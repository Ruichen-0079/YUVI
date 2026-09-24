import { ConversationPersistenceError } from "@companion/core";
import { parseRuntimeConfig } from "@companion/config";
import { createEvent } from "@companion/protocol";
import { randomUUID } from "node:crypto";
import { ProviderError } from "@companion/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import {
  toConversationalAdmissionFailure,
  type ConversationalReceiptSurface
} from "../conversational-receipt-admission.js";

const MESSAGE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 20 MiB raw image expands to ~26.7 MiB in base64 plus the JSON envelope. */
export const MESSAGE_REQUEST_BODY_LIMIT = 30 * 1024 * 1024;

const MessageImageAttachmentSchema = z
  .object({
    imageBase64: z.string().min(1),
    mimeType: z.enum(["image/png", "image/jpeg"])
  })
  .superRefine((value, context) => {
    const payload = value.imageBase64;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "imageBase64 must be valid base64."
      });
      return;
    }
    const paddingIndex = payload.indexOf("=");
    if (paddingIndex >= 0 && payload.length % 4 !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "imageBase64 padding is invalid." });
      return;
    }
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    const estimatedBytes = Math.floor((payload.length * 3) / 4) - padding;
    if (estimatedBytes <= 0 || estimatedBytes > MESSAGE_IMAGE_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Attached image must be non-empty and no larger than 20 MiB."
      });
      return;
    }
    const decoded = Buffer.from(payload, "base64");
    if (
      decoded.byteLength !== estimatedBytes ||
      decoded.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "imageBase64 must be canonically encoded."
      });
    }
  });

export const MessageRequestSchema = z
  .object({
    sessionId: z.string().min(1).default("default"),
    content: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    /** Explicit Mem0/user identity — preferred over env defaults. */
    subjectUserId: z.string().min(1).optional(),
    personaId: z.string().min(1).optional(),
    speechObservationId: z.string().min(1).optional(),
    voiceOutput: z.boolean().optional(),
    imageAttachment: MessageImageAttachmentSchema.optional(),
    options: z
      .object({
        tts: z.boolean().optional(),
        voiceOutput: z.boolean().optional(),
        useMemory: z.boolean().optional(),
        readMemory: z.boolean().optional(),
        writeMemory: z.boolean().optional(),
        promptPreview: z.boolean().optional()
      })
      .optional()
  })
  .refine((input) => input.content || input.text, {
    message: "Either content or text is required.",
    path: ["text"]
  });

const defaultUseMemory = true;

