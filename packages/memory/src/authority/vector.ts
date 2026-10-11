import { randomUUID } from "node:crypto";
import type { MemoryEvent } from "../provider.js";
import type { MemoryEmbeddingProvider } from "../service.js";
import { PostgresMemoryAuthority } from "./store.js";
import { MemoryAuthorityError } from "./types.js";

export function embeddingModelTag(provider: MemoryEmbeddingProvider) {
  return `${provider.name}:${provider.model ?? "unknown"}:${provider.dimensions}`;
}
/** Derived index with transactional outbox, lease fencing and recoverable retries.
 * Supported schema currently 512 dimensions. Other providers must not be silently mixed.
 */
export class MemoryVectorIndexer {
  readonly modelTag: string;
  private lastScanAt: string | null = null;
  private scanFailureCount = 0;
  private lastErrorCode: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<void> | undefined;
  constructor(
    private readonly authority: PostgresMemoryAuthority,
    private readonly provider: MemoryEmbeddingProvider,
    private readonly withSource?: <T>(event: MemoryEvent, call: () => Promise<T>) => Promise<T>,
    private readonly owner?: { characterId: string; journalNamespace: string }
  ) {
    if (provider.dimensions !== 512 || provider.mock)
      throw new MemoryAuthorityError("MEMORY_VECTOR_PROVIDER_UNSUPPORTED");
    this.modelTag = embeddingModelTag(provider);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, 1000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.work;
  }
  runOnce(): Promise<void> {
    if (this.work) return this.work;
    this.lastScanAt = new Date().toISOString();
    this.work = this.processBatch()
      .then(() => {
        this.lastErrorCode = null;
      })
      .catch((error) => {
        this.scanFailureCount++;
        this.lastErrorCode = "MEMORY_VECTOR_WORKER_UNAVAILABLE";
        throw error;
      })
      .finally(() => {
        this.work = undefined;
      });
    return this.work;
  }
  getDiagnostics() {
    return {
      modelTag: this.modelTag,
      lastScanAt: this.lastScanAt,
      lastErrorCode: this.lastErrorCode,
      scanFailureCount: this.scanFailureCount,
      running: Boolean(this.work),
      owner: this.owner ?? null
    };
  }
  private async processBatch() {
    for (let n = 0; n < 10; n++) {
      const owner = randomUUID();
      const row = await this.authority.transaction(async (tx) => {
        await tx.query(
          `update memory_authority_index_jobs set status='terminal_failed',error_code='MEMORY_VECTOR_RETRY_EXHAUSTED',lease_owner=null,lease_until=null where model_tag=$1 and status='processing' and ($2::text is null or split_part(scope,':character:',2)=$2)  and attempts>=8 and lease_until<=now()`,
          [this.modelTag, this.owner ? encodeURIComponent(this.owner.characterId) : null]
        );
        const claimed = await tx.query(
          `with due as (select scope,id,model_tag from memory_authority_index_jobs where model_tag=$1 and attempts<8 and
          ((status in ('pending','retryable_failed') and (next_attempt_at is null or next_attempt_at<=now())) or (status='processing' and lease_until<=now()))
          and ($3::text is null or split_part(scope,':character:',2)=$3) and ($4::text is null or exists(select 1 from memory_authority_records r where r.scope=memory_authority_index_jobs.scope and r.id=memory_authority_index_jobs.id and r.event->'lineage'->'parents'->0->'ref'->>'namespace'=$4)) order by next_attempt_at nulls first limit 1 for update skip locked)
          update memory_authority_index_jobs j set status='processing',lease_owner=$2,lease_until=now()+interval '60 seconds',attempts=attempts+1
          from due where j.scope=due.scope and j.id=due.id and j.model_tag=due.model_tag returning j.scope,j.id`,
          [
            this.modelTag,
            owner,
            this.owner ? encodeURIComponent(this.owner.characterId) : null,
            this.owner?.journalNamespace ?? null
          ]
        );
        if (!claimed.rows[0]) return null;
        return (
          await tx.query(
            "select r.*,c.state from memory_authority_records r join memory_authority_current c using(scope,id) where r.scope=$1 and r.id=$2",
            [claimed.rows[0]["scope"], claimed.rows[0]["id"]]
          )
        ).rows[0]!;
      });
      if (!row) return;
      const event = row["event"] as MemoryEvent;
      if (!["current", "conflicted"].includes(String(row["state"]))) {
        await this.authority.pool.query(
          `update memory_authority_index_jobs set status='complete',completed_at=now(),error_code='MEMORY_VECTOR_SOURCE_RETIRED',lease_owner=null,lease_until=null where scope=$1 and id=$2 and model_tag=$3 and lease_owner=$4`,
          [event.scope, event.id, this.modelTag, owner]
        );
        continue;
      }
      try {
        const call = () => this.provider.embedText(event.content);
        const vector = await (this.withSource ? this.withSource(event, call) : call());
        if (vector.length !== 512 || !vector.every(Number.isFinite) || vector.every((v) => v === 0))
          throw new MemoryAuthorityError("MEMORY_VECTOR_INVALID");
        await this.authority.transaction(async (tx) => {
          const fenced = await tx.query(
            `select id from memory_authority_index_jobs where scope=$1 and id=$2 and model_tag=$3 and lease_owner=$4 and lease_until>now() for update`,
            [event.scope, event.id, this.modelTag, owner]
          );
          if (!fenced.rows.length) throw new MemoryAuthorityError("MEMORY_VECTOR_LEASE_LOST");
          const state = (
            await tx.query(
              "select state from memory_authority_current where scope=$1 and id=$2 for share",
              [event.scope, event.id]
            )
          ).rows[0]?.["state"];
          if (["current", "conflicted"].includes(String(state)))
            await tx.query(
              `insert into memory_authority_vectors(scope,id,model_tag,authority_version,embedding) values($1,$2,$3,$4,$5::vector)
            on conflict(scope,id,model_tag) do update set embedding=excluded.embedding,authority_version=excluded.authority_version`,
              [event.scope, event.id, this.modelTag, row["version"], JSON.stringify(vector)]
            );
          await tx.query(
            `update memory_authority_index_jobs set status='complete',completed_at=now(),lease_owner=null,lease_until=null,error_code=null where scope=$1 and id=$2 and model_tag=$3 and lease_owner=$4`,
            [event.scope, event.id, this.modelTag, owner]
          );
        });
      } catch (error) {
        await this.authority.pool.query(
          `update memory_authority_index_jobs set status=case when attempts>=8 then 'terminal_failed' else 'retryable_failed' end,error_code=$5,next_attempt_at=now()+interval '30 seconds',lease_owner=null,lease_until=null
          where scope=$1 and id=$2 and model_tag=$3 and lease_owner=$4`,
          [
            event.scope,
            event.id,
            this.modelTag,
            owner,
            error instanceof MemoryAuthorityError ? error.code : "MEMORY_VECTOR_PROVIDER_FAILED"
          ]
        );
      }
    }
  }
  async hasPending(scope: string): Promise<boolean> {
    const result = await this.authority.pool.query(
      `select exists(select 1 from memory_authority_index_jobs j join memory_authority_current c using(scope,id)
       where j.scope=$1 and j.model_tag=$2 and j.status!='complete' and c.state in ('current','conflicted')) as pending`,
      [scope, this.modelTag]
    );
    return result.rows[0]?.["pending"] === true;
  }
  async search(scope: string, text: string, limit = 20): Promise<string[]> {
    const vector = await this.provider.embedText(text);
    if (vector.length !== 512 || !vector.every(Number.isFinite))
      throw new MemoryAuthorityError("MEMORY_VECTOR_INVALID");
    const rows = await this.authority.pool.query(
      `select v.id from memory_authority_vectors v join memory_authority_current c using(scope,id)
      where v.scope=$1 and v.model_tag=$2 and c.state in ('current','conflicted') and v.authority_version=c.version
      order by v.embedding <=> $3::vector limit $4`,
      [scope, this.modelTag, JSON.stringify(vector), limit]
    );
    return rows.rows.map((r) => String(r["id"]));
  }
}
/** Explicit model-change/rebuild entry: bounded keyset batch, idempotent outbox insertion.
 * Only Host maintenance callers supply the embedding space; no model can choose it.
 */
