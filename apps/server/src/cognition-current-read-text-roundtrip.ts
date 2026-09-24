import {
  createCharacterHarnessCognitionRoundTrip,
  type CharacterHarnessCognitionRoundTrip
} from "@companion/character-harness/cognition-result";
import { createCognitionReasoningTask } from "@companion/cognition";
import type { ProviderResolver } from "@companion/providers";
import type { ServerMcpCapabilityBindings } from "./mcp-capability-binding.js";
import type { ServerMcpClient } from "./mcp-client.js";
import { executeServerCurrentCapabilityAwareCognition } from "./cognition-current-capabilities.js";
import { executeServerReadTextAssistedCompletion } from "./cognition-read-text-assisted-completion.js";

export type ServerCurrentReadTextCognitionRoundTripInput = Readonly<{
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  mcpClient: Pick<ServerMcpClient, "listTools" | "callTool">;
  /** Caller-authorized read-text-only A7.1 capability registry. */
  staticRegistry: ServerMcpCapabilityBindings;
  /** One caller-authorized 6A task. */
  task: unknown;
  capabilityRoundsUsed: number;
  policyAllowsCapability: boolean;
  /** Runtime-authorized concrete path used only if Cognition requests read-text. */
  runtimeAuthorizedPath: string;
  signal?: AbortSignal | undefined;
}>;

/**
 * Execute one current capability-aware Cognition round-trip with at most one
 * concrete read-text capability round.
 *
 * Existing seams retain all authority: 6Y owns current semantic inventory and
 * the initial COMPLETE | REQUEST_CAPABILITY disposition; 5H owns direct
 * COMPLETE correlation; 6AB owns the single read-text execution, normalized
 * observation, one assisted completion, and final 5H correlation.
 *
 * This composition snapshots caller-owned task/admission/path values before the
 * first asynchronous discovery. It accepts only a read-text-only A7.1 registry
 * so the initial provider is never shown a capability this path cannot execute.
 * No second capability opportunity, retry/fallback, round-counter mutation,
 * persistence, Memory/P8 write, Character ABI assembly, or Character invocation
 * is introduced here.
 */
export async function executeServerCurrentReadTextCognitionRoundTrip(
  input: ServerCurrentReadTextCognitionRoundTripInput
): Promise<CharacterHarnessCognitionRoundTrip> {
  const task = createCognitionReasoningTask(input.task);
  const providers = input.providers;
  const mcpClient = input.mcpClient;
  const staticRegistry = input.staticRegistry;
  const capabilityRoundsUsed = input.capabilityRoundsUsed;
  const policyAllowsCapability = input.policyAllowsCapability;
  const runtimeAuthorizedPath = input.runtimeAuthorizedPath;
  const signal = input.signal;

  assertReadTextOnlyRegistry(staticRegistry);

  const initial = await executeServerCurrentCapabilityAwareCognition({
    providers,
    mcpClient,
    staticRegistry,
    task,
    ...(signal === undefined ? {} : { signal })
  });

  if (initial.kind === "COMPLETE") {
    return createCharacterHarnessCognitionRoundTrip({
      request: task.escalation,
      result: initial.result
    });
  }

  return executeServerReadTextAssistedCompletion({
    providers,
    mcpClient,
    staticRegistry,
    task,
    request: initial.request,
    capabilityRoundsUsed,
    policyAllowsCapability,
    runtimeAuthorizedPath,
    ...(signal === undefined ? {} : { signal })
  });
}

function assertReadTextOnlyRegistry(registry: ServerMcpCapabilityBindings): void {
  if (registry.bindings.some((binding) => binding.toolName !== "read_text_file")) {
    throw new Error(
      "Server current read-text Cognition round-trip requires a read_text_file-only capability registry."
    );
  }
}
