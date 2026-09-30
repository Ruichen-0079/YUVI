"""Sidecar configuration. Embedding model/dimensions are fixed for collection safety."""

from __future__ import annotations

from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from yuvi_mem0.noop_llm import YUVI_NOOP_MODEL, YUVI_NOOP_WIRE_PROVIDER
from yuvi_mem0.runtime_paths import is_packaged_mode

# YUVI-tuned Ollama Modelfile over the same qwen3-embedding:0.6b weights
# with PARAMETER num_ctx 2048 (lower VRAM). Output dims remain 1024 and share
# the same vector space as the base model (verified bitwise-equal on short texts).
FIXED_EMBEDDER_MODEL = "yuvi-embedding:0.6b"
FIXED_EMBEDDER_DIMENSIONS = 1024
# Reused: same embedding space as qwen3-embedding:0.6b @ 1024-d.
FIXED_COLLECTION = "yuvi_mem0_qwen3_1024_v1"

YUVI_NOOP_LLM_PROVIDER = YUVI_NOOP_WIRE_PROVIDER
YUVI_NOOP_LLM_MODEL = YUVI_NOOP_MODEL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    mem0_sidecar_host: str = "127.0.0.1"
    mem0_sidecar_port: int = 6131

    mem0_embedder_provider: str = "ollama"
    mem0_embedder_model: str = FIXED_EMBEDDER_MODEL
    mem0_embedder_dimensions: int = FIXED_EMBEDDER_DIMENSIONS
    mem0_ollama_base_url: str = "http://127.0.0.1:11434"

    mem0_pg_connection_string: str = ""
    mem0_pg_collection: str = FIXED_COLLECTION
    mem0_pg_hnsw: bool = True
    mem0_pg_diskann: bool = False

    mem0_llm_provider: str = "openai"
    mem0_llm_model: str = ""
    mem0_llm_api_key: str = ""
    mem0_llm_base_url: str = ""
    mem0_llm_temperature: float = 0.0
    mem0_llm_timeout_ms: int = 30000

    mem0_request_timeout_ms: int = 5000
    mem0_log_content: bool = False
    mem0_health_embed_cache_ttl_s: int = 30

    @field_validator("mem0_embedder_model")
    @classmethod
    def validate_embedder_model(cls, value: str) -> str:
        if value.strip() != FIXED_EMBEDDER_MODEL:
            raise ValueError(
                f"MEM0_EMBEDDER_MODEL must be exactly '{FIXED_EMBEDDER_MODEL}' "
                f"(got '{value}'). Changing models requires a new collection."
            )
        return value.strip()

    @field_validator("mem0_embedder_dimensions")
    @classmethod
    def validate_dimensions(cls, value: int) -> int:
        if value != FIXED_EMBEDDER_DIMENSIONS:
            raise ValueError(
                f"MEM0_EMBEDDER_DIMENSIONS must be {FIXED_EMBEDDER_DIMENSIONS} for "
                f"{FIXED_EMBEDDER_MODEL}."
            )
        return value

    @field_validator("mem0_pg_diskann")
    @classmethod
    def validate_diskann_off(cls, value: bool) -> bool:
        if value:
            raise ValueError("MEM0_PG_DISKANN must be false (DiskANN is disabled for v1).")
        return False

    @property
    def has_pg(self) -> bool:
        return bool(self.mem0_pg_connection_string.strip())

    @property
    def has_memory_llm(self) -> bool:
        return bool(self.mem0_llm_model.strip() and self.mem0_llm_api_key.strip())

    def build_mem0_config(self) -> dict:
        """
        Build Memory.from_config dict for mem0ai==2.2.1.

        PGVector 2.2.1 accepts connection_string; preserve SSL/search_path URL options.
        Existing collection_name, dimensions and index settings stay fixed.
        """
        if not self.has_pg:
            raise ValueError("MEM0_PG_CONNECTION_STRING is required for Mem0 initialization.")

        pg = parse_postgres_url(self.mem0_pg_connection_string)
        config: dict = {
            "embedder": {
                "provider": "ollama",
                "config": {
                    "model": self.mem0_embedder_model,
                    "ollama_base_url": self.mem0_ollama_base_url.rstrip("/"),
                    "embedding_dims": self.mem0_embedder_dimensions,
                },
            },
            "vector_store": {
                "provider": "pgvector",
                "config": {
                    "connection_string": self.mem0_pg_connection_string,
                    "dbname": pg["dbname"],
                    "collection_name": self.mem0_pg_collection,
                    "embedding_model_dims": self.mem0_embedder_dimensions,
                    "user": pg["user"],
                    "password": pg["password"],
                    "host": pg["host"],
                    "port": pg["port"],
                    "hnsw": bool(self.mem0_pg_hnsw),
                    "diskann": False,
                },
            },
            "version": "v1.1",
        }

        # mem0ai always constructs an LLM client at init. When Memory LLM is not
        # configured we install YuviNoopLLM via factory patch — no forged API
        # keys, no outbound LLM traffic. infer=true is rejected in service.
        if self.has_memory_llm:
            config["llm"] = self._build_real_llm_config()
        else:
            from yuvi_mem0.noop_llm import build_noop_llm_config, register_yuvi_noop_llm

            register_yuvi_noop_llm()
            config["llm"] = build_noop_llm_config()

        return config

    def _build_real_llm_config(self) -> dict:
        """Map MEM0_LLM_* to mem0ai 2.2.1 provider config fields."""
        provider_raw = (self.mem0_llm_provider or "openai").strip().lower()
        model = self.mem0_llm_model.strip()
        api_key = self.mem0_llm_api_key.strip()
        base_url = self.mem0_llm_base_url.strip().rstrip("/")
        temperature = float(self.mem0_llm_temperature)

        # deepseek is a first-class provider in mem0ai 2.2.1.
        if provider_raw in ("deepseek",):
            llm_config: dict = {
                "model": model,
                "api_key": api_key,
                "temperature": temperature,
            }
            if base_url:
                llm_config["deepseek_base_url"] = base_url
            return {"provider": "deepseek", "config": llm_config}

        # openai / openai-compatible (including DeepSeek via openai provider)
        if provider_raw in ("openai", "openai_compatible", "openai-compatible", ""):
            llm_config = {
                "model": model,
                "api_key": api_key,
                "temperature": temperature,
            }
            if base_url:
                llm_config["openai_base_url"] = base_url
            return {"provider": "openai", "config": llm_config}

        # Pass-through for other mem0-supported providers (ollama, litellm, …).
        llm_config = {
            "model": model,
            "api_key": api_key,
            "temperature": temperature,
        }
        if base_url:
            # Prefer openai_base_url as common extension; providers ignore unknowns
            # only if they accept via BaseLlmConfig kwargs — use openai_base_url
            # for openai-family, deepseek_base_url already handled above.
            llm_config["openai_base_url"] = base_url
        return {"provider": provider_raw, "config": llm_config}


def parse_postgres_url(url: str) -> dict[str, str | int]:
    """Parse postgres://user:pass@host:port/dbname into mem0 pgvector fields."""
    from urllib.parse import unquote, urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("postgres", "postgresql"):
        raise ValueError("MEM0_PG_CONNECTION_STRING must be a postgres URL.")
    dbname = (parsed.path or "").lstrip("/")
    if not dbname:
        raise ValueError("MEM0_PG_CONNECTION_STRING must include a database name.")
    return {
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "host": parsed.hostname or "127.0.0.1",
        "port": int(parsed.port or 5432),
        "dbname": dbname,
    }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    if is_packaged_mode():
        # Packaged mode must never discover a .env from cwd, the install
        # directory, or an accidentally inherited repository path.
        return Settings(_env_file=None)  # type: ignore[call-arg]
    return Settings()
