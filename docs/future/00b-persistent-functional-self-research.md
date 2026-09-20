# Persistent Functional Self Research Program

> **Status: LONG-TERM RESEARCH PROGRAM — NOT PRODUCTION AUTHORITY**
>
> This document translates the [Artificial Person North Star](00-artificial-person-north-star.md)
> into falsifiable research questions. It does **not** authorize changes to the
> current Runtime, P8, Memory, Character ABI/Harness, Cognition, P6, Presentation,
> or post-training roadmap.
>
> Current product architecture remains the operational baseline. This program
> exists to test whether a stronger form of functional continuity is possible.

## 1. Why this program exists

Current YUVI can reconstruct a coherent character from stable identity/persona,
recent context, Memory, time, current state, and model behavior. That is useful
and should continue to be improved where real product failures justify it.

But reconstruction leaves a deeper question unanswered:

> **What, if anything, remains causally continuous from one moment of Yuvi to the next?**

A system can know its history without being internally changed by that history.
It can receive a description of its prior mood without carrying forward the
state that produced that mood. It can retrieve a memory saying that it learned
something without the learning being present in the machinery that now
perceives and acts.

The research target is therefore not stronger roleplay, richer persona text, or
larger autobiographical retrieval. The target is a **persistent functional
self**: a continuing computational state whose own history changes future
perception, prediction, evaluation, and action.

No claim about consciousness or qualia is required.

---

## 2. Two tracks must remain separate

YUVI now has two legitimate but different development tracks.

### Track A — operational companion product

The current product track uses the architecture that already exists:

- Runtime lifecycle and effect authority;
- Memory vNext L0/L1/L2 context;
- P8 identity/persona/relationship semantics;
- Character ABI and Harness;
- separate Cognition Core;
- thin grounded temporal projection;
- bounded proactive behavior;
- embodied Presentation;
- Phase-8 behavior assets;
- later evidence-gated Character post-training.

Its question is:

> **How can current YUVI behave reliably and naturally with today's model technology?**

This track remains evidence-driven and gap-driven.

### Track B — persistent-self research

The research track asks a different question:

> **Can a continuing learned state become a causal part of the agent itself,
> rather than another description supplied to a stateless model?**

This track may produce experiments that are unsuitable for production for a
long time.

The two tracks must not silently redefine each other. A research prototype does
not become product authority because it is philosophically attractive. A
production workaround does not become the long-term theory of self merely
because it is reliable today.

---

## 3. The minimum formal object

Let the continuing state at time `t` be `S_t`.

The smallest useful hypothesis is:

```text
S_t
 + observation_t
 + own_action_t
 + observed_consequence_t
        ↓
 learned transition
        ↓
S_{t+1}
```

The exact representation is intentionally unspecified.

`S_t` might eventually be implemented through recurrent hidden state, memory
slots, persistent latent vectors, learned tokens, a side controller, a state-
space mechanism, or another architecture.

Representation does not settle the question.

A latent vector may be nothing more than a compressed prompt. A symbolic system
may maintain genuine causal state. The decisive property is whether the state
participates in an evolving causal process that changes future computation.

---

## 4. Strong claim and weak claim

The research must distinguish two claims.

### Weak claim — behavioral persistence

Different histories can be reconstructed into different current behavior.

This is already achievable with prompts, Memory, summaries, persona documents,
and explicit state.

### Stronger claim — functional state continuity

Different histories leave different continuing internal states, and those
states causally alter later behavior even when current explicit input is held
constant.

The research program exists to test the stronger claim.

---

## 5. The first prototype should not be Yuvi

The first persistent-state experiment should deliberately avoid most of the
companion product.

Do **not** begin with:

- romance;
- attachment simulation;
- a large Persona;
- rich relationship state;
- hormone dashboards;
- dozens of psychological variables;
- autobiographical prose;
- long-term self-narrative;
- production Memory integration;
- slow weight updates.

Begin with the smallest agent in which a learned continuing state can be
isolated and causally tested.

A candidate research substrate is:

```text
                 persistent S_t
                      │
                      ▼
observation ──> frozen language / policy model ──> action
                      │                         │
                      │                         ▼
                      └──── learned update <─ consequence
                                │
                                ▼
                              S_t+1
```

