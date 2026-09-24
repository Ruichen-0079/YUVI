import { createCharacterHarnessCognitionRoundTrip } from "@companion/character-harness/cognition-result";
import { COGNITION_6U_VERSION } from "@companion/cognition/capability-aware-task";
import {
  COGNITION_6G_VERSION,
  createCognitionCapabilityDescriptions,
  createCognitionFailureResult,
  createCognitionReasoningTask
} from "@companion/cognition";
import {
  COGNITION_6N_VERSION,
  createCognitionCapabilityObservation,
  type CognitionCapabilityObservation
} from "@companion/cognition/capability-observation";
import {
  COGNITION_INTERACTION_ROUND_VERSION,
  createCognitionInteractionReasoningInput,
  createCognitionInteractionRound,
  interpretCognitionInteractionOutput,
  type CognitionInteractionRound
} from "@companion/cognition/interaction-round";
import {
  executeRuntimeCognitionInteraction,
  executeRuntimeCognitionOnce,
  type RuntimeCognitionExecution,
  type RuntimeCognitionLimits
} from "@companion/core";
import type { ProviderResolver } from "@companion/providers";
import type { CanonicalContext } from "@companion/prompt-builder";
import {
  createCurrentServerMcpCapabilityBindings,
  SERVER_MCP_READ_TEXT_IMPLEMENTATION_REF,
  type ServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";
import type { ServerPluginRuntimeCapabilitySurface } from "./plugin-lifecycle.js";
import type { ServerMcpClient } from "./mcp-client.js";
import { executeServerReadTextObservationRound } from "./cognition-read-text-observation.js";

/** Composition only: Core owns every loop/attempt; Phase-6 owns binding and normalization. */
export async function executeServerCognitionInteraction(input: {
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  task: unknown;
  canonicalContext?: CanonicalContext | undefined;
  staticRegistry: ServerMcpCapabilityBindings;
  /** Host-only registration view; invocation is used only inside Core's admitted callback. */
  pluginCapabilities?: ServerPluginRuntimeCapabilitySurface | undefined;
  mcpClient: Pick<ServerMcpClient, "listTools" | "callTool">;
  runtimeAuthorizedPath: string;
  policyAllowsCapability: boolean;
  execution: RuntimeCognitionExecution;
  limits: RuntimeCognitionLimits;
  signal?: AbortSignal | undefined;
}) {
  const task = createCognitionReasoningTask(input.task);
  const { providers, staticRegistry, mcpClient, runtimeAuthorizedPath } = input;
  if (
    staticRegistry.bindings.some(
      (binding) => binding.implementationRef !== SERVER_MCP_READ_TEXT_IMPLEMENTATION_REF
    )
  )
    throw new Error("Cognition interaction requires a read_text_file-only registry.");
  let pluginCapabilityRefs = new Set<string>();
  let authorizedHistoryDescriptions = staticRegistry.descriptions;
  const outcome = await executeRuntimeCognitionInteraction<
    CognitionInteractionRound,
    CognitionCapabilityObservation
  >({
    execution: input.execution,
    limits: input.limits,
    signal: input.signal,
    policyAllowsCapability: input.policyAllowsCapability,
    async reason(history, signal) {
      const tools = await mcpClient.listTools({ signal });
      const current = createCurrentServerMcpCapabilityBindings(staticRegistry, tools);
      const pluginCapabilities = input.pluginCapabilities?.snapshot() ?? [];
      pluginCapabilityRefs = new Set(
        pluginCapabilities.map((capability) => capability.capabilityRef)
      );
      const currentDescriptions = createCognitionCapabilityDescriptions({
        version: COGNITION_6G_VERSION,
        capabilities: [...current.descriptions.capabilities, ...pluginCapabilities]
      });
      authorizedHistoryDescriptions = createCognitionCapabilityDescriptions({
        version: COGNITION_6G_VERSION,
        capabilities: [
          ...authorizedHistoryDescriptions.capabilities,
          ...pluginCapabilities.filter(
            (capability) =>
              !authorizedHistoryDescriptions.capabilities.some(
                (authorized) => authorized.capabilityRef === capability.capabilityRef
              )
          )
        ]
      });
      const capabilityTask = {
        version: COGNITION_6U_VERSION,
        task,
        capabilities: currentDescriptions
      };
      return executeRuntimeCognitionOnce({
        providers,
        task: capabilityTask,
        signal,
        allowFallback: false,
        boundary: {
          createReasoningInput: (value) =>
            createCognitionInteractionReasoningInput(
              value,
              history.map((exchange) => ({
                request: exchange.request.request,
                observation: exchange.observation
              })),
              authorizedHistoryDescriptions,
              input.canonicalContext
            ),
          normalizeReasoningOutput: (output) =>
            interpretCognitionInteractionOutput(output, currentDescriptions),
          createFailureResult: (failure) =>
            createCognitionInteractionRound(
              {
                version: COGNITION_INTERACTION_ROUND_VERSION,
                kind: "COMPLETE",
                result: createCognitionFailureResult(failure)
              },
              currentDescriptions
            )
        }
      });
    },
    async invoke(round, state, signal) {
      try {
        if (pluginCapabilityRefs.has(round.request.capabilityRef) && input.pluginCapabilities) {
          const content = await input.pluginCapabilities.invoke(
            round.request.capabilityRef,
            round.request.request,
            signal
          );
          return createCognitionCapabilityObservation({
            version: COGNITION_6N_VERSION,
            capabilityRef: round.request.capabilityRef,
            status: "SUCCESS",
            content
          });
        }
        const observed = await executeServerReadTextObservationRound({
          mcpClient,
          staticRegistry,
          request: round.request,
          capabilityRoundsUsed: state.capabilityCallsUsed,
          maxCapabilityCalls: state.limits.maxCapabilityCalls,
          policyAllowsCapability: true,
          runtimeAuthorizedPath,
          signal
        });
        return observed.observation;
      } catch {
        // Never expose transport error text or invent successful evidence. Core
        // checks abort/current identity before admitting another reasoning pass.
        return createCognitionCapabilityObservation({
          version: COGNITION_6N_VERSION,
          capabilityRef: round.request.capabilityRef,
          status: "ERROR"
        });
      }
    }
  });
  const terminal = outcome.state.terminal;
  const result =
    outcome.completion?.result ??
    createCognitionFailureResult({
      status:
        terminal?.status === "CANCELLED" ||
        (terminal?.status === "FAILED" && terminal.reason === "STALE_EXECUTION")
          ? "CANCELLED"
          : "ERROR"
    });
  return createCharacterHarnessCognitionRoundTrip({ request: task.escalation, result });
}
