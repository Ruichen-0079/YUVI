import { describe, expect, it } from "vitest";
import { SemanticMemoryPolicy } from "./semantic-policy.js";
import { freezeFinalizedMemoryEvent } from "../finalized-memory-lineage.js";
import type { GroundedMemorySource } from "../lineage.js";
import type { MemoryEvent } from "../provider.js";
import { finalizedTestParent, finalizedTestResolver } from "../finalized-test-fixture.js";

describe("semantic proposition admission", () => {
  it("keeps independently verifiable propositions and reports rejected quotes without accepting context as evidence", async () => {
    const text = "我用青禾。我的面试在周四。";
    const source = await finalizedTestResolver.resolve({
      sourceJournalRef: finalizedTestParent,
      sourceText: text
    });
    let request: any;
    const policy = new SemanticMemoryPolicy(
      {
        async generateReasoning(input) {
          request = JSON.parse(input.messages[1]!.content);
          return {
            reasoning: "",
            answer: JSON.stringify({
              propositions: [
                {
                  content: "用户使用青禾。",
                  evidenceText: "我用青禾。",
                  relation: "new",
                  targetIds: []
                },
                { content: "用户面试周四。", evidenceText: "周五", relation: "new", targetIds: [] },
                {
                  content: "用户面试周四。",
                  evidenceText: "我的面试在周四。",
                  relation: "new",
                  targetIds: []
                },
                {
                  content: "Assistant context is not a user assertion.",
                  evidenceText: "你喜欢咖啡。",
                  relation: "new",
                  targetIds: []
                },
                { content: "invalid shape" }
              ]
            })
          };
        }
      },
      async () => [],
      { providerConfigured: true }
    );
    const result = await policy.build({
      scope: "synthetic",
      userMessage: text,
      groundedSource: source,
      dialogueContext: [{ id: "assistant-context", role: "assistant", content: "你喜欢咖啡。" }]
    });
    expect(result.events.map((e) => e.content)).toEqual(["用户使用青禾。", "用户面试周四。"]);
    expect(result.rejectedPropositions).toEqual([
      { index: 1, code: "MEMORY_SEMANTIC_EVIDENCE_NOT_SELECTED" },
      { index: 3, code: "MEMORY_SEMANTIC_EVIDENCE_NOT_SELECTED" },
      { index: 4, code: "MEMORY_SEMANTIC_PROPOSITION_INVALID" }
    ]);
    expect(request.dialogueContext[0].role).toBe("assistant");
    expect(request.source).toBe(text);
  });
  it("rejects noncanonical support references while keeping independent valid propositions", async () => {
    const source = await finalizedTestResolver.resolve({
      sourceJournalRef: finalizedTestParent,
      sourceText: "周三。我还是要面试。茶叶用月桂。"
    });
    const groundedSource: GroundedMemorySource = {
      ...source,
      authority: {
        principal: { state: "RESOLVED", kind: "PRINCIPAL", namespace: "unit", actorId: "a" },
        binding: { state: "RESOLVED", kind: "PERSON_BINDING", personId: "p", bindingVersion: "g" },
        audience: { kind: "PRIVATE", channelRef: "private" }
      }
    };
    const prior: MemoryEvent = {
      ...freezeFinalizedMemoryEvent(
        groundedSource,
        { scope: "s", content: "用户有面试安排。", kind: "fact" },
        "unit"
      ),
      id: "prior",
      scope: "s",
      source: "postgres",
      sourceRecordId: "prior",
      recordedAt: source.recordedAt,
      metadata: {}
    };
    const policy = new SemanticMemoryPolicy(
      {
        async generateReasoning() {
          return {
            reasoning: "",
            answer: JSON.stringify({
              propositions: [
                {
                  content: "用户面试在周三。",
                  evidenceText: "周三。",
                  relation: "supports",
                  targetIds: ["prior"]
                },
                {
                  content: "用户有面试安排。",
                  evidenceText: "我还是要面试。",
                  relation: "supports",
                  targetIds: ["prior"]
                },
                {
                  content: "用户茶叶用月桂。",
                  evidenceText: "茶叶用月桂。",
                  relation: "new",
                  targetIds: []
                }
              ]
            })
          };
        }
      },
      async () => [prior],
      { providerConfigured: true }
    );
    const result = await policy.build({
      scope: "s",
      userMessage: source.selectedText,
      groundedSource
    });
    expect(result.events.map((e) => e.content)).toEqual(["用户有面试安排。", "用户茶叶用月桂。"]);
    expect(result.rejectedPropositions).toEqual([
      { index: 0, code: "MEMORY_SEMANTIC_SUPPORT_CANONICAL_MISMATCH" }
    ]);
  });
  it("does not turn a malformed response envelope into a successful no-value decision", async () => {
    const source = await finalizedTestResolver.resolve({
      sourceJournalRef: finalizedTestParent,
      sourceText: "A factual source"
    });
    const policy = new SemanticMemoryPolicy(
      {
        async generateReasoning() {
          return { reasoning: "", answer: "invalid JSON" };
        }
      },
      async () => [],
      { providerConfigured: true }
    );
    await expect(
      policy.build({ scope: "synthetic", userMessage: source.selectedText, groundedSource: source })
    ).rejects.toThrow();
  });
});
