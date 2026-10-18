import { describe, it, expect } from "vitest";
import { expandMemorySearch } from "./query-expansion.js";
describe("bounded query expansion protocol, not semantic quality", () => {
  it("accepts only a bounded query plan without record IDs or facts", async () => {
    const reasoner = {
      async generateReasoning(input: { messages: unknown[] }) {
        expect(JSON.stringify(input.messages)).toContain("question");
        return { reasoning: '{"queries":["编辑器 偏好","editor preference"]}', model: "fixture" };
      }
    };
    expect((await expandMemorySearch(reasoner, "Which editor do I use?")).queries).toEqual([
      "编辑器 偏好",
      "editor preference"
    ]);
  });
  it("rejects incomplete, malformed and overbroad output", async () => {
    for (const output of [
      { reasoning: '{"queries":["x"]}', finishReason: "length" },
      { reasoning: '{"queries":["x"],"answer":"invented"}' },
      { reasoning: '{"queries":["a","b","c"]}' },
      { reasoning: "not JSON" }
    ])
      await expect(
        expandMemorySearch({ generateReasoning: async () => output }, "query")
      ).rejects.toThrow();
  });
  it("keeps disjoint exact source spans and rejects invented or overlapping demands", async () => {
    const reasoner = (needs: unknown) => ({
      generateReasoning: async () => ({ reasoning: JSON.stringify({ needs }) })
    });
    const valid = [
      { quote: "date", queries: ["日期", "date"] },
      { quote: "tea", queries: ["茶叶", "tea"] }
    ];
    expect(
      (await expandMemorySearch(reasoner(valid), "date and tea")).needs?.map((n) => n.id)
    ).toEqual(["n0", "n1"]);
    for (const invalid of [
      [{ quote: "owner", queries: ["负责人"] }],
      [valid[0], valid[0]],
      [valid[1], valid[0]]
    ])
      await expect(expandMemorySearch(reasoner(invalid), "date and tea")).rejects.toThrow();
  });
});
