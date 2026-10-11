/** Synthetic 512D load, not LLM grounding or real embedding quality. Isolated PG process only.
 * Bulk fixture construction is explicitly separate from production write throughput.
 * Read/ANN/rebuild calls use the production components and real indexes.
 */
import pg from "pg";
import { performance } from "node:perf_hooks";
import { writeFile, statfs } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  MemoryKnowledgeReader,
  MemoryVectorIndexer,
  PostgresMemoryAuthority,
  MemoryProjectionRebuild
} from "../../../../packages/memory/src/index.js";
const url = process.env["DATABASE_URL"],
  destination = process.env["YUVI_R5_SCALE_OUTPUT"];
if (
  !url ||
  new URL(url).port !== "31508" ||
  new URL(url).pathname !== "/yuvi_runtime_r5p2_scale" ||
  !destination
)
  throw Error("Isolated Phase 2 scale PG and output required");
const pool = new pg.Pool({ connectionString: url, max: 8, application_name: "r5p2-vector-scale" });
const scope = "yuvi:v1:user:r5p2-vector-scale:character:r5p2-vector-scale",
  model = "synthetic-performance-vector:deterministic-load-only:512";
const reader = new MemoryKnowledgeReader(pool),
  authority = new PostgresMemoryAuthority(pool);
const embedding = (g: number) =>
  Array.from({ length: 512 }, (_, i) => {
    const j = i + 1,
      b = g > 1 && g % 10 === 1 ? g - 1 : g;
    return Math.fround(
      Math.sin(b * (j * 0.371 + j * j * 0.13)) + (g !== b ? 0.0001 * Math.cos(j) : 0)
    );
  });
