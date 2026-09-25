import { createEvent } from "@companion/protocol";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  ProviderErrorCode,
  type ProviderCallOptions,
  type STTInput,
  type STTOutput,
  type TTSInput,
  type TTSOutput,
  type VisionInput,
  type VisionOutput
} from "@companion/providers";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { SpeechCaptureFenceError } from "@companion/core";
import { JournalStoreError } from "@companion/journal";
import type { AppContext } from "../context.js";
import {
  type VisionReceiptAdmission,
  type VisionReceiptInput
} from "../vision-receipt-admission.js";
import { createTestVisionReceiptAdmission } from "../test-support/vision-receipt.js";
import { registerMediaRoutes } from "./media.js";

const routeCases = ["/v1/audio/transcriptions", "/v1/voice/message"] as const;

type TestSTTTranscriber = (input: STTInput, options?: ProviderCallOptions) => Promise<STTOutput>;

type TestTTSSynthesizer = (input: TTSInput, options?: ProviderCallOptions) => Promise<TTSOutput>;

type TestVisionAnalyzer = (
  input: VisionInput,
  options?: ProviderCallOptions
) => Promise<VisionOutput>;

type RequestCapture = {
  raw: IncomingMessage | undefined;
  socket: Socket | undefined;
  rawAbortedListenersBefore: number | undefined;
  socketCloseListenersBefore: number | undefined;
};

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

function recognizedOutput(): STTOutput {
  return {
    text: "recognized speech",
    language: "en",
    confidence: 0.9,
    model: "test-stt",
    providerMetadata: { sourceKind: "base64" }
  };
}

function speechOutput(): TTSOutput {
  return {
    audio: new Uint8Array([1, 2, 3]),
    audioBase64: "AQID",
    mimeType: "audio/wav",
    durationMs: 42,
    model: "test-tts",
    finalProvider: "test-tts",
    providerMetadata: { sourceKind: "test" }
  };
}

function visionOutput(): VisionOutput {
  return {
    text: "a bright scene",
    sceneSummary: "a bright scene",
    model: "test-vision",
    finalProvider: "test-vision",
    providerMetadata: { sourceKind: "test" }
  };
}

let mockSpeechReceiptSequence = 0;
function mockSpeechReceipt(observation: STTOutput, sessionId: string): any {
  const sequence = ++mockSpeechReceiptSequence;
  return {
    version: "life-event-envelope.v1",
    eventId: `jev1_${String(sequence).padStart(16, "0")}`,
    journalNamespace: "test:speech",
    commitSeq: sequence,
    recordedAt: "2026-09-25T00:00:00.000Z",
    command: { kind: "RECEIPT" },
    authority: {
      correlations: [
        { kind: "CONVERSATION", sessionId },
        {
          kind: "VOICE_OBSERVATION",
          observationId: observation.observationId,
          captureEpoch: observation.captureEpoch
        }
      ]
    }
  };
}

function cancelledProviderError(effectState: "not_started" | "unknown"): ProviderError {
  return new ProviderError({
    provider: "test-stt",
    capability: "stt",
    code: ProviderErrorCode.Cancelled,
    message: "STT operation cancelled.",
    retryable: false,
    fallbackEligible: false,
    effectState
  });
}

function cancelledTTSError(effectState: "not_started" | "unknown"): ProviderError {
  return new ProviderError({
    provider: "test-tts",
    capability: "tts",
    code: ProviderErrorCode.Cancelled,
    message: "TTS operation cancelled.",
    retryable: false,
    fallbackEligible: false,
    effectState
  });
}

function createContext() {
  const transcribeAudio = vi.fn(async () => ({
    text: "recognized speech",
    language: "en",
    confidence: 0.9,
    model: "test-stt",
    providerMetadata: { sourceKind: "base64" }
  }));
  let reserved:
    | { token: string; sessionId: string; captureEpoch: string; observation: STTOutput }
    | undefined;
  const context = {
    providers: { getSTTProvider: () => ({ transcribeAudio }) },
    runtime: {
      commitSpeechTurn: vi.fn((observationId: string, sessionId: string, content: string) =>
        createEvent("user.voice.transcript", { observationId, sessionId, content })
      ),
      handleUserMessage: vi.fn(async () => ({
        payload: { content: "reply", provider: "mock" },
        traceId: "trace-1"
      })),
      reserveFinalizedSpeechObservation: vi.fn(
        (output: STTOutput, options: { sessionId?: string }) => {
          const observation = {
            ...output,
            observationId: output.observationId ?? "observation-test",
            captureEpoch: output.captureEpoch ?? "epoch-test"
          };
          reserved = {
            token: "reservation-test",
            sessionId: options.sessionId ?? "default",
            captureEpoch: observation.captureEpoch!,
            observation
          };
          return reserved;
        }
      ),
      finalizeSpeechReservation: vi.fn(() => ({ status: "ready", ...reserved! })),
      releaseSpeechReservation: vi.fn(),
      getLatestPromptPreview: vi.fn(() => undefined)
    },
    speechReceiptAdmission: {
      admit: vi.fn(async () =>
        mockSpeechReceipt(
          {
            observationId: "observation-test",
            captureEpoch: "epoch-test",
            text: "recognized speech"
          },
          "default"
        )
      )
    }
  } as unknown as AppContext;
  return { context, transcribeAudio };
}

