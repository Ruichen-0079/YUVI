import { executeRuntimeCognitionInteraction, DEFAULT_COGNITION_LIMITS } from "./runtime-cognition-interaction.js";
import { InMemoryEventBus } from "@companion/event-bus";
import { InMemoryConversationRepository } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import type { RuntimeEvent } from "@companion/protocol";
import {
  ProviderError,
  ProviderErrorCode,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider,
  type ProviderResolver,
  type TTSInput
} from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeOrchestrator,
  type RuntimeCharacterCognitionExecutor,
  type RuntimeCharacterPort,
  type RuntimeCharacterTurnResult,
  type RuntimeMemoryPort,
  type RuntimeReplyStreamEvent
} from "./index.js";

function decisionFixture(
  reply: RuntimeCharacterTurnResult["decision"]["reply"]
): RuntimeCharacterTurnResult {
  return Object.freeze({
    decision: {
      addressing: "DIRECTED_TO_YUVI",
      reply,
      proactive: { action: "KEEP" }
    },
    providerMetadata: { model: "character-test-chat-model" },
    // Mirrors the real adapter: a NEED_COGNITION pass hands Runtime the
    // Character-owned escalation request and bounded problem statement.
    ...(reply.disposition === "NEED_COGNITION"
      ? {
          cognitionHandoff: Object.freeze({
            request: Object.freeze({
              version: "character-harness-5g.v1",
              kind: "NEED_COGNITION",
              focus: reply.focus ?? "verification"
            }),
            problem: `Character focus:\n${reply.focus ?? "verification"}`
          })
        }
      : {})
  });
}

function roundTripFixture() {
  return {
    version: "character-harness-5h.v1",
    request: {
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "verification"
    },
    result: {
      version: "character-cognition-result.v1",
      status: "SUCCESS",
      answer: "The normalized answer."
    }
  };
}

function memoryStub() {
  const extractCandidates = vi.fn(async () => []);
  const memory: RuntimeMemoryPort = {
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
    extractCandidates,
    async rememberCandidate() {
      throw new Error("rememberCandidate must not run in this suite");
    },
    async rememberInteraction() {
      return null;
    }
  };
  return { memory, extractCandidates };
}

