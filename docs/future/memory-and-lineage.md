# Memory, lineage and reconstruction

Status: **PRODUCTION ARCHITECTURE DECISION** for future ownership; **IMPLEMENTED REALITY** for the existing mechanisms identified here; A10 is **PLANNED ENGINEERING**.

Memory is a replaceable set of evidence indexes, retrieval/ranking policies, compaction and retention views. The planned journal owns original causal evidence; Memory does not become world truth, disposition state, obligation state or identity authority. Mem0 can propose/index normalized material, but neither its extraction nor mutable search results may silently become canonical history. All provider requests and Memory writes remain behind existing contracts.

## Assets to reuse

The current finalized-turn ingestion ledger already gives parent turns and child events stable identities, payload keys, versioned claims/leases, dispatch-start persistence and ambiguous-delivery reconciliation. Its executor calls `writeEventIdempotent` and refuses unsafe blind delivery recovery. Dream delivery also uses keyed writes and reconciliation. These are downstream delivery assets; A9 does not replace them with another retry engine. Journal intents link to their stable child keys; each delivery still has one active executor.

The Mem0 provider sends normalized writes with `infer: false`. Its canonical Memory event ID and backend ID are not journal receipt IDs. The local controller evidence provider separately preserves trusted voice-binding evidence. Legacy Memory and Mem0 have distinct active paths; architecture must test both, not infer safety of one from tests of the other.

The optional legacy `LlmMemoryExtractor` has a real attribution defect at the audited baseline. Its accepted candidates are forced to `originRole: user`. A model-supplied `sourceTraceId` and `observedAt`/validity times override the authority-supplied values. Provenance enrichment trusts the declared role and can attach an unrelated user message as `evidenceText`. A deterministic stub probe stored an unsupported generated preference as `durable-core` Memory with a forged trace ([baseline](implementation-baseline.md#verified-defects-and-gaps)). The path is active with the legacy backend (the default) and `MEMORY_EXTRACTOR=llm`, which any unrecognized non-empty value also selects. It is not a direct P8 state writer, but P8's per-turn projection reads such rows as user-originated evidence. It does not characterize the rule-based default or the Mem0 path, which skips legacy extraction. **A10.1 must structurally gate this path before journal-backed consumers are enabled.** Prompt instructions, confidence thresholds and substring heuristics are insufficient. See the [audit](../validation/v0.1.3-future-consolidation.md).

## Consumer contract

Every future evidence-backed write carries committed parent IDs and selectors, source/subject/audience/binding scope, producer and policy version, an immutable consumer key and payload identity. The owner validates those fields outside the model output. An index row without valid lineage is unavailable for authoritative use. Unverifiable generated content may be kept as labeled generated output where retention permits, never relabeled user evidence.

A consumer uses a durable checkpoint, idempotent output key and compare-and-set version. If its store is separate, no distributed atomicity is invented: commit derivation and delivery intent locally, then use the existing keyed delivery/reconcile mechanism. Duplicate processing produces the same logical child; a changed derivation version produces a new child with explicit supersession. Sidecar outage is degraded retrieval, not permission to fabricate a memory or mark delivery complete.

Memory extraction may propose statements only from eligible committed source selectors; model output cannot provide authoritative event IDs, clock values, principal or scope. A10 may fail closed by disabling unsupported legacy LLM candidate admission while preserving its explicit fallback/default, rather than inventing a weak “semantic match” validator. A scoped, auditable bounded extractor can be introduced later through the measurement gates. Explicit controller claims still need committed control receipts; `profile-evidence.ts` currently writes directly to the Memory provider, without Runtime admission or an idempotency key, and must be routed through Runtime control admission by A10.2.

## Context as a consumer

A4 continues to assemble IDENTITY, PERSONA, RELATIONSHIP_CONTEXT, RECENT_CONVERSATION, MEMORY_EVIDENCE, TEMPORAL_CONTEXT and CURRENT_SITUATION into one canonical snapshot with intentional Chat/Character/Cognition projections. A5 content stability is metadata, not a provider cache guarantee. The assembler cannot become a second Memory or P8 writer.

A context-use manifest records the exact selected evidence/projection IDs and versions, binding and disclosure decision, known excluded candidates/reasons, provider/model/prompt versions, truncation/order/token budget and payload availability. It distinguishes retrieval candidates from what was actually exposed to the model. A reference to a mutable Mem0 search or “latest profile” is not reconstruction. Persist authorized normalized input/output evidence rather than hidden reasoning. Replay reconstructs views and reducers without calling live tools or claiming nondeterministic model output will repeat bit-for-bit.

## Corrections and legacy data

AMENDMENT triggers a lineage worklist: locate descendants, mark invalid/stale, withdraw affected indexes and caches, recompute eligible derivations under a declared version, then publish replacement projections atomically. While correction is pending, affected material is unavailable for authoritative context. A failed consumer remains visibly behind its checkpoint; unrelated branches remain valid. Correcting one receipt must not silently erase a genuine later independent observation.

Old rows have incomplete lineage. Import them with an explicit legacy/import producer, import time, retained original timestamps marked source-reported, and declared gaps. Do not fabricate original journal receipts or historical audiences. They may remain available under existing conservative retrieval policy, but cannot count as independent measured support or authenticated identity merely because they were imported. Compatibility adapters are scoped and temporary; new writes cannot use a blanket legacy exception.

The journal, Memory and correction owners have one-way responsibilities: journal records events and amendments; Memory updates its derived views; P8/prospective/integrator owners update their meanings. An amendment does not itself install a second state reducer inside the journal. [P8 ownership](p8-ownership.md) specifies atomic cutover rules.
