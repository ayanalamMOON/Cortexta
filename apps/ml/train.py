from __future__ import annotations

import contextlib
import json
import os
from dataclasses import dataclass
from typing import Any, List, Tuple

import torch
from torch.utils.data import Dataset, DataLoader
import torch.nn.functional as F

try:
    from .feature_extractor import build_feature_vector, pad_or_trim
    from .model import CodeSemanticEmbedder
except ImportError:
    from feature_extractor import build_feature_vector, pad_or_trim
    from model import CodeSemanticEmbedder


@dataclass
class PairSample:
    text_a: str
    text_b: str
    struct_a: List[float]
    struct_b: List[float]
    label: float


class PairDataset(Dataset):
    def __init__(self, path: str):
        self.path = path
        self.samples: List[PairSample] = []
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self.path):
            self.samples = []
            return

        with open(self.path, "r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue

                text_a = str(row.get("text_a", "")).strip()
                text_b = str(row.get("text_b", "")).strip()
                if not text_a or not text_b:
                    continue

                struct_a = row.get("struct_a") if isinstance(row.get("struct_a"), dict) else {}
                struct_b = row.get("struct_b") if isinstance(row.get("struct_b"), dict) else {}
                label = float(row.get("label", 1.0))

                self.samples.append(
                    PairSample(
                        text_a=text_a,
                        text_b=text_b,
                        struct_a=pad_or_trim(build_feature_vector(struct_a)),
                        struct_b=pad_or_trim(build_feature_vector(struct_b)),
                        label=max(0.0, min(1.0, label)),
                    )
                )

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx: int):
        return self.samples[idx]


def _collate(model: Any, batch: List[PairSample]) -> Tuple[torch.Tensor, ...]:
    texts_a = [sample.text_a for sample in batch]
    texts_b = [sample.text_b for sample in batch]

    tokenized_a = model.tokenizer(texts_a, padding=True, truncation=True, max_length=256, return_tensors="pt")
    tokenized_b = model.tokenizer(texts_b, padding=True, truncation=True, max_length=256, return_tensors="pt")

    struct_a = torch.tensor([sample.struct_a for sample in batch], dtype=torch.float32)
    struct_b = torch.tensor([sample.struct_b for sample in batch], dtype=torch.float32)
    labels = torch.tensor([sample.label for sample in batch], dtype=torch.float32)

    return (
        tokenized_a["input_ids"],
        tokenized_a["attention_mask"],
        struct_a,
        tokenized_b["input_ids"],
        tokenized_b["attention_mask"],
        struct_b,
        labels,
    )


def _configure_runtime_for_device(device: torch.device) -> None:
    if device.type != "cuda":
        return

    if hasattr(torch, "set_float32_matmul_precision"):
        torch.set_float32_matmul_precision("high")

    if hasattr(torch.backends, "cuda") and hasattr(torch.backends.cuda, "matmul"):
        torch.backends.cuda.matmul.allow_tf32 = True

    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True


def _resolve_num_workers() -> int:
    configured = os.getenv("CORTEXA_TRAIN_NUM_WORKERS")
    if configured is not None:
        try:
            return max(0, int(configured))
        except ValueError:
            return 0

    if os.name == "nt":
        return 0

    cpu_count = os.cpu_count() or 1
    return min(4, max(1, cpu_count - 1))


def _maybe_compile_model(model: Any, device: torch.device) -> Any:
    enabled = str(os.getenv("CORTEXA_TRAIN_COMPILE", "0")).strip().lower() in {"1", "true", "yes", "on"}
    if not enabled or device.type != "cuda" or not hasattr(torch, "compile"):
        return model

    try:
        return torch.compile(model)
    except Exception:
        return model


def _build_optimizer(model: Any, lr: float, device: torch.device) -> tuple[torch.optim.Optimizer, bool]:
    fused_requested = str(os.getenv("CORTEXA_TRAIN_FUSED_ADAMW", "auto")).strip().lower()
    want_fused = device.type == "cuda" and fused_requested in {"auto", "1", "true", "yes", "on"}

    if want_fused:
        try:
            return torch.optim.AdamW(model.parameters(), lr=lr, fused=True), True
        except TypeError:
            pass
        except RuntimeError:
            pass

    return torch.optim.AdamW(model.parameters(), lr=lr), False


