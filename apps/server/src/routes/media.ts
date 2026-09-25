import { retainSpeechReview } from "../services/voice-review.js";
import { SpeechCaptureFenceError, type SpeechCaptureReservationResult } from "@companion/core";
import { JournalStoreError } from "@companion/journal";
import {
  ProviderError,
  ProviderErrorCode,
  type ProviderAttempt,
  type ProviderCapability,
  type ProviderMetadata,
  type STTInput,
  type STTOutput,
  type STTProvider
} from "@companion/providers";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  toSpeechAdmissionFailure,
  type SpeechReceiptSurface
} from "../speech-receipt-admission.js";
import { toVisionAdmissionFailure } from "../vision-receipt-admission.js";

const IdentitySchema = {
  sessionId: z.string().min(1).default("default"),
  personaId: z.string().min(1).nullable().optional(),
  subjectUserId: z.string().min(1).nullable().optional(),
  createdByUserId: z.string().min(1).nullable().optional(),
  speakerId: z.string().min(1).nullable().optional(),
  voiceProfileId: z.string().min(1).nullable().optional(),
  captureEpoch: z.string().min(1).optional()
} as const;

const TranscriptionRequestSchema = z.object({
  preview: z.boolean().optional(),
  ...IdentitySchema,
  audioBase64: z.string().optional(),
  mimeType: z.string().optional(),
  language: z.string().optional(),
  mockText: z.string().optional()
});

const VoiceMessageRequestSchema = z.object({
  ...IdentitySchema,
  audioBase64: z.string().optional(),
  mimeType: z.string().optional(),
  language: z.string().optional(),
  mockText: z.string().optional(),
  options: z
    .object({
      readMemory: z.boolean().optional(),
      writeMemory: z.boolean().optional(),
      promptPreview: z.boolean().optional(),
      voiceOutput: z.boolean().optional()
    })
    .optional()
});

const TTSRequestSchema = z.object({
  sessionId: z.string().min(1).default("default"),
  text: z.string().min(1),
  voice: z.string().min(1).optional(),
  format: z.enum(["mp3", "wav", "opus", "pcm", "mulaw", "alaw"]).optional(),
  language: z.string().min(1).optional()
});

const VisionRequestSchema = z.object({
  ...IdentitySchema,
  imageBase64: z.string().optional(),
  imageUrl: z.string().optional(),
  mimeType: z.string().optional(),
  prompt: z.string().optional()
});

const PUBLIC_VISION_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PUBLIC_VISION_MIME_TYPES = new Map([
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/png", "image/png"]
]);

function validatePublicSTTInput(input: {
  audioBase64?: string | undefined;
  mockText?: string | undefined;
}): string | undefined {
  if (input.audioBase64 !== undefined) {
    if (!isValidPublicBase64Audio(input.audioBase64)) {
      return "audioBase64 must contain valid non-empty base64 audio data.";
    }
    return undefined;
  }

  if (input.mockText?.trim()) {
    return undefined;
  }

  return "Provide valid audioBase64 or non-empty mockText.";
}

function isValidPublicBase64Audio(value: string): boolean {
  const payload = value.startsWith("data:")
    ? (() => {
        const comma = value.indexOf(",");
        return comma >= 0 && /^data:[^,]*;base64$/i.test(value.slice(0, comma))
          ? value.slice(comma + 1)
          : "";
      })()
    : value;

  if (payload.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return false;
  }

  const paddingIndex = payload.indexOf("=");
  if (paddingIndex >= 0 && payload.length % 4 !== 0) {
    return false;
  }

  const decoded = Buffer.from(payload, "base64");
  if (decoded.byteLength === 0) {
    return false;
  }

  const normalizedInput = payload.replace(/=+$/, "");
  const normalizedCanonical = decoded.toString("base64").replace(/=+$/, "");
  return normalizedInput === normalizedCanonical;
}