function providersStub(ttsInputs?: TTSInput[]): ProviderResolver {
  const chat = createMockChatProvider("character-test-chat");
  return {
    getChatProvider: () => chat,
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider("NO_OP"),
    getReasoningProvider: () => createMockReasoningProvider("character-test-reasoning"),
    getTTSProvider: () => ({
      name: "character-test-tts",
      async healthCheck() {
        return {
          provider: "character-test-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech(input: TTSInput) {
        if (ttsInputs) {
          ttsInputs.push(input);
          return {
            audio: new Uint8Array([1, 2, 3]),
            audioBase64: "AQID",
            mimeType: "audio/wav",
            model: "character-test-tts"
          };
        }
        throw new Error("TTS must not run for this turn");
      }
    }),
    getSTTProvider: () => createMockSTTProvider("character-test-stt"),
    getVisionProvider: () => createMockVisionProvider("character-test-vision"),
    getEmbeddingProvider: () => ({
      name: "character-test-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "character-test-embedding",
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

type SequenceStep = "generate" | "cognition" | "generateAfterCognition";

function characterHarness(input: {
  initial: RuntimeCharacterTurnResult;
  reentry?: RuntimeCharacterTurnResult;
  onCognition?: () => void;
  cognition?: () => Promise<unknown>;
  onReentry?: (turnInput: {
    signal: AbortSignal | undefined;
    generateChat(
      chatInput: unknown,
      callOptions?: Readonly<{ signal?: AbortSignal | undefined }>
    ): Promise<unknown>;
  }) => void;
}) {
  const order: SequenceStep[] = [];
  const generate = vi.fn(
    async (turnInput: Parameters<RuntimeCharacterPort["generate"]>[0]) => {
      order.push("generate");
      return input.initial;
    }
  );
  const executeCognition = vi.fn(
    async (
      _request: unknown,
      _problem: string,
      _options?: Readonly<{ signal?: AbortSignal | undefined }>
    ) => {
      order.push("cognition");
      input.onCognition?.();
      if (input.cognition) {
        return input.cognition();
      }
      return roundTripFixture();
    }
  );
  const generateAfterCognition = vi.fn(
    async (turnInput: Parameters<RuntimeCharacterPort["generateAfterCognition"]>[0]) => {
      order.push("generateAfterCognition");
      await input.onReentry?.({
        signal: turnInput.signal,
        generateChat: turnInput.generateChat as Parameters<
          NonNullable<(typeof input)["onReentry"]>
        >[0]["generateChat"]
      });
      if (!input.reentry) {
        throw new Error("unexpected Character re-entry");
      }
      return input.reentry;
    }
  );
  const character: RuntimeCharacterPort = Object.freeze({
    generate,
    generateAfterCognition
  });
  return { character, order, generate, executeCognition, generateAfterCognition };
}

async function runTurn(input: {
  character: RuntimeCharacterPort;
  cognition?: RuntimeCharacterCognitionExecutor;
  signal?: AbortSignal;
  outputLanguage?: "AUTO" | "EN" | "ZH" | "JA";
  voiceOutput?: boolean;
  ttsInputs?: TTSInput[];
  embodiedPresentation?: import("./runtime-contracts.js").RuntimeEmbodiedPresentationPort;
}): Promise<{
  events: RuntimeReplyStreamEvent[];
  published: RuntimeEvent[];
  conversation: InMemoryConversationRepository;
  extractCandidates: ReturnType<typeof vi.fn>;
  failure: unknown;
}> {
  const eventBus = new InMemoryEventBus({ development: false });
  const published: RuntimeEvent[] = [];
  eventBus.subscribe("*", (event) => {
    published.push(event);
  });
  const conversation = new InMemoryConversationRepository();
  const { memory, extractCandidates } = memoryStub();
  const runtime = new RuntimeOrchestrator({
    eventBus,
    memory,
    promptBuilder: new PromptBuilder(),
    providers: providersStub(input.ttsInputs),
    conversation,
    ...(input.outputLanguage ? { outputLanguage: input.outputLanguage } : {}),
    ...(input.cognition ? { characterCognition: input.cognition } : {}),
    embodiedPresentation: input.embodiedPresentation,
    character: input.character
  });

  const events: RuntimeReplyStreamEvent[] = [];
  let failure: unknown;
  try {
    const iterator = runtime.streamUserMessage(
      { sessionId: "character-session", content: "Please verify this claim carefully." },
      {
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.voiceOutput ? { voiceOutput: true } : {}),
        readMemory: true,
        writeMemory: true
      }
    );
    for await (const event of iterator) {
      events.push(event);
    }
  } catch (error) {
    failure = error;
  }
  return { events, published, conversation, extractCandidates, failure };
}

function assistantRowId(published: RuntimeEvent[]): string {
  const userMessage = published.find((event) => event.type === "user.message");
  if (!userMessage) {
    throw new Error("user.message was not published");
  }
  return `assistant:${userMessage.id}`;
}

function expectNoAssistantCommit(turn: {
  published: RuntimeEvent[];
  conversation: InMemoryConversationRepository;
}): void {
  expect(turn.published.some((event) => event.type === "agent.reply")).toBe(false);
  expect(turn.published.some((event) => event.type === "assistant.message")).toBe(false);
}

describe("Runtime Character outcome sequencing", () => {
  it("commits a RESPOND decision as exactly one assistant message", async () => {
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "RESPOND", text: "A grounded answer." })
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition
    });

    expect(turn.failure).toBeUndefined();
    const assistantRow = await turn.conversation.getMessageById(assistantRowId(turn.published));
    expect(assistantRow?.role).toBe("assistant");
    expect(assistantRow?.content).toBe("A grounded answer.");

    const agentReplies = turn.published.filter((event) => event.type === "agent.reply");
    const assistantMessages = turn.published.filter((event) => event.type === "assistant.message");
    expect(agentReplies).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);

    expect(turn.events.filter((event) => event.type === "text-delta")).toHaveLength(1);
    const completed = turn.events.find((event) => event.type === "completed");
    expect(completed).toMatchObject({ content: "A grounded answer." });
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(harness.executeCognition).not.toHaveBeenCalled();
    expect(harness.generateAfterCognition).not.toHaveBeenCalled();
    expect(turn.extractCandidates).toHaveBeenCalledTimes(1);
  });

  it("treats SILENCE as a successful turn with no assistant message", async () => {
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "SILENCE" })
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition
    });

    expect(turn.failure).toBeUndefined();
    expect(await turn.conversation.getMessageById(assistantRowId(turn.published))).toBeNull();
    expectNoAssistantCommit(turn);
    expect(turn.published.some((event) => event.type === "runtime.error")).toBe(false);
    expect(turn.published.some((event) => event.type === "provider.error")).toBe(false);
    expect(turn.extractCandidates).not.toHaveBeenCalled();

    expect(turn.events.map((event) => event.type)).toEqual(["completed"]);
    expect(turn.events.find((event) => event.type === "completed")).toMatchObject({ content: "" });
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(harness.generateAfterCognition).not.toHaveBeenCalled();
  });

  it("treats TERMINATE as a clean control-flow outcome with no follow-up generation", async () => {
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "TERMINATE" })
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition
    });

    expect(turn.failure).toBeUndefined();
    expect(await turn.conversation.getMessageById(assistantRowId(turn.published))).toBeNull();
    expectNoAssistantCommit(turn);
    expect(turn.extractCandidates).not.toHaveBeenCalled();
    expect(turn.events.map((event) => event.type)).toEqual(["completed"]);
    expect(turn.events.find((event) => event.type === "completed")).toMatchObject({ content: "" });
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(harness.executeCognition).not.toHaveBeenCalled();
    expect(harness.generateAfterCognition).not.toHaveBeenCalled();
  });

  it("observes NEED_COGNITION before executing Cognition exactly once and re-enters once", async () => {
    const roundTrip = roundTripFixture();
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" }),
      reentry: decisionFixture({ disposition: "RESPOND", text: "The verified answer." }),
      cognition: async () => roundTrip
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition
    });

    expect(turn.failure).toBeUndefined();
    expect(harness.order).toEqual(["generate", "cognition", "generateAfterCognition"]);
    expect(harness.executeCognition).toHaveBeenCalledTimes(1);
    const [request, problem] = harness.executeCognition.mock.calls[0] ?? [];
    expect(request).toMatchObject({ kind: "NEED_COGNITION", focus: "verification" });
    expect(String(problem)).toContain("verification");
    expect(harness.generateAfterCognition.mock.calls[0]?.[0].cognitionRoundTrip).toBe(roundTrip);

    const assistantRow = await turn.conversation.getMessageById(assistantRowId(turn.published));
    expect(assistantRow?.content).toBe("The verified answer.");
    const completed = turn.events.find((event) => event.type === "completed");
    expect(completed).toMatchObject({ content: "The verified answer." });
  });

  it("transports the explicit preference through Character re-entry without making Memory its authority", async () => {
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" }),
      reentry: decisionFixture({ disposition: "RESPOND", text: "The English answer." })
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition,
      outputLanguage: "EN"
    });

    expect(turn.failure).toBeUndefined();
    expect(harness.generate.mock.calls[0]?.[0].outputLanguage).toBe("EN");
    expect(harness.generateAfterCognition.mock.calls[0]?.[0].outputLanguage).toBe("EN");
    expect(turn.extractCandidates).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(turn.extractCandidates.mock.calls)).not.toContain("outputLanguage");
  });

  it("hands the admitted final text and its resolved language to the existing TTS seam", async () => {
    const ttsInputs: TTSInput[] = [];
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "RESPOND", text: "你好，世界。" })
    });

    const turn = await runTurn({
      character: harness.character,
      outputLanguage: "ZH",
      voiceOutput: true,
      ttsInputs
    });

    expect(turn.failure).toBeUndefined();
    expect(ttsInputs).toEqual([
      expect.objectContaining({
        text: "你好，世界。",
        metadata: { language: "zh" }
      })
    ]);
    expect(ttsInputs[0]).not.toHaveProperty("provider");
    expect(ttsInputs[0]).not.toHaveProperty("model");
    expect(ttsInputs[0]).not.toHaveProperty("voice");
  });

  it.each(["SILENCE", "TERMINATE"] as const)(
    "finalizes a NEED_COGNITION turn with %s and no assistant message",
    async (disposition) => {
      const harness = characterHarness({
        initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" }),
        reentry: decisionFixture({ disposition })
      });

      const turn = await runTurn({
        character: harness.character,
        cognition: harness.executeCognition
      });

      expect(turn.failure).toBeUndefined();
      expect(harness.order).toEqual(["generate", "cognition", "generateAfterCognition"]);
      expect(harness.executeCognition).toHaveBeenCalledTimes(1);
      expect(await turn.conversation.getMessageById(assistantRowId(turn.published))).toBeNull();
      expectNoAssistantCommit(turn);
      expect(turn.events.map((event) => event.type)).toEqual(["completed"]);
      expect(turn.events.find((event) => event.type === "completed")).toMatchObject({
        content: ""
      });
    }
  );

  it("fails the turn deterministically when post-Cognition Character asks for Cognition again", async () => {
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" }),
      reentry: decisionFixture({ disposition: "NEED_COGNITION" })
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition
    });

    expect(turn.failure).toBeInstanceOf(ProviderError);
    expect(String(turn.failure)).toContain("after Cognition completed");
    expect(harness.order).toEqual(["generate", "cognition", "generateAfterCognition"]);
    expect(harness.executeCognition).toHaveBeenCalledTimes(1);
    expect(harness.generateAfterCognition).toHaveBeenCalledTimes(1);
    expect(await turn.conversation.getMessageById(assistantRowId(turn.published))).toBeNull();
    expectNoAssistantCommit(turn);
  });

  it("fails explicitly when a NEED_COGNITION handoff carries no Cognition request", async () => {
    const harness = characterHarness({
      initial: {
        decision: {
          addressing: "DIRECTED_TO_YUVI",
          reply: { disposition: "NEED_COGNITION", focus: "verification" },
          proactive: { action: "KEEP" }
        },
        providerMetadata: { model: "character-test-chat-model" }
      }
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition
    });

    expect(String(turn.failure)).toContain("did not include a Cognition request");
    expect(harness.executeCognition).not.toHaveBeenCalled();
  });

  it("fails explicitly when Cognition execution is unavailable", async () => {
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" })
    });

    const turn = await runTurn({ character: harness.character });

    expect(String(turn.failure)).toContain("Character Cognition execution is unavailable");
    expect(harness.generate).toHaveBeenCalledTimes(1);
  });

  it("does not commit stale output when cancelled during Cognition", async () => {
    const controller = new AbortController();
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" }),
      onCognition: () => {
        controller.abort();
      },
      cognition: async () => {
        throw new ProviderError({
          provider: "character",
          capability: "chat",
          code: ProviderErrorCode.Cancelled,
          message: "Character turn was cancelled.",
          retryable: false
        });
      }
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition,
      signal: controller.signal
    });

    expect(turn.failure).toBeInstanceOf(ProviderError);
    expect(harness.generateAfterCognition).not.toHaveBeenCalled();
    expect(await turn.conversation.getMessageById(assistantRowId(turn.published))).toBeNull();
    expectNoAssistantCommit(turn);
  });

  it("does not commit stale output when cancelled before the re-entry Chat call", async () => {
    const controller = new AbortController();
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" }),
      cognition: async () => {
        controller.abort();
        return roundTripFixture();
      },
      onReentry: async (turnInput) => {
        // Simulates the re-entry Chat call under the aborted originating turn:
        // the Runtime-owned wrapper rejects before any provider work.
        await expect(
          turnInput.generateChat(
            { messages: [{ role: "user", content: "re-entry" }] },
            {
              signal: turnInput.signal
            }
          )
        ).rejects.toThrow("cancelled");
        throw new ProviderError({
          provider: "character",
          capability: "chat",
          code: ProviderErrorCode.Cancelled,
          message: "Character turn was cancelled.",
          retryable: false
        });
      },
      reentry: decisionFixture({ disposition: "RESPOND", text: "Too late." })
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition,
      signal: controller.signal
    });

    expect(turn.failure).toBeInstanceOf(ProviderError);
    expect(await turn.conversation.getMessageById(assistantRowId(turn.published))).toBeNull();
    expectNoAssistantCommit(turn);
  });

  it("does not commit when cancellation lands after the final Character result", async () => {
    const controller = new AbortController();
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "RESPOND", text: "Late result." })
    });
    // Abort the originating turn as soon as the initial pass has produced its
    // final decision; the Runtime fence must discard it before commit.
    harness.generate.mockImplementation(async () => {
      controller.abort();
      return decisionFixture({ disposition: "RESPOND", text: "Late result." });
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition,
      signal: controller.signal
    });

    expect(turn.failure).toBeInstanceOf(ProviderError);
    expect(await turn.conversation.getMessageById(assistantRowId(turn.published))).toBeNull();
    expectNoAssistantCommit(turn);
  });

  it("propagates Cognition failure through the normalized failure contract without fabricating text", async () => {
    const harness = characterHarness({
      initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" }),
      cognition: async () => {
        throw new ProviderError({
          provider: "character",
          capability: "chat",
          code: ProviderErrorCode.ProviderUnavailable,
          message: "Cognition backend is unavailable.",
          retryable: false
        });
      }
    });

    const turn = await runTurn({
      character: harness.character,
      cognition: harness.executeCognition
    });

    expect(String(turn.failure)).toContain("Cognition backend is unavailable");
    expect(await turn.conversation.getMessageById(assistantRowId(turn.published))).toBeNull();
    expectNoAssistantCommit(turn);
  });
});


