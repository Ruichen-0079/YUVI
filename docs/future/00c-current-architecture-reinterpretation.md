# Current Architecture Reinterpretation

> **Status: LONG-TERM CONCEPTUAL AUDIT — NO CURRENT AUTHORITY CHANGE**
>
> This document explains how existing YUVI architecture should be read after the
> north star moved from increasingly complete identity reconstruction toward
> persistent functional continuity.

## 1. Keep the current product; change the theory around it

Current YUVI contains many good ideas:

- grounded Memory;
- explicit authority boundaries;
- P8 identity/persona semantics;
- grounded time;
- Character/Cognition separation;
- meaningful silence;
- embodiment;
- behavior evaluation before training.

None needs to be discarded merely because the deeper theory changed.

The conceptual correction is:

```text
old reading:
current modules collectively reconstruct enough information for the model to be Yuvi

new reading:
current modules are useful product/support systems around a future continuing process;
they should not be mistaken for that process itself
```

---

## 2. Classification

| Layer / idea | Long-term role | Important correction |
| --- | --- | --- |
| Runtime | **Fundamental** | If future state carries causal history, restart/fork/restore may become identity operations rather than ordinary infrastructure events. |
| Memory | **Fundamental + supportive** | Memory preserves evidence and autobiography; retrieval is not itself causal self continuity. |
| P8 identity/persona | **Current product authority; partly transitional long term** | P8 should identify, constrain, correct, and ground Yuvi, not grow into an exhaustive authored personality. |
| Relationship interpretation | **Supportive** | Evidence-grounded claims remain useful, but relationship depth should not default to a giant state vector. |
| Character ABI | **Fundamental boundary** | Explicit semantic context may remain an ABI; future persistent state may need direct computational coupling rather than JSON/text serialization. |
| PromptBuilder | **Transitional** | Prompt remains necessary today, but should not remain the final home of personality. |
| Temporal | **Fundamental + supportive** | Grounded time remains necessary; do not invent off-screen life. |
| Continuity/open threads | **Supportive / gap-driven** | Unfinished relevance is not the same thing as self continuity. |
| Life Layer | **Potentially fundamental** | Keep it low-level and sparse; do not turn psychology vocabulary into a dashboard. |
| Character Model | **Fundamental cognitive surface** | Current stateless invocation is transitional; future research asks whether it can operate from continuing state. |
| Cognition Core | **Fundamental + supportive** | Strong reasoning may remain replaceable machinery; it need not define identity. |
| Character Harness | **Fundamental supervision** | It may later validate state/model compatibility, but must not become a hand-authored `SelfManager`. |
| Embodiment / Presentation | **Supportive, developmentally useful** | Its deeper value is that actions have consequences that can change later state. |
| Character behavior spec | **Fundamental for product quality** | Passing behavior eval does not prove persistent self. |
| Character post-training | **Supportive** | SFT/DPO can encode Yuvi-like behavior without representing lived development. |
| Model replaceability | **Fundamental, with qualification** | Machinery carrying accumulated causal history may need migration rather than blind replacement. |
| Narrative self | **Supportive interpretation** | Self-description may be wrong, revised, or incomplete; it is not causal ground truth. |

---

## 3. The main conceptual mistakes to avoid

### Persona is not self

```text
more persona detail
≠ more causal continuity
```

Persona can stabilize reconstruction. It should not expand until it specifies
everything a continuing life failed to develop.

### Memory is not self

```text
more retrieval
≠ more causal continuity
```

A stateless model with perfect autobiography is still reconstructing from an
autobiography.

### Psychological variables are not personality

```text
more named variables
≠ more human complexity
```

Prefer a few dynamics plus history and learning over explicit `trust`,
`attachment`, `jealousy`, `intimacy`, and similar fields unless evidence shows
they are necessary.

### Character weights are not lived history

```text
SFT / DPO / LoRA
≠ experience-conditioned self formation
```

A trained prior can be excellent without the deployed entity having lived the
training examples.

### Latent is not automatically self

```text
latent vector
≠ causal continuity
```

A latent state may simply be a compressed instruction.

### Persistent storage is not a persistent agent

```text
database survives restart
≠ agent state survived as a continuing process
```

Storage is necessary but not sufficient.

---

## 4. How the current pieces should fit the future theory

The most elegant long-term picture is:

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
```

Around that loop:

- Runtime provides reliable execution and persistence;
- P8 provides explicit identity boundaries, correction, provenance, and claims;
- Memory provides recoverable history;
- Character/Mind interprets and expresses;
- Cognition supplies expensive reasoning;
- Presentation supplies embodied action;
- Harness supervises boundaries and failures.

The future persistent state, if it proves useful, should be **supported by**
these systems rather than reconstructed from them every turn.

---

## 5. What remains unchanged now

For the current product:

- P8 remains authoritative;
- Memory vNext remains the operational continuity path;
- Prompt reconstruction remains valid;
- Character ABI/Harness/Cognition remain closed boundaries;
- Phase 8 behavior assets remain useful;
- Temporal/Continuity remain gap-driven;
- no production persistent-state subsystem is authorized;
- no continual LoRA training is authorized.

The current architecture is not being declared wrong. It is being assigned a
more precise long-term role.

---

## 6. What research would have to prove before integration

Do not redesign product architecture until an isolated prototype shows:

- different histories produce justified differences under identical current
  input;
- resetting/swapping state moves behavior with the state;
- irrelevant tone does not erase accumulated differences;
- repeated reliable evidence can revise them;
- the agent's own actions and consequences alter later state;
- the effect adds value beyond strong text-summary and Memory baselines.

Only then ask where such a state belongs in Runtime, Character, Harness, Memory,
or elsewhere.

---

## 7. The conceptual transition

The old architecture mostly asked:

> **What information must the current model receive so that it behaves like
> Yuvi?**

The new north star asks a prior question:

> **What must continue from one moment to the next so that the system
> encountering the present has actually been changed by Yuvi's past?**

Existing modules should increasingly support that continuing process rather
than substitute for it.
