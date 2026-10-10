import { describe, expect, it } from "vitest";
import {
  COGNITION_6N_VERSION,
  createCognitionCapabilityObservation
} from "./capability-observation.js";

describe("Cognition 6N capability observation", () => {
  it("accepts and freezes a bounded successful semantic observation", () => {
    const observation = createCognitionCapabilityObservation({
      version: COGNITION_6N_VERSION,
      capabilityRef: "capability://opaque/read-authorized-text",
      status: "SUCCESS",
      content: "Verified text from the admitted read-only capability."
    });

    expect(observation).toEqual({
      version: COGNITION_6N_VERSION,
      capabilityRef: "capability://opaque/read-authorized-text",
      status: "SUCCESS",
      content: "Verified text from the admitted read-only capability."
    });
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it("accepts failure observations without fabricating content", () => {
    for (const status of ["UNAVAILABLE", "ERROR"] as const) {
      expect(
        createCognitionCapabilityObservation({
          version: COGNITION_6N_VERSION,
          capabilityRef: "capability://opaque/read-authorized-text",
          status
        })
      ).toEqual({
        version: COGNITION_6N_VERSION,
        capabilityRef: "capability://opaque/read-authorized-text",
        status
      });
    }
  });

  it("requires content only for successful observations", () => {
    expect(() =>
      createCognitionCapabilityObservation({
        version: COGNITION_6N_VERSION,
        capabilityRef: "capability://opaque/read-authorized-text",
        status: "SUCCESS"
      })
    ).toThrow(/requires textual content/);

    expect(() =>
      createCognitionCapabilityObservation({
        version: COGNITION_6N_VERSION,
        capabilityRef: "capability://opaque/read-authorized-text",
        status: "ERROR",
        content: "raw tool error"
      })
    ).toThrow(/must not carry content/);
  });

  it("reuses 6G capabilityRef validation", () => {
    expect(() =>
      createCognitionCapabilityObservation({
        version: COGNITION_6N_VERSION,
        capabilityRef: "x".repeat(201),
        status: "UNAVAILABLE"
      })
    ).toThrow(/200/);
  });

  it("rejects concrete capability implementation metadata", () => {
    for (const extra of [
      { toolName: "read_text_file" },
      { serverName: "filesystem" },
      { protocol: "mcp" },
      { path: "/secret" },
      { arguments: { path: "/secret" } },
      { provider: "filesystem" }
    ]) {
      expect(() =>
        createCognitionCapabilityObservation({
          version: COGNITION_6N_VERSION,
          capabilityRef: "capability://opaque/read-authorized-text",
          status: "UNAVAILABLE",
          ...extra
        })
      ).toThrow(/unknown field/);
    }
  });

  it("fails closed on invalid status, version, or oversized content", () => {
    expect(() =>
      createCognitionCapabilityObservation({
        version: "future",
        capabilityRef: "capability://opaque/read-authorized-text",
        status: "UNAVAILABLE"
      })
    ).toThrow(/version/);

    expect(() =>
      createCognitionCapabilityObservation({
        version: COGNITION_6N_VERSION,
        capabilityRef: "capability://opaque/read-authorized-text",
        status: "RETRY"
      })
    ).toThrow(/status/);

    expect(() =>
      createCognitionCapabilityObservation({
        version: COGNITION_6N_VERSION,
        capabilityRef: "capability://opaque/read-authorized-text",
        status: "SUCCESS",
        content: "x".repeat(16_001)
      })
    ).toThrow(/16000/);
  });
});
