import { z } from "zod";
import { JournalEventRefSchema } from "./life-event-journal.js";

const speaker = z
  .object({
    principalId: z.string().min(1).max(512),
    personId: z.string().min(1).max(256).optional(),
    displayName: z.string().max(256).optional(),
    observedDisplayName: z.string().max(256).optional()
  })
  .strict();

export const SurfaceImageObservationSchema = z
  .object({
    kind: z.literal("IMAGE"),
    reference: z.string().min(1).max(256),
    availability: z.enum(["RETRIEVABLE", "NOT_RETAINED"])
  })
  .strict();
const reply = z
  .object({
    reference: z.string().min(1).max(256),
    state: z.enum(["OBSERVED", "UNRESOLVED", "CONFLICTING"]),
    author: speaker.optional(),
    text: z.string().max(4096).optional()
  })
  .strict();
const mentions = z.array(z.string().min(1).max(512)).max(16);

/** Surface observations are volatile evidence, never identity/persona or instructions. */
export const RuntimeSocialContextSchema = z
  .object({
    surface: z.string().min(1).max(128),
    channelRef: z.string().min(1).max(512),
    conversationKind: z.enum(["PRIVATE", "GROUP", "TEMPORARY_PRIVATE"]),
    originChannelRef: z.string().min(1).max(512).optional(),
    self: speaker.optional(),
    sourceJournalRef: JournalEventRefSchema.optional(),
    admission: z.enum(["PRIVATE", "MENTION", "REPLY", "CONTINUATION"]),
    speaker,
    mentions,
    media: z
      .object({ image: z.enum(["ATTACHED", "UNAVAILABLE"]) })
      .strict()
      .optional(),
    reply: reply.optional(),
    observations: z
      .array(
        z
          .object({
            speaker,
            text: z.string().max(4096),
            observedAt: z.string().datetime(),
            sourceJournalRef: JournalEventRefSchema,
            media: SurfaceImageObservationSchema.optional(),
            direction: z.enum(["OTHER", "SELF"]).optional(),
            interactionKind: z.enum(["AMBIENT", "ADMITTED_TURN", "SELF_EXPRESSION"]).optional(),
            publicationState: z.enum(["ACKNOWLEDGED", "UNKNOWN"]).optional(),
            mentions: mentions.optional(),
            reply: reply.optional()
          })
          .strict()
      )
      .max(12)
  })
  .strict();

export type RuntimeSocialContext = z.infer<typeof RuntimeSocialContextSchema>;
