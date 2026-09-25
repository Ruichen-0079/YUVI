import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { JournalStoreError, PostgresJournalRepository } from "@companion/journal";
import type { JournalCommittedEnvelope } from "@companion/protocol";
import { emptyProductConfiguration, type ProductConfiguration } from "@companion/providers";
import {
  readSqlMigrations,
  runPostgresMigrations
} from "../../../packages/memory/src/migrations.js";
import { loadServerConfig } from "./config.js";
import { createAppContext, type AppContext } from "./context.js";
import {
  HostProductControlReceiptAdmission,
  type ProductControlReceiptAdmission,
  type ProductControlReceiptInput
} from "./product-control-receipt-admission.js";
import { registerProductRoutes } from "./routes/product.js";
import { readProductSettings } from "./services/product-store.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `product_control_${randomBytes(5).toString("hex")}`;
const quotedSchema = `"${schema}"`;
let adminPool: PostgresPool | undefined;
let pool: PostgresPool | undefined;
let sequence = 0;
const oldEnv = { ...process.env };
const runs: Array<{ app: ReturnType<typeof Fastify>; context: AppContext; dir: string }> = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => (resolve = accept));
  return { promise, resolve };
}

function nextNamespace() {
  sequence += 1;
  return `a8.2e1-product-control-${sequence}`;
}

function createRepository(namespace: string): PostgresJournalRepository {
  return new PostgresJournalRepository(pool!, {
    namespace,
    authorityBuilder() {
      throw new Error("Product control receipts require explicit host authority.");
    }
  });
}

async function events(namespace: string) {
  const result = await pool!.query(
    `select event_id, commit_seq, envelope from journal_events where journal_namespace = $1 order by commit_seq`,
    [namespace]
  );
  return result.rows as Array<{
    event_id: string;
    commit_seq: string | number;
    envelope: JournalCommittedEnvelope;
  }>;
}

async function payloads(namespace: string) {
  const result = await pool!.query(
    `select descriptor, text_content from journal_payloads where journal_namespace = $1`,
    [namespace]
  );
  return result.rows as Array<{ descriptor: Record<string, any>; text_content: string | null }>;
}

async function setup(
  namespace: string,
  admission?: ProductControlReceiptAdmission,
  onRequest?: (request: FastifyRequest) => void
) {
  const dir = await mkdtemp(join(tmpdir(), "yuvi-a8-2e1-product-control-"));
  process.env = {
    ...oldEnv,
    NODE_ENV: "test",
    RUNTIME_MODE: "development",
    LOG_LEVEL: "silent",
    PROVIDER_ALLOW_MOCKS: "false",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_BACKEND: "legacy",
    EVENT_BUS: "in-memory",
    MEMORY_INGESTION_COORDINATOR_ENABLED: "false",
    MEMORY_MAINTENANCE_ENABLED: "false",
    YUVI_RUNTIME_ENV_DIR: dir,
    YUVI_JOURNAL_NAMESPACE: namespace
  };
  delete process.env["DATABASE_URL"];
  const config = loadServerConfig(process.env);
  const app = Fastify({ logger: false });
  if (onRequest) app.addHook("onRequest", async (request) => onRequest(request));
  const context = await createAppContext(app.log, config);
  if (admission) context.productControlReceiptAdmission = admission;
  vi.spyOn(context, "reloadRuntimeConfig").mockImplementation(async () => ({
    providers: context.providers.getStatus(),
    restartRequired: false,
    notHotReloaded: [],
    appliedKeys: [],
    pendingRestartKeys: [],
    message: "Test reload completed."
  }));
  await registerProductRoutes(app, context, config);
  runs.push({ app, context, dir });
  return { app, context, dir };
}

