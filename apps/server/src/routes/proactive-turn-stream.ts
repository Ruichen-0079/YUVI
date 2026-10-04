import {
  AssistantTurnConflictError,
  ConversationPersistenceError,
  ProactiveAdmissionError,
  type ProactiveShouldSpeak,
  type RuntimeReplyStreamEvent
} from "@companion/core";
import { ProviderError, ProviderErrorCode } from "@companion/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { requireLocalDashboardAccess } from "./security.js";
import { JournalStoreError } from "@companion/journal";
import { desktopCorsHeaders } from "../cors.js";
import { SseConnectionClosedError, writeSseFrame } from "./sse.js";
import { resolveMessageIdentity } from "./message.js";
import { toProactiveTurnAdmissionFailure } from "../proactive-turn-receipt-admission.js";
import { randomUUID } from "node:crypto";
import type { ReplyPublicationTarget } from "@companion/memory";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no"
};

const ProactiveConsentRequestSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("READY"),
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      enabled: z.boolean()
    })
    .strict(),
  z
    .object({
      state: z.literal("UNKNOWN_DENIED"),
      revisionFloor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .strict()
]);

export const ProactiveTurnStreamRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(512),
    idempotencyKey: z.string().trim().min(1).max(512),
    modality: z.literal("text"),
    options: z
      .object({
        readMemory: z.boolean(),
        speechPlan: z.enum(["NONE", "CLIENT_SEGMENTED"]).optional(),
        speechRequestId: z.string().min(1).max(512).optional(),
        promptPreview: z.boolean().optional()
      })
      .strict()
  })
  .strict();

export type ProactiveTurnStreamRequest = z.infer<typeof ProactiveTurnStreamRequestSchema>;

export async function registerProactiveTurnStreamRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  let readyProjectionTail: Promise<void> = Promise.resolve();
  const enqueueReadyProjection = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = readyProjectionTail.then(operation, operation);
    readyProjectionTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  app.post("/v1/proactive/consent", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = ProactiveConsentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    if (parsed.data.state === "UNKNOWN_DENIED") {
      const result = context.runtime.invalidateProactiveConsentProjection(
        parsed.data.revisionFloor
      );
      return reply.send({ ok: true, applied: result === "APPLIED", state: "UNKNOWN_DENIED" });
    }
    const readyInput = parsed.data;

    return enqueueReadyProjection(async () => {
      const input = readyInput;
      const preflight = context.runtime.preflightProactiveConsentProjection(input);
      if (preflight.result === "STALE") {
        return reply.status(409).send({ error: "stale_projection" });
      }
      if (preflight.result === "CONFLICT") {
        return reply.status(409).send({ error: "projection_conflict" });
      }
      if (preflight.result === "ALREADY_CURRENT") {
        return reply.send({ ok: true, applied: false, state: "READY" });
      }

      try {
        await context.proactiveConsentReceiptAdmission.admit({
          enabled: input.enabled,
          settingsRevision: input.revision
        });
      } catch (error) {
        const failure = proactiveConsentAdmissionFailure(error);
        return reply
          .status(failure.statusCode)
          .send({ error: failure.code, message: failure.message });
      }

      const applied = context.runtime.applyProactiveConsentProjection(input);
      if (applied === "CONFLICT") {
        return reply.status(409).send({ error: "projection_conflict" });
      }
      return reply.send({
        ok: true,
        applied: applied === "APPLIED",
        ...(applied === "STALE" ? { stale: true } : {}),
        state: "READY"
      });
    });
  });

  app.get("/v1/proactive-turns/live", async (request, reply) => {
    const sessionId =
      typeof request.query === "object" && request.query && "sessionId" in request.query
        ? String((request.query as { sessionId?: unknown }).sessionId ?? "default").trim() ||
          "default"
        : "default";
    reply.hijack();
    reply.raw.writeHead(200, {
      ...SSE_HEADERS,
      ...desktopCorsHeaders(request.headers.origin)
    });
    reply.raw.flushHeaders();
    const abortController = new AbortController();
    const target: ReplyPublicationTarget = {
      surface: "HTTP_SSE",
      targetId: `HTTP_SSE:proactive-live:${randomUUID()}`,
      targetGeneration: randomUUID()
    };
    const unregister = context.outwardEffects?.registerTarget(
      target,
      (session) => session === sessionId,
      () => !abortController.signal.aborted && !reply.raw.destroyed
    );
    const unsubscribe = context.subscribeProactiveStream(async (event) => {
      if (event.sessionId !== sessionId || abortController.signal.aborted) return;
      try {
        if (
          context.outwardEffects &&
          !(event.type === "proactive-decision" && event.decision === "NO_OP")
        )
          await context.outwardEffects.publish({
            target,
            frameId:
              event.type === "text-delta" ? event.componentId! : `${event.traceId}:${event.type}`,
            payload: event,
            scope: `session:${sessionId}`,
            ...(event.type === "text-delta"
              ? { replyId: event.replyId, componentId: event.componentId }
              : {}),
            write: () => writeSseFrame(reply.raw, event.type, event, abortController.signal)
          });
        else await writeSseFrame(reply.raw, event.type, event, abortController.signal);
      } catch {
        abortController.abort();
        unregister?.();
      }
    });
    const onDisconnect = () => {
      abortController.abort();
      unsubscribe();
      unregister?.();
    };
    request.raw.once("aborted", onDisconnect);
    reply.raw.once("close", onDisconnect);
    reply.raw.once("error", onDisconnect);
  });

  app.post("/v1/proactive-turns/stream", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const input = ProactiveTurnStreamRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const requestTraceId = crypto.randomUUID();
    const abortController = new AbortController();
    let iterator: AsyncIterator<RuntimeReplyStreamEvent> | undefined;
    let headersStarted = false;
    let responseFinalized = false;
    let clientDisconnected = false;
    let publicationTarget: ReplyPublicationTarget | undefined;
    let unregisterPublicationTarget: (() => void) | undefined;
    let journalAdmitted = false;
    let closePromise: Promise<void> | undefined;

    const closeIterator = (): Promise<void> => {
      if (!iterator) {
        return Promise.resolve();
      }
      if (closePromise) {
        return closePromise;
      }
      closePromise = Promise.resolve(iterator.return?.()).then(
        () => undefined,
        (error) => {
          request.log.warn({ err: error }, "failed to close proactive turn stream iterator");
        }
      );
      return closePromise;
    };
    const onDisconnect = () => {
      if (responseFinalized) {
        return;
      }
      clientDisconnected = true;
      abortController.abort();
      if (iterator) void closeIterator();
    };
    const onResponseError = () => onDisconnect();

    request.raw.once("aborted", onDisconnect);
    reply.raw.once("close", onDisconnect);
    reply.raw.once("error", onResponseError);

    try {
      if (request.raw.aborted || reply.raw.destroyed || reply.raw.writableEnded) {
        onDisconnect();
        return;
      }

      const sourceJournalRef = await context.proactiveTurnReceiptAdmission.admit({
        sessionId: input.data.sessionId,
        readMemory: input.data.options.readMemory,
        promptPreview: input.data.options.promptPreview ?? false
      });
      journalAdmitted = true;

      // A committed receipt is kept if the client left during append, but that request
      // must not start Runtime semantic work after its transport is no longer current.
      if (
        clientDisconnected ||
        request.raw.aborted ||
        reply.raw.destroyed ||
        reply.raw.writableEnded
      ) {
        return;
      }

      publicationTarget = {
        surface: "HTTP_SSE",
        targetId: `HTTP_SSE:proactive:${requestTraceId}`,
        targetGeneration: randomUUID()
      };
      unregisterPublicationTarget = context.outwardEffects?.registerTarget(
        publicationTarget,
        (session) => session === input.data.sessionId,
        () => !clientDisconnected && !abortController.signal.aborted
      );

      const identity = resolveMessageIdentity({});
      const runtimeStream = context.runtime.streamAssistantInitiatedTurn(
        {
          sessionId: input.data.sessionId,
          idempotencyKey: input.data.idempotencyKey,
          ...(sourceJournalRef ? { sourceJournalRef } : {}),
          readMemory: input.data.options.readMemory,
          ...(identity.personaId ? { personaId: identity.personaId } : {}),
          ...(identity.subjectUserId ? { subjectUserId: identity.subjectUserId } : {})
        },
        {
          speechPlan: input.data.options.speechPlan,
          speechRequestId: input.data.options.speechRequestId,
          signal: abortController.signal,
          promptPreview: input.data.options.promptPreview,
          replyPublicationTargets: [publicationTarget]
        }
      );
      const activeIterator = runtimeStream[Symbol.asyncIterator]();
      iterator = activeIterator;

      let next: IteratorResult<RuntimeReplyStreamEvent>;
      try {
        next = await activeIterator.next();
      } catch (error) {
        if (clientDisconnected) {
          return;
        }
        return sendAccountedProactiveError(
          reply,
          error,
          requestTraceId,
          context,
          publicationTarget
        );
      }

      if (clientDisconnected) {
        return;
      }
      if (next.done) {
        return sendProactiveTurnError(
          reply,
          new Error("Proactive turn stream ended before a completed event was produced."),
          requestTraceId
        );
      }

      reply.hijack();
      headersStarted = true;
      reply.raw.writeHead(200, {
        ...SSE_HEADERS,
        ...desktopCorsHeaders(request.headers.origin)
      });

      let successful = false;
      let decision: ProactiveShouldSpeak | undefined;
      let sawTextDelta = false;
      while (!next.done) {
        if (clientDisconnected) {
          return;
        }
        if (next.value.type === "proactive-decision") {
          if (decision !== undefined) {
            throw new Error("Proactive Runtime emitted multiple decisions.");
          }
          decision = next.value.decision;
        } else if (next.value.type === "text-delta") {
          if (decision !== "REQUEST_TEXT") {
            throw new Error("Proactive Runtime emitted text before REQUEST_TEXT.");
          }
          sawTextDelta = true;
        } else if (next.value.type === "completed") {
          if (decision !== "REQUEST_TEXT" || !sawTextDelta) {
            throw new Error("Proactive Runtime completed without REQUEST_TEXT.");
          }
        }
        if (
          context.outwardEffects &&
          publicationTarget &&
          !(next.value.type === "proactive-decision" && next.value.decision === "NO_OP")
        ) {
          const value = next.value;
          await context.outwardEffects.publish({
            target: publicationTarget,
            frameId:
              value.type === "text-delta" ? value.componentId! : `${value.traceId}:${value.type}`,
            payload: value,
            scope: `session:${input.data.sessionId}`,
            ...(value.type === "text-delta"
              ? { replyId: value.replyId, componentId: value.componentId }
              : {}),
            write: () => writeSseFrame(reply.raw, value.type, value, abortController.signal)
          });
        } else await writeSseFrame(reply.raw, next.value.type, next.value, abortController.signal);
        if (
          next.value.type === "completed" ||
          (next.value.type === "proactive-decision" && next.value.decision === "NO_OP")
        ) {
          successful = true;
          responseFinalized = true;
          break;
        }
        next = await activeIterator.next();
      }

      if (!successful) {
        throw new Error("Proactive turn stream ended before a successful terminal event.");
      }
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    } catch (error) {
      if (clientDisconnected || error instanceof SseConnectionClosedError) {
        return;
      }
      if (!headersStarted) {
        if (!journalAdmitted) {
          const failure = toProactiveTurnAdmissionFailure(error);
          return reply.status(failure.statusCode).send({
            error: failure.code,
            message: failure.message,
            traceId: requestTraceId
          });
        }
        return sendAccountedProactiveError(
          reply,
          error,
          requestTraceId,
          context,
          publicationTarget
        );
      }
      if (!responseFinalized && !reply.raw.destroyed && !reply.raw.writableEnded) {
        try {
          const payload = toSseError(error, requestTraceId);
          if (context.outwardEffects && publicationTarget)
            await context.outwardEffects.publish({
              target: publicationTarget,
              frameId: `error:${randomUUID()}`,
              payload,
              write: () => writeSseFrame(reply.raw, "error", payload)
            });
          else if (!context.outwardEffects) await writeSseFrame(reply.raw, "error", payload);
        } catch (writeError) {
          request.log.warn({ err: writeError }, "failed to write proactive turn stream error");
        }
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    } finally {
      unregisterPublicationTarget?.();
      request.raw.off("aborted", onDisconnect);
      reply.raw.off("close", onDisconnect);
      reply.raw.off("error", onResponseError);
      await closeIterator();
    }
  });
}

