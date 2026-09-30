"""Runtime path and environment governance for the Mem0 sidecar.

This module intentionally has no dependency on Mem0, FastAPI, Pydantic, or
Uvicorn.  The packaged entry imports it before importing the application so
that Mem0's own default directories and telemetry settings are controlled
before any Mem0 module is loaded.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

_PACKAGED_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_LOCALAPPDATA_ENV = "LOCALAPPDATA"
_RESOURCE_ENV = "YUVI_MEM0_RESOURCE_DIR"
_DATA_ENV = "YUVI_MEM0_DATA_DIR"
_LOG_ENV = "YUVI_MEM0_LOG_DIR"


class RuntimePathError(RuntimeError):
    """Stable, non-sensitive packaged path configuration error."""


@dataclass(frozen=True)
class RuntimePaths:
    """Resolved packaged runtime locations.

    Development mode deliberately leaves all paths unset.  The packaged
    resource directory is read-only; data and log directories are writable
    LocalAppData locations prepared by :func:`prepare_runtime_environment`.
    """

    packaged: bool
    resource_dir: Path | None
    data_dir: Path | None
    log_dir: Path | None


def is_packaged_mode() -> bool:
    """Return whether packaged behavior was explicitly requested.

    Only the documented environment flag controls the mode.  Frozen-runtime
    implementation details and the current working directory are not used to
    switch behavior.
    """

    value = os.environ.get("YUVI_MEM0_PACKAGED", "")
    return value.strip().casefold() in _PACKAGED_TRUE_VALUES


def _absolute_path(value: str, *, variable: str) -> Path:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        raise RuntimePathError(f"{variable} must be an absolute path.")
    return candidate.resolve()


def _optional_absolute_env(variable: str) -> Path | None:
    value = os.environ.get(variable, "").strip()
    if not value:
        return None
    return _absolute_path(value, variable=variable)


def _frozen_resource_dir() -> Path | None:
    """Resolve a frozen executable's resource directory without using cwd."""

    if not bool(getattr(sys, "frozen", False)):
        return None

    executable = str(getattr(sys, "executable", "") or "").strip()
    if executable:
        executable_path = Path(executable).expanduser()
        if executable_path.is_absolute():
            return executable_path.resolve().parent

    # PyInstaller exposes _MEIPASS in some boot modes.  It is only an
    # auxiliary fallback after the executable location, never the mode switch.
    meipass = str(getattr(sys, "_MEIPASS", "") or "").strip()
    if meipass:
        return _absolute_path(meipass, variable="sys._MEIPASS")
    return None


def _resolve_resource_dir() -> Path:
    explicit = _optional_absolute_env(_RESOURCE_ENV)
    if explicit is not None:
        return explicit
    frozen = _frozen_resource_dir()
    if frozen is not None:
        return frozen
    raise RuntimePathError(
        "YUVI_MEM0_RESOURCE_DIR is required when packaged resource location cannot be resolved."
    )


def _local_app_data_dir() -> Path:
    value = os.environ.get(_LOCALAPPDATA_ENV, "").strip()
    if not value:
        raise RuntimePathError(
            "LOCALAPPDATA is required when packaged data or log paths are not set."
        )
    return _absolute_path(value, variable=_LOCALAPPDATA_ENV)


def _resolve_writable_dir(variable: str, default_suffix: tuple[str, ...]) -> Path:
    explicit = _optional_absolute_env(variable)
    if explicit is not None:
        return explicit
    return _local_app_data_dir().joinpath(*default_suffix).resolve()


def resolve_runtime_paths() -> RuntimePaths:
    """Resolve runtime paths without creating directories or changing env."""

    if not is_packaged_mode():
        return RuntimePaths(packaged=False, resource_dir=None, data_dir=None, log_dir=None)

    return RuntimePaths(
        packaged=True,
        resource_dir=_resolve_resource_dir(),
        data_dir=_resolve_writable_dir(_DATA_ENV, ("YUVI", "Mem0", "data")),
        log_dir=_resolve_writable_dir(_LOG_ENV, ("YUVI", "Mem0", "logs")),
    )


def prepare_runtime_environment() -> RuntimePaths:
    """Prepare packaged directories and Mem0 process environment.

    In development this is a no-op.  In packaged mode it creates only the
    writable data/log directories and forces Mem0's directory and telemetry
    environment before any Mem0 import can occur.
    """

    paths = resolve_runtime_paths()
    if not paths.packaged:
        return paths

    assert paths.data_dir is not None
    assert paths.log_dir is not None
    paths.data_dir.mkdir(parents=True, exist_ok=True)
    paths.log_dir.mkdir(parents=True, exist_ok=True)

    # These values intentionally override stale inherited values.  Mem0
    # 2.2.1 reads MEM0_DIR for config/history/migration paths and
    # MEM0_TELEMETRY as a case-insensitive boolean string.
    os.environ["MEM0_DIR"] = str(paths.data_dir)
    os.environ["MEM0_TELEMETRY"] = "false"
    return paths
