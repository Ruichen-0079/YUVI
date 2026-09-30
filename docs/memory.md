# Memory

Memory is not raw chat log injection. The runtime stores structured memories, retrieves candidates, ranks them, compresses them, and reconstructs prompt-safe context.

## Runtime-ready memory architecture (P3)

The P3 migration keeps storage, semantic evidence, prompt compatibility, and
authoritative runtime state as separate boundaries. `MemoryBackend` is the
storage-level contract (`health`, `add`, `search`, `get`, `list`, `update`,
`delete`, and `history`). `MemoryProvider` is the runtime-facing semantic
contract: it retrieves `MemoryRetrievalOutcome`, returns canonical
`MemoryEvent` evidence, and accepts `MemoryWriteEventInput` for semantic writes.
The runtime does not import a Mem0 SDK or sidecar DTO.

`MemoryEvent` is canonical, provenance-preserving evidence. Its stable opaque
`id` is independent of rank and prompt position. The Mem0 adapter uses
`mem0:<memoryId>` with `source=mem0` and the raw Mem0 UUID in
`sourceRecordId`; scope is enforced on reads and is not encoded into the ID.
Missing source timestamps remain unknown: `createdAt` maps to `recordedAt`,
while `occurredAt` is supplied only by explicit event metadata. The provider
never fills a missing timestamp with `now`.

`MemoryContextBuilder` is the only compatibility bridge to the existing
PromptBuilder. It retains canonical events for diagnostics and projects
prompt-safe `{ content, displayText }` objects with an internal
`provenanceId`. Current-turn and DirectContext echoes are removed
deterministically with a reason, while their canonical events remain. Prompt
wording, memory limits, token budgets, scope filtering, and DirectContext
behavior remain owned by the existing prompt/retrieval code.

### Read and write flows

```text
READ
Mem0 → MemoryBackend → Mem0MemoryProvider
     → MemoryRetrievalOutcome → MemoryEvent[]
     → MemoryContextBuilder → PromptBuilder

WRITE
Conversation → MemoryIngestionPolicy → MemoryWriteEventInput
            → MemoryProvider.writeEvent() → Mem0MemoryProvider
            → MemoryBackend → Mem0
```

`MemoryIngestionPolicy` is the factual/user-claim write boundary. Normal
conversation turns produce only user-grounded factual events, each dispatched
through `writeEvent()` with `infer=false`; the assistant is context, not a
default fact source. Explicit remember produces one unverified `user_claim`
event and is not a verified truth. Assistant-only relationship or affect
prose is rejected. There is no normal-turn user+assistant `infer=true` write,
and no interpretation loop that writes assistant-derived state back to Mem0.

Evidence is not authoritative `Relationship`, `Affect`, `Persona`, `Interest`,
or `Commitment` state. A memory containing metadata such as `trust` or
`closeness` does not create those states. A future path may compile selected
evidence as `MemoryProvider → MemoryEvent[] → RuntimeStateEnvelope →
GroundedClaimCompiler`; that state path is not implemented in P3.

Retrieval status is epistemic and must be preserved: `ok`, `empty`,
`unavailable`, `error`, or `partial`. `empty` means no relevant hit for this
query, not confirmed database absence. `unavailable`/`error` are not amnesia.
When a provider is unavailable or errors, legacy retrieval may supply prompt
memories; diagnostics still preserve the provider status and mark the final
prompt result separately. A successful fallback does not mean provider health
was restored. The valid state is therefore `provider=unavailable`,
`fallbackUsed=true`, `final=ok` when legacy retrieval produced a usable result.

Forget remains a scoped search/delete operation. Dialogue-level “forget” does
not imply a future administrator delete, repair, rollback, or audit operation.
Observability is intentionally safe: status, counts, bounded query length,
stable event IDs, drop reasons, source, and aggregate provenance flags may be
reported; full memory text, raw query text, metadata, credentials, database
URLs, authorization headers, tokens, API keys, and secrets must not be logged.

The migration is storage-compatible: existing Mem0 records remain readable,
there is no new event store, and no database or pgvector migration is required
for the semantic contracts.

## Durable finalized-ingestion ledger

When PostgreSQL-backed repository mode is enabled, completed text turns also
cross a separate Yuvi operational ledger. The conversation repository remains
authoritative for the finalized assistant text; the ledger records the
admission decision, frozen policy output, durable child-event identities, and
the outcome state of each semantic event. Mem0 remains a derived semantic
store and is not treated as the ledger.

The canonical ordering is:

`committed user receipt → assistant finalization / conversation persistence → exact Journal grounding → policy materialization / frozen lineage-bearing child admission → coordinator wake → shared C1 delivery executor`

