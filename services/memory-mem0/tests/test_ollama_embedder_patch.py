from __future__ import annotations

import warnings

import pytest

from yuvi_mem0.ollama_embedder_patch import (
    EMBEDDER_MODEL_NOT_LOCAL,
    MEM0_EMBEDDER_PATCH_UNSUPPORTED,
    SUPPORTED_MEM0AI_VERSION,
    Mem0EmbedderPatchError,
    _local_model_names,
    _model_identifiers,
    get_mem0ai_version,
    is_private_ollama_tag,
    last_patch_result,
    patch_ollama_embedder,
    reset_ollama_embedder_patch_for_tests,
)


@pytest.fixture(autouse=True)
def _reset_patch() -> None:
    reset_ollama_embedder_patch_for_tests()
    yield
    reset_ollama_embedder_patch_for_tests()


def test_model_identifiers_from_dict_name_and_model() -> None:
    assert _model_identifiers({"name": "a:1"}) == {"a:1"}
    assert _model_identifiers({"model": "yuvi-embedding:0.6b"}) == {"yuvi-embedding:0.6b"}


def test_model_identifiers_from_object() -> None:
    class M:
        model = "yuvi-embedding:0.6b"
        name = None

    assert "yuvi-embedding:0.6b" in _model_identifiers(M())


def test_local_model_names_from_list_response_style() -> None:
    class Model:
        def __init__(self, model: str) -> None:
            self.model = model

    class ListResponse:
        models = [Model("yuvi-embedding:0.6b"), Model("qwen3-embedding:0.6b")]

    class Client:
        def list(self) -> ListResponse:
            return ListResponse()

    names = _local_model_names(Client())
    assert "yuvi-embedding:0.6b" in names
    assert "qwen3-embedding:0.6b" in names


def test_private_tag_detection() -> None:
    assert is_private_ollama_tag("yuvi-embedding:0.6b") is True
    assert is_private_ollama_tag("YUVI-embedding:latest") is True
    assert is_private_ollama_tag("qwen3-embedding:0.6b") is False
    assert is_private_ollama_tag("nomic-embed-text") is False
    assert is_private_ollama_tag("library/qwen3-embedding:0.6b") is False


def test_installed_mem0ai_is_supported_pin() -> None:
    # CI/dev pin must remain the supported version for this patch.
    assert get_mem0ai_version() == SUPPORTED_MEM0AI_VERSION


def test_patch_applied_only_for_supported_version() -> None:
    result = patch_ollama_embedder()
    assert result.applied is True
    assert result.mem0_version == SUPPORTED_MEM0AI_VERSION
    assert result.reason == "patched_mem0ai_2_2_1"
    assert result.code is None
    assert last_patch_result() == result
    # Idempotent
    again = patch_ollama_embedder()
    assert again.applied is True


def test_patch_skipped_on_version_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "yuvi_mem0.ollama_embedder_patch.get_mem0ai_version",
        lambda: "0.1.200",
    )
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = patch_ollama_embedder()
    assert result.applied is False
    assert result.code == MEM0_EMBEDDER_PATCH_UNSUPPORTED
    assert result.reason == "unsupported_mem0ai_version"
    assert result.mem0_version == "0.1.200"
    assert any(MEM0_EMBEDDER_PATCH_UNSUPPORTED in str(w.message) for w in caught)

    from mem0.embeddings.ollama import OllamaEmbedding

    # Must not replace method when version mismatches.
    assert OllamaEmbedding._ensure_model_exists.__name__ == "_ensure_model_exists"


def test_patch_strict_version_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "yuvi_mem0.ollama_embedder_patch.get_mem0ai_version",
        lambda: "9.9.9",
    )
    with pytest.raises(Mem0EmbedderPatchError) as exc:
        patch_ollama_embedder(strict_version=True)
    assert exc.value.code == MEM0_EMBEDDER_PATCH_UNSUPPORTED


def _fake_client_module(monkeypatch: pytest.MonkeyPatch, local_models: list[str]):
    from mem0.embeddings import ollama as ollama_mod

    class Model:
        def __init__(self, model: str) -> None:
            self.model = model

    class ListResponse:
        def __getitem__(self, key):
            return getattr(self, key)

        def __init__(self, models: list[str]) -> None:
            self.models = [Model(m) for m in models]

    class FakeClient:
        def __init__(self, host: str | None = None) -> None:
            self.host = host
            self.pulled: list[str] = []
            self._local = list(local_models)

        def list(self) -> ListResponse:
            return ListResponse(self._local)

        def pull(self, name: str) -> None:
            self.pulled.append(name)
            self._local.append(name)

    monkeypatch.setattr(ollama_mod, "Client", FakeClient)
    return ollama_mod


def test_local_yuvi_model_exists_no_pull(monkeypatch: pytest.MonkeyPatch) -> None:
    from mem0.configs.embeddings.base import BaseEmbedderConfig

    ollama_mod = _fake_client_module(monkeypatch, ["yuvi-embedding:0.6b"])
    patch_ollama_embedder()
    emb = ollama_mod.OllamaEmbedding(
        BaseEmbedderConfig(
            model="yuvi-embedding:0.6b",
            ollama_base_url="http://127.0.0.1:11434",
            embedding_dims=1024,
        )
    )
    assert emb.client.pulled == []


def test_local_yuvi_model_missing_stable_error_no_pull(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mem0.configs.embeddings.base import BaseEmbedderConfig

    ollama_mod = _fake_client_module(monkeypatch, ["qwen3-embedding:0.6b"])
    patch_ollama_embedder()
    with pytest.raises(Mem0EmbedderPatchError) as exc:
        ollama_mod.OllamaEmbedding(
            BaseEmbedderConfig(
                model="yuvi-embedding:0.6b",
                ollama_base_url="http://127.0.0.1:11434",
                embedding_dims=1024,
            )
        )
    assert exc.value.code == EMBEDDER_MODEL_NOT_LOCAL
    assert EMBEDDER_MODEL_NOT_LOCAL in str(exc.value)
    assert "never auto-pulled" in str(exc.value).lower() or "never auto-pulled" in exc.value.message


def test_public_model_missing_still_pulls(monkeypatch: pytest.MonkeyPatch) -> None:
    """Official public models keep stock pull-if-missing behaviour."""
    from mem0.configs.embeddings.base import BaseEmbedderConfig

    ollama_mod = _fake_client_module(monkeypatch, [])
    patch_ollama_embedder()
    emb = ollama_mod.OllamaEmbedding(
        BaseEmbedderConfig(
            model="nomic-embed-text",
            ollama_base_url="http://127.0.0.1:11434",
            embedding_dims=768,
        )
    )
    # Original ensure path should have attempted pull for public tag.
    assert "nomic-embed-text" in emb.client.pulled


def test_public_model_local_no_pull(monkeypatch: pytest.MonkeyPatch) -> None:
    from mem0.configs.embeddings.base import BaseEmbedderConfig

    ollama_mod = _fake_client_module(monkeypatch, ["qwen3-embedding:0.6b", "nomic-embed-text"])
    patch_ollama_embedder()
    emb = ollama_mod.OllamaEmbedding(
        BaseEmbedderConfig(
            model="qwen3-embedding:0.6b",
            ollama_base_url="http://127.0.0.1:11434",
            embedding_dims=1024,
        )
    )
    assert emb.client.pulled == []
