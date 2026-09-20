# Phase 8 — Character Behavior Assets and Deferred Post-Training

> **Status: CURRENT — behavior specification/eval/preference assets exist; model training phases 9–13 remain DEFERRED.**
>
> **Persistent-self boundary:** this roadmap improves durable Character behavior.
> It is **not** the research path by which Yuvi acquires a persistent functional
> self. See [Persistent Functional Self Research Program](00b-persistent-functional-self-research.md).

Current implementation is indexed in [the roadmap](README.md). Detailed phase plans below preserve historical design reasoning; they are not a new work queue.

## 1. Purpose

Create durable behavioral assets for Yuvi now, while postponing model selection
and weight training until the product is actually usable and has accumulated
real operational evidence.

The immediate goal is not to train a Character Model. It is to define and test
what stable Yuvi behavior means independently of today's temporary Chat model,
provider, tools, and Runtime internals.

Current product use may rely on a replaceable DeepSeek V4 Flash-class Chat model
through configured provider infrastructure. That operational model is a
baseline/substitute, not Character identity and not a training invariant.

This phase answers:

> **What Character behavior should remain desirable across replaceable models
> and environments?**

It does **not** answer:

> **How can accumulated experience causally change a continuing computational
> self over time?**

A future Character model can satisfy this document while still being
reconstructed from prompt, Memory, and current context on every inference.
Passing Phase 8 therefore cannot be used as evidence that a persistent self
exists.

## 2. Responsibility

Phase 8 behavior assets define desired priors for:

- Yuvi's social and conversational behavior;
- natural character expression;
- epistemic honesty and uncertainty behavior;
- attention and response-worthiness;
- termination and meaningful silence;
- coarse escalation to Cognition Core;
- adaptation to environment-provided semantic context;
- Yuvi-specific behavioral preferences that remain valid across environments.

The durable product assets are:

- `YUVI_BEHAVIOR_SPEC`;
- `YUVI_BEHAVIOR_EVAL`;
- `YUVI_PREFERENCE_DATASET` schema/governance rules.

Base model weights, adapters, serving backends, and the current operational Chat
model are replaceable outputs or temporary infrastructure, not the durable
source of behavior truth.

These assets specify **behavioral quality**, not ontological or functional
continuity. They should remain useful even if persistent-self research fails.

## 3. Inputs

Phase 8 may use:

- frozen Character/Cognition responsibility rules;
- Character ABI meaning catalog and versioned evaluation fixtures;
- current grounded examples from P8, Memory vNext thin temporal context,
  bounded recent context, Harness, cognition, and embodied behavior;
- prompt-only operational failure cases gathered before training;
- supervised demonstration and preference-data schemas with provenance;
- failure cases for repetition, bad termination, over-speaking, false
  familiarity, under/over-escalation, backend/tool leakage, time confusion, and
  inappropriate use of remembered context;
- environment variation across Memory, cognition, providers,
  Cognition-facing capabilities/results, and presentation;
- explicit `CHARACTER_INVARIANT` versus `ENVIRONMENT_BOUND` labels.

Only `CHARACTER_INVARIANT` content may eventually define weight objectives.
Environment-bound examples may teach adaptation to descriptions, but their
concrete names/values must not become character facts.

Real private conversations are not automatically training data. Product traces
may first be used for evaluation/failure classification under explicit data
rules; any later training-data use requires consent and provenance policy.

Experience traces collected for persistent-self research are **not** thereby
admissible Character training data. The two programs require separate evidence,
consent, provenance, and interpretation.

## 4. Outputs

### Phase 8 — allowed now

- maintained `YUVI_BEHAVIOR_SPEC`;
- maintained `YUVI_BEHAVIOR_EVAL`;
- `YUVI_PREFERENCE_DATASET` schema, labels, provenance, consent, and review
  policy;
- prompt-only/operational baseline results;
- failure taxonomy and evidence for later model-selection decisions.