def _make_grad_scaler(enabled: bool):
    amp = getattr(torch, "amp", None)
    if amp is not None and hasattr(amp, "GradScaler"):
        try:
            return amp.GradScaler("cuda", enabled=enabled)
        except TypeError:
            return amp.GradScaler(enabled=enabled)
    return torch.cuda.amp.GradScaler(enabled=enabled)


def _make_autocast_context(enabled: bool):
    if not enabled:
        return contextlib.nullcontext()

    amp = getattr(torch, "amp", None)
    if amp is not None and hasattr(amp, "autocast"):
        try:
            return amp.autocast(device_type="cuda", dtype=torch.float16)
        except TypeError:
            return amp.autocast("cuda", dtype=torch.float16)
    return torch.cuda.amp.autocast(dtype=torch.float16)


def train(path: str, epochs: int = 2, batch_size: int = 4, lr: float = 2e-5) -> None:
    dataset = PairDataset(path)
    if len(dataset) == 0:
        raise RuntimeError(f"No valid training samples found in {path}")

    model = CodeSemanticEmbedder()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    _configure_runtime_for_device(device)
    model.to(device)
    model = _maybe_compile_model(model, device)
    model.train()

    pin_memory = device.type == "cuda"
    num_workers = _resolve_num_workers()

    optimizer, fused_optimizer = _build_optimizer(model, lr, device)
    loader_kwargs = {
        "batch_size": batch_size,
        "shuffle": True,
        "collate_fn": lambda batch: _collate(model, batch),
        "pin_memory": pin_memory,
        "num_workers": num_workers,
    }
    if num_workers > 0:
        loader_kwargs["persistent_workers"] = True
        loader_kwargs["prefetch_factor"] = 2

    loader = DataLoader(dataset, **loader_kwargs)

    use_amp = device.type == "cuda"
    scaler = _make_grad_scaler(enabled=use_amp)

    print(
        f"training device={device.type} amp={'on' if use_amp else 'off'} "
        f"pin_memory={pin_memory} workers={num_workers} fused_adamw={'on' if fused_optimizer else 'off'}"
    )

    for epoch in range(epochs):
        total_loss = 0.0
        for (
            input_ids_a,
            attention_mask_a,
            struct_a,
            input_ids_b,
            attention_mask_b,
            struct_b,
            labels,
        ) in loader:
            input_ids_a = input_ids_a.to(device, non_blocking=pin_memory)
            attention_mask_a = attention_mask_a.to(device, non_blocking=pin_memory)
            struct_a = struct_a.to(device, non_blocking=pin_memory)
            input_ids_b = input_ids_b.to(device, non_blocking=pin_memory)
            attention_mask_b = attention_mask_b.to(device, non_blocking=pin_memory)
            struct_b = struct_b.to(device, non_blocking=pin_memory)
            labels = labels.to(device, non_blocking=pin_memory)

            autocast_context = _make_autocast_context(enabled=use_amp)
            with autocast_context:
                emb_a = model(input_ids_a, attention_mask_a, struct_a)
                emb_b = model(input_ids_b, attention_mask_b, struct_b)

                emb_a = F.normalize(emb_a, p=2, dim=-1)
                emb_b = F.normalize(emb_b, p=2, dim=-1)

                cosine = F.cosine_similarity(emb_a, emb_b)
                loss = F.mse_loss(cosine, labels)

            optimizer.zero_grad(set_to_none=True)
            if use_amp:
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
            else:
                loss.backward()
                optimizer.step()

            total_loss += float(loss.item())

        avg_loss = total_loss / max(1, len(loader))
        print(f"epoch={epoch + 1}/{epochs} loss={avg_loss:.6f}")

    os.makedirs("data/models", exist_ok=True)
    checkpoint_path = os.path.join("data/models", "code-semantic-embedder.pt")
    torch.save(model.state_dict(), checkpoint_path)
    print(f"saved checkpoint -> {checkpoint_path}")


if __name__ == "__main__":
    train("data/training/pairs.jsonl")
