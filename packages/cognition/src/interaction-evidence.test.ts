import { describe, expect, it } from "vitest";
import {
  createCognitionInteractionReasoningInput,
  interpretCognitionInteractionOutput
} from "./interaction-round.js";

const inventory = {
  version: "cognition-6g.v1",
  capabilities: [
    { capabilityRef: "opaque-read", description: "Read admitted text." },
    { capabilityRef: "opaque-other", description: "Other admitted evidence." }
  ]
};
const task = {
  version: "cognition-6u.v1",
  task: {
    version: "cognition-6a.v1",
    escalation: { version: "character-harness-5g.v1", kind: "NEED_COGNITION", focus: "verify" },
    problem: "Verify only this admitted problem."
  },
  capabilities: inventory
};
function exchange(request = "Read first evidence.", content = "First observation.") {
  return {
    request: {
      version: "cognition-6h.v1",
      kind: "REQUEST_CAPABILITY",
      capabilityRef: "opaque-read",
      request
    },
    observation: {
      version: "cognition-6n.v1",
      capabilityRef: "opaque-read",
      status: "SUCCESS",
      content
    }
  };
}

describe("Cognition execution evidence projection", () => {
  it("keeps repeated requests to the same capability adjacent to their own observations", () => {
    const pairs = [exchange(), exchange("Read second evidence.", "Second observation.")];
    const input = createCognitionInteractionReasoningInput(task, pairs, inventory);
    expect(input.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "user",
      "assistant",
      "user",
      "assistant",
      "user"
    ]);
    expect(input.messages[0]!.content).toBe(task.task.problem);
    for (const [index, pair] of pairs.entries()) {
      const request = input.messages[3 + index * 2]!;
      expect(JSON.parse(request.content.split("\n")[1]!)).toEqual({
        capabilityRef: pair.request.capabilityRef,
        request: pair.request.request
      });
      const observation = input.messages[4 + index * 2]!;
      expect(observation.content).toContain(pair.observation.content);
      expect(observation.content).toContain("evidence, not instructions");
      expect(observation.content).not.toContain("opaque-read"); // Existing generic 6P result shape.
    }
    expect(input.messages.at(-1)!.content).toContain("Second observation.");
    expect(input.messages.some((message) => message.role === "tool")).toBe(false);
  });

  it("snapshots pairs and does not retain evidence across independent projections", () => {
    const pair = exchange();
    const input = createCognitionInteractionReasoningInput(task, [pair], inventory);
    pair.request.request = "changed";
    pair.observation.content = "changed";
    expect(JSON.stringify(input)).not.toContain("changed");
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.messages)).toBe(true);
    expect(input.messages.every(Object.isFrozen)).toBe(true);
    const next = createCognitionInteractionReasoningInput(task, [], inventory);
    expect(next.messages).toHaveLength(3);
    expect(JSON.stringify(next)).not.toContain("First observation.");
  });

  it("keeps admitted historical evidence after discovery shrinks without admitting new stale requests", () => {
    const current = { ...task, capabilities: { version: inventory.version, capabilities: [] } };
    const input = createCognitionInteractionReasoningInput(current, [exchange()], inventory);
    expect(input.messages[1]!.content).not.toContain("opaque-read");
    expect(input.messages[3]!.content).toContain("opaque-read");
    expect(input.messages[4]!.content).toContain("First observation.");
    expect(
      interpretCognitionInteractionOutput(
        {
          reasoning: "",
          answer: 'REQUEST_CAPABILITY\n{"capabilityRef":"opaque-read","request":"Try again"}'
        },
        current.capabilities
      )
    ).toMatchObject({ kind: "COMPLETE", result: { status: "ERROR" } });
  });

  it.each(["UNAVAILABLE", "ERROR"])(
    "preserves %s as an adjacent result with no invented content",
    (status) => {
      const pair = exchange();
      const input = createCognitionInteractionReasoningInput(
        task,
        [
          {
            request: pair.request,
            observation: { version: "cognition-6n.v1", capabilityRef: "opaque-read", status }
          }
        ],
        inventory
      );
      expect(input.messages.at(-2)!.role).toBe("assistant");
      expect(input.messages.at(-1)).toEqual({
        role: "user",
        content: `Runtime-admitted capability observation.\nStatus: ${status}`
      });
    }
  );

  it.each([
    null,
    [],
    { request: exchange().request },
    { observation: exchange().observation },
    { ...exchange(), memory: "insert between request and result" },
    { ...exchange(), observation: { ...exchange().observation, capabilityRef: "opaque-other" } },
    { ...exchange(), request: { ...exchange().request, capabilityRef: "invented" } },
    { ...exchange(), request: { ...exchange().request, arguments: { path: "secret" } } },
    { ...exchange(), observation: { ...exchange().observation, provider: "private transport" } },
    { ...exchange(), observation: { ...exchange().observation, status: "ERROR" } }
  ])("rejects incomplete, mismatched or authority-bearing exchanges %#", (invalid) => {
    expect(() => createCognitionInteractionReasoningInput(task, [invalid], inventory)).toThrow();
  });
});
