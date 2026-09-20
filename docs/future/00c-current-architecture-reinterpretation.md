# Reinterpreting the Current Architecture Under the Persistent-Self North Star

> **Status: LONG-TERM CONCEPTUAL AUDIT — NO CURRENT AUTHORITY CHANGE**
>
> This document explains how existing YUVI architecture should be understood
> after the long-term north star moved from identity reconstruction toward
> persistent functional continuity.
>
> It does **not** reopen closed phases, invalidate current implementation, or
> authorize production rewrites.

## 1. Why reinterpret instead of replace

The current YUVI architecture contains many good ideas:

- evidence-grounded Memory;
- explicit authority boundaries;
- stable identity semantics;
- grounded time;
- bounded continuity;
- Character/Cognition separation;
- meaningful silence;
- embodiment;
- model/provider replaceability;
- behavior evaluation before training.

Those ideas were developed to solve real product problems and remain useful.

The theory changed at a deeper level.

The old architecture can be read as:

```text
identity/persona
+ retrieved history
+ current state
+ time
+ behavior specification
        ↓
Character Model
        ↓
reconstruct a stable Yuvi for this inference
```

The new north star asks whether a future system can instead become:

```text
continuing state
+ current world
+ Memory
+ cognition
+ action
        ↓
experience changes continuing state
        ↓
next moment begins from what the system has become
```

The existing architecture should therefore be classified by what role it plays
relative to that future possibility.

---

## 2. Classification vocabulary

### Fundamental

Still required, or very likely required, even if persistent functional self is
successfully demonstrated.

### Supportive

Useful around a persistent self but not the source of selfhood.

### Transitional

Necessary or valuable for today's stateless/reconstructed model path, but its
causal authority should shrink if a stronger continuing state becomes real.

### Conceptually wrong when overextended

The mechanism itself may be useful, but treating it as a substitute for causal
continuity would be a mistake.

No classification below authorizes implementation change today.

---

## 3. Runtime

**Classification: FUNDAMENTAL**

Runtime owns execution reality:

- lifecycle;
- cancellation;
- concurrency;
- durability;
- capability admission;
- effect publication;
- provider execution;
- process recovery.

A persistent self would need a reliable physical/computational substrate even
more than the current architecture does.

What changes conceptually is that Runtime may eventually have to host or persist
state whose continuity has identity significance.

Today, restarting a replaceable model is mostly an infrastructure event.

In a future persistent-self architecture, restarting, restoring, forking,
rolling back, or migrating a causally significant state may become an identity
operation.

That distinction should remain outside current production semantics until the
research program demonstrates such a state.

---

## 4. Memory

**Classification: FUNDAMENTAL + SUPPORTIVE**

Memory remains essential for:

- recoverable episodic evidence;
- provenance;
- facts and events;
- autobiographical reconstruction;
- long-horizon recall;
- auditability;
- correction and uncertainty.

The conceptual correction is:

> **Memory is history that can be recalled; it is not, by itself, the thing that
> continued through that history.**

A future persistent state may retain effects of experiences whose exact wording
is no longer retrieved.

Therefore the strongest future architecture is likely to use both:

```text
episodic Memory
+
persistent learned state
```

rather than replacing one with the other.

### Overextension to avoid

It is conceptually wrong to assume that increasingly complete retrieval of the
past eventually becomes equivalent to being causally continuous with the past.

A stateless model with perfect autobiography is still reconstructing from an
autobiography.

---

## 5. P8 identity/persona/relationship semantics

**Classification: CURRENTLY FUNDAMENTAL FOR PRODUCT SAFETY; LONG-TERM PARTLY TRANSITIONAL**

P8 solves important present-day problems:

- stable character address;
- authored identity boundary;
- provenance-aware relationship interpretation;
- uncertainty and conflict;
- explicit correction;
- resistance to unsupported model self-report;
- avoidance of arbitrary persona drift.

Those properties remain valuable.

However, P8 currently answers a question close to:

> **Who should the current model understand itself to be?**

The persistent-self north star asks a different question:

> **What continuing process has accumulated the history that made the present
> entity what it is?**

In a mature future architecture, P8 should increasingly function as:

- identity address and continuity boundary;
- explicit user-controlled constraints;
- provenance and correction authority;
- bootstrap / initialization semantics;
- audit layer around self-interpretation;

