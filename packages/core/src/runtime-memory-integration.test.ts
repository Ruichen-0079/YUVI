import { InMemoryEventBus } from "@companion/event-bus";
import {
  InMemoryConversationRepository,
  type Memory,
  type MemoryCandidate
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  ProviderError,
  ProviderErrorCode,
  createMockAssistantContinuationProvider,
  type ChatStreamEvent,
  type ChatOutput,
  type ChatProvider,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider,
  type ChatInput,
  type ChatStreamOptions
} from "@companion/providers";
import { createEvent, type RuntimeEvent } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import { RuntimeOrchestrator, type RuntimeMemoryPort } from "./index.js";

describe("RuntimeOrchestrator", () => {
  it("restores published answer tails and multiline code within the conversation budget", async () => {
    const conversation = new InMemoryConversationRepository();
    const sessionId = "published-tail";
    const code =
      "```python\n" +
      Array.from({ length: 120 }, (_, i) => `value_${i} = ${i}\n`).join("") +
      "# confirmation: PUBLISHED_TAIL_852\n```";
    await conversation.ensureSession(sessionId);
    for (const [index, entry] of [
      { role: "user" as const, content: "Write the test code and its confirmation." },
      { role: "assistant" as const, content: code }
    ].entries()) {
      await conversation.appendMessage({
        id: `published-tail-${index}`,
        sessionId,
        traceId: "published-tail-trace",
        parentMessageId: null,
        role: entry.role,
        content: entry.content,
        status: "completed",
        createdAt: "2026-10-10T00:00:00.000Z",
        completedAt: "2026-10-10T00:00:00.000Z",
        metadata: {}
      });
    }
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await runtime.handleUserMessage(
      { sessionId, content: "What confirmation did you give?" },
      { readMemory: false, writeMemory: false }
    );
    const direct = runtime
      .getLatestPromptPreview()
      ?.sections.find((section) => section.name === "DirectContext");
    expect(direct?.content).toContain(code);
    expect(direct?.content).toContain("PUBLISHED_TAIL_852");
    expect(direct?.content.length).toBeLessThanOrEqual(6000);
    await runtime.sealAndDrainMemoryWrites();
  });

  it("publishes no reply events when every chat provider fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const providers = createMockProviders();
    providers.getChatProvider = () => ({
      name: "failing-chat",
      async healthCheck() {
        return {
          provider: "failing-chat",
          status: "unavailable" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async generateReply() {
        throw new ProviderError({
          provider: "failing-chat",
          capability: "chat",
          code: ProviderErrorCode.ProviderUnavailable,
          message: "Chat provider is unavailable."
        });
      }
    });

    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      promptBuilder: new PromptBuilder(),
      providers
    });

    await expect(
      runtime.handleUserMessage({ sessionId: "failed-session", content: "hello" })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
    expect(published.filter((event) => event.type === "provider.error")).toHaveLength(1);
  });

  it("publishes one assistant message when memory retrieval fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const memory = createRecordingMemory([]);
    memory.retrieveRelevantMemoriesWithMetadata = async () => {
      throw new Error("memory read unavailable");
    };
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "read-failed-session",
      content: "hello"
    });

    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
    expect(published.find((event) => event.type === "assistant.message")?.payload).toMatchObject({
      content: reply!.payload.content
    });
    expect(published.filter((event) => event.type === "runtime.error")).toHaveLength(1);
  });

  it("restores direct context from the repository when a Runtime is rebuilt", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtimeA = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await runtimeA.handleUserMessage(
      { sessionId: "persisted-session", content: "remember this direct context" },
      { readMemory: false, writeMemory: false }
    );

    const runtimeB = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await runtimeB.handleUserMessage(
      { sessionId: "persisted-session", content: "what did I say?" },
      { readMemory: false, writeMemory: false }
    );

    const restored = runtimeB
      .getLatestPromptPreview()
      ?.sections.find((section) => section.name === "DirectContext");
    expect(restored?.content).toContain("remember this direct context");

    const isolated = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await isolated.handleUserMessage(
      { sessionId: "other-session", content: "isolated" },
      { readMemory: false, writeMemory: false }
    );
    expect(
      isolated
        .getLatestPromptPreview()
        ?.sections.find((section) => section.name === "DirectContext")?.content
    ).not.toContain("remember this direct context");
  });

  it("blocks provider execution when the user message cannot be persisted", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let providerCalls = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation: {
        kind: "in-memory",
        async healthCheck() {
          return { status: "healthy" as const };
        },
        async ensureSession() {
          throw new Error("session store unavailable");
        },
        async appendMessage() {
          throw new Error("unreachable");
        },
        async appendMessageContent() {
          throw new Error("unreachable");
        },
        async completeMessage() {
          throw new Error("unreachable");
        },
        async failMessage() {
          throw new Error("unreachable");
        },
        async listRecentMessages() {
          return [];
        }
      },
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => {
          providerCalls += 1;
          return createMockProviders().getChatProvider();
        }
      }
    });

    await expect(
      runtime.handleUserMessage({ sessionId: "save-failed", content: "hello" })
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "session_create"
    });
    expect(providerCalls).toBe(0);
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
    expect(published.find((event) => event.type === "runtime.error")?.payload).toMatchObject({
      category: "persistence",
      operation: "session_create"
    });
  });

  it("does not publish or cache an assistant message when assistant persistence fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let appends = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation: {
        kind: "in-memory",
        async healthCheck() {
          return { status: "healthy" as const };
        },
        async ensureSession() {},
        async appendMessage(message) {
          appends += 1;
          if (appends > 1) {
            throw new Error("assistant store unavailable");
          }
          return { ...message, sequence: 1 };
        },
        async appendMessageContent() {
          throw new Error("unreachable");
        },
        async completeMessage() {
          throw new Error("unreachable");
        },
        async failMessage() {
          throw new Error("unreachable");
        },
        async listRecentMessages() {
          return [];
        }
      },
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await expect(
      runtime.handleUserMessage({
        sessionId: "assistant-save-failed",
        content: "hello"
      })
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_message_save"
    });
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(1);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("uses memory extractor candidates for runtime writes and skips ordinary turns", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const written: MemoryCandidate[] = [];
    const extractionInputs: string[] = [];
    const groundingContexts: Array<{ sourceJournalRef: unknown; sourceText: string } | undefined> =
      [];
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: {
        async retrieveRelevantMemories() {
          return [];
        },
        scoreImportance() {
          return 0;
        },
        async extractCandidates(input) {
          extractionInputs.push(input.userMessage);
          if (input.userMessage.startsWith("记住")) {
            return [
              {
                type: "semantic",
                subtype: "path",
                content: "我的项目路径是 /home/administrator/uv-main/uv-main",
                summary: "我的项目路径是 /home/administrator/uv-main/uv-main",
                importance: 0.95,
                tags: ["path"],
                reason: "explicit-remember",
                sourceTraceId: input.sourceTraceId ?? null
              }
            ];
          }
          if (input.userMessage.startsWith("secret metadata")) {
            return [
              {
                type: "semantic",
                subtype: "fact",
                content: "apiKey=sk-super-secret should be redacted",
                summary: "authorization: Bearer secret should be redacted",
                importance: 0.2,
                tags: ["token=secret"],
                reason: "low-quality-secret-test",
                sourceTraceId: input.sourceTraceId ?? null,
                metadata: {
                  apiKey: "sk-super-secret",
                  nested: { authorization: "Bearer secret" }
                }
              }
            ];
          }
          return [];
        },
        async processCandidateForStorage(candidate, _options, groundingContext) {
          groundingContexts.push(groundingContext);
          if (!groundingContext) {
            return {
              decision: "rejected" as const,
              candidate,
              rejectedReason: "missing-committed-source"
            };
          }
          if (candidate.importance < 0.65) {
            return {
              decision: "rejected" as const,
              candidate,
              rejectedReason: `runtime-threshold:${candidate.reason}`
            };
          }
          written.push(candidate);
          return {
            decision: "stored" as const,
            candidate,
            memory: createMemory(candidate),
            storageReason: "test-grounded-boundary"
          };
        },
        async rememberInteraction(): Promise<Memory> {
          throw new Error("legacy memory write should not be used");
        }
      },
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await runtime.handleUserMessage(
      createEvent("user.message", {
        sessionId: "test-session",
        content: "hi",
        sourceJournalRef: {
          kind: "JOURNAL_EVENT",
          namespace: "runtime-memory-test",
          eventId: "jev1_1111111111111111"
        }
      })
    );
    await runtime.handleUserMessage({
      sessionId: "test-session",
      content: "记住：unreceipted input must not become legacy evidence"
    });
    await runtime.handleUserMessage(
      createEvent("user.message", {
        sessionId: "test-session",
        content: "记住：这个不应该写入，因为 writeMemory=false",
        sourceJournalRef: {
          kind: "JOURNAL_EVENT",
          namespace: "runtime-memory-test",
          eventId: "jev1_2222222222222222"
        }
      }),
      {
        writeMemory: false
      }
    );
    const reply = await runtime.handleUserMessage(
      createEvent("user.message", {
        sessionId: "test-session",
        content: "记住：我的项目路径是 /home/administrator/uv-main/uv-main",
        sourceJournalRef: {
          kind: "JOURNAL_EVENT",
          namespace: "runtime-memory-test",
          eventId: "jev1_3333333333333333"
        }
      })
    );
    await runtime.handleUserMessage(
      createEvent("user.message", {
        sessionId: "test-session",
        content: "secret metadata candidate",
        sourceJournalRef: {
          kind: "JOURNAL_EVENT",
          namespace: "runtime-memory-test",
          eventId: "jev1_4444444444444444"
        }
      })
    );

    expect(extractionInputs).toEqual([
      "hi",
      "记住：unreceipted input must not become legacy evidence",
      "记住：我的项目路径是 /home/administrator/uv-main/uv-main",
      "secret metadata candidate"
    ]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      type: "semantic",
      subtype: "path",
      reason: "explicit-remember",
      sourceTraceId: reply!.traceId
    });
    expect(groundingContexts).toHaveLength(3);
    expect(groundingContexts[0]).toBeUndefined();
    expect(groundingContexts[1]).toMatchObject({
      sourceJournalRef: {
        kind: "JOURNAL_EVENT",
        namespace: "runtime-memory-test",
        eventId: "jev1_3333333333333333"
      },
      sourceText: "记住：我的项目路径是 /home/administrator/uv-main/uv-main"
    });
    expect(groundingContexts[2]?.sourceJournalRef).toMatchObject({
      kind: "JOURNAL_EVENT",
      namespace: "runtime-memory-test",
      eventId: "jev1_4444444444444444"
    });
    const history = runtime.getRecentMemoryCandidates(5);
    expect(history.some((candidate) => candidate.decision === "stored")).toBe(true);
    const rejected = history.find((candidate) => candidate.reason === "low-quality-secret-test");
    expect(rejected).toMatchObject({
      decision: "rejected",
      rejectedReason: "runtime-threshold:low-quality-secret-test"
    });
    expect(JSON.stringify(rejected)).not.toContain("sk-super-secret");
    expect(JSON.stringify(rejected)).not.toContain("Bearer secret");
  });

  it("revalidates dashboard acceptance against private host grounding context", async () => {
    const sourceText = "Remember that I prefer concise technical answers.";
    const sourceJournalRef = {
      kind: "JOURNAL_EVENT" as const,
      namespace: "runtime-memory-test",
      eventId: "jev1_6666666666666666"
    };
    const candidate: MemoryCandidate = {
      type: "semantic",
      subtype: "preference",
      content: "I prefer concise technical answers.",
      summary: "I prefer concise technical answers.",
      importance: 0.92,
      tags: [],
      reason: "explicit-remember"
    };
    const groundingContexts: Array<{ sourceJournalRef: unknown; sourceText: string } | undefined> =
      [];
    const memory = createRecordingMemory([]);
    memory.extractCandidates = async () => [candidate];
    memory.processCandidateForStorage = async (proposed, options, groundingContext) => {
      groundingContexts.push(groundingContext);
      if (!options?.skipAdmissionPolicy) {
        return {
          decision: "rejected",
          candidate: proposed,
          rejectedReason: "awaiting-review"
        };
      }
      return {
        decision: "stored",
        candidate: proposed,
        memory: createMemory(proposed),
        storageReason: "manual-accept"
      };
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await runtime.handleUserMessage(
      createEvent("user.message", {
        sessionId: "candidate-review",
        content: sourceText,
        sourceJournalRef
      })
    );
    const review = runtime.getRecentMemoryCandidates(1)[0];
    expect(review?.decision).toBe("rejected");
    expect(groundingContexts[0]).toEqual({ sourceJournalRef, sourceText });

    await expect(
      runtime.acceptMemoryCandidate(review!.id, { content: "I prefer astronomy." })
    ).resolves.toBeNull();
    expect(groundingContexts).toHaveLength(1);

    const accepted = await runtime.acceptMemoryCandidate(review!.id, {
      sourceJournalRef: {
        kind: "JOURNAL_EVENT",
        namespace: "attacker-controlled",
        eventId: "jev1_aaaaaaaaaaaaaaaa"
      },
      lineage: { state: "GROUNDED" },
      consumerKey: "attacker-controlled"
    } as never);
    expect(accepted?.alreadyStored).toBe(false);
    expect(groundingContexts).toHaveLength(2);
    expect(groundingContexts[1]).toEqual({ sourceJournalRef, sourceText });
  });

  it("injects bounded same-session DirectContext without mixing unrelated sessions", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const written: MemoryCandidate[] = [];
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory(written),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders(),
      directContext: {
        enabled: true,
        maxTurns: 1,
        maxChars: 220
      }
    });

    await runtime.handleUserMessage(
      {
        sessionId: "session-a",
        content: "First context turn with token=super-secret-value"
      },
      { writeMemory: false }
    );
    await runtime.handleUserMessage(
      {
        sessionId: "session-b",
        content: "Unrelated session content should not appear"
      },
      { writeMemory: false }
    );
    await runtime.handleUserMessage(
      {
        sessionId: "session-a",
        content: "Second context turn"
      },
      { writeMemory: false }
    );
    const secondPreview = runtime.getLatestPromptPreview();
    const directContext = secondPreview?.sections.find(
      (section) => section.name === "DirectContext"
    );
    const relevantMemory = secondPreview?.sections.find(
      (section) => section.name === "RelevantMemory"
    );

    expect(directContext?.content).toContain("First context turn");
    expect(directContext?.content).not.toContain("super-secret-value");
    expect(directContext?.content).not.toContain("Unrelated session content");
    expect(relevantMemory?.content).toBe("No relevant memory retrieved.");
    expect(secondPreview).toMatchObject({
      directContextEnabled: true,
      directContextTurnCount: 1,
      directContextTruncated: false,
      directContextSource: "session-turns"
    });
    expect(secondPreview?.directContextCharCount).toBeGreaterThan(0);
    expect(written).toHaveLength(0);

    await runtime.handleUserMessage(
      {
        sessionId: "session-a",
        content: "Third context turn"
      },
      { writeMemory: false }
    );
    const thirdPreview = runtime.getLatestPromptPreview();
    const thirdDirectContext = thirdPreview?.sections.find(
      (section) => section.name === "DirectContext"
    );
    expect(thirdDirectContext?.content).not.toContain("First context turn");
    expect(thirdDirectContext?.content).toContain("Second context turn");
    expect(thirdPreview?.directContextTruncated).toBe(true);
  });
});

