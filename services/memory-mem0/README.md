# YUVI Mem0 Sidecar

Python FastAPI sidecar that wraps **Mem0 OSS** for YUVI long-term memory.

Runtime never embeds a Mem0 Node SDK. Chat paths use the vendor-neutral
`MemoryProvider` contract; `Mem0MemoryProvider` adapts the sidecar and the
Legacy provider remains an explicit fallback. Prompt compatibility is handled
by Core's `MemoryContextBuilder`.

## Python baseline

**Formal development and deploy runtime: Python 3.11 only.**

| Item | Value |
|------|--------|
| requires-python | `>=3.11,<3.12` |
| Dockerfile base | `python:3.11.11-slim-bookworm` |
| Local system Python 3.13 | **not** a deploy baseline |

Create the venv with an explicit 3.11 interpreter:

```bash
# Windows (Astral uv managed CPython example):
py -3.11 -m venv .venv
# or:
# C:\path\to\cpython-3.11.x\python.exe -m venv .venv
.venv\Scripts\activate

# Linux / macOS (explicit 3.11 interpreter — system python3 is not enough):
# python3.11 -m venv .venv
# or: /path/to/cpython-3.11.x/bin/python3.11 -m venv .venv
# source .venv/bin/activate

python --version   # must print 3.11.x
pip install -U pip
pip install -e ".[dev]"
```

Desktop Supervisor resolves the repo-local interpreter only:

| Platform | Interpreter |
|----------|-------------|
| Windows | `services/memory-mem0/.venv/Scripts/python.exe` |
| Linux / macOS | `services/memory-mem0/.venv/bin/python` |

It never falls back to bare `python` / `python3` on `PATH`. If the venv is missing
or cannot import `uvicorn`/`fastapi`, Mem0 stays **unavailable** with a setup hint
(no crash-loop spawn).

## Architecture

```text
YUVI Runtime :6121
  └─ MemoryProvider
      ├─ Legacy provider (fallback)
      └─ Mem0MemoryProvider
          └─ Mem0MemoryBackend (HTTP adapter)
              └─ this sidecar :6131
                  ├─ Mem0 OSS (Python)
                  ├─ Ollama embedder :11434  yuvi-embedding:0.6b (1024-d, num_ctx=2048)
                  └─ PostgreSQL + pgvector collection yuvi_mem0_qwen3_1024_v1
```

Sidecar process lifecycle uses FastAPI **lifespan** (not deprecated `on_event`):

- **Startup**: validate fixed embedder config; initialize the process-global
  `Mem0Service` singleton once when PG is configured.
- **Shutdown**: `Mem0Service.shutdown()` releases Mem0 resources (best-effort).
- Request handlers reuse the same singleton — never re-create Memory per request.

### Why Python sidecar

- Mem0 OSS is mature in Python.
- Isolates Python deps from the pnpm monorepo.
- Allows independent restarts and health reporting.

### Why local embeddings

- Deterministic 1024-d vectors from YUVI Ollama model `yuvi-embedding:0.6b`.
- Same weights as `qwen3-embedding:0.6b`, with **`PARAMETER num_ctx 2048`** to cut VRAM
  (base Ollama tag often allocates CONTEXT≈16384 and ~3.8 GB).
- Verified bitwise-equal embeddings vs base model on short zh/en/ja facts → same vector
  space → collection `yuvi_mem0_qwen3_1024_v1` is **reused**.
- No cloud embedding cost for development.
- Changing model/dimensions/vector space requires a **new collection** (never silent mix).

## Fixed technical choices

| Item | Value |
|------|--------|
| Port | `6131` |
| Embedder | Ollama **`yuvi-embedding:0.6b`** |
| Base weights | `qwen3-embedding:0.6b` (Q8_0, emb length 1024) |
| `num_ctx` | **2048** (Modelfile) |
| Dimensions | **1024** (not 1536) |
| Collection | `yuvi_mem0_qwen3_1024_v1` (reused; same space) |
| Index | HNSW on, DiskANN **off** |
| Graph Memory | disabled |
| Default Runtime backend | **legacy** (Mem0 is opt-in) |
| Python | **3.11** |

