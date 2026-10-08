import { describe, expect, it, vi } from "vitest";
import { PromptBuilder, assembleCanonicalContext } from "@companion/prompt-builder";
import { RuntimeSocialContextSchema } from "@companion/protocol";
import { renderSurfaceSituation } from "@companion/core";
import type { ChatInput, ChatOutput } from "@companion/providers";
import { createServerCharacterPort } from "./character-runtime.js";
import {
  TURN_AUTHORITY_VERSION,
  validateCurrentTurnAuthorization
} from "./character-turn-authority.js";

const history =
  "User previously requested IMAGE_TASK_42. It remains unresolved. Earlier assistant invited comparison.";
const output = (value: unknown): ChatOutput => ({
  message: { role: "assistant", content: JSON.stringify(value) },
  finishReason: "stop"
});
function input(
  current: string,
  generateChat: (chat: ChatInput) => Promise<ChatOutput>,
  eventId = "jev1_0000000000000001"
) {
  const surfaceContext = RuntimeSocialContextSchema.parse({
    surface: "matrix",
    channelRef: "group",
    conversationKind: "GROUP",
    admission: "ATTENTION",
    self: { principalId: "self", displayName: "Alice" },
    speaker: { principalId: "a" },
    sourceJournalRef: { kind: "JOURNAL_EVENT", namespace: "test", eventId },
    mentions: [],
    observations: []
  });
  const canonicalContext = assembleCanonicalContext({
    currentInput: current,
    situationEvidence: renderSurfaceSituation(surfaceContext),
    semanticSections: [{ kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: history }]
  });
  return {
    userMessage: current,
    canonicalContext,
    surfaceContext,
    interactionBoundary: surfaceContext,
    prompt: new PromptBuilder().buildPrompt({
      systemIdentity: "Alice",
      characterStyle: "Natural",
      userMessage: current
    }),
    visualSources: [{ reference: "image:old", sourceJournalRef: surfaceContext.sourceJournalRef! }],
    requestVisualEvidence: vi.fn(async () => ({
      status: "AVAILABLE" as const,
      observations: "CURRENT_IMAGE_42"
    })),
    generateChat
  };
}
describe("current turn authority, separately from unresolved history", () => {
  it.each(["得对比一下", "测试看看她能不能区分", "[Image attachment]", "这条不需要回复"])(
    "keeps history understandable but permits zero actions for observation %s",
    async (current) => {
      const generateChat = vi.fn(async (_chat: ChatInput) => output({ authorization: "NONE" }));
      const turn = input(current, generateChat);
      const result = await createServerCharacterPort().generate(turn);
      expect(result.decision.reply.disposition).toBe("SILENCE");
      expect(result.cognitionHandoff).toBeUndefined();
      expect(turn.requestVisualEvidence).not.toHaveBeenCalled();
      expect(generateChat).toHaveBeenCalledOnce();
      const wire = generateChat.mock.calls[0]![0];
      expect(wire.contextProjectionVersions).toContain(TURN_AUTHORITY_VERSION);
      expect(wire.messages[0]!.content).toContain(history);
      expect(wire.messages[1]!.content).toContain(current);
    }
  );
  it.each([
    { visualNeed: "Finish IMAGE_TASK_42", sourceReference: "image:old" },
    { disposition: "NEED_COGNITION", focus: "Finish IMAGE_TASK_42" },
    { disposition: "RESPOND", proactive: { action: "CLEAR" } }
  ])("rejects an out-of-scope proposal after a current social call: %j", async (proposal) => {
    const responses = [
      output({
        authorization: "SOCIAL",
        currentEvidence: "Alice 你在吗",
        request: "Acknowledge the current call"
      }),
      output(proposal),
      output(proposal)
    ];
    const generateChat = vi.fn(async (_chat: ChatInput) => responses.shift()!);
    const turn = input("Alice 你在吗", generateChat);
    const result = await createServerCharacterPort().generate(turn);
    expect(result.decision.reply.disposition).toBe("SILENCE");
    expect(result.cognitionHandoff).toBeUndefined();
    expect(turn.requestVisualEvidence).not.toHaveBeenCalled();
    expect(generateChat).toHaveBeenCalledTimes(3);
    expect(generateChat.mock.calls[1]![0].messages[0]!.content).toContain(
      "Only the current social response is authorized"
    );
  });
  it("requires a separate current continuation witness and keeps full historical context", async () => {
    const responses = [
      output({
        authorization: "RESUME",
        currentEvidence: "继续看刚才的图",
        historicalEvidence: "IMAGE_TASK_42",
        request: "Read the explicitly resumed image",
        perception: true
      }),
      output({ visualNeed: "Read the resumed image", sourceReference: "image:old" }),
      output({ disposition: "RESPOND" })
    ];
    const generateChat = vi.fn(async (_chat: ChatInput) => responses.shift()!);
    const turn = input("Alice，继续看刚才的图", generateChat);
    const result = await createServerCharacterPort().generate(turn);
    expect(turn.requestVisualEvidence).toHaveBeenCalledOnce();
    expect(result.decision.reply.disposition).toBe("RESPOND");
    if (result.decision.reply.disposition !== "RESPOND" || !("body" in result.decision.reply))
      throw Error("Missing body");
    expect(result.decision.reply.body.messages[0]!.content).toContain(
      "Current turn authorization: RESUME"
    );
    expect(result.decision.reply.body.messages[0]!.content).toContain(history);
    expect(result.decision.reply.body.messages[1]!.content).toContain("CURRENT_IMAGE_42");
  });
  it("does not inherit permission from the preceding turn or a Cognition result", async () => {
    const responses = [
      output({
        authorization: "TASK",
        currentEvidence: "Alice 看图",
        request: "Describe the current image",
        perception: true
      }),
      output({ disposition: "RESPOND" }),
      output({ authorization: "NONE" })
    ];
    const generateChat = vi.fn(async (_chat: ChatInput) => responses.shift()!);
    const port = createServerCharacterPort();
    const first = input("Alice 看图", generateChat);
    expect((await port.generate(first)).decision.reply.disposition).toBe("RESPOND");
    const second = input("得对比一下", generateChat, "jev1_0000000000000002");
    const result = await port.generateAfterCognition({
      ...second,
      cognitionRoundTrip: { result: "Finish the old image task" }
    });
    expect(result.decision.reply.disposition).toBe("SILENCE");
    expect(second.requestVisualEvidence).not.toHaveBeenCalled();
    expect(generateChat.mock.calls[2]![0].contextProjectionVersions).toContain(
      TURN_AUTHORITY_VERSION
    );
  });
  it("binds same-turn Cognition handoff to the authorized goal and reuses only that event's decision", async () => {
    const responses = [
      output({
        authorization: "TASK",
        currentEvidence: "Alice 算一下",
        request: "Compute the current requested sum",
        perception: false
      }),
      output({ disposition: "NEED_COGNITION", focus: "Resume OLD_TASK_WITHOUT_PERMISSION" }),
      output({ disposition: "RESPOND" })
    ];
    const generateChat = vi.fn(async (_chat: ChatInput) => responses.shift()!);
    const turn = input("Alice 算一下", generateChat),
      port = createServerCharacterPort();
    const first = await port.generate(turn);
    expect(first.cognitionHandoff?.problem).toContain("Compute the current requested sum");
    expect(first.cognitionHandoff?.problem).not.toContain("OLD_TASK_WITHOUT_PERMISSION");
    const second = await port.generateAfterCognition({
      ...turn,
      cognitionRoundTrip: {
        version: "character-harness-5h.v1",
        request: first.cognitionHandoff!.request,
        result: { version: "character-cognition-result.v1", status: "SUCCESS", answer: "42" }
      }
    });
    expect(second.decision.reply.disposition).toBe("RESPOND");
    expect(generateChat).toHaveBeenCalledTimes(3);
    expect(
      generateChat.mock.calls.filter(([chat]) =>
        chat.contextProjectionVersions?.includes(TURN_AUTHORITY_VERSION)
      )
    ).toHaveLength(1);
  });
  it("rejects historical evidence offered as current permission, invented resume history and unknown fields", () => {
    const v = {
      authorization: "RESUME",
      currentEvidence: "IMAGE_TASK_42",
      historicalEvidence: "IMAGE_TASK_42",
      request: "Resume",
      perception: true
    };
    expect(validateCurrentTurnAuthorization(v, "得对比一下", history)).toBeUndefined();
    expect(
      validateCurrentTurnAuthorization(
        { ...v, currentEvidence: "继续", historicalEvidence: "invented" },
        "继续",
        history
      )
    ).toBeUndefined();
    expect(
      validateCurrentTurnAuthorization({ authorization: "NONE", perception: true }, "继续", history)
    ).toBeUndefined();
  });
  it("fails closed after bounded malformed authorization and never advertises available actions to that classifier", async () => {
    const generateChat = vi.fn(async (_chat: ChatInput) =>
      output({ visualNeed: "Look at the old image" })
    );
    const turn = input("得对比一下", generateChat);
    expect((await createServerCharacterPort().generate(turn)).decision.reply.disposition).toBe(
      "SILENCE"
    );
    expect(generateChat).toHaveBeenCalledTimes(2);
    expect(turn.requestVisualEvidence).not.toHaveBeenCalled();
    expect(generateChat.mock.calls[0]![0].messages[0]!.content).not.toContain('"visualNeed"');
  });
  it("does not reuse authorization when the same snapshot object receives a different source event", async () => {
    const responses = [
      output({
        authorization: "SOCIAL",
        currentEvidence: "Alice 你在吗",
        request: "Acknowledge the current call"
      }),
      output({ disposition: "RESPOND" }),
      output({ authorization: "NONE" })
    ];
    const generateChat = vi.fn(async (_chat: ChatInput) => responses.shift()!);
    const turn = input("Alice 你在吗", generateChat),
      port = createServerCharacterPort();
    expect((await port.generate(turn)).decision.reply.disposition).toBe("RESPOND");
    turn.surfaceContext.sourceJournalRef!.eventId = "jev1_0000000000000002";
    expect((await port.generate(turn)).decision.reply.disposition).toBe("SILENCE");
    expect(generateChat).toHaveBeenCalledTimes(3);
    expect(turn.requestVisualEvidence).not.toHaveBeenCalled();
  });
  it("blocks perception of an old task during an unrelated authorized current task", async () => {
    const responses = [
      output({
        authorization: "TASK",
        currentEvidence: "Alice 算一下",
        request: "Compute the current requested sum",
        perception: false
      }),
      output({ visualNeed: "Finish IMAGE_TASK_42", sourceReference: "image:old" }),
      output({ visualNeed: "Finish IMAGE_TASK_42", sourceReference: "image:old" })
    ];
    const generateChat = vi.fn(async (_chat: ChatInput) => responses.shift()!);
    const turn = input("Alice 算一下", generateChat);
    const result = await createServerCharacterPort().generate(turn);
    expect(result.decision.reply.disposition).toBe("SILENCE");
    expect(turn.requestVisualEvidence).not.toHaveBeenCalled();
    expect(result.cognitionHandoff).toBeUndefined();
    expect(generateChat).toHaveBeenCalledTimes(3);
  });
});
