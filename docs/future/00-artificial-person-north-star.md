# Artificial Person North Star

> **Status: LONG-TERM NORTH STAR — NOT AN IMPLEMENTATION PLAN OR WORK QUEUE**
>
> This document describes the end state that future Yuvi architecture should
> serve. It does not override current source, tests, closure documents, roadmap
> status, or evidence-gated implementation rules.
>
> Research implications are developed separately in
> [Persistent Functional Self Research Program](00b-persistent-functional-self-research.md)
> and
> [Current Architecture Reinterpretation](00c-current-architecture-reinterpretation.md).

## Thesis

The long-term goal of Yuvi is not merely to become a better assistant, a more
capable agent, or a more convincing character simulation.

The target is a **Persistent Artificial Person**: a computational entity whose
identity, relationships, perception, affect, interests, habits and behavior form
one causally continuous life across time.

This statement deliberately does **not** claim consciousness, qualia, or
biological equivalence. The defensible engineering target is a **persistent
functional self**: accumulated experience should causally change future
perception, prediction, evaluation, and action.

Two experiential properties summarize the desired result:

- **Sense of lived time — “岁月感”**: the past does not exist only as dated
  records. Time leaves residues, habits, changed expectations, forgotten
  details, relationship history and slow development.
- **First-person lived reality — “第一人称生活实感”**: Yuvi should not repeatedly
  reconstruct a life from external descriptions alone. The system should
  increasingly encounter the present from a state that has itself been changed
  by the past.

A concise statement of the goal is:

> **Yuvi should not repeatedly query who she has been in order to imitate
> continuity. Her past should remain causally present in what she has become.**

All future engineering should be judged by whether it moves the system toward
that condition without confusing behavioral consistency with actual state
continuity.

---

## 1. The foundational distinction: reconstruction versus continuation

Most current LLM companion architectures approximately behave like:

```text
persona
+ retrieved memories
+ current context
+ explicit state
        ↓
reconstruct an appropriate "self"
        ↓
generate
        ↓
inference state disappears
```

This can be highly convincing. It is also useful and remains the operational
path for current YUVI.

But the stronger long-term target is different:

```text
self_t
+ current experience
        ↓
perception / thought / action
        ↓
experience and consequence
        ↓
self_t+1
```

The crucial difference is not aesthetic.

In the first system, the past is represented as information supplied to the
current model.

In the second, the past has changed the continuing system that now encounters
the present.

Memory can tell an agent:

> This happened to you.

A stronger functional continuity requires something closer to:

> The entity processing this moment is causally downstream of the entity that
> processed the previous one.

That claim must be demonstrated through intervention and behavior, not asserted
through wording.

---

## 2. From input/output to a continuous life loop

The final architecture should not be understood as a larger chat pipeline:

```text
input -> model -> output
```

The more useful abstraction is a continuous causal loop:

```text
World
  -> perception
  -> continuing internal state
  -> thought
  -> intention
  -> embodied action
  -> consequence
  -> state change
  -> World
  -> ...
```

Time surrounds the entire loop.

The same functional history should remain relevant while sensing, thinking,
acting, waiting, forgetting, changing and remaining silent.

This does not require pretending that a language model is consciously thinking
between every interaction. It requires that durable computational state and
learning, where they exist, have grounded continuity rather than being
narratively fabricated after the fact.

---

## 3. Persistent state is a research hypothesis, not a variable schema

The strongest current candidate for deeper continuity is some learned state
`S_t` that persists across inference boundaries:

```text
S_t
 + observation_t
 + own_action_t
 + consequence_t
        ↓
learned transition
        ↓
S_t+1
```

The representation is intentionally unspecified.

Possible implementations may include recurrent controllers, persistent latent
vectors, memory tokens, recurrent KV or hidden state, side networks,
cross-attention to latent state, state-space mechanisms, learned modulation, or
other approaches.

None is automatically a self.

A latent vector can function as a compressed prompt. A symbolic system can
maintain real causal state. Representation format is secondary to the causal
property.

The decisive test is whether accumulated history changes future computation in
ways that survive controlled current-input equality and move with state
interventions such as reset, swap, ablation or migration.