### mem0ai 2.2.1 field notes

PGVector uses `connection_string` plus explicit collection/dimensions settings. Connection options (including private schema search paths/SSL) are preserved. Mem0 2.2.1 uses psycopg3/`psycopg-pool`; the YUVI atomic idempotency protocol retains its own psycopg2 connection. Pool shutdown is explicit. Existing `(id UUID, vector vector(1024), payload JSONB)` rows remain readable; no collection recreation or re-embedding is performed.

Search/list now use `filters={"user_id": scope}` and `top_k`. Updates use `text`; lineage-bearing evidence cannot be mutated through update. The upstream Ollama name/model detection fix makes the old detection patch unnecessary. Only a version-gated private `yuvi-*` no-pull guard remains; missing private tags fail `EMBEDDER_MODEL_NOT_LOCAL`, unsupported versions fail `MEM0_EMBEDDER_PATCH_UNSUPPORTED`. Public tags delegate to upstream behavior.

Finalized metadata carries the dedicated YUVI bounded canonical JSON lineage encoding, version and SHA-256 (65,536 UTF-8 bytes). The sidecar validates transport integrity without deciding committed Journal authority. Semantic admission belongs to the host. Caller metadata cannot replace keyed delivery identity; grounded corrections require new source-backed admission. Telemetry is disabled before Mem0 imports, and packaged mode does not discover `.env` files.

Local OSS has no User Profiles generator; hosted `MemoryClient` (Python 2.2.1 / Node 3.3.0 and 3.3.1) calls cloud profile APIs. This sidecar adds no hosted dependency or profile behavior.

### Memory LLM capability mode (no placeholder keys)

mem0ai always constructs an LLM at `Memory.from_config`. When `MEM0_LLM_MODEL` +
`MEM0_LLM_API_KEY` are **empty**, the sidecar intercepts its owned **`yuvi_noop`**
factory marker under an exact 2.2.1 version gate (the upstream config allowlist still excludes custom providers):

- **No** forged / placeholder API keys
- **No** outbound LLM network calls
- Sidecar still starts; embedder + vector store initialize
- `infer=false` semantic writes, search, and CRUD work
- `infer=true` returns stable error `MEMORY_LLM_NOT_CONFIGURED` (`retryable=false`)
- `/health`: `status=degraded`, `components.memoryLlm=not_configured`,
  `capabilities.infer=false`

When Memory LLM is configured:

- Provider fields follow mem0ai 2.2.1 (`openai` uses `openai_base_url`;
  `deepseek` uses `deepseek_base_url`)
- `capabilities.infer=true` when mem0 + embedder + vector are healthy
- `infer=true` performs real fact extraction / update / delete tools

Verified Memory LLM for M1 acceptance (no keys in repo):

| Field | Value |
|-------|--------|
| Provider | `deepseek` (native mem0ai provider) |
| Model | `deepseek-chat` |
| Base URL | `https://api.deepseek.com` |

Note: some flash/compatible models extract ADD facts but may return
`operation=unchanged` on preference corrections. Prefer `deepseek` +
`deepseek-chat` for reliable UPDATE history.

Use **only** independent `MEM0_LLM_*` env vars. Do not read or write main chat
provider keys into the sidecar repo.

## Dependency policy

**Single source of truth: `pyproject.toml`.**

- Install: `pip install -e ".[dev]"` (or `pip install -r requirements.txt` for
  deploy images)
- `requirements.txt` is an **export/compat pin set** mirroring `pyproject.toml`
  direct deps — keep them identical; do not hand-edit one without the other

Pinned direct versions (see pyproject for authoritative list):

