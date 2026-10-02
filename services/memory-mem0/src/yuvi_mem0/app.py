"""FastAPI application for the YUVI Mem0 sidecar."""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from yuvi_mem0 import __version__
from yuvi_mem0.config import get_settings
from yuvi_mem0.errors import SidecarError
from yuvi_mem0.logging import configure_logging, hash_scope, log_event
from yuvi_mem0.memory import get_service
from yuvi_mem0.schemas import (
    AddMemoryRequest,
    ApiMeta,
    ApiResponse,
    ErrorBody,
    IdempotentMemoryReconcileRequest,
    IdempotentMemoryWriteRequest,
    MemoryHistoryResponse,
    MemoryListResponse,
    MemoryReconciliationResult,
    MemorySearchResponse,
    SearchMemoryRequest,
    UpdateMemoryRequest,
)

configure_logging()
logger = logging.getLogger("yuvi_mem0.app")


def _validate_fixed_settings() -> None:
    settings = get_settings()
    if settings.mem0_embedder_model != "yuvi-embedding:0.6b":
        raise RuntimeError("Invalid embedder model configuration.")
    if settings.mem0_embedder_dimensions != 1024:
        raise RuntimeError("Invalid embedder dimensions configuration.")
    if settings.mem0_pg_diskann:
        raise RuntimeError("DiskANN must remain disabled.")


def _startup_initialize() -> None:
    """Run once at process start: validate config and init Mem0Service singleton."""
    _validate_fixed_settings()
    settings = get_settings()
    service = get_service()
    if settings.has_pg:
        try:
            service.initialize()
        except SidecarError as exc:
            # Degraded start: health reports unhealthy/degraded; CRUD may retry init.
            logger.error("Mem0 startup init deferred/failed: %s", exc.message)
    else:
        logger.warning("MEM0_PG_CONNECTION_STRING missing; sidecar starts degraded.")


def _shutdown_release() -> None:
    """Run once at process stop: release Mem0 resources held by the singleton."""
    service = get_service()
    try:
        service.shutdown()
    except Exception:  # noqa: BLE001
        logger.exception("Mem0Service shutdown failed")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """FastAPI lifespan (replaces deprecated on_event startup/shutdown)."""
    _startup_initialize()
    try:
        yield
    finally:
        _shutdown_release()


app = FastAPI(title="YUVI Mem0 Sidecar", version=__version__, lifespan=lifespan)


@app.exception_handler(SidecarError)
async def sidecar_error_handler(_request: Request, exc: SidecarError) -> JSONResponse:
    body = ApiResponse(
        ok=False,
        error=ErrorBody(
            code=exc.code,
            message=exc.message,
            retryable=exc.retryable,
            details=_sanitize_details(exc.details),
        ),
        meta=ApiMeta(),
    )
    return JSONResponse(status_code=exc.status_code, content=body.model_dump())


@app.exception_handler(Exception)
async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled sidecar error: %s", exc)
    body = ApiResponse(
        ok=False,
        error=ErrorBody(code="INTERNAL_ERROR", message="Internal sidecar error.", retryable=True),
        meta=ApiMeta(),
    )
    return JSONResponse(status_code=500, content=body.model_dump())


def _ok(data: Any, duration_ms: int) -> dict[str, Any]:
    return ApiResponse(ok=True, data=data, meta=ApiMeta(durationMs=duration_ms)).model_dump()


@app.get("/health")
def health() -> dict[str, Any]:
    started = time.perf_counter()
    service = get_service()
    data = service.health()
    duration = int((time.perf_counter() - started) * 1000)
    log_event(logger, operation="health", duration_ms=duration)
    return _ok(data.model_dump(), duration)


@app.post("/v1/memories")
def add_memory(request: AddMemoryRequest) -> dict[str, Any]:
    started = time.perf_counter()
    service = get_service()
    result = service.add(request)
    duration = int((time.perf_counter() - started) * 1000)
    log_event(
        logger,
        operation="add",
        duration_ms=duration,
        scope_hash=hash_scope(request.scope),
        infer=request.infer,
        result_count=1 if result.memoryId else 0,
    )
    return _ok(result.model_dump(), duration)


@app.post("/v1/memories/idempotent")
def submit_idempotent_memory(request: IdempotentMemoryWriteRequest) -> dict[str, Any]:
    started = time.perf_counter()
    result = get_service().submit_idempotent(request)
    duration = int((time.perf_counter() - started) * 1000)
    log_event(logger, operation="submit_idempotent", duration_ms=duration, result_count=1)
    return _ok(result.model_dump(), duration)


