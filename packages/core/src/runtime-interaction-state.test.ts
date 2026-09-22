import { describe, expect, it } from "vitest";
import {
  admitRuntimeCapabilityRound,
  RUNTIME_CAPABILITY_ADMISSION_6J_VERSION
} from "./runtime-capability-admission.js";
import {
  RUNTIME_INTERACTION_STATE_VERSION,
  RUNTIME_INTERACTION_FAILURE_REASONS,
  RUNTIME_SINGLE_CAPABILITY_INTERACTION_LIMITS,
  createRuntimeInteractionState
} from "./runtime-interaction-state.js";

function active() {
  const limits: { maxReasoningRounds: number; maxCapabilityCalls: number } = {
    ...RUNTIME_SINGLE_CAPABILITY_INTERACTION_LIMITS
  };
  return {
    version: RUNTIME_INTERACTION_STATE_VERSION,
    executionId: "runtime-execution-1",
    reasoningRoundsUsed: 0,
    capabilityCallsUsed: 0,
    limits,
    deadlineAtMs: null,
    terminal: null
  };
}

describe("Runtime interaction-state contract", () => {
  it("represents the existing one-capability path with separate attempt counts", () => {
    for (const [reasoningRoundsUsed, capabilityCallsUsed] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1]
    ]) {
      const state = createRuntimeInteractionState({
        ...active(),
        reasoningRoundsUsed,
        capabilityCallsUsed
      });
      expect(state.reasoningRoundsUsed).toBe(reasoningRoundsUsed);
      expect(state.capabilityCallsUsed).toBe(capabilityCallsUsed);
      const admission = admitRuntimeCapabilityRound({
        version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
        capabilityRoundsUsed: state.capabilityCallsUsed,
        policyAllowsCapability: true
      });
      expect(admission.status).toBe(capabilityCallsUsed === 0 ? "ADMITTED" : "REJECTED");
    }
    const completed = createRuntimeInteractionState({
      ...active(),
      reasoningRoundsUsed: 2,
      capabilityCallsUsed: 1,
      terminal: { status: "COMPLETED" }
    });
    expect(completed.terminal).toEqual({ status: "COMPLETED" });
  });

  it("represents zero-capability completion and pre-I/O cancellation", () => {
    const complete = createRuntimeInteractionState({
      ...active(),
      reasoningRoundsUsed: 1,
      limits: { maxReasoningRounds: 1, maxCapabilityCalls: 0 },
      terminal: { status: "COMPLETED" }
    });
    expect(complete.capabilityCallsUsed).toBe(0);
    const cancelled = createRuntimeInteractionState({
      ...active(),
      terminal: { status: "CANCELLED" }
    });
    expect(cancelled.terminal).toEqual({ status: "CANCELLED" });
    expect(cancelled.reasoningRoundsUsed).toBe(0);
  });

  it.each(RUNTIME_INTERACTION_FAILURE_REASONS)("represents bounded failure %s", (reason) => {
    const state = createRuntimeInteractionState({
      ...active(),
      reasoningRoundsUsed: 1,
      terminal: { status: "FAILED", reason }
    });
    expect(state.terminal).toEqual({ status: "FAILED", reason });
  });

  it("keeps monotonic deadlines explicit without reading or inventing a clock", () => {
    for (const deadlineAtMs of [null, 0, 1234.5]) {
      expect(createRuntimeInteractionState({ ...active(), deadlineAtMs }).deadlineAtMs).toBe(
        deadlineAtMs
      );
    }
  });

  it("copies and freezes caller facts without retaining an independent state store", () => {
    const input = { ...active(), terminal: { status: "FAILED", reason: "ERROR" } };
    const state = createRuntimeInteractionState(input);
    input.executionId = "replacement";
    input.limits.maxCapabilityCalls = 99;
    input.terminal.reason = "UNAVAILABLE";
    expect(state.executionId).toBe("runtime-execution-1");
    expect(state.limits.maxCapabilityCalls).toBe(1);
    expect(state.terminal).toEqual({ status: "FAILED", reason: "ERROR" });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.limits)).toBe(true);
    expect(Object.isFrozen(state.terminal)).toBe(true);
  });

  it.each([
    { version: "future" },
    { executionId: "" },
    { executionId: "runtime execution" },
    { executionId: "x".repeat(201) },
    { reasoningRoundsUsed: -1 },
    { reasoningRoundsUsed: 0.5 },
    { reasoningRoundsUsed: 3 },
    { capabilityCallsUsed: 1 },
    { reasoningRoundsUsed: 2, capabilityCallsUsed: 2 },
    { limits: { maxReasoningRounds: 0, maxCapabilityCalls: 1 } },
    { limits: { maxReasoningRounds: Infinity, maxCapabilityCalls: 1 } },
    { limits: { maxReasoningRounds: Number.MAX_SAFE_INTEGER + 1, maxCapabilityCalls: 1 } },
    { limits: { maxReasoningRounds: 2, maxCapabilityCalls: -1 } },
    { limits: { maxReasoningRounds: 2 } },
    { deadlineAtMs: undefined },
    { deadlineAtMs: NaN },
    { deadlineAtMs: Infinity },
    { deadlineAtMs: -1 },
    { terminal: undefined },
    { terminal: { status: "RUNNING" } },
    { terminal: { status: "FAILED" } },
    { terminal: { status: "FAILED", reason: "retry forever" } },
    { terminal: { status: "COMPLETED", reason: "ERROR" } },
    { terminal: { status: "CANCELLED", resume: true } },
    { capabilityRef: "opaque-read" },
    { toolName: "read_text_file" },
    { limits: { maxReasoningRounds: 2, maxCapabilityCalls: 1, retry: true } }
  ])("rejects unbounded, inconsistent or foreign facts %#", (patch) => {
    expect(() => createRuntimeInteractionState({ ...active(), ...patch })).toThrow();
  });

  it.each([null, [], "state"])("rejects a non-object state %#", (input) => {
    expect(() => createRuntimeInteractionState(input)).toThrow();
  });
});
