import type { Pool } from "pg";
import { createPostgresPool } from "@companion/database";
import type { QueryResultRow } from "pg";
import { parseMemoryRepositoryEnv } from "./env.js";
import { DEFAULT_L1_MAX_EPISODES, DEFAULT_L1_RETENTION_MS } from "./hierarchy.js";
import type { RecentEpisode, RecentEpisodeStatus } from "./recent-episode.js";

export type RecentEpisodeListQuery = {
  now: Date;
  sessionId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  includeRolled?: boolean | undefined;
  limit?: number | undefined;
};

export interface RecentEpisodeStore {
  readonly kind: "in-memory" | "postgres";
  upsert(episode: RecentEpisode): Promise<RecentEpisode>;
  getById(id: string): Promise<RecentEpisode | null>;
  getByDigest(sourceDigest: string): Promise<RecentEpisode | null>;
  listActive(query: RecentEpisodeListQuery): Promise<RecentEpisode[]>;
  markStatus(
    id: string,
    status: RecentEpisodeStatus,
    fields?: {
      consolidatedAt?: string | null | undefined;
      consolidationJobId?: string | null | undefined;
      recurrenceCount?: number | undefined;
    }
  ): Promise<RecentEpisode | null>;
  rollover(query: RecentEpisodeListQuery & { maxActive?: number | undefined }): Promise<number>;
  close?(): Promise<void>;
}

export class InMemoryRecentEpisodeStore implements RecentEpisodeStore {
  readonly kind = "in-memory" as const;
  private readonly episodes = new Map<string, RecentEpisode>();
  private readonly digestIndex = new Map<string, string>();

  async upsert(episode: RecentEpisode): Promise<RecentEpisode> {
    const existing = this.episodes.get(episode.id);
    if (existing) {
      this.digestIndex.delete(existing.sourceDigest);
    }
    const stored = cloneEpisode(episode);
    this.episodes.set(stored.id, stored);
    this.digestIndex.set(stored.sourceDigest, stored.id);
    return cloneEpisode(stored);
  }

  async getById(id: string): Promise<RecentEpisode | null> {
    const episode = this.episodes.get(id);
    return episode ? cloneEpisode(episode) : null;
  }

  async getByDigest(sourceDigest: string): Promise<RecentEpisode | null> {
    const id = this.digestIndex.get(sourceDigest);
    return id ? this.getById(id) : null;
  }

  async listActive(query: RecentEpisodeListQuery): Promise<RecentEpisode[]> {
    const nowMs = query.now.getTime();
    const allowed = new Set<RecentEpisodeStatus>(
      query.includeRolled ? ["active", "rolled"] : ["active"]
    );
    const matches = [...this.episodes.values()].filter((episode) => {
      if (!allowed.has(episode.status)) return false;
      if (parseMs(episode.expiresAt) <= nowMs) return false;
      if (query.sessionId && !query.subjectUserId && episode.sessionId !== query.sessionId) {
        return false;
      }
      if (query.subjectUserId && episode.subjectUserId !== query.subjectUserId) return false;
      if (query.personaId && episode.personaId !== query.personaId) return false;
      return true;
    });
    matches.sort((left, right) => right.endedAt.localeCompare(left.endedAt));
    return matches.slice(0, query.limit ?? DEFAULT_L1_MAX_EPISODES).map(cloneEpisode);
  }

  async markStatus(
    id: string,
    status: RecentEpisodeStatus,
    fields: {
      consolidatedAt?: string | null | undefined;
      consolidationJobId?: string | null | undefined;
      recurrenceCount?: number | undefined;
    } = {}
  ): Promise<RecentEpisode | null> {
    const existing = this.episodes.get(id);
    if (!existing) return null;
    const next: RecentEpisode = {
      ...existing,
      status,
      ...(fields.consolidatedAt !== undefined ? { consolidatedAt: fields.consolidatedAt } : {}),
      ...(fields.consolidationJobId !== undefined
        ? { consolidationJobId: fields.consolidationJobId }
        : {}),
      ...(fields.recurrenceCount !== undefined ? { recurrenceCount: fields.recurrenceCount } : {}),
      lastAccessedAt: new Date().toISOString()
    };
    this.episodes.set(id, next);
    return cloneEpisode(next);
  }