function validatePublicVisionInput(input: {
  imageBase64?: string | undefined;
  imageUrl?: string | undefined;
  mimeType?: string | undefined;
}): string | undefined {
  if (input.imageUrl) {
    let parsed: URL;
    try {
      parsed = new URL(input.imageUrl);
    } catch {
      return "imageUrl must be a valid HTTP or HTTPS URL.";
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "imageUrl must use the http or https scheme.";
    }
    return undefined;
  }

  if (input.imageBase64) {
    if (/^data:/i.test(input.imageBase64)) {
      return validatePublicVisionDataUrl(input.imageBase64);
    }

    if (!normalizePublicVisionMimeType(input.mimeType)) {
      return "Raw imageBase64 requires image/png or image/jpeg mimeType.";
    }
    return validatePublicVisionBase64(input.imageBase64);
  }

  return "Provide a usable imageUrl or imageBase64 source.";
}

function validatePublicVisionDataUrl(value: string): string | undefined {
  const match = /^data:([^;,\s]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) {
    return "imageBase64 data URLs must use a supported image MIME type and base64 encoding.";
  }

  const rawMimeType = match[1];
  const payload = match[2];
  if (!rawMimeType || !payload || !normalizePublicVisionMimeType(rawMimeType)) {
    return "imageBase64 data URLs must contain a non-empty PNG or JPEG payload.";
  }
  return validatePublicVisionBase64(payload);
}

function validatePublicVisionBase64(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length === 0 || value.length % 4 === 1) {
    return "imageBase64 must contain valid non-empty base64 data.";
  }

  const paddingIndex = value.indexOf("=");
  if (paddingIndex >= 0 && value.length % 4 !== 0) {
    return "imageBase64 has invalid base64 padding.";
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const estimatedBytes = Math.floor((value.length * 3) / 4) - padding;
  if (estimatedBytes > PUBLIC_VISION_MAX_IMAGE_BYTES) {
    return "Inline images must not exceed 20 MiB.";
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0) {
    return "imageBase64 must decode to non-empty image bytes.";
  }
  if (decoded.byteLength > PUBLIC_VISION_MAX_IMAGE_BYTES) {
    return "Inline images must not exceed 20 MiB.";
  }

  const normalizedInput = value.replace(/=+$/, "");
  const normalizedCanonical = decoded.toString("base64").replace(/=+$/, "");
  if (normalizedInput !== normalizedCanonical) {
    return "imageBase64 is not canonically encoded.";
  }
  return undefined;
}

function normalizePublicVisionMimeType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType ? PUBLIC_VISION_MIME_TYPES.get(mediaType) : undefined;
}

type RequestDisconnectBoundary = {
  signal: AbortSignal;
  cleanup(): void;
};

export function createRequestDisconnectBoundary(
  request: FastifyRequest
): RequestDisconnectBoundary {
  const controller = new AbortController();
  const socket = request.raw.socket;
  let aborted = false;
  const abortOnDisconnect = () => {
    if (aborted) {
      return;
    }
    aborted = true;
    controller.abort();
  };

  request.raw.once("aborted", abortOnDisconnect);
  socket?.once("close", abortOnDisconnect);

  if (request.raw.aborted || socket?.destroyed) {
    abortOnDisconnect();
  }

  let cleaned = false;
  return {
    signal: controller.signal,
    cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      request.raw.removeListener("aborted", abortOnDisconnect);
      socket?.removeListener("close", abortOnDisconnect);
    }
  };
}