Each finalized turn receives an immutable `finalized_turn_id`. Each materialized
child receives a content-derived stable event identity and a persisted backend
key of the form
`yuvi:finalized-turn:<finalized-turn-id>:event:<stable-event-id>`.
The canonical finalized C1 path enforces these keys as backend idempotency
identities. Ordinary compatibility Mem0 writes outside this keyed path are not
governed by that contract. Ledger rows and child payloads are persisted before
delivery starts. `MemoryIngestionCoordinator` owns automatic execution of that
durable child work. `notifyAdmitted()` is a wake signal only; one serialized
scheduler loop discovers pending, due retryable, expired-lease, and
`reconcile_required` events, then calls the shared C1 executor or exact
reconciliation primitive. Per-process concurrency is capped by
`MEMORY_INGESTION_CONCURRENCY` across wake, poll, startup, retry, reclaim,
and reconcile work. Cross-process correctness still depends on PostgreSQL
claims and backend idempotency. Request completion does not wait for backend
delivery. A process crash can therefore leave `pending`, `processing`, or
`retryable_failed` work, while uncertain provider outcomes remain
`reconcile_required` work. Coordinator startup is asynchronous and must not
block application readiness. Historical assistant rows with
`ingestion_requested = NULL` stay outside automatic recovery. Automatic
missing-admission remains restricted to completed assistant rows with
`ingestion_requested = true`, a finalized identity, and recoverable
user/persona scope. Recovery obtains exact persisted user text and `sourceJournalRef`; missing/malformed ancestry produces terminal materialization failure without children. The grounded policy epoch is `factual-v1/schema-2/grounded-a10.1d`. Old pending/retryable children lacking finalized lineage fail closed before dispatch with `MEMORY_FINALIZED_LINEAGE_MISSING`. Historical terminal rows are not rewritten; uncertain old effects retain exact reconciliation before any possible dispatch guard.

Ordinary backend delivery is gated by `MEMORY_INGESTION_MAX_DELIVERY_ATTEMPTS`
(default 8). The budget counts durable dispatch markers only, not claims or
reconciliation probes. Exhaustion may terminalize a child only when the
durable state proves no unresolved external effect, including exact
`not_applied` after a previous ambiguous dispatch. `reconcile_required`,
`in_flight`, and `unknown` are never converted to terminal failure by the
retry budget.

Coordinator work statistics are observability, not availability.
`GET /health` continues to derive overall `ok` from existing core service
conditions such as database and chat-provider health. A diagnostics query
failure, a stopped coordinator, or a pending/reconcile backlog does not make
the server unavailable. When durable counts cannot be read they stay `null`
instead of being reported as zero. Runtime settings use the same fail-open
rule for `memory.ingestionCoordinator`.

Semantic write failures retain a typed classification. Definitive validation
or explicitly rejected backend responses become terminal failures; only a
provider result that proves no external dispatch occurred may become ordinary
retryable work; timeout, connection loss, malformed responses, and other
uncertain outcomes become `reconcile_required`. Materialization/policy-build
failures are recorded as one durable `terminal_failed` parent with
`failure_stage=materialization` and no fabricated child events.

Memory-disabled turns are durably recorded as `skipped`. Missing required
persona/user scope is recorded as a terminal admission failure and is not
classified as an intentional skip. Existing completed assistant rows receive
identity-only migration backfill (`legacy:conversation:<message-id>`); their
historical ingestion outcome remains unknown and is discoverable rather than
being marked complete.

Voice transcripts now enter the same durable finalized-turn path as text. The
`user.voice.transcript` event is persisted as the canonical user message,
followed by the normal assistant finalization, ingestion admission, durable
Mem0 write scheduling, and optional TTS side effect. STT failures stop before a
user turn is persisted; later chat failures leave the persisted user turn
without a finalized assistant row. The transcript retains language,
confidence, speaker, and voice-profile metadata when supplied. These fields are descriptive, not Journal identity authority. Real speech retains `EXTERNAL_OBSERVATION`; mock text retains `USER_ASSERTION`. Lineage preserves committed `recordedAt` and exact `occurrenceTime`, including UNKNOWN.

## Categories

- `working`: short-lived task/session state, such as the current goal or active preference.
- `episodic`: remembered interactions and events, stored as compact summaries rather than raw transcripts.
- `semantic`: stable facts about the user, companion, world, projects, or entities.
- `emotional`: affective signals such as valence, arousal, recurring stressors, and positive anchors.
- `procedural`: learned routines, instructions, workflows, and “how we do this” patterns.

