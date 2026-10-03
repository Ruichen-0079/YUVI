import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { JournalStoreError, PostgresJournalRepository } from "@companion/journal";
import type { JournalCommittedEnvelope } from "@companion/protocol";
import { emptyProductConfiguration, type ProductConfiguration } from "@companion/providers";
import type { VoiceProfileNativeCommand, VoiceProfileNativeCommandReceipt } from "@companion/providers";
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
import { registerLocalServiceRoutes } from "./routes/local-services.js";
import { registerPeopleVoiceRoutes } from "./routes/people-voices.js";
import { createAcousticReplacementWorkflowPlan } from "./product-person-command-effects.js";
import { readProductSettings } from "./services/product-store.js";
import { retainEnrollmentSamples } from "./services/voice-review.js";

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

function wavWithMarker(marker = "PRIVATE_AUDIO_MARKER") {
  const bytes = Buffer.alloc(44 + 32_000);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(32_000, 40);
  bytes.write(marker, 44, "ascii");
  return bytes;
}

function nextNamespace() {
  sequence += 1;
  return `a8.2e1-product-control-${sequence}`;
}

function scopedDatabaseUrl() {
  const value = new URL(databaseUrl!);
  value.searchParams.set("options", `-c search_path=${schema}`);
  return value.toString();
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

async function nativeIntent(commandHandle: string) {
  const result = await pool!.query(
    `select intent_id,intent from effect_intents where contract_ref='yuvi.native-control.v1' and
      intent->'request'->'payload'->>'commandHandle'=$1`,
    [commandHandle]
  );
  return result.rows[0] as { intent_id: string; intent: Record<string, any> } | undefined;
}

async function nativePayload(commandHandle: string) {
  const result = await pool!.query(
    `select intent_id,payload_state,payload,payload_digest,semantic_digest from effect_command_payloads
      where contract_ref='yuvi.native-control.v1' and command_handle=$1`,
    [commandHandle]
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function nativeAttempt(intentId: string) {
  const result = await pool!.query(
    `select a.attempt_id,a.dispatch_started_at,o.observation_version,o.evidence from effect_attempts a
      left join effect_observations o using(attempt_id) where a.intent_id=$1 order by a.ordinal,o.observation_id`,
    [intentId]
  );
  return result.rows as Array<{
    attempt_id: string;
    dispatch_started_at: Date | null;
    observation_version: string | null;
    evidence: Record<string, unknown> | null;
  }>;
}

async function setup(
  namespace: string,
  admission?: ProductControlReceiptAdmission,
  onRequest?: (request: FastifyRequest) => void,
  extraEnv: Record<string, string | undefined> = {}
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
    YUVI_JOURNAL_NAMESPACE: namespace,
    DATABASE_URL: scopedDatabaseUrl(),
    ...extraEnv
  };
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
    const migrations = await readSqlMigrations();
    const requiredNames = [
      "013_life_event_journal_v1.sql",
      "019_evidence_admission_v1.sql",
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
        const receipt = await baseAdmission.admit(input);
        appendReturned = true;
        expect(readProductSettings(process.env)).toBeNull();
        return receipt;
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
        reason: "the local command handle is an idempotency key, not a source assertion"
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
        return actual.admit(input);
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

  it("atomically admits Person control and A9 work, applies once, and keeps the projection out of Memory", async () => {
    const namespace = nextNamespace();
    const run = await setup(namespace);
    run.context.activeRuntimeEnv["MEMORY_PERSONA_ID"] = "persona-private-marker";
    const memoryCalls: unknown[] = [];
    run.context.memory.getMemoryProvider = () =>
      ({
        async writeEvent(input: unknown) {
          memoryCalls.push(input);
          expect(await events(namespace)).toHaveLength(1);
          throw new Error("Person projections must not be written to Memory.");
        }
      }) as never;

    const response = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: {
        displayName: "NAME_PRIVATE_MARKER",
        personaId: "persona-private-marker",
        notes: "NOTES_PRIVATE_MARKER",
        primary: true,
        commandHandle: "person-create-a10-non-evidence",
        expectedPersonRevision: null,
        expectedPrimaryRevision: null
      }
    });
    expect(response.statusCode).toBe(200);
    const personId = response.json().personId as string;
    expect(personId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.json().profileEvidence).toMatchObject({
      classification: "NON_EVIDENCE",
      projectionVersion: "product-person-profile.v1",
      owner: "PRODUCT_PERSON_STORE",
      personId
    });
    const savedSettings = readProductSettings(process.env);
    expect(savedSettings?.people[0]?.id).toBe(personId);
    expect(response.json().profileEvidence.personRevision).toBe(
      savedSettings?.personRevisionById?.[personId]
    );
    expect(memoryCalls).toHaveLength(0);

    const replay = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: {
        displayName: "NAME_PRIVATE_MARKER",
        personaId: "persona-private-marker",
        notes: "NOTES_PRIVATE_MARKER",
        primary: true,
        commandHandle: "person-create-a10-non-evidence",
        expectedPersonRevision: null,
        expectedPrimaryRevision: null
      }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().personId).toBe(personId);
    expect(readProductSettings(process.env)?.people).toHaveLength(1);

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
    const summaryValue = JSON.parse(summary) as Record<string, unknown>;
    expect(summaryValue).toMatchObject({
      operation: "product.person.create",
      personId,
      requestedPrimary: true,
      commandHandle: "person-create-a10-non-evidence",
      expectedPersonRevision: null,
      expectedPrimaryRevision: null
    });
    expect(summaryValue).toHaveProperty("payloadDigest");
    const intent = await nativeIntent("person-create-a10-non-evidence");
    expect(intent?.intent["contractRef"]).toBe("yuvi.native-control.v1");
    expect((intent?.intent["request"] as Record<string, any>)?.["payload"]).toMatchObject({
      version: "native-control-command.v1",
      family: "PRODUCT_PERSON",
      commandHandle: "person-create-a10-non-evidence",
      targetReference: personId
    });
    const descriptor = (intent?.intent["request"] as Record<string, any>)["payload"] as Record<
      string,
      unknown
    >;
    expect(descriptor).not.toHaveProperty("displayName");
    expect(descriptor).not.toHaveProperty("notes");
    expect(descriptor).not.toHaveProperty("personaId");
    expect(descriptor["payloadDigest"]).toBe(summaryValue["payloadDigest"]);
    const commandPayload = await nativePayload("person-create-a10-non-evidence");
    expect(commandPayload).toMatchObject({ payload_state: "REDACTED", payload: null });
    expect(commandPayload?.["intent_id"]).toBe(intent!.intent_id);
    expect(commandPayload?.["payload_digest"]).toBe(summaryValue["payloadDigest"]);
    const attempts = await nativeAttempt(intent!.intent_id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.dispatch_started_at).toBeTruthy();
    expect(attempts[0]?.evidence).toMatchObject({
      certainty: "APPLIED",
      layer: "NATIVE_OWNER_COMMIT",
      reason: "OWNER_COMMITTED",
      nativeOwnerCommit: {
        version: "native-owner-commit.v1",
        ownerFamily: "PRODUCT_PERSON",
        targetReference: personId,
        revisions: expect.arrayContaining([
          { ownerReference: `person:${personId}`, revision: savedSettings?.personRevisionById?.[personId] },
          { ownerReference: "primary-person-selection", revision: savedSettings?.primaryPersonRevision }
        ])
      }
    });
    expect(attempts[0]?.observation_version).toBe("effect-observation.v2");
    expect(savedSettings?.productCommandReceipts?.[0]).toMatchObject({
      commandHandle: "person-create-a10-non-evidence",
      intentId: intent!.intent_id,
      personId
    });
    const serialized = JSON.stringify({
      rows,
      payloads: await payloads(namespace),
      intent,
      commandPayload,
      attempts
    });
    expect(serialized).not.toContain("NAME_PRIVATE_MARKER");
    expect(serialized).not.toContain("NOTES_PRIVATE_MARKER");
    expect(serialized).not.toContain("persona-private-marker");
    expect(rows.some((row) => ["OUTCOME", "DERIVATION"].includes(row.envelope.command.kind))).toBe(
      false
    );
  });

  it("withholds native dispatch when local dashboard authority changes after admission", async () => {
    const namespace = nextNamespace();
    const run = await setup(namespace);
    let allowed = true;
    const dispatcher = run.context.readTextEffects.dispatcher!;
    const dispatch = dispatcher.run.bind(dispatcher);
    vi.spyOn(dispatcher, "run").mockImplementation(async (intentId) => {
      allowed = false;
      return dispatch(intentId);
    });
    const commandHandle = "person-dispatch-authority-revoked";
    const result = await run.context.productPersonCommands.execute(
      {
        commandHandle,
        operation: "CREATE",
        displayName: "Must not apply",
        personaId: "persona-authority-test",
        notes: "",
        requestedPrimary: true,
        expectedPersonRevision: null,
        expectedPrimaryRevision: null
      },
      () => allowed
    );
    expect(allowed).toBe(false);
    expect(result).toMatchObject({ status: "UNKNOWN" });
    const intent = await nativeIntent(commandHandle);
    expect(intent).toBeTruthy();
    const attempts = await nativeAttempt(intent!.intent_id);
    expect(attempts).toEqual([]);
    const disposition = await pool!.query(
      `select state,work_state,pre_dispatch_reason from effect_intents where intent_id=$1`,
      [intent!.intent_id]
    );
    expect(disposition.rows[0]).toMatchObject({
      state: "ADMITTED",
      work_state: "WITHHELD",
      pre_dispatch_reason: "AUTHORITY_REVOKED"
    });
    expect(readProductSettings(process.env)?.people ?? []).toEqual([]);
    expect(await events(namespace)).toHaveLength(1);
  });

  it("records a verified update target separately from principal identity", async () => {
    const namespace = nextNamespace();
    const repository = createRepository(namespace);
    const run = await setup(namespace, new HostProductControlReceiptAdmission(repository));
    run.context.activeRuntimeEnv["MEMORY_PERSONA_ID"] = "persona-v1";
    const created = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: {
        displayName: "First private name",
        notes: "first private note",
        primary: true,
        commandHandle: "person-create-private-fields",
        expectedPersonRevision: null,
        expectedPrimaryRevision: null
      }
    });
    const personId = created.json().personId as string;
    const beforeUpdate = readProductSettings(process.env)!;
    const updated = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: {
        id: personId,
        displayName: "Second private name",
        personaId: "persona-v2-private",
        notes: "second private note",
        primary: false,
        commandHandle: "person-update-private-fields",
        expectedPersonRevision: beforeUpdate.personRevisionById?.[personId] ?? null,
        expectedPrimaryRevision: beforeUpdate.primaryPersonRevision ?? null
      }
    });
    expect(updated.statusCode).toBe(200);
    const afterUpdate = readProductSettings(process.env)!;
    expect(beforeUpdate.primaryPersonId).toBe(personId);
    expect(afterUpdate.primaryPersonId).toBeNull();
    expect(afterUpdate.primaryPersonRevision).not.toBe(beforeUpdate.primaryPersonRevision);
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
    expect(JSON.parse(summary)).toMatchObject({
      operation: "product.person.update",
      personId,
      requestedPrimary: false,
      commandHandle: "person-update-private-fields",
      expectedPersonRevision: beforeUpdate.personRevisionById?.[personId] ?? null,
      expectedPrimaryRevision: beforeUpdate.primaryPersonRevision ?? null
    });
    const serialized = JSON.stringify({ rows, payloads: await payloads(namespace) });
    expect(serialized).not.toContain("Second private name");
    expect(serialized).not.toContain("second private note");
    expect(serialized).not.toContain("persona-v2-private");
  });

  it("routes voice assignment through the native controller owner and resolves replay before owner enumeration", async () => {
    const namespace = nextNamespace();
    const personaId = "voice-binding-persona";
    const run = await setup(namespace, undefined, undefined, { MEMORY_PERSONA_ID: personaId });
    await registerLocalServiceRoutes(run.app, run.context, loadServerConfig(process.env));
    await registerPeopleVoiceRoutes(run.app, run.context, loadServerConfig(process.env));
    const personResponse = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: {
        displayName: "Voice binding Person",
        personaId,
        notes: "",
        primary: true,
        commandHandle: "voice-binding-person-create",
        expectedPersonRevision: null,
        expectedPrimaryRevision: null
      }
    });
    expect(personResponse.statusCode).toBe(200);
    const personId = personResponse.json().personId as string;
    const voiceProfileId = "speaker-acoustic-authority-id";
    const profiles = {
      list: vi.fn(async () => [
        { voiceProfileId, label: "Private acoustic label", enrolledAt: "2026-01-01T00:00:00Z" }
      ]),
      readAuthorityState: vi.fn(async () => ({
        complete: true,
        revision: "speaker-generation-1",
        profiles: [{ voiceProfileId, label: "Private acoustic label", enrolledAt: "2026-01-01T00:00:00Z" }]
      }))
    };
    vi.spyOn(run.context.providers, "getSTTProvider").mockReturnValue({
      voiceProfiles: profiles
    } as never);
    const bindingRead = vi.spyOn(run.context.runtime, "getVoiceProfileBindingAuthorityState");
    const payload = { personId, commandHandle: "voice-binding-a10.2-replay" };
    const beforeInvalidTarget = await events(namespace);
    const invalidTarget = await run.app.inject({
      method: "POST",
      url: `/voice-profiles/${voiceProfileId}/person`,
      payload: { personId: "not-a-product-person", commandHandle: "voice-binding-invalid-target" }
    });
    expect(invalidTarget.statusCode).toBe(404);
    expect(await events(namespace)).toHaveLength(beforeInvalidTarget.length);
    expect(await nativeIntent("voice-binding-invalid-target")).toBeUndefined();

    const first = await run.app.inject({
      method: "POST",
      url: `/voice-profiles/${voiceProfileId}/person`,
      payload
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "STORED", personId });
    expect(bindingRead).toHaveBeenCalledTimes(1);
    const firstState = await run.context.memory
      .getNativeVoiceBindingOwner()!
      .getBindingState(voiceProfileId, personaId);
    expect(firstState).toMatchObject({ status: "ACTIVE", personId, lineageStatus: "VERSIONED" });
    const intent = await nativeIntent(payload.commandHandle);
    expect(intent).toBeTruthy();
    expect(await nativeAttempt(intent!.intent_id)).toHaveLength(1);

    const replay = await run.app.inject({
      method: "POST",
      url: `/voice-profiles/${voiceProfileId}/person`,
      payload
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      status: "STORED",
      personId,
      intentId: intent!.intent_id
    });
    expect(bindingRead).toHaveBeenCalledTimes(1);
    expect((await nativeIntent(payload.commandHandle))?.intent_id).toBe(intent!.intent_id);
    expect(await nativeAttempt(intent!.intent_id)).toHaveLength(1);
    expect(await events(namespace)).toHaveLength(2);

    const removeHandle = "voice-binding-a10.2-remove";
    const removed = await run.app.inject({
      method: "DELETE",
      url: `/product/voices/${voiceProfileId}/binding?commandHandle=${removeHandle}`
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ status: "REMOVED" });
    const removeIntent = await nativeIntent(removeHandle);
    expect(removeIntent).toBeDefined();
    expect(await nativeAttempt(removeIntent!.intent_id)).toMatchObject([
      { evidence: { certainty: "APPLIED", nativeOwnerCommit: { ownerFamily: "VOICE_BINDING" } } }
    ]);
    expect(
      await run.context.memory
        .getNativeVoiceBindingOwner()!
        .getBindingState(voiceProfileId, personaId)
    ).toMatchObject({ status: "UNBOUND", lineageStatus: "VERSIONED" });
    expect(await events(namespace)).toHaveLength(3);

    const finalState = await run.context.memory
      .getNativeVoiceBindingOwner()!
      .getBindingState(voiceProfileId, personaId);
    expect(finalState.revision).not.toBe(firstState.revision);
  });

  it("reassigns one voice profile across persona scopes with one exact A9 owner commit", async () => {
    const namespace = nextNamespace();
    const run = await setup(namespace, undefined, undefined, { MEMORY_PERSONA_ID: "voice-scope-a" });
    await registerLocalServiceRoutes(run.app, run.context, loadServerConfig(process.env));
    const createPerson = async (displayName: string, personaId: string, commandHandle: string, primary: boolean) => {
      const current = readProductSettings(process.env);
      const response = await run.app.inject({
        method: "POST",
        url: "/product/people",
        payload: {
          displayName,
          personaId,
          notes: "",
          primary,
          commandHandle,
          expectedPersonRevision: null,
          expectedPrimaryRevision: current?.primaryPersonRevision ?? null
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().personId as string;
    };
    const personA = await createPerson("Person A", "voice-scope-a", "voice-scope-person-a", true);
    const personB = await createPerson("Person B", "voice-scope-b", "voice-scope-person-b", false);
    const voiceProfileId = "voice-profile-cross-persona";
    const profiles = {
      list: vi.fn(async () => [{ voiceProfileId, label: "private label" }]),
      readAuthorityState: vi.fn(async () => ({
        complete: true as const,
        revision: "speaker-generation-cross-persona",
        profiles: [{ voiceProfileId, label: "private label" }]
      }))
    };
    vi.spyOn(run.context.providers, "getSTTProvider").mockReturnValue({ voiceProfiles: profiles } as never);
    const bindingOwner = run.context.memory.getNativeVoiceBindingOwner()!;
    const applyBinding = vi.spyOn(bindingOwner, "applyBindingCommand");

    const assign = (personId: string, commandHandle: string) => run.app.inject({
      method: "POST",
      url: `/voice-profiles/${voiceProfileId}/person`,
      payload: { personId, commandHandle }
    });
    const first = await assign(personA, "voice-scope-bind-a");
    expect(first.statusCode, first.body).toBe(200);
    const previous = await run.context.memory.getNativeVoiceBindingOwner()!.getBindingState(voiceProfileId, "voice-scope-a");
    expect(previous).toMatchObject({ status: "ACTIVE", personId: personA, lineageStatus: "VERSIONED" });

    const switched = await assign(personB, "voice-scope-bind-b");
    expect(switched.statusCode, switched.body).toBe(200);
    expect(await run.context.memory.getNativeVoiceBindingOwner()!.getBindingState(voiceProfileId, "voice-scope-a"))
      .toMatchObject({ status: "UNBOUND", revision: expect.any(String), eventIds: [] });
    const current = await run.context.memory.getNativeVoiceBindingOwner()!.getBindingState(voiceProfileId, "voice-scope-b");
    expect(current).toMatchObject({ status: "ACTIVE", personId: personB, lineageStatus: "VERSIONED" });

    const switchedCommand = applyBinding.mock.calls.map(([command]) => command)
      .find((command) => command.commandHandle === "voice-scope-bind-b");
    expect(switchedCommand).toMatchObject({
      operation: "REPLACE",
      voiceProfileId,
      personaId: "voice-scope-b",
      previousVoiceProfileId: voiceProfileId,
      previousPersonaId: "voice-scope-a",
      expectedBindingRevision: null,
      expectedPreviousBindingRevision: previous.revision
    });
    const command = await nativePayload("voice-scope-bind-b");
    expect(command).toMatchObject({ payload_state: "REDACTED", payload: null });
    const intent = await nativeIntent("voice-scope-bind-b");
    expect(intent).toBeTruthy();
    const attempts = await nativeAttempt(intent!.intent_id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.evidence).toMatchObject({
      certainty: "APPLIED",
      nativeOwnerCommit: {
        ownerFamily: "VOICE_BINDING",
        eventIds: [expect.any(String), expect.any(String)],
        revisions: [
          { ownerReference: expect.stringContaining("voice-profile"), revision: expect.any(String) },
          { ownerReference: expect.stringContaining("voice-profile"), revision: expect.any(String) }
        ]
      }
    });
  });

  it("routes direct acoustic enrollment and deletion through committed CONTROL, A9, and exact SpeakerStore revisions", async () => {
    const namespace = nextNamespace();
    const run = await setup(namespace, undefined, undefined, { MEMORY_PERSONA_ID: "acoustic-delete-persona" });
    const rows: Array<{ voiceProfileId: string; label: string }> = [];
    const receipts = new Map<string, VoiceProfileNativeCommandReceipt>();
    let acousticRevision: string | null = "speaker-generation-0";
    let generation = 0;
    const voiceProfiles = {
      list: vi.fn(async () => rows.map((row) => ({ ...row }))),
      enroll: vi.fn(async () => ({ voiceProfileId: "legacy-direct-write", label: "" })),
      identify: vi.fn(async () => ({ voiceProfileId: null, confidence: 0 })),
      delete: vi.fn(async () => undefined),
      readAuthorityState: vi.fn(async () => ({
        complete: true,
        revision: acousticRevision,
        profiles: rows.map((row) => ({ ...row }))
      })),
      fenceNativeCommand: vi.fn(async (command: VoiceProfileNativeCommand) =>
        receipts.has(command.commandHandle) ? "APPLIED" as const : "READY" as const
      ),
      applyNativeCommand: vi.fn(async (command: VoiceProfileNativeCommand & { audioBase64?: string }) => {
        const previous = receipts.get(command.commandHandle);
        if (previous) return { status: "ALREADY_APPLIED" as const, receipt: previous };
        if (command.expectedRevision !== acousticRevision)
          return {
            status: "PROVEN_NOT_APPLIED" as const,
            reason: "REVISION_MISMATCH" as const,
            revision: acousticRevision
          };
        const causal = command.causalRefs[0];
        const committed = causal ? (await events(namespace)).find((row) => row.event_id === causal.eventId) : undefined;
        expect(committed?.envelope.command).toMatchObject({ kind: "RECEIPT", data: { receiptClass: "CONTROL" } });
        const admitted = await nativeIntent(command.commandHandle);
        expect(admitted?.intent["request"]["causalRefs"]).toContainEqual(causal);
        const attempts = await nativeAttempt(command.intentId);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.dispatch_started_at).not.toBeNull();
        if (command.operation === "ENROLL") {
          if (!command.audioBase64 || rows.some((row) => row.voiceProfileId === command.voiceProfileId))
            return {
              status: "PROVEN_NOT_APPLIED" as const,
              reason: "PROFILE_EXISTS" as const,
              revision: acousticRevision
            };
          rows.push({ voiceProfileId: command.voiceProfileId, label: command.label ?? "" });
        } else {
          const index = rows.findIndex((row) => row.voiceProfileId === command.voiceProfileId);
          if (index < 0)
            return {
              status: "PROVEN_NOT_APPLIED" as const,
              reason: "PROFILE_ABSENT" as const,
              revision: acousticRevision
            };
          rows.splice(index, 1);
        }
        const priorRevision = acousticRevision;
        acousticRevision = `speaker-generation-${++generation}`;
        const receipt: VoiceProfileNativeCommandReceipt = {
          commandHandle: command.commandHandle,
          intentId: command.intentId,
          attemptId: command.attemptId,
          fence: command.fence,
          payloadDigest: command.payloadDigest,
          operation: command.operation,
          voiceProfileId: command.voiceProfileId,
          priorRevision,
          resultingRevision: acousticRevision,
          causalRefs: command.causalRefs
        };
        receipts.set(command.commandHandle, receipt);
        return { status: "APPLIED" as const, receipt };
      }),
      reconcileNativeCommand: vi.fn(async (command: VoiceProfileNativeCommand) => {
        const receipt = receipts.get(command.commandHandle);
        return receipt
          ? { status: "ALREADY_APPLIED" as const, receipt }
          : {
              status: "PROVEN_NOT_APPLIED" as const,
              reason: "EXACT_PREDECESSOR_REMAINS" as const,
              revision: acousticRevision
            };
      })
    };
    vi.spyOn(run.context.providers, "getSTTProvider").mockReturnValue({ voiceProfiles } as never);
    await registerLocalServiceRoutes(run.app, run.context, loadServerConfig(process.env));
    await registerPeopleVoiceRoutes(run.app, run.context, loadServerConfig(process.env));

    const commandHandle = "a10.2-direct-acoustic-profile";
    const audio = wavWithMarker("DIRECT_PRIVATE_AUDIO_MARKER").toString("base64");
    const enroll = await run.app.inject({
      method: "POST",
      url: "/voice-profiles",
      payload: { audioBase64: audio, mimeType: "audio/wav", label: "DIRECT_PRIVATE_LABEL", commandHandle }
    });
    expect(enroll.statusCode, enroll.body).toBe(200);
    const voiceProfileId = enroll.json().voiceProfileId as string;
    expect(rows).toEqual([{ voiceProfileId, label: "DIRECT_PRIVATE_LABEL" }]);
    expect(voiceProfiles.applyNativeCommand).toHaveBeenCalledTimes(1);
    expect(voiceProfiles.enroll).not.toHaveBeenCalled();

    const enrolledEvents = await events(namespace);
    expect(enrolledEvents).toHaveLength(1);
    const enrollEvent = enrolledEvents[0]!;
    expect(enrollEvent.envelope.authority.surface.reference).toBe("yuvi:voice-profile-acoustic-control");
    const enrollPayload = (await payloads(namespace)).find((row) => row.text_content !== null)?.text_content ?? "";
    expect(enrollPayload).toContain("acoustic.profile.enroll");
    expect(enrollPayload).not.toContain(audio);
    expect(enrollPayload).not.toContain("DIRECT_PRIVATE_AUDIO_MARKER");
    expect(enrollPayload).not.toContain("DIRECT_PRIVATE_LABEL");
    const enrollCommand = await nativePayload(`${commandHandle}:acoustic-enroll`);
    expect(enrollCommand).toMatchObject({ payload_state: "REDACTED", payload: null });
    const enrollIntent = await nativeIntent(`${commandHandle}:acoustic-enroll`);
    expect(enrollIntent).toBeDefined();
    expect(enrollIntent!.intent["request"]["causalRefs"]).toContainEqual({
      kind: "JOURNAL_EVENT",
      namespace,
      eventId: enrollEvent.event_id
    });
    const enrollAttempts = await nativeAttempt(enrollIntent!.intent_id);
    expect(enrollAttempts).toHaveLength(1);
    expect(enrollAttempts[0]?.evidence).toMatchObject({
      certainty: "APPLIED",
      nativeOwnerCommit: {
        ownerFamily: "ACOUSTIC_PROFILE",
        revisions: [{ ownerReference: "speaker-store-generation", revision: "speaker-generation-1" }]
      }
    });

    const replay = await run.app.inject({
      method: "POST",
      url: "/voice-profiles",
      payload: { audioBase64: audio, mimeType: "audio/wav", label: "DIRECT_PRIVATE_LABEL", commandHandle }
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(voiceProfiles.applyNativeCommand).toHaveBeenCalledTimes(1);
    expect(await events(namespace)).toHaveLength(1);
    expect(await nativeAttempt(enrollIntent!.intent_id)).toHaveLength(1);

    const person = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: {
        displayName: "Acoustic binding Person",
        personaId: "acoustic-delete-persona",
        notes: "",
        primary: true,
        commandHandle: "a10.2-acoustic-binding-person",
        expectedPersonRevision: null,
        expectedPrimaryRevision: null
      }
    });
    expect(person.statusCode, person.body).toBe(200);
    const personId = person.json().personId as string;
    const binding = await run.app.inject({
      method: "POST",
      url: `/voice-profiles/${voiceProfileId}/person`,
      payload: { personId, commandHandle: "a10.2-acoustic-binding-assign" }
    });
    expect(binding.statusCode, binding.body).toBe(200);
    const blockedDelete = await run.app.inject({
      method: "DELETE",
      url: `/voice-profiles/${voiceProfileId}?commandHandle=a10.2-acoustic-delete-bound`
    });
    expect(blockedDelete.statusCode).toBe(409);
    expect(voiceProfiles.applyNativeCommand).toHaveBeenCalledTimes(1);

    const unbind = await run.app.inject({
      method: "DELETE",
      url: `/product/voices/${voiceProfileId}/binding?commandHandle=a10.2-acoustic-binding-remove`
    });
    expect(unbind.statusCode, unbind.body).toBe(200);
    expect(unbind.json()).toMatchObject({ status: "REMOVED" });

    const deletion = await run.app.inject({
      method: "DELETE",
      url: `/voice-profiles/${voiceProfileId}?commandHandle=a10.2-direct-acoustic-delete`
    });
    expect(deletion.statusCode, deletion.body).toBe(200);
    expect(rows).toHaveLength(0);
    expect(voiceProfiles.applyNativeCommand).toHaveBeenCalledTimes(2);
    const finalEvents = await events(namespace);
    expect(finalEvents).toHaveLength(5);
    const deleteIntent = await nativeIntent("a10.2-direct-acoustic-delete:acoustic-delete");
    expect(deleteIntent).toBeDefined();
    const deleteRefs = deleteIntent!.intent["request"]["causalRefs"] as Array<{ eventId: string }>;
    expect(deleteRefs).toHaveLength(1);
    expect(finalEvents.some((row) => row.event_id === deleteRefs[0]!.eventId)).toBe(true);
    expect(await nativeAttempt(deleteIntent!.intent_id)).toMatchObject([
      {
        evidence: {
          certainty: "APPLIED",
          nativeOwnerCommit: {
            ownerFamily: "ACOUSTIC_PROFILE",
            revisions: [{ ownerReference: "speaker-store-generation", revision: "speaker-generation-2" }]
          }
        }
      }
    ]);
  });

  it("persists and enforces the immutable acoustic replacement plan with three exact A9 child references", async () => {
    const namespace = nextNamespace();
    const personaId = "voice-replacement-workflow-persona";
    const run = await setup(namespace, undefined, undefined, { MEMORY_PERSONA_ID: personaId });
    const oldVoiceProfileId = "voice-replacement-old-profile";
    const acousticRows = [{ voiceProfileId: oldVoiceProfileId, label: "old profile" }];
    const nativeReceipts = new Map<string, VoiceProfileNativeCommandReceipt>();
    let acousticRevision: string | null = "acoustic-generation-0";
    let generation = 0;
    const acousticProfiles = {
      list: vi.fn(async () => acousticRows.map((row) => ({ ...row }))),
      enroll: vi.fn(async () => ({ voiceProfileId: "unused", label: "unused" })),
      identify: vi.fn(async () => ({ voiceProfileId: null, confidence: 0 })),
      delete: vi.fn(async () => undefined),
      readAuthorityState: vi.fn(async () => ({
        complete: true,
        revision: acousticRevision,
        profiles: acousticRows.map((row) => ({ ...row }))
      })),
      fenceNativeCommand: vi.fn(async (command: VoiceProfileNativeCommand) =>
        nativeReceipts.has(command.commandHandle) ? "APPLIED" as const : "READY" as const
      ),
      applyNativeCommand: vi.fn(async (command: VoiceProfileNativeCommand & { audioBase64?: string }) => {
        const existing = nativeReceipts.get(command.commandHandle);
        if (existing) return { status: "ALREADY_APPLIED" as const, receipt: existing };
        if (command.expectedRevision !== acousticRevision)
          return { status: "PROVEN_NOT_APPLIED" as const, reason: "REVISION_MISMATCH" as const, revision: acousticRevision };
        if (command.operation === "ENROLL") {
          if (!command.audioBase64 || acousticRows.some((row) => row.voiceProfileId === command.voiceProfileId))
            return { status: "PROVEN_NOT_APPLIED" as const, reason: "PROFILE_EXISTS" as const, revision: acousticRevision };
          acousticRows.push({ voiceProfileId: command.voiceProfileId, label: command.label ?? "" });
        } else {
          const index = acousticRows.findIndex((row) => row.voiceProfileId === command.voiceProfileId);
          if (index < 0) return { status: "PROVEN_NOT_APPLIED" as const, reason: "PROFILE_ABSENT" as const, revision: acousticRevision };
          acousticRows.splice(index, 1);
        }
        const priorRevision = acousticRevision;
        acousticRevision = `acoustic-generation-${++generation}`;
        const receipt: VoiceProfileNativeCommandReceipt = {
          commandHandle: command.commandHandle,
          intentId: command.intentId,
          attemptId: command.attemptId,
          fence: command.fence,
          payloadDigest: command.payloadDigest,
          operation: command.operation,
          voiceProfileId: command.voiceProfileId,
          priorRevision,
          resultingRevision: acousticRevision,
          causalRefs: command.causalRefs
        };
        nativeReceipts.set(command.commandHandle, receipt);
        return { status: "APPLIED" as const, receipt };
      }),
      reconcileNativeCommand: vi.fn(async (command: VoiceProfileNativeCommand) => {
        const receipt = nativeReceipts.get(command.commandHandle);
        return receipt
          ? { status: "ALREADY_APPLIED" as const, receipt }
          : { status: "PROVEN_NOT_APPLIED" as const, reason: "EXACT_PREDECESSOR_REMAINS" as const, revision: acousticRevision };
      })
    };
    vi.spyOn(run.context.providers, "getSTTProvider").mockReturnValue({
      voiceProfiles: acousticProfiles
    } as never);
    await registerLocalServiceRoutes(run.app, run.context, loadServerConfig(process.env));
    await registerPeopleVoiceRoutes(run.app, run.context, loadServerConfig(process.env));

    const personResponse = await run.app.inject({
      method: "POST",
      url: "/product/people",
      payload: {
        displayName: "Replacement Person",
        personaId,
        notes: "",
        primary: true,
        commandHandle: "workflow-person-create",
        expectedPersonRevision: null,
        expectedPrimaryRevision: null
      }
    });
    expect(personResponse.statusCode).toBe(200);
    const personId = personResponse.json().personId as string;
    const initialBinding = await run.app.inject({
      method: "POST",
      url: `/voice-profiles/${oldVoiceProfileId}/person`,
      payload: { personId, commandHandle: "workflow-old-binding" }
    });
    expect(initialBinding.statusCode).toBe(200);

    const workflowId = "acoustic-replacement-workflow-a10.2";
    const recordings = [
      wavWithMarker("WORKFLOW_PRIVATE_AUDIO").toString("base64"),
      wavWithMarker().toString("base64"),
      wavWithMarker().toString("base64")
    ];
    const sampleRefs = retainEnrollmentSamples(recordings, `${workflowId}:acoustic-samples`);
    const newVoiceProfileId = `voice_${createHash("sha256").update(workflowId).digest("hex").slice(0, 32)}`;
    const replacementPlan = createAcousticReplacementWorkflowPlan({
      workflowId,
      newVoiceProfileId,
      previousVoiceProfileId: oldVoiceProfileId,
      personId,
      personaId,
      label: "Replacement Person",
      ...sampleRefs
    });
    const outOfOrder = await run.context.productPersonCommands.execute(
      {
        family: "ACOUSTIC_PROFILE",
        commandHandle: `${workflowId}:acoustic-retire-old`,
        operation: "DELETE",
        voiceProfileId: oldVoiceProfileId,
        expectedAcousticRevision: acousticRevision
      },
      () => true,
      { plan: replacementPlan, stepKey: "retire_old" }
    );
    expect(outOfOrder).toMatchObject({ status: "CONFLICT" });
    expect(await nativeIntent(`${workflowId}:acoustic-retire-old`)).toBeUndefined();

    const enrollment = await run.app.inject({
      method: "POST",
      url: "/product/voices/enroll",
      payload: {
        personId,
        commandHandle: workflowId,
        replaceVoiceId: oldVoiceProfileId,
        recordings
      }
    });
    expect(enrollment.statusCode, enrollment.body).toBe(200);
    const currentProfiles = await acousticProfiles.list();
    expect(currentProfiles).toHaveLength(1);
    expect(currentProfiles[0]?.voiceProfileId).not.toBe(oldVoiceProfileId);
    const enrolledTarget = await pool!.query(
      `select target_reference from effect_command_payloads where command_handle=$1`,
      ["acoustic-replacement-workflow-a10.2:acoustic-enroll"]
    );
    expect(enrolledTarget.rows[0]?.["target_reference"]).toBe(currentProfiles[0]?.voiceProfileId);
    expect(await run.context.runtime.getVoiceProfilePerson(oldVoiceProfileId)).toBeNull();
    expect(await run.context.runtime.getVoiceProfilePerson(currentProfiles[0]!.voiceProfileId)).toBe(personId);

    const workflow = await pool!.query(
      `select workflow_id,workflow_kind,plan_digest,plan::text as plan from native_control_workflows where workflow_id=$1`,
      [workflowId]
    );
    expect(workflow.rows).toHaveLength(1);
    expect(workflow.rows[0]).toMatchObject({ workflow_kind: "ACOUSTIC_PROFILE_REPLACEMENT" });
    const children = await pool!.query(
      `select step_key,ordinal,command_handle,intent_id,payload_ref from native_control_workflow_children
       where workflow_id=$1 order by ordinal`,
      [workflowId]
    );
    expect(children.rows.map((row) => row["step_key"])).toEqual(["enroll_new", "switch_binding", "retire_old"]);
    expect(children.rows.map((row) => row["ordinal"])).toEqual([0, 1, 2]);
    for (const child of children.rows) {
      const attempts = await nativeAttempt(String(child["intent_id"]));
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.evidence).toMatchObject({ certainty: "APPLIED" });
      expect(attempts[0]?.observation_version).toBe("effect-observation.v2");
      expect((attempts[0]?.evidence?.["nativeOwnerCommit"] as Record<string, unknown>)?.["revisions"]).toBeTruthy();
    }
    const planText = String(workflow.rows[0]?.["plan"]);
    expect(planText).not.toContain("WORKFLOW_PRIVATE_AUDIO");
    expect(planText).not.toContain("RIFF");
    expect(await nativeIntent("acoustic-replacement-workflow-a10.2")).toBeUndefined();
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
        const receipt = await actual.admit(input);
        committed = true;
        return receipt;
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
    run.context.productPersonCommands = {
      async execute() {
        return { status: "UNAVAILABLE", reason: "DURABLE_NATIVE_CONTROL_UNAVAILABLE" };
      },
      async resolveExisting() {
        return { status: "UNAVAILABLE", reason: "DURABLE_NATIVE_CONTROL_UNAVAILABLE" };
      }
    };
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
      payload: {
        displayName: "Rui",
        primary: true,
        commandHandle: "person-create-journal-unavailable",
        expectedPersonRevision: null,
        expectedPrimaryRevision: null
      }
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
