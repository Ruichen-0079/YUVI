"""Build the Windows x64 Mem0 sidecar as a PyInstaller onedir artifact."""

from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import shutil
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PYINSTALLER_VERSION = "6.13.0"
MEM0_VERSION = "2.2.1"
MANIFEST = {
    "schemaVersion": 1,
    "protocolVersion": 1,
    "platform": "win32",
    "arch": "x64",
    "executable": "yuvi-mem0.exe",
    "healthPath": "/health",
    "defaultHost": "127.0.0.1",
    "defaultPort": 6131,
}


class BuildError(RuntimeError):
    """Stable build configuration or artifact validation error."""


@dataclass(frozen=True)
class BuildLayout:
    repo_root: Path
    memory_root: Path
    source_root: Path
    spec_path: Path
    dist_root: Path
    output_dir: Path
    work_dir: Path


def resolve_layout(script_path: Path | None = None) -> BuildLayout:
    """Resolve all build paths from this file, never from the caller cwd."""

    packaging_dir = (script_path or Path(__file__)).resolve().parent
    memory_root = packaging_dir.parent
    repo_root = memory_root.parent.parent
    build_root = repo_root / "build"
    dist_root = build_root / "desktop" / "win32-x64"
    return BuildLayout(
        repo_root=repo_root,
        memory_root=memory_root,
        source_root=memory_root / "src",
        spec_path=packaging_dir / "yuvi_mem0.spec",
        dist_root=dist_root,
        output_dir=dist_root / "mem0",
        work_dir=build_root / ".pyinstaller" / "mem0",
    )


def _resolved(path: Path) -> Path:
    return path.expanduser().resolve()


def _assert_safe_build_target(path: Path, layout: BuildLayout) -> Path:
    target = _resolved(path)
    repo_root = _resolved(layout.repo_root)
    build_root = _resolved(layout.repo_root / "build")
    home = _resolved(Path.home())
    if not target or str(target) in {"", target.anchor}:
        raise BuildError("Refusing an empty or root build path.")
    if target == repo_root or target == home:
        raise BuildError("Refusing to remove a protected build path.")
    if not target.is_relative_to(build_root):
        raise BuildError("Build cleanup path must remain under the repository build directory.")
    if target in {_resolved(layout.output_dir), _resolved(layout.work_dir)}:
        return target
    raise BuildError("Build cleanup path is outside the allowed output/work directories.")


def safe_remove_build_target(path: Path, layout: BuildLayout) -> None:
    """Remove exactly one approved generated directory, never via git clean."""

    target = _assert_safe_build_target(path, layout)
    if target.exists():
        if not target.is_dir():
            raise BuildError("Build cleanup target is not a directory.")
        shutil.rmtree(target)


def _distribution_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError as exc:
        raise BuildError(f"Required package metadata is missing: {name}.") from exc


def validate_build_environment() -> dict[str, str]:
    """Fail fast unless the requested Windows/Python/dependency pins match."""

    if sys.platform != "win32":
        raise BuildError("Mem0 packaged build requires Windows.")
    if platform.architecture()[0] != "64bit" or struct.calcsize("P") != 8:
        raise BuildError("Mem0 packaged build requires a 64-bit Python process.")
    if platform.machine().upper() not in {"AMD64", "X86_64"}:
        raise BuildError("Mem0 packaged build requires Windows x64 (AMD64).")
    if sys.version_info[:2] != (3, 11):
        raise BuildError("Mem0 packaged build requires Python 3.11.x.")

    configured_python = os.environ.get("YUVI_PYTHON311", "").strip()
    if configured_python:
        try:
            configured_path = _resolved(Path(configured_python))
            current_path = _resolved(Path(sys.executable))
        except OSError as exc:
            raise BuildError("YUVI_PYTHON311 is not a usable interpreter path.") from exc
        if configured_path != current_path:
            raise BuildError("YUVI_PYTHON311 must point to the interpreter running build.py.")

    pyinstaller = _distribution_version("pyinstaller")
    mem0 = _distribution_version("mem0ai")
    if pyinstaller != PYINSTALLER_VERSION:
        raise BuildError(f"PyInstaller {PYINSTALLER_VERSION} is required (detected {pyinstaller}).")
    if mem0 != MEM0_VERSION:
        raise BuildError(f"mem0ai {MEM0_VERSION} is required (detected {mem0}).")
    return {
        "python": platform.python_version(),
        "architecture": platform.architecture()[0],
        "platform": sys.platform,
        "pyinstaller": pyinstaller,
        "mem0ai": mem0,
    }