## Storage

Development defaults to `MEMORY_REPOSITORY=in-memory`, which is useful for quick iteration but resets when the server restarts. Durable development memory uses PostgreSQL with pgvector after `MEMORY_REPOSITORY=postgres`, `DATABASE_URL`, and migrations are configured.

Packaged YUVI owns a private PostgreSQL 16 cluster under the user-writable
`%LOCALAPPDATA%\\YUVI\\Postgres` data root (P4-2D1). Supervisor is the lifecycle
owner. The packaged password lives in Windows Credential Manager
(`YUVI/postgres/local`); it is not a user-editable setting and is not stored
as a long-lived `local.secret`. Runtime repository selection and Yuvi schema
migrations are not switched in D1; those land in P4-2D2/D3. External
`DATABASE_URL` remains an advanced override and is never started or stopped by
the private-cluster owner.

Migrations live in:

```text
packages/memory/migrations/
```

Core tables:

- `memories`
- `entities`
- `relations`

PostgreSQL mode uses YUVI Postgres Search v2 plus optional pgvector retrieval. `pg_trgm` is enabled by migration, content and summary have trigram indexes, tags and metadata use GIN indexes, and structured fields such as scope, scopeId, memoryLayer, status, type, subtype, source, sourceTraceId, timestamps, and importance have supporting indexes for filtering and ranking. A built-in PostgreSQL full-text expression index using the `simple` config complements keyword and trigram matching.

Search covers content, summary, tags, type, subtype, scope, scopeId, memoryLayer, source/sourceTraceId, and safe metadata text. This supports Chinese, English, mixed Chinese/English queries such as `YUVI Runtime 是什么项目`, local paths like `C:\Users\...`, ports such as `6121`, URLs such as `ws://127.0.0.1:6121`, env keys such as `MEMORY_EXTRACTOR`, and commands such as `pnpm db:migrate`. Prompt Preview and memory search debug metadata can report `retrievalMode`, `matchedBy`, `score`, rank components, type/subtype/source/importance, and `sourceTraceId`.

Embeddings augment this keyword/trigram/full-text path; they do not replace it. Exact technical matches such as paths, ports, commands, provider names, model names, env vars, tags, and error messages remain high-priority signals. Real-provider-first development uses `EMBEDDING_PROVIDER=openai-compatible` when configured. `EMBEDDING_PROVIDER=mock` is explicit offline/test mode and reports `semanticEmbedding=false` because it validates the retrieval pipeline without real semantic similarity. Real embeddings may consume provider tokens:

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_BASEURL=https://example-embedding-provider.test/v1
EMBEDDING_API_KEY=replace-with-embedding-api-key
EMBEDDING_MODEL=replace-with-embedding-model
EMBEDDING_DIMENSIONS=1536
```

DashScope `text-embedding-v4` works through OpenAI-compatible mode:

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_BASEURL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=<DashScope API key>
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIMENSIONS=1536
```

Use Dashboard **Verify Embedding** or `POST /providers/verify/embedding` only when you explicitly want to call the active embedding provider. Verification returns safe provider/model/dimension/latency metadata and may consume provider usage. It never returns API keys or raw embedding vectors.

New memory writes generate embeddings when the configured provider is available. If embedding generation fails, YUVI stores the memory without a vector and retrieval falls back to keyword/trigram/full-text search. Existing Postgres memories can be backfilled after migrations:

```bash
pnpm memory:embed:backfill
pnpm memory:embed:backfill -- --dry-run
pnpm memory:embed:backfill -- --limit 100
pnpm memory:embed:backfill -- --force
```

Backfill defaults to missing embeddings only. Use `--force` to re-embed existing vectors, and optional filters such as `--scope project`, `--scopeId yuvi-runtime`, and `--status active` to keep a run bounded. The script prints provider/model/dimensions, progress counts, and a summary of `scanned`, `skipped`, `embedded`, and `failed`. It does not print API keys or raw vectors. If a provider returns a vector whose size differs from `EMBEDDING_DIMENSIONS`, YUVI does not store that vector and reports a safe diagnostic with expected dimensions, actual dimensions, provider, and model.

The API and Dashboard expose safe embedding metadata such as `hasEmbedding`, `embeddedAt`, `embeddingProvider`, `embeddingModel`, `embeddingDimensions`, `semanticEmbedding`, and safe `embeddingError` text when available. Raw embedding vectors are not returned by default.

Keyword/trigram/full-text retrieval remains important for technical memories. Exact env vars, commands, paths, ports, provider names, model names, error messages, and tags should outrank vague vector similarity. ANN vector indexing is optional acceleration only.