function proactiveConsentAdmissionFailure(error: unknown): {
  statusCode: 400 | 503;
  code: "JOURNAL_ADMISSION_REJECTED" | "JOURNAL_UNAVAILABLE" | "JOURNAL_PERSISTENCE_FAILED";
  message: string;
} {
  if (error instanceof JournalStoreError) {
    if (error.code === "INVALID_PROPOSAL" || error.code === "UNSUPPORTED_SCHEMA_VERSION") {
      return {
        statusCode: 400,
        code: "JOURNAL_ADMISSION_REJECTED",
        message: "Proactive settings projection was rejected."
      };
    }
    if (error.code === "DATABASE_UNAVAILABLE") {
      return {
        statusCode: 503,
        code: "JOURNAL_UNAVAILABLE",
        message: "Durable proactive settings admission is unavailable."
      };
    }
  }
  return {
    statusCode: 503,
    code: "JOURNAL_PERSISTENCE_FAILED",
    message: "Durable proactive settings admission did not commit."
  };
}

function sendProactiveTurnError(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  error: unknown,
  traceId: string
): unknown {
  if (error instanceof ProactiveAdmissionError) {
    return reply.status(409).send({
      error: "proactive_not_admitted",
      reason: error.reason,
      message: "Runtime did not admit the proactive attempt.",
      traceId
    });
  }
  if (error instanceof AssistantTurnConflictError) {
    return reply.status(409).send({
      error: "idempotency_conflict",
      message: "The assistant turn idempotency key has already been used.",
      traceId
    });
  }
  if (error instanceof ConversationPersistenceError) {
    return reply.status(503).send({
      error: "persistence_failed",
      operation: error.operation,
      message: error.message,
      traceId
    });
  }
  if (error instanceof ProviderError) {
    return reply.status(error.statusCode ?? 503).send({
      error: "provider_unavailable",
      code: error.code,
      provider: error.provider,
      capability: error.capability,
      message: error.message,
      traceId
    });
  }
  return reply.status(500).send({
    error: "proactive_turn_failed",
    message: "Assistant-initiated turn failed.",
    traceId
  });
}

