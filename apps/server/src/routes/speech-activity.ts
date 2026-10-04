import { createRequestDisconnectBoundary } from "./media.js";
import type { SpeechActivitySnapshot } from "@companion/core";
import { SpeechCaptureFenceError } from "@companion/core";
import { ProviderError, ProviderErrorCode, type STTProvider } from "@companion/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

const SpeechActivityObservationSchema = z
  .object({
    sessionId: z.string().trim().min(1).default("default"),
    captureEpoch: z.string().trim().min(1),
    active: z.boolean()
  })
  .strict();

const SpeechActivityFrameSchema = z
  .object({
    sessionId: z.string().trim().min(1).default("default"),
    captureEpoch: z.string().trim().min(1),
    pcmBase64: z.string().min(1),
    sampleRate: z.number().int().positive().optional()
  })
  .strict();

export async function registerSpeechActivityRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.get("/v1/speech-activity", async (request, reply) => {
    const sessionId =
      typeof request.query === "object" && request.query && "sessionId" in request.query
        ? String((request.query as { sessionId?: unknown }).sessionId ?? "default")
        : "default";
    return reply.send({
      sessionId,
      ...context.runtime.getSpeechActivitySnapshot()
    });
  });

  app.post("/v1/speech-activity", async (request, reply) => {
    const parsed = SpeechActivityObservationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    try {
      const snapshot = context.runtime.observeSpeechActivity(parsed.data);
      const revoked = parsed.data.active
        ? context.mediaEffects?.interruptSession(parsed.data.sessionId)
        : undefined;
      return reply.send({
        ...toResponse(parsed.data.sessionId, snapshot),
        ...(revoked ? { revokedSpeechRequestId: revoked } : {})
      });
    } catch (error) {
      return sendSpeechActivityError(reply, error);
    }
  });

  app.post("/v1/speech-activity/frames", async (request, reply) => {
    const parsed = SpeechActivityFrameSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const stt = context.providers.getSTTProvider();
    if (!hasVoiceActivity(stt)) {
      return reply.status(503).send({
        error: "vad_unavailable",
        message: "Live speech activity requires the local STT sidecar Silero VAD."
      });
    }
    const boundary = createRequestDisconnectBoundary(request);
    try {
      const classified = await stt.detectVoiceActivity(
        {
          captureEpoch: parsed.data.captureEpoch,
          pcmBase64: parsed.data.pcmBase64,
          sampleRate: parsed.data.sampleRate ?? 16_000
        },
        { signal: boundary.signal }
      );
      if (boundary.signal.aborted) return;
      const snapshot = context.runtime.observeSpeechActivity({
        sessionId: parsed.data.sessionId,
        captureEpoch: parsed.data.captureEpoch,
        active: classified.active
      });
      const revoked = classified.active
        ? context.mediaEffects?.interruptSession(parsed.data.sessionId)
        : undefined;
      return reply.send({
        ...toResponse(parsed.data.sessionId, snapshot),
        ...(revoked ? { revokedSpeechRequestId: revoked } : {})
      });
    } catch (error) {
      return sendSpeechActivityError(reply, error);
    } finally {
      boundary.cleanup();
    }
  });

  for (const path of ["/v1/speech-playback", "/v1/speech-playback/outcome"])
    app.post(path, async (_request, reply) =>
      reply.code(410).send({ error: "canonical_media_permission_required" })
    );
}

function hasVoiceActivity(provider: STTProvider): provider is STTProvider & {
  detectVoiceActivity: NonNullable<STTProvider["detectVoiceActivity"]>;
} {
  return typeof provider.detectVoiceActivity === "function";
}

function toResponse(sessionId: string, snapshot: SpeechActivitySnapshot) {
  return {
    sessionId,
    speechActive: snapshot.speechActive,
    captureEpoch: snapshot.captureEpoch,
    activityRevision: snapshot.activityRevision,
    speechPlaybackEffectId: snapshot.speechPlaybackEffectId ?? null,
    speechPlaybackRequestId: snapshot.speechPlaybackRequestId ?? null,
    speechPlaybackState: snapshot.speechPlaybackState ?? null,
    ...(snapshot.revokedSpeechEffectId === undefined
      ? {}
      : { revokedSpeechEffectId: snapshot.revokedSpeechEffectId }),
    ...(snapshot.revokedSpeechRequestId === undefined
      ? {}
      : { revokedSpeechRequestId: snapshot.revokedSpeechRequestId })
  };
}

function sendSpeechActivityError(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  error: unknown
): unknown {
  if (error instanceof SpeechCaptureFenceError) {
    return reply.status(409).send({
      error: "speech_capture_rejected",
      reason: error.reason,
      captureEpoch: error.captureEpoch,
      message: error.message
    });
  }
  if (error instanceof ProviderError) {
    const status =
      error.code === ProviderErrorCode.ProviderUnavailable ? 503 : (error.statusCode ?? 503);
    return reply.status(status).send({
      error:
        error.code === ProviderErrorCode.ProviderUnavailable
          ? "vad_unavailable"
          : "provider_unavailable",
      code: error.code,
      message: error.message
    });
  }
  return reply.status(500).send({
    error: "speech_activity_failed",
    message: error instanceof Error ? error.message : "Speech activity failed."
  });
}
