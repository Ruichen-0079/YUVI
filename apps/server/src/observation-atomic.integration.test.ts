import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "@companion/database";
import { applySqlMigrations, readSqlMigrations } from "@companion/memory";
import { PostgresJournalRepository } from "@companion/journal";
import {
  HostEffectIntentAdmission,
  PostgresEffectIntentStore,
  PostgresEffectDispatchStore,
  EffectDispatcher,
  type EffectAdapter
} from "@companion/effects";
import {
  effectRequest,
  effectAuthority,
  fixtureIdentity
} from "../../../packages/effects/src/test-fixture.js";
import { actualReadEvidence, reportProjection } from "./test-support/observation-atomic.js";
type Pool = ReturnType<typeof createPostgresPool>;
const url = process.env["YUVI_PRODUCTION_PATH_TEST_DATABASE_URL"];
const evidence: Record<string, unknown>[] = [];
const schema = "ob_atomic_" + randomUUID().replaceAll("-", "");
let admin: Pool,
  db: Pool,
  admission: HostEffectIntentAdmission,
  source: ReturnType<typeof effectRequest>["causalRefs"][number],
  connection: string,
  directory: string;
function adapter(invoke: EffectAdapter["invoke"]): EffectAdapter {
  return {
    contractRef: "yuvi.read-text.v1",
    adapter: "yuvi.local-read-text.v1",
    isCurrent: () => true,
    invoke
  };
}
async function admit() {
  const request = {
    ...effectRequest("atomic:" + randomUUID()),
    contractRef: "yuvi.read-text.v1" as const,
    causalRefs: [source],
    payload: { path: "synthetic-owned-file" }
  };
  const auth = effectAuthority();
  auth.snapshot.permissions = ["RUNTIME_AUTHORIZED_PATH_READ"];
  return admission.admit(request, auth);
}
describe.skipIf(!url)("A9/report atomic contract on real PostgreSQL and Dispatcher", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !(
        (process.env["CI"] === "true" &&
          ["/yuvi_smoke", "/yuvi_conformance"].includes(parsed.pathname)) ||
        (parsed.hostname === "127.0.0.1" &&
          parsed.port === "31508" &&
          parsed.pathname.startsWith("/yuvi_pr_"))
      )
    )
      throw Error("Isolated database required");
    admin = createPostgresPool(url!);
    await admin.query(`create schema "${schema}"`);
    parsed.searchParams.set("options", `-c search_path=${schema},public`);
    connection = parsed.toString();
    db = createPostgresPool(connection);
    db.on("connect", (client: { on(event: string, listener: () => void): unknown }) =>
      client.on("error", () => {})
    ); // deliberate backend termination is asserted below
    await applySqlMigrations(db, await readSqlMigrations());
    const journal = new PostgresJournalRepository(db, {
      namespace: schema,
      authorityBuilder() {
        throw Error("Host only");
      }
    });
    const receipt = await journal.appendWithHostAuthority(
      {
        command: {
          version: "life-event-command.v1",
          kind: "RECEIPT",
          occurrenceTime: { state: "UNKNOWN" },
          causalParents: [],
          data: { receiptClass: "CONTROL", evidenceSelectors: [] }
        }
      },
      {
        ...fixtureIdentity,
        surface: { kind: "LOCAL", reference: "atomic-test" },
        correlations: [],
        policyVersion: "atomic-test.v1",
        producer: { name: "atomic-test", version: "1" },
        sourceReferences: [{ kind: "UNRESOLVED_SOURCE", reason: "isolated protocol experiment" }],
        payloads: []
      }
    );
    source = { kind: "JOURNAL_EVENT", namespace: schema, eventId: receipt.envelope.eventId };
    admission = new HostEffectIntentAdmission(new PostgresEffectIntentStore(db), journal);
    directory = await mkdtemp(join(tmpdir(), "yuvi-observation-atomic-"));
  });
  afterAll(async () => {
    const archive = process.env["YUVI_PRODUCTION_PATH_EVIDENCE_DIRECTORY"];
    if (archive) {
      await mkdir(archive, { recursive: true });
      await writeFile(
        join(archive, "observation-atomic.json"),
        JSON.stringify(
          {
            schema: "observation.atomic-verification.v1",
            kind: "actual-postgresql-production-dispatcher-host-fixture",
            cases: evidence
          },
          null,
          2
        )
      );
    }
    await db?.end();
    if (admin) {
      await admin.query(`drop schema "${schema}" cascade`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  for (const stage of ["before-start", "after-adapter", "in-projection", "after-commit"] as const) {
    it(`SIGKILL ${stage}: committed truth survives, ambiguous execution is never replayed`, async () => {
      const intent = await admit();
      const path = join(directory, stage + ".txt");
      await writeFile(path, "PRIVATE_SYNTHETIC_" + randomUUID());
      const child = spawn(
        process.execPath,
        [
          "--conditions=development",
          "--import",
          "tsx",
          resolve("src/test-support/observation-atomic-child.ts"),
          intent.intentId,
          path,
          stage
        ],
        {
          env: { PATH: process.env["PATH"], YUVI_ATOMIC_CHILD_DATABASE_URL: connection },
          stdio: ["ignore", "pipe", "pipe", "ipc"]
        }
      );
      let log = "";
      child.stderr?.on("data", (chunk) => {
        log += chunk;
      });
      try {
        await new Promise<void>((done, reject) => {
          const timeout = setTimeout(() => reject(Error("Checkpoint timeout " + log)), 15000);
          child.once("message", () => {
            clearTimeout(timeout);
            done();
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            reject(Error("Early exit " + code + log));
          });
        });
        const ended = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await ended;
        // Closing the killed process's connection rolls back an in-flight report + terminal transaction.
        const store = new PostgresEffectDispatchStore(db);
        const before = await store.diagnostic(intent.intentId);
        expect(before?.currentAttempt).toBeTruthy();
        expect(before?.evidence?.certainty).toBe(stage === "after-commit" ? "APPLIED" : undefined);
        const reports = await db.query("select * from retained_observations where attempt_id=$1", [
          before!.currentAttempt!.attemptId
        ]);
        expect(reports.rows).toHaveLength(stage === "after-commit" ? 1 : 0);
        const count = (await readFile(path + ".calls", "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean).length;
        expect(count).toBe(stage === "before-start" ? 0 : 1);
        await db.query(
          "update effect_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where intent_id=$1",
          [intent.intentId]
        );
        let reinvoked = 0;
        const recovering = new EffectDispatcher(store, [
          adapter(async (i, a) => {
            reinvoked++;
            return {
              evidence: actualReadEvidence,
              projection: reportProjection(a.attemptId, source, await readFile(path, "utf8"))
            };
          })
        ]);
        await recovering.run(intent.intentId);
        await recovering.shutdown();
        expect(reinvoked).toBe(stage === "before-start" ? 1 : 0); // Only a proven unstarted attempt is safely invoked.
        const recovered = await store.diagnostic(intent.intentId);
        expect(recovered?.evidence?.certainty).toBe(
          stage === "after-commit" || stage === "before-start" ? "APPLIED" : "UNKNOWN"
        );
        evidence.push({
          stage,
          adapterCallsBeforeRecovery: count,
          adapterCallsDuringRecovery: reinvoked,
          certainty: recovered?.evidence?.certainty,
          reportsAfterCrash: reports.rows.length
        });
        expect(recovered?.evidence?.reportRetention?.state).toBe(
          stage === "after-commit" || stage === "before-start" ? "STORED" : undefined
        );
      } finally {
        child.kill("SIGKILL");
      }
    }, 25000);
  }
  it("lost terminal COMMIT response resolves from PostgreSQL; deletion and divergent replay cannot resurrect content", async () => {
    const intent = await admit();
    let invoked = 0,
      dropped = false;
    const faultyPool = {
      query: db.query.bind(db),
      async connect() {
        const client = await db.connect();
        let terminal = false;
        return {
          async query(sql: string, values?: unknown[]) {
            if (sql.includes("insert into effect_observations")) terminal = true;
            const result = await client.query(sql, values);
            if (sql.toLowerCase() === "commit" && terminal && !dropped) {
              dropped = true;
              throw Error("ECONNRESET after server COMMIT");
            }
            return result;
          },
          release() {
            client.release();
          }
        };
      }
    } as unknown as Pool;
    const store = new PostgresEffectDispatchStore(faultyPool);
    const dispatcher = new EffectDispatcher(store, [
      adapter(async (i, a) => {
        invoked++;
        return {
          evidence: actualReadEvidence,
          transientResult: "synthetic-content",
          projection: reportProjection(a.attemptId, source, "synthetic-content")
        };
      })
    ]);
    expect(await dispatcher.run(intent.intentId)).toMatchObject({
      invoked: true,
      recorded: true,
      transientResult: "synthetic-content"
    });
    expect(dropped).toBe(true);
    const d = (await store.diagnostic(intent.intentId))!;
    expect(d.evidence?.reportRetention?.state).toBe("STORED");
    evidence.push({
      stage: "lost-commit-response-and-erasure-replay",
      certainty: d.evidence?.certainty,
      retention: d.evidence?.reportRetention?.state,
      adapterCalls: invoked
    });
    await db.query(
      "update retained_observations set erased_at=now(),erased_by_source=$2,evidence=null,image_bytes=null where attempt_id=$1",
      [d.currentAttempt!.attemptId, source]
    );
    expect(await store.record(d.currentAttempt!, d.evidence!)).toBe("REPLAY");
    expect(
      await store.record(
        d.currentAttempt!,
        actualReadEvidence,
        reportProjection(d.currentAttempt!.attemptId, source, "different-private-content")
      )
    ).toBe("CONFLICT");
    expect(
      await store.record(
        d.currentAttempt!,
        actualReadEvidence,
        reportProjection(d.currentAttempt!.attemptId, source, "synthetic-content")
      )
    ).toBe("REPLAY");
    expect((await dispatcher.run(intent.intentId)).invoked).toBe(false);
    expect(invoked).toBe(1);
    const row = (
      await db.query(
        "select evidence,image_bytes,erased_at from retained_observations where attempt_id=$1",
        [d.currentAttempt!.attemptId]
      )
    ).rows[0];
    expect(row).toMatchObject({ evidence: null, image_bytes: null });
    expect(row.erased_at).not.toBeNull();
    expect((await store.diagnostic(intent.intentId))?.evidence?.certainty).toBe("APPLIED");
    await dispatcher.shutdown();
  });
  it("a deferred cross-reference failure cannot commit a forged STORED disposition", async () => {
    const intent = await admit(),
      store = new PostgresEffectDispatchStore(db);
    const dispatcher = new EffectDispatcher(store, [
      adapter(async (i, a) => {
        const p = reportProjection(a.attemptId, source, "BOUND_REPORT");
        return {
          evidence: actualReadEvidence,
          projection: {
            digest: p.digest,
            async commit(tx) {
              const r = await p.commit(tx);
              return { ...r, reportId: "ob1_" + "0".repeat(64) };
            }
          }
        };
      })
    ]);
    expect((await dispatcher.run(intent.intentId)).recorded).toBe(true);
    const d = (await store.diagnostic(intent.intentId))!;
    expect(d.evidence).toMatchObject({
      certainty: "APPLIED",
      reportRetention: { state: "FAILED" }
    });
    expect(
      (
        await db.query("select * from retained_observations where attempt_id=$1", [
          d.currentAttempt!.attemptId
        ])
      ).rows
    ).toHaveLength(0);
    evidence.push({
      stage: "deferred-reference-check",
      certainty: d.evidence?.certainty,
      retention: d.evidence?.reportRetention?.state,
      reports: 0
    });
    await dispatcher.shutdown();
  });
  it("SQL failure rolls back private contents but commits explicit APPLIED / retention FAILED", async () => {
    const intent = await admit();
    let invoked = 0;
    const store = new PostgresEffectDispatchStore(db);
    const dispatcher = new EffectDispatcher(store, [
      adapter(async (i, a) => {
        invoked++;
        const p = reportProjection(a.attemptId, source, "PRIVATE_REPORT_SQL_FAILURE");
        return {
          evidence: actualReadEvidence,
          projection: {
            digest: p.digest,
            async commit(tx) {
              await p.commit(tx);
              await tx.query("select 1/0");
              throw Error("unreachable");
            }
          }
        };
      })
    ]);
    expect((await dispatcher.run(intent.intentId)).recorded).toBe(true);
    const d = (await store.diagnostic(intent.intentId))!;
    expect(d.evidence).toMatchObject({
      certainty: "APPLIED",
      reportRetention: { state: "FAILED", reason: "REPORT_PERSISTENCE_FAILED" }
    });
    expect(
      (
        await db.query("select * from retained_observations where attempt_id=$1", [
          d.currentAttempt!.attemptId
        ])
      ).rows
    ).toHaveLength(0);
    expect(
      JSON.stringify(
        (
          await db.query("select evidence from effect_observations where attempt_id=$1", [
            d.currentAttempt!.attemptId
          ])
        ).rows
      )
    ).not.toContain("PRIVATE_REPORT_SQL_FAILURE");
    await dispatcher.run(intent.intentId);
    expect(invoked).toBe(1);
    evidence.push({
      stage: "report-sql-failure",
      certainty: d.evidence?.certainty,
      retention: d.evidence?.reportRetention?.state,
      adapterCalls: invoked,
      reports: 0
    });
    await dispatcher.shutdown();
  });
  it("connection termination before terminal COMMIT cannot leave a STORED receipt or report behind", async () => {
    const intent = await admit();
    const store = new PostgresEffectDispatchStore(db);
    let invoked = 0;
    const dispatcher = new EffectDispatcher(store, [
      adapter(async (i, a) => {
        invoked++;
        const p = reportProjection(a.attemptId, source, "PRIVATE_TERMINATED_REPORT");
        return {
          evidence: actualReadEvidence,
          projection: {
            digest: p.digest,
            async commit(tx) {
              await p.commit(tx);
              const pid = (await tx.query("select pg_backend_pid() pid")).rows[0].pid;
              await db.query("select pg_terminate_backend($1)", [pid]);
              throw Error("connection terminated");
            }
          }
        };
      })
    ]);
    expect((await dispatcher.run(intent.intentId)).recorded).toBe(false);
    const d = (await store.diagnostic(intent.intentId))!;
    expect(d.evidence).toBeNull();
    expect(
      (
        await db.query("select * from retained_observations where attempt_id=$1", [
          d.currentAttempt!.attemptId
        ])
      ).rows
    ).toHaveLength(0);
    await db.query(
      "update effect_attempts set lease_expires_at=now()-interval '1 second' where intent_id=$1",
      [intent.intentId]
    );
    await dispatcher.run(intent.intentId);
    expect(invoked).toBe(1);
    expect((await store.diagnostic(intent.intentId))?.evidence?.certainty).toBe("UNKNOWN");
    evidence.push({
      stage: "terminated-postgresql-connection",
      certainty: (await store.diagnostic(intent.intentId))?.evidence?.certainty,
      adapterCalls: invoked,
      reports: 0
    });
    await dispatcher.shutdown();
  });
});
