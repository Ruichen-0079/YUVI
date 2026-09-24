export * from "./embodied-behavior.js";
export * from "./embodied-behavior-correlation.js";
export * from "./embodied-presentation-outcome.js";
export * from "./embodied-presentation-request.js";
export * from "./life-event-journal.js";

import { z } from "zod";

export const EventTypeSchema = z.enum([
  "user.message",
  "user.voice.transcript",
  "agent.reply",
  "avatar.speak",
  "assistant.message",
  "memory.retrieved",
  "tts.started",
  "perception.vision",
  "stt.completed",
  "vision.completed",
  "provider.error",
  "runtime.error",
  "runtime.embodied.effect",
  "runtime.embodied.presentation.request"
]);

export const TurnOriginSchema = z.enum(["user-turn", "assistant-initiated"]);

export type TurnOrigin = z.infer<typeof TurnOriginSchema>;

export type EventType = z.infer<typeof EventTypeSchema>;

export const RuntimeEventSchema = z.object({
  id: z.string().min(1),
  type: EventTypeSchema,
  timestamp: z.string().datetime(),
  traceId: z.string().min(1),
  parentId: z.string().min(1).optional(),
  payload: z.unknown()
});

export type RuntimeEvent<TType extends string = EventType, TPayload = unknown> = {
  id: string;
  type: TType;
  timestamp: string;
  traceId: string;
  parentId?: string | undefined;
  payload: TPayload;
};

export const UserMessagePayloadSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1),
  personaId: z.string().min(1).nullable().optional(),
  subjectUserId: z.string().min(1).nullable().optional(),
  createdByUserId: z.string().min(1).nullable().optional(),
  speakerId: z.string().min(1).nullable().optional(),
  voiceProfileId: z.string().min(1).nullable().optional()
});

export type UserMessagePayload = z.infer<typeof UserMessagePayloadSchema>;

export const UserMessageEventSchema = RuntimeEventSchema.extend({
  type: z.literal("user.message"),
  payload: UserMessagePayloadSchema
});

export type UserMessageEvent = RuntimeEvent<"user.message", UserMessagePayload>;

export const UserVoiceTranscriptPayloadSchema = z.object({
  observationId: z.string().optional(),
  captureEpoch: z.string().optional(),
  segments: z
    .array(
      z.object({
        segmentId: z.string().optional(),
        text: z.string().optional(),
        startMs: z.number().optional(),
        endMs: z.number().optional(),
        speakerClusterId: z.string().optional(),
        voiceProfileMatch: z
          .object({
            status: z.enum(["MATCHED", "NO_MATCH"]),
            voiceProfileId: z.string().optional()
          })
          .optional()
      })
    )
    .optional(),
  sessionId: z.string().min(1),
  content: z.string().min(1),
  language: z.string().optional(),
  confidence: z.number().optional(),
  personaId: z.string().min(1).nullable().optional(),
  subjectUserId: z.string().min(1).nullable().optional(),
  createdByUserId: z.string().min(1).nullable().optional(),
  speakerId: z.string().min(1).nullable().optional(),
  voiceProfileId: z.string().min(1).nullable().optional()
});

export type UserVoiceTranscriptPayload = z.infer<typeof UserVoiceTranscriptPayloadSchema>;
export type UserVoiceTranscriptEvent = RuntimeEvent<
  "user.voice.transcript",
  UserVoiceTranscriptPayload
>;

export const AssistantMessagePayloadSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string(),
  turnOrigin: TurnOriginSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  decisionId: z.string().min(1).optional(),
  activityRevision: z.number().int().nonnegative().optional(),
  provider: z
    .object({
      name: z.string(),
      capability: z.string(),
      model: z.string().optional(),
      mock: z.boolean(),
      latencyMs: z.number().optional(),
      tokenUsage: z
        .object({
          inputTokens: z.number().optional(),
          outputTokens: z.number().optional(),
          totalTokens: z.number().optional()
        })
        .optional(),
      healthStatus: z.string().optional()
    })
    .optional()
});

export type AssistantMessagePayload = z.infer<typeof AssistantMessagePayloadSchema>;
/** Final assistant text that has been selected for publication to the user. */
export type AssistantMessageEvent = RuntimeEvent<"assistant.message", AssistantMessagePayload>;

/**
 * Internal reply produced by the runtime orchestrator before any transport-specific publication.
 * Consumers that need the final user-facing publication semantic should use `assistant.message`.
 */
export type AgentReplyEvent = RuntimeEvent<"agent.reply", AssistantMessagePayload>;

export type AvatarSpeakPayload = {
  sessionId: string;
  text: string;
  audioBase64?: string | undefined;
  mimeType: string;
  durationMs?: number | undefined;
};

export type AvatarSpeakEvent = RuntimeEvent<"avatar.speak", AvatarSpeakPayload>;

export type PerceptionVisionPayload = {
  sessionId: string;
  text: string;
  objects?: string[] | undefined;
  sceneSummary?: string | undefined;
  confidence?: number | undefined;
};

export type PerceptionVisionEvent = RuntimeEvent<"perception.vision", PerceptionVisionPayload>;

export type CreateEventOptions = {
  traceId?: string | undefined;
  parentId?: string | undefined;
};

export function createEvent<TType extends EventType, TPayload>(
  type: TType,
  payload: TPayload,
  options: CreateEventOptions = {}
): RuntimeEvent<TType, TPayload> {
  const id = crypto.randomUUID();

  return {
    id,
    type,
    timestamp: new Date().toISOString(),
    traceId: options.traceId ?? id,
    ...(options.parentId ? { parentId: options.parentId } : {}),
    payload
  };
}
