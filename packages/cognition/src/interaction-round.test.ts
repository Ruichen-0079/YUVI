import { describe, expect, it } from "vitest";
import { COGNITION_6G_VERSION, COGNITION_6H_VERSION } from "./index.js";
import {
  interpretCognitionCapabilityAwareReasoningOutput,
  type CognitionCapabilityAwareReasoningDisposition
} from "./capability-aware-task.js";
import {
  COGNITION_INTERACTION_ROUND_VERSION,
  createCognitionInteractionRound,
  interpretCognitionInteractionOutput,
  type CognitionInteractionDecision
} from "./interaction-round.js";

const inventory = {
  version: COGNITION_6G_VERSION,
  capabilities: [{ capabilityRef: "opaque-read", description: "Read authorized evidence." }]
};
const request = {
  version: COGNITION_6H_VERSION,
  kind: "REQUEST_CAPABILITY",
  capabilityRef: "opaque-read",
  request: "Read the authorized evidence."
};
const version = COGNITION_INTERACTION_ROUND_VERSION;

describe("Cognition interaction-round contract", () => {
  it.each([
    "COMPLETE\nSupported answer.",
    'REQUEST_CAPABILITY\n{"capabilityRef":"opaque-read","request":"Read the evidence."}'
  ])("represents the existing 6W decision without changing its payload: %s", (answer) => {
    const legacy: CognitionCapabilityAwareReasoningDisposition =
      interpretCognitionCapabilityAwareReasoningOutput({ reasoning: "", answer }, inventory);
    const decision: CognitionInteractionDecision = legacy;
    const round = createCognitionInteractionRound({ ...decision, version }, inventory);
    expect(round).toEqual({ ...legacy, version });
    expect(Object.isFrozen(round)).toBe(true);
  });

  it.each(["SUCCESS", "PARTIAL", "UNAVAILABLE", "CANCELLED", "ERROR"])(
    "retains normalized terminal result status %s rather than assuming success",
    (status) => {
      const result = {
        version: "character-cognition-result.v1",
        status,
        ...(status === "SUCCESS" || status === "PARTIAL" ? { answer: "Supported answer." } : {})
      };
      expect(
        createCognitionInteractionRound({ version, kind: "COMPLETE", result }, inventory)
      ).toEqual({ version, kind: "COMPLETE", result });
    }
  );

  it("represents CONTINUE without enabling it in the legacy 6W wire parser", () => {
    const round = createCognitionInteractionRound({ version, kind: "CONTINUE" }, inventory);
    expect(round).toEqual({ version, kind: "CONTINUE" });
    expect(Object.isFrozen(round)).toBe(true);
    for (const answer of ["CONTINUE", "CONTINUE\n", "CONTINUE_REASONING\nkeep going"]) {
      expect(
        interpretCognitionCapabilityAwareReasoningOutput({ reasoning: "", answer }, inventory)
      ).toMatchObject({ kind: "COMPLETE", result: { status: "ERROR" } });
    }
  });

  it("revalidates membership against the current inventory", () => {
    expect(() =>
      createCognitionInteractionRound(
        { version, kind: "REQUEST_CAPABILITY", request },
        { version: COGNITION_6G_VERSION, capabilities: [] }
      )
    ).toThrow();
    expect(() =>
      createCognitionInteractionRound(
        { version, kind: "REQUEST_CAPABILITY", request: { ...request, capabilityRef: "invented" } },
        inventory
      )
    ).toThrow();
  });

  it("snapshots nested semantic evidence and requests before callers can mutate them", () => {
    const result = {
      version: "character-cognition-result.v1",
      status: "SUCCESS",
      answer: "Supported answer.",
      evidence: [{ reference: "evidence-1", statement: "Observed fact." }]
    };
    const completed = createCognitionInteractionRound(
      { version, kind: "COMPLETE", result },
      inventory
    );
    result.evidence[0]!.statement = "Changed after validation.";
    expect(completed).toMatchObject({ result: { evidence: [{ statement: "Observed fact." }] } });
    if (completed.kind !== "COMPLETE") throw new Error("Expected COMPLETE");
    expect(Object.isFrozen(completed.result.evidence)).toBe(true);
    expect(Object.isFrozen(completed.result.evidence![0])).toBe(true);
    const mutableRequest = { ...request };
    const requested = createCognitionInteractionRound(
      { version, kind: "REQUEST_CAPABILITY", request: mutableRequest },
      inventory
    );
    mutableRequest.capabilityRef = "different";
    expect(requested).toMatchObject({ request: { capabilityRef: "opaque-read" } });
    if (requested.kind !== "REQUEST_CAPABILITY") throw new Error("Expected REQUEST_CAPABILITY");
    expect(Object.isFrozen(requested.request)).toBe(true);
  });

  it.each([
    null,
    [],
    { version: "future", kind: "CONTINUE" },
    { version, kind: "RETRY" },
    { version, kind: "COMPLETE" },
    { version, kind: "REQUEST_CAPABILITY" },
    { version, kind: "CONTINUE", result: {} },
    { version, kind: "CONTINUE", reasoning: "raw private reasoning" },
    { version, kind: "CONTINUE", problem: "replace the admitted task" },
    { version, kind: "CONTINUE", executionId: "caller-selected" },
    { version, kind: "CONTINUE", maxReasoningRounds: 999 },
    { version, kind: "REQUEST_CAPABILITY", request: { ...request, arguments: { path: "file" } } },
    {
      version,
      kind: "COMPLETE",
      result: { version: "character-cognition-result.v1", status: "SUCCESS" }
    },
    {
      version,
      kind: "COMPLETE",
      result: { version: "character-cognition-result.v1", status: "ERROR", provider: "leak" }
    }
  ])("rejects malformed or authority-bearing input %#", (input) => {
    expect(() => createCognitionInteractionRound(input, inventory)).toThrow();
  });
});

describe("bounded interaction wire protocol", () => {
  it("admits only an exact payload-free CONTINUE", () => {
    expect(
      interpretCognitionInteractionOutput(
        { reasoning: "", answer: "CONTINUE", finishReason: "stop" },
        inventory
      )
    ).toEqual({ version, kind: "CONTINUE" });
    for (const output of [
      { reasoning: "", answer: "CONTINUE\n" },
      { reasoning: "", answer: 'CONTINUE\n{"maxReasoningRounds":999}' },
      { reasoning: "", answer: "CONTINUE", finishReason: "length" as const }
    ])
      expect(interpretCognitionInteractionOutput(output, inventory)).toMatchObject({
        kind: "COMPLETE",
        result: { status: "ERROR" }
      });
  });

  it("rejects non-normalized raw reasoning at the boundary", () => {
    expect(() =>
      interpretCognitionInteractionOutput(
        { reasoning: "private trace", answer: "CONTINUE" },
        inventory
      )
    ).toThrow(/provider-normalized/);
  });

  it.each([
    "COMPLETE\nSupported answer.",
    'REQUEST_CAPABILITY\n{"capabilityRef":"opaque-read","request":"Read evidence."}'
  ])("validates the existing semantic payload: %s", (answer) => {
    const legacy = interpretCognitionCapabilityAwareReasoningOutput(
      { reasoning: "", answer },
      inventory
    );
    expect(interpretCognitionInteractionOutput({ reasoning: "", answer }, inventory)).toEqual({
      ...legacy,
      version
    });
  });
});