async function createApp() {
  const { context, transcribeAudio } = createContext();
  const app = Fastify({ logger: false });
  await registerMediaRoutes(app, context);
  return { app, transcribeAudio };
}

async function createLifecycleApp(
  route: (typeof routeCases)[number],
  transcribeAudio: TestSTTTranscriber,
  runtimeHandler?: (...args: never[]) => Promise<unknown>,
  configureRequest?: (raw: IncomingMessage, socket: Socket | undefined) => void
): Promise<{
  app: ReturnType<typeof Fastify>;
  transcribeAudio: TestSTTTranscriber;
  handleUserMessage: ReturnType<typeof vi.fn>;
  commitSpeechTurn: ReturnType<typeof vi.fn>;
  reserveFinalizedSpeechObservation: ReturnType<typeof vi.fn>;
  finalizeSpeechReservation: ReturnType<typeof vi.fn>;
  releaseSpeechReservation: ReturnType<typeof vi.fn>;
  speechReceiptAdmission: { admit: ReturnType<typeof vi.fn> };
  request: RequestCapture;
}> {
  const handleUserMessage = vi.fn(
    runtimeHandler ??
      (async () => ({
        payload: { content: "reply", provider: "mock" },
        traceId: "trace-1"
      }))
  );
  const commitSpeechTurn = vi.fn((observationId: string, sessionId: string, content: string) =>
    createEvent("user.voice.transcript", {
      observationId,
      sessionId,
      content,
      language: "en",
      confidence: 0.9
    })
  );
  let latestReservation:
    | { token: string; sessionId: string; captureEpoch: string; observation: STTOutput }
    | undefined;
  const reserveFinalizedSpeechObservation = vi.fn(
    (output: STTOutput, options: { sessionId?: string; captureEpoch?: string }) => {
      const observation = {
        ...output,
        observationId: output.observationId ?? "observation-test",
        captureEpoch: options.captureEpoch ?? output.captureEpoch ?? "epoch-test"
      };
      latestReservation = {
        token: "reservation-test",
        sessionId: options.sessionId ?? "default",
        captureEpoch: observation.captureEpoch!,
        observation
      };
      return latestReservation;
    }
  );
  const finalizeSpeechReservation = vi.fn(() => ({ status: "ready", ...latestReservation! }));
  const releaseSpeechReservation = vi.fn();
  const speechReceiptAdmission = {
    admit: vi.fn(
      async ({ observation, sessionId }: { observation: STTOutput; sessionId: string }) =>
        mockSpeechReceipt(observation, sessionId)
    )
  };
  const context = {
    providers: { getSTTProvider: () => ({ transcribeAudio }) },
    runtime: {
      handleUserMessage,
      commitSpeechTurn,
      reserveFinalizedSpeechObservation,
      finalizeSpeechReservation,
      releaseSpeechReservation,
      getLatestPromptPreview: vi.fn(() => undefined)
    },
    speechReceiptAdmission
  } as unknown as AppContext;
  const request: RequestCapture = {
    raw: undefined,
    socket: undefined,
    rawAbortedListenersBefore: undefined,
    socketCloseListenersBefore: undefined
  };
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (incomingRequest) => {
    request.raw = incomingRequest.raw;
    request.socket = incomingRequest.raw.socket ?? undefined;
    request.rawAbortedListenersBefore = request.raw.listenerCount("aborted");
    request.socketCloseListenersBefore = request.socket?.listenerCount("close");
    configureRequest?.(request.raw, request.socket);
  });
  await registerMediaRoutes(app, context);
  return {
    app,
    transcribeAudio,
    handleUserMessage,
    commitSpeechTurn,
    reserveFinalizedSpeechObservation,
    finalizeSpeechReservation,
    releaseSpeechReservation,
    speechReceiptAdmission,
    request
  };
}

async function createTTSLifecycleApp(
  synthesizeSpeech: TestTTSSynthesizer,
  configureRequest?: (raw: IncomingMessage, socket: Socket | undefined) => void
): Promise<{
  app: ReturnType<typeof Fastify>;
  synthesizeSpeech: TestTTSSynthesizer;
  request: RequestCapture;
}> {
  const context = {
    providers: { getTTSProvider: () => ({ name: "test-tts", synthesizeSpeech }) },
    runtime: {
      handleUserMessage: vi.fn(),
      getLatestPromptPreview: vi.fn(() => undefined)
    }
  } as unknown as AppContext;
  const request: RequestCapture = {
    raw: undefined,
    socket: undefined,
    rawAbortedListenersBefore: undefined,
    socketCloseListenersBefore: undefined
  };
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (incomingRequest) => {
    request.raw = incomingRequest.raw;
    request.socket = incomingRequest.raw.socket ?? undefined;
    request.rawAbortedListenersBefore = request.raw.listenerCount("aborted");
    request.socketCloseListenersBefore = request.socket?.listenerCount("close");
    configureRequest?.(request.raw, request.socket);
  });
  await registerMediaRoutes(app, context);
  return { app, synthesizeSpeech, request };
}

