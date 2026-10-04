import { z } from "zod";
const token = z.string().min(1).max(512);
const ordinal = z.string().regex(/^[1-9][0-9]*$/);
export const SpeechSegmentSealSchema = z
  .object({
    version: z.literal("speech-segment-seal.v1"),
    replyId: token,
    sequence: ordinal,
    throughSequence: ordinal,
    preparedStart: z.number().int().nonnegative(),
    preparedEnd: z.number().int().positive(),
    preparationVersion: z.literal("speech-preparation.v1")
  })
  .strict()
  .refine((v) => v.preparedEnd > v.preparedStart);
export type SpeechSegmentSeal = z.infer<typeof SpeechSegmentSealSchema>;
export const MediaPermissionSchema = z
  .object({
    version: z.literal("media-permission.v1"),
    intentId: token,
    attemptId: token,
    fence: ordinal,
    expiresAt: z.string().datetime(),
    generation: token,
    capability: token,
    segmentId: token,
    kind: z.enum(["PLAYBACK", "SUBTITLE"])
  })
  .strict();
export type MediaPermission = z.infer<typeof MediaPermissionSchema>;
export const MediaDeviceReportSchema = z
  .object({
    permission: MediaPermissionSchema,
    observation: z.enum([
      "ATTACHED",
      "PLAYING",
      "COMPLETED",
      "INTERRUPTED",
      "ERROR",
      "SUBTITLE_ACCEPTED"
    ])
  })
  .strict();
export type MediaDeviceReport = z.infer<typeof MediaDeviceReportSchema>;