## ANN Vector Index v1

PostgreSQL memory can optionally add a pgvector ANN index to accelerate vector candidate lookup. This is a performance feature only. It does not change retrieval semantics, prompt policy, scope/status/time filtering, Direct Context behavior, supersession exclusions, or the keyword-first ranking rules for technical memories.

The ANN index migration is idempotent and non-destructive. It prefers HNSW when supported by the installed pgvector version, then falls back to IVFFLAT if HNSW creation is unavailable. Both indexes use cosine distance and a fixed-dimension expression over the existing `embedding` column; the migration does not change stored vectors or embedding dimensions.

Configuration:

```env
MEMORY_VECTOR_INDEX_ENABLED=true
MEMORY_VECTOR_INDEX_TYPE=hnsw
MEMORY_VECTOR_DISTANCE=cosine
MEMORY_VECTOR_IVFFLAT_PROBES=10
MEMORY_VECTOR_HNSW_EF_SEARCH=
```

Allowed index types are `hnsw`, `ivfflat`, and `none`. Set `MEMORY_VECTOR_INDEX_ENABLED=false` or `MEMORY_VECTOR_INDEX_TYPE=none` to skip index creation in small development setups. `EMBEDDING_DIMENSIONS` controls the fixed-dimension expression used during migration; DashScope `text-embedding-v4` commonly uses `1536`.

For the current Linux Qwen3-Embedding-0.6B Q8_0 local deployment, set `EMBEDDING_DIMENSIONS=512`. Migration `010_embedding_mrl_512_v1.sql` converts existing 1024-dimensional Qwen vectors in place to the first-512 L2-normalized prefix, preserves memory identity/content/metadata and temporal fields, and rebuilds the configured cosine ANN index at 512 dimensions. It is target-aware and leaves other configured dimensions unchanged.

Run migrations normally:

```bash
pnpm db:migrate
```

Check safe index diagnostics:

```bash
pnpm memory:index:status
```

The status command reports whether embedding-related indexes exist, their type, vector dimensions present in memory rows, embedded count, and missing embedding count. It does not print API keys, `DATABASE_URL`, raw vectors, or memory content.

HNSW generally has better recall/latency behavior for growing datasets. IVFFLAT is a fallback and may require tuning with `MEMORY_VECTOR_IVFFLAT_PROBES`. HNSW can optionally use `MEMORY_VECTOR_HNSW_EF_SEARCH`. These settings tune vector candidate lookup only; exact keyword/tag/path/env-var matches still remain crucial and should outrank weak vector similarity.

Dashboard memory/status panels expose the same safe ANN visibility where available: configured index type, cosine distance, configured dimensions, embedded count, missing embedding count, and whether ANN acceleration is active. If no index is available, the Dashboard shows a safe fallback notice; retrieval still works through keyword, trigram, full-text, and non-indexed vector search when configured.

## Personalization And Retention v1

Memory records now include identity foundation fields for future multi-user and multi-persona use:

- `personaId`: which YUVI persona or agent owns/uses the memory.
- `subjectUserId`: who the memory is about.
- `createdByUserId`: who stated the information.
- `speakerId`: UI/STT speaker identity when supplied.
- `voiceProfileId`: future voiceprint binding.
- `sessionId`: originating session.

Single-user behavior remains unchanged. When no identity is supplied, YUVI defaults `personaId` to `default-persona` and user fields to `default-user`. Retrieval can filter by persona, subject user, speaker, session, and existing scope/scopeId so unrelated users do not mix once identity fields are present. This is foundation only; YUVI does not implement STT diarization or voiceprint recognition yet.

The developer voice route (`POST /v1/voice/message`) preserves supplied `speakerId`, `voiceProfileId`, `subjectUserId`, `createdByUserId`, and `sessionId` metadata when it transcribes audio and passes a `user.voice.transcript` event through the normal durable message runtime. These fields are metadata only in v1 and do not imply actual speaker recognition.

Automatic extraction favors durable user information: explicit name/nickname, long-term preferences, project/provider/model choices, device or environment facts, workflow habits, communication/accessibility preferences, stable constraints, explicit important relationships, and explicit useful health/safety notes. It avoids storing trivial daily events, casual temporary moods, ambiguous guesses, and sensitive inferences that the user did not state.

Current affect is short-term prompt context, not long-term memory by default. Rule-based detection can label obvious immediate states such as frustrated, anxious, confused, angry, sad, tired, excited, calm, or neutral from the current user turn. PromptBuilder may inject a compact section:

