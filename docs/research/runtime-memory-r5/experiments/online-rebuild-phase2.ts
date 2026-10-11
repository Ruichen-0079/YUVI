import pg from "pg";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  PostgresMemoryAuthority,
  MemoryProjectionRebuild,
  MemoryKnowledgeReader,
  verifyMemoryProjection,
  readSqlMigrations,
  applySqlMigrations
} from "../../../../packages/memory/src/index.js";
const url = process.env["DATABASE_URL"],
  out = process.env["YUVI_R5_SCALE_OUTPUT"];
if (
  !url ||
  new URL(url).port !== "31508" ||
  new URL(url).pathname !== "/yuvi_runtime_r5p2_scale" ||
  !out
)
  throw Error("Own Phase 2 scale cluster required");
const pool = new pg.Pool({ connectionString: url, max: 8 }),
  authority = new PostgresMemoryAuthority(pool),
  reader = new MemoryKnowledgeReader(pool);
const scope = "yuvi:v1:user:r5p2-vector-scale:character:r5p2-vector-scale";
const id = "online-million-" + randomUUID(),
  reads: number[] = [],
  writes: number[] = [],
  samples: any[] = [],
  errors: string[] = [];
let reading = true;
const start = performance.now();
const report: any = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope,
  id,
  synthetic: true,
  before: null,
  after: null,
  rebuild: null,
  samples,
  errors
};
function latency(a: number[]) {
  const v = [...a].sort((a, b) => a - b);
  return {
    n: v.length,
    p50: v[Math.floor(v.length * 0.5)],
    p95: v[Math.floor(v.length * 0.95)],
    p99: v[Math.floor(v.length * 0.99)],
    max: v.at(-1)
  };
}
async function save() {
  report.durationMs = performance.now() - start;
  report.read = latency(reads);
  report.write = latency(writes);
  await writeFile(out, JSON.stringify(report, null, 2), { mode: 0o600 });
}
try {
  await applySqlMigrations(pool, await readSqlMigrations());
  report.before = await reader.overview(scope);
  const build = new MemoryProjectionRebuild(authority);
  await build.start(scope, id, "synthetic-scale-operator");
  const readLoop = (async () => {
    while (reading) {
      const t = performance.now();
      try {
        const r = await reader.page({ scope, limit: 20 });
        if (r.records.some((r) => r.state === "superseded")) throw Error("superseded leak");
        reads.push(performance.now() - t);
      } catch (e) {
        errors.push(String(e));
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  const writeLoop = (async () => {
    for (let i = 0; i < 50; i++) {
      const t = performance.now(),
        sourceId = id + "-" + i;
      await authority.importLegacy({
        scope,
        source: "synthetic-concurrent-writer",
        sourceId,
        event: {
          id: sourceId,
          scope,
          source: "legacy",
          sourceRecordId: sourceId,
          kind: "fact",
          content: "Synthetic concurrent writer " + i,
          recordedAt: "2026-10-01T00:00:00Z",
          metadata: { indexLoadOnly: true }
        }
      });
      writes.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  let state = await build.status(scope, id),
    steps = 0;
  while (state?.status !== "ACTIVE") {
    state = await new MemoryProjectionRebuild(new PostgresMemoryAuthority(pool)).advance(
      scope,
      id,
      1000
    );
    steps++;
    if (steps === 5) {
      await build.pause(scope, id, true);
      const paused = await build.advance(scope, id, 1000);
      if (paused.status !== "PAUSED") throw Error("pause failed");
      await new MemoryProjectionRebuild(authority).pause(scope, id, false);
    }
    if (steps % 100 === 0) {
      samples.push({ step: steps, ...state });
      await save();
      console.log(steps, state?.status, state?.checkpoint);
    }
    if (state?.status === "FAILED" || steps > 1100)
      throw Error("rebuild did not activate " + JSON.stringify(state));
  }
  await writeLoop;
  reading = false;
  await readLoop;
  report.rebuild = state;
  report.after = await reader.overview(scope);
  const bad = (
    await pool.query(
      `select count(*) from memory_authority_records r join memory_authority_current c using(scope,id)
 where r.scope=$1 and c.state<>case when r.classification='LEGACY_UNVERIFIED' then 'legacy_unverified'
 when exists(select 1 from memory_authority_relations e where e.scope=r.scope and e.to_id=r.id and e.kind='supersedes') then 'superseded'
 else 'current' end`,
      [scope]
    )
  ).rows[0].count;
  report.finalStateMismatches = bad;
  if (
    bad !== "0" ||
    errors.length ||
    BigInt(report.after.records) !== BigInt(report.before.records) + 50n
  )
    throw Error("final durable invariant failed");
  report.status = "VERIFIED_SYNTHETIC_ONLINE_REBUILD";
  await save();
} catch (e) {
  reading = false;
  report.status = "FAILED";
  report.error = String(e);
  await save();
  throw e;
} finally {
  await pool.end();
}