  async rollover(
    query: RecentEpisodeListQuery & { maxActive?: number | undefined }
  ): Promise<number> {
    const nowMs = query.now.getTime();
    let changed = 0;
    for (const episode of this.episodes.values()) {
      if (episode.status === "active" && parseMs(episode.expiresAt) <= nowMs) {
        episode.status = "expired";
        changed += 1;
      }
    }
    const active = [...this.episodes.values()]
      .filter((episode) => episode.status === "active")
      .sort((left, right) => right.endedAt.localeCompare(left.endedAt));
    const maxActive = query.maxActive ?? DEFAULT_L1_MAX_EPISODES;
    for (const episode of active.slice(maxActive)) {
      episode.status = "rolled";
      changed += 1;
    }
    return changed;
  }
}

export class PostgresRecentEpisodeStore implements RecentEpisodeStore {
  readonly kind = "postgres" as const;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(connectionString: string | Pool) {
    this.ownsPool = typeof connectionString === "string";
    this.pool =
      typeof connectionString === "string"
        ? createPostgresPool(connectionString)
        : connectionString;
  }

  async upsert(episode: RecentEpisode): Promise<RecentEpisode> {
    const result = await this.pool.query(
      `insert into recent_episodes (
        episode_id, session_id, persona_id, subject_user_id, memory_scope,
        started_at, ended_at, recorded_at, occurred_at, temporal_confidence,
        status, source_turn_ids, source_digest, what_happened, user_statements,
        task_state, unresolved, outcome, assistant_context, metadata,
        recurrence_count, last_accessed_at, expires_at, consolidated_at,
        consolidation_job_id
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb,
        $16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25
      )
      on conflict (episode_id) do update set
        session_id = excluded.session_id,
        persona_id = excluded.persona_id,
        subject_user_id = excluded.subject_user_id,
        memory_scope = excluded.memory_scope,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        recorded_at = excluded.recorded_at,
        occurred_at = excluded.occurred_at,
        temporal_confidence = excluded.temporal_confidence,
        what_happened = excluded.what_happened,
        user_statements = excluded.user_statements,
        task_state = excluded.task_state,
        unresolved = excluded.unresolved,
        outcome = excluded.outcome,
        assistant_context = excluded.assistant_context,
        metadata = excluded.metadata,
        source_turn_ids = excluded.source_turn_ids,
        source_digest = excluded.source_digest,
        last_accessed_at = excluded.last_accessed_at,
        expires_at = excluded.expires_at,
        updated_at = now()
      returning *`,
      [
        episode.id,
        episode.sessionId,
        episode.personaId,
        episode.subjectUserId,
        episode.memoryScope,
        episode.startedAt,
        episode.endedAt,
        episode.recordedAt,
        episode.occurredAt,
        episode.temporalConfidence,
        episode.status,
        JSON.stringify(episode.sourceTurnIds),
        episode.sourceDigest,
        episode.whatHappened,
        JSON.stringify(episode.userStatements),
        episode.taskState,
        episode.unresolved,
        episode.outcome,
        episode.assistantContext,
        JSON.stringify(episode.metadata),
        episode.recurrenceCount,
        episode.lastAccessedAt,
        episode.expiresAt,
        episode.consolidatedAt,
        episode.consolidationJobId
      ]
    );
    return mapEpisodeRow(result.rows[0]);
  }

  async getById(id: string): Promise<RecentEpisode | null> {
    const result = await this.pool.query(`select * from recent_episodes where episode_id = $1`, [
      id
    ]);
    return result.rows[0] ? mapEpisodeRow(result.rows[0]) : null;
  }

  async getByDigest(sourceDigest: string): Promise<RecentEpisode | null> {
    const result = await this.pool.query(`select * from recent_episodes where source_digest = $1`, [
      sourceDigest
    ]);
    return result.rows[0] ? mapEpisodeRow(result.rows[0]) : null;
  }

  async listActive(query: RecentEpisodeListQuery): Promise<RecentEpisode[]> {
    const statuses = query.includeRolled ? ["active", "rolled"] : ["active"];
    const result = await this.pool.query(
      `select * from recent_episodes
       where status = any($1)
         and expires_at > $2
         and ($3::text is null or subject_user_id = $3)
         and ($4::text is null or persona_id = $4)
         and ($5::text is null or $3::text is not null or session_id = $5)
       order by ended_at desc
       limit $6`,
      [
        statuses,
        query.now.toISOString(),
        query.subjectUserId ?? null,
        query.personaId ?? null,
        query.sessionId ?? null,
        query.limit ?? DEFAULT_L1_MAX_EPISODES
      ]
    );
    return result.rows.map(mapEpisodeRow);
  }

