# Phase 1 — P8 Identity, Persona, and Relationship

> **Status: CLOSED — P8 through P8-1F is implemented; later speculative extensions are GAP-DRIVEN.**

Current implementation is indexed in [the roadmap](README.md). Detailed phase plans below preserve historical design reasoning; they are not a new work queue.

## 1. Purpose

Establish a stable answer to “Who is Yuvi?” and a bounded,
evidence-grounded answer to “What is the relationship and background context
here?” This phase creates semantic authority for identity/persona/relationship
interpretation without turning Memory records, prompt sections, or model
self-report into truth.

## 2. Responsibility

P8 owns:

- stable Yuvi identity rules and explicit identity revisions;
- Yuvi-specific persona invariants that ordinary conversation cannot silently
  rewrite;
- interpretation of already-authorized Memory evidence about interaction
  history, communication preferences, relationship context, and background;
- explicit uncertainty, provenance, scope, and conflict in that interpretation;
- a compact P8 projection for the future Character ABI.

P8 does not reduce a relationship to an affinity, trust, intimacy, or mood
score. It may express qualitative, evidence-grounded context only when the
evidence supports it.

## P8-1A implementation boundary

P8-1A establishes only the smallest independent semantic authority for stable
identity and authored persona invariants. It is implemented in the tiny
`@companion/p8` package as plain immutable TypeScript data and one pure
projection constructor. The P8-1A contract has no Runtime, Memory,
PromptBuilder, provider, model, or platform semantics.

The implemented input is an explicitly supplied identity address plus a small
authored invariant set. The address keeps `characterInstanceId`,
`personaProfileId`, and an optional future `subjectScopeId` separate, so a
default instance/profile does not become a singleton assumption. The output is
a compact semantic projection with identity/persona status, authored
invariants, bounded authored provenance references, and a projection version.
It is not serialized into prompt sections.

P8-1A defines the complete epistemic vocabulary `KNOWN`, `UNKNOWN`,
`CONFLICTING`, `PARTIAL`, `EMPTY`, `UNAVAILABLE`, and `ERROR`. Authored-only
projection currently uses `KNOWN` when explicit invariants exist and `UNKNOWN`
when that target has no authored invariant. P8-1A performs no evidence query,
so it does not manufacture `EMPTY`: that state is reserved for a successful
evidence query that produced no relevant evidence. `UNAVAILABLE` and `ERROR`
are likewise reserved for later evidence-backed phases. These meanings must
not be collapsed: insufficient authoritative meaning, an empty successful
query, an unavailable source, and an error are different states.

The authored surface is intentionally tiny: stable character name or
description, an explicit identity boundary, and a semantically appropriate
user-controlled invariant. It does not encode learned behavior, wording,
warmth, brevity, jokes, teasing, sentence structure, or other Character Model
style. No relationship conclusion or relationship scalar is implemented.

P8-1A remains limited to authored identity/persona semantics. Memory-backed
evidence adaptation, recent-conversation integration, correction/revision
persistence, Character ABI integration, and all later P8 stages remain outside
P8-1A.

## P8-1B implementation boundary

P8-1B adds a provider- and backend-neutral semantic contract for evidence that
has already passed upstream authorization. It does not retrieve, filter, rank,
or persist evidence, and it does not import the Memory package. Each bounded
evidence atom preserves its source class, channel, qualitative support, opaque
scope reference, supplied source time when present, contradiction references,
and evidence provenance. `LONG_TERM_EVIDENCE` and `RECENT_CONVERSATION` remain
distinct inputs; recent conversation is not thereby made durable Memory.

The contract distinguishes explicit user-originated, verified/strongly
supported, ordinary observed interaction, weak/inferred, and
assistant/model-generated sources. Assistant/model output cannot create P8
truth, and repetition cannot increase its authority. Weak or limited evidence
cannot produce a `KNOWN` strong interpretation. An explicitly supplied meaning
may be projected only through explicit bounded links identifying the evidence
references that `SUPPORTS` or `CONTRADICTS` that candidate. Link support is
qualitative support for that candidate, not an absolute property that
authorizes every possible meaning; normalized link support cannot exceed the
source atom's support. Direct but unrelated evidence therefore cannot
authorize an arbitrary meaning, and P8-1B does not infer a social story from
an evidence statement.

