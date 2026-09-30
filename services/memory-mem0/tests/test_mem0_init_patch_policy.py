"""Sidecar Mem0 initialization policy for ollama_embedder_patch."""

from __future__ import annotations

import logging
from typing import Any

import pytest

from yuvi_mem0.config import Settings
from yuvi_mem0.errors import (
    MEM0_EMBEDDER_PATCH_UNSUPPORTED,
    SidecarError,
)
from yuvi_mem0.memory import Mem0Service
from yuvi_mem0.ollama_embedder_patch import (
    SUPPORTED_MEM0AI_VERSION,
    last_patch_result,
    reset_ollama_embedder_patch_for_tests,
)


@pytest.fixture(autouse=True)
def _reset_patch() -> None:
    reset_ollama_embedder_patch_for_tests()
    yield
    reset_ollama_embedder_patch_for_tests()


def _settings(*, model: str) -> Settings:
    # Fixed validators only accept yuvi-embedding:0.6b — for public-model policy
    # tests we bypass Settings construction of embedder by subclassing service
    # and assigning model after, or use object.__setattr__ patterns.
    # Settings rejects non-yuvi models; use model_construct for public tests.
    return Settings.model_construct(
        mem0_sidecar_host="127.0.0.1",
        mem0_sidecar_port=6130,
        mem0_embedder_provider="ollama",
        mem0_embedder_model=model,
        mem0_embedder_dimensions=1024,
        mem0_ollama_base_url="http://127.0.0.1:11434",
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
        mem0_pg_collection="yuvi_mem0_qwen3_1024_v1",
        mem0_pg_hnsw=True,
        mem0_pg_diskann=False,
        mem0_llm_provider="openai",
        mem0_llm_model="",
        mem0_llm_api_key="",
        mem0_llm_base_url="",
        mem0_llm_temperature=0.0,
        mem0_llm_timeout_ms=30000,
        mem0_request_timeout_ms=5000,
        mem0_log_content=False,
        mem0_health_embed_cache_ttl_s=30,
    )


def test_private_model_supported_version_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "yuvi_mem0.ollama_embedder_patch.get_mem0ai_version",
        lambda: SUPPORTED_MEM0AI_VERSION,
    )

    import mem0.memory.main as mem0_main

    calls: dict[str, Any] = {"from_config": 0}

    class FakeMemory:
        def __init__(self, *_a: Any, **_k: Any) -> None:
            pass

        @classmethod
        def from_config(cls, _config: dict) -> FakeMemory:
            calls["from_config"] += 1
            from types import SimpleNamespace
            result = cls()
            result.vector_store = SimpleNamespace(collection_name="test", list_cols=lambda: ["test"])
            return result

    monkeypatch.setattr(mem0_main, "Memory", FakeMemory)
    # Also patch the import path used inside initialize
    import mem0 as mem0_pkg

    monkeypatch.setattr(mem0_pkg, "Memory", FakeMemory)

    svc = Mem0Service(settings=_settings(model="yuvi-embedding:0.6b"))
    monkeypatch.setattr(svc, "_ensure_idempotency_table", lambda: None)
    svc.initialize()
    assert svc.ready is True
    assert calls["from_config"] == 1
    result = last_patch_result()
    assert result is not None
    assert result.applied is True


def test_private_model_unsupported_version_fail_fast(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "yuvi_mem0.ollama_embedder_patch.get_mem0ai_version",
        lambda: "0.1.200",
    )

    import mem0 as mem0_pkg

    def _boom(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("Memory.from_config must not run for private+unsupported")

    monkeypatch.setattr(mem0_pkg, "Memory", type("M", (), {"from_config": staticmethod(_boom)}))

    svc = Mem0Service(settings=_settings(model="yuvi-embedding:0.6b"))
    with pytest.raises(SidecarError) as exc:
        svc.initialize()
    assert exc.value.code == MEM0_EMBEDDER_PATCH_UNSUPPORTED
    assert exc.value.retryable is False
    assert exc.value.status_code == 400
    assert svc.ready is False
    assert svc._memory is None
    result = last_patch_result()
    assert result is not None
    assert result.applied is False
    assert result.code == MEM0_EMBEDDER_PATCH_UNSUPPORTED


def test_public_model_unsupported_version_warns_and_continues(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(
        "yuvi_mem0.ollama_embedder_patch.get_mem0ai_version",
        lambda: "0.1.200",
    )

    import mem0 as mem0_pkg

    calls = {"from_config": 0}

    class FakeMemory:
        @classmethod
        def from_config(cls, _config: dict) -> FakeMemory:
            calls["from_config"] += 1
            from types import SimpleNamespace
            result = cls()
            result.vector_store = SimpleNamespace(collection_name="test", list_cols=lambda: ["test"])
            return result

    monkeypatch.setattr(mem0_pkg, "Memory", FakeMemory)

    svc = Mem0Service(settings=_settings(model="qwen3-embedding:0.6b"))
    with caplog.at_level(logging.WARNING, logger="yuvi_mem0.memory"):
        monkeypatch.setattr(svc, "_ensure_idempotency_table", lambda: None)
        with pytest.warns(UserWarning, match=MEM0_EMBEDDER_PATCH_UNSUPPORTED):
            svc.initialize()
    assert svc.ready is True
    assert calls["from_config"] == 1
    result = last_patch_result()
    assert result is not None
    assert result.applied is False
    assert any(
        "patch skipped" in r.message.lower() or "skipped" in r.message.lower()
        for r in caplog.records
    )
