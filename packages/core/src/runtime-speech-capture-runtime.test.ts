import { InMemoryEventBus } from "@companion/event-bus";
import { InMemoryConversationRepository } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import { createEvent } from "@companion/protocol";
import type { JournalCommittedEnvelope, RuntimeEvent } from "@companion/protocol";
import {
  createMockAssistantContinuationProvider,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider,
  type ProviderResolver,
  type STTOutput
} from "@companion/providers";
import { describe, expect, it } from "vitest";
import {
  ProactiveAdmissionError,
  RuntimeOrchestrator,
  SpeechCaptureFenceError,
  type RuntimeCharacterPort,
  type RuntimeCharacterTurnResult,
  type RuntimeMemoryPort
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
      throw new Error("speech capture tests must not write Memory");
    },
    async rememberInteraction() {
      return null;
    }
  };
}

function providers(stt?: STTOutput): ProviderResolver {
  return {
    getChatProvider: () => createMockChatProvider("capture-chat"),
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider("REQUEST_TEXT"),
    getAssistantContinuationProvider: () =>
      createMockAssistantContinuationProvider("proactive hello"),
    getReasoningProvider: () => createMockReasoningProvider("capture-reasoning"),
    getTTSProvider: () => ({
      name: "capture-tts",
      async healthCheck() {
        return {
          provider: "capture-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech() {
        throw new Error("TTS must not run");
      }
    }),
    getSTTProvider: () =>
      stt
        ? {
            name: "capture-stt",
            async healthCheck() {
              return {
                provider: "capture-stt",
                status: "healthy" as const,
                checkedAt: new Date().toISOString()
              };
            },
            async transcribeAudio() {
              return stt;
            }
          }
        : createMockSTTProvider("capture-stt"),
    getVisionProvider: () => createMockVisionProvider("capture-vision"),
    getEmbeddingProvider: () => ({
      name: "capture-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "capture-embedding",
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

function characterPort(): RuntimeCharacterPort {
  const result: RuntimeCharacterTurnResult = {
    decision: {
      addressing: "DIRECTED_TO_YUVI",
      reply: { disposition: "RESPOND", text: "好" },
      proactive: { action: "KEEP" }
    },
    providerMetadata: { model: "capture-character" }
  };
  return {
    async generate() {
      return result;
    },
    async generateAfterCognition() {
      throw new Error("cognition must not run");
    }
  };
}

function createRuntime(stt?: STTOutput): RuntimeOrchestrator {
  return new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory: memoryStub(),
    promptBuilder: new PromptBuilder(),
    conversation: new InMemoryConversationRepository(),
    providers: providers(stt),
    character: characterPort()
  });
}

let testReceiptSequence = 0;
function receiptForTestReservation(
  reservation: ReturnType<RuntimeOrchestrator["reserveFinalizedSpeechObservation"]>
): JournalCommittedEnvelope {
  const sequence = ++testReceiptSequence;
  return {
    version: "life-event-envelope.v1",
    eventId: `jev1_${String(sequence).padStart(16, "0")}`,
    journalNamespace: "test:speech",
    commitSeq: sequence,
    recordedAt: "2026-09-25T00:00:00.000Z",
    command: {
      version: "life-event-command.v1",
      kind: "RECEIPT",
      occurrenceTime: { state: "UNKNOWN" },
      causalParents: [],
      data: { receiptClass: "DIRECT_OBSERVATION", evidenceSelectors: [] }
    },
    authority: {
      journalNamespace: "test:speech",
      principal: { state: "UNRESOLVED", reason: "test fixture" },
      subjects: [],
      binding: { state: "UNRESOLVED", reason: "test fixture" },
      surface: { kind: "LOCAL", reference: "test" },
      correlations: [
        { kind: "CONVERSATION", sessionId: reservation.sessionId },
        {
          kind: "VOICE_OBSERVATION",
          observationId: reservation.observation.observationId,
          captureEpoch: reservation.captureEpoch
        }
      ],
      audience: { kind: "UNKNOWN", reason: "test fixture" },
      disclosurePolicy: { state: "UNRESOLVED", reason: "test fixture" },
      policyVersion: "test.v1",
      producer: { name: "test", version: "1" },
      sourceReferences: [
        {
          kind: "VOICE_OBSERVATION",
          observationId: reservation.observation.observationId,
          captureEpoch: reservation.captureEpoch
        }
      ],
      payloads: []
    }
  } as JournalCommittedEnvelope;
}

function admitSpeechForTest(
  runtime: RuntimeOrchestrator,
  observation: STTOutput,
  options: { sessionId?: string; captureEpoch?: string } = {}
): STTOutput {
  const reservation = runtime.reserveFinalizedSpeechObservation(observation, options);
  const receipt = receiptForTestReservation(reservation);
  const finalized = runtime.finalizeSpeechReservation(reservation.token, receipt);
  if (finalized.status !== "ready")
    throw new Error(`Test speech did not become ready: ${finalized.status}`);
  return finalized.observation;
}

async function collect(stream: AsyncIterable<{ type: string }>): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Runtime finalized capture lifecycle", () => {
  it("keeps reservation provisional until a matching committed receipt is finalized", () => {
    const runtime = createRuntime();
    const before = runtime.getProactiveState().activityRevision;
    const reservation = runtime.reserveFinalizedSpeechObservation(
      {
        text: "hello",
        observationId: "obs-provisional",
        segments: [{ segmentId: "seg-provisional" }]
      },
      { sessionId: "s", captureEpoch: "epoch-provisional" }
    );
    expect(runtime.getProactiveState().activityRevision).toBe(before);
    expect(() => runtime.commitSpeechTurn("obs-provisional", "s", "hello")).toThrow();
    expect(runtime.releaseSpeechReservation(reservation.token)).toBe(true);
    expect(runtime.getProactiveState().activityRevision).toBe(before);
    expect(() => runtime.commitSpeechTurn("obs-provisional", "s", "hello")).toThrow();
  });

  it("keeps a new VAD epoch responsive and refuses handoff after a receipt commits stale", () => {
    const runtime = createRuntime();
    runtime.observeSpeechActivity({ sessionId: "race", captureEpoch: "epoch-old", active: true });
    const reservation = runtime.reserveFinalizedSpeechObservation(
      { text: "old speech", observationId: "obs-race", segments: [{ segmentId: "seg-race" }] },
      { sessionId: "race", captureEpoch: "epoch-old" }
    );
    const beforeNewEpoch = runtime.getProactiveState().activityRevision;
    const newer = runtime.observeSpeechActivity({
      sessionId: "race",
      captureEpoch: "epoch-new",
      active: true
    });
    expect(newer.captureEpoch).toBe("epoch-new");
    expect(runtime.getProactiveState().activityRevision).toBe(beforeNewEpoch + 1);

    const finalized = runtime.finalizeSpeechReservation(
      reservation.token,
      receiptForTestReservation(reservation)
    );
    expect(finalized.status).toBe("stale");
    expect(runtime.getSpeechActivitySnapshot().captureEpoch).toBe("epoch-new");
    expect(runtime.getProactiveState().activityRevision).toBe(beforeNewEpoch + 1);
    expect(() => runtime.commitSpeechTurn("obs-race", "race", "old speech")).toThrow();
  });

  it("does not advance capture state when Journal failure releases a new-epoch reservation", () => {
    const runtime = createRuntime();
    runtime.observeSpeechActivity({
      sessionId: "release",
      captureEpoch: "epoch-old",
      active: true
    });
    const reservation = runtime.reserveFinalizedSpeechObservation(
      { text: "retry me", observationId: "obs-release", segments: [{ segmentId: "seg-release" }] },
      { sessionId: "release", captureEpoch: "epoch-new" }
    );
    runtime.releaseSpeechReservation(reservation.token);
    expect(runtime.getSpeechActivitySnapshot().captureEpoch).toBe("epoch-old");
    const retry = runtime.reserveFinalizedSpeechObservation(
      { text: "retry me", observationId: "obs-release", segments: [{ segmentId: "seg-release" }] },
      { sessionId: "release", captureEpoch: "epoch-new" }
    );
    expect(retry.observation.observationId).toBe("obs-release");
    runtime.releaseSpeechReservation(retry.token);
  });

  it("keeps explicit PTT as an admitted interaction after a fenced observation", async () => {
    const runtime = createRuntime();
    const observation = admitSpeechForTest(
      runtime,
      {
        text: "几点了",
        language: "zh",
        observationId: "obs-ptt",
        segments: [{ segmentId: "seg-ptt", text: "几点了", speakerClusterId: "0" }]
      },
      { sessionId: "voice", captureEpoch: "epoch-ptt" }
    );
    const reply = await runtime.handleUserMessage(
      createEvent("user.voice.transcript", {
        sessionId: "voice",
        content: observation.text,
        language: observation.language
      }),
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(reply?.payload.content).toBe("好");
  });

  it("does not turn a finalized observation into a UserMessage", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: providers({
        text: "ambient",
        observationId: "obs-ambient",
        segments: [{ segmentId: "seg-ambient", text: "ambient", speakerClusterId: "1" }]
      })
    });
    const observation = await runtime.transcribeSpeechAudio({
      sessionId: "obs",
      audioBase64: "AQID",
      captureEpoch: "epoch-ambient"
    });
    expect(observation.text).toBe("ambient");
    expect(observation.captureEpoch).toBeUndefined();
    expect(published.some((event) => event.type === "user.message")).toBe(false);
    expect(published.some((event) => event.type === "user.voice.transcript")).toBe(false);
  });

  it("advances activityRevision on accepted capture without clearing suppression", async () => {
    const engaged = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: providers(),
      character: {
        async generate() {
          return {
            decision: {
              addressing: "DIRECTED_TO_YUVI" as const,
              reply: { disposition: "RESPOND" as const, text: "好" },
              proactive: {
                action: "SUPPRESS" as const,
                scope: { kind: "UNTIL_ENGAGEMENT" as const }
              }
            },
            providerMetadata: { model: "capture-character" }
          };
        },
        async generateAfterCognition() {
          throw new Error("cognition must not run");
        }
      }
    });
    await engaged.handleUserMessage(
      { sessionId: "eng", content: "安静直到我再找你" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(engaged.getProactiveState().suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });
    const revision = engaged.getProactiveState().activityRevision;
    admitSpeechForTest(
      engaged,
      {
        text: "tv noise",
        segments: [{ segmentId: "seg-tv", text: "tv noise", speakerClusterId: "unk" }]
      },
      { sessionId: "eng", captureEpoch: "epoch-tv" }
    );
    expect(engaged.getProactiveState().activityRevision).toBe(revision + 1);
    expect(engaged.getProactiveState().suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });
  });

  it("does not treat speech capture as explicit resume", async () => {
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: providers(),
      character: {
        async generate() {
          return {
            decision: {
              addressing: "DIRECTED_TO_YUVI" as const,
              reply: { disposition: "RESPOND" as const, text: "好" },
              proactive: {
                action: "SUPPRESS" as const,
                scope: { kind: "UNTIL_EXPLICIT_RESUME" as const }
              }
            },
            providerMetadata: { model: "capture-character" }
          };
        },
        async generateAfterCognition() {
          throw new Error("cognition must not run");
        }
      }
    });
    await runtime.handleUserMessage(
      { sessionId: "r", content: "别再主动说话" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    admitSpeechForTest(
      runtime,
      { text: "noise", segments: [{ segmentId: "seg-r", text: "noise" }] },
      { sessionId: "r", captureEpoch: "epoch-r" }
    );
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "UNTIL_EXPLICIT_RESUME" });
  });

  it("stales an in-flight proactive attempt when a newer capture advances revision", async () => {
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
        idempotencyKey: "stale-capture",
        readMemory: false
      })
    );
    await continuationBegan;
    admitSpeechForTest(
      runtime,
      { text: "new capture", segments: [{ segmentId: "seg-new", text: "new capture" }] },
      { sessionId: "s", captureEpoch: "epoch-new" }
    );
    expect(runtime.getProactiveState().activityRevision).toBe(startedRevision + 1);
    release();
    await expect(pending).rejects.toMatchObject({
      name: "ProactiveAdmissionError",
      reason: "stale-revision"
    });
    expect(ProactiveAdmissionError).toBeDefined();
  });

  it("keeps speaker clusters unresolved after fencing", () => {
    const runtime = createRuntime();
    const observation = admitSpeechForTest(
      runtime,
      {
        text: "two speakers",
        segments: [
          { segmentId: "seg-0", speakerClusterId: "0" },
          { segmentId: "seg-1", speakerClusterId: "1" }
        ]
      },
      { sessionId: "s", captureEpoch: "epoch-diar" }
    );
    expect(observation.segments?.map((segment) => segment.speakerClusterId)).toEqual(["0", "1"]);
    expect(JSON.stringify(observation)).not.toMatch(/personId/);
    const interpretation = runtime.interpretSpeechObservationIdentity({
      observation,
      address: {
        characterInstanceId: "yuvi-default-character-instance",
        personaProfileId: "yuvi-default-persona-profile"
      },
      scopeReference: "scope-voice-runtime"
    });
    expect(interpretation.remainsObservation).toBe(true);
    expect(interpretation.resolutions).toHaveLength(2);
    expect(interpretation.resolutions[0]?.speakerClusterId).toBe("0");
    expect(interpretation.resolutions[1]?.speakerClusterId).toBe("1");
    expect(interpretation.characterSpeakers).toEqual([
      { speaker: "unknown" },
      { speaker: "unknown" }
    ]);
    expect(interpretation.claimAssertor).toEqual({ resolution: "unresolved" });
    expect(JSON.stringify(interpretation.characterSpeakers)).not.toMatch(
      /voiceProfileId|embedding|threshold|score/
    );
  });

  it("throws on a duplicate Runtime claim of the same epoch and segment", () => {
    const runtime = createRuntime();
    const first = {
      text: "hello",
      segments: [{ segmentId: "seg-dup", text: "hello" }]
    };
    admitSpeechForTest(runtime, first, { sessionId: "s", captureEpoch: "epoch-dup" });
    expect(() =>
      admitSpeechForTest(runtime, first, { sessionId: "s", captureEpoch: "epoch-dup" })
    ).toThrow(SpeechCaptureFenceError);
  });
  it("commits server-owned acoustic evidence once, retaining mixed per-span profiles", () => {
    const runtime = createRuntime();
    const observation = admitSpeechForTest(
      runtime,
      {
        text: "hello there",
        segments: [
          {
            segmentId: "s1",
            text: "hello",
            speakerClusterId: "0",
            voiceProfileMatch: { status: "MATCHED", voiceProfileId: "profile-a" }
          },
          {
            segmentId: "s2",
            text: "there",
            speakerClusterId: "1",
            voiceProfileMatch: { status: "NO_MATCH" }
          }
        ]
      },
      { sessionId: "s", captureEpoch: "epoch-commit" }
    );
    expect(() =>
      runtime.commitSpeechTurn(observation.observationId!, "other", observation.text)
    ).toThrow();
    const event = runtime.commitSpeechTurn(observation.observationId!, "s", observation.text);
    expect(event.type).toBe("user.voice.transcript");
    expect(event.payload.voiceProfileId).toBeUndefined();
    expect(event.payload.segments?.[0]?.voiceProfileMatch?.voiceProfileId).toBe("profile-a");
    expect(event.payload.segments?.[1]?.voiceProfileMatch).toEqual({ status: "NO_MATCH" });
    expect(() =>
      runtime.commitSpeechTurn(observation.observationId!, "s", observation.text)
    ).toThrow();
  });

  it("preserves a single recognized acoustic profile without manufacturing a person", () => {
    const runtime = createRuntime();
    const observation = admitSpeechForTest(
      runtime,
      { text: "hello", voiceProfileMatch: { status: "MATCHED", voiceProfileId: "profile-a" } },
      { sessionId: "s" }
    );
    const event = runtime.commitSpeechTurn(observation.observationId!, "s", "hello");
    expect(event.payload.voiceProfileId).toBe("profile-a");
    expect(event.payload).not.toHaveProperty("subjectUserId");
    expect(event.payload).not.toHaveProperty("speakerId");
  });

  it("does not fill missing segment identities from a whole-capture match", () => {
    const runtime = createRuntime();
    const observation = admitSpeechForTest(
      runtime,
      {
        text: "two spans",
        voiceProfileMatch: { status: "MATCHED", voiceProfileId: "profile-a" },
        segments: [{ text: "two" }, { text: "spans" }]
      },
      { sessionId: "s" }
    );
    const event = runtime.commitSpeechTurn(observation.observationId!, "s", observation.text);
    expect(event.payload.voiceProfileId).toBeUndefined();
    expect(event.payload.segments?.every((segment) => !segment.voiceProfileMatch)).toBe(true);
  });
});
