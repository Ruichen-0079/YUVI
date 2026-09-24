# Frontend design and execution policy

> **Status:** CURRENT EXECUTION POLICY FOR PRODUCT UI WORK
>
> This document defines when a frontend atom may be executed mechanically by a coding model and when product/UI work must stop for a human or high-capability design/review gate. It does not create a new frontend framework or replace current source conventions.

YUVI distinguishes **frontend implementation authority** from **frontend design authority**.

A coding model may be excellent at implementing an already-decided interface and still be a poor authority for information architecture, interaction philosophy, visual hierarchy, or product taste. Passing tests is necessary but does not establish that a page is coherent, calm, legible, or recognizably YUVI.

## 1. Default model split

### Coding-model implementation work

A bounded coding model such as Luna may implement frontend work when the design boundary is already explicit. Typical examples:

- wire an approved UI to existing/new APIs;
- implement specified components and states;
- add loading / empty / error / stale / conflict states that are already defined;
- perform mechanical component extraction or state migration;
- add/update focused frontend tests;
- fix a narrow visual defect with an explicit expected result;
- implement an approved responsive/window behavior contract;
- make bounded CSS/layout changes whose intended appearance is already documented.

The coding model is not the product-design authority merely because it owns the implementation diff.

### Human / high-capability judgment work

A **HUMAN / HIGH-CAPABILITY DESIGN GATE** is required before implementation when an atom introduces or materially redesigns any of the following:

- a first-class product page or major navigation destination;
- information architecture or content hierarchy;
- the primary interaction model of a feature;
- a major visual redesign or new reusable visual language;
- typography/spacing/density decisions that materially determine the page character;
- the choice between cards, lists, panels, overlays, drawers, modals, tabs or comparable layout primitives when no existing pattern already decides it;
- dense provenance/history/conflict presentation where clarity depends on visual judgment;
- a UX whose success is primarily qualitative rather than expressible as a boolean test.

The same gate is required for frontend bugs whose root cause spans multiple interactive systems rather than one isolated component, especially:

- streaming/list scroll anchoring;
- focus and keyboard behavior;
- IME/composition handling;
- resize/window-state interactions;
- virtualization;
- Live2D/overlay/z-order interactions;
- audio/playback/UI synchronization;
- async race conditions whose visible symptom is intermittent;
- behavior that differs materially across Linux/Wayland, Windows or macOS.

These are engineering problems as well as product problems. They should not be reduced to “make the test pass” if the resulting interaction remains visibly wrong.

## 2. Required design-gate output

A design gate should leave enough explicit evidence that a bounded coding model can implement without inventing the product direction. The record should include, as applicable:

- the user task and product goal;
- current-screen / current-flow audit;
- information hierarchy;
- page/layout structure;
- intended interaction flow;
- component/state inventory;
- empty/loading/error/stale/conflict/correction states;
- responsive/window-size behavior;
- keyboard/focus/IME requirements where relevant;
- visual constraints: typography, spacing, density, alignment and reuse of existing YUVI patterns;
- elements/patterns explicitly rejected;
- screenshots, sketches or reference captures when visual comparison is useful;
- an implementation boundary: what Luna may decide locally and what it must not redesign;
- qualitative acceptance criteria for final human/high-capability review.

The gate does not need to be a pixel-perfect design file. It must remove the need for the implementation model to invent the page philosophy.

## 3. Frontend implementation loop

For gated UI work, use this loop:

```text
human / high-capability design audit
        ↓
approved design-gate record
        ↓
bounded coding-model implementation
        ↓
real screenshots / real-device interaction
        ↓
human / high-capability visual + interaction review
        ↓
bounded revision pass
        ↓
final regression / cross-platform checks
```

A frontend atom is not complete merely because DOM/unit tests pass. Where appearance or interaction quality is part of the atom, closure requires inspection of the rendered result.

## 4. Anti-patterns

Do not give a bounded coding model an unconstrained request such as:

- “redesign this page to look modern”;
- “make the People page beautiful”;
- “improve the UX however you think best”;
- “clean up the frontend architecture”;
- “make this dashboard more polished”.

These prompts encourage locally plausible but globally inconsistent UI: excess cards, decorative badges, arbitrary gradients/shadows, unnecessary manager/state abstractions, duplicated visual patterns or SaaS-dashboard styling that conflicts with YUVI's companion-oriented product direction.

Likewise, do not accept a patch solely because it is technically functional if it introduces obvious visual hierarchy, spacing, interaction or cross-platform regressions.

## 5. PF5 mandatory gate

`v0.1.4` atom **PF5 — People/Profile product surface and A4 projection** has a mandatory design gate **before any product-surface implementation begins**.

PF1–PF4 may be executed atomically by a bounded coding model if their own prerequisites are satisfied. PF5 must stop after source/UI audit if no approved People/Profile frontend design record exists.

The PF5 design gate must decide at least:

- how People navigation/list and Person detail relate;
- what information is visible at first glance versus drill-down;
- how authored Person data differs visually from derived profile data;
- how provenance, conflicts, stale state and unknowns are shown without turning the page into an engineering dashboard;
- how correction/regeneration is exposed without implying that a generated profile is truth;
- how QQ provenance is visible without making the feature QQ-specific;
- how dense the profile should be and what should remain hidden until requested;
- how the page fits the existing YUVI visual language rather than introducing a separate dashboard aesthetic;
- responsive/window behavior and the minimum supported layout;
- which existing frontend components/patterns should be reused and which should be retired or avoided.

After this gate, Luna may implement the approved component/state plan, APIs, tests and bounded visual details. It must not independently redesign the page structure during implementation.

PF5 closure additionally requires a rendered-result review using actual screenshots or an interactive build. Any revision requested from that review should remain a bounded implementation pass, not a second uncontrolled redesign.

## 6. Cross-platform frontend work

Cross-platform UI work is not automatically a Luna-only maintenance atom. If a defect is caused by platform windowing, IME, focus, media, GPU/overlay, WebView or timing differences, first establish the platform-specific failure mode and expected behavior with a human/high-capability engineering review. Once the repair shape is narrow and testable, bounded implementation may be delegated.

Platform bring-up should therefore use the pattern:

```text
high-capability audit / failure model
        ↓
narrow repair atom(s)
        ↓
bounded implementation
        ↓
real-platform verification
        ↓
high-capability final diff/behavior review
```

Do not let platform-specific work create parallel UI state authorities, lifecycle owners or compatibility layers merely to make one environment pass.

## 7. Relationship to the roadmap

This policy applies to every current and future atom that touches substantial product UI, even if that atom's own document predates this file. [`version-roadmap.md`](version-roadmap.md) remains release-sequencing authority; this file governs **how frontend atoms are allowed to execute**.

When an atom's Definition of Done conflicts with this policy by implying that automated tests alone are sufficient for a qualitative UI change, this policy adds the rendered-result/design review requirement. It does not weaken any technical tests already required by the atom.
