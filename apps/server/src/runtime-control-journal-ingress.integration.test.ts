import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import type { JournalCommittedEnvelope } from "@companion/protocol";
import { createFileP8CorrectionStore } from "@companion/core";
import {
  readSqlMigrations,
  runPostgresMigrations
} from "../../../packages/memory/src/migrations.js";
import { loadServerConfig } from "./config.js";
import { createAppContext, type AppContext } from "./context.js";
import {
  HostRuntimeControlReceiptAdmission,
  type RuntimeControlReceiptAdmission
} from "./runtime-control-receipt-admission.js";
import { registerLocalServiceRoutes } from "./routes/local-services.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `runtime_control_${randomBytes(5).toString("hex")}`;
const schemaSql = `"${schema}"`;
let adminPool: PostgresPool | undefined;
let pool: PostgresPool | undefined;
let namespaceSequence = 0;
const oldEnv = { ...process.env };
const runs: Array<{ app: ReturnType<typeof Fastify>; context: AppContext; dir: string }> = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => (resolve = accept));
  return { promise, resolve };
}

function nextNamespace(label: string): string {
  namespaceSequence += 1;
  return `a8.2e2-${label}-${namespaceSequence}`;
}

function createRepository(namespace: string, usingPool = pool!): PostgresJournalRepository {
  return new PostgresJournalRepository(usingPool, {
    namespace,
    authorityBuilder() {
      throw new Error("Runtime control receipts require host authority.");
    }
  });
}

