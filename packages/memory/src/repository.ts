import type { Pool, QueryResultRow } from "pg";
import { createPostgresPool } from "@companion/database";
import type {
  CreateEntityInput,
  CreateMemoryInput,
  CreateRelationInput,
  Entity,
  Memory,
  MemoryLayer,
  MemoryMatchReason,
  MemoryRetrievalMode,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchRankComponents,
  MemoryStatus,
  MemorySubtype,
  MemoryType,
  MemoryVectorIndexStatus,
  Relation,
  UpdateMemoryInput
} from "./types.js";
import { parseMemoryRepositoryEnv, type MemoryRepositoryKind } from "./env.js";

export interface MemoryRepository {
  readonly kind: MemoryRepositoryKind;
  getDatabaseClient?(): {
    query(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
    end(): Promise<void>;
  };
  healthCheck(): Promise<{ status: "healthy" | "unavailable"; message?: string }>;
  getRetrievalMode?():
    | "in-memory-keyword"
    | "in-memory-hybrid"
    | "keyword"
    | "postgres-trigram"
    | "postgres-hybrid-keyword"
    | "postgres-hybrid";
  createMemory(input: CreateMemoryInput): Promise<Memory>;
  getMemoryById(id: string): Promise<Memory | null>;
  updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory | null>;
  deleteMemory(id: string): Promise<boolean>;
  listRecentMemories(limit?: number): Promise<Memory[]>;
  searchMemoriesByTextFallback(query: MemorySearchQuery): Promise<Memory[]>;
  searchMemoriesByEmbedding(query: MemorySearchQuery): Promise<Memory[]>;
  updateMemoryAccess(id: string): Promise<void>;
  getVectorIndexStatus?(): Promise<MemoryVectorIndexStatus>;
  close?(): Promise<void>;
  createEntity(input: CreateEntityInput): Promise<Entity>;
  createRelation(input: CreateRelationInput): Promise<Relation>;
}

export class PostgresMemoryRepository implements MemoryRepository {
  readonly kind = "postgres";
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(connectionString: string | Pool) {
    this.ownsPool = typeof connectionString === "string";
    this.pool =
      typeof connectionString === "string"
        ? createPostgresPool(connectionString)
        : connectionString;
  }

  async healthCheck(): Promise<{ status: "healthy" | "unavailable"; message?: string }> {
    try {
      await this.pool.query("select 1");
      return { status: "healthy" };
    } catch (error) {
      return {
        status: "unavailable",
        message: error instanceof Error ? error.message : "PostgreSQL health check failed."
      };
    }
  }

  getRetrievalMode(): "postgres-hybrid-keyword" {
    return "postgres-hybrid-keyword";
  }

  getDatabaseClient(): Pool {
    return this.pool;
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const now = new Date();
    const scope = input.scope ?? inferDefaultScope(input);
    const memoryLayer = input.memoryLayer ?? inferMemoryLayer(input.type, input.subtype ?? null);
    const observedAt = toDateOrDefault(input.observedAt, now);
    const validFrom = toDateOrDefault(input.validFrom, observedAt);
    const result = await this.pool.query(
      `insert into memories (
        type, subtype, scope, scope_id, memory_layer, status, content, summary, embedding,
        embedding_model, embedding_provider, embedding_dimensions, embedded_at,
        importance, emotion_valence, emotion_arousal, source, source_trace_id,
        persona_id, subject_user_id, created_by_user_id, speaker_id, voice_profile_id, session_id,
        metadata, tags,
        observed_at, event_time, valid_from, valid_until, expires_at, superseded_at,
        supersedes, superseded_by, contradicts
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24,
        $25, $26,
        $27, $28, $29, $30, $31, $32, $33, $34, $35
      ) returning *`,
      [
        input.type,
        input.subtype ?? null,
        scope,
        input.scopeId ?? (scope === "project" ? "yuvi-runtime" : null),
        memoryLayer,
        input.status ?? "active",
        input.content,
        input.summary ?? null,
        input.embedding ? vectorLiteral(input.embedding) : null,
        input.embeddingModel ?? null,
        input.embeddingProvider ?? null,
        input.embeddingDimensions ?? input.embedding?.length ?? null,
        toNullableDate(input.embeddedAt),
        input.importance ?? 0.5,
        input.emotionValence ?? 0,
        input.emotionArousal ?? 0,
        input.source,
        input.sourceTraceId ?? null,
        input.personaId ?? metadataString(input.metadata, "personaId") ?? "default-persona",
        input.subjectUserId ?? metadataString(input.metadata, "subjectUserId") ?? "default-user",
        input.createdByUserId ??
          metadataString(input.metadata, "createdByUserId") ??
          input.subjectUserId ??
          "default-user",
        input.speakerId ?? metadataString(input.metadata, "speakerId") ?? null,
        input.voiceProfileId ?? metadataString(input.metadata, "voiceProfileId") ?? null,
        input.sessionId ?? metadataString(input.metadata, "sessionId") ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.tags ?? [],
        observedAt,
        toNullableDate(input.eventTime),
        validFrom,
        toNullableDate(input.validUntil),
        toNullableDate(input.expiresAt),
        toNullableDate(input.supersededAt),
        input.supersedes ?? [],
        input.supersededBy ?? null,
        input.contradicts ?? []
      ]
    );

    return mapMemoryRow(requireOne(result.rows));
  }

  async getMemoryById(id: string): Promise<Memory | null> {
    const result = await this.pool.query("select * from memories where id = $1", [id]);
    const row = result.rows[0];
    return row ? mapMemoryRow(row) : null;
  }

  async updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory | null> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    function set(column: string, value: unknown): void {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }

    if (input.type !== undefined) {
      set("type", input.type);
    }
    if (input.subtype !== undefined) {
      set("subtype", input.subtype);
    }
    if (input.scope !== undefined) {
      set("scope", input.scope);
    }
    if (input.scopeId !== undefined) {
      set("scope_id", input.scopeId);
    }
    if (input.memoryLayer !== undefined) {
      set("memory_layer", input.memoryLayer);
    }
    if (input.status !== undefined) {
      set("status", input.status);
    }
    if (input.content !== undefined) {
      set("content", input.content);
    }
    if (input.summary !== undefined) {
      set("summary", input.summary);
    }
    if (input.embedding !== undefined) {
      set("embedding", input.embedding ? vectorLiteral(input.embedding) : null);
    }
    if (input.embeddingModel !== undefined) {
      set("embedding_model", input.embeddingModel);
    }
    if (input.embeddingProvider !== undefined) {
      set("embedding_provider", input.embeddingProvider);
    }
    if (input.embeddingDimensions !== undefined) {
      set("embedding_dimensions", input.embeddingDimensions);
    }
    if (input.embeddedAt !== undefined) {
      set("embedded_at", toNullableDate(input.embeddedAt));
    }
    if (input.importance !== undefined) {
      set("importance", input.importance);
    }
    if (input.emotionValence !== undefined) {
      set("emotion_valence", input.emotionValence);
    }
    if (input.emotionArousal !== undefined) {
      set("emotion_arousal", input.emotionArousal);
    }
    if (input.personaId !== undefined) {
      set("persona_id", input.personaId);
    }
    if (input.subjectUserId !== undefined) {
      set("subject_user_id", input.subjectUserId);
    }
    if (input.createdByUserId !== undefined) {
      set("created_by_user_id", input.createdByUserId);
    }
    if (input.speakerId !== undefined) {
      set("speaker_id", input.speakerId);
    }
    if (input.voiceProfileId !== undefined) {
      set("voice_profile_id", input.voiceProfileId);
    }
    if (input.sessionId !== undefined) {
      set("session_id", input.sessionId);
    }
    if (input.metadata !== undefined) {
      set("metadata", JSON.stringify(input.metadata));
    }
    if (input.tags !== undefined) {
      set("tags", input.tags);
    }
    if (input.observedAt !== undefined) {
      set("observed_at", toNullableDate(input.observedAt));
    }
    if (input.eventTime !== undefined) {
      set("event_time", toNullableDate(input.eventTime));
    }
    if (input.validFrom !== undefined) {
      set("valid_from", toNullableDate(input.validFrom));
    }
    if (input.validUntil !== undefined) {
      set("valid_until", toNullableDate(input.validUntil));
    }
    if (input.expiresAt !== undefined) {
      set("expires_at", toNullableDate(input.expiresAt));
    }
    if (input.supersededAt !== undefined) {
      set("superseded_at", toNullableDate(input.supersededAt));
    }
    if (input.supersedes !== undefined) {
      set("supersedes", input.supersedes);
    }
    if (input.supersededBy !== undefined) {
      set("superseded_by", input.supersededBy);
    }
    if (input.contradicts !== undefined) {
      set("contradicts", input.contradicts);
    }

    if (assignments.length === 0) {
      return this.getMemoryById(id);
    }

    values.push(id);
    const result = await this.pool.query(
      `update memories
       set ${assignments.join(", ")}, updated_at = now()
       where id = $${values.length}
       returning *`,
      values
    );
    const row = result.rows[0];
    return row ? mapMemoryRow(row) : null;
  }