### Phases 9–13 — intentionally deferred

Only after Yuvi is landed, used for a sustained period, and has enough reviewed
real-world evaluation evidence may the program produce:

- base-model bakeoff evidence and candidate selection;
- QLoRA SFT adapter/checkpoint and training report;
- DPO adapter/checkpoint and preference report;
- shadow/A-B results and regression decisions;
- an iterative, provenance-aware preference-data flywheel.

No current Phase-8 work authorizes training, model selection, or deployment.

### Explicit non-output

This roadmap does not produce or claim:

- persistent recurrent self state;
- self-state transition dynamics;
- online identity adaptation;
- experience-conditioned continual learning;
- automatic personality consolidation;
- a proof of functional continuity.

Those belong to separate research.

## 5. Authority boundaries

| Candidate owner                     | Boundary audit                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                             | Supplies architecture, execution truth, traces, and evaluation environments; weights must not learn current Runtime fields or replace Runtime admission.                                                  |
| Memory                              | Supplies authorized evidence/context under current policy; training data must not turn Memory content into universal Persona truth.                                                                       |
| P8                                  | Defines stable identity/persona/relationship semantics for the current product; behavior assets and later post-training cannot silently redefine P8.                                                       |
| Temporal / Memory time context      | Current thin temporal projection supplies grounded time context; later weights learn to interpret provided time, not invent authoritative elapsed reality.                                                |
| Continuity                          | No separate explicit Continuity authority is currently required for product landing; if one is later introduced, weights consume its projection rather than invent its durable state.                     |
| **Character Model / post-training** | Later owns learned social, epistemic, attention, termination, escalation, and expression priors because these should generalize across environments.                                                      |
| Persistent-self research            | Separately tests causal history-dependent internal state and, only later, slow experience-conditioned consolidation; Phase 8 does not own or imply this research result.                                   |
| Cognition Core                      | Provides serious reasoning during product use/evaluation; its model identity and raw outputs must not be baked into Character weights.                                                                    |
| Character Harness                   | Supplies stable ABI/supervision and collects bounded failure outcomes; post-training cannot replace Harness generation safeguards.                                                                        |
| MCP capability layer                | Supplies dynamic environment-bound capability descriptions to Cognition; direct Character capability execution remains reserved, and concrete names/servers/tools are excluded from character invariants. |
| Presentation                        | Supplies causal behavior outcomes and preferences; incidental animation/device details must not define character identity.                                                                                |

Stable behavior belongs in weights only when it remains desirable after every
backend and environment component is replaced.

This rule does not imply that the weights thereby become Yuvi's persistent self.

## 6. Hard invariants

- Every dataset item intended to influence future weights is classified as
  `CHARACTER_INVARIANT` or `ENVIRONMENT_BOUND` before training use.
- Stable weights may eventually encode social prior, natural conversation,
  epistemic behavior, termination/silence, coarse escalation, environment
  adaptability, and Yuvi-specific preference.
- Character weights learn coarse `NEED_COGNITION`, not
  `REQUEST_CAPABILITY`; direct Character-to-capability execution remains
  reserved/non-executable in the initial architecture.
- Weights must not encode DeepSeek, DeepSeek V4 Flash, DeepInfra, a specific
  model size, concrete MCP tool/server names, provider names, Runtime field
  names, database implementation, or raw Cognition Result format.
- The current Chat model is replaceable operational infrastructure, not Yuvi's
  identity.
- Phase 8 behavior assets may proceed before custom Character training.
- Phase 9 base-model bakeoff is blocked until sustained real product use has
  produced reviewed evaluation evidence.
- Phase 10 SFT is blocked until a Phase-9 selection exists and reviewed
  invariant demonstrations exist.
- Phase 11 DPO is blocked until a passing SFT artifact and reviewed preference
  pairs exist.
- Phase 12 shadow/A-B is blocked until a candidate passes durable offline eval.
- Phase 13 flywheel is blocked until real deployment/data governance and
  consent gates are in place.