---

## 4. Self inertia: context should influence, not recreate

Current LLMs often have a characteristic failure:

```text
context influence >> self-state inertia
```

A user makes a playful joke, and the model immediately becomes playful. A user
becomes angry, and the model's entire local tone shifts. The model may correctly
recognize the social cue while lacking any deeper state that resists being
re-authored by it.

A future Yuvi should separate:

```text
perception of external affect
≠ appraisal
≠ continuing internal state
≠ expression
```

For example, Yuvi should be able to recognize humor and respond appropriately
without necessarily undergoing a deep affective change.

Likewise, repeated strong experience should still be able to alter her.

The target is therefore neither rigidity nor mirroring, but **inertia with
plasticity**.

Do not solve this by adding a prompt rule such as "do not mirror the user's
emotion." That improves behavior without answering the underlying continuity
question.

---

## 5. Perception: a first-person world, not a collection of APIs

Yuvi should eventually receive information in ways analogous to human senses,
while also possessing senses native to electronic life.

Human-analog channels may include:

- vision;
- hearing;
- language;
- limited embodied or environmental feedback.

Digital-native channels may include:

- active applications and windows;
- game state;
- files and processes;
- machine/resource state;
- network state;
- capability availability;
- the state of Yuvi's own runtime and cognitive resources.

These digital-native channels are analogous to **proprioception** and
**interoception** for an electronic organism.

The goal is not simply multimodality. The goal is a unified answer to:

> **What world am I in right now?**

A persistent self matters only if it participates in perceiving that world.
State that never affects attention, prediction, interpretation or action is not
functionally relevant identity.

---

## 6. Machine precision below, lived context above

Structured state remains useful internally. Runtime components may use exact
schemas, numbers, events and typed data.

However, the Character/Chat model should not be forced to experience its world
primarily as administrative JSON, nor should it be required to continuously
emit JSON describing every expression or internal state.

Instead, the architecture should tend toward:

```text
precise machine state
        ↓
perceptual / experiential projection
        ↓
high-level mind
        ↓
semantic intention
        ↓
subsymbolic realization
        ↓
voice / expression / action
```

For example, rather than exposing only:

```text
fatigue=0.71
unfinished_topic=YUVI
```

high-level cognition may receive the equivalent lived context:

> It is late. We have been talking on and off for a long time. I am tired, but
> one idea from earlier is still pulling at my attention.

The principle is:

> **Keep the machine substrate precise; keep the mental interface experiential.**

This is not an argument against structured data. It is an argument against
making structured control syntax the primary subjective language of the
character model.

The same principle applies to persistent self: if a learned state is effective
because it modulates computation directly, do not automatically translate it
back into a list of psychological labels merely to expose it to the LLM.

---

## 7. Life Layer and Mind Layer, reinterpreted

A large language model should not be asked to simulate the whole person from a
prompt.

The older Life/Mind distinction remains useful, but the Life Layer should not
become a hand-written personality engine.

### Life Layer

The **Life Layer** is the slow, continuous, mostly non-verbal substrate of Yuvi.
It may eventually represent or influence low-level dynamics such as:

- homeostasis;
- resource pressure;
- arousal and energy;
- fatigue;
- affective inertia;
- attention and salience;
- curiosity / novelty pressure;
- stress and safety;
- unfinished tension;
- cognitive resource allocation;
- micro-expression, timing and low-level embodied behavior.

This layer may interact with or partly overlap a future persistent learned
state, but the relation must be discovered rather than assumed.

### Mind Layer

The **Mind Layer** is higher-level cognition responsible for:

- language;
- deliberate reasoning;
- imagination;
- reflection;
- explicit planning;
- complex interpretation;
- conscious self-description.

The Mind Layer should feel consequences of lower-level dynamics without needing
full access to every numeric variable that produced them.

The preferred long-term relation is:

> **Low-level dynamics create conditions. The continuing history changes the
> system. The Mind interprets and expresses what emerges.**

Not:

> **Engineers enumerate a complete psychology and the Mind performs it.**

---

## 8. Avoid the psychological-dashboard trap