@app.post("/v1/memories/idempotent/reconcile")
def reconcile_idempotent_memory(request: IdempotentMemoryReconcileRequest) -> dict[str, Any]:
    started = time.perf_counter()
    result: MemoryReconciliationResult = get_service().reconcile_idempotency(
        request.idempotencyKey, request.payloadDigest
    )
    duration = int((time.perf_counter() - started) * 1000)
    log_event(logger, operation="reconcile_idempotent", duration_ms=duration)
    return _ok(result.model_dump(), duration)


@app.post("/v1/memories/search")
def search_memories(request: SearchMemoryRequest) -> dict[str, Any]:
    started = time.perf_counter()
    service = get_service()
    items = service.search(request)
    duration = int((time.perf_counter() - started) * 1000)
    log_event(
        logger,
        operation="search",
        duration_ms=duration,
        scope_hash=hash_scope(request.scope),
        result_count=len(items),
    )
    payload = MemorySearchResponse(items=items)
    return _ok(payload.model_dump(), duration)


@app.get("/v1/memories/{memory_id}")
def get_memory(memory_id: str, scope: str | None = Query(default=None)) -> dict[str, Any]:
    started = time.perf_counter()
    service = get_service()
    record = service.get(memory_id, scope=scope)
    duration = int((time.perf_counter() - started) * 1000)
    log_event(logger, operation="get", duration_ms=duration, result_count=1)
    return _ok(record.model_dump(), duration)


@app.get("/v1/memories")
def list_memories(
    scope: str = Query(min_length=1),
    limit: int = Query(default=20, ge=1),
    offset: int = Query(default=0, ge=0),
    mode: str | None = Query(default=None),
) -> dict[str, Any]:
    started = time.perf_counter()
    service = get_service()
    if mode is None:
        if limit > 100:
            raise RequestValidationError([{
                "type": "less_than_equal",
                "loc": ("query", "limit"),
                "msg": "Input should be less than or equal to 100",
                "input": limit,
                "ctx": {"le": 100},
            }])
        items = service.list_memories(scope=scope, limit=limit, offset=offset)
        snapshot = None
    elif mode != "bounded_snapshot":
        raise SidecarError("ENUMERATION_UNSUPPORTED", "Requested Memory enumeration mode is unsupported.", status_code=501)
    else:
        if limit != 4096 or offset != 0:
            raise SidecarError("VALIDATION_ERROR", "Bounded snapshot mode requires limit 4096 and offset zero.", status_code=400)
        items, snapshot = service.list_profile_snapshot(scope=scope)
    duration = int((time.perf_counter() - started) * 1000)
    log_event(
        logger,
        operation="list",
        duration_ms=duration,
        scope_hash=hash_scope(scope),
        result_count=len(items),
    )
    payload = MemoryListResponse(items=items, total=len(items), snapshot=snapshot)
    return _ok(payload.model_dump(exclude={"snapshot"} if snapshot is None else set()), duration)


@app.put("/v1/memories/{memory_id}")
def update_memory(memory_id: str, request: UpdateMemoryRequest) -> dict[str, Any]:
    started = time.perf_counter()
    service = get_service()
    record = service.update(memory_id, request)
    duration = int((time.perf_counter() - started) * 1000)
    log_event(logger, operation="update", duration_ms=duration, result_count=1)
    return _ok(record.model_dump(), duration)


@app.delete("/v1/memories/{memory_id}")
def delete_memory(memory_id: str, scope: str | None = Query(default=None)) -> dict[str, Any]:
    started = time.perf_counter()
    service = get_service()
    service.delete(memory_id, scope=scope)
    duration = int((time.perf_counter() - started) * 1000)
    log_event(logger, operation="delete", duration_ms=duration, result_count=0)
    return _ok({"deleted": True}, duration)


@app.get("/v1/memories/{memory_id}/history")
def memory_history(memory_id: str, scope: str | None = Query(default=None)) -> dict[str, Any]:
    started = time.perf_counter()
    service = get_service()
    items = service.history(memory_id, scope=scope)
    duration = int((time.perf_counter() - started) * 1000)
    log_event(logger, operation="history", duration_ms=duration, result_count=len(items))
    payload = MemoryHistoryResponse(items=items)
    return _ok(payload.model_dump(), duration)


def _sanitize_details(details: dict[str, Any]) -> dict[str, Any]:
    blocked = ("key", "secret", "password", "authorization", "token", "connection")
    cleaned: dict[str, Any] = {}
    for key, value in details.items():
        if any(part in key.lower() for part in blocked):
            continue
        if isinstance(value, str) and len(value) > 200:
            cleaned[key] = value[:200] + "…"
        else:
            cleaned[key] = value
    return cleaned


def create_app() -> FastAPI:
    return app
