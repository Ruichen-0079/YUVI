# YUVI version roadmap

> **Status:** CURRENT RELEASE-SEQUENCING AUTHORITY
>
> This document answers **what version comes next and what each version is meant to make true**. It does not replace the detailed atom contracts in the v0.1.3 plan, the A10.1 leaf roadmap, the v0.1.4 People/Profile plan, or the post-v0.1.3 research roadmap. When a technical dependency conflicts with convenient version grouping, the dependency wins.
>
> Current Future authority is indexed in [`README.md`](README.md). Implemented reality remains source/tests/validation first.

## 1. Release philosophy

YUVI advances by observable capability boundaries rather than by adding broad psychological subsystems.

```text
v0.1.3  Durable Causal History
        "What happened, who/what caused it, what did I attempt,
         what is actually known, and what evidence supports derived Memory/Profile state?"

v0.1.4  People & Profile
        "Who is this person across surfaces, and how is the already-grounded
         profile substrate exposed safely as a People product?"

v0.1.5  Prospective Life
        "What did I commit to, what am I waiting for,
         and what remains unresolved across time/restart?"

v0.1.6  Measured Change
        "Can repeated eligible experience produce bounded, testable
         long-term relational/dispositional change?"

v0.1.7  Attention, Selection & Portability
        "Which parts of history should influence the present,
         and does learned selection add anything over explicit mechanisms?"

later research
        Revealed disposition / constrained exploration only if earlier gates justify them.
```

The release numbers are planning labels, not promises that every research branch will be implemented. A failed gate can intentionally delete later work.

---

## 2. Execution discipline for coding agents

Every implementation atom/sub-atom is executed independently.

Before an atom:

1. Fetch the target branch and verify the exact current HEAD.
2. Read the authoritative Future index, implementation baseline, version plan, atom definition, and previous validation record.
3. Inspect current source/tests before editing. Documentation cannot overrule implemented reality.
4. If HEAD or implemented authority differs from stated preconditions, stop and report the mismatch rather than silently reconciling it.

For every atom:

- one coherent semantic change;
- no speculative implementation of later atoms;
- preserve Runtime as the single semantic execution authority;
- preserve one active owner per meaning;
- add/modify tests proving the exit criteria;
- write a validation record with exact commit/environment/results;
- update `implementation-baseline.md` only for reality actually changed;
- update ownership/authority docs when an owner changes;
- commit/push only after the atom closes cleanly.

A coding model must not implement multiple roadmap atoms merely because they are adjacent.

---

# v0.1.3 — Durable Causal History Foundation

Detailed authority: [`09-v0.1.3-platform-completion.md`](09-v0.1.3-platform-completion.md).

A8.2 leaf authority: [`a8.2-ingress-closure.md`](a8.2-ingress-closure.md).

A10.1 leaf authority: [`a10.1-grounded-memory-roadmap.md`](a10.1-grounded-memory-roadmap.md).

## Current state

A0–A6, A7.1, A7.2, A8.1, A8.2a–A8.2f6 and aggregate A8.2 are implemented reality. A10.1a–c are implemented. A10.1d–f, A9, A10.2/A10.3, A11 and A12 remain planned/open engineering, with A12.1 already holding a pinned source-level SnowLuma contract while its live probe remains pending.

### Milestone 1 — Evidence Foundation

```text
A7.1 → A7.2 → A8.1
                  ↓
               A8.2a  Journal store — IMPLEMENTED
                  ↓
               A8.2b  conversational ingress — IMPLEMENTED
                  ↓
               A8.2c  finalized speech ingress — IMPLEMENTED
                  ↓
               A8.2d  standalone vision ingress — IMPLEMENTED
                  ↓
               A8.2e1 Product / Person controls — IMPLEMENTED
                  ↓
               A8.2e2 Runtime-governed controls — IMPLEMENTED
                  ↓
               A8.2e3 proactive-consent authority — IMPLEMENTED
                  ↓
               A8.2f1–f6 remaining receipt/applicability closure — IMPLEMENTED
                  ↓
               A8.2 aggregate closure — IMPLEMENTED
                  ↓
               A10.1a fail-closed legacy LLM evidence — IMPLEMENTED
                  ↓
               A10.1b committed Journal ancestry — IMPLEMENTED
                  ↓
               A10.1c grounded legacy Memory writes
                  ↓
               A10.1d grounded Mem0 ingestion + modernization boundary
                  ↓
               A10.1e grounded dream derivations
                  ↓
               A10.1f1 ProfileProvider + local grounded materializer
                  ↓
               A10.1f2 People.Model bridge + dirty/regeneration
                  ↓
               A10.1f3 aggregate Memory/Profile lineage closure
```

The A10.1 scope correction is deliberate. Mem0 Python `2.2.0` / TypeScript `3.3.0` introduced hosted User Profiles on 2026-09-23 while YUVI is already opening the Mem0 boundary for grounded modernization. Profile materialization is therefore implemented once alongside A10.1 rather than reopening the same Memory/provider seam in v0.1.4.

This does **not** move Person authority into Mem0. A10.1f must preserve:

```text
People
├── Facts  ← governed Person fields + grounded Memory/evidence
├── Model  ← derived ProfileProvider snapshot
└── Relationship adaptation ← later measured mechanisms
```

The local/private profile materializer is the required baseline. A hosted Mem0 User Profiles adapter is optional and cannot become a mandatory cloud dependency.