async function createVisionLifecycleApp(
  analyzeImage: TestVisionAnalyzer,
  configureRequest?: (raw: IncomingMessage, socket: Socket | undefined) => void,
  visionReceiptAdmission: VisionReceiptAdmission = createTestVisionReceiptAdmission()
): Promise<{
  app: ReturnType<typeof Fastify>;
  analyzeImage: TestVisionAnalyzer;
  visionReceiptAdmission: VisionReceiptAdmission;
  request: RequestCapture;
}> {
  const context = {
    providers: { getVisionProvider: () => ({ name: "test-vision", analyzeImage }) },
    visionReceiptAdmission,
    runtime: {
      handleUserMessage: vi.fn(),
      getLatestPromptPreview: vi.fn(() => undefined)
    }
  } as unknown as AppContext;
  const request: RequestCapture = {
    raw: undefined,
    socket: undefined,
    rawAbortedListenersBefore: undefined,
    socketCloseListenersBefore: undefined
  };
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (incomingRequest) => {
    request.raw = incomingRequest.raw;
    request.socket = incomingRequest.raw.socket ?? undefined;
    request.rawAbortedListenersBefore = request.raw.listenerCount("aborted");
    request.socketCloseListenersBefore = request.socket?.listenerCount("close");
    configureRequest?.(request.raw, request.socket);
  });
  await registerMediaRoutes(app, context);
  return { app, analyzeImage, visionReceiptAdmission, request };
}

function emitDisconnect(request: RequestCapture, event: "aborted" | "socket-close"): void {
  if (event === "aborted") {
    request.raw?.emit("aborted");
    return;
  }
  request.socket?.emit("close");
}

function expectDisconnectListenersCleaned(request: RequestCapture): void {
  expect(request.raw).toBeDefined();
  expect(request.raw?.listenerCount("aborted")).toBe(request.rawAbortedListenersBefore);
  if (request.socket) {
    expect(request.socket.listenerCount("close")).toBe(request.socketCloseListenersBefore);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public batch STT input validation", () => {
  for (const route of routeCases) {
    it(`${route} rejects missing audio and mock text before provider invocation`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({ method: "POST", url: route, payload: {} });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} rejects empty audioBase64 before provider invocation`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} rejects whitespace-only mockText without audio`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { mockText: "   \n" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} preserves explicit non-empty mockText compatibility`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { mockText: "developer mock transcript" }
      });

      expect(response.statusCode).toBe(200);
      expect(transcribeAudio).toHaveBeenCalledOnce();
      await app.close();
    });

    it(`${route} rejects malformed audioBase64 even with mockText`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "not base64!", mockText: "do not fall back" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} rejects non-canonical raw base64 before provider invocation`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "AB" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} rejects non-canonical data URL base64 before provider invocation`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "data:audio/wav;base64,AB" }
      });

      expect(response.statusCode).toBe(400);
      expect(transcribeAudio).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route} accepts canonical unpadded base64`, async () => {
      const { app, transcribeAudio } = await createApp();

      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { audioBase64: "AQ" }
      });

      expect(response.statusCode).toBe(200);
      expect(transcribeAudio).toHaveBeenCalledOnce();
      await app.close();
    });

    it(`${route} accepts valid raw and data URL base64`, async () => {
      const { app, transcribeAudio } = await createApp();

      for (const audioBase64 of ["AQID", "data:audio/wav;base64,AQID"]) {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64, mimeType: "audio/wav" }
        });
        expect(response.statusCode).toBe(200);
      }

      expect(transcribeAudio).toHaveBeenCalledTimes(2);
      await app.close();
    });
  }
});

