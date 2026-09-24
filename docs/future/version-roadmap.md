# YUVI version roadmap

> **Status:** CURRENT RELEASE-SEQUENCING AUTHORITY
>
> This document answers **what version comes next and what each version is meant to make true**. It does not replace the detailed atom contracts in the v0.1.3 plan or the post-v0.1.3 research roadmap. When a technical dependency conflicts with convenient version grouping, the dependency wins.
>
> Current implemented baseline is A0–A6 plus A7.1, A7.2 and the storage-independent A8.1 journal contract. See [`implementation-baseline.md`](implementation-baseline.md). Current Future authority is indexed in [`README.md`](README.md).

## 1. Release philosophy

YUVI will no longer advance by adding broad psychological subsystems. Releases are organized around one observable capability boundary at a time:

```text
v0.1.3  Durable Causal History
        "What happened, who/what caused it, what did I attempt, and what is actually known?"

v0.1.4  People & Profile
        "Who is this person across surfaces, and what evidence-backed profile do I currently know about them?"

v0.1.5  Prospective Life
        "What did I commit to, what am I waiting for, and what remains unresolved across time/restart?"

v0.1.6  Measured Change
        "Can repeated eligible experience produce bounded, testable long-term relational/dispositional change?"

v0.1.7  Attention, Selection & Portability
        "Which parts of history should influence the present, and does learned selection add anything over explicit mechanisms?"

later research
        Revealed disposition / constrained exploration only if earlier gates justify them.
```

The release numbers are planning labels, not promises that every research branch will be implemented. A failed gate can intentionally delete later work.

## 2. Execution discipline for coding agents

Every implementation atom is executed independently.

Before an atom:

1. Fetch the target branch and verify the exact current HEAD.
2. Read the authoritative Future index, implementation baseline, the version plan, the atom definition, and the previous atom's validation record.
3. Inspect current source/tests before editing. Documentation is not allowed to overrule implemented reality.
4. If HEAD or implemented authority differs from the atom's stated preconditions, stop and report the mismatch. Do not silently reconcile, rebase, reset, or reinterpret completed work.

For every atom:

- one coherent semantic change;
- no speculative implementation of later atoms;
- preserve Runtime as the single semantic execution authority;
- preserve one active owner per meaning;
- add/modify tests that prove the atom's exit criteria;
- write a validation record with exact commit/environment/results;
- update `implementation-baseline.md` only for reality actually changed;
- update ownership/authority docs when an owner changes;
- commit and push only after the atom closes cleanly.

A coding model should never implement multiple roadmap atoms merely because they are adjacent.

---

# v0.1.3 — Durable Causal History Foundation

Detailed authority: [`09-v0.1.3-platform-completion.md`](09-v0.1.3-platform-completion.md).

## Current state

A0–A6, A7.1, A7.2 and A8.1 are implemented. A8.2–A12 remain planned engineering. A8.1 validation is recorded in [`v0.1.3-a8.1-journal-contract.md`](../validation/v0.1.3-a8.1-journal-contract.md).

The release is best tracked as three milestones rather than six family numbers.

### Milestone 1 — Evidence Foundation

Default execution order:

```text
A7.1 → A7.2 → A8.1 → A8.2 → A10.1
```

Result:

- executable capabilities have explicit effect contracts;
- plugins can register only narrow governed executable handles;
- a versioned journal command, envelope and evidence-selector contract exists;
- source/principal/audience/retention semantics are structurally represented, while accepted input becomes durable receipt evidence only after A8.2;
- the reproduced legacy LLM Memory attribution defect is closed;
- new evidence-backed Memory writes require committed lineage.

This is the first intentional checkpoint. Perform an authority-bypass audit before continuing to external effects.

### Milestone 2 — Action Foundation

Default execution order:

```text
A9.1 → A9.2
          ├→ A10.2
          └→ A11.1 (may begin here)
A9.3 + A10.1 + A10.2 → A10.3
```

Result:

