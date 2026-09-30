import hashlib
import json

import pytest

from yuvi_mem0.errors import SidecarError
from yuvi_mem0.lineage_encoding import validate_lineage_encoding


def encoded(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {"yuviLineageEncoding": "yuvi.memory-lineage-json.v1", "yuviLineageJson": raw, "yuviLineageDigest": hashlib.sha256(raw.encode()).hexdigest()}


def test_unicode_transport_is_lossless():
    metadata = encoded({"version": "memory-lineage.v1", "opaque": "long:🍵:" + "x" * 5000})
    before = metadata.copy()
    validate_lineage_encoding(metadata)
    assert metadata == before
    validate_lineage_encoding({})


@pytest.mark.parametrize("change", [
    {"yuviLineageEncoding": "fake"}, {"yuviLineageDigest": "fake"},
    {"yuviLineageJson": "{"}, {"yuviLineageJson": "x" * 65537},
])
def test_invalid_encoding_fails_closed(change):
    with pytest.raises(SidecarError):
        validate_lineage_encoding(encoded({"version": "memory-lineage.v1"}) | change)


def test_partial_unknown_and_noncanonical_fail_closed():
    for metadata in [{"yuviLineageEncoding": "yuvi.memory-lineage-json.v1"}, encoded({"version": "future"})]:
        with pytest.raises(SidecarError):
            validate_lineage_encoding(metadata)
    raw = '{ "version": "memory-lineage.v1" }'
    with pytest.raises(SidecarError):
        validate_lineage_encoding({"yuviLineageEncoding": "yuvi.memory-lineage-json.v1", "yuviLineageJson": raw, "yuviLineageDigest": hashlib.sha256(raw.encode()).hexdigest()})
