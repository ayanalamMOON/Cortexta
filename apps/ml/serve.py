from __future__ import annotations

import contextlib
import hashlib
import math
import os
import re
from functools import lru_cache
from typing import TYPE_CHECKING, Any

try:
    import torch  # type: ignore
except Exception:  # pragma: no cover - optional runtime dependency
    torch = None
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

try:
    from .feature_extractor import build_feature_vector, pad_or_trim
except ImportError:
    try:
        from apps.ml.feature_extractor import build_feature_vector, pad_or_trim
    except ImportError:
        from feature_extractor import build_feature_vector, pad_or_trim

try:
    from src.llm_adapter import LocalLLMAdapter
except Exception:  # pragma: no cover - adapter is optional
    LocalLLMAdapter = None  # type: ignore[assignment]

if TYPE_CHECKING:
    try:
        from .model import CodeSemanticEmbedder
    except Exception:
        try:
            from apps.ml.model import CodeSemanticEmbedder
        except Exception:
            from model import CodeSemanticEmbedder

app = FastAPI(title="cortexa-ml")

DEFAULT_DIM = 256


class EmbedRequest(BaseModel):
    text: str
    ast: dict | None = None
    dimensions: int | None = None


class TagRequest(BaseModel):
    text: str
    project_id: str | None = None
    max_tags: int | None = None


class CompleteJsonRequest(BaseModel):
    system: str | None = None
    user: str
    schema_hint: str | None = None
    max_tokens: int | None = None


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


def _read_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(str(os.getenv(name, str(default))).strip())
    except ValueError:
        parsed = default
    return max(minimum, min(maximum, parsed))


def _read_float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(str(os.getenv(name, str(default))).strip())
    except ValueError:
        parsed = default
    return max(minimum, min(maximum, parsed))


def _read_bool_env(name: str, default: bool) -> bool:
    raw = str(os.getenv(name, "true" if default else "false")).strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


def _heuristic_tags(text: str, max_tags: int) -> list[str]:
    stopwords = {
        "the",
        "and",
        "for",
        "with",
        "this",
        "that",
        "from",
        "into",
        "when",
        "where",
        "how",
        "what",
        "why",
        "should",
        "could",
        "would",
        "about",
        "using",
    }

    counts: dict[str, int] = {}
    for token in re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", text.lower()):
        if token in stopwords:
            continue
        counts[token] = counts.get(token, 0) + 1

    return [
        token
        for token, _ in sorted(counts.items(), key=lambda item: (-item[1], len(item[0]), item[0]))[:max_tags]
    ]


def _build_complete_json_prompt(system: str, user: str, schema_hint: str) -> str:
    sections = [
        "You are a JSON-only assistant for Cortexa memory evolution.",
        "Return a single valid JSON object only. Do not include markdown fences or prose.",
    ]

    if system:
        sections.append(f"System instructions:\n{system}")

    if schema_hint:
        sections.append(f"Schema hint:\n{schema_hint}")

    sections.append(f"User input:\n{user}")
    sections.append("JSON:")
    return "\n\n".join(sections)


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
            try:
                from apps.ml.model import CodeSemanticEmbedder
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


@lru_cache(maxsize=1)
def _load_tagger_adapter() -> Any:
    if LocalLLMAdapter is None:
        return None

    default_model_path = os.path.join("data", "models", "qwen2.5-1.5b-instruct-q4_k_m.gguf")
    model_path = str(os.getenv("CORTEXA_QWEN_MODEL_PATH", default_model_path)).strip()

    if not model_path or not os.path.exists(model_path):
        return None

    try:
        return LocalLLMAdapter(
            model_path=model_path,
            n_ctx=_read_int_env("CORTEXA_QWEN_N_CTX", 512, 256, 4096),
            n_threads=_read_int_env("CORTEXA_QWEN_N_THREADS", 4, 1, 32),
            n_gpu_layers=_read_int_env("CORTEXA_QWEN_N_GPU_LAYERS", 0, 0, 128),
            cache_size=_read_int_env("CORTEXA_QWEN_CACHE_SIZE", 256, 32, 4096),
            timeout_seconds=_read_float_env("CORTEXA_QWEN_TIMEOUT_SECONDS", 90.0, 0.5, 180.0),
            max_concurrency=_read_int_env("CORTEXA_QWEN_MAX_CONCURRENCY", 2, 1, 8),
        )
    except Exception:
        return None


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


