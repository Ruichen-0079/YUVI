# Post-Structural Companion Roadmap

> **Status: CURRENT ROADMAP / IMPLEMENTATION MIXED — REBASELINED TO THE MEMORY-FIRST OPERATIONAL PATH**
>
> **Current-state authority:** the current `origin/main` source, tests, closure
> documents, and current-state documentation are authoritative.
>
> **Scope:** long-term semantic architecture and staged product direction. This
> directory must not override implemented behavior or create work merely because
> an older phase sequence listed it.

Current source, tests, closure documents, and current-state documentation remain
authoritative for implemented behavior. In particular, [P4 Linux-first](../p4-linux-first.md),
[Memory](../memory.md), [Memory vNext](../memory-vnext.md),
[Providers](../providers.md), [Prompt Pipeline](../prompt-pipeline.md), and the
current Runtime contracts take precedence over older roadmap status text.

The long-term philosophical north star is [Artificial Person North Star](00-artificial-person-north-star.md).
Its new persistent-functional-self research path is intentionally **separate**
from this operational roadmap; see
[Persistent Functional Self Research Program](00b-persistent-functional-self-research.md)
and
[Current Architecture Reinterpretation](00c-current-architecture-reinterpretation.md).
Those documents do not reopen closed phases or authorize production persistent-state
infrastructure.

Linux daily-use and local speech are closed by [Campaign B](campaign-b-closure.md).
[Campaign C](campaign-c-closure.md) rebaselines Linux local services / Memory: the
remaining follow-up exposes existing Supervisor diagnostics when Runtime is down.
External PostgreSQL/Ollama ownership and the established embedding path remain
authoritative; the old campaign sequence does not require rebuilding them.

Structural Debt Paydown is complete. P8 identity/persona/relationship work is
closed through P8-1F; Character ABI 2A–2D is implemented; the Character Harness
semantic kernel is closed through 5L; the initial bounded Cognition/capability
slice is closed; and Phase 7 embodied agency is closed. Memory vNext already
provides the operational L0/L1/L2 hierarchy, bounded associative intrusion, and
a thin temporal projection used by the live user-turn prompt.

The immediate product path is therefore **not** to rebuild full Temporal and
Continuity subsystems before Yuvi can run. Use the implemented Memory-first
path, evaluate real failures, and add only the smallest missing explicit
semantic artifact when evidence proves one is required. P6 remains frozen
current proactive-text behavior.

Formal Phase 8 behavior assets are present and available for evaluation. Phases 9–13 — base-model
bakeoff, QLoRA SFT, DPO, shadow/A-B, and the preference-data flywheel — are
deferred until Yuvi is landed, has run for a sustained period, and has produced
reviewed real-usage evaluation evidence. The current DeepSeek V4 Flash-class
Chat path is replaceable operational infrastructure, not Character identity.

## Current operational status

[Production reachability audit](production-reachability.md) records actual callers, fixes, and explicit library-only boundaries for these closure claims.

[Campaign H](campaign-h-closure.md) records cache and proactive evidence, Memory
console consistency, durable Live2D import with the official Hiyori default
installation seam, Chinese UI and objective interaction acceptance.

| Area | Classification | Current authority |
| --- | --- | --- |
| P8 identity/persona/relationship | CLOSED | P8-1F; current Memory/P8 projection |
| Character ABI, Harness, Cognition | CLOSED | Production Character adapter and bounded Cognition re-entry |
| Voice and interruption | CLOSED | [Campaign D](campaign-d-closure.md) |
| Local speech | CURRENT | dots.tts / Rei, local STT; [Linux daily use](../linux-daily-use.md) |
| On-demand Visual Grounding | CLOSED | [Campaign E](campaign-e-visual-grounding.md); remote capability still requires configured credentials |
| Companion and Live2D calibration | CLOSED | [Campaign F](campaign-f-presentation.md) |
| Linux packaged daily deployment | CLOSED | [Linux release gate](linux-release-gate-closure.md); private model/sidecar prerequisites remain external |
| Behavior assets | CURRENT | specification, evaluation and preference schema in this directory |
| Character training | DEFERRED | requires reviewed sustained usage evidence |
| Persistent functional self research | RESEARCH / ISOLATED | `00b`; no production authority |
| Dream | CURRENT | event-driven consolidation; real idle scheduling remains DEFERRED |
| Memory maintenance | CURRENT | explicit opt-in, OFF by default; no automatic startup/periodic sweep |
| Prompt caching | CURRENT | invariant prefix plus provider-bound time-last layout; H measurements distinguish budget protection from prefix stability |
| Full Temporal/Continuity systems | GAP-DRIVEN | existing thin time and L0/L1 evidence remain the daily-use path |
| Earlier operational audits and atom plans | HISTORICAL | retain reasoning; use this table and current code for status |