describe("public batch STT disconnect cancellation", () => {
  for (const route of routeCases) {
    it(`${route} passes a caller-owned AbortSignal to STT`, async () => {
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => recognizedOutput());
      const { app } = await createLifecycleApp(route, transcribeAudio);

      try {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });

        expect(response.statusCode).toBe(200);
        const signal = transcribeAudio.mock.calls[0]?.[1]?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
      } finally {
        await app.close();
      }
    });

    for (const event of ["aborted", "socket-close"] as const) {
      it(`${route} cancels pending STT on ${event} without entering success handling`, async () => {
        const started = deferred<void>();
        let signal: AbortSignal | undefined;
        const transcribeAudio = vi.fn<TestSTTTranscriber>(async (_input, options) => {
          signal = options?.signal;
          started.resolve();
          if (!signal) {
            throw new Error("STT route did not provide a disconnect signal.");
          }
          if (signal.aborted) {
            throw cancelledProviderError("not_started");
          }
          return new Promise<STTOutput>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(cancelledProviderError("unknown")), {
              once: true
            });
          });
        });
        const { app, handleUserMessage, request } = await createLifecycleApp(
          route,
          transcribeAudio
        );

        try {
          const responsePromise = app.inject({
            method: "POST",
            url: route,
            payload: { audioBase64: "AQID" }
          });
          await started.promise;

          emitDisconnect(request, event);

          expect(signal?.aborted).toBe(true);
          const response = await responsePromise;
          expect(response.statusCode).toBe(503);
          expect(response.statusCode).not.toBe(200);
          if (route === "/v1/voice/message") {
            expect(handleUserMessage).not.toHaveBeenCalled();
          }
        } finally {
          await app.close();
        }
      });
    }
  }

  for (const route of routeCases) {
    it(`${route} does not abort STT for request raw close during a normal POST`, async () => {
      const started = deferred<void>();
      const finishSTT = deferred<STTOutput>();
      let signal: AbortSignal | undefined;
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async (_input, options) => {
        signal = options?.signal;
        started.resolve();
        return finishSTT.promise;
      });
      const { app, request } = await createLifecycleApp(route, transcribeAudio);

      try {
        const responsePromise = app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });
        await started.promise;

        request.raw?.emit("close");
        expect(signal?.aborted).toBe(false);

        finishSTT.resolve(recognizedOutput());
        const response = await responsePromise;
        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it(`${route} removes STT disconnect listeners after success`, async () => {
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => recognizedOutput());
      const { app, request } = await createLifecycleApp(route, transcribeAudio);

      try {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });

        expect(response.statusCode).toBe(200);
        expectDisconnectListenersCleaned(request);
      } finally {
        await app.close();
      }
    });

    it(`${route} removes STT disconnect listeners after failure`, async () => {
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => {
        throw new Error("synthetic STT failure");
      });
      const { app, request } = await createLifecycleApp(route, transcribeAudio);

      try {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });

        expect(response.statusCode).toBe(503);
        expectDisconnectListenersCleaned(request);
      } finally {
        await app.close();
      }
    });

    it(`${route} honors a request that was already aborted before STT`, async () => {
      let signal: AbortSignal | undefined;
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async (_input, options) => {
        signal = options?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(true);
        throw cancelledProviderError("not_started");
      });
      const { app, request } = await createLifecycleApp(
        route,
        transcribeAudio,
        undefined,
        (raw) => {
          raw.aborted = true;
        }
      );

      try {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID" }
        });

        expect(response.statusCode).toBe(503);
        expect(signal?.aborted).toBe(true);
        expectDisconnectListenersCleaned(request);
      } finally {
        await app.close();
      }
    });
  }

  it("/v1/voice/message ends STT disconnect ownership before chat starts", async () => {
    const sttStarted = deferred<void>();
    const finishSTT = deferred<STTOutput>();
    const runtimeStarted = deferred<void>();
    const finishRuntime = deferred<unknown>();
    let sttSignal: AbortSignal | undefined;
    const transcribeAudio = vi.fn<TestSTTTranscriber>(async (_input, options) => {
      sttSignal = options?.signal;
      sttStarted.resolve();
      return finishSTT.promise;
    });
    const runtimeHandler = vi.fn(async () => {
      runtimeStarted.resolve();
      return finishRuntime.promise;
    });
    const { app, handleUserMessage, request } = await createLifecycleApp(
      "/v1/voice/message",
      transcribeAudio,
      runtimeHandler
    );

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/voice/message",
        payload: { audioBase64: "AQID" }
      });
      await sttStarted.promise;
      finishSTT.resolve(recognizedOutput());
      await runtimeStarted.promise;

      expectDisconnectListenersCleaned(request);
      expect(sttSignal?.aborted).toBe(false);
      request.raw?.emit("aborted");
      request.socket?.emit("close");
      expect(sttSignal?.aborted).toBe(false);
      expect(handleUserMessage.mock.calls[0]?.[1]).not.toHaveProperty("signal");

      finishRuntime.resolve({
        payload: { content: "reply", provider: "mock" },
        traceId: "trace-1"
      });
      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("/v1/voice/message passes a canonical voice transcript event to Runtime", async () => {
    const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => recognizedOutput());
    const { app, handleUserMessage } = await createLifecycleApp(
      "/v1/voice/message",
      transcribeAudio
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/voice/message",
        payload: {
          audioBase64: "AQID",
          sessionId: "voice-route-session",
          personaId: "alice",
          subjectUserId: "user-a",
          createdByUserId: "user-a",
          speakerId: "speaker-a",
          voiceProfileId: "voice-a",
          options: { readMemory: false, writeMemory: false }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(handleUserMessage.mock.calls[0]?.[0]).toMatchObject({
        type: "user.voice.transcript",
        payload: {
          sessionId: "voice-route-session",
          content: "recognized speech",
          language: "en",
          confidence: 0.9
        }
      });
      expect(handleUserMessage.mock.calls[0]?.[0].payload).not.toHaveProperty("subjectUserId");
      expect(handleUserMessage.mock.calls[0]?.[0].payload).not.toHaveProperty("voiceProfileId");
      expect(handleUserMessage.mock.calls[0]?.[1]).toMatchObject({
        readMemory: false,
        writeMemory: false
      });
    } finally {
      await app.close();
    }
  });

  it("/v1/voice/message returns observation identity separate from caller speaker assertions", async () => {
    const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => ({
      ...recognizedOutput(),
      observationId: "obs-1",
      segments: [
        { segmentId: "seg-1", startMs: 0, endMs: 1200, speakerClusterId: "0" },
        { segmentId: "seg-2", startMs: 1300, endMs: 2600, speakerClusterId: "1" }
      ]
    }));
    const { app, handleUserMessage } = await createLifecycleApp(
      "/v1/voice/message",
      transcribeAudio
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/voice/message",
        payload: {
          audioBase64: "AQID",
          sessionId: "voice-route-session",
          speakerId: "speaker-a",
          voiceProfileId: "voice-a"
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Acoustic evidence travels in typed observation fields...
      expect(body.transcription.observationId).toBe("obs-1");
      expect(body.transcription.segments).toEqual([
        { segmentId: "seg-1", startMs: 0, endMs: 1200, speakerClusterId: "0" },
        { segmentId: "seg-2", startMs: 1300, endMs: 2600, speakerClusterId: "1" }
      ]);
      // ...while caller-supplied speaker fields stay verbatim assertions.
      expect(body.transcription.speakerId).toBe("speaker-a");
      expect(body.transcription.voiceProfileId).toBe("voice-a");
      // Runtime receives the server-owned observation; caller assertions cannot bind identity.
      const eventPayload = handleUserMessage.mock.calls[0]?.[0].payload;
      expect(eventPayload.speakerId).toBeUndefined();
      expect(JSON.stringify(eventPayload)).not.toContain("speakerClusterId");
      expect(eventPayload.observationId).toBe("obs-1");
    } finally {
      await app.close();
    }
  });

  it("/v1/audio/transcriptions returns observation identity after Journal finalization", async () => {
    const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => ({
      ...recognizedOutput(),
      observationId: "obs-transcribe-only"
    }));
    const {
      app,
      handleUserMessage,
      reserveFinalizedSpeechObservation,
      finalizeSpeechReservation,
      speechReceiptAdmission
    } = await createLifecycleApp("/v1/audio/transcriptions", transcribeAudio);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        payload: { audioBase64: "AQID", sessionId: "transcribe-only-session" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().observationId).toBe("obs-transcribe-only");
      expect(response.json().captureEpoch).toBe("epoch-test");
      expect(handleUserMessage).not.toHaveBeenCalled();
      expect(reserveFinalizedSpeechObservation.mock.invocationCallOrder[0]).toBeLessThan(
        speechReceiptAdmission.admit.mock.invocationCallOrder[0]!
      );
      expect(speechReceiptAdmission.admit.mock.invocationCallOrder[0]).toBeLessThan(
        finalizeSpeechReservation.mock.invocationCallOrder[0]!
      );
    } finally {
      await app.close();
    }
  });

  it.each(routeCases)(
    "%s releases reservation and blocks semantic work on Journal failure",
    async (route) => {
      const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => recognizedOutput());
      const {
        app,
        commitSpeechTurn,
        handleUserMessage,
        releaseSpeechReservation,
        speechReceiptAdmission
      } = await createLifecycleApp(route, transcribeAudio);
      speechReceiptAdmission.admit.mockRejectedValue(
        new JournalStoreError("DATABASE_UNAVAILABLE", "private database detail")
      );
      try {
        const response = await app.inject({
          method: "POST",
          url: route,
          payload: { audioBase64: "AQID", sessionId: "journal-failure" }
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ error: "journal_admission_failed" });
        expect(response.json()).not.toHaveProperty("observationId");
        expect(response.body).not.toContain("private database detail");
        expect(releaseSpeechReservation).toHaveBeenCalledWith("reservation-test");
        expect(commitSpeechTurn).not.toHaveBeenCalled();
        expect(handleUserMessage).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("/v1/voice/message does not admit a duplicate capture as a second interaction", async () => {
    const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => recognizedOutput());
    const { app, handleUserMessage, reserveFinalizedSpeechObservation } = await createLifecycleApp(
      "/v1/voice/message",
      transcribeAudio
    );
    reserveFinalizedSpeechObservation.mockImplementation(() => {
      throw new SpeechCaptureFenceError("duplicate", "epoch-dup");
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/voice/message",
        payload: { audioBase64: "AQID", sessionId: "dup", captureEpoch: "epoch-dup" }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "speech_capture_rejected",
        reason: "duplicate"
      });
      expect(handleUserMessage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("/v1/audio/transcriptions rejects a stale capture epoch", async () => {
    const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => recognizedOutput());
    const { app, handleUserMessage, reserveFinalizedSpeechObservation } = await createLifecycleApp(
      "/v1/audio/transcriptions",
      transcribeAudio
    );
    reserveFinalizedSpeechObservation.mockImplementation(() => {
      throw new SpeechCaptureFenceError("stale-epoch", "epoch-old");
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        payload: { audioBase64: "AQID", sessionId: "stale", captureEpoch: "epoch-old" }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "speech_capture_rejected",
        reason: "stale-epoch"
      });
      expect(handleUserMessage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("public Vision input validation", () => {
  for (const testCase of [
    { payload: {}, label: "missing image" },
    { payload: { prompt: "describe" }, label: "prompt without image" },
    { payload: { imageBase64: "" }, label: "empty base64" },
    {
      payload: { imageBase64: "not-base64", mimeType: "image/png" },
      label: "malformed base64"
    },
    { payload: { imageBase64: "AQID" }, label: "raw base64 without MIME" },
    { payload: { imageBase64: "AQID", mimeType: "image/webp" }, label: "unsupported MIME" },
    {
      payload: { imageBase64: "data:text/plain;base64,AQID" },
      label: "non-image data URL"
    },
    {
      payload: { imageBase64: "data:image/png,AQID" },
      label: "non-base64 data URL"
    },
    {
      payload: { imageBase64: "data:image/png;base64," },
      label: "empty data URL"
    },
    { payload: { imageUrl: "ftp://example.com/image.png" }, label: "unsupported URL scheme" },
    { payload: { imageUrl: "not-a-url" }, label: "invalid URL syntax" },
    {
      payload: { imageUrl: "data:image/png;base64,AQID" },
      label: "data URL through imageUrl"
    }
  ]) {
    it(`rejects ${testCase.label} before provider invocation`, async () => {
      const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
      const { app } = await createVisionLifecycleApp(analyzeImage);

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/vision/analyze",
          payload: testCase.payload
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "invalid_request" });
        expect(analyzeImage).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });
  }

  it("preserves URL precedence without validating an ignored malformed base64 source", async () => {
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
    const { app } = await createVisionLifecycleApp(analyzeImage);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: {
          imageUrl: "https://example.com/image.png",
          imageBase64: "not-base64"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(analyzeImage).toHaveBeenCalledWith(
        expect.objectContaining({
          imageUrl: "https://example.com/image.png",
          imageBase64: "not-base64"
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    } finally {
      await app.close();
    }
  });

  it.each(["http://example.com/image.png", "https://example.com/image.png"])(
    "accepts a public %s image URL",
    async (imageUrl) => {
      const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
      const { app } = await createVisionLifecycleApp(analyzeImage);

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/vision/analyze",
          payload: { imageUrl }
        });

        expect(response.statusCode).toBe(200);
        expect(analyzeImage).toHaveBeenCalledWith(
          expect.objectContaining({ imageUrl }),
          expect.anything()
        );
      } finally {
        await app.close();
      }
    }
  );

  it("falls back from an empty URL to a valid base64 source", async () => {
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
    const { app } = await createVisionLifecycleApp(analyzeImage);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: {
          imageUrl: "",
          imageBase64: "AQID",
          mimeType: "image/png"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(analyzeImage).toHaveBeenCalledWith(
        expect.objectContaining({ imageUrl: "", imageBase64: "AQID" }),
        expect.anything()
      );
    } finally {
      await app.close();
    }
  });

  it("accepts raw base64, canonicalizes the JPG alias, and preserves prompt metadata", async () => {
    let receivedInput: VisionInput | undefined;
    let receivedOptions: ProviderCallOptions | undefined;
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async (input, options) => {
      receivedInput = input;
      receivedOptions = options;
      return visionOutput();
    });
    const { app } = await createVisionLifecycleApp(analyzeImage);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: {
          sessionId: "vision-session",
          imageBase64: "AQID",
          mimeType: "IMAGE/JPG; charset=binary",
          prompt: "  preserve prompt  "
        }
      });

      expect(response.statusCode).toBe(200);
      expect(receivedInput).toMatchObject({
        imageBase64: "AQID",
        mimeType: "image/jpeg",
        prompt: "  preserve prompt  ",
        metadata: { sessionId: "vision-session" }
      });
      expect(receivedInput).not.toHaveProperty("signal");
      expect(receivedOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(receivedOptions?.signal?.aborted).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("accepts supported data URLs and lets their embedded MIME govern the source", async () => {
    let receivedInput: VisionInput | undefined;
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async (input) => {
      receivedInput = input;
      return visionOutput();
    });
    const { app } = await createVisionLifecycleApp(analyzeImage);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: {
          imageBase64: "data:image/png;base64,AQID",
          mimeType: "image/jpeg"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(receivedInput).toMatchObject({
        imageBase64: "data:image/png;base64,AQID",
        mimeType: "image/jpeg"
      });
    } finally {
      await app.close();
    }
  });
});

describe("public Vision disconnect cancellation", () => {
  it("does not start Vision when the request is already aborted", async () => {
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
    const admit = vi.fn(async (_input: VisionReceiptInput) => {});
    const { app, request } = await createVisionLifecycleApp(
      analyzeImage,
      (raw) => {
        raw.aborted = true;
      },
      { admit }
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageBase64: "AQID", mimeType: "image/png" }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        capability: "vision",
        code: ProviderErrorCode.Cancelled,
        fallbackUsed: false
      });
      expect(admit).not.toHaveBeenCalled();
      expect(analyzeImage).not.toHaveBeenCalled();
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  it("does not start Vision when the request socket is already destroyed", async () => {
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
    const { app, request } = await createVisionLifecycleApp(analyzeImage, (_raw, socket) => {
      if (socket) {
        Object.defineProperty(socket, "destroyed", { configurable: true, value: true });
      }
    });

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageBase64: "AQID", mimeType: "image/png" }
      });
      void responsePromise.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(analyzeImage).not.toHaveBeenCalled();
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  for (const event of ["aborted", "socket-close"] as const) {
    it(`passes ${event} cancellation to Vision and rejects a late result`, async () => {
      const started = deferred<void>();
      const finish = deferred<VisionOutput>();
      let signal: AbortSignal | undefined;
      const analyzeImage = vi.fn<TestVisionAnalyzer>(async (_input, options) => {
        signal = options?.signal;
        started.resolve();
        if (!signal) {
          throw new Error("Vision route did not provide a canonical signal.");
        }
        return finish.promise;
      });
      const { app, request } = await createVisionLifecycleApp(analyzeImage);

      try {
        const responsePromise = app.inject({
          method: "POST",
          url: "/v1/vision/analyze",
          payload: { imageBase64: "AQID", mimeType: "image/png" }
        });
        await started.promise;
        emitDisconnect(request, event);

        expect(signal?.aborted).toBe(true);
        finish.resolve(visionOutput());

        const response = await responsePromise;
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain("a bright scene");
        expectDisconnectListenersCleaned(request);
      } finally {
        await app.close();
      }
    });
  }

  it("does not treat normal request-body close as cancellation", async () => {
    const started = deferred<void>();
    const finish = deferred<VisionOutput>();
    let signal: AbortSignal | undefined;
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async (_input, options) => {
      signal = options?.signal;
      started.resolve();
      return finish.promise;
    });
    const { app, request } = await createVisionLifecycleApp(analyzeImage);

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageBase64: "AQID", mimeType: "image/png" }
      });
      await started.promise;
      request.raw?.emit("close");
      expect(signal?.aborted).toBe(false);
      finish.resolve(visionOutput());

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ analysis: "a bright scene" });
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  it("cleans Vision disconnect listeners after provider failure", async () => {
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => {
      throw new Error("synthetic Vision failure");
    });
    const { app, request } = await createVisionLifecycleApp(analyzeImage);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageBase64: "AQID", mimeType: "image/png" }
      });

      expect(response.statusCode).toBe(503);
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });
});

