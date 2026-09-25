import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { JournalStoreError, PostgresJournalRepository } from "@companion/journal";
import type { JournalCommittedEnvelope } from "@companion/protocol";
import type { VoiceProfileProvider } from "@companion/providers";
import {
  readSqlMigrations,
  runPostgresMigrations
} from "../../../packages/memory/src/migrations.js";
import { loadServerConfig } from "./config.js";
import { createAppContext, type AppContext } from "./context.js";
import {
  HostVoiceControlReceiptAdmission,
  type VoiceControlReceiptInput
} from "./voice-control-receipt-admission.js";
import { registerLocalServiceRoutes } from "./routes/local-services.js";
import { registerPeopleVoiceRoutes } from "./routes/people-voices.js";
import {
  importLegacyConfiguration,
  productPath,
  writePrivateJson
} from "./services/product-store.js";
import { retainVoiceSample, voiceReviews } from "./services/voice-review.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `voice_control_${randomBytes(5).toString("hex")}`;
const quotedSchema = `"${schema}"`;
let adminPool: PostgresPool | undefined;
let pool: PostgresPool | undefined;
let sequence = 0;
const oldEnv = { ...process.env };
const runs: Array<{ app: ReturnType<typeof Fastify>; context: AppContext; dir: string }> = [];

type Profile = { voiceProfileId: string; label: string };
function profiles(initial: Profile[] = []) {
  const rows = [...initial];
  return {
    rows,
    list: vi.fn(async () => rows.map((row) => ({ ...row }))),
    enroll: vi.fn(async (input: { voiceProfileId: string; label: string }) => {
      const profile = { voiceProfileId: input.voiceProfileId, label: input.label };
      rows.push(profile);
      return profile;
    }),
    identify: vi.fn(async () => ({ status: "NO_MATCH" as const })),
    delete: vi.fn(async (id: string) => {
      const index = rows.findIndex((row) => row.voiceProfileId === id);
      if (index >= 0) rows.splice(index, 1);
    })
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => (resolve = accept));
  return { promise, resolve };
}

function nextNamespace() {
  sequence += 1;
  return `a8.2f1-voice-control-${sequence}`;
}

function repository(namespace: string) {
  return new PostgresJournalRepository(pool!, {
    namespace,
    authorityBuilder() {
      throw new Error("Voice control receipts require explicit host authority.");
    }
  });
}

