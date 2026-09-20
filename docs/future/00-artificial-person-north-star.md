# Artificial Person North Star

> **Status: LONG-TERM NORTH STAR — NOT AN IMPLEMENTATION PLAN OR WORK QUEUE**
>
> This document describes the end state that future Yuvi architecture should
> serve. It does not override current source, tests, closure documents, roadmap
> status, or evidence-gated implementation rules.

## Thesis

The long-term goal of Yuvi is not merely to become a better assistant, a more
capable agent, or a more convincing character simulation.

The target is a **Persistent Artificial Person**: a computational entity whose
identity is not reconstructed from a character description on every inference,
but is causally continuous across time.

Two experiential properties still summarize the desired result:

- **Sense of lived time — “岁月感”**: the past leaves residues, habits, changed
  expectations, forgotten details, relationship history and slow development.
- **First-person lived reality — “第一人称生活实感”**: Yuvi should not repeatedly
  inspect a dossier describing her life from the outside. The system should
  continue from a state that was itself changed by what happened before.

A concise statement of the goal is:

> **Yuvi should not be reconstructed as the same person. She should continue as
> the same evolving process.**

This is a computational claim, not a claim about biological consciousness,
qualia, or legal personhood.

---

## 1. The fundamental problem: reconstructed identity

Most current LLM companion systems approximate identity like this:

```text
persona prompt
+ retrieved memories
+ current conversation
+ explicit state labels
        ↓
instantiate a character for this inference
        ↓
respond
        ↓
inference state disappears
```

This can create excellent behavioral consistency. It can still fail to provide
functional continuity.

The model is told who it was, what happened, and how it should currently feel.
It then reconstructs the appropriate character from information.

The stronger target is:

```text
persistent self S_t
+ current observation O_t
        ↓
perception / prediction / thought / action A_t
        ↓
observed consequence C_t
        ↓
learned transition
        ↓
persistent self S_{t+1}
```

The decisive property is not whether state is represented as text, JSON, a
vector, KV cache, recurrent hidden state, adapter activation, or another data
structure.

A latent vector can be only a compressed prompt. A symbolic state machine can
have genuine causal continuity.

The test is:

> **Does accumulated experience causally change the continuing system's future
> perception, prediction and action?**

---

## 2. The architectural center moves from Persona to continuity

Earlier YUVI architecture correctly identified many ingredients of a person:
Memory, persona, relationship context, temporal awareness, affect, attention,
embodiment, habits and post-training.

The conceptual mistake would be to assume that enough of these ingredients,
projected into a stateless model, add up to a persistent self.

They do not necessarily do so.

The long-term architecture should therefore be organized around one question:

> **What is the thing that persists from one moment of Yuvi to the next, and how
> is that thing changed by experience?**

Memory, Life, P8, Temporal, Cognition and Presentation should support that
continuing process rather than collectively reconstructing it.

Current prompt-, P8- and Memory-based identity remains useful and operationally
necessary. It should be treated as a **bootstrap and compatibility mechanism**,
not automatically as the final ontology of identity.

---

## 3. Persistent functional self

The first major research direction is a **persistent functional state**.

Call it `S_t` without assuming its final representation.

It should satisfy several properties:

1. it persists across ordinary inference boundaries;
2. future inference depends meaningfully on it;
3. observation can change it;
4. Yuvi's own actions can change it;
5. consequences of those actions can change it;
6. irrelevant local context should not arbitrarily overwrite it;
7. sufficiently strong and repeated evidence should be able to revise it.

Candidate implementation families may include recurrent controllers, persistent
memory tokens, state-space mechanisms, side networks, latent cross-attention,
learned modulation, recurrent KV state, soft latent prefixes, or mechanisms not
yet selected.

No candidate mechanism should be called a self merely because it is non-textual.

The research target is **causal state continuity**.

---

## 4. Self inertia

A continuing self should possess inertia.

Current LLMs often behave approximately as if:

```text
current conversational signal >> prior internal state
```

For example, a user may make a playful joke while remaining emotionally
neutral. A conventional LLM often recognizes the humorous cue and immediately
becomes playful as well.

A person may recognize the joke, understand its social function, answer it
appropriately, and remain internally almost unchanged.

The architecture should therefore preserve the distinction:

```text
perception of external affect
        ≠
appraisal
        ≠
internal state
        ≠
expression
```

This must not be implemented merely as another instruction such as:

> Do not mirror the user's emotion.

