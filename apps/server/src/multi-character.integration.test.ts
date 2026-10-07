import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { defineCharacter, characterPersonaId } from "@companion/core";
import { buildMemoryScope } from "@companion/memory";
import { readSqlMigrations } from "../../../packages/memory/src/migrations.js";
import {
  characterComposition,
  fileProductPersonSource,
  type ProductPersonSource
} from "./character-composition.js";
import { defaultProductSettings, writeProductSettings } from "./services/product-store.js";
import { claimCharacterDatabase, claimCharacterFiles } from "./character-storage.js";
import { toConversationalJournalRef } from "./conversational-receipt-admission.js";
import { createAppContext, type AppContext } from "./context.js";
import { loadServerConfig } from "./config.js";

const databaseUrl =
  process.env["YUVI_MULTI_CHARACTER_TEST_DATABASE_URL"] ??
  process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const prefix = "multi_character_" + randomBytes(6).toString("hex");
let root: string;
let admin: PostgresPool;
const contexts: AppContext[] = [];
const children: ChildProcess[] = [];
const schemas = [prefix + "_yuvi", prefix + "_alice"];
const person = Object.freeze({ id: "person:chen", displayName: "Chen" });
let people: ProductPersonSource;
const bindings = ["Yuvi", "Alice"].map((name) => ({
  instanceId: name.toLowerCase() + ".acceptance",
  definition: defineCharacter({
    id: name.toLowerCase(),
    revision: "1",
    name,
    persona:
      name === "Yuvi"
        ? "Careful and warm; your own experiences belong to Yuvi."
        : "Playful and curious; your own experiences belong to Alice."
  })
}));
function environment(index: number) {
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", "-c search_path=" + schemas[index] + ",public");
  return {
    NODE_ENV: "test",
    PROVIDER_ALLOW_MOCKS: "true",
    MEMORY_REPOSITORY: "postgres",
    MEMORY_BACKEND: "legacy",
    DATABASE_URL: url.toString(),
    MEMORY_EXTRACTOR: "rule-based",
    MEMORY_INGESTION_ENABLED: "false",
    MEMORY_MAINTENANCE_ENABLED: "false"
  };
}
function composition(index: number) {
  return characterComposition({
    binding: bindings[index]!,
    envDirectory: join(root, String(index)),
    env: environment(index),
    subjectUserId: person.id,
    people
  });
}
async function open(index: number) {
  const c = composition(index);
  const context = await createAppContext(
    Fastify({ logger: false }).log,
    loadServerConfig(c.env),
    undefined,
    c
  );
  contexts.push(context);
  return context;
}
async function close(context: AppContext) {
  context.runtime.stopProactiveScheduler();
  await context.runtime.sealAndDrainMemoryWrites();
  await context.memoryIngestionCoordinator.shutdown({ graceMs: 2_000 });
  await context.finalizedIngestionRepository.close?.();
  await context.conversationRepository.close?.();
  await context.memoryRepository.close?.();
  await context.closeDatabasePool();
  contexts.splice(contexts.indexOf(context), 1);
}

