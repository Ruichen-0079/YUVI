import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import {
  readSqlMigrations,
  runPostgresMigrations
} from "../../../packages/memory/src/migrations.js";
import { loadServerConfig } from "./config.js";
import { createAppContext, type AppContext } from "./context.js";
import { registerProactiveTurnStreamRoutes } from "./routes/proactive-turn-stream.js";
import { HostProactiveConsentReceiptAdmission } from "./proactive-consent-receipt-admission.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `proactive_consent_${randomBytes(5).toString("hex")}`;
const schemaSql = `"${schema}"`;
let adminPool: PostgresPool | undefined;
let inspectionPool: PostgresPool | undefined;
let scopedDatabaseUrl: string | undefined;
const oldEnv = { ...process.env };
const runtimes: Array<{ app: FastifyInstance; context: AppContext; dir: string }> = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function holdNamespaceStateLock(
  sourcePool: PostgresPool,
  onLocked: () => Promise<void>
): PostgresPool {
  return new Proxy(sourcePool, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(pgClient, clientProperty) {
              if (clientProperty === "query") {
                return async (...args: any[]) => {
                  const result = await Reflect.apply(pgClient.query, pgClient, args);
                  const first = args[0];
                  const sql =
                    typeof first === "string"
                      ? first
                      : typeof first?.text === "string"
                        ? first.text
                        : "";
                  if (/select\s+current_seq[\s\S]*for\s+update/i.test(sql)) await onLocked();
                  return result;
                };
              }
              return Reflect.get(pgClient, clientProperty, pgClient);
            }
          });
        };
      }
      return Reflect.get(target, property, target);
    }
  });
}

async function createRun(namespace: string, dir?: string) {
  const runtimeDir = dir ?? (await mkdtemp(join(tmpdir(), "yuvi-a8-2e3-consent-")));
  process.env = {
    ...oldEnv,
    NODE_ENV: "test",
    RUNTIME_MODE: "development",
    DASHBOARD_DEV_TOKEN: "consent-projection-test-token",
    LOG_LEVEL: "silent",
    PROVIDER_ALLOW_MOCKS: "false",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_BACKEND: "legacy",
    CONVERSATION_REPOSITORY: "in-memory",
    LEDGER_REPOSITORY: "in-memory",
    EVENT_BUS: "in-memory",
    MEMORY_INGESTION_COORDINATOR_ENABLED: "false",
    MEMORY_MAINTENANCE_ENABLED: "false",
    YUVI_RUNTIME_ENV_DIR: runtimeDir,
    YUVI_JOURNAL_NAMESPACE: namespace,
    DATABASE_URL: scopedDatabaseUrl!
  };
  const config = loadServerConfig(process.env);
  const app = Fastify({ logger: false });
  const context = await createAppContext(app.log, config);
  await registerProactiveTurnStreamRoutes(app, context, config);
  const run = { app, context, dir: runtimeDir };
  runtimes.push(run);
  return run;
}

async function closeRun(run: (typeof runtimes)[number], removeDir = true) {
  run.context.runtime.stopProactiveScheduler();
  await run.context.runtime.sealAndDrainMemoryWrites();
  run.context.embodiedPresentationBridge.close();
  await run.context.memoryIngestionCoordinator.shutdown({ graceMs: 100 });
  await run.context.conversationRepository.close?.();
  await run.context.finalizedIngestionRepository.close?.();
  await run.context.memoryRepository.close?.();
  await run.context.closeDatabasePool();
  await run.app.close();
  if (removeDir) await rm(run.dir, { recursive: true, force: true });
}

const headers = { authorization: "Bearer consent-projection-test-token" };