function createRecordingMemory(written: MemoryCandidate[]): RuntimeMemoryPort {
  return {
    async retrieveRelevantMemories() {
      return [];
    },
    async retrieveRelevantMemoriesWithMetadata() {
      return {
        query: "",
        keywords: [],
        rawCount: 0,
        count: 0,
        retrievalMode: "keyword",
        vectorEnabled: false,
        vectorUsed: false,
        queryEmbeddingGenerated: false,
        vectorResultCount: 0,
        keywordResultCount: 0,
        hybridResultCount: 0,
        fallbackUsed: false,
        retrievalScope: "user,project:yuvi-runtime",
        includedScopes: [{ scope: "user" }, { scope: "project", scopeId: "yuvi-runtime" }],
        includeArchived: false,
        includeSuperseded: false,
        includeExpired: false,
        currentTime: new Date().toISOString(),
        excludedByStatus: 0,
        excludedByTime: 0,
        excludedByScope: 0,
        rawMemories: [],
        memories: [],
        selectedMemories: []
      };
    },
    scoreImportance() {
      return 0;
    },
    async extractCandidates() {
      return [];
    },
    async rememberCandidate(candidate): Promise<Memory> {
      written.push(candidate);
      return createMemory(candidate);
    },
    async rememberInteraction(): Promise<Memory | null> {
      return null;
    }
  };
}

