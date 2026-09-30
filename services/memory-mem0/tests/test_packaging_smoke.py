"""Pure helper tests for the clean-room smoke runner."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from urllib.request import Request, urlopen

import pytest


def _load_smoke() -> ModuleType:
    path = Path(__file__).parents[1] / "packaging" / "smoke.py"
    spec = importlib.util.spec_from_file_location("yuvi_mem0_packaging_smoke", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


smoke = _load_smoke()


def _write_artifact(root: Path, *, manifest: dict | None = None) -> Path:
    artifact = root / "artifact"
    (artifact / "_internal").mkdir(parents=True)
    (artifact / "_internal" / "runtime.dll").write_bytes(b"dll")
    (artifact / "yuvi-mem0.exe").write_bytes(b"exe")
    (artifact / "mem0-manifest.json").write_text(
        json.dumps(manifest or smoke.MANIFEST), encoding="utf-8"
    )
    return artifact


def test_layout_uses_script_location_not_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = tmp_path / "repo/services/memory-mem0/packaging/smoke.py"
    monkeypatch.chdir(tmp_path)
    layout = smoke.resolve_layout(script)
    assert layout.repo_root == tmp_path / "repo"
    assert layout.artifact_source == tmp_path / "repo/build/desktop/win32-x64/mem0"


def test_manifest_must_match_exactly(tmp_path: Path) -> None:
    artifact = _write_artifact(tmp_path)
    assert smoke.validate_manifest(artifact).name == "yuvi-mem0.exe"


@pytest.mark.parametrize(
    "executable",
    [r"C:\outside.exe", "..\\outside.exe", "nested\\yuvi-mem0.exe"],
)
def test_manifest_rejects_non_basename(tmp_path: Path, executable: str) -> None:
    manifest = {**smoke.MANIFEST, "executable": executable}
    artifact = _write_artifact(tmp_path, manifest=manifest)
    with pytest.raises(smoke.SmokeError):
        smoke.validate_manifest(artifact)


def test_manifest_rejects_missing_internal(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact"
    artifact.mkdir()
    (artifact / "yuvi-mem0.exe").write_bytes(b"exe")
    (artifact / "mem0-manifest.json").write_text(json.dumps(smoke.MANIFEST), encoding="utf-8")
    with pytest.raises(smoke.SmokeError):
        smoke.validate_manifest(artifact)


def test_artifact_metrics_rejects_small_tree(tmp_path: Path) -> None:
    artifact = _write_artifact(tmp_path)
    with pytest.raises(smoke.SmokeError, match="unexpectedly small"):
        smoke.artifact_metrics(artifact)


def test_copy_destination_must_be_temp_child(tmp_path: Path) -> None:
    temp_root = tmp_path / "temp"
    temp_root.mkdir()
    repo = tmp_path / "repo"
    repo.mkdir()
    target = temp_root / "clean"
    assert (
        smoke.copy_destination_guard(target, temp_root=temp_root, repo_root=repo)
        == target.resolve()
    )
    with pytest.raises(smoke.SmokeError):
        smoke.copy_destination_guard(repo / "clean", temp_root=temp_root, repo_root=repo)


def test_copy_destination_rejects_existing_path(tmp_path: Path) -> None:
    temp_root = tmp_path / "temp"
    temp_root.mkdir()
    target = temp_root / "clean"
    target.mkdir()
    with pytest.raises(smoke.SmokeError):
        smoke.copy_destination_guard(target, temp_root=temp_root, repo_root=tmp_path / "repo")


def test_restricted_path_has_no_development_runtimes(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    def missing(name: str, path: str) -> None:
        calls.append((name, path))
        return None

    monkeypatch.setattr(smoke.shutil, "which", missing)
    result = smoke.validate_restricted_path("system-only")
    assert result == {name: True for name in ("python", "python3", "py", "pip", "uv")}
    assert {name for name, _ in calls} == {"python", "python3", "py", "pip", "uv"}


def test_child_env_clears_parent_runtime_variables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PYTHONPATH", r"C:\Dev\UV-main\services\memory-mem0\src")
    env = smoke.build_child_env(
        cleanroom=tmp_path,
        artifact_dir=tmp_path / "artifact",
        port=6131,
    )
    assert "PYTHONPATH" not in env
    assert "VIRTUAL_ENV" not in env
    assert r"C:\Dev\UV-main" not in "\n".join(env.values())
    assert env["YUVI_MEM0_PACKAGED"] == "1"


def test_poison_env_is_fixed_and_non_secret() -> None:
    text = smoke.poison_env_text()
    assert "poison-model-must-not-load" in text
    assert "999" in text
    assert smoke.SMOKE_SECRET not in text


def test_tree_snapshot_detects_addition_and_modification(tmp_path: Path) -> None:
    root = tmp_path / "tree"
    root.mkdir()
    (root / "one.txt").write_text("one", encoding="utf-8")
    first = smoke.tree_snapshot(root)
    (root / "one.txt").write_text("changed", encoding="utf-8")
    (root / "two.txt").write_text("two", encoding="utf-8")
    second = smoke.tree_snapshot(root)
    assert first != second
    assert "two.txt" in second


def test_log_scanner_rejects_import_and_secret() -> None:
    result = smoke.classify_logs(
        "ImportError: bad\nP3_SMOKE_SECRET_DO_NOT_LOG",
        "",
        health_ok=True,
        repo_root=Path(r"C:\repo"),
        case_env={"MEM0_PG_CONNECTION_STRING": "postgresql://u:P3_SMOKE_SECRET_DO_NOT_LOG@x/y"},
    )
    assert result["ok"] is False
    assert result["hard_failures"]


def test_log_scanner_allows_expected_connection_traceback() -> None:
    result = smoke.classify_logs(
        "Traceback\npsycopg2.OperationalError: connection refused",
        "",
        health_ok=True,
        repo_root=Path(r"C:\repo"),
        case_env={},
    )
    assert result["expected_connection_traceback"] is True
    assert result["ok"] is True


def test_log_scanner_rejects_unexpected_traceback() -> None:
    result = smoke.classify_logs(
        "Traceback\nRuntimeError: broken frozen startup",
        "",
        health_ok=True,
        repo_root=Path(r"C:\repo"),
        case_env={},
    )
    assert result["ok"] is False
    assert "unexpected traceback" in result["hard_failures"]


def test_health_envelope_validation(monkeypatch: pytest.MonkeyPatch) -> None:
    class Response:
        status = 200

        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return b'{"ok":true,"data":{"status":"unhealthy"}}'

    monkeypatch.setattr(smoke.urllib.request, "urlopen", lambda *_args, **_kwargs: Response())
    assert smoke.health_request(6131, 1)["ok"] is True


def test_health_rejects_healthy_status(monkeypatch: pytest.MonkeyPatch) -> None:
    class Response:
        status = 200

        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return b'{"ok":true,"data":{"status":"healthy"}}'

    monkeypatch.setattr(smoke.urllib.request, "urlopen", lambda *_args, **_kwargs: Response())
    with pytest.raises(smoke.SmokeError):
        smoke.health_request(6131, 1)


def test_cleanup_guard_rejects_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(smoke.tempfile, "gettempdir", lambda: str(tmp_path))
    with pytest.raises(smoke.SmokeError):
        smoke.safe_cleanup_cleanroom(tmp_path / "repo")


def test_process_tree_helper_uses_parent_links(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(smoke.sys, "platform", "win32")
    before = {
        10: smoke.ProcessInfo(10, 1, "yuvi-mem0.exe"),
        11: smoke.ProcessInfo(11, 10, "child.exe"),
    }
    assert smoke.descendant_pids(10, before) == {11}
    assert smoke.process_tree_clear(10, before, {}) is True
    assert smoke.process_tree_clear(10, before, before) is False


def test_signal_exit_code_policy() -> None:
    assert smoke.acceptable_exit_code(0) is True
    assert smoke.acceptable_exit_code(3) is True
    assert smoke.acceptable_exit_code(1) is False


def test_ollama_stub_tags_and_embedding() -> None:
    stub = smoke.start_ollama_stub()
    try:
        with urlopen(f"http://127.0.0.1:{stub.server.server_port}/api/tags") as response:
            payload = json.loads(response.read().decode())
        assert payload["models"][0]["name"] == "yuvi-embedding:0.6b"
        request = Request(
            f"http://127.0.0.1:{stub.server.server_port}/api/embed",
            data=b"{}",
            method="POST",
        )
        with urlopen(request) as response:
            embedding = json.loads(response.read().decode())["embeddings"][0]
        assert len(embedding) == 1024
        assert stub.requests == ["GET /api/tags", "POST /api/embed"]
    finally:
        smoke.stop_ollama_stub(stub)