```text
<CurrentAffect>
User appears frustrated/confused in the current turn. Respond with concise, concrete debugging steps.
</CurrentAffect>
```

This affects response tone and strategy for the turn. One-off messages such as “今天有点烦” are not stored as durable emotional memory. Long-term emotional memory is reserved for explicit communication preferences, repeated patterns over time, or useful safety/health-relevant notes such as a stable preference for direct step-by-step debugging when project failures become stressful.

Retention Policy v1 computes safe metadata during storage:

- `retentionClass`
- `retentionReason`
- `computedExpiresAt` when a TTL is applied

Default retention is category and importance based:

- semantic/core identity and stable preferences: no default expiry unless low confidence
- project facts, provider choices, config decisions, workflows: 180-365 days, or no expiry when highly important
- troubleshooting conclusions: 90-180 days
- emotional patterns: 90-365 days depending on importance
- explicit stable relationships: long retention; no expiry only when explicit and high importance
- explicit health/safety notes: long retention, no short TTL, and no unsafe inference
- schedule/task memories: expire after the event/deadline plus a small buffer
- ordinary episodic daily events: rejected by default; if explicitly remembered/manual, expire after about seven days
- working/session memories: hours to one day
- smoke/mock/test memories: expire within one day

Higher importance extends retention. Durable memories at `importance >= 0.9` generally avoid short expiry. Smoke/mock/test memories are marked with safe metadata such as `testMemory=true` and are meant to be marked expired by maintenance after their short TTL. Normal prompt retrieval and fallback-recent retrieval exclude smoke/mock/test memories by default so local validation text such as `Smoke test memory.` does not pollute `RelevantMemory`. Manual/debug search can opt into those records with `includeTestMemories=true`. No retention rule hard-deletes data.

## Memory Model v2

Memory records now carry the foundation for scoped and temporal memory:

- `scope`: `user`, `project`, `agent`, `plugin`, or `session`
- `scopeId`: optional scope identifier such as `yuvi-runtime`
- `memoryLayer`: `core`, `recall`, `archival`, or `working`
- `status`: `active`, `superseded`, `archived`, `forgotten`, or `expired`
- temporal fields: `observedAt`, `eventTime`, `validFrom`, `validUntil`, `expiresAt`, `lastAccessedAt`, `supersededAt`
- lightweight relation fields: `supersedes`, `supersededBy`, and `contradicts`

Default prompt retrieval only uses `active` memories whose validity window currently applies. `forgotten`, `expired`, and `superseded` memories are excluded by default. `archived` memories remain available for manual inspection but are not injected into prompts unless a future debug/history mode opts into them.

The default scope is `user`. YUVI project memories can be inferred as `scope=project` and `scopeId=yuvi-runtime`. `working` memories map to the `working` layer; stable semantic preferences and project facts map to `core`; episodic milestones and troubleshooting records map to `recall`.

## Temporal Normalization

Long-term memory must not preserve unresolved relative time phrases such as `今早`, `今天`, `昨天`, `刚才`, `today`, `yesterday`, `this morning`, or `last night`. Before storage, `MemoryService` resolves relative temporal text against the candidate `observedAt`, extraction time, user timezone when available, and server timezone as a fallback.

For example, if the current observed date is `2026-05-23`:

```text
我今早吃了芒果蛋糕
=> 用户在 2026-05-23 早上吃了芒果蛋糕。
```

Temporal normalization stores safe metadata such as `originalTemporalText`, `normalizedTemporalText`, and `temporalResolution` with the detected relative expression, resolved date, resolution source, confidence, and a suggested rewrite when available. Low-confidence phrases such as broad `最近` style claims are not aggressively rewritten; they are rejected by automatic storage or surfaced as warning-only metadata in manual/debug flows.

Ordinary one-off daily events are not durable facts. A message like `我今早吃了芒果蛋糕` is classified as `episodic / event / recall`, tagged with signals such as `meal` or `activity`, assigned low-to-medium importance, and rejected by default as an ordinary one-off daily event. An explicit request such as `记住：我今早吃了芒果蛋糕` may store the event, but it remains time-bound episodic recall and is not upgraded to `semantic / core`.

Stable implications can still become core memory: preferences, allergy or health notes, schedules and future commitments, project facts, workflows, provider/config choices, and troubleshooting conclusions. For example, `我喜欢芒果蛋糕` remains `semantic / preference / core`.

Temporal fields use these meanings:

- `eventTime`: the resolved event time when known.
- `validFrom`: when the memory becomes current, usually the event or observed time.
- `validUntil`: when the memory is no longer current, commonly the end of the resolved local day for daily events.
- `expiresAt`: when the memory should no longer be normally retrieved or injected; ordinary stored episodic events default to about seven days.

