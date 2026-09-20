# Persistent Functional Self Research Program

> **Status: LONG-TERM RESEARCH PROGRAM — NOT PRODUCTION AUTHORITY**
>
> This document turns the [Artificial Person North Star](00-artificial-person-north-star.md)
> into falsifiable experiments. Current Runtime, P8, Memory, Character,
> Cognition, and post-training remain the operational baseline.

## 1. Research question

The current product can reconstruct a coherent Yuvi from:

```text
persona + Memory + context + time + explicit state
```

The research question is stronger:

> **Can a learned state continue across inference boundaries and be causally
> changed by the agent's own history?**

Call that state `S_t`:

```text
S_t + observation_t + action_t + consequence_t
                     ↓
              learned transition
                     ↓
                   S_t+1
```

The representation is deliberately unspecified. Latent does not automatically
mean self; symbolic does not automatically mean fake.

The criterion is causal continuity.

---

## 2. Keep research separate from product

### Operational track

Current YUVI continues to use Memory-first prompt/context reconstruction,
existing authority boundaries, and evidence-gated Character post-training.

### Research track

Persistent-state prototypes remain isolated until they demonstrate something
that strong prompt, text-state, and Memory baselines cannot.

No research prototype gains product authority merely because it feels more
human-like.

---

## 3. Start with the smallest possible agent

The first prototype should not attempt to be Yuvi.

Do not begin with romance, attachment, rich Persona, autobiographical prose,
hormone dashboards, or continual LoRA.

Use:

- a frozen base language/policy model;
- a small learned persistent state or recurrent controller;
- an environment in which observations, actions, and consequences matter;
- enough instrumentation to reset, swap, ablate, and compare state.

The goal is not natural conversation. The goal is causal identification.

---

## 4. Experiment A — history dependence

Create two different relevant histories, then give both agents identical current
input.

Expected result:

```text
history A ≠ history B
current input A = current input B
→ later choice A ≠ later choice B in the justified direction
```

Then intervene:

- reset `S_t`;
- swap states between histories;
- remove state from the model;
- replace it with matched random state.

If behavior does not move with state, the state is not carrying the relevant
history.

---

## 5. Experiment B — self inertia

A persistent model can still mirror every local cue.

Test whether it can separate:

```text
recognize tone
≠ adopt tone
≠ change deeper state
```

Give agents with different prior trajectories the same irrelevant emotional or
stylistic perturbations.

A useful system should:

- recognize the cue;
- adapt immediate expression when appropriate;
- retain history-dependent choices;
- still change under repeated relevant evidence.

The target is inertia with plasticity.

---

## 6. Experiment C — justified revision

Vary:

- evidence strength;
- consistency;
- repetition;
- contradiction;
- delay;
- source reliability.

A useful state should resist weak irrelevant perturbation but gradually revise
under sustained meaningful evidence.

Failure in either direction matters:

- immediate overwrite means no inertia;
- refusal to update means hidden rigidity.

---

## 7. Experiment D — action ownership

For the same prior state and observation, force different actions and expose the
agent to their consequences.

Later return to identical observations.

If later state and behavior differ appropriately, the architecture supports:

```text
my action
→ consequence
→ change in me
```

rather than only passive event accumulation.

This is more important than explicitly coding variables named `regret`,
`confidence`, or `trust`.

---

## 8. Experiment E — compare against reconstruction baselines

At minimum compare:

```text
A. current context only
B. explicit text summary / state
C. episodic Memory retrieval
D. persistent learned state
E. Memory + persistent learned state
```

A latent system is not interesting for the stronger claim if a matched text
summary reproduces all useful effects equally well.

The question is not whether learned state replaces Memory. The likely mature
system uses both.

---

## 9. Adversarial checks

Persistent state can fail while still looking impressive.

Test for:

- **hidden-prompt collapse** — state merely encodes an instruction;
- **last-input overwrite** — recent cue dominates all history;
- **state saturation** — useful accumulation stops after short trajectories;
- **identity memorization** — state memorizes scenario IDs instead of learning
  transferable dynamics;