The GPT-SoVITS/Alice and IndexTTS operational recommendations in earlier audit
text are historical. The installed local TTS path is dots.tts / Rei. There is no
next automatic campaign or architecture expansion implied by this roadmap.

## Product north star

Yuvi is intended to become a persistent local AI companion, not an ordinary
agent framework or only a capable work assistant. The target combines stable
identity, an evidence-grounded relationship and persona, temporal awareness,
continuity across gaps, unresolved conversational attention, selective
initiative and meaningful silence, replaceable capabilities, embodied
voice/visual behavior, a character-specific language model, and a separate
strong cognition core for reliable work. Yuvi should have independent access
to admitted capabilities without making today's tool inventory part of her
identity.

The longer-term research north star now asks an additional question that this
product roadmap does not answer by itself: whether some learned state can remain
causally continuous across inference boundaries, resist irrelevant contextual
overwrite, be revised by evidence, and be changed by the agent's own actions and
consequences. That question is tested separately before it can alter product
architecture.

The character surface should do less rational work than a general assistant.
It should primarily express Yuvi's character, decide what deserves attention,
know when to stop or remain silent, and make a coarse decision to request
stronger cognition. Complex reasoning, coding, research, verification,
multi-step planning, repository analysis, complex tool selection, and
high-reliability factual work belong to the Cognition Core.

## Current and planned boundary

**CURRENT:** Runtime lifecycle, event publication, provider abstraction,
conversation persistence, evidence-oriented Memory, P8 through 1F, Character
ABI through 2D, prompt sections, Memory vNext L0/L1/L2 context, associative
recall, thin temporal projection, the Character Harness semantic kernel,
initial bounded Cognition/capability execution, bounded P6 assistant-initiated
text, and Phase 7 embodied presentation are implemented to their respective
closure boundaries.

The live user-turn prompt already receives current/local time, elapsed time from
the prior interaction, Direct Context, time-labelled L1 recent episodes, and
bounded associated L1/L2 Memory. This is the current operational continuity/time
strategy. It is intentionally simpler than the originally planned full Phase 3
and Phase 4 systems.

**RESERVED / GAP-DRIVEN:** Temporal remains the semantic owner for any future
shared elapsed/horizon calculation beyond the implemented thin projection.
Continuity remains the reserved owner for any future explicit durable
unfinished-relevance state. Neither reserved owner authorizes building a large
subsystem before a repeatable real failure proves it necessary.

**CLOSED:** Phase 8 behavior assets are now defined by
[`YUVI_BEHAVIOR_SPEC`](YUVI_BEHAVIOR_SPEC.md),
[`YUVI_BEHAVIOR_EVAL`](YUVI_BEHAVIOR_EVAL.md), and
[`YUVI_PREFERENCE_DATASET`](YUVI_PREFERENCE_DATASET.md) schema/governance.

**NEXT:** Complete the operational landing audit in
[`YUVI_OPERATIONAL_LANDING_AUDIT`](YUVI_OPERATIONAL_LANDING_AUDIT.md) before
making Stage 3 product fixes. The current prompt/provider Chat model remains
the replaceable baseline against which behavior is evaluated.

**DEFERRED:** Phases 9–13 wait until Yuvi is actually operational for sustained
daily use and enough reviewed evidence exists to distinguish model-behavior
failures from Memory, prompt, Runtime, provider, or presentation defects.

**PARALLEL RESEARCH / NOT PRODUCT AUTHORITY:** the persistent-self program may
prototype minimal learned recurrent state, self-inertia, action-conditioned
state development, and later slow consolidation. It must remain isolated until
its causal milestones outperform strong prompt/text-state/Memory baselines and
an explicit integration decision is made.

