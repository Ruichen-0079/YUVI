import { InMemoryEventBus } from "@companion/event-bus";
import {
  InMemoryConversationRepository,
  type MemoryConversationTurnWriteResult,
  type Memory,
  type MemoryCandidate
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  ProviderError,
  ProviderErrorCode,
  FallbackChatProvider,
  createMockAssistantContinuationProvider,
  type ChatStreamEvent,
  type ChatOutput,
  type ChatProvider,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockStreamingChatProvider as createRawMockStreamingChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider,
  type ChatInput,
  type ChatStreamOptions,
  type MockStreamingChatProviderOptions,
  type TTSOutput
} from "@companion/providers";
import { type RuntimeEvent } from "@companion/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeOrchestrator,
  type RuntimeMemoryPort,
  type RuntimeReplyStreamEvent
} from "./index.js";

async function collectRuntimeStream(
  stream: AsyncIterable<RuntimeReplyStreamEvent>,
  onEvent?: (event: RuntimeReplyStreamEvent) => void
): Promise<RuntimeReplyStreamEvent[]> {
  const events: RuntimeReplyStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
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
    resolve(value: T): void {
      resolvePromise?.(value);
    },
    reject(reason?: unknown): void {
      rejectPromise?.(reason);
    }
  };
}

async function appendCompletedConversationMessage(
  conversation: InMemoryConversationRepository,
  input: {
    id: string;
    sessionId: string;
    traceId: string;
    role: "user" | "assistant";
    content: string;
    sourceUserEventId?: string | null;
    metadata?: Record<string, unknown>;
    timestampMs?: number;
  }
): Promise<void> {
  const timestamp = new Date(input.timestampMs ?? 0).toISOString();
  await conversation.ensureSession(input.sessionId);
  await conversation.appendMessage({
    id: input.id,
    sessionId: input.sessionId,
    traceId: input.traceId,
    parentMessageId: null,
    sourceUserEventId: input.sourceUserEventId ?? null,
    role: input.role,
    content: input.content,
    status: "completed",
    createdAt: timestamp,
    completedAt: timestamp,
    metadata: input.metadata ?? {}
  });
}

function runtimeSpeechOutput(): TTSOutput {
  return {
    audio: new Uint8Array([1, 2, 3]),
    audioBase64: "AQID",
    mimeType: "audio/wav",
    durationMs: 42,
    model: "runtime-test-tts",
    finalProvider: "runtime-test-tts"
  };
}