describe("public Vision Journal admission", () => {
  it("commits safe normalized input before provider analysis", async () => {
    const order: string[] = [];
    const admit = vi.fn(async (input: VisionReceiptInput) => {
      order.push("receipt");
      expect(input).toEqual({
        imageSource: "INLINE_BYTES",
        prompt: "  describe this  "
      });
    });
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => {
      order.push("provider");
      return visionOutput();
    });
    const { app } = await createVisionLifecycleApp(analyzeImage, undefined, { admit });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: {
          imageBase64: "AQID",
          mimeType: "image/png",
          prompt: "  describe this  ",
          subjectUserId: "caller-user",
          personaId: "caller-persona",
          speakerId: "caller-speaker",
          voiceProfileId: "caller-profile"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(order).toEqual(["receipt", "provider"]);
      expect(admit).toHaveBeenCalledOnce();
      expect(analyzeImage).toHaveBeenCalledOnce();
      expect(analyzeImage.mock.calls[0]?.[0]).toMatchObject({
        imageBase64: "AQID",
        prompt: "  describe this  ",
        metadata: {
          subjectUserId: "caller-user",
          personaId: "caller-persona",
          speakerId: "caller-speaker",
          voiceProfileId: "caller-profile"
        }
      });
    } finally {
      await app.close();
    }
  });

  it("passes only URL-reference classification to the Journal facade", async () => {
    const admit = vi.fn(async (_input: VisionReceiptInput) => {});
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
    const { app } = await createVisionLifecycleApp(analyzeImage, undefined, { admit });
    const imageUrl = "https://example.invalid/private.png?token=NEVER_PERSIST";

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageUrl, prompt: "summarize" }
      });

      expect(response.statusCode).toBe(200);
      expect(admit).toHaveBeenCalledWith({
        imageSource: "URL_REFERENCE",
        prompt: "summarize"
      });
      expect(JSON.stringify(admit.mock.calls[0]?.[0])).not.toContain(imageUrl);
      expect(analyzeImage).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("fails closed on Journal errors with a bounded response and no provider fallback", async () => {
    const admit = vi.fn(async (_input: VisionReceiptInput) => {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "private database details");
    });
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
    const { app } = await createVisionLifecycleApp(analyzeImage, undefined, { admit });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageBase64: "AQID", mimeType: "image/png" }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "journal_admission_failed",
        code: "JOURNAL_UNAVAILABLE",
        message: "Durable vision admission is temporarily unavailable."
      });
      expect(response.body).not.toContain("private database details");
      expect(admit).toHaveBeenCalledOnce();
      expect(analyzeImage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    ["INVALID_PROPOSAL", "JOURNAL_ADMISSION_REJECTED"],
    ["TRANSACTION_FAILED", "JOURNAL_PERSISTENCE_FAILED"]
  ] as const)("maps %s to a bounded admission failure", async (failureCode, responseCode) => {
    const admit = vi.fn(async (_input: VisionReceiptInput) => {
      throw new JournalStoreError(failureCode, "private SQL and request data");
    });
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
    const { app } = await createVisionLifecycleApp(analyzeImage, undefined, { admit });
    const privateImageUrl = "https://example.invalid/private.png?token=NEVER_RETURN";

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageUrl: privateImageUrl }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "journal_admission_failed", code: responseCode });
      expect(response.body).not.toContain("private SQL and request data");
      expect(response.body).not.toContain(privateImageUrl);
      expect(response.body).not.toContain("NEVER_RETURN");
      expect(analyzeImage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not start provider work when a disconnect occurs while admission is held", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const admit = vi.fn(async (_input: VisionReceiptInput) => {
      started.resolve();
      await release.promise;
    });
    const analyzeImage = vi.fn<TestVisionAnalyzer>(async () => visionOutput());
    const { app, request } = await createVisionLifecycleApp(analyzeImage, undefined, { admit });

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageBase64: "AQID", mimeType: "image/png" }
      });
      await started.promise;
      expect(analyzeImage).not.toHaveBeenCalled();
      emitDisconnect(request, "aborted");
      release.resolve();

      const response = await responsePromise;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ capability: "vision", code: "CANCELLED" });
      expect(analyzeImage).not.toHaveBeenCalled();
      expectDisconnectListenersCleaned(request);
    } finally {
      release.resolve();
      await app.close();
    }
  });
});

