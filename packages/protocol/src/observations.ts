import { z } from "zod";
import { JournalEventRefSchema } from "./life-event-journal.js";
/** Immutable retention fact at terminal COMMIT, never current disclosure permission. */
export const ObservationRetentionSchema = z
  .object({
    version: z.literal("observation-retention.v1"),
    state: z.enum(["STORED", "NOT_REQUESTED", "WITHHELD", "EXPIRED", "FAILED"]),
    reportId: z
      .string()
      .regex(/^ob1_[a-f0-9]{64}$/u)
      .nullable(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    expiresAt: z.string().datetime().nullable(),
    reason: z
      .enum([
        "POLICY_DISABLED",
        "SOURCE_NOT_AUTHORIZED",
        "RETENTION_EXPIRED",
        "REPORT_PERSISTENCE_FAILED"
      ])
      .nullable()
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.state === "STORED" && (!r.reportId || !r.digest || !r.expiresAt || r.reason))
      ctx.addIssue({
        code: "custom",
        message: "Stored report needs its exact committed reference."
      });
    const reason = {
      NOT_REQUESTED: "POLICY_DISABLED",
      WITHHELD: "SOURCE_NOT_AUTHORIZED",
      EXPIRED: "RETENTION_EXPIRED",
      FAILED: "REPORT_PERSISTENCE_FAILED"
    } as const;
    if (r.state !== "STORED" && r.reason !== reason[r.state])
      ctx.addIssue({ code: "custom", message: "Report disposition and reason disagree." });
    if (r.state === "NOT_REQUESTED" && (r.digest !== null || r.expiresAt !== null))
      ctx.addIssue({
        code: "custom",
        message: "Opted-out reports persist no content fingerprint or expiry."
      });
    if (r.state !== "STORED" && r.reportId !== null)
      ctx.addIssue({ code: "custom", message: "Unavailable report has no stored reference." });
  });
export type ObservationRetention = z.infer<typeof ObservationRetentionSchema>;
/** Retained reports are neither confirmed world facts nor task-completion receipts. */
export const ObservationEvidenceSchema = z
  .object({
    schema: z.literal("observation.v1"),
    id: z.string().regex(/^ob1_[a-f0-9]{64}$/u),
    kind: z.enum(["VISION", "READ_TEXT"]),
    availability: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    unavailableReason: z
      .enum([
        "EXPIRED",
        "DELETED",
        "SOURCE_AUTHORITY_UNAVAILABLE",
        "RETENTION_DISABLED",
        "EXECUTION_INTEGRITY_CONFLICT"
      ])
      .optional(),
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
/** A9 execution truth and the current privacy lifecycle are separate facts.
 * No body, source parameters or inaccessible object IDs are returned here. */
export const ObservationExecutionSchema = z
  .object({
    schema: z.literal("observation.execution.v1"),
    attemptId: z.string().regex(/^ea1_[a-f0-9]{64}$/u),
    execution: z.enum(["NOT_STARTED", "UNKNOWN", "APPLIED", "NOT_APPLIED", "INTEGRITY_CONFLICT"]),
    hasAppliedReceipt: z.boolean(),
    retentionAtCommit: ObservationRetentionSchema.nullable(),
    report: z.enum([
      "NOT_PRODUCED",
      "UNKNOWN",
      "NOT_REQUESTED",
      "AVAILABLE",
      "EXPIRED",
      "DELETED",
      "WITHHELD",
      "FAILED",
      "LEGACY_MISSING",
      "UNAVAILABLE"
    ]),
    reportId: z
      .string()
      .regex(/^ob1_[a-f0-9]{64}$/u)
      .nullable(),
    goalStatus: z.literal("NOT_INFERRED")
  })
  .strict();
export type ObservationExecution = z.infer<typeof ObservationExecutionSchema>;
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
  async execution(sessionId: string, attemptId: string) {
    return ObservationExecutionSchema.parse(
      await this.request(
        `/observations/v1/executions/${encodeURIComponent(attemptId)}?${new URLSearchParams({ sessionId })}`
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