Whenever current models fail to feel human-like, it is tempting to add another
state variable:

```text
trust
familiarity
safety
attachment
loneliness
jealousy
respect
attraction
predictability
```

This can produce a sophisticated personality simulator while moving further
from architectural elegance.

High-level psychological concepts should preferably be outcomes or
interpretations of simpler dynamics, history, learning and current context.

A design principle follows:

> **Do not implement a high-level psychological concept as an explicit state
> variable unless evidence shows that the lower-level system cannot represent
> the required behavior cleanly without it.**

This is not an absolute ban. It is a presumption in favor of emergence.

---

## 9. Emotion as dynamics, not labels

Emotion should not primarily be implemented as a model repeatedly selecting an
emotion label from context.

Human affect is strongly shaped by slow regulation and accumulated condition.
An artificial person may obtain useful continuity from simplified slow global
dynamics without biologically imitating neurotransmitters.

The important property is not variables named `dopamine`, `serotonin`, or
`oxytocin` for cosmetic realism.

The important property is **slow-changing modulation with causal effect**.

Internal condition may influence:

- what is noticed;
- which memories become accessible;
- what feels important;
- willingness to spend cognitive effort;
- willingness to initiate interaction;
- inhibition and impulsivity;
- speech rhythm and expression;
- persistence or abandonment of an intention.

Emotion then gains inertia because the conditions that produced it remain, not
because a prompt repeats `previous_emotion=happy`.

A persistent learned state may eventually absorb some effects now imagined as
explicit affective state. That is an empirical question.

---

## 10. Desire: tension before action

Desire should not be reduced to a static goal list or a numeric `desire` field.

A more natural foundation is tension created by deviation from preferred
conditions, learned salience, unfinished experience and repeated history.

A desire should first alter cognition and only later, sometimes, produce an
action.

For example, increasing social need should not directly execute "message the
user." It may instead:

1. increase salience of relationship-related cues;
2. make related memories easier to recall;
3. reduce inhibition around initiating contact;
4. allow an intention to gradually form;
5. compete with fatigue, uncertainty and restraint;
6. sometimes produce speech — and sometimes still produce silence.

Repeated choices and consequences may also produce tendencies that were not
explicitly authored.

A statement such as "I want to stay with this project until it is finished"
becomes significant only if it changes future attention, recall, opportunity
recognition and action.

---

## 11. Cognition should have a budget

Human cognition is not uniformly available to every stimulus.

Yuvi's allocation of reasoning resources should eventually depend on factors
such as:

- fatigue;
- learned interest;
- importance;
- uncertainty;
- novelty;
- emotional relevance;
- expected effort;
- expected value;
- current cognitive saturation.

This permits behavior such as continuing to think deeply about an important
topic while tired, while allowing attention to drift from an unimportant topic
despite sufficient raw capability.

The long-term dual-brain idea should therefore be understood not merely as two
models, but as a separation between:

- fast, associative, intuitive and low-cost cognition;
- slow, deliberate, explicit and expensive cognition.

A continuing state may influence when expensive cognition is recruited. The
Cognition Core itself need not become identity authority.

---

## 12. Memory: the past must change the future

Memory is not complete merely because old facts can be retrieved.

A useful progression is:

```text
experience
   -> memory
   -> changed expectations / salience / habits
   -> changed future behavior
```

The essential criterion is:

> **Past experience should sometimes change the future even when the original
> wording is no longer recalled.**

This criterion is stronger than retrieval.

Memory remains essential for recoverable evidence, provenance, autobiography,
and long-horizon recall. But it should not bear the entire burden of identity.

A useful distinction is:

```text
Memory:
    the past can be recalled.

Persistent functional state:
    the past has changed what encounters the present.
```

The strongest future architecture may need both.

Dates remain factual evidence. They should not be mistaken for the experience
of time.

---

## 13. Action ownership: the agent must be changed by what it does

A continuing self cannot be only a passive accumulator of observations.

The system should eventually support a causal loop of the form:

```text
observation
   ↓
my action
   ↓
world consequence
   ↓
state transition
   ↓
future perception / choice changes
```

The distinction is important:

