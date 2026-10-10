import { describe, expect, it } from "vitest";
import { COGNITION_6H_VERSION } from "@companion/cognition";
import { createCognitionCapabilityObservation } from "@companion/cognition/capability-observation";
import { createServerMcpReadTextObservation } from "./mcp-read-text-observation.js";
import {
  createServerMcpCapabilityBindings,
  createServerMcpReadTextRegistration,
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION
} from "./mcp-capability-binding.js";
import { SERVER_MCP_READ_TEXT_6M_VERSION } from "./mcp-read-text-capability.js";
const seed = 0x0d894cc;
describe("read observation capacity properties", () => {
  it(`preserves prefixes, Unicode and explicit coverage across 64 cases; seed=${seed}`, () => {
    let state = seed;
    const cap = "capability://opaque/property-evidence";
    const registry = createServerMcpCapabilityBindings({
      version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
      capabilities: [createServerMcpReadTextRegistration(cap, "Read an authorized artifact")]
    });
    for (let i = 0; i < 64; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const count = 15996 + (state % 9),
        unit = ["x", "语", "😀", "é"][state % 4]!;
      const content = unit.repeat(count) + "END";
      const observation = createServerMcpReadTextObservation({
        staticRegistry: registry,
        request: {
          version: COGNITION_6H_VERSION,
          kind: "REQUEST_CAPABILITY",
          capabilityRef: cap,
          request: "Inspect"
        },
        outcome: {
          version: SERVER_MCP_READ_TEXT_6M_VERSION,
          status: "INVOKED",
          result: { isError: false, content: [{ type: "text", text: content }] }
        }
      }).observation;
      try {
        expect(observation.status).toBe("SUCCESS");
        expect(observation.content!.length).toBeLessThanOrEqual(16000);
        expect(content.startsWith(observation.content!)).toBe(true);
        expect(observation.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
        if (content.length > 16000) {
          expect(observation.coverage).toMatchObject({
            kind: "PREFIX",
            unit: "UTF16_CODE_UNITS",
            originalCharacters: content.length,
            providedCharacters: observation.content!.length
          });
        } else expect(observation.coverage).toBeUndefined();
        createCognitionCapabilityObservation(observation);
      } catch (error) {
        throw new Error(
          `seed=${seed}; case=${i}; count=${count}; unit=${JSON.stringify(unit)}; ${String(error)}`
        );
      }
    }
  });
  it("rejects false coverage and coverage on errors instead of trusting descriptive labels", () => {
    for (const coverage of [
      { kind: "PREFIX", unit: "BYTES", originalCharacters: 9, providedCharacters: 1 },
      { kind: "PREFIX", unit: "UTF16_CODE_UNITS", originalCharacters: 1, providedCharacters: 1 },
      { kind: "PREFIX", unit: "UTF16_CODE_UNITS", originalCharacters: 9, providedCharacters: 3 }
    ]) {
      expect(() =>
        createCognitionCapabilityObservation({
          version: "cognition-6n.v1",
          capabilityRef: "capability://opaque/property-evidence",
          status: "SUCCESS",
          content: "x",
          coverage
        })
      ).toThrow();
    }
  });
});
