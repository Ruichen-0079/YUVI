# Memory, lineage and reconstruction

Status: **PRODUCTION ARCHITECTURE DECISION** for future ownership; **IMPLEMENTED REALITY** for the existing mechanisms identified here; aggregate A10.1 remains **PLANNED / INCOMPLETE**, with A10.1a and A10.1b implemented.

Memory is a replaceable set of evidence indexes, retrieval/ranking policies, compaction and retention views. The planned journal owns original causal evidence; Memory does not become world truth, disposition state, obligation state or identity authority. Mem0 can propose/index normalized material, but neither its extraction nor mutable search results may silently become canonical history. All provider requests and Memory writes remain behind existing contracts.

## Assets to reuse

The current finalized-turn ingestion ledger already gives parent turns and child events stable identities, payload keys, versioned claims/leases, dispatch-start persistence and ambiguous-delivery reconciliation. Its executor calls `writeEventIdempotent` and refuses unsafe blind delivery recovery. Dream delivery also uses keyed writes and reconciliation. These are downstream delivery assets; A9 does not replace them with another retry engine. Journal intents link to their stable child keys; each delivery still has one active executor.

The Mem0 provider sends normalized writes with `infer: false`. Its canonical Memory event ID and backend ID are not journal receipt IDs. The local controller evidence provider separately preserves trusted voice-binding evidence. Legacy Memory and Mem0 have distinct active paths; architecture must test both, not infer safety of one from tests of the other.

Before A10.1a, the optional legacy `LlmMemoryExtractor` could force generated candidates to `originRole: user`, accept model `sourceTraceId` and model clocks, and let provenance enrichment attach unrelated user text as `evidenceText`. The deterministic weather-to-astronomy probe stored an unsupported generated preference as durable legacy Memory with a forged trace ([baseline](implementation-baseline.md#verified-defects-and-gaps)). **A10.1a closes this extractor path:** when `MEMORY_EXTRACTOR=llm`, the reasoning provider is not invoked; only the existing rule-based extractor supplies candidates, and status reports `unsupported-grounding`. Unknown values reject through shared parsing, server boot and runtime reload. Mem0 continues to skip legacy extraction. This does not ground other legacy/finalized/dream writes; A10.1b carries conversation ancestry, while A10.1c–f remain planned.

P8 qualification: the reproduced row could contaminate legacy Memory prompt retrieval. Current legacy mode has no semantic `MemoryProvider`, so that exact row is not directly passed into Runtime P8 reconstruction as a semantic `MemoryEvent`; Runtime receives an unavailable semantic Memory outcome. If future code exposes generated or lineage-bearing Memory to P8, model-owned `originRole: user` metadata alone must not authenticate it or make it verified user evidence.

A10.1b now stores the exact host-derived `JournalEventRef` on each newly admitted conversational or finalized-speech user message in the durable conversation repository. The reference is separate from Runtime event/trace IDs, `sourceUserEventId`, speech observation IDs and Memory/backend IDs. Legacy messages remain null; no receipt is guessed from text. This ancestry seam does not itself ground Memory: A10.1c must resolve the committed parent and validate eligible selectors before new legacy evidence-backed writes.

## Consumer contract

Every future evidence-backed write carries committed parent IDs and selectors, source/subject/audience/binding scope, producer and policy version, an immutable consumer key and payload identity. The owner validates those fields outside the model output. An index row without valid lineage is unavailable for authoritative use. Unverifiable generated content may be kept as labeled generated output where retention permits, never relabeled user evidence.

A consumer uses a durable checkpoint, idempotent output key and compare-and-set version. If its store is separate, no distributed atomicity is invented: commit derivation and delivery intent locally, then use the existing keyed delivery/reconcile mechanism. Duplicate processing produces the same logical child; a changed derivation version produces a new child with explicit supersession. Sidecar outage is degraded retrieval, not permission to fabricate a memory or mark delivery complete.

Memory extraction may propose statements only from eligible committed source selectors; model output cannot provide authoritative event IDs, clock values, principal or scope. A10.1a now fails closed on the optional legacy LLM candidate path while preserving rule-based extraction; A10.1b preserves the committed source reference on conversation rows, but neither is structural Memory grounding. A10.1c and later consumers must resolve and validate source selectors before admission. A scoped, auditable bounded extractor can be introduced later through the measurement gates. Explicit controller claims still need committed control receipts; `profile-evidence.ts` currently writes directly to the Memory provider, without Runtime admission or an idempotency key, and must be routed through Runtime control admission by A10.2.

## Context as a consumer

A4 continues to assemble IDENTITY, PERSONA, RELATIONSHIP_CONTEXT, RECENT_CONVERSATION, MEMORY_EVIDENCE, TEMPORAL_CONTEXT and CURRENT_SITUATION into one canonical snapshot with intentional Chat/Character/Cognition projections. A5 content stability is metadata, not a provider cache guarantee. The assembler cannot become a second Memory or P8 writer.

A context-use manifest records the exact selected evidence/projection IDs and versions, binding and disclosure decision, known excluded candidates/reasons, provider/model/prompt versions, truncation/order/token budget and payload availability. It distinguishes retrieval candidates from what was actually exposed to the model. A reference to a mutable Mem0 search or “latest profile” is not reconstruction. Persist authorized normalized input/output evidence rather than hidden reasoning. Replay reconstructs views and reducers without calling live tools or claiming nondeterministic model output will repeat bit-for-bit.

## Corrections and legacy data

AMENDMENT triggers a lineage worklist: locate descendants, mark invalid/stale, withdraw affected indexes and caches, recompute eligible derivations under a declared version, then publish replacement projections atomically. While correction is pending, affected material is unavailable for authoritative context. A failed consumer remains visibly behind its checkpoint; unrelated branches remain valid. Correcting one receipt must not silently erase a genuine later independent observation.

Old rows have incomplete lineage. Import them with an explicit legacy/import producer, import time, retained original timestamps marked source-reported, and declared gaps. Do not fabricate original journal receipts or historical audiences. They may remain available under existing conservative retrieval policy, but cannot count as independent measured support or authenticated identity merely because they were imported. Compatibility adapters are scoped and temporary; new writes cannot use a blanket legacy exception.

The journal, Memory and correction owners have one-way responsibilities: journal records events and amendments; Memory updates its derived views; P8/prospective/integrator owners update their meanings. An amendment does not itself install a second state reducer inside the journal. [P8 ownership](p8-ownership.md) specifies atomic cutover rules.
