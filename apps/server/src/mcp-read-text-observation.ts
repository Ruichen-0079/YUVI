import {
  COGNITION_6H_VERSION,
  createCognitionCapabilityRequest
} from "@companion/cognition";
import {
  COGNITION_6N_VERSION,
  createCognitionCapabilityObservation,
  type CognitionCapabilityObservation
} from "@companion/cognition/capability-observation";
import {
  bindServerMcpCapabilityRequest,
  SERVER_MCP_READ_TEXT_IMPLEMENTATION_REF,
  type ServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";
import {
  SERVER_MCP_READ_TEXT_6M_VERSION,
  type ServerMcpReadTextOutcome
} from "./mcp-read-text-capability.js";

export const SERVER_MCP_READ_TEXT_OBSERVATION_6O_VERSION =
  "server-mcp-read-text-observation-6o.v1" as const;

export type ServerMcpReadTextObservation = Readonly<{
  version: typeof SERVER_MCP_READ_TEXT_OBSERVATION_6O_VERSION;
  observation: CognitionCapabilityObservation;
}>;

export type ServerMcpReadTextObservationInput = Readonly<{
  outcome: ServerMcpReadTextOutcome;
  request: unknown;
  staticRegistry: ServerMcpCapabilityBindings;
}>;

/**
 * Project the first concrete MCP capability result into the provider-neutral
 * 6N observation contract consumed by Cognition.
 *
 * The original 6H request is revalidated against the static A7.1 registry so
 * the observation cannot be rebound to another opaque capability. Concrete
 * tool names, paths, MCP wire blocks, Runtime rejection reasons, and tool error
 * text are never exposed through the observation seam.
 */
export function createServerMcpReadTextObservation(
  input: ServerMcpReadTextObservationInput
): ServerMcpReadTextObservation {
  const request = createCognitionCapabilityRequest(
    input.request,
    input.staticRegistry.descriptions
  );
  if (request.version !== COGNITION_6H_VERSION) {
    throw new Error("Server MCP read-text observation requires a 6H capability request.");
  }

  const binding = bindServerMcpCapabilityRequest(request, input.staticRegistry);
  if (binding.implementationRef !== SERVER_MCP_READ_TEXT_IMPLEMENTATION_REF) {
    throw new Error("Server MCP read-text observation requires a read_text_file binding.");
  }
  if (input.outcome.version !== SERVER_MCP_READ_TEXT_6M_VERSION) {
    throw new Error("Server MCP read-text observation requires a 6M outcome.");
  }

  const observation = normalizeOutcome(input.outcome, request.capabilityRef);
  return Object.freeze({
    version: SERVER_MCP_READ_TEXT_OBSERVATION_6O_VERSION,
    observation
  });
}

function normalizeOutcome(
  outcome: ServerMcpReadTextOutcome,
  capabilityRef: string
): CognitionCapabilityObservation {
  switch (outcome.status) {
    case "REJECTED":
    case "UNAVAILABLE":
      return createCognitionCapabilityObservation({
        version: COGNITION_6N_VERSION,
        capabilityRef,
        status: "UNAVAILABLE"
      });
    case "INVOKED":
      if (outcome.result.isError) {
        return createCognitionCapabilityObservation({
          version: COGNITION_6N_VERSION,
          capabilityRef,
          status: "ERROR"
        });
      }

      const content = extractReadTextContent(outcome.result.content);
      if (content === undefined) {
        return createCognitionCapabilityObservation({
          version: COGNITION_6N_VERSION,
          capabilityRef,
          status: "ERROR"
        });
      }

      try {
        return createCognitionCapabilityObservation({
          version: COGNITION_6N_VERSION,
          capabilityRef,
          status: "SUCCESS",
          content
        });
      } catch {
        return createCognitionCapabilityObservation({
          version: COGNITION_6N_VERSION,
          capabilityRef,
          status: "ERROR"
        });
      }
  }
}

function extractReadTextContent(content: readonly unknown[]): string | undefined {
  const textBlocks: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      return undefined;
    }
    const value = block as Record<string, unknown>;
    if (value["type"] !== "text" || typeof value["text"] !== "string") {
      return undefined;
    }
    textBlocks.push(value["text"]);
  }

  if (textBlocks.length === 0) {
    return undefined;
  }
  const joined = textBlocks.join("\n");
  return joined.trim().length === 0 ? undefined : joined;
}
