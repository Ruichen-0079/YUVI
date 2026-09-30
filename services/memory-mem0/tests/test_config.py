from __future__ import annotations

import pytest
from pydantic import ValidationError

from yuvi_mem0.config import Settings
from yuvi_mem0.noop_llm import YUVI_NOOP_MODEL, YUVI_NOOP_WIRE_PROVIDER


def test_default_embedder_is_fixed_yuvi_1024(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MEM0_EMBEDDER_MODEL", raising=False)
    monkeypatch.delenv("MEM0_EMBEDDER_DIMENSIONS", raising=False)
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
    )
    assert settings.mem0_embedder_model == "yuvi-embedding:0.6b"
    assert settings.mem0_embedder_dimensions == 1024
    assert settings.mem0_pg_collection == "yuvi_mem0_qwen3_1024_v1"
    assert settings.mem0_pg_diskann is False
    assert settings.mem0_pg_hnsw is True


def test_rejects_wrong_embedder_model() -> None:
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,  # type: ignore[call-arg]
            mem0_embedder_model="qwen3-embedding:0.6b",
            mem0_pg_connection_string="postgres://x",
        )
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,  # type: ignore[call-arg]
            mem0_embedder_model="qwen3-embedding:latest",
            mem0_pg_connection_string="postgres://x",
        )


def test_rejects_wrong_dimensions() -> None:
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,  # type: ignore[call-arg]
            mem0_embedder_dimensions=1536,
            mem0_pg_connection_string="postgres://x",
        )


def test_rejects_diskann() -> None:
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,  # type: ignore[call-arg]
            mem0_pg_diskann=True,
            mem0_pg_connection_string="postgres://x",
        )


def test_build_mem0_config_with_real_llm() -> None:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
        mem0_llm_provider="openai",
        mem0_llm_model="deepseek-chat",
        mem0_llm_api_key="test-key",
        mem0_llm_base_url="https://api.deepseek.com",
    )
    config = settings.build_mem0_config()
    assert config["embedder"]["provider"] == "ollama"
    assert config["embedder"]["config"]["model"] == "yuvi-embedding:0.6b"
    assert config["embedder"]["config"]["embedding_dims"] == 1024
    assert config["vector_store"]["provider"] == "pgvector"
    assert config["vector_store"]["config"]["collection_name"] == "yuvi_mem0_qwen3_1024_v1"
    assert config["vector_store"]["config"]["embedding_model_dims"] == 1024
    assert config["vector_store"]["config"]["hnsw"] is True
    assert config["vector_store"]["config"]["diskann"] is False
    assert config["vector_store"]["config"]["host"] == "127.0.0.1"
    assert config["vector_store"]["config"]["dbname"] == "yuvi"
    assert config["vector_store"]["config"]["connection_string"] == settings.mem0_pg_connection_string
    assert config["llm"]["provider"] == "openai"
    assert config["llm"]["config"]["api_key"] == "test-key"
    assert config["llm"]["config"]["openai_base_url"] == "https://api.deepseek.com"


def test_build_mem0_config_deepseek_provider() -> None:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
        mem0_llm_provider="deepseek",
        mem0_llm_model="deepseek-chat",
        mem0_llm_api_key="test-key",
        mem0_llm_base_url="https://api.deepseek.com",
    )
    config = settings.build_mem0_config()
    assert config["llm"]["provider"] == "deepseek"
    assert config["llm"]["config"]["deepseek_base_url"] == "https://api.deepseek.com"
    assert "openai_base_url" not in config["llm"]["config"]


def test_no_placeholder_key_when_llm_missing() -> None:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        mem0_pg_connection_string="postgres://yuvi:yuvi@127.0.0.1:5432/yuvi",
        mem0_llm_model="",
        mem0_llm_api_key="",
    )
    assert settings.has_memory_llm is False
    config = settings.build_mem0_config()
    assert config["llm"]["provider"] == YUVI_NOOP_WIRE_PROVIDER
    llm_cfg = config["llm"]["config"]
    assert llm_cfg["model"] == YUVI_NOOP_MODEL
    assert "api_key" not in llm_cfg
    serialized = str(config)
    assert "yuvi-mem0-llm-not-configured" not in serialized
    assert "sk-" not in serialized
    assert "placeholder" not in serialized.lower()