async function closeRun(run: {
  app: ReturnType<typeof Fastify>;
  context: AppContext;
  dir: string;
}) {
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

function configurationWithSecrets(): ProductConfiguration {
  const configuration = emptyProductConfiguration();
  configuration.providers = [
    {
      id: "provider-id-private-marker",
      displayName: "private provider label",
      adapter: "openai-compatible",
      baseUrl: "https://private.invalid/private-path-URL_MARKER",
      apiKey: "API_KEY_MARKER"
    }
  ];
  return configuration;
}

async function settingsGet(app: ReturnType<typeof Fastify>) {
  return app.inject({ method: "GET", url: "/product/configuration" });
}

describe.skipIf(!databaseUrl)("A8.2e1 Product controls with real PostgreSQL Journal", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query(`create schema ${quotedSchema}`);
    const migration = (await readSqlMigrations()).find(
      (entry) => entry.name === "013_life_event_journal_v1.sql"
    );
    expect(migration).toBeDefined();
    await runPostgresMigrations({
      databaseUrl: databaseUrl!,
      migrations: [migration!],
      settings: { search_path: schema }
    });
    pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
  });

  afterEach(async () => {
    for (const run of runs.splice(0).reverse()) await closeRun(run);
    process.env = { ...oldEnv };
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists ${quotedSchema} cascade`);
      await adminPool.end();
    }
  });

  it("commits a minimal configuration CONTROL receipt before Product persistence and reconstructs it after reopen", async () => {
    const namespace = nextNamespace();
    const repository = createRepository(namespace);
    const baseAdmission = new HostProductControlReceiptAdmission(repository);
    let appendReturned = false;
    const admission: ProductControlReceiptAdmission = {
      async admit(input) {
        expect(readProductSettings(process.env)).toBeNull();
        await baseAdmission.admit(input);
        appendReturned = true;
        expect(readProductSettings(process.env)).toBeNull();
      }
    };
    const run = await setup(namespace, admission);
    vi.spyOn(run.context, "reloadRuntimeConfig").mockImplementation(async () => {
      expect(appendReturned).toBe(true);
      expect(await events(namespace)).toHaveLength(1);
      expect(readProductSettings(process.env)?.revision).toBe(1);
      return {
        providers: run.context.providers.getStatus(),
        restartRequired: false,
        notHotReloaded: [],
        appliedKeys: [],
        pendingRestartKeys: [],
        message: "Test reload completed."
      };
    });

    const get = await settingsGet(run.app);
    const response = await run.app.inject({
      method: "PUT",
      url: "/product/configuration",
      payload: { configuration: configurationWithSecrets(), revision: get.json().revision }
    });
    expect(response.statusCode).toBe(200);

    const rows = await events(namespace);
    expect(rows).toHaveLength(1);
    const envelope = rows[0]!.envelope;
    expect(envelope.command.kind).toBe("RECEIPT");
    if (envelope.command.kind !== "RECEIPT") throw new Error("Expected CONTROL receipt.");
    expect(envelope.command.data.receiptClass).toBe("CONTROL");
    expect(envelope.authority.surface).toEqual({
      kind: "LOCAL",
      reference: "yuvi:http:/product/configuration"
    });
    expect(envelope.authority.principal.state).toBe("UNRESOLVED");
    expect(envelope.authority.binding.state).toBe("UNRESOLVED");
    expect(envelope.authority.subjects).toEqual([]);
    expect(envelope.authority.audience.kind).toBe("UNKNOWN");
    expect(envelope.authority.sourceReferences).toEqual([
      {
        kind: "UNRESOLVED_SOURCE",
        reason: "local dashboard requests provide no stable command identity"
      }
    ]);
    const retained = envelope.authority.payloads[0];
    expect(retained).toMatchObject({ modality: "TEXT", retention: "RETAINED", selectable: true });
    if (retained?.modality !== "TEXT") throw new Error("Expected sanitized summary text.");
    const reopened = createRepository(namespace);
    const payload = await reopened.resolveRetainedText(retained.ref);
    expect(payload?.text).toBe(
      JSON.stringify({ operation: "product.configuration.save", expectedRevision: 0 })
    );
    const serialized = JSON.stringify({ rows, payloads: await payloads(namespace) });
    expect(serialized).not.toContain("API_KEY_MARKER");
    expect(serialized).not.toContain("URL_MARKER");
    expect(serialized).not.toContain("provider-id-private-marker");
    expect(serialized).not.toContain("private provider label");
  });

  it("rejects remote, malformed and stale configuration commands without a receipt", async () => {
    const namespace = nextNamespace();
    const run = await setup(
      namespace,
      new HostProductControlReceiptAdmission(createRepository(namespace))
    );
    const config = emptyProductConfiguration();
    const denied = await run.app.inject({
      method: "PUT",
      url: "/product/configuration",
      remoteAddress: "192.0.2.10",
      payload: { configuration: config, revision: 0 }
    });
    expect(denied.statusCode).toBe(403);
    const malformed = await run.app.inject({
      method: "PUT",
      url: "/product/configuration",
      payload: { configuration: config, revision: "0", apiKey: "MUST_NOT_BE_ACCEPTED" }
    });
    expect(malformed.statusCode).toBe(400);
    const admitSpy = vi.spyOn(run.context.productControlReceiptAdmission, "admit");
    const malformedFalsyProactive = await run.app.inject({
      method: "PUT",
      url: "/product/configuration",
      payload: { configuration: config, revision: 0, proactive: false }
    });
    expect(malformedFalsyProactive.statusCode).toBe(400);
    expect(admitSpy).not.toHaveBeenCalled();
    expect(await events(namespace)).toHaveLength(0);
    const stale = await run.app.inject({
      method: "PUT",
      url: "/product/configuration",
      payload: { configuration: config, revision: 9 }
    });
    expect(stale.statusCode).toBe(409);
    expect(await events(namespace)).toHaveLength(0);
    expect(readProductSettings(process.env)).toBeNull();
  });

  it("keeps concurrent same-revision Product saves behind the queue while Journal append is held", async () => {
    const namespace = nextNamespace();
    const appendEntered = deferred<ProductControlReceiptInput>();
    const releaseAppend = deferred();
    const actual = new HostProductControlReceiptAdmission(createRepository(namespace));
    let appendCount = 0;
    const admission: ProductControlReceiptAdmission = {
      async admit(input) {
        appendCount += 1;
        appendEntered.resolve(input);
        if (appendCount === 1) await releaseAppend.promise;
        await actual.admit(input);
      }
    };
    const secondRequestSeen = deferred();
    const run = await setup(namespace, admission, (request) => {
      if (request.headers["x-control-test"] === "second") secondRequestSeen.resolve();
    });
    const configuration = emptyProductConfiguration();
    const first = run.app.inject({
      method: "PUT",
      url: "/product/configuration",
      payload: { configuration, revision: 0 }
    });
    const firstInput = await appendEntered.promise;
    expect(firstInput).toEqual({ operation: "CONFIGURATION_SAVE", expectedRevision: 0 });
    expect(await events(namespace)).toHaveLength(0);
    expect(readProductSettings(process.env)).toBeNull();

    const second = run.app.inject({
      method: "PUT",
      url: "/product/configuration",
      headers: { "x-control-test": "second" },
      payload: { configuration, revision: 0 }
    });
    await secondRequestSeen.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(appendCount).toBe(1);
    expect(readProductSettings(process.env)).toBeNull();

    releaseAppend.resolve();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(409);
    expect(appendCount).toBe(1);
    expect(readProductSettings(process.env)?.revision).toBe(1);
    expect(await events(namespace)).toHaveLength(1);
  });

  it("preallocates a Person target before append, withholds private fields and keeps Memory failure downstream", async () => {
    const namespace = nextNamespace();
    const actual = new HostProductControlReceiptAdmission(createRepository(namespace));
    let admittedInput: ProductControlReceiptInput | undefined;
    const admission: ProductControlReceiptAdmission = {
      async admit(input) {
        admittedInput = input;
        await actual.admit(input);
        expect(readProductSettings(process.env)).toBeNull();
      }
    };
    const run = await setup(namespace, admission);
    run.context.activeRuntimeEnv["MEMORY_PERSONA_ID"] = "persona-private-marker";
    const memoryCalls: unknown[] = [];
    run.context.memory.getMemoryProvider = () =>
      ({
        async writeEvent(input: unknown) {
          memoryCalls.push(input);
          expect(await events(namespace)).toHaveLength(1);
          throw new Error("profile evidence unavailable");
        }
      }) as never;

    const response = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: {
        displayName: "NAME_PRIVATE_MARKER",
        personaId: "persona-private-marker",
        notes: "NOTES_PRIVATE_MARKER",
        primary: true
      }
    });
    expect(response.statusCode).toBe(200);
    const personId = response.json().personId as string;
    expect(personId).toMatch(/^[a-f0-9-]{36}$/);
    expect(admittedInput).toMatchObject({
      operation: "PERSON_CREATE",
      personId,
      requestedPrimary: true
    });
    expect(response.json().profileEvidence).toBe("APPLY_FAILED");
    expect(readProductSettings(process.env)?.people[0]?.id).toBe(personId);
    expect(memoryCalls).toHaveLength(1);

    const rows = await events(namespace);
    expect(rows).toHaveLength(1);
    const envelope = rows[0]!.envelope;
    expect(envelope.authority.principal.state).toBe("UNRESOLVED");
    expect(envelope.authority.binding.state).toBe("UNRESOLVED");
    expect(envelope.authority.subjects).toEqual([]);
    expect(envelope.command.kind).toBe("RECEIPT");
    if (envelope.command.kind !== "RECEIPT") throw new Error("Expected Person CONTROL receipt.");
    expect(envelope.command.data.receiptClass).toBe("CONTROL");
    const payload = envelope.authority.payloads[0];
    if (payload?.modality !== "TEXT") throw new Error("Expected safe Person summary.");
    const summary =
      (await createRepository(namespace).resolveRetainedText(payload.ref))?.text ?? "";
    expect(JSON.parse(summary)).toEqual({
      operation: "product.person.create",
      personId,
      requestedPrimary: true
    });
    const serialized = JSON.stringify({ rows, payloads: await payloads(namespace) });
    expect(serialized).not.toContain("NAME_PRIVATE_MARKER");
    expect(serialized).not.toContain("NOTES_PRIVATE_MARKER");
    expect(serialized).not.toContain("persona-private-marker");
    expect(rows.some((row) => ["OUTCOME", "DERIVATION"].includes(row.envelope.command.kind))).toBe(
      false
    );
  });

  it("records a verified update target separately from principal identity", async () => {
    const namespace = nextNamespace();
    const repository = createRepository(namespace);
    const run = await setup(namespace, new HostProductControlReceiptAdmission(repository));
    run.context.activeRuntimeEnv["MEMORY_PERSONA_ID"] = "persona-v1";
    const created = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: { displayName: "First private name", notes: "first private note", primary: true }
    });
    const personId = created.json().personId as string;
    const updated = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: {
        id: personId,
        displayName: "Second private name",
        personaId: "persona-v2-private",
        notes: "second private note",
        primary: false
      }
    });
    expect(updated.statusCode).toBe(200);
    const rows = await events(namespace);
    expect(rows).toHaveLength(2);
    const envelope = rows[1]!.envelope;
    expect(envelope.authority.principal.state).toBe("UNRESOLVED");
    expect(envelope.authority.binding.state).toBe("UNRESOLVED");
    expect(envelope.authority.subjects).toEqual([]);
    const payload = envelope.authority.payloads[0];
    if (payload?.modality !== "TEXT") throw new Error("Expected safe Person update summary.");
    const summary =
      (await createRepository(namespace).resolveRetainedText(payload.ref))?.text ?? "";
    expect(JSON.parse(summary)).toEqual({
      operation: "product.person.update",
      personId,
      requestedPrimary: false
    });
    const serialized = JSON.stringify({ rows, payloads: await payloads(namespace) });
    expect(serialized).not.toContain("Second private name");
    expect(serialized).not.toContain("second private note");
    expect(serialized).not.toContain("persona-v2-private");
  });

  it("leaves a committed configuration receipt when Runtime reload fails after the Product save", async () => {
    const namespace = nextNamespace();
    const run = await setup(
      namespace,
      new HostProductControlReceiptAdmission(createRepository(namespace))
    );
    vi.spyOn(run.context, "reloadRuntimeConfig").mockRejectedValueOnce(
      new Error("private reload failure")
    );
    const response = await run.app.inject({
      method: "PUT",
      url: "/product/configuration",
      payload: { configuration: emptyProductConfiguration(), revision: 0 }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().applyState).toBe("APPLY_FAILED");
    expect(readProductSettings(process.env)?.revision).toBe(1);
    expect(await events(namespace)).toHaveLength(1);
  });

  it("commits proactive-resume receipts before Runtime and keeps identical commands distinct", async () => {
    const namespace = nextNamespace();
    const actual = new HostProductControlReceiptAdmission(createRepository(namespace));
    let committed = false;
    const admission: ProductControlReceiptAdmission = {
      async admit(input) {
        await actual.admit(input);
        committed = true;
      }
    };
    const run = await setup(namespace, admission);
    const resume = vi.spyOn(run.context.runtime, "resumeProactiveNow").mockImplementation(() => {
      expect(committed).toBe(true);
    });
    for (let index = 0; index < 2; index += 1) {
      committed = false;
      const response = await run.app.inject({ method: "POST", url: "/product/proactive/resume" });
      expect(response.statusCode).toBe(200);
    }
    const rows = await events(namespace);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.event_id).not.toBe(rows[1]!.event_id);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(
      rows.every(
        (row) =>
          row.envelope.command.kind === "RECEIPT" &&
          row.envelope.command.data.receiptClass === "CONTROL"
      )
    ).toBe(true);
  });

  it("Journal unavailability prevents config save, Person save/Memory write, and proactive Runtime mutation", async () => {
    const namespace = nextNamespace();
    const run = await setup(namespace, new HostProductControlReceiptAdmission(null));
    run.context.activeRuntimeEnv["MEMORY_PERSONA_ID"] = "persona";
    const memoryWrite = vi.fn();
    run.context.memory.getMemoryProvider = () => ({ writeEvent: memoryWrite }) as never;
    const resume = vi.spyOn(run.context.runtime, "resumeProactiveNow");

    const configResponse = await run.app.inject({
      method: "PUT",
      url: "/product/configuration",
      payload: { configuration: emptyProductConfiguration(), revision: 0 }
    });
    const personResponse = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: { displayName: "Rui", primary: true }
    });
    const resumeResponse = await run.app.inject({
      method: "POST",
      url: "/product/proactive/resume"
    });

    expect(configResponse.statusCode).toBe(503);
    expect(personResponse.statusCode).toBe(503);
    expect(resumeResponse.statusCode).toBe(503);
    expect(configResponse.body).not.toContain("DATABASE_URL");
    expect(readProductSettings(process.env)).toBeNull();
    expect(memoryWrite).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(await events(namespace)).toHaveLength(0);
  });
});