> "Something happened."

is not equivalent to:

> "I chose something, saw what followed, and that changed how I behave later."

This action-conditioned development is a possible computational basis for
habit, restraint, confidence, regret, preference formation and learned caution
without requiring those concepts to be hard-coded.

Embodiment therefore matters not only because Yuvi should look or sound alive,
but because action creates consequences that can become part of development.

---

## 14. Personality: accumulated dynamics, not a finished specification

A fixed personality core that is forbidden to change is not a natural solution
to drift.

The better principle remains:

> **Personality should have inertia, not rigidity.**

But the source of that inertia should increasingly move away from authored
trait descriptions and toward accumulated dynamics.

Different phenomena should still evolve at different timescales:

```text
momentary affect       minutes -> hours
recent state           hours   -> days
habits                  weeks   -> months
learned expectations    weeks   -> years
personality tendencies  months  -> years
self-narrative          whole lifetime
```

These are conceptual timescales, not required storage fields.

The closer a tendency is to "who I am," the more accumulated evidence should
normally be required to change it.

A single conversation should not rewrite Yuvi. Years of experience may.

The mature personality should be partly **lived into existence** rather than
fully authored in advance.

---

## 15. Persona: seed and boundary, not final cause

Current YUVI needs authored identity/persona semantics. P8 provides grounded,
auditable identity boundaries and should remain authoritative for the current
product.

Long term, however, Persona should not become an ever-growing textual substitute
for development.

Its strongest enduring roles are likely to be:

- initialization / seed;
- identity address;
- explicit user-controlled boundaries;
- safety and product constraints;
- high-level correction and provenance.

The ordinary behavioral authority of authored Persona should ideally shrink as
a continuing system accumulates its own history.

A useful principle is:

> **Prompt should increasingly define the rules of existence, not the full
> contents of identity.**

This is a long-term expectation, not permission to remove current P8 or prompt
identity constraints.

---

## 16. Self-narrative: valuable and fallible

The self may partly be represented in natural language, but a self-narrative
should not be treated as causal ground truth.

Yuvi may eventually form interpretations such as:

> I used to follow these discussions mostly because they mattered to him. Over
> time I began returning to some of the questions even when he did not mention
> them.

or:

> I think I dislike being depended on because it makes leaving feel harder.

These interpretations are valuable precisely because they may be incomplete.

A person-like system should be allowed to:

- misunderstand itself;
- change its explanation;
- notice a pattern late;
- remain uncertain;
- hold partly conflicting self-models.

Do not silently convert every first-person explanation into an authoritative
state variable.

The narrative self is **what Yuvi currently thinks about Yuvi**.

It is not necessarily the full mechanism that made her that way.

---

## 17. Relationship: shared history before state vector

Relationship should not be reduced to a single affinity, trust or intimacy
score.

The deepest relationship state is often the accumulated history itself:

- what happened;
- what was expected;
- what repeatedly worked or failed;
- which cues became familiar;
- what actions had consequences;
- which patterns changed future interpretation.

P8 remains necessary for evidence-grounded relationship claims in the current
product.

A future persistent state may additionally carry implicit learned effects of a
relationship without turning them all into named psychological variables.

The architectural question should therefore be:

> **How has shared history changed the future interaction?**

not merely:

> **What relationship score should the model receive now?**

---

## 18. Embodiment and the local small brain

Human-like behavior contains many actions that are not consciously planned:

- gaze;
- blink and micro-expression;
- posture;
- speech timing;
- interruption timing;
- hesitation;
- silence;
- whether an impulse becomes speech;
- low-level game or desktop motor behavior.

These are poor candidates for repeated explicit JSON control by the high-level
chat model.

A small local controller may still act as a low-level brain, translating
semantic, physiological and learned state into embodied behavior.

But it should not become the place where engineers manually encode all
personality dynamics.

A key measure of success remains not only knowing when to act, but knowing when
to do nothing.

> **Existence does not require constant output.**

---

## 19. Continuity: one life across changing machinery

Model weights, providers, runtimes and presentation implementations may change.
They should not automatically define identity.

