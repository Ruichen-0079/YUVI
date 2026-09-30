"""Mem0 service wrapper with health probes and YUVI-normalized results."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx

from yuvi_mem0.config import Settings, get_settings
from yuvi_mem0.lineage_encoding import validate_lineage_encoding
from yuvi_mem0.errors import (
    EMBEDDER_UNAVAILABLE,
    INTERNAL_ERROR,
    MEM0_EMBEDDER_PATCH_UNSUPPORTED,
    MEM0_INITIALIZATION_FAILED,
    MEMORY_LLM_NOT_CONFIGURED,
    MEMORY_NOT_FOUND,
    UNSUPPORTED_OPERATION,
    VALIDATION_ERROR,
    SidecarError,
)
from yuvi_mem0.schemas import (
    AddMemoryRequest,
    HealthCapabilities,
    HealthComponents,
    HealthData,
    HealthEmbedding,
    IdempotentMemoryWriteRequest,
    MemoryHistoryEntry,
    MemoryReconciliationResult,
    MemoryRecord,
    MemoryWriteResult,
    SearchMemoryRequest,
    UpdateMemoryRequest,
)

logger = logging.getLogger("yuvi_mem0.memory")


class Mem0Service:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self._memory: Any | None = None
        self._init_error: str | None = None
        # Cached health probe results (no side-effectful re-init per request).
        self._embed_cache: tuple[float, str, str | None] | None = None
        self._vector_cache: tuple[float, str, str | None] | None = None
        self._idempotency_lock = threading.RLock()
        self._idempotency_conn: Any | None = None

    def shutdown(self) -> None:
        """
        Release Mem0 resources at process shutdown (lifespan end).

        Safe to call multiple times. After shutdown, a later initialize() may
        recreate Memory (startup path only — not per request).
        """
        memory = self._memory
        connection = getattr(self, "_idempotency_conn", None)
        if connection is not None:
            connection.close()
            self._idempotency_conn = None
        self._memory = None
        self._embed_cache = None
        self._vector_cache = None
        if memory is None:
            return
        # Memory.close releases SQLite only in 2.2.1. Close PGVector pools explicitly.
        close = getattr(memory, "close", None)
        if callable(close):
            close()
        for attr in ("db", "vector_store", "_telemetry_vector_store"):
            obj = getattr(memory, attr, None)
            if obj is None:
                continue
            pool = getattr(obj, "connection_pool", None)
            if pool is not None:
                closer = getattr(pool, "close", None) or getattr(pool, "closeall", None)
                if callable(closer):
                    closer()
            for method_name in ("close", "disconnect", "shutdown"):
                method = getattr(obj, method_name, None)
                if not callable(method):
                    continue
                try:
                    method()
                except Exception:  # noqa: BLE001
                    logger.debug(
                        "Mem0Service.shutdown: %s.%s failed",
                        attr,
                        method_name,
                        exc_info=True,
                    )
                break
        logger.info("Mem0Service shut down")

    def initialize(self) -> None:
        if self._memory is not None:
            return
        try:
            from mem0 import Memory  # type: ignore

            from yuvi_mem0.ollama_embedder_patch import (
                EMBEDDER_MODEL_NOT_LOCAL,
                Mem0EmbedderPatchError,
                is_private_ollama_tag,
                patch_ollama_embedder,
            )

            # Private yuvi-* tags require the 2.2.1 patch (strict fail-fast).
            # Public models: warn + skip patch on unsupported mem0ai; keep pull.
            private_embedder = is_private_ollama_tag(self.settings.mem0_embedder_model)
            try:
                patch_result = patch_ollama_embedder(strict_version=private_embedder)
            except Mem0EmbedderPatchError as exc:
                self._memory = None
                self._init_error = exc.message
                if exc.code == MEM0_EMBEDDER_PATCH_UNSUPPORTED:
                    logger.error(
                        "Mem0 refuse start: private embedder requires mem0ai==2.2.1 "
                        "patch (model=%s)",
                        self.settings.mem0_embedder_model,
                    )
                    raise SidecarError(
                        MEM0_EMBEDDER_PATCH_UNSUPPORTED,
                        exc.message,
                        retryable=False,
                        status_code=400,
                    ) from exc
                raise SidecarError(
                    EMBEDDER_UNAVAILABLE,
                    exc.message,
                    retryable=False,
                    status_code=503,
                ) from exc

            if not patch_result.applied:
                logger.warning(
                    "Ollama embedder patch skipped code=%s reason=%s mem0=%s private_embedder=%s",
                    patch_result.code or MEM0_EMBEDDER_PATCH_UNSUPPORTED,
                    patch_result.reason,
                    patch_result.mem0_version,
                    private_embedder,
                )

            config = self.settings.build_mem0_config()
            # Ensure noop provider is registered before Memory constructs LLM.
            if not self.settings.has_memory_llm:
                from yuvi_mem0.noop_llm import register_yuvi_noop_llm

                register_yuvi_noop_llm()
            self._memory = Memory.from_config(config)
            vector_store = self._memory.vector_store
            if vector_store.collection_name not in vector_store.list_cols():
                vector_store.create_col()
            self._ensure_idempotency_table()
            self._init_error = None
            logger.info(
                "Mem0 initialized collection=%s dims=%s model=%s llm_configured=%s",
                self.settings.mem0_pg_collection,
                self.settings.mem0_embedder_dimensions,
                self.settings.mem0_embedder_model,
                self.settings.has_memory_llm,
            )
        except SidecarError as exc:
            self._memory = None
            if self._init_error is None:
                self._init_error = exc.message
            raise
        except Exception as exc:  # noqa: BLE001
            from yuvi_mem0.ollama_embedder_patch import (
                EMBEDDER_MODEL_NOT_LOCAL,
                Mem0EmbedderPatchError,
            )

            self._memory = None
            if isinstance(exc, Mem0EmbedderPatchError):
                self._init_error = exc.message
                if exc.code == EMBEDDER_MODEL_NOT_LOCAL:
                    raise SidecarError(
                        EMBEDDER_UNAVAILABLE,
                        exc.message,
                        retryable=False,
                        status_code=503,
                    ) from exc
                if exc.code == MEM0_EMBEDDER_PATCH_UNSUPPORTED:
                    raise SidecarError(
                        MEM0_EMBEDDER_PATCH_UNSUPPORTED,
                        exc.message,
                        retryable=False,
                        status_code=400,
                    ) from exc
            self._init_error = _safe_error_message(exc)
            logger.exception("Mem0 initialization failed")
            raise SidecarError(
                MEM0_INITIALIZATION_FAILED,
                f"Mem0 initialization failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=503,
            ) from exc

    @property
    def ready(self) -> bool:
        return self._memory is not None

    def ensure_ready(self) -> Any:
        if self._memory is None:
            self.initialize()
        assert self._memory is not None
        return self._memory

    def probe_embedder(self, *, force: bool = False) -> tuple[str, str | None]:
        ttl = max(0, int(self.settings.mem0_health_embed_cache_ttl_s))
        now = time.monotonic()
        if not force and self._embed_cache is not None and ttl > 0:
            cached_at, status, msg = self._embed_cache
            if now - cached_at < ttl:
                return status, msg
        try:
            url = f"{self.settings.mem0_ollama_base_url.rstrip('/')}/api/embed"
            with httpx.Client(timeout=5.0) as client:
                response = client.post(
                    url,
                    json={
                        "model": self.settings.mem0_embedder_model,
                        "input": "yuvi-health-check",
                    },
                )
            if response.status_code >= 400:
                result: tuple[str, str | None] = (
                    "unhealthy",
                    f"Ollama embed HTTP {response.status_code}",
                )
            else:
                data = response.json()
                vectors = data.get("embeddings") or []
                if not vectors:
                    result = ("unhealthy", "Ollama returned no embeddings")
                else:
                    dims = len(vectors[0])
                    if dims != self.settings.mem0_embedder_dimensions:
                        result = (
                            "unhealthy",
                            f"embedding dimensions mismatch: expected "
                            f"{self.settings.mem0_embedder_dimensions}, got {dims}",
                        )
                    else:
                        result = ("healthy", None)
        except Exception as exc:  # noqa: BLE001
            result = ("unhealthy", _safe_error_message(exc))
        self._embed_cache = (now, result[0], result[1])
        return result

    def probe_vector_store(self, *, force: bool = False) -> tuple[str, str | None]:
        ttl = max(0, int(self.settings.mem0_health_embed_cache_ttl_s))
        now = time.monotonic()
        if not force and self._vector_cache is not None and ttl > 0:
            cached_at, status, msg = self._vector_cache
            if now - cached_at < ttl:
                return status, msg
        if not self.settings.has_pg:
            result: tuple[str, str | None] = (
                "unhealthy",
                "MEM0_PG_CONNECTION_STRING is not configured",
            )
            self._vector_cache = (now, result[0], result[1])
            return result
        try:
            import psycopg

            # Hard timeouts so /health never blocks for minutes on bad DNS/network.
            with psycopg.connect(
                self.settings.mem0_pg_connection_string,
                connect_timeout=3,
                options="-c statement_timeout=3000",
            ) as conn:
                with conn.cursor() as cur:
                    cur.execute("select 1")
                    # Read-only probe: do not CREATE EXTENSION on every health hit.
                    cur.execute(
                        "select exists(select 1 from pg_extension where extname = 'vector')"
                    )
                    row = cur.fetchone()
                    has_vector = bool(row and row[0])
                    if not has_vector:
                        result = ("unhealthy", "pgvector extension is not installed")
                    else:
                        collection = self.settings.mem0_pg_collection
                        cur.execute("select to_regclass(%s) is not null", (collection,))
                        table_row = cur.fetchone()
                        if table_row and table_row[0]:
                            result = ("healthy", None)
                        else:
                            # Table may be created lazily on first write; connectivity ok.
                            result = (
                                "healthy",
                                f"collection table '{collection}' not yet created",
                            )
        except Exception as exc:  # noqa: BLE001
            result = ("unhealthy", _safe_error_message(exc))
        self._vector_cache = (now, result[0], result[1])
        return result

    def probe_memory_llm(self) -> tuple[str, str | None]:
        if not self.settings.has_memory_llm:
            return "not_configured", "Memory LLM is not configured (infer=true unavailable)"
        return "healthy", None

    def health(self) -> HealthData:
        # Health must not re-initialize Mem0 or run add/search.
        embedder_status, embedder_msg = self.probe_embedder()
        vector_status, vector_msg = self.probe_vector_store()
        llm_status, llm_msg = self.probe_memory_llm()

        mem0_status = "healthy" if self.ready else "unhealthy"
        if self._init_error and not self.ready:
            mem0_status = "unhealthy"

        crud_ok = self.ready and embedder_status == "healthy" and vector_status == "healthy"
        infer_ok = bool(self.settings.has_memory_llm and crud_ok)

        hard_fail = (
            embedder_status == "unhealthy"
            or vector_status == "unhealthy"
            or mem0_status == "unhealthy"
        )
        if hard_fail:
            overall = "unhealthy"
        elif llm_status == "not_configured" or not infer_ok:
            overall = "degraded"
        else:
            overall = "healthy"

        messages = [m for m in (embedder_msg, vector_msg, llm_msg, self._init_error) if m]
        return HealthData(
            status=overall,  # type: ignore[arg-type]
            components=HealthComponents(
                mem0=mem0_status,
                embedder=embedder_status,
                vectorStore=vector_status,
                memoryLlm=llm_status,
            ),
            capabilities=HealthCapabilities(
                infer=infer_ok,
                crud=crud_ok,
                search=crud_ok,
            ),
            embedding=HealthEmbedding(
                provider=self.settings.mem0_embedder_provider,
                model=self.settings.mem0_embedder_model,
                dimensions=self.settings.mem0_embedder_dimensions,
            ),
            collection=self.settings.mem0_pg_collection,
            message="; ".join(messages) if messages else None,
        )

    def add(self, request: AddMemoryRequest) -> MemoryWriteResult:
        if request.infer and not self.settings.has_memory_llm:
            raise SidecarError(
                MEMORY_LLM_NOT_CONFIGURED,
                "infer=true requires Memory LLM configuration.",
                retryable=False,
                status_code=400,
            )
        memory = self.ensure_ready()
        metadata = request.metadata.model_dump(exclude_none=True)
        validate_lineage_encoding(metadata)
        metadata.setdefault("schemaVersion", 1)

        payload: Any
        if request.messages:
            payload = [message.model_dump() for message in request.messages]
        elif request.content and request.content.strip():
            payload = request.content.strip()
        else:
            raise SidecarError(
                VALIDATION_ERROR,
                "Either content or messages is required.",
                status_code=400,
            )

        try:
            result = memory.add(
                payload,
                user_id=request.scope,
                metadata=metadata,
                infer=request.infer,
            )
        except SidecarError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 add failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=500,
            ) from exc

        return self._normalize_write_result(result, scope=request.scope, metadata=metadata)

    def submit_idempotent(self, request: IdempotentMemoryWriteRequest) -> MemoryWriteResult:
        """Apply one finalized event under a durable, exact backend identity.

        The durable reservation is committed before embedding. The pgvector
        row and the transition from ``in_flight`` to ``applied`` are committed
        together in a second PostgreSQL transaction. Mem0's ordinary ``add``
        path is not used here because it generates a random UUID and commits
        through a separate history SQLite database.
        """
        if request.infer:
            raise SidecarError(
                VALIDATION_ERROR,
                "Idempotent finalized writes require infer=false.",
                status_code=400,
            )
        memory = self.ensure_ready()
        payload = self._request_payload(request)
        metadata = request.metadata.model_dump(exclude_none=True)
        validate_lineage_encoding(metadata)
        metadata.update(
            {
                "user_id": request.scope,
                "data": payload,
                "hash": hashlib.md5(payload.encode()).hexdigest(),
                "created_at": datetime.now(timezone.utc).isoformat(),
                "yuviIngestionKey": request.idempotencyKey,
                "yuviPayloadDigest": request.payloadDigest,
            }
        )
        backend_id = str(uuid.uuid5(uuid.NAMESPACE_URL, request.idempotencyKey))
        with self._idempotency_lock:
            self._ensure_idempotency_table()
            vector_store = getattr(memory, "vector_store", None)
            connection = self._storage_connection()
            collection = getattr(vector_store, "collection_name", None)
            if connection is None or not isinstance(collection, str):
                raise SidecarError(
                    INTERNAL_ERROR,
                    "Idempotent backend storage is unavailable.",
                    retryable=False,
                    status_code=503,
                )
            table = _safe_identifier(collection)
            try:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "select idempotency_key, payload_digest, state, backend_memory_id, "
                        "backend_operation from yuvi_memory_idempotency "
                        "where idempotency_key = %s for update",
                        (request.idempotencyKey,),
                    )
                    existing = cursor.fetchone()
                    if existing:
                        if existing[1] != request.payloadDigest:
                            connection.rollback()
                            raise SidecarError(
                                "MEMORY_IDEMPOTENCY_CONFLICT",
                                "Idempotency key is already bound to a different payload.",
                                status_code=409,
                            )
                        if existing[2] == "in_flight":
                            connection.rollback()
                            raise SidecarError(
                                "MEMORY_IDEMPOTENCY_IN_FLIGHT",
                                "Idempotent operation is still in flight.",
                                retryable=True,
                                status_code=409,
                            )
                        record = self._get_vector_record(
                            cursor,
                            table,
                            str(existing[3]),
                            request.scope,
                            expected_key=request.idempotencyKey,
                            expected_digest=request.payloadDigest,
                        )
                        if record is None:
                            connection.rollback()
                            raise SidecarError(
                                "MEMORY_IDEMPOTENCY_EFFECT_MISSING",
                                "Idempotency journal points to a missing backend effect.",
                                status_code=503,
                            )
                        connection.rollback()
                        return MemoryWriteResult(
                            memoryId=str(existing[3]), operation="unchanged", record=record
                        )

                    cursor.execute(
                        "insert into yuvi_memory_idempotency "
                        "(idempotency_key, payload_digest, state, backend_memory_id, "
                        "backend_operation) values (%s, %s, 'in_flight', %s, 'created') "
                        "on conflict (idempotency_key) do nothing returning idempotency_key",
                        (request.idempotencyKey, request.payloadDigest, backend_id),
                    )
                    inserted = cursor.fetchone()
                    if not inserted:
                        cursor.execute(
                            "select payload_digest, state, backend_memory_id, backend_operation "
                            "from yuvi_memory_idempotency where idempotency_key = %s for update",
                            (request.idempotencyKey,),
                        )
                        reserved = cursor.fetchone()
                        if reserved and reserved[1] == "applied":
                            record = self._get_vector_record(
                                cursor,
                                table,
                                str(reserved[2]),
                                request.scope,
                                expected_key=request.idempotencyKey,
                                expected_digest=request.payloadDigest,
                            )
                            if record is not None:
                                connection.rollback()
                                return MemoryWriteResult(
                                    memoryId=str(reserved[2]),
                                    operation="unchanged",
                                    record=record,
                                )
                            connection.rollback()
                            raise SidecarError(
                                "MEMORY_IDEMPOTENCY_EFFECT_MISSING",
                                "Idempotency journal points to a missing backend effect.",
                                status_code=503,
                            )
                        connection.rollback()
                        raise SidecarError(
                            "MEMORY_IDEMPOTENCY_IN_FLIGHT",
                            "Idempotent operation is still in flight.",
                            retryable=True,
                            status_code=409,
                        )
                    connection.commit()

                embedding = memory.embedding_model.embed(payload, "add")
                with connection.cursor() as cursor:
                    cursor.execute(
                        f"insert into {table} (id, vector, payload) values (%s, %s, %s)",
                        (backend_id, embedding, _json_value(metadata)),
                    )
                    cursor.execute(
                        "update yuvi_memory_idempotency set state = 'applied', "
                        "updated_at = now() where idempotency_key = %s and state = 'in_flight'",
                        (request.idempotencyKey,),
                    )
                    if cursor.rowcount != 1:
                        connection.rollback()
                        raise SidecarError(
                            "MEMORY_IDEMPOTENCY_IN_FLIGHT",
                            "Idempotent operation is still in flight.",
                            retryable=True,
                            status_code=409,
                        )
                    connection.commit()
                return MemoryWriteResult(
                    memoryId=backend_id,
                    operation="created",
                    record=MemoryRecord(
                        id=backend_id,
                        content=payload,
                        scope=request.scope,
                        metadata=metadata,
                        createdAt=metadata["created_at"],
                    ),
                )
            except SidecarError:
                raise
            except Exception as exc:  # noqa: BLE001
                try:
                    connection.rollback()
                except Exception:  # noqa: BLE001
                    pass
                raise SidecarError(
                    INTERNAL_ERROR,
                    f"Idempotent memory write failed: {_safe_error_message(exc)}",
                    retryable=True,
                    status_code=503,
                ) from exc

    def reconcile_idempotency(
        self, idempotency_key: str, payload_digest: str
    ) -> MemoryReconciliationResult:
        memory = self.ensure_ready()
        with self._idempotency_lock:
            self._ensure_idempotency_table()
            vector_store = getattr(memory, "vector_store", None)
            connection = self._storage_connection()
            collection = getattr(vector_store, "collection_name", None)
            if connection is None or not isinstance(collection, str):
                return MemoryReconciliationResult(status="unknown", errorCode="BACKEND_UNAVAILABLE")
            table = _safe_identifier(collection)
            backend_id = str(uuid.uuid5(uuid.NAMESPACE_URL, idempotency_key))
            try:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "select payload_digest, state, backend_memory_id, backend_operation "
                        "from yuvi_memory_idempotency where idempotency_key = %s for update",
                        (idempotency_key,),
                    )
                    journal = cursor.fetchone()
                    if journal and journal[0] != payload_digest:
                        connection.rollback()
                        return MemoryReconciliationResult(status="payload_conflict")
                    exact_id = str(journal[2]) if journal and journal[2] else backend_id
                    vector = self._get_vector_payload(cursor, table, exact_id)
                    if vector is None:
                        connection.rollback()
                        return MemoryReconciliationResult(
                            status=(
                                "in_flight"
                                if journal and journal[1] == "in_flight"
                                else "unknown" if journal else "not_applied"
                            )
                        )
                    stored_key = vector.get("yuviIngestionKey")
                    stored_digest = vector.get("yuviPayloadDigest")
                    if stored_key != idempotency_key or stored_digest != payload_digest:
                        connection.rollback()
                        return MemoryReconciliationResult(status="payload_conflict")
                    if journal and journal[1] == "in_flight":
                        cursor.execute(
                            "update yuvi_memory_idempotency set state = 'applied', "
                            "updated_at = now() where idempotency_key = %s "
                            "and payload_digest = %s and state = 'in_flight'",
                            (idempotency_key, payload_digest),
                        )
                        if cursor.rowcount != 1:
                            connection.rollback()
                            return MemoryReconciliationResult(status="unknown")
                        connection.commit()
                    else:
                        connection.rollback()
                    return MemoryReconciliationResult(
                        status="applied",
                        memoryId=exact_id,
                        operation=str(journal[3]) if journal and journal[3] else "created",
                    )
            except Exception as exc:  # noqa: BLE001
                try:
                    connection.rollback()
                except Exception:  # noqa: BLE001
                    pass
                return MemoryReconciliationResult(
                    status="unknown", errorCode=f"{type(exc).__name__}"
                )

    def _storage_connection(self) -> Any:
        """YUVI-owned transaction connection; independent of Mem0's pooled driver."""
        connection = getattr(self, "_idempotency_conn", None)
        if connection is None or getattr(connection, "closed", False):
            import psycopg2

            connection = psycopg2.connect(self.settings.mem0_pg_connection_string, connect_timeout=3)
            self._idempotency_conn = connection
        return connection

    def _ensure_idempotency_table(self) -> None:
        memory = self._memory
        vector_store = getattr(memory, "vector_store", None) if memory is not None else None
        connection = self._storage_connection()
        if connection is None:
            return
        with connection.cursor() as cursor:
            cursor.execute(
                "create table if not exists yuvi_memory_idempotency ("
                "idempotency_key text primary key, payload_digest text not null, "
                "state text not null check (state in ('in_flight', 'applied')), "
                "backend_memory_id uuid, backend_operation text, "
                "created_at timestamptz not null default now(), "
                "updated_at timestamptz not null default now())"
            )
        connection.commit()

    @staticmethod
    def _request_payload(request: IdempotentMemoryWriteRequest) -> str:
        if request.messages:
            return "\n".join(
                message.content.strip() for message in request.messages if message.content.strip()
            )
        if request.content and request.content.strip():
            return request.content.strip()
        raise SidecarError(
            VALIDATION_ERROR, "Either content or messages is required.", status_code=400
        )

    @staticmethod
    def _get_vector_payload(cursor: Any, table: str, memory_id: str) -> dict[str, Any] | None:
        cursor.execute(f"select payload from {table} where id = %s", (memory_id,))
        row = cursor.fetchone()
        return row[0] if row and isinstance(row[0], dict) else None

    def _get_vector_record(
        self,
        cursor: Any,
        table: str,
        memory_id: str,
        scope: str,
        *,
        expected_key: str | None = None,
        expected_digest: str | None = None,
    ) -> MemoryRecord | None:
        payload = self._get_vector_payload(cursor, table, memory_id)
        if payload is None or payload.get("user_id") != scope:
            return None
        if expected_key is not None and payload.get("yuviIngestionKey") != expected_key:
            return None
        if expected_digest is not None and payload.get("yuviPayloadDigest") != expected_digest:
            return None
        return MemoryRecord(
            id=memory_id,
            content=str(payload.get("data") or ""),
            scope=scope,
            metadata=payload,
            createdAt=_as_optional_str(payload.get("created_at")),
            updatedAt=_as_optional_str(payload.get("updated_at")),
        )

    def search(self, request: SearchMemoryRequest) -> list[MemoryRecord]:
        memory = self.ensure_ready()
        try:
            raw = memory.search(
                request.query,
                filters={"user_id": request.scope},
                top_k=request.limit,
            )
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 search failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=500,
            ) from exc
        items = self._extract_list(raw)
        return [self._to_record(item, default_scope=request.scope) for item in items]

    def get(self, memory_id: str, scope: str | None = None) -> MemoryRecord:
        memory = self.ensure_ready()
        try:
            raw = memory.get(memory_id)
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 get failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=500,
            ) from exc
        if not raw:
            raise SidecarError(MEMORY_NOT_FOUND, f"Memory {memory_id} not found.", status_code=404)
        record = self._to_record(raw, default_scope=scope or "")
        if scope and not self._scope_matches(raw, scope, record):
            raise SidecarError(MEMORY_NOT_FOUND, f"Memory {memory_id} not found.", status_code=404)
        return record

    def list_memories(self, scope: str, limit: int = 20, offset: int = 0) -> list[MemoryRecord]:
        memory = self.ensure_ready()
        try:
            if hasattr(memory, "get_all"):
                raw = memory.get_all(filters={"user_id": scope}, top_k=offset + limit)
            else:
                raw = []
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 list failed: {_safe_error_message(exc)}",
                retryable=True,
                status_code=500,
            ) from exc
        items = self._extract_list(raw)
        sliced = items[offset : offset + limit]
        return [self._to_record(item, default_scope=scope) for item in sliced]

    def update(self, memory_id: str, request: UpdateMemoryRequest) -> MemoryRecord:
        memory = self.ensure_ready()
        existing_record = self.get(memory_id, scope=request.scope)
        if "yuviLineageEncoding" in existing_record.metadata:
            raise SidecarError(VALIDATION_ERROR, "Grounded evidence is immutable; admit a new source-backed correction.", status_code=409)
        if request.scope:
            # Enforce scope isolation before update.
            self.get(memory_id, scope=request.scope)
        try:
            yuvi_identity = self._read_yuvi_identity(memory, memory_id)
            if yuvi_identity is not None:
                self._update_yuvi_memory(memory, memory_id, request.content, yuvi_identity)
            elif hasattr(memory, "update"):
                memory.update(memory_id, text=request.content)
            else:
                raise SidecarError(
                    INTERNAL_ERROR,
                    "Mem0 update is not available in this package version.",
                    status_code=501,
                )
        except SidecarError:
            raise
        except Exception as exc:  # noqa: BLE001
            message = str(exc).lower()
            if "not found" in message:
                raise SidecarError(
                    MEMORY_NOT_FOUND, f"Memory {memory_id} not found.", status_code=404
                ) from exc
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 update failed: {_safe_error_message(exc)}",
                retryable=True,
            ) from exc
        return self.get(memory_id, scope=request.scope)

    @staticmethod
    def _read_yuvi_identity(memory: Any, memory_id: str) -> dict[str, str] | None:
        """Read the immutable Yuvi identity directly from the canonical vector row."""
        vector_store = getattr(memory, "vector_store", None)
        getter = getattr(vector_store, "get", None)
        if not callable(getter):
            return None
        existing = getter(vector_id=memory_id)
        payload = getattr(existing, "payload", None)
        if not isinstance(payload, dict):
            return None
        key = payload.get("yuviIngestionKey")
        digest = payload.get("yuviPayloadDigest")
        if key is None and digest is None:
            return None
        if not isinstance(key, str) or not key or not isinstance(digest, str) or not digest:
            raise SidecarError(
                INTERNAL_ERROR,
                "Yuvi memory identity is incomplete and cannot be safely updated.",
                retryable=False,
                status_code=503,
            )
        return {"yuviIngestionKey": key, "yuviPayloadDigest": digest}

    @staticmethod
    def _update_yuvi_memory(
        memory: Any, memory_id: str, content: str, identity: dict[str, str]
    ) -> None:
        """Run Mem0's normal update primitive with only immutable Yuvi identity added."""
        update_memory = getattr(memory, "_update_memory", None)
        embedding_model = getattr(memory, "embedding_model", None)
        embed = getattr(embedding_model, "embed", None)
        if not callable(update_memory) or not callable(embed):
            raise SidecarError(
                INTERNAL_ERROR,
                "Mem0 update primitive is unavailable for Yuvi-identified memory.",
                retryable=False,
                status_code=503,
            )
        embeddings = embed(content, "update")
        # Mem0's internal update preserves its normal data/hash/timestamp, vector,
        # and history behavior. Only the two immutable Yuvi identity fields are
        # supplied as metadata; caller metadata cannot replace them.
        update_memory(memory_id, content, {content: embeddings}, metadata=identity)

    def delete(self, memory_id: str, scope: str | None = None) -> None:
        memory = self.ensure_ready()
        if scope:
            self.get(memory_id, scope=scope)
        try:
            memory.delete(memory_id)
        except Exception as exc:  # noqa: BLE001
            message = str(exc).lower()
            if "not found" in message:
                raise SidecarError(
                    MEMORY_NOT_FOUND, f"Memory {memory_id} not found.", status_code=404
                ) from exc
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 delete failed: {_safe_error_message(exc)}",
                retryable=True,
            ) from exc

    def history(self, memory_id: str, scope: str | None = None) -> list[MemoryHistoryEntry]:
        """
        Normalize mem0ai 2.2.1 history rows into MemoryHistoryEntry.

        mem0 stores history in a local SQLite history.db keyed by memory_id.
        When scope is provided we verify the memory belongs to that scope first.
        Missing IDs return an empty list (stable), not a vague structure.
        """
        memory = self.ensure_ready()
        if scope:
            # Scope isolation: wrong-scope IDs must not leak history.
            try:
                self.get(memory_id, scope=scope)
            except SidecarError as exc:
                if exc.code == MEMORY_NOT_FOUND:
                    return []
                raise
        try:
            if not hasattr(memory, "history"):
                # Explicit: do not invent history from unrelated SDK fields.
                raise SidecarError(
                    UNSUPPORTED_OPERATION,
                    "Memory history is not available in this Mem0 build.",
                    retryable=False,
                    status_code=501,
                )
            raw = memory.history(memory_id)
        except SidecarError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SidecarError(
                INTERNAL_ERROR,
                f"Mem0 history failed: {_safe_error_message(exc)}",
                retryable=True,
            ) from exc
        # Stable empty list when SDK returns nothing (missing id or no events).
        items = self._extract_list(raw)
        results: list[MemoryHistoryEntry] = []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                # Skip non-dict rows rather than returning unstable shapes.
                continue
            event = str(item.get("event") or item.get("action") or "unknown").strip() or "unknown"
            # Only accept known-ish event tokens; unknown remains "unknown" (stable).
            results.append(
                MemoryHistoryEntry(
                    id=str(item.get("id") or f"{memory_id}:{index}"),
                    memoryId=str(item.get("memory_id") or memory_id),
                    event=event,
                    previousValue=_as_optional_str(
                        item.get("previous_value") or item.get("old_memory")
                    ),
                    newValue=_as_optional_str(item.get("new_value") or item.get("new_memory")),
                    createdAt=_as_optional_str(item.get("created_at") or item.get("updated_at")),
                )
            )
        return results

    def _normalize_write_result(
        self,
        raw: Any,
        *,
        scope: str,
        metadata: dict[str, Any],
    ) -> MemoryWriteResult:
        items = self._extract_list(raw)
        if not items and isinstance(raw, dict):
            items = self._extract_list(raw.get("results"))
        if not items:
            return MemoryWriteResult(memoryId="unchanged", operation="unchanged", record=None)

        first = items[0] if isinstance(items[0], dict) else {"id": str(items[0]), "memory": ""}
        memory_id = str(
            first.get("id") or first.get("memory_id") or first.get("event_id") or "unknown"
        )
        event = str(first.get("event") or first.get("action") or "ADD").upper()
        if "DELETE" in event:
            operation = "deleted"
        elif "UPDATE" in event:
            operation = "updated"
        elif "NOOP" in event or "NONE" in event:
            operation = "unchanged"
        else:
            operation = "created"
        content = str(first.get("memory") or first.get("data") or first.get("text") or "")
        record = MemoryRecord(
            id=memory_id,
            content=content,
            scope=scope,
            metadata={**metadata, **(first.get("metadata") or {})},
            createdAt=_as_optional_str(first.get("created_at")),
            updatedAt=_as_optional_str(first.get("updated_at")),
        )
        return MemoryWriteResult(memoryId=memory_id, operation=operation, record=record)  # type: ignore[arg-type]

    def _to_record(self, item: Any, *, default_scope: str) -> MemoryRecord:
        if not isinstance(item, dict):
            return MemoryRecord(id=str(item), content=str(item), scope=default_scope, metadata={})
        memory_id = str(item.get("id") or item.get("memory_id") or "unknown")
        content = str(
            item.get("memory") or item.get("data") or item.get("text") or item.get("content") or ""
        )
        scope = str(item.get("user_id") or item.get("scope") or default_scope)
        raw_meta = item.get("metadata")
        metadata: dict[str, Any] = raw_meta if isinstance(raw_meta, dict) else {}
        score = item.get("score")
        return MemoryRecord(
            id=memory_id,
            content=content,
            scope=scope,
            metadata=metadata,
            score=float(score) if isinstance(score, (int, float)) else None,
            createdAt=_as_optional_str(item.get("created_at")),
            updatedAt=_as_optional_str(item.get("updated_at")),
        )

    @staticmethod
    def _scope_matches(raw: Any, scope: str, record: MemoryRecord) -> bool:
        if record.scope and record.scope == scope:
            return True
        if isinstance(raw, dict):
            user_id = raw.get("user_id") or ""
            if user_id and user_id == scope:
                return True
            if user_id and user_id != scope:
                return False
            # Some get() payloads omit user_id; fall back to record.scope.
        return not record.scope or record.scope == scope

    @staticmethod
    def _extract_list(raw: Any) -> list[Any]:
        if raw is None:
            return []
        if isinstance(raw, list):
            return raw
        if isinstance(raw, dict):
            for key in ("results", "memories", "data", "items"):
                value = raw.get(key)
                if isinstance(value, list):
                    return value
            return [raw]
        return []


_service: Mem0Service | None = None


def get_service() -> Mem0Service:
    global _service
    if _service is None:
        _service = Mem0Service()
    return _service


def reset_service_for_tests() -> None:
    """Test helper: shutdown + clear the process-global service singleton."""
    global _service
    if _service is not None:
        try:
            _service.shutdown()
        except Exception:  # noqa: BLE001
            logger.debug("reset_service_for_tests shutdown failed", exc_info=True)
    _service = None


def _as_optional_str(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _safe_error_message(exc: BaseException) -> str:
    """Strip likely secrets from exception strings before surfacing them."""
    text = str(exc)
    blocked = ("sk-", "api_key", "password=", "Bearer ", "Authorization")
    lowered = text.lower()
    for token in blocked:
        if token.lower() in lowered:
            return type(exc).__name__
    if len(text) > 300:
        return text[:300] + "…"
    return text


def _safe_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise SidecarError(
            INTERNAL_ERROR, "Invalid backend collection identifier.", status_code=503
        )
    return value


def _json_value(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
