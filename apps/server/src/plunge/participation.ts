import { z } from "zod";
/** Existing admission branches and continuation duration, with an optional opportunity cooldown. */
export const ParticipationSchema = z
  .object({
    private: z.boolean().default(true),
    mention: z.boolean().default(true),
    reply: z.boolean().default(true),
    alias: z.boolean().default(true),
    ambientAttention: z.boolean().default(true),
    continuationMs: z.number().int().min(0).max(120_000).default(60_000),
    groupCooldownMs: z.number().int().min(0).max(120_000).default(0),
    privateCooldownMs: z.number().int().min(0).max(120_000).default(0),
    quoteReply: z.boolean().default(true)
  })
  .strict();
export type Participation = z.infer<typeof ParticipationSchema>;
export const DEFAULT_PARTICIPATION = ParticipationSchema.parse({});