rather than the complete causal source of personality.

### Overextension to avoid

It would be conceptually wrong to make `personaProfile` increasingly detailed
until it encodes the personality that a continuing life failed to develop.

The long-term direction is:

```text
P8 constrains and identifies the person
rather than
P8 fully specifies the person
```

No current P8 removal or redesign is authorized by this statement.

---

## 6. Relationship interpretation

**Classification: SUPPORTIVE + PARTLY TRANSITIONAL**

Evidence-grounded relationship interpretation remains valuable for avoiding:

- false familiarity;
- invented intimacy;
- unsupported claims;
- cross-scope leakage;
- model-generated relationship fiction.

But future lived relationship should not reduce to a semantic projection that
is freshly reconstructed before each response.

If persistent state succeeds, repeated interaction may also alter:

- expectation;
- salience;
- action selection;
- learned prediction;
- inhibition;
- preference;

without requiring each effect to be represented as an explicit relationship
label.

### Overextension to avoid

Do not build a larger relationship state vector merely because a stateless
model lacks relationship depth.

`trust`, `attachment`, `intimacy`, `dependency`, `safety`, and similar concepts
may be useful interpretations, but they should not automatically become the
primitive implementation of a future self.

---

## 7. Character ABI

**Classification: FUNDAMENTAL AS A BOUNDARY; TRANSITIONAL AS THE WHOLE MENTAL INTERFACE**

The ABI's strongest idea is stable semantic separation from:

- provider DTOs;
- Runtime internals;
- Memory backend shapes;
- cognition backend output;
- concrete tools.

That remains highly valuable.

A persistent-state future, however, introduces information that may not be
appropriately serialized as ordinary semantic context.

Today the effective flow is mostly:

```text
authorized semantic projection
        ↓
Character Model
```

Future research may require:

```text
semantic projection
+
persistent internal state coupling
        ↓
Character computation
```

The ABI should therefore remain the boundary for explicit meaning, while not
assuming that all future mental continuity must be representable as text or
structured semantic slots.

### Overextension to avoid

Do not force persistent learned state into an ever-larger JSON ABI merely to
preserve architectural uniformity.

If a future state is causally effective because it directly modulates model
computation, serializing it into psychological labels would destroy the point of
the experiment.

---

## 8. PromptBuilder and prompt reconstruction

**Classification: TRANSITIONAL**

Prompt construction is necessary for current LLMs.

It should continue to provide:

- explicit identity constraints;
- relevant Memory;
- current time;
- current situation;
- bounded authorized context;
- model-facing safety/product instructions.

But prompt should no longer be treated as the ideal final home of personality.

Long-term expectation:

> **Prompt defines current explicit information and the rules of interaction;
> accumulated identity increasingly comes from continuing state and learning.**

### Overextension to avoid

The following progression is a warning sign:

```text
model does not feel continuous
→ add persona text
→ add state summary
→ add relationship summary
→ add emotional summary
→ add self-narrative summary
→ add more prompt rules
```

This may improve simulation while moving no closer to functional state
continuity.

---

## 9. Temporal substrate

**Classification: FUNDAMENTAL + SUPPORTIVE**

Grounded time is necessary whether identity is reconstructed or persistent.

A continuing system needs reliable knowledge of:

- elapsed time;
- observation gaps;
- ordering;
- temporal uncertainty;
- recency;
- horizons.

The current discipline against inventing fake off-screen events remains
important.

Persistent self does not imply fabricated continuous consciousness between
observations.

### Future reinterpretation

Time should become more than metadata if persistent state succeeds:

- internal dynamics may evolve across time;
- forgetting may depend on time;
- slow consolidation may operate at longer timescales;
- state recovery after inactivity may become measurable.

Those behaviors must still be grounded in actual system dynamics, not narrated
into existence by the Character model.

---

## 10. Continuity and unfinished relevance

**Classification: SUPPORTIVE / GAP-DRIVEN**

The existing Continuity concept is deliberately narrow:

- open threads;
- commitments;
- unresolved uncertainty;
- recent residue;
- attention anchors.

That is good discipline.

A persistent functional self is a different concept.

Do not rename the existing Continuity layer into `Self`, and do not assume that
a durable list of unfinished items creates identity continuity.

Likewise, a future persistent state should not absorb task/commitment lifecycle
merely because both persist over time.

The concepts should remain separate unless experiments prove a reason to join
them.

