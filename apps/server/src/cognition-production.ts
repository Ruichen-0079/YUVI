import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { COGNITION_6A_VERSION } from "@companion/cognition";
import type { CharacterHarnessCognitionRequest } from "@companion/character-harness/cognition-request";
import type { ProviderResolver } from "@companion/providers";
import { executeServerCognitionInteraction } from "./cognition-interaction.js";
import type { RuntimeCognitionExecution, RuntimeCognitionLimits } from "@companion/core";
import {
  createServerMcpCapabilityBindings,
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION
} from "./mcp-capability-binding.js";

/** Concrete local adapter for the existing allowlisted read_text_file seam. */
export function executeProductionCognition(input: {
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  request: CharacterHarnessCognitionRequest;
  problem: string;
  runtimeAuthorizedPath?: string | undefined;
  signal?: AbortSignal | undefined;
  execution: RuntimeCognitionExecution;
  limits: RuntimeCognitionLimits;
}) {
  const path = input.runtimeAuthorizedPath;
  const staticRegistry = createServerMcpCapabilityBindings({
    version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
    capabilities: path
      ? [
          {
            capabilityRef: "capability://opaque/read-authorized-text",
            description:
              "Read the single text file explicitly authorized by the local controller for this turn.",
            toolName: "read_text_file"
          }
        ]
      : []
  });
  return executeServerCognitionInteraction({
    providers: input.providers,
    task: { version: COGNITION_6A_VERSION, escalation: input.request, problem: input.problem },
    staticRegistry,
    execution: input.execution,
    limits: input.limits,
    policyAllowsCapability: Boolean(path),
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
        const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 64_000)
            throw new Error("Authorized text must be a regular file of at most 64000 bytes");
          const bytes = Buffer.alloc(64_001);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          options?.signal?.throwIfAborted();
          if (bytesRead > 64_000) throw new Error("Authorized text exceeds limit");
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))
              }
            ]
          };
        } finally {
          await file.close();
        }
      }
    }
  });
}