function createMockProviders() {
  return {
    getChatProvider: () => createAssistantAwareChatProvider(createMockChatProvider("mock-chat")),
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider("REQUEST_TEXT"),
    getAssistantContinuationProvider: () =>
      createMockAssistantContinuationProvider("Mock proactive continuation."),
    getReasoningProvider: () => createMockReasoningProvider("mock-reasoning"),
    getTTSProvider: () => ({
      name: "mock-tts",
      async healthCheck() {
        return {
          provider: "mock-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech() {
        return {
          audio: new Uint8Array(),
          audioBase64: "",
          mimeType: "audio/wav",
          durationMs: 0
        };
      }
    }),
    getSTTProvider: () => createMockSTTProvider("mock-stt"),
    getVisionProvider: () => createMockVisionProvider("mock-vision"),
    getEmbeddingProvider: () => ({
      name: "mock-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "mock-embedding",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async embedText() {
        return [0, 0, 0];
      },
      async embedBatch(texts: string[]) {
        return texts.map(() => [0, 0, 0]);
      }
    })
  };
}

function createAssistantAwareChatProvider(provider: ChatProvider): ChatProvider {
  return {
    ...provider,
    async generateReply(input: ChatInput, options?: ChatStreamOptions): Promise<ChatOutput> {
      const output = await provider.generateReply(input, options);
      return isAssistantInitiatedInput(input) ? withProactiveControl(output) : output;
    },
    async *streamReply(
      input: ChatInput,
      options?: ChatStreamOptions
    ): AsyncIterable<ChatStreamEvent> {
      const proactive = isAssistantInitiatedInput(input);
      let controlEmitted = false;
      const stream = provider.streamReply
        ? provider.streamReply(input, options)
        : (async function* (): AsyncIterable<ChatStreamEvent> {
            const output = await provider.generateReply(input, options);
            if (output.message.content) {
              yield { type: "text-delta", text: output.message.content };
            }
            yield { type: "completed", output };
          })();
      for await (const event of stream) {
        if (!proactive) {
          yield event;
          continue;
        }
        if (event.type === "text-delta") {
          if (!controlEmitted) {
            controlEmitted = true;
            yield { type: "text-delta", text: "REQUEST_TEXT\n" };
          }
          yield event;
          continue;
        }
        if (!controlEmitted) {
          controlEmitted = true;
          yield { type: "text-delta", text: "REQUEST_TEXT\n" };
        }
        yield {
          ...event,
          output: withProactiveControl(event.output)
        };
      }
    }
  };
}

