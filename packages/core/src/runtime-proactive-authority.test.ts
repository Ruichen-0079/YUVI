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
  type ProviderResolver
} from "@companion/providers";
import { describe, expect, it } from "vitest";
import {
  ProactiveAdmissionError,
  RuntimeOrchestrator,
  type RuntimeCharacterPort,
  type RuntimeCharacterTurnResult,
  type RuntimeMemoryPort,
  type RuntimeProactiveStateStore
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
      throw new Error("proactive policy tests must not write Memory");
    },
    async rememberInteraction() {
      return null;
    }
  };
}

function providers(decision: "NO_OP" | "REQUEST_TEXT" = "REQUEST_TEXT"): ProviderResolver {
  const chat = createMockChatProvider("policy-chat");
  return {
    getChatProvider: () => chat,
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider(decision),
    getAssistantContinuationProvider: () =>
      createMockAssistantContinuationProvider("proactive hello"),
    getReasoningProvider: () => createMockReasoningProvider("policy-reasoning"),
    getTTSProvider: () => ({
      name: "policy-tts",
      async healthCheck() {
        return {
          provider: "policy-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech() {
        throw new Error("TTS must not run");
      }
    }),
    getSTTProvider: () => createMockSTTProvider("policy-stt"),
    getVisionProvider: () => createMockVisionProvider("policy-vision"),
    getEmbeddingProvider: () => ({
      name: "policy-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "policy-embedding",
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

function characterPort(result: RuntimeCharacterTurnResult): RuntimeCharacterPort {
  return {
    async generate() {
      return result;
    },
    async generateAfterCognition() {
      throw new Error("cognition must not run");
    }
  };
}

function decision(input: {
  text?: string;
  proactive: RuntimeCharacterTurnResult["decision"]["proactive"];
}): RuntimeCharacterTurnResult {
  return {
    decision: {
      addressing: "DIRECTED_TO_YUVI",
      reply: { disposition: "RESPOND", text: input.text ?? "好" },
      proactive: input.proactive
    },
    providerMetadata: { model: "policy-character" }
  };
}

function memoryStore(): RuntimeProactiveStateStore {
  let snapshot: ReturnType<RuntimeProactiveStateStore["load"]> = null;
  return {
    load() {
      return snapshot;
    },
    save(next) {
      snapshot = next;
    }
  };
}

function createRuntime(input: {
  nowMs: { current: number };
  store?: RuntimeProactiveStateStore;
  character?: RuntimeCharacterPort;
  consent?: boolean;
  projectionRequired?: boolean;
  decision?: "NO_OP" | "REQUEST_TEXT";
}): RuntimeOrchestrator {
  return new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory: memoryStub(),
    promptBuilder: new PromptBuilder(),
    providers: providers(input.decision),
    conversation: new InMemoryConversationRepository(),
    now: () => input.nowMs.current,
    ...(input.consent === undefined ? {} : { proactiveConsentEnabled: input.consent }),
    ...(input.projectionRequired ? { proactiveConsentProjectionRequired: true } : {}),
    ...(input.store ? { proactiveStateStore: input.store } : {}),
    ...(input.character ? { character: input.character } : {})
  });
}

async function collect(
  stream: AsyncIterable<{ type: string; decision?: string; content?: string }>
): Promise<Array<{ type: string; decision?: string; content?: string }>> {
  const events: Array<{ type: string; decision?: string; content?: string }> = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("Runtime proactive policy authority", () => {
  it("ignores persisted consent in projection-required mode until a current settings view arrives", async () => {
    let saves = 0;
    const store: RuntimeProactiveStateStore = {
      load: () => ({
        version: 1,
        suppression: { kind: "NONE" },
        eligibleAfterMs: 0,
        consentEnabled: true
      }),
      save: () => {
        saves += 1;
      }
    };
    const runtime = createRuntime({
      nowMs: { current: Date.parse("2026-09-25T00:00:00Z") },
      store,
      projectionRequired: true
    });
    expect(runtime.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 0
    });
    expect(() => runtime.setProactiveConsent(true)).toThrow(/projection API/u);
    await expect(
      collect(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "s",
          idempotencyKey: "projection-startup-denied",
          readMemory: false
        })
      )
    ).rejects.toBeInstanceOf(ProactiveAdmissionError);
    expect(saves).toBe(0);

    expect(runtime.invalidateProactiveConsentProjection(7)).toBe("APPLIED");
    expect(saves).toBe(0);
    expect(
      runtime.applyProactiveConsentProjection({
        state: "READY",
        revision: 7,
        enabled: false
      })
    ).toBe("APPLIED");
    expect(saves).toBe(0);

    const restarted = createRuntime({
      nowMs: { current: Date.parse("2026-09-25T00:01:00Z") },
      store,
      projectionRequired: true
    });
    expect(restarted.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 0
    });
    await expect(
      collect(
        restarted.streamAssistantInitiatedTurn({
          sessionId: "s",
          idempotencyKey: "projection-restart-denied",
          readMemory: false
        })
      )
    ).rejects.toBeInstanceOf(ProactiveAdmissionError);
  });

  it("fences stale READY projections and rejects same-revision conflicts", () => {
    const runtime = createRuntime({
      nowMs: { current: Date.parse("2026-09-25T00:00:00Z") },
      projectionRequired: true
    });
    expect(
      runtime.preflightProactiveConsentProjection({
        state: "READY",
        revision: 10,
        enabled: true
      })
    ).toEqual({ result: "APPLY" });
    expect(
      runtime.applyProactiveConsentProjection({
        state: "READY",
        revision: 10,
        enabled: true
      })
    ).toBe("APPLIED");
    expect(
      runtime.preflightProactiveConsentProjection({
        state: "READY",
        revision: 10,
        enabled: true
      })
    ).toEqual({ result: "ALREADY_CURRENT" });
    expect(
      runtime.preflightProactiveConsentProjection({
        state: "READY",
        revision: 10,
        enabled: false
      })
    ).toEqual({ result: "CONFLICT" });
    expect(runtime.invalidateProactiveConsentProjection(11)).toBe("APPLIED");
    expect(
      runtime.preflightProactiveConsentProjection({
        state: "READY",
        revision: 10,
        enabled: true
      })
    ).toEqual({ result: "STALE" });
    expect(
      runtime.applyProactiveConsentProjection({
        state: "READY",
        revision: 11,
        enabled: true
      })
    ).toBe("APPLIED");
    expect(runtime.getProactiveConsentProjection()).toEqual({
      state: "READY",
      revision: 11,
      enabled: true
    });
  });

  it("carries the volatile projection and revision fence across in-process Runtime replacement", () => {
    const nowMs = { current: Date.parse("2026-09-25T00:00:00Z") };
    const previous = createRuntime({ nowMs, projectionRequired: true });
    expect(
      previous.applyProactiveConsentProjection({
        state: "READY",
        revision: 10,
        enabled: true
      })
    ).toBe("APPLIED");
    const replacement = createRuntime({ nowMs, projectionRequired: true });
    replacement.adoptProactiveConsentProjection(previous);
    expect(replacement.getProactiveConsentProjection()).toEqual({
      state: "READY",
      revision: 10,
      enabled: true
    });
    expect(replacement.invalidateProactiveConsentProjection(11)).toBe("APPLIED");
    expect(
      replacement.applyProactiveConsentProjection({
        state: "READY",
        revision: 10,
        enabled: true
      })
    ).toBe("STALE");
  });

  it("commits a quiet-five-minutes reply and blocks only future proactive initiation", async () => {
    const nowMs = { current: Date.parse("2026-09-05T12:00:00Z") };
    const runtime = createRuntime({
      nowMs,
      character: characterPort(
        decision({
          proactive: { action: "SUPPRESS", scope: { kind: "UNTIL", duration: "PT5M" } }
        })
      )
    });

    const reply = await runtime.handleUserMessage(
      { sessionId: "s", content: "安静五分钟" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(reply?.payload.content).toBe("好");
    expect(runtime.getProactiveState().suppression).toEqual({
      kind: "UNTIL",
      untilMs: nowMs.current + 5 * 60 * 1000
    });

    await expect(
      collect(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "s",
          idempotencyKey: "p1",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ name: "ProactiveAdmissionError", reason: "suppressed" });

    const later = await runtime.handleUserMessage(
      { sessionId: "s", content: "几点了？" },
      {
        controlAuthority: "LOCAL_EXPLICIT_CONTROLLER",
        readMemory: false,
        writeMemory: false
      }
    );
    expect(later?.payload.content).toBe("好");
    expect(runtime.getProactiveState().suppression.kind).toBe("UNTIL");
  });

  it("expires UNTIL(time) by injected clock without sleeping", async () => {
    const nowMs = { current: Date.parse("2026-09-05T12:00:00Z") };
    const runtime = createRuntime({
      nowMs,
      character: characterPort(
        decision({
          proactive: { action: "SUPPRESS", scope: { kind: "UNTIL", time: "2026-09-05T12:05:00Z" } }
        })
      )
    });
    await runtime.handleUserMessage(
      { sessionId: "s", content: "quiet" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    await expect(
      collect(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "s",
          idempotencyKey: "before",
          readMemory: false
        })
      )
    ).rejects.toBeInstanceOf(ProactiveAdmissionError);

    nowMs.current = Date.parse("2026-09-05T12:05:00Z");
    const events = await collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "after",
        readMemory: false
      })
    );
    expect(events[0]).toMatchObject({ type: "proactive-decision", decision: "REQUEST_TEXT" });
  });

  it("clears UNTIL_ENGAGEMENT only on authorized explicit engagement", async () => {
    const nowMs = { current: Date.parse("2026-09-05T12:00:00Z") };
    let proposal: RuntimeCharacterTurnResult["decision"]["proactive"] = {
      action: "SUPPRESS",
      scope: { kind: "UNTIL_ENGAGEMENT" }
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      providers: providers(),
      conversation: new InMemoryConversationRepository(),
      now: () => nowMs.current,
      character: {
        async generate() {
          return decision({ text: "好", proactive: proposal });
        },
        async generateAfterCognition() {
          throw new Error("cognition must not run");
        }
      }
    });
    await runtime.handleUserMessage(
      { sessionId: "s", content: "安静" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );

    proposal = { action: "KEEP" };
    await runtime.handleUserMessage(
      { sessionId: "s", content: "tv noise" },
      { controlAuthority: "UNTRUSTED", readMemory: false, writeMemory: false }
    );
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });

    await runtime.handleUserMessage(
      { sessionId: "s", content: "hello" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "NONE" });
  });

  it("keeps UNTIL_EXPLICIT_RESUME through ordinary reactive replies until authorized CLEAR", async () => {
    const nowMs = { current: Date.parse("2026-09-05T12:00:00Z") };
    let proposal: RuntimeCharacterTurnResult["decision"]["proactive"] = {
      action: "SUPPRESS",
      scope: { kind: "UNTIL_EXPLICIT_RESUME" }
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      providers: providers(),
      conversation: new InMemoryConversationRepository(),
      now: () => nowMs.current,
      character: {
        async generate() {
          return decision({ text: "好", proactive: proposal });
        },
        async generateAfterCognition() {
          throw new Error("cognition must not run");
        }
      }
    });

    await runtime.handleUserMessage(
      { sessionId: "s", content: "别再主动说话" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "UNTIL_EXPLICIT_RESUME" });

    proposal = { action: "KEEP" };
    const reactive = await runtime.handleUserMessage(
      { sessionId: "s", content: "几点了？" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(reactive?.payload.content).toBe("好");
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "UNTIL_EXPLICIT_RESUME" });

    proposal = { action: "CLEAR" };
    await runtime.handleUserMessage(
      { sessionId: "s", content: "可以继续主动说话了" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "NONE" });
  });

  it("rejects unauthorized third-party durable suppression", async () => {
    const nowMs = { current: Date.parse("2026-09-05T12:00:00Z") };
    const runtime = createRuntime({
      nowMs,
      character: characterPort(
        decision({
          text: "ok",
          proactive: { action: "SUPPRESS", scope: { kind: "UNTIL_EXPLICIT_RESUME" } }
        })
      )
    });
    await runtime.handleUserMessage(
      { sessionId: "s", content: "be quiet forever" },
      { controlAuthority: "UNTRUSTED", readMemory: false, writeMemory: false }
    );
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "NONE" });
  });

  it("advances activity_revision on explicit activity and drops a stale proactive commit", async () => {
    const nowMs = { current: Date.parse("2026-09-05T12:00:00Z") };
    let release: () => void = () => undefined;
    const continuationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let continuationStarted: () => void = () => undefined;
    const continuationBegan = new Promise<void>((resolve) => {
      continuationStarted = resolve;
    });
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      now: () => nowMs.current,
      providers: {
        ...providers(),
        getAssistantContinuationProvider: () => ({
          name: "gated-continuation",
          async generateContinuation() {
            continuationStarted();
            await continuationGate;
            return {
              message: { role: "assistant" as const, content: "stale proactive" },
              finishReason: "stop" as const
            };
          }
        })
      }
    });

    const startedRevision = runtime.getProactiveState().activityRevision;
    const pending = collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "stale-1",
        readMemory: false
      })
    );
    await continuationBegan;
    await runtime.handleUserMessage(
      { sessionId: "s", content: "new explicit turn" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(runtime.getProactiveState().activityRevision).toBe(startedRevision + 1);
    release();
    await expect(pending).rejects.toMatchObject({
      name: "ProactiveAdmissionError",
      reason: "stale-revision"
    });
  });

  it("reloads UNTIL_ENGAGEMENT and UNTIL_EXPLICIT_RESUME from the existing store", async () => {
    const nowMs = { current: Date.parse("2026-09-05T12:00:00Z") };
    const store = memoryStore();
    const first = createRuntime({
      nowMs,
      store,
      character: characterPort(
        decision({ proactive: { action: "SUPPRESS", scope: { kind: "UNTIL_EXPLICIT_RESUME" } } })
      )
    });
    await first.handleUserMessage(
      { sessionId: "s", content: "stop" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    const reloaded = createRuntime({ nowMs, store });
    expect(reloaded.getProactiveState().suppression).toEqual({ kind: "UNTIL_EXPLICIT_RESUME" });
  });

  it("does not call the decision provider when suppression is active", async () => {
    const nowMs = { current: Date.parse("2026-09-05T12:00:00Z") };
    let decided = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      now: () => nowMs.current,
      character: characterPort(
        decision({ proactive: { action: "SUPPRESS", scope: { kind: "UNTIL_EXPLICIT_RESUME" } } })
      ),
      providers: {
        ...providers(),
        getProactiveDecisionProvider: () => ({
          name: "must-not-run",
          async decide() {
            decided += 1;
            return { decision: "REQUEST_TEXT" as const };
          }
        })
      }
    });
    await runtime.handleUserMessage(
      { sessionId: "s", content: "stop" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    await expect(
      collect(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "s",
          idempotencyKey: "blocked",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ reason: "suppressed" });
    expect(decided).toBe(0);
  });
});
