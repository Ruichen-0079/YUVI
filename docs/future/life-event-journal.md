# Life-event journal and external effects

Status: **PRODUCTION ARCHITECTURE DECISION**. A8.1's versioned command/envelope contract and structural validation are **IMPLEMENTED REALITY**; durable journal implementation remains **PLANNED ENGINEERING**, A8.2–A10. Existing conversation, Memory and delivery records are partial foundations, not this completed journal. See the [A8.1 validation record](../validation/v0.1.3-a8.1-journal-contract.md).

The journal is authoritative evidence of what YUVI received, committed, attempted and observed. It is **not authoritative world truth**. A receipt of “I repaid you” proves receipt of that assertion, not repayment. An extraction can faithfully quote a false assertion. An attempted delivery is not a delivered message. A downstream index row is not an original receipt.

## Envelope and ordering

Every committed event has the following versioned envelope. Producer-supplied values are validated; authority-controlled values cannot be overridden by model output or plugin metadata.

| Field | Contract |
| --- | --- |
| `schema_version`, `event_id` | Validated version and opaque immutable identity; unique within the journal namespace |
| `journal_id`, `commit_seq` | Durable journal namespace and total commit order assigned by the append gate, not occurrence order |
| `recorded_at` | Store-assigned wall time of recording, useful operationally but not ordering authority |
| `occurred_at`, `clock_source`, `time_uncertainty` | Source-reported occurrence interval/time, source clock identity and uncertainty; may be unknown, skewed or out of order |
| `kind` | RECEIPT, INTENT, ATTEMPT, OUTCOME, DECISION, DERIVATION or AMENDMENT |
| `surface`, `channel` | Versioned transport instance and channel kind / opaque channel reference; private/group/device are distinct |
| `principal_ref`, `subject_refs`, `binding_version` | Authenticated transport principal, explicitly attributed subjects, and identity mapping used; unresolved is a valid explicit state |
| `audience_snapshot_ref`, `disclosure_policy_ref` | Who could receive the original event, membership snapshot quality, and applicable disclosure policy; not a public-membership assumption |
| `causal_parent_ids`, `correlation` | Causal links and session/turn/A1 execution/A2 round/capability/prospective references as applicable; no fabricated A2 continuity after restart |
| `payload_refs`, `payload_state` | Scoped references and retained/redacted/not-retained/unavailable state, rather than mandatory inline personal content |
| `producer`, `producer_version`, `policy_version` | Responsible component and rule/schema versions; model/prompt/codebook versions when a model measured or generated content |
| `lineage` | Input event IDs, evidence selectors, source digest/version where permitted, derivation version and checkpoint; consumer output identity |
| `supersedes`, `amends` | Typed earlier references; append-only correction, with authorization and reason; no silent historical overwrite |

The A8.1 protocol contract separates producer commands from the committed envelope. It reserves event identity, namespace, principal/source attribution, surface/channel, correlations, policy/producer versions, `recorded_at` and `commit_seq` for a separate host authority snapshot and future append gate. It defines seven kind-specific command shapes and strict selectors; confirmed outcome predicates distinguish local result produced, service accepted, remote persisted, device presented, human acknowledged, delivery rejected and no effect established. The contract validates structure and selector boundaries, not whether a citation semantically proves a real-world claim.

`commit_seq` must reflect serialized commits within a journal; a database sequence allocated before transaction commit is insufficient. The planned store reuses the existing PostgreSQL migration/connection and bundled-runtime seams, with a journal append lock/CAS protocol and a transaction that commits envelope, intent uniqueness and outbox together where applicable. Gaps are allowed. Parent existence/scope and acyclicity are validated. Cross-journal imports retain external references and explicit unresolved/import status; there is no invented global total order. An in-memory test adapter does not satisfy durability or packaged deployment acceptance.

Wall clocks never determine causal precedence. A7/A8 schema tests include skew, identical timestamps, rollback, concurrent commits and imported histories. Replay consumes commit order plus explicit causality. Recorded historical deadlines are evidence; Runtime uses a new monotonic budget for each new execution.

## Kinds and evidence selectors

| Kind | Meaning / restriction |
| --- | --- |
| RECEIPT | An input or external observation was accepted, with transport identity and source provenance |
| INTENT | One authorized logical action, with immutable key, normalized payload identity, authority and effect contract |
| ATTEMPT | A particular dispatch may begin; committed before crossing the effect boundary |
| OUTCOME | Evidence about one attempt, with observation time, source and certainty level |
| DECISION | A policy/admission/selection choice and its available alternatives and pre-choice inputs; no hidden chain of thought required |
| DERIVATION | A versioned claim, annotation, projection, context manifest or index input derived from committed sources |
| AMENDMENT | Authorized correction, supersession, retraction, binding correction or redaction; descendants are invalidated/recomputed by their owners |

