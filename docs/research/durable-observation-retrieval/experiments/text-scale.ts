/** Existing isolated million-row corpus, read-only. No semantic LLM claim. */
import pg from "pg";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { MemoryKnowledgeReader } from "../../../../packages/memory/src/index.js";
const url = process.env.DATABASE_URL,
  dest = process.env.YUVI_RETRIEVAL_OUTPUT;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).port !== "31508" ||
  new URL(url).pathname !== "/yuvi_runtime_r5p2_scale" ||
  !dest
)
  throw Error("Explicit synthetic scale database/output required");
const db = new pg.Pool({
  connectionString: url,
  max: 2,
  statement_timeout: 10000,
  application_name: "retrieval-quality-read-only"
});
let productionQuery: { sql: string; values?: unknown[] } | undefined;
const reader = new MemoryKnowledgeReader({
    query(sql, values) {
      if (sql.includes("with ranked as materialized")) productionQuery = { sql, values };
      return db.query(sql, values);
    }
  }),
  scope = "yuvi:v1:user:r5p2-vector-scale:character:r5p2-vector-scale";
const active = `(select scope,id,version,state,search from memory_authority_projection_rows where scope=$1 and generation=(select projection_generation from memory_authority_scopes where scope=$1))`;
const baseline = `with candidates as materialized (select scope,id,state,version,search from ${active} c where scope=$1 and state in ('current','conflicted') and search @@ to_tsquery('simple',$2) limit 513)
 select r.*,c.state,(select count(*) from candidates) as candidate_count from candidates c join memory_authority_records r using(scope,id) order by ts_rank(c.search,to_tsquery('simple',$2)) desc,c.version desc limit 8`;
async function measure(fn: () => Promise<unknown>) {
  const ms = [];
  for (let i = 0; i < 22; i++) {
    const start = performance.now();
    await fn();
    if (i >= 2) ms.push(performance.now() - start);
  }
  ms.sort((a, b) => a - b);
  return { n: ms.length, p50: ms[10], p95: ms[19], p99: ms[19] };
}
const report: any = {
  schema: "memory.text-quality-scale.v1",
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  started: new Date().toISOString(),
  kind: "actual-postgresql-synthetic-corpus-production-reader",
  cache: "hot after warmup, OS cache not evicted",
  logicalCPUs: cpus().length,
  ramBytes: totalmem(),
  cases: []
};
try {
  report.overview = await reader.overview(scope);
  for (const g of [50, 530000, 930000]) {
    const expected = "vs_" + (g % 10 === 0 ? g + 1 : g),
      query = "synthetic object_" + (g % 10 === 0 ? g + 1 : g),
      tsquery = query.replace(" ", " | ");
    const old = (await db.query(baseline, [scope, tsquery])).rows.map((r) => r.id),
      result = await reader.search(scope, query, 8);
    report.cases.push({
      query,
      expected,
      baseline: old,
      revised: result.records.map((r) => r.id),
      baselineRecallAt8: old.includes(expected),
      revisedRecallAt8: result.records.some((r) => r.id === expected),
      states: result.records.map((r) => r.state)
    });
  }
  report.selective = await measure(() => reader.search(scope, "object_530001", 8));
  report.mixed = await measure(() => reader.search(scope, "synthetic object_530001", 8));
  report.broad = await measure(() => reader.search(scope, "synthetic", 8));
  report.baselineMixed = await measure(() =>
    db.query(baseline, [scope, "synthetic | object_530001"])
  );
  await reader.search(scope, "synthetic object_530001", 8);
  if (!productionQuery) throw Error("Missing production query trace");
  report.plan = (
    await db.query(
      "explain(analyze,buffers,format json) " + productionQuery.sql,
      productionQuery.values
    )
  ).rows[0];
  report.sizes = (
    await db.query(
      "select relname,pg_total_relation_size(oid)::text bytes from pg_class where oid=any(array['memory_authority_projection_rows'::regclass,'memory_authority_records'::regclass])"
    )
  ).rows;
  report.boundary =
    "Global rank removes the correctness cliff. Very broad lexical queries can still examine all matching current records; this is not a sublinear top-K index or complete R5 scalability acceptance.";
  await writeFile(dest, JSON.stringify(report, null, 2));
} finally {
  await db.end();
}