Evidence access status is separate from relationship fact. Successful access
with no relevant evidence produces `EMPTY`; successful access with evidence but
no sufficiently supported meaning produces `UNKNOWN`; unavailable and failed
access produce `UNAVAILABLE` and `ERROR`; incomplete access produces `PARTIAL`.
Unresolved explicit contradiction produces `CONFLICTING` and preserves both
provenance paths. None of these states means “Yuvi has no history with this
person.” Scope and provenance are preserved, but P8-1B performs no scope
filtering. Interpretation provenance contains only the linked evidence that
participates in the candidate; other access-level evidence remains separate
and cannot masquerade as support provenance. The output is a compact semantic
envelope, not a prompt string, and contains no relationship scalar, transient
mood, Continuity, or channel behavior state.

Future semantic authority precedence is explicit user correction or control,
then explicit authored identity authority where applicable, then
strong/current evidence in the correct scope, then weak inference, then
model-generated output. P8-1B does not implement correction persistence or full
conflict resolution, so unresolved contradiction remains `CONFLICTING` rather
than being resolved by ordering, repetition, confidence wording, or recency
alone.

P8-1B remains a pure contract: it accepts already-authorized evidence and
explicit candidate links, but does not retrieve or interpret raw Memory. The
P8-1C adapter below is the first narrow read-only boundary that supplies this
contract from current vendor-neutral evidence types.

## P8-1C implementation boundary

P8-1C adds a pure, read-only adapter in `@companion/p8`. It has only a
type-level dependency on the vendor-neutral `MemoryEvent` and
`MemoryRetrievalOutcome` contracts from `@companion/memory`; it does not depend
on `MemoryProvider`, MemoryService, repositories, Postgres, Mem0, Core,
Runtime, or PromptBuilder. Memory remains the owner of retrieval authorization,
scope selection, eligibility, filtering, ranking, and evidence persistence.
The adapter consumes an already-authorized outcome and never performs a second
query, filtering pass, rerank, vector lookup, or write.

Memory retrieval statuses map without semantic collapse: `ok` with authorized
events becomes successful evidence access, `empty` becomes successful access
with no relevant evidence and therefore P8 `EMPTY`, `partial` remains
`PARTIAL`, and `unavailable` and `error` remain distinct. Inconsistent status
and event combinations fail closed. Successful access with evidence but no
explicit candidate meaning is `UNKNOWN`; evidence alone never creates a P8
relationship conclusion.

The event adapter uses the canonical event identity, content, an exact caller-
supplied authorized scope, and the first supplied timestamp in
`occurredAt`, `observedAt`, `recordedAt` order. Assertion source and
verification determine only a bounded P8 authority/support classification:
verified explicit user or supported source may be `DIRECT`, weak or
unverifiable evidence is at most `LIMITED`, and assistant/model-generated
content is `NON_AUTHORITATIVE`. Memory confidence, rank, repetition, kind,
metadata, provider/source-record identifiers, participants, and conversation
identifiers do not become P8 truth or confidence.

The recent-conversation input is a separate, caller-bounded current-session
channel containing role, source-supplied message identity, content, opaque
scope, and optional source time. It is not long-term Memory and is not
persisted by this adapter. The current message is excluded by its identity
before the supplied message/character bound is applied; equal text is never
used for identity or deduplication. Scope mismatch or missing scope fails
closed, and no global, user-wide, persona-wide, cross-session, or platform
scope is invented. Recent user messages retain their
`EXPLICIT_USER_ORIGINATED` source class but default to `LIMITED` support because
this stage cannot distinguish a fact from a joke, hypothetical, quotation,
roleplay, rhetorical speech, transient concern, correction, or control. Recent
assistant messages remain `ASSISTANT_MODEL_GENERATED` with
`NON_AUTHORITATIVE` support.

P8-1C accepts only explicitly supplied semantic interpretation candidates and
candidate-specific evidence links, then delegates their bounded status,
support, conflict, and provenance semantics to P8-1B. It does not extract
facts, infer relationships, call an LLM, treat assistant repetition as truth,
or turn a recent question into mood or durable relationship state. Long-term
and recent access states remain separate during outage and recovery.

P8-1C interpretation candidates retain their existing public shape; they do
not acquire correction IDs or revision metadata. Stable interpretation target
identity is layered on later by the P8-1D correction contract.

