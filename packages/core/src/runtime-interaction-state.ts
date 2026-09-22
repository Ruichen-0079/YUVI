export const RUNTIME_INTERACTION_STATE_VERSION = "runtime-interaction-state.v1" as const;

/** Existing Phase-6 behavior: initial reasoning, one read, assisted completion. */
export const RUNTIME_SINGLE_CAPABILITY_INTERACTION_LIMITS = Object.freeze({
  maxReasoningRounds: 2,
  maxCapabilityCalls: 1
});

export const RUNTIME_INTERACTION_FAILURE_REASONS = [
  "UNAVAILABLE",
  "ERROR",
  "POLICY_DENIED",
  "REASONING_BUDGET_EXHAUSTED",
  "CAPABILITY_BUDGET_EXHAUSTED",
  "DEADLINE_EXCEEDED",
  "STALE_EXECUTION"
] as const;

export type RuntimeInteractionFailureReason = (typeof RUNTIME_INTERACTION_FAILURE_REASONS)[number];
export type RuntimeInteractionTerminal =
  | Readonly<{ status: "COMPLETED" | "CANCELLED" }>
  | Readonly<{ status: "FAILED"; reason: RuntimeInteractionFailureReason }>;

/** Runtime-local containment facts; never model input or a persistence authority. */
export type RuntimeInteractionState = Readonly<{
  version: typeof RUNTIME_INTERACTION_STATE_VERSION;
  /** Fresh Runtime execution identity, not a session ID or semantic capability ref. */
  executionId: string;
  /** Admitted attempts, charged before I/O, including failed/cancelled attempts. */
  reasoningRoundsUsed: number;
  capabilityCallsUsed: number;
  limits: Readonly<{ maxReasoningRounds: number; maxCapabilityCalls: number }>;
  /** Absolute deadline on the Runtime's monotonic clock; null means no extra deadline. */
  deadlineAtMs: number | null;
  /** null is active; COMPLETED means a terminal result, not factual/effect success. */
  terminal: RuntimeInteractionTerminal | null;
}>;

/**
 * Snapshot caller-owned Runtime facts with bounded, independent counters.
 * This is validation, not admission or a state transition: it neither allocates
 * identity nor checks time, aborts I/O, advances counters, or reopens a terminal.
 * A2 must retain the snapshot within the existing Runtime execution, propagate
 * its AbortSignal, check identity/deadline before and after awaits, and make
 * terminal states absorbing. A semantic CONTINUE cannot change these facts.
 */
export function createRuntimeInteractionState(input: unknown): RuntimeInteractionState {
  const value = object(input, "state");
  keys(value, [
    "version",
    "executionId",
    "reasoningRoundsUsed",
    "capabilityCallsUsed",
    "limits",
    "deadlineAtMs",
    "terminal"
  ]);
  if (value["version"] !== RUNTIME_INTERACTION_STATE_VERSION) {
    throw new Error(
      `Runtime interaction state version must be ${RUNTIME_INTERACTION_STATE_VERSION}.`
    );
  }
  const executionId = value["executionId"];
  if (
    typeof executionId !== "string" ||
    executionId.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(executionId)
  ) {
    throw new Error(
      "Runtime interaction executionId must be an opaque reference of 1 to 200 characters."
    );
  }
  const limits = object(value["limits"], "limits");
  keys(limits, ["maxReasoningRounds", "maxCapabilityCalls"]);
  const maxReasoningRounds = count(limits["maxReasoningRounds"], "maxReasoningRounds", 1);
  const maxCapabilityCalls = count(limits["maxCapabilityCalls"], "maxCapabilityCalls", 0);
  const reasoningRoundsUsed = count(value["reasoningRoundsUsed"], "reasoningRoundsUsed", 0);
  const capabilityCallsUsed = count(value["capabilityCallsUsed"], "capabilityCallsUsed", 0);
  if (reasoningRoundsUsed > maxReasoningRounds || capabilityCallsUsed > maxCapabilityCalls) {
    throw new Error("Runtime interaction counters exceed their limits.");
  }
  if (capabilityCallsUsed > reasoningRoundsUsed) {
    throw new Error("Runtime interaction capability calls require preceding reasoning rounds.");
  }
  const deadlineAtMs = value["deadlineAtMs"];
  if (
    deadlineAtMs !== null &&
    (typeof deadlineAtMs !== "number" ||
      !Number.isFinite(deadlineAtMs) ||
      deadlineAtMs < 0 ||
      deadlineAtMs > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(
      "Runtime interaction deadlineAtMs must be null or a finite non-negative clock value."
    );
  }
  return Object.freeze({
    version: RUNTIME_INTERACTION_STATE_VERSION,
    executionId,
    reasoningRoundsUsed,
    capabilityCallsUsed,
    limits: Object.freeze({ maxReasoningRounds, maxCapabilityCalls }),
    deadlineAtMs,
    terminal: terminal(value["terminal"])
  });
}

function terminal(input: unknown): RuntimeInteractionTerminal | null {
  if (input === null) return null;
  const value = object(input, "terminal");
  const status = value["status"];
  keys(value, status === "FAILED" ? ["status", "reason"] : ["status"]);
  if (status === "COMPLETED" || status === "CANCELLED") return Object.freeze({ status });
  if (
    status === "FAILED" &&
    RUNTIME_INTERACTION_FAILURE_REASONS.some((reason) => reason === value["reason"])
  ) {
    return Object.freeze({ status, reason: value["reason"] as RuntimeInteractionFailureReason });
  }
  throw new Error("Runtime interaction terminal status/reason is invalid.");
}

function object(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`Runtime interaction ${field} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Runtime interaction contains unknown fields.");
  }
}

function count(input: unknown, field: string, minimum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum) {
    throw new Error(`Runtime interaction ${field} must be a safe integer >= ${minimum}.`);
  }
  return input;
}
