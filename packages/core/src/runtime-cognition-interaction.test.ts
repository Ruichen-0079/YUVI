import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeRuntimeCognitionInteraction,
  DEFAULT_COGNITION_LIMITS,
  type RuntimeCognitionExchange
} from "./runtime-cognition-interaction.js";
import type { RuntimeInteractionState } from "./runtime-interaction-state.js";

type Round =
  | { kind: "COMPLETE"; result: string }
  | { kind: "REQUEST_CAPABILITY"; request: string }
  | { kind: "CONTINUE" };
const complete: Round = { kind: "COMPLETE", result: "done" };
const request: Round = { kind: "REQUEST_CAPABILITY", request: "evidence" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  return {
    execution: { executionId: "execution-1", isCurrent: () => true },
    limits: { ...DEFAULT_COGNITION_LIMITS },
    policyAllowsCapability: true,
    reason: vi.fn(
      async (
        _history: readonly RuntimeCognitionExchange<Round, string>[],
        _signal: AbortSignal
      ): Promise<Round> => complete
    ),
    invoke: vi.fn(
      async (
        _round: Extract<Round, { kind: "REQUEST_CAPABILITY" }>,
        _state: RuntimeInteractionState,
        _signal: AbortSignal
      ) => "observed"
    )
  };
}
afterEach(() => vi.useRealTimers());

