# Canonical interaction round — v0.1.3 A1

Status: **A1 contract complete; consumed by the [A2 bounded Runtime loop](validation/v0.1.3-a2-bounded-loop.md)**.

[A3 execution evidence](validation/v0.1.3-a3-execution-evidence.md) defines live provider-facing request/observation adjacency and persistence rules.

The sections below record the A1 boundary and validation baseline. A2 supplies the executable transitions and live configuration described in its closure record.

Intake: [A0 baseline](validation/v0.1.3-a0-baseline.md), followed by a fresh fetch on 2026-09-22. `origin/main` remained `4278eb36b1a01acde82dde27b806dca996739972`; open PRs #315/#321, issue #51 and the two successful main workflows were unchanged. A transient fetch/API TLS failure succeeded on retry. The clean A0 documentation commit is the only preceding campaign change; old worktrees were not reused.

## Semantic decision

`@companion/cognition/interaction-round` defines `cognition-interaction-round.v1`:

| Decision | Payload and meaning |
| --- | --- |
| `COMPLETE` | Existing `NormalizedCognitionResult`, including PARTIAL, UNAVAILABLE, CANCELLED and ERROR. Completion does not imply success or factual truth. |
| `REQUEST_CAPABILITY` | Existing 6H semantic request, revalidated against the current 6G inventory. The opaque reference is not a tool name or execution permission. |
| `CONTINUE` | Payload-free proposal for another reasoning pass over the existing authorized task/evidence. It cannot replace the task, supply raw chain-of-thought, alter a budget, or execute anything. |

`createCognitionInteractionRound` validates already-normalized semantic decisions. It does not parse vendor output or become another Cognition-result normalizer. Existing Character ABI/result validation and inventory-bound request validation remain authoritative. Each variant rejects fields outside its contract and snapshots/freezes its nested payload.

The legacy `cognition-6w.v1` disposition shares the canonical decision payload type but excludes CONTINUE. Its wire format and parser are unchanged: unsupported continuation still becomes a bounded ERROR. At A1 closure the constructor was library-only. A2 now binds it to production execution through a separate bounded interaction protocol; the legacy parser remains unchanged.

## Runtime containment state

`@companion/core` exports `RuntimeInteractionState` and its snapshot validator, `createRuntimeInteractionState`, versioned `runtime-interaction-state.v1`.

- `executionId` is a fresh Runtime execution identity. Session IDs, semantic capability refs, and model-supplied IDs do not allocate execution identity. Allocation and comparison belong to Runtime.
- `reasoningRoundsUsed` counts admitted reasoning attempts, including initial and post-capability reasoning. `capabilityCallsUsed` separately counts admitted capability invocations. Charge before starting I/O; failures/cancellation after admission do not refund the attempt. A policy veto performs no invocation and consumes no capability attempt.
- Both counters and limits are finite safe integers; reasoning limit is positive, capability limit may be zero. Counts cannot exceed their respective limits or contain more capability calls than preceding reasoning rounds. Validation does not itself authorize the next attempt when a counter equals its limit.
- `RUNTIME_SINGLE_CAPABILITY_INTERACTION_LIMITS` records the existing structural maximum: **two reasoning attempts, one capability call**. It does not change the live 6J one-capability admission gate or install new configuration defaults.
- `deadlineAtMs` is an absolute value on the Runtime execution's monotonic clock. `null` explicitly means no additional interaction deadline; existing provider timeouts still apply. It is process-local, not a persisted wall-clock timestamp or a new timer service.
- `terminal: null` means active. `COMPLETED` records receipt of a terminal Cognition result, not successful tool execution or Memory truth. `CANCELLED` records cancellation, including cancellation before the first attempt. `FAILED` carries bounded unavailable/error/policy/budget/deadline/stale-execution reasons, not raw provider payloads.

The state contains no model decision, provider selection, concrete tool arguments, transcript, or Memory. Validation copies/freezes caller facts; it cannot prove their history, allocate identities, advance counters, enforce a deadline, or cancel I/O. It is not a second state store or orchestrator.

At A1 closure, production containment came from Runtime's one Cognition handoff/re-entry, `executeRuntimeCognitionOnce`, 6J capability admission, and the current server read-text composition. The existing AbortSignal remains the cancellation transport. No new controller or independent cancellation authority is introduced by A1.

## A2 obligations (implemented in the linked closure)

A2 was required to freshly audit and extend the existing Runtime authority to retain this state, charge attempts, and consume semantic proposals. It must propagate the current execution's AbortSignal to both provider and capability calls; check cancellation, current execution identity and deadline at admission and after asynchronous work; make all terminal states absorbing; and preserve shutdown/sealing/draining and no-retry containment. A model's CONTINUE or REQUEST_CAPABILITY cannot reopen a terminal execution or replenish a budget. Larger limits may only enter through the existing configuration authority under A2's explicit implementation and tests.

For the current path, the state can describe `(reasoning, capability)` counts `(0,0) → (1,0) → (1,1) → (2,1) → terminal`, or direct completion after `(1,0)`. A1 adds no loop, plugin, effect class, Memory pipeline, context/cache rewrite, provider router, or research architecture.

## Verification

- 65 new contract cases cover legacy decision compatibility, all normalized completion statuses, continued rejection of CONTINUE by production 6W, current-inventory membership, immutable snapshots, separate bounded counters, deadline representation, cancellation/terminal representation, and rejection of malformed or authority-bearing fields.
- Focused Cognition/Core/Server regression run: 167 tests across 15 files passed, including the current production Character/read-text path and existing cancellation/admission behavior.
- `pnpm check`, `pnpm build`, the Cognition package's emitted-JavaScript/public-subpath import check, and `pnpm smoke` passed.
- Full `pnpm test`: 3,088 Vitest tests passed, 26 prerequisite-dependent tests skipped, plus 55 Node packaging/host tests passed. No live PostgreSQL distribution/connection was configured for this local run; hosted main persistence evidence remains the A0 baseline, not a claim of hosted A1 validation.
- New source/tests and package metadata passed targeted Prettier checks; `git diff --check` passed. No Rust/native or OS-specific implementation changed; no new packaged artifact or platform-parity claim is made.
