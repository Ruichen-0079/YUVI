import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import {
  effectAuthority,
  effectRequest,
  fixtureIdentity
} from "../../../packages/effects/src/test-fixture.js";
import { readSqlMigrations } from "../../../packages/memory/src/migrations.js";
import { createAppContext, type AppContext } from "./context.js";
import { loadServerConfig } from "./config.js";

const databaseUrl = process.env["YUVI_EFFECT_TEST_DATABASE_URL"];
const originalEnv = { ...process.env };
const schema = `a91_composition_${randomBytes(6).toString("hex")}`;
let admin: PostgresPool, pool: PostgresPool, context: AppContext;
let directory: string;
let request: ReturnType<typeof effectRequest>;
const app = Fastify({ logger: false });
describe.skipIf(!databaseUrl)("A9.1 production AppContext shared PostgreSQL composition", () => {
  beforeAll(async () => {
    admin = createPostgresPool(databaseUrl!);
    await admin.query(`create schema "${schema}"`);
    pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema},public` });
    for (const migration of await readSqlMigrations()) await pool.query(migration.sql);
    directory = await mkdtemp(join(tmpdir(), "yuvi-a91-composition-"));
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    process.env = {
      NODE_ENV: "test",
      RUNTIME_MODE: "test",
      LOG_LEVEL: "silent",
      PROVIDER_ALLOW_MOCKS: "true",
      DATABASE_URL: scopedUrl.toString(),
      MEMORY_REPOSITORY: "postgres",
      CONVERSATION_REPOSITORY: "postgres",
      MEMORY_BACKEND: "legacy",
      MEMORY_EXTRACTOR: "rule-based",
      EVENT_BUS: "in-memory",
      MEMORY_INGESTION_COORDINATOR_ENABLED: "false",
      MEMORY_MAINTENANCE_ENABLED: "false",
      YUVI_RUNTIME_ENV_DIR: directory,
      YUVI_JOURNAL_NAMESPACE: schema
    };
    context = await createAppContext(app.log, loadServerConfig(process.env));
    const journal = new PostgresJournalRepository(pool, {
      namespace: schema,
      authorityBuilder() {
        throw Error("host only");
      }
    });
    const receipt = await journal.appendWithHostAuthority(
      {
        command: {
          version: "life-event-command.v1",
          kind: "RECEIPT",
          causalParents: [],
          occurrenceTime: { state: "UNKNOWN" },
          data: { receiptClass: "CONTROL", evidenceSelectors: [] }
        }
      },
      {
        ...fixtureIdentity,
        surface: { kind: "LOCAL", reference: "a91-composition-test" },
        policyVersion: "test.v1",
        producer: { name: "a91-host-test", version: "1" },
        correlations: [],
        sourceReferences: [{ kind: "UNRESOLVED_SOURCE", reason: "synthetic local control" }],
        payloads: []
      }
    );
    request = {
      ...effectRequest("composition-effect"),
      causalRefs: [{ kind: "JOURNAL_EVENT", namespace: schema, eventId: receipt.envelope.eventId }]
    };
  });
  afterAll(async () => {
    if (context) {
      await context.runtime.sealAndDrainMemoryWrites();
      context.embodiedPresentationBridge.close();
      await context.memoryIngestionCoordinator.shutdown({ graceMs: 100 });
      await context.finalizedIngestionRepository.close?.();
      await context.memoryRepository.close?.();
      await context.conversationRepository.close?.();
      await context.closeDatabasePool();
    }
    await app.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });
  it("shares durable host authority across Runtime reload, preserves exact replay, and never dispatches", async () => {
    const admission = context.effectIntents;
    const runtime = context.runtime;
    const publish = vi.spyOn(context.eventBus, "publish");
    const write = vi.spyOn(context.memory, "rememberInteraction");
    const present = vi.spyOn(context.embodiedPresentationBridge, "present");
    const chat = vi.spyOn(context.providers, "getChatProvider");
    const admitted = await runtime.admitPendingEffectIntent(
      request,
      effectAuthority().snapshot,
      runtime.getProactiveState().activityRevision
    );
    await context.reloadRuntimeConfig({ ...process.env, DIRECT_CONTEXT_MAX_TURNS: "4" });
    expect(context.effectIntents).toBe(admission);
    expect(context.runtime).not.toBe(runtime);
    expect(
      await context.runtime.admitPendingEffectIntent(
        request,
        effectAuthority().snapshot,
        context.runtime.getProactiveState().activityRevision
      )
    ).toEqual(admitted);
    expect((await pool.query("select count(*)::int n from effect_intents")).rows[0]?.n).toBe(1);
    expect(await admission.listPending()).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    await expect(
      runtime.admitPendingEffectIntent(request, effectAuthority().snapshot, 0)
    ).rejects.toThrow(/disposed/);
  });
  it("existing Memory mapping reads cannot create A9 dispatch work", async () => {
    const before = await pool.query(
      "select intent_id, payload_digest from effect_intents order by intent_id"
    );
    expect(
      await context.existingMemoryEffectIntents.finalized("absent-finalized-test-work")
    ).toEqual([]);
    expect(await context.existingMemoryEffectIntents.dream("absent-dream-test-work")).toEqual([]);
    expect(
      (await pool.query("select intent_id, payload_digest from effect_intents order by intent_id"))
        .rows
    ).toEqual(before.rows);
  });
});
