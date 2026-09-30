"""YUVI Mem0 OSS sidecar."""

import os

# Local/private sidecar never enables upstream telemetry, including direct ASGI imports.
os.environ["MEM0_TELEMETRY"] = "false"

__version__ = "0.1.0"