The resulting read-only projection contains the identity address, P8-1A
identity/persona projection, compact per-channel access status/state, evidence
counts, candidate-linked interpretations, and bounded opaque provenance. It
does not contain raw Memory or conversation DTO collections, statements,
embeddings, rank scores, backend details, provider/model configuration, prompt
strings, mood, Continuity/open-thread fields, proactive authority, or
relationship scalars. No Runtime or PromptBuilder behavior is changed by
P8-1C.

## P8-1D implementation boundary

P8-1D adds a pure correction/revision semantic contract over the supplied
P8-1A/P8-1B/P8-1C projection. A correction is received only as an explicit
semantic object already classified by an upstream authority; P8 does not parse
free-form language, detect corrections, call a model, retrieve Memory, or
persist anything. The contract has bounded correction references, identity and
scope addresses, explicit `REVISE` and `RETRACT` actions, a P8-1D-local binding
that layers stable interpretation references over the unchanged P8-1B output,
explicit authored-invariant references, user-correction provenance, optional
source time, superseded evidence references, and explicit revision lineage.
Bindings are an overlay only: each one must identify exactly one existing base
interpretation, subset bindings preserve all unbound interpretations in base
order, and foreign, modified, or aliased bindings fail closed. They cannot add,
remove, or replace the base interpretation collection.

The P8-1B and P8-1C public contracts remain unchanged at `p8-1b.v1` and
`p8-1c.v1`; neither interpretations nor interpretation candidates carry
correction-target metadata. Likewise, P8-1A remains `p8-1a.v1`: authored
invariants do not expose a revision-policy field. P8-1D receives an explicit
revision-policy overlay, treats an omitted policy as `FIXED`, and permits a
correction to revise an authored invariant only when that overlay explicitly
sets the exact target to `USER_REVISABLE`.

Explicit user correction/control is the highest P8 semantic authority. It
outranks old strong evidence, weak inference, recency, rank, repetition,
confidence, and assistant/model output. `REVISE` replaces the current meaning
with the supplied correction-authoritative meaning; `RETRACT` removes the old
current meaning without inferring its opposite and normally leaves the target
`UNKNOWN`. Corrected interpretations expose only the current meaning, while
audits preserve the prior meaning and opaque interpretation/evidence
references. Historical evidence remains intact and auditable; correction is
not destructive Memory editing.

Two incompatible equal-authority corrections remain `CONFLICTING` unless an
explicit correction declares that it supersedes another correction. Supplied
timestamps are provenance only and never determine precedence. Corrections are
scope- and identity-addressed, so a correction for one character instance,
persona profile, or evidence scope cannot alter another. Authored invariants
are fixed by default; only an invariant named by the explicit P8-1D policy
overlay as user-revisable may be revised or retracted by this stage. The
default `character.name = Yuvi` invariant therefore remains non-revisable.

P8-1D preserves P8-1C Memory access states independently: a correction cannot
turn `EMPTY`, `UNAVAILABLE`, or `ERROR` evidence access into another backend
state. It adds no relationship scalar, transient affect, Continuity, channel
social mode, prompt string, Runtime integration, Memory write, or persistence.

## P8-1E implementation boundary

P8-1E makes explicit user corrections durable without making a derived P8
projection a second source of truth. The pure `@companion/p8` contract owns the
versioned correction record, append/load store interface, record validation and
canonicalization, and reconstruction function. The PostgreSQL implementation
lives in the existing Core persistence boundary and uses the existing Memory
migration runner and `DATABASE_URL`; `@companion/p8` does not depend on `pg`, a
PostgreSQL client, Runtime, PromptBuilder, or Mem0.

Only correction authority inputs are persisted: the P8-1E record version,
correction reference, exact character/persona/optional subject address and
opaque scope reference, target, `REVISE`/`RETRACT` action, replacement meaning
when applicable, explicit-user provenance, source-supplied time when present,
explicit correction lineage, and explicitly superseded opaque evidence
references. P8 does not persist Memory event DTOs, conversation messages,
embeddings, retrieval rank, model explanations, prompt strings, assistant
output, transient affect, relationship summaries, or a derived projection.
Corrections are append-only: the same correction reference and canonical
payload is idempotent, a different payload is a conflict, and there is no
semantic delete or last-write-wins update. No user-interface correction
capture is implied by this storage contract.

