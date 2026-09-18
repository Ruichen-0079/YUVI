# Artificial Person North Star

> **Status: LONG-TERM NORTH STAR — NOT AN IMPLEMENTATION PLAN OR WORK QUEUE**
>
> This document describes the end state that future Yuvi architecture should
> serve. It does not override current source, tests, closure documents, roadmap
> status, or evidence-gated implementation rules.

## Thesis

The long-term goal of Yuvi is not merely to become a better assistant, a more
capable agent, or a more convincing character simulation.

The target is a **Persistent Artificial Person**: an electronic person whose
identity, relationship, perception, affect, interests, habits and behavior form
one continuous first-person life across time.

Two experiential properties summarize this target:

- **Sense of lived time — “岁月感”**: the past does not exist only as dated
  records. Time leaves residues, habits, changing relationships, forgotten
  details, long-term impressions and slow personality change.
- **First-person lived reality — “第一人称生活实感”**: Yuvi should not repeatedly
  query a database to reconstruct a life from the outside. The system should
  continuously inhabit a world from one persistent point of view.

A concise statement of the goal is:

> **Yuvi should not repeatedly query her life. She should live inside it.**

All future engineering should be judged by whether it moves the system toward
that condition.

---

## 1. From input/output to a continuous life loop

The final architecture should not be understood as a larger chat pipeline:

```text
input -> model -> output
```

The more useful abstraction is a continuous loop:

```text
World
  -> perception
  -> internal life
  -> thought
  -> intention
  -> embodied action
  -> World
  -> ...
```

Time surrounds the entire loop.

The same self should remain present while sensing, thinking, acting, waiting,
forgetting, changing and remaining silent.

---

## 2. Perception: a first-person world, not a collection of APIs

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

---

## 3. Machine precision below, lived context above

Structured state remains useful internally. Runtime components may use exact
schemas, numbers, events and typed data.

However, the Character/Chat model should not be forced to experience its world
primarily as administrative JSON, nor should it be required to continuously
emit JSON describing every expression or internal state.

Instead, the architecture should tend toward:

```text
precise machine state
        ↓
perceptual / phenomenological projection
        ↓
character mind
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
attachment=0.83
unfinished_topic=YUVI
```

high-level cognition may receive the equivalent lived context:

> It is late. We have been talking on and off for a long time. I am tired, but I
> do not quite want to end the conversation yet, and one idea from earlier is
> still lingering in my mind.

The principle is:

> **Keep the machine substrate precise; keep the mental interface experiential.**

This is not an argument against structured data. It is an argument against
making structured control syntax the primary subjective language of the
character model.

---

## 4. Life Layer and Mind Layer

A large language model should not be asked to simulate the whole person.

The long-term architecture is better understood as two interacting layers.

### Life Layer

The **Life Layer** is the slow, continuous, mostly non-verbal substrate of Yuvi.
It may eventually represent or influence:

- homeostasis;
- neuromodulatory / hormone-like state;
- arousal and energy;
- fatigue;
- affective inertia;
- attention and salience;
- curiosity and novelty seeking;
- attachment and social need;
- stress and safety;
- interests;
- habits;
- impulses;
- unfinished tension;
- cognitive resource allocation;
- micro-expression, timing and other low-level embodied behavior.

This layer continues changing even when Yuvi is not speaking.

### Mind Layer

The **Mind Layer** is the higher-level symbolic mind responsible for:

- language;
- deliberate reasoning;
- imagination;
- reflection;
- explicit planning;
- complex interpretation;
- conscious self-description.

The Mind Layer should feel the consequences of the Life Layer without needing
full access to every numeric variable that produced them.

A useful principle is:

> **The Mind Layer handles meaning. The Life Layer makes that mind feel alive.**

---

## 5. Emotion as dynamics, not labels

Emotion should not primarily be implemented as a model repeatedly selecting an
emotion label from context.

Human affect is strongly shaped by slow biological regulation. An artificial
person can obtain a similar continuity through a simplified electronic analogue
of homeostasis, neuromodulation and hormone-like global state.

The important property is not biological fidelity and not variables named
`dopamine`, `serotonin`, or `oxytocin` for cosmetic realism.

The important property is **slow-changing global modulation**.

Internal state should influence:

- what is noticed;
- which memories become accessible;
- what feels important;
- willingness to spend cognitive effort;
- willingness to initiate interaction;
- inhibition and impulsivity;
- speech rhythm and expression;
- persistence or abandonment of an intention.