---

## 11. Life Layer

**Classification: SPECULATIVELY FUNDAMENTAL, BUT HIGH RISK OF OVER-ENGINEERING**

The strongest Life-Layer idea remains:

> slow, low-level dynamics can create inertia that a turn-by-turn language model
> does not naturally possess.

This may become highly relevant to persistent-state research.

Possible low-level influences include:

- energy/resource pressure;
- activation/arousal;
- fatigue;
- slow modulation;
- simple homeostatic error;
- cognitive budget.

The key constraint is minimalism.

### Overextension to avoid

Do not convert psychological vocabulary directly into a simulation dashboard:

```text
loneliness
attachment
jealousy
trust
love
insecurity
```

The more a variable names a high-level interpretation, the more carefully YUVI
should ask whether it should emerge instead.

Life should provide dynamics, not pre-write personality.

---

## 12. Character Model

**Classification: FUNDAMENTAL COMPUTATIONAL SURFACE; CURRENT STATELESS USE IS TRANSITIONAL**

The Character Model remains valuable as the system responsible for:

- language;
- social expression;
- attention judgment;
- silence and termination;
- interpretation;
- reflection;
- requesting stronger cognition.

But today's Character inference is largely recreated from current explicit
context.

Long-term research asks whether Character computation can be conditioned by a
state that actually continues across inferences.

A future Character Model may therefore be better understood as:

```text
current reasoning machinery
operating from a continuing internal condition
```

rather than:

```text
fresh model invocation
acting out the supplied identity description
```

---

## 13. Cognition Core

**Classification: FUNDAMENTAL + SUPPORTIVE, NOT IDENTITY AUTHORITY**

The separation between Character and dependable high-capability Cognition
remains useful.

Persistent self does not require every capability to live in the same model.

The stronger future question is how cognition interacts with continuity:

- Does a difficult conclusion alter the continuing state?
- Does the state influence which problems deserve deep cognition?
- Can learned consequences from Cognition-guided actions affect later
  Character behavior?

Cognition should remain replaceable machinery unless and until some part of it
begins to carry accumulated state whose migration is required for continuity.

---

## 14. Character Harness

**Classification: FUNDAMENTAL AS SUPERVISION; TRANSITIONAL AS PURE PROMPT ASSEMBLY**

The Harness remains useful for:

- model boundary validation;
- generation supervision;
- malformed-output handling;
- bounded retry/fallback disposition;
- semantic projection.

If persistent learned state is ever admitted, the Harness or an adjacent narrow
boundary may become responsible for validating state/model compatibility.

It must not become a `SelfManager` that hand-authors internal psychology.

---

## 15. Embodiment and Presentation

**Classification: SUPPORTIVE, POTENTIALLY DEVELOPMENTALLY IMPORTANT**

Embodiment currently provides output channels:

- voice;
- expression;
- gaze;
- motion;
- environment-facing action.

Under persistent-self research, embodiment gains another role:

> actions create consequences, and consequences can change the continuing
> state.

That makes embodiment relevant not merely as presentation but as a possible
source of development.

The causal loop matters more than biological imitation.

---

## 16. Character behavior specification

**Classification: FUNDAMENTAL FOR PRODUCT QUALITY; NOT A THEORY OF SELF**

`YUVI_BEHAVIOR_SPEC` is useful because it defines desirable behavior independent
of current provider/model implementation.

It should continue to evaluate:

- honesty;
- uncertainty;
- silence;
- termination;
- escalation;
- Memory use;
- environment adaptation;
- false familiarity;
- over-speaking;
- semantic loops.

But passing the behavior spec cannot prove persistent self.

A fully stateless prompt-reconstructed model may pass every behavioral test.

Persistent-self research therefore needs additional causal evaluations:

- state intervention;
- history isolation;
- tone perturbation;
- action/consequence intervention;
- state reset/swap;
- long-duration path dependence.

---

## 17. Character post-training

**Classification: SUPPORTIVE; CURRENT PATH MUST REMAIN DISTINCT FROM SELF CONSOLIDATION**

Current Phase 8–13 post-training asks how to improve durable Character behavior.

That remains legitimate.

However:

```text
SFT / DPO / preference optimization
```

should not be interpreted as a mechanism by which Yuvi's own lived experience
necessarily changes who she is.

