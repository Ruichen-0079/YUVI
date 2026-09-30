"""No-op LLM used when Memory LLM is intentionally not configured.

mem0ai 2.2.1 always constructs an LLM at Memory.from_config and only allows a
fixed LlmConfig provider allow-list. We therefore:

1. Pass provider=\"openai\" (allowed by pydantic) with model marker `yuvi-noop`
   and **no** api_key field (no forged keys).
2. Patch LlmFactory.create so the marker returns YuviNoopLLM instead of OpenAI.
3. Service layer rejects infer=true with MEMORY_LLM_NOT_CONFIGURED before any
   generate_response call.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from mem0.configs.llms.base import BaseLlmConfig
from mem0.llms.base import LLMBase

# Marker model name — never sent to a real provider.
YUVI_NOOP_MODEL = "yuvi-noop"
# Wire provider name must be on mem0ai LlmConfig allow-list.
YUVI_NOOP_WIRE_PROVIDER = "openai"

_FACTORY_PATCHED = False


class YuviNoopLLM(LLMBase):
    """LLM stub that never issues network calls."""

    def __init__(self, config: Optional[BaseLlmConfig] = None) -> None:
        super().__init__(config)

    def generate_response(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: str = "auto",
        **kwargs: Any,
    ) -> str:
        raise RuntimeError(
            "MEMORY_LLM_NOT_CONFIGURED: Memory LLM is not configured; infer=true is unavailable."
        )


def build_noop_llm_config() -> dict:
    """Mem0 LLM config block for capability mode (no keys, no network)."""
    return {
        "provider": YUVI_NOOP_WIRE_PROVIDER,
        "config": {
            "model": YUVI_NOOP_MODEL,
            "temperature": 0.0,
        },
    }


def register_yuvi_noop_llm() -> None:
    """Patch LlmFactory so marker model installs YuviNoopLLM (idempotent)."""
    global _FACTORY_PATCHED
    from importlib.metadata import version
    from mem0.utils.factory import LlmFactory

    if version("mem0ai") != "2.2.1":
        raise RuntimeError("YUVI noop LLM seam requires audited mem0ai==2.2.1")

    if _FACTORY_PATCHED:
        return

    original_create = LlmFactory.create.__func__  # type: ignore[attr-defined]

    @classmethod  # type: ignore[misc]
    def create(cls: type, provider_name: str, config: Any = None, **kwargs: Any) -> Any:
        model = None
        if isinstance(config, dict):
            model = config.get("model")
        elif config is not None:
            model = getattr(config, "model", None)
        if model == YUVI_NOOP_MODEL:
            base = BaseLlmConfig(**config) if isinstance(config, dict) else config
            return YuviNoopLLM(base)
        return original_create(cls, provider_name, config, **kwargs)

    LlmFactory.create = create  # type: ignore[method-assign]
    _FACTORY_PATCHED = True
