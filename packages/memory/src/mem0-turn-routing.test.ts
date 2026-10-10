import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "./service.js";
import { InMemoryMemoryRepository } from "./repository.js";
import type { MemoryBackend } from "./backend.js";
import { MEMORY_SCOPE_MISSING, classifyMem0Turn, resolveMem0ChatIdentity } from "./mem0-chat.js";

function createCountingBackend() {
  const calls = {
    add: [] as Array<{ infer?: boolean; content?: string; messages?: unknown }>,
    search: 0,
    delete: 0
  };
  const backend: MemoryBackend = {
    kind: "mem0",
    health: async () => ({ status: "healthy", backend: "mem0" }),
    add: vi.fn(async (input) => {
      calls.add.push({
        infer: input.infer,
        content: input.content,
        messages: input.messages
      });
      return { memoryId: `m-${calls.add.length}`, operation: "created" as const };
    }),
    search: vi.fn(async () => {
      calls.search += 1;
      return [
        {
          id: "sci-1",
          content: "我喜欢科幻作品",
          scope: "s",
          metadata: {},
          score: 0.9
        }
      ];
    }),
    get: async () => null,
    list: async () => ({ items: [] }),
    update: async () => ({
      id: "x",
      content: "x",
      scope: "s",
      metadata: {}
    }),
    delete: vi.fn(async () => {
      calls.delete += 1;
    }),
    history: async () => []
  };
  return { backend, calls };
}

function serviceWith(backend: MemoryBackend): MemoryService {
  return new MemoryService(
    new InMemoryMemoryRepository(),
    undefined,
    undefined,
    undefined,
    { enabled: false },
    { kind: "mem0", mem0: backend, searchTimeoutMs: 600, writeTimeoutMs: 5000 }
  );
}

describe("Mem0 identity scope", () => {
  it("rejects missing subjectUserId without silent default", () => {
    const r = resolveMem0ChatIdentity({ personaId: "lumi" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(MEMORY_SCOPE_MISSING);
      expect(r.missing).toContain("subjectUserId");
    }
  });

  it("rejects missing personaId without silent default", () => {
    const r = resolveMem0ChatIdentity({ subjectUserId: "local-user" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain("personaId");
    }
  });

  it("builds stable scope for full identity", () => {
    const r = resolveMem0ChatIdentity({
      subjectUserId: "local-user",
      personaId: "lumi"
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toEqual({ userId: "local-user", characterId: "lumi" });
    }
  });

  it("search skips Mem0 when scope missing", async () => {
    const { backend, calls } = createCountingBackend();
    const service = serviceWith(backend);
    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "coffee",
      // missing persona
      subjectUserId: "local-user"
    });
    expect(result.count).toBe(0);
    expect(result.fallbackReason).toBe(MEMORY_SCOPE_MISSING);
    expect(calls.search).toBe(0);
  });
});

describe("Mem0 turn classification and write routing", () => {
  it("classifies turn kinds", () => {
    expect(
      classifyMem0Turn({
        userMessage: "I like coffee",
        assistantMessage: "ok",
        cancelledOrFailed: false
      })
    ).toBe("normal");
    expect(
      classifyMem0Turn({
        userMessage: "请记住：我喜欢科幻",
        assistantMessage: "好的"
      })
    ).toBe("explicit_remember");
    expect(
      classifyMem0Turn({
        userMessage: "忘记我喜欢科幻作品",
        assistantMessage: "已删除"
      })
    ).toBe("normal");
    expect(
      classifyMem0Turn({
        userMessage: "hi",
        assistantMessage: "",
        cancelledOrFailed: true
      })
    ).toBe("cancelled_or_failed");
  });

  it("explicit remember calls add once with infer=false and never infer=true", async () => {
    const { backend, calls } = createCountingBackend();
    const service = serviceWith(backend);
    const result = await service.storeConversationTurn({
      userMessage: "请记住：我喜欢科幻作品",
      assistantMessage: "好的，记住了。",
      subjectUserId: "local-user",
      personaId: "lumi"
    });
    expect(result.ok).toBe(true);
    expect(result.turnKind).toBe("explicit_remember");
    expect(result.infer).toBe(false);
    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]?.infer).toBe(false);
    expect(calls.add[0]?.content).toContain("科幻");
    expect(calls.add.some((c) => c.infer === true)).toBe(false);
  });

  it("a host-authored explicit_forget turn skips add, but conversational text cannot authorize deletion", async () => {
    const { backend, calls } = createCountingBackend();
    const service = serviceWith(backend);
    const write = await service.storeConversationTurn({
      userMessage: "忘记我喜欢科幻作品",
      turnKind: "explicit_forget",
      assistantMessage: "好的",
      subjectUserId: "local-user",
      personaId: "lumi"
    });
    expect(write.ok).toBe(false);
    expect(write.status).toBe("skipped");
    expect(write.skippedCount).toBe(1);
    expect(write.turnKind).toBe("explicit_forget");
    expect(calls.add).toHaveLength(0);

    const forget = await service.forgetExplicitMemory({
      userMessage: "忘记我喜欢科幻作品",
      subjectUserId: "local-user",
      personaId: "lumi"
    });
    expect(forget).toMatchObject({ status: "CONFIRMATION_REQUIRED", deleted: 0, notFound: false });
    expect(calls.search).toBe(0);
    expect(calls.delete).toBe(0);
    expect(calls.add).toHaveLength(0);
  });

  it("normal factual turn calls the semantic provider once", async () => {
    const { backend, calls } = createCountingBackend();
    const service = serviceWith(backend);
    const result = await service.storeConversationTurn({
      userMessage: "我早上通常喝咖啡",
      assistantMessage: "了解",
      subjectUserId: "local-user",
      personaId: "lumi"
    });
    expect(result.ok).toBe(true);
    expect(result.turnKind).toBe("normal");
    expect(result.infer).toBe(false);
    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]?.infer).toBe(false);
    expect(calls.add[0]?.messages).toBeUndefined();
    expect(calls.add[0]?.content).toContain("咖啡");
  });

  it("cancelled_or_failed never writes", async () => {
    const { backend, calls } = createCountingBackend();
    const service = serviceWith(backend);
    const result = await service.storeConversationTurn({
      userMessage: "hello",
      assistantMessage: "",
      cancelledOrFailed: true,
      subjectUserId: "local-user",
      personaId: "lumi"
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.skippedCount).toBe(1);
    expect(result.turnKind).toBe("cancelled_or_failed");
    expect(calls.add).toHaveLength(0);
  });

  it("missing scope skips add with MEMORY_SCOPE_MISSING", async () => {
    const { backend, calls } = createCountingBackend();
    const service = serviceWith(backend);
    const result = await service.storeConversationTurn({
      userMessage: "我喜欢茶",
      assistantMessage: "好",
      subjectUserId: "local-user"
      // persona missing
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.skippedCount).toBe(1);
    expect(result.code).toBe(MEMORY_SCOPE_MISSING);
    expect(calls.add).toHaveLength(0);
  });
});