- a logical external action has one durable INTENT identity;
- concrete ATTEMPTs and OUTCOMEs are accounted for;
- crash ambiguity is explicit; UNKNOWN is preserved where the remote world cannot be proven;
- existing provider/stream/speech/presentation effects are covered rather than only new plugins;
- Person/controller/voice/P8 corrections have causal lineage without creating new domain owners;
- a context-use manifest can explain which retained evidence and projection versions an execution actually saw.

`A9.3` must start with a read-only effect-surface audit. If the source reveals separate large seams for provider generation, streamed publication, and speech/presentation, split A9.3 into smaller validated leaf atoms before implementation. Do not pre-split it for roadmap aesthetics.

### Milestone 3 — Reality Check

```text
A11.1 → A11.2 → A12.2
A7.1  → A12.1 ─────┘
```

`A12.1` should begin early after A7.1 when an authorized Snowluma/QQ test environment is available. It is a protocol/effect probe, not the final adapter implementation.

Result:

- deterministic fault injection proves the six v0.1.3 invariants under restart/concurrency;
- one real QQ/Snowluma private/group surface passes the same contract;
- unsupported remote guarantees remain UNKNOWN/unsupported rather than being papered over;
- QQ remains a thin surface rather than a second conversation/Memory/persona Runtime.

### v0.1.3 closure

v0.1.3 ends at A12.2. Do not add a generic A13 cleanup atom. Windows/macOS parity, relationship learning, profiles, prospective state, learned selection, and autonomous exploration are not v0.1.3 closure requirements.

---

# v0.1.4 — People & Profile

Detailed executable plan: [`10-v0.1.4-people-profile.md`](10-v0.1.4-people-profile.md).

## Product result

A Person becomes a core YUVI domain object across surfaces, and YUVI can expose an evidence-linked, regenerable semantic profile of that Person.

QQ is the first high-value source of multi-person evidence, but **People/Profile is not a QQ plugin feature**. QQ contributes principals, receipts, audience and transport metadata. Core YUVI owns Person binding, evidence access, profile derivation, disclosure and context projection.

Conceptually:

```text
QQ / voice / desktop / future surfaces
                ↓
             principal
                ↓ governed binding
              Person
                ↓
       committed evidence / Memory
                ↓
        derived profile snapshot
                ↓
          People UI + A4 context
```

## Atom order

```text
PF1 → PF2 → PF3 → PF4? → PF5 → PF6
```

- **PF1** freezes People/Profile ownership, schema and provider contract.
- **PF2** audits the current Mem0 dependency against current upstream OSS/Platform capabilities and makes an explicit migration decision. It does not upgrade Mem0 merely because a newer package exists.
- **PF3** implements the provider-neutral YUVI profile baseline from lineage-bound evidence. This makes the feature work without requiring Mem0 Platform.
- **PF4** conditionally executes the Mem0 path selected by PF2. It may legitimately close as `NO_UPGRADE` / `NO_PLATFORM_DEPENDENCY` with no production code if that is the safe decision.
- **PF5** adds the People/Profile product surface and bounded A4 context projection.
- **PF6** proves cross-surface identity/profile behavior with QQ plus at least one non-QQ source and closes v0.1.4.

The profile is a derived view, never identity truth, relationship authority, obligation state or a generic trust/disposition store.

---

# v0.1.5 — Prospective Life

Detailed atoms already exist in [`post-v0.1.3-roadmap.md`](post-v0.1.3-roadmap.md).

## Product result

YUVI carries unfinished life forward across turns, restarts and elapsed time:

- commitments YUVI actually accepted;
- expectations about people/schedules/events;
- low-authority intentions with TTL;
- derived/decaying open threads;
- explicit closure, failure, expiry, release and unknown states.

## Default atom order

```text
M1 → M2 → E1a
          ↓
          P1 → P2 → P3
```

`M1/M2` are deliberately included before Prospective product work because from this release onward continuity features need controlled accelerated histories, fixed probes, blind evaluation and preregistered failure criteria.

