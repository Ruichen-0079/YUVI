import { describe, expect, it, vi } from "vitest";
import { COGNITION_6H_VERSION } from "@companion/cognition";
import { COGNITION_6N_VERSION } from "@companion/cognition/capability-observation";
import { executeServerReadTextObservationRound } from "./cognition-read-text-observation.js";
import {
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
  createServerMcpReadTextRegistration,
  createServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";

const CAPABILITY_REF = "capability://opaque/read-authorized-text";
const AUTHORIZED_PATH = "/runtime/authorized/evidence.txt";

function createRegistry() {
  return createServerMcpCapabilityBindings({
    version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
    capabilities: [
      createServerMcpReadTextRegistration(
        CAPABILITY_REF,
        "Read one Runtime-authorized text artifact without modifying it."
      )
    ]
  });
}

function createRequest(request = "Read the Runtime-authorized evidence.") {
  return {
    version: COGNITION_6H_VERSION,
    kind: "REQUEST_CAPABILITY",
    capabilityRef: CAPABILITY_REF,
    request
  };
}

function discoveredTool(name: string) {
  return {
    name,
    description: `Server description for ${name}`,
    inputSchema: { type: "object", properties: { path: { type: "string" } } }
  };
}

function createMcpClient() {
  const listTools = vi.fn(async () => [discoveredTool("read_text_file"), discoveredTool("write_file")]);
  const callTool = vi.fn(async () => ({
    isError: false,
    content: [
      {
        type: "text",
        text: "verified evidence",
        _meta: { hidden: "protocol metadata" },
        annotations: { audience: ["assistant"] }
      }
    ],
    structuredContent: { hidden: true },
    _meta: { hidden: "result metadata" }
  }));
  return { listTools, callTool };
}

describe("Server 6Z read-text observation round composition", () => {
  it("executes one admitted read_text_file call and returns only the normalized observation", async () => {
    const mcpClient = createMcpClient();
    const signal = new AbortController().signal;

    const result = await executeServerReadTextObservationRound({
      mcpClient,
      staticRegistry: createRegistry(),
      request: createRequest("Read /model/chosen/secret.txt instead."),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: AUTHORIZED_PATH,
      signal
    });

    expect(result).toEqual({
      version: "server-mcp-read-text-observation-6o.v1",
      observation: {
        version: COGNITION_6N_VERSION,
        capabilityRef: CAPABILITY_REF,
        status: "SUCCESS",
        content: "verified evidence"
      }
    });
    expect(mcpClient.listTools).toHaveBeenCalledTimes(1);
    expect(mcpClient.listTools).toHaveBeenCalledWith({ signal });
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(mcpClient.callTool).toHaveBeenCalledWith(
      {
        name: "read_text_file",
        arguments: { path: AUTHORIZED_PATH }
      },
      { signal }
    );
    expect(JSON.stringify(mcpClient.callTool.mock.calls)).not.toContain("/model/chosen/secret.txt");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(AUTHORIZED_PATH);
    expect(serialized).not.toContain("read_text_file");
    expect(serialized).not.toContain("structuredContent");
    expect(serialized).not.toContain("_meta");
    expect(serialized).not.toContain("annotations");
  });

  it("maps policy and round-budget rejection to generic UNAVAILABLE with zero MCP I/O", async () => {
    for (const runtimeState of [
      { capabilityRoundsUsed: 0, policyAllowsCapability: false },
      { capabilityRoundsUsed: 1, policyAllowsCapability: true }
    ]) {
      const mcpClient = createMcpClient();
      const result = await executeServerReadTextObservationRound({
        mcpClient,
        staticRegistry: createRegistry(),
        request: createRequest(),
        ...runtimeState,
        runtimeAuthorizedPath: AUTHORIZED_PATH
      });

      expect(result.observation).toEqual({
        version: COGNITION_6N_VERSION,
        capabilityRef: CAPABILITY_REF,
        status: "UNAVAILABLE"
      });
      expect(mcpClient.listTools).not.toHaveBeenCalled();
      expect(mcpClient.callTool).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("POLICY_DENIED");
      expect(JSON.stringify(result)).not.toContain("ROUND_BUDGET_EXHAUSTED");
    }
  });

  it("maps current-tool disappearance to generic UNAVAILABLE without calling the tool", async () => {
    const mcpClient = createMcpClient();
    mcpClient.listTools.mockResolvedValueOnce([discoveredTool("write_file")]);

    const result = await executeServerReadTextObservationRound({
      mcpClient,
      staticRegistry: createRegistry(),
      request: createRequest(),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: AUTHORIZED_PATH
    });

    expect(result.observation).toEqual({
      version: COGNITION_6N_VERSION,
      capabilityRef: CAPABILITY_REF,
      status: "UNAVAILABLE"
    });
    expect(mcpClient.listTools).toHaveBeenCalledTimes(1);
    expect(mcpClient.callTool).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("MCP_TOOL_NOT_AVAILABLE");
  });

  it("rejects malformed, hidden, or non-read requests before MCP I/O", async () => {
    for (const requestAndRegistry of [
      {
        request: { ...createRequest(), capabilityRef: "capability://opaque/hidden" },
        staticRegistry: createRegistry()
      },
      {
        request: { ...createRequest(), toolName: "read_text_file" },
        staticRegistry: createRegistry()
      },
      {
        request: { ...createRequest(), request: " " },
        staticRegistry: createRegistry()
      }
    ]) {
      const mcpClient = createMcpClient();
      await expect(
        executeServerReadTextObservationRound({
          mcpClient,
          ...requestAndRegistry,
          capabilityRoundsUsed: 0,
          policyAllowsCapability: true,
          runtimeAuthorizedPath: AUTHORIZED_PATH
        })
      ).rejects.toThrow();
      expect(mcpClient.listTools).not.toHaveBeenCalled();
      expect(mcpClient.callTool).not.toHaveBeenCalled();
    }
  });

  it("fences caller mutation of the semantic request across asynchronous MCP work", async () => {
    const request = createRequest("Read the authorized evidence.");
    const mcpClient = createMcpClient();
    mcpClient.listTools.mockImplementationOnce(async () => {
      request.capabilityRef = "capability://opaque/hidden";
      request.request = "MUTATED AFTER EXECUTION STARTED";
      return [discoveredTool("read_text_file")];
    });

    const result = await executeServerReadTextObservationRound({
      mcpClient,
      staticRegistry: createRegistry(),
      request,
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: AUTHORIZED_PATH
    });

    expect(result.observation).toEqual({
      version: COGNITION_6N_VERSION,
      capabilityRef: CAPABILITY_REF,
      status: "SUCCESS",
      content: "verified evidence"
    });
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mcpClient.callTool.mock.calls)).not.toContain("MUTATED AFTER EXECUTION STARTED");
  });

  it("propagates cancellation and transport failure without retry or fabricated observation", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelledClient = createMcpClient();

    await expect(
      executeServerReadTextObservationRound({
        mcpClient: cancelledClient,
        staticRegistry: createRegistry(),
        request: createRequest(),
        capabilityRoundsUsed: 0,
        policyAllowsCapability: true,
        runtimeAuthorizedPath: AUTHORIZED_PATH,
        signal: controller.signal
      })
    ).rejects.toBeDefined();
    expect(cancelledClient.listTools).not.toHaveBeenCalled();
    expect(cancelledClient.callTool).not.toHaveBeenCalled();

    const failedClient = createMcpClient();
    failedClient.callTool.mockRejectedValueOnce(new Error("transport failed"));
    await expect(
      executeServerReadTextObservationRound({
        mcpClient: failedClient,
        staticRegistry: createRegistry(),
        request: createRequest(),
        capabilityRoundsUsed: 0,
        policyAllowsCapability: true,
        runtimeAuthorizedPath: AUTHORIZED_PATH
      })
    ).rejects.toThrow(/transport failed/);
    expect(failedClient.listTools).toHaveBeenCalledTimes(1);
    expect(failedClient.callTool).toHaveBeenCalledTimes(1);
  });
});