  async deleteMemory(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from memories where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async listRecentMemories(limit = 20): Promise<Memory[]> {
    const result = await this.pool.query(
      `select * from memories
       where ${activeMemorySql("manual")}
       order by created_at desc
       limit $1`,
      [limit]
    );

    return result.rows.map(mapMemoryRow);
  }

  async getVectorIndexStatus(): Promise<MemoryVectorIndexStatus> {
    try {
      const [indexes, counts] = await Promise.all([
        this.pool.query<{ indexname: string; indexdef: string }>(
          `select indexname, indexdef
           from pg_indexes
           where schemaname = current_schema()
             and tablename = 'memories'
             and indexdef ilike '%embedding%'
           order by indexname`
        ),
        this.pool.query<{
          embedded_count: string;
          missing_embedding_count: string;
          dimensions: number[] | null;
        }>(
          `select
             count(*) filter (where embedding is not null)::text as embedded_count,
             count(*) filter (where embedding is null)::text as missing_embedding_count,
             coalesce(
               array_agg(distinct embedding_dimensions order by embedding_dimensions)
                 filter (where embedding_dimensions is not null),
               '{}'::integer[]
             ) as dimensions
           from memories`
        )
      ]);
      const annIndex = indexes.rows.find(
        (index) => index.indexdef.includes("USING hnsw") || index.indexdef.includes("USING ivfflat")
      );
      const vectorIndexType = annIndex?.indexdef.includes("USING hnsw")
        ? "hnsw"
        : annIndex?.indexdef.includes("USING ivfflat")
          ? "ivfflat"
          : "none";
      const countRow = counts.rows[0];
      const dimensions = countRow?.dimensions?.[0];
      return {
        vectorIndexEnabled: parseBoolean(process.env["MEMORY_VECTOR_INDEX_ENABLED"], true),
        vectorIndexType,
        vectorDistance: "cosine",
        ...(dimensions ? { embeddingDimensions: dimensions } : {}),
        indexCreated: Boolean(annIndex),
        indexAvailable: Boolean(annIndex),
        ...(annIndex
          ? {}
          : { indexFallbackReason: "No HNSW or IVFFLAT embedding index was found." }),
        embeddedCount: Number(countRow?.embedded_count ?? 0),
        missingEmbeddingCount: Number(countRow?.missing_embedding_count ?? 0),
        annAccelerationActive: Boolean(annIndex)
      };
    } catch (error) {
      return {
        vectorIndexEnabled: parseBoolean(process.env["MEMORY_VECTOR_INDEX_ENABLED"], true),
        vectorIndexType: "unavailable",
        vectorDistance: "cosine",
        indexCreated: false,
        indexAvailable: false,
        indexFallbackReason: safeRepositoryError(error),
        embeddedCount: 0,
        missingEmbeddingCount: 0,
        annAccelerationActive: false
      };
    }
  }

  async searchMemoriesByTextFallback(query: MemorySearchQuery): Promise<Memory[]> {
    const text = query.text?.trim() ?? "";
    const likeText = `%${escapeLike(text)}%`;
    const searchDocument = `(
      setweight(to_tsvector('simple', coalesce(content, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(summary, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(type, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(subtype, '')), 'B') ||
      setweight(to_tsvector('simple', coalesce(scope, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(scope_id, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(memory_layer, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(source, '')), 'C') ||
      setweight(to_tsvector('simple', coalesce(source_trace_id, '')), 'C')
    )`;
    const clauses = [
      `(
        $1 = ''
        or content ilike $2 escape '\\'
        or coalesce(summary, '') ilike $2 escape '\\'
        or type ilike $2 escape '\\'
        or coalesce(subtype, '') ilike $2 escape '\\'
        or scope ilike $2 escape '\\'
        or coalesce(scope_id, '') ilike $2 escape '\\'
        or memory_layer ilike $2 escape '\\'
        or source ilike $2 escape '\\'
        or coalesce(source_trace_id, '') ilike $2 escape '\\'
        or exists (
          select 1 from unnest(tags) as tag
          where tag ilike $2 escape '\\'
        )
        or metadata::text ilike $2 escape '\\'
        or similarity(content, $1) > 0.18
        or similarity(coalesce(summary, ''), $1) > 0.18
        or similarity(array_to_string(tags, ' '), $1) > 0.18
        or similarity(coalesce(subtype, ''), $1) > 0.28
        or similarity(coalesce(scope_id, ''), $1) > 0.28
        or similarity(coalesce(source_trace_id, ''), $1) > 0.28
        or ${searchDocument} @@ plainto_tsquery('simple', $1)
      )`
    ];
    const values: unknown[] = [text, likeText];

    if (query.types?.length) {
      values.push(query.types);
      clauses.push(`type = any($${values.length}::text[])`);
    }

    if (query.subtypes?.length) {
      values.push(query.subtypes);
      clauses.push(`subtype = any($${values.length}::text[])`);
    }

    if (query.memoryLayers?.length) {
      values.push(query.memoryLayers);
      clauses.push(`memory_layer = any($${values.length}::text[])`);
    }

    if (query.statuses?.length) {
      values.push(query.statuses);
      clauses.push(`status = any($${values.length}::text[])`);
    }

    if (query.sources?.length) {
      values.push(query.sources);
      clauses.push(`source = any($${values.length}::text[])`);
    }
    addIdentityClauses(query, clauses, values);

    if (query.minImportance !== undefined) {
      values.push(query.minImportance);
      clauses.push(`importance >= $${values.length}`);
    }

    if (query.scopes?.length) {
      values.push(query.scopes);
      clauses.push(`scope = any($${values.length}::text[])`);
    } else if (query.scope) {
      values.push(query.scope);
      clauses.push(`scope = $${values.length}`);
    }

    if (query.scopeId) {
      values.push(query.scopeId);
      clauses.push(`scope_id = $${values.length}`);
    }

    clauses.push(activeMemorySql(visibilityModeForQuery(query)));

    if (query.tags?.length) {
      values.push(query.tags);
      clauses.push(`tags && $${values.length}::text[]`);
    }

    values.push(query.limit ?? 10);

    const result = await this.pool.query(
      `select *
       from (
         select memories.*,
           case
             when $1 = '' then 0
             else
               case when lower(content) = lower($1) then 12 else 0 end +
               case when lower(coalesce(summary, '')) = lower($1) then 11 else 0 end +
               case when content ilike $2 escape '\\' then 8 else 0 end +
               case when coalesce(summary, '') ilike $2 escape '\\' then 7 else 0 end +
               case when exists (
                 select 1 from unnest(tags) as tag
                 where lower(tag) = lower($1)
               ) then 10 else 0 end +
               case when exists (
                 select 1 from unnest(tags) as tag
                 where tag ilike $2 escape '\\'
               ) then 7 else 0 end +
               case when type ilike $2 escape '\\' then 5 else 0 end +
               case when coalesce(subtype, '') ilike $2 escape '\\' then 5.5 else 0 end +
               case when scope ilike $2 escape '\\' then 4 else 0 end +
               case when coalesce(scope_id, '') ilike $2 escape '\\' then 4 else 0 end +
               case when memory_layer ilike $2 escape '\\' then 3.5 else 0 end +
               case when source ilike $2 escape '\\' then 3 else 0 end +
               case when coalesce(source_trace_id, '') ilike $2 escape '\\' then 3 else 0 end +
               case when metadata::text ilike $2 escape '\\' then 2 else 0 end
           end as keyword_score,
           case
             when $1 = '' then 0
             else case when exists (
               select 1 from unnest(tags) as tag
               where lower(tag) = lower($1)
             ) then 10 else 0 end +
             case when exists (
               select 1 from unnest(tags) as tag
               where tag ilike $2 escape '\\'
             ) then 7 else 0 end +
             similarity(array_to_string(tags, ' '), $1) * 4
           end as tag_score,
           case
             when $1 = '' then 0
             else greatest(
               similarity(content, $1),
               similarity(coalesce(summary, ''), $1),
               similarity(array_to_string(tags, ' '), $1),
               similarity(coalesce(subtype, ''), $1),
               similarity(coalesce(scope_id, ''), $1),
               similarity(coalesce(source_trace_id, ''), $1)
             ) * 6
           end as trigram_score,
           case
             when $1 = '' then 0
             else ts_rank_cd(${searchDocument}, plainto_tsquery('simple', $1)) * 8
           end as full_text_score,
           case
             when scope = 'user' then 1.2
             when scope = 'project' and coalesce(scope_id, '') = 'yuvi-runtime' then 1.4
             when scope = 'session' then 1.1
             else 0.4
           end as scope_score,
           importance * 2 as importance_score,
	           greatest(
	             0,
	             1 - extract(epoch from (now() - created_at)) / (86400 * 30)
	           ) * 0.5 as recency_score,
	           case
	             when $1 = '' then 'keyword'
	             when exists (
	               select 1 from unnest(tags) as tag
	               where tag ilike $2 escape '\\'
	             ) then 'tag'
	             when content ilike $2 escape '\\' or similarity(content, $1) > 0.18 then 'content'
	             when coalesce(summary, '') ilike $2 escape '\\'
	               or similarity(coalesce(summary, ''), $1) > 0.18 then 'summary'
	             when type ilike $2 escape '\\' then 'type'
	             when coalesce(subtype, '') ilike $2 escape '\\'
	               or similarity(coalesce(subtype, ''), $1) > 0.28 then 'subtype'
	             when scope ilike $2 escape '\\'
	               or coalesce(scope_id, '') ilike $2 escape '\\'
	               or memory_layer ilike $2 escape '\\' then 'scope'
	             when source ilike $2 escape '\\'
	               or coalesce(source_trace_id, '') ilike $2 escape '\\' then 'source'
	             when metadata::text ilike $2 escape '\\' then 'metadata'
	             else 'keyword'
	           end as search_matched_by
	         from memories
         where ${clauses.join(" and ")}
       ) ranked_memories
       order by
         (keyword_score + tag_score + trigram_score + full_text_score + scope_score + importance_score + recency_score) desc,
         importance desc,
         last_accessed_at desc,
         created_at desc
       limit $${values.length}`,
      values
    );

    return result.rows.map(mapMemoryRow);
  }

  async searchMemoriesByEmbedding(query: MemorySearchQuery): Promise<Memory[]> {
    if (!query.embedding?.length) {
      return this.searchMemoriesByTextFallback(query);
    }
    await this.applyVectorSearchTuning();

    const clauses = [
      `embedding is not null`,
      `vector_dims(embedding) = $2`,
      activeMemorySql(visibilityModeForQuery(query))
    ];
    const values: unknown[] = [vectorLiteral(query.embedding), query.embedding.length];

    if (query.types?.length) {
      values.push(query.types);
      clauses.push(`type = any($${values.length}::text[])`);
    }
    if (query.subtypes?.length) {
      values.push(query.subtypes);
      clauses.push(`subtype = any($${values.length}::text[])`);
    }
    if (query.memoryLayers?.length) {
      values.push(query.memoryLayers);
      clauses.push(`memory_layer = any($${values.length}::text[])`);
    }
    if (query.statuses?.length) {
      values.push(query.statuses);
      clauses.push(`status = any($${values.length}::text[])`);
    }
    if (query.sources?.length) {
      values.push(query.sources);
      clauses.push(`source = any($${values.length}::text[])`);
    }
    addIdentityClauses(query, clauses, values);
    if (query.minImportance !== undefined) {
      values.push(query.minImportance);
      clauses.push(`importance >= $${values.length}`);
    }
    if (query.scopes?.length) {
      values.push(query.scopes);
      clauses.push(`scope = any($${values.length}::text[])`);
    } else if (query.scope) {
      values.push(query.scope);
      clauses.push(`scope = $${values.length}`);
    }
    if (query.scopeId) {
      values.push(query.scopeId);
      clauses.push(`scope_id = $${values.length}`);
    }
    if (query.tags?.length) {
      values.push(query.tags);
      clauses.push(`tags && $${values.length}::text[]`);
    }

    values.push(query.limit ?? 10);
    const result = await this.pool.query(
      `select *
       from (
         select memories.*,
           1 - least(embedding <=> $1::vector, 1) as vector_score,
           (1 - least(embedding <=> $1::vector, 1)) * 10 as hybrid_score,
           case
             when scope = 'user' then 1.2
             when scope = 'project' and coalesce(scope_id, '') = 'yuvi-runtime' then 1.4
             when scope = 'session' then 1.1
             else 0.4
           end as scope_score,
           importance * 2 as importance_score,
           greatest(
             0,
             1 - extract(epoch from (now() - created_at)) / (86400 * 30)
           ) * 0.5 as recency_score,
           'vector' as search_matched_by
         from memories
         where ${clauses.join(" and ")}
       ) ranked_memories
       order by
         (hybrid_score + scope_score + importance_score + recency_score) desc,
         importance desc,
         last_accessed_at desc,
         created_at desc
       limit $${values.length}`,
      values
    );

    return result.rows.map(mapMemoryRow);
  }

  private async applyVectorSearchTuning(): Promise<void> {
    const vectorIndexEnabled = parseBoolean(process.env["MEMORY_VECTOR_INDEX_ENABLED"], true);
    if (!vectorIndexEnabled) {
      return;
    }

    const indexType = parseVectorIndexType(process.env["MEMORY_VECTOR_INDEX_TYPE"]);
    try {
      if (indexType === "hnsw") {
        const efSearch = parsePositiveInteger(process.env["MEMORY_VECTOR_HNSW_EF_SEARCH"]);
        if (efSearch !== null) {
          await this.pool.query(`set hnsw.ef_search = ${efSearch}`);
        }
      }
      if (indexType === "ivfflat") {
        const probes = parsePositiveInteger(process.env["MEMORY_VECTOR_IVFFLAT_PROBES"]);
        if (probes !== null) {
          await this.pool.query(`set ivfflat.probes = ${probes}`);
        }
      }
    } catch {
      // ANN tuning is an optimization only; retrieval semantics must not depend on it.
    }
  }

  async updateMemoryAccess(id: string): Promise<void> {
    await this.pool.query(
      `update memories
       set last_accessed_at = now(), updated_at = now()
       where id = $1`,
      [id]
    );
  }

  async createEntity(input: CreateEntityInput): Promise<Entity> {
    const result = await this.pool.query(
      `insert into entities (name, type)
       values ($1, $2)
       returning *`,
      [input.name, input.type]
    );

    return mapEntityRow(requireOne(result.rows));
  }

  async createRelation(input: CreateRelationInput): Promise<Relation> {
    const result = await this.pool.query(
      `insert into relations (source_entity, target_entity, relation, weight)
       values ($1, $2, $3, $4)
       returning *`,
      [input.sourceEntity, input.targetEntity, input.relation, input.weight ?? 1]
    );

    return mapRelationRow(requireOne(result.rows));
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

export class InMemoryMemoryRepository implements MemoryRepository {
  readonly kind = "in-memory";
  private readonly memories: Memory[] = [];
  private readonly entities: Entity[] = [];
  private readonly relations: Relation[] = [];

  async healthCheck(): Promise<{ status: "healthy" | "unavailable"; message?: string }> {
    return { status: "healthy", message: "Using in-memory memory repository." };
  }

  getRetrievalMode(): "in-memory-keyword" {
    return "in-memory-keyword";
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const now = new Date();
    const scope = input.scope ?? inferDefaultScope(input);
    const memoryLayer = input.memoryLayer ?? inferMemoryLayer(input.type, input.subtype ?? null);
    const observedAt = toDateOrDefault(input.observedAt, now);
    const memory: Memory = {
      id: crypto.randomUUID(),
      type: input.type,
      subtype: input.subtype ?? null,
      scope,
      scopeId: input.scopeId ?? (scope === "project" ? "yuvi-runtime" : null),
      memoryLayer,
      status: input.status ?? "active",
      content: input.content,
      summary: input.summary ?? null,
      embedding: input.embedding ?? null,
      embeddingModel: input.embeddingModel ?? null,
      embeddingProvider: input.embeddingProvider ?? null,
      embeddingDimensions: input.embeddingDimensions ?? input.embedding?.length ?? null,
      embeddedAt: toNullableDate(input.embeddedAt),
      importance: input.importance ?? 0.5,
      emotionValence: input.emotionValence ?? 0,
      emotionArousal: input.emotionArousal ?? 0,
      source: input.source,
      sourceTraceId: input.sourceTraceId ?? null,
      personaId:
        input.personaId ?? metadataString(input.metadata, "personaId") ?? "default-persona",
      subjectUserId:
        input.subjectUserId ?? metadataString(input.metadata, "subjectUserId") ?? "default-user",
      createdByUserId:
        input.createdByUserId ??
        metadataString(input.metadata, "createdByUserId") ??
        input.subjectUserId ??
        "default-user",
      speakerId: input.speakerId ?? metadataString(input.metadata, "speakerId") ?? null,
      voiceProfileId:
        input.voiceProfileId ?? metadataString(input.metadata, "voiceProfileId") ?? null,
      sessionId: input.sessionId ?? metadataString(input.metadata, "sessionId") ?? null,
      metadata: input.metadata ?? {},
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      observedAt,
      eventTime: toNullableDate(input.eventTime),
      validFrom: toDateOrDefault(input.validFrom, observedAt),
      validUntil: toNullableDate(input.validUntil),
      expiresAt: toNullableDate(input.expiresAt),
      lastAccessedAt: now,
      supersededAt: toNullableDate(input.supersededAt),
      supersedes: input.supersedes ?? [],
      supersededBy: input.supersededBy ?? null,
      contradicts: input.contradicts ?? []
    };
    this.memories.push(memory);
    return memory;
  }

  async getMemoryById(id: string): Promise<Memory | null> {
    return this.memories.find((memory) => memory.id === id) ?? null;
  }

  async updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory | null> {
    const memory = this.memories.find((candidate) => candidate.id === id);
    if (!memory) {
      return null;
    }

    if (input.type !== undefined) {
      memory.type = input.type;
    }
    if (input.subtype !== undefined) {
      memory.subtype = input.subtype as MemorySubtype | null;
    }
    if (input.scope !== undefined) {
      memory.scope = input.scope;
    }
    if (input.scopeId !== undefined) {
      memory.scopeId = input.scopeId;
    }
    if (input.memoryLayer !== undefined) {
      memory.memoryLayer = input.memoryLayer;
    }
    if (input.status !== undefined) {
      memory.status = input.status;
    }
    if (input.content !== undefined) {
      memory.content = input.content;
    }
    if (input.summary !== undefined) {
      memory.summary = input.summary;
    }
    if (input.embedding !== undefined) {
      memory.embedding = input.embedding;
    }
    if (input.embeddingModel !== undefined) {
      memory.embeddingModel = input.embeddingModel;
    }
    if (input.embeddingProvider !== undefined) {
      memory.embeddingProvider = input.embeddingProvider;
    }
    if (input.embeddingDimensions !== undefined) {
      memory.embeddingDimensions = input.embeddingDimensions;
    }
    if (input.embeddedAt !== undefined) {
      memory.embeddedAt = toNullableDate(input.embeddedAt);
    }
    if (input.importance !== undefined) {
      memory.importance = input.importance;
    }
    if (input.emotionValence !== undefined) {
      memory.emotionValence = input.emotionValence;
    }
    if (input.emotionArousal !== undefined) {
      memory.emotionArousal = input.emotionArousal;
    }
    if (input.personaId !== undefined) {
      memory.personaId = input.personaId;
    }
    if (input.subjectUserId !== undefined) {
      memory.subjectUserId = input.subjectUserId;
    }
    if (input.createdByUserId !== undefined) {
      memory.createdByUserId = input.createdByUserId;
    }
    if (input.speakerId !== undefined) {
      memory.speakerId = input.speakerId;
    }
    if (input.voiceProfileId !== undefined) {
      memory.voiceProfileId = input.voiceProfileId;
    }
    if (input.sessionId !== undefined) {
      memory.sessionId = input.sessionId;
    }
    if (input.metadata !== undefined) {
      memory.metadata = input.metadata;
    }
    if (input.tags !== undefined) {
      memory.tags = input.tags;
    }
    if (input.observedAt !== undefined) {
      memory.observedAt = toDateOrDefault(input.observedAt, memory.observedAt);
    }
    if (input.eventTime !== undefined) {
      memory.eventTime = toNullableDate(input.eventTime);
    }
    if (input.validFrom !== undefined) {
      memory.validFrom = toDateOrDefault(input.validFrom, memory.validFrom);
    }
    if (input.validUntil !== undefined) {
      memory.validUntil = toNullableDate(input.validUntil);
    }
    if (input.expiresAt !== undefined) {
      memory.expiresAt = toNullableDate(input.expiresAt);
    }
    if (input.supersededAt !== undefined) {
      memory.supersededAt = toNullableDate(input.supersededAt);
    }
    if (input.supersedes !== undefined) {
      memory.supersedes = input.supersedes;
    }
    if (input.supersededBy !== undefined) {
      memory.supersededBy = input.supersededBy;
    }
    if (input.contradicts !== undefined) {
      memory.contradicts = input.contradicts;
    }
    memory.updatedAt = new Date();
    return memory;
  }

  async deleteMemory(id: string): Promise<boolean> {
    const index = this.memories.findIndex((memory) => memory.id === id);
    if (index === -1) {
      return false;
    }
    this.memories.splice(index, 1);
    return true;
  }

  async listRecentMemories(limit = 20): Promise<Memory[]> {
    return [...this.memories]
      .filter((memory) => isMemoryVisible(memory, "manual"))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit);
  }

  async searchMemoriesByTextFallback(query: MemorySearchQuery): Promise<Memory[]> {
    const searchText = (query.text ?? "").toLowerCase();
    return this.memories
      .filter((memory) => isMemoryVisible(memory, visibilityModeForQuery(query)))
      .filter((memory) => !query.types?.length || query.types.includes(memory.type))
      .filter(
        (memory) =>
          !query.subtypes?.length ||
          (memory.subtype !== null && query.subtypes.includes(memory.subtype))
      )
      .filter(
        (memory) => !query.memoryLayers?.length || query.memoryLayers.includes(memory.memoryLayer)
      )
      .filter((memory) => !query.statuses?.length || query.statuses.includes(memory.status))
      .filter((memory) => !query.sources?.length || query.sources.includes(memory.source))
      .filter((memory) => matchesIdentityQuery(memory, query))
      .filter(
        (memory) => query.minImportance === undefined || memory.importance >= query.minImportance
      )
      .filter((memory) =>
        query.scopes?.length
          ? query.scopes.includes(memory.scope)
          : !query.scope || memory.scope === query.scope
      )
      .filter((memory) => !query.scopeId || memory.scopeId === query.scopeId)
      .filter(
        (memory) => !query.tags?.length || query.tags.some((tag) => memory.tags.includes(tag))
      )
      .filter(
        (memory) =>
          !searchText ||
          memory.content.toLowerCase().includes(searchText) ||
          memory.summary?.toLowerCase().includes(searchText) ||
          memory.type.toLowerCase().includes(searchText) ||
          memory.scope.toLowerCase().includes(searchText) ||
          memory.scopeId?.toLowerCase().includes(searchText) ||
          memory.memoryLayer.toLowerCase().includes(searchText) ||
          memory.source.toLowerCase().includes(searchText) ||
          memory.sourceTraceId?.toLowerCase().includes(searchText) ||
          memory.subtype?.toLowerCase().includes(searchText) ||
          memory.tags.some((tag) => tag.toLowerCase().includes(searchText)) ||
          JSON.stringify(memory.metadata).toLowerCase().includes(searchText)
      )
      .sort((left, right) => right.importance - left.importance)
      .slice(0, query.limit ?? 10);
  }

  async searchMemoriesByEmbedding(query: MemorySearchQuery): Promise<Memory[]> {
    if (!query.embedding?.length) {
      return this.searchMemoriesByTextFallback(query);
    }
    return this.memories
      .filter((memory) => memory.embedding?.length === query.embedding?.length)
      .filter((memory) => isMemoryVisible(memory, visibilityModeForQuery(query)))
      .filter((memory) => !query.types?.length || query.types.includes(memory.type))
      .filter(
        (memory) =>
          !query.subtypes?.length ||
          (memory.subtype !== null && query.subtypes.includes(memory.subtype))
      )
      .filter(
        (memory) => !query.memoryLayers?.length || query.memoryLayers.includes(memory.memoryLayer)
      )
      .filter((memory) => !query.statuses?.length || query.statuses.includes(memory.status))
      .filter((memory) => !query.sources?.length || query.sources.includes(memory.source))
      .filter((memory) => matchesIdentityQuery(memory, query))
      .filter(
        (memory) => query.minImportance === undefined || memory.importance >= query.minImportance
      )
      .filter((memory) =>
        query.scopes?.length
          ? query.scopes.includes(memory.scope)
          : !query.scope || memory.scope === query.scope
      )
      .filter((memory) => !query.scopeId || memory.scopeId === query.scopeId)
      .filter(
        (memory) => !query.tags?.length || query.tags.some((tag) => memory.tags.includes(tag))
      )
      .map((memory) => {
        const vectorScore = cosineSimilarity(memory.embedding ?? [], query.embedding ?? []);
        return {
          ...memory,
          searchScore: vectorScore * 10,
          searchMatchedBy: "vector" as const,
          searchRetrievalMode: "in-memory-hybrid" as const,
          searchRankComponents: {
            vectorScore,
            hybridScore: vectorScore * 10,
            importanceScore: memory.importance * 2
          }
        };
      })
      .sort((left, right) => (right.searchScore ?? 0) - (left.searchScore ?? 0))
      .slice(0, query.limit ?? 10);
  }

  async updateMemoryAccess(id: string): Promise<void> {
    const memory = this.memories.find((candidate) => candidate.id === id);
    if (memory) {
      memory.lastAccessedAt = new Date();
      memory.updatedAt = new Date();
    }
  }

  async getVectorIndexStatus(): Promise<MemoryVectorIndexStatus> {
    const embeddedCount = this.memories.filter((memory) => memory.embedding?.length).length;
    return {
      vectorIndexEnabled: false,
      vectorIndexType: "none",
      vectorDistance: "cosine",
      indexCreated: false,
      indexAvailable: false,
      indexFallbackReason: "ANN indexes are only available for PostgreSQL memory repositories.",
      embeddedCount,
      missingEmbeddingCount: this.memories.length - embeddedCount,
      annAccelerationActive: false
    };
  }

  async createEntity(input: CreateEntityInput): Promise<Entity> {
    const entity: Entity = {
      id: crypto.randomUUID(),
      name: input.name,
      type: input.type,
      createdAt: new Date()
    };
    this.entities.push(entity);
    return entity;
  }

  async createRelation(input: CreateRelationInput): Promise<Relation> {
    const relation: Relation = {
      id: crypto.randomUUID(),
      sourceEntity: input.sourceEntity,
      targetEntity: input.targetEntity,
      relation: input.relation,
      weight: input.weight ?? 1,
      createdAt: new Date()
    };
    this.relations.push(relation);
    return relation;
  }
}

export function createMemoryRepositoryFromEnv(
  env: Record<string, string | undefined> = process.env,
  sharedPool?: Pool
): MemoryRepository {
  const repositoryMode = parseMemoryRepositoryEnv(env);
  const databaseUrl = env["DATABASE_URL"];

  if (repositoryMode.kind === "postgres") {
    if (!databaseUrl) {
      throw new Error("MEMORY_REPOSITORY=postgres requires DATABASE_URL.");
    }

    return new PostgresMemoryRepository(sharedPool ?? databaseUrl);
  }

  return new InMemoryMemoryRepository();
}

function mapMemoryRow(row: QueryResultRow): Memory {
  return {
    id: row["id"],
    type: row["type"] as MemoryType,
    subtype: row["subtype"] ?? null,
    scope: (row["scope"] ?? "user") as MemoryScope,
    scopeId: row["scope_id"] ?? null,
    memoryLayer: (row["memory_layer"] ??
      inferMemoryLayer(row["type"] as MemoryType, row["subtype"] ?? null)) as MemoryLayer,
    status: (row["status"] ?? "active") as MemoryStatus,
    content: row["content"],
    summary: row["summary"],
    embedding: parseVector(row["embedding"]),
    embeddingModel: row["embedding_model"] ?? null,
    embeddingProvider: row["embedding_provider"] ?? null,
    embeddingDimensions: row["embedding_dimensions"] ? Number(row["embedding_dimensions"]) : null,
    embeddedAt: row["embedded_at"] ?? null,
    importance: Number(row["importance"]),
    emotionValence: Number(row["emotion_valence"]),
    emotionArousal: Number(row["emotion_arousal"]),
    source: row["source"],
    sourceTraceId: row["source_trace_id"] ?? null,
    personaId:
      row["persona_id"] ??
      metadataString(parseMetadata(row["metadata"]), "personaId") ??
      "default-persona",
    subjectUserId:
      row["subject_user_id"] ??
      metadataString(parseMetadata(row["metadata"]), "subjectUserId") ??
      "default-user",
    createdByUserId:
      row["created_by_user_id"] ??
      metadataString(parseMetadata(row["metadata"]), "createdByUserId") ??
      row["subject_user_id"] ??
      "default-user",
    speakerId:
      row["speaker_id"] ?? metadataString(parseMetadata(row["metadata"]), "speakerId") ?? null,
    voiceProfileId:
      row["voice_profile_id"] ??
      metadataString(parseMetadata(row["metadata"]), "voiceProfileId") ??
      null,
    sessionId:
      row["session_id"] ?? metadataString(parseMetadata(row["metadata"]), "sessionId") ?? null,
    metadata: parseMetadata(row["metadata"]),
    tags: row["tags"] ?? [],
    createdAt: row["created_at"],
    updatedAt: row["updated_at"],
    observedAt: row["observed_at"] ?? row["created_at"],
    eventTime: row["event_time"] ?? null,
    validFrom: row["valid_from"] ?? row["observed_at"] ?? row["created_at"],
    validUntil: row["valid_until"] ?? null,
    expiresAt: row["expires_at"] ?? null,
    lastAccessedAt: row["last_accessed_at"],
    supersededAt: row["superseded_at"] ?? null,
    supersedes: row["supersedes"] ?? [],
    supersededBy: row["superseded_by"] ?? null,
    contradicts: row["contradicts"] ?? [],
    ...searchMetadataFromRow(row)
  };
}

function searchMetadataFromRow(row: QueryResultRow): {
  searchScore?: number;
  searchMatchedBy?: MemoryMatchReason;
  searchRetrievalMode?: MemoryRetrievalMode;
  searchRankComponents?: MemorySearchRankComponents;
} {
  const rankComponents = rankComponentsFromRow(row);
  const score = Object.values(rankComponents).reduce((sum, value) => sum + (value ?? 0), 0);
  if (score <= 0 && Object.keys(rankComponents).length === 0) {
    return {};
  }

  return {
    searchScore: score,
    searchMatchedBy: matchReasonFromRow(row, rankComponents),
    searchRetrievalMode: retrievalModeFromRank(rankComponents),
    searchRankComponents: rankComponents
  };
}

function rankComponentsFromRow(row: QueryResultRow): MemorySearchRankComponents {
  const output: MemorySearchRankComponents = {};
  setFiniteNumber(output, "keywordScore", row["keyword_score"]);
  setFiniteNumber(output, "tagScore", row["tag_score"]);
  setFiniteNumber(output, "trigramScore", row["trigram_score"]);
  setFiniteNumber(output, "fullTextScore", row["full_text_score"]);
  setFiniteNumber(output, "vectorScore", row["vector_score"]);
  setFiniteNumber(output, "hybridScore", row["hybrid_score"]);
  setFiniteNumber(output, "scopeScore", row["scope_score"]);
  setFiniteNumber(output, "importanceScore", row["importance_score"]);
  setFiniteNumber(output, "recencyScore", row["recency_score"]);
  return output;
}

function setFiniteNumber(
  output: MemorySearchRankComponents,
  key: keyof MemorySearchRankComponents,
  value: unknown
): void {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    output[key] = numeric;
  }
}

function retrievalModeFromRank(rank: MemorySearchRankComponents): MemoryRetrievalMode {
  if (
    (rank.hybridScore ?? 0) > 0 &&
    ((rank.keywordScore ?? 0) > 0 || (rank.trigramScore ?? 0) > 0 || (rank.fullTextScore ?? 0) > 0)
  ) {
    return "postgres-hybrid";
  }
  if ((rank.hybridScore ?? 0) > 0 || (rank.vectorScore ?? 0) > 0) {
    return "postgres-vector";
  }
  if ((rank.fullTextScore ?? 0) > 0 && (rank.trigramScore ?? 0) > 0) {
    return "postgres-hybrid-keyword";
  }
  if ((rank.fullTextScore ?? 0) > 0) {
    return "postgres-full-text";
  }
  if ((rank.trigramScore ?? 0) > 0) {
    return "postgres-trigram";
  }
  return "postgres-hybrid-keyword";
}

function matchReasonFromRow(
  row: QueryResultRow,
  rank: MemorySearchRankComponents
): MemoryMatchReason {
  const reason = row["search_matched_by"];
  if (isMemoryMatchReason(reason)) {
    return reason;
  }
  if ((rank.tagScore ?? 0) >= Math.max(rank.keywordScore ?? 0, rank.trigramScore ?? 0)) {
    return "tag";
  }
  if (row["subtype"] && (rank.keywordScore ?? 0) > 0) {
    return "subtype";
  }
  if ((rank.scopeScore ?? 0) > 1.3 && (rank.keywordScore ?? 0) > 0) {
    return "scope";
  }
  if ((rank.fullTextScore ?? 0) > 0) {
    return "content";
  }
  if ((rank.trigramScore ?? 0) > 0) {
    return "content";
  }
  return "keyword";
}

function isMemoryMatchReason(value: unknown): value is MemoryMatchReason {
  return (
    value === "content" ||
    value === "vector" ||
    value === "summary" ||
    value === "tag" ||
    value === "type" ||
    value === "subtype" ||
    value === "scope" ||
    value === "metadata" ||
    value === "source" ||
    value === "keyword" ||
    value === "fallback"
  );
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function mapEntityRow(row: QueryResultRow): Entity {
  return {
    id: row["id"],
    name: row["name"],
    type: row["type"],
    createdAt: row["created_at"]
  };
}

function mapRelationRow(row: QueryResultRow): Relation {
  return {
    id: row["id"],
    sourceEntity: row["source_entity"],
    targetEntity: row["target_entity"],
    relation: row["relation"],
    weight: Number(row["weight"]),
    createdAt: row["created_at"]
  };
}

function requireOne<TRow>(rows: TRow[]): TRow {
  const row = rows[0];
  if (!row) {
    throw new Error("Expected database query to return one row.");
  }

  return row;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function parseVector(value: unknown): number[] | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(Number);
  }

  if (typeof value === "string") {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .filter(Boolean)
      .map(Number);
  }

  return null;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return Math.max(0, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function addIdentityClauses(query: MemorySearchQuery, clauses: string[], values: unknown[]): void {
  if (query.personaId) {
    values.push(query.personaId);
    clauses.push(`persona_id = $${values.length}`);
  }
  if (query.subjectUserId || query.userId) {
    values.push(query.subjectUserId ?? query.userId);
    clauses.push(`subject_user_id = $${values.length}`);
  }
  if (query.createdByUserId) {
    values.push(query.createdByUserId);
    clauses.push(`created_by_user_id = $${values.length}`);
  }
  if (query.speakerId) {
    values.push(query.speakerId);
    clauses.push(`speaker_id = $${values.length}`);
  }
  if (query.voiceProfileId) {
    values.push(query.voiceProfileId);
    clauses.push(`voice_profile_id = $${values.length}`);
  }
  if (query.sessionId) {
    values.push(query.sessionId);
    clauses.push(`(session_id = $${values.length} or (session_id is null and scope = 'session'))`);
  }
}

function matchesIdentityQuery(memory: Memory, query: MemorySearchQuery): boolean {
  if (query.personaId && memory.personaId !== query.personaId) return false;
  const subjectUserId = query.subjectUserId ?? query.userId;
  if (subjectUserId && memory.subjectUserId !== subjectUserId) return false;
  if (query.createdByUserId && memory.createdByUserId !== query.createdByUserId) return false;
  if (query.speakerId && memory.speakerId !== query.speakerId) return false;
  if (query.voiceProfileId && memory.voiceProfileId !== query.voiceProfileId) return false;
  if (query.sessionId && memory.sessionId && memory.sessionId !== query.sessionId) return false;
  return true;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function safeRepositoryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(DATABASE_URL|API_KEY|TOKEN|SECRET|PASSWORD)=([^\s]+)/giu, "$1=[REDACTED]")
    .slice(0, 240);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseVectorIndexType(value: string | undefined): "hnsw" | "ivfflat" | "none" {
  if (value === "ivfflat" || value === "none") {
    return value;
  }
  return "hnsw";
}

type VisibilityMode = "prompt" | "manual" | "history";

function visibilityModeForQuery(query: MemorySearchQuery): VisibilityMode {
  if (
    query.includeHistory ||
    query.includeHistoricalEpisodic ||
    query.includeExpired ||
    query.includeSuperseded ||
    query.statuses?.some((status) => status === "forgotten" || status === "expired")
  ) {
    return "history";
  }
  if (query.includeArchived || query.statuses?.includes("archived")) {
    return "manual";
  }
  return "prompt";
}

function activeMemorySql(mode: VisibilityMode): string {
  const activeWindow = `(expires_at is null or expires_at > now())
    and (valid_from is null or valid_from <= now())
    and (valid_until is null or valid_until > now())`;
  if (mode === "history") {
    return "true";
  }
  if (mode === "manual") {
    return `status in ('active', 'archived') and ${activeWindow}`;
  }
  return `status = 'active' and ${activeWindow}`;
}

function isMemoryVisible(memory: Memory, mode: VisibilityMode): boolean {
  const now = Date.now();
  if (mode === "history") {
    return true;
  }
  if (memory.expiresAt && memory.expiresAt.getTime() <= now) {
    return false;
  }
  if (memory.validUntil && memory.validUntil.getTime() <= now) {
    return false;
  }
  if (memory.validFrom && memory.validFrom.getTime() > now) {
    return false;
  }
  if (mode === "manual") {
    return memory.status === "active" || memory.status === "archived";
  }
  return memory.status === "active";
}

function inferDefaultScope(
  input: Pick<CreateMemoryInput, "type" | "subtype" | "content" | "summary" | "tags">
): MemoryScope {
  if (input.type === "working") {
    return "session";
  }
  const haystack =
    `${input.content} ${input.summary ?? ""} ${(input.tags ?? []).join(" ")}`.toLowerCase();
  if (haystack.includes("yuvi") || haystack.includes("runtime")) {
    return "project";
  }
  return "user";
}

function inferMemoryLayer(type: MemoryType, subtype: MemorySubtype | null): MemoryLayer {
  if (type === "working") {
    return "working";
  }
  if (
    type === "semantic" ||
    subtype === "preference" ||
    subtype === "project" ||
    subtype === "provider-choice"
  ) {
    return "core";
  }
  if (type === "episodic" || subtype === "milestone" || subtype === "troubleshooting") {
    return "recall";
  }
  return "recall";
}

function toNullableDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function toDateOrDefault(value: Date | string | null | undefined, fallback: Date): Date {
  return toNullableDate(value) ?? fallback;
}