- **M1** synthetic life-history generator + accelerated clock + zero-real-effect replay.
- **M2** fixed probe suite + blind evaluation + preregistration registry.
- **E1a** long-context/provenance baseline scan.
- **P1** typed COMMITMENT / EXPECTATION / INTENTION reducer.
- **P2** due/review scheduling, restart and clock handling.
- **P3** derived OPEN_THREAD projection + B0p+L2 evaluation.

v0.1.5 does not implement relationship/disposition learning or learned selection.

---

# v0.1.6 — Measured Change

Detailed atoms: C-series and E-series in [`post-v0.1.3-roadmap.md`](post-v0.1.3-roadmap.md).

## Research/product result

Test whether repeated eligible experiences can produce bounded, attributable and correctable long-term projections without allowing an LLM to directly write psychological state.

## Atom order

```text
C1 → E2(gate) → C2 → C3 → C4
                         ├→ E4
                         ├→ E5
                         └→ E6
```

- **C1** frozen codebook + evidence pointers + state-blind annotation harness.
- **E2** reliability gate. Failing labels do not proceed.
- **C2** deterministic/governed accumulator in shadow.
- **C3** construct-specific promotion/decay with explicit measurement definitions.
- **C4** read-only rendering into A4 context plus B2/B0p+S evaluation.
- **E4/E5/E6** manipulation-budget, pulse-response, attribution/correction tests as defined in research methodology.

This release does **not** promise that a human-like relationship scalar or personality representation will emerge. If measured constructs do not survive the gates, that branch stops.

---

# v0.1.7 — Attention, Selection & Portability

Detailed atoms: S/PV/Z/MR/PM in [`post-v0.1.3-roadmap.md`](post-v0.1.3-roadmap.md).

## Result

Determine how much continuity comes from explicit evidence selection, whether any learned selector is justified, and whether continuity survives foundation-model replacement within declared dimensions.

## Default order

```text
S1 → S2/E3(gate)
          ├─ no oracle gap → stop Z successfully
          └─ real gap → PV1 → Z1(gate, optional)

P3 + C4 + E6 → MR1
MR1 + replacement-owner gates → PM1 per P8 field
```

- **S1** strong B3/Zero explicit selection baseline.
- **S2/E3** state ablation + O_text/O_selection oracle gap.
- **PV1** deletion cascade/research-data admissibility before real longitudinal learned state.
- **Z1** optional offline learned selection trial only if a preregistered O_selection gap exists and the learned artifact can remain replayable/deletable/portable.
- **MR1** model-replacement continuity release gate across factual/obligation, relationship/preference, normative and style dimensions.
- **PM1** P8 migration one field at a time after replacement owners pass gates.

There is no single Yuvi-likeness score and no required latent-self implementation.

---

# Later research — Revealed Disposition & Exploration

Do not assign these to a promised product release until v0.1.6/v0.1.7 gates justify them.

```text
C4 + S1 → RD1 → RD2(gate) → X1(research)
```

- **RD1** logs genuine counterfactual choice sets and pre-choice propensities without writing state.
- **RD2** tests tiny residual revealed-disposition updates in shadow; predicted behavior cannot recursively confirm itself.
- **X1** only if RD2 is informative: a small charter-constrained exploration budget, never an engagement/retention optimizer.

A negative RD2 result is a valid conclusion: YUVI can continue using explicit history/prospective/selection mechanisms without inventing an autonomous-interest subsystem.

---

# Continuous product lane

Version sequencing above does not freeze ordinary product maintenance. The following may continue when they do not violate atom authority or destabilize a closure boundary:

- STT/TTS reliability;
- Live2D/presentation bugs;
- provider compatibility;
- Linux packaging/runtime fixes;
- UI defect fixes;
- performance/latency regressions;
- security/privacy correctness fixes.

Such work is not allowed to sneak in a second Runtime, Memory authority, Person store, profile owner, scheduler or selection policy.

## Summary

The intended growth path is:

```text
causal history
    ↓
people/profile
    ↓
prospective continuity
    ↓
measured change
    ↓
explicit selection
    ↓
optional learned selection
    ↓
optional revealed disposition / exploration
```

At every arrow, the next mechanism must justify itself against the simplest explicit alternative already implemented.