const index = new MemoryVectorIndexer(authority, {
  name: "synthetic-performance-vector",
  model: "deterministic-load-only",
  dimensions: 512,
  mock: false,
  embedText: async (text: string) => embedding(Number(text)),
  embedBatch: async () => {
    throw Error("Load does not claim model indexing throughput");
  }
});
const report: any = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
  embedding: "synthetic deterministic 512D; not real model embedding",
  samples: [],
  started: new Date().toISOString()
};
async function save() {
  await writeFile(destination, JSON.stringify(report, null, 2), { mode: 0o600 });
}
function summary(xs: number[]) {
  const v = [...xs].sort((a, b) => a - b);
  return {
    n: v.length,
    p50: v[Math.floor(v.length * 0.5)],
    p95: v[Math.floor(v.length * 0.95)],
    p99: v[Math.min(v.length - 1, Math.floor(v.length * 0.99))]
  };
}
async function measure(run: () => Promise<unknown>, n = 40) {
  const values = [];
  for (let i = 0; i < n + 5; i++) {
    const t = performance.now();
    await run();
    if (i >= 5) values.push(performance.now() - t);
  }
  return summary(values);
}
try {
  report.database = (
    await pool.query(
      "select version(),(select extversion from pg_extension where extname='vector') as pgvector"
    )
  ).rows[0];
  await pool.query("insert into memory_authority_scopes(scope) values($1) on conflict do nothing", [
    scope
  ]);
  let size = Number((await reader.overview(scope)).records);
  for (const scale of [10000, 100000, 1000000].filter(
    (n) => n <= Number(process.argv[2] ?? 1000000)
  )) {
    if (scale < size) continue;
    const item: any = { scale, started: new Date().toISOString() };
    report.samples.push(item);
    await save();
    const t = performance.now();
    if (size < scale) await pool.query("drop index if exists memory_authority_vectors_hnsw_idx");
    for (let from = size + 1; from <= scale; from += 5000) {
      const disk = await statfs(destination.substring(0, destination.lastIndexOf("/")));
      if (Number(disk.bavail) * Number(disk.bsize) < 6 * 1024 ** 3)
        throw Error("SCALE_DISK_RESERVE_REACHED");
      const to = Math.min(scale, from + 4999),
        c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("select scope from memory_authority_scopes where scope=$1 for update", [
          scope
        ]);
        await c.query(
          `insert into memory_authority_records(scope,id,logical_key,digest,version,source_at,classification,event,search_terms)
      select $1,'vs_'||g,'vs_'||g,repeat('0',64),g,'2026-10-01','GROUNDED',jsonb_build_object('id','vs_'||g,'scope',$1::text,'kind','fact','content','synthetic object_'||g||' topic_'||(g%500),'source','postgres','sourceRecordId','vs_'||g,'metadata',jsonb_build_object('syntheticIndexLoad',true),'lineage',jsonb_build_object('authority',jsonb_build_object('principal',jsonb_build_object('state','RESOLVED'),'binding',jsonb_build_object('state','RESOLVED'),'audience',jsonb_build_object('kind','PRIVATE')))), 'synthetic object_'||g||' topic_'||(g%500) from generate_series($2::bigint,$3::bigint) g`,
          [scope, from, to]
        );
        // Direct fixture population of the physical generation avoids claiming per-event write throughput.
        await c.query(
          `insert into memory_authority_projection_rows(scope,generation,id,version,state,search) select r.scope,1,id,version,'current',to_tsvector('simple',search_terms) from memory_authority_records r where scope=$1 and version between $2 and $3`,
          [scope, from, to]
        );
        await c.query(
          `insert into memory_authority_relations(scope,from_id,to_id,kind,version) select $1,'vs_'||g,'vs_'||(g-1),'supersedes',g from generate_series($2::bigint,$3::bigint) g where g>1 and g%10=1`,
          [scope, from, to]
        );
        await c.query(
          `update memory_authority_projection_rows set state='superseded' where scope=$1 and generation=1 and version%10=0 and version between greatest(1,$2::bigint-1) and $3::bigint-1`,
          [scope, from, to]
        );
        await c.query(
          `insert into memory_authority_vectors(scope,id,model_tag,authority_version,embedding)
     select $1,'vs_'||g,$4,g,(array(select (sin((case when g>1 and g%10=1 then g-1 else g end)*(j*.371+j*j*.13)) + case when g>1 and g%10=1 then .0001*cos(j) else 0 end)::real from generate_series(1,512) j))::vector from generate_series($2::bigint,$3::bigint) g`,
          [scope, from, to, model]
        );
        await c.query(
          "update memory_authority_scopes set version=$2::bigint,projection_version=$2::bigint,record_count=$2::bigint,current_count=$2::bigint-floor(($2::bigint-1)::numeric/10)::bigint where scope=$1",
          [scope, to]
        );
        await c.query("commit");
      } catch (e) {
        await c.query("rollback").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
      if (to % 100000 === 0) {
        item.loaded = to;
        await save();
        console.log("vectors loaded", to);
      }
    }
    item.bulkLoadMs = performance.now() - t;
    size = scale;
    const build = performance.now();
    await pool.query(
      "create index if not exists memory_authority_vectors_hnsw_idx on memory_authority_vectors using hnsw(embedding vector_cosine_ops)"
    );
    item.indexBuildMs = performance.now() - build;
    for (const table of [
      "memory_authority_vectors",
      "memory_authority_records",
      "memory_authority_projection_rows",
      "memory_authority_scopes",
      "memory_authority_relations"
    ])
      await pool.query("analyze " + table);
    item.page = await measure(() => reader.page({ scope, limit: 20 }));
    item.text = await measure(() => reader.search(scope, "object_" + Math.floor(scale * 0.53), 8));
    item.broadText = await measure(() => reader.search(scope, "synthetic", 8));
    item.vector = await measure(() => index.search(scope, String(Math.floor(scale * 0.53) + 1), 8));
    const scores = [];
    for (const q of [11, 100, 791, Math.floor(scale * 0.53), Math.floor(scale * 0.93)]) {
      const ids = await index.search(scope, String(q), 8),
        expected = "vs_" + (q % 10 === 0 && q < scale ? q + 1 : q);
      const states = (
        await pool.query(
          "select id,state from memory_authority_current where scope=$1 and id=any($2::text[])",
          [scope, ids]
        )
      ).rows;
      scores.push({
        query: q,
        expected,
        ids,
        recallAt8: ids.includes(expected),
        oldLeak: states.some((r) => r.state === "superseded")
      });
    }
    item.syntheticRecall = scores;
    item.plans = (
      await pool.query(
        "explain (analyze,buffers,format json) select v.id from memory_authority_vectors v join memory_authority_current c using(scope,id) where v.scope=$1 and v.model_tag=$2 and c.state in ('current','conflicted') and v.authority_version=c.version order by v.embedding <=> $3::vector limit 8",
        [scope, model, JSON.stringify(embedding(Math.floor(scale * 0.53) + 1))]
      )
    ).rows;
    const begin = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let i = 0; i < 25; i++)
          await Promise.all([
            reader.page({ scope, limit: 20 }),
            index.search(scope, String(791 + i), 8)
          ]);
      })
    );
    item.mixed = { readers: 4, requests: 200, durationMs: performance.now() - begin };
    item.storage = (
      await pool.query(
        "select relname,pg_total_relation_size(oid)::text as bytes,pg_indexes_size(oid)::text as index_bytes from pg_class where relname in ('memory_authority_records','memory_authority_projection_rows','memory_authority_vectors','memory_authority_relations')"
      )
    ).rows;
    item.io = (
      await pool.query(
        "select blks_read,blks_hit,tup_returned,tup_fetched,temp_bytes from pg_stat_database where datname=current_database()"
      )
    ).rows[0];
    item.finished = new Date().toISOString();
    await save();
    console.log(
      "measured",
      scale,
      JSON.stringify({ page: item.page, vector: item.vector, scores })
    );
  }
  report.finished = new Date().toISOString();
  await save();
} catch (e) {
  report.failure = {
    message: e instanceof Error ? e.message : String(e),
    at: new Date().toISOString()
  };
  await save();
  throw e;
} finally {
  await pool.end();
}
