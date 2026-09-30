from __future__ import annotations

import json
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from yuvi_mem0.memory import Mem0Service
from yuvi_mem0.schemas import IdempotentMemoryWriteRequest, UpdateMemoryRequest


class Cursor:
    def __init__(self, rows: list[tuple] | None = None) -> None:
        self.rows = rows or []
        self.executed: list[tuple[str, tuple]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, query: str, params=()):
        self.executed.append((query, params))

    def fetchone(self):
        if self.rows:
            return self.rows.pop(0)
        return None


class Connection:
    def __init__(self, cursor: Cursor) -> None:
        self.cursor_obj = cursor
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return self.cursor_obj

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def test_same_key_conflict_is_deterministic_without_backend_write() -> None:
    service = Mem0Service.__new__(Mem0Service)
    cursor = Cursor(rows=[("key", "old-digest", "applied", "stable-id", "created")])
    connection = Connection(cursor)
    service._memory = SimpleNamespace(
        vector_store=SimpleNamespace(conn=connection, collection_name="memories"),
        embedding_model=SimpleNamespace(embed=lambda *_args: [0.1]),
    )
    service._idempotency_conn = connection
    service._idempotency_lock = __import__("threading").RLock()

    request = IdempotentMemoryWriteRequest(
        scope="scope", content="fact", infer=False, idempotencyKey="key", payloadDigest="new-digest"
    )
    try:
        service.submit_idempotent(request)
    except Exception as exc:
        assert getattr(exc, "code", None) == "MEMORY_IDEMPOTENCY_CONFLICT"
    else:
        raise AssertionError("expected deterministic payload conflict")
    assert connection.commits == 1  # table bootstrap only


def _fake_service(connection: object, collection: str) -> Mem0Service:
    service = Mem0Service.__new__(Mem0Service)
    service._memory = SimpleNamespace(
        vector_store=SimpleNamespace(conn=connection, collection_name=collection),
        embedding_model=SimpleNamespace(embed=lambda *_args: [0.1, 0.2, 0.3]),
    )
    service._idempotency_conn = connection
    service._idempotency_lock = threading.RLock()
    return service


class _VectorRecord:
    def __init__(self, memory_id: str, payload: dict) -> None:
        self.id = memory_id
        self.payload = payload


class _PostgresVectorStore:
    def __init__(self, connection: object, collection: str) -> None:
        self.conn = connection
        self.collection_name = collection

    def get(self, *, vector_id: str) -> _VectorRecord | None:
        with self.conn.cursor() as cursor:
            cursor.execute(
                f"select payload from {self.collection_name} where id = %s", (vector_id,)
            )
            row = cursor.fetchone()
        if not row:
            return None
        return _VectorRecord(vector_id, row[0])

    def update(self, *, vector_id: str, vector: list[float], payload: dict) -> None:
        with self.conn.cursor() as cursor:
            cursor.execute(
                f"update {self.collection_name} set vector = %s, payload = %s where id = %s",
                (vector, json.dumps(payload, separators=(",", ":")), vector_id),
            )
        self.conn.commit()


class _HistoryDb:
    def add_history(self, *_args, **_kwargs) -> None:  # type: ignore[no-untyped-def]
        return


def _actual_mem0_update_memory(connection: object, collection: str):
    from mem0.configs.base import MemoryConfig
    from mem0.memory.main import Memory

    memory = Memory.__new__(Memory)
    memory.config = MemoryConfig()
    memory.collection_name = collection
    memory.api_version = "v1.1"
    memory._entity_store = None
    memory.graph = None
    memory.llm = type("Llm", (), {})()
    memory.vector_store = _PostgresVectorStore(connection, collection)
    memory.embedding_model = type(
        "EmbeddingModel",
        (),
        {
            "config": type("EmbeddingConfig", (), {"embedding_dims": 3})(),
            "embed": lambda _self, _content, _action: [0.4, 0.5, 0.6],
        },
    )()
    memory.db = _HistoryDb()
    return memory


class _UpdateService(Mem0Service):
    def __init__(self, connection: object, collection: str) -> None:
        self._memory = _actual_mem0_update_memory(connection, collection)
        self._idempotency_conn = connection
        self._idempotency_lock = threading.RLock()

    def ensure_ready(self):  # type: ignore[no-untyped-def]
        return self._memory


@pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL is not configured")
def test_postgres_idempotency_and_concurrency_contract() -> None:
    psycopg2 = pytest.importorskip("psycopg2")
    database_url = os.environ["DATABASE_URL"]
    collection = f"yuvi_c1_probe_{uuid.uuid4().hex}"
    key = f"test:yuvi-c1:{uuid.uuid4()}"
    digest = "digest-v1"
    request = IdempotentMemoryWriteRequest(
        scope="scope",
        content="fact",
        infer=False,
        idempotencyKey=key,
        payloadDigest=digest,
    )
    connections = []
    setup = psycopg2.connect(database_url)
    try:
        with setup.cursor() as cursor:
            cursor.execute(
                f"create table {collection} (id uuid primary key, vector vector(3), payload jsonb)"
            )
        setup.commit()

        first_connection = psycopg2.connect(database_url)
        connections.append(first_connection)
        service = _fake_service(first_connection, collection)
        assert service.reconcile_idempotency(key, digest).status == "not_applied"
        first = service.submit_idempotent(request)
        restart_connection = psycopg2.connect(database_url)
        connections.append(restart_connection)
        restarted_service = _fake_service(restart_connection, collection)
        duplicate = restarted_service.submit_idempotent(request)
        reconciled = restarted_service.reconcile_idempotency(key, digest)
        conflict = None
        try:
            restarted_service.submit_idempotent(
                request.model_copy(update={"payloadDigest": "digest-v2"})
            )
        except Exception as exc:  # noqa: BLE001
            conflict = exc

        assert first.operation == "created"
        assert duplicate.operation == "unchanged"
        assert reconciled.status == "applied"
        assert getattr(conflict, "code", None) == "MEMORY_IDEMPOTENCY_CONFLICT"

        reserved_key = f"test:yuvi-c1:reserved:{uuid.uuid4()}"
        reserved_digest = "reserved-digest"
        reserved_id = str(uuid.uuid5(uuid.NAMESPACE_URL, reserved_key))
        with first_connection.cursor() as cursor:
            cursor.execute(
                "insert into yuvi_memory_idempotency "
                "(idempotency_key, payload_digest, state, backend_memory_id, backend_operation) "
                "values (%s, %s, 'in_flight', %s, 'created')",
                (reserved_key, reserved_digest, reserved_id),
            )
        first_connection.commit()
        assert (
            restarted_service.reconcile_idempotency(reserved_key, reserved_digest).status
            == "in_flight"
        )

        applied_while_reserved_key = f"test:yuvi-c1:reserved-applied:{uuid.uuid4()}"
        applied_while_reserved_digest = "reserved-applied-digest"
        applied_while_reserved_id = str(
            uuid.uuid5(uuid.NAMESPACE_URL, applied_while_reserved_key)
        )
        with first_connection.cursor() as cursor:
            cursor.execute(
                "insert into yuvi_memory_idempotency "
                "(idempotency_key, payload_digest, state, backend_memory_id, backend_operation) "
                "values (%s, %s, 'in_flight', %s, 'created')",
                (
                    applied_while_reserved_key,
                    applied_while_reserved_digest,
                    applied_while_reserved_id,
                ),
            )
            cursor.execute(
                f"insert into {collection} (id, vector, payload) values (%s, %s, %s)",
                (
                    applied_while_reserved_id,
                    [0.1, 0.2, 0.3],
                    json.dumps(
                        {
                            "data": "reserved but applied",
                            "user_id": "scope",
                            "yuviIngestionKey": applied_while_reserved_key,
                            "yuviPayloadDigest": applied_while_reserved_digest,
                        }
                    ),
                ),
            )
        first_connection.commit()
        repaired = restarted_service.reconcile_idempotency(
            applied_while_reserved_key, applied_while_reserved_digest
        )
        assert repaired.status == "applied"
        assert repaired.memoryId == applied_while_reserved_id
        with first_connection.cursor() as cursor:
            cursor.execute(
                "select state from yuvi_memory_idempotency where idempotency_key = %s",
                (applied_while_reserved_key,),
            )
            assert cursor.fetchone()[0] == "applied"

        conflicting_key = f"test:yuvi-c1:reserved-conflict:{uuid.uuid4()}"
        conflicting_digest = "conflicting-digest"
        conflicting_id = str(uuid.uuid5(uuid.NAMESPACE_URL, conflicting_key))
        with first_connection.cursor() as cursor:
            cursor.execute(
                "insert into yuvi_memory_idempotency "
                "(idempotency_key, payload_digest, state, backend_memory_id, backend_operation) "
                "values (%s, %s, 'in_flight', %s, 'created')",
                (conflicting_key, conflicting_digest, conflicting_id),
            )
            cursor.execute(
                f"insert into {collection} (id, vector, payload) values (%s, %s, %s)",
                (
                    conflicting_id,
                    [0.1, 0.2, 0.3],
                    json.dumps(
                        {
                            "data": "conflicting effect",
                            "user_id": "scope",
                            "yuviIngestionKey": conflicting_key,
                            "yuviPayloadDigest": "other-digest",
                        }
                    ),
                ),
            )
        first_connection.commit()
        assert (
            restarted_service.reconcile_idempotency(conflicting_key, conflicting_digest).status
            == "payload_conflict"
        )

        missing_key = f"test:yuvi-c1:missing:{uuid.uuid4()}"
        missing_digest = "missing-digest"
        with first_connection.cursor() as cursor:
            cursor.execute(
                "insert into yuvi_memory_idempotency "
                "(idempotency_key, payload_digest, state, backend_memory_id, backend_operation) "
                "values (%s, %s, 'applied', %s, 'created')",
                (missing_key, missing_digest, str(uuid.uuid4())),
            )
        first_connection.commit()
        assert (
            restarted_service.reconcile_idempotency(missing_key, missing_digest).status == "unknown"
        )

        concurrent_key = f"test:yuvi-c1:concurrent:{uuid.uuid4()}"
        concurrent_request = request.model_copy(update={"idempotencyKey": concurrent_key})
        concurrent_connections = [psycopg2.connect(database_url) for _ in range(2)]
        connections.extend(concurrent_connections)

        def submit(index: int):
            try:
                return _fake_service(concurrent_connections[index], collection).submit_idempotent(
                    concurrent_request
                )
            except Exception as exc:  # noqa: BLE001
                return exc

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(submit, (0, 1)))
        successful = [result for result in results if not isinstance(result, Exception)]
        failures = [result for result in results if isinstance(result, Exception)]
        assert len(successful) + len(failures) == 2
        assert [result.operation for result in successful].count("created") == 1
        assert all(
            result.operation == "unchanged"
            for result in successful
            if result.operation != "created"
        )
        if failures:
            assert len(failures) == 1
            assert getattr(failures[0], "code", None) == "MEMORY_IDEMPOTENCY_IN_FLIGHT"
        assert (
            _fake_service(first_connection, collection)
            .submit_idempotent(concurrent_request)
            .operation
            == "unchanged"
        )
        with first_connection.cursor() as cursor:
            cursor.execute(
                f"select count(*) from {collection} where payload->>'yuviIngestionKey' in (%s, %s)",
                (key, concurrent_key),
            )
            assert cursor.fetchone()[0] == 2

        update_key = f"test:yuvi-c1:update:{uuid.uuid4()}"
        update_digest = "original-digest"
        update_request = request.model_copy(
            update={"idempotencyKey": update_key, "payloadDigest": update_digest}
        )
        update_connection = psycopg2.connect(database_url)
        connections.append(update_connection)
        update_service = _UpdateService(update_connection, collection)
        created = update_service.submit_idempotent(update_request)
        assert created.operation == "created"
        update_result = update_service.update(
            created.memoryId,
            UpdateMemoryRequest(
                content="edited fact",
                scope="scope",
                metadata={
                    "yuviIngestionKey": "attacker-key",
                    "yuviPayloadDigest": "attacker-digest",
                },
            ),
        )
        assert update_result.content == "edited fact"
        assert update_result.metadata["yuviIngestionKey"] == update_key
        assert update_result.metadata["yuviPayloadDigest"] == update_digest
        reopened_update_connection = psycopg2.connect(database_url)
        connections.append(reopened_update_connection)
        reopened_update_service = _UpdateService(reopened_update_connection, collection)
        assert (
            reopened_update_service.reconcile_idempotency(update_key, update_digest).status
            == "applied"
        )
        replay = reopened_update_service.submit_idempotent(update_request)
        assert replay.operation == "unchanged"
        assert replay.memoryId == created.memoryId
        with update_connection.cursor() as cursor:
            cursor.execute(f"select count(*) from {collection} where id = %s", (created.memoryId,))
            assert cursor.fetchone()[0] == 1
    finally:
        try:
            for connection in connections:
                connection.close()
            with setup.cursor() as cursor:
                cursor.execute(
                    "delete from yuvi_memory_idempotency where idempotency_key like %s",
                    ("test:yuvi-c1:%",),
                )
                cursor.execute(f"drop table if exists {collection}")
            setup.commit()
        finally:
            setup.close()