describe("RuntimeOrchestrator", () => {
  it("uses the normalized reasoning answer instead of provider internal reasoning", async () => {
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getReasoningProvider: () => ({
          name: "reasoning-test",
          async healthCheck() {
            return {
              provider: "reasoning-test",
              status: "healthy" as const,
              checkedAt: new Date().toISOString()
            };
          },
          async generateReasoning() {
            return {
              reasoning: "private provider internal trace",
              answer: "safe final answer"
            };
          }
        })
      }
    });

    await expect(
      runtime.maybeGenerateReasoning({
        messages: [{ role: "user", content: "What is the answer?" }],
        purpose: "planning"
      })
    ).resolves.toBe("safe final answer");
  });

  it("persists each delta before yielding it and finalizes one reply lifecycle", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const conversation = new InMemoryConversationRepository();
    const order: string[] = [];
    const published: RuntimeEvent[] = [];
    const appendMessage = conversation.appendMessage.bind(conversation);
    const appendMessageContent = conversation.appendMessageContent.bind(conversation);
    const completeMessage = conversation.completeMessage.bind(conversation);
    conversation.appendMessage = async (message) => {
      order.push(`${message.role}:${message.status}:save`);
      return appendMessage(message);
    };
    conversation.appendMessageContent = async (id, delta) => {
      order.push(`assistant:stream:${delta}`);
      return appendMessageContent(id, delta);
    };
    conversation.completeMessage = async (id, metadata) => {
      order.push("assistant:completed");
      return completeMessage(id, metadata);
    };
    eventBus.subscribe("*", (event) => {
      order.push(`event:${event.type}`);
      published.push(event);
    });

    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", {
            chunks: ["hel", "lo"],
            output: { model: "native-model", tokenUsage: { totalTokens: 3 } }
          })
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "stream-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      ),
      (event) => {
        order.push(
          `yield:${event.type}:${event.type === "text-delta" ? event.text : event.type === "completed" ? event.content : event.decision}`
        );
      }
    );
    const messages = await conversation.listRecentMessages("stream-session");
    const assistant = messages.find((message) => message.role === "assistant");

    expect(events.map((event) => event.type)).toEqual(["text-delta", "text-delta", "completed"]);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(assistant).toMatchObject({ content: "hello", status: "completed" });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      messageId: assistant?.id,
      content: "hello",
      provider: "native"
    });
    expect(order.indexOf("assistant:stream:hel")).toBeLessThan(
      order.indexOf("yield:text-delta:hel")
    );
    expect(order.indexOf("assistant:stream:lo")).toBeLessThan(order.indexOf("yield:text-delta:lo"));
    expect(order).toContain("event:agent.reply");
    expect(order).toContain("event:assistant.message");
    expect(order.indexOf("assistant:completed")).toBeLessThan(order.indexOf("event:agent.reply"));
    const userEvent = published.find((event) => event.type === "user.message")!;
    const agentReply = published.find((event) => event.type === "agent.reply")!;
    const assistantMessage = published.find((event) => event.type === "assistant.message")!;
    expect(agentReply).toMatchObject({
      traceId: userEvent.traceId,
      parentId: userEvent.id,
      payload: { sessionId: "stream-session", content: "hello" }
    });
    expect(assistantMessage).toMatchObject({
      id: assistant?.id,
      traceId: userEvent.traceId,
      parentId: agentReply.id,
      payload: { sessionId: "stream-session", content: "hello" }
    });

    const rebuilt = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await rebuilt.handleUserMessage(
      { sessionId: "stream-session", content: "next" },
      { readMemory: false, writeMemory: false }
    );
    expect(
      rebuilt.getLatestPromptPreview()?.sections.find((section) => section.name === "DirectContext")
        ?.content
    ).toContain("hello");
  });

  it("supports compatible non-streaming providers through the runtime stream entry", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockChatProvider("legacy")
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "compatible-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      )
    );
    expect(events.map((event) => event.type)).toEqual(["text-delta", "completed"]);
    expect((await conversation.listRecentMessages("compatible-session")).at(-1)).toMatchObject({
      status: "completed",
      content: events[0]?.type === "text-delta" ? events[0].text : ""
    });
  });

  it("forwards the runtime call options to a compatible provider", async () => {
    let receivedOptions: { signal?: AbortSignal } | undefined;
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation: new InMemoryConversationRepository(),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => ({
          name: "legacy-options",
          healthCheck: async () => ({
            provider: "legacy-options",
            status: "healthy" as const,
            checkedAt: new Date().toISOString()
          }),
          async generateReply(_input: unknown, options?: { signal?: AbortSignal }) {
            receivedOptions = options;
            return { message: { role: "assistant" as const, content: "legacy reply" } };
          }
        })
      }
    });

    const controller = new AbortController();
    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "compatible-options-session", content: "hello" },
        { signal: controller.signal, readMemory: false, writeMemory: false }
      )
    );

    expect(receivedOptions?.signal).toBeDefined();
    expect(events.map((event) => event.type)).toEqual(["text-delta", "completed"]);
  });

  it("finalizes persistence and final events before yielding completed", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] })
      }
    });
    const iterator = runtime
      .streamUserMessage(
        { sessionId: "completed-stop-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      )
      [Symbol.asyncIterator]();
    let completion: RuntimeReplyStreamEvent | undefined;
    while (!completion || completion.type !== "completed") {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      if (next.value.type === "completed") {
        completion = next.value;
      }
    }

    expect(completion).toMatchObject({ type: "completed", content: "done" });
    expect((await conversation.listRecentMessages("completed-stop-session")).at(-1)).toMatchObject({
      status: "completed",
      content: "done"
    });
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(1);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
  });

  it("keeps a finalized stream completed when cancellation occurs during optional post-processing", async () => {
    const controller = new AbortController();
    let releaseMemory!: () => void;
    let memoryStarted!: () => void;
    const memoryReady = new Promise<void>((resolve) => {
      memoryStarted = resolve;
    });
    const memoryRelease = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const memory = createRecordingMemory([]);
    memory.extractCandidates = async () => {
      memoryStarted();
      await memoryRelease;
      return [];
    };
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] })
      }
    });

    const collecting = collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "post-processing-cancel-session", content: "hello" },
        { signal: controller.signal, writeMemory: true }
      )
    );
    await memoryReady;
    controller.abort();
    releaseMemory();

    await expect(collecting).resolves.toEqual([
      {
        type: "text-delta",
        text: "done",
        language: "en",
        messageId: expect.any(String),
        replyId: expect.any(String),
        componentId: expect.stringMatching(/^rc1_[a-f0-9]{64}$/),
        sequence: "1",
        sessionId: "post-processing-cancel-session",
        traceId: expect.any(String)
      },
      {
        type: "completed",
        messageId: expect.any(String),
        replyId: expect.any(String),
        lastSequence: "1",
        sessionId: "post-processing-cancel-session",
        traceId: expect.any(String),
        content: "done",
        language: "en",
        provider: "native"
      }
    ]);
    expect(
      (await conversation.listRecentMessages("post-processing-cancel-session")).at(-1)
    ).toMatchObject({
      content: "done",
      status: "completed"
    });
  });

  it("forwards the caller signal to TTS and publishes one complete audio event", async () => {
    const controller = new AbortController();
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let receivedSignal: AbortSignal | undefined;
    const synthesizeSpeech = vi.fn(async (_input: unknown, options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      return runtimeSpeechOutput();
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation: new InMemoryConversationRepository(),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] }),
        getTTSProvider: () => ({
          name: "runtime-test-tts",
          healthCheck: async () => ({
            provider: "runtime-test-tts",
            status: "healthy" as const,
            checkedAt: new Date().toISOString()
          }),
          synthesizeSpeech
        })
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "tts-success-session", content: "hello" },
        { signal: controller.signal, voiceOutput: true, readMemory: false, writeMemory: false }
      )
    );

    expect(receivedSignal).toBe(controller.signal);
    expect(synthesizeSpeech).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "completed", content: "done" });
    expect(published.filter((event) => event.type === "avatar.speak")).toHaveLength(1);
    expect(published.find((event) => event.type === "avatar.speak")).toMatchObject({
      payload: { audioBase64: "AQID", mimeType: "audio/wav", durationMs: 42 }
    });
  });

  it("skips TTS after the finalized reply is cancelled before synthesis starts", async () => {
    const controller = new AbortController();
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
      if (event.type === "assistant.message") {
        controller.abort();
      }
    });
    const synthesizeSpeech = vi.fn(async () => runtimeSpeechOutput());
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] }),
        getTTSProvider: () => ({
          name: "runtime-test-tts",
          healthCheck: async () => ({
            provider: "runtime-test-tts",
            status: "healthy" as const,
            checkedAt: new Date().toISOString()
          }),
          synthesizeSpeech
        })
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "tts-pre-cancel-session", content: "hello" },
        { signal: controller.signal, voiceOutput: true, readMemory: false, writeMemory: false }
      )
    );

    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(published.filter((event) => event.type === "avatar.speak")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "completed", content: "done" });
    expect((await conversation.listRecentMessages("tts-pre-cancel-session")).at(-1)).toMatchObject({
      content: "done",
      status: "completed"
    });
  });

  it("propagates in-flight TTS cancellation without failing the finalized reply", async () => {
    const controller = new AbortController();
    const ttsStarted = deferred<void>();
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let receivedSignal: AbortSignal | undefined;
    const synthesizeSpeech = vi.fn(
      async (_input: unknown, options?: { signal?: AbortSignal }): Promise<TTSOutput> => {
        receivedSignal = options?.signal;
        ttsStarted.resolve();
        if (!receivedSignal) {
          throw new Error("TTS did not receive the caller signal.");
        }
        return new Promise<TTSOutput>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () =>
              reject(
                new ProviderError({
                  provider: "runtime-test-tts",
                  capability: "tts",
                  code: ProviderErrorCode.Cancelled,
                  message: "TTS cancelled",
                  retryable: false,
                  fallbackEligible: false,
                  effectState: "unknown"
                })
              ),
            { once: true }
          );
        });
      }
    );
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] }),
        getTTSProvider: () => ({
          name: "runtime-test-tts",
          healthCheck: async () => ({
            provider: "runtime-test-tts",
            status: "healthy" as const,
            checkedAt: new Date().toISOString()
          }),
          synthesizeSpeech
        })
      }
    });

    const collecting = collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "tts-in-flight-cancel-session", content: "hello" },
        { signal: controller.signal, voiceOutput: true, readMemory: false, writeMemory: false }
      )
    );
    await ttsStarted.promise;
    controller.abort();

    const events = await collecting;
    expect(receivedSignal).toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "completed", content: "done" });
    expect(published.filter((event) => event.type === "avatar.speak")).toHaveLength(0);
    expect(
      (await conversation.listRecentMessages("tts-in-flight-cancel-session")).at(-1)
    ).toMatchObject({
      content: "done",
      status: "completed"
    });
  });

  it("discards a late TTS result when the provider ignores cancellation", async () => {
    const controller = new AbortController();
    const ttsStarted = deferred<void>();
    const finishTTS = deferred<TTSOutput>();
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let receivedSignal: AbortSignal | undefined;
    const synthesizeSpeech = vi.fn(
      async (_input: unknown, options?: { signal?: AbortSignal }): Promise<TTSOutput> => {
        receivedSignal = options?.signal;
        ttsStarted.resolve();
        return finishTTS.promise;
      }
    );
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] }),
        getTTSProvider: () => ({
          name: "runtime-test-tts",
          healthCheck: async () => ({
            provider: "runtime-test-tts",
            status: "healthy" as const,
            checkedAt: new Date().toISOString()
          }),
          synthesizeSpeech
        })
      }
    });

    const collecting = collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "tts-late-result-session", content: "hello" },
        { signal: controller.signal, voiceOutput: true, readMemory: false, writeMemory: false }
      )
    );
    await ttsStarted.promise;
    controller.abort();
    finishTTS.resolve(runtimeSpeechOutput());

    const events = await collecting;
    expect(receivedSignal).toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "completed", content: "done" });
    expect(published.filter((event) => event.type === "avatar.speak")).toHaveLength(0);
    expect((await conversation.listRecentMessages("tts-late-result-session")).at(-1)).toMatchObject(
      {
        content: "done",
        status: "completed"
      }
    );
  });

  it("keeps streaming completed when optional memory and TTS post-processing fail", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createFailingMemory(),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] }),
        getTTSProvider: () => ({
          name: "failing-tts",
          async healthCheck() {
            return {
              provider: "failing-tts",
              status: "unavailable" as const,
              checkedAt: new Date().toISOString()
            };
          },
          async synthesizeSpeech() {
            throw new ProviderError({
              provider: "failing-tts",
              capability: "tts",
              code: ProviderErrorCode.ProviderUnavailable,
              message: "TTS unavailable"
            });
          }
        })
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "optional-failure-stream-session", content: "hello" },
        { voiceOutput: true, writeMemory: true }
      )
    );
    expect(events.map((event) => event.type)).toEqual(["text-delta", "completed"]);
    expect(
      (await conversation.listRecentMessages("optional-failure-stream-session")).at(-1)
    ).toMatchObject({
      content: "done",
      status: "completed"
    });
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(1);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
  });

  it("falls back before the first output without exposing the failed provider stream", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const failing = createMockStreamingChatProvider("primary", {
      failBeforeFirst: new ProviderError({
        provider: "primary",
        capability: "chat",
        code: ProviderErrorCode.ProviderUnavailable,
        message: "primary unavailable"
      })
    });
    const backup = createMockStreamingChatProvider("backup", {
      chunks: ["ok"]
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => new FallbackChatProvider([failing, backup])
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "fallback-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      )
    );
    expect(events.at(-1)).toMatchObject({ type: "completed", content: "ok" });
    expect(
      (await conversation.listRecentMessages("fallback-session")).filter(
        (message) => message.role === "assistant"
      )
    ).toHaveLength(1);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(1);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
  });

  it("does not create an assistant message when every provider fails before output", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          new FallbackChatProvider([
            createMockStreamingChatProvider("primary", {
              failBeforeFirst: new ProviderError({
                provider: "primary",
                capability: "chat",
                code: ProviderErrorCode.ProviderUnavailable,
                message: "primary unavailable"
              })
            }),
            createMockStreamingChatProvider("backup", {
              failBeforeFirst: new ProviderError({
                provider: "backup",
                capability: "chat",
                code: ProviderErrorCode.Timeout,
                message: "backup timeout"
              })
            })
          ])
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "all-failed-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.Timeout });
    expect(
      (await conversation.listRecentMessages("all-failed-session")).filter(
        (message) => message.role === "assistant"
      )
    ).toHaveLength(0);
  });

  it("marks partial provider output as failed without publishing final reply events", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("primary", {
            chunks: ["partial", "ignored"],
            failAfterChunks: 1,
            failAfter: new ProviderError({
              provider: "primary",
              capability: "chat",
              code: ProviderErrorCode.NetworkError,
              message: "stream interrupted"
            })
          })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "partial-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.NetworkError });
    const assistant = (await conversation.listRecentMessages("partial-session")).find(
      (message) => message.role === "assistant"
    );
    expect(assistant).toMatchObject({ content: "partial", status: "failed" });
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("surfaces failure-state persistence errors and recovers abandoned streams", async () => {
    const conversation = new InMemoryConversationRepository();
    conversation.failMessage = async () => {
      throw new Error("failure state unavailable");
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", {
            chunks: ["partial", "ignored"],
            failAfterChunks: 1,
            failAfter: new ProviderError({
              provider: "native",
              capability: "chat",
              code: ProviderErrorCode.NetworkError,
              message: "interrupted"
            })
          })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "failure-state-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_stream_fail"
    });
    expect((await conversation.listRecentMessages("failure-state-session")).at(-1)).toMatchObject({
      status: "streaming"
    });

    const recovered = await runtime.recoverStaleStreamingMessages({
      olderThan: new Date(Date.now() + 1),
      recoveredAt: new Date("2026-08-28T12:00:00.000Z")
    });
    expect(recovered).toMatchObject([
      {
        status: "failed",
        metadata: { recoveryReason: "stale-streaming-message" }
      }
    ]);
  });

  it("does not let recovered abandoned rows poison rebuilt direct context", async () => {
    const conversation = new InMemoryConversationRepository();
    const timestampMs = Date.now() - 60 * 60 * 1000;
    await appendCompletedConversationMessage(conversation, {
      id: "prior-user",
      sessionId: "recovery-context-session",
      traceId: "prior-trace",
      role: "user",
      content: "prior completed context",
      timestampMs
    });
    await appendCompletedConversationMessage(conversation, {
      id: "prior-assistant",
      sessionId: "recovery-context-session",
      traceId: "prior-trace",
      role: "assistant",
      content: "prior completed answer",
      sourceUserEventId: "prior-user",
      timestampMs: timestampMs + 1
    });
    await conversation.ensureSession("recovery-context-session");
    await conversation.appendMessage({
      id: "abandoned-assistant",
      sessionId: "recovery-context-session",
      traceId: "abandoned-trace",
      parentMessageId: null,
      role: "assistant",
      content: "stranded partial output",
      status: "streaming",
      createdAt: new Date(timestampMs + 2).toISOString(),
      completedAt: null,
      metadata: {}
    });

    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await runtime.recoverStaleStreamingMessages({ olderThan: new Date(), limit: 10 });
    await runtime.handleUserMessage(
      { sessionId: "recovery-context-session", content: "new question" },
      { readMemory: false, writeMemory: false }
    );

    const directContext = runtime
      .getLatestPromptPreview()
      ?.sections.find((section) => section.name === "DirectContext")?.content;
    expect(directContext).toContain("prior completed context");
    expect(directContext).toContain("prior completed answer");
    expect(directContext).not.toContain("stranded partial output");
  });

  it("marks an assistant message failed and withholds a delta when its component commit fails", async () => {
    const conversation = new InMemoryConversationRepository();
    conversation.appendReplyComponent = async () => {
      throw new Error("component commit unavailable");
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["one", "two"] })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "append-failed-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_stream_append"
    });
    expect((await conversation.listRecentMessages("append-failed-session")).at(-1)).toMatchObject({
      content: "",
      status: "failed"
    });
  });

  it("stops before yielding when the streaming assistant message cannot be created", async () => {
    const conversation = new InMemoryConversationRepository();
    const appendMessage = conversation.appendMessage.bind(conversation);
    conversation.appendMessage = async (message) => {
      if (message.role === "assistant") {
        throw new Error("stream create unavailable");
      }
      return appendMessage(message);
    };
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["first"] })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "create-failed-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_stream_create"
    });
    expect(
      (await conversation.listRecentMessages("create-failed-session")).map(
        (message) => message.role
      )
    ).toEqual(["user"]);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("does not publish final events when streaming finalization persistence fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    conversation.completeMessage = async () => {
      throw new Error("finalize unavailable");
    };
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["complete"] })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "finalize-failed-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_stream_complete"
    });
    expect((await conversation.listRecentMessages("finalize-failed-session")).at(-1)).toMatchObject(
      {
        content: "complete",
        status: "failed"
      }
    );
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("marks streaming messages cancelled for external abort and consumer return", async () => {
    const conversation = new InMemoryConversationRepository();
    const controller = new AbortController();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", {
            chunks: ["first", "second"],
            delayMs: 5
          })
      }
    });
    const iterator = runtime
      .streamUserMessage(
        { sessionId: "abort-session", content: "hello" },
        { signal: controller.signal, readMemory: false, writeMemory: false }
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "text-delta", text: "first" },
      done: false
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect((await conversation.listRecentMessages("abort-session")).at(-1)).toMatchObject({
      status: "cancelled",
      content: "first"
    });

    const earlyConversation = new InMemoryConversationRepository();
    const consumerReturnMemoryWrites: Array<Record<string, unknown>> = [];
    const trackedReturn = vi.fn(
      async (): Promise<IteratorResult<ChatStreamEvent>> => ({ done: true, value: undefined })
    );
    const trackedProvider = {
      name: "tracked",
      healthCheck: async () => ({
        provider: "tracked",
        status: "healthy" as const,
        checkedAt: new Date().toISOString()
      }),
      generateReply: async () => ({ message: { role: "assistant" as const, content: "tracked" } }),
      streamReply: () => ({
        async next() {
          return { done: false as const, value: { type: "text-delta" as const, text: "first" } };
        },
        return: trackedReturn,
        [Symbol.asyncIterator]() {
          return this;
        }
      })
    };
    const earlyRuntime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        consumerReturnMemoryWrites.push(input);
        return completeMemoryWrite();
      }),
      conversation: earlyConversation,
      promptBuilder: new PromptBuilder(),
      providers: { ...createMockProviders(), getChatProvider: () => trackedProvider }
    });
    const earlyIterator = earlyRuntime
      .streamUserMessage(
        { sessionId: "return-session", content: "hello" },
        { readMemory: false, writeMemory: true }
      )
      [Symbol.asyncIterator]();
    await earlyIterator.next();
    await earlyIterator.return?.();
    expect(trackedReturn).toHaveBeenCalledTimes(1);
    expect((await earlyConversation.listRecentMessages("return-session")).at(-1)).toMatchObject({
      status: "cancelled"
    });
    expect(consumerReturnMemoryWrites).toHaveLength(0);
  });

  it("checks cancellation before saving the user message", async () => {
    const controller = new AbortController();
    controller.abort();
    const conversation = new InMemoryConversationRepository();
    const published: RuntimeEvent[] = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let providerCalls = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => {
          providerCalls += 1;
          return createMockChatProvider("never");
        }
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "pre-cancel-session", content: "hello" },
          { signal: controller.signal }
        )
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(providerCalls).toBe(0);
    expect(await conversation.listRecentMessages("pre-cancel-session")).toEqual([]);
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(0);
  });

  it("keeps failed streaming text out of restored direct context and persists with memory disabled", async () => {
    const conversation = new InMemoryConversationRepository();
    const memory = createRecordingMemory([]);
    let memoryReads = 0;
    memory.retrieveRelevantMemories = async () => {
      memoryReads += 1;
      return [];
    };
    const failedRuntime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", {
            chunks: ["not completed", "ignored"],
            failAfterChunks: 1,
            failAfter: new ProviderError({
              provider: "native",
              capability: "chat",
              code: ProviderErrorCode.NetworkError,
              message: "interrupted"
            })
          })
      }
    });
    await expect(
      collectRuntimeStream(
        failedRuntime.streamUserMessage(
          { sessionId: "context-session", content: "remember partial" },
          { useMemory: false }
        )
      )
    ).rejects.toBeInstanceOf(ProviderError);

    const restored = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await restored.handleUserMessage(
      { sessionId: "context-session", content: "what was completed?" },
      { useMemory: false }
    );
    const directContext = restored
      .getLatestPromptPreview()
      ?.sections.find((section) => section.name === "DirectContext")?.content;
    expect(directContext).not.toContain("remember partial");
    expect(memoryReads).toBe(0);
    expect((await conversation.listRecentMessages("context-session")).length).toBe(4);
  });
  it("returns the agent reply when optional memory and TTS side effects fail", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const diagnostics: string[] = [];
    const published: RuntimeEvent[] = [];
    const conversation = new InMemoryConversationRepository();
    const persistenceOrder: string[] = [];
    const appendMessage = conversation.appendMessage.bind(conversation);
    conversation.appendMessage = async (message) => {
      persistenceOrder.push(`${message.role}:save`);
      return appendMessage(message);
    };

    eventBus.subscribe("*", (event) => {
      published.push(event);
      if (["user.message", "agent.reply", "assistant.message"].includes(event.type)) {
        persistenceOrder.push(event.type);
      }
    });
    eventBus.subscribe("runtime.error", (event) => {
      diagnostics.push(event.type);
    });
    eventBus.subscribe("provider.error", (event) => {
      diagnostics.push(event.type);
    });

    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createFailingMemory(),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        getChatProvider: () => createMockChatProvider("mock-chat"),
        getReasoningProvider: () => createMockReasoningProvider("mock-reasoning"),
        getTTSProvider: () => ({
          name: "failing-tts",
          async healthCheck() {
            return {
              provider: "failing-tts",
              status: "unavailable",
              checkedAt: new Date().toISOString()
            };
          },
          async synthesizeSpeech() {
            throw new ProviderError({
              provider: "failing-tts",
              capability: "tts",
              code: ProviderErrorCode.ProviderUnavailable,
              message: "TTS is unavailable."
            });
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
              status: "healthy",
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
      }
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "test-session",
      content: "hello",
      voiceOutput: true
    });

    expect(reply!.type).toBe("agent.reply");
    expect(reply!.payload.content).toContain("Mock reply");
    expect(diagnostics).toContain("runtime.error");
    expect(diagnostics).toContain("provider.error");

    const messageEvents = published.filter((event) =>
      ["user.message", "agent.reply", "assistant.message"].includes(event.type)
    );
    expect(messageEvents.map((event) => event.type)).toEqual([
      "user.message",
      "agent.reply",
      "assistant.message"
    ]);
    const userMessage = messageEvents[0]!;
    const agentReply = messageEvents[1]!;
    const assistantMessage = messageEvents[2]!;
    expect(agentReply.traceId).toBe(userMessage.traceId);
    expect(assistantMessage.traceId).toBe(userMessage.traceId);
    expect(agentReply.parentId).toBe(userMessage.id);
    expect(assistantMessage.parentId).toBe(agentReply.id);
    expect(assistantMessage.payload).toMatchObject({
      sessionId: "test-session",
      content: reply!.payload.content,
      provider: reply!.payload.provider
    });
    expect(persistenceOrder).toEqual([
      "user:save",
      "user.message",
      "assistant:save",
      "agent.reply",
      "assistant.message"
    ]);
  });
});

