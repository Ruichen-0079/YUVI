/** Real immediate PostgreSQL process stops on an OWN cluster only. Deterministic delivery fixtures,
 * not semantic quality evidence. Lost COMMIT receipt injected AFTER actual COMMIT and process stop.
 */
import pg from "pg";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  PostgresMemoryAuthority,
  PostgresMemoryProvider,
  MemoryVectorIndexer,
  embeddingModelTag,
  readSqlMigrations,
  applySqlMigrations,
  buildMemoryScope,
  MemoryKnowledgeReader,
  enqueueVectorIndexBatch
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
const root = process.env["YUVI_R5_FAULT_ROOT"],
  url = process.env["DATABASE_URL"];
if (
  root !== "/home/ruichen/.local/state/yuvi-runtime-memory-r5-phase2" ||
  !url ||
  new URL(url).port !== "31508" ||
  new URL(url).pathname !== "/yuvi_runtime_r5p2_scale"
)
  throw Error("Explicit own scale cluster required");
const cluster = root + "/scale-pg",
  bin = "/home/ruichen/.local/opt/yuvi-p8-postgresql-16.15/bin/pg_ctl";
async function stop() {
  const pidfile = (await readFile(cluster + "/postmaster.pid", "utf8")).split("\n");
  if (pidfile[1] !== cluster || pidfile[3] !== "31508") throw Error("Cluster ownership mismatch");
  execFileSync(bin, ["-D", cluster, "stop", "-m", "immediate", "-w"], { stdio: "pipe" });
}
function start() {
  execFileSync(bin, ["-D", cluster, "-l", root + "/scale-pg.log", "start", "-w"], {
    stdio: "pipe"
  });
}
const report: any = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  fixture: "deterministic delivery only; no semantic model",
  cases: []
};
const person = "fault-" + randomUUID(),
  scope = buildMemoryScope(person, "fault-isolated");
const embedding = {
  name: "synthetic-fault-contract",
  model: "not-semantic-quality",
  dimensions: 512,
  mock: false,
  embedText: async () => Array.from({ length: 512 }, (_, i) => Math.sin(i + 1))
};
let pool = new pg.Pool({ connectionString: url, max: 4 }),
  authority = new PostgresMemoryAuthority(pool, embeddingModelTag(embedding)),
  provider = new PostgresMemoryProvider(authority);
async function reopen() {
  await pool.end().catch(() => {});
  start();
  pool = new pg.Pool({ connectionString: url, max: 4 });
  authority = new PostgresMemoryAuthority(pool, embeddingModelTag(embedding));
  provider = new PostgresMemoryProvider(authority);
}
async function event(content: string) {
  const source = await finalizedTestResolver.resolve({
    sourceJournalRef: finalizedTestParent,
    sourceText: content
  });
  source.authority = {
    principal: {
      state: "RESOLVED",
      kind: "PRINCIPAL",
      namespace: "isolated-fault",
      actorId: "synthetic"
    },
    binding: { state: "RESOLVED", kind: "PERSON_BINDING", personId: person, bindingVersion: "1" },
    audience: { kind: "PRIVATE", channelRef: "isolated" }
  };
  const semantic = freezeFinalizedMemoryEvent(
    source,
    { scope, kind: "fact", content },
    "fault-delivery.v1"
  );
  return {
    ...semantic,
    idempotencyKey: randomUUID(),
    payloadDigest: lineageDigest(canonicalLineageJson(semantic))
  };
}
function faultProvider(stage: "before-commit" | "after-commit") {
  const wrapper = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const c = await target.connect(),
            query = c.query.bind(c),
            original = c.query,
            release = c.release.bind(c);
          c.release = () => {
            c.query = original;
            c.release = release;
            release();
          };
          c.query = (async (...args: any[]) => {
            if (String(args[0]).toLowerCase() === "commit") {
              if (stage === "before-commit") {
                await stop();
                throw Error("database stopped with uncommitted transaction");
              }
              await (query as any)(...args);
              await stop();
              throw Error("committed receipt lost before caller observed it");
            }
            return (query as any)(...args);
          }) as any;
          return c;
        };
      return Reflect.get(target, key, target);
    }
  });
  return new PostgresMemoryProvider(
    new PostgresMemoryAuthority(wrapper, embeddingModelTag(embedding))
  );
}
try {
  await applySqlMigrations(pool, await readSqlMigrations());
  for (const stage of ["before-commit", "after-commit"] as const) {
    const input = await event("Durable " + stage);
    await provider.prepareEvidence!("FINALIZED_INGESTION", input);
    const bad = faultProvider(stage);
    const result = await bad.writeEventIdempotent(input);
    if (result.failureClass !== "ambiguous") throw Error("transport failure must be unknown");
    const down = await provider.reconcileEvent({
      scope,
      idempotencyKey: input.idempotencyKey,
      payloadDigest: input.payloadDigest
    });
    if (down.status !== "unknown") throw Error("down DB must not claim absent");
    await reopen();
    const reconciled = await provider.reconcileEvent({
      scope,
      idempotencyKey: input.idempotencyKey,
      payloadDigest: input.payloadDigest
    });
    if (reconciled.status !== (stage === "before-commit" ? "not_applied" : "applied"))
      throw Error("unexpected durable state " + JSON.stringify(reconciled));
    const replay = await provider.writeEventIdempotent(input);
    if (replay.status !== (stage === "before-commit" ? "written" : "unchanged"))
      throw Error("replay invariant");
    report.cases.push({
      stage,
      result,
      down,
      reconciled,
      replay: { status: replay.status, eventId: replay.eventId }
    });
  }
  let failures = true;
  const index = new MemoryVectorIndexer(authority, {
    ...embedding,
    embedText: async () => {
      if (failures) throw Error("injected unavailable vector provider");
      return embedding.embedText();
    }
  });
  await index.runOnce();
  const jobs = (
    await pool.query("select status,error_code from memory_authority_index_jobs where scope=$1", [
      scope
    ])
  ).rows;
  if (jobs.some((j) => j.status !== "retryable_failed")) throw Error("must retain index failures");
  failures = false;
  await pool.query("update memory_authority_index_jobs set next_attempt_at=now() where scope=$1", [
    scope
  ]);
  await index.runOnce();
  const before = (
    await pool.query("select count(*) from memory_authority_vectors where scope=$1", [scope])
  ).rows[0].count;
  await pool.query("delete from memory_authority_vectors where scope=$1", [scope]);
  await enqueueVectorIndexBatch(authority, scope, index.modelTag, "0", 100);
  await index.runOnce();
  const after = (
    await pool.query("select count(*) from memory_authority_vectors where scope=$1", [scope])
  ).rows[0].count;
  if (before !== "2" || after !== "2") throw Error("index repair failed");
  report.cases.push({ stage: "vector-unavailable-and-corruption-repair", jobs, before, after });
  report.final = await new MemoryKnowledgeReader(pool).overview(scope);
  if (report.final.records !== "2" || report.final.current !== "2")
    throw Error("final authority counts wrong");
  report.status = "VERIFIED_ISOLATED_PROCESS_CRASH_AND_REPLAY";
} finally {
  await pool.end().catch(() => {});
  await writeFile(root + "/database-faults.json", JSON.stringify(report, null, 2), { mode: 0o600 });
}