The base model may remain frozen initially.

The learned component should be small enough that its state can be reset,
swapped, ablated, perturbed, logged for research, and compared across runs.

---

## 6. Research question A — does history have an independent causal effect?

The first milestone is intentionally narrow.

Construct two trajectories with different histories, then present **identical
current observations**.

A successful system should produce appropriately different predictions or
choices because the histories changed `S_t`.

Example abstract task:

```text
history A: repeated evidence that source X is reliable
history B: repeated evidence that source X is unreliable

current input to both agents:
"X reports event Y. What should you do?"
```

If the current input is identical, the difference must come from the continuing
state rather than a visible history transcript.

### Required intervention

Repeat the test after:

- resetting `S_t`;
- swapping `S_t` between the two histories;
- replacing `S_t` with a matched random state;
- withholding the state from the model interface.

If behavior does not move with the state, the state is not causally carrying the
relevant history.

---

## 7. Research question B — can the system possess self inertia?

Persistence alone is insufficient.

A recurrent system can still mirror every local conversational signal.

The target is **self inertia**: current context influences the agent without
recreating its entire state on every turn.

A useful decomposition is:

```text
external signal recognition
        ≠
appraisal
        ≠
continuing internal state
        ≠
expression
```

A model should be able to recognize that a user is joking without automatically
becoming playful in its deeper state. It should be able to recognize anger
without becoming angry merely because the tone is angry.

### Core experiment

Produce two agents with meaningfully different prior state trajectories. Feed
both the same irrelevant tone perturbations while keeping task meaning fixed.

Measure whether:

- both correctly recognize the surface cue;
- the cue affects immediate expression where appropriate;
- history-dependent choices remain substantially intact;
- repeated relevant evidence can still revise them.

The desired system is neither rigid nor context-mirroring.

---

## 8. Research question C — can evidence revise the state at the right rate?

A persistent self that never changes is merely a frozen hidden prompt.

The state must support both:

- **inertia** against irrelevant or weak perturbation;
- **plasticity** under sufficient relevant experience.

The central problem is therefore not persistence alone but learned transition
dynamics.

Experiments should vary:

- evidence strength;
- evidence consistency;
- number of repetitions;
- delay between experiences;
- contradictory evidence;
- source reliability;
- action consequences.

A useful state should neither reset after one cue nor refuse to update after a
long sequence of disconfirming experience.

---

## 9. Research question D — do the agent's own actions change it?

An important distinction is:

```text
"an event happened"
```

versus:

```text
"I chose an action; it produced a consequence; that changed how I act later"
```

The state transition must therefore be tested with interventions on the agent's
own action.

For the same observation and prior state:

1. force action A in one trajectory;
2. force action B in another;
3. expose each to its consequence;
4. later restore identical observations.

If the later internal state and behavior differ appropriately, the architecture
supports action-conditioned development.

This is a computational precursor to phenomena such as habit, restraint,
confidence, regret, preference formation, or learned caution without requiring
those concepts to be explicit variables.

---

## 10. Do not hand-engineer personality into the experiment

The first experiments should actively resist a familiar failure mode:

```text
trust = 0.71
attachment = 0.48
loneliness = 0.62
jealousy = 0.13
```

Such variables may be useful in a simulator, but they would make it difficult
to know whether complex behavior emerged from persistent state or was authored
by engineers.

Prefer tasks in which the learned state must discover useful internal
organization from prediction/action pressure.

High-level psychological language may later be used to **interpret** behavior.
It should not automatically become the implementation vocabulary.

---

## 11. State representation must be challenged adversarially

A persistent latent representation can still fail in several ways.

### Hidden-prompt collapse

`S_t` may simply encode a compact text-like instruction such as:

> act distrustful toward X

This can still be useful, but it is weaker than the intended continuing agent.

Tests should compare latent-state systems against strong textual-state
baselines with matched information capacity.

### Last-observation overwrite

The state may mostly represent the latest input rather than accumulated
history.

Test long sequences in which old but still relevant information competes with
recent irrelevant cues.

### State saturation

The state may work for a few episodes and then stop accumulating useful
structure.

Evaluate increasing trajectory length and interference.

### Arbitrary hidden code