describe("public TTS disconnect cancellation", () => {
  it("passes the canonical signal without putting it on TTSInput", async () => {
    let receivedInput: TTSInput | undefined;
    let receivedOptions: ProviderCallOptions | undefined;
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async (input, options) => {
      receivedInput = input;
      receivedOptions = options;
      return speechOutput();
    });
    const { app } = await createTTSLifecycleApp(synthesizeSpeech);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { sessionId: "tts-session", text: "hello", voice: "ara", format: "wav" }
      });

      expect(response.statusCode).toBe(200);
      expect(receivedInput).toMatchObject({
        text: "hello",
        voice: "ara",
        format: "wav",
        metadata: { sessionId: "tts-session" }
      });
      expect(receivedInput).not.toHaveProperty("signal");
      expect(receivedOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(receivedOptions?.signal?.aborted).toBe(false);
      expect(response.json()).toMatchObject({
        audioBase64: "AQID",
        mimeType: "audio/wav",
        durationMs: 42,
        finalProvider: "test-tts",
        provider: "test-tts",
        model: "test-tts"
      });
    } finally {
      await app.close();
    }
  });

  it("does not start TTS when the request is already aborted", async () => {
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async () => speechOutput());
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech, (raw) => {
      raw.aborted = true;
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });

      expect(response.statusCode).toBe(503);
      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  it("does not start TTS when the request socket is already destroyed", async () => {
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async () => speechOutput());
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech, (_raw, socket) => {
      if (socket) {
        Object.defineProperty(socket, "destroyed", { configurable: true, value: true });
      }
    });

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });
      void responsePromise.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  for (const event of ["aborted", "socket-close"] as const) {
    it(`aborts pending TTS on ${event} and cleans up listeners`, async () => {
      const started = deferred<void>();
      let signal: AbortSignal | undefined;
      const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async (_input, options) => {
        signal = options?.signal;
        started.resolve();
        if (!signal) {
          throw new Error("TTS route did not provide a canonical signal.");
        }
        return new Promise<TTSOutput>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(cancelledTTSError("unknown")), {
            once: true
          });
        });
      });
      const { app, request } = await createTTSLifecycleApp(synthesizeSpeech);

      try {
        const responsePromise = app.inject({
          method: "POST",
          url: "/v1/tts",
          payload: { text: "hello" }
        });
        await started.promise;
        emitDisconnect(request, event);

        expect(signal?.aborted).toBe(true);
        const response = await responsePromise;
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain("audioBase64");
        expectDisconnectListenersCleaned(request);
      } finally {
        await app.close();
      }
    });
  }

  it("does not treat normal request-body close as cancellation", async () => {
    const started = deferred<void>();
    const finish = deferred<TTSOutput>();
    let signal: AbortSignal | undefined;
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async (_input, options) => {
      signal = options?.signal;
      started.resolve();
      return finish.promise;
    });
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech);

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });
      await started.promise;
      request.raw?.emit("close");
      expect(signal?.aborted).toBe(false);
      finish.resolve(speechOutput());

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  it("rejects a late provider result after request disconnect without serializing success", async () => {
    const started = deferred<void>();
    const finish = deferred<TTSOutput>();
    let signal: AbortSignal | undefined;
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async (_input, options) => {
      signal = options?.signal;
      started.resolve();
      return finish.promise;
    });
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech);

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });
      await started.promise;
      request.raw?.emit("aborted");
      expect(signal?.aborted).toBe(true);
      finish.resolve(speechOutput());

      const response = await responsePromise;
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("audioBase64");
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });

  it("cleans TTS disconnect listeners after provider failure", async () => {
    const synthesizeSpeech = vi.fn<TestTTSSynthesizer>(async () => {
      throw new Error("synthetic TTS failure");
    });
    const { app, request } = await createTTSLifecycleApp(synthesizeSpeech);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: { text: "hello" }
      });

      expect(response.statusCode).toBe(503);
      expectDisconnectListenersCleaned(request);
    } finally {
      await app.close();
    }
  });
});

it("keeps endpoint ASR previews outside finalized Runtime observations", async () => {
  const app = Fastify();
  const transcribeAudio = vi.fn<TestSTTTranscriber>(async () => recognizedOutput());
  const reserveFinalizedSpeechObservation = vi.fn();
  await registerMediaRoutes(app, {
    providers: { getSTTProvider: () => ({ name: "local", transcribeAudio }) },
    runtime: { reserveFinalizedSpeechObservation }
  } as unknown as AppContext);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/audio/transcriptions",
      payload: { audioBase64: "AQID", preview: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "recognized speech", language: "en" });
    expect(transcribeAudio.mock.calls[0]?.[0]).toMatchObject({
      metadata: { identify: false, diarize: false }
    });
    expect(reserveFinalizedSpeechObservation).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
