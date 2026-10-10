import { InMemoryEventBus } from "@companion/event-bus";
import {
  type MemoryEvent,
  buildMemoryScope,
  InMemoryMemoryRepository,
  MemoryService,
  type MemoryBackend,
  type MemoryProvider,
  type MemoryRetrievalOutcome,
  type MemoryRetrievalResult,
  type RetrievedMemoryDebug
} from "@companion/memory";
import {
  PromptBuilder,
  type PromptBuildInput,
  type PromptBuildOutput
} from "@companion/prompt-builder";
import {
  createMockChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockTTSProvider,
  createMockVisionProvider,
  MockEmbeddingProvider
} from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryContextBuilder,
  RuntimeOrchestrator,
  defineCharacter,
  type RuntimeMemoryPort
} from "./index.js";

function event(content = "User likes tea"): MemoryEvent {
  return {
    id: "mem0:test",
    kind: "fact",
    content,
    source: "mem0",
    sourceRecordId: "test",
    metadata: {}
  };
}

function outcome(
  status: MemoryRetrievalOutcome["status"],
  events: MemoryEvent[] = [],
  errorCode?: string
): MemoryRetrievalOutcome {
  return {
    status,
    events,
    source: "mem0",
    limited: false,
    ...(errorCode ? { errorCode } : {})
  };
}

function legacyDebug(content: string): RetrievedMemoryDebug {
  return {
    id: "legacy-1",
    type: "semantic",
    subtype: "fact",
    scope: "user",
    scopeId: null,
    memoryLayer: "core",
    status: "active",
    source: "legacy",
    sourceTraceId: null,
    metadata: {},
    importance: 0.8,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    displayText: content,
    matchedBy: "content",
    hasEmbedding: false,
    embeddingProvider: null,
    embeddingModel: null,
    embeddingDimensions: null,
    embeddedAt: null,
    score: 0.8
  };
}

function legacyResult(content: string): MemoryRetrievalResult {
  const memory = legacyDebug(content);
  return {
    query: "hello",
    keywords: ["hello"],
    rawCount: 1,
    count: 1,
    retrievalMode: "keyword",
    vectorEnabled: false,
    vectorUsed: false,
    queryEmbeddingGenerated: false,
    vectorResultCount: 0,
    keywordResultCount: 1,
    hybridResultCount: 1,
    fallbackUsed: false,
    retrievalScope: "user",
    includedScopes: [{ scope: "user" }],
    includeArchived: false,
    includeSuperseded: false,
    includeExpired: false,
    currentTime: "2025-01-01T00:00:00.000Z",
    excludedByStatus: 0,
    excludedByTime: 0,
    excludedByScope: 0,
    rawMemories: [memory],
    memories: [memory],
    selectedMemories: []
  };
}

function createProvider(result: MemoryRetrievalOutcome): MemoryProvider {
  return {
    retrieveRelevant: vi.fn(async () => result),
    getEvent: vi.fn(async () => null),
    writeEvent: vi.fn(async () => ({ status: "rejected" as const }))
  };
}

function createProviders() {
  return {
    getChatProvider: () => createMockChatProvider("test-chat"),
    getReasoningProvider: () => createMockReasoningProvider("test-reasoning"),
    getTTSProvider: () => createMockTTSProvider("test-tts"),
    getSTTProvider: () => createMockSTTProvider("test-stt"),
    getVisionProvider: () => createMockVisionProvider("test-vision"),
    getEmbeddingProvider: () => new MockEmbeddingProvider(3)
  };
}

function createMemory(
  provider: MemoryProvider | undefined,
  legacy: ReturnType<typeof vi.fn>
): RuntimeMemoryPort {
  return {
    ...(provider ? { getMemoryProvider: () => provider } : {}),
    retrieveRelevantMemories: vi.fn(async () => []),
    retrieveRelevantMemoriesWithMetadata: legacy,
    scoreImportance: () => 0,
    rememberInteraction: vi.fn(async () => null)
  };
}

