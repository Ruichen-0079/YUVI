import {
  createNormalizedCognitionResult,
  type NormalizedCognitionResult
} from "@companion/character-abi";
import { createCognitionCapabilityRequest, type CognitionCapabilityRequest } from "./index.js";

export const COGNITION_INTERACTION_ROUND_VERSION = "cognition-interaction-round.v1" as const;

/** Semantic proposals only; none of these variants authorizes another effect. */
export type CognitionInteractionDecision =
  | Readonly<{ kind: "COMPLETE"; result: NormalizedCognitionResult }>
  | Readonly<{ kind: "REQUEST_CAPABILITY"; request: CognitionCapabilityRequest }>
  | Readonly<{ kind: "CONTINUE" }>;

export type CognitionInteractionRound = Readonly<{
  version: typeof COGNITION_INTERACTION_ROUND_VERSION;
}> &
  CognitionInteractionDecision;

/**
 * Validate a decision produced by the Cognition boundary, not raw provider wire.
 * Reuse the existing result validator and inventory-bound capability request.
 * CONTINUE asks for another reasoning pass over the authorized task/evidence;
 * it carries no raw reasoning, new task, execution identity, or budget override.
 *
 * A1 defines the contract only. The production 6W parser still rejects CONTINUE.
 * Runtime admission, counters, cancellation and terminal fencing belong to A2.
 */
export function createCognitionInteractionRound(
  input: unknown,
  capabilityDescriptions: unknown
): CognitionInteractionRound {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Cognition interaction round must be an object.");
  }
  const value = input as Record<string, unknown>;
  if (value["version"] !== COGNITION_INTERACTION_ROUND_VERSION) {
    throw new Error(
      `Cognition interaction round version must be ${COGNITION_INTERACTION_ROUND_VERSION}.`
    );
  }
  const kind = value["kind"];
  const payloadKey =
    kind === "COMPLETE" ? "result" : kind === "REQUEST_CAPABILITY" ? "request" : undefined;
  const allowed = new Set(["version", "kind", ...(payloadKey ? [payloadKey] : [])]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Cognition interaction round contains unknown fields.");
  }
  const version = COGNITION_INTERACTION_ROUND_VERSION;
  switch (kind) {
    case "COMPLETE":
      return Object.freeze({
        version,
        kind,
        result: createNormalizedCognitionResult(value["result"])
      });
    case "REQUEST_CAPABILITY":
      return Object.freeze({
        version,
        kind,
        request: createCognitionCapabilityRequest(value["request"], capabilityDescriptions)
      });
    case "CONTINUE":
      return Object.freeze({ version, kind });
    default:
      throw new Error("Cognition interaction round kind is invalid.");
  }
}
