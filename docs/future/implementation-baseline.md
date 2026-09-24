# Implementation baseline for the Future architecture

Status: **IMPLEMENTED REALITY**, audited on branch `codex/v0.1.3-platform-completion-20260922` at `ecbb3c50603bb65d603d2e006ec06140e56fd4b1` (A6), with A7.1 recorded below. This is the only Future document that states what exists today. Every other Future document states decisions, planned engineering or hypotheses and must defer to this record and to source. When source changes, the atom that changes it updates this file.

The [consolidation audit](../validation/v0.1.3-future-consolidation.md) records the commands, probe and evidence behind the findings below.

## Completed v0.1.3 atoms

A0–A6 and A7.1 are complete and are not redesigned by the new architecture. A0–A6 original atom specifications are preserved in git history at `ecbb3c5` (the previous text of [the v0.1.3 roadmap](09-v0.1.3-platform-completion.md)); their validation records remain the evidence:

| Atom | Result | Evidence |
| --- | --- | --- |
| A0 | Authority baseline | [A0](../validation/v0.1.3-a0-baseline.md) |
| A1 | Canonical interaction-round contract; one execution identity | [contract](../interaction-round.md) |
| A2 | Bounded Runtime-owned cognition loop; counters, cancellation, currentness and deadline fences | [A2](../validation/v0.1.3-a2-bounded-loop.md) |
| A3 | Normalized, **execution-local** capability request/observation evidence (not a durable journal) | [A3](../validation/v0.1.3-a3-execution-evidence.md) |
| A4 | One canonical semantic-context assembly with intentional Chat/Character/Cognition projections | [A4](../validation/v0.1.3-a4-canonical-context.md) |
| A5 | Stable-prefix metadata and volatile speaker placement (not a remote cache-hit guarantee) | [A5](../validation/v0.1.3-a5-stable-prefix.md) |
| A6 | Composition-trusted plugin discovery/load/start/stop/dispose lifecycle; inert declarations; **not a sandbox** | [A6](../validation/v0.1.3-a6-plugin-lifecycle.md) |
| A7.1 | Versioned host-owned executable registry and effect contracts; current `read_text_file` binding only | [A7.1](../validation/v0.1.3-a7.1-executable-registry.md) |

Pre-v0.1.3 closures (P8-1F, Character ABI/Harness, bounded Cognition, Phase 7 embodied agency, Campaigns A–I, Linux release gate) remain historical evidence in this directory; their status claims are not re-derived here.

## Current owners that the architecture preserves

| Meaning | Current owner in source |
| --- | --- |
| Turn admission, execution, cancellation, publication | `packages/core` Runtime orchestrator |
| Executable capabilities | A7.1 validated server registry; only `read_text_file` is bound (`apps/server/src/mcp-capability-binding.ts`) |
| Plugin lifecycle | Server composition root, A6 host (`apps/server/src/plugin-lifecycle.ts`) |
| Proactive text | P6 `ProactiveDecisionProvider` is the sole `NO_OP`/`REQUEST_TEXT` gate. User priority, one-shot attempts, stale-callback fencing, no synthetic user message, no proactive Memory write and no proactive TTS/tool authority are frozen until an explicit atomic replacement |
| Long-term Memory | One active backend: legacy PostgreSQL Memory **or** Mem0. With Mem0 active, legacy extraction is skipped entirely (`MemoryService.extractCandidates`) |
| Person definitions | Controller product store (`apps/server/src/services/product-store.ts`) |
| Voice-to-Person binding | Explicit local-controller admission (`/voice-profiles/:id/person`), local acoustic match evidence |
| P8 identity/persona/relationship projection | Pure per-turn reconstruction; see [P8 ownership map](p8-ownership.md) |
| Processes | Desktop / Supervisor ownership chain |

## Reusable delivery machinery

The finalized-turn ingestion ledger (`packages/memory/src/finalized-ingestion-ledger.ts`, PostgreSQL) gives each child event a stable ID, payload digest and backend idempotency key, uses versioned lease claims, and persists `dispatch_started_at` **before** calling `writeEventIdempotent` (`finalized-ingestion-executor.ts`). An expired lease after dispatch start moves the event to `reconcile_required` with result `ambiguous`; it is not blindly resent. A provider without `writeEventIdempotent`, or an event without a payload digest, is definitively rejected rather than written unsafely. Dream delivery (`dream-delivery.ts`) uses the same keyed write plus `reconcileEvent` pattern. Mem0 writes use `infer: false`, so Mem0 does not run its own LLM ADD/UPDATE/DELETE over YUVI's payloads. The canonical Memory event ID and the Mem0 backend ID are not journal receipt IDs.

