from __future__ import annotations

import contextlib
import hashlib
import math
import os
from functools import lru_cache
from typing import TYPE_CHECKING, Any

try:
    import torch  # type: ignore
except Exception:  # pragma: no cover - optional runtime dependency
    torch = None
from fastapi import FastAPI
from pydantic import BaseModel

try:
    from .feature_extractor import build_feature_vector, pad_or_trim
except ImportError:
    from feature_extractor import build_feature_vector, pad_or_trim

if TYPE_CHECKING:
    from model import CodeSemanticEmbedder

app = FastAPI(title="cortexa-ml")

DEFAULT_DIM = 256


class EmbedRequest(BaseModel):
    text: str
    ast: dict | None = None
    dimensions: int | None = None


def _normalize(vec: list[float]) -> list[float]:
    magnitude = math.sqrt(sum(v * v for v in vec))
    if magnitude == 0:
        return vec
    return [v / magnitude for v in vec]


def _deterministic_embedding(text: str, dimensions: int = DEFAULT_DIM) -> list[float]:
    values = [0.0] * dimensions
    for index, ch in enumerate(text):
        bucket = index % dimensions
        code = ord(ch)
        values[bucket] += ((code * (index + 19)) % 1009) / 1009.0
    return _normalize(values)


def _resize_embedding(vec: list[float], dimensions: int) -> list[float]:
    if dimensions <= 0:
        return vec

    if len(vec) == dimensions:
        return vec

    if len(vec) > dimensions:
        return _normalize(vec[:dimensions])

    return _normalize(vec + [0.0] * (dimensions - len(vec)))


@lru_cache(maxsize=1)
def _resolve_device() -> str:
    if torch is None:
        return "cpu"

    configured = str(os.getenv("CORTEXA_ML_DEVICE", "auto")).strip().lower()
    if configured in {"cpu"}:
        return "cpu"

    if configured in {"cuda", "gpu"}:
        return "cuda" if torch.cuda.is_available() else "cpu"

    return "cuda" if torch.cuda.is_available() else "cpu"


def _configure_runtime_for_device(device: str) -> None:
    if torch is None or device != "cuda":
        return

    if hasattr(torch, "set_float32_matmul_precision"):
        torch.set_float32_matmul_precision("high")

    if hasattr(torch.backends, "cuda") and hasattr(torch.backends.cuda, "matmul"):
        torch.backends.cuda.matmul.allow_tf32 = True

    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True


@lru_cache(maxsize=1)
def _load_model() -> Any:
    if torch is None:
        return None

    device = _resolve_device()
    _configure_runtime_for_device(device)

    checkpoint_candidates = [
        os.path.join("data", "models", "code-semantic-embedder.pt"),
        os.path.join("data", "checkpoints", "code_semantic_embedder.pt"),
    ]
    checkpoint_path = next((candidate for candidate in checkpoint_candidates if os.path.exists(candidate)), None)
    if checkpoint_path is None:
        return None

    try:
        try:
            from .model import CodeSemanticEmbedder
        except ImportError:
            from model import CodeSemanticEmbedder
    except Exception:
        return None

    model = CodeSemanticEmbedder()
    state = torch.load(checkpoint_path, map_location=device)
    model.load_state_dict(state, strict=False)
    model.to(device)
    model.eval()
    return model


def _model_embed(text: str, ast: dict | None) -> list[float] | None:
    if torch is None:
        return None

    model = _load_model()
    if model is None:
        return None

    device = _resolve_device()
    use_amp = device == "cuda"

    with torch.inference_mode():
        tokenized = model.tokenizer([text], padding=True, truncation=True, max_length=256, return_tensors="pt")
        struct_source = ast if isinstance(ast, dict) else {}
        input_ids = tokenized["input_ids"].to(device)
        attention_mask = tokenized["attention_mask"].to(device)
        struct_feats = torch.tensor([pad_or_trim(build_feature_vector(struct_source))], dtype=torch.float32, device=device)

        autocast_context = (
            torch.amp.autocast(device_type="cuda", dtype=torch.float16)
            if use_amp
            else contextlib.nullcontext()
        )
        with autocast_context:
            emb = model(input_ids, attention_mask, struct_feats)[0]
        emb = torch.nn.functional.normalize(emb, p=2, dim=0)
        return emb.cpu().tolist()


@app.post("/embed")
def embed(req: EmbedRequest):
    text = req.text.strip()
    if not text:
        return {"embedding": [], "dim": 0, "text": req.text, "provider": "none"}

    dimensions = max(16, min(req.dimensions or DEFAULT_DIM, 4096))

    vec = _model_embed(text, req.ast)
    provider = "model"

    if vec is None:
        vec = _deterministic_embedding(text, dimensions)
        provider = "deterministic"
    else:
        vec = _resize_embedding(vec, dimensions)

    checksum = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    return {
        "embedding": vec,
        "dim": len(vec),
        "provider": provider,
        "checksum": checksum,
        "text": req.text,
    }
