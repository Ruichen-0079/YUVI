# Authority and execution boundaries

Status: **PRODUCTION ARCHITECTURE DECISION**. The A8.1 protocol contract and A8.2a PostgreSQL append store are **IMPLEMENTED REALITY**; production ingress admission remains **PLANNED ENGINEERING**. Existing owners are recorded in [implementation baseline](implementation-baseline.md). One meaning has one active committing owner in a deployment epoch. A storage writer is not automatically an authority over the meaning it stores.

| Meaning | Current / preserved owner | Planned boundary |
| --- | --- | --- |
| Turn admission, execution, cancellation, capability permission, publication | Runtime | Runtime admits journal commands through one append gate; transport cannot commit independently |
| Normalized receipt and execution evidence | Conversation persistence, Runtime events and specialized ledgers presently cover parts | Journal append authority records what was observed/committed; never decides world truth |
| Journal command/envelope schema and structural validation | `packages/protocol/src/life-event-journal.ts`; A8.2a `packages/journal/src/index.ts` validates and commits envelopes in PostgreSQL | A8.2b–f ingress adapters resolve actual source identity and admit production receipts; A8.2a storage does not authenticate transports |
| A1/A2 reasoning round | Runtime owns execution ID, counters, currentness, deadline | Cognition proposes; registry validates; Runtime commits permitted intent |
| Character expression | Character produces bounded outcomes; Runtime consumes them | Character may express a projection; expression cannot write that projection |
| Capability availability and implementation | A7.1 host registry binds `read_text_file`; A7.2 composition-root policy grants only fixed local transforms to exact plugin/version identities | Runtime admits each call; future effect dispatch remains behind A9.2 |
| Plugin lifecycle | Server composition root's A6 lifecycle host owns A7.2 per-instance registration scopes | Plugin handles can fill only host-approved slots; no injected Runtime, Memory, provider or database authority |
| Claims, evidence retrieval and indexing | Memory policies, providers, repository | Memory consumes committed receipts/derivations; Mem0 is a replaceable index |
| Person definitions and authenticated bindings | Local controller product store and explicit identity/voice admission | Governed identity owner, journaled control receipts; language cannot bind accounts |
| P8 authored identity/persona, corrections and projections | Authored production invariants, explicit correction store, pure P8 reconstruction | Preserve until per-field atomic migration in [ownership map](p8-ownership.md) |
| Canonical semantic context | A4 assembler and supplying domain owners | Context records a use manifest; providers only serialize their view |
| Future prospective items | Not yet implemented | Runtime prospective service alone commits typed obligations and closure |
| Future durable evidence-derived projections | Not yet implemented | Versioned deterministic/governed integrator alone commits bounded updates |
| Future learned selection parameters | No current owner | Optional, versioned research artifact; no facts, bindings, obligations or charter authority |
| Charter and permissions | Authored/governed policy | Experience may not silently weaken normative constraints |
| Application processes | Desktop / Supervisor ownership chain | Runtime owns semantics, Supervisor owns processes; plugins own neither |

A model can propose an action, label an authorized evidence window, suggest a correction or express an interpretation. It cannot commit a scalar relationship state, choose its own evidence eligibility, authenticate a principal, grant a plugin permission or rewrite policy. A validated model output remains a measurement with an error model, not an authoritative fact. A8.1 validates producer commands against a separately supplied authority snapshot; A8.2a's host-configured append authority assigns event identity, namespace, recorded time and serialized commit sequence. Neither authenticates production transports or admits production input into Runtime.

A database transaction enforces a durable commit; it does not turn a claim into truth. Conversely, passing through Runtime does not by itself make an unsafe command valid. The planned A8.2b–f admission seams must check available principal, scope, audience, parent evidence, current execution, effect contract, policy version and any applicable source identity before production input is accepted.

## Capability contract

A7 adds independent dimensions, not one overloaded READ_ONLY/EXTERNAL/SELF_MUTATING enum:

- `action_kind`: query, transform, deliver, mutate or actuate; `effect_locus`: process, local durable store, remote service or physical world.
- `reversibility`: reversible, compensatable, irreversible or unknown; permission and data-disclosure class are independent. A remote read may disclose input and spend quota.
- `idempotency`: none or adapter-certified key semantics, including namespace, payload equality and retention window. Reversibility does not imply idempotency.
- `reconciliation`: unsupported or a versioned lookup contract with the evidence it can establish. Transport accepted, remotely persisted, device presented and human acknowledged are different observations.
- Input/output schema versions, authenticated principal requirements, audience restrictions, timeout/cancellation behavior, provider/binding version, and restart/retry policy.

Missing effect semantics fails closed at registration. Cognition sees only approved semantic capability references, never raw provider tools discovered outside the allowlist. A7 replaces the narrow read-text special case incrementally; it does not give plugins a second execution loop. Read-only local capabilities still have intents and attempts when invoked as Runtime actions. Internal pure calculations need derivation lineage, not fictitious external delivery.

A7.1 implements versioned descriptors and host-owned effect contracts for the current executable registry. A7.2 adds a separately host-issued, versioned grant for a local in-process transform; its permission, PROCESS locus, disclosure, reversibility, idempotency and reconciliation fields are fixed by host policy. Plugin declarations cannot create grants. Cognition sees only semantic reference/description pairs, and Core Runtime admits every invocation before the lifecycle-owned handler runs. The existing `read_text_file` path is unchanged. No remote, durable-store or physical-world plugin effect is granted or dispatched.

A6/A7.2 remain an in-process, composition-trusted plugin model, **not a sandbox against malicious JavaScript imports**. The supported lifecycle API exposes only the manifest, cancellation signal and grant-specific registration handles; tests verify it does not expose Runtime, Memory, provider or database objects. This constrains the supported dependency surface but cannot stop trusted composition code from importing arbitrary modules. Untrusted executable plugins require a later process/security design.

## Runtime, providers and lifecycle

Preserve A1–A5 execution fences, monotonic process-local deadlines, bounded counters, normalized evidence and context projections. Persisted intent IDs survive restarts; A2 execution IDs and deadlines do not resume. A replacement turn cannot be revived by a late provider result. Late delivery evidence is still journaled as an observation without authorizing a stale reply.

At shutdown, A7.2 revokes plugin capability ingress before draining admitted calls, then stops/disposes implementations in reverse lifecycle order. The in-process drain is bounded for the server close hook; if a call outlives its deadline, the lifecycle reports `DRAINING`, retains the implementation and defers stop/dispose until it settles. This unresolved state is only in memory: process termination can lose it, and A7.2 claims no crash recovery. A9.2 is still required before durable attempt accounting or external plugin dispatch. Existing Runtime Memory-write drain and store close ordering follows plugin shutdown.

Existing provider-facing interfaces remain in core; vendor clients stay in providers. Existing Desktop/Supervisor process ownership and packaged Linux lifecycle remain intact. Neither journal nor scheduler introduces another process owner. [Embodiment](embodiment.md) covers presentation and local actuator safety.
