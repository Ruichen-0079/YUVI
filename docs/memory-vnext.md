# Memory vNext

Status: **implemented vertical slice** on current Runtime/PromptBuilder.
Canonical MemoryEvent, MemoryProvider, P8, and finalized-ingestion contracts
remain authoritative. This document records the open-source bakeoff and the
Yuvi-native hierarchical context that was actually landed.

Baseline SHA at implementation start: `198534f67368f1eb6a75a1df49ad2a5b551bb40c`.

## Bakeoff

Criteria: maintenance, license, language fit, local-model support, embedding
independence, database assumptions, incremental ingestion, provenance,
temporal metadata, mixed Chinese/English, technical exact-match, latency,
token reduction, operational complexity, reuse of PostgreSQL/Mem0, migration
risk.

| System                                  | Decision                            | Evidence                                                                                                                                                                                                                               |
| --------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RecMem                                  | **ADAPT_ALGORITHM**                 | Recurrence-triggered consolidation is the right _when_, not a second store. Python research code is not the Yuvi authority. Buffer raw/recent evidence cheaply; invoke extraction only on recurrence/salience/idle.                    |
| memU                                    | **ADAPT_ALGORITHM / REJECT import** | Hierarchical Resource→Item→Category and proactive retrieval are useful ideas. Importing memU would add a second memory service, filesystem-as-memory orchestration, and agent-driven writes. Yuvi already has MemoryProvider + ledger. |
| Mem0 current OSS (`mem0ai==2.2.1`)    | **KEEP as L2 derived store**        | Already integrated. Do not replace Yuvi contracts.                                                                                                                                                                                     |
| Mem0 v3 / Dream / ADD-only algorithm    | **REJECT as authority**             | ADD-only plus first-class agent-generated facts conflict with correction/supersession and assistant non-authority. Platform Dream is not OSS. Keep Mem0 as a derived semantic backend.                                                 |
| LLMLingua / LongLLMLingua / LLMLingua-2 | **OPTIONAL_OPTIMIZER**              | Token pruning can delete `UNKNOWN`/`UNAVAILABLE`/P8/correction markers and compete for local GPU. Yuvi-native structured compression is default. A later optimizer may compress only L1 detail / old DirectContext behind a flag.      |
| HyperMem / Zep / Graphiti / MemOS       | **REJECT**                          | Graph/OS frameworks become a second storage or orchestration authority. No measured benefit over PostgreSQL + Yuvi ranking.                                                                                                            |

No library was adopted as Memory authority.

## Architecture

```text
L0 working context     = DirectContext / near-verbatim recent completed turns
L1 recent episodic     = durable/reconstructable narrative episodes (hours/days)
L2 long-term evidence  = existing MemoryEvent / MemoryProvider / MemoryService

Dream                  = recurrence/salience/explicit consolidation into L2 write events
Associative intrusion  = bounded context-triggered recall (not permission to speak)
Compression            = IMPLEMENTED_PRIMITIVE_NOT_RUNTIME_ACTIVE
Thin temporal          = elapsed/age/occurredAt vs recordedAt projection
```

External algorithms may score, cluster, or compress. They may not reinterpret
empty vs unavailable vs error, invent timestamps, upgrade confidence because
something repeated, or treat assistant prose as user truth.

## L0 / L1 / L2

- L0 is unchanged DirectContext, still not long-term Memory.
- L1 groups completed conversation turns by session and a 30-minute gap
  under one stable logical episode id (`episode:<sessionId>:<firstTurnId>`).
  Later messages in the same gap update that episode; they do not create a
  second recurrence observation. User-grounded fields are searchable evidence.
  Assistant output is stored as non-authoritative continuity and is labeled
  `Assistant previously said (non-authoritative, not evidence)` in the
  Character-facing projection. Retention is seven days with rollover. Restart
  reconstructs from `conversation_messages` and upserts by logical episode id.
- L2 is existing durable evidence. Dream may propose additional
  `MemoryWriteEventInput` values.

## Dream

Triggers that are actually wired: recurrence of user-grounded statements with
non-overlapping `sourceTurnIds`, explicit importance, and salience. Idle and
scheduled maintenance exist as engine kinds only; production Runtime does not
currently supply idle semantics, so idle Dream is **deferred**.

Delivery authority is `MemoryProvider.writeEventIdempotent` plus
`MemoryProvider.reconcileEvent` (the same primitives as finalized C1
delivery). Keys are `yuvi:dream-job:<jobId>:event:<payloadDigest>`. Dream
does not call `writeEvent`. `reconcile_required` is not due work and is never
auto-retried. An explicit `reconcileJob()` path may rewrite only after
`reconcileEvent` returns `not_applied`. Jobs are claimed atomically
(`FOR UPDATE SKIP LOCKED` in PostgreSQL; serialized claim in memory). Missing
writer/provider skips the job without marking L1 episodes consolidated.

“Dream” is a product metaphor. It does not simulate hidden experiences.

## Associative intrusion

Cheap lexical/technical activation over L1 and usable L2. Cooldown prevents
one intrusion per turn unless the score is high. Stale items decay in rank.
Character-facing text strips provider/database identifiers. This is context,
not a speak gate.

## Compression and temporal projection

`compressHierarchicalContext()` is implemented as a primitive and is
**not** wired into the live Runtime/Character prompt
(`IMPLEMENTED_PRIMITIVE_NOT_RUNTIME_ACTIVE`). No TTFT claim is made.

Thin temporal projection excludes the current user turn when computing
`lastInteractionAt`, so a long gap is not collapsed to ~0.

Thin temporal projection adds current local time, elapsed gap, age bands,
and occurredAt vs recordedAt when known. Missing timestamps stay unknown.
No off-screen life, no relationship progression from elapsed time, no full
Temporal or Continuity subsystems.

## Database

Migration `012_memory_vnext_v1.sql` adds `recent_episodes` and `dream_jobs`.
These are Yuvi-owned ledgers, not a second MemoryEvent store.
