import type { MemoryEvent } from "../provider.js";
import { MemoryLineageV1Schema } from "../lineage.js";
import {
  canonicalScope,
  MemoryAuthorityError,
  searchTerms,
  type AuthorityQuery,
  type AuthorityRelation,
  type KnowledgeOverview,
  type KnowledgePage,
  type KnowledgeRecord,
  type MemoryProcessingView,
  type MemoryMigrationView,
  type MemoryJobState,
  type KnowledgeState
} from "./types.js";

/** Scalar generation lookup is an InitPlan for a fixed scope. A view join can
 * make PostgreSQL sort the entire scope before LIMIT; keep the pointer in the same snapshot.
 */
const activeProjection = `(select scope,id,version,state,search from memory_authority_projection_rows
 where scope=$1 and generation=(select projection_generation from memory_authority_scopes where scope=$1))`;

export class MemoryKnowledgeReader {
  constructor(private readonly db: AuthorityQuery) {}
  async overview(scope: string): Promise<KnowledgeOverview> {
    canonicalScope(scope);
    const row = (
      await this.db.query("select * from memory_authority_scopes where scope=$1", [scope])
    ).rows[0];
    const version = String(row?.["version"] ?? "0");
    const projectionVersion = String(row?.["projection_version"] ?? "0");
    const audit = (
      await this.db.query(
        "select status,anchor from memory_authority_audits where scope=$1 order by created_at desc,audit_id desc limit 1",
        [scope]
      )
    ).rows[0];
    return {
      schema: "memory.overview.v1",
      status: version === projectionVersion ? "OK" : "PARTIAL",
      version,
      projectionVersion,
      records: String(row?.["record_count"] ?? "0"),
      current: String(row?.["current_count"] ?? "0"),
      legacy: String(row?.["legacy_count"] ?? "0"),
      unattributed: String(row?.["unattributed_count"] ?? "0"),
      integrity:
        audit?.["status"] === "VERIFIED" && String(audit["anchor"]) === version
          ? "VERIFIED"
          : "NOT_VERIFIED",
      compatibility: Number(row?.["legacy_count"] ?? 0)
        ? "LEGACY_UNVERIFIED_PRESENT"
        : "NO_LEGACY_IMPORT"
    };
  }
  async page(input: {
    scope: string;
    limit?: number | undefined;
    cursor?: string | undefined;
    state?: KnowledgeState | undefined;
  }): Promise<KnowledgePage> {
    const health = await this.requireProjection(input.scope);
    const cursor = decodeCursor(input.cursor, input.scope);
    const anchor = cursor?.anchor ?? health.version;
    const limit = boundLimit(input.limit);
    const rows = await this.db.query(
      `select r.*,c.state from ${activeProjection} c join memory_authority_records r using(scope,id)
      where c.scope=$1 and (($2::text is null and c.state in ('current','conflicted')) or c.state=$2) and c.version <= $3::bigint and ($4::bigint is null or c.version < $4::bigint)
      order by c.version desc limit $5`,
      [input.scope, input.state ?? null, anchor, cursor?.after ?? null, limit + 1]
    );
    const records = rows.rows.slice(0, limit).map(mapRecord);
    return {
      schema: "memory.page.v1",
      status: "OK",
      records,
      watermark: anchor,
      nextCursor:
        rows.rows.length > limit ? encodeCursor(input.scope, anchor, records.at(-1)!.version) : null
    };
  }
  async timeline(input: {
    scope: string;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<KnowledgePage> {
    const health = await this.requireProjection(input.scope);
    const cursor = decodeCursor(input.cursor, input.scope);
    const anchor = cursor?.anchor ?? health.version;
    const limit = boundLimit(input.limit);
    const rows = await this.db.query(
      `select r.*,c.state from memory_authority_records r join ${activeProjection} c using(scope,id)
      where r.scope=$1 and r.version <= $2::bigint and ($3::bigint is null or r.version < $3::bigint)
      order by r.version desc limit $4`,
      [input.scope, anchor, cursor?.after ?? null, limit + 1]
    );
    const records = rows.rows.slice(0, limit).map(mapRecord);
    return {
      schema: "memory.page.v1",
      status: "OK",
      records,
      watermark: anchor,
      nextCursor:
        rows.rows.length > limit ? encodeCursor(input.scope, anchor, records.at(-1)!.version) : null
    };
  }
  async detail(scope: string, id: string): Promise<KnowledgeRecord | null> {
    await this.requireProjection(scope);
    const row = (
      await this.db.query(
        `select r.*,c.state from memory_authority_records r join ${activeProjection} c using(scope,id) where r.scope=$1 and r.id=$2`,
        [scope, id]
      )
    ).rows[0];
    return row ? mapRecord(row) : null;
  }
  async search(
    scope: string,
    text: string,
    limit = 8
  ): Promise<{ records: KnowledgeRecord[]; watermark: string; candidateLimited: boolean }> {
    const health = await this.requireProjection(scope);
    // Bound the query, not the corpus. All candidates are resolved against the current projection.
    const terms = searchTerms(text).slice(0, 32);
    if (!terms.length) return { records: [], watermark: health.version, candidateLimited: false };
    // Existing Chinese documents are indexed as bigrams. A one-Han search
    // term must match a leading bigram (e.g. a topic noun), rather than require
    // an impossible unigram lexeme. No fact- or intent-specific vocabulary.
    const query = terms
      .map((t) => `'${t.replaceAll("'", "''")}'${/^\p{Script=Han}$/u.test(t) ? ":*" : ""}`)
      .join(" | ");
    const rows = await this.db.query(
      `with ranked as materialized (
      select scope,id,state,version,ts_rank(search,to_tsquery('simple',$2)) as relevance
      from ${activeProjection} c where scope=$1 and state in ('current','conflicted')
        and search @@ to_tsquery('simple',$2)
      order by relevance desc,version desc,id limit $3::int+1
      ) select r.*,c.state,(select count(*) from ranked)>$3::int as candidate_limited
      from ranked c join memory_authority_records r using(scope,id)
      order by c.relevance desc,c.version desc,c.id limit $3`,
      [scope, query, boundLimit(limit)]
    );
    return {
      records: rows.rows.map(mapRecord),
      watermark: health.version,
      candidateLimited: rows.rows[0]?.["candidate_limited"] === true
    };
  }
  /** Resolve a bounded candidate set against ONE current generation/version snapshot.
   * Retrieval stages may cross a correction while an embedding Provider is in flight.
   * Their earlier DTO states are ranking hints, never final current-knowledge authority.
   */
  async resolveCandidates(scope: string, ids: string[]) {
    canonicalScope(scope);
    if (ids.length > 100 || new Set(ids).size !== ids.length)
      throw new MemoryAuthorityError("MEMORY_CANDIDATE_BOUND");
    const rows = (
      await this.db.query(
        `with snapshot as materialized (
      select version,projection_version,projection_generation from memory_authority_scopes where scope=$1)
      select s.version as snapshot_version,s.projection_version as snapshot_projection,r.*,c.state from snapshot s
      left join memory_authority_projection_rows c on c.scope=$1 and c.generation=s.projection_generation and c.id=any($2::text[])
      left join memory_authority_records r on r.scope=c.scope and r.id=c.id`,
        [scope, ids]
      )
    ).rows;
    const first = rows[0];
    if (first && first["snapshot_version"] !== first["snapshot_projection"])
      throw new MemoryAuthorityError("MEMORY_PROJECTION_STALE");
    return {
      watermark: String(first?.["snapshot_version"] ?? "0"),
      records: rows.filter((r) => r["id"] !== null && r["id"] !== undefined).map(mapRecord)
    };
  }
  async relations(
    scope: string,
    id: string,
    limit = 40
  ): Promise<{ schema: "memory.relations.v1"; relations: AuthorityRelation[]; limited: boolean }> {
    await this.requireProjection(scope);
    const n = boundLimit(limit);
    const rows = await this.db.query(
      `select from_id,to_id,kind,version from memory_authority_relations where scope=$1 and (from_id=$2 or to_id=$2) order by version desc limit $3`,
      [scope, id, n + 1]
    );
    return {
      schema: "memory.relations.v1",
      relations: rows.rows.slice(0, n).map((r) => ({
        fromId: String(r["from_id"]),
        toId: String(r["to_id"]),
        kind: r["kind"] as AuthorityRelation["kind"],
        version: String(r["version"])
      })),
      limited: rows.rows.length > n
    };
  }
  async migrations(scope: string): Promise<MemoryMigrationView[]> {
    return (
      await this.db.query(
        "select migration_id,source,checkpoint,imported_count,state,error_code,updated_at from memory_authority_migrations where scope=$1 order by updated_at desc,migration_id limit 10",
        [scope]
      )
    ).rows.map((r) => ({
      id: String(r["migration_id"]),
      source: String(r["source"]),
      checkpoint: r["checkpoint"] as string | null,
      importedCount: String(r["imported_count"]),
      state: r["state"] as MemoryMigrationView["state"],
      errorCode: r["error_code"] as string | null,
      updatedAt: new Date(String(r["updated_at"])).toISOString()
    }));
  }
  async processing(scope: string, id: string): Promise<MemoryProcessingView> {
    canonicalScope(scope);
    const row = (
      await this.db.query(
        "select status,attempts,next_attempt_at,error_code,provider_model,token_usage,duration_ms,created_at,updated_at from memory_semantic_jobs where scope=$1 and job_id=$2",
        [scope, id]
      )
    ).rows[0];
    const usage = row?.["token_usage"] as Record<string, unknown> | null;
    const semantic = row
      ? {
          id,
          state: row["status"] as MemoryJobState,
          attempts: Number(row["attempts"]),
          nextAttemptAt: optionalTime(row["next_attempt_at"]),
          errorCode: row["error_code"] as string | null,
          model: row["provider_model"] as string | null,
          usage: usage
            ? {
                inputTokens: typeof usage["inputTokens"] === "number" ? usage["inputTokens"] : null,
                outputTokens:
                  typeof usage["outputTokens"] === "number" ? usage["outputTokens"] : null
              }
            : null,
          durationMs: row["duration_ms"] as number | null,
          createdAt: new Date(String(row["created_at"])).toISOString(),
          updatedAt: new Date(String(row["updated_at"])).toISOString()
        }
      : null;
    const indexes = (
      await this.db.query(
        `select j.model_tag,j.status,j.attempts,j.error_code,j.next_attempt_at,j.completed_at,
      case when c.state not in ('current','conflicted') then 'RETIRED' when v.authority_version=c.version then 'CURRENT' else 'MISSING' end as projection
      from memory_authority_index_jobs j join ${activeProjection} c using(scope,id) left join memory_authority_vectors v using(scope,id,model_tag)
      where j.scope=$1 and j.id=$2 order by j.model_tag limit 100`,
        [scope, id]
      )
    ).rows.map((r) => ({
      modelTag: String(r["model_tag"]),
      state: r["status"] as MemoryJobState,
      attempts: Number(r["attempts"]),
      errorCode: r["error_code"] as string | null,
      nextAttemptAt: optionalTime(r["next_attempt_at"]),
      completedAt: optionalTime(r["completed_at"]),
      projection: r["projection"] as "CURRENT" | "MISSING" | "RETIRED"
    }));
    return { schema: "memory.processing.v1", semantic, indexes };
  }
  private async requireProjection(scope: string) {
    const health = await this.overview(scope);
    if (health.status !== "OK") throw new MemoryAuthorityError("MEMORY_PROJECTION_BEHIND");
    return health;
  }
}
function mapRecord(row: Record<string, unknown>): KnowledgeRecord {
  const event = row["event"] as MemoryEvent;
  if (
    typeof event.content !== "string" ||
    ![
      "episodic",
      "fact",
      "user_claim",
      "interaction",
      "correction",
      "commitment_evidence"
    ].includes(event.kind)
  )
    throw new MemoryAuthorityError("MEMORY_PRODUCT_RECORD_INVALID");
  // Authority payload is protected history, not a product DTO. Never spread an
  // old/provider JSON object into the API: it can carry arbitrary source bodies.
  const parsedLineage =
    row["classification"] === "GROUNDED" ? MemoryLineageV1Schema.safeParse(event.lineage) : null;
  const publicEvent: MemoryEvent = {
    id: String(row["id"]),
    kind: event.kind,
    content: event.content,
    source: "postgres",
    sourceRecordId: String(row["id"]),
    scope: String(row["scope"]),
    ...(publicTime(event.recordedAt) ? { recordedAt: publicTime(event.recordedAt)! } : {}),
    ...(publicTime(event.observedAt) ? { observedAt: publicTime(event.observedAt)! } : {}),
    ...(parsedLineage?.success ? { lineage: parsedLineage.data } : {}),
    ...(row["classification"] === "GROUNDED" &&
    event.assertion &&
    ["user", "assistant", "mixed", "system", "unknown"].includes(event.assertion.source) &&
    ["unverified", "verified", "unknown"].includes(event.assertion.verification)
      ? {
          assertion: { source: event.assertion.source, verification: event.assertion.verification }
        }
      : {}),
    metadata: { knowledgeState: row["state"], knowledgeVersion: String(row["version"]) }
  };
  return {
    schema: "memory.knowledge.v1",
    id: String(row["id"]),
    version: String(row["version"]),
    state: row["state"] as KnowledgeState,
    classification: row["classification"] as KnowledgeRecord["classification"],
    sourceAt: new Date(String(row["source_at"])).toISOString(),
    committedAt: new Date(String(row["committed_at"])).toISOString(),
    evidence: {
      sourceOrigin:
        publicEvent.lineage?.state === "GROUNDED" ? publicEvent.lineage.origin : "UNKNOWN",
      interpretation:
        row["classification"] === "GROUNDED" && event.metadata["semanticPolicy"]
          ? "MODEL_PROPOSED"
          : "HOST_OR_LEGACY",
      selectedSpan:
        row["classification"] === "GROUNDED"
          ? selectedSpan(event.metadata["evidenceSelection"])
          : null
    },
    event: publicEvent
  };
}
function publicTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}
function selectedSpan(value: unknown): KnowledgeRecord["evidence"]["selectedSpan"] {
  if (!value || typeof value !== "object") return null;
  const selection = value as Record<string, unknown>;
  const start = selection["start"],
    end = selection["end"];
  return selection["unit"] === "UNICODE_CODE_POINT" &&
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end >= start
    ? { unit: "UNICODE_CODE_POINT", start, end }
    : null;
}
function boundLimit(n?: number): number {
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 100))
    throw new MemoryAuthorityError("MEMORY_LIMIT_INVALID");
  return n ?? 20;
}
function encodeCursor(scope: string, anchor: string, after: string) {
  return Buffer.from(JSON.stringify({ v: 1, scope, anchor, after })).toString("base64url");
}
function decodeCursor(
  cursor: string | undefined,
  scope: string
): { anchor: string; after: string } | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 4096) throw new Error();
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, unknown>;
    if (
      p["v"] !== 1 ||
      p["scope"] !== scope ||
      !validVersion(p["anchor"]) ||
      !validVersion(p["after"]) ||
      BigInt(p["after"]) > BigInt(p["anchor"])
    )
      throw new Error();
    return { anchor: p["anchor"], after: p["after"] };
  } catch {
    throw new MemoryAuthorityError("MEMORY_CURSOR_INVALID");
  }
}
function validVersion(v: unknown): v is string {
  return (
    typeof v === "string" && /^(0|[1-9][0-9]{0,18})$/u.test(v) && BigInt(v) <= 9223372036854775807n
  );
}

function optionalTime(value: unknown): string | null {
  return value == null ? null : new Date(String(value)).toISOString();
}