  async markStatus(
    id: string,
    status: RecentEpisodeStatus,
    fields: {
      consolidatedAt?: string | null | undefined;
      consolidationJobId?: string | null | undefined;
      recurrenceCount?: number | undefined;
    } = {}
  ): Promise<RecentEpisode | null> {
    const result = await this.pool.query(
      `update recent_episodes
       set status = $2,
           consolidated_at = coalesce($3, consolidated_at),
           consolidation_job_id = coalesce($4, consolidation_job_id),
           recurrence_count = coalesce($5, recurrence_count),
           last_accessed_at = now(),
           updated_at = now()
       where episode_id = $1
       returning *`,
      [
        id,
        status,
        fields.consolidatedAt ?? null,
        fields.consolidationJobId ?? null,
        fields.recurrenceCount ?? null
      ]
    );
    return result.rows[0] ? mapEpisodeRow(result.rows[0]) : null;
  }

  async rollover(
    query: RecentEpisodeListQuery & { maxActive?: number | undefined }
  ): Promise<number> {
    const expired = await this.pool.query(
      `update recent_episodes
       set status = 'expired', updated_at = now()
       where status = 'active' and expires_at <= $1`,
      [query.now.toISOString()]
    );
    const active = await this.listActive({ ...query, includeRolled: false, limit: 200 });
    const maxActive = query.maxActive ?? DEFAULT_L1_MAX_EPISODES;
    const overflow = active.slice(maxActive);
    for (const episode of overflow) {
      await this.markStatus(episode.id, "rolled");
    }
    return (expired.rowCount ?? 0) + overflow.length;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

export function createRecentEpisodeStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
  sharedPool?: Pool
): RecentEpisodeStore {
  const repository = parseMemoryRepositoryEnv(env);
  if (repository.kind !== "postgres") {
    return new InMemoryRecentEpisodeStore();
  }
  if (sharedPool) return new PostgresRecentEpisodeStore(sharedPool);
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("PostgreSQL recent episode store requires DATABASE_URL.");
  }
  return new PostgresRecentEpisodeStore(databaseUrl);
}

export function reconstructableRetentionMs(): number {
  return DEFAULT_L1_RETENTION_MS;
}

function mapEpisodeRow(row: QueryResultRow | undefined): RecentEpisode {
  if (!row) throw new Error("Recent episode row was empty.");
  return {
    id: String(row["episode_id"]),
    sessionId: String(row["session_id"]),
    personaId: row["persona_id"] ?? null,
    subjectUserId: row["subject_user_id"] ?? null,
    memoryScope: row["memory_scope"] ?? null,
    startedAt: toIso(row["started_at"]),
    endedAt: toIso(row["ended_at"]),
    recordedAt: toIso(row["recorded_at"]),
    occurredAt: row["occurred_at"] ? toIso(row["occurred_at"]) : null,
    temporalConfidence: row["temporal_confidence"] as RecentEpisode["temporalConfidence"],
    status: row["status"] as RecentEpisodeStatus,
    sourceTurnIds: asStringArray(row["source_turn_ids"]),
    sourceDigest: String(row["source_digest"]),
    whatHappened: String(row["what_happened"]),
    userStatements: asStringArray(row["user_statements"]),
    taskState: row["task_state"] ?? null,
    unresolved: row["unresolved"] ?? null,
    outcome: row["outcome"] ?? null,
    assistantContext: row["assistant_context"] ?? null,
    metadata: asObject(row["metadata"]),
    recurrenceCount: Number(row["recurrence_count"] ?? 0),
    lastAccessedAt: toIso(row["last_accessed_at"]),
    expiresAt: toIso(row["expires_at"]),
    consolidatedAt: row["consolidated_at"] ? toIso(row["consolidated_at"]) : null,
    consolidationJobId: row["consolidation_job_id"] ?? null
  };
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function parseMs(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function cloneEpisode(episode: RecentEpisode): RecentEpisode {
  return {
    ...episode,
    sourceTurnIds: [...episode.sourceTurnIds],
    userStatements: [...episode.userStatements],
    metadata: { ...episode.metadata }
  };
}