async function transcribeAudioWithDisconnectBoundary(
  request: FastifyRequest,
  provider: STTProvider,
  input: STTInput
): Promise<STTOutput> {
  const boundary = createRequestDisconnectBoundary(request);
  try {
    const output = await provider.transcribeAudio(input, { signal: boundary.signal });
    if (boundary.signal.aborted) throw createCancelledProviderError(provider.name, "unknown");
    return output;
  } finally {
    boundary.cleanup();
  }
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.post("/v1/audio/transcriptions", async (request, reply) => {
    const parsed = TranscriptionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const inputError = validatePublicSTTInput(parsed.data);
    if (inputError) {
      return reply.status(400).send({ error: "invalid_request", message: inputError });
    }

    const provider = context.providers.getSTTProvider();
    try {
      const output = await transcribeAudioWithDisconnectBoundary(request, provider, {
        audioBase64: parsed.data.audioBase64,
        mimeType: parsed.data.mimeType,
        language: parsed.data.language,
        metadata: {
          identify: !parsed.data.preview,
          diarize: !parsed.data.preview,
          ...identityMetadata(parsed.data),
          ...(parsed.data.mockText ? { mockTranscription: parsed.data.mockText } : {})
        }
      });
      if (parsed.data.preview) return reply.send({ text: output.text, language: output.language });
      retainSpeechReview(parsed.data.audioBase64, output);
      const admitted = await admitFinalizedSpeech(context, output, {
        sessionId: parsed.data.sessionId,
        ...(parsed.data.captureEpoch ? { captureEpoch: parsed.data.captureEpoch } : {}),
        surface: "HTTP_AUDIO_TRANSCRIPTIONS",
        audioReceived: parsed.data.audioBase64 !== undefined,
        mockTextSupplied: parsed.data.mockText !== undefined
      });
      const observation = admitted.observation;
      return reply.send({
        text: observation.text,
        language: observation.language,
        confidence: observation.confidence,
        ...(admitted.status !== "ready" || observation.observationId === undefined
          ? {}
          : { observationId: observation.observationId }),
        ...(observation.captureEpoch === undefined
          ? {}
          : { captureEpoch: observation.captureEpoch }),
        ...(observation.segments === undefined ? {} : { segments: observation.segments }),
        // Caller-supplied assertions, echoed verbatim; never recognition
        // results. Acoustic speaker evidence only appears in typed segments.
        speakerId: parsed.data.speakerId,
        voiceProfileId: parsed.data.voiceProfileId,
        ...standardProviderMetadata("stt", observation)
      });
    } catch (error) {
      if (error instanceof JournalStoreError) return sendSpeechAdmissionFailure(reply, error);
      return sendSpeechCaptureOrProviderFailure(reply, error);
    }
  });

  app.post("/v1/voice/message", async (request, reply) => {
    const parsed = VoiceMessageRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const inputError = validatePublicSTTInput(parsed.data);
    if (inputError) {
      return reply.status(400).send({ error: "invalid_request", message: inputError });
    }

    const sttProvider = context.providers.getSTTProvider();
    try {
      const transcription = await transcribeAudioWithDisconnectBoundary(request, sttProvider, {
        audioBase64: parsed.data.audioBase64,
        mimeType: parsed.data.mimeType,
        language: parsed.data.language,
        metadata: {
          ...identityMetadata(parsed.data),
          ...(parsed.data.mockText ? { mockTranscription: parsed.data.mockText } : {})
        }
      });
      retainSpeechReview(parsed.data.audioBase64, transcription);
      const admitted = await admitFinalizedSpeech(context, transcription, {
        sessionId: parsed.data.sessionId,
        ...(parsed.data.captureEpoch ? { captureEpoch: parsed.data.captureEpoch } : {}),
        surface: "HTTP_VOICE_MESSAGE",
        audioReceived: parsed.data.audioBase64 !== undefined,
        mockTextSupplied: parsed.data.mockText !== undefined
      });
      if (admitted.status !== "ready") {
        return reply.status(422).send({
          error: "speech_not_handoff_ready",
          reason: "empty_transcript",
          message: "The finalized speech observation has no text to admit as a voice turn."
        });
      }
      const observation = admitted.observation;
      const transcriptEvent = context.runtime.commitSpeechTurn(
        observation.observationId!,
        parsed.data.sessionId,
        observation.text
      );
      const response = await context.runtime.handleUserMessage(transcriptEvent, {
        readMemory: parsed.data.options?.readMemory,
        writeMemory: parsed.data.options?.writeMemory,
        voiceOutput: parsed.data.options?.voiceOutput,
        controlAuthority: "LOCAL_EXPLICIT_CONTROLLER"
      });

      const sttMetadata = standardProviderMetadata("stt", observation);
      if (response === null) {
        // Intentional Character silence/termination: the admitted voice turn
        // succeeded, but no assistant message exists to return.
        return reply.send({
          transcription: {
            text: observation.text,
            language: observation.language,
            confidence: observation.confidence,
            ...(observation.observationId === undefined
              ? {}
              : { observationId: observation.observationId }),
            ...(observation.captureEpoch === undefined
              ? {}
              : { captureEpoch: observation.captureEpoch }),
            ...(observation.segments === undefined ? {} : { segments: observation.segments }),
            // Caller-supplied assertions, echoed verbatim; never recognition
            // results. Acoustic speaker evidence only appears in typed segments.
            speakerId: parsed.data.speakerId,
            voiceProfileId: parsed.data.voiceProfileId,
            ...sttMetadata
          },
          reply: null,
          traceId: transcriptEvent.traceId,
          provider: null,
          stt: sttMetadata,
          chat: null,
          promptPreview: parsed.data.options?.promptPreview
            ? context.runtime.getLatestPromptPreview()
            : undefined
        });
      }
      return reply.send({
        transcription: {
          text: observation.text,
          language: observation.language,
          confidence: observation.confidence,
          ...(observation.observationId === undefined
            ? {}
            : { observationId: observation.observationId }),
          ...(observation.captureEpoch === undefined
            ? {}
            : { captureEpoch: observation.captureEpoch }),
          ...(observation.segments === undefined ? {} : { segments: observation.segments }),
          // Caller-supplied assertions, echoed verbatim; never recognition
          // results. Acoustic speaker evidence only appears in typed segments.
          speakerId: parsed.data.speakerId,
          voiceProfileId: parsed.data.voiceProfileId,
          ...sttMetadata
        },
        reply: response.payload.content,
        traceId: response.traceId,
        provider: response.payload.provider,
        stt: sttMetadata,
        chat: response.payload.provider,
        promptPreview: parsed.data.options?.promptPreview
          ? context.runtime.getLatestPromptPreview()
          : undefined
      });
    } catch (error) {
      if (error instanceof JournalStoreError) return sendSpeechAdmissionFailure(reply, error);
      return sendSpeechCaptureOrProviderFailure(reply, error);
    }
  });

  app.post("/v1/tts", async (request, reply) => {
    const parsed = TTSRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const provider = context.providers.getTTSProvider();
    const boundary = createRequestDisconnectBoundary(request);
    try {
      if (boundary.signal.aborted) {
        throw createCancelledProviderError(provider.name, "not_started");
      }

      const output = await provider.synthesizeSpeech(
        {
          text: parsed.data.text,
          voice: parsed.data.voice,
          format: parsed.data.format,
          metadata: {
            sessionId: parsed.data.sessionId,
            ...(parsed.data.language ? { language: parsed.data.language } : {})
          }
        },
        { signal: boundary.signal }
      );

      if (boundary.signal.aborted) {
        throw createCancelledProviderError(provider.name, "unknown");
      }
      if (isResponseUnavailable(request, reply)) {
        return;
      }

      return reply.send({
        audioBase64: output.audioBase64 ?? Buffer.from(output.audio).toString("base64"),
        mimeType: output.mimeType,
        durationMs: output.durationMs,
        ...standardProviderMetadata("tts", output)
      });
    } catch (error) {
      if (isResponseUnavailable(request, reply)) {
        return;
      }
      return sendProviderFailure(reply, "tts", error);
    } finally {
      boundary.cleanup();
    }
  });

  app.post("/v1/vision/analyze", async (request, reply) => {
    const parsed = VisionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const inputError = validatePublicVisionInput(parsed.data);
    if (inputError) {
      return reply.status(400).send({ error: "invalid_request", message: inputError });
    }

    const boundary = createRequestDisconnectBoundary(request);
    try {
      if (boundary.signal.aborted) {
        throw createCancelledVisionProviderError("vision", "not_started");
      }

      try {
        await context.visionReceiptAdmission.admit({
          imageSource: parsed.data.imageUrl ? "URL_REFERENCE" : "INLINE_BYTES",
          ...(parsed.data.prompt !== undefined ? { prompt: parsed.data.prompt } : {})
        });
      } catch (error) {
        if (isResponseUnavailable(request, reply)) {
          return;
        }
        return sendVisionAdmissionFailure(reply, error);
      }

      if (boundary.signal.aborted) {
        throw createCancelledVisionProviderError("vision", "not_started");
      }
      if (isResponseUnavailable(request, reply)) {
        return;
      }

      const provider = context.providers.getVisionProvider();
      if (boundary.signal.aborted) {
        throw createCancelledVisionProviderError(provider.name, "not_started");
      }

      const output = await provider.analyzeImage(
        {
          imageBase64: parsed.data.imageBase64,
          imageUrl: parsed.data.imageUrl,
          mimeType: normalizePublicVisionMimeType(parsed.data.mimeType) ?? parsed.data.mimeType,
          prompt: parsed.data.prompt,
          metadata: identityMetadata(parsed.data)
        },
        { signal: boundary.signal }
      );

      if (boundary.signal.aborted) {
        throw createCancelledVisionProviderError(provider.name, "unknown");
      }
      if (isResponseUnavailable(request, reply)) {
        return;
      }

      return reply.send({
        analysis: output.text,
        labels: output.labels,
        objects: output.objects,
        sceneSummary: output.sceneSummary,
        confidence: output.confidence,
        ...standardProviderMetadata("vision", output)
      });
    } catch (error) {
      if (isResponseUnavailable(request, reply)) {
        return;
      }
      return sendProviderFailure(reply, "vision", error);
    } finally {
      boundary.cleanup();
    }
  });
}