- Post-training does not compensate for missing Runtime architecture or unclear
  semantic ownership.
- Post-training is not a formal guarantee against repetition or semantic loops;
  Harness supervision remains mandatory.
- Raw private conversation is not training data by default.
- Model weights remain replaceable; spec/eval/data remain durable.
- Static Character post-training must not be described as experience-driven
  personality development unless an independent continual-learning experiment
  demonstrates that causal property.
- A Character adapter trained from curated examples is a behavioral prior, not
  evidence that the deployed Yuvi lived those examples.
- Phase 8 must not absorb persistent-state or slow-consolidation research merely
  because both may eventually use adapters or preference data.

## 7. Explicit non-goals

- Beginning base-model bakeoff, QLoRA, DPO, shadow/A-B, or preference-flywheel
  operation before Yuvi has been landed and used for a sustained period.
- Training Cognition Core to sound like Yuvi.
- Treating the temporary DeepSeek V4 Flash Chat model as the Character Model.
- Baking current environment configuration into character identity.
- Using fine-tuning to hide architectural ambiguity, unsafe capability
  admission, weak generation supervision, or Memory retrieval errors.
- A one-time static dataset with no provenance, consent, or regression policy.
- Optimizing only for response preference while ignoring silence and
  escalation.
- Claiming that SFT/DPO creates persistent selfhood.
- Treating a Character LoRA as the storage location for accumulated lived
  history by default.
- Automatic online fine-tuning from conversations.
- Periodic personality consolidation without state/parameter compatibility,
  rollback, poisoning, and drift research.

## 8. Dependencies and gate to training

### Phase 8 dependencies

Behavior-spec/eval work may proceed using the semantics already implemented and
closed enough to evaluate: P8, Character ABI, the current Harness/Cognition
slice, embodied agency, and the operational Memory-first time/continuity path.
A full standalone Temporal or Continuity subsystem is not a prerequisite.

Persistent-self research is also **not** a prerequisite for Phase 8. Product
behavior work should not wait for an unsolved research program.

### Phase 9 gate

Phase 9 does **not** begin merely because Phase 8 documents exist. Before a
base-model bakeoff starts, Yuvi must:

1. be operational as a real companion product rather than only an architecture
   harness;
2. run for a sustained period using the replaceable prompt/provider Chat path;
3. accumulate reviewed failure/evaluation evidence across ordinary daily use;
4. establish data governance, consent, redaction, retention, and provenance
   rules for any real usage that may inform later preference data;
5. show which deficits are model-behavior deficits rather than prompt, Memory,
   retrieval, Runtime, or presentation defects.

This gate prevents training effort from optimizing temporary architecture or
invented benchmark needs.

It remains separate from the research gates required before any future
experience-conditioned consolidation experiment could be considered for product
integration.

## 9. Relationship to existing implementation

**CURRENT:** Yuvi uses provider-configured replaceable models and prompt
instructions. The current default Chat path is an OpenAI-compatible remote
DeepSeek V4 Flash-class model, while serious reasoning remains separately
routed. Provider/model names are configuration, not Character semantics.

Memory vNext already provides detailed recent episodic context, bounded
associative long-term recall, and thin temporal labels into the live prompt.
This operational path should be exercised before introducing a custom Character
checkpoint so failures can be attributed correctly.

P6 provides useful examples of meaningful `NO_OP`, bounded text,
malformed-output rejection, one-shot behavior, and user priority. Current
provider normalization, P8 grounding, and Memory provenance provide
quality/authority precedents.

**NEXT / PHASE 8:** define durable behavior spec, eval, and dataset-governance
assets. Evaluate the current prompt/provider baseline and record failures.

**DEFERRED / PHASES 9–13:** model bakeoff, QLoRA SFT, DPO, shadow/A-B, and the
preference-data flywheel wait for sustained real YUVI use and reviewed evidence.