function createFailingMemory(): RuntimeMemoryPort {
  return {
    async retrieveRelevantMemories() {
      return [];
    },
    scoreImportance() {
      return 1;
    },
    async rememberInteraction(): Promise<Memory> {
      throw new Error("memory database unavailable");
    }
  };
}

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

function completeMemoryWrite(idempotencyKey?: string): MemoryConversationTurnWriteResult {
  return {
    status: "complete",
    ok: true,
    attemptedCount: 1,
    writtenCount: 1,
    rejectedCount: 0,
    deduplicatedCount: 0,
    skippedCount: 0,
    memoryId: "memory-id",
    operation: "created",
    idempotencyKey
  };
}

function createMem0RecordingMemory(
  store: (input: Record<string, unknown>) => Promise<MemoryConversationTurnWriteResult>
): RuntimeMemoryPort {
  return {
    async retrieveRelevantMemories() {
      return [];
    },
    scoreImportance() {
      return 0;
    },
    isMem0Backend() {
      return true;
    },
    async storeConversationTurn(input) {
      return store(input as unknown as Record<string, unknown>);
    },
    async rememberInteraction() {
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

function createMockStreamingChatProvider(
  name = "mock-stream-chat",
  options: MockStreamingChatProviderOptions = {}
): ChatProvider {
  return createAssistantAwareChatProvider(createRawMockStreamingChatProvider(name, options));
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

it.each(["EN", "ZH", "JA"] as const)(
  "propagates configured %s despite ambiguous script",
  async (language) => {
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      promptBuilder: new PromptBuilder(),
      outputLanguage: language,
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["同じ文字。"] })
      }
    });
    const events = await collectRuntimeStream(
      runtime.streamUserMessage({ sessionId: "language", content: "hello" })
    );
    const output = events.filter(
      (event) => event.type === "text-delta" || event.type === "completed"
    );
    expect(output.length).toBeGreaterThan(1);
    expect(output.every((event) => event.language === language.toLowerCase())).toBe(true);
  }
);