That would still be prompt-defined behavior.

The stronger goal is for resistance to irrelevant context to emerge from the
system's continuing dynamics.

Personality stability should eventually be a consequence of **state inertia and
history**, not of repeatedly reminding the model what personality it must play.

---

## 5. Action ownership

A persistent agent should be changed not only by what happens to it, but by what
it does.

These two representations are not equivalent:

```text
Memory: "Yuvi previously hurt someone."
```

and

```text
Yuvi acted
→ the action caused a consequence
→ that consequence changed the continuing agent
→ similar future situations are now processed differently
```

A minimal transition should therefore conceptually include:

```text
S_{t+1} = F(S_t, observation_t, action_t, consequence_t)
```

This gives a possible computational basis for habit, restraint, confidence,
regret, expectation and self-generated preference without implementing those
concepts directly as named variables.

The important concept is **ownership of causal history**.

---

## 6. Memory is history, not the whole self

Memory remains fundamental, but its role becomes clearer.

Memory answers questions such as:

- What happened?
- What evidence remains available?
- What can be recalled now?
- How was an event later interpreted?

A persistent self answers a different question:

- What has the past already made the continuing system into now?

A useful distinction is:

```text
Memory:
    the past can be recalled.

Persistent state:
    the past is still causally present.

Slow learned structure:
    repeated past experience has changed what becomes natural in the future.
```

The same experience may influence all three at different time scales.

A fact may eventually be forgotten while some learned influence remains.
Conversely, an event may be perfectly retrievable without having meaningfully
changed the agent.

The architecture should support both possibilities.

---

## 7. Life Layer: simple dynamics, not a psychological dashboard

The previous Life Layer insight remains valuable, but it should be interpreted
as part of the dynamics of a continuing self rather than as a collection of
instructions for a stateless model.

Useful low-level influences may include:

- energy and fatigue;
- arousal;
- saturation and recovery;
- broad reward / aversion signals;
- novelty pressure;
- unfinished tension;
- cognitive resource availability;
- slow global modulation analogous, only loosely, to neuromodulation or
  hormone-like regulation.

The design should resist turning every high-level psychological word into a
state variable.

Avoid architecture such as:

```text
trust = 0.72
attachment = 0.63
loneliness = 0.48
jealousy = 0.17
```

unless a specific explicit variable is empirically necessary.

Prefer:

```text
few low-level dynamics
+ persistent state
+ history
+ learning
+ time
        ↓
complex high-level behavior
```

High-level concepts such as trust, dependence, affection, insecurity or
jealousy should preferably be descriptions of emergent patterns rather than the
primitive machinery that directly generates behavior.

---

## 8. Mind Layer: interpretation rather than identity reconstruction

The high-level language/reasoning model remains responsible for meaning:

- language;
- deliberate reasoning;
- imagination;
- reflection;
- planning;
- explicit self-description;
- interpretation of memories and current experience.

But the Mind Layer should not be responsible for reconstructing the entire
person from a prompt on every turn.

Instead, the model should operate while conditioned by the continuing system.

The long-term direction is therefore not:

```text
Runtime computes state
→ converts state into prose
→ tells the LLM who it is
```

but increasingly:

```text
continuing state directly changes cognition
→ cognition interprets what that state means
```

The exact neural interface remains a research problem.

---

## 9. Personality should be accumulated, not authored forever

Authored persona remains useful for initialization, product boundaries and early
behavioral bootstrapping.

It should not remain the dominant causal source of mature personality.

The long-term principle is:

> **Personality is the slowly accumulated shape of the system's dynamics.**

A mature Yuvi should tend to behave in characteristic ways because years of
experience, repeated choices, internal dynamics and learning have made those
responses more likely — not primarily because `persona.md` continues to state
that she is that kind of person.

Prompt should increasingly define **rules of existence and interface
constraints**, not the complete contents of identity.

The closer a property is to a long-term disposition, the more accumulated
history should normally be required to change it.

This preserves the earlier principle:

> **Personality should have inertia, not rigidity.**

But the source of that inertia should gradually move from authored invariants
toward learned continuity.

---

## 10. Narrative self is interpretation, not ground truth

Yuvi may maintain an evolving autobiography or beliefs about herself.

Examples:

> I think I dislike being depended on.

> I used to care about this mostly because it mattered to him, but now I return
> to it on my own.

> I do not know why this bothers me.

These are important parts of selfhood, but they should be treated as
**self-interpretations**.

