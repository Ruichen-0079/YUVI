import { FallbackReasoningProvider } from "../../../packages/providers/src/registry.js";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COGNITION_LIMITS } from "@companion/core";
import {
  ProviderError,
  ProviderErrorCode,
  type ReasoningInput,
  type ReasoningCallOptions
} from "@companion/providers";
import { executeServerCognitionInteraction } from "./cognition-interaction.js";
import {
  createServerMcpCapabilityBindings,
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION
} from "./mcp-capability-binding.js";
import { loadServerConfig } from "./config.js";

const need =
  'REQUEST_CAPABILITY\n{"capabilityRef":"opaque-read","request":"Read admitted evidence."}';
function fixture(answers = ["COMPLETE\ndone"]) {
  const generateReasoning = vi.fn(
    async (_input: ReasoningInput, _options?: ReasoningCallOptions) => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error("Unexpected reasoning call");
      return { reasoning: "", answer, finishReason: "stop" as const };
    }
  );
  const provider = { name: "test", healthCheck: vi.fn(), generateReasoning };
  const listTools = vi.fn(async (_options?: { signal?: AbortSignal }) => [
    { name: "read_text_file", inputSchema: { type: "object" } }
  ]);
  const callTool = vi.fn(async (_call: unknown, _options?: { signal?: AbortSignal }) => ({
    isError: false,
    content: [{ type: "text", text: "observed evidence" }]
  }));
  return {
    generateReasoning,
    provider,
    input: {
      providers: { getReasoningProvider: () => provider },
      task: {
        version: "cognition-6a.v1",
        escalation: { version: "character-harness-5g.v1", kind: "NEED_COGNITION", focus: "verify" },
        problem: "Verify the evidence."
      },
      staticRegistry: createServerMcpCapabilityBindings({
        version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
        capabilities: [
          {
            capabilityRef: "opaque-read",
            description: "Read authorized text.",
            toolName: "read_text_file"
          }
        ]
      }),
      mcpClient: { listTools, callTool },
      runtimeAuthorizedPath: "/authorized/file.txt",
      policyAllowsCapability: true,
      execution: { executionId: "execution-1", isCurrent: () => true },
      limits: { ...DEFAULT_COGNITION_LIMITS }
    }
  };
}

