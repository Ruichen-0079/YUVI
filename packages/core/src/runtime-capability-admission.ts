export const RUNTIME_CAPABILITY_ADMISSION_6J_VERSION =
  "runtime-capability-admission-6j.v1" as const;

export const RUNTIME_CAPABILITY_ADMISSION_REJECTION_REASONS = [
  "POLICY_DENIED",
  "ROUND_BUDGET_EXHAUSTED"
] as const;

export type RuntimeCapabilityAdmissionRejectionReason =
  (typeof RUNTIME_CAPABILITY_ADMISSION_REJECTION_REASONS)[number];

export type RuntimeCapabilityAdmissionDecision =
  | Readonly<{
      version: typeof RUNTIME_CAPABILITY_ADMISSION_6J_VERSION;
      status: "ADMITTED";
    }>
  | Readonly<{
      version: typeof RUNTIME_CAPABILITY_ADMISSION_6J_VERSION;
      status: "REJECTED";
      reason: RuntimeCapabilityAdmissionRejectionReason;
    }>;

type RuntimeCapabilityAdmissionInput = Readonly<{
  version: typeof RUNTIME_CAPABILITY_ADMISSION_6J_VERSION;
  /** Number of capability rounds already committed for this Cognition cycle. */
  capabilityRoundsUsed: number;
  /** Current Runtime policy decision supplied by the composition boundary. */
  policyAllowsCapability: boolean;
  maxCapabilityCalls: number;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  capabilityRoundsUsed?: unknown;
  policyAllowsCapability?: unknown;
  maxCapabilityCalls?: unknown;
};

/**
 * Decide whether one already-validated capability request may enter execution.
 *
 * Core deliberately does not receive capability refs, MCP tool/server names,
 * schemas, arguments, or provider metadata. The composition boundary owns
 * request membership and opaque ref binding; Runtime policy supplies a simple
 * allow/veto fact. This pure function only enforces that policy veto and the
 * Phase-6 one-capability-round default, or the explicit Runtime interaction limit.
 *
 * It does not mutate a counter, execute a capability, retry, persist, or emit
 * any user-visible effect. Callers retain lifecycle and commit ownership.
 */
export function admitRuntimeCapabilityRound(input: unknown): RuntimeCapabilityAdmissionDecision {
  const value = expectObject(input);
  assertAllowedKeys(value);

  if (value.version !== RUNTIME_CAPABILITY_ADMISSION_6J_VERSION) {
    throw new Error(
      `Runtime capability admission version must be ${RUNTIME_CAPABILITY_ADMISSION_6J_VERSION}.`
    );
  }
  if (
    typeof value.capabilityRoundsUsed !== "number" ||
    !Number.isSafeInteger(value.capabilityRoundsUsed) ||
    value.capabilityRoundsUsed < 0
  ) {
    throw new Error("Runtime capabilityRoundsUsed must be a non-negative safe integer.");
  }
  if (typeof value.policyAllowsCapability !== "boolean") {
    throw new Error("Runtime policyAllowsCapability must be boolean.");
  }
  const maxCapabilityCalls = value.maxCapabilityCalls === undefined ? 1 : value.maxCapabilityCalls;
  if (
    typeof maxCapabilityCalls !== "number" ||
    !Number.isSafeInteger(maxCapabilityCalls) ||
    maxCapabilityCalls < 0 ||
    maxCapabilityCalls > 4
  ) {
    throw new Error("Runtime maxCapabilityCalls must be an integer from 0 to 4.");
  }

  const normalized: RuntimeCapabilityAdmissionInput = Object.freeze({
    version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
    capabilityRoundsUsed: value.capabilityRoundsUsed,
    policyAllowsCapability: value.policyAllowsCapability,
    maxCapabilityCalls
  });

  if (!normalized.policyAllowsCapability) {
    return Object.freeze({
      version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
      status: "REJECTED",
      reason: "POLICY_DENIED"
    });
  }

  if (normalized.capabilityRoundsUsed >= normalized.maxCapabilityCalls) {
    return Object.freeze({
      version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
      status: "REJECTED",
      reason: "ROUND_BUDGET_EXHAUSTED"
    });
  }

  return Object.freeze({
    version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
    status: "ADMITTED"
  });
}

function expectObject(input: unknown): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runtime capability admission input must be an object.");
  }
  return input as UnknownObject;
}

function assertAllowedKeys(value: Record<string, unknown>): void {
  const allowed = new Set([
    "version",
    "capabilityRoundsUsed",
    "policyAllowsCapability",
    "maxCapabilityCalls"
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime capability admission input contains unknown field: ${unknown.sort().join(", ")}.`
    );
  }
}
