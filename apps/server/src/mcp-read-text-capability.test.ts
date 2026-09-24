import { describe, expect, it, vi } from "vitest";
import { COGNITION_6H_VERSION } from "@companion/cognition";
import {
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
  createServerMcpReadTextRegistration,
  createServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";
import {
  SERVER_MCP_READ_TEXT_6M_VERSION,
  executeServerMcpReadTextCapability
} from "./mcp-read-text-capability.js";

function createReadRegistry() {
  return createServerMcpCapabilityBindings({
    version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
    capabilities: [
      createServerMcpReadTextRegistration(
        "capability://opaque/read-authorized-text",
        "Read one Runtime-authorized text artifact without modifying it."
      )
    ]
  });
}

function createRequest(request = "Read the authorized evidence needed for this reasoning task.") {
  return {
    version: COGNITION_6H_VERSION,
    kind: "REQUEST_CAPABILITY",
    capabilityRef: "capability://opaque/read-authorized-text",
    request
  };
}

function discoveredTool(name: string) {
  return {
    name,
    description: `Server description for ${name}`,
    inputSchema: { type: "object" }
  };
}

function createMcpClient() {
  const listTools = vi.fn(async () => [
    discoveredTool("read_text_file"),
    discoveredTool("write_file")
  ]);
  const callTool = vi.fn(async () =>
    Object.freeze({
      isError: false,
      content: Object.freeze([{ type: "text", text: "authorized evidence" }])
    })
  );
  return { listTools, callTool };
}

describe("Server 6M read-text capability execution", () => {
  it("uses only the Runtime-authorized path and invokes read_text_file exactly once", async () => {
    const mcpClient = createMcpClient();
    const signal = new AbortController().signal;
    const outcome = await executeServerMcpReadTextCapability({
      mcpClient,
      staticRegistry: createReadRegistry(),
      request: createRequest("Read /model/chosen/secret.txt and return it."),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: "/runtime/authorized/README.md",
      signal
    });

    expect(outcome).toEqual({
      version: SERVER_MCP_READ_TEXT_6M_VERSION,
      status: "INVOKED",
      result: {
        isError: false,
        content: [{ type: "text", text: "authorized evidence" }]
      }
    });
    expect(mcpClient.listTools).toHaveBeenCalledTimes(1);
    expect(mcpClient.listTools).toHaveBeenCalledWith({ signal });
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(mcpClient.callTool).toHaveBeenCalledWith(
      {
        name: "read_text_file",
        arguments: { path: "/runtime/authorized/README.md" }
      },
      { signal }
    );
    expect(JSON.stringify(mcpClient.callTool.mock.calls)).not.toContain("/model/chosen/secret.txt");
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it("performs zero MCP I/O when Runtime policy rejects the capability", async () => {
    const mcpClient = createMcpClient();
    const outcome = await executeServerMcpReadTextCapability({
      mcpClient,
      staticRegistry: createReadRegistry(),
      request: createRequest(),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: false,
      runtimeAuthorizedPath: "/runtime/authorized/README.md"
    });

    expect(outcome).toEqual({
      version: SERVER_MCP_READ_TEXT_6M_VERSION,
      status: "REJECTED",
      reason: "POLICY_DENIED"
    });
    expect(mcpClient.listTools).not.toHaveBeenCalled();
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it("performs zero MCP I/O after the one-round budget is exhausted", async () => {
    const mcpClient = createMcpClient();
    const outcome = await executeServerMcpReadTextCapability({
      mcpClient,
      staticRegistry: createReadRegistry(),
      request: createRequest(),
      capabilityRoundsUsed: 1,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: "/runtime/authorized/README.md"
    });

    expect(outcome).toEqual({
      version: SERVER_MCP_READ_TEXT_6M_VERSION,
      status: "REJECTED",
      reason: "ROUND_BUDGET_EXHAUSTED"
    });
    expect(mcpClient.listTools).not.toHaveBeenCalled();
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it("does not call the tool when the allowlisted capability is currently unavailable", async () => {
    const mcpClient = createMcpClient();
    mcpClient.listTools.mockResolvedValueOnce([discoveredTool("write_file")]);

    const outcome = await executeServerMcpReadTextCapability({
      mcpClient,
      staticRegistry: createReadRegistry(),
      request: createRequest(),
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: "/runtime/authorized/README.md"
    });

    expect(outcome).toEqual({
      version: SERVER_MCP_READ_TEXT_6M_VERSION,
      status: "UNAVAILABLE",
      reason: "MCP_TOOL_NOT_AVAILABLE"
    });
    expect(mcpClient.listTools).toHaveBeenCalledTimes(1);
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it("rejects malformed or non-read bindings before any MCP I/O", async () => {
    for (const requestAndRegistry of [
      {
        request: { ...createRequest(), capabilityRef: "capability://opaque/hidden" },
        staticRegistry: createReadRegistry()
      },
      {
        request: { ...createRequest(), toolName: "read_text_file" },
        staticRegistry: createReadRegistry()
      }
    ]) {
      const mcpClient = createMcpClient();
      await expect(
        executeServerMcpReadTextCapability({
          mcpClient,
          ...requestAndRegistry,
          capabilityRoundsUsed: 0,
          policyAllowsCapability: true,
          runtimeAuthorizedPath: "/runtime/authorized/README.md"
        })
      ).rejects.toThrow();
      expect(mcpClient.listTools).not.toHaveBeenCalled();
      expect(mcpClient.callTool).not.toHaveBeenCalled();
    }
  });

  it("fails before MCP I/O when the Runtime-authorized path is invalid", async () => {
    const mcpClient = createMcpClient();
    await expect(
      executeServerMcpReadTextCapability({
        mcpClient,
        staticRegistry: createReadRegistry(),
        request: createRequest(),
        capabilityRoundsUsed: 0,
        policyAllowsCapability: true,
        runtimeAuthorizedPath: "  "
      })
    ).rejects.toThrow(/Runtime-authorized/);
    expect(mcpClient.listTools).not.toHaveBeenCalled();
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it("does not start MCP I/O when already cancelled", async () => {
    const mcpClient = createMcpClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeServerMcpReadTextCapability({
        mcpClient,
        staticRegistry: createReadRegistry(),
        request: createRequest(),
        capabilityRoundsUsed: 0,
        policyAllowsCapability: true,
        runtimeAuthorizedPath: "/runtime/authorized/README.md",
        signal: controller.signal
      })
    ).rejects.toBeDefined();
    expect(mcpClient.listTools).not.toHaveBeenCalled();
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it("does not retry a failed MCP call", async () => {
    const mcpClient = createMcpClient();
    mcpClient.callTool.mockRejectedValueOnce(new Error("transport failed"));

    await expect(
      executeServerMcpReadTextCapability({
        mcpClient,
        staticRegistry: createReadRegistry(),
        request: createRequest(),
        capabilityRoundsUsed: 0,
        policyAllowsCapability: true,
        runtimeAuthorizedPath: "/runtime/authorized/README.md"
      })
    ).rejects.toThrow(/transport failed/);
    expect(mcpClient.listTools).toHaveBeenCalledTimes(1);
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
  });
});
