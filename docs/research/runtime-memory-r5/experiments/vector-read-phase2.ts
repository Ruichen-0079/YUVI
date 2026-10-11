/** Corrected production reader on existing synthetic scale fixture. No LLM quality claim. */
import pg from "pg";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  MemoryKnowledgeReader,
  MemoryVectorIndexer,
  PostgresMemoryAuthority
} from "../../../../packages/memory/src/index.js";
const url = process.env["DATABASE_URL"],
  dest = process.env["YUVI_R5_SCALE_OUTPUT"];
if (
  !url ||
  new URL(url).port !== "31508" ||
  new URL(url).pathname !== "/yuvi_runtime_r5p2_scale" ||
  !dest
)
  throw Error("Isolated scale DB required");
const pool = new pg.Pool({
  connectionString: url,
  max: 8,
  application_name: "r5p2-vector-corrected"
});
const scope = "yuvi:v1:user:r5p2-vector-scale:character:r5p2-vector-scale";
function vector(g: number) {
  return Array.from({ length: 512 }, (_, i) => {
    const j = i + 1,
      b = g > 1 && g % 10 === 1 ? g - 1 : g;
    return Math.fround(
      Math.sin(b * (j * 0.371 + j * j * 0.13)) + (g !== b ? 0.0001 * Math.cos(j) : 0)
    );
  });
}
const index = new MemoryVectorIndexer(new PostgresMemoryAuthority(pool), {
  name: "synthetic-performance-vector",
  model: "deterministic-load-only",
  dimensions: 512,
  mock: false,
  embedText: async (t: string) => vector(Number(t))
});
const reader = new MemoryKnowledgeReader(pool),
  report: any = {
    sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    started: new Date().toISOString(),
    embedding: "synthetic deterministic 512D; not model semantic quality"
  };
async function measure(run: () => Promise<unknown>, n = 40) {
  const v = [];
  for (let i = 0; i < n + 5; i++) {
    const t = performance.now();
    await run();
    if (i >= 5) v.push(performance.now() - t);
  }
  v.sort((a, b) => a - b);
  return {
    n,
    p50: v[Math.floor(n * 0.5)],
    p95: v[Math.floor(n * 0.95)],
    p99: v[Math.min(n - 1, Math.floor(n * 0.99))]
  };
}
try {
  report.overview = await reader.overview(scope);
  report.counts = (
    await pool.query(
      "select (select count(*) from memory_authority_vectors where scope=$1) as vectors,(select indisvalid from pg_index where indexrelid='memory_authority_vectors_hnsw_idx'::regclass) as index_valid",
      [scope]
    )
  ).rows[0];
  const tPage = performance.now();
  await reader.page({ scope, limit: 20 });
  const pageFirst = performance.now() - tPage;
  const tVector = performance.now();
  await index.searchWithEvidence(scope, "530000", 8);
  const vectorFirst = performance.now() - tVector;
  report.first = {
    pageMs: pageFirst,
    vectorMs: vectorFirst,
    cacheCondition:
      "own PG recovered after crash; filesystem cache not evicted; first calls, not fully cold OS"
  };
  report.page = await measure(() => reader.page({ scope, limit: 20 }));
  report.text = await measure(() => reader.search(scope, "object_530001", 8));
  report.broadText = await measure(() => reader.search(scope, "synthetic", 8));
  report.vector = await measure(() => index.searchWithEvidence(scope, "530000", 8));
  report.scores = [];
  for (const q of [11, 100, 791, 530000, 930000]) {
    const r = await index.searchWithEvidence(scope, String(q), 8),
      expected = "vs_" + (q % 10 === 0 ? q + 1 : q);
    const states = (
      await pool.query(
        "select id,state from memory_authority_current where scope=$1 and id=any($2::text[])",
        [scope, r.ids]
      )
    ).rows;
    report.scores.push({
      query: q,
      expected,
      ...r,
      recallAt8: r.ids.includes(expected),
      oldLeak: states.some((s) => s.state === "superseded")
    });
  }
  const begin = performance.now();
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let i = 0; i < 25; i++)
        await Promise.all([
          reader.page({ scope, limit: 20 }),
          index.searchWithEvidence(scope, String(791 + i), 8)
        ]);
    })
  );
  report.mixed = { readers: 4, requests: 200, durationMs: performance.now() - begin };
  report.plans = {};
  for (const [name, sql, args] of [
    [
      "page",
      "select c.id from memory_authority_projection_rows c where c.scope=$1 and generation=(select projection_generation from memory_authority_scopes where scope=$1) and state in ('current','conflicted') order by version desc limit 20",
      [scope]
    ],
    [
      "vector",
      "with nearest as materialized (select scope,id,authority_version,embedding <=> $3::vector as distance from memory_authority_vectors where scope=$1 and model_tag=$2 order by embedding <=> $3::vector limit 64) select n.id from nearest n join memory_authority_projection_rows c using(scope,id) where c.generation=(select projection_generation from memory_authority_scopes where scope=$1) and c.state in ('current','conflicted') and n.authority_version=c.version order by n.distance,n.id limit 8",
      [scope, index.modelTag, JSON.stringify(vector(530000))]
    ]
  ] as const)
    report.plans[name] = (
      await pool.query("explain (analyze,buffers,format json) " + sql, [...args])
    ).rows;
  report.storage = (
    await pool.query(
      "select relname,pg_total_relation_size(oid)::text as bytes,pg_indexes_size(oid)::text as index_bytes from pg_class where relname in ('memory_authority_records','memory_authority_projection_rows','memory_authority_vectors','memory_authority_relations')"
    )
  ).rows;
  report.io = (
    await pool.query(
      "select blks_read,blks_hit,tup_returned,tup_fetched,temp_bytes from pg_stat_database where datname=current_database()"
    )
  ).rows[0];
  report.finished = new Date().toISOString();
  await writeFile(dest, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      overview: report.overview,
      counts: report.counts,
      page: report.page,
      text: report.text,
      vector: report.vector,
      scores: report.scores,
      mixed: report.mixed
    })
  );
} finally {
  await pool.end();
}