## Expected sequence

### Operational product sequence

1. Keep the closed P8 / Character ABI / Harness / Cognition / embodiment
   boundaries stable; do not reopen them without a proven regression or an
   explicitly authorized extension.
2. Use the implemented Memory-first continuity/time path in product:
   Direct Context + reconstructable L1 + bounded associated L2 + thin temporal
   projection.
3. Evaluate minutes/hours/days/older-memory resumption and real daily-use
   failures. Fix retrieval, prompt, or model interpretation first when those
   are the actual cause.
4. Add a Temporal or Continuity semantic atom only when a repeatable failure
   cannot be solved by the current context/time projection; never build a
   generic manager pre-emptively.
5. Maintain Phase 8 behavior spec, eval, and dataset-governance assets.
6. Land and operate Yuvi using the replaceable DeepSeek V4 Flash-class Chat
   path plus the existing separate Cognition path.
7. Accumulate reviewed real-use evaluation evidence and fix non-model defects.
8. Only after the operational gate passes, consider Phase 9 base-model bakeoff,
   then evidence-gated Phase 10 SFT, Phase 11 DPO, Phase 12 shadow/A-B, and
   Phase 13 preference-data flywheel.

### Parallel persistent-self research sequence

This is not inserted into the production phase numbering:

1. minimal persistent learned state;
2. causal history-dependence under identical current input;
3. state reset/swap/ablation tests;
4. self-inertia against irrelevant tone/context shifts;
5. gradual revision under reliable evidence;
6. own-action + consequence conditioned development;
7. comparison against text-state and Memory baselines;
8. only then, slow parameter consolidation and state/parameter compatibility;
9. long-duration months/years evaluation.

Data/evaluation collection may begin earlier when provenance and labeling are
sound. Raw private conversation is not training data by default. Post-training
must not compensate for missing Runtime architecture, unclear authority, weak
Memory retrieval, or an unstable model boundary.

## Frozen responsibility map

The semantic ownership map remains valid even when an owner is currently only
reserved. “Owner” means where that meaning must live if/when it is explicitly
implemented; it does not require a dedicated service, manager, table, or phase
before product evidence needs it.

The persistent-self research track is deliberately **not** added as a new owner
in this table. It has no product semantic authority until an explicit future
migration is justified.

| Layer                | Semantic responsibility                                                                                                                                                 | Must not absorb                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Runtime              | Execution authority, lifecycle, concurrency, durability, persistence, provider/cognition execution, capability admission, hard loop containment, event publication      | Persona interpretation, attention judgment, cognition semantics, presentation meaning                         |
| Memory               | Durable, provenance-preserving evidence plus record retrieval/ranking, validity, status, retention, and expiry                                                          | Relationship truth, explicit Continuity authority, consumer-specific semantic relevance                       |
| P8                   | Stable identity plus evidence-grounded persona and relationship interpretation                                                                                          | Transient attention, generic mood, execution authority                                                        |
| Temporal substrate   | Shared non-mutating time position, elapsed time, age, temporal distance, consumer horizons, and derived relevance/attention decay when such shared semantics are needed | Memory record expiry/status, fake off-screen life, relationship interpretation, scheduling authority          |
| Continuity           | Reserved authority for explicit unfinished relevance: open threads, commitments, expectations, uncertainty, residue, and attention anchors                              | Durable factual Memory, Persona authority, execution                                                          |
| Character Model      | Character expression, reactive attention and termination/silence, coarse `NEED_COGNITION`, result expression                                                            | Current P6 proactive admission, capability selection, reliable complex reasoning, backend/model identity      |
| Cognition Core       | Complex reasoning, coding, research, planning, complex social interpretation, verification, and tool-assisted reasoning                                                 | Yuvi's identity, final character voice, direct effect authority                                               |
| Character Harness    | Character ABI inclusion/assembly, output interpretation, cognition-escalation requests, generation supervision, semantic recovery disposition                           | Durable state, cognition-result normalization, execution/retry, independent orchestration, provider lifecycle |
| MCP capability layer | Dynamic external capability discovery/description and one admitted protocol invocation at a time                                                                        | Continuation/loop control, character identity, hard-coded weighted tool names, admission authority            |
| Presentation         | Speech, silence rendering, gaze, expression, pose, motion, and visible environment-facing effects                                                                       | Attention/relationship truth, capability admission, random motion presented as agency                         |

