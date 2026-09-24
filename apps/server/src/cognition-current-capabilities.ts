import { createCognitionReasoningTask } from "@companion/cognition";
import {
  COGNITION_6U_VERSION,
  createCognitionCapabilityAwareFailureDisposition,
  createCognitionCapabilityAwareReasoningTask,
  type CognitionCapabilityAwareReasoningDisposition
} from "@companion/cognition/capability-aware-task";
import type { ProviderResolver } from "@companion/providers";
import { executeServerCapabilityAwareCognition } from "./cognition-capability-aware.js";
import {
  createCurrentServerMcpCapabilityBindings,
  type ServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";
import type { ServerMcpClient } from "./mcp-client.js";

export type ServerCurrentCapabilityAwareCognitionInput = Readonly<{
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  mcpClient: Pick<ServerMcpClient, "listTools">;
  staticRegistry: ServerMcpCapabilityBindings;
  /** One caller-authorized 6A task. Capability inventory is not caller-supplied here. */
  task: unknown;
  signal?: AbortSignal | undefined;
}>;

/**
 * Execute one initial capability-aware Cognition pass against the current
 * Runtime-authorized semantic capability surface.
 *
 * The caller-owned 6A task is canonicalized before MCP discovery. Capability
 * inventory is then derived only from the host-validated A7.1 registry
 * intersected with one current MCP `listTools()` result. Discovery may remove
 * unavailable capabilities but cannot promote server-only tools or replace the
 * static semantic descriptions. The resulting 6U task is delegated unchanged
 * to the existing 6X one-shot composition.
 *
 * This seam performs no Runtime capability admission, `callTool`, concrete
 * argument/path binding, capability execution, post-capability reasoning,
 * retry/fallback, persistence, Memory/P8 writes, Runtime events, or Character
 * re-entry. Discovery failure is not reinterpreted as an empty inventory.
 */
export async function executeServerCurrentCapabilityAwareCognition(
  input: ServerCurrentCapabilityAwareCognitionInput
): Promise<CognitionCapabilityAwareReasoningDisposition> {
  const task = createCognitionReasoningTask(input.task);

  if (input.signal?.aborted) {
    return createCognitionCapabilityAwareFailureDisposition({ status: "CANCELLED" });
  }

  const discoveredTools = await input.mcpClient.listTools(
    input.signal === undefined ? undefined : { signal: input.signal }
  );
  const currentRegistry = createCurrentServerMcpCapabilityBindings(
    input.staticRegistry,
    discoveredTools
  );
  const capabilityAwareTask = createCognitionCapabilityAwareReasoningTask({
    version: COGNITION_6U_VERSION,
    task,
    capabilities: currentRegistry.descriptions
  });

  return executeServerCapabilityAwareCognition({
    providers: input.providers,
    task: capabilityAwareTask,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
}
