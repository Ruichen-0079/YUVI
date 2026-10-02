from __future__ import annotations

import threading
import uuid
from types import SimpleNamespace
from typing import Any

from fastapi.testclient import TestClient

from yuvi_mem0.app import app
from yuvi_mem0.errors import SidecarError
from yuvi_mem0.memory import Mem0Service
from yuvi_mem0.schemas import MemoryRecord


class _ControlCursor:
    def __init__(self, connection: "_Connection") -> None:
        self.connection = connection

    def __enter__(self) -> "_ControlCursor":
        return self

    def __exit__(self, *_args: object) -> bool:
        return False

    def execute(self, query: str, params: tuple = ()) -> None:
        self.connection.statements.append((query, params))


class _NamedCursor:
    def __init__(self, rows: list[tuple[Any, ...]], name: str) -> None:
        self.rows = rows
        self.name = name
        self.itersize = 0
        self.closed = False
        self.statements: list[tuple[str, tuple]] = []

    def execute(self, query: str, params: tuple) -> None:
        self.statements.append((query, params))

    def fetchmany(self, count: int) -> list[tuple[Any, ...]]:
        batch, self.rows = self.rows[:count], self.rows[count:]
        return batch

    def close(self) -> None:
        self.closed = True


class _Connection:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self.rows = rows
        self.named: _NamedCursor | None = None
        self.statements: list[tuple[str, tuple]] = []
        self.commits = 0
        self.rollbacks = 0

    def cursor(self, name: str | None = None) -> Any:
        if name:
            self.named = _NamedCursor(self.rows, name)
            return self.named
        return _ControlCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


def _payload(scope: str, content: str = "grounded text") -> dict[str, Any]:
    return {"user_id": scope, "data": content, "created_at": None, "updated_at": None, "yuviLineageJson": "opaque"}


def _service(rows: list[tuple[Any, ...]], collection: str = "yuvi_mem0_qwen3_1024_v1") -> tuple[Mem0Service, _Connection]:
    connection = _Connection(rows)
    service = Mem0Service.__new__(Mem0Service)
    service._memory = SimpleNamespace(vector_store=SimpleNamespace(collection_name=collection))
    service._idempotency_conn = connection
    service._idempotency_lock = threading.RLock()
    service._storage_connection = lambda: connection  # type: ignore[method-assign]
    return service, connection


def test_bounded_snapshot_lists_4096_in_id_order_with_one_read_only_statement() -> None:
    scope = "yuvi:v1:user:local-user:character:lumi"
    rows = [(uuid.UUID(int=index + 1), _payload(scope), 96) for index in range(4097)]
    service, connection = _service(rows)
    items, marker = service.list_profile_snapshot(scope)
    assert len(items) == 4096
    assert items[0].id == str(uuid.UUID(int=1))
    assert items[-1].id == str(uuid.UUID(int=4096))
    assert marker == {"mode": "bounded_snapshot", "exhausted": False, "rawBytesExceeded": False}
    assert connection.named is not None and connection.named.itersize == 100 and connection.named.closed
    query, params = connection.named.statements[0]
    assert "payload->>'user_id' = %s" in query
    assert "order by id asc limit %s" in query.lower()
    assert "select vector" not in query.lower()
    assert params == (67_108_864, scope, 4097)
    assert connection.commits == 1 and connection.rollbacks == 0
    assert any("begin read only" in query.lower() for query, _ in connection.statements)
    assert any("statement_timeout" in query.lower() and "30000ms" in query for query, _ in connection.statements)


def test_lookahead_is_not_normalized_and_raw_overflow_discards_prefix() -> None:
    scope = "s"
    rows = [(uuid.UUID(int=index + 1), _payload(scope), 128) for index in range(4096)]
    rows.append((uuid.UUID(int=4097), {"user_id": scope}, 67_108_865))
    service, connection = _service(rows)
    items, marker = service.list_profile_snapshot(scope)
    assert items == []
    assert marker["rawBytesExceeded"] is True and marker["exhausted"] is False
    assert connection.rollbacks == 1 and connection.commits == 0

    # A malformed lookahead is only used to prove truncation; it never becomes evidence.
    safe_rows = [(uuid.UUID(int=index + 1), _payload(scope), 128) for index in range(4096)]
    safe_rows.append((uuid.UUID(int=4097), {"user_id": scope}, 10))
    service, _ = _service(safe_rows)
    items, marker = service.list_profile_snapshot(scope)
    assert len(items) == 4096 and marker["exhausted"] is False


def test_snapshot_rejects_malformed_evidence_rows_and_unsafe_collection_names() -> None:
    service, connection = _service([(uuid.UUID(int=1), {"user_id": "scope", "data": 42}, 50)])
    try:
        service.list_profile_snapshot("scope")
    except SidecarError as exc:
        assert exc.code == "MEMORY_RECORD_INVALID"
    else:
        raise AssertionError("invalid content must fail closed")
    assert connection.rollbacks == 1

    service, connection = _service([], collection="memories; drop table memories")
    try:
        service.list_profile_snapshot("scope")
    except SidecarError as exc:
        assert exc.code == "INTERNAL_ERROR"
    else:
        raise AssertionError("unsafe configured collection must fail closed")
    assert connection.named is None


def test_http_bounded_mode_requires_exact_parameters_and_returns_exhaustion_marker(monkeypatch: Any) -> None:
    import yuvi_mem0.app as app_module

    class _RouteService(Mem0Service):
        def list_memories(self, scope: str, limit: int, offset: int):
            assert scope == "s" and limit == 100 and offset == 0
            return [MemoryRecord(id=str(uuid.UUID(int=1)), content="ordinary", scope=scope, metadata={})]

        def list_profile_snapshot(self, scope: str):
            assert scope == "s"
            return [MemoryRecord(id=str(uuid.UUID(int=1)), content="text", scope=scope, metadata={})], {
                "mode": "bounded_snapshot", "exhausted": True, "rawBytesExceeded": False
            }

    route_service = _RouteService.__new__(_RouteService)
    monkeypatch.setattr(app_module, "get_service", lambda: route_service)
    monkeypatch.setattr(app_module, "_startup_initialize", lambda: None)
    monkeypatch.setattr(app_module, "_shutdown_release", lambda: None)
    with TestClient(app) as client:
        ok = client.get("/v1/memories", params={"scope": "s", "limit": 4096, "offset": 0, "mode": "bounded_snapshot"})
        invalid = client.get("/v1/memories", params={"scope": "s", "limit": 100, "offset": 0, "mode": "bounded_snapshot"})
        unsupported = client.get("/v1/memories", params={"scope": "s", "limit": 20, "mode": "other"})
        ordinary = client.get("/v1/memories", params={"scope": "s", "limit": 100, "offset": 0})
        ordinary_too_large = client.get("/v1/memories", params={"scope": "s", "limit": 101, "offset": 0})
    assert ok.status_code == 200
    assert ok.json()["data"]["snapshot"] == {"mode": "bounded_snapshot", "exhausted": True, "rawBytesExceeded": False}
    assert invalid.status_code == 400 and invalid.json()["error"]["code"] == "VALIDATION_ERROR"
    assert unsupported.status_code == 501 and unsupported.json()["error"]["code"] == "ENUMERATION_UNSUPPORTED"
    assert ordinary.status_code == 200 and "snapshot" not in ordinary.json()["data"]
    assert ordinary_too_large.status_code == 422