Selectors identify a text span in an immutable payload version, an audio time range/channel, an image/frame region with coordinates, a JSON pointer/structured field, or a specific tool-result fragment. A citation to a whole conversation when only one sentence supports a claim is insufficient. Selectors carry modality and bounds; a transcript and its audio are linked but do not become independent corroboration. Missing retained payload cannot be reconstructed from a model's plausible quotation.

Keep extraction fidelity separate from world credence. Fidelity asks whether the selector supports the attributed statement. Credence concerns the source's relation to the world, conflicts, verification and uncertainty. A high fidelity score for hearsay does not promote it to direct observation. Self-generated prose is evidence that YUVI said something; it is never evidence that YUVI has the described disposition.

## Intent, attempt, outcome and recovery

Exactly-once applies to **logical intent admission**, enforced by a durable unique `(authority_scope, logical_intent_key)` plus normalized payload digest/version. The same key and payload returns the existing intent; the same key with different payload conflicts. A caller cannot mint a new key merely to retry an uncertain send. A new, deliberately authorized action has a new identity and an explicit relationship to the earlier uncertain action.

Runtime atomically commits INTENT and outbox admission. The dispatcher claims eligible work using version/fencing checks, then commits ATTEMPT before invoking the adapter. OUTCOME is appended and dispatch state advanced transactionally. A worker lease is scheduling machinery, not proof that an earlier worker stopped. No second dispatcher may issue an unsupported duplicate after lease expiry; remote idempotency, effective execution fencing or reconciliation is required. Local locks alone cannot promise exactly-once remote effects.

| Crash / observation | Recovery rule |
| --- | --- |
| Before intent transaction commits | No admitted intent and no permitted effect; retry admission with the same logical key |
| Committed intent, no attempt | Eligible to dispatch after current policy/audience checks; intent may instead expire or be canceled |
| Committed attempt, crash before the call is known to start | May have dispatched; UNKNOWN unless durable evidence proves otherwise |
| Remote accepted, response lost | UNKNOWN; reconcile or use a certified idempotency key within its validity window |
| Response received, outcome not committed | Same ambiguity; never infer failure merely from missing local outcome |
| Durable positive evidence | Record exactly what was established, e.g. service accepted; do not upgrade to human read/physical success |
| Durable negative evidence of no effect | Retry only if contract and current authority permit; preserve attempt lineage |
| Cancellation/timeout after dispatch may begin | UNKNOWN unless outcome evidence establishes a narrower result; cancellation is not remote rollback |
| Restart / stale generation / expired lease | Preserve intent identity, fence stale publication, reconcile without resuming the old A2 loop |

Outcome certainty is `CONFIRMED_SUCCESS`, `CONFIRMED_FAILURE` or `UNKNOWN`, with a required predicate describing what “success” means for that adapter. Reconciliation is a **method** (`direct_response`, `remote_lookup`, `idempotency_receipt`, `controller_observation`), not a certainty status. Contradictory evidence appends a disputed/unknown interpretation with links; it never erases an earlier observation. A controller can choose to abandon an unknown intent but cannot retroactively prove it did not happen.

An ingress stable remote message ID is deduplicated only in its account/channel/adapter namespace. If an adapter has no stable ID, identical text is not proof of duplicate delivery: record uncertainty and distinct receipts, and prohibit automatic consequential duplication based on a guessed identity. A12 must discover these real limits.

## Coverage and retention

A9 covers existing tool calls, remote provider requests, message delivery, voice/presentation requests and streaming publication at their current authorized boundaries. A response may have one parent intent and component intents for distinct effects. Progressive visible chunks need durable sequence/payload references before publication; batching may reduce overhead but cannot publish ahead of its durable batch. Do not replay old text deltas, audio or gestures on restart. Record device reports only at the fidelity they establish; there is no requirement to log every animation frame. Journal append failure prevents new external effects and new evidence-backed writes, with a visible degraded state rather than a hidden volatile fallback.

Raw screenshots, ambient audio, credentials and private reasoning are not mandatory journal payloads. Preserve existing `memoryEphemeral`/`writeMemory=false` behavior. The existing bounded private voice-review buffer (at most 30 short single-speaker samples, kept for controller review of voice bindings) is a separate retention class. It is not journal evidence and is not a general audio archive; a receipt may reference a review sample only while that sample exists. A control receipt may retain only minimal metadata and a `not-retained` marker. Capability request payloads must be scrubbed before durable references are made. Membership lists and principal mappings are personal data too; use protected references and retention classes, not hashes of guessable PII as public identities.

Causal reconstruction always reports the known chain and gaps. Exact content reconstruction is possible only for authorized retained inputs; deliberately absent content remains unavailable and cannot support a later measurement requiring it. This is a necessary qualification of “full reconstruction,” not permission to invent missing evidence. Full deletion propagation/crypto-shredding is post-v0.1.3, but schema minimization, redaction states, access checks and no-secret logging are v0.1.3 requirements. [Privacy and research gates](research-methodology.md) forbid treating append-only storage as a retention exemption.