function identityMetadata(input: {
  sessionId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  createdByUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  voiceProfileId?: string | null | undefined;
}): Record<string, string | null> {
  return {
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.personaId !== undefined ? { personaId: input.personaId } : {}),
    ...(input.subjectUserId !== undefined ? { subjectUserId: input.subjectUserId } : {}),
    ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
    ...(input.speakerId !== undefined ? { speakerId: input.speakerId } : {}),
    ...(input.voiceProfileId !== undefined ? { voiceProfileId: input.voiceProfileId } : {})
  };
}

function standardProviderMetadata(capability: ProviderCapability, output: ProviderMetadata) {
  const attemptedProviders = sanitizeAttempts(output.attemptedProviders);
  const success = attemptedProviders.find((attempt) => attempt.status === "success");
  const finalProvider = output.finalProvider ?? success?.provider ?? "unknown";
  return {
    capability,
    fallbackUsed: Boolean(output.fallbackUsed),
    attemptedProviders,
    finalProvider,
    provider: finalProvider,
    model: output.model ?? success?.model,
    mock: output.model === "mock" || finalProvider === "mock",
    latencyMs: output.latencyMs ?? success?.latencyMs
  };
}

function sendSpeechCaptureOrProviderFailure(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  error: unknown
): unknown {
  if (error instanceof SpeechCaptureFenceError) {
    return reply.status(error.reason === "reservation-capacity" ? 503 : 409).send({
      error: "speech_capture_rejected",
      reason: error.reason,
      captureEpoch: error.captureEpoch,
      message: error.message
    });
  }
  return sendProviderFailure(reply, "stt", error);
}

