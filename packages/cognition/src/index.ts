import {
  NORMALIZED_COGNITION_RESULT_VERSION,
  createNormalizedCognitionResult,
  type NormalizedCognitionResult
} from "@companion/character-abi";
import {
  CHARACTER_HARNESS_5G_VERSION,
  type CharacterHarnessCognitionRequest
} from "@companion/character-harness/cognition-request";
import type { ReasoningInput, ReasoningOutput } from "@companion/providers";
import { createCognitionCapabilityObservation } from "./capability-observation.js";

export const COGNITION_6A_VERSION = "cognition-6a.v1" as const;
export const COGNITION_6G_VERSION = "cognition-6g.v1" as const;
export const COGNITION_6H_VERSION = "cognition-6h.v1" as const;

export const COGNITION_6A_FAILURE_STATUSES = ["UNAVAILABLE", "CANCELLED", "ERROR"] as const;
export type Cognition6AFailureStatus = (typeof COGNITION_6A_FAILURE_STATUSES)[number];

export type Cognition6AReasoningTask = Readonly<{
  version: typeof COGNITION_6A_VERSION;
  escalation: CharacterHarnessCognitionRequest;
  /** Runtime-authorized, privacy-minimized task statement for Cognition. */
  problem: string;
}>;

export type CognitionCapabilityDescription = Readonly<{
  /** Opaque Runtime binding handle; Cognition must not interpret its format. */
  capabilityRef: string;
  /** Bounded semantic description of what the capability can provide. */
  description: string;
}>;

export type CognitionCapabilityDescriptionSet = Readonly<{
  version: typeof COGNITION_6G_VERSION;
  capabilities: readonly CognitionCapabilityDescription[];
}>;

export type CognitionCapabilityRequest = Readonly<{
  version: typeof COGNITION_6H_VERSION;
  kind: "REQUEST_CAPABILITY";
  /** Must identify one capability in the current validated 6G inventory. */
  capabilityRef: string;
  /** Semantic task meaning only; concrete MCP/tool arguments remain outside Cognition. */
  request: string;
}>;

const COGNITION_6G_MAX_CAPABILITIES = 32;
const COGNITION_6G_MAX_CAPABILITY_REF_CHARACTERS = 200;
const COGNITION_6G_MAX_DESCRIPTION_CHARACTERS = 1_000;
const COGNITION_6H_MAX_REQUEST_CHARACTERS = 4_000;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  escalation?: unknown;
  problem?: unknown;
  kind?: unknown;
  focus?: unknown;
  reasoning?: unknown;
  answer?: unknown;
  finishReason?: unknown;
  status?: unknown;
  capabilities?: unknown;
  capabilityRef?: unknown;
  description?: unknown;
  request?: unknown;
  reason?: unknown;
  observations?: unknown;
};

/**
 * Validate the bounded semantic capability inventory visible to Cognition.
 *
 * This is description-only. The opaque reference carries no execution
 * authority, no provider/tool/server identity is admitted into the stable
 * contract, and Runtime remains the sole owner of capability binding and
 * admission. Empty inventories are valid when the current environment exposes
 * no authorized capabilities.
 */
export function createCognitionCapabilityDescriptions(
  input: unknown
): CognitionCapabilityDescriptionSet {
  const value = expectObject(input, "Cognition 6G capability descriptions");
  assertAllowedKeys(value, ["version", "capabilities"], "Cognition 6G capability descriptions");
  if (value.version !== COGNITION_6G_VERSION) {
    throw new Error(`Cognition capability descriptions version must be ${COGNITION_6G_VERSION}.`);
  }
  if (!Array.isArray(value.capabilities)) {
    throw new Error("Cognition capabilities must be an array.");
  }
  if (value.capabilities.length > COGNITION_6G_MAX_CAPABILITIES) {
    throw new Error(
      `Cognition capabilities must not exceed ${COGNITION_6G_MAX_CAPABILITIES} entries.`
    );
  }

  const seenRefs = new Set<string>();
  const capabilities = Array.from(value.capabilities, (entry, index) =>
    normalizeCapabilityDescription(entry, index, seenRefs)
  );
  Object.freeze(capabilities);

  return Object.freeze({
    version: COGNITION_6G_VERSION,
    capabilities
  });
}

/**
 * Validate one Cognition proposal to request a capability from the current
 * bounded 6G inventory.
 *
 * The request is semantic only. It does not carry MCP method names, concrete
 * tool/server/provider identities, tool schemas, wire arguments, or execution
 * authority. Runtime remains responsible for binding the opaque ref, admitting
 * the effect, enforcing the one-round budget, and performing any invocation.
 */