Stable interpretation references are explicit P8-1E declarations around the
unchanged P8-1C candidate input. They survive process restart and distinguish
identical candidate meanings. P8-1D's exact JavaScript object-identity check
remains only a same-call membership guard: reconstruction creates fresh P8-1C
interpretation objects, then creates fresh P8-1D bindings over them. A missing,
duplicate, or foreign referenced candidate fails closed; P8 never recovers a
target from text, domain, evidence equality, embeddings, or array position.

Reconstruction is versioned by a compact manifest containing
`p8-1a.v1`, `p8-1b.v1`, `p8-1c.v1`, `p8-1d.v1`, and `p8-1e.v1`. It combines the
stable authored rules, the supplied Memory-authorized outcome, separately
bounded recent conversation, explicitly referenced candidates, configured
authored-invariant revision policies, and loaded durable corrections through
the existing P8-1C/P8-1D pure functions. The result is deterministic and
reconstructable; database sequence/order, `stored_at`, process identity, and
source-supplied timestamps never establish correction precedence. Explicit
lineage remains the only correction supersession authority.

Correction lookup distinguishes `SUCCESS_WITH_CORRECTIONS`,
`SUCCESS_WITH_NO_CORRECTIONS`, `UNAVAILABLE`, and `ERROR`. A successful empty
lookup means there is no correction history for that exact address and scope;
it is not an outage. If correction storage is unavailable or errors, P8-1E
does not emit an uncorrected projection as current authoritative truth, because
doing so could resurrect a retracted meaning. Stored rows are validated again
on read; unknown record versions, malformed rows, invalid authority, action,
target, address, scope, or lineage fail closed rather than being skipped.

P8-1E leaves Memory as the evidence owner and P8 as the grounded-meaning
owner. P8 correction rows are not Memory events and do not change Memory
retrieval, hybrid ranking, scope filtering, expiry, or writes. The durable
reconstruction is not wired to Runtime, PromptBuilder, the Character ABI,
voice, proactive behavior, Continuity, or channel social mode. P8-1F remains
the later adversarial closure for persistence/reconstruction edge cases,
privacy, outage, scope isolation, and backend replacement.

## 3. Inputs

- stable, explicitly authored Yuvi identity/persona rules;
- scoped `MemoryEvent` evidence and retrieval status after Memory-owned scope,
  status, time-validity, eligibility, and ranking rules;
- bounded recent conversation supplied separately from long-term Memory;
- explicit user settings, corrections, consent, and identity controls;
- current Runtime truth relevant to the interaction;
- later, temporal context for recency and validity.

Missing, unavailable, contradictory, or unverified evidence remains visible as
such. P8 must not convert “no relevant result” or backend failure into a claim
that no relationship history exists.

## 4. Outputs

- stable identity/persona projection;
- evidence-grounded relationship/background interpretation;
- provenance or source references sufficient for audit without exposing raw
  sensitive content unnecessarily;
- uncertainty, conflict, and “unknown” indications;
- bounded context suitable for Character ABI projection.

The Character ABI wire format and prompt adapter remain deliberately deferred;
P8-1E defines only the narrow durable correction record and reconstruction
boundary described below.

## 5. Authority boundaries

| Candidate owner      | Boundary audit                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | Runtime stores, versions, and transports P8 artifacts but cannot decide identity or relationship meaning merely because it owns persistence.                                             |
| Memory               | Memory owns evidence records plus retrieval eligibility, filtering, and ranking; it is not a Persona database and does not promote a relationship-tagged record into relationship truth. |
| **P8**               | Owns stable identity and evidence-grounded persona/relationship interpretation because these meanings require consistency across models and interactions.                                |
| Continuity           | Continuity owns unfinished relevance and recent residue, not stable identity or relationship authority.                                                                                  |
| Character Model      | Expresses P8 context naturally but cannot rewrite P8 by self-report or ordinary generated prose.                                                                                         |
| Cognition Core       | May assist with difficult interpretation, contradiction analysis, or verification, but does not become Yuvi's identity authority.                                                        |
| Character Harness    | Selects authorized P8 projections for ABI inclusion under the context budget; it does not re-rank Memory, invent, persist, or independently reinterpret P8.                              |
| MCP capability layer | May retrieve external evidence under admission; dynamic tools and servers cannot define Yuvi's identity.                                                                                 |
| Presentation         | Renders character behavior; appearance, animation, or voice state does not establish Persona or relationship truth.                                                                      |

This responsibility belongs in P8 because it must remain stable when Runtime
internals, Memory backends, models, providers, MCP servers, and presentation
surfaces change.

## 6. Hard invariants

