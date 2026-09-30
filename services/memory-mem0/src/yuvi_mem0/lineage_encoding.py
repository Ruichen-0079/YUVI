"""Transport integrity only; committed evidence authority remains in the YUVI host."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from yuvi_mem0.errors import SidecarError, VALIDATION_ERROR

KEYS = ("yuviLineageEncoding", "yuviLineageJson", "yuviLineageDigest")
MAX_BYTES = 65_536


def validate_lineage_encoding(metadata: dict[str, Any]) -> None:
    if not any(key in metadata for key in KEYS):
        return  # Historical/non-evidence compatibility records do not gain lineage.
    raw = metadata.get("yuviLineageJson")
    try:
        if metadata.get("yuviLineageEncoding") != "yuvi.memory-lineage-json.v1":
            raise ValueError("encoding")
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_BYTES:
            raise ValueError("bound")
        if metadata.get("yuviLineageDigest") != hashlib.sha256(raw.encode("utf-8")).hexdigest():
            raise ValueError("digest")
        decoded = json.loads(raw)
        if not isinstance(decoded, dict) or decoded.get("version") != "memory-lineage.v1":
            raise ValueError("version")
        if json.dumps(decoded, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) != raw:
            raise ValueError("canonical encoding")
        # Deep schema and semantic validation belongs to MemoryLineageV1Schema in the host.
    except (TypeError, ValueError, UnicodeError) as exc:
        raise SidecarError(VALIDATION_ERROR, "Invalid bounded YUVI lineage encoding.", status_code=400) from exc