export function createCognitionCapabilityRequest(
  input: unknown,
  capabilityDescriptions: unknown
): CognitionCapabilityRequest {
  const inventory = createCognitionCapabilityDescriptions(capabilityDescriptions);
  const value = expectObject(input, "Cognition 6H capability request");
  assertAllowedKeys(
    value,
    ["version", "kind", "capabilityRef", "request"],
    "Cognition 6H capability request"
  );
  if (value.version !== COGNITION_6H_VERSION || value.kind !== "REQUEST_CAPABILITY") {
    throw new Error(
      `Cognition capability request must use ${COGNITION_6H_VERSION} REQUEST_CAPABILITY.`
    );
  }

  const capabilityRef = boundedCapabilityRef(
    value.capabilityRef,
    "Cognition capability request capabilityRef"
  );
  if (!inventory.capabilities.some((capability) => capability.capabilityRef === capabilityRef)) {
    throw new Error(
      "Cognition capability request must reference the current capability inventory."
    );
  }

  const request = boundedCapabilityRequest(value.request);
  return Object.freeze({
    version: COGNITION_6H_VERSION,
    kind: "REQUEST_CAPABILITY",
    capabilityRef,
    request
  });
}

/**
 * Validate the stable 6A semantic reasoning task without performing provider
 * serialization or execution. This is the single task-shape authority reused
 * by initial and post-capability Cognition paths.
 */
export function createCognitionReasoningTask(input: unknown): Cognition6AReasoningTask {
  const value = expectObject(input, "Cognition 6A reasoning task");
  assertAllowedKeys(value, ["version", "escalation", "problem"], "Cognition 6A reasoning task");
  if (value.version !== COGNITION_6A_VERSION) {
    throw new Error(`Cognition reasoning task version must be ${COGNITION_6A_VERSION}.`);
  }

  const escalation = normalizeEscalation(value.escalation);
  const problem = boundedProblem(value.problem);

  return Object.freeze({
    version: COGNITION_6A_VERSION,
    escalation,
    problem
  });
}

/**
 * Build the provider-neutral reasoning input for one admitted Character
 * escalation. Runtime owns task/context authorization and provider execution;
 * this boundary only validates the stable 5G escalation and carries the
 * Runtime-supplied bounded problem into the existing ReasoningProvider shape.
 */
export function createCognitionReasoningInput(input: unknown): ReasoningInput {
  const task = createCognitionReasoningTask(input);
  const messages: ReasoningInput["messages"] = [
    Object.freeze({
      role: "user",
      content: task.problem
    })
  ];
  Object.freeze(messages);

  return Object.freeze({ messages });
}

/**
 * Sole phase-6 normalization from the existing provider-normalized reasoning
 * output into the Character-facing Normalized Cognition Result.
 *
 * The existing ReasoningProvider boundary must already have discarded raw
 * reasoning. Provider identity/metadata, token accounting, request IDs, debug
 * payloads, and fallback traces are deliberately not projected.
 */
export function normalizeCognitionReasoningOutput(input: unknown): NormalizedCognitionResult {
  const output = expectObject(input, "Cognition reasoning output");
  if (output.reasoning !== "") {
    throw new Error(
      "Cognition reasoning output must be provider-normalized with an empty reasoning field."
    );
  }
  const finishReason = normalizeFinishReason(output.finishReason);

  switch (finishReason) {
    case "stop":
      return createNormalizedCognitionResult({
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "SUCCESS",
        answer: requireProviderAnswer(output.answer)
      });
    case "length":
      return createNormalizedCognitionResult({
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "PARTIAL",
        answer: requireProviderAnswer(output.answer)
      });
    case "content_filter":
      return createNormalizedCognitionResult({
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "UNSAFE_TO_ANSWER"
      });
    case "tool_call":
    case "unknown":
      return createNormalizedCognitionResult({
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "ERROR"
      });
  }
}

/**
 * Construct a normalized non-success result after Runtime classifies an
 * execution failure. Runtime owns ProviderError interpretation; this boundary
 * remains the sole producer of the Character-facing result shape.
 */
