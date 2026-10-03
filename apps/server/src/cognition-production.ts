import type { ReadTextEffectInput, HostReadTextEffects } from "./read-text-effect.js";
import { COGNITION_6A_VERSION } from "@companion/cognition";
import type { CharacterHarnessCognitionRequest } from "@companion/character-harness/cognition-request";
import type { ProviderResolver } from "@companion/providers";
import type { CanonicalContext } from "@companion/prompt-builder";
import { executeServerCognitionInteraction } from "./cognition-interaction.js";
import type { RuntimeCognitionExecution, RuntimeCognitionLimits } from "@companion/core";
import {
  createServerMcpCapabilityBindings,
  SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
  SERVER_MCP_READ_TEXT_CAPABILITY_REF,
  createServerMcpReadTextRegistration
} from "./mcp-capability-binding.js";
import type { ServerPluginRuntimeCapabilitySurface } from "./plugin-lifecycle.js";

/** Concrete local adapter for the existing allowlisted read_text_file seam. */
export function executeProductionCognition(input: {
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  request: CharacterHarnessCognitionRequest;
  problem: string;
  canonicalContext?: CanonicalContext | undefined;
  runtimeAuthorizedPath?: string | undefined;
  readTextEffects?: HostReadTextEffects | undefined;
  effectContext?: Pick<ReadTextEffectInput, "scope" | "cause"> | undefined;
  pluginCapabilities?: ServerPluginRuntimeCapabilitySurface | undefined;
  signal?: AbortSignal | undefined;
  execution: RuntimeCognitionExecution;
  limits: RuntimeCognitionLimits;
}) {
  const path = input.runtimeAuthorizedPath;
  const expiresAt = new Date(Date.now() + input.limits.timeBudgetMs).toISOString();
  let readOrdinal = 0;
  const staticRegistry = createServerMcpCapabilityBindings({
    version: SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
    capabilities: path
      ? [
          createServerMcpReadTextRegistration(
            SERVER_MCP_READ_TEXT_CAPABILITY_REF,
            "Read the single text file explicitly authorized by the local controller for this turn."
          )
        ]
      : []
  });
  return executeServerCognitionInteraction({
    providers: input.providers,
    task: { version: COGNITION_6A_VERSION, escalation: input.request, problem: input.problem },
    canonicalContext: input.canonicalContext,
    staticRegistry,
    pluginCapabilities: input.pluginCapabilities,
    execution: input.execution,
    limits: input.limits,
    policyAllowsCapability: Boolean(path || input.pluginCapabilities?.snapshot().length),
    runtimeAuthorizedPath: path ?? "unavailable",
    signal: input.signal,
    mcpClient: {
      async listTools() {
        return path
          ? [
              {
                name: "read_text_file",
                inputSchema: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"]
                }
              }
            ]
          : [];
      },
      async callTool(call, options) {
        if (!path || call.name !== "read_text_file" || call.arguments?.["path"] !== path)
          throw new Error("Read-text admission mismatch");
        options?.signal?.throwIfAborted();
        if (!input.readTextEffects || !input.effectContext)
          throw new Error("Durable read-text authority unavailable");
        const { scope, cause } = input.effectContext;
        return input.readTextEffects.execute({
          path,
          scope,
          cause,
          executionId: input.execution.executionId,
          logicalKey: `read-text:${cause.namespace}:${cause.eventId}:round:${readOrdinal++}`,
          expiresAt,
          isCurrent: () => input.execution.isCurrent(),
          signal: options?.signal
        });
      }
    }
  });
}
