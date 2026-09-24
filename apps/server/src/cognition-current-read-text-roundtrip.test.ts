import { describe, expect, it, vi } from "vitest";
import { COGNITION_6A_VERSION } from "@companion/cognition";
import type { ReasoningInput, ReasoningOutput } from "@companion/providers";
import { executeServerCurrentReadTextCognitionRoundTrip } from "./cognition-current-read-text-roundtrip.js";
import {
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
  createServerMcpReadTextRegistration,
  createServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";

const CAPABILITY_REF = "capability://opaque/read-authorized-text";
const AUTHORIZED_PATH = "/runtime/authorized/evidence.txt";
const STATIC_DESCRIPTION = "Read one Runtime-authorized text artifact without modifying it.";

function reasoningTask() {
  return {
    version: COGNITION_6A_VERSION,
    escalation: {
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "verify the claim"
    },
    problem: "Determine whether the claim is supported by the authorized evidence."
  };
}

function staticRegistry() {
  return createServerMcpCapabilityBindings({
    version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
    capabilities: [createServerMcpReadTextRegistration(CAPABILITY_REF, STATIC_DESCRIPTION)]
  });
}

function discoveredTool(name: string) {
  return {
    name,
    description: `server description for ${name}`,
    inputSchema: { type: "object", properties: { path: { type: "string" } } }
  };
}

function mcpClient() {
  const listTools = vi.fn(async () => [discoveredTool("read_text_file")]);
  const callTool = vi.fn(async () => ({
    isError: false,
    content: [{ type: "text", text: "The authorized evidence supports the claim." }]
  }));
  return { listTools, callTool };
}

function providersWithOutputs(...outputs: ReasoningOutput[]) {
  let index = 0;
  const generateReasoning = vi.fn(async (_input: ReasoningInput, _options?: unknown) => {
    const output = outputs[index];
    index += 1;
    if (output === undefined) {
      throw new Error("Unexpected extra reasoning call.");
    }
    return output;
  });
  const getReasoningProvider = vi.fn(() => ({
    name: "current-read-text-test",
    healthCheck: vi.fn(),
    generateReasoning
  }));
  return { providers: { getReasoningProvider }, getReasoningProvider, generateReasoning };
}

function capabilityRequestOutput(): ReasoningOutput {
  return {
    reasoning: "",
    answer: [
      "REQUEST_CAPABILITY",
      JSON.stringify({
        capabilityRef: CAPABILITY_REF,
        request: "Read the currently authorized evidence needed to verify the claim."
      })
    ].join("\n"),
    finishReason: "stop"
  };
}

describe("Server 6AC current read-text Cognition round-trip", () => {
  it("closes an initial COMPLETE disposition directly through 5H without capability execution", async () => {
    const mcp = mcpClient();
    const { providers, generateReasoning } = providersWithOutputs({
      reasoning: "",
      answer: "COMPLETE\nThe claim can be answered without reading the artifact.",
      finishReason: "stop"
    });

    const roundTrip = await executeServerCurrentReadTextCognitionRoundTrip({
      providers,
      mcpClient: mcp,
      staticRegistry: staticRegistry(),
      task: reasoningTask(),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: AUTHORIZED_PATH
    });

    expect(roundTrip).toEqual({
      version: "character-harness-5h.v1",
      request: {
        version: "character-harness-5g.v1",
        kind: "NEED_COGNITION",
        focus: "verify the claim"
      },
      result: {
        version: "character-cognition-result.v1",
        status: "SUCCESS",
        answer: "The claim can be answered without reading the artifact."
      }
    });
    expect(mcp.listTools).toHaveBeenCalledTimes(1);
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(generateReasoning).toHaveBeenCalledTimes(1);
  });

  it("executes at most one requested read and one assisted completion before closing to 5H", async () => {
    const mcp = mcpClient();
    const { providers, generateReasoning } = providersWithOutputs(
      capabilityRequestOutput(),
      {
        reasoning: "",
        answer: "The claim is supported.",
        finishReason: "stop"
      }
    );
    const signal = new AbortController().signal;

    const roundTrip = await executeServerCurrentReadTextCognitionRoundTrip({
      providers,
      mcpClient: mcp,
      staticRegistry: staticRegistry(),
      task: reasoningTask(),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: AUTHORIZED_PATH,
      signal
    });

    expect(roundTrip.result).toEqual({
      version: "character-cognition-result.v1",
      status: "SUCCESS",
      answer: "The claim is supported."
    });
    expect(mcp.listTools).toHaveBeenCalledTimes(2);
    expect(mcp.listTools).toHaveBeenNthCalledWith(1, { signal });
    expect(mcp.listTools).toHaveBeenNthCalledWith(2, { signal });
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    expect(mcp.callTool).toHaveBeenCalledWith(
      {
        name: "read_text_file",
        arguments: { path: AUTHORIZED_PATH }
      },
      { signal }
    );
    expect(generateReasoning).toHaveBeenCalledTimes(2);

    const initialInput = JSON.stringify(generateReasoning.mock.calls[0]?.[0]);
    expect(initialInput).toContain(CAPABILITY_REF);
    expect(initialInput).toContain(STATIC_DESCRIPTION);
    expect(initialInput).not.toContain("read_text_file");
    expect(initialInput).not.toContain(AUTHORIZED_PATH);

    const assistedInput = JSON.stringify(generateReasoning.mock.calls[1]?.[0]);
    expect(assistedInput).toContain("Runtime-admitted capability observation");
    expect(assistedInput).toContain("The authorized evidence supports the claim.");
    expect(assistedInput).not.toContain(CAPABILITY_REF);
    expect(assistedInput).not.toContain("read_text_file");
    expect(assistedInput).not.toContain(AUTHORIZED_PATH);
    expect(assistedInput).not.toContain("REQUEST_CAPABILITY");
  });

  it("keeps Runtime policy rejection at zero capability MCP I/O and still performs only one assisted completion", async () => {
    const mcp = mcpClient();
    const { providers, generateReasoning } = providersWithOutputs(
      capabilityRequestOutput(),
      {
        reasoning: "",
        answer: "The evidence is unavailable, so the claim remains unverified.",
        finishReason: "stop"
      }
    );

    const roundTrip = await executeServerCurrentReadTextCognitionRoundTrip({
      providers,
      mcpClient: mcp,
      staticRegistry: staticRegistry(),
      task: reasoningTask(),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: false,
      runtimeAuthorizedPath: AUTHORIZED_PATH
    });

    expect(mcp.listTools).toHaveBeenCalledTimes(1);
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(generateReasoning).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(generateReasoning.mock.calls[1]?.[0])).toContain("Status: UNAVAILABLE");
    expect(roundTrip.result.status).toBe("SUCCESS");
  });

  it("returns canonical 5H cancellation with zero MCP/provider I/O when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const mcp = mcpClient();
    const { providers, getReasoningProvider, generateReasoning } = providersWithOutputs({
      reasoning: "",
      answer: "COMPLETE\nunused",
      finishReason: "stop"
    });

    const roundTrip = await executeServerCurrentReadTextCognitionRoundTrip({
      providers,
      mcpClient: mcp,
      staticRegistry: staticRegistry(),
      task: reasoningTask(),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: AUTHORIZED_PATH,
      signal: controller.signal
    });

    expect(roundTrip).toEqual({
      version: "character-harness-5h.v1",
      request: {
        version: "character-harness-5g.v1",
        kind: "NEED_COGNITION",
        focus: "verify the claim"
      },
      result: {
        version: "character-cognition-result.v1",
        status: "CANCELLED"
      }
    });
    expect(mcp.listTools).not.toHaveBeenCalled();
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(getReasoningProvider).not.toHaveBeenCalled();
    expect(generateReasoning).not.toHaveBeenCalled();
  });

  it("snapshots task, admission, path, and signal inputs before initial asynchronous discovery", async () => {
    const task = reasoningTask();
    const originalSignal = new AbortController().signal;
    const replacementSignal = new AbortController().signal;
    const mcp = mcpClient();
    const input = {
      providers: undefined as never,
      mcpClient: mcp,
      staticRegistry: staticRegistry(),
      task,
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: AUTHORIZED_PATH,
      signal: originalSignal
    };
    mcp.listTools.mockImplementation(async () => {
      if (mcp.listTools.mock.calls.length === 1) {
        task.problem = "MUTATED PROBLEM";
        task.escalation.focus = "MUTATED FOCUS";
        input.capabilityRoundsUsed = 1;
        input.policyAllowsCapability = false;
        input.runtimeAuthorizedPath = "/runtime/mutated.txt";
        input.signal = replacementSignal;
      }
      return [discoveredTool("read_text_file")];
    });
    const { providers, generateReasoning } = providersWithOutputs(
      capabilityRequestOutput(),
      {
        reasoning: "",
        answer: "stable answer",
        finishReason: "stop"
      }
    );
    input.providers = providers as never;

    const roundTrip = await executeServerCurrentReadTextCognitionRoundTrip(input);

    expect(roundTrip.request.focus).toBe("verify the claim");
    expect(mcp.callTool).toHaveBeenCalledWith(
      {
        name: "read_text_file",
        arguments: { path: AUTHORIZED_PATH }
      },
      { signal: originalSignal }
    );
    const assistedInput = JSON.stringify(generateReasoning.mock.calls[1]?.[0]);
    expect(assistedInput).toContain(
      "Determine whether the claim is supported by the authorized evidence."
    );
    for (const forbidden of ["MUTATED PROBLEM", "MUTATED FOCUS", "/runtime/mutated.txt"]) {
      expect(assistedInput).not.toContain(forbidden);
      expect(JSON.stringify(mcp.callTool.mock.calls)).not.toContain(forbidden);
    }
  });

  it("rejects a registry containing a non-read capability before MCP or provider I/O", async () => {
    const mcp = mcpClient();
    expect(() =>
      createServerMcpCapabilityBindings({
        version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
        capabilities: [
          {
            descriptorVersion: "server-mcp-capability-descriptor-a7.1.v1",
            capabilityRef: CAPABILITY_REF,
            description: STATIC_DESCRIPTION,
            implementationRef: "yuvi.server.mcp.write_file.v1"
          }
        ]
      })
    ).toThrow(/unknown executable implementation/);

    expect(mcp.listTools).not.toHaveBeenCalled();
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it("propagates capability transport failure without assisted continuation or retry", async () => {
    const mcp = mcpClient();
    mcp.callTool.mockRejectedValueOnce(new Error("transport failed"));
    const { providers, generateReasoning } = providersWithOutputs(
      capabilityRequestOutput(),
      {
        reasoning: "",
        answer: "must not run",
        finishReason: "stop"
      }
    );

    await expect(
      executeServerCurrentReadTextCognitionRoundTrip({
        providers,
        mcpClient: mcp,
        staticRegistry: staticRegistry(),
        task: reasoningTask(),
        capabilityRoundsUsed: 0,
        policyAllowsCapability: true,
        runtimeAuthorizedPath: AUTHORIZED_PATH
      })
    ).rejects.toThrow(/transport failed/);

    expect(mcp.listTools).toHaveBeenCalledTimes(2);
    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    expect(generateReasoning).toHaveBeenCalledTimes(1);
  });

  it("stops at the 5H boundary without Character re-entry, Memory, or round-state mutation", async () => {
    const mcp = mcpClient();
    const { providers } = providersWithOutputs({
      reasoning: "",
      answer: "COMPLETE\ndone",
      finishReason: "stop"
    });

    const roundTrip = await executeServerCurrentReadTextCognitionRoundTrip({
      providers,
      mcpClient: mcp,
      staticRegistry: staticRegistry(),
      task: reasoningTask(),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: AUTHORIZED_PATH
    });
    const serialized = JSON.stringify(roundTrip);

    expect(Object.keys(roundTrip)).toEqual(["version", "request", "result"]);
    expect(serialized).not.toContain("CHARACTER_GENERATION");
    expect(serialized).not.toContain("abiVersion");
    expect(serialized).not.toContain("MEMORY");
    expect(serialized).not.toContain("capabilityRoundsUsed");
    expect(serialized).not.toContain("runtimeAuthorizedPath");
  });
});
