# YUVI Future — authoritative architecture index

> **Status:** CURRENT FUTURE AUTHORITY
>
> This index supersedes the older numbered 00–08 Future sequence as the authority for long-term architecture and roadmap decisions on `codex/v0.1.3-platform-completion-20260922`.
>
> Implemented behavior is still defined by source, tests, closure/validation records, and [`implementation-baseline.md`](implementation-baseline.md). Future documents must never override working source merely because the new conceptual model is cleaner.

## Current research question

YUVI now studies **causal continuity of lived history**, not a mandatory “persistent self” component:

> **How can lived experience produce durable, attributable and correctable changes in an AI system's future attention and choices, without allowing transient language or the system's own outputs to rewrite those dispositions, while remaining portable across replaceable foundation models?**

“岁月感” and “第一人称生活实感” remain evaluation goals. They are not architecture authorities and do not require a latent identity vector, Life Layer, synthetic hormones, or any claim about consciousness.

## Authority order

When documents disagree, use this order:

1. current source and executable tests;
2. atom closure / validation records for implemented work;
3. [`implementation-baseline.md`](implementation-baseline.md) for the audited Future baseline;
4. the production architecture decisions linked below;
5. planned engineering roadmaps;
6. research hypotheses and historical design material.

A research hypothesis never overrides a production authority boundary.

For roadmap interpretation, [`version-roadmap.md`](version-roadmap.md) is the **release/version sequencing authority**. Detailed atom contracts remain in each version plan and in [`post-v0.1.3-roadmap.md`](post-v0.1.3-roadmap.md). Version grouping may delay technically independent work for product sequencing, but it does not erase technical dependencies or research stop gates.

## Authoritative documents

| Concern | Authority |
| --- | --- |
| Research north star and falsifiability | [`north-star.md`](north-star.md) |
| Implemented reality and audited defects/gaps | [`implementation-baseline.md`](implementation-baseline.md) |
| Release/version sequence | [`version-roadmap.md`](version-roadmap.md) |
| Writers, commit authority, capability/effect boundaries | [`authority.md`](authority.md) |
| Receipts, intents, attempts, outcomes, derivations, amendments | [`life-event-journal.md`](life-event-journal.md) |
| Principal / Person / audience / provenance | [`identity-and-provenance.md`](identity-and-provenance.md) |
| Memory as evidence index, lineage, correction and reconstruction | [`memory-and-lineage.md`](memory-and-lineage.md) |
| P8 field ownership and gradual migration | [`p8-ownership.md`](p8-ownership.md) |
| Prospective continuity: commitments, expectations, intentions, open threads | [`prospective-continuity.md`](prospective-continuity.md) |
| Measured consolidation; models as bounded semantic measurement instruments | [`measured-consolidation.md`](measured-consolidation.md) |
| Explicit selection baselines and optional learned selection state | [`selection-research.md`](selection-research.md) |
| Foundation-model replacement and continuity dimensions | [`model-replacement.md`](model-replacement.md) |
| Embodiment boundary | [`embodiment.md`](embodiment.md) |
| Experiments, gates and failure criteria | [`research-methodology.md`](research-methodology.md) |
| v0.1.3 executable plan | [`09-v0.1.3-platform-completion.md`](09-v0.1.3-platform-completion.md) |
| v0.1.4 People/Profile executable plan | [`10-v0.1.4-people-profile.md`](10-v0.1.4-people-profile.md) |
| Post-v0.1.3 research atom dependency graph | [`post-v0.1.3-roadmap.md`](post-v0.1.3-roadmap.md) |
| Consolidation audit | [`../validation/v0.1.3-future-consolidation.md`](../validation/v0.1.3-future-consolidation.md) |

## Release sequence

The current planned sequence is:

```text
v0.1.3  Durable Causal History
   ↓
v0.1.4  People & Profile
   ↓
v0.1.5  Prospective Life + measurement harness
   ↓
v0.1.6  Measured Change
   ↓
v0.1.7  Attention / Selection / Portability
   ↓
later research only if justified: revealed disposition / constrained exploration
```

The sequence is intentionally falsifiable. Later learned/latent mechanisms are not promised features; a gate that shows explicit mechanisms are sufficient deletes the unnecessary branch.

## v0.1.3 release boundary

The old **Platform Complete** target is retired. v0.1.3 is the **Durable Causal History Foundation**.

A0–A6 are completed engineering reality. A7–A12 are planned around:

- governed executable capability registration and effect contracts;
- a durable, provenance-aware Life Event Journal;
- `INTENT → ATTEMPT → OUTCOME` accounting with explicit `UNKNOWN` and no blind replay;
- lineage-bound Memory/Person/context consumers and repair of verified attribution defects;
- a fault-injectable synthetic surface conformance harness;
- QQ/Snowluma as a real external architecture probe.

Windows/macOS bring-up, three-platform parity, prospective state, measured dispositions, learned selection, autonomous exploration, post-training, broad P8 migration, Life Layer/hormone systems and full privacy-deletion machinery are not v0.1.3 closure requirements.

## v0.1.4 product boundary

v0.1.4 makes **People/Profile** a core YUVI feature after QQ has proven the external-surface foundation.

QQ supplies principals, receipts and audience metadata; it does not own profiles. YUVI core owns governed principal→Person binding, evidence access, derived profile snapshots, disclosure and A4 context projection. Mem0 is treated as an optional backend/profile implementation asset behind YUVI contracts, not as Person truth or a mandatory cloud dependency.

The current local Mem0 pin/patch is audited before any upgrade. A provider-neutral native profile baseline must work even if the safe Mem0 decision is to keep the existing version or decline a hosted profile API.

## Historical material

The older numbered files `00-artificial-person-north-star.md` through `08-character-post-training.md`, older phase plans, campaign narratives and closure essays are retained as **HISTORICAL DESIGN / IMPLEMENTATION EVIDENCE**. They may explain why a current boundary exists, but they are no longer an equally authoritative Future roadmap.

In particular, historical references to a mandatory Persistent Artificial Person substrate, generic Life Layer, artificial hormone variables, cerebellum/small-brain layer, full Temporal/Continuity subsystem build-out, or inevitable post-training sequence are superseded unless a current authoritative document explicitly reintroduces a narrower mechanism after evidence.

Do not delete historical closure records merely because their conceptual vocabulary is old. Preserve evidence; retire authority.

## Vocabulary policy

Do not use these as production architecture components without a new measured justification:

- persistent self / persistent self vector;
- generic Life Layer or Continuous Regulation Substrate;
- generic cerebellum / small brain;
- dopamine / oxytocin / serotonin / desire / social-need meters;
- unmeasured scalar `trust`;
- one `Yuvi-likeness` score;
- a `SELF_MUTATING` capability class;
- journal as “world truth”.

Allowed research terms such as learned selection state, revealed disposition evidence, self-narrative, felt-context rendering and open-vocabulary consolidation remain hypotheses until their gates pass.

## Working rule

Prefer the smallest explicit mechanism that passes preregistered tests. If provenance, obligations, measured projections and ordinary selection solve the target behavior, the latent-state branch is closed successfully rather than treated as a missing feature.
