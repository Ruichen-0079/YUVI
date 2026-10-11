/** Deterministic production authority commit amid 1M synthetic index fixtures.
 * Does NOT assert LLM semantics or complete Journal ingestion throughput. */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  PostgresMemoryAuthority,
  PostgresMemoryProvider
} from "../../../../packages/memory/src/index.js";
import {
  finalizedTestResolver,
  finalizedTestParent
} from "../../../../packages/memory/src/finalized-test-fixture.js";
import { freezeFinalizedMemoryEvent } from "../../../../packages/memory/src/finalized-memory-lineage.js";
import {
  canonicalLineageJson,
  lineageDigest
} from "../../../../packages/memory/src/lineage-encoding.js";
const url = process.env["DATABASE_URL"];
if (!url || !new URL(url).pathname.includes("runtime_r5_"))
  throw new Error("Isolated R5 DB required");
const pool = new pg.Pool({ connectionString: url, max: 2 });
const scope = "yuvi:v1:user:r5-load:character:r5-load";
const principal = { namespace: "r5-incremental-host", actorId: "r5-incremental-owner" };
const run = randomUUID();
const provider = new PostgresMemoryProvider(new PostgresMemoryAuthority(pool));
const background = (await provider.knowledge.overview(scope)).records;
if (BigInt(background) < 1000000n) throw new Error("Actual million-record background required");
async function commit(content: string, offset: number, supersedes?: string[]) {
  const original = await finalizedTestResolver.resolve({
    sourceJournalRef: finalizedTestParent,
    sourceText: content
  });
  const source = {
    ...original,
    recordedAt: new Date(Date.now() + offset * 1000).toISOString(),
    authority: {
      principal: { state: "RESOLVED" as const, kind: "PRINCIPAL" as const, ...principal },
      binding: {
        state: "RESOLVED" as const,
        kind: "PERSON_BINDING" as const,
        personId: "r5-load",
        bindingVersion: "1"
      },
      audience: { kind: "PRIVATE" as const, channelRef: run }
    }
  };
  const payload = freezeFinalizedMemoryEvent(
    source,
    { scope, kind: "fact", content, ...(supersedes ? { supersedes } : {}) },
    "r5-incremental-fixture"
  );
  const input = {
    ...payload,
    idempotencyKey: run + ":" + offset,
    payloadDigest: lineageDigest(canonicalLineageJson(payload))
  };
  const started = performance.now();
  await provider.prepareEvidence!("FINALIZED_INGESTION", input);
  const ack = await provider.writeEventIdempotent(input);
  if (ack.status !== "written") throw new Error("Incremental commit failed: " + ack.errorCode);
  return { ack, elapsedMs: performance.now() - started };
}
try {
  const a = await commit("Incremental editor A " + run, 1);
  const unrelated = await commit("Incremental independent tea " + run, 2);
  const b = await commit("Incremental editor B " + run, 3, [a.ack.eventId!]);
  const started = performance.now();
  const retrieval = await provider.retrieveRelevant({
    scope,
    text: run,
    access: { principal, personId: "r5-load" }
  });
  const retrieveMs = performance.now() - started;
  const old = await provider.knowledge.detail(scope, a.ack.eventId!);
  const current = await provider.knowledge.detail(scope, b.ack.eventId!);
  const tea = await provider.knowledge.detail(scope, unrelated.ack.eventId!);
  if (
    old?.state !== "superseded" ||
    current?.state !== "current" ||
    tea?.state !== "current" ||
    retrieval.events.some((e) => e.id === a.ack.eventId)
  )
    throw new Error("Incremental semantic state violated");
  const result = {
    sourceSHA: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    backgroundRecords: background,
    commitMs: { a: a.elapsedMs, independent: unrelated.elapsedMs, b: b.elapsedMs },
    retrieveMs,
    oldState: old.state,
    newState: current.state,
    unrelatedState: tea.state,
    retrievalStatus: retrieval.status,
    selectedIds: retrieval.events.map((e) => e.id),
    limitations:
      "single deterministic correction; synthetic index background; no LLM quality or sustained concurrent write SLO"
  };
  await writeFile(process.argv[2] ?? "/tmp/r5-incremental.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