function createRuntime(memory: RuntimeMemoryPort, builder?: Pick<MemoryContextBuilder, "build">) {
  const promptBuilder = new PromptBuilder();
  const buildPrompt = vi.fn(
    (input: PromptBuildInput): PromptBuildOutput => promptBuilder.buildPrompt(input)
  );
  const runtime = new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory,
    promptBuilder: { buildPrompt },
    providers: createProviders(),
    ...(builder ? { memoryContextBuilder: builder } : {})
  });
  return { runtime, buildPrompt };
}

function createMem0Service(backend: MemoryBackend): MemoryService {
  return new MemoryService(
    new InMemoryMemoryRepository(),
    undefined,
    undefined,
    undefined,
    { enabled: false },
    { kind: "mem0", mem0: backend }
  );
}

describe("Runtime provider retrieval wiring", () => {
  it("retrieves a bound Character's memories through its explicit user × instance scope", async () => {
    const scope = buildMemoryScope("test-person", "character-instance:scope-audit");
    const search = vi.fn(async () => [
      { id: "scoped-fact", content: "Editor is GARDEN_613", scope, metadata: {}, score: 0.9 }
    ]);
    const memory = createMem0Service({
      kind: "mem0",
      search,
      health: vi.fn(),
      add: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      history: vi.fn()
    } as MemoryBackend);
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      promptBuilder: new PromptBuilder(),
      providers: createProviders(),
      characterBinding: {
        instanceId: "scope-audit",
        definition: defineCharacter({
          id: "scope-audit",
          name: "Alice",
          revision: "1",
          persona: "Use authorized evidence."
        })
      }
    });
    await runtime.handleUserMessage(
      { sessionId: "scoped-session", content: "What is my editor?", subjectUserId: "test-person" },
      { readMemory: true, writeMemory: false }
    );
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ scope }), undefined);
    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "ok",
      memoryRetrievalEventIds: ["mem0:scoped-fact"]
    });
    expect(
      runtime
        .getLatestPromptPreview()
        ?.sections.find((section) => section.name === "RelevantMemory")?.content
    ).toContain("GARDEN_613");
    await runtime.sealAndDrainMemoryWrites();
  });

  it("uses MemoryProvider and MemoryContextBuilder without legacy mapping on success", async () => {
    const provider = createProvider(outcome("ok", [event()]));
    const legacy = vi.fn(async () => legacyResult("legacy should not be read"));
    const build = vi.fn((input: MemoryEvent[] | MemoryRetrievalOutcome) =>
      new MemoryContextBuilder().build(input)
    );
    const { runtime, buildPrompt } = createRuntime(createMemory(provider, legacy), { build });

    await runtime.handleUserMessage(
      { sessionId: "session-provider", content: "What do I like?" },
      { readMemory: true, writeMemory: false }
    );

    expect(provider.retrieveRelevant).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
    expect(buildPrompt.mock.calls[0]?.[0].retrievedMemories).toMatchObject([
      {
        content: "User likes tea",
        provenanceId: "mem0:test",
        source: "mem0",
        sourceRecordId: "test"
      }
    ]);
    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "ok",
      memoryFinalStatus: "ok",
      memoryProviderSource: "mem0",
      memoryRetrievalLimited: false,
      memoryRetrievalEventIds: ["mem0:test"],
      memoryRetrievalDroppedCount: 0,
      memoryFallbackUsed: false
    });
  });

  it("continues with an empty prompt context for provider empty", async () => {
    const provider = createProvider(outcome("empty"));
    const legacy = vi.fn(async () => legacyResult("legacy should not be read"));
    const { runtime, buildPrompt } = createRuntime(createMemory(provider, legacy));

    await expect(
      runtime.handleUserMessage(
        { sessionId: "session-empty", content: "No memory?" },
        { readMemory: true, writeMemory: false }
      )
    ).resolves.toBeDefined();

    expect(legacy).not.toHaveBeenCalled();
    expect(buildPrompt.mock.calls[0]?.[0].retrievedMemories).toEqual([]);
    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "empty",
      memoryFinalStatus: "empty",
      memoryFallbackUsed: false
    });
  });

  it("uses partial provider results without legacy fallback", async () => {
    const provider = createProvider(outcome("partial", [event("Partial memory")], "TOP_K_CAP"));
    const legacy = vi.fn(async () => legacyResult("legacy should not be read"));
    const { runtime, buildPrompt } = createRuntime(createMemory(provider, legacy));

    await runtime.handleUserMessage(
      { sessionId: "session-partial", content: "Partial retrieval" },
      { readMemory: true, writeMemory: false }
    );

    expect(legacy).not.toHaveBeenCalled();
    expect(buildPrompt.mock.calls[0]?.[0].retrievedMemories).toMatchObject([
      { content: "Partial memory", provenanceId: "mem0:test" }
    ]);
    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "partial",
      memoryProviderErrorCode: "TOP_K_CAP",
      memoryFallbackUsed: false
    });
  });

  it("drops a current-turn echo from the prompt while retaining its event id", async () => {
    const provider = createProvider(outcome("ok", [event("用户喜欢蓝色")]));
    const legacy = vi.fn(async () => legacyResult("legacy should not be read"));
    const { runtime, buildPrompt } = createRuntime(createMemory(provider, legacy));

    await runtime.handleUserMessage(
      { sessionId: "session-echo", content: "我喜欢蓝色" },
      { readMemory: true, writeMemory: false }
    );

    expect(buildPrompt.mock.calls[0]?.[0].retrievedMemories).toEqual([]);
    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryFinalStatus: "ok",
      memoryRetrievalEventIds: ["mem0:test"],
      memoryRetrievalDroppedCount: 1,
      memoryRetrievalDropped: [{ id: "mem0:test", reason: "current_turn_echo", source: "mem0" }]
    });
  });

  it("marks the legacy path explicitly when no semantic provider is configured", async () => {
    const legacy = vi.fn(async () => legacyResult("legacy-only memory"));
    const { runtime } = createRuntime(createMemory(undefined, legacy));

    await runtime.handleUserMessage(
      { sessionId: "session-legacy", content: "Legacy mode" },
      { readMemory: true, writeMemory: false }
    );

    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryFallbackUsed: true,
      memoryFinalStatus: "ok",
      memoryFallbackProducedResults: true,
      memoryFallbackSource: "legacy",
      memoryFallbackReason: "provider-not-configured"
    });
  });

  it("preserves unavailable status while explicitly falling back to legacy retrieval", async () => {
    const provider = createProvider(outcome("unavailable", [], "OPERATION_TIMEOUT"));
    const legacy = vi.fn(async () => legacyResult("legacy compatibility memory"));
    const { runtime, buildPrompt } = createRuntime(createMemory(provider, legacy));

    await runtime.handleUserMessage(
      { sessionId: "session-fallback", content: "Use fallback" },
      { readMemory: true, writeMemory: false }
    );

    expect(legacy).toHaveBeenCalledOnce();
    expect(buildPrompt.mock.calls[0]?.[0].retrievedMemories).toMatchObject([
      { content: "legacy compatibility memory" }
    ]);
    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "unavailable",
      memoryFinalStatus: "ok",
      memoryFallbackProducedResults: true,
      memoryProviderErrorCode: "OPERATION_TIMEOUT",
      memoryFallbackUsed: true,
      memoryFallbackSource: "legacy",
      memoryFallbackReason: "OPERATION_TIMEOUT"
    });
  });

  it("fails closed on provider errors without legacy fallback", async () => {
    const provider = createProvider(outcome("error", [], "MEMORY_PROVIDER_ERROR"));
    const legacy = vi.fn(async () => legacyResult("legacy after provider error"));
    const { runtime, buildPrompt } = createRuntime(createMemory(provider, legacy));

    await runtime.handleUserMessage(
      { sessionId: "session-error", content: "Provider error" },
      { readMemory: true, writeMemory: false }
    );

    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "error",
      memoryProviderErrorCode: "MEMORY_PROVIDER_ERROR",
      memoryFinalStatus: "error",
      memoryFallbackUsed: false
    });
    expect(buildPrompt.mock.calls[0]?.[0].retrievedMemories).toEqual([]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("does not let a real Service → Core scope mismatch enter legacy fallback", async () => {
    const requestedScope = buildMemoryScope("user-a", "alice");
    const foreignScope = buildMemoryScope("user-b", "alice");
    const search = vi.fn(async () => [
      {
        id: "foreign",
        content: "foreign scope memory",
        scope: foreignScope,
        metadata: {},
        score: 0.9
      }
    ]);
    const backend: MemoryBackend = {
      kind: "mem0",
      health: vi.fn(),
      add: vi.fn(),
      search,
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      history: vi.fn()
    } as MemoryBackend;
    const { runtime, buildPrompt } = createRuntime(createMem0Service(backend));

    await runtime.handleUserMessage(
      { sessionId: "scope-a", content: "recall", subjectUserId: "user-a", personaId: "alice" },
      { readMemory: true, writeMemory: false }
    );

    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ scope: requestedScope }),
      undefined
    );
    expect(buildPrompt.mock.calls[0]?.[0].retrievedMemories).toEqual([]);
    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "error",
      memoryProviderErrorCode: "MEMORY_SCOPE_MISMATCH",
      memoryFallbackUsed: false,
      memoryFinalStatus: "error"
    });
  });

  it("keeps unavailable fallback but fails closed if its legacy Mem0 result crosses scope", async () => {
    const foreignScope = buildMemoryScope("user-b", "alice");
    const backend: MemoryBackend = {
      kind: "mem0",
      health: vi.fn(),
      add: vi.fn(),
      search: vi.fn(async () => [
        {
          id: "foreign",
          content: "foreign scope memory",
          scope: foreignScope,
          metadata: {},
          score: 0.9
        }
      ]),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      history: vi.fn()
    } as MemoryBackend;
    const service = createMem0Service(backend);
    const unavailable = createProvider(outcome("unavailable", [], "OPERATION_TIMEOUT"));
    const memory: RuntimeMemoryPort = {
      getMemoryProvider: () => unavailable,
      retrieveRelevantMemories: service.retrieveRelevantMemories.bind(service),
      retrieveRelevantMemoriesWithMetadata:
        service.retrieveRelevantMemoriesWithMetadata.bind(service),
      scoreImportance: service.scoreImportance.bind(service),
      rememberInteraction: service.rememberInteraction.bind(service)
    };
    const { runtime, buildPrompt } = createRuntime(memory);

    await runtime.handleUserMessage(
      {
        sessionId: "scope-unavailable",
        content: "recall",
        subjectUserId: "user-a",
        personaId: "alice"
      },
      { readMemory: true, writeMemory: false }
    );

    expect(backend.search).toHaveBeenCalledOnce();
    expect(buildPrompt.mock.calls[0]?.[0].retrievedMemories).toEqual([]);
    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "unavailable",
      memoryProviderErrorCode: "OPERATION_TIMEOUT",
      memoryFallbackUsed: true,
      memoryFallbackReason: "MEMORY_SCOPE_MISMATCH"
    });
  });

  it("keeps provider unavailable diagnostics when legacy fallback also fails", async () => {
    const provider = createProvider(outcome("unavailable", [], "OPERATION_TIMEOUT"));
    const legacy = vi.fn(async () => {
      throw new Error("legacy database unavailable");
    });
    const { runtime } = createRuntime(createMemory(provider, legacy));

    await runtime.handleUserMessage(
      { sessionId: "session-double-failure", content: "Continue without memory" },
      { readMemory: true, writeMemory: false }
    );

    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "unavailable",
      memoryProviderErrorCode: "OPERATION_TIMEOUT",
      memoryFallbackUsed: true,
      memoryFallbackSource: "legacy"
    });
  });
});
