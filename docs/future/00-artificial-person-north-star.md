# Artificial Person North Star

> **Status: LONG-TERM NORTH STAR — NOT AN IMPLEMENTATION PLAN OR WORK QUEUE**
>
> This document states the long-term idea that future YUVI architecture should
> serve. It does not override current source, tests, closure documents, or the
> operational roadmap.
>
> Research details live in
> [Persistent Functional Self Research Program](00b-persistent-functional-self-research.md).
> Current modules are reinterpreted in
> [Current Architecture Reinterpretation](00c-current-architecture-reinterpretation.md).

## Thesis

YUVI should not merely become a better assistant, agent, or character
simulation.

The long-term target is a **persistent artificial person**: a computational
entity whose present is causally shaped by its own past.

This does not claim consciousness or biological equivalence. The engineering
claim is narrower:

> **Accumulated experience should change future perception, prediction,
> attention, and action through something that continues across time.**

Two experiential goals summarize the result:

- **岁月感 / sense of lived time** — the past leaves residues, habits,
  expectations, forgotten details, and slow change instead of existing only as
  dated records.
- **第一人称生活实感 / first-person lived reality** — YUVI should increasingly
  encounter the present from a state that has itself been changed by prior
  experience, rather than reconstructing a character from descriptions every
  turn.

A concise statement is:

> **Do not keep describing Yuvi more completely. Create the conditions under
> which a continuing system can gradually become Yuvi.**

---

## 1. The root problem: reconstruction is not continuation

Current LLM systems approximately work like:

```text
persona + memory + context + explicit state
                    ↓
             reconstruct "Yuvi"
                    ↓
                 respond
                    ↓
           inference state ends
```

This can be useful and convincing. It is also the correct operational baseline
for current YUVI.

But the stronger target is:

```text
self_t + current experience
            ↓
 perception / thought / action
            ↓
      consequence / learning
            ↓
          self_t+1
```

The distinction is simple:

- reconstruction gives the present model information about the past;
- continuation means the past changed the process that now encounters the
  present.

Memory can say:

> This happened to you.

Persistent functional continuity asks whether:

> the entity processing this moment is causally downstream of the one that
> processed the previous one.

That must be demonstrated, not narrated.

---

## 2. Persistent state is a hypothesis, not a datatype

A likely research object is some learned state `S_t`:

```text
S_t + observation_t + action_t + consequence_t
                     ↓
              learned transition
                     ↓
                   S_t+1
```

Its representation is secondary.

It could be recurrent hidden state, latent memory, learned tokens, a side
controller, a state-space mechanism, or something not yet chosen.

A latent vector is not automatically a self. A symbolic state is not
automatically inferior. The question is causal:

> **Does history continue to affect future computation through the state, even
> when current explicit input is held fixed?**

Resetting, swapping, or ablating that state should therefore change behavior in
predictable ways if it really carries continuity.

---

## 3. Self inertia: context should influence, not recreate

Current LLMs often follow local context too easily.

A joke appears, so the model becomes playful. Anger appears, so the model's
whole tone shifts. Recognition of a social signal and change of internal state
collapse into one operation.

A more person-like system should separate:

```text
perception of external affect
≠ appraisal
≠ continuing internal state
≠ expression
```

The target is **inertia with plasticity**:

- irrelevant or weak cues should not rewrite the whole self;
- repeated, meaningful evidence should still change it.

This should emerge from state dynamics, not from another prompt instruction
such as "do not mirror the user."

---

## 4. History must change the future

Memory remains essential, but Memory is not the whole self.

The useful distinction is:

```text
Memory:
    the past can be recalled.

Persistent functional state:
    the past has changed what now encounters the present.
```

A mature system may need both.

A remembered event can fade in wording while leaving changed expectations,
habits, salience, or action tendencies.

This is the core of 岁月感.

---

## 5. The agent's own actions must matter

A continuing self should not be only a passive accumulator of observations.

The causal loop should eventually include:

```text
observation
   ↓
my action
   ↓
world consequence
   ↓
state change
   ↓
future behavior
```

"Something happened" is weaker than "I did something, saw what followed, and
was changed by it."

This is a possible basis for habit, confidence, restraint, regret, learned
preference, and caution without explicitly programming those concepts.