export async function registerMessageRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  async function handleMessage(
    request: { body: unknown; log: FastifyInstance["log"] },
    reply: {
      status(code: number): { send(payload: unknown): unknown };
      send(payload: unknown): unknown;
    },
    surface: ConversationalReceiptSurface
  ) {
    const input = MessageRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const content = input.data.content ?? input.data.text ?? "";
    const voiceOutput = Boolean(
      input.data.voiceOutput ?? input.data.options?.voiceOutput ?? input.data.options?.tts
    );
    const memoryOptions = normalizeMessageMemoryOptions(input.data.options);
    const identity = resolveMessageIdentity(input.data);
    let event;
    let runtimeEventId: string | undefined;
    try {
      if (input.data.speechObservationId) {
        event = context.runtime.commitSpeechTurn(
          input.data.speechObservationId,
          input.data.sessionId,
          content
        );
      } else {
        runtimeEventId = randomUUID();
      }
    } catch {
      return reply.status(409).send({ error: "invalid_speech_observation" });
    }

    if (runtimeEventId) {
      try {
        const receipt = await context.conversationalReceiptAdmission.admit({
          surface,
          sessionId: input.data.sessionId,
          runtimeEventId,
          content,
          ...(input.data.imageAttachment ? { hasImageAttachment: true } : {})
        });
        request.log.info(
          {
            journalEventId: receipt.envelope.eventId,
            runtimeEventId,
            sessionId: input.data.sessionId
          },
          "conversation receipt committed"
        );
      } catch (error) {
        const failure = toConversationalAdmissionFailure(error);
        request.log.error(
          { runtimeEventId, sessionId: input.data.sessionId, code: failure.code },
          "conversation receipt admission failed"
        );
        return reply.status(503).send({
          error: "journal_admission_failed",
          ...failure,
          traceId: runtimeEventId
        });
      }

      event = createEvent(
        "user.message",
        {
          sessionId: input.data.sessionId,
          content,
          ...(identity.subjectUserId ? { subjectUserId: identity.subjectUserId } : {}),
          ...(identity.personaId ? { personaId: identity.personaId } : {})
        },
        { id: runtimeEventId }
      );
    }

    if (!event) {
      return reply.status(500).send({ error: "runtime_event_not_created" });
    }

    request.log.info(
      {
        traceId: event.traceId,
        sessionId: input.data.sessionId,
        hasSubjectUserId: Boolean(identity.subjectUserId),
        hasPersonaId: Boolean(identity.personaId)
      },
      "message request received"
    );

    try {
      const response = await context.runtime.handleUserMessage(event, {
        voiceOutput,
        useMemory: memoryOptions.legacyUseMemory,
        readMemory: memoryOptions.readMemory,
        writeMemory: memoryOptions.writeMemory,
        ...(input.data.imageAttachment ? { imageAttachment: input.data.imageAttachment } : {}),
        controlAuthority: "LOCAL_EXPLICIT_CONTROLLER"
      });
      if (response === null) {
        // Intentional Character silence/termination: the turn succeeded, but
        // no assistant message exists to return.
        return reply.send({
          reply: null,
          traceId: event.traceId,
          provider: null,
          memory: {
            legacyUseMemory: memoryOptions.legacyUseMemory,
            readMemory: memoryOptions.readMemory,
            writeMemory: memoryOptions.writeMemory,
            memoryReadEnabled: memoryOptions.readMemory,
            memoryWriteEnabled: memoryOptions.writeMemory
          },
          promptPreview: input.data.options?.promptPreview
            ? context.runtime.getLatestPromptPreview()
            : undefined
        });
      }
      const provider = response.payload.provider;
      return reply.send({
        ...response,
        reply: response.payload.content,
        traceId: response.traceId,
        provider,
        memory: {
          legacyUseMemory: memoryOptions.legacyUseMemory,
          readMemory: memoryOptions.readMemory,
          writeMemory: memoryOptions.writeMemory,
          memoryReadEnabled: memoryOptions.readMemory,
          memoryWriteEnabled: memoryOptions.writeMemory
        },
        promptPreview: input.data.options?.promptPreview
          ? context.runtime.getLatestPromptPreview()
          : undefined
      });
    } catch (error) {
      return sendMessageError(reply, error, event.traceId);
    }
  }

  app.post("/message", { bodyLimit: MESSAGE_REQUEST_BODY_LIMIT }, (request, reply) =>
    handleMessage(request, reply, "HTTP_MESSAGE")
  );
  app.post("/v1/messages", { bodyLimit: MESSAGE_REQUEST_BODY_LIMIT }, (request, reply) =>
    handleMessage(request, reply, "HTTP_V1_MESSAGES")
  );
}

export function normalizeMessageMemoryOptions(
  options:
    | {
        useMemory?: boolean | undefined;
        readMemory?: boolean | undefined;
        writeMemory?: boolean | undefined;
      }
    | undefined
): {
  legacyUseMemory: boolean | undefined;
  readMemory: boolean;
  writeMemory: boolean;
} {
  const legacyUseMemory = options?.useMemory;
  const defaultEnabled = legacyUseMemory ?? defaultUseMemory;
  return {
    legacyUseMemory,
    readMemory: options?.readMemory ?? defaultEnabled,
    writeMemory: options?.writeMemory ?? defaultEnabled
  };
}

/**
 * Resolve chat identity for Mem0 scopes.
 * Request fields win; otherwise explicit MEMORY_SUBJECT_USER_ID / MEMORY_PERSONA_ID.
 * Never invents default-user / default-persona.
 */
export function resolveMessageIdentity(input: {
  subjectUserId?: string | undefined;
  personaId?: string | undefined;
}): { subjectUserId?: string; personaId?: string } {
  const runtime = parseRuntimeConfig(process.env);
  const subjectUserId = input.subjectUserId?.trim() || runtime.memory.subjectUserId?.trim();
  const personaId = input.personaId?.trim() || runtime.memory.personaId?.trim();
  return {
    ...(subjectUserId ? { subjectUserId } : {}),
    ...(personaId ? { personaId } : {})
  };
}

export function sendMessageError(
  reply: {
    status(code: number): { send(payload: unknown): unknown };
  },
  error: unknown,
  traceId: string
): unknown {
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
      attemptedProviders: error.attemptedProviders,
      setup:
        "Configure Chat in Product configuration (Provider → Model → Capability Route) and use Save & apply, or set PROVIDER_ALLOW_MOCKS=true for explicit offline/mock development.",
      traceId
    });
  }
  return reply.status(500).send({
    error: "message_failed",
    message: error instanceof Error ? error.message : "Message handling failed.",
    traceId
  });
}
