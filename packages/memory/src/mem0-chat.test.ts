import { describe, expect, it, vi } from "vitest";
import {
  buildChatMemoryScope,
  dedupeSearchResults,
  forgetMemoriesInScope,
  selectPromptMemories,
  toPromptMemoryDebug
} from "./mem0-chat.js";
import type { MemoryBackend, MemorySearchResult } from "./backend.js";

function hit(id: string, content: string, score = 0.8): MemorySearchResult {
  return {
    id,
    content,
    scope: "yuvi:v1:user:u:character:c",
    metadata: {},
    score
  };
}

describe("mem0 chat helpers", () => {
  it("builds isolated scopes", () => {
    const a = buildChatMemoryScope({ userId: "user-a", characterId: "alice" });
    const b = buildChatMemoryScope({ userId: "user-a", characterId: "lumi" });
    const c = buildChatMemoryScope({ userId: "user-b", characterId: "alice" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("dedupes and budgets prompt memories without metadata leakage in displayText", () => {
    const items = [
      hit("1", "User likes coffee"),
      hit("2", "User likes coffee"),
      hit("3", "User prefers short replies"),
      hit("4", "A".repeat(3000))
    ];
    const selected = selectPromptMemories(items, { maxItems: 5, charBudget: 200 });
    expect(selected).toHaveLength(2);
    expect(selected.map((s) => s.content)).toEqual([
      "User likes coffee",
      "User prefers short replies"
    ]);
    const debug = toPromptMemoryDebug(selected[0]!);
    expect(debug.displayText).toBe("User likes coffee");
    expect(JSON.stringify(debug.displayText)).not.toContain("memoryId");
    expect(debug.metadata).toEqual({});
  });

  it("dedupeSearchResults drops blanks", () => {
    expect(dedupeSearchResults([hit("1", "  "), hit("2", "x")])).toHaveLength(1);
  });

  it("forgetMemoriesInScope deletes content-overlap matches even with near-zero scores", async () => {
    const deleted: string[] = [];
    const backend: MemoryBackend = {
      kind: "mem0",
      health: async () => ({ status: "healthy", backend: "mem0" }),
      add: async () => ({ memoryId: "x", operation: "created" }),
      search: async () => [
        hit("keep-unrelated", "user likes coffee", 0.99),
        // Live Mem0 often returns near-zero scores for exact fact hits.
        hit("del-1", "我喜欢科幻作品", 0.00015),
        hit("del-2", "user preferred red", 0.12)
      ],
      get: async () => null,
      list: async () => ({ items: [] }),
      update: async () => hit("1", "x"),
      delete: async (input) => {
        deleted.push(input.memoryId);
      },
      history: async () => []
    };
    const sci = await forgetMemoriesInScope(backend, {
      scope: "yuvi:v1:user:u:character:c",
      query: "我喜欢科幻作品",
      maxDelete: 5
    });
    expect(sci.deleted).toBe(1);
    expect(sci.memoryIds).toEqual(["del-1"]);

    deleted.length = 0;
    const red = await forgetMemoriesInScope(backend, {
      scope: "yuvi:v1:user:u:character:c",
      query: "red color preference",
      maxDelete: 5
    });
    expect(red.deleted).toBe(1);
    expect(red.memoryIds).toEqual(["del-2"]);
    expect(deleted).not.toContain("keep-unrelated");
  });

  it("forget returns notFound when nothing matches", async () => {
    const backend: MemoryBackend = {
      kind: "mem0",
      health: async () => ({ status: "healthy", backend: "mem0" }),
      add: async () => ({ memoryId: "x", operation: "created" }),
      search: async () => [],
      get: async () => null,
      list: async () => ({ items: [] }),
      update: async () => hit("1", "x"),
      delete: async () => {
        throw new Error("should not delete");
      },
      history: async () => []
    };
    const result = await forgetMemoriesInScope(backend, { scope: "s", query: "nothing" });
    expect(result).toMatchObject({ deleted: 0, notFound: true });
  });
});
