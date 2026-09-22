import { createCognitionCapabilityRequest } from "@companion/cognition";
import type { ServerMcpCapabilityBindings } from "./mcp-capability-binding.js";
import type { ServerMcpClient } from "./mcp-client.js";
import { executeServerMcpReadTextCapability } from "./mcp-read-text-capability.js";
import {
  createServerMcpReadTextObservation,
  type ServerMcpReadTextObservation
} from "./mcp-read-text-observation.js";

export type ServerReadTextObservationRoundInput = Readonly<{
  mcpClient: Pick<ServerMcpClient, "listTools" | "callTool">;
  staticRegistry: ServerMcpCapabilityBindings;
  /** One Cognition 6H semantic request; never interpreted as concrete arguments. */
  request: unknown;
  capabilityRoundsUsed: number;
  maxCapabilityCalls?: number | undefined;
  policyAllowsCapability: boolean;
  /** Runtime-authorized concrete path. Cognition request text cannot select it. */
  runtimeAuthorizedPath: string;
  signal?: AbortSignal | undefined;
}>;

/**
 * Execute and normalize exactly one admitted read-text capability round.
 *
 * The 6H request is canonicalized before asynchronous MCP work so caller-side
 * mutation cannot change capability identity or semantic request text while the
 * invocation is in flight. Existing 6M remains the sole Runtime-admission,
 * current-discovery, concrete-path binding, and one-call execution authority.
 * Existing 6O remains the sole MCP/result -> provider-neutral 6N observation
 * projection authority.
 *
 * This seam does not perform initial or post-capability Cognition reasoning,
 * does not increment/persist round state, does not retry/fallback, and does not
 * write Memory/P8, emit Runtime events, or re-enter Character.
 */
export async function executeServerReadTextObservationRound(
  input: ServerReadTextObservationRoundInput
): Promise<ServerMcpReadTextObservation> {
  const request = createCognitionCapabilityRequest(
    input.request,
    input.staticRegistry.descriptions
  );

  const outcome = await executeServerMcpReadTextCapability({
    mcpClient: input.mcpClient,
    staticRegistry: input.staticRegistry,
    request,
    capabilityRoundsUsed: input.capabilityRoundsUsed,
    maxCapabilityCalls: input.maxCapabilityCalls,
    policyAllowsCapability: input.policyAllowsCapability,
    runtimeAuthorizedPath: input.runtimeAuthorizedPath,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });

  return createServerMcpReadTextObservation({
    outcome,
    request,
    staticRegistry: input.staticRegistry
  });
}