Direct Context may preserve words like `刚才` or `今天` because it is short-term same-session context. Long-term memory content should use absolute time or be rejected/warning-marked.

## Read Pipeline v2

Prompt assembly now combines short-term Direct Context with long-term RelevantMemory. They are separate on purpose:

- `DirectContext` is bounded recent same-session context. It improves conversational continuity for recent turns, immediate confirmations, current task intent, and recent errors. It is not long-term memory; raw conversation persistence is handled separately by the Conversation Repository.
- `RelevantMemory` is durable long-term memory retrieved from `MemoryService`, filtered by scope/status/time and ranked before prompt injection.

Default Direct Context settings are `DIRECT_CONTEXT_ENABLED=true`, `DIRECT_CONTEXT_MAX_TURNS=6`, and `DIRECT_CONTEXT_MAX_CHARS=6000`. The runtime trims oldest turns first, does not use LLM summarization, and redacts secret-like values before prompt injection.

Long-term prompt retrieval remains scope-aware, status-aware, and time-aware:

- Default prompt reads include `user` and `project:yuvi-runtime`; current-session reads also include `session:<sessionId>`.
- `agent` and `plugin` scopes are only included when the request supplies matching context.
- Unrelated project, plugin, or agent memories are filtered out before prompt injection.
- `forgotten`, `expired`, `superseded`, and `archived` memories are excluded from prompt injection by default.
- `includeArchived`, `includeSuperseded`, and `includeExpired` are manual/debug search options, not normal prompt defaults.
- `includeHistoricalEpisodic` is used for history-intent queries such as `我那天吃了什么`, `之前吃过什么`, `history`, `previously`, or `before`; it may include stale episodic recall but still excludes forgotten memories by default.
- `expiresAt`, `validUntil`, and future `validFrom` values are respected during retrieval.
- `lastAccessedAt` is updated when a memory is selected, so future ranking can use access recency.

Ranking combines keyword relevance, type/subtype priority, memory layer priority, importance, recency, access recency, source quality, and scope match quality. Core active memories in the current project/user scope are favored; low-importance verbose runtime episodic summaries, archival records, and unrelated scoped records are down-ranked or excluded.

Prompt Preview exposes explainable debug fields such as `retrievalScope`, `includedScopes`, `includeArchived`, `includeSuperseded`, `includeExpired`, `excludedByStatus`, `excludedByTime`, `excludedByScope`, `currentTime`, `vectorEnabled`, `vectorUsed`, `embeddingProvider`, `embeddingModel`, `queryEmbeddingGenerated`, `vectorResultCount`, `keywordResultCount`, `hybridResultCount`, `fallbackUsed`, and per-memory `matchedBy`, `score`, optional rank components (`keywordScore`, `tagScore`, `trigramScore`, `fullTextScore`, `vectorScore`, `hybridScore`, `scopeScore`, `importanceScore`, `recencyScore`), `scope`, `memoryLayer`, `status`, temporal fields, and `excludedReason`.

PromptBuilder also injects a `CurrentTime` section containing the current ISO timestamp, timezone, and local date. RelevantMemory bullets may include compact hints such as `[project:yuvi-runtime][core][active]` or `[2026-05-23 morning][episodic][recall]` so the model can reason about scope and freshness without receiving verbose metadata. Time-bound memories should carry absolute time hints and should not inject unresolved relative phrases.

Prompt Preview reports Direct Context budget metadata: `directContextEnabled`, `directContextTurnCount`, `directContextCharCount`, `directContextTruncated`, and `directContextSource`. The prompt sections remain distinct:

```text
<CurrentTime>
...
</CurrentTime>

<DirectContext>
...
</DirectContext>

<RecentEpisodicMemory>
...
</RecentEpisodicMemory>

<RelevantMemory>
...
</RelevantMemory>
```

Memory vNext adds a Yuvi-native hierarchical context on top of this pipeline
without replacing MemoryProvider or MemoryEvent authority. `DirectContext` is
L0 working context. `RecentEpisodicMemory` is the L1 hours/days episode
ledger. `RelevantMemory` remains L2 durable evidence, optionally plus bounded
associative recalls (context only, not a speak gate). Dream delivery uses
`MemoryProvider.writeEventIdempotent` and `reconcileEvent`. Idle Dream is
deferred / not Runtime-active. Structured compression exists as a primitive
and is not applied to the live Runtime/Character prompt. Thin temporal
projection and remaining boundaries are documented in
[Memory vNext](./memory-vnext.md). Continuity and the full Temporal substrate
remain planned and are not implemented here.

