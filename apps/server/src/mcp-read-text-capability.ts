import {
  RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
  admitRuntimeCapabilityRound,
  type RuntimeCapabilityAdmissionRejectionReason
} from "@companion/core";
import {
  bindServerMcpCapabilityRequest,
  createCurrentServerMcpCapabilityBindings,
  type ServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";
import type { ServerMcpClient, ServerMcpToolResult } from "./mcp-client.js";

export const SERVER_MCP_READ_TEXT_6M_VERSION = "server-mcp-read-text-6m.v1" as const;

export type ServerMcpReadTextOutcome =
  | Readonly<{
      version: typeof SERVER_MCP_READ_TEXT_6M_VERSION;
      status: "REJECTED";
      reason: RuntimeCapabilityAdmissionRejectionReason;
    }>
  | Readonly<{
      version: typeof SERVER_MCP_READ_TEXT_6M_VERSION;
      status: "UNAVAILABLE";
      reason: "MCP_TOOL_NOT_AVAILABLE";
    }>
  | Readonly<{
      version: typeof SERVER_MCP_READ_TEXT_6M_VERSION;
      status: "INVOKED";
      result: ServerMcpToolResult;
    }>;

export type ServerMcpReadTextInput = Readonly<{
  mcpClient: Pick<ServerMcpClient, "listTools" | "callTool">;
  staticRegistry: ServerMcpCapabilityBindings;
  /** Cognition 6H semantic proposal; never parsed into concrete tool arguments. */
  request: unknown;
  capabilityRoundsUsed: number;
  maxCapabilityCalls?: number | undefined;
  policyAllowsCapability: boolean;
  /** Runtime-authorized concrete file path. Cognition does not choose this value. */
  runtimeAuthorizedPath: string;
  signal?: AbortSignal | undefined;
}>;

/**
 * Execute the first concrete Phase-6 capability: one Runtime-admitted
 * `read_text_file` MCP invocation.
 *
 * The semantic request is validated/bound before any MCP I/O, but it never
 * supplies the path argument. Runtime supplies the already-authorized concrete
 * path. Admission happens before discovery/call, current inventory is the 6K
 * allowlist intersected with 6L discovery, and exactly one call is attempted.
 *
 * This function does not retry, mutate the round counter, persist, normalize
 * evidence, or continue Cognition. MCP call failures are allowed to propagate
 * to the Runtime/composition owner.
 */
export async function executeServerMcpReadTextCapability(
  input: ServerMcpReadTextInput
): Promise<ServerMcpReadTextOutcome> {
  const staticBinding = bindServerMcpCapabilityRequest(input.request, input.staticRegistry);
  if (staticBinding.toolName !== "read_text_file") {
    throw new Error("Server MCP read-text capability requires an explicit read_text_file binding.");
  }

  const runtimeAuthorizedPath = requireRuntimeAuthorizedPath(input.runtimeAuthorizedPath);
  const admission = admitRuntimeCapabilityRound({
    version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
    capabilityRoundsUsed: input.capabilityRoundsUsed,
    maxCapabilityCalls: input.maxCapabilityCalls,
    policyAllowsCapability: input.policyAllowsCapability
  });
  if (admission.status === "REJECTED") {
    return Object.freeze({
      version: SERVER_MCP_READ_TEXT_6M_VERSION,
      status: "REJECTED",
      reason: admission.reason
    });
  }

  input.signal?.throwIfAborted();
  const discoveredTools = await input.mcpClient.listTools(
    input.signal === undefined ? undefined : { signal: input.signal }
  );
  const currentRegistry = createCurrentServerMcpCapabilityBindings(
    input.staticRegistry,
    discoveredTools
  );

  const currentlyAvailable = currentRegistry.bindings.some(
    (binding) => binding.toolName === staticBinding.toolName
  );
  if (!currentlyAvailable) {
    return Object.freeze({
      version: SERVER_MCP_READ_TEXT_6M_VERSION,
      status: "UNAVAILABLE",
      reason: "MCP_TOOL_NOT_AVAILABLE"
    });
  }

  const currentBinding = bindServerMcpCapabilityRequest(input.request, currentRegistry);
  if (currentBinding.toolName !== "read_text_file") {
    throw new Error("Server MCP current read-text binding changed unexpectedly.");
  }

  input.signal?.throwIfAborted();
  const result = await input.mcpClient.callTool(
    {
      name: "read_text_file",
      arguments: Object.freeze({ path: runtimeAuthorizedPath })
    },
    input.signal === undefined ? undefined : { signal: input.signal }
  );
  input.signal?.throwIfAborted();

  return Object.freeze({
    version: SERVER_MCP_READ_TEXT_6M_VERSION,
    status: "INVOKED",
    result
  });
}

function requireRuntimeAuthorizedPath(input: string): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.trim() !== input) {
    throw new Error(
      "Runtime-authorized MCP read-text path must be a non-empty string without surrounding whitespace."
    );
  }
  if (input.length > 4_096) {
    throw new Error("Runtime-authorized MCP read-text path must not exceed 4096 characters.");
  }
  return input;
}