async function admitFinalizedSpeech(
  context: AppContext,
  output: STTOutput,
  options: {
    sessionId: string;
    captureEpoch?: string;
    surface: SpeechReceiptSurface;
    audioReceived: boolean;
    mockTextSupplied: boolean;
  }
): Promise<{ status: "ready" | "not-handoff-ready"; observation: STTOutput }> {
  const reservation: SpeechCaptureReservationResult =
    context.runtime.reserveFinalizedSpeechObservation(output, {
      sessionId: options.sessionId,
      ...(options.captureEpoch ? { captureEpoch: options.captureEpoch } : {})
    });
  let receipt;
  try {
    receipt = await context.speechReceiptAdmission.admit({
      surface: options.surface,
      sessionId: reservation.sessionId,
      observation: reservation.observation,
      audioReceived: options.audioReceived,
      mockTextSupplied: options.mockTextSupplied
    });
  } catch (error) {
    context.runtime.releaseSpeechReservation(reservation.token);
    throw error;
  }

  let finalized;
  try {
    finalized = context.runtime.finalizeSpeechReservation(reservation.token, receipt);
  } catch (error) {
    context.runtime.releaseSpeechReservation(reservation.token);
    throw error;
  }
  if (finalized.status === "stale") {
    throw new SpeechCaptureFenceError(
      "stale-epoch",
      finalized.captureEpoch,
      "A newer live speech epoch superseded this observation during durable admission."
    );
  }
  return { status: finalized.status, observation: finalized.observation };
}

