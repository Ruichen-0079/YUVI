/** First reads after restarting ONLY the isolated 31508 PostgreSQL. OS page cache
 * is not evicted; never drop machine-wide caches on a machine hosting Alice. */
import pg from "pg";
import { writeFile } from "node:fs/promises";
import { MemoryKnowledgeReader } from "../../../../packages/memory/src/index.js";
const url = process.env.DATABASE_URL!,
  out = process.env.YUVI_COLD_OUTPUT!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).port !== "31508" ||
  new URL(url).pathname !== "/yuvi_runtime_r5p2_scale" ||
  !out
)
  throw Error("Explicit synthetic cold DB/output required");
const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    application_name: "composition-cold-probe"
  }),
  reader = new MemoryKnowledgeReader(pool),
  rows = [];
try {
  const started = (await pool.query("select pg_postmaster_start_time() started")).rows[0].started;
  for (const [scope, key] of [
    ["yuvi:v1:user:r5p2-vector-scale:character:r5p2-vector-scale", "530001"],
    ["yuvi:v1:user:composition-scale-100000:character:composition-scale-100000", "50001"],
    ["yuvi:v1:user:composition-scale-10000:character:composition-scale-10000", "5001"]
  ]) {
    const t = performance.now(),
      r = await reader.search(scope!, "synthetic object_" + key, 8);
    rows.push({
      scope,
      firstReadMs: performance.now() - t,
      found: r.records.some((r) => r.id === "vs_" + key)
    });
  }
  await writeFile(
    out,
    JSON.stringify(
      {
        schema: "memory.cold-buffer-probe.v1",
        postgresStarted: started,
        cache: "fresh PostgreSQL shared buffers; OS page cache remains warm, not storage-cold",
        cases: rows
      },
      null,
      2
    )
  );
} finally {
  await pool.end();
}
