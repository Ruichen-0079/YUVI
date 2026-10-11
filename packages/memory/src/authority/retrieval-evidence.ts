import { z } from "zod";
import { ContextBlockSchema, ContextExposureSchema } from "@companion/protocol";
import { randomUUID } from "node:crypto";
import { canonicalScope, MemoryAuthorityError, type AuthorityQuery } from "./types.js";
import type { MemoryRetrievalInput, MemoryRetrievalOutcome } from "../provider.js";

export type RetrievalCandidate = {
  id: string;
  version: string;
  state: string;
  channels: ("TEXT" | "VECTOR")[];
  selected: boolean;
  reason: "SELECTED" | "RESULT_BOUND" | "NO_LONGER_CURRENT";
  content: string;
};
const candidateSchema = z
  .object({
    id: z.string().min(1).max(1024),
    version: z.string().regex(/^\d+$/),
    state: z.enum([
      "current",
      "superseded",
      "conflicted",
      "supporting",
      "legacy_unverified",
      "unattributed"
    ]),
    channels: z.array(z.enum(["TEXT", "VECTOR"])).max(2),
    selected: z.boolean(),
    reason: z.enum(["SELECTED", "RESULT_BOUND", "NO_LONGER_CURRENT"]),
    content: z.string().max(16000)
  })
  .strip();
const memoryBlocksSchema = z.array(ContextBlockSchema.strip()).max(128);
const memoryExposureSchema = z
  .object({
    boundary: z.literal("PREPARED_FOR_USE"),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    blocks: z.array(ContextExposureSchema.shape.blocks.element.strip()).max(128)
  })
  .strip();