**SEPARATE RESEARCH:** persistent learned state, self-inertia, action-conditioned
development, and slow experience consolidation follow
[`00b-persistent-functional-self-research.md`](00b-persistent-functional-self-research.md).
They are not Phase 9–13 extensions.

## 10. Staged implementation shape

1. **Phase 8A — `YUVI_BEHAVIOR_SPEC`:** define stable social, epistemic,
   silence/termination, escalation, Memory-use, and environment-adaptation
   behavior without provider/model names.
2. **Phase 8B — `YUVI_BEHAVIOR_EVAL`:** encode adversarial and natural scenarios
   that can score the current prompt/provider baseline as well as future models.
3. **Phase 8C — `YUVI_PREFERENCE_DATASET` schema/governance:** define
   provenance, consent, redaction, labeling, review, and
   `CHARACTER_INVARIANT | ENVIRONMENT_BOUND` policy. Building a large training
   corpus is not required now.
4. **Operational interval:** land Yuvi, use the current replaceable Chat model,
   gather reviewed eval failures, and fix non-model defects first.
5. **Phase 9 — deferred gate:** run a base-model bakeoff only after the
   operational interval satisfies Section 8.
6. **Phase 10 — deferred:** QLoRA SFT on reviewed invariant demonstrations.
7. **Phase 11 — deferred:** DPO on reviewed preference pairs.
8. **Phase 12 — deferred:** shadow and controlled A/B evaluation.
9. **Phase 13 — deferred:** operate a consented preference-data flywheel with
   regression gates and dataset versioning.

Each later stage can stop without changing Runtime semantics if evidence is
insufficient or evaluation fails.

None of these stages should be renamed or reinterpreted as persistent-self
research. If the research track later needs adapters, LoRA, or preference
learning, it should define its own hypotheses, baselines, interventions, and
failure criteria.

### Phase 8–13 stage authority contracts

| Stage                         | Owns                                                                                                                                                | Consumes                                                                     | Emits                                                                  | Does not own                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 8 — Behavior assets           | Semantic target definition in `YUVI_BEHAVIOR_SPEC`, measurement definitions in `YUVI_BEHAVIOR_EVAL`, and provenance/governance-ready dataset schema | Current stable semantic seams, operational prompt traces, approved governance rules | Versioned spec, eval, schema/policy, and baseline evidence             | Runtime/P8 redesign, weight transformation, model selection, deployment admission, persistent-self claims |
| 9 — Base-model bakeoff        | Candidate comparison and selection evidence against the durable eval                                                                                | Passing Phase-9 gate, Phase-8 spec/eval, candidates, local constraints       | Bakeoff report and evidence-supported candidate selection              | Changing semantic targets, SFT/DPO, deployment admission, self-continuity evidence          |
| 10 — SFT                      | Weight transformation from reviewed `CHARACTER_INVARIANT` demonstrations                                                                            | Selected base model, reviewed demonstrations, ABI/eval versions              | QLoRA SFT checkpoint/adapter and training report                       | Relabeling data, redefining behavior semantics, Runtime authority, lived-experience consolidation |
| 11 — DPO                      | Preference optimization from reviewed pairs                                                                                                         | Passing SFT artifact, reviewed preference pairs, durable eval                | DPO checkpoint/adapter and preference report                           | Consent/data-governance policy, semantic target redefinition, deployment admission, persistent self |
| 12 — Shadow/A-B               | Controlled measurement and deployment-readiness evidence                                                                                            | Candidate artifact, durable eval, admitted shadow/A-B environment            | Shadow/A-B results, regression evidence, readiness recommendation      | Runtime admission, automatic promotion/deployment, semantic authority, selfhood claims      |
| 13 — Preference-data flywheel | Consented, reviewed dataset revision and regression-input versioning                                                                                | Admitted consented traces, reviewed labels/preferences, evaluation failures  | Versioned dataset revisions and evidence for a later training decision | Automatic retraining/deployment, silent weight updates, P8/Runtime/Continuity redefinition, online self consolidation |