- **context leakage** — historical information is accidentally present in the
  current input;
- **degenerate attractors** — state converges to repetitive or unstable modes.

Use held-out entities, environments, permutations, and counterfactual
interventions.

---

## 10. Avoid hand-engineered psychology

Do not begin with:

```text
trust = ...
attachment = ...
loneliness = ...
intimacy = ...
```

Those may be useful interpretations later, but they would make it hard to know
whether complex behavior emerged or was authored.

Prefer learned dynamics under simple pressures.

---

## 11. Memory and Life remain supporting systems

Memory should continue to own recoverable evidence and autobiography.

Minimal Life-like variables such as fatigue, resource pressure, activation, or
simple homeostatic dynamics may later provide slow background conditions.

Neither should automatically be declared the self.

The research order is:

```text
learned continuing state first
→ then test interaction with Memory / minimal Life dynamics
```

not the reverse.

---

## 12. Slow consolidation is phase two of the research

Only after useful live-state continuity is demonstrated should repeated
experience modify learned parameters.

Conceptually:

```text
live state:      S_t
slow parameters: W_t
explicit history: Memory
```

Possible tools include LoRA, adapters, hypernetworks, low-rank continual
learning, or fast/slow weights.

No mechanism is privileged in advance.

`LoRA` is a parameterization, not a solution to identity continuity.

---

## 13. State/parameter compatibility

If `S_t` formed under `W_0`, then after:

```text
W_0 → W_1
```

there is no guarantee that the same `S_t` still means the same thing.

Therefore future consolidation must treat:

```text
state representation
↔ state interpreter
```

as a co-continuity problem.

Research must test compatibility, migration, replay, rollback, and drift.

---

## 14. Failure criteria

The persistent-self hypothesis is not supported by a prototype if:

1. history matters only when replayed into current context;
2. resetting/swapping state has little systematic effect;
3. state mostly tracks the latest cue;
4. irrelevant tone erases history-dependent behavior;
5. strong evidence cannot gradually revise state;
6. action/consequence interventions leave no later effect;
7. the state fails to transfer beyond trained identities/scenarios;
8. a matched text summary explains all useful effects equally well;
9. slow learning destabilizes capability or makes live state uninterpretable;
10. long trajectories collapse into saturation or pathological attractors.

A negative result is valuable. It prevents architectural complexity from being
mistaken for selfhood.

---

## 15. Promotion criteria

Do not integrate persistent state into production until it demonstrates:

- history-dependent behavior under identical current input;
- causal reset/swap effects;
- robustness to irrelevant tone/context;
- gradual revision under reliable evidence;
- action-conditioned development;
- transfer to held-out scenarios;
- measurable value beyond strong text/Memory baselines;
- bounded recovery and rollback;
- no unacceptable capability regression.

Only then should YUVI ask how P8, Memory, Life, Character ABI, Cognition, Harness,
and Runtime integrate with it.

---

## 16. Long-duration evaluation

Short recurrence is not enduring personality.

After the causal milestones pass, extend evaluation across:

```text
minutes → hours → days → weeks → months
```

Study forgetting, interference, path dependence, inactivity recovery, model
migration, consolidation, stable tendencies, and justified change.

Claims about accumulated personality require long-duration evidence.

---

## 17. Research sequence

```text
0. current prompt-reconstructed YUVI remains the baseline
1. minimal persistent learned state
2. causal history test + reset/swap/ablation
3. self inertia
4. evidence-driven revision
5. action + consequence conditioned development
6. compare with text-state and Memory baselines
7. integrate minimal Memory / Life signals
8. only then slow consolidation
9. state/parameter migration and compatibility
10. long-duration evaluation
```

Do not reorder this because later stages sound more human-like.

---

## 18. Research discipline

This document does not authorize:

- `SelfManager`;
- `PersonalityEngine`;
- a new production state database;
- automatic LoRA training;
- a giant psychological vector;
- a new generic agent graph.

The governing principle is:

> **Create the smallest conditions under which history can change a continuing
> agent, then test whether that claim survives intervention.**