function sendSpeechAdmissionFailure(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  error: JournalStoreError
): unknown {
  const failure = toSpeechAdmissionFailure(error);
  return reply.status(503).send({ error: "journal_admission_failed", ...failure });
}

function sendVisionAdmissionFailure(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  error: unknown
): unknown {
  const failure = toVisionAdmissionFailure(error);
  return reply.status(503).send({ error: "journal_admission_failed", ...failure });
}

function sendProviderFailure(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  capability: ProviderCapability,
  error: unknown
): unknown {
  const providerError = error instanceof ProviderError ? error : null;
  return reply.status(providerError?.statusCode ?? 503).send({
    error: "provider_unavailable",
    capability,
    provider: providerError?.provider,
    code: providerError?.code ?? "PROVIDER_UNAVAILABLE",
    message: safeProviderError(error),
    fallbackUsed: false,
    attemptedProviders: sanitizeAttempts(extractAttempts(error)),
    setup:
      "Configure a real provider for this capability, or set PROVIDER_ALLOW_MOCKS=true for explicit offline/mock development."
  });
}

function createCancelledProviderError(
  provider: string,
  effectState: "not_started" | "unknown"
): ProviderError {
  return new ProviderError({
    provider,
    capability: "tts",
    code: ProviderErrorCode.Cancelled,
    message: "TTS operation cancelled.",
    retryable: false,
    fallbackEligible: false,
    effectState
  });
}

function createCancelledVisionProviderError(
  provider: string,
  effectState: "not_started" | "unknown"
): ProviderError {
  return new ProviderError({
    provider,
    capability: "vision",
    code: ProviderErrorCode.Cancelled,
    message: "Vision operation cancelled.",
    retryable: false,
    fallbackEligible: false,
    effectState
  });
}

function isResponseUnavailable(
  request: FastifyRequest,
  reply: { raw: { destroyed?: boolean; writableEnded?: boolean } }
): boolean {
  return Boolean(reply.raw.destroyed || reply.raw.writableEnded || request.raw.socket?.destroyed);
}

function extractAttempts(error: unknown): ProviderAttempt[] {
  if (error instanceof ProviderError && error.attemptedProviders) {
    return error.attemptedProviders;
  }
  const value = (error as { attemptedProviders?: unknown })?.attemptedProviders;
  return Array.isArray(value) ? (value as ProviderAttempt[]) : [];
}

function sanitizeAttempts(attempts: ProviderAttempt[] | undefined): ProviderAttempt[] {
  return (attempts ?? []).map((attempt) => ({
    provider: attempt.provider,
    ...(attempt.model !== undefined ? { model: attempt.model } : {}),
    status: attempt.status,
    ...(attempt.errorCode !== undefined ? { errorCode: attempt.errorCode } : {}),
    ...(attempt.error !== undefined ? { error: safeProviderError(attempt.error) } : {}),
    ...(attempt.latencyMs !== undefined ? { latencyMs: attempt.latencyMs } : {}),
    ...(attempt.configured !== undefined ? { configured: attempt.configured } : {}),
    ...(attempt.enabled !== undefined ? { enabled: attempt.enabled } : {}),
    ...(attempt.priority !== undefined ? { priority: attempt.priority } : {})
  }));
}

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._~+/=-]+/g, "sk-[REDACTED]")
    .replace(/(api[-_]?key|authorization|token|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/DATABASE_URL=[^\s]+/gi, "DATABASE_URL=[REDACTED]")
    .slice(0, 300);
}