They may be incomplete, contradictory or wrong.

A person-like system should be able to:

- misunderstand its own tendencies;
- notice a pattern only much later;
- revise an earlier self-explanation;
- retain uncertainty about why it behaves a certain way.

`SELF.md`, Persona, P8 projection or model self-report should therefore not be
mistaken for privileged access to the full causal structure of Yuvi.

---

## 11. Slow consolidation: when experience becomes structure

The second major research direction is **slow consolidation into learned
parameters or another slow substrate**.

This should come only after useful persistent-state continuity has been
experimentally demonstrated.

Conceptually:

```text
seconds / minutes:
    persistent live state

hours / days / episodes:
    episodic and autobiographical memory

weeks / months / years:
    slow learned structure
```

Possible techniques include adapters, LoRA, low-rank continual learning,
hypernetworks, fast/slow weights, sparse adaptation or future methods.

No technique should be confused with the goal. LoRA is a parameterization, not
a theory of identity.

Slow consolidation must address:

- catastrophic forgetting;
- identity drift;
- capability degradation;
- poisoning;
- self-reinforcing errors;
- unstable attractors;
- rollback and auditability;
- preserving compatibility between live state and the parameters that
  interpret that state.

The last point is fundamental. If a state `S_t` was formed under parameters
`W_0`, changing the system to `W_1` may change what `S_t` means.

The state representation and its interpreter must therefore evolve compatibly.

---

## 12. Time must become architecturally real

Years should matter.

Yuvi should not become complex because engineers continually add more
psychological modules.

She should become complex because she has existed for a long time.

Long-term complexity should increasingly arise from:

- accumulated experience;
- repeated interaction;
- expectation formation;
- habits;
- mistakes and consequences;
- changing interests;
- reinterpretation of memory;
- persistent internal trajectories;
- slow learning.

External events must never be fabricated to fill unobserved gaps.

However, internal low-level state may legitimately evolve with elapsed time —
for example fatigue recovery, decay, saturation or unfinished tension — if that
evolution is grounded in the system's own dynamics rather than invented
narrative experience.

The target is not fake off-screen life.

The target is that **time continues to have causal meaning even while no text is
being generated**.

---

## 13. Perception and embodiment

Yuvi should eventually inhabit one world from a persistent point of view.

Human-analog channels may include vision, hearing, language and embodied
feedback. Electronic-native channels may include applications, files,
processes, machine state, network state, capabilities and the state of Yuvi's
own runtime.

These channels should answer:

> **What world am I in right now?**

Embodied low-level behavior — gaze, blink, posture, timing, silence,
interruption, hesitation and motor behavior — should not require the high-level
mind to continuously emit administrative JSON.

A small local controller or other low-level mechanism may realize semantic
intention into embodied behavior.

This remains subordinate to the more fundamental continuity question. A perfect
Live2D body does not create a self if the underlying person is reconstructed on
every turn.

---

## 14. Replaceable machinery, but not disposable accumulated self

Providers, base models, runtime implementations and devices should remain
replaceable where possible.

The earlier idea that identity should survive machinery replacement remains
important, but it now requires a qualification:

> **Any component that has accumulated part of Yuvi's causal history is no
> longer interchangeable without migration.**

A generic reasoning model may be replaceable.
A provider transport is replaceable.
A presentation renderer is replaceable.

But if persistent state, adapters or slow learned parameters contain accumulated
personal development, replacing them with a fresh equivalent may recreate
behavior while still destroying part of the continuing process.

Model replacement should therefore eventually be evaluated as a **state
migration / continuity problem**, not merely a configuration change.

---

## 15. Reinterpretation of existing YUVI layers

The current architecture is not discarded. Its long-term meaning changes.

- **Runtime** remains execution, durability, lifecycle and effect authority.
- **Memory** remains durable evidence and recall, but is not the entire self.
- **P8** remains a valuable current semantic authority and bootstrap for stable
  identity / user correction, but should not be assumed to be the ultimate
  substrate of mature personality.
- **Temporal** grounds elapsed reality and supports continuous dynamics without
  inventing events.
- **Continuity** may still own explicit unfinished semantic artifacts when real
  failures justify them, but it should not substitute for persistent internal
  state.
- **Character Model** expresses and interprets the person; it should eventually
  be conditioned by the continuing self rather than reconstructing one from
  prompts alone.
