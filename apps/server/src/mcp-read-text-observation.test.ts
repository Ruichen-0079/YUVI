import { describe, expect, it } from "vitest";
import { COGNITION_6H_VERSION } from "@companion/cognition";
import {
  COGNITION_6N_VERSION
} from "@companion/cognition/capability-observation";
import {
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
  createServerMcpReadTextRegistration,
  createServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";
import { SERVER_MCP_READ_TEXT_6M_VERSION } from "./mcp-read-text-capability.js";
import {
  SERVER_MCP_READ_TEXT_OBSERVATION_6O_VERSION,
  createServerMcpReadTextObservation
} from "./mcp-read-text-observation.js";

function createRegistry() {
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

function createRequest(capabilityRef = "capability://opaque/read-authorized-text") {
  return {
    version: COGNITION_6H_VERSION,
    kind: "REQUEST_CAPABILITY",
    capabilityRef,
    request: "Read the authorized evidence."
  };
}

describe("Server 6O read-text observation adapter", () => {
  it("projects successful MCP text blocks into one bounded 6N observation", () => {
    const result = createServerMcpReadTextObservation({
      staticRegistry: createRegistry(),
      request: createRequest(),
      outcome: {
        version: SERVER_MCP_READ_TEXT_6M_VERSION,
        status: "INVOKED",
        result: {
          isError: false,
          content: [
            { type: "text", text: "first fact", annotations: { audience: ["assistant"] } },
            { type: "text", text: "second fact" }
          ],
          structuredContent: { ignored: true }
        }
      }
    });

    expect(result).toEqual({
      version: SERVER_MCP_READ_TEXT_OBSERVATION_6O_VERSION,
      observation: {
        version: COGNITION_6N_VERSION,
        capabilityRef: "capability://opaque/read-authorized-text",
        status: "SUCCESS",
        content: "first fact\nsecond fact"
      }
    });
    expect(JSON.stringify(result)).not.toContain("read_text_file");
    expect(JSON.stringify(result)).not.toContain("structuredContent");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observation)).toBe(true);
  });

  it("maps Runtime rejection and current-tool unavailability to generic UNAVAILABLE", () => {
    for (const outcome of [
      {
        version: SERVER_MCP_READ_TEXT_6M_VERSION,
        status: "REJECTED" as const,
        reason: "POLICY_DENIED" as const
      },
      {
        version: SERVER_MCP_READ_TEXT_6M_VERSION,
        status: "REJECTED" as const,
        reason: "ROUND_BUDGET_EXHAUSTED" as const
      },
      {
        version: SERVER_MCP_READ_TEXT_6M_VERSION,
        status: "UNAVAILABLE" as const,
        reason: "MCP_TOOL_NOT_AVAILABLE" as const
      }
    ]) {
      const result = createServerMcpReadTextObservation({
        staticRegistry: createRegistry(),
        request: createRequest(),
        outcome
      });

      expect(result.observation).toEqual({
        version: COGNITION_6N_VERSION,
        capabilityRef: "capability://opaque/read-authorized-text",
        status: "UNAVAILABLE"
      });
      expect(JSON.stringify(result)).not.toContain("POLICY_DENIED");
      expect(JSON.stringify(result)).not.toContain("ROUND_BUDGET_EXHAUSTED");
      expect(JSON.stringify(result)).not.toContain("MCP_TOOL_NOT_AVAILABLE");
    }
  });

  it("maps MCP tool errors to generic ERROR without leaking tool error text", () => {
    const result = createServerMcpReadTextObservation({
      staticRegistry: createRegistry(),
      request: createRequest(),
      outcome: {
        version: SERVER_MCP_READ_TEXT_6M_VERSION,
        status: "INVOKED",
        result: {
          isError: true,
          content: [{ type: "text", text: "permission denied: /private/path" }]
        }
      }
    });

    expect(result.observation).toEqual({
      version: COGNITION_6N_VERSION,
      capabilityRef: "capability://opaque/read-authorized-text",
      status: "ERROR"
    });
    expect(JSON.stringify(result)).not.toContain("permission denied");
    expect(JSON.stringify(result)).not.toContain("/private/path");
  });

  it("fails closed to ERROR for non-text, empty, or oversized successful payloads", () => {
    const outcomes = [
      {
        isError: false,
        content: [{ type: "image", data: "abc" }]
      },
      {
        isError: false,
        content: [{ type: "text", text: "   " }]
      },
      {
        isError: false,
        content: [{ type: "text", text: "x".repeat(16_001) }]
      }
    ];

    for (const toolResult of outcomes) {
      const result = createServerMcpReadTextObservation({
        staticRegistry: createRegistry(),
        request: createRequest(),
        outcome: {
          version: SERVER_MCP_READ_TEXT_6M_VERSION,
          status: "INVOKED",
          result: toolResult
        }
      });
      expect(result.observation.status).toBe("ERROR");
      expect("content" in result.observation).toBe(false);
    }
  });

  it("revalidates the request and explicit read_text_file binding before projection", () => {
    expect(() =>
      createServerMcpReadTextObservation({
        staticRegistry: createRegistry(),
        request: createRequest("capability://opaque/hidden"),
        outcome: {
          version: SERVER_MCP_READ_TEXT_6M_VERSION,
          status: "UNAVAILABLE",
          reason: "MCP_TOOL_NOT_AVAILABLE"
        }
      })
    ).toThrow(/current capability inventory/);

    expect(() =>
      createServerMcpReadTextObservation({
        staticRegistry: { ...createRegistry() },
        request: createRequest(),
        outcome: {
          version: SERVER_MCP_READ_TEXT_6M_VERSION,
          status: "UNAVAILABLE",
          reason: "MCP_TOOL_NOT_AVAILABLE"
        }
      })
    ).toThrow(/host registry validator/);
  });
});