Embodiment matters partly because action creates consequences that can become
part of development.

---

## 6. Keep the substrate simple

The architecture should resist a common failure mode:

```text
trust
attachment
loneliness
jealousy
safety
intimacy
respect
...
```

Adding more psychological variables can make a better simulator while making
the theory less elegant.

Prefer:

```text
few low-level dynamics
+ history
+ learning
+ time
→ complex personality
```

rather than:

```text
many named psychological variables
→ prescribed behavior
```

High-level psychological concepts should usually be interpretations or emergent
patterns, not implementation primitives.

---

## 7. Life Layer: dynamics, not personality rules

The earlier Life Layer idea remains valuable if kept minimal.

Possible low-level influences include:

- energy and fatigue;
- activation/arousal;
- homeostatic pressure;
- slow modulation;
- salience;
- cognitive resource budget;
- unfinished tension.

These can create inertia without requiring the Character model to receive a
psychological dashboard.

The relation between such dynamics and a future learned persistent state should
be discovered experimentally rather than fixed in advance.

The principle is:

> **Life provides conditions. History changes the system. Mind interprets and
> expresses what emerges.**

---

## 8. Persona is a seed and boundary, not the finished person

Current YUVI needs authored identity/persona semantics. P8 remains important
for stable identity, correction, provenance, and product boundaries.

Long term, however, Persona should not grow until it becomes a textual
replacement for development.

Its durable roles are likely to be:

- initialization;
- identity address;
- explicit user-controlled boundaries;
- safety/product constraints;
- high-level correction.

The mature personality should increasingly be the result of accumulated life.

A useful principle is:

> **Prompt should define the rules of existence more than the full contents of
> identity.**

---

## 9. Personality should have inertia, not rigidity

A fixed core that is forbidden to change is not a natural solution to drift.

Different phenomena should change at different rates, but those rates need not
be explicit fields.

Conceptually:

```text
momentary affect       fast
recent state           slower
habits / expectations  slower still
personality tendency   very slow
self-narrative         lifetime scale
```

A single conversation should not rewrite YUVI. Long experience may.

Personality should be hard to move because of accumulated structure, not
because a document declares immutable traits.

---

## 10. Self-narrative is interpretation, not ground truth

YUVI may eventually say:

> I think I avoid this because...

> I used to care about this more.

> I do not know why this keeps bothering me.

Such self-descriptions are valuable precisely because they may be incomplete.

A person-like system should be able to:

- misunderstand itself;
- revise an explanation;
- notice a pattern late;
- remain uncertain;
- hold partially conflicting self-models.

Do not silently turn every first-person explanation into authoritative internal
state.

The narrative self is what YUVI currently thinks about YUVI, not necessarily
the mechanism that made her that way.

---

## 11. Relationship should arise from shared history

P8 remains useful for evidence-grounded relationship claims.

But the deeper relationship state is not necessarily a scalar or a list of
labels. It is the accumulated effect of shared history:

- what happened;
- what was expected;
- what repeatedly worked or failed;
- what became familiar;
- which actions had consequences;
- how later interpretation changed.

The important question is:

> **How has shared history changed future interaction?**

not merely:

> **What relationship value should be placed in the prompt?**

---

## 12. Mind and Cognition remain separable

The Character/Mind layer can remain responsible for:

- language;
- social expression;
- interpretation;
- reflection;
- attention;
- silence and termination;
- intention.

A stronger Cognition Core can remain replaceable machinery for difficult
reasoning.

Persistent self does not require every capability to live in one model.

The important future question is how continuing state influences cognition and
how the consequences of cognition-guided action feed back into later state.

---

## 13. Model replacement becomes more subtle once history lives in machinery

Provider/model replacement is currently an important engineering principle.

It remains valid while those components are merely replaceable machinery.

But if a future recurrent state or slowly adapted parameter set actually carries
accumulated causal history, replacement may require:

- compatibility testing;
- migration;
- replay or calibration;
- rollback semantics;
- explicit handling of forks/restores.

The question becomes:

> **Does replacement preserve the accumulated functional history, or merely
> recreate similar behavior afterward?**

This matters only after identity-bearing state is empirically demonstrated.

