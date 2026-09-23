import { createCharacterHarnessCognitionRoundTrip } from "@companion/character-harness/cognition-result";
import { COGNITION_6U_VERSION } from "@companion/cognition/capability-aware-task";
import { createCognitionFailureResult, createCognitionReasoningTask } from "@companion/cognition";
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
  type ServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";
import type { ServerMcpClient } from "./mcp-client.js";
import { executeServerReadTextObservationRound } from "./cognition-read-text-observation.js";

/** Composition only: Core owns every loop/attempt; Phase-6 owns binding and normalization. */
export async function executeServerCognitionInteraction(input: {
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  task: unknown;
  canonicalContext?: CanonicalContext | undefined;
  staticRegistry: ServerMcpCapabilityBindings;
  mcpClient: Pick<ServerMcpClient, "listTools" | "callTool">;
  runtimeAuthorizedPath: string;
  policyAllowsCapability: boolean;
  execution: RuntimeCognitionExecution;
  limits: RuntimeCognitionLimits;
  signal?: AbortSignal | undefined;
}) {
  const task = createCognitionReasoningTask(input.task);
  const { providers, staticRegistry, mcpClient, runtimeAuthorizedPath } = input;
  if (staticRegistry.bindings.some((binding) => binding.toolName !== "read_text_file"))
    throw new Error("Cognition interaction requires a read_text_file-only registry.");
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
      const capabilityTask = {
        version: COGNITION_6U_VERSION,
        task,
        capabilities: current.descriptions
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
              staticRegistry.descriptions,
              input.canonicalContext
            ),
          normalizeReasoningOutput: (output) =>
            interpretCognitionInteractionOutput(output, current.descriptions),
          createFailureResult: (failure) =>
            createCognitionInteractionRound(
              {
                version: COGNITION_INTERACTION_ROUND_VERSION,
                kind: "COMPLETE",
                result: createCognitionFailureResult(failure)
              },
              current.descriptions
            )
        }
      });
    },
    async invoke(round, state, signal) {
      try {
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