async function eventRows(namespace: string) {
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

async function payloadRows(namespace: string) {
  const result = await pool!.query(
    `select descriptor, text_content from journal_payloads where journal_namespace = $1 order by payload_id`,
    [namespace]
  );
  return result.rows as Array<{ descriptor: Record<string, any>; text_content: string | null }>;
}

async function lockNamespace(namespace: string) {
  await pool!.query(
    `insert into journal_namespaces (journal_namespace, current_seq) values ($1, 0) on conflict (journal_namespace) do nothing`,
    [namespace]
  );
  const client = await pool!.connect();
  await client.query("begin");
  await client.query(
    "select current_seq from journal_namespaces where journal_namespace = $1 for update",
    [namespace]
  );
  return async () => {
    await client.query("commit");
    client.release();
  };
}

function wavWithMarker(marker = "RAW_AUDIO_MARKER_123") {
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

async function setup(namespace: string, voiceProfiles = profiles()) {
  const dir = await mkdtemp(join(tmpdir(), "yuvi-a8-2f1-voice-control-"));
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
    YUVI_RUNTIME_DATA_DIR: join(dir, "data"),
    YUVI_JOURNAL_NAMESPACE: namespace
  };
  delete process.env["DATABASE_URL"];
  const settings = importLegacyConfiguration(process.env);
  settings.people = [
    {
      id: "person-saved-1",
      displayName: "PERSON_DISPLAY_NAME_MARKER",
      personaId: "persona-voice",
      notes: ""
    }
  ];
  settings.primaryPersonId = "person-saved-1";
  writePrivateJson(productPath(), settings);
  const config = loadServerConfig(process.env);
  const app = Fastify({ logger: false });
  const context = await createAppContext(app.log, config);
  vi.spyOn(context.providers, "getSTTProvider").mockReturnValue({ voiceProfiles } as never);
  context.voiceControlReceiptAdmission = new HostVoiceControlReceiptAdmission(
    repository(namespace)
  );
  await registerLocalServiceRoutes(app, context, config);
  await registerPeopleVoiceRoutes(app, context, config);
  const run = { app, context, dir };
  runs.push(run);
  return { ...run, profiles: voiceProfiles };
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

function heldAdmission(run: { context: AppContext }, namespace: string) {
  const reached = deferred<VoiceControlReceiptInput>();
  const real = new HostVoiceControlReceiptAdmission(repository(namespace));
  run.context.voiceControlReceiptAdmission = {
    async admit(input) {
      reached.resolve(input);
      await real.admit(input);
    }
  };
  return reached;
}

describe.skipIf(!databaseUrl)("A8.2f1 voice control receipts with real PostgreSQL", () => {
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

  it("holds profile enrollment until a real Journal transaction commits and stores no audio or label", async () => {
    const namespace = nextNamespace();
    const run = await setup(namespace);
    const reached = heldAdmission(run, namespace);
    const release = await lockNamespace(namespace);
    const input = wavWithMarker();
    const request = run.app.inject({
      method: "POST",
      url: "/voice-profiles",
      payload: {
        audioBase64: input.toString("base64"),
        mimeType: "audio/wav",
        label: "VOICE_LABEL_SECRET_MARKER"
      }
    });
    const command = await reached.promise;
    expect(command.operation).toBe("VOICE_PROFILE_ENROLL");
    expect(run.profiles.enroll).not.toHaveBeenCalled();
    expect(run.profiles.rows).toEqual([]);
    await release();
    const response = await request;
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().voiceProfileId as string;
    expect(run.profiles.enroll).toHaveBeenCalledWith(
      expect.objectContaining({ voiceProfileId: id })
    );
    const rows = await eventRows(namespace);
    expect(rows).toHaveLength(1);
    const envelope = rows[0]!.envelope;
    expect(envelope.command).toMatchObject({ kind: "RECEIPT", data: { receiptClass: "CONTROL" } });
    expect(envelope.authority).toMatchObject({
      principal: { state: "UNRESOLVED" },
      binding: { state: "UNRESOLVED" },
      subjects: [],
      audience: { kind: "UNKNOWN" }
    });
    const descriptors = envelope.authority.payloads;
    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modality: "AUDIO", retention: "NOT_RETAINED", selectable: false })
      ])
    );
    if (envelope.command.kind !== "RECEIPT") throw new Error("Expected a receipt command.");
    expect(envelope.command.data.evidenceSelectors).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ modality: "AUDIO" })])
    );
    const serialized = JSON.stringify({ rows, payloads: await payloadRows(namespace) });
    expect(serialized).not.toContain(input.toString("base64"));
    for (const marker of [
      "RAW_AUDIO_MARKER_123",
      "VOICE_LABEL_SECRET_MARKER",
      "PERSON_DISPLAY_NAME_MARKER",
      "EMBEDDING_SECRET_MARKER"
    ])
      expect(serialized).not.toContain(marker);
    expect(serialized).toContain(id); // A profile ID is a control target, never authority or dedup identity.
    expect(
      (
        await pool!.query(
          "select count(*)::int as n from journal_source_dedup where journal_namespace = $1",
          [namespace]
        )
      ).rows[0]?.["n"]
    ).toBe(0);
    const text = (await payloadRows(namespace)).filter((row) => row.text_content !== null);
    expect(text).toHaveLength(1);
    expect(text[0]?.text_content).toContain("voice.profile.enroll");

    const reopened = repository(namespace);
    const reconstructed = await reopened.get({
      kind: "JOURNAL_EVENT",
      namespace,
      eventId: rows[0]!.event_id
    });
    expect(reconstructed).toMatchObject({
      command: { kind: "RECEIPT", data: { receiptClass: "CONTROL" } },
      authority: {
        principal: { state: "UNRESOLVED" },
        binding: { state: "UNRESOLVED" },
        subjects: []
      }
    });
    const textDescriptor = reconstructed?.authority.payloads.find(
      (payload) => payload.modality === "TEXT"
    );
    const audioDescriptor = reconstructed?.authority.payloads.find(
      (payload) => payload.modality === "AUDIO"
    );
    expect(textDescriptor).toBeDefined();
    expect(audioDescriptor).toMatchObject({ retention: "NOT_RETAINED", selectable: false });
    expect(await reopened.resolveRetainedText(textDescriptor!.ref)).toMatchObject({
      text: expect.stringContaining("voice.profile.enroll")
    });
    expect(await reopened.resolveRetainedText(audioDescriptor!.ref)).toBeNull();
  });

  it("holds Person binding until the receipt commits and preserves the saved Person as target only", async () => {
    const namespace = nextNamespace();
    const id = "voice-target-profile";
    const run = await setup(
      namespace,
      profiles([{ voiceProfileId: id, label: "ACOUSTIC_LABEL_SECRET" }])
    );
    const provider = run.context.memory.getVoiceBindingProvider()!;
    const write = vi.spyOn(provider, "writeEvent");
    const reached = heldAdmission(run, namespace);
    const release = await lockNamespace(namespace);
    const request = run.app.inject({
      method: "POST",
      url: `/voice-profiles/${id}/person`,
      payload: { personId: "person-saved-1" }
    });
    expect(await reached.promise).toMatchObject({
      operation: "VOICE_PROFILE_BIND_PERSON",
      voiceProfileId: id,
      personId: "person-saved-1"
    });
    expect(write).not.toHaveBeenCalled();
    await release();
    const response = await request;
    expect(response.statusCode, response.body).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await run.context.runtime.getVoiceProfilePerson(id)).toBe("person-saved-1");
    const envelope = (await eventRows(namespace))[0]!.envelope;
    expect(envelope.authority).toMatchObject({
      principal: { state: "UNRESOLVED" },
      binding: { state: "UNRESOLVED" },
      subjects: []
    });
    expect(JSON.stringify(envelope.authority)).not.toContain("person-saved-1");
    const payload = (await payloadRows(namespace))[0]?.text_content ?? "";
    expect(payload).toContain('"personId":"person-saved-1"');
    expect(payload).not.toContain("PERSON_DISPLAY_NAME_MARKER");
    expect(payload).not.toContain("ACOUSTIC_LABEL_SECRET");
  });

  it("rejects a non-Product Person target before Journal admission", async () => {
    const namespace = nextNamespace();
    const id = "voice-target-profile";
    const run = await setup(namespace, profiles([{ voiceProfileId: id, label: "profile" }]));
    const response = await run.app.inject({
      method: "POST",
      url: `/voice-profiles/${id}/person`,
      payload: { personId: "not-saved" }
    });
    expect(response.statusCode).toBe(404);
    expect(await eventRows(namespace)).toHaveLength(0);
  });

  it("holds profile deletion until receipt commit and then preserves the existing binding/profile/sample order", async () => {
    const namespace = nextNamespace();
    const id = "voice-delete-profile";
    const run = await setup(namespace, profiles([{ voiceProfileId: id, label: "profile" }]));
    expect(await run.context.runtime.bindVoiceProfileToPerson(id, "person-saved-1")).toMatchObject({
      status: "STORED"
    });
    const sample = retainVoiceSample(wavWithMarker("REVIEW_AUDIO_MARKER").toString("base64"), id);
    const remove = vi.spyOn(run.context.runtime, "removeVoiceProfileBinding");
    const reached = heldAdmission(run, namespace);
    const release = await lockNamespace(namespace);
    const request = run.app.inject({ method: "DELETE", url: `/voice-profiles/${id}` });
    expect(await reached.promise).toMatchObject({
      operation: "VOICE_PROFILE_DELETE",
      voiceProfileId: id
    });
    expect(remove).not.toHaveBeenCalled();
    expect(run.profiles.delete).not.toHaveBeenCalled();
    expect(await run.context.runtime.getVoiceProfilePerson(id)).toBe("person-saved-1");
    expect(voiceReviews().some((row) => row.id === sample.id)).toBe(true);
    await release();
    const response = await request;
    expect(response.statusCode, response.body).toBe(200);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(run.profiles.delete).toHaveBeenCalledWith(id);
    expect(await run.context.runtime.getVoiceProfilePerson(id)).toBeNull();
    expect(voiceReviews().some((row) => row.id === sample.id)).toBe(false);
    expect(await eventRows(namespace)).toHaveLength(1);
  });

  it("holds binding removal until Journal commit", async () => {
    const namespace = nextNamespace();
    const id = "voice-unbind-profile";
    const run = await setup(namespace, profiles([{ voiceProfileId: id, label: "profile" }]));
    await run.context.runtime.bindVoiceProfileToPerson(id, "person-saved-1");
    const reached = heldAdmission(run, namespace);
    const release = await lockNamespace(namespace);
    const request = run.app.inject({ method: "DELETE", url: `/product/voices/${id}/binding` });
    expect(await reached.promise).toMatchObject({
      operation: "VOICE_PROFILE_BINDING_REMOVE",
      voiceProfileId: id
    });
    expect(await run.context.runtime.getVoiceProfilePerson(id)).toBe("person-saved-1");
    await release();
    const response = await request;
    expect(response.statusCode, response.body).toBe(200);
    expect(await run.context.runtime.getVoiceProfilePerson(id)).toBeNull();
    expect(await eventRows(namespace)).toHaveLength(1);
  });

  it("keeps committed receipts when post-admission operations fail", async () => {
    const namespace = nextNamespace();
    const profileId = "post-receipt-binding-error";
    const run = await setup(
      namespace,
      profiles([{ voiceProfileId: profileId, label: "private profile label" }])
    );
    run.profiles.enroll.mockRejectedValueOnce(new Error("provider failure"));
    const enrollment = await run.app.inject({
      method: "POST",
      url: "/voice-profiles",
      payload: { audioBase64: "U0VDUkVUX0FVRElP", mimeType: "audio/wav", label: "private label" }
    });
    expect(enrollment.statusCode).toBe(422);
    expect(await eventRows(namespace)).toHaveLength(1);
    const write = vi
      .spyOn(run.context.memory.getVoiceBindingProvider()!, "writeEvent")
      .mockRejectedValueOnce(new Error("memory failure"));
    const binding = await run.app.inject({
      method: "POST",
      url: `/voice-profiles/${profileId}/person`,
      payload: { personId: "person-saved-1" }
    });
    expect(binding.statusCode).toBe(503);
    expect(write).toHaveBeenCalledTimes(1);
    expect(await eventRows(namespace)).toHaveLength(2);
    expect(await run.context.runtime.getVoiceProfilePerson(profileId)).toBeNull();
  });

  it("retains binding Memory evidence when the separate reference-index append fails", async () => {
    const namespace = nextNamespace();
    const id = "voice-reference-index-failure";
    const run = await setup(namespace, profiles([{ voiceProfileId: id, label: "profile" }]));
    await run.context.runtime.bindVoiceProfileToPerson("voice-index-seed", "person-saved-1");
    const provider = run.context.memory.getVoiceBindingProvider()!;
    const actualWrite = provider.writeEvent.bind(provider);
    const write = vi.spyOn(provider, "writeEvent");
    let eventId: string | undefined;
    let scope: string | undefined;
    write.mockImplementation(async (input) => {
      const result = await actualWrite(input);
      eventId = result.eventId ?? result.event?.id;
      scope = input.scope;
      return result;
    });
    eventId = undefined;
    await chmod(run.dir, 0o500);
    try {
      const response = await run.app.inject({
        method: "POST",
        url: `/voice-profiles/${id}/person`,
        payload: { personId: "person-saved-1" }
      });
      expect(response.statusCode, response.body).toBe(503);
      expect(write).toHaveBeenCalled();
      expect(await write.mock.results[0]?.value).toMatchObject({ status: "written" });
      expect(await eventRows(namespace)).toHaveLength(1);
      expect(eventId).toBeTruthy();
    } finally {
      await chmod(run.dir, 0o700);
    }
    const event = await provider.getEvent({ id: eventId!, scope: scope! });
    expect(event).not.toBeNull();
    expect(await run.context.runtime.getVoiceProfilePerson(id)).toBeNull();
  });

  it("keeps the receipt and removed binding when later profile deletion fails", async () => {
    const namespace = nextNamespace();
    const id = "voice-delete-failure";
    const fake = profiles([{ voiceProfileId: id, label: "profile" }]);
    fake.delete.mockRejectedValueOnce(new Error("sidecar delete failure"));
    const run = await setup(namespace, fake);
    await run.context.runtime.bindVoiceProfileToPerson(id, "person-saved-1");
    const response = await run.app.inject({ method: "DELETE", url: `/voice-profiles/${id}` });
    expect(response.statusCode).toBe(503);
    expect(await eventRows(namespace)).toHaveLength(1);
    expect(await run.context.runtime.getVoiceProfilePerson(id)).toBeNull();
    expect(fake.rows).toHaveLength(1);
  });

  it("keeps the receipt and deleted profile when review cleanup fails", async () => {
    const namespace = nextNamespace();
    const id = "voice-review-cleanup-failure";
    const fake = profiles([{ voiceProfileId: id, label: "profile" }]);
    const run = await setup(namespace, fake);
    retainVoiceSample(wavWithMarker("REVIEW_CLEANUP_MARKER").toString("base64"), id);
    await chmod(join(run.dir, "data"), 0o500);
    try {
      const response = await run.app.inject({ method: "DELETE", url: `/voice-profiles/${id}` });
      expect(response.statusCode).toBe(503);
      expect(await eventRows(namespace)).toHaveLength(1);
      expect(fake.rows).toHaveLength(0);
      expect(voiceReviews().some((row) => row.voiceProfileId === id)).toBe(true);
    } finally {
      await chmod(join(run.dir, "data"), 0o700);
    }
  });

  it("records an explicit removal receipt even when the profile is already unbound", async () => {
    const namespace = nextNamespace();
    const run = await setup(namespace);
    const response = await run.app.inject({
      method: "DELETE",
      url: "/product/voices/never-bound/binding"
    });
    expect(response.statusCode).toBe(200);
    expect(await eventRows(namespace)).toHaveLength(1);
    const command = (await eventRows(namespace))[0]?.envelope.command;
    expect(command?.kind).toBe("RECEIPT");
    if (command?.kind !== "RECEIPT") throw new Error("Expected a receipt command.");
    expect(command.data.receiptClass).toBe("CONTROL");
  });

  it("retains the receipt when binding removal reports a post-admission owner failure", async () => {
    const namespace = nextNamespace();
    const id = "voice-unbind-owner-failure";
    const run = await setup(namespace);
    await run.context.runtime.bindVoiceProfileToPerson(id, "person-saved-1");
    vi.spyOn(run.context.runtime, "removeVoiceProfileBinding").mockResolvedValue({
      status: "UNAVAILABLE"
    });
    const response = await run.app.inject({
      method: "DELETE",
      url: `/product/voices/${id}/binding`
    });
    expect(response.statusCode).toBe(409);
    expect(await eventRows(namespace)).toHaveLength(1);
    expect(await run.context.runtime.getVoiceProfilePerson(id)).toBe("person-saved-1");
  });
});
