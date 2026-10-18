import { z } from "zod";
import { ContextBlockSchema, ContextExposureSchema } from "@companion/protocol";
import { randomUUID } from "node:crypto";
import { canonicalScope, MemoryAuthorityError, type AuthorityQuery } from "./types.js";
import type {
  MemoryRetrievalInput,
  MemoryRetrievalOutcome,
  MemoryReadAuthority
} from "../provider.js";
import { EvidenceSupportSchema } from "./evidence-support.js";
const coverageSchema = z
  .array(
    z
      .object({
        id: z.string().max(16),
        quote: z.string().max(512),
        candidateIds: z.array(z.string().max(1024)).max(64),
        selectedIds: z.array(z.string().max(1024)).max(64),
        preferredId: z.string().max(1024).nullable().optional(),
        preferredSelected: z.boolean().optional(),
        status: z.enum([
          "SELECTED_CANDIDATE",
          "NO_AUTHORIZED_CANDIDATE",
          "RESULT_BOUND",
          "CHANNEL_UNAVAILABLE"
        ])
      })
      .strip()
  )
  .max(5);

export const RetrievalQueryPlanSchema = z
  .object({
    schema: z.literal("memory.search-plan.v1"),
    originalQueryTruncated: z.boolean().optional(),
    status: z.enum(["DISABLED", "APPLIED", "UNAVAILABLE"]),
    queries: z.array(z.string().max(4000)).max(3),
    model: z.string().max(512).nullable(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        cachedInputTokens: z.number().nonnegative().optional()
      })
      .strip()
      .nullable(),
    channels: z
      .array(
        z
          .object({
            query: z.string().max(4000),
            needId: z.string().max(16).nullable().optional(),
            lexicalIndex: z.string().max(64).optional(),
            queryTermsLimited: z.boolean().optional(),
            candidateLimited: z.boolean().optional(),
            status: z.enum(["OK", "UNAVAILABLE"]),
            ids: z.array(z.string().max(1024)).max(32)
          })
          .strip()
      )
      .max(26),
    coverage: coverageSchema.optional(),
    evidenceSupport: EvidenceSupportSchema.optional(),
    vectorChannels: z
      .array(
        z
          .object({
            needId: z.string().max(16).nullable(),
            query: z.string().max(4000),
            status: z.enum(["OK", "UNAVAILABLE"]),
            ids: z.array(z.string().max(1024)).max(32)
          })
          .strip()
      )
      .max(6)
      .optional(),
    textStatus: z.enum(["OK", "PARTIAL_OR_UNAVAILABLE"]),
    vectorStatus: z.enum(["DISABLED", "OK", "UNAVAILABLE", "PENDING"])
  })
  .strip();
export type RetrievalCandidate = {
  id: string;
  version: string;
  state: string;
  channels: ("TEXT" | "VECTOR")[];
  selected: boolean;
  reason: "SELECTED" | "RESULT_BOUND" | "NO_LONGER_CURRENT" | "EVIDENCE_NOT_ESTABLISHED";
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
    reason: z.enum(["SELECTED", "RESULT_BOUND", "NO_LONGER_CURRENT", "EVIDENCE_NOT_ESTABLISHED"]),
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
    detail: {
      watermark: string;
      candidates: RetrievalCandidate[];
      modelTag?: string | undefined;
      queryPlan?: unknown;
    }
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
      `insert into memory_retrieval_runs(scope,retrieval_id,trace_id,session_id,source_ref,reader,query,status,error_code,limited,watermark,model_tag,candidates,candidate_count,candidate_evidence_limited,query_plan)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
        candidates.length > 64,
        detail.queryPlan ? disclosed(RetrievalQueryPlanSchema, detail.queryPlan) : null
      ]
    );
    return id;
  }
  async page(input: {
    scope: string;
    traceId?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    access?: MemoryReadAuthority | undefined;
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
      where scope=$1 and ($2::text is null or trace_id=$2) and ($3::timestamptz is null or (created_at,retrieval_id)<($3::timestamptz,$4::text)) and ($6::jsonb is null or reader=$6::jsonb) order by created_at desc,retrieval_id desc limit $5`,
        [
          input.scope,
          input.traceId ?? null,
          cursor?.at ?? null,
          cursor?.id ?? null,
          limit + 1,
          input.access ?? null
        ]
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
  async detail(scope: string, id: string, access?: MemoryReadAuthority) {
    canonicalScope(scope);
    const row = (
      await this.db.query(
        "select * from memory_retrieval_runs where scope=$1 and retrieval_id=$2 and ($3::jsonb is null or reader=$3::jsonb)",
        [scope, id, access ?? null]
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
      queryPlan: row["query_plan"] ? disclosed(RetrievalQueryPlanSchema, row["query_plan"]) : null,
      contextsLimited: exposures.length > 100
    };
  }
}

export type MemoryRetrievalPage = Awaited<ReturnType<MemoryRetrievalEvidence["page"]>>;
export type MemoryRetrievalDetail = NonNullable<
  Awaited<ReturnType<MemoryRetrievalEvidence["detail"]>>
>;