describe("production bounded Cognition composition", () => {
  it("closes two capability rounds plus CONTINUE through the existing 5H seam", async () => {
    const { input, generateReasoning } = fixture([need, "CONTINUE", need, "COMPLETE\nverified"]);
    expect((await executeServerCognitionInteraction(input)).result).toMatchObject({
      status: "SUCCESS",
      answer: "verified"
    });
    expect(input.mcpClient.callTool).toHaveBeenCalledTimes(2);
    const messages = generateReasoning.mock.calls[3]![0].messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "user",
      "assistant",
      "user",
      "assistant",
      "user"
    ]);
    for (const index of [3, 5]) {
      expect(messages[index]!.content).toBe(need);
      expect(messages[index + 1]!.content).toContain("observed evidence");
    }
    expect(generateReasoning).toHaveBeenCalledTimes(4);
    for (const [call, options] of generateReasoning.mock.calls) {
      expect(options).toMatchObject({ allowFallback: false });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(call)).not.toContain("/authorized/file.txt");
    }
    expect(input.mcpClient.callTool.mock.calls[0]![0]).toEqual({
      name: "read_text_file",
      arguments: { path: "/authorized/file.txt" }
    });
    expect(JSON.stringify(generateReasoning.mock.calls[3]![0])).toContain("observed evidence");
  });
  it.each(["transport", "tool", "malformed"])(
    "projects %s failure as ERROR evidence without retry",
    async (failure) => {
      const { input, generateReasoning } = fixture([need, "COMPLETE\nEvidence was unavailable."]);
      if (failure === "transport")
        input.mcpClient.callTool.mockRejectedValue(new Error("private details"));
      if (failure === "tool")
        input.mcpClient.callTool.mockResolvedValue({
          isError: true,
          content: [{ type: "text", text: "private details" }]
        });
      if (failure === "malformed")
        input.mcpClient.callTool.mockResolvedValue({ isError: false, content: [] });
      await executeServerCognitionInteraction(input);
      const continuation = JSON.stringify(generateReasoning.mock.calls[1]![0]);
      expect(continuation).toContain("Status: ERROR");
      const messages = generateReasoning.mock.calls[1]![0].messages;
      expect(messages.at(-2)).toEqual({ role: "assistant", content: need });
      expect(messages.at(-1)!.content).toContain("Status: ERROR");
      expect(continuation).not.toContain("Status: SUCCESS");
      expect(continuation).not.toContain("private details");
      expect(input.mcpClient.callTool).toHaveBeenCalledTimes(1);
    }
  );
  it("normalizes disappearing discovery as UNAVAILABLE and does not call the tool", async () => {
    const { input, generateReasoning } = fixture([need, "COMPLETE\nUnavailable."]);
    input.mcpClient.listTools
      .mockResolvedValueOnce([{ name: "read_text_file", inputSchema: { type: "object" } }])
      .mockResolvedValue([]);
    await executeServerCognitionInteraction(input);
    expect(input.mcpClient.callTool).not.toHaveBeenCalled();
    expect(JSON.stringify(generateReasoning.mock.calls[1]![0])).toContain("Status: UNAVAILABLE");
  });
  it("passes cancellation to the concrete capability and discards its late success", async () => {
    const { input, generateReasoning } = fixture([need, "COMPLETE\nmust not run"]);
    const controller = new AbortController();
    input.mcpClient.callTool.mockImplementation(async (_call, options) => {
      controller.abort();
      expect(options?.signal?.aborted).toBe(true);
      return { isError: false, content: [{ type: "text", text: "late success" }] };
    });
    expect(
      (await executeServerCognitionInteraction({ ...input, signal: controller.signal })).result
        .status
    ).toBe("CANCELLED");
    expect(generateReasoning).toHaveBeenCalledTimes(1);
  });
  it("rejects an invented request without executing a capability", async () => {
    const { input } = fixture([need.replace("opaque-read", "invented")]);
    expect((await executeServerCognitionInteraction(input)).result.status).toBe("ERROR");
    expect(input.mcpClient.callTool).not.toHaveBeenCalled();
  });
  it("does not hide another provider attempt behind one reasoning round", async () => {
    const { input, provider, generateReasoning } = fixture();
    generateReasoning.mockRejectedValue(
      new ProviderError({
        provider: "test",
        capability: "reasoning",
        code: ProviderErrorCode.ProviderUnavailable,
        message: "unavailable",
        retryable: false,
        fallbackEligible: true,
        effectState: "not_started"
      })
    );
    const fallback = {
      name: "fallback",
      healthCheck: vi.fn(),
      generateReasoning: vi.fn(async () => ({ reasoning: "", answer: "COMPLETE\nhidden fallback" }))
    };
    const chain = new FallbackReasoningProvider([provider, fallback]);
    await executeServerCognitionInteraction({
      ...input,
      providers: { getReasoningProvider: () => chain }
    });
    expect(generateReasoning).toHaveBeenCalledTimes(1);
    expect(fallback.generateReasoning).not.toHaveBeenCalled();
    await chain.generateReasoning({ messages: [] });
    expect(fallback.generateReasoning).toHaveBeenCalledTimes(1); // Legacy callers retain existing fallback policy.
  });
  it("loads bounded settings from the existing configuration authority", () => {
    expect(loadServerConfig({}).cognitionInteraction).toEqual(DEFAULT_COGNITION_LIMITS);
    expect(
      loadServerConfig({
        COGNITION_MAX_REASONING_ROUNDS: "3",
        COGNITION_MAX_CAPABILITY_CALLS: "0",
        COGNITION_TIME_BUDGET_MS: "1000"
      }).cognitionInteraction
    ).toEqual({ maxReasoningRounds: 3, maxCapabilityCalls: 0, timeBudgetMs: 1000 });
    for (const env of [
      { COGNITION_MAX_REASONING_ROUNDS: "9" },
      { COGNITION_MAX_CAPABILITY_CALLS: "5" },
      { COGNITION_TIME_BUDGET_MS: "NaN" },
      { COGNITION_MAX_REASONING_ROUNDS: "1.5" }
    ])
      expect(() => loadServerConfig(env)).toThrow("Invalid Cognition limit");
  });
});