function disclosed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MemoryAuthorityError("MEMORY_RETRIEVAL_EVIDENCE_INVALID");
  return result.data;
}
export class MemoryRetrievalEvidence {
  constructor(private readonly db: AuthorityQuery) {}
  async record(
    input: MemoryRetrievalInput,
    outcome: MemoryRetrievalOutcome,
    detail: { watermark: string; candidates: RetrievalCandidate[]; modelTag?: string | undefined }
  ) {
    if (!input.scope || !input.access)
      throw new MemoryAuthorityError("MEMORY_EVIDENCE_AUTHORITY_REQUIRED");
    if (detail.candidates.filter((c) => c.selected).length > 64)
      throw new MemoryAuthorityError("MEMORY_EVIDENCE_CONTEXT_BOUND");
    const candidates = [...detail.candidates].sort(
      (a, b) => Number(b.selected) - Number(a.selected)
    );
    const id = `mre_${randomUUID()}`;
    await this.db.query(
      `insert into memory_retrieval_runs(scope,retrieval_id,trace_id,session_id,source_ref,reader,query,status,error_code,limited,watermark,model_tag,candidates,candidate_count,candidate_evidence_limited)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        input.scope,
        id,
        input.traceId ?? id,
        input.sessionId ?? null,
        input.sourceJournalRef ?? null,
        input.access,
        input.text.slice(0, 4000),
        outcome.status,
        outcome.errorCode ?? outcome.limitReason ?? null,
        outcome.limited,
        detail.watermark,
        detail.modelTag ?? null,
        JSON.stringify(disclosed(z.array(candidateSchema).max(64), candidates.slice(0, 64))),
        candidates.length,
        candidates.length > 64
      ]
    );
    return id;
  }
  async page(input: {
    scope: string;
    traceId?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }) {
    canonicalScope(input.scope);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new MemoryAuthorityError("MEMORY_LIMIT_INVALID");
    let cursor: { scope: string; traceId: string | null; at: string; id: string } | undefined;
    if (input.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      } catch {
        throw new MemoryAuthorityError("MEMORY_CURSOR_INVALID");
      }
      if (
        !cursor ||
        cursor.scope !== input.scope ||
        cursor.traceId !== (input.traceId ?? null) ||
        typeof cursor.at !== "string" ||
        !Number.isFinite(Date.parse(cursor.at)) ||
        typeof cursor.id !== "string"
      )
        throw new MemoryAuthorityError("MEMORY_CURSOR_INVALID");
    }
    const rows = (
      await this.db.query(
        `select retrieval_id,trace_id,session_id,status,error_code,limited,watermark,model_tag,created_at from memory_retrieval_runs
      where scope=$1 and ($2::text is null or trace_id=$2) and ($3::timestamptz is null or (created_at,retrieval_id)<($3::timestamptz,$4::text)) order by created_at desc,retrieval_id desc limit $5`,
        [input.scope, input.traceId ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1]
      )
    ).rows;
    const items = rows.slice(0, limit).map((r) => ({
      id: String(r["retrieval_id"]),
      traceId: String(r["trace_id"]),
      sessionId: r["session_id"] as string | null,
      status: String(r["status"]),
      errorCode: r["error_code"] as string | null,
      limited: r["limited"] === true,
      watermark: String(r["watermark"]),
      modelTag: r["model_tag"] as string | null,
      at: (r["created_at"] as Date).toISOString()
    }));
    const last = items.at(-1);
    return {
      schema: "memory.retrieval.page.v1" as const,
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                scope: input.scope,
                traceId: input.traceId ?? null,
                at: last.at,
                id: last.id
              })
            ).toString("base64url")
          : null
    };
  }
  async detail(scope: string, id: string) {
    canonicalScope(scope);
    const row = (
      await this.db.query(
        "select * from memory_retrieval_runs where scope=$1 and retrieval_id=$2",
        [scope, id]
      )
    ).rows[0];
    if (!row) return null;
    const exposures = (
      await this.db.query(
        `with contexts as materialized (select * from memory_retrieval_contexts where scope=$1 and retrieval_id=$2 order by created_at,exposure_id limit 101)
        select c.manifest_id,c.exposure_id,c.consumer_operation,c.memory_blocks,c.exposure,
          (select coalesce(jsonb_agg(x),'[]'::jsonb) from (
            select i.intent_id as "intentId",i.state as "admissionState",a.attempt_id as "attemptId",a.dispatch_started_at as "dispatchStartedAt",o.evidence->>'certainty' as certainty,o.evidence->>'layer' as layer
            from effect_intents i left join effect_attempts a using(intent_id)
            left join lateral(select evidence from effect_observations where attempt_id=a.attempt_id and category='TERMINAL' order by observation_id desc limit 1) o on true
            where i.intent->'request'->'payload'->'inputSnapshot'->'manifest'->>'exposureId'=c.exposure_id
            or i.intent->'request'->'payload'->'contextUse'->>'exposureId'=c.exposure_id
            order by i.intent_id,a.ordinal limit 21
          ) x) as consumers from contexts c`,
        [scope, id]
      )
    ).rows;
    return {
      schema: "memory.retrieval.v1" as const,
      id,
      traceId: String(row["trace_id"]),
      query: String(row["query"]),
      status: String(row["status"]),
      errorCode: row["error_code"] as string | null,
      limited: row["limited"] === true,
      watermark: String(row["watermark"]),
      modelTag: row["model_tag"] as string | null,
      candidateCount: typeof row["candidate_count"] === "number" ? row["candidate_count"] : null,
      candidateEvidenceLimited:
        typeof row["candidate_evidence_limited"] === "boolean"
          ? row["candidate_evidence_limited"]
          : null,
      candidates: disclosed(z.array(candidateSchema).max(64), row["candidates"]),
      contexts: exposures.slice(0, 100).map((e) => ({
        manifestId: String(e["manifest_id"]),
        exposureId: String(e["exposure_id"]),
        consumerOperation: String(e["consumer_operation"]),
        memoryBlocks: disclosed(memoryBlocksSchema, e["memory_blocks"]),
        exposure: disclosed(memoryExposureSchema, e["exposure"]),
        consumers: disclosed(
          z
            .array(
              z
                .object({
                  intentId: z.string(),
                  admissionState: z.string(),
                  attemptId: z.string().nullable(),
                  dispatchStartedAt: z.string().nullable(),
                  certainty: z
                    .enum(["APPLIED", "DEFINITIVE_REJECTION", "PROVEN_NOT_APPLIED", "UNKNOWN"])
                    .nullable(),
                  layer: z.string().nullable()
                })
                .strip()
            )
            .max(21),
          e["consumers"]
        ).slice(0, 20),
        consumersLimited: Array.isArray(e["consumers"]) && e["consumers"].length > 20
      })),
      contextsLimited: exposures.length > 100
    };
  }
}

export type MemoryRetrievalPage = Awaited<ReturnType<MemoryRetrievalEvidence["page"]>>;
export type MemoryRetrievalDetail = NonNullable<
  Awaited<ReturnType<MemoryRetrievalEvidence["detail"]>>
>;