it.each(["excited", "amused", undefined])("passes accepted Character presentation %s to Runtime without replacing its meaning", async intent => {
  const propose = vi.fn(() => null);
  const character = characterHarness({ initial: decisionFixture({ disposition: "RESPOND", text: "A reply", ...(intent ? { presentation: { intent } } : {}) }) });
  await runTurn({ character: character.character, embodiedPresentation: { propose, present: async request => ({ version: "embodied-presentation-outcome-7k.v1", effectId: request.effectId, outcome: "REJECTED" }) } });
  expect(propose).toHaveBeenCalledWith(expect.objectContaining({ type: "agent.reply" }), intent ? { intent } : null);
});


function interactionGate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const streaming of [false, true]) {
  describe(`Cognition lifecycle through ${streaming ? "streaming" : "ordinary"} Runtime turns`, () => {
    function lifecycleFixture(streamBody = false) {
      const gate = interactionGate<{ kind: "COMPLETE"; result: string }>();
      const entered = interactionGate<AbortSignal>();
      const bodyGate = interactionGate<void>();
      const bodyEntered = interactionGate<AbortSignal>();
      const published: RuntimeEvent[] = [];
      const eventBus = new InMemoryEventBus({ development: false });
      eventBus.subscribe("*", (event) => {
        published.push(event);
      });
      const harness = characterHarness({
        initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verify" }),
        reentry: decisionFixture({ disposition: "RESPOND", text: "Verified reply." })
      });
      if (streamBody)
        harness.generateAfterCognition.mockResolvedValue({
          ...decisionFixture({ disposition: "RESPOND", text: "unused" }),
          decision: {
            ...decisionFixture({ disposition: "RESPOND", text: "unused" }).decision,
            reply: {
              disposition: "RESPOND",
              body: { messages: [{ role: "user", content: "express result" }] }
            }
          }
        });
      const providers = providersStub();
      const chat = {
        ...providers.getChatProvider(),
        streamingMode: "native" as const,
        async *streamReply(_input: unknown, options?: { signal?: AbortSignal }) {
          bodyEntered.resolve(options!.signal!);
          await bodyGate.promise;
          yield { type: "text-delta" as const, text: "late body" };
          yield {
            type: "completed" as const,
            output: { message: { role: "assistant" as const, content: "late body" } }
          };
        }
      };
      const generate = vi.fn(async (input: Parameters<RuntimeCharacterPort["generate"]>[0]) =>
        input.userMessage === "replacement"
          ? decisionFixture({ disposition: "RESPOND", text: "Replacement reply." })
          : harness.character.generate(input)
      );
      const runtime = new RuntimeOrchestrator({
        eventBus,
        memory: memoryStub().memory,
        promptBuilder: new PromptBuilder(),
        providers: { ...providers, getChatProvider: () => chat },
        conversation: new InMemoryConversationRepository(),
        character: { ...harness.character, generate },
        characterCognition: async (_request, _problem, options) => {
          await executeRuntimeCognitionInteraction({
            execution: options.execution,
            signal: options.signal,
            limits: DEFAULT_COGNITION_LIMITS,
            policyAllowsCapability: false,
            reason: async (_history, signal) => {
              entered.resolve(signal);
              return gate.promise;
            },
            invoke: async () => {
              throw new Error("No capability should execute");
            }
          });
          // Deliberately return a seemingly valid late result: the outer Runtime
          // must fence it before Character re-entry, regardless of this callback.
          return roundTripFixture();
        }
      });
      const run = async (content: string, signal?: AbortSignal, sessionId = "lifecycle") => {
        const input = { sessionId, content };
        if (streaming) {
          for await (const _event of runtime.streamUserMessage(input, {
            readMemory: false,
            writeMemory: false,
            signal
          })) {
            /* drain transport */
          }
        } else
          await runtime.handleUserMessage(input, { readMemory: false, writeMemory: false, signal });
      };
      return { gate, entered, bodyGate, bodyEntered, published, harness, runtime, run };
    }

    it("cancels a pending interaction without Character re-entry or assistant commit", async () => {
      const f = lifecycleFixture();
      const controller = new AbortController();
      const turn = f.run("original", controller.signal).catch((error) => error);
      const signal = await f.entered.promise;
      controller.abort();
      expect(signal.aborted).toBe(true);
      f.gate.resolve({ kind: "COMPLETE", result: "late" });
      expect(await turn).toBeInstanceOf(ProviderError);
      expect(f.harness.generateAfterCognition).not.toHaveBeenCalled();
      expect(f.published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
    });

    it("supersedes same-session Cognition without committing its late result", async () => {
      const f = lifecycleFixture();
      const old = f.run("original").catch((error) => error);
      const signal = await f.entered.promise;
      await f.run("replacement");
      expect(signal.aborted).toBe(true);
      f.gate.resolve({ kind: "COMPLETE", result: "stale" });
      expect(await old).toBeInstanceOf(ProviderError);
      expect(f.harness.generateAfterCognition).not.toHaveBeenCalled();
      const assistants = f.published.filter((event) => event.type === "assistant.message");
      expect(assistants).toHaveLength(1);
      expect(JSON.stringify(assistants)).toContain("Replacement reply.");
    });

    it("does not invalidate another session's admitted interaction", async () => {
      const f = lifecycleFixture();
      const old = f.run("original");
      const signal = await f.entered.promise;
      await f.run("replacement", undefined, "other-session");
      expect(signal.aborted).toBe(false);
      f.gate.resolve({ kind: "COMPLETE", result: "done" });
      await old;
      expect(f.published.filter((event) => event.type === "assistant.message")).toHaveLength(2);
    });

    it("fences replacement during the post-Cognition Character body stream", async () => {
      const f = lifecycleFixture(true);
      const old = f.run("original").catch((error) => error);
      await f.entered.promise;
      f.gate.resolve({ kind: "COMPLETE", result: "done" });
      const bodySignal = await f.bodyEntered.promise;
      await f.run("replacement");
      expect(bodySignal.aborted).toBe(true);
      f.bodyGate.resolve();
      expect(await old).toBeInstanceOf(ProviderError);
      const assistants = f.published.filter((event) => event.type === "assistant.message");
      expect(assistants).toHaveLength(1);
      expect(JSON.stringify(assistants)).not.toContain("late body");
    });

    it("seals new admissions but drains the already admitted interaction before disposal", async () => {
      const f = lifecycleFixture();
      const turn = f.run("original");
      await f.entered.promise;
      let drained = false;
      const sealing = f.runtime.sealAndDrainMemoryWrites().then(() => {
        drained = true;
      });
      expect(f.runtime.getLifecycleState()).toBe("sealing");
      expect(drained).toBe(false);
      await expect(f.run("replacement")).rejects.toThrow("not accepting new operations");
      f.gate.resolve({ kind: "COMPLETE", result: "done" });
      await turn;
      await sealing;
      expect(f.harness.generateAfterCognition).toHaveBeenCalledTimes(1);
      expect(f.published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
      expect(f.runtime.getLifecycleState()).toBe("disposed");
    });
  });
}

it("offers Memory only the final Character turn after bounded execution evidence", async () => {
  const harness = characterHarness({
    initial: decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" }),
    reentry: decisionFixture({ disposition: "RESPOND", text: "The visible answer." })
  });
  type Round = { kind: "REQUEST_CAPABILITY"; request: string } | { kind: "COMPLETE" };
  const turn = await runTurn({
    character: harness.character,
    cognition: async (_request, _problem, options) => {
      const outcome = await executeRuntimeCognitionInteraction<Round, string>({
        execution: options.execution,
        signal: options.signal,
        limits: DEFAULT_COGNITION_LIMITS,
        policyAllowsCapability: true,
        reason: async (history) =>
          history.length === 0
            ? { kind: "REQUEST_CAPABILITY", request: "EXECUTION_ONLY_REQUEST" }
            : { kind: "COMPLETE" },
        invoke: async () => "EXECUTION_ONLY_OBSERVATION"
      });
      expect(outcome.state.capabilityCallsUsed).toBe(1);
      return {
        ...roundTripFixture(),
        result: { ...roundTripFixture().result, answer: "EXECUTION_ONLY_COGNITION_RESULT" }
      };
    }
  });
  expect(turn.failure).toBeUndefined();
  expect(turn.extractCandidates).toHaveBeenCalledTimes(1);
  const extraction = JSON.stringify(turn.extractCandidates.mock.calls);
  expect(extraction).toContain("The visible answer.");
  expect(extraction).toContain("Please verify this claim carefully.");
  expect(extraction).not.toContain("EXECUTION_ONLY_");
  expect(JSON.stringify(turn.published)).not.toContain("EXECUTION_ONLY_");
  expect(JSON.stringify(turn.events)).not.toContain("EXECUTION_ONLY_");
  const history = await turn.conversation.listRecentMessages("character-session", { limit: 10 });
  expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(history)).not.toContain("EXECUTION_ONLY_");
});
