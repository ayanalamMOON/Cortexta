from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
from collections import OrderedDict
from typing import Any, Dict

try:
    from llama_cpp import Llama
except Exception as error:  # pragma: no cover - optional runtime dependency
    Llama = None  # type: ignore[assignment]
    LLAMA_IMPORT_ERROR: Exception | None = error
else:
    LLAMA_IMPORT_ERROR = None


class LocalLLMAdapter:
    """
    Async, non-blocking LLM adapter for MCP/memory enrichment.
    Optimized for deterministic JSON output with bounded resource usage.
    """

    def __init__(
        self,
        model_path: str,
        n_ctx: int = 512,
        n_threads: int = 4,
        n_gpu_layers: int = 0,
        cache_size: int = 256,
        timeout_seconds: float = 2.0,
        max_concurrency: int = 2,
    ):
        if Llama is None:
            detail = f" ({LLAMA_IMPORT_ERROR})" if LLAMA_IMPORT_ERROR else ""
            raise RuntimeError(f"llama-cpp-python is not installed{detail}")

        self.llm = Llama(
            model_path=model_path,
            n_ctx=n_ctx,
            n_threads=n_threads,
            n_gpu_layers=n_gpu_layers,
            verbose=False,
            logits_all=False,
            use_mlock=True,
            n_batch=256,
        )
        self._semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self._timeout_seconds = max(0.1, float(timeout_seconds))
        self._cache_size = max(8, int(cache_size))
        self._cache: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._cache_lock = asyncio.Lock()

    @staticmethod
    def _build_cache_key(prompt: str, schema_hint: str, max_tokens: int) -> str:
        payload = f"{prompt}\n###schema###\n{schema_hint}\n###tokens###\n{max_tokens}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _raw_infer(self, prompt: str, max_tokens: int = 32) -> str:
        """Synchronous inference core. Called via to_thread/run_in_executor."""
        result: Any = self.llm(
            prompt,
            max_tokens=max_tokens,
            temperature=0.05,
            top_p=0.9,
            repeat_penalty=1.1,
            stop=["Human:", "User:", "<|im_end|>", "```"],
        )
        text = result["choices"][0]["text"]
        cleaned = str(text).strip()
        if cleaned:
            return cleaned

        retry: Any = self.llm(
            prompt,
            max_tokens=max_tokens,
            temperature=0.08,
            top_p=0.95,
            repeat_penalty=1.05,
            stop=["Human:", "User:", "<|im_end|>", "```"],
        )
        return str(retry["choices"][0]["text"]).strip()

    @staticmethod
    def _strip_markdown_fences(raw: str) -> str:
        candidate = raw.strip()
        candidate = re.sub(r"^```(?:json)?\\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\\s*```$", "", candidate)
        return candidate.strip()

    @staticmethod
    def _extract_json_payload(raw: str) -> str:
        clean = LocalLLMAdapter._strip_markdown_fences(raw)
        if clean.startswith("{") and clean.endswith("}"):
            return clean

        left = clean.find("{")
        right = clean.rfind("}")
        if left >= 0 and right > left:
            return clean[left:right + 1]

        return clean

    @staticmethod
    def _normalize_tag(candidate: str) -> str:
        normalized = re.sub(r"[^a-z0-9_-]", "", candidate.strip().lower())
        normalized = re.sub(r"[_-]{2,}", "-", normalized).strip("-_")
        return normalized

    @staticmethod
    def _extract_tag_candidates_from_raw(raw: str) -> list[str]:
        clean = LocalLLMAdapter._strip_markdown_fences(raw)
        candidates = re.findall(r'"([^"\n]{2,40})"', clean)
        if not candidates:
            candidates = re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,39}", clean)

        deduped: list[str] = []
        for candidate in candidates:
            if candidate not in deduped:
                deduped.append(candidate)
        return deduped

    async def _cache_get(self, cache_key: str) -> Dict[str, Any] | None:
        async with self._cache_lock:
            hit = self._cache.get(cache_key)
            if hit is None:
                return None

            self._cache.move_to_end(cache_key)
            return copy.deepcopy(hit)

    async def _cache_put(self, cache_key: str, value: Dict[str, Any]) -> None:
        async with self._cache_lock:
            self._cache[cache_key] = copy.deepcopy(value)
            self._cache.move_to_end(cache_key)

            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)

    async def generate_structured(
        self,
        prompt: str,
        schema_hint: str = "",
        max_tokens: int = 32,
    ) -> Dict[str, Any]:
        """
        Async wrapper with LRU caching, timeout, and JSON parsing fallback.
        """
        bounded_tokens = max(4, min(int(max_tokens), 256))
        cache_key = self._build_cache_key(prompt, schema_hint, bounded_tokens)

        cached = await self._cache_get(cache_key)
        if cached is not None:
            cached["_cache_hit"] = True
            return cached

        async with self._semaphore:
            try:
                raw = await asyncio.wait_for(
                    asyncio.to_thread(self._raw_infer, prompt, bounded_tokens),
                    timeout=self._timeout_seconds,
                )
            except asyncio.TimeoutError:
                return {"error": "llm_timeout", "fallback": True}
            except Exception as error:  # pragma: no cover - runtime dependent
                return {"error": "llm_inference_failed", "fallback": True, "detail": str(error)}

        try:
            parsed = json.loads(self._extract_json_payload(raw))
            if isinstance(parsed, dict):
                await self._cache_put(cache_key, parsed)
                parsed["_cache_hit"] = False
                return parsed

            wrapped = {"value": parsed}
            await self._cache_put(cache_key, wrapped)
            wrapped["_cache_hit"] = False
            return wrapped
        except json.JSONDecodeError:
            return {"raw": raw, "parse_failed": True}

    async def generate_tags(self, content: str, max_tags: int = 5) -> Dict[str, Any]:
        bounded_max_tags = max(1, min(int(max_tags), 12))
        snippet = content.strip().replace("\n", " ")[:320]
        prompt = (
            "You are a tagging engine for code-memory indexing. "
            f"Return compact JSON only with at most {bounded_max_tags} lowercase technical tags. "
            "Use short snake_case or kebab-case values. "
            "Output format exactly: {\"tags\":[\"tag1\",\"tag2\"]}. "
            f"Text: {snippet}. "
            "JSON:"
        )
        response = await self.generate_structured(prompt, schema_hint='{"tags":["..."]}', max_tokens=96)

        source_candidates: list[str] = []
        if isinstance(response, dict):
            source_candidates.extend(
                candidate for candidate in response.get("tags", []) if isinstance(candidate, str)
            )

            if not source_candidates and isinstance(response.get("raw"), str):
                source_candidates.extend(self._extract_tag_candidates_from_raw(response["raw"]))

        tags: list[str] = []
        for candidate in source_candidates:
            normalized = self._normalize_tag(candidate)
            if len(normalized) < 2:
                continue
            if normalized not in tags:
                tags.append(normalized)
            if len(tags) >= bounded_max_tags:
                break

        if tags:
            response["tags"] = tags
            if response.get("parse_failed"):
                response["recovered_from_raw"] = True

        return response

    async def clear_cache(self) -> None:
        async with self._cache_lock:
            self._cache.clear()
