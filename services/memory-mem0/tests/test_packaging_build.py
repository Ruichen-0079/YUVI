from __future__ import annotations

import importlib.util
import json
import os
import platform
import sys
from pathlib import Path

import pytest

_BUILD_PATH = Path(__file__).resolve().parents[1] / "packaging" / "build.py"
_BUILD_SPEC = importlib.util.spec_from_file_location("yuvi_mem0_packaging_build", _BUILD_PATH)
assert _BUILD_SPEC is not None and _BUILD_SPEC.loader is not None
build = importlib.util.module_from_spec(_BUILD_SPEC)
sys.modules[_BUILD_SPEC.name] = build
_BUILD_SPEC.loader.exec_module(build)


def test_layout_is_anchored_to_script_not_cwd() -> None:
    layout = build.resolve_layout()
    assert layout.repo_root == _BUILD_PATH.parents[3]
    assert layout.source_root == layout.memory_root / "src"
    assert layout.output_dir == layout.repo_root / "build/desktop/win32-x64/mem0"
    assert layout.work_dir == layout.repo_root / "build/.pyinstaller/mem0"


def test_cleanup_rejects_unsafe_paths() -> None:
    layout = build.resolve_layout()
    with pytest.raises(build.BuildError):
        build.safe_remove_build_target(layout.repo_root, layout)
    with pytest.raises(build.BuildError):
        build.safe_remove_build_target(layout.repo_root / "build", layout)
    with pytest.raises(build.BuildError):
        build.safe_remove_build_target(Path.home(), layout)


def test_manifest_is_fixed_and_contains_no_paths_or_secrets(tmp_path: Path) -> None:
    manifest_path = tmp_path / "mem0-manifest.json"
    manifest_path.write_text(
        json.dumps(build.MANIFEST, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    build._validate_manifest(manifest_path)
    text = manifest_path.read_text(encoding="utf-8")
    assert "DATABASE_URL" not in text
    assert "api_key" not in text.lower()
    assert str(tmp_path) not in text


def test_environment_validation_fails_fast_when_platform_is_not_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(build.sys, "platform", "linux")
    with pytest.raises(build.BuildError, match="Windows"):
        build.validate_build_environment()


def test_environment_validation_rejects_wrong_python_pin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(build.sys, "platform", "win32")
    monkeypatch.setattr(build.platform, "architecture", lambda: ("64bit", "WindowsPE"))
    monkeypatch.setattr(build.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(build.sys, "version_info", (3, 11, 0))
    monkeypatch.setattr(build.struct, "calcsize", lambda _: 8)
    monkeypatch.setenv("YUVI_PYTHON311", "C:/different/python.exe")
    with pytest.raises(build.BuildError, match="YUVI_PYTHON311"):
        build.validate_build_environment()


def test_artifact_validation_rejects_env_and_nested_executable(tmp_path: Path) -> None:
    layout = build.BuildLayout(
        repo_root=tmp_path,
        memory_root=tmp_path / "services" / "memory-mem0",
        source_root=tmp_path / "services" / "memory-mem0" / "src",
        spec_path=tmp_path / "spec",
        dist_root=tmp_path / "build" / "desktop" / "win32-x64",
        output_dir=tmp_path / "build" / "desktop" / "win32-x64" / "mem0",
        work_dir=tmp_path / "build" / ".pyinstaller" / "mem0",
    )
    layout.output_dir.joinpath("_internal").mkdir(parents=True)
    layout.output_dir.joinpath("_internal", "runtime.dll").write_bytes(b"dll")
    layout.output_dir.joinpath("yuvi-mem0.exe").write_bytes(b"exe")
    layout.output_dir.joinpath("mem0-manifest.json").write_text(
        json.dumps(build.MANIFEST), encoding="utf-8"
    )
    layout.output_dir.joinpath(".env").write_text("MEM0_LLM_API_KEY=secret", encoding="utf-8")
    with pytest.raises(build.BuildError, match=".env"):
        build._validate_artifact(layout)


def test_build_does_not_use_caller_environment_as_project_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    original = os.getcwd()
    try:
        monkeypatch.chdir(tmp_path)
        layout = build.resolve_layout()
        assert layout.repo_root == _BUILD_PATH.parents[3]
        assert original != os.getcwd() or platform.system() == "Windows"
    finally:
        os.chdir(original)