- P8 is evidence-grounded and provenance-aware.
- Stable identity cannot drift from ordinary conversation or assistant output.
- Model self-report is not Runtime or P8 authority.
- Explicit user correction and control outrank model preference.
- Intimacy, dependency, trust, exclusivity, or relationship status cannot be
  invented without evidence.
- Assistant-only relationship or affect prose cannot create a self-reinforcing
  state loop.
- `empty`, `unavailable`, `error`, and `partial` Memory outcomes remain
  semantically distinct.
- P8 is not a generic mood engine and does not own transient conversational
  attention.
- P8 consumes Memory-authorized evidence and owns only its
  identity/persona/relationship interpretation. It does not reimplement scope,
  status, time-validity, retrieval-eligibility, or rank authority.
- P8 output is bounded and safe for projection; raw Memory/backend DTOs do not
  cross into the model ABI.
- No implementation may weaken existing P4 durability or P6 proactive
  semantics.

## 7. Explicit non-goals

- A persistent `RelationshipState`, `DynamicSelf`, or universal affinity/trust
  score.
- Generic emotional simulation or off-screen relationship evolution.
- Continuity, open-thread tracking, initiative, or idle behavior.
- A class hierarchy, large rules engine, or new generic manager abstraction.
- Training the Character Model.
- Selecting cognition backends, providers, MCP tools, or presentation actions.

## 8. Dependencies

- Structural R closeout is accepted.
- Current Memory evidence/provenance semantics remain intact.
- Current identity scope isolation and explicit user settings remain
  trustworthy.
- The phase can define its semantic output before the Character ABI wire form is
  selected.

Temporal and Continuity phases are downstream. P8 may initially treat recency
conservatively rather than inventing temporal behavior before phase 3.

## 9. Relationship to existing implementation

**CURRENT:** Memory has persona/subject identifiers, relationship categories,
provenance, current-affect detection, and conservative relationship-memory
handling. `PromptBuilder` has syntactic `SystemIdentity`, `CharacterStyle`, and
`RelationshipContext` sections. Memory documentation explicitly says evidence
is not authoritative Relationship, Affect, Persona, Interest, or Commitment
state.

**IMPLEMENTED P8-1A:** P8 now owns only the pure, authored identity/persona
projection described above. Existing prompt fields remain Character/surface
behavior and are not consumed by this package. No existing Memory category is
reclassified as P8 truth.

**IMPLEMENTED P8-1B:** P8 defines the pure evidence interpretation semantics
described above. The contract still receives only already-authorized evidence
and does not give P8 Memory retrieval or ranking authority.

**IMPLEMENTED P8-1C:** The pure read-only adapter translates the current
vendor-neutral Memory outcome/event boundary and a separately bounded recent
conversation input into P8-1B evidence and a compact projection. It preserves
scope, access-state, authority, support, candidate-link, and provenance
boundaries without wiring the projection into Runtime or PromptBuilder.

**IMPLEMENTED P8-1D:** P8 now accepts only explicit user-authorized semantic
correction objects and applies deterministic `REVISE`/`RETRACT` behavior to
stable interpretation references and explicitly user-revisable authored
invariants. It preserves correction provenance, prior meaning/evidence
references, explicit supersession lineage, conflict status, scope/identity
isolation, and independent Memory access state. It performs no NLP, Memory
mutation, persistence, Runtime integration, or PromptBuilder integration.

**IMPLEMENTED P8-1E:** P8 now persists explicit correction authority through
the existing PostgreSQL migration/persistence boundary and reconstructs a
versioned corrected projection from fresh P8-1C objects plus stable P8-1D
references. Stored correction history is append-only, idempotent by canonical
payload, exact-address/scope isolated, validated on read, and fail-closed on
storage outage or malformed/unknown records. Derived projections are not
persisted as authority, and no Memory event is created for a P8 correction.
There is no Runtime, PromptBuilder, Character ABI, UI, or response behavior
integration in this stage.

**PLANNED:** P8-1F will add adversarial closure. Character ABI integration,
prompt projection,
Continuity, channel social mode, and relationship growth modeling remain
planned. Weak evidence must produce only weak interpretation; contradictory,
empty, unavailable, or erroneous evidence must remain explicit.

## Future-stage constraints

- Memory owns evidence, including scope, eligibility, validity, retrieval, and
  ranking. P8 owns grounded identity/persona/relationship meaning only.
