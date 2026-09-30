"""Structured sidecar errors."""

from __future__ import annotations

from typing import Any


class SidecarError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        status_code: int = 500,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.status_code = status_code
        self.details = details or {}


CONFIG_INVALID = "CONFIG_INVALID"
EMBEDDER_UNAVAILABLE = "EMBEDDER_UNAVAILABLE"
VECTOR_STORE_UNAVAILABLE = "VECTOR_STORE_UNAVAILABLE"
MEMORY_LLM_UNAVAILABLE = "MEMORY_LLM_UNAVAILABLE"
MEMORY_LLM_NOT_CONFIGURED = "MEMORY_LLM_NOT_CONFIGURED"
MEM0_INITIALIZATION_FAILED = "MEM0_INITIALIZATION_FAILED"
# Private yuvi-* embedder requires mem0ai==2.2.1 ollama patch; version mismatch.
MEM0_EMBEDDER_PATCH_UNSUPPORTED = "MEM0_EMBEDDER_PATCH_UNSUPPORTED"
VALIDATION_ERROR = "VALIDATION_ERROR"
MEMORY_NOT_FOUND = "MEMORY_NOT_FOUND"
OPERATION_TIMEOUT = "OPERATION_TIMEOUT"
UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION"
INTERNAL_ERROR = "INTERNAL_ERROR"