## Cross-boundary responsibility audit

Each row answers why the responsibility belongs to its owner instead of every
other candidate layer. A future implementation may cross process or package
boundaries, but it must preserve these semantic owners. The Memory-first
operational shortcut may supply enough context to avoid instantiating a reserved
owner; that does not transfer the reserved semantics to Memory or Runtime.

| Responsibility                                                                  | Owner and reason                                                                                                                           | Why not Runtime / Memory / P8 / Continuity                                                                                                            | Why not Character Model / Cognition Core / Harness / MCP / Presentation                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execute, cancel, serialize, persist, admit, contain, and publish effects        | **Runtime**, because one effect authority is required for lifecycle, loop containment, and durability correctness                          | Memory records evidence; P8 interprets identity; Continuity, if introduced, tracks relevance. None may execute effects                                | Models propose; Harness requests; MCP performs one admitted invocation; Presentation renders/reports. None may become a second Runtime             |
| Preserve, retrieve, filter, rank, and lifecycle durable evidence                | **Memory**, because evidence fidelity and record eligibility must survive model replacement                                                | Runtime supplies persistence mechanics but not evidence meaning; P8 interprets already-authorized evidence; future Continuity may derive relevance    | Models and Harness consume authorized projections; MCP may produce evidence; Presentation may report observations. None is the evidence authority  |
| Define who Yuvi is and interpret the relationship from evidence                 | **P8**, because identity stability and relationship meaning require one evidence-grounded semantic authority                               | Runtime stores/executes; Memory supplies evidence; future Continuity owns transient unresolved state                                                  | Character expresses the projection; Cognition may assist hard interpretation; Harness assembles it; MCP and Presentation cannot define identity    |
| Derive shared time position, elapsed gaps, age, distance, and consumer horizons | **Temporal substrate**, when semantics beyond the thin current projection are proven necessary                                             | Runtime supplies clock observations; Memory owns record validity/status/expiry and supplies timestamps; P8/future Continuity consume temporal meaning | Models interpret the projection; Harness passes it; MCP and Presentation do not define elapsed reality                                             |
| Track explicit unfinished relevance across interaction gaps                     | **Continuity**, if contextual L0/L1 recovery proves insufficient                                                                           | Runtime may persist the projection; Memory is evidence/context; P8 may influence interpretation but does not own transient conversational residue     | Character judges response-worthiness; Cognition resolves hard work; Harness mediates; MCP/Presentation cannot decide what remains open             |
| Decide reactive character response, silence/termination, and coarse escalation  | **Character Model**, because these are learned social judgments at Yuvi's surface; current proactive text remains P6-owned until migration | Runtime enforces effects; Memory/P8/time/future Continuity provide grounded context rather than generate behavior                                     | Cognition performs hard reasoning; Harness supervises/interprets; MCP supplies capabilities to Cognition; Presentation renders the admitted choice |
| Perform serious reasoning and propose semantic continuation/capability need     | **Cognition Core**, because reasoning can be replaced independently of character identity                                                  | Runtime contains and executes the bounded cognition/capability session; Memory/P8/context provide evidence                                            | Character only emits `NEED_COGNITION` and expresses results; Harness mediates requests; MCP cannot decide continuation                             |
| Assemble the model projection, validate crossings, and supervise generation     | **Character Harness**, because adaptation and safety need a thin replaceable seam around the Character model                               | Runtime remains lifecycle/effect/retry authority; Memory/P8/future Continuity remain state authorities                                                | Phase-6 cognition boundary normalizes results; Character/Cognition remain models; MCP remains capability protocol; Presentation remains rendering  |
| Describe and perform one admitted invocation of dynamic capabilities            | **MCP capability layer**, because tool/server identities and protocol mechanics change independently from models                           | Runtime admits and contains execution; Memory records resulting evidence; P8/future Continuity do not route tools                                     | Cognition proposes `REQUEST_CAPABILITY`; Character emits only `NEED_COGNITION`; Harness requests; Presentation cannot be the capability registry   |
| Render embodied behavior                                                        | **Presentation**, because device/UI-specific execution should consume semantic intent                                                      | Runtime admits/publishes; Memory/P8/future Continuity do not animate                                                                                  | Character proposes expression; Cognition does not animate; Harness mediates; MCP may provide an environment action but does not render embodiment  |

