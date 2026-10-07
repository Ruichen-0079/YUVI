import { InMemoryEventBus } from "@companion/event-bus";
import { PromptBuilder } from "@companion/prompt-builder";
import type { RuntimeEvent } from "@companion/protocol";
import {
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
  type RuntimeCharacterPort,
  type RuntimeCharacterCognitionExecutor,
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

function setup(
  generate: RuntimeCharacterPort["generate"],
  cognition?: RuntimeCharacterCognitionExecutor
) {
  const captureScreen = vi.fn(async (_signal: AbortSignal) => new Uint8Array([1, 2, 3]));
  const analyzeImage = vi.fn(async () => ({ text: "VISIBLE_ERROR " + "x".repeat(5000) }));
  const eventBus = new InMemoryEventBus({ development: false });
  const published: RuntimeEvent[] = [];
  eventBus.subscribe("*", (event) => {
    published.push(event);
  });
  const { memory, extractCandidates } = memoryStub();
  const runtime = new RuntimeOrchestrator({
    eventBus,
    memory,
    promptBuilder: new PromptBuilder(),
    captureScreen,
    providers: {
      ...providersStub(),
      getVisionProvider: () => ({
        name: "vision",
        analyzeImage,
        healthCheck: async () => ({ provider: "vision", status: "healthy", checkedAt: "" })
      })
    },
    character: { generate, generateAfterCognition: generate },
    ...(cognition ? { characterCognition: cognition } : {})
  });
  return { runtime, captureScreen, analyzeImage, extractCandidates, published };
}
const respond = () =>
  decisionFixture({ disposition: "RESPOND", text: "YUVI original-turn answer" });
async function collect(runtime: RuntimeOrchestrator, signal?: AbortSignal) {
  const events: RuntimeReplyStreamEvent[] = [];
  for await (const event of runtime.streamUserMessage(
    { sessionId: "original", content: "What error is on screen?" },
    { signal, writeMemory: true }
  ))
    events.push(event);
  return events;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("on-demand visual grounding in the original Runtime turn", () => {
  it("does no capture or Vision call when unnecessary", async () => {
    const s = setup(async () => respond());
    await collect(s.runtime);
    expect(s.captureScreen).not.toHaveBeenCalled();
    expect(s.analyzeImage).not.toHaveBeenCalled();
  });
  it("captures once, calls routed Vision once, preserves complete evidence and resumes the same turn without Memory", async () => {
    let evidence: unknown;
    const s = setup(async (input) => {
      expect(input.userMessage).toBe("What error is on screen?");
      evidence = await input.requestVisualEvidence!({ need: "Read the error dialog" });
      return respond();
    });
    const events = await collect(s.runtime);
    expect(s.captureScreen).toHaveBeenCalledTimes(1);
    expect(s.analyzeImage).toHaveBeenCalledTimes(1);
    expect(evidence).toEqual({
      status: "AVAILABLE",
      observations: expect.stringMatching(/^VISIBLE_ERROR/)
    });
    expect(evidence).toEqual({
      status: "AVAILABLE",
      observations: "VISIBLE_ERROR " + "x".repeat(5000)
    });
    expect(s.analyzeImage.mock.calls[0]).toEqual([
      expect.objectContaining({
        image: new Uint8Array([1, 2, 3]),
        prompt: expect.stringContaining("Read the error dialog")
      }),
      expect.objectContaining({ allowFallback: false })
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      sessionId: "original",
      content: "YUVI original-turn answer"
    });
    expect(s.extractCandidates).not.toHaveBeenCalled();
    expect(JSON.stringify(s.published)).not.toContain("VISIBLE_ERROR");
  });
  it.each(["capture", "provider", "empty"])(
    "returns honest unavailability for %s failure",
    async (failure) => {
      let evidence: unknown;
      const s = setup(async (input) => {
        evidence = await input.requestVisualEvidence!({ need: "Read screen" });
        return respond();
      });
      if (failure === "capture") s.captureScreen.mockRejectedValueOnce(new Error("private path"));
      if (failure === "provider")
        s.analyzeImage.mockRejectedValueOnce(new Error("private provider details"));
      if (failure === "empty") s.analyzeImage.mockResolvedValueOnce({ text: "" });
      await collect(s.runtime);
      expect(evidence).toMatchObject({ status: "UNAVAILABLE" });
      expect(JSON.stringify(evidence)).not.toContain("private");
      expect(s.analyzeImage).toHaveBeenCalledTimes(failure === "capture" ? 0 : 1);
    }
  );
  it("rejects a second semantic request without recapturing", async () => {
    const s = setup(async (input) => {
      await input.requestVisualEvidence!({ need: "Read screen" });
      await input.requestVisualEvidence!({ need: "Again" });
      return respond();
    });
    await expect(collect(s.runtime)).rejects.toThrow("Only one");
    expect(s.captureScreen).toHaveBeenCalledTimes(1);
  });
  it.each(["capture", "provider"])(
    "fences cancellation during %s even if the dependency ignores abort",
    async (stage) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const controller = new AbortController();
      let resumed = false;
      const s = setup(async (input) => {
        await input.requestVisualEvidence!({ need: "Read screen" });
        resumed = true;
        return respond();
      });
      if (stage === "capture")
        s.captureScreen.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return new Uint8Array([1]);
        });
      else
        s.analyzeImage.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { text: "stale" };
        });
      const pending = collect(s.runtime, controller.signal);
      await entered.promise;
      controller.abort();
      release.resolve();
      await expect(pending).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
      expect(resumed).toBe(false);
      if (stage === "capture") expect(s.analyzeImage).not.toHaveBeenCalled();
      expect(s.published.some((event) => event.type === "agent.reply")).toBe(false);
    }
  );
  it("fences old evidence when a newer turn starts", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let turns = 0;
    const s = setup(async (input) => {
      if (++turns === 1) await input.requestVisualEvidence!({ need: "Read screen" });
      return respond();
    });
    s.analyzeImage.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { text: "stale" };
    });
    const pending = collect(s.runtime);
    await entered.promise;
    await collect(s.runtime);
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(s.published.filter((event) => event.type === "agent.reply")).toHaveLength(1);
  });
});

