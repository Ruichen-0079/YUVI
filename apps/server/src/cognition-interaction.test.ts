import { FallbackReasoningProvider } from "../../../packages/providers/src/registry.js";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COGNITION_LIMITS } from "@companion/core";
import { assembleCanonicalContext } from "@companion/prompt-builder";
import {
  ProviderError,
  ProviderErrorCode,
  type ReasoningInput,
  type ReasoningCallOptions
} from "@companion/providers";
import { executeServerCognitionInteraction } from "./cognition-interaction.js";
import {
  createServerMcpCapabilityBindings,
  SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
  createServerMcpReadTextRegistration
} from "./mcp-capability-binding.js";
import { loadServerConfig } from "./config.js";
import {
  SERVER_PLUGIN_API_VERSION,
  SERVER_PLUGIN_MANIFEST_VERSION,
  ServerPluginLifecycle,
  type ServerPluginSource
} from "./plugin-lifecycle.js";
import {
  SERVER_PLUGIN_CAPABILITY_GRANT_A72_VERSION,
  createServerPluginCapabilityGrant
} from "./mcp-capability-binding.js";

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
        version: SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
        capabilities: [createServerMcpReadTextRegistration("opaque-read", "Read authorized text.")]
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
  it("routes a host-registered plugin transform only after Runtime admission and drains it before disposal", async () => {
    const capabilityRef = "capability://plugin/fixture/local-transform";
    const grant = createServerPluginCapabilityGrant({
      version: SERVER_PLUGIN_CAPABILITY_GRANT_A72_VERSION,
      pluginId: "org.yuvi.fixture",
      pluginVersion: "1.2.3",
      capabilityRef,
      description: "Apply a host-approved local fixture transformation.",
      implementationRef: "yuvi.plugin.fixture.local-transform.v1"
    });
    const events: string[] = [];
    let releaseCall: (() => void) | undefined;
    let callStarted: (() => void) | undefined;
    let savedRegistration:
      | NonNullable<Parameters<ServerPluginSource["load"]>[0]["capabilityRegistrations"]>[number]
      | undefined;
    const callGate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const callStartedPromise = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    const plugin: ServerPluginSource = {
      manifest: {
        manifestVersion: SERVER_PLUGIN_MANIFEST_VERSION,
        id: "org.yuvi.fixture",
        version: "1.2.3",
        compatibility: { apiVersion: SERVER_PLUGIN_API_VERSION },
        capabilities: ["capability://plugin/self-declared"]
      },
      async load(context) {
        savedRegistration = context.capabilityRegistrations?.[0];
        return {
          start(startContext) {
            startContext.capabilityRegistrations?.[0]?.register(async (request) => {
              events.push("call-start");
              callStarted?.();
              await callGate;
              events.push("call-finish");
              return `transformed ${request}`;
            });
          },
          stop() {
            events.push("stop");
          },
          dispose() {
            events.push("dispose");
          }
        };
      }
    };
    const lifecycle = new ServerPluginLifecycle(() => [plugin], { warn: vi.fn() } as never, 20, [
      grant
    ]);
    await lifecycle.discover();
    await lifecycle.load();
    await lifecycle.start();

    const pluginRequest = `REQUEST_CAPABILITY\n${JSON.stringify({
      capabilityRef,
      request: "uppercase this"
    })}`;
    const denied = fixture([pluginRequest]);
    await executeServerCognitionInteraction({
      ...denied.input,
      staticRegistry: createServerMcpCapabilityBindings({
        version: SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
        capabilities: []
      }),
      mcpClient: {
        listTools: vi.fn(async () => []),
        callTool: vi.fn(async () => ({ isError: false, content: [] }))
      },
      pluginCapabilities: lifecycle.runtimeCapabilities,
      policyAllowsCapability: true,
      limits: { ...DEFAULT_COGNITION_LIMITS, maxCapabilityCalls: 0 }
    });
    expect(events).toEqual([]);

    const active = fixture([pluginRequest, "COMPLETE\nfinished"]);
    const activeClient = {
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ isError: false, content: [] }))
    };
    const interaction = executeServerCognitionInteraction({
      ...active.input,
      staticRegistry: createServerMcpCapabilityBindings({
        version: SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
        capabilities: []
      }),
      mcpClient: activeClient,
      pluginCapabilities: lifecycle.runtimeCapabilities,
      policyAllowsCapability: true
    });
    await callStartedPromise;
    const providerInput = JSON.stringify(active.generateReasoning.mock.calls[0]?.[0]);
    expect(providerInput).toContain(capabilityRef);
    expect(providerInput).toContain("Apply a host-approved local fixture transformation.");
    expect(providerInput).not.toContain(grant.descriptor.implementationRef);
    expect(providerInput).not.toContain("effectContract");
    expect(activeClient.callTool).not.toHaveBeenCalled();

    const shutdown = await lifecycle.shutdown();
    expect(shutdown.phase).toBe("DRAINING");
    expect(shutdown.plugins[0]?.state).toBe("DRAINING");
    expect(lifecycle.runtimeCapabilities.snapshot()).toEqual([]);
    expect(events).toEqual(["call-start"]);
    expect(() => savedRegistration?.register(() => "late registration")).toThrow(/closed/);

    const late = fixture([pluginRequest]);
    await executeServerCognitionInteraction({
      ...late.input,
      staticRegistry: createServerMcpCapabilityBindings({
        version: SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
        capabilities: []
      }),
      mcpClient: {
        listTools: vi.fn(async () => []),
        callTool: vi.fn(async () => ({ isError: false, content: [] }))
      },
      pluginCapabilities: lifecycle.runtimeCapabilities,
      policyAllowsCapability: true
    });
    expect(events).toEqual(["call-start"]);

    releaseCall?.();
    expect((await interaction).result).toMatchObject({ status: "SUCCESS", answer: "finished" });
    await vi.waitFor(() => expect(lifecycle.snapshot().phase).toBe("DISPOSED"));
    expect(events).toEqual(["call-start", "call-finish", "stop", "dispose"]);
    expect(lifecycle.runtimeCapabilities.snapshot()).toEqual([]);
  });

  it("coalesces overlapping shutdown while an admitted plugin call drains", async () => {
    const capabilityRef = "capability://plugin/fixture/concurrent-shutdown";
    const grant = createServerPluginCapabilityGrant({
      version: SERVER_PLUGIN_CAPABILITY_GRANT_A72_VERSION,
      pluginId: "org.yuvi.concurrent",
      pluginVersion: "1.2.3",
      capabilityRef,
      description: "Apply a host-approved local fixture transformation.",
      implementationRef: "yuvi.plugin.concurrent.local-transform.v1"
    });
    const events: string[] = [];
    let finishCall: ((value: string) => void) | undefined;
    let callStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    const plugin: ServerPluginSource = {
      manifest: {
        manifestVersion: SERVER_PLUGIN_MANIFEST_VERSION,
        id: "org.yuvi.concurrent",
        version: "1.2.3",
        compatibility: { apiVersion: SERVER_PLUGIN_API_VERSION }
      },
      async load() {
        return {
          start(context) {
            context.capabilityRegistrations?.[0]?.register(
              () =>
                new Promise<string>((resolve) => {
                  events.push("call-start");
                  finishCall = resolve;
                  callStarted?.();
                })
            );
          },
          stop() {
            events.push("stop");
          },
          dispose() {
            events.push("dispose");
          }
        };
      }
    };
    const lifecycle = new ServerPluginLifecycle(() => [plugin], { warn: vi.fn() } as never, 200, [
      grant
    ]);
    await lifecycle.discover();
    await lifecycle.load();
    await lifecycle.start();

    const active = fixture([
      `REQUEST_CAPABILITY\n${JSON.stringify({ capabilityRef, request: "input" })}`,
      "COMPLETE\nfinished"
    ]);
    const interaction = executeServerCognitionInteraction({
      ...active.input,
      staticRegistry: createServerMcpCapabilityBindings({
        version: SERVER_EXECUTABLE_CAPABILITY_REGISTRY_A71_VERSION,
        capabilities: []
      }),
      mcpClient: {
        listTools: vi.fn(async () => []),
        callTool: vi.fn(async () => ({ isError: false, content: [] }))
      },
      pluginCapabilities: lifecycle.runtimeCapabilities
    });
    await started;

    const shutdowns = Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);
    finishCall?.("completed locally");
    const [first, second] = await shutdowns;
    expect(first.phase).toBe("DISPOSED");
    expect(second.phase).toBe("DISPOSED");
    expect((await interaction).result).toMatchObject({ status: "SUCCESS", answer: "finished" });
    expect(events).toEqual(["call-start", "stop", "dispose"]);
  });

  it("projects Runtime P8 and Memory context without splitting capability evidence", async () => {
    const { input, generateReasoning } = fixture([need, "COMPLETE\nverified"]);
    const canonicalContext = assembleCanonicalContext({
      semanticSections: [
        { kind: "IDENTITY", state: "KNOWN", summary: "P8 user identity" },
        { kind: "PERSONA", state: "KNOWN", summary: "P8 YUVI persona" },
        { kind: "RELATIONSHIP_CONTEXT", state: "UNKNOWN" },
        { kind: "RECENT_CONVERSATION", state: "KNOWN", summary: "Earlier user task" },
        { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "Unverified retrieved claim" }
      ],
      currentInput: "Current user text"
    });
    await executeServerCognitionInteraction({ ...input, canonicalContext });
    const first = generateReasoning.mock.calls[0]![0].messages;
    const second = generateReasoning.mock.calls[1]![0].messages;
    expect(first[0]!.content).toContain("P8 user identity");
    expect(first[0]!.content).toContain("Unverified retrieved claim");
    expect(first[1]!.content).toBe("Verify the evidence.");
    expect(JSON.stringify(first)).not.toContain("read_text_file");
    expect(JSON.stringify(first)).not.toContain("implementationRef");
    expect(JSON.stringify(first)).not.toContain("effectContract");
    expect(JSON.stringify(first)).not.toContain("RUNTIME_AUTHORIZED_PATH_READ");
    expect(second.slice(0, -2)).toEqual(first);
    expect(second.at(-2)).toEqual({ role: "assistant", content: need });
    expect(second.at(-1)!.content).toContain("observed evidence");
    expect(JSON.stringify(second)).not.toContain("Current user text");
  });
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
  it("keeps Runtime policy admission ahead of the registered implementation call", async () => {
    const { input, generateReasoning } = fixture([need, "COMPLETE\nunreachable"]);
    input.policyAllowsCapability = false;

    const output = await executeServerCognitionInteraction(input);

    expect(output.result.status).toBe("ERROR");
    expect(generateReasoning).toHaveBeenCalledTimes(1);
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
