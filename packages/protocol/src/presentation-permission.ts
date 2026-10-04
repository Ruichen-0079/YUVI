import { z } from "zod";
import { EmbodiedPresentationRequestSchema } from "./embodied-presentation-request.js";
import { EmbodiedPresentationOutcomeReportSchema } from "./embodied-presentation-outcome.js";
const token = z.string().min(1).max(512);
export const PresentationPermissionSchema = z
  .object({
    version: z.literal("presentation-permission.v1"),
    intentId: token,
    attemptId: token,
    fence: z.string().regex(/^[1-9][0-9]*$/),
    generation: token,
    requestId: token,
    expiresAt: z.string().datetime(),
    capability: token,
    effectId: token
  })
  .strict();
export type PresentationPermission = z.infer<typeof PresentationPermissionSchema>;
export const AccountedPresentationRequestSchema = z
  .object({
    version: z.literal("accounted-presentation.v1"),
    request: EmbodiedPresentationRequestSchema,
    permission: PresentationPermissionSchema
  })
  .strict()
  .refine((v) => v.request.effectId === v.permission.effectId);
export type AccountedPresentationRequest = z.infer<typeof AccountedPresentationRequestSchema>;
export const AccountedPresentationReportSchema = z
  .object({
    permission: PresentationPermissionSchema,
    report: EmbodiedPresentationOutcomeReportSchema
  })
  .strict()
  .refine((v) => v.permission.effectId === v.report.effectId);
export type AccountedPresentationReport = z.infer<typeof AccountedPresentationReportSchema>;
