# Authority and execution boundaries

Status: **PRODUCTION ARCHITECTURE DECISION**. Journal-mediated authority is **PLANNED ENGINEERING**; existing owners are recorded in [implementation baseline](implementation-baseline.md). One meaning has one active committing owner in a deployment epoch. A storage writer is not automatically an authority over the meaning it stores.

| Meaning | Current / preserved owner | Planned boundary |
| --- | --- | --- |
| Turn admission, execution, cancellation, capability permission, publication | Runtime | Runtime admits journal commands through one append gate; transport cannot commit independently |
| Normalized receipt and execution evidence | Conversation persistence, Runtime events and specialized ledgers presently cover parts | Journal append authority records what was observed/committed; never decides world truth |
| A1/A2 reasoning round | Runtime owns execution ID, counters, currentness, deadline | Cognition proposes; registry validates; Runtime commits permitted intent |
| Character expression | Character produces bounded outcomes; Runtime consumes them | Character may express a projection; expression cannot write that projection |
| Capability availability and implementation | A7.1 validated host-owned executable registry; only `read_text_file` is bound | A7.2 narrow plugin registration; discovery only subtracts from approved availability |
| Plugin lifecycle | Server composition root's A6 host | Registration through narrow handles; no injected Runtime or database authority |
| Claims, evidence retrieval and indexing | Memory policies, providers, repository | Memory consumes committed receipts/derivations; Mem0 is a replaceable index |
| Person definitions and authenticated bindings | Local controller product store and explicit identity/voice admission | Governed identity owner, journaled control receipts; language cannot bind accounts |
| P8 authored identity/persona, corrections and projections | Authored production invariants, explicit correction store, pure P8 reconstruction | Preserve until per-field atomic migration in [ownership map](p8-ownership.md) |
| Canonical semantic context | A4 assembler and supplying domain owners | Context records a use manifest; providers only serialize their view |
| Future prospective items | Not yet implemented | Runtime prospective service alone commits typed obligations and closure |
| Future durable evidence-derived projections | Not yet implemented | Versioned deterministic/governed integrator alone commits bounded updates |
| Future learned selection parameters | No current owner | Optional, versioned research artifact; no facts, bindings, obligations or charter authority |
| Charter and permissions | Authored/governed policy | Experience may not silently weaken normative constraints |
| Application processes | Desktop / Supervisor ownership chain | Runtime owns semantics, Supervisor owns processes; plugins own neither |

A model can propose an action, label an authorized evidence window, suggest a correction or express an interpretation. It cannot commit a scalar relationship state, choose its own evidence eligibility, authenticate a principal, grant a plugin permission or rewrite policy. A validated model output remains a measurement with an error model, not an authoritative fact.

A database transaction enforces a durable commit; it does not turn a claim into truth. Conversely, passing through Runtime does not by itself make an unsafe command valid. Admission checks principal, scope, audience, parent evidence, current execution, effect contract, policy version and idempotency identity before the journal gate accepts it.

## Capability contract

A7 adds independent dimensions, not one overloaded READ_ONLY/EXTERNAL/SELF_MUTATING enum:

- `action_kind`: query, transform, deliver, mutate or actuate; `effect_locus`: process, local durable store, remote service or physical world.
- `reversibility`: reversible, compensatable, irreversible or unknown; permission and data-disclosure class are independent. A remote read may disclose input and spend quota.
- `idempotency`: none or adapter-certified key semantics, including namespace, payload equality and retention window. Reversibility does not imply idempotency.
- `reconciliation`: unsupported or a versioned lookup contract with the evidence it can establish. Transport accepted, remotely persisted, device presented and human acknowledged are different observations.
- Input/output schema versions, authenticated principal requirements, audience restrictions, timeout/cancellation behavior, provider/binding version, and restart/retry policy.

Missing effect semantics fails closed at registration. Cognition sees only approved semantic capability references, never raw provider tools discovered outside the allowlist. A7 replaces the narrow read-text special case incrementally; it does not give plugins a second execution loop. Read-only local capabilities still have intents and attempts when invoked as Runtime actions. Internal pure calculations need derivation lineage, not fictitious external delivery.

A7.1 implements versioned descriptors and host-owned effect contracts for the current executable registry. The only bound implementation remains the existing `read_text_file` path; discovery cannot register implementations, and no external-effect executor is enabled.

A6 is an in-process, composition-trusted lifecycle boundary, **not a sandbox against malicious JavaScript**. Narrow dependency injection and import-boundary checks prevent ordinary bypasses; untrusted executable plugins require a later process/security design. No document claims A7 makes hostile in-process code safe.

## Runtime, providers and lifecycle

Preserve A1–A5 execution fences, monotonic process-local deadlines, bounded counters, normalized evidence and context projections. Persisted intent IDs survive restarts; A2 execution IDs and deadlines do not resume. A replacement turn cannot be revived by a late provider result. Late delivery evidence is still journaled as an observation without authorizing a stale reply.

At shutdown, stop ingress and new admissions, revoke new registrations, seal dispatch, drain or durably classify in-flight attempts while executors remain available, then stop/dispose plugin implementations and close stores. A6 currently stops lifecycle-only plugins before existing Runtime drain; A7/A9 must extend that order for executable plugins. Preserve reverse lifecycle cleanup and bounded shutdown; do not unload a delivery implementation before its evidence is settled or marked unknown. Forced termination cannot promise completed drain and is covered by restart recovery.

Existing provider-facing interfaces remain in core; vendor clients stay in providers. Existing Desktop/Supervisor process ownership and packaged Linux lifecycle remain intact. Neither journal nor scheduler introduces another process owner. [Embodiment](embodiment.md) covers presentation and local actuator safety.