def _write_manifest(output_dir: Path) -> Path:
    manifest_path = output_dir / "mem0-manifest.json"
    manifest_path.write_text(
        json.dumps(MANIFEST, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def _validate_manifest(manifest_path: Path) -> None:
    try:
        actual = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BuildError("Generated Mem0 manifest is unreadable.") from exc
    if actual != MANIFEST:
        raise BuildError("Generated Mem0 manifest does not match the fixed schema.")


def _validate_artifact(layout: BuildLayout) -> dict[str, int]:
    output_dir = layout.output_dir
    executable = output_dir / "yuvi-mem0.exe"
    internal = output_dir / "_internal"
    manifest = output_dir / "mem0-manifest.json"
    if not executable.is_file() or executable.stat().st_size <= 0:
        raise BuildError("yuvi-mem0.exe is missing or empty.")
    if not internal.is_dir() or not any(internal.iterdir()):
        raise BuildError("PyInstaller _internal directory is missing or empty.")
    if not manifest.is_file():
        raise BuildError("mem0-manifest.json is missing.")
    _validate_manifest(manifest)

    nested_executables = [
        path for path in output_dir.rglob("yuvi-mem0.exe") if path.resolve() != executable.resolve()
    ]
    if nested_executables:
        raise BuildError("Unexpected nested yuvi-mem0.exe detected in the onedir artifact.")

    for path in output_dir.rglob("*"):
        if path.name.lower() == ".env" or path.suffix.lower() == ".env":
            raise BuildError(".env was included in the packaged artifact.")
        if path.is_file() and path.suffix.lower() == ".py":
            if path.name.startswith("test_") or "tests" in path.parts:
                raise BuildError("Test source was included in the packaged artifact.")

    repo_marker = str(layout.repo_root).replace("\\", "/").lower()
    for path in output_dir.rglob("*.json"):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if repo_marker in text.replace("\\", "/").lower():
            raise BuildError("Repository path leaked into a packaged JSON configuration file.")

    files = [path for path in output_dir.rglob("*") if path.is_file()]
    total_bytes = sum(path.stat().st_size for path in files)
    internal_files = [path for path in internal.rglob("*") if path.is_file()]
    internal_bytes = sum(path.stat().st_size for path in internal_files)
    return {
        "files": len(files),
        "bytes": total_bytes,
        "internal_files": len(internal_files),
        "internal_bytes": internal_bytes,
    }


def build() -> dict[str, Any]:
    """Build and validate the formal onedir artifact."""

    layout = resolve_layout()
    environment = validate_build_environment()
    if not layout.source_root.is_dir():
        raise BuildError("Sidecar source directory is missing.")
    if not layout.spec_path.is_file():
        raise BuildError("PyInstaller spec is missing.")

    safe_remove_build_target(layout.output_dir, layout)
    safe_remove_build_target(layout.work_dir, layout)
    layout.output_dir.parent.mkdir(parents=True, exist_ok=True)
    layout.work_dir.parent.mkdir(parents=True, exist_ok=True)

    from PyInstaller.__main__ import run as pyinstaller_run

    caller_cwd = Path.cwd()
    previous_spec_dir = os.environ.get("YUVI_MEM0_SPEC_DIR")
    os.environ["YUVI_MEM0_SPEC_DIR"] = str(layout.spec_path.parent)
    try:
        # PyInstaller rejects protected/system cwd values.  This temporary
        # internal cwd is never used to resolve project paths and is restored
        # before returning to the caller.
        os.chdir(layout.memory_root)
        pyinstaller_run(
            [
                "--noconfirm",
                "--clean",
                "--distpath",
                str(layout.dist_root),
                "--workpath",
                str(layout.work_dir),
                str(layout.spec_path),
            ]
        )
    finally:
        os.chdir(caller_cwd)
        if previous_spec_dir is None:
            os.environ.pop("YUVI_MEM0_SPEC_DIR", None)
        else:
            os.environ["YUVI_MEM0_SPEC_DIR"] = previous_spec_dir
    manifest_path = _write_manifest(layout.output_dir)
    artifact = _validate_artifact(layout)
    return {
        "environment": environment,
        "output_dir": str(layout.output_dir),
        "executable": str(layout.output_dir / "yuvi-mem0.exe"),
        "manifest": str(manifest_path),
        **artifact,
    }


def main() -> int:
    try:
        summary = build()
    except BuildError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
