/** No Git branch merges. Only unique disposable synthetic databases on 31508. */
import pg from "pg";
import { writeFile, readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { PostgresJournalRepository } from "../../../../packages/journal/src/index.js";
import { ConversationHostIdentity } from "../../../../apps/server/src/conversation-host-identity.js";
import {
  HostConversationalReceiptAdmission,
  toConversationalJournalRef
} from "../../../../apps/server/src/conversational-receipt-admission.js";
import {
  PostgresMemoryAuthority,
  MemoryKnowledgeReader,
  MemoryProjectionRebuild,
  MemoryIntegrityAudit,
  JournalMemoryGroundingResolver,
  applySqlMigrations,
  readSqlMigrations,
  advanceLexicalIndex,
  rebuildLexicalIndex,
  verifyLexicalIndex
} from "../../../../packages/memory/src/index.js";
import { freezeFinalizedMemoryEvent } from "../../../../packages/memory/src/finalized-memory-lineage.js";
import {
  canonicalLineageJson,
  lineageDigest
} from "../../../../packages/memory/src/lineage-encoding.js";
const base = process.env.DATABASE_URL!,
  out = process.env.YUVI_INTEGRATION_OUTPUT!,
  stackFile = process.env.YUVI_STACK_FILE!,
  bin = process.env.YUVI_PG_BIN!;
if (
  !base ||
  new URL(base).hostname !== "127.0.0.1" ||
  new URL(base).port !== "31508" ||
  !new URL(base).pathname.startsWith("/yuvi_pr_") ||
  !out ||
  !stackFile ||
  !bin
)
  throw Error("Explicit isolated integration parameters required");
const id = randomUUID().replaceAll("-", ""),
  name = "yuvi_pr_stack_" + id,
  restoredName = "yuvi_pr_restored_" + id;
const dbUrl = (name: string) => {
  const u = new URL(base);
  u.pathname = "/" + name;
  return u.toString();
};
const admin = new pg.Pool({ connectionString: base }),
  pool = new pg.Pool({ connectionString: dbUrl(name), max: 6 });
let restored: pg.Pool | undefined;
const report: any = {
  schema: "yuvi.stack-integration.v1",
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  started: new Date().toISOString(),
  databases: { name, restoredName },
  stages: [],
  notes: [
    "Synthetic complete database backup, not an installed Alice backup; no production files, credentials, external effects or private content.",
    "Main legacy runner SQL order is reproduced without a ledger. New runner is used for subsequent stages. No Git refs are merged."
  ]
};
async function save() {
  await writeFile(out, JSON.stringify(report, null, 2));
}
function at(sha: string) {
  const names = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", sha, "packages/memory/migrations"],
    { encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter((n) => n.endsWith(".sql"))
    .sort();
  return names.map((n) => ({
    name: n.split("/").at(-1)!,
    sql: execFileSync("git", ["show", sha + ":" + n], { encoding: "utf8", maxBuffer: 4e6 })
  }));
}
async function signature(db: pg.Pool) {
  return (
    await db.query(
      `select (select md5(string_agg(id||event::text||version::text,'' order by id)) from memory_authority_records) history,(select md5(string_agg(scope||projection_generation::text||version::text,'' order by scope)) from memory_authority_scopes) generations,(select count(*)::int from memory_authority_records) history_count,(select count(*)::int from journal_events) journal_count,(select count(*)::int from memory_lexical_postings) posting_count,(select md5(string_agg(content,'' order by id)) from memories) legacy_digest`
    )
  ).rows[0];
}
try {
  await admin.query("create database " + name);
  await admin.query("create database " + restoredName);
  for (const extension of ["vector", "pgcrypto", "pg_trgm"])
    await pool.query("create extension if not exists " + extension + " with schema public");
  const main = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim(),
    stack = JSON.parse(await readFile(stackFile, "utf8"));
  let previous = main;
  for (const r of stack) {
    const ancestor = (() => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", previous, r.headRefOid]);
        return true;
      } catch {
        return false;
      }
    })();
    const tree = execFileSync("git", ["merge-tree", "--write-tree", previous, r.headRefOid], {
      encoding: "utf8"
    })
      .trim()
      .split("\n")[0];
    report.stages.push({
      pr: r.number,
      base: r.baseRefName,
      head: r.headRefOid,
      draft: r.isDraft,
      ancestor,
      simulatedMergeTree: tree,
      headTree: execFileSync("git", ["rev-parse", r.headRefOid + "^{tree}"], {
        encoding: "utf8"
      }).trim()
    });
    previous = r.headRefOid;
  }
  const mainMigrations = at(main);
  await pool.query("select set_config('yuvi.memory_vector_index_enabled','false',false)");
  for (const m of mainMigrations) await pool.query(m.sql);
  await pool.query(
    "insert into memories(type,content,source,scope,persona_id,subject_user_id) values('semantic','Synthetic legacy record survives upgrade','integration-fixture','user','legacy-persona','legacy-person')"
  );
  report.main = {
    sha: main,
    migrations: mainMigrations.map((m) => ({
      name: m.name,
      digest: createHash("sha256").update(m.sql).digest("hex")
    })),
    ledgerExisted: (
      await pool.query("select to_regclass('yuvi_schema_migrations') is not null present")
    ).rows[0].present
  };
  for (const stage of report.stages) {
    const before = performance.now(),
      migrations = at(stage.head);
    stage.applied = await applySqlMigrations(pool, migrations, {
      "yuvi.memory_vector_index_enabled": "false"
    });
    stage.elapsedMs = performance.now() - before;
    await save();
  }
  const migrations = await readSqlMigrations();
  report.finalReplay = await applySqlMigrations(pool, migrations);
  report.migrations = migrations.map((m) => ({
    name: m.name,
    digest: createHash("sha256").update(m.sql).digest("hex")
  }));
  const authority = new PostgresMemoryAuthority(pool),
    reader = new MemoryKnowledgeReader(pool),
    scope = "yuvi:v1:user:stack-person:character:stack-persona";
  const journal = new PostgresJournalRepository(pool, {
      namespace: "stack-integration",
      authorityBuilder() {
        throw Error("Host required");
      }
    }),
    host = new ConversationHostIdentity(
      pool,
      journal,
      { instanceId: "stack-persona", personaId: "stack-persona" },
      (id) => (id === "stack-person" ? "1" : null)
    ),
    ingress = new HostConversationalReceiptAdmission(journal, undefined, host),
    token = (await host.issue("stack-person")).token;
  async function write(content: string, changes: any = {}, writer = authority) {
    const sessionId = randomUUID(),
      identity = await host.authorize(
        { headers: { authorization: "Bearer " + token } },
        { sessionId }
      );
    const receipt = await ingress.admit({
      surface: "HTTP_MESSAGE",
      sessionId,
      runtimeEventId: randomUUID(),
      content,
      hostIdentity: identity!
    });
    const source = await new JournalMemoryGroundingResolver(journal).resolve({
      sourceJournalRef: toConversationalJournalRef(receipt.envelope),
      sourceText: content
    });
    const semantic = freezeFinalizedMemoryEvent(
      source,
      {
        scope,
        kind: changes.supersedes ? "correction" : "fact",
        content,
        assertion: { source: "user", verification: "unverified" },
        ...changes
      },
      "integration-protocol"
    );
    const input = {
      ...semantic,
      idempotencyKey: randomUUID(),
      payloadDigest: lineageDigest(canonicalLineageJson(semantic))
    };
    await writer.prepare("FINALIZED_INGESTION", input);
    const t = performance.now();
    const r = await writer.commit(input);
    return { id: r.event.id, commitMs: performance.now() - t };
  }
  const old = await write("amber spruce long-lived co-occurrence target");
  let writes = [];
  for (let n = 0; n < 160; n++)
    writes.push(
      await write(
        n % 2 ? "amber unrelated recent record " + n : "spruce unrelated recent record " + n
      )
    );
  const bounded = await reader.search(scope, "amber spruce", 8);
  const t = performance.now(),
    prototype = await pool.query(
      "explain (analyze,buffers,format json) select id from memory_authority_current where scope=$1 and search @@ plainto_tsquery('simple',$2) order by version desc,id limit 8",
      [scope, "amber spruce"]
    );
  const conjunction = await pool.query(
    "select id from memory_authority_current where scope=$1 and search @@ plainto_tsquery('simple',$2) order by version desc,id limit 8",
    [scope, "amber spruce"]
  );
  report.oldFrequent = {
    targetId: old.id,
    currentState: (await reader.detail(scope, old.id))?.state,
    boundedFound: bounded.records.some((r) => r.id === old.id),
    boundedLimited: bounded.candidateLimited,
    conjunctionPrototypeFound: conjunction.rows.some((r) => r.id === old.id),
    prototypeElapsedMs: performance.now() - t,
    prototypePlan: prototype.rows[0],
    note: "Conjunctive GIN is a diagnostic prototype, not shipped. Broad conjunction still has potentially unbounded matching/sort cost."
  };
  const long =
    "长中文" +
    Array.from({ length: 1600 }, (_, i) => String.fromCharCode(0x4e00 + i)).join("") +
    " 长文尾部标记LONGTAIL_9762";
  const longSaved = await write(long);
  const tail = await reader.search(scope, "LONGTAIL_9762", 8);
  report.longText = {
    chars: long.length,
    postingCount: (
      await pool.query(
        "select count(*)::int n from memory_lexical_postings where scope=$1 and id=$2",
        [scope, longSaved.id]
      )
    ).rows[0].n,
    tailFound: tail.records.some((r) => r.id === longSaved.id),
    note: "Known term-bound omission; no claim of full long-record indexing."
  };
  let current = (await write("Current configuration revision 0")).id;
  for (let n = 1; n <= 12; n++)
    current = (await write("Current configuration revision " + n, { supersedes: [current] })).id;
  const size = async () => ({
    postings: (
      await pool.query("select count(*)::int n from memory_lexical_postings where scope=$1", [
        scope
      ])
    ).rows[0].n,
    relationBytes: (
      await pool.query("select pg_total_relation_size('memory_lexical_postings')::text bytes")
    ).rows[0].bytes,
    states: (
      await pool.query(
        "select state,count(*)::int n from memory_authority_current where scope=$1 group by state",
        [scope]
      )
    ).rows
  });
  const rebuild = new MemoryProjectionRebuild(authority);
  report.beforeShadow = await size();
  let state = await rebuild.start(scope, "shadow-integrate", "synthetic-operator");
  state = await rebuild.advance(scope, state.id, 40);
  await rebuild.pause(scope, state.id, true);
  report.interruptedShadow = await rebuild.status(scope, state.id);
  await rebuild.pause(scope, state.id, false);
  while (state.status !== "ACTIVE") state = await rebuild.advance(scope, state.id, 40);
  report.afterShadow = { state, size: await size() };
  let retired;
  do {
    retired = await rebuild.retire(scope, "adopted-generation-1", 40);
  } while (retired.status !== "RETIRED");
  report.afterRetirement = await size();
  await pool.query("delete from memory_lexical_postings where scope=$1 and id=$2", [
    scope,
    current
  ]);
  report.corruption = await verifyLexicalIndex(authority, scope, "", 200, "synthetic-operator");
  let progress = await rebuildLexicalIndex(authority, scope, "synthetic-operator");
  progress = await advanceLexicalIndex(authority, scope, 30);
  report.interruptedLexical = progress;
  await write("Concurrent write during lexical recovery marker RESUME_38");
  while (progress.status !== "READY") progress = await advanceLexicalIndex(authority, scope, 30);
  report.repaired = await verifyLexicalIndex(authority, scope, "", 200, "synthetic-operator");
  await rebuildLexicalIndex(authority, scope, "synthetic-operator");
  const readTimes: number[] = [],
    writeTimes: number[] = [],
    waitSamples: any[] = [];
  let running = true;
  const observer = (async () => {
    while (running) {
      waitSamples.push(
        ...(
          await pool.query(
            "select wait_event_type,wait_event,count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' group by wait_event_type,wait_event"
          )
        ).rows
      );
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  const readers = (async () => {
    for (let n = 0; n < 40; n++) {
      const t = performance.now();
      const r = await reader.search(scope, "RESUME_38", 5);
      if (!r.records.length) throw Error("Concurrent read lost a confirmed source");
      readTimes.push(performance.now() - t);
    }
  })();
  let batch: any;
  do {
    const [b, w] = await Promise.all([
      advanceLexicalIndex(authority, scope, 20),
      (async () => {
        const t = performance.now();
        const w = await write("Continuous write concurrency marker " + randomUUID());
        writeTimes.push(performance.now() - t);
        if ((await reader.detail(scope, w.id))?.state !== "current")
          throw Error("Read-your-write failed");
        return w;
      })()
    ]);
    batch = b;
  } while (batch.status !== "READY");
  await readers;
  running = false;
  await observer;
  const stats = (v: number[]) => {
    const r = [...v].sort((a, b) => a - b);
    return {
      n: r.length,
      p50: r[Math.floor(r.length * 0.5)],
      p95: r[Math.floor(r.length * 0.95)],
      max: r.at(-1)
    };
  };
  report.concurrentBackfill = {
    reads: stats(readTimes),
    writesIncludingJournalAndAdmission: stats(writeTimes),
    lockSamples: waitSamples,
    note: "Short burst on an isolated small scope; 5ms sampler can miss locks. Not a long-running SLO."
  };
  await pool.query("select pg_stat_force_next_flush()");
  report.postingStatisticsBeforeVacuum = (
    await pool.query(
      "select n_tup_ins,n_tup_upd,n_tup_del,n_live_tup,n_dead_tup,vacuum_count,autovacuum_count from pg_stat_user_tables where relname='memory_lexical_postings'"
    )
  ).rows[0];
  await pool.query("vacuum (analyze) memory_lexical_postings");
  report.afterVacuum = await size();
  report.concurrentIndexVerified = await verifyLexicalIndex(
    authority,
    scope,
    "",
    200,
    "synthetic-operator"
  );
  const audit = new MemoryIntegrityAudit(authority, journal);
  await audit.start(scope, "backup-source-audit");
  let auditState = await audit.advance(scope, "backup-source-audit", 50);
  while (auditState?.status === "RUNNING")
    auditState = await audit.advance(scope, "backup-source-audit", 50);
  report.sourceAudit = auditState;
  report.writeLatency = {
    n: writes.length,
    p50: writes.map((x) => x.commitMs).sort((a, b) => a - b)[Math.floor(writes.length * 0.5)],
    p95: writes.map((x) => x.commitMs).sort((a, b) => a - b)[Math.floor(writes.length * 0.95)]
  };
  report.beforeBackup = await signature(pool);
  const backup = out + ".dump",
    started = performance.now();
  execFileSync(bin + "/pg_dump", ["--format=custom", "--file=" + backup, dbUrl(name)]);
  report.backup = { bytes: (await stat(backup)).size, elapsedMs: performance.now() - started };
  execFileSync(bin + "/pg_restore", [
    "--exit-on-error",
    "--no-owner",
    "--no-acl",
    "--dbname=" + dbUrl(restoredName),
    backup
  ]);
  restored = new pg.Pool({ connectionString: dbUrl(restoredName) });
  report.afterRestore = await signature(restored);
  report.restoreMatches =
    JSON.stringify(report.beforeBackup) === JSON.stringify(report.afterRestore);
  report.restoredIndex = await verifyLexicalIndex(
    new PostgresMemoryAuthority(restored),
    scope,
    "",
    200,
    "synthetic-operator"
  );
  report.restoreMigrationReplay = await applySqlMigrations(restored, migrations);
  try {
    for (const m of at(stack.find((r: any) => r.number === 325).headRefOid))
      await restored.query(m.sql);
    report.oldRunnerReplay = { unexpectedSuccess: true };
  } catch (error: any) {
    report.oldRunnerReplay = {
      code: error.code,
      message: error.message,
      note: "Only disposable restored database. Old runner is not a rollback mechanism."
    };
  }
  const amplification: any[] = [];
  const measured = new PostgresMemoryAuthority({
    query: (sql, values) => pool.query(sql, values),
    connect: async () => {
      const c = await pool.connect();
      return {
        release: () => c.release(),
        on: (event, listener) => {
          c.on(event, listener);
        },
        query: async (sql, values) => {
          if (sql.trim().toLowerCase() === "commit") {
            const r = (
              await c.query(
                "select pg_stat_get_xact_tuples_inserted('memory_lexical_postings'::regclass::oid)::int lexical_inserted,pg_stat_get_xact_tuples_deleted('memory_lexical_postings'::regclass::oid)::int lexical_deleted,pg_stat_get_xact_tuples_inserted('memory_authority_records'::regclass::oid)::int history_inserted"
              )
            ).rows[0];
            if (r.history_inserted) amplification.push(r);
          }
          return c.query(sql, values);
        }
      };
    }
  });
  const short = await write("Write amplification probe WAMP_137", {}, measured);
  await write("Write amplification current WAMP_932", { supersedes: [short.id] }, measured);
  await write(long + " AMP_LONG_31", {}, measured);
  report.writeAmplificationAfterBackup = {
    backendLocalCountersBeforeCommit: amplification,
    note: "Raw backend-local counters observed before COMMIT may include unflushed prior transactions (observed history_inserted 1,2,3). They are NOT three independent per-transaction measurements or WAL amplification. Additional confirmed writes AFTER the verified backup checkpoint; earlier snapshot signatures remain asOf that checkpoint."
  };
  await save();
} catch (error) {
  report.error = String(error);
  await save();
  throw error;
} finally {
  await pool.end();
  await restored?.end();
  await admin.end();
}
