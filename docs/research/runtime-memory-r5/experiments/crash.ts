import { freezeFinalizedMemoryEvent } from "../../../../packages/memory/src/finalized-memory-lineage.js";
/** Deterministic real PostgreSQL immediate-stop test. NEVER targets the daily cluster. */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  PostgresMemoryAuthority,
  PostgresMemoryProvider
} from "../../../../packages/memory/src/index.js";
import {
  finalizedTestResolver,
  finalizedTestParent
} from "../../../../packages/memory/src/finalized-test-fixture.js";
import {
  lineageDigest,
  canonicalLineageJson
} from "../../../../packages/memory/src/lineage-encoding.js";
const dir = process.env["YUVI_R5_CRASH_PG"];
const ctl = process.env["YUVI_R5_PG_CTL"];
const url = process.env["DATABASE_URL"];
const output = process.env["YUVI_R5_CRASH_OUTPUT"];
if (
  !dir?.endsWith("/yuvi-runtime-memory-r5/crash-pg") ||
  !ctl ||
  !url ||
  new URL(url).port !== "31506" ||
  !output
)
  throw new Error("Dedicated crash cluster and port 31506 required");
const person = "crash-" + randomUUID();
const scope = `yuvi:v1:user:${person}:character:crash-persona`;
let pool = new pg.Pool({ connectionString: url });
pool.on("error", () => {});
const control = (command: "start" | "stop") => {
  const args =
    command === "stop"
      ? ["-D", dir, "stop", "-m", "immediate", "-w"]
      : ["-D", dir, "-l", dir + ".log", "-o", "-h 127.0.0.1 -p 31506 -k " + dir, "start", "-w"];
  const p = spawnSync(ctl, args, { encoding: "utf8" });
  if (p.status !== 0) throw new Error("Isolated pg_ctl failed: " + p.stderr);
};
try {
  await pool.query("create extension if not exists vector");
  await pool.query(
    await readFile(
      new URL(
        "../../../../packages/memory/migrations/026_memory_authority_v1.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  let provider = new PostgresMemoryProvider(new PostgresMemoryAuthority(pool));
  async function payload(content: string, seconds: number, supersedes?: string[]) {
    const src = await finalizedTestResolver.resolve({
      sourceJournalRef: finalizedTestParent,
      sourceText: content
    });
    const source = {
      ...src,
      recordedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seconds)).toISOString(),
      authority: {
        principal: {
          state: "RESOLVED" as const,
          kind: "PRINCIPAL" as const,
          namespace: "r5-crash-host",
          actorId: "crash-owner"
        },
        binding: {
          state: "RESOLVED" as const,
          kind: "PERSON_BINDING" as const,
          personId: person,
          bindingVersion: "1"
        },
        audience: { kind: "PRIVATE" as const, channelRef: "synthetic" }
      }
    };
    const semantic = freezeFinalizedMemoryEvent(
      source,
      { scope, kind: "fact", content, ...(supersedes ? { supersedes } : {}) },
      "r5-crash-fixture"
    );
    return {
      ...semantic,
      idempotencyKey: "crash-" + content,
      payloadDigest: lineageDigest(canonicalLineageJson(semantic))
    };
  }
  const a = await payload("Editor-A", 1);
  await provider.prepareEvidence!("FINALIZED_INGESTION", a);
  const ack = await provider.writeEventIdempotent(a);
  if (!["written", "unchanged"].includes(ack.status))
    throw new Error("Initial acknowledgment failed");
  const b = await payload("Editor-B", 2, [ack.eventId!]);
  await provider.prepareEvidence!("FINALIZED_INGESTION", b);
  const faultPool = {
    query: pool.query.bind(pool),
    async connect() {
      const c = await pool.connect();
      return {
        release: () => c.release(),
        on: c.on.bind(c),
        off: c.off.bind(c),
        async query(sql: string, args?: unknown[]) {
          if (sql.includes("insert into memory_authority_current")) control("stop");
          return c.query(sql, args);
        }
      };
    }
  };
  const interrupted = await new PostgresMemoryProvider(
    new PostgresMemoryAuthority(faultPool)
  ).writeEventIdempotent(b);
  await pool.end();
  control("start");
  pool = new pg.Pool({ connectionString: url });
  pool.on("error", () => {});
  provider = new PostgresMemoryProvider(new PostgresMemoryAuthority(pool));
  const before = await provider.knowledge.detail(scope, ack.eventId!);
  const reconcile = await provider.reconcileEvent({
    scope,
    idempotencyKey: b.idempotencyKey,
    payloadDigest: b.payloadDigest
  });
  const retried = await provider.writeEventIdempotent(b);
  control("stop");
  await pool.end();
  control("start");
  pool = new pg.Pool({ connectionString: url });
  pool.on("error", () => {});
  provider = new PostgresMemoryProvider(new PostgresMemoryAuthority(pool));
  const after = {
    a: await provider.knowledge.detail(scope, ack.eventId!),
    b: await provider.knowledge.detail(scope, retried.eventId!)
  };
  const result = {
    scenario: "real PostgreSQL immediate stop mid-transaction and after acknowledged correction",
    initialAck: ack.status,
    interrupted: interrupted.failureClass,
    beforeState: before?.state,
    reconcile: reconcile.status,
    retry: retried.status,
    afterA: after.a?.state,
    afterB: after.b?.state
  };
  if (
    result.beforeState !== "current" ||
    result.reconcile !== "not_applied" ||
    result.retry !== "written" ||
    result.afterA !== "superseded" ||
    result.afterB !== "current"
  )
    throw new Error("Crash invariant violated");
  await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
