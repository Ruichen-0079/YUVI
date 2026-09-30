"""Private local model guard, audited and gated to mem0ai==2.2.1.

Upstream now recognizes both name/model fields, so YUVI no longer patches
that detection bug. Upstream still pulls a missing model; this guard prevents
any registry pull for a private tag and delegates public tags unchanged.
"""

from __future__ import annotations

import logging
import warnings
from dataclasses import dataclass
from typing import Any, Callable

logger = logging.getLogger("yuvi_mem0.ollama_embedder_patch")

# Only this exact package version is known-safe for this monkey-patch.
SUPPORTED_MEM0AI_VERSION = "2.2.1"

# Stable error token for missing private/local-only models (tests assert this).
EMBEDDER_MODEL_NOT_LOCAL = "EMBEDDER_MODEL_NOT_LOCAL"
MEM0_EMBEDDER_PATCH_UNSUPPORTED = "MEM0_EMBEDDER_PATCH_UNSUPPORTED"

_PATCHED = False
_ORIGINAL_ENSURE: Callable[..., None] | None = None
_LAST_RESULT: PatchResult | None = None


@dataclass(frozen=True)
class PatchResult:
    """Outcome of :func:`patch_ollama_embedder`."""

    applied: bool
    mem0_version: str | None
    reason: str
    code: str | None = None


class Mem0EmbedderPatchError(RuntimeError):
    """Raised for version-gated patch policy or private-tag local-model failures."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def get_mem0ai_version() -> str | None:
    """Return installed mem0ai version string, or None if unavailable."""
    try:
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:  # pragma: no cover
        return None
    try:
        return version("mem0ai")
    except PackageNotFoundError:
        return None


def is_private_ollama_tag(model: str) -> bool:
    """
    Private / YUVI-only tags that must never be registry-pulled.

    Official public models (e.g. ``qwen3-embedding:0.6b``, ``nomic-embed-text``)
    return False so stock pull behaviour remains available when missing locally.
    """
    name = (model or "").strip().lower()
    if not name:
        return False
    # Strip optional namespace host prefixes like "registry.example.com/yuvi-..."
    short = name.rsplit("/", 1)[-1]
    return short.startswith("yuvi-")


def _model_identifiers(entry: Any) -> set[str]:
    names: set[str] = set()
    if entry is None:
        return names
    if isinstance(entry, dict):
        for key in ("name", "model", "model_name"):
            value = entry.get(key)
            if isinstance(value, str) and value.strip():
                names.add(value.strip())
        return names
    for attr in ("name", "model", "model_name"):
        value = getattr(entry, attr, None)
        if isinstance(value, str) and value.strip():
            names.add(value.strip())
    return names


def _local_model_names(client: Any) -> set[str]:
    listed = client.list()
    if isinstance(listed, dict):
        raw_models = list(listed.get("models") or [])
    else:
        raw_models = list(getattr(listed, "models", None) or [])
    names: set[str] = set()
    for entry in raw_models:
        names |= _model_identifiers(entry)
    return names


def _model_is_local(wanted: str, local: set[str]) -> bool:
    """Exact tag match only (no silent base-name fuzzy match)."""
    return wanted in local


def last_patch_result() -> PatchResult | None:
    return _LAST_RESULT


def reset_ollama_embedder_patch_for_tests() -> None:
    """Restore original method and clear patch flags (unit tests only)."""
    global _PATCHED, _ORIGINAL_ENSURE, _LAST_RESULT
    if _PATCHED and _ORIGINAL_ENSURE is not None:
        from mem0.embeddings.ollama import OllamaEmbedding

        OllamaEmbedding._ensure_model_exists = _ORIGINAL_ENSURE  # type: ignore[method-assign]
    _PATCHED = False
    _ORIGINAL_ENSURE = None
    _LAST_RESULT = None


def patch_ollama_embedder(*, strict_version: bool = False) -> PatchResult:
    """
    Idempotent, version-gated monkey-patch of OllamaEmbedding._ensure_model_exists.

    Parameters
    ----------
    strict_version:
        When True, unsupported mem0ai versions raise
        :class:`Mem0EmbedderPatchError` instead of only warning + skip.

    Returns
    -------
    PatchResult
        Whether the patch was applied and why.
    """
    global _PATCHED, _ORIGINAL_ENSURE, _LAST_RESULT

    if _PATCHED:
        assert _LAST_RESULT is not None
        return _LAST_RESULT

    mem0_version = get_mem0ai_version()
    if mem0_version != SUPPORTED_MEM0AI_VERSION:
        msg = (
            f"{MEM0_EMBEDDER_PATCH_UNSUPPORTED}: "
            f"ollama_embedder_patch supports mem0ai=={SUPPORTED_MEM0AI_VERSION} only "
            f"(detected {mem0_version!r}). Patch NOT applied; behaviour is stock mem0."
        )
        logger.warning(msg)
        warnings.warn(msg, UserWarning, stacklevel=2)
        result = PatchResult(
            applied=False,
            mem0_version=mem0_version,
            reason="unsupported_mem0ai_version",
            code=MEM0_EMBEDDER_PATCH_UNSUPPORTED,
        )
        _LAST_RESULT = result
        if strict_version:
            raise Mem0EmbedderPatchError(MEM0_EMBEDDER_PATCH_UNSUPPORTED, msg)
        return result

    from mem0.embeddings.ollama import OllamaEmbedding

    original = OllamaEmbedding._ensure_model_exists
    _ORIGINAL_ENSURE = original

    def _ensure_model_exists(self: Any) -> None:  # noqa: ANN401
        wanted = (getattr(self.config, "model", None) or "").strip()
        if not wanted:
            raise ValueError("Ollama embedder model is empty.")

        local = _local_model_names(self.client)
        if _model_is_local(wanted, local):
            return

        if is_private_ollama_tag(wanted):
            # Never pull private/YUVI tags (not on public registry).
            raise Mem0EmbedderPatchError(
                EMBEDDER_MODEL_NOT_LOCAL,
                (
                    f"{EMBEDDER_MODEL_NOT_LOCAL}: Ollama model '{wanted}' is not "
                    f"available locally. Private YUVI tags are never auto-pulled; "
                    f"create the model first (e.g. ollama create). "
                    f"Local models: {sorted(local)}"
                ),
            )

        # Upstream 2.2.1 fixes model field detection; preserve its public behavior.
        original(self)

    OllamaEmbedding._ensure_model_exists = _ensure_model_exists  # type: ignore[method-assign]
    _PATCHED = True
    result = PatchResult(
        applied=True,
        mem0_version=mem0_version,
        reason="patched_mem0ai_2_2_1",
        code=None,
    )
    _LAST_RESULT = result
    logger.info(
        "Applied OllamaEmbedding patch for mem0ai==%s (private tags never auto-pulled)",
        mem0_version,
    )
    return result
