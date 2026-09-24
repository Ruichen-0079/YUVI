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
      {
        ...createServerMcpReadTextRegistration(
          "capability://opaque/read-authorized-text",
          "Read one Runtime-authorized text artifact without modifying it."
        )
      }
    ]
  });
}

describe("Server 6M read-text MCP result boundary", () => {
  it("preserves an MCP tool-level error as an invoked result without reinterpreting it", async () => {
    const mcpClient = {
      listTools: vi.fn(async () => [
        {
          name: "read_text_file",
          inputSchema: { type: "object" }
        }
      ]),
      callTool: vi.fn(async () =>
        Object.freeze({
          isError: true,
          content: Object.freeze([{ type: "text", text: "permission denied" }])
        })
      )
    };

    const outcome = await executeServerMcpReadTextCapability({
      mcpClient,
      staticRegistry: createReadRegistry(),
      request: {
        version: COGNITION_6H_VERSION,
        kind: "REQUEST_CAPABILITY",
        capabilityRef: "capability://opaque/read-authorized-text",
        request: "Read the currently authorized evidence."
      },
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true,
      runtimeAuthorizedPath: "/runtime/authorized/README.md"
    });

    expect(outcome).toEqual({
      version: SERVER_MCP_READ_TEXT_6M_VERSION,
      status: "INVOKED",
      result: {
        isError: true,
        content: [{ type: "text", text: "permission denied" }]
      }
    });
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
  });
});