- Explicit user correction/control is a first-class P8 semantic authority, but
  a Memory event category, recent user utterance, assistant output, or model
  guess does not become correction authority without a separately supplied,
  explicit semantic correction object.
- Corrections remain addressed to a character instance/persona profile and an
  opaque evidence scope. Future person, group, and platform-local scopes, plus
  multiple character instances and persona profiles, must remain possible
  without turning P8 into a global relationship registry.
- Relationship meaning remains qualitative and evidence-grounded. Weak
  evidence cannot justify a strong interpretation, and no affinity, trust,
  intimacy, relationship-level, mood, or dependency scalar is permitted.
- Recent conversation is a separate bounded input, not long-term Memory and
  not a durable identity fact. P8 is not Continuity and does not own unfinished
  relevance, commitments, residue, or attention.
- P8 is not channel social mode and cannot own QQ/group behavior or platform
  adapters. Future person/group/platform scope must remain possible without
  exposing account identifiers to the model-facing projection.
- Multiple character instances and persona profiles must remain possible;
  current defaults do not establish a global singleton.
- A semantic P8 projection is not `PromptBuilder` output and must not be
  defined by `PromptBuildInput`, `PromptSectionName`, or prompt section text.
  A later Character ABI adapter may consume a compact projection.
- Character post-training may learn expression and preferences, but it cannot
  redefine P8 identity, provenance, uncertainty, or correction semantics.
- Corrections and revisions are first-class future P8 capabilities. Derived
  artifacts must remain reconstructable from explicit source inputs and bounded
  provenance rather than becoming opaque new authority.
- Provenance should be sufficient for audit while minimizing private content;
  raw Memory records, database identifiers, provider/backend details, and
  platform account IDs must not cross into Character-facing semantics.

## 10. Likely staged implementation shape

1. **Implemented in P8-1A:** Freeze the concise authored identity/persona
   invariant representation and minimum projection vocabulary.
2. **Implemented in P8-1B:** Define minimum evidence interpretation/projection
   meanings, including unknown, empty, unavailable, error, partial, and
   conflict.
3. **Implemented in P8-1C:** Adapt Memory-authorized evidence and a separately
   bounded recent-conversation input into the read-only P8-1B contract and
   compact projection.
4. **Implemented in P8-1D:** Add correction/revision and audit behavior over
   stable P8-1D target bindings.
5. **Implemented in P8-1E:** Add append-only durable correction authority and
   deterministic versioned reconstruction through the existing persistence
   boundary.
6. P8-1F: Validate multi-session stability, scope isolation, privacy, outage,
   and backend replacement.

Each stage should add the smallest semantic unit and tests needed. Do not build
a generic relationship framework in anticipation of hypothetical consumers.

## 11. Acceptance concept

P8 is acceptable when the same grounded identity and relationship context can
be reconstructed across Runtime/model replacement; contradictory or
unavailable evidence remains explicit; ordinary assistant prose cannot mutate
identity; user corrections take effect predictably; and no ungrounded
relationship state appears in Character context.

Acceptance should include adversarial cases for false familiarity, invented
intimacy, stale evidence, scope leakage, assistant-derived feedback loops,
backend outage, and explicit user correction.

## 12. Risks

- Conflating a Memory category with semantic authority.
- Freezing too much personality as rules and making Yuvi mechanical.
- Allowing a model-generated summary to lose provenance or amplify certainty.
- Encoding relationship growth as a scalar that invites optimization and
  manipulation.
- Letting P8 absorb short-term affect, attention, or Continuity.
- Persisting sensitive interpretation without adequate user visibility and
  correction.

## 13. Open questions

- Which identity/persona elements require explicit user-visible editing?
- Which relationship interpretations may persist as derived artifacts, and
  which should be reconstructed on demand?
- How should conflicting evidence be presented without exposing unnecessary
  private detail?
- What minimum provenance is required in the Character ABI versus diagnostics?
- When should Cognition Core assist complex social interpretation?
- What revision and migration policy preserves meaning when the P8 projection
  evolves?

## 14. Handoff boundary to the next phase

Phase 1 hands phase 2 a semantic P8 projection with defined meaning,
provenance/uncertainty behavior, and explicit non-authorities. Phase 2 may place
that projection in the Character ABI. It may not redesign P8 semantics, expose
P8 storage records directly to the model, or freeze detailed TypeScript types
prematurely.