### Milestone 2 — Action and attribution foundation

Default dependency order:

```text
A9.1 → A9.2
          ├→ A10.2
          └→ A11.1 (may begin here)

A9.3 + A10.1 + A10.2 → A10.3
```

Result:

- a logical external action has one durable INTENT identity;
- ATTEMPTs and OUTCOMEs are accounted for without fabricated certainty;
- crash ambiguity remains explicit as UNKNOWN where necessary;
- controller→Person, voice binding, authored/controller Person fields and P8 correction issuer/binding have causal lineage;
- A10.2 does **not** reimplement derived profile synthesis; that belongs to A10.1f;
- A10.3 can explain which retained evidence and projection revisions an execution actually consumed.

### Milestone 3 — Reality Check

```text
A11.1 → A11.2 → A12.2
A7.1  → A12.1 ─────┘
```

Result:

- deterministic fault injection proves the v0.1.3 invariants under restart/concurrency;
- one real QQ/Snowluma private/group surface passes the same contract;
- unsupported remote guarantees remain UNKNOWN/unsupported rather than being papered over;
- QQ remains a thin surface rather than a second conversation/Memory/People runtime.

### v0.1.3 closure

v0.1.3 ends at A12.2. Do not add a generic cleanup A13.

Windows/macOS parity, relationship learning, prospective state, learned selection, autonomous exploration and People product UI are not v0.1.3 closure requirements. The profile **substrate/materializer** is inside A10.1 because it shares the Memory modernization boundary; the People **product** remains v0.1.4.

---

# v0.1.4 — People & Profile

Detailed executable plan: [`10-v0.1.4-people-profile.md`](10-v0.1.4-people-profile.md).

## Product result

A Person becomes a core YUVI domain object across surfaces, and YUVI exposes the evidence-linked, regenerable profile substrate built in A10.1f through stable People APIs, governed identity/binding, disclosure-safe A4 projection and a user-facing People surface.

QQ is the first high-value source of multi-person evidence, but **People/Profile is not a QQ plugin feature**. QQ contributes principals, receipts, audience and transport metadata. Core YUVI owns Person binding, evidence access, profile product semantics, disclosure and context projection.

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
        A10.1f ProfileProvider
                ↓
          People.Model snapshot
                ↓
          People UI + A4 context
```

## Atom order

```text
PF1 → PF2 → PF3 → PF4? → PF5 → PF6
```

- **PF1 — People/Profile contract hardening.** Freeze the product-facing Person/Profile read schema over the inherited A10.1f substrate.
- **PF2 — governed cross-surface Person binding and correction.** Make identity/binding stable without using profile similarity as authority.
- **PF3 — People.Model product bridge.** Expose current/dirty/pending/stale/conflicting profile lifecycle and bounded regeneration through People APIs.
- **PF4 — optional Mem0 Platform adapter hardening.** Conditional only. Validate hosted User Profiles parity/idempotency/privacy if configured; otherwise close as `NOT_APPLICABLE`. Local profile operation remains mandatory.
- **PF5 — People surface + bounded A4 profile projection.** Includes the mandatory HUMAN / HIGH-CAPABILITY DESIGN GATE and rendered review.
- **PF6 — cross-surface closure.** Prove identity/profile/disclosure/correction behavior with QQ plus at least one non-QQ source.

The profile remains a derived view, never identity truth, relationship authority, obligation state or a generic trust/disposition store.

---

# v0.1.5 — Prospective Life

Detailed atoms: [`post-v0.1.3-roadmap.md`](post-v0.1.3-roadmap.md).

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

```text
C1 → E2(gate) → C2 → C3 → C4
                         ├→ E4
                         ├→ E5
                         └→ E6
```

- **C1** frozen codebook + evidence pointers + state-blind annotation harness.
- **E2** reliability gate; failing labels do not proceed.
- **C2** deterministic/governed accumulator in shadow.
- **C3** construct-specific promotion/decay with explicit measurement definitions.
- **C4** read-only rendering into A4 context plus B2/B0p+S evaluation.

If measured constructs do not survive the gates, that branch stops. The release does not promise a human-like relationship scalar or personality representation.

---

# v0.1.7 — Attention, Selection & Portability

Detailed atoms: S/PV/Z/MR/PM in [`post-v0.1.3-roadmap.md`](post-v0.1.3-roadmap.md).

## Result

Determine how much continuity comes from explicit evidence selection, whether any learned selector adds value over governed retrieval, and how much behavior survives foundation-model replacement.

Representative dependency direction remains:

```text
C3 → S1 → S2 / E3(gate) → PV1 → Z1(gate, optional)
C4 + S1 → RD1 → RD2(gate) → X1
P3 + C4 + E6 → MR1
MR1 + replacement-owner gate → PM1 (per field)
```

Learned/latent selection is optional research. If explicit mechanisms meet the preregistered target, the latent branch closes successfully rather than being treated as missing functionality.

---

## Later research

Revealed disposition, constrained exploration, post-training and deeper artificial-person hypotheses remain gated research. They do not acquire production authority merely because they are philosophically interesting or appear in historical Future documents.

## Working rule

Prefer the smallest explicit mechanism that passes preregistered tests. Reuse an existing authoritative seam when the capability naturally belongs there; do not postpone adjacent work only to reopen the same provider/storage boundary in the next release.