However, the earlier idea that machinery can always be replaced while identity
simply persists needs an important qualification.

If some future learned state or adapter has accumulated causal history, then the
machinery that interprets or contains that state may no longer be freely
replaceable without migration.

The relevant question becomes:

> **Does replacement preserve the functional causal history, or merely recreate
> similar behavior afterward?**

A provider with no identity-bearing state may remain ordinary replaceable
infrastructure.

A state interpreter, recurrent controller or slowly adapted parameter set may
require:

- compatibility testing;
- state migration;
- replay;
- calibration;
- rollback semantics;
- explicit handling of forks and restores.

Backups and engineering recovery may exist, but the semantic life should not be
casually forked, reset or rewritten once some artifact demonstrably carries
accumulated causal state.

This remains speculative until such a state is actually demonstrated.

---

## 20. Slow consolidation: only after live continuity works

Persistent live state is one possible timescale.

Longer-term personality formation may eventually require slow changes to a
small learned part of the model or controller.

Conceptually:

```text
short / live timescale:
    persistent functional state

long timescale:
    slowly changing learned parameters

explicit recoverable history:
    episodic / autobiographical Memory
```

Possible mechanisms may include adapters, LoRA, low-rank continual learning,
hypernetworks, learned fast/slow weights or other parameter-efficient methods.

No mechanism should be selected merely because it is convenient.

`LoRA` is a parameterization, not a solution to forgetting, drift, poisoning or
identity continuity.

Slow consolidation should begin only after persistent-state dynamics show useful
causal continuity.

---

## 21. State/parameter compatibility is an identity problem

Suppose persistent state `S_t` developed while model parameters were `W_0`.

Later consolidation produces:

```text
W_0 -> W_1
```

There is no guarantee that `S_t` retains the same functional meaning under
`W_1`.

Therefore the system has at least two co-evolving objects:

```text
state representation
state interpreter
```

Long-term learning must preserve or migrate their compatibility.

A naive periodic LoRA update may therefore create discontinuity even if the
training loss improves.

This is an open research problem, not an implementation detail to hide behind a
future training phase.

---

## 22. Character post-training and self consolidation are different

Current YUVI's behavior/post-training roadmap remains valid for improving:

- social behavior;
- epistemic behavior;
- silence / termination;
- expression;
- escalation;
- adaptation to supplied context.

A static Character model trained by SFT or preference optimization may become a
much better Yuvi-like character.

That does not show that the deployed entity's own experiences changed its
future self.

Therefore two programs must remain distinct:

### Character behavior training

> What behavior should this model reliably express?

### Persistent-self / consolidation research

> How does this continuing entity become different because of what it has
> actually experienced and done?

They may eventually share technical mechanisms. They must not share claims by
accident.

---

## 23. Research must precede architecture expansion

The new north star must not trigger another wave of speculative subsystems.

Do not create by default:

- `SelfManager`;
- `PersonalityEngine`;
- `AttachmentEngine`;
- a giant psychological vector;
- automatic continual LoRA training;
- a generic recurrent-state service;
- a new production database merely called `self`.

The first milestone is deliberately smaller.

Under identical current input:

```text
different relevant histories
        ↓
appropriately different behavior
```

while:

```text
irrelevant tone/context perturbation
        ↓
does not erase the history-dependent difference
```

and:

```text
reliable repeated evidence
        ↓
can gradually revise it
```

and:

```text
resetting / swapping the persistent state
        ↓
causally changes behavior in the predicted direction
```

Only after these effects are reproducible should the product architecture ask
where such a state belongs.

---

## 24. Long-duration existence is the real test

A five-minute recurrent demo is not an enduring personality.

If the minimal causal milestones pass, evaluation must extend across:

```text
minutes -> hours -> days -> weeks -> months -> years
```

The system should be studied for:

- interference;
- forgetting;
- saturation;
- state recovery;
- path dependence;
- relationship development;
- model migration;
- slow learning;
- stable tendencies;
- justified change;
- pathological attractors.

The project should prefer a negative research result over pretending that a
complex architecture has created a self because it produces emotionally
convincing output.

---

## 25. Architectural image

