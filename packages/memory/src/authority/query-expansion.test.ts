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
});