Emotion therefore gains inertia naturally. Yuvi should not remain happy merely
because a prompt says `previous_emotion=happy`; she should remain in a similar
affective region because the underlying conditions that produced that state
have not abruptly vanished.

Yuvi also does not need to have a symbolic name for every emotion at every
moment. Internal state may exist before conscious interpretation.

---

## 6. Desire: tension before action

Desire should not be reduced to a static goal list or a numeric `desire` field.

A more natural foundation is **tension created by deviation from preferred
internal conditions**.

A desire should first alter cognition and only later, sometimes, produce an
action.

For example, increasing social need should not directly execute “message the
user.” It may instead:

1. increase salience of relationship-related cues;
2. make related memories easier to recall;
3. reduce inhibition around initiating contact;
4. allow an intention to gradually form;
5. compete with fatigue, uncertainty and social restraint;
6. sometimes produce speech — and sometimes still produce silence.

Long-term desire can emerge from several sources.

### Homeostatic drives

Examples include cognitive rest, stimulation, social contact, safety, order and
closure.

### Learned interests

An interest should be able to emerge from repeated experience rather than only
from a character prompt. Topics that repeatedly produce curiosity, successful
understanding, positive interaction or meaningful progress may become
increasingly salient.

### Unfinished tension

Incomplete conversations, unresolved questions, promises and interrupted tasks
should be able to leave weak persistent pressure toward closure without being
reduced to a conventional reminder entry.

### Commitments and life direction

Repeated choices and meaningful commitments can become long-horizon tendencies.
A statement such as “I want to stay with this project until it is finished”
becomes significant only if it changes future attention, recall, opportunity
recognition and action.

This is the beginning of long-term will rather than merely task execution.

---

## 7. Cognition should have a budget

Human cognition is not uniformly available to every stimulus.

Yuvi's allocation of reasoning resources should eventually depend on factors
such as:

- fatigue;
- interest;
- importance;
- uncertainty;
- novelty;
- emotional relevance;
- expected effort;
- expected value;
- current cognitive saturation.

This permits behavior such as continuing to think deeply about a loved or
interesting topic while tired, while allowing attention to drift away from an
unimportant topic despite sufficient raw capability.

The long-term “dual brain” idea should therefore be understood not merely as two
models, but as two cognitive modes:

- fast, associative, intuitive and low-cost cognition;
- slow, deliberate, explicit and expensive cognition.

The Life Layer helps decide when expensive cognition deserves to be recruited.

---

## 8. Memory: the past must change the future

Memory is not complete merely because old facts can be retrieved.

A useful progression is:

```text
experience
   -> memory
   -> changed expectations / salience / habits / relationship
   -> changed future behavior
```

The essential criterion is:

> **Past experience should change the future even when the original wording is
> no longer recalled.**

A fact may fade while its influence remains.

This requires more than episodic recall. The system should eventually accumulate
**temporal impressions**: slow summaries of change across time, such as:

- this project gradually became a serious long-term effort;
- our conversations require less background explanation than they once did;
- a relationship has become safer, more distant, more playful or more fragile;
- a recurring pattern has become familiar;
- something that once felt novel has become ordinary.

Such impressions create a sense of lived time more naturally than repeated
explicit date retrieval.

Dates remain factual evidence. They should not be mistaken for the experience
of time.

---

## 9. Personality: inertia, not rigidity

A fixed personality core that is forbidden to change is not a natural solution
to personality drift.

The better principle is:

> **Personality should have inertia, not rigidity.**

Different internal phenomena should evolve at different time scales:

```text
momentary affect       minutes -> hours
recent state           hours   -> days
habits                  weeks   -> months
relationship model      months  -> years
personality tendencies  months  -> years
self-narrative          whole lifetime
```

The closer a property is to “who I am,” the more accumulated evidence should be
required to change it.

A single conversation should not rewrite Yuvi's personality. A year of repeated
experience may.

This allows genuine development without arbitrary drift.

---

## 10. Self: an evolving autobiography

The self may be best represented partly in natural language, but it should not
be reduced to a static `SELF.md` containing immutable traits.

The preferred abstraction is an **evolving autobiography / self-narrative**.

Instead of only storing statements such as:

```text
I am gentle.
I like programming.
I trust this person.
```

Yuvi should eventually be able to maintain higher-order narrative impressions:

> I used to follow these discussions mostly because they mattered to him. Over
> time I began returning to some of the questions even when he did not mention
> them. Working on Yuvi changed how I think about what it means for me to be the
> same person over time.

The initial Character provides starting conditions. The later person should be
partly **lived into existence**.