## Lightweight Supersession And Contradiction Suggestions

YUVI has a lightweight, rule-based relationship pass in `packages/memory`. It is not a graph reasoning engine. When a candidate is being processed, `MemoryService` compares it with memories from compatible scopes and records safe relationship hints:

- `supersedes`: the new memory may replace an older memory.
- `supersededBy` / `supersededAt`: set on an older memory only for high-confidence safe replacements.
- `contradicts`: the new memory appears to conflict with another memory but should be reviewed.

Scope boundaries are conservative. User memories compare with user memories. Project, plugin, agent, and session memories only compare when the relevant `scopeId` matches. A memory from another project must not supersede the current project.

The v1 rules only cover obvious structured categories: provider choices, config decisions, project paths, ports/endpoints, model choices, memory mode, workflow/procedure notes, troubleshooting conclusions, and stable preferences. Exact structured evidence such as tags, subtype, provider names, config keys, paths, ports, model names, and project scope dominates; embedding similarity may help find candidates but cannot supersede by itself.

High-confidence safe examples can auto-supersede:

- `用户偏好 Chat provider 使用 OpenAI。` -> `用户偏好 Chat provider 使用 DeepSeek。`
- `项目路径是 C:\old-path` -> `项目路径改为 C:\Users\Administrator.DESKTOP-NPU6DHJ\Desktop\uv-main`

Risky or ambiguous categories are suggestion-only. Health/safety notes, emotional or relationship memories, legal/financial-like notes, ambiguous personal facts, and cross-scope conflicts are never automatically superseded in v1. They may receive `contradicts` debug metadata for review.

Superseded memories are retained for history/debug but excluded from normal prompt injection. Manual or historical/debug search can include them with `includeSuperseded=true`. Forgotten memories remain excluded by default.

Candidate Review shows possible supersessions, contradictions, confidence, reason, and safe old-memory previews when available. This remains developer/debug tooling; normal runtime decisions are still only `stored` or `rejected`.

Full graph reasoning over `supersedes`, `supersededBy`, and `contradicts` is future work. Automatic background retention scheduling is also future work; forgetting is status-based for now.

## Memory Maintenance v1

Memory Maintenance v1 is a safe cleanup pass for long-term memory. It never hard-deletes records. Instead, it marks elapsed memories, reports health, and audits obvious supersession inconsistencies so the memory store stays understandable without losing history.

Run it from the repository root:

```bash
pnpm memory:maintenance -- --dry-run
pnpm memory:maintenance
pnpm memory:maintenance -- --limit 100
pnpm memory:maintenance -- --scope project --scopeId yuvi-runtime
```

Dry-run mode is the recommended first step. It scans the active repository and reports `scanned`, `expired`, `stale`, `supersessionWarnings`, `skipped`, and `failed` without modifying data. The script prints safe repository/provider-style metadata only; it does not print API keys, tokens, Authorization headers, `DATABASE_URL`, or raw vectors.

Expired and stale mean different things:

- `expired`: an `active` memory whose `expiresAt` is before the maintenance `now`. A non-dry-run marks it `status=expired`, updates `updatedAt`, and writes safe metadata such as `maintenanceReason="expiresAt elapsed"` and `expiredByMaintenance=true`.
- `stale`: an `active` `episodic / recall` memory whose `validUntil` is before `now`. It is no longer current, but it is not marked expired unless `expiresAt` has also elapsed. Maintenance reports it and may add `staleByValidity=true` metadata.

Retrieval behavior stays the same. Normal prompt injection excludes `forgotten`, `expired`, `superseded`, archived, and stale episodic memories. Historical-intent retrieval can include stale episodic memories through `includeHistoricalEpisodic`, but forgotten memories remain excluded by default.

Maintenance also audits supersession state. It can safely fix active memories that already have `supersededBy` set and superseded memories missing `supersededAt`. It reports memories that claim to supersede missing or deleted IDs as warnings only.

The Dashboard Memory page shows a lightweight health summary: active, expired, archived, superseded, forgotten, stale episodic, and missing embedding counts. In development, `POST /memory/maintenance/run` is protected like other sensitive dashboard actions and can run dry-run or real maintenance from the UI. `GET /memory/maintenance/status` reports safe in-memory scheduler state: enabled flags, interval, limit, running state, last run, last summary, last safe error, and next run time.

Memory Maintenance Scheduler v1 is optional and disabled by default:

```env
MEMORY_MAINTENANCE_ENABLED=true
MEMORY_MAINTENANCE_RUN_ON_STARTUP=true
MEMORY_MAINTENANCE_INTERVAL_MINUTES=360
MEMORY_MAINTENANCE_LIMIT=500
```