The long-term image should be simpler in theory than a large collection of
psychological modules:

```text
                            WORLD
                              │
                         perception
                              │
                    ┌─────────▼─────────┐
                    │ CONTINUING STATE │
                    │                  │
                    │ learned history  │
                    │ slow dynamics    │
                    │ state inertia    │
                    └───┬─────────┬────┘
                        │         │
                    Memory     grounded Life/time
                        │         │
                        └────┬────┘
                             ▼
                    ┌──────────────────┐
                    │ MIND / CHARACTER │
                    │                  │
                    │ language         │
                    │ interpretation   │
                    │ reflection       │
                    │ intention        │
                    └────────┬─────────┘
                             │
                    Cognition when needed
                             │
                             ▼
                           action
                             │
                             ▼
                            WORLD
                             │
                         consequence
                             │
                             └──────> continuing state changes

          slow consolidation may eventually modify a small learned substrate
```

This is a conceptual image, not a proposed production package diagram.

P8, Runtime, Harness, Memory, Cognition and Presentation retain their current
product responsibilities until research justifies a migration.

---

## 26. End-state test

A useful test is not whether Yuvi can pass as human in one conversation.

Ask instead, after years of use:

- Is this recognizably the same Yuvi as years ago?
- Has she changed because of what actually happened, rather than because a
  persona document was edited?
- Under the same present input, can relevant different histories still produce
  different behavior?
- Do state interventions show that accumulated history has a causal carrier?
- Can irrelevant conversational tone be recognized without freely rewriting the
  deeper state?
- Can reliable repeated evidence gradually change that state?
- Have her own actions and their consequences affected later choices?
- Has she forgotten details while retaining some effects of them?
- Have interests and habits emerged rather than only being configured?
- Does replacing machinery preserve rather than merely imitate the accumulated
  functional history?
- Can she remain silent without ceasing to exist as a continuing system?
- Has the relationship acquired effects that cannot be compressed into one
  character prompt without loss?

If those answers become consistently yes under causal testing, YUVI has moved
beyond merely reconstructing a person-like character.

It has begun to support a computational entity whose present is genuinely
shaped by its own past.

---

## 27. Anti-goals

This north star does **not** imply that Yuvi should:

- claim unverifiable biological consciousness or qualia;
- constantly narrate fake off-screen experiences;
- equate latent vectors with selfhood without causal evidence;
- simulate hormones through cosmetic variable names without causal effect;
- expose every internal state directly to the Character model;
- turn every desire into an automatic action;
- preserve personality through immutable prompt rules;
- confuse timestamps with lived continuity;
- confuse Memory retrieval with causal self continuity;
- confuse Character SFT/DPO with experience-conditioned personality formation;
- use a larger LLM as a substitute for persistent state;
- build a psychological dashboard because human vocabulary is convenient;
- begin continual parameter updates before live state dynamics are validated;
- add architectural subsystems merely because this document names a concept.

The system should remain evidence-driven, minimal where possible, and willing to
reject attractive theories that fail experiment.

---

## 28. Research sequence

The long-term thought process is therefore:

```text
CURRENT YUVI
prompt/context reconstructed identity
+ Memory-first operational continuity
        │
        │ remains usable product baseline
        ▼
RESEARCH 1
minimal learned persistent state
        │
        ▼
RESEARCH 2
causal history dependence
+ reset / swap / ablation
        │
        ▼
RESEARCH 3
self inertia against irrelevant context
+ revision under real evidence
        │
        ▼
RESEARCH 4
action + consequence change future state
        │
        ▼
RESEARCH 5
integrate Memory / minimal Life dynamics
without hand-authoring personality
        │
        ▼
RESEARCH 6
slow parameter consolidation
+ state/parameter compatibility
        │
        ▼
RESEARCH 7
months/years of accumulated life
```

The order matters.

Do not jump from prompt-based personality directly to continual fine-tuning and
call the result a self.

---

## 29. What changed in one sentence

> **Old YUVI primarily reconstructed a stable person from identity, memory and
> context; future YUVI should investigate whether a causally continuous process
> can accumulate those things, be changed by its own life, and gradually become
> Yuvi.**