@app.post("/complete-json")
async def complete_json(req: CompleteJsonRequest):
    strict_mode = _read_bool_env("CORTEXA_QWEN_STRICT", True)
    user_text = req.user.strip()

    if not user_text:
        return {
            "error": "empty_user",
            "fallback": True,
        }

    adapter = _load_tagger_adapter()
    if adapter is None:
        if strict_mode:
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "llm_adapter_unavailable",
                    "strict_mode": True,
                },
            )

        return {
            "error": "llm_adapter_unavailable",
            "fallback": True,
        }

    max_tokens = max(32, min(req.max_tokens or 220, 1024))
    system_text = (req.system or "").strip()
    schema_hint = (req.schema_hint or "").strip()
    prompt = _build_complete_json_prompt(system_text, user_text, schema_hint)

    result = await adapter.generate_structured(
        prompt,
        schema_hint=schema_hint,
        max_tokens=max_tokens,
    )

    if not isinstance(result, dict):
        if strict_mode:
            raise HTTPException(
                status_code=502,
                detail={
                    "error": "llm_generation_invalid",
                    "strict_mode": True,
                    "reason": "non_object_response",
                },
            )

        return {
            "error": "llm_generation_invalid",
            "fallback": True,
            "reason": "non_object_response",
        }

    if isinstance(result.get("error"), str):
        if strict_mode:
            raise HTTPException(
                status_code=502,
                detail={
                    "error": str(result.get("error")),
                    "strict_mode": True,
                },
            )

        return {
            **result,
            "fallback": True,
        }

    if result.get("parse_failed"):
        if strict_mode:
            raise HTTPException(
                status_code=502,
                detail={
                    "error": "llm_generation_parse_failed",
                    "strict_mode": True,
                    "cache_hit": bool(result.get("_cache_hit")),
                },
            )

        return {
            **result,
            "fallback": True,
        }

    result["_provider"] = "qwen2.5-1.5b-instruct-q4_k_m"
    result["_strict_mode"] = strict_mode
    return result


@app.post("/tags")
async def tags(req: TagRequest):
    text = req.text.strip()
    strict_mode = _read_bool_env("CORTEXA_QWEN_STRICT", True)

    if not text:
        return {
            "tags": [],
            "provider": "none",
            "fallback": True,
            "error": "empty_text",
        }

    max_tags = max(1, min(req.max_tags or 5, 12))
    fallback_tags = _heuristic_tags(text, max_tags)

    adapter = _load_tagger_adapter()
    if adapter is None:
        if strict_mode:
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "llm_adapter_unavailable",
                    "strict_mode": True,
                },
            )

        return {
            "tags": fallback_tags,
            "provider": "heuristic",
            "fallback": True,
            "error": "llm_adapter_unavailable",
        }

    result = await adapter.generate_tags(text, max_tags=max_tags)
    llm_tags = result.get("tags") if isinstance(result, dict) else None

    if isinstance(llm_tags, list) and llm_tags:
        return {
            "tags": llm_tags[:max_tags],
            "provider": "qwen2.5-1.5b-instruct-q4_k_m",
            "fallback": False,
            "cache_hit": bool(result.get("_cache_hit")),
            "llm_verified": True,
            "strict_mode": strict_mode,
            "project_id": req.project_id,
        }

    if strict_mode:
        raise HTTPException(
            status_code=502,
            detail={
                "error": "llm_generation_invalid",
                "strict_mode": True,
                "cache_hit": bool(result.get("_cache_hit")) if isinstance(result, dict) else False,
                "parse_failed": bool(result.get("parse_failed")) if isinstance(result, dict) else False,
            },
        )

    return {
        "tags": fallback_tags,
        "provider": "heuristic",
        "fallback": True,
        "cache_hit": bool(result.get("_cache_hit")) if isinstance(result, dict) else False,
        "project_id": req.project_id,
        "raw": result.get("raw") if isinstance(result, dict) else None,
        "parse_failed": bool(result.get("parse_failed")) if isinstance(result, dict) else False,
    }