| Package | Version |
|---------|---------|
| mem0ai | 2.2.1 |
| fastapi | 0.115.12 |
| uvicorn | 0.34.2 |
| pydantic | 2.11.4 |
| ollama | 0.4.8 |
| psycopg | 3.2.9 |
| psycopg2-binary | 2.9.10 |
| pytest | 8.3.5 |
| ruff | 0.11.8 |
| mypy | 1.15.0 |

## Prerequisites

1. PostgreSQL with `CREATE EXTENSION vector;`
2. Ollama on `http://127.0.0.1:11434`
3. Base weights: `ollama pull qwen3-embedding:0.6b`
4. YUVI model (create once from a Modelfile with `FROM qwen3-embedding:0.6b` and
   `PARAMETER num_ctx 2048`), then verify: `ollama list` shows `yuvi-embedding:0.6b`
5. Optional Memory LLM (OpenAI-compatible or DeepSeek) for explicit sidecar
   `infer=true` operations; normal YUVI conversation writes use `infer=false`

## Setup

```bash
cd services/memory-mem0
# Python 3.11 venv — see above
copy .env.example .env
# set MEM0_PG_CONNECTION_STRING
# optional: MEM0_LLM_PROVIDER / MODEL / API_KEY / BASE_URL
set PYTHONPATH=src
python -m yuvi_mem0
```

Health:

```bash
curl http://127.0.0.1:6131/health
```

## API

- `GET /health` — no memory writes, no LLM fact extraction, no Mem0 re-init
- `POST /v1/memories` — add (`infer` true/false)
- `POST /v1/memories/search`
- `GET /v1/memories/{id}`
- `GET /v1/memories?scope=...`
- `PUT /v1/memories/{id}`
- `DELETE /v1/memories/{id}`
- `GET /v1/memories/{id}/history` — normalized from mem0ai SQLite history

### History semantics (mem0ai 2.2.1)

History is supported via Mem0's local SQLite history DB (`memory.history(id)`).

Normalized entries: `{ id, memoryId, event, previousValue, newValue, createdAt }`.

| Case | Behaviour |
|------|-----------|
| After create/update/delete | Events `ADD` / `UPDATE` / `DELETE` when SDK records them |
| Missing memory id | Empty `items` list |
| Wrong scope (when `scope` query set) | Empty `items` list (no cross-scope leak) |

Not an undefined “depends on version” API: this sidecar always returns the YUVI
history envelope above for 2.2.1.

Scope is the Mem0 `user_id` and must be built by Runtime via:

`yuvi:v1:user:{encodeURIComponent(userId)}:character:{encodeURIComponent(characterId)}`

## Changing embeddings

If you change model or dimensions:

1. Choose a **new** collection name.
2. Update env + code constants together.
3. Do **not** write mixed-dimension vectors into the same collection.
4. Do not auto-drop existing collections.

## Startup order

1. PostgreSQL
2. Ollama `:11434`
3. Mem0 Sidecar `:6131`
4. YUVI Runtime `:6121`
5. Tauri / Vite

## Quality gates

```bash
# from services/memory-mem0 with Python 3.11 venv active
set PYTHONPATH=src
ruff check .
ruff format --check .
mypy src
pytest -q
```

Live scripts (need PG + Ollama; LLM optional unless noted):

```bash
python scripts/persistence_restart.py
python scripts/perf_bench.py
python scripts/live_infer_acceptance.py   # needs MEM0_LLM_* configured
```

## Not in this phase

- Chat prompt injection
- Chat write path
- Legacy memory migration
- Graph memory / Graphiti
- Default `MEMORY_BACKEND=mem0`

The [A10.1d validation record](../../docs/validation/v0.1.3-a10.1d-grounded-finalized-mem0.md) records the 0.1.107 → 2.2.1 migration and real PostgreSQL/Ollama/packaged Linux checks. Finalized evidence delivery always uses `infer=false`.