No stage may silently redefine P8, Runtime, Memory, Cognition, MCP, Presentation,
or any future Continuity semantics. Evaluation evidence and readiness
recommendations do not themselves grant deployment or effect authority.

## 11. Phase 8 acceptance concept

Phase 8 is acceptable when the repository has durable, versioned behavior
semantics and an evaluation suite capable of measuring both the current
DeepSeek V4 Flash-class prompt/provider baseline and future Character models;
when failure attribution distinguishes model behavior from Memory/prompt/Runtime
failures; and when dataset governance prevents environment-bound/private data
from silently becoming Character invariants.

The eval must cover at least false familiarity, invented relationship state,
over-speaking, endless continuation, repetition/semantic loops, bad EOS,
under/over-escalation, capability/provider-name leakage, raw cognition-format
leakage, Memory scope leakage, time confusion, misuse of associated old memory,
uncertainty fabrication, and environment replacement.

Passing Phase 8 does not authorize Phase 9. The operational gate in Section 8
still applies.

Passing Phase 8 also does not count as evidence for the persistent-functional-
self milestones. Those require causal state interventions defined by the
separate research program.

## 12. Risks

- Treating the current DeepSeek V4 Flash provider path as the permanent
  Character design.
- Designing training objectives from synthetic architecture assumptions before
  real daily use exposes actual problems.
- Dataset contamination by current provider/tool/Runtime names.
- Preference optimization that rewards verbosity or constant engagement over
  meaningful silence.
- Memorizing private user evidence as character invariant.
- Training on model-generated labels without independent review/provenance.
- Overfitting one ABI serialization or one base model.
- Using DPO to conceal weak SFT data or unresolved architecture.
- Removing Harness safeguards after benchmark gains.
- Treating model weights as the only durable character asset.
- Mistaking a better roleplayed personality for a more persistent self.
- Feeding autobiographical traces into SFT and then claiming that the model
  personally accumulated those experiences.
- Reusing continual-learning terminology in Phase 8–13 without the causal
  experiments necessary to distinguish learning from reconstruction.

## 13. Open questions

Phase 8 should answer now:

- What behavior is truly invariant across providers and future model changes?
- Which scenarios best expose false familiarity, over-speaking, bad silence,
  time confusion, and inappropriate Memory intrusion?
- What evidence format best separates prompt/Memory defects from model defects?
- What consent/provenance rules would make later preference data admissible?

Questions intentionally postponed until after sustained real use:

- Which base-model candidates deserve a bakeoff?
- What local latency/quality tradeoff is acceptable for the eventual Character
  model?
- What training mixture, QLoRA configuration, DPO objective, and A/B stopping
  rules are justified by actual failures?

Questions intentionally assigned to persistent-self research instead:

- Can a learned state carry causal history across inference boundaries?
- Can that state resist irrelevant tone while remaining revisable by evidence?
- Can the agent's own actions and consequences change future state?
- Does a latent state outperform matched text-state reconstruction for the
  intended continuity claim?
- When, if ever, should repeated lived experience be consolidated into learned
  parameters?
- How can live state remain compatible with slowly changing parameters?

## 14. Handoff boundary

Phase 8 hands the operational Yuvi product a durable behavior target and eval,
not a training mandate and not a selfhood claim. The immediate sequence is:

`behavior spec/eval/schema → operate Yuvi with replaceable Chat model → collect reviewed real failures → fix non-model defects → Phase-9 gate review`

Only after that review may Phase 9 begin. Phases 10–13 remain downstream of
their own evidence gates. No stage may change Runtime, P8, Memory, Cognition,
MCP, Presentation, or future Continuity authority merely to improve a training
score.

Persistent-self research proceeds independently:

`minimal persistent state → causal history test → self-inertia → action-conditioned development → Memory/text baselines → only then slow consolidation`

The two paths may eventually meet, but neither is allowed to borrow the other's
success criteria.