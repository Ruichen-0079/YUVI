"""YUVI-owned request/response schemas (no raw Mem0 SDK leakage)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class MemoryMetadata(BaseModel):
    userId: str | None = None
    characterId: str | None = None
    conversationId: str | None = None
    sourceMessageId: str | None = None
    sourceTraceId: str | None = None
    memoryType: str | None = None
    explicit: bool | None = None
    language: str | None = None
    schemaVersion: int = 1
    createdBy: str | None = None
    supersedesMemoryId: str | None = None

    model_config = {"extra": "allow"}


class AddMemoryRequest(BaseModel):
    scope: str = Field(min_length=1)
    content: str | None = None
    messages: list[ChatMessage] | None = None
    infer: bool = True
    metadata: MemoryMetadata = Field(default_factory=MemoryMetadata)


class IdempotentMemoryWriteRequest(AddMemoryRequest):
    idempotencyKey: str = Field(min_length=1)
    payloadDigest: str = Field(min_length=1)


class IdempotentMemoryReconcileRequest(BaseModel):
    idempotencyKey: str = Field(min_length=1)
    payloadDigest: str = Field(min_length=1)


class SearchMemoryRequest(BaseModel):
    scope: str = Field(min_length=1)
    query: str = Field(min_length=1)
    limit: int = Field(default=8, ge=1, le=50)
    metadataFilter: dict[str, Any] | None = None


class UpdateMemoryRequest(BaseModel):
    content: str = Field(min_length=1)
    scope: str | None = None
    metadata: MemoryMetadata | None = None


class MemoryRecord(BaseModel):
    id: str
    content: str
    scope: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    score: float | None = None
    createdAt: str | None = None
    updatedAt: str | None = None


class MemoryWriteResult(BaseModel):
    memoryId: str
    operation: Literal["created", "updated", "deleted", "unchanged"]
    record: MemoryRecord | None = None


class MemoryReconciliationResult(BaseModel):
    status: Literal["applied", "not_applied", "in_flight", "payload_conflict", "unknown"]
    memoryId: str | None = None
    operation: str | None = None
    errorCode: str | None = None


class MemorySearchResponse(BaseModel):
    items: list[MemoryRecord]


class MemorySnapshotMarker(BaseModel):
    mode: Literal["bounded_snapshot"]
    exhausted: bool
    rawBytesExceeded: bool


class MemoryListResponse(BaseModel):
    items: list[MemoryRecord]
    total: int | None = None
    snapshot: MemorySnapshotMarker | None = None


class MemoryHistoryEntry(BaseModel):
    id: str
    memoryId: str
    event: str
    previousValue: str | None = None
    newValue: str | None = None
    createdAt: str | None = None


class MemoryHistoryResponse(BaseModel):
    items: list[MemoryHistoryEntry]


class HealthComponents(BaseModel):
    mem0: str = "unknown"
    embedder: str = "unknown"
    vectorStore: str = "unknown"
    memoryLlm: str = "unknown"


class HealthCapabilities(BaseModel):
    """Explicit capability flags so clients do not guess from component strings."""

    infer: bool = False
    crud: bool = False
    search: bool = False


class HealthEmbedding(BaseModel):
    provider: str
    model: str
    dimensions: int


class HealthData(BaseModel):
    status: Literal["healthy", "degraded", "unhealthy"]
    backend: str = "mem0"
    components: HealthComponents
    capabilities: HealthCapabilities = Field(default_factory=HealthCapabilities)
    embedding: HealthEmbedding
    collection: str
    message: str | None = None


class ErrorBody(BaseModel):
    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] | None = None


class ApiMeta(BaseModel):
    durationMs: int = 0
    backend: str = "mem0"


class ApiResponse(BaseModel):
    ok: bool
    data: Any | None = None
    meta: ApiMeta = Field(default_factory=ApiMeta)
    error: ErrorBody | None = None