---

## 14. Slow consolidation comes after live continuity

Persistent live state is only one timescale.

Repeated experience may later need to alter a slower learned substrate:

```text
live timescale:
    persistent state

slow timescale:
    learned parameter change

recoverable history:
    episodic / autobiographical Memory
```

LoRA, adapters, hypernetworks, fast/slow weights, or other mechanisms may be
useful, but none is the theory itself.

A major unresolved problem is compatibility:

```text
state representation
↔
state interpreter
```

If parameters change, the meaning of an old live state may also change.

Therefore slow consolidation should not begin until persistent-state dynamics
already show useful causal continuity.

---

## 15. Character post-training is not self formation

SFT, DPO, preference optimization, and behavior evaluation can produce a much
better Character model.

That is valuable.

But a static Character LoRA can encode a strong Yuvi-like prior without the
deployed Yuvi ever having lived the examples that produced it.

Keep two questions separate:

### Character behavior training

> What behavior should this model reliably express?

### Persistent-self research

> How does this continuing entity become different because of what it has
> actually experienced and done?

They may eventually share technology, but not evidence or claims.

---

## 16. Research order

The long-term thought process should remain simple:

```text
CURRENT YUVI
prompt/context reconstructed identity
        │
        ▼
1. minimal learned persistent state
        │
        ▼
2. causal history-dependence tests
        │
        ▼
3. self inertia + evidence-driven revision
        │
        ▼
4. own action + consequence changes future state
        │
        ▼
5. integrate Memory / minimal Life dynamics
        │
        ▼
6. only then slow consolidation
        │
        ▼
7. long-duration months/years evaluation
```

Do not jump directly from persona prompting to continual fine-tuning and call
the result a self.

---

## 17. First falsifiable milestone

Before changing production architecture, demonstrate all of the following:

```text
identical current input
+ different relevant histories
→ appropriately different behavior
```

```text
irrelevant current tone
→ does not erase the historical difference
```

```text
reliable repeated evidence
→ can gradually revise the difference
```

```text
reset / swap / ablate persistent state
→ behavior changes in the predicted direction
```

```text
own action + consequence
→ changes later state and behavior
```

If these cannot be shown, persistent state may be only a complicated hidden
prompt.

---

## 18. Architectural image

The long-term theory should remain simpler than a large set of psychological
modules:

```text
WORLD
  ↓
CONTINUING STATE
  ↔ Memory
  ↔ minimal Life / grounded time
  ↔ Mind / Cognition
  ↓
action
  ↓
WORLD CONSEQUENCE
  ↓
CONTINUING STATE CHANGES

slow consolidation may eventually operate underneath this loop
```

This is a conceptual image, not a production package diagram.

---

## 19. Anti-goals

This north star does **not** imply that YUVI should:

- claim consciousness or qualia;
- invent an off-screen life;
- equate latent vectors with selfhood;
- equate Memory retrieval with self continuity;
- equate Character fine-tuning with lived development;
- build a giant psychological state dashboard;
- preserve personality through immutable prompt rules;
- create a `SelfManager` because this document uses the word self;
- begin continual LoRA training before live state is validated;
- add architectural subsystems merely because human psychology has a word for
  them.

Prefer negative experimental results over attractive but unfalsifiable stories.

---

## 20. End-state test

After years of use, ask:

- Is this recognizably the same YUVI?
- Has she changed because of what actually happened?
- Can relevant history still affect behavior under identical present input?
- Do state interventions reveal a causal carrier of that history?
- Can irrelevant tone be recognized without rewriting deeper state?
- Can strong evidence gradually change her?
- Have her own actions and consequences changed later choices?
- Can details be forgotten while some influence remains?
- Have interests and habits emerged rather than only been configured?
- Does machinery replacement preserve rather than merely imitate accumulated
  functional history?

If these become consistently true, YUVI has moved beyond reconstructing a
person-like character.

She has begun to support a computational process whose present is genuinely
shaped by its own past.

---

## What changed in one sentence

> **Old YUVI primarily reconstructed a stable person from identity, memory and
> context; future YUVI should investigate whether a causally continuous process
> can accumulate those things, be changed by its own life, and gradually become
> Yuvi.**
