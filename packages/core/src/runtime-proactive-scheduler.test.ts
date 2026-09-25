import { InMemoryEventBus } from "@companion/event-bus";
import { InMemoryConversationRepository } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createMockAssistantContinuationProvider,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider,
  type AssistantContinuationInput,
  type ProactiveDecisionInput
} from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import {
  PROACTIVE_NO_OP_BACKOFF_MS,
  RuntimeOrchestrator,
  SpeechCaptureFenceError,
  type RuntimeCharacterPort,
  type RuntimeMemoryPort,
  type RuntimeReplyStreamEvent
} from "./index.js";

function memoryStub(): RuntimeMemoryPort {
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
        retrievalScope: "user",
        includedScopes: [{ scope: "user" }],
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
    async rememberCandidate() {
      throw new Error("proactive scheduler must not write Memory");
    },
    async rememberInteraction() {
      return null;
    }
  };
}

function providers(decision: "NO_OP" | "REQUEST_TEXT" = "REQUEST_TEXT") {
  return {
    getChatProvider: () => createMockChatProvider("scheduler-chat"),
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider(decision),
    getAssistantContinuationProvider: () =>
      createMockAssistantContinuationProvider("scheduled hello"),
    getReasoningProvider: () => createMockReasoningProvider("scheduler-reasoning"),
    getTTSProvider: () => ({
      name: "scheduler-tts",
      async healthCheck() {
        return {
          provider: "scheduler-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech() {
        throw new Error("TTS must not run");
      }
    }),
    getSTTProvider: () => createMockSTTProvider("scheduler-stt"),
    getVisionProvider: () => createMockVisionProvider("scheduler-vision"),
    getEmbeddingProvider: () => ({
      name: "scheduler-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "scheduler-embedding",
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    },
    reject(reason?: unknown) {
      rejectPromise?.(reason);
    }
  };
}

async function collect(stream: AsyncIterable<RuntimeReplyStreamEvent>) {
  const events: RuntimeReplyStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Runtime proactive scheduler", () => {
  it("passes configured identity through an automatic scheduler wake into P8", async () => {
    const wakes: Array<() => void> = [];
    const loadCorrections = vi.fn(async () => ({ status: "UNAVAILABLE" as const }));
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      providers: providers(),
      proactiveConsentEnabled: true,
      p8CorrectionStore: {
        loadCorrections,
        loadCorrectionByReference: async () => ({ status: "UNAVAILABLE" as const }),
        appendCorrection: async () => ({ status: "UNAVAILABLE" as const })
      },
      setProactiveWake(callback) {
        wakes.push(callback);
        return wakes.length;
      },
      clearProactiveWake() {}
    });
    runtime.startProactiveScheduler({
      sessionId: "s",
      readMemory: false,
      personaId: "persona-a",
      subjectUserId: "person-a"
    });
    wakes[0]?.();
    await vi.waitFor(() =>
      expect(loadCorrections).toHaveBeenCalledWith(
        expect.objectContaining({
          address: expect.objectContaining({
            personaProfileId: "persona-a",
            subjectScopeId: "person-a"
          }),
          scopeReference: { reference: "yuvi:v1:user:person-a:character:persona-a" }
        })
      )
    );
    await runtime.sealAndDrainMemoryWrites();
  });

  it("does not call the decision provider while speech is active", async () => {
    let decided = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: {
        ...providers(),
        getProactiveDecisionProvider: () => ({
          name: "blocked-decision",
          async decide() {
            decided += 1;
            return { decision: "REQUEST_TEXT" as const, model: "blocked" };
          }
        })
      }
    });
    runtime.setProactiveConsent(true);
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-live", active: true });
    await expect(
      collect(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "s",
          idempotencyKey: "speech-gate",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ name: "ProactiveAdmissionError", reason: "not-eligible" });
    expect(decided).toBe(0);
  });

  it("drops when VAD becomes ACTIVE during the decision provider", async () => {
    const gate = deferred<void>();
    let started = false;
    let continued = 0;
    const startedAt = deferred<void>();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: {
        ...providers(),
        getProactiveDecisionProvider: () => ({
          name: "gated-decision",
          async decide() {
            started = true;
            startedAt.resolve();
            await gate.promise;
            return { decision: "REQUEST_TEXT" as const, model: "gated" };
          }
        }),
        getAssistantContinuationProvider: () => ({
          name: "gated-continuation",
          async generateContinuation() {
            continued += 1;
            return {
              message: { role: "assistant" as const, content: "should drop" },
              finishReason: "stop" as const
            };
          }
        })
      }
    });
    const pending = collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "vad-during-decision",
        readMemory: false
      })
    );
    await startedAt.promise;
    expect(started).toBe(true);
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-vad", active: true });
    gate.resolve();
    await expect(pending).rejects.toMatchObject({
      name: "ProactiveAdmissionError",
      reason: "stale-revision"
    });
    expect(continued).toBe(0);
  });

  it("drops when VAD becomes ACTIVE during text continuation", async () => {
    const gate = deferred<void>();
    const startedAt = deferred<void>();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: {
        ...providers(),
        getAssistantContinuationProvider: () => ({
          name: "gated-continuation",
          async generateContinuation() {
            startedAt.resolve();
            await gate.promise;
            return {
              message: { role: "assistant" as const, content: "stale continuation" },
              finishReason: "stop" as const
            };
          }
        })
      }
    });
    const pending = collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "vad-during-text",
        readMemory: false
      })
    );
    await startedAt.promise;
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-text", active: true });
    gate.resolve();
    await expect(pending).rejects.toMatchObject({
      name: "ProactiveAdmissionError",
      reason: "stale-revision"
    });
  });

  it("drops when an explicit user turn starts during generation", async () => {
    const gate = deferred<void>();
    const startedAt = deferred<void>();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: {
        ...providers(),
        getAssistantContinuationProvider: () => ({
          name: "gated-continuation",
          async generateContinuation() {
            startedAt.resolve();
            await gate.promise;
            return {
              message: { role: "assistant" as const, content: "stale after user" },
              finishReason: "stop" as const
            };
          }
        })
      }
    });
    const pending = collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "user-during-text",
        readMemory: false
      })
    );
    await startedAt.promise;
    await runtime.handleUserMessage(
      { sessionId: "s", content: "hello" },
      { readMemory: false, writeMemory: false }
    );
    gate.resolve();
    await expect(pending).rejects.toMatchObject({
      name: "ProactiveAdmissionError",
      reason: "stale-revision"
    });
  });

  it("drops when suppression changes during generation", async () => {
    const gate = deferred<void>();
    const startedAt = deferred<void>();
    const character: RuntimeCharacterPort = {
      async generate() {
        return {
          decision: {
            addressing: "DIRECTED_TO_YUVI",
            reply: { disposition: "RESPOND", text: "好" },
            proactive: { action: "SUPPRESS", scope: { kind: "UNTIL_ENGAGEMENT" } }
          },
          providerMetadata: { model: "suppress-character" }
        };
      },
      async generateAfterCognition() {
        throw new Error("cognition must not run");
      }
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      character,
      providers: {
        ...providers(),
        getAssistantContinuationProvider: () => ({
          name: "gated-continuation",
          async generateContinuation() {
            startedAt.resolve();
            await gate.promise;
            return {
              message: { role: "assistant" as const, content: "stale after suppress" },
              finishReason: "stop" as const
            };
          }
        })
      }
    });
    const pending = collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "suppress-during-text",
        readMemory: false
      })
    );
    await startedAt.promise;
    await runtime.handleUserMessage(
      { sessionId: "s", content: "安静" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });
    gate.resolve();
    await expect(pending).rejects.toMatchObject({
      name: "ProactiveAdmissionError",
      reason: "stale-revision"
    });
    const reactive = await runtime.handleUserMessage(
      { sessionId: "s", content: "还在吗" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(reactive).not.toBeNull();
  });

  it("uses a fixed evaluation interval without mutating quiet policy on low scores", async () => {
    let now = 1_000;
    let decided = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      now: () => now,
      proactiveConsentEnabled: true,
      providers: {
        ...providers(),
        getProactiveDecisionProvider: () => ({
          name: "noop-decision",
          async decide(_input: ProactiveDecisionInput) {
            decided += 1;
            return { decision: "NO_OP" as const, model: "noop" };
          }
        })
      }
    });
    await collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "noop-1",
        readMemory: false
      })
    );
    expect(decided).toBe(1);
    expect(runtime.getProactiveState().eligibleAfterMs).toBe(0);
    await expect(
      collect(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "s",
          idempotencyKey: "noop-2",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ name: "ProactiveAdmissionError", reason: "not-eligible" });
    expect(decided).toBe(1);
    now += 60_000;
    await collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "noop-3",
        readMemory: false
      })
    );
    expect(decided).toBe(2);
  });

  it("collapses overlapping scheduler wakeups into one in-flight attempt", async () => {
    const gate = deferred<void>();
    const startedAt = deferred<void>();
    let decided = 0;
    const wakes: Array<() => void> = [];
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      proactiveConsentEnabled: true,
      setProactiveWake(callback) {
        wakes.push(callback);
        return wakes.length;
      },
      clearProactiveWake() {},
      providers: {
        ...providers(),
        getProactiveDecisionProvider: () => ({
          name: "one-flight",
          async decide() {
            decided += 1;
            startedAt.resolve();
            await gate.promise;
            return { decision: "NO_OP" as const, model: "one-flight" };
          }
        })
      }
    });
    runtime.startProactiveScheduler({ sessionId: "s", readMemory: false });
    expect(wakes).toHaveLength(1);
    const first = wakes[0];
    first?.();
    await startedAt.promise;
    first?.();
    wakes[1]?.();
    await Promise.resolve();
    expect(decided).toBe(1);
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(decided).toBe(1);
  });

  it("commits one assistant-initiated message with decision provenance and no synthetic user", async () => {
    const conversation = new InMemoryConversationRepository();
    const published: string[] = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("*", (event) => {
      published.push(event.type);
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation,
      providers: {
        ...providers(),
        getAssistantContinuationProvider: () => ({
          name: "prov-continuation",
          async generateContinuation(_input: AssistantContinuationInput) {
            return {
              message: { role: "assistant" as const, content: "one message" },
              finishReason: "stop" as const
            };
          }
        })
      }
    });
    const startedRevision = runtime.getProactiveState().activityRevision;
    await collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "provenance-1",
        readMemory: false
      })
    );
    const messages = await conversation.listRecentMessages("s");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "one message",
      sourceUserEventId: null,
      metadata: {
        origin: "assistant-initiated",
        idempotencyKey: "provenance-1",
        decision: "REQUEST_TEXT",
        activityRevision: startedRevision
      }
    });
    expect(messages[0]?.metadata?.["decisionId"]).toEqual(expect.any(String));
    expect(published).not.toContain("user.message");
    await expect(
      collect(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "s",
          idempotencyKey: "provenance-1",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ name: "AssistantTurnConflictError" });
  });

  it("does not treat a duplicate capture fence as a scheduler start", () => {
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: providers()
    });
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-a", active: true });
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-b", active: true });
    expect(() =>
      runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-a", active: true })
    ).toThrow(SpeechCaptureFenceError);
  });
});