function isAssistantInitiatedInput(input: ChatInput): boolean {
  return input.metadata?.["turnOrigin"] === "assistant-initiated";
}

function withProactiveControl(output: ChatOutput): ChatOutput {
  return {
    ...output,
    message: {
      ...output.message,
      content: `REQUEST_TEXT\n${output.message.content}`
    }
  };
}

function createMemory(candidate: MemoryCandidate): Memory {
  const now = new Date();
  return {
    id: "memory-id",
    type: candidate.type,
    subtype: candidate.subtype ?? null,
    scope: candidate.scope ?? "user",
    scopeId: candidate.scopeId ?? null,
    memoryLayer: candidate.memoryLayer ?? "core",
    status: "active",
    content: candidate.content,
    summary: candidate.summary ?? null,
    embedding: null,
    embeddingModel: null,
    embeddingProvider: null,
    embeddingDimensions: null,
    embeddedAt: null,
    importance: candidate.importance,
    emotionValence: 0,
    emotionArousal: 0,
    source: "runtime",
    sourceTraceId: candidate.sourceTraceId ?? null,
    metadata: {},
    tags: candidate.tags,
    createdAt: now,
    updatedAt: now,
    observedAt: candidate.observedAt ? new Date(candidate.observedAt) : now,
    eventTime: null,
    validFrom: now,
    validUntil: null,
    expiresAt: null,
    lastAccessedAt: now,
    supersededAt: null,
    supersedes: [],
    supersededBy: null,
    contradicts: []
  };
}