## Authoritative decision ownership

Each concern below has one authority. Other layers may propose, consume,
project, validate, or transport, but those verbs do not transfer authority.
Reserved future concerns do not require an implementation until evidence proves
they are needed.

| Concern                                            | Sole authority                                                                                                       | May propose or consume                                                                                       | Explicitly not authority                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Memory record retrieval/ranking                    | Memory                                                                                                               | Runtime requests; P8/future Continuity consume authorized evidence                                           | P8, Harness, Character Model                                     |
| Memory record expiry/status                        | Memory                                                                                                               | Thin/shared Temporal may supply non-mutating calculations; Runtime persists a Memory-owned admitted mutation | Temporal, P8, Continuity, Harness                                |
| P8 evidence interpretation                         | P8                                                                                                                   | Memory supplies evidence; Cognition may return bounded analysis; Harness projects                            | Memory, Cognition, Harness                                       |
| Shared temporal elapsed/horizon calculation        | Temporal substrate when semantics beyond current thin projection are needed                                          | Runtime supplies clocks; Memory supplies timestamps; P8/future Continuity consume                            | Memory record lifecycle, Character narration                     |
| Explicit Continuity unresolved relevance           | Continuity if/when such durable semantics are introduced                                                             | Memory/events/time supply evidence/context; Character consumes anchors                                       | Memory, P8, Harness, Presentation                                |
| Current proactive text `NO_OP \| REQUEST_TEXT`     | Existing P6 `ProactiveDecisionProvider` until atomic migration                                                       | Context/attention/Character may supply input only through an explicitly admitted compatible change           | Character Model as a second gate, Harness, Presentation          |
| Reactive character response disposition            | Character Model                                                                                                      | Harness validates; Runtime admits effects                                                                    | Current P6 proactive decision, Harness, Presentation             |
| Future generalized proactive response disposition  | Sole replacement semantic authority designated by the explicit atomic P6 migration; none is active before the switch | Character/context may supply input under the migrated contract; Runtime admits effects                       | Old P6 producer after retirement, any parallel second gate       |
| Cognition escalation                               | Character Model emits `NEED_COGNITION`                                                                               | Harness validates/projects; Runtime executes the request                                                     | Harness as reasoning policy, MCP                                 |
| Cognition semantic continuation                    | Cognition Core emits `CONTINUE_REASONING \| REQUEST_CAPABILITY \| COMPLETE`                                          | Runtime enforces bounds; Harness transports normalized outcomes                                              | Runtime as semantic reasoner, MCP adapter                        |
| Cognition-result normalization                     | Phase-6 cognition boundary/adapter                                                                                   | Phase 2 defines meanings; Harness validates/budgets/consumes; Runtime transports                             | Character Harness, Runtime, Character Model                      |
| Provider/cognition execution                       | Runtime through existing provider infrastructure                                                                     | Harness constructs requests; models propose                                                                  | Harness, models, MCP server                                      |
| Capability selection by semantic need              | Cognition Core emits `REQUEST_CAPABILITY` after escalation                                                           | Runtime binds against current truthful descriptions                                                          | Character Model in the initial architecture, Harness, MCP server |
| Capability admission                               | Runtime                                                                                                              | Cognition proposes; Harness validates request form; MCP describes availability                               | Cognition, Harness, MCP adapter/server                           |
| MCP invocation                                     | MCP adapter/server performs one Runtime-admitted invocation                                                          | Runtime supplies lifecycle/cancellation; Cognition consumes evidence                                         | MCP continuation/loop control, Character Model                   |
| Capability-loop hard containment                   | Runtime                                                                                                              | Cognition proposes continuation; MCP reports one-call outcome                                                | Cognition, Harness, MCP adapter/server                           |
| Character generation retry disposition             | Character Harness                                                                                                    | Character adapter output and supervision signals are inputs; Runtime consumes disposition                    | Harness execution, provider routing/fallback                     |
| Actual provider retry/fallback                     | Runtime/provider infrastructure                                                                                      | Harness may request `RETRY_CHARACTER_GENERATION`, `FALLBACK_TO_COGNITION`, or `FAIL_CHARACTER_OUTPUT`        | Character Harness, Character Model                               |
| Presentation device rendering                      | Presentation                                                                                                         | Character/Harness propose intent; Runtime supplies admitted envelope                                         | Presentation admission or semantic attention                     |
| Authoritative Runtime effect lifecycle/publication | Runtime                                                                                                              | Presentation reports device outcomes; MCP/provider adapters report call outcomes                             | Presentation, Harness, models, MCP server                        |

