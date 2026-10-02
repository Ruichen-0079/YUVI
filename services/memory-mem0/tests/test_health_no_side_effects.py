from __future__ import annotations

from yuvi_mem0.config import Settings
from yuvi_mem0.memory import Mem0Service


def test_health_does_not_reinitialize_mem0(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
        mem0_llm_model="",
        mem0_llm_api_key="",
    )
    service = Mem0Service(settings=settings)
    service._memory = object()  # pretend already initialized

    calls = {"init": 0}

    def boom() -> None:
        calls["init"] += 1
        raise AssertionError("initialize must not be called from health")

    service.initialize = boom  # type: ignore[method-assign]
    service.probe_embedder = lambda force=False: ("healthy", None)  # type: ignore[method-assign]
    service.probe_vector_store = lambda force=False: ("healthy", None)  # type: ignore[method-assign]

    data = service.health()
    assert calls["init"] == 0
    assert data.components.memoryLlm == "not_configured"
    assert data.capabilities.infer is False
    assert data.capabilities.profileSnapshotMode == "bounded_snapshot"
    assert data.status == "degraded"


def test_health_embed_cache_avoids_repeat_calls() -> None:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
        mem0_health_embed_cache_ttl_s=60,
    )
    service = Mem0Service(settings=settings)
    service._memory = object()
    hits = {"n": 0}

    def probe(*, force: bool = False) -> tuple[str, str | None]:
        if not force and service._embed_cache is not None:
            return service._embed_cache[1], service._embed_cache[2]
        hits["n"] += 1
        import time

        service._embed_cache = (time.monotonic(), "healthy", None)
        return "healthy", None

    service.probe_embedder = probe  # type: ignore[method-assign]
    service.probe_vector_store = lambda force=False: ("healthy", None)  # type: ignore[method-assign]

    service.health()
    service.health()
    assert hits["n"] == 1