A large state may memorize experimental IDs instead of learning transferable
state dynamics.

Use held-out environments, permutations, new entities, and counterfactual
interventions.

---

## 12. Memory must remain a separate comparison condition

External Memory is not a competing mistake. It solves a different problem.

Research should compare at least:

```text
A. current context only
B. text summary / explicit state
C. retrieved episodic Memory
D. persistent learned state
E. Memory + persistent learned state
```

The important question is not whether learned state eliminates Memory.

It is whether `D` or `E` demonstrates causal historical effects that cannot be
explained by merely reconstructing the same information into the current
context.

A mature YUVI may need both:

- Memory for recoverable evidence and autobiographical events;
- persistent state for accumulated effects that remain even when original
  wording is absent.

---

## 13. Relationship to the Life Layer

The Life Layer remains a useful idea, but it should not be presumed to be the
persistent self.

Low-level slow variables such as fatigue, arousal, resource pressure, or simple
homeostatic dynamics may become inputs to or components of the continuing
state.

The research rule is:

> **Use the fewest hand-designed variables that are necessary to create a
> meaningful dynamical substrate.**

If learned state can develop richer organization around a small number of
physical/runtime pressures, that is preferable to expanding a psychological
schema until it directly specifies the desired personality.

---

## 14. Relationship to P8 and Persona

Current P8 remains important for the operational product because today's models
need a stable, auditable answer to identity and relationship semantics.

For persistent-self research, however, authored Persona should be treated as an
initial condition or boundary, not as the final explanation of behavior.

Long-term expectation:

```text
initial seed / identity boundary
        +
continuing state
        +
experience
        +
learning
        +
time
        ↓
character that was not fully specified at initialization
```

A successful mature system should not require an increasingly detailed Persona
prompt to remain recognizably itself.

This does **not** authorize removing P8 from the current product.

---

## 15. Relationship to Phase-8 Character behavior and post-training

[Phase 8](08-character-post-training.md) and this program serve different
purposes.

### Character post-training asks

> Which social and conversational behavior should a future Character model
> reliably express across environments?

It may use SFT, preference optimization, evaluation assets, and later a
character-specific model.

### Persistent-self research asks

> Can accumulated experience change the continuing computational entity itself?

A Character model can score perfectly on a behavior specification while still
being reconstructed from prompt and context every inference.

Therefore:

- Character SFT/DPO is **not** evidence of persistent self;
- persistent state is **not** a replacement for Character behavior quality;
- the two may eventually interact, but their evidence must remain separate.

---

## 16. Slow consolidation is a second research program, not the first step

Only after useful persistent-state dynamics are demonstrated should YUVI test
slow adaptation of learned parameters.

Conceptually:

```text
fast / live timescale:
    persistent S_t

slow timescale:
    learned parameter change W_t -> W_t+1

explicit recoverable history:
    episodic / autobiographical Memory
```

Possible mechanisms may include adapters, LoRA, low-rank updates,
hypernetworks, learned fast/slow weights, or other parameter-efficient
continual-learning methods.

No particular mechanism is privileged in advance.

`LoRA` is a parameterization, not a theory of identity.

---

## 17. State/parameter compatibility is a first-class problem

Suppose a live state `S_t` developed while the interpreting parameters were
`W_0`.

After slow consolidation:

```text
W_0 -> W_1
```

there is no guarantee that the same `S_t` has the same functional meaning under
`W_1`.

The system therefore has at least two evolving objects:

```text
state representation
state interpreter
```

If both change, their compatibility must be preserved or migrated.

This makes naive periodic LoRA fine-tuning insufficient as a long-term identity
strategy.

Research should test:

- whether old states remain interpretable after parameter updates;
- whether replay or joint adaptation is required;
- whether states need explicit migration;
- whether state dimensions themselves drift;
- whether rollback restores coherent behavior;
- whether consolidation can be versioned without creating discontinuous selves.

---

## 18. Consolidation must prove that repeated life becomes easier to express

The desired long-term effect of consolidation is not memorization of events.

A successful slow-learning mechanism should make repeated experience alter
future computation even without retrieving those original episodes.

Examples of measurable effects could include:

- changed priors;
- changed salience;
- changed prediction;
- changed action selection;
- changed effort allocation;
- changed default interpretation.