function toSseError(
  error: unknown,
  traceId: string
): {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
  traceId: string;
} {
  if (error instanceof ConversationPersistenceError) {
    return {
      type: "error",
      code: "PERSISTENCE_FAILED",
      message: "Assistant message persistence failed.",
      retryable: false,
      traceId
    };
  }
  if (error instanceof ProviderError) {
    return {
      type: "error",
      code: error.code,
      message: safeProviderMessage(error.code),
      retryable: error.retryable,
      traceId
    };
  }
  return {
    type: "error",
    code: "INTERNAL",
    message: "Assistant-initiated turn failed.",
    retryable: false,
    traceId
  };
}

function safeProviderMessage(code: string): string {
  switch (code) {
    case ProviderErrorCode.MissingApiKey:
    case ProviderErrorCode.InvalidApiKey:
    case ProviderErrorCode.PermissionDenied:
      return "Provider authentication failed.";
    case ProviderErrorCode.RateLimited:
      return "Provider rate limit reached.";
    case ProviderErrorCode.Timeout:
      return "Provider request timed out.";
    case ProviderErrorCode.Cancelled:
      return "Assistant-initiated turn was cancelled.";
    case ProviderErrorCode.ProviderUnavailable:
      return "Provider is unavailable.";
    default:
      return "Provider request failed.";
  }
}

async function sendAccountedProactiveError(
  reply: { status(code: number): { send(payload: unknown): unknown }; raw: { destroy(): void } },
  error: unknown,
  traceId: string,
  context: AppContext,
  target?: import("@companion/memory").ReplyPublicationTarget
) {
  if (
    !context.outwardEffects ||
    !target ||
    error instanceof ProactiveAdmissionError ||
    error instanceof AssistantTurnConflictError
  )
    return sendProactiveTurnError(reply, error, traceId);
  let code = 500,
    payload: unknown;
  sendProactiveTurnError(
    {
      status(status) {
        code = status;
        return {
          send(value) {
            payload = value;
          }
        };
      }
    },
    error,
    traceId
  );
  try {
    await context.outwardEffects.publish({
      target,
      frameId: `error:${randomUUID()}`,
      payload,
      write: async () => {
        reply.status(code).send(payload);
      }
    });
  } catch {
    reply.raw.destroy();
  }
  return reply;
}
