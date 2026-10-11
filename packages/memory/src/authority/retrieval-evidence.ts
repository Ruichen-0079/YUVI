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
export class MemoryRetrievalEvidence {
  constructor(private readonly db: AuthorityQuery) {}
  async record(
    input: MemoryRetrievalInput,
    outcome: MemoryRetrievalOutcome,
    detail: { watermark: string; candidates: RetrievalCandidate[]; modelTag?: string | undefined }
  ) {
    if (!input.scope || !input.access)
      throw new MemoryAuthorityError("MEMORY_EVIDENCE_AUTHORITY_REQUIRED");
    const id = `mre_${randomUUID()}`;
    await this.db.query(
      `insert into memory_retrieval_runs(scope,retrieval_id,trace_id,session_id,source_ref,reader,query,status,error_code,limited,watermark,model_tag,candidates)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
        JSON.stringify(detail.candidates.slice(0, 64))
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
    const items = rows
      .slice(0, limit)
      .map((r) => ({
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
        `select manifest_id,exposure_id,consumer_operation,memory_blocks,exposure from memory_retrieval_contexts where scope=$1 and retrieval_id=$2 order by created_at,exposure_id limit 101`,
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
      candidates: row["candidates"] as RetrievalCandidate[],
      contexts: exposures
        .slice(0, 100)
        .map((e) => ({
          manifestId: String(e["manifest_id"]),
          exposureId: String(e["exposure_id"]),
          consumerOperation: String(e["consumer_operation"]),
          memoryBlocks: e["memory_blocks"],
          exposure: e["exposure"]
        })),
      contextsLimited: exposures.length > 100
    };
  }
}
