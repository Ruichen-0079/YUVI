import pg from "pg";
import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import {
  PostgresMemoryAuthority,
  MemoryKnowledgeReader
} from "../../../../packages/memory/src/index.js";
import { freezeFinalizedMemoryEvent } from "../../../../packages/memory/src/finalized-memory-lineage.js";
import {
  finalizedTestResolver,
  finalizedTestParent
} from "../../../../packages/memory/src/finalized-test-fixture.js";
import {
  lineageDigest,
  canonicalLineageJson
} from "../../../../packages/memory/src/lineage-encoding.js";
const url = process.env.DATABASE_URL!,
  out = process.env.YUVI_LOAD_OUTPUT!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).port !== "31508" ||
  new URL(url).pathname !== "/yuvi_runtime_r5p2_scale" ||
  !out
)
  throw Error("Explicit synthetic load DB/output required");
const pool = new pg.Pool({
    connectionString: url,
    max: 6,
    application_name: "composition-concurrent-load"
  }),
  reader = new MemoryKnowledgeReader(pool),
  authority = new PostgresMemoryAuthority(pool);
const scopes = [10000, 100000]
  .map((n) => `yuvi:v1:user:composition-scale-${n}:character:composition-scale-${n}`)
  .concat("yuvi:v1:user:r5p2-vector-scale:character:r5p2-vector-scale");
const report: any = {
  schema: "memory.composition-concurrency.v1",
  kind: "real-postgresql-production-reader-writer-protocol-source",
  readers: 4,
  writers: 2,
  reads: [],
  writes: [],
  errors: [],
  started: new Date().toISOString()
};
async function writer(i: number) {
  for (let n = 0; n < 10; n++) {
    const t = performance.now(),
      text = `Synthetic concurrent load pulse ${i}-${n}-${randomUUID()}`;
    const original = await finalizedTestResolver.resolve({
      sourceJournalRef: finalizedTestParent,
      sourceText: text
    });
    const source = {
      ...original,
      authority: {
        principal: {
          state: "RESOLVED",
          kind: "PRINCIPAL",
          namespace: "composition-load",
          actorId: "synthetic-actor"
        },
        binding: {
          state: "RESOLVED",
          kind: "PERSON_BINDING",
          personId: "composition-scale-100000",
          bindingVersion: "1"
        },
        audience: { kind: "PRIVATE", channelRef: "synthetic-load-private" }
      }
    } as any;
    const value = freezeFinalizedMemoryEvent(
      source,
      { scope: scopes[1]!, kind: "fact", content: text },
      "composition-load-test"
    );
    const input = {
      ...value,
      idempotencyKey: randomUUID(),
      payloadDigest: lineageDigest(canonicalLineageJson(value))
    };
    await authority.prepare("FINALIZED_INGESTION", input);
    const result = await authority.commit(input);
    const retrieved = await reader.search(scopes[1]!, text, 8);
    report.writes.push({
      elapsedMs: performance.now() - t,
      id: result.event.id,
      version: result.version,
      readYourWrite: retrieved.records.some((r) => r.id === result.event.id)
    });
  }
}
async function read(i: number) {
  for (let n = 0; n < 25; n++) {
    const s = scopes[(i + n) % 3]!,
      expected = s === scopes[2] ? "vs_530001" : s === scopes[1] ? "vs_50001" : "vs_5001";
    const t = performance.now();
    const result = await reader.search(s, "synthetic object_" + expected.slice(3), 8);
    report.reads.push({
      scope: s,
      elapsedMs: performance.now() - t,
      found: result.records.some((r) => r.id === expected),
      watermark: result.watermark
    });
  }
}
try {
  const start = performance.now();
  const work = await Promise.allSettled([
    writer(0),
    writer(1),
    ...Array.from({ length: 4 }, (_, i) => read(i))
  ]);
  report.elapsedMs = performance.now() - start;
  report.errors = work
    .filter((r) => r.status === "rejected")
    .map((r) => String((r as PromiseRejectedResult).reason));
  report.databaseIO = (
    await pool.query(
      "select blks_read,blks_hit,temp_bytes from pg_stat_database where datname=current_database()"
    )
  ).rows;
  const pids = (
    await pool.query(
      "select pid from pg_stat_activity where application_name='composition-concurrent-load'"
    )
  ).rows.map((r) => r.pid);
  report.backendMemory = await Promise.all(
    pids.map(async (pid) => ({
      pid,
      status: (await readFile(`/proc/${pid}/status`, "utf8"))
        .split("\n")
        .filter((s) => /^Vm(RSS|HWM|Size):/.test(s))
    }))
  );
} finally {
  await writeFile(out, JSON.stringify(report, null, 2));
  await pool.end();
}
