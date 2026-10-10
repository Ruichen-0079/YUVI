import { COGNITION_6G_VERSION, createCognitionCapabilityDescriptions } from "./index.js";

export const COGNITION_6N_VERSION = "cognition-6n.v1" as const;
export const COGNITION_6N_OBSERVATION_STATUSES = ["SUCCESS", "UNAVAILABLE", "ERROR"] as const;
export type CognitionCapabilityObservationStatus =
  (typeof COGNITION_6N_OBSERVATION_STATUSES)[number];

export type CognitionCapabilityObservation = Readonly<{
  version: typeof COGNITION_6N_VERSION;
  /** Opaque binding handle only; concrete tool/server identity stays outside Cognition. */
  capabilityRef: string;
  status: CognitionCapabilityObservationStatus;
  /** Bounded semantic observation from a successful admitted invocation. */
  content?: string;
  /** Successful invocation with only a bounded prefix available to Cognition. */
  coverage?: Readonly<{
    kind: "PREFIX";
    unit: "UTF16_CODE_UNITS";
    originalCharacters: number;
    providedCharacters: number;
  }>;
}>;

export const COGNITION_6N_MAX_CONTENT_CHARACTERS = 16_000;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  capabilityRef?: unknown;
  status?: unknown;
  content?: unknown;
};

/**
 * Validate one provider/MCP-neutral capability observation returned toward
 * Cognition after Runtime admission and execution.
 *
 * This is not a final Cognition Result and does not create Memory/P8 truth.
 * Concrete MCP/tool/server/path/provider metadata is deliberately absent.
 */
export function createCognitionCapabilityObservation(
  input: unknown
): CognitionCapabilityObservation {
  const value = expectObject(input, "Cognition 6N capability observation");
  assertAllowedKeys(
    value,
    ["version", "capabilityRef", "status", "content", "coverage"],
    "Cognition 6N capability observation"
  );
  if (value.version !== COGNITION_6N_VERSION) {
    throw new Error(`Cognition capability observation version must be ${COGNITION_6N_VERSION}.`);
  }
  if (!isObservationStatus(value.status)) {
    throw new Error("Cognition capability observation status is invalid.");
  }

  const capabilityRef = validateCapabilityRef(value.capabilityRef);
  if (value.status === "SUCCESS") {
    const content = boundedContent(value.content);
    const coverage =
      value["coverage"] === undefined ? undefined : validateCoverage(value["coverage"], content);
    return Object.freeze({
      version: COGNITION_6N_VERSION,
      capabilityRef,
      status: value.status,
      content,
      ...(coverage ? { coverage } : {})
    });
  }

  if (value.content !== undefined || value["coverage"] !== undefined) {
    throw new Error("Non-success Cognition capability observations must not carry content.");
  }
  return Object.freeze({
    version: COGNITION_6N_VERSION,
    capabilityRef,
    status: value.status
  });
}

function validateCapabilityRef(input: unknown): string {
  const inventory = createCognitionCapabilityDescriptions({
    version: COGNITION_6G_VERSION,
    capabilities: [
      {
        capabilityRef: input,
        description: "Validated capability observation binding."
      }
    ]
  });
  return inventory.capabilities[0]!.capabilityRef;
}

function boundedContent(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("Successful Cognition capability observation requires textual content.");
  }
  if (input.length > COGNITION_6N_MAX_CONTENT_CHARACTERS) {
    throw new Error(
      `Cognition capability observation content must not exceed ${COGNITION_6N_MAX_CONTENT_CHARACTERS} characters.`
    );
  }
  return input;
}

function validateCoverage(
  input: unknown,
  content: string
): NonNullable<CognitionCapabilityObservation["coverage"]> {
  const value = expectObject(input, "Cognition observation coverage");
  assertAllowedKeys(
    value,
    ["kind", "unit", "originalCharacters", "providedCharacters"],
    "Cognition observation coverage"
  );
  const original = value["originalCharacters"],
    provided = value["providedCharacters"];
  if (
    value["kind"] !== "PREFIX" ||
    value["unit"] !== "UTF16_CODE_UNITS" ||
    typeof original !== "number" ||
    !Number.isSafeInteger(original) ||
    typeof provided !== "number" ||
    !Number.isSafeInteger(provided) ||
    provided !== content.length ||
    original <= provided
  ) {
    throw new Error("Cognition observation coverage must describe an actual bounded prefix.");
  }
  return Object.freeze({
    kind: "PREFIX",
    unit: "UTF16_CODE_UNITS",
    originalCharacters: original,
    providedCharacters: provided
  });
}

function isObservationStatus(input: unknown): input is CognitionCapabilityObservationStatus {
  return (
    typeof input === "string" &&
    (COGNITION_6N_OBSERVATION_STATUSES as readonly string[]).includes(input)
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
