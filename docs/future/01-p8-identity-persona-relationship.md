# Phase 1 — P8 Identity, Persona, and Relationship

> **Status: CLOSED — P8 through P8-1F is implemented; later speculative extensions are GAP-DRIVEN.**
>
> **Long-term interpretation:** P8 remains the current product authority for
> stable identity, authored persona constraints, correction, and evidence-grounded
> relationship meaning. Under the persistent-functional-self north star, P8 is
> **not** assumed to be the complete causal source of a mature Yuvi's personality.
> See [Artificial Person North Star](00-artificial-person-north-star.md) and
> [Current Architecture Reinterpretation](00c-current-architecture-reinterpretation.md).

Current implementation is indexed in [the roadmap](README.md). Detailed phase plans below preserve historical design reasoning; they are not a new work queue.

## 1. Purpose

Establish a stable answer to “Who is Yuvi?” and a bounded,
evidence-grounded answer to “What is the relationship and background context
here?” This phase creates semantic authority for identity/persona/relationship
interpretation without turning Memory records, prompt sections, or model
self-report into truth.

For the current operational architecture, this remains the correct authority.
Long term, however, the phrase “Who is Yuvi?” must be read carefully. P8 answers
what identity/persona/relationship meaning is authorized and safe to project; it
does not by itself prove that a causally continuous self exists across
inference boundaries.

A future persistent self, if demonstrated, should accumulate characteristics
through lived state transition and learning rather than requiring P8 to grow
into an exhaustive personality specification.

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

Under the long-term persistent-self research direction, P8 also must **not** be
expanded by default into a comprehensive psychological state or a textual
replacement for continuing internal state.

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

That small authored surface is also the preferred long-term direction. A lack of
human-like personality should not automatically be repaired by adding more
invariants. If future research demonstrates a continuing learned self, authored
persona should increasingly act as initialization and explicit boundary rather
than exhaustive identity content.

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
| Runtime              | Runtime stores, versions, and transports P8 artifacts but cannot decide identity or relationship meaning.                                                                              |
| Memory               | Memory is evidence authority: retrieval authorization, scope, eligibility, filtering, ranking, provenance, validity/status, retention, expiry, and record lifecycle stay there.        |
| **P8**               | P8 owns stable identity/persona semantics, evidence-grounded relationship interpretation, uncertainty/conflict, and explicit correction/revision semantics.                            |
| Temporal             | Supplies elapsed/recency meaning when needed; time alone cannot establish relationship progression or P8 truth.                                                                         |
| Continuity           | Owns unfinished relevance if later implemented; it must not absorb stable persona or relationship interpretation.                                                                       |
| Character Model      | Expresses P8 meaning naturally but does not create or revise P8 authority merely by saying something.                                                                                   |
| Cognition Core       | May assist hard interpretation when explicitly requested, but its output is evidence/advice to the P8 authority rather than automatic truth.                                            |
| Character Harness    | Projects and validates P8 context for the model boundary; it does not infer, persist, or revise P8 meaning.                                                                              |
| Presentation         | Renders behavior; no animation, tone, or presentation state establishes relationship truth.                                                                                             |

Long term, this authority map should be read as **epistemic/product authority**,
not as proof that P8 is the full physical substrate of identity. If a persistent
functional state is later demonstrated, P8 may remain the authority for explicit
identity constraints and grounded claims while learned state carries additional
causal history.

## 6. Hard invariants

- Memory evidence is not itself P8 truth.
- Assistant/model output is never promoted to P8 truth merely through
  repetition, confidence, or self-reference.
- Stable authored identity/persona rules cannot be silently rewritten by
  ordinary conversation.
- P8 does not invent relationship meaning from absence of evidence.
- Unknown, empty, partial, unavailable, error, and conflicting evidence states
  remain distinct.
- Recent conversation is not automatically durable Memory.
- P8 does not own generic mood, transient attention, Continuity, Runtime
  execution, or provider behavior.
- No relationship scalar is required.
- Explicit correction/control remains auditable and provenance-preserving.
- Current P8 remains product authority until an explicitly designed migration,
  regardless of speculative persistent-self research.
- Lack of personality depth must not automatically justify adding more authored
  persona invariants or psychological relationship fields.

## 7. Explicit non-goals

- A full personality simulator.
- A mood engine.
- A relationship score.
- A replacement for Memory retrieval.
- A hidden social graph.
- Automatic inference of intimacy or attachment from elapsed time.
- Treating the model's self-description as authoritative identity state.
- Making P8 the persistence container for a future latent self merely because it
  already owns identity semantics.
- Expanding Persona text until it substitutes for learned continuity.

## 8. Dependencies

- Current Memory evidence contracts and provenance rules.
- Runtime persistence and identity/address transport.
- Character ABI projection.
- Later temporal context when recency is semantically required.
- Explicit user correction and control paths.

The persistent-self research program is **not** a current dependency. Its
results may eventually motivate a new integration boundary, but only after
causal milestones are demonstrated.

## 9. Relationship to existing implementation

**CURRENT:** P8 through P8-1F is implemented and remains authoritative for the
present product architecture. Its small authored invariant set, evidence
interpretation, correction persistence, provenance, scope isolation, and
unknown/conflict behavior should not be reopened merely because the long-term
north star changed.

**LONG-TERM REINTERPRETATION:** if a continuing learned state eventually proves
itself, P8 should increasingly be understood as the stable identity/address,
explicit constraint, correction, and epistemic interpretation layer around that
state — not as the exhaustive definition of everything the person is.

## 10. Acceptance concept

P8 remains acceptable when it provides stable, auditable identity/persona and
relationship meaning without inventing unsupported social state, while staying
small enough that behavior and personality need not be authored into it.

A future persistent-self integration would require separate acceptance criteria.
It must not be accepted merely because a latent vector can be stored under a P8
identity address.

## 11. Risks

- Letting P8 slowly absorb transient affect, attention, Memory lifecycle, or
  Runtime concerns because they all influence Character behavior.
- Treating authored Persona as a substitute for a character that should have
  learned a tendency through experience.
- Adding relationship scalars because natural behavior is difficult to obtain
  from current models.
- Confusing epistemic authority (what may be claimed) with causal substrate
  (what makes the continuing system different now).
- Reusing P8 correction semantics for hidden-state mutation without a separate
  research justification.

## 12. Open questions

Current product questions remain gap-driven and should be answered from real
use.

Long-term research questions include:

- Which P8 meanings remain necessary once a persistent learned state exists?
- Which authored invariants are true identity boundaries versus temporary
  bootstrap Persona?
- How should explicit user correction interact with learned internal state
  without pretending that natural-language correction directly rewrites an
  arbitrary latent representation?
- Can relationship interpretations remain auditable while some relationship
  effects emerge implicitly through learned state?
- When does a change in learned state require a P8-visible identity revision,
  and when is it ordinary development within the same identity?

## 13. Handoff boundary

For the current product, P8 continues to hand the Character ABI a compact,
provenance-grounded identity/persona/relationship projection.

For long-term research, the conceptual boundary is stricter:

```text
P8: what identity and relationship claims are authorized

persistent state: what accumulated experience has causally made the continuing
system different
```

Neither should silently absorb the other.