describe("Runtime bounded Cognition execution", () => {
  it("terminates immediately on COMPLETE, with no additional call or capability", async () => {
    const input = fixture();
    const output = await executeRuntimeCognitionInteraction(input);
    expect(output.state).toMatchObject({
      reasoningRoundsUsed: 1,
      capabilityCallsUsed: 0,
      terminal: { status: "COMPLETED" }
    });
    expect(output.completion).toEqual(complete);
    expect(input.reason).toHaveBeenCalledTimes(1);
    expect(input.invoke).not.toHaveBeenCalled();
  });
  it("runs multiple admitted capabilities and supplies only completed exchanges", async () => {
    const input = fixture();
    input.reason
      .mockResolvedValueOnce(request)
      .mockResolvedValueOnce(request)
      .mockResolvedValueOnce(complete);
    const output = await executeRuntimeCognitionInteraction(input);
    expect(output.state).toMatchObject({
      reasoningRoundsUsed: 3,
      capabilityCallsUsed: 2,
      terminal: { status: "COMPLETED" }
    });
    expect(input.invoke).toHaveBeenCalledTimes(2);
    expect(input.reason.mock.calls[2]![0]).toEqual([
      { request, observation: "observed" },
      { request, observation: "observed" }
    ]);
  });
  it("contains endless reasoning continuation", async () => {
    const input = fixture();
    input.reason.mockResolvedValue({ kind: "CONTINUE" });
    const output = await executeRuntimeCognitionInteraction(input);
    expect(output.state.terminal).toEqual({
      status: "FAILED",
      reason: "REASONING_BUDGET_EXHAUSTED"
    });
    expect(input.reason).toHaveBeenCalledTimes(4);
    expect(input.invoke).not.toHaveBeenCalled();
  });
  it("contains endless capability requests independently", async () => {
    const input = fixture();
    input.reason.mockResolvedValue(request);
    const output = await executeRuntimeCognitionInteraction(input);
    expect(output.state).toMatchObject({
      reasoningRoundsUsed: 3,
      capabilityCallsUsed: 2,
      terminal: { reason: "CAPABILITY_BUDGET_EXHAUSTED" }
    });
    expect(input.invoke).toHaveBeenCalledTimes(2);
  });
  it("does not invoke a capability with no remaining reasoning slot", async () => {
    const input = fixture();
    input.limits.maxReasoningRounds = 1;
    input.reason.mockResolvedValue(request);
    expect((await executeRuntimeCognitionInteraction(input)).state.terminal).toMatchObject({
      reason: "REASONING_BUDGET_EXHAUSTED"
    });
    expect(input.invoke).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "denies policy/zero-call budget without invoking: policy=%s",
    async (policyAllowsCapability) => {
      const input = fixture();
      input.reason.mockResolvedValue(request);
      input.policyAllowsCapability = policyAllowsCapability;
      input.limits.maxCapabilityCalls = 0;
      expect((await executeRuntimeCognitionInteraction(input)).state.terminal).toMatchObject({
        reason: policyAllowsCapability ? "CAPABILITY_BUDGET_EXHAUSTED" : "POLICY_DENIED"
      });
      expect(input.invoke).not.toHaveBeenCalled();
    }
  );
  it("cancels before all I/O", async () => {
    const input = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      (await executeRuntimeCognitionInteraction({ ...input, signal: controller.signal })).state
        .terminal
    ).toEqual({ status: "CANCELLED" });
    expect(input.reason).not.toHaveBeenCalled();
  });
  it.each(["reason", "invoke"] as const)(
    "propagates abort and drops a late %s result while retaining in-flight ownership",
    async (stage) => {
      const input = fixture();
      const gate = deferred<any>();
      const entered = deferred<AbortSignal>();
      const controller = new AbortController();
      input.reason.mockImplementation(async (_history, signal) => {
        if (stage === "reason") {
          entered.resolve(signal);
          return gate.promise;
        }
        return request;
      });
      input.invoke.mockImplementation(async (_round, _state, signal) => {
        entered.resolve(signal);
        return gate.promise;
      });
      let settled = false;
      const running = executeRuntimeCognitionInteraction({
        ...input,
        signal: controller.signal
      }).then((x) => {
        settled = true;
        return x;
      });
      const childSignal = await entered.promise;
      controller.abort();
      expect(childSignal.aborted).toBe(true);
      expect(settled).toBe(false);
      gate.resolve(stage === "reason" ? complete : "late observation");
      const output = await running;
      expect(output.completion).toBeNull();
      expect(output.state.terminal).toEqual({ status: "CANCELLED" });
      expect(input.reason).toHaveBeenCalledTimes(1);
    }
  );
  it.each(["reason", "invoke"] as const)("fences replaced execution after %s", async (stage) => {
    const input = fixture();
    let current = true;
    input.execution.isCurrent = () => current;
    input.reason.mockImplementation(async () => {
      if (stage === "reason") current = false;
      return request;
    });
    input.invoke.mockImplementation(async () => {
      current = false;
      return "stale";
    });
    const output = await executeRuntimeCognitionInteraction(input);
    expect(output.state.terminal).toEqual({ status: "FAILED", reason: "STALE_EXECUTION" });
    expect(output.completion).toBeNull();
    expect(input.reason).toHaveBeenCalledTimes(1);
  });
  it("aborts at the deadline and rejects the late completion", async () => {
    vi.useFakeTimers();
    const input = fixture();
    const gate = deferred<Round>();
    const entered = deferred<AbortSignal>();
    input.reason.mockImplementation(async (_history, signal) => {
      entered.resolve(signal);
      return gate.promise;
    });
    const running = executeRuntimeCognitionInteraction(input);
    const signal = await entered.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal.aborted).toBe(true);
    gate.resolve(complete);
    expect((await running).state.terminal).toEqual({
      status: "FAILED",
      reason: "DEADLINE_EXCEEDED"
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("snapshots limits and cannot replenish them from a callback", async () => {
    const input = fixture();
    input.reason.mockImplementation(async () => {
      input.limits.maxReasoningRounds = 999;
      return { kind: "CONTINUE" };
    });
    expect((await executeRuntimeCognitionInteraction(input)).state.reasoningRoundsUsed).toBe(4);
  });
  it("normalizes unexpected execution errors without retry or continuation", async () => {
    const input = fixture();
    input.reason.mockResolvedValue(request);
    input.invoke.mockRejectedValue(new Error("private transport details"));
    const output = await executeRuntimeCognitionInteraction(input);
    expect(output.state.terminal).toEqual({ status: "FAILED", reason: "ERROR" });
    expect(JSON.stringify(output)).not.toContain("private");
    expect(input.reason).toHaveBeenCalledTimes(1);
  });
  it.each([
    { maxReasoningRounds: 9 },
    { maxReasoningRounds: NaN },
    { maxCapabilityCalls: 5 },
    { timeBudgetMs: Infinity },
    { timeBudgetMs: 0 }
  ])("rejects invalid limits before I/O: %j", (limits) => {
    const input = fixture();
    return expect(
      executeRuntimeCognitionInteraction({ ...input, limits: { ...input.limits, ...limits } })
    ).rejects.toThrow("Invalid Cognition limit");
  });
});
