import {
  admitRuntimeCapabilityRound,
  RUNTIME_CAPABILITY_ADMISSION_6J_VERSION
} from "./runtime-capability-admission.js";
import {
  createRuntimeInteractionState,
  RUNTIME_INTERACTION_STATE_VERSION,
  type RuntimeInteractionState,
  type RuntimeInteractionTerminal
} from "./runtime-interaction-state.js";

export type RuntimeCognitionExecution = Readonly<{ executionId: string; isCurrent(): boolean }>;
export type RuntimeCognitionLimits = Readonly<{
  maxReasoningRounds: number;
  maxCapabilityCalls: number;
  timeBudgetMs: number;
}>;
export const DEFAULT_COGNITION_LIMITS: RuntimeCognitionLimits = Object.freeze({
  maxReasoningRounds: 4,
  maxCapabilityCalls: 2,
  timeBudgetMs: 60_000
});
export const MAX_COGNITION_LIMITS: RuntimeCognitionLimits = Object.freeze({
  maxReasoningRounds: 8,
  maxCapabilityCalls: 4,
  timeBudgetMs: 120_000
});

/** The semantic boundary supplies A1 decisions; Core only consumes their control discriminant. */
type Round = Readonly<{ kind: "COMPLETE" | "REQUEST_CAPABILITY" | "CONTINUE" }>;
export type RuntimeCognitionExchange<T extends Round, O> = Readonly<{
  request: Extract<T, { kind: "REQUEST_CAPABILITY" }>;
  observation: O;
}>;

/** One bounded execution inside the existing Runtime lifecycle; no retained service or retries. */
export async function executeRuntimeCognitionInteraction<T extends Round, O>(input: {
  execution: RuntimeCognitionExecution;
  limits: RuntimeCognitionLimits;
  policyAllowsCapability: boolean;
  signal?: AbortSignal | undefined;
  reason(history: readonly RuntimeCognitionExchange<T, O>[], signal: AbortSignal): Promise<T>;
  invoke(
    request: Extract<T, { kind: "REQUEST_CAPABILITY" }>,
    state: RuntimeInteractionState,
    signal: AbortSignal
  ): Promise<O>;
}): Promise<
  Readonly<{ state: RuntimeInteractionState; completion: Extract<T, { kind: "COMPLETE" }> | null }>
> {
  const { executionId, isCurrent } = input.execution;
  const { reason, invoke, policyAllowsCapability, signal } = input;
  const limits = { ...input.limits };
  for (const key of Object.keys(MAX_COGNITION_LIMITS) as (keyof RuntimeCognitionLimits)[]) {
    const minimum = key === "maxCapabilityCalls" ? 0 : 1;
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < minimum ||
      limits[key] > MAX_COGNITION_LIMITS[key]
    )
      throw new Error(`Invalid Cognition limit: ${key}`);
  }
  if (typeof policyAllowsCapability !== "boolean" || typeof isCurrent !== "function")
    throw new Error("Invalid Runtime Cognition authority.");
  let state = createRuntimeInteractionState({
    version: RUNTIME_INTERACTION_STATE_VERSION,
    executionId,
    reasoningRoundsUsed: 0,
    capabilityCallsUsed: 0,
    limits: {
      maxReasoningRounds: limits.maxReasoningRounds,
      maxCapabilityCalls: limits.maxCapabilityCalls
    },
    deadlineAtMs: performance.now() + limits.timeBudgetMs,
    terminal: null
  });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeBudgetMs);
  const history: RuntimeCognitionExchange<T, O>[] = [];
  const finish = (
    terminal: RuntimeInteractionTerminal,
    completion: Extract<T, { kind: "COMPLETE" }> | null = null
  ) => {
    state = createRuntimeInteractionState({ ...state, terminal });
    return Object.freeze({ state, completion });
  };
  const stopped = (): RuntimeInteractionTerminal | null => {
    if (signal?.aborted) {
      controller.abort();
      return { status: "CANCELLED" };
    }
    let current = false;
    try {
      current = isCurrent();
    } catch {
      /* Unverifiable identity fails closed. */
    }
    if (!current) {
      controller.abort();
      return { status: "FAILED", reason: "STALE_EXECUTION" };
    }
    if (timedOut || performance.now() >= state.deadlineAtMs!) {
      controller.abort();
      return { status: "FAILED", reason: "DEADLINE_EXCEEDED" };
    }
    return null;
  };
  try {
    for (;;) {
      const stop = stopped();
      if (stop) return finish(stop);
      if (state.reasoningRoundsUsed >= state.limits.maxReasoningRounds)
        return finish({ status: "FAILED", reason: "REASONING_BUDGET_EXHAUSTED" });
      state = createRuntimeInteractionState({
        ...state,
        reasoningRoundsUsed: state.reasoningRoundsUsed + 1
      });
      const round = await reason(Object.freeze([...history]), controller.signal);
      const afterReason = stopped();
      if (afterReason) return finish(afterReason);
      if (round.kind === "COMPLETE")
        return finish({ status: "COMPLETED" }, round as Extract<T, { kind: "COMPLETE" }>);
      if (round.kind === "CONTINUE") continue;
      if (round.kind !== "REQUEST_CAPABILITY") return finish({ status: "FAILED", reason: "ERROR" });
      // Never perform a capability when no reasoning budget remains to consume it.
      if (state.reasoningRoundsUsed >= state.limits.maxReasoningRounds)
        return finish({ status: "FAILED", reason: "REASONING_BUDGET_EXHAUSTED" });
      const admission = admitRuntimeCapabilityRound({
        version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
        policyAllowsCapability,
        capabilityRoundsUsed: state.capabilityCallsUsed,
        maxCapabilityCalls: state.limits.maxCapabilityCalls
      });
      if (admission.status === "REJECTED")
        return finish({
          status: "FAILED",
          reason:
            admission.reason === "POLICY_DENIED" ? "POLICY_DENIED" : "CAPABILITY_BUDGET_EXHAUSTED"
        });
      const before = state;
      state = createRuntimeInteractionState({
        ...state,
        capabilityCallsUsed: state.capabilityCallsUsed + 1
      });
      const request = round as Extract<T, { kind: "REQUEST_CAPABILITY" }>;
      const observation = await invoke(request, before, controller.signal);
      const afterInvoke = stopped();
      if (afterInvoke) return finish(afterInvoke);
      history.push(Object.freeze({ request, observation }));
    }
  } catch {
    return finish(stopped() ?? { status: "FAILED", reason: "ERROR" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    // Await admitted work even if it ignores abort, so sealing/draining never
    // loses ownership of an in-flight operation. Its late result is fenced above.
  }
}