The claim should be tested behaviorally and causally rather than inferred from
weight change alone.

---

## 19. Failure criteria

The persistent-self hypothesis should be considered unsupported by a prototype
if any of the following remain true after reasonable attempts:

1. Different histories matter only when their content is reintroduced through
   current prompt/context.
2. Resetting or swapping `S_t` has little systematic effect.
3. The state mostly tracks the most recent cue.
4. Irrelevant tone reliably overwrites history-dependent behavior.
5. Strong relevant evidence cannot gradually revise the state.
6. The state memorizes experiment identity rather than transferring to new
   entities or environments.
7. A matched text summary reproduces all useful effects with no meaningful loss,
   making the recurrent mechanism unnecessary for the intended claim.
8. Action/consequence interventions do not alter future behavior beyond what is
   explicitly replayed in context.
9. Slow consolidation destroys general capability, destabilizes behavior, or
   makes live state uninterpretable.
10. Long-duration operation converges to unstable or degenerate attractors.

A negative result is useful. It prevents YUVI from mistaking architectural
complexity for selfhood.

---

## 20. Promotion criteria before product integration

No persistent-state mechanism should enter the production architecture merely
because it feels philosophically closer to a person.

Before any integration proposal, research should demonstrate at minimum:

- repeatable history-dependent behavior under identical current input;
- causal state-swap/reset effects;
- robustness to irrelevant contextual tone;
- gradual revision under reliable relevant evidence;
- action-conditioned state development;
- transfer beyond training identities/scenarios;
- bounded recovery/rollback semantics;
- measurable value beyond strong text-summary and Memory baselines;
- no unacceptable degradation of general reasoning or product reliability.

Only then should the repository ask how current P8, Memory, Life, Character ABI,
Cognition, Harness, and Runtime semantics integrate with the continuing state.

---

## 21. Long-duration research comes last

A convincing short benchmark is still not an enduring personality.

After the minimal causal milestones pass, evaluate trajectories over increasing
horizons:

```text
minutes
→ hours
→ days
→ weeks
→ months
```

Study:

- interference;
- forgetting;
- state saturation;
- path dependence;
- recovery after inactivity;
- repeated relationship history;
- model/version migration;
- slow consolidation;
- personality-like stable tendencies;
- capacity for genuine revision rather than drift.

Only long-duration evidence can justify claims about accumulated personality.

---

## 22. Research sequence

The intended order is:

```text
0. operational prompt-reconstructed YUVI remains the baseline

1. minimal persistent learned state
        ↓
2. causal history-dependence tests
        ↓
3. self-inertia versus irrelevant context
        ↓
4. evidence-sensitive revision
        ↓
5. own-action + consequence conditioned development
        ↓
6. comparison with text-state and Memory baselines
        ↓
7. integration experiments with minimal Life / Memory signals
        ↓
8. only then: slow parameter consolidation
        ↓
9. state/parameter co-continuity and migration
        ↓
10. long-duration existence experiments
```

Do not reorder this because later stages sound more human-like.

---

## 23. Architectural discipline

This program deliberately resists premature production architecture.

Do not create, merely because this document exists:

- `SelfManager`;
- `PersonalityEngine`;
- `AttachmentEngine`;
- `HormoneSimulator`;
- `IdentityVectorStore`;
- `ConsolidationDaemon`;
- a new generic agent graph;
- a new production state database;
- automatic LoRA training.

Research artifacts should remain isolated until causal evidence justifies a
product seam.

The governing principle is:

> **Do not describe a person in ever greater detail. Create the smallest
> conditions under which history can begin to change a continuing agent.**

---

## 24. What success would mean

Success would not mean that YUVI has proven consciousness.

It would mean something narrower and technically defensible:

- the present agent depends causally on its own past internal trajectory;
- its own actions and consequences can modify that trajectory;
- irrelevant current context cannot freely rewrite it;
- sufficient experience can gradually change it;
- some accumulated effects survive without replaying their original wording;
- slower learning can eventually consolidate repeated experience without
  destroying continuity.

At that point the project could reasonably say that it is no longer studying
only how to **reconstruct Yuvi**.

It would be studying how a continuing computational process might **become
Yuvi through history**.