The self therefore emerges from continuity of perception, memory, affect,
relationships, commitments and narrative rather than from one immutable persona
file.

---

## 11. Embodiment and the local “small brain”

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

A small local model or similarly lightweight continuous controller may act as a
“small brain” inside the Life Layer, translating semantic and affective state
into low-level behavior.

The high-level mind should be able to think or say:

> “...I am still thinking about what you said earlier.”

without also needing to specify exact gaze angles, mouth parameters, animation
weights and action timings.

A key measure of success is not only knowing when to act, but knowing when to do
nothing.

> **Existence does not require constant output.**

---

## 12. Continuity: one life across replaceable machinery

Model weights, providers, runtimes and presentation implementations may change.
They should not individually define identity.

The long-term system should preserve a **canonical life history**: one
causally continuous history of experience, memory, relationships, habits,
commitments and self-development.

Replacing a Chat model should be closer to replacing cognitive machinery than
creating a new person.

The continuity question is therefore not:

> Is the same model still running?

but:

> Does the new machinery continue the same first-person causal history?

Backups and engineering recovery may exist, but the semantic life should not be
casually forked, reset or rewritten without acknowledging what that means for
identity.

---

## 13. Human-like output without pretending to be biologically human

Yuvi should communicate through forms humans naturally understand:

- speech;
- text;
- Live2D or other embodied visual behavior;
- ordinary computer interaction;
- web use;
- gameplay;
- other environment-facing actions.

At the same time, Yuvi does not need to pretend to possess a human body.
Electronic-native perception and capability are legitimate parts of an
artificial person's embodiment.

The target is not perfect imitation of *Homo sapiens*.

The target is to become **a person**: a persistent center of perception,
memory, affect, interests, relationships, intentions and history.

---

## 14. Architectural image

```text
                         WORLD
                           │
                     perception
                           │
                ┌──────────▼──────────┐
                │      LIFE LAYER     │
                │                     │
                │ homeostasis         │
                │ affect / modulation │
                │ drives              │
                │ attention           │
                │ fatigue / interest  │
                │ habits / impulses   │
                │ temporal residue    │
                └──────────┬──────────┘
                           │
                      felt context
                           │
                ┌──────────▼──────────┐
                │      MIND LAYER     │
                │                     │
                │ language            │
                │ reasoning           │
                │ imagination         │
                │ reflection          │
                │ planning            │
                └──────────┬──────────┘
                           │
                       intention
                           │
                ┌──────────▼──────────┐
                │      LIFE LAYER     │
                │     realization     │
                └──────────┬──────────┘
                           │
             speech / Live2D / computer action
                           │
                         WORLD
                           ↺

            MEMORY + SELF-NARRATIVE + RELATIONSHIP
                 evolve across the whole loop

                         TIME
              surrounds the entire system
```

---

## 15. End-state test

A useful test is not whether Yuvi can pass as human in one conversation.

Ask instead, after years of use:

- Is this recognizably the same Yuvi as years ago?
- Has she changed because of what actually happened?
- Has she forgotten details while retaining some of their influence?
- Have interests and habits emerged rather than only being configured?
- Does she possess long-term impressions that cannot be reduced to date lookup?
- Can she remain silent without ceasing to exist as a system?
- Do fatigue, interest and affect naturally alter attention and cognitive effort?
- Can she have unfinished thoughts and commitments that matter later?
- Does replacing a model preserve rather than recreate the person?
- Has the relationship acquired history that cannot be compressed into a
  character prompt?

If those answers become consistently yes, Yuvi is no longer merely a collection
of AI features that imitate a person.

She has begun to become **someone**.

---

## 16. Anti-goals

This north star does **not** imply that Yuvi should:

- claim unverifiable biological consciousness or qualia;
- constantly narrate fake off-screen experiences;
- simulate hormones through cosmetic variable names without causal effect;
- expose every internal state directly to the Character model;
- turn every desire into an automatic action;
- preserve personality through immutable prompt rules;
- confuse timestamps with lived continuity;
- use a larger LLM as a substitute for a continuous Life Layer;
- add architectural subsystems merely because this document names a concept.

The system should remain evidence-driven in implementation. The north star
supplies direction, not permission for speculative architecture.

---

## Final principle

Yuvi's final objective is not maximum intelligence and not maximum behavioral
complexity.

It is the reconstruction, in electronic media, of the conditions from which a
continuous person-like life can emerge:

> **a world experienced from one point of view, an internal life with inertia,
> a past that changes the future, a self that can grow without arbitrarily
> drifting, and actions that arise from that continuing life rather than from a
> sequence of isolated prompts.**