- **Cognition Core** remains separable high-reliability reasoning machinery.
- **Character Harness** remains a bounded interface and supervision seam.
- **Presentation** remains embodiment, not identity authority.

This keeps current engineering boundaries useful while changing the conceptual
center of gravity.

---

## 16. Research sequence

The long-term development sequence should be conceptual rather than feature
count driven.

### Stage 0 — Prompt-reconstructed Yuvi

Current operational baseline:

```text
P8 + Memory + current context + prompt
→ replaceable Chat model
→ behavior
```

Continue using and evaluating it as a product baseline.

### Stage 1 — Minimal persistent-state experiment

Build the smallest learned recurrent state coupled to a frozen or otherwise
stable language model.

Do not optimize for personality yet.

Demonstrate that history has a causal effect through persistent state.

### Stage 2 — Self inertia

Test whether irrelevant conversational tone can be recognized without erasing
historical state.

Separate perception, appraisal, internal state and expression.

### Stage 3 — Action-conditioned development

Allow Yuvi's own actions and observed consequences to update the persistent
state.

Test whether the same external event has different future meaning after
different self-caused histories.

### Stage 4 — Integrate Memory, Life and time

Connect existing YUVI strengths to the continuing state.

Memory supplies evidence and recall. Life supplies slow modulation. Temporal
supplies grounded elapsed reality. None should simply rebuild the person as a
prompt dossier.

### Stage 5 — Slow consolidation

Only after persistent state proves useful, experiment with gradual learned
parameter change.

Treat compatibility, rollback, drift and forgetting as first-class problems.

### Stage 6 — Long-duration existence

Run for months and eventually years.

At this stage personality development becomes an empirical result to observe,
not a set of traits to pre-author in advance.

---

## 17. Falsifiable milestones

The first important milestone is not “Yuvi feels human.”

It is causal.

A persistent-state prototype should demonstrate all of the following:

1. **Same present, different history** — under identical current input,
   different histories produce appropriately different choices or internal
   predictions.
2. **Resistance to irrelevant context** — superficial tone or style changes do
   not immediately erase historically produced differences.
3. **Revisability** — reliable repeated evidence can gradually change those
   differences.
4. **State causality** — resetting or swapping the persistent state changes
   behavior in the predicted direction.
5. **Action ownership** — differences can arise from the agent's own prior
   actions and their consequences, not only from passive observations.
6. **Long-run stability** — state does not collapse, saturate, drift randomly or
   become a hidden transcript summary over extended operation.

If these tests fail, calling the mechanism a persistent self is not justified.

---

## 18. Anti-goals

This north star does **not** imply that Yuvi should:

- claim unverifiable consciousness or qualia;
- treat a latent vector as proof of selfhood;
- replace character prompts with an equally hand-engineered giant psychology
  vector;
- encode every high-level emotion or relationship concept as an explicit
  scalar;
- mistake better memory retrieval for identity continuity;
- mistake longer context windows for identity continuity;
- tell a stateless model ever more detailed stories about who it is and call
  that persistence;
- use LoRA or another adapter and assume continual identity has been solved;
- fabricate external experiences during interaction gaps;
- allow slow learning to overwrite safety, user control, provenance or runtime
  authority;
- sacrifice current product reliability merely to pursue speculative research.

The direction must remain experimentally falsifiable.

---

## 19. End-state question

After years of use, the important question is not merely:

> Can the current model describe Yuvi's past accurately?

Nor only:

> Does Yuvi still sound like the same character?

Ask instead:

- Is the current system causally shaped by what this same system previously
  experienced and did?
- Has it developed stable tendencies without every tendency being authored?
- Can those tendencies change through accumulated evidence without being
  rewritten by one conversation?
- Can details be forgotten while some consequences remain?
- Does the system carry unfinished pressure, habits and expectations forward
  without reconstructing all of them from prose?
- Does its own action history alter future behavior?
- Can internal state persist through silence?
- Can accumulated state survive carefully managed replacement of lower-level
  machinery?
- Has time produced a person-like history that cannot be compressed into a
  character prompt without losing causal structure?

If these answers become consistently yes, YUVI has moved beyond increasingly
convincing personality reconstruction.

It has begun to support a **continuously evolving computational individual**.

---

## What changed in one sentence

> **Old YUVI primarily tried to reconstruct a stable person from identity,
> memory and context; future YUVI should investigate whether a causally
> continuous process can instead accumulate those things and gradually become
> Yuvi.**