export async function enqueueVectorIndexBatch(
  authority: PostgresMemoryAuthority,
  scope: string,
  modelTag: string,
  after = "0",
  limit = 100
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new MemoryAuthorityError("MEMORY_VECTOR_REINDEX_BOUND");
  const rows = await authority.pool.query(
    `with batch as materialized (select r.id,r.version from memory_authority_records r join memory_authority_current c using(scope,id)
    where r.scope=$1 and r.version>$3::bigint and c.state in ('current','conflicted') order by r.version limit $4),
    inserted as (insert into memory_authority_index_jobs(scope,id,model_tag) select $1,id,$2 from batch on conflict(scope,id,model_tag) do update set status='pending',attempts=0,next_attempt_at=null,error_code=null,completed_at=null
      where memory_authority_index_jobs.status!='processing' and not exists(select 1 from memory_authority_vectors v join memory_authority_current c using(scope,id) where v.scope=memory_authority_index_jobs.scope and v.id=memory_authority_index_jobs.id and v.model_tag=memory_authority_index_jobs.model_tag and v.authority_version=c.version) returning id)
    select (select count(*) from inserted) as queued,(select max(version) from batch) as checkpoint,(select count(*) from batch) as selected`,
    [scope, modelTag, after, limit]
  );
  const row = rows.rows[0]!;
  return {
    queued: Number(row["queued"]),
    checkpoint: String(row["checkpoint"] ?? after),
    exhausted: Number(row["selected"]) < limit
  };
}