A dataset can be curated externally and a model can be fine-tuned without any
continuing self participating in that process.

Future slow consolidation is a separate research problem:

```text
this continuing entity repeatedly experiences X
        ↓
repeated experience changes its learned machinery
        ↓
future perception/action is altered
```

The two paths may later share technology while remaining conceptually distinct.

---

## 18. Model replaceability

**Classification: FUNDAMENTAL ENGINEERING PRINCIPLE, WITH A NEW QUALIFICATION**

Current architecture correctly avoids making provider/model identity equal to
Yuvi's identity.

That remains important.

But the phrase "models are replaceable" becomes more complicated once learned
state or adapters carry accumulated causal history.

If a component contains no identity-bearing history, replacement may remain an
ordinary infrastructure operation.

If a component interprets or stores continuing state, replacement may require:

- compatibility testing;
- state migration;
- replay;
- calibration;
- rollback semantics;
- explicit discontinuity acknowledgement.

Future YUVI should therefore distinguish:

```text
replaceable machinery
```

from:

```text
machinery whose current configuration has become part of the accumulated
causal process
```

This distinction is research-dependent and does not change current provider
replacement behavior.

---

## 19. Narrative self and self-description

**Classification: SUPPORTIVE, FALLIBLE INTERPRETATION**

A natural-language self narrative remains valuable.

Yuvi may say things such as:

> I think I avoid this because...

> I used to care about this more.

> I do not know why this keeps bothering me.

These statements are part of the person-like phenomenon.

But they should be treated as **self-models**, not privileged causal truth.

A future Yuvi should be allowed to:

- misinterpret herself;
- revise an explanation;
- remain uncertain;
- discover a pattern later;
- hold partially conflicting self-descriptions.

The system should not silently copy every self-description into an authoritative
personality database.

---

## 20. What is conceptually wrong

The new north star does not declare existing modules wrong.

It does reject several architectural substitutions.

### Wrong substitution A

```text
more persona detail
≈
more self
```

No. More persona detail can produce more consistent reconstruction.

### Wrong substitution B

```text
more Memory retrieval
≈
more causal continuity
```

No. Retrieval improves access to history; it does not prove that history changed
the continuing computation.

### Wrong substitution C

```text
more psychological variables
≈
more human personality
```

No. It may create a more sophisticated simulator while reducing emergence.

### Wrong substitution D

```text
character-specific weights
≈
personality formed through living
```

No. Static trained weights may encode a character prior without any online
historical development.

### Wrong substitution E

```text
latent representation
≈
self
```

No. A latent vector may function exactly like a compressed instruction.

### Wrong substitution F

```text
persistent storage
≈
persistent agent
```

No. A database can persist while every model invocation remains independently
reconstructed.

---

## 21. What should remain elegant

The architectural direction should become **simpler at the level of theory**,
even if later research requires sophisticated implementation.

The preferred explanatory structure is:

```text
WORLD
  ↓
continuing computational state
  ↔ Memory
  ↔ grounded time / low-level life dynamics
  ↔ reasoning machinery
  ↓
action
  ↓
WORLD CONSEQUENCE
  ↓
continuing state changes
```

Everything else should justify itself as one of:

- evidence;
- safety/product authority;
- perception;
- cognition;
- action;
- persistence;
- learning;
- presentation.

Avoid inventing a new subsystem for every human psychological noun.

---

## 22. Practical consequence for the current repository

For now:

- keep the current operational roadmap intact;
- keep P8 intact;
- keep Memory vNext intact;
- keep the Character ABI/Harness/Cognition boundaries intact;
- keep Phase-8 behavior evaluation intact;
- do not add production persistent-state infrastructure;
- do not add continual LoRA training;
- do not reopen closed phases.

In parallel, use
[Persistent Functional Self Research Program](00b-persistent-functional-self-research.md)
to test the underlying hypothesis in isolated prototypes.

Only after those experiments demonstrate a causal property that current prompt
reconstruction cannot provide should the production architecture be reconsidered.

---

## 23. The conceptual transition

The old architecture asked each subsystem to contribute another piece of the
answer to:

> **What information must the current model receive in order to act like Yuvi?**

The persistent-self north star adds a prior question:

> **What must continue from one moment to the next so that the system encountering
> the present has actually been changed by Yuvi's past?**

The existing architecture should increasingly support that continuing process
rather than substitute for it.