function observeNamespaceStateLock(sourcePool: PostgresPool, onAttempt: () => void): PostgresPool {
  return new Proxy(sourcePool, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(pgClient, clientProperty) {
              if (clientProperty === "query") {
                return (...args: any[]) => {
                  const first = args[0];
                  const sql =
                    typeof first === "string"
                      ? first
                      : typeof first?.text === "string"
                        ? first.text
                        : "";
                  if (/select\s+current_seq[\s\S]*for\s+update/i.test(sql)) onAttempt();
                  return Reflect.apply(pgClient.query, pgClient, args);
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

async function events(namespace: string) {
  const result = await pool!.query(
    `select event_id, commit_seq, envelope from journal_events
     where journal_namespace = $1 order by commit_seq`,
    [namespace]
  );
  return result.rows as Array<{
    event_id: string;
    commit_seq: string | number;
    envelope: JournalCommittedEnvelope;
  }>;
}

async function payloadRows(namespace: string) {
  const result = await pool!.query(
    `select descriptor, text_content, content_sha256 from journal_payloads
     where journal_namespace = $1`,
    [namespace]
  );
  return result.rows as Array<{
    descriptor: Record<string, any>;
    text_content: string | null;
    content_sha256: string | null;
  }>;
}

function correction(overrides: Record<string, unknown> = {}) {
  return {
    recordVersion: "p8-1e.v1",
    correctionReference: "CORRECTION_REFERENCE_PRIVATE_MARKER",
    address: {
      characterInstanceId: "yuvi-default-character-instance",
      personaProfileId: "persona-a",
      subjectScopeId: "person-a"
    },
    scopeReference: { reference: "scope-a" },
    target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
    action: "REVISE",
    replacementMeaning: "REPLACEMENT_MEANING_PRIVATE_MARKER",
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: "PROVENANCE_REFERENCE_PRIVATE_MARKER",
      suppliedAt: "2026-09-25T00:00:00.000Z"
    },
    supersededEvidenceReferences: ["EVIDENCE_REFERENCE_PRIVATE_MARKER"],
    ...overrides
  };
}

function readTextGrants(context: AppContext): Map<string, string> {
  return (context.runtime as unknown as { authorizedReadText: Map<string, string> })
    .authorizedReadText;
}

async function setup(
  namespace: string,
  admission?: RuntimeControlReceiptAdmission,
  usingPool = pool!
) {
  const dir = await mkdtemp(join(tmpdir(), "yuvi-a8-2e2-runtime-control-"));
  const scopedUrl = new URL(databaseUrl!);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  process.env = {
    ...oldEnv,
    NODE_ENV: "test",
    RUNTIME_MODE: "development",
    DASHBOARD_DEV_TOKEN: "runtime-control-test-token",
    LOG_LEVEL: "silent",
    PROVIDER_ALLOW_MOCKS: "false",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_BACKEND: "legacy",
    EVENT_BUS: "in-memory",
    MEMORY_INGESTION_COORDINATOR_ENABLED: "false",
    MEMORY_MAINTENANCE_ENABLED: "false",
    YUVI_RUNTIME_ENV_DIR: dir,
    YUVI_JOURNAL_NAMESPACE: namespace,
    DATABASE_URL: scopedUrl.toString()
  };
  const config = loadServerConfig(process.env);
  const app = Fastify({ logger: false });
  const context = await createAppContext(app.log, config);
  context.runtimeControlReceiptAdmission =
    admission ?? new HostRuntimeControlReceiptAdmission(createRepository(namespace, usingPool));
  await registerLocalServiceRoutes(app, context, config);
  const run = { app, context, dir };
  runs.push(run);
  return run;
}

async function closeRun(run: (typeof runs)[number]) {
  run.context.runtime.stopProactiveScheduler();
  await run.context.runtime.sealAndDrainMemoryWrites();
  run.context.embodiedPresentationBridge.close();
  await run.context.memoryIngestionCoordinator.shutdown({ graceMs: 100 });
  await run.context.conversationRepository.close?.();
  await run.context.finalizedIngestionRepository.close?.();
  await run.context.memoryRepository.close?.();
  await run.context.closeDatabasePool();
  await run.app.close();
  await rm(run.dir, { recursive: true, force: true });
}

const localHeaders = { authorization: "Bearer runtime-control-test-token" };

describe.skipIf(!databaseUrl)("A8.2e2 Runtime control receipts with real PostgreSQL", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query(`create schema ${schemaSql}`);
    const migrations = await readSqlMigrations();
    const requiredNames = [
      "013_life_event_journal_v1.sql",
      "020_effect_intents_v1.sql",
      "021_effect_attempts_v1.sql",
      "022_native_control_effects_v1.sql"
    ];
    const selected = requiredNames.map((name) => migrations.find((entry) => entry.name === name));
    expect(selected.every(Boolean)).toBe(true);
    await runPostgresMigrations({
      databaseUrl: databaseUrl!,
      migrations: selected as typeof migrations,
      settings: { search_path: schema }
    });
    pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
  });

  afterEach(async () => {
    for (const run of runs.splice(0).reverse()) await closeRun(run);
    process.env = { ...oldEnv };
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists ${schemaSql} cascade`);
      await adminPool.end();
    }
  });

  it("rejects unauthorized, malformed, invalid-target, invalid-lineage and known-conflict P8 input before receipts", async () => {
    const namespace = nextNamespace("p8-preflight");
    const run = await setup(namespace);
    const privateCorrection = correction();

    const unauthorized = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      remoteAddress: "192.0.2.20",
      headers: localHeaders,
      payload: privateCorrection
    });
    expect(unauthorized.statusCode).toBe(403);
    expect(
      await createFileP8CorrectionStore(
        join(run.dir, "p8-corrections.json")
      ).loadCorrectionByReference("CORRECTION_REFERENCE_PRIVATE_MARKER")
    ).toEqual({
      status: "SUCCESS_WITH_NO_CORRECTION"
    });

    const unauthorizedReadText = await run.app.inject({
      method: "POST",
      url: "/capabilities/read-text/authorize",
      remoteAddress: "192.0.2.20",
      headers: localHeaders,
      payload: { sessionId: "unauthorized-session", path: "/tmp/unauthorized-private.txt" }
    });
    expect(unauthorizedReadText.statusCode).toBe(403);
    expect(readTextGrants(run.context).size).toBe(0);

    const malformed = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      headers: localHeaders,
      payload: { ...privateCorrection, unexpected: "must-be-rejected" }
    });
    expect(malformed.statusCode).toBe(400);

    const invalidTarget = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      headers: localHeaders,
      payload: {
        ...privateCorrection,
        correctionReference: "invalid-target-reference",
        target: { kind: "INTERPRETATION", interpretationReference: "unknown-target" }
      }
    });
    expect(invalidTarget.statusCode).toBe(400);

    const invalidLineage = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      headers: localHeaders,
      payload: {
        ...privateCorrection,
        correctionReference: "invalid-lineage-reference",
        supersedesCorrectionReference: "missing-parent-reference"
      }
    });
    expect(invalidLineage.statusCode).toBe(400);

    const store = createFileP8CorrectionStore(join(run.dir, "p8-corrections.json"));
    expect((await store.appendCorrection(privateCorrection as never)).status).toBe("STORED");
    const knownConflict = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      headers: localHeaders,
      payload: { ...privateCorrection, replacementMeaning: "CHANGED_MEANING" }
    });
    expect(knownConflict.statusCode).toBe(409);
    expect(await events(namespace)).toHaveLength(0);
    expect(readTextGrants(run.context).size).toBe(0);
  });

  it("replays one canonical P8 command through one private CONTROL receipt and exact owner observation", async () => {
    const namespace = nextNamespace("p8-retry");
    const run = await setup(namespace);
    const body = correction();
    const first = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      headers: localHeaders,
      payload: body
    });
    const second = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      headers: localHeaders,
      payload: body
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("STORED");
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("STORED");
    expect(second.json().intentId).toBe(first.json().intentId);
    expect(second.json().controlReceiptRef).toEqual(first.json().controlReceiptRef);

    const rows = await events(namespace);
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.envelope.command.kind).toBe("RECEIPT");
      if (row.envelope.command.kind !== "RECEIPT") throw new Error("Expected CONTROL receipt.");
      expect(row.envelope.command.data.receiptClass).toBe("CONTROL");
      expect(row.envelope.authority).toMatchObject({
        principal: { state: "UNRESOLVED" },
        binding: { state: "UNRESOLVED" },
        subjects: [],
        audience: { kind: "UNKNOWN" }
      });
      const payload = row.envelope.authority.payloads[0];
      if (payload?.modality !== "TEXT") throw new Error("Expected bounded control summary.");
      expect(payload.retention).toBe("RETAINED");
      const summary = JSON.parse(
        (await createRepository(namespace).resolveRetainedText(payload.ref))!.text
      ) as Record<string, unknown>;
      expect(summary).toMatchObject({
        operation: "p8.correction.revise",
        commandHandleDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        targetKind: "INTERPRETATION",
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
    }
    const serialized = JSON.stringify({ rows, payloads: await payloadRows(namespace) });
    for (const marker of [
      "CORRECTION_REFERENCE_PRIVATE_MARKER",
      "REPLACEMENT_MEANING_PRIVATE_MARKER",
      "PROVENANCE_REFERENCE_PRIVATE_MARKER",
      "2026-09-25T00:00:00.000Z",
      "EVIDENCE_REFERENCE_PRIVATE_MARKER",
      "relationship.current"
    ]) {
      expect(serialized).not.toContain(marker);
    }
    const dedup = await pool!.query(
      "select count(*)::int as count from journal_source_dedup where journal_namespace = $1",
      [namespace]
    );
    expect(dedup.rows[0]?.["count"]).toBe(0);

    const durable = await pool!.query(
      `select i.intent_id, i.work_state, count(distinct a.attempt_id)::int as attempts,
              o.observation_version, o.evidence
       from effect_intents i
       join effect_attempts a using(intent_id)
       join effect_observations o using(attempt_id)
       where i.contract_ref='yuvi.native-control.v1'
         and i.intent_id=$1
       group by i.intent_id, i.work_state, o.observation_version, o.evidence`,
      [first.json().intentId]
    );
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]).toMatchObject({
      intent_id: first.json().intentId,
      work_state: "CLAIMED",
      attempts: 1,
      observation_version: "effect-observation.v2"
    });
    expect(durable.rows[0]?.evidence).toMatchObject({
      certainty: "APPLIED",
      layer: "NATIVE_OWNER_COMMIT",
      nativeOwnerCommit: {
        version: "native-owner-commit.v1",
        ownerFamily: "P8_CORRECTION",
        targetReference: "CORRECTION_REFERENCE_PRIVATE_MARKER",
        revisions: [
          {
            ownerReference: "CORRECTION_REFERENCE_PRIVATE_MARKER",
            revision: expect.any(String)
          }
        ],
        eventIds: ["CORRECTION_REFERENCE_PRIVATE_MARKER"]
      }
    });
  });

  it("revalidates a P8 reference race at the native owner without overwriting the winner", async () => {
    const namespace = nextNamespace("p8-race");
    const run = await setup(namespace);
    const store = createFileP8CorrectionStore(join(run.dir, "p8-corrections.json"));
    const originalAppend = run.context.runtime.appendP8CorrectionCommand.bind(run.context.runtime);
    let appendOutcome: string | undefined;
    run.context.runtime.appendP8CorrectionCommand = async (candidate, command) => {
      const result = await originalAppend(candidate, command);
      appendOutcome = result.status;
      return result;
    };
    const originalExecute = run.context.productPersonCommands.execute.bind(
      run.context.productPersonCommands
    );
    let raced = false;
    run.context.productPersonCommands.execute = async (input, current, workflowChild) => {
      if (
        !raced &&
        "family" in input &&
        input.family === "P8_CORRECTION" &&
        input.correctionReference === "CORRECTION_REFERENCE_PRIVATE_MARKER"
      ) {
        raced = true;
        const concurrent = await run.app.inject({
          method: "POST",
          url: "/p8/corrections",
          headers: localHeaders,
          payload: correction({
            correctionReference: "CONCURRENT_WINNER_REFERENCE",
            replacementMeaning: "CONCURRENT_WINNER"
          })
        });
        expect(concurrent.statusCode).toBe(200);
      }
      return originalExecute(input, current, workflowChild);
    };

    const response = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      headers: localHeaders,
      payload: correction()
    });
    expect(raced, `${response.statusCode}: ${response.body}`).toBe(true);
    expect(appendOutcome, response.body).toBe("CONFLICT");
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().status).toBe("CONFLICT");

    const intent = await pool!.query(
      `select intent_id from effect_intents
       where contract_ref='yuvi.native-control.v1' and logical_key like $1`,
      [`%${namespace}%CORRECTION_REFERENCE_PRIVATE_MARKER%`]
    );
    expect(intent.rows).toHaveLength(1);
    let evidence: Record<string, unknown> | undefined;
    for (let index = 0; index < 80 && !evidence; index += 1) {
      const result = await pool!.query(
        `select o.evidence from effect_observations o join effect_attempts a using(attempt_id)
         where a.intent_id=$1 order by o.observation_id desc limit 1`,
        [intent.rows[0]?.["intent_id"]]
      );
      evidence = result.rows[0]?.["evidence"] as Record<string, unknown> | undefined;
      if (!evidence) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const attemptState = await pool!.query(
      `select a.*, i.pre_dispatch_reason from effect_attempts a join effect_intents i using(intent_id)
       where a.intent_id=$1`,
      [intent.rows[0]?.["intent_id"]]
    );
    expect(evidence, JSON.stringify(attemptState.rows)).toMatchObject({
      certainty: "DEFINITIVE_REJECTION",
      reason: "OWNER_REJECTED"
    });

    const retry = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      headers: localHeaders,
      payload: correction()
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().status).toBe("CONFLICT");
    expect(await events(namespace)).toHaveLength(2);
    const attemptCount = await pool!.query(
      "select count(*)::int as count from effect_attempts where intent_id=$1",
      [intent.rows[0]?.["intent_id"]]
    );
    expect(attemptCount.rows[0]?.["count"]).toBe(1);
    const stored = await store.loadCorrectionByReference("CORRECTION_REFERENCE_PRIVATE_MARKER");
    expect(stored.status).toBe("SUCCESS_WITH_NO_CORRECTION");
    const winner = await store.loadCorrectionByReference("CONCURRENT_WINNER_REFERENCE");
    expect(winner.status).toBe("SUCCESS_WITH_CORRECTION");
    if (winner.status === "SUCCESS_WITH_CORRECTION")
      expect(winner.correction.replacementMeaning).toBe("CONCURRENT_WINNER");
  });

  it("commits read-text receipt before the exact process-local grant and keeps path private", async () => {
    const namespace = nextNamespace("read-text-order");
    await pool!.query(
      "insert into journal_namespaces (journal_namespace, current_seq) values ($1, 0) on conflict do nothing",
      [namespace]
    );
    const lockAttempted = deferred<void>();
    const lockedPool = observeNamespaceStateLock(pool!, () => lockAttempted.resolve());
    const run = await setup(namespace, undefined, lockedPool);
    const blocker = await pool!.connect();
    await blocker.query("begin");
    await blocker.query(
      "select current_seq from journal_namespaces where journal_namespace = $1 for update",
      [namespace]
    );
    const sessionId = " read-text-session ";
    const privatePath = join(run.dir, "ABSOLUTE_PATH_PRIVATE_MARKER-does-not-exist.txt");
    const request = run.app.inject({
      method: "POST",
      url: "/capabilities/read-text/authorize",
      headers: localHeaders,
      payload: { sessionId, path: privatePath }
    });

    try {
      await lockAttempted.promise;
      expect(await events(namespace)).toHaveLength(0);
      expect(readTextGrants(run.context).has(sessionId)).toBe(false);
      await blocker.query("commit");
      const response = await request;
      expect(response.statusCode).toBe(200);
      expect(readTextGrants(run.context).get(sessionId)).toBe(privatePath);
      expect(await events(namespace)).toHaveLength(1);

      const repeated = await run.app.inject({
        method: "POST",
        url: "/capabilities/read-text/authorize",
        headers: localHeaders,
        payload: { sessionId, path: "/tmp/SECOND_PRIVATE_PATH_MARKER.txt" }
      });
      expect(repeated.statusCode).toBe(200);
      expect(readTextGrants(run.context).get(sessionId)).toBe(
        "/tmp/SECOND_PRIVATE_PATH_MARKER.txt"
      );
      const rows = await events(namespace);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.event_id).not.toBe(rows[1]!.event_id);
      expect(rows.every((row) => row.envelope.command.kind === "RECEIPT")).toBe(true);
      const serialized = JSON.stringify({ rows, payloads: await payloadRows(namespace) });
      expect(serialized).not.toContain(privatePath);
      expect(serialized).not.toContain("ABSOLUTE_PATH_PRIVATE_MARKER");
      expect(serialized).not.toContain("SECOND_PRIVATE_PATH_MARKER");
      expect(serialized).not.toContain(sessionId);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
  }, 10_000);

  it("rejects whitespace-only sessions and invalid paths without receipt or grant", async () => {
    const namespace = nextNamespace("read-text-invalid");
    const run = await setup(namespace);
    const invalidPayloads = [
      { sessionId: "   ", path: "/tmp/read.txt" },
      { sessionId: "valid-session", path: "relative.txt" },
      { sessionId: "valid-session", path: " /tmp/padded.txt" },
      { sessionId: "valid-session", path: `/${"x".repeat(4096)}` }
    ];
    for (const payload of invalidPayloads) {
      const response = await run.app.inject({
        method: "POST",
        url: "/capabilities/read-text/authorize",
        headers: localHeaders,
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await events(namespace)).toHaveLength(0);
    expect(readTextGrants(run.context).size).toBe(0);
  });

  it("keeps committed receipt across Runtime reconstruction without restoring its grant", async () => {
    const namespace = nextNamespace("read-text-restart");
    const run = await setup(namespace);
    const response = await run.app.inject({
      method: "POST",
      url: "/capabilities/read-text/authorize",
      headers: localHeaders,
      payload: { sessionId: "restart-session", path: "/tmp/restart-private.txt" }
    });
    expect(response.statusCode).toBe(200);
    expect(readTextGrants(run.context).has("restart-session")).toBe(true);
    const committed = await events(namespace);
    expect(committed).toHaveLength(1);

    const rebuilt = await import("@companion/core").then(
      ({ RuntimeOrchestrator }) =>
        new RuntimeOrchestrator({
          eventBus: run.context.eventBus,
          memory: {} as never,
          promptBuilder: {} as never,
          providers: {} as never
        })
    );
    expect(
      (rebuilt as unknown as { authorizedReadText: Map<string, string> }).authorizedReadText.has(
        "restart-session"
      )
    ).toBe(false);
    expect(
      (
        await createRepository(namespace).get({
          kind: "JOURNAL_EVENT",
          namespace,
          eventId: committed[0]!.event_id
        })
      )?.eventId
    ).toBe(committed[0]!.event_id);
  });

  it("does not create P8 or read-text state when Journal admission is unavailable", async () => {
    const namespace = nextNamespace("journal-unavailable");
    const run = await setup(namespace, new HostRuntimeControlReceiptAdmission(null));
    run.context.productPersonCommands.execute = async () => ({
      status: "UNAVAILABLE",
      reason: "DURABLE_NATIVE_CONTROL_UNAVAILABLE"
    });
    const p8Response = await run.app.inject({
      method: "POST",
      url: "/p8/corrections",
      headers: localHeaders,
      payload: correction()
    });
    const readTextResponse = await run.app.inject({
      method: "POST",
      url: "/capabilities/read-text/authorize",
      headers: localHeaders,
      payload: { sessionId: "unavailable-session", path: "/tmp/unavailable.txt" }
    });
    expect(p8Response.statusCode).toBe(503);
    expect(readTextResponse.statusCode).toBe(503);
    expect(p8Response.body).not.toContain("DATABASE_URL");
    expect(readTextResponse.body).not.toContain("/tmp/unavailable.txt");
    expect(await events(namespace)).toHaveLength(0);
    expect(
      await createFileP8CorrectionStore(
        join(run.dir, "p8-corrections.json")
      ).loadCorrectionByReference("CORRECTION_REFERENCE_PRIVATE_MARKER")
    ).toEqual({
      status: "SUCCESS_WITH_NO_CORRECTION"
    });
    expect(readTextGrants(run.context).size).toBe(0);
  });
});
