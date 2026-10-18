import { describe, it, expect, vi } from "vitest";
import { assessEvidenceSupport, evidenceAnchors } from "./evidence-support.js";
import type { SupportInput } from "./evidence-support.js";
const input: SupportInput = {
  request: { text: "茶与编辑器" },
  needs: [
    { id: "n0", quote: "茶" },
    { id: "n1", quote: "编辑器" }
  ],
  events: [
    {
      id: "tea",
      kind: "fact",
      content: "我喜欢月桂-5967。",
      source: "postgres",
      sourceRecordId: "tea",
      assertion: { source: "user", verification: "unverified" },
      metadata: { knowledgeState: "current" }
    }
  ]
};
const evaluate = (needs: unknown) =>
  assessEvidenceSupport(
    {
      generateReasoning: async () => ({
        reasoning: JSON.stringify({ needs }),
        model: "protocol-fixture"
      })
    },
    input
  );
describe("evidence support provenance, not semantic quality", () => {
  it("retains a valid independent need while rejecting a fabricated citation", async () => {
    const r = await evaluate([
      { id: "n0", verdict: "SUPPORTED", citations: [{ id: "tea", quote: "我喜欢月桂-5967。" }] },
      { id: "n1", verdict: "SUPPORTED", citations: [{ id: "foreign", quote: "editor-91" }] }
    ]);
    expect(r.needs.map((n) => n.verdict)).toEqual(["SUPPORTED", "INSUFFICIENT"]);
    expect(r.needs[1]?.citations).toEqual([]);
  });
  it("cannot turn stale/conflicted or truncated claims into definite support", async () => {
    for (const event of [
      { ...input.events[0]!, metadata: { knowledgeState: "conflicted" } },
      { ...input.events[0]!, metadata: { knowledgeState: "superseded" } },
      { ...input.events[0]!, content: input.events[0]!.content + "x".repeat(1600) }
    ]) {
      const r = await assessEvidenceSupport(
        {
          generateReasoning: async () => ({
            reasoning: JSON.stringify({
              needs: [
                { id: "n0", verdict: "SUPPORTED", citations: [{ id: "tea", quote: "月桂-5967" }] }
              ]
            })
          })
        },
        { ...input, events: [event], needs: [input.needs[0]!] }
      );
      expect(r.needs[0]?.verdict).toBe("INSUFFICIENT");
    }
  });
  it("rejects extra answers, incomplete outputs, missing/duplicate demands and altered quotes", async () => {
    await expect(evaluate([{ id: "n0", verdict: "SUPPORTED", citations: [] }])).rejects.toThrow();
    await expect(
      evaluate([
        { id: "n0", verdict: "INSUFFICIENT", citations: [] },
        { id: "n0", verdict: "INSUFFICIENT", citations: [] }
      ])
    ).rejects.toThrow();
    const r = await evaluate([
      { id: "n0", verdict: "SUPPORTED", citations: [{ id: "tea", quote: "月桂-91" }] },
      { id: "n1", verdict: "INSUFFICIENT", citations: [] }
    ]);
    expect(r.needs[0]?.verdict).toBe("INSUFFICIENT");
    for (const result of [
      { reasoning: '{"needs":[],"answer":"invented"}' },
      { reasoning: '{"needs":[]}', finishReason: "length" }
    ])
      await expect(
        assessEvidenceSupport({ generateReasoning: async () => result }, input)
      ).rejects.toThrow();
  });
  it("does not spend a call to classify an empty candidate set, or assert database absence", async () => {
    const generateReasoning = vi.fn();
    const r = await assessEvidenceSupport({ generateReasoning }, { ...input, events: [] });
    expect(generateReasoning).not.toHaveBeenCalled();
    expect(r.needs.every((n) => n.verdict === "INSUFFICIENT")).toBe(true);
  });
  it("derives copy-sensitive anchors from disclosed content without domain vocabulary", () => {
    expect(evidenceAnchors("月桂-5967 38% FIN_42 月桂-5967")).toEqual([
      "月桂-5967",
      "38%",
      "FIN_42"
    ]);
  });
});
