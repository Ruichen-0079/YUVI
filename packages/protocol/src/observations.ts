import { z } from "zod";
import { JournalEventRefSchema } from "./life-event-journal.js";
/** Retained reports are neither confirmed world facts nor task-completion receipts. */
export const ObservationEvidenceSchema = z
  .object({
    schema: z.literal("observation.v1"),
    id: z.string().regex(/^ob1_[a-f0-9]{64}$/u),
    kind: z.enum(["VISION", "READ_TEXT"]),
    availability: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    unavailableReason: z.enum(["EXPIRED", "DELETED", "SOURCE_AUTHORITY_UNAVAILABLE"]).optional(),
    source: JournalEventRefSchema,
    observedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    action: z
      .object({
        attemptId: z.string().regex(/^ea1_[a-f0-9]{64}$/u),
        contractRef: z.enum(["yuvi.provider.v1", "yuvi.read-text.v1"]),
        certainty: z.literal("APPLIED")
      })
      .strict(),
    goalStatus: z.literal("NOT_INFERRED"),
    coverage: z.literal("BOUNDED_PROVIDER_REPORT"),
    provider: z.string().max(512).nullable(),
    model: z.string().max(512).nullable(),
    evidence: z
      .object({
        text: z.string().max(64000),
        sceneSummary: z.string().max(4000),
        objects: z.array(z.string().max(160)).max(32),
        confidence: z.number().min(0).max(1).nullable()
      })
      .strict()
      .optional(),
    sourceArtifact: z.enum(["AVAILABLE", "NOT_RETAINED", "UNAVAILABLE"])
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      record.availability === "UNAVAILABLE" &&
      (record.evidence !== undefined ||
        !record.unavailableReason ||
        record.sourceArtifact !== "UNAVAILABLE")
    )
      ctx.addIssue({
        code: "custom",
        message: "Unavailable reports cannot expose retained content or artifacts."
      });
    if (record.availability === "AVAILABLE" && (!record.evidence || record.unavailableReason))
      ctx.addIssue({
        code: "custom",
        message: "Available reports require evidence and no unavailable reason."
      });
  });
export type ObservationEvidence = z.infer<typeof ObservationEvidenceSchema>;
export const ObservationPageSchema = z
  .object({
    schema: z.literal("observations.page.v1"),
    status: z.enum(["OK", "UNAVAILABLE"]),
    records: z.array(ObservationEvidenceSchema).max(32),
    nextCursor: z.string().max(1024).nullable()
  })
  .strict();
export type ObservationPage = z.infer<typeof ObservationPageSchema>;
/** Caller supplies its authenticated Host transport; credentials never appear in URLs. */
export class ObservationClient {
  constructor(
    private readonly request: <T>(path: string, options?: { method: "DELETE" }) => Promise<T>
  ) {}
  async list(sessionId: string, options: { limit?: number; cursor?: string } = {}) {
    const query = new URLSearchParams({ sessionId });
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    return ObservationPageSchema.parse(await this.request(`/observations/v1?${query}`));
  }
  async detail(sessionId: string, id: string) {
    return ObservationEvidenceSchema.parse(
      await this.request(
        `/observations/v1/${encodeURIComponent(id)}?${new URLSearchParams({ sessionId })}`
      )
    );
  }
  erase(sessionId: string, id: string) {
    return this.request<{
      schema: "observation.erasure.v1";
      status: "COMPLETE";
      id: string;
      scope: "OBSERVATION_PAYLOAD_AND_IMAGE";
      actionReceipt: "RETAINED";
    }>(`/observations/v1/${encodeURIComponent(id)}?${new URLSearchParams({ sessionId })}`, {
      method: "DELETE"
    });
  }
}