## Stable semantic seams

The roadmap depends on four narrow seams, not a generic agent graph:

1. **Evidence to interpretation:** Memory evidence enters P8 or any future
   explicit Continuity artifact with provenance, status, temporal uncertainty,
   and scope intact.
2. **Character ABI:** the Character Model receives a stable semantic projection,
   not Runtime internal objects or provider DTOs.
3. **Normalized Cognition Result:** the Character Model receives a stable
   result meaning, not one cognition backend's raw response format.
4. **Semantic capability request:** the Character Model initially emits only
   `NEED_COGNITION`; after escalation, Cognition may emit
   `REQUEST_CAPABILITY`. Runtime admission and dynamic capability binding remain
   outside model weights. Direct Character-to-capability execution is reserved
   and non-executable in the initial architecture.

Current Character-facing context already includes recent conversation, relevant
Memory, and temporal context through the Memory vNext / Prompt path. A future
explicit Continuity/open-thread section is added only if gap-driven evaluation
requires it. Dynamic capability descriptions belong to Cognition task context
in the initial architecture; any future Character-facing capability section is
reserved and absent until an explicit later contract admits it. These are
semantic sections, not frozen wire fields.

`MODEL ABI` and `INTERNAL RUNTIME IMPLEMENTATION SCHEMA` are different:

- the Model ABI is compact, versioned by meaning, provider-neutral, safe to
  expose to a replaceable model, and tolerant of missing/unknown information;
- the internal schema may contain lifecycle identities, repositories,
  diagnostics, provider metadata, locks, leases, and storage-specific fields;
- projection into the Model ABI is one-way and selective; internal fields do
  not become character semantics merely because they exist.

## Cognition result seam

Phase 2 owns the semantic meanings of the normalized Cognition Result. The
phase-6 cognition boundary/adapter is its sole producer: it adapts
backend-specific cognition output into the stable Character-facing result
before the result leaves that boundary. The Character Harness validates,
budgets, includes, and consumes the normalized result; it does not perform a
second normalization or reinterpret raw backend output. Runtime executes and
transports the cognition request/result under lifecycle authority without
defining or reinterpreting its semantics.

The directional seam is:

`Cognition backend → phase-6 cognition boundary → NORMALIZED_COGNITION_RESULT → Character Harness → Character Model`

Candidate meanings include status, answer, key facts, evidence, uncertainty,
and caveats. Raw chain-of-thought, vendor-specific payloads, provider model
names, tool traces, and one backend's formatting are not part of the stable
seam.

## P6 compatibility freeze

P6 is an implemented and tested subset of future agency. Later phases may
generalize agency beyond text, but must preserve the current path unless an
explicitly scoped replacement proves equivalent behavior:

- user work has priority over proactive work, including proactive preemption;
- the decision is exactly `NO_OP` or `REQUEST_TEXT`;
- `NO_OP` produces no assistant text or persistence;
- `REQUEST_TEXT` permits one bounded, validated assistant-only continuation;
- an admitted attempt is one-shot and stale callbacks are fenced to their
  originating effect;
- presentation candidate identity and fresh Runtime execution/idempotency
  identity remain separate;
- no synthetic user message is created;
- no uncontrolled proactive Memory write occurs;
- proactive execution has no TTS, voice, or tool authority unless a later
  phase adds a separately admitted contract.

Future initiative may consume current Memory/time context and any later
explicit Continuity/attention context; it must not casually rewrite the proven
P6 mechanism or reinterpret random idle animation as semantic agency.