it("times out an abort-ignoring Vision call and resumes honestly", async () => {
  vi.useFakeTimers();
  try {
    const entered = deferred<void>();
    let evidence: unknown;
    const s = setup(async (input) => {
      evidence = await input.requestVisualEvidence!({ need: "Read screen" });
      return respond();
    });
    s.analyzeImage.mockImplementationOnce(async () => {
      entered.resolve();
      return new Promise(() => {});
    });
    const pending = collect(s.runtime);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(45_000);
    await pending;
    expect(evidence).toMatchObject({ status: "UNAVAILABLE" });
    expect(s.captureScreen).toHaveBeenCalledTimes(1);
    expect(s.analyzeImage).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps non-streaming grounded turns out of automatic Memory too", async () => {
  const s = setup(async (input) => {
    await input.requestVisualEvidence!({ need: "Read screen" });
    return respond();
  });
  const reply = await s.runtime.handleUserMessage(
    { sessionId: "original", content: "Read screen" },
    { writeMemory: true }
  );
  expect(reply?.payload.content).toBe("YUVI original-turn answer");
  expect(s.extractCandidates).not.toHaveBeenCalled();
});

describe("explicit user image attachment grounding", () => {
  it("preserves selected visual evidence and source descriptions through Cognition and Character re-entry", async () => {
    const sourceJournalRef = {
      kind: "JOURNAL_EVENT" as const,
      namespace: "test",
      eventId: "jev1_0000000000000001"
    };
    let calls = 0;
    const cognition = vi.fn(async (_request, _problem, options) => {
      expect(options.canonicalContext.multimodalEvidence).toContain("VISIBLE_ERROR");
      expect(options.canonicalContext.multimodalEvidence).toContain(sourceJournalRef.eventId);
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
          answer: "Reasoned answer"
        }
      };
    });
    const s = setup(async (input) => {
      if (++calls === 1) {
        await input.requestVisualEvidence!({
          need: "Read the diagram",
          sourceReference: "image:a"
        });
        return decisionFixture({ disposition: "NEED_COGNITION", focus: "verification" });
      }
      expect(input.visualEvidence).toMatchObject({ status: "AVAILABLE", sourceJournalRef });
      expect(input.visualSources).toMatchObject([{ reference: "image:a" }]);
      return respond();
    }, cognition);
    await s.runtime.handleUserMessage(
      { sessionId: "observed", content: "Read then verify the diagram" },
      {
        visualSources: [
          {
            reference: "image:a",
            sourceJournalRef,
            read: async () => ({ imageBase64: "AQID", mimeType: "image/png" })
          }
        ]
      }
    );
    expect(cognition).toHaveBeenCalledOnce();
    expect(s.analyzeImage).toHaveBeenCalledOnce();
    expect(s.captureScreen).not.toHaveBeenCalled();
    expect(calls).toBe(2);
  });
  it("reads only the explicitly selected observation source through the existing Vision cycle, with no desktop capture or implicit attachment", async () => {
    const sourceJournalRef = {
      kind: "JOURNAL_EVENT" as const,
      namespace: "test",
      eventId: "jev1_0000000000000001"
    };
    const first = vi.fn(async () => ({ imageBase64: "AQID", mimeType: "image/png" as const }));
    const second = vi.fn(async () => ({ imageBase64: "BAUG", mimeType: "image/png" as const }));
    let evidence: unknown;
    const s = setup(async (input) => {
      expect(input.visualSources?.map((source) => source.reference)).toEqual([
        "image:a",
        "image:b"
      ]);
      evidence = await input.requestVisualEvidence!({
        need: "Describe B's diagram",
        sourceReference: "image:b"
      });
      return respond();
    });
    const result = await s.runtime.handleUserMessage(
      { sessionId: "observed", content: "What is in B's diagram?" },
      {
        visualSources: [
          { reference: "image:a", sourceJournalRef, read: first },
          { reference: "image:b", sourceJournalRef, read: second }
        ]
      }
    );
    expect(result?.payload.content).toContain("original-turn answer");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(s.captureScreen).not.toHaveBeenCalled();
    expect(s.analyzeImage).toHaveBeenCalledOnce();
    expect(evidence).toMatchObject({ status: "AVAILABLE", sourceJournalRef });
    expect(s.extractCandidates).not.toHaveBeenCalled();
  });
  it("never guesses an image source or falls back to desktop capture for a surface with no selected source", async () => {
    const s = setup(async (input) => {
      expect(await input.requestVisualEvidence!({ need: "look at it" })).toMatchObject({
        status: "UNAVAILABLE"
      });
      return respond();
    });
    await s.runtime.handleUserMessage(
      { sessionId: "observed", content: "What image?" },
      { visualSources: [] }
    );
    expect(s.captureScreen).not.toHaveBeenCalled();
    expect(s.analyzeImage).not.toHaveBeenCalled();
  });
  async function collectAttached(
    runtime: RuntimeOrchestrator,
    options: { signal?: AbortSignal; imageBase64?: string } = {}
  ) {
    const events: RuntimeReplyStreamEvent[] = [];
    for await (const event of runtime.streamUserMessage(
      { sessionId: "attached", content: "What is shown in this image?" },
      {
        writeMemory: true,
        imageAttachment: {
          imageBase64: options.imageBase64 ?? "AQID",
          mimeType: "image/png"
        },
        ...(options.signal ? { signal: options.signal } : {})
      }
    )) {
      events.push(event);
    }
    return events;
  }

  it("uses routed Vision once and hands complete evidence to the same Character turn", async () => {
    let attachedEvidence: unknown;
    const s = setup(async (input) => {
      attachedEvidence = input.visualEvidence;
      return respond();
    });
    s.analyzeImage.mockImplementationOnce(async () => {
      expect(s.published.some((event) => event.type === "user.message")).toBe(true);
      return {
        text: "VISIBLE_ERROR " + "x".repeat(5000),
        sceneSummary: "VISIBLE_ERROR " + "x".repeat(5000)
      };
    });

    const events = await collectAttached(s.runtime);

    expect(s.captureScreen).not.toHaveBeenCalled();
    expect(s.analyzeImage).toHaveBeenCalledTimes(1);
    const visionCall = s.analyzeImage.mock.calls[0] as unknown as [
      { imageBase64: string; mimeType: string; prompt: string },
      { allowFallback?: boolean; signal?: AbortSignal }
    ];
    expect(visionCall[0]).toMatchObject({
      imageBase64: "AQID",
      mimeType: "image/png",
      prompt: expect.stringContaining("What is shown in this image?")
    });
    expect(visionCall[1]).toMatchObject({ allowFallback: false });
    expect(visionCall[1].signal).toBeInstanceOf(AbortSignal);
    expect(attachedEvidence).toEqual({
      status: "AVAILABLE",
      observations: expect.stringMatching(/^VISIBLE_ERROR/)
    });
    expect(attachedEvidence).toEqual({
      status: "AVAILABLE",
      observations: "VISIBLE_ERROR " + "x".repeat(5000)
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      sessionId: "attached",
      content: "YUVI original-turn answer"
    });
    expect(JSON.stringify(s.published)).not.toContain("AQID");
    expect(s.published.some((event) => event.type === "perception.vision")).toBe(false);
    expect(s.extractCandidates).not.toHaveBeenCalled();
  });

  it("does not allow an attached-image turn to request a second screen grounding cycle", async () => {
    const s = setup(async (input) => {
      expect(input.visualEvidence).toBeDefined();
      await input.requestVisualEvidence!({ need: "capture screen too" });
      return respond();
    });

    await expect(collectAttached(s.runtime)).rejects.toThrow("Only one visual grounding cycle");
    expect(s.captureScreen).not.toHaveBeenCalled();
    expect(s.analyzeImage).toHaveBeenCalledTimes(1);
  });

  it("degrades provider failure to unavailable evidence without inventing image contents", async () => {
    let attachedEvidence: unknown;
    const s = setup(async (input) => {
      attachedEvidence = input.visualEvidence;
      return respond();
    });
    s.analyzeImage.mockRejectedValueOnce(new Error("private provider failure"));

    await collectAttached(s.runtime);

    expect(attachedEvidence).toEqual({
      status: "UNAVAILABLE",
      observations: "Attached image analysis failed. Image contents are unknown."
    });
    expect(JSON.stringify(attachedEvidence)).not.toContain("private provider failure");
    expect(s.extractCandidates).not.toHaveBeenCalled();
  });

  it("fences an attachment result when the caller cancels during Vision", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    let characterRan = false;
    const s = setup(async () => {
      characterRan = true;
      return respond();
    });
    s.analyzeImage.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { text: "stale attached evidence" };
    });

    const pending = collectAttached(s.runtime, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    release.resolve();

    await expect(pending).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(characterRan).toBe(false);
    expect(s.published.some((event) => event.type === "agent.reply")).toBe(false);
  });

  it("fences old attached evidence when a newer explicit turn starts", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let characterCalls = 0;
    const s = setup(async () => {
      characterCalls += 1;
      return respond();
    });
    s.analyzeImage.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { text: "stale attached evidence" };
    });

    const pending = collectAttached(s.runtime);
    await entered.promise;
    await collect(s.runtime);
    release.resolve();

    await expect(pending).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(characterCalls).toBe(1);
  });

  it("rejects invalid attachment bytes before Vision and still keeps the turn epistemically honest", async () => {
    let attachedEvidence: unknown;
    const s = setup(async (input) => {
      attachedEvidence = input.visualEvidence;
      return respond();
    });

    await collectAttached(s.runtime, { imageBase64: "***not-base64***" });

    expect(s.analyzeImage).not.toHaveBeenCalled();
    expect(attachedEvidence).toMatchObject({
      status: "UNAVAILABLE",
      observations: expect.stringContaining("invalid")
    });
    expect(s.extractCandidates).not.toHaveBeenCalled();
  });
});
