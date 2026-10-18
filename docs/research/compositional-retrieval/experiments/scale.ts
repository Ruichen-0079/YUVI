/** Actual derived-index load on the existing synthetic million corpus. Never an
 * Alice database; manually copied load rows are NOT grounded semantic evidence. */
import pg from "pg";
import { readFile, writeFile, statfs } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cpus, totalmem, freemem } from "node:os";
import {
  MemoryKnowledgeReader,
  PostgresMemoryAuthority,
  advanceLexicalIndex,
  applySqlMigrations,
  readSqlMigrations
} from "../../../../packages/memory/src/index.js";
const url = process.env.DATABASE_URL!,
  dest = process.env.YUVI_SCALE_OUTPUT!,
  baselineRoot = process.env.YUVI_BASELINE_CHECKOUT!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).port !== "31508" ||
  new URL(url).pathname !== "/yuvi_runtime_r5p2_scale" ||
  !dest ||
  !baselineRoot
)
  throw Error("Explicit synthetic scale DB/output/baseline required");
const db = new pg.Pool({
  connectionString: url,
  max: 1,
  statement_timeout: 20000,
  application_name: "composition-synthetic-scale"
});
const authority = new PostgresMemoryAuthority(db),
  scope = "yuvi:v1:user:r5p2-vector-scale:character:r5p2-vector-scale";
const { MemoryKnowledgeReader: BaselineReader } = await import(
  pathToFileURL(baselineRoot + "/packages/memory/src/authority/read.ts").href
);
let captured: any;
const reader = new MemoryKnowledgeReader({
    query(sql, values) {
      if (sql.includes("probes as materialized")) captured = { sql, values };
      return db.query(sql, values);
    }
  }),
  old = new BaselineReader(db);
async function measure(fn: () => Promise<unknown>) {
  const pid = Number((await db.query("select pg_backend_pid() pid")).rows[0].pid);
  const ticks = async () => {
    const p = (await readFile(`/proc/${pid}/stat`, "utf8")).split(" ");
    return [Number(p[13]), Number(p[14])];
  };
  const before = await ticks();
  const values = [];
  for (let i = 0; i < 32; i++) {
    const t = performance.now();
    await fn();
    if (i > 1) values.push(performance.now() - t);
  }
  values.sort((a, b) => a - b);
  const after = await ticks(),
    hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
  return {
    n: values.length,
    p50: values[14],
    p95: values[28],
    p99: values[29],
    backendCPU: {
      userMs: (1000 * (after[0] - before[0])) / hz,
      systemMs: (1000 * (after[1] - before[1])) / hz,
      scope:
        "32 requests including warmup; this backend only, excludes possible parallel worker CPU"
    }
  };
}
const report: any = {
  schema: "memory.composition-scale.v1",
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  cache: "warm shared buffers and OS; no machine-wide cache eviction",
  logicalCPUs: cpus().length,
  ramBytes: totalmem(),
  freeRamBefore: freemem(),
  started: new Date().toISOString(),
  results: []
};
async function save() {
  await writeFile(dest, JSON.stringify(report, null, 2));
}
try {
  await applySqlMigrations(db, await readSqlMigrations());
  const start = performance.now();
  let state,
    batches = 0;
  do {
    const fs = await statfs("/home/ruichen");
    if (Number(fs.bavail) * Number(fs.bsize) < 4 * 1024 ** 3)
      throw Error("Keep 4GB reserve; backfill checkpoint preserved");
    state = await advanceLexicalIndex(authority, scope, 1000, "isolated-scale-experiment");
    if (++batches % 100 === 0) {
      report.backfill = { batches, state, elapsedMs: performance.now() - start };
      await save();
    }
  } while (state.status !== "READY");
  report.backfill = { batches, state, elapsedMs: performance.now() - start };
  await save();
  const pid = Number((await db.query("select pg_backend_pid() pid")).rows[0].pid);
  async function cpu() {
    const p = (await readFile(`/proc/${pid}/stat`, "utf8")).split(" ");
    return { userTicks: p[13], systemTicks: p[14] };
  }
  for (const n of [10000, 100000, 1000000]) {
    const s =
      n === 1000000
        ? scope
        : `yuvi:v1:user:composition-scale-${n}:character:composition-scale-${n}`;
    const buildStart = performance.now();
    if (n !== 1000000) {
      const existing = await db.query("select scope from memory_authority_scopes where scope=$1", [
        s
      ]);
      if (!existing.rows.length) {
        await db.query("insert into memory_authority_scopes(scope) values($1)", [s]);
        for (let after = 0; after < n; after += 1000) {
          await db.query(
            `insert into memory_authority_records(scope,id,logical_key,digest,version,source_at,classification,event,search_terms,semantic_payload)
      select $2,id,logical_key,digest,version,source_at,classification,jsonb_set(event,'{scope}',to_jsonb($2::text)),search_terms,semantic_payload from memory_authority_records where scope=$1 and version>$3 and version<=$4`,
            [scope, s, after, after + 1000]
          );
          await db.query(
            `insert into memory_authority_current(scope,id,version,state,search)
      select $2,c.id,c.version,c.state,c.search from memory_authority_current c join memory_authority_records r using(scope,id) where c.scope=$1 and r.version>$3 and r.version<=$4`,
            [scope, s, after, after + 1000]
          );
        }
        await db.query(
          `update memory_authority_scopes set version=(select max(version) from memory_authority_records where scope=$1),projection_version=(select max(version) from memory_authority_records where scope=$1),record_count=(select count(*) from memory_authority_records where scope=$1),current_count=(select count(*) from memory_authority_current where scope=$1 and state in ('current','conflicted')) where scope=$1`,
          [s]
        );
      }
    }
    const object = n === 1000000 ? 530001 : Math.floor(n / 2) + 1,
      q = `synthetic object_${object}`;
    const beforeCPU = await cpu(),
      entry: any = {
        n,
        scope: s,
        copyAndIndexMs: performance.now() - buildStart,
        overview: await reader.overview(s)
      };
    entry.selective = await measure(() => reader.search(s, `object_${object}`, 8));
    entry.mixed = await measure(() => reader.search(s, q, 8));
    entry.broad = await measure(() => reader.search(s, "synthetic", 8));
    entry.threeNeeds = await measure(() =>
      Promise.all(
        [q, "synthetic object_51", `synthetic object_${n - 9}`].map((x) => reader.search(s, x, 8))
      )
    );
    entry.baselineMixed = await measure(() => old.search(s, q, 8));
    entry.expected = "vs_" + object;
    entry.selected = (await reader.search(s, q, 8)).records.map((r) => r.id);
    entry.baselineSelected = (await old.search(s, q, 8)).records.map((r: any) => r.id);
    entry.cpuTicks = { before: beforeCPU, after: await cpu() };
    await reader.search(s, q, 8);
    entry.plan = (
      await db.query("explain(analyze,buffers,format json) " + captured.sql, captured.values)
    ).rows[0];
    report.results.push(entry);
    await save();
  }
  report.sizes = (
    await db.query(
      "select relname,pg_total_relation_size(oid)::text bytes from pg_class where oid=any(array['memory_lexical_postings'::regclass,'memory_lexical_generations'::regclass])"
    )
  ).rows;
  report.databaseIO = (
    await db.query(
      "select blks_read,blks_hit,temp_bytes,blk_read_time,blk_write_time from pg_stat_database where datname=current_database()"
    )
  ).rows;
  report.freeRamAfter = freemem();
  report.finished = new Date().toISOString();
  await save();
} catch (e) {
  report.error = String(e);
  await save();
  throw e;
} finally {
  await db.end();
}