### Atomic P6 authority migration

While current P6 is active, its `ProactiveDecisionProvider` is the sole
authority deciding whether a proactive text attempt becomes `NO_OP` or
`REQUEST_TEXT`. Future Continuity, attention, or Character judgments may supply
context or candidate semantic input only through an explicitly admitted
compatible change; they must not independently admit or reject the same
user-visible proactive text effect. Character-owned silence/termination before
that migration applies to reactive conversation, not to a second proactive
speak/no-speak gate.

A future generalized-agency migration must be explicit and atomic:

1. define the replacement semantic authority;
2. prove behavioral equivalence for every frozen P6 guarantee;
3. switch authority;
4. retire the old P6 decision producer.

At no point may both decision producers independently gate one proactive
effect. User priority, `NO_OP | REQUEST_TEXT` semantics until the switch,
one-shot execution, stale-callback fencing, fresh Runtime effect identity,
idempotency/claim behavior, no synthetic user message, no proactive Memory
write authority, and no implied proactive TTS/tool authority remain frozen.

## Implementation discipline

Future implementation agents must implement the smallest unit that realizes a
proven semantic requirement. Do not create `PersonaManager`,
`ContinuityEngine`, `AgencyManager`, `CharacterService`, `ToolOrchestrator`,
`RelationshipEngine`, `TemporalManager`, or a generic agent graph merely to
mirror this roadmap. Introduce a named abstraction only when current evidence
proves multiple callers or invariants need that seam.

In particular, do not implement the formerly linear Phase 3 → Phase 4 sequence
as mandatory infrastructure. The current Memory-first context path is the
baseline. Full Temporal/Continuity work is gap-driven. Likewise, do not begin
Phases 9–13 merely because Phase 8 assets exist; the sustained real-use gate is
mandatory.

The same discipline applies to persistent-self research: do not create
`SelfManager`, `PersonalityEngine`, `AttachmentEngine`, `IdentityVectorStore`,
or automatic continual-training services merely because the north star now
mentions persistent state. Research prototypes must first establish causal
value in isolation.

## Document map

0. [Artificial Person North Star](00-artificial-person-north-star.md)
   - [Persistent Functional Self Research Program](00b-persistent-functional-self-research.md)
   - [Current Architecture Reinterpretation](00c-current-architecture-reinterpretation.md)
1. [P8 Identity, Persona, and Relationship](01-p8-identity-persona-relationship.md)
2. [Character ABI and Cognition Boundary](02-character-abi-and-cognition-boundary.md)
3. [Temporal Substrate](03-temporal-substrate.md)
4. [Continuity and Attention](04-continuity-and-attention.md)
5. [Character Harness](05-character-harness.md)
6. [Cognition and Capabilities](06-cognition-and-capabilities.md)
7. [Embodied Agency](07-embodied-agency.md)
8. [Character Behavior Assets and Deferred Post-Training](08-character-post-training.md)

## Future-state implementation atoms

The September 2026 future-state architecture self-audit is decomposed into
small-agent implementation plans under
[**Future-State Implementation Atoms**](atoms/README.md). Those files are
planning artifacts only: current source/tests/merged closure documents remain
implementation authority, and each atom requires a fresh audit before work.

## Known current-document tension

Some per-phase and older current documents still contain stale status lines from
before P8, Character ABI, Harness, Cognition, Phase 7, and Memory vNext landed.
Current source/tests, merged closure documents, and this rebaselined sequence
take precedence until those individual status headers are reconciled.

The key operational correction is that Memory vNext already supplies a thin,
live time/continuity path. A standalone full Temporal or Continuity subsystem is
not automatically “next” merely because the old roadmap numbered it earlier.
Likewise, the formal post-training roadmap is split: Phase 8 behavior assets may
proceed now, while Phases 9–13 remain intentionally deferred until sustained
real YUVI usage produces reviewed evidence.

The new persistent-functional-self documents add a second kind of tension that
should remain explicit rather than be prematurely resolved: current YUVI uses
prompt/context reconstruction because that is what today's product can run,
while the long-term research program tests whether causal state continuity can
provide something qualitatively stronger. Until those experiments pass, the
operational roadmap remains authoritative.