This is the local precedent for A9's INTENT → ATTEMPT → OUTCOME protocol. A9 reuses it; it does not add a second retry or reconciliation engine for Memory delivery.

## Retention reality

- Conversation persistence stores normalized text turns. Raw vision input is not written to Memory: visually grounded turns are marked `memoryEphemeral` in the Runtime orchestrator, and some internal paths run with `writeMemory: false`.
- Voice audio is **not** fully ephemeral. `apps/server/src/services/voice-review.ts` retains a bounded private review buffer: at most 30 single-speaker mono PCM16 samples of at most about 8 seconds each, written only when the local acoustic contract proposes review material. This supports controller review of voice bindings. It is not a general audio archive and is not journal evidence.
- Consequently no current path supports exact replay of raw perception. The architecture must not claim it, and the journal must not start retaining raw media by default.

## Verified defects and gaps

1. **Legacy LLM extractor attribution defect (real, reproduced).** In `packages/memory/src/extractor.ts`, every accepted LLM candidate gets `originRole: "user"`. A model-supplied `sourceTraceId`, `observedAt` and validity times override the authority-supplied values. In `provenance.ts`, `inferOriginRole` returns a declared `user` role without the fact-core check, and `extractEvidenceText` falls back to the whole user message. A deterministic stub reasoner that invented “User loves astronomy…” in reply to “The weather is nice today.” produced a **stored** `durable-core` semantic memory with `originRole: user`, the forged trace `forged-trace-999`, and `evidenceText` set to the unrelated message.
   - *Active only when* `MEMORY_BACKEND` selects legacy Memory (the default; unknown values also fall back to legacy) **and** `MEMORY_EXTRACTOR=llm`. Note that `parseMemoryExtractor` in `packages/config/src/index.ts` maps any non-empty unrecognized value to `llm`. The rule-based default and the Mem0 path do not run this extractor.
   - *Indirect P8 exposure.* P8 does not have a direct LLM writer (see below), but P8's per-turn projection reads long-term Memory. Such a row reaches P8 as `EXPLICIT_USER_ORIGINATED` evidence with `LIMITED` support through `memorySourceClass`. The defect therefore contaminates P8 through reads, not through a P8 write.
   - Repair: **A10.1** in [v0.1.3](09-v0.1.3-platform-completion.md).
2. **Controller profile write outside Runtime.** `apps/server/src/services/profile-evidence.ts` (called from `routes/product.ts`) writes an `EXTERNAL_CLAIM` from the local controller directly to the Memory provider with `writeEvent`. It has no Runtime admission, no idempotency key and no causal receipt, so a retried save can duplicate the claim. Repair: **A10.2**.
3. **No causal journal.** Conversation persistence, Runtime events, A3 execution-local evidence and the Memory ledgers are partial records. Nothing today connects receipt → context → cognition → intent → attempt → outcome durably across restart. Repair: A8–A10.
4. **No durable external-effect accounting.** Provider calls, streaming publication, TTS/presentation, capability calls and Memory delivery each have their own fencing, but only Memory delivery persists an attempt before effect. A7.1 adds validated registry metadata; durable intent/attempt/outcome accounting remains A8–A9 work.
5. **No QQ, Snowluma or OneBot code exists.** A12 starts from an empty adapter.

## P8 authority finding

No LLM, provider, cognition or character output path writes P8 identity or relationship state:

- Authored identity/persona comes from code constants (`production-invariants.ts`).
- Relationship context is a read-only interpretation reconstructed each turn.
- The only persistent P8 write is `appendP8Correction`. It is reachable only through `POST /p8/corrections` behind local dashboard access, and it rejects any provenance other than `EXPLICIT_USER_CORRECTION` (`correction.ts`).
- Assistant-generated evidence is classified `ASSISTANT_MODEL_GENERATED`/`NON_AUTHORITATIVE`, and identity resolution discards `ASSISTANT_INFERENCE`.

This is preserved rather than rewritten. The [P8 ownership map](p8-ownership.md) records the details and migration conditions.
