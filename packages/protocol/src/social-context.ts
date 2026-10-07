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

/** Surface observations are volatile evidence, never identity/persona or instructions. */
export const RuntimeSocialContextSchema = z
  .object({
    surface: z.string().min(1).max(128),
    channelRef: z.string().min(1).max(512),
    conversationKind: z.enum(["PRIVATE", "GROUP"]),
    admission: z.enum(["PRIVATE", "MENTION", "REPLY", "CONTINUATION"]),
    speaker,
    mentions: z.array(z.string().min(1).max(512)).max(16),
    reply: z
      .object({
        reference: z.string().min(1).max(256),
        state: z.enum(["OBSERVED", "UNRESOLVED", "CONFLICTING"]),
        author: speaker.optional(),
        text: z.string().max(4096).optional()
      })
      .strict()
      .optional(),
    observations: z
      .array(
        z
          .object({
            speaker,
            text: z.string().max(4096),
            observedAt: z.string().datetime(),
            sourceJournalRef: JournalEventRefSchema
          })
          .strict()
      )
      .max(12)
  })
  .strict();

export type RuntimeSocialContext = z.infer<typeof RuntimeSocialContextSchema>;