`MEMORY_MAINTENANCE_ENABLED=false` disables all automatic maintenance. `MEMORY_MAINTENANCE_INTERVAL_MINUTES=0` means no interval timer. Startup maintenance only runs when both `MEMORY_MAINTENANCE_ENABLED=true` and `MEMORY_MAINTENANCE_RUN_ON_STARTUP=true`. All scheduled runs are bounded by `MEMORY_MAINTENANCE_LIMIT`, log only safe summary counts, and clear their timer on server shutdown.

Recommended local development settings are a startup run plus a long interval such as 360 minutes when using PostgreSQL memory. Keep it disabled for tests unless a test explicitly enables it. A future retention scheduler may add richer policies, but v1 only marks expired/stale state and audits supersession; it does not delete or purge memories.

## Manual Management

The Dashboard Memory page is a development console for manual memory management. It can:

- view memory details and debug metadata
- create manual memories with type, subtype, scope, layer, status, summary, importance, source, tags, and temporal fields
- edit content, summary, type, subtype, scope, layer, status, importance, emotion fields, tags, temporal fields, and safe metadata
- archive, restore, forget, or delete memories from the active repository
- search and filter memories by type, subtype, source, scope, scopeId, memory layer, status, importance, and opt-in archived/superseded/expired history

Manual memories should use `source=dashboard` or `source=manual`. Deleted memories are removed from retrieval results. Do not store API keys, passwords, tokens, Authorization headers, or other secrets in memory metadata or content.

Archive/restore/forget are the first forgetting foundation. Archive keeps a memory visible for manual management but excludes it from prompt injection. Forget marks a memory as `forgotten`, which excludes it from normal retrieval.

Manual create/edit and Candidate Review show a warning when content still contains unresolved relative temporal text. The guard is warning-only in v1 and may include a suggested absolute rewrite, but saving is not blocked.

## Automatic Writes

Automatic memory writes are conservative. `readMemory` controls retrieval for prompt context, while `writeMemory` controls whether the runtime may write new memories after a turn. When `writeMemory=false`, the runtime must not write memory.

The rule-based extractor only proposes memories for durable signals such as explicit `remember` / `记住`, `from now on` / `以后`, long-term preferences, provider choices, project paths, repository paths, startup commands, configuration decisions, troubleshooting conclusions, stable workflow instructions, and project milestones. Ordinary questions, greetings, failed answers, uncertain assistant responses, and ordinary one-off daily events are not stored automatically. Explicit remember can store a daily event, but it remains `episodic / event / recall` with temporal bounds and low-to-medium importance. Use the Dashboard Memory page for explicit manual corrections.

`MEMORY_EXTRACTOR=llm` is the default and uses the configured DeepSeek Reasoning provider when available, so it consumes reasoning tokens only when `writeMemory=true`. The LLM can only propose internal/debug candidates; `MemoryService` owns normalization, classification correction, scoring, deduplication, storage decisions, and `storageReason` / `rejectedReason`. Normal runtime decisions are `stored` or `rejected`. Invalid JSON fails closed, and unavailable reasoning providers fall back to the rule-based extractor. `MEMORY_EXTRACTOR=rule-based` remains available for deterministic no-token extraction.

## Candidate Review

The Dashboard exposes recent memory extraction candidates as development-only debug state. Candidate history is currently in-memory and volatile; it resets when the server restarts. Candidates are suggestions, not a separate product-facing workflow or source of truth. They show the extractor mode, source trace, type/subtype, preview text, summary, importance, confidence, tags, reason, and final normal-runtime decision (`stored` or `rejected`). Suspicious metadata keys such as API keys, tokens, passwords, bearer values, and Authorization headers are redacted.

From the Dashboard, a developer can accept, edit-and-save, or reject a recent candidate. Accepting a candidate writes it through the normal memory service path as a dashboard/manual memory; accepting an already stored candidate does not create a duplicate. Rejecting a candidate only updates the in-memory candidate history. LLM extraction never bypasses validation, temporal normalization, scoring, or manual memory controls.

## Prompt Safety

Raw chat logs are noisy and can overfit the companion to irrelevant phrasing. Before prompt injection, memory must be compressed into concise reconstructed context:

1. retrieve candidate memories
2. rank by relevance, recency, and importance
3. compress or use stored summaries
4. reconstruct a small prompt-ready memory block

This keeps prompts smaller, reduces accidental leakage of irrelevant history, and makes memory feel like understanding rather than transcript replay.