describe.skipIf(!databaseUrl)("Core multi-Character durable composition acceptance", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "yuvi-multi-character-"));
    const worldEnv = { YUVI_RUNTIME_ENV_DIR: join(root, "world") };
    writeProductSettings(
      {
        ...defaultProductSettings(),
        people: [{ ...person, personaId: "legacy-yuvi", notes: "PRIVATE_YUVI_NOTES" }],
        personRevisionById: { [person.id]: "person-revision:1" }
      },
      worldEnv
    );
    people = fileProductPersonSource(join(root, "world"));
    expect(people.readPerson(person.id)).toEqual({ person, revision: "person-revision:1" });
    expect(JSON.stringify(people.readPerson(person.id))).not.toContain("PRIVATE_YUVI_NOTES");
    admin = createPostgresPool(databaseUrl!);
    claimCharacterFiles(bindings[0]!, composition(0).env, false);
    await writeFile(
      join(root, "0", "proactive-policy.json"),
      JSON.stringify({
        version: 1,
        suppression: { kind: "UNTIL_EXPLICIT_RESUME" },
        eligibleAfterMs: 0
      })
    );
    const migrations = await readSqlMigrations();
    for (let index = 0; index < schemas.length; index++) {
      await admin.query('create schema "' + schemas[index] + '"');
      const pool = createPostgresPool(environment(index).DATABASE_URL);
      try {
        for (const migration of migrations) await pool.query(migration.sql);
      } finally {
        await pool.end();
      }
    }
  }, 60_000);
  afterAll(async () => {
    for (const child of [...children]) await stopChild(child);
    for (const context of [...contexts]) await close(context);
    if (admin) {
      for (const schema of schemas)
        await admin.query('drop schema if exists "' + schema + '" cascade');
      await admin.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("shares a Person but never Memory, context, relationship, corrections, Registry or durable identity", async () => {
    let yuvi = await open(0);
    let alice = await open(1);
    const initialGlobalPersona = process.env["MEMORY_PERSONA_ID"];
    const records = await Promise.all(
      [yuvi, alice].map(async (c, i) => {
        const content = "private relationship marker " + (i === 0 ? "YUVI_ONLY_A" : "ALICE_ONLY_B");
        const receipt = await c.conversationalReceiptAdmission.admit({
          surface: "HTTP_MESSAGE",
          sessionId: "same-session",
          runtimeEventId: "memory-source-" + i,
          content
        });
        const stored = await c.memory.processCandidateForStorage(
          {
            type: "relationship",
            subtype: "relationship",
            content,
            subjectUserId: person.id,
            personaId: characterPersonaId(bindings[i]!),
            importance: 0.9,
            confidence: 0.95,
            tags: ["private"],
            reason: "explicit-remember",
            originRole: "user",
            explicitRememberRequested: true
          },
          {},
          { sourceJournalRef: toConversationalJournalRef(receipt.envelope), sourceText: content }
        );
        expect(stored.decision).toBe("stored");
        expect(stored.memory!.lineage).toBeDefined();
        return stored.memory!;
      })
    );
    for (const [i, c] of [yuvi, alice].entries()) {
      expect(c.runtime.characterBinding).toEqual(bindings[i]);
      expect(c.providers.getCharacterOwner()).toBe(bindings[i]!.instanceId);
      await expect(
        c.memory.retrieveRelevantMemories({
          text: "private relationship marker",
          subjectUserId: person.id,
          personaId: characterPersonaId(bindings[1 - i]!)
        })
      ).rejects.toThrow(/another Character/);
      await c.runtime.handleUserMessage(
        {
          sessionId: "same-session",
          subjectUserId: person.id,
          content: i === 0 ? "YUVI_RECENT_ONLY" : "ALICE_RECENT_ONLY"
        },
        { readMemory: true, writeMemory: false }
      );
      const preview = JSON.stringify(c.runtime.getLatestPromptPreview());
      expect(preview).toContain(bindings[i]!.definition.name);
      expect(preview).not.toContain(i === 0 ? "ALICE_RECENT_ONLY" : "YUVI_RECENT_ONLY");
    }
    expect(composition(0).people!.readPerson(person.id)).toEqual(
      composition(1).people!.readPerson(person.id)
    );
    expect(yuvi.providers).not.toBe(alice.providers);
    expect(yuvi.runtime.getProactiveState().activityRevision).toBe(
      alice.runtime.getProactiveState().activityRevision
    );
    expect(yuvi.runtime.getProactiveState().suppression.kind).toBe("UNTIL_EXPLICIT_RESUME");
    expect(alice.runtime.getProactiveState().suppression.kind).toBe("NONE");
    const correction = {
      correctionReference: "yuvi-private-correction",
      address: {
        characterInstanceId: bindings[0]!.instanceId,
        personaProfileId: bindings[0]!.definition.id,
        subjectScopeId: person.id
      },
      scopeReference: { reference: buildMemoryScope(person.id, characterPersonaId(bindings[0]!)) },
      target: { kind: "INTERPRETATION" as const, interpretationReference: "relationship.current" },
      action: "REVISE" as const,
      replacementMeaning: "Chen and Yuvi have a private perspective.",
      provenance: { source: "EXPLICIT_USER_CORRECTION" as const, reference: "acceptance-explicit" },
      supersededEvidenceReferences: []
    };
    expect(await yuvi.runtime.preflightP8Correction(correction)).toBe("READY");
    expect(await alice.runtime.preflightP8Correction(correction)).toBe("INVALID");
    const applied = await yuvi.productPersonCommands.execute(
      {
        family: "P8_CORRECTION",
        commandHandle: correction.correctionReference,
        operation: correction.action,
        correctionReference: correction.correctionReference,
        expectedRevision: null,
        correction: structuredClone(correction)
      },
      () => true
    );
    expect(applied.status).toBe("APPLIED");
    const correctionRevision = await yuvi.runtime.getP8CorrectionOwnerRevision(correction);
    expect(correctionRevision).toMatchObject({ status: "AVAILABLE", revision: expect.any(String) });
    expect(() => claimCharacterFiles(bindings[1]!, composition(0).env, false)).toThrow(/another/);
    const collidingPool = createPostgresPool(environment(0).DATABASE_URL);
    await expect(claimCharacterDatabase(collidingPool, bindings[1]!, false)).rejects.toThrow(
      /active writer/
    );
    await collidingPool.end();
    await close(yuvi);
    const wrongOwnerPool = createPostgresPool(environment(0).DATABASE_URL);
    await expect(claimCharacterDatabase(wrongOwnerPool, bindings[1]!, false)).rejects.toThrow(
      /belongs to another Character/
    );
    await wrongOwnerPool.end();
    // One restart must leave the other live Character and its state unchanged.
    expect(alice.runtime.characterBinding.definition.name).toBe("Alice");
    await alice.runtime.handleUserMessage(
      { sessionId: "same-session", subjectUserId: person.id, content: "Alice stays alive" },
      { readMemory: false, writeMemory: false }
    );
    await close(alice);
    yuvi = await open(0);
    alice = await open(1);
    for (const [i, c] of [yuvi, alice].entries()) {
      const rows = await c.memoryRepository.listRecentMemories(20);
      expect(rows.map((row) => row.id)).toContain(records[i]!.id);
      expect(rows.map((row) => row.id)).not.toContain(records[1 - i]!.id);
      const retrieved = await c.memory.retrieveRelevantMemories({
        text: "private relationship marker",
        subjectUserId: person.id,
        limit: 10
      });
      expect(retrieved.map((row) => row.content)).toContain(records[i]!.content);
      expect(retrieved.map((row) => row.content)).not.toContain(records[1 - i]!.content);
      await c.runtime.handleUserMessage(
        { sessionId: "same-session", subjectUserId: person.id, content: "after restart" },
        { readMemory: false, writeMemory: false }
      );
      const preview = JSON.stringify(c.runtime.getLatestPromptPreview());
      expect(preview).toContain(i === 0 ? "YUVI_RECENT_ONLY" : "ALICE_RECENT_ONLY");
      expect(preview).not.toContain(i === 0 ? "ALICE_RECENT_ONLY" : "YUVI_RECENT_ONLY");
      expect(c.runtime.characterBinding.definition.name).toBe(i === 0 ? "Yuvi" : "Alice");
    }
    expect(yuvi.runtime.getProactiveState().suppression.kind).toBe("UNTIL_EXPLICIT_RESUME");
    expect(alice.runtime.getProactiveState().suppression.kind).toBe("NONE");
    expect(await yuvi.runtime.getP8CorrectionOwnerRevision(correction)).toEqual(correctionRevision);
    expect(await alice.runtime.getP8CorrectionOwnerRevision(correction)).toEqual({
      status: "UNAVAILABLE"
    });
    expect(process.env["MEMORY_PERSONA_ID"]).toBe(initialGlobalPersona);
  }, 60_000);
  it("boots two actual worker processes and restarts one without changing the other's durable perspective", async () => {
    for (const context of [...contexts]) await close(context);
    const ports: number[] = [];
    const configs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      ports.push((reservation.address() as { port: number }).port);
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      configs.push(join(root, "worker-" + i + ".json"));
      await writeFile(
        configs[i]!,
        JSON.stringify({
          version: 1,
          instanceId: bindings[i]!.instanceId,
          definition: {
            id: bindings[i]!.definition.id,
            revision: "1",
            name: bindings[i]!.definition.name,
            persona: bindings[i]!.definition.name + " owns only its own perspective."
          },
          envDirectory: join(root, String(i)),
          peopleDirectory: join(root, "world"),
          subjectUserId: person.id
        })
      );
    }
    const launch = async (i: number) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
        {
          env: {
            ...process.env,
            ...environment(i),
            SERVER_PORT: String(ports[i]),
            SERVER_HOST: "127.0.0.1",
            YUVI_CHARACTER_CONFIG_PATH: configs[i]
          },
          stdio: "ignore"
        }
      );
      children.push(child);
      await expect
        .poll(
          async () => {
            if (child.exitCode !== null)
              throw new Error("Character worker exited during bootstrap.");
            try {
              return (await fetch("http://127.0.0.1:" + ports[i] + "/health")).ok;
            } catch {
              return false;
            }
          },
          { timeout: 20_000, interval: 100 }
        )
        .toBe(true);
      return child;
    };
    let a = await launch(0);
    const b = await launch(1);
    const read = async (i: number, path: string) => {
      const response = await fetch("http://127.0.0.1:" + ports[i] + path);
      expect(response.ok).toBe(true);
      return JSON.stringify(await response.json());
    };
    for (let i = 0; i < 2; i++) {
      const health = JSON.parse(await read(i, "/health"));
      expect(health.character.instanceId).toBe(bindings[i]!.instanceId);
      const memories = await read(i, "/memory/recent");
      expect(memories).toContain(i === 0 ? "YUVI_ONLY_A" : "ALICE_ONLY_B");
      expect(memories).not.toContain(i === 0 ? "ALICE_ONLY_B" : "YUVI_ONLY_A");
    }
    await stopChild(a, "SIGKILL");
    expect(b.exitCode).toBeNull();
    const unchanged = await read(1, "/v1/conversations/history?sessionId=same-session");
    a = await launch(0);
    expect(await read(1, "/v1/conversations/history?sessionId=same-session")).toBe(unchanged);
    const reopened = await read(0, "/v1/conversations/history?sessionId=same-session");
    expect(reopened).toContain("YUVI_RECENT_ONLY");
    expect(reopened).not.toContain("ALICE_RECENT_ONLY");
    await stopChild(a);
    await stopChild(b);
  }, 60_000);
});

async function stopChild(child: ChildProcess, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  }
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
}