export function createCognitionFailureResult(input: unknown): NormalizedCognitionResult {
  const value = expectObject(input, "Cognition failure result input");
  assertAllowedKeys(value, ["status", "observations", "reason"], "Cognition failure result input");
  if (!isFailureStatus(value.status)) {
    throw new Error("Cognition failure status must be UNAVAILABLE, CANCELLED, or ERROR.");
  }

  if (value.observations !== undefined) {
    if (!Array.isArray(value.observations) || value.observations.length > 4)
      throw new Error("Cognition interrupted observations must be a bounded array.");
    if (value.status === "CANCELLED")
      throw new Error("Cancelled results cannot disclose capability observations.");
    const success = value.observations
      .map(createCognitionCapabilityObservation)
      .filter((o) => o.status === "SUCCESS" && o.content?.trim());
    if (success.length) {
      if (
        value.reason !== undefined &&
        (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 200)
      )
        throw new Error("Invalid Cognition interruption reason.");
      const reason = value.reason ?? "execution stopped";
      return createNormalizedCognitionResult({
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "PARTIAL",
        evidence: success.map((o) => ({
          reference: o.capabilityRef,
          statement:
            o.content!.length <= 2000
              ? o.content!
              : o.content!.slice(0, 980) +
                "\n[observation excerpt; middle omitted]\n" +
                o.content!.slice(-980)
        })),
        caveats: [
          `Goal not completed: ${reason}.`,
          "These are returned capability observations, not proof that every requested external action completed. Evidence references identify capability bindings; observations remain ordered.",
          ...(success.some((o) => o.coverage || o.content!.length > 2000)
            ? [
                "Some observation content is a bounded excerpt; unseen source content remains unknown."
              ]
            : [])
        ]
      });
    }
  }
  return createNormalizedCognitionResult({
    version: NORMALIZED_COGNITION_RESULT_VERSION,
    status: value.status
  });
}

function normalizeCapabilityDescription(
  input: unknown,
  index: number,
  seenRefs: Set<string>
): CognitionCapabilityDescription {
  const field = `Cognition capability ${index}`;
  const value = expectObject(input, field);
  assertAllowedKeys(value, ["capabilityRef", "description"], field);

  const capabilityRef = boundedCapabilityRef(value.capabilityRef, `${field} capabilityRef`);
  if (seenRefs.has(capabilityRef)) {
    throw new Error("Cognition capabilityRef values must be unique.");
  }
  seenRefs.add(capabilityRef);

  const description = boundedCapabilityDescription(value.description, `${field} description`);
  return Object.freeze({ capabilityRef, description });
}

function normalizeEscalation(input: unknown): CharacterHarnessCognitionRequest {
  const value = expectObject(input, "Cognition Character escalation");
  assertAllowedKeys(value, ["version", "kind", "focus"], "Cognition Character escalation");
  if (value.version !== CHARACTER_HARNESS_5G_VERSION || value.kind !== "NEED_COGNITION") {
    throw new Error("Cognition requires a Character Harness 5G NEED_COGNITION request.");
  }

  const focus =
    value.focus === undefined ? undefined : boundedFocus(value.focus, "Cognition escalation focus");

  return Object.freeze({
    version: CHARACTER_HARNESS_5G_VERSION,
    kind: "NEED_COGNITION",
    ...(focus === undefined ? {} : { focus })
  });
}

function boundedProblem(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("Cognition problem must be a non-empty string.");
  }
  if (input.length > 16_000) {
    throw new Error("Cognition problem must not exceed 16000 characters.");
  }
  return input;
}

function boundedCapabilityRef(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0 || input.trim() !== input) {
    throw new Error(`${field} must be a non-empty opaque string without surrounding whitespace.`);
  }
  if (input.length > COGNITION_6G_MAX_CAPABILITY_REF_CHARACTERS) {
    throw new Error(
      `${field} must not exceed ${COGNITION_6G_MAX_CAPABILITY_REF_CHARACTERS} characters.`
    );
  }
  return input;
}

function boundedCapabilityDescription(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (input.length > COGNITION_6G_MAX_DESCRIPTION_CHARACTERS) {
    throw new Error(
      `${field} must not exceed ${COGNITION_6G_MAX_DESCRIPTION_CHARACTERS} characters.`
    );
  }
  return input;
}

function boundedCapabilityRequest(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("Cognition capability request must be a non-empty string.");
  }
  if (input.length > COGNITION_6H_MAX_REQUEST_CHARACTERS) {
    throw new Error(
      `Cognition capability request must not exceed ${COGNITION_6H_MAX_REQUEST_CHARACTERS} characters.`
    );
  }
  return input;
}

function boundedFocus(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (input.length > 500) {
    throw new Error(`${field} must not exceed 500 characters.`);
  }
  return input;
}

function requireProviderAnswer(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("Cognition reasoning output requires a non-empty answer.");
  }
  return input;
}

type NormalizedFinishReason = NonNullable<ReasoningOutput["finishReason"]>;

function normalizeFinishReason(input: unknown): NormalizedFinishReason {
  if (input === undefined) {
    return "stop";
  }
  if (
    input === "stop" ||
    input === "length" ||
    input === "tool_call" ||
    input === "content_filter" ||
    input === "unknown"
  ) {
    return input;
  }
  throw new Error("Cognition reasoning finishReason is invalid.");
}

function isFailureStatus(input: unknown): input is Cognition6AFailureStatus {
  return (
    typeof input === "string" &&
    (COGNITION_6A_FAILURE_STATUSES as readonly string[]).includes(input)
  );
}

function expectObject(input: unknown, field: string): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  return input as UnknownObject;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown field: ${unknown.sort().join(", ")}.`);
  }
}
