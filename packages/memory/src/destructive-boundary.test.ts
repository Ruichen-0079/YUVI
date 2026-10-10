import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "./service.js";
import { InMemoryMemoryRepository } from "./repository.js";
import { forgetMemoriesInScope } from "./mem0-chat.js";
import type { MemoryBackend } from "./backend.js";
const scope = "yuvi:v1:user:u:character:p";
function backend(overrides: Partial<MemoryBackend> = {}): MemoryBackend {
  return {
    kind: "mem0",
    health: async () => ({ status: "healthy", backend: "mem0" }),
    add: vi.fn(),
    search: vi.fn(async () => [
      { id: "fact", content: "I prefer tea", scope, metadata: {}, score: 1 }
    ]),
    get: async () => null,
    list: vi.fn(async () => ({ items: [] })),
    update: vi.fn(),
    delete: vi.fn(async () => {}),
    history: async () => [],
    ...overrides
  };
}
function service(b: MemoryBackend) {
  return new MemoryService(
    new InMemoryMemoryRepository(),
    undefined,
    undefined,
    undefined,
    { enabled: false },
    { kind: "mem0", mem0: b }
  );
}
describe("destructive memory boundary", () => {
  it.each([
    "Don't forget I prefer tea",
    "Please forget I prefer tea",
    "Do not delete memory: I prefer tea",
    'She said "forget I prefer tea"',
    "If I request forget I prefer tea, ask first",
    "Explain the word forget: I prefer tea",
    "不要忘记我喜欢茶",
    "请删除我喜欢茶的记忆"
  ])("never treats unconfirmed chat text as delete authority: %s", async (userMessage) => {
    const b = backend();
    const result = await service(b).forgetExplicitMemory({
      userMessage,
      subjectUserId: "u",
      personaId: "p"
    });
    expect(b.delete).not.toHaveBeenCalled();
    expect(b.search).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deleted: 0, notFound: false, status: "CONFIRMATION_REQUIRED" });
  });
  it("keeps backend search failures distinct from absence", async () => {
    const b = backend({
      search: vi.fn(async () => {
        throw new Error("offline");
      })
    });
    const r = await forgetMemoriesInScope(b, { scope, query: "I prefer tea" });
    expect(r).toMatchObject({ status: "FAILED", notFound: false, deleted: 0 });
    expect(b.delete).not.toHaveBeenCalled();
  });
  it("does not hide fallback list failures", async () => {
    const b = backend({
      search: vi.fn(async () => []),
      list: vi.fn(async () => {
        throw new Error("offline");
      })
    });
    expect(await forgetMemoriesInScope(b, { scope, query: "tea" })).toMatchObject({
      status: "FAILED",
      notFound: false
    });
  });
  it("does not upgrade an uncertain delete outcome to not-found or success", async () => {
    const b = backend({
      delete: vi.fn(async () => {
        throw new Error("connection lost after dispatch");
      })
    });
    expect(await forgetMemoriesInScope(b, { scope, query: "tea" })).toMatchObject({
      status: "UNKNOWN",
      deleted: 0,
      notFound: false,
      unknownMemoryIds: ["fact"]
    });
  });
  it("never consumes another scope's candidate, even if backend returns it", async () => {
    const b = backend({
      search: vi.fn(async () => [
        { id: "foreign", content: "I prefer tea", scope: "other-scope", metadata: {}, score: 1 }
      ])
    });
    expect(await forgetMemoriesInScope(b, { scope, query: "tea" })).toMatchObject({
      status: "NOT_FOUND",
      deleted: 0
    });
    expect(b.delete).not.toHaveBeenCalled();
  });
  it("preserves confirmed helper success and honest empty/cancelled results", async () => {
    const b = backend();
    expect(await forgetMemoriesInScope(b, { scope, query: "tea" })).toMatchObject({
      status: "DELETED",
      deleted: 1,
      notFound: false
    });
    const c = new AbortController();
    c.abort();
    b.delete = vi.fn();
    expect(await forgetMemoriesInScope(b, { scope, query: "tea", signal: c.signal })).toMatchObject(
      { status: "CANCELLED", notFound: false }
    );
    expect(b.delete).not.toHaveBeenCalled();
    expect(
      await forgetMemoriesInScope(backend({ search: async () => [] }), { scope, query: "tea" })
    ).toMatchObject({ status: "NOT_FOUND", notFound: true });
  });
});
