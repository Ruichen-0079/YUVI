from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from yuvi_mem0.app import app
from yuvi_mem0.errors import MEMORY_LLM_NOT_CONFIGURED, SidecarError
from yuvi_mem0.memory import Mem0Service
from yuvi_mem0.schemas import (
    AddMemoryRequest,
    HealthCapabilities,
    HealthComponents,
    HealthData,
    HealthEmbedding,
    MemoryWriteResult,
)


class FakeService(Mem0Service):
    def __init__(self) -> None:  # type: ignore[no-untyped-def]
        self.init_calls = 0
        self.shutdown_calls = 0

    def initialize(self) -> None:  # type: ignore[override]
        self.init_calls += 1

    def shutdown(self) -> None:  # type: ignore[override]
        self.shutdown_calls += 1

    def health(self) -> HealthData:  # type: ignore[override]
        return HealthData(
            status="degraded",
            components=HealthComponents(
                mem0="healthy",
                embedder="healthy",
                vectorStore="healthy",
                memoryLlm="not_configured",
            ),
            capabilities=HealthCapabilities(infer=False, crud=True, search=True),
            embedding=HealthEmbedding(
                provider="ollama",
                model="yuvi-embedding:0.6b",
                dimensions=1024,
            ),
            collection="yuvi_mem0_qwen3_1024_v1",
            message="unit-test",
        )


def test_health_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    import yuvi_mem0.app as app_module

    fake = FakeService()
    monkeypatch.setattr(app_module, "get_service", lambda: fake)
    # Lifespan runs on context enter; fake initialize/shutdown keep tests offline.
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["embedding"]["dimensions"] == 1024
    assert body["data"]["embedding"]["model"] == "yuvi-embedding:0.6b"
    assert body["data"]["collection"] == "yuvi_mem0_qwen3_1024_v1"
    assert body["data"]["components"]["memoryLlm"] == "not_configured"
    assert body["data"]["capabilities"]["infer"] is False
    assert body["data"]["capabilities"]["profileSnapshotMode"] == "bounded_snapshot"
    assert body["data"]["status"] == "degraded"


class InferGuardService(Mem0Service):
    def __init__(self) -> None:  # type: ignore[no-untyped-def]
        from yuvi_mem0.config import Settings

        self.settings = Settings(
            _env_file=None,  # type: ignore[call-arg]
            mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
            mem0_llm_model="",
            mem0_llm_api_key="",
        )
        self._memory = object()
        self._init_error = None
        self._embed_cache = None
        self._vector_cache = None
        self.llm_calls = 0

    def initialize(self) -> None:  # type: ignore[override]
        return

    def shutdown(self) -> None:  # type: ignore[override]
        return

    def ensure_ready(self) -> Any:  # type: ignore[override]
        self.llm_calls += 1
        return self._memory

    def add(self, request: AddMemoryRequest) -> MemoryWriteResult:  # type: ignore[override]
        # Use real add guard path via parent if we wire properly — call parent logic.
        return Mem0Service.add(self, request)


def test_infer_true_without_llm_returns_stable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import yuvi_mem0.app as app_module

    service = InferGuardService()

    def _ensure_should_not_run() -> Any:
        raise AssertionError("ensure_ready must not run for infer=true without LLM")

    service.ensure_ready = _ensure_should_not_run  # type: ignore[method-assign]
    monkeypatch.setattr(app_module, "get_service", lambda: service)
    with TestClient(app) as client:
        response = client.post(
            "/v1/memories",
            json={
                "scope": "yuvi:v1:user:u:character:c",
                "content": "用户喜欢蓝色",
                "infer": True,
                "metadata": {},
            },
        )
    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"]["code"] == MEMORY_LLM_NOT_CONFIGURED
    assert body["error"]["retryable"] is False
    # Must not leak user content or secret material.
    dumped = str(body)
    assert "用户喜欢蓝色" not in dumped
    assert "sk-" not in dumped
    assert "password" not in dumped.lower()


def test_infer_false_does_not_require_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    import yuvi_mem0.app as app_module

    class OkService(InferGuardService):
        def add(self, request: AddMemoryRequest) -> MemoryWriteResult:  # type: ignore[override]
            if request.infer and not self.settings.has_memory_llm:
                raise SidecarError(
                    MEMORY_LLM_NOT_CONFIGURED,
                    "infer=true requires Memory LLM configuration.",
                    retryable=False,
                    status_code=400,
                )
            return MemoryWriteResult(
                memoryId="m1",
                operation="created",
                record=None,
            )

    service = OkService()
    monkeypatch.setattr(app_module, "get_service", lambda: service)
    with TestClient(app) as client:
        response = client.post(
            "/v1/memories",
            json={
                "scope": "yuvi:v1:user:u:character:c",
                "content": "用户喜欢蓝色",
                "infer": False,
                "metadata": {},
            },
        )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["memoryId"] == "m1"


def test_idempotent_routes_delegate_exact_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    import yuvi_mem0.app as app_module

    class IdempotentService(FakeService):
        def submit_idempotent(self, request):  # type: ignore[no-untyped-def]
            return MemoryWriteResult(memoryId="stable-id", operation="created", record=None)

        def reconcile_idempotency(self, key: str, digest: str):
            from yuvi_mem0.schemas import MemoryReconciliationResult

            assert key == "k"
            assert digest == "d"
            return MemoryReconciliationResult(status="applied", memoryId="stable-id")

    monkeypatch.setattr(app_module, "get_service", lambda: IdempotentService())
    with TestClient(app) as client:
        submitted = client.post(
            "/v1/memories/idempotent",
            json={
                "scope": "yuvi:v1:user:u:character:c",
                "content": "fact",
                "infer": False,
                "idempotencyKey": "k",
                "payloadDigest": "d",
            },
        )
        reconciled = client.post(
            "/v1/memories/idempotent/reconcile",
            json={"idempotencyKey": "k", "payloadDigest": "d"},
        )
    assert submitted.status_code == 200
    assert submitted.json()["data"]["memoryId"] == "stable-id"
    assert reconciled.status_code == 200
    assert reconciled.json()["data"]["status"] == "applied"


def test_noop_llm_raises_without_network() -> None:
    from yuvi_mem0.noop_llm import YuviNoopLLM, register_yuvi_noop_llm

    register_yuvi_noop_llm()
    llm = YuviNoopLLM()
    with pytest.raises(RuntimeError, match="MEMORY_LLM_NOT_CONFIGURED"):
        llm.generate_response([{"role": "user", "content": "hi"}])