describe.skipIf(!databaseUrl)("A8.2e3 consent projection with real PostgreSQL", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query(`create schema ${schemaSql}`);
    const migration = (await readSqlMigrations()).find(
      (entry) => entry.name === "013_life_event_journal_v1.sql"
    );
    expect(migration).toBeDefined();
    await runPostgresMigrations({
      databaseUrl: databaseUrl!,
      migrations: [migration!],
      settings: { search_path: schema }
    });
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    scopedDatabaseUrl = url.toString();
    inspectionPool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
  });

  afterEach(async () => {
    for (const run of runtimes.splice(0).reverse()) await closeRun(run);
    process.env = { ...oldEnv };
  });

  afterAll(async () => {
    await inspectionPool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists ${schemaSql} cascade`);
      await adminPool.end();
    }
  });

  it("commits before apply, fences a held stale READY, and stays volatile across restart", async () => {
    const namespace = `a8.2e3-projection-${randomBytes(5).toString("hex")}`;
    const dir = await mkdtemp(join(tmpdir(), "yuvi-a8-2e3-policy-"));
    const policyPath = join(dir, "proactive-policy.json");
    const oldSnapshot = {
      version: 1,
      suppression: { kind: "NONE" },
      eligibleAfterMs: 0,
      consentEnabled: true
    };
    await writeFile(policyPath, `${JSON.stringify(oldSnapshot)}\n`, "utf8");
    let run = await createRun(namespace, dir);
    const lockAcquired = deferred<void>();
    const releaseLock = deferred<void>();
    const lockPool = holdNamespaceStateLock(inspectionPool!, async () => {
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    // Pause after PostgreSQL has acquired the namespace row FOR UPDATE, while
    // the real append transaction is open and before the event can commit.
    run.context.proactiveConsentReceiptAdmission = new HostProactiveConsentReceiptAdmission(
      new PostgresJournalRepository(lockPool, {
        namespace,
        authorityBuilder() {
          throw new Error("Host proactive consent admission supplies authority.");
        }
      })
    );

    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 0
    });
    const pendingReady = run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      headers,
      payload: { state: "READY", revision: 10, enabled: true }
    });
    await lockAcquired.promise;
    expect(
      (
        await inspectionPool!.query(
          "select count(*)::int as count from journal_events where journal_namespace = $1",
          [namespace]
        )
      ).rows[0]?.count
    ).toBe(0);
    const invalidation = await run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      headers,
      payload: { state: "UNKNOWN_DENIED", revisionFloor: 11 }
    });
    expect(invalidation.statusCode).toBe(200);
    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 11
    });
    expect(JSON.parse(await readFile(policyPath, "utf8"))).toEqual(oldSnapshot);

    // Resolve the blocked HTTP operation after the synchronous invalidation.
    releaseLock.resolve();
    const staleResponse = await pendingReady;
    expect(staleResponse.statusCode).toBe(200);
    expect(staleResponse.json()).toMatchObject({ ok: true, applied: false, stale: true });
    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 11
    });

    const staleLower = await run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      headers,
      payload: { state: "READY", revision: 10, enabled: true }
    });
    expect(staleLower.statusCode).toBe(409);
    const revision11Committed = deferred<void>();
    const allowRevision11Apply = deferred<void>();
    const revision12Committed = deferred<void>();
    const allowRevision12Apply = deferred<void>();
    const previousAdmission = run.context.proactiveConsentReceiptAdmission;
    run.context.proactiveConsentReceiptAdmission = {
      async admit(input) {
        await previousAdmission.admit(input);
        if (input.settingsRevision === 11) {
          revision11Committed.resolve();
          await allowRevision11Apply.promise;
        }
        if (input.settingsRevision === 12) {
          revision12Committed.resolve();
          await allowRevision12Apply.promise;
        }
      }
    };
    const pendingFresh = run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      headers,
      payload: { state: "READY", revision: 11, enabled: true }
    });
    await revision11Committed.promise;
    expect(
      (
        await inspectionPool!.query(
          "select count(*)::int as count from journal_events where journal_namespace = $1",
          [namespace]
        )
      ).rows[0]?.count
    ).toBe(2);
    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 11
    });
    allowRevision11Apply.resolve();
    const fresh = await pendingFresh;
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "READY",
      revision: 11,
      enabled: true
    });
    const sameRevisionConflict = await run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      headers,
      payload: { state: "READY", revision: 11, enabled: false }
    });
    expect(sameRevisionConflict.statusCode).toBe(409);
    const replay = await run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      headers,
      payload: { state: "READY", revision: 11, enabled: true }
    });
    expect(replay.json()).toMatchObject({ applied: false });

    const immediateInvalidation = await run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      headers,
      payload: { state: "UNKNOWN_DENIED", revisionFloor: 12 }
    });
    expect(immediateInvalidation.statusCode).toBe(200);
    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 12
    });
    await expect(
      run.context.runtime
        .streamAssistantInitiatedTurn({
          sessionId: "default",
          idempotencyKey: "invalidated-immediately",
          readMemory: false
        })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ name: "ProactiveAdmissionError" });
    expect(
      (
        await inspectionPool!.query(
          "select count(*)::int as count from journal_events where journal_namespace = $1",
          [namespace]
        )
      ).rows[0]?.count
    ).toBe(2);

    const pendingDisabled = run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      headers,
      payload: { state: "READY", revision: 12, enabled: false }
    });
    await revision12Committed.promise;
    expect(
      (
        await inspectionPool!.query(
          "select count(*)::int as count from journal_events where journal_namespace = $1",
          [namespace]
        )
      ).rows[0]?.count
    ).toBe(3);
    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 12
    });
    allowRevision12Apply.resolve();
    const disabled = await pendingDisabled;
    expect(disabled.statusCode).toBe(200);
    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "READY",
      revision: 12,
      enabled: false
    });
    expect(JSON.parse(await readFile(policyPath, "utf8"))).toEqual(oldSnapshot);

    const persisted = await inspectionPool!.query(
      "select event_id, envelope from journal_events where journal_namespace = $1 order by commit_seq",
      [namespace]
    );
    expect(persisted.rows).toHaveLength(3);
    for (const row of persisted.rows) {
      expect(row.envelope.command).toMatchObject({
        kind: "RECEIPT",
        data: { receiptClass: "CONTROL" }
      });
      expect(row.envelope.authority).toMatchObject({
        principal: { state: "UNRESOLVED" },
        binding: { state: "UNRESOLVED" },
        subjects: [],
        audience: { kind: "UNKNOWN" }
      });
      expect(row.envelope.authority.payloads).toHaveLength(1);
      expect(row.envelope.authority.payloads[0]).toMatchObject({
        modality: "TEXT",
        origin: "EXTERNAL_RESULT",
        retention: "RETAINED"
      });
    }
    expect(
      (
        await inspectionPool!.query(
          "select count(*)::int as count from journal_source_dedup where journal_namespace = $1",
          [namespace]
        )
      ).rows[0]?.count
    ).toBe(0);
    const payloads = await inspectionPool!.query(
      "select text_content from journal_payloads where journal_namespace = $1",
      [namespace]
    );
    const summaries = payloads.rows.map((row) => row.text_content ?? "").join("\n");
    expect(summaries).toContain('"settingsRevision":10');
    expect(summaries).toContain('"settingsRevision":11');
    expect(summaries).toContain('"settingsRevision":12');

    await closeRun(run, false);
    runtimes.splice(runtimes.indexOf(run), 1);
    const reopenedPool = createPostgresPool(scopedDatabaseUrl!);
    try {
      const reopenedRepository = new PostgresJournalRepository(reopenedPool, {
        namespace,
        authorityBuilder() {
          throw new Error("Journal reads do not construct producer authority.");
        }
      });
      for (const row of persisted.rows) {
        await expect(
          reopenedRepository.get({
            kind: "JOURNAL_EVENT",
            namespace,
            eventId: row.event_id
          })
        ).resolves.toMatchObject({ eventId: row.event_id });
      }
    } finally {
      await reopenedPool.end();
    }
    run = await createRun(namespace, dir);
    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 0
    });
    await expect(
      run.context.runtime
        .streamAssistantInitiatedTurn({
          sessionId: "default",
          idempotencyKey: "restart-denied",
          readMemory: false
        })
        [Symbol.asyncIterator]()
        .next()
    ).rejects.toMatchObject({ name: "ProactiveAdmissionError" });
    const afterRestart = await inspectionPool!.query(
      "select count(*)::int as count from journal_events where journal_namespace = $1",
      [namespace]
    );
    expect(afterRestart.rows[0]?.count).toBe(3);
  });

  it("rejects remote and malformed projection requests before a receipt", async () => {
    const namespace = `a8.2e3-reject-${randomBytes(5).toString("hex")}`;
    const run = await createRun(namespace);
    const remote = await run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      remoteAddress: "192.0.2.30",
      headers,
      payload: { state: "READY", revision: 1, enabled: true }
    });
    expect(remote.statusCode).toBe(403);
    const malformed = await run.app.inject({
      method: "POST",
      url: "/v1/proactive/consent",
      headers,
      payload: { state: "READY", revision: 1, enabled: "true" }
    });
    expect(malformed.statusCode).toBe(400);
    expect(
      (
        await inspectionPool!.query(
          "select count(*)::int as count from journal_events where journal_namespace = $1",
          [namespace]
        )
      ).rows[0]?.count
    ).toBe(0);
    expect(run.context.runtime.getProactiveConsentProjection()).toEqual({
      state: "UNKNOWN_DENIED",
      revisionFloor: 0
    });
  });
});
