import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import {
  JOURNAL_COMMAND_VERSION,
  type JournalEventRef,
  type JournalPayloadDescriptor
} from "@companion/protocol";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  FinalizedIngestionService,
  PostgresFinalizedIngestionRepository,
  PostgresConversationRepository,
  JournalMemoryGroundingResolver,
  MemoryIngestionCoordinator,
  Mem0MemoryProvider,
  Mem0MemoryBackend,
  MemoryLineageV1Schema
} from "@companion/memory";
import { readSqlMigrations } from "../../../packages/memory/src/migrations.js";
import { decodeMemoryLineage } from "../../../packages/memory/src/lineage-encoding.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const python = process.env["YUVI_MEM0_INTEGRATION_PYTHON"];
const executable = process.env["YUVI_MEM0_INTEGRATION_EXECUTABLE"];
const schema = "a10_1d_" + randomBytes(6).toString("hex");
const collection = "yuvi_mem0_qwen3_1024_v1";
let admin: PostgresPool, pool: PostgresPool, journal: PostgresJournalRepository;
let backend: Mem0MemoryBackend, provider: Mem0MemoryProvider;
let processChild: ChildProcess | undefined, runtimeDir: string, url: string;
let legacyId: string;
let logs = "";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startSidecar() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const source = path.resolve("services/memory-mem0/src");
  const env = {
    ...process.env,
    PYTHONPATH: source,
    YUVI_MEM0_PACKAGED: "1",
    YUVI_MEM0_RESOURCE_DIR: source,
    YUVI_MEM0_DATA_DIR: path.join(runtimeDir, "data"),
    YUVI_MEM0_LOG_DIR: path.join(runtimeDir, "logs"),
    MEM0_DIR: path.join(runtimeDir, "data"),
    MEM0_TELEMETRY: "false",
    MEM0_SIDECAR_PORT: String(port),
    MEM0_PG_CONNECTION_STRING: url,
    MEM0_PG_COLLECTION: collection,
    MEM0_LLM_MODEL: "",
    MEM0_LLM_API_KEY: "",
    MEM0_OLLAMA_BASE_URL: "http://127.0.0.1:11434"
  };
  processChild = executable
    ? spawn(executable, [], { cwd: runtimeDir, env })
    : spawn(python!, ["-m", "yuvi_mem0"], { cwd: runtimeDir, env });
  processChild.stdout?.on("data", (data) => {
    logs += String(data);
  });
  processChild.stderr?.on("data", (data) => {
    logs += String(data);
  });
  backend = new Mem0MemoryBackend({
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 30_000,
    writeTimeoutMs: 30_000,
    healthTimeoutMs: 10_000
  });
  for (let i = 0; i < 100; i++) {
    if (processChild.exitCode !== null)
      throw new Error(`Sidecar exited (${processChild.exitCode}): ${logs.slice(-1500)}`);
    try {
      if ((await backend.health()).components?.["mem0"] === "healthy") {
        provider = new Mem0MemoryProvider(backend);
        return;
      }
    } catch {}
    await delay(100);
  }
  throw new Error("Sidecar readiness failed: " + logs.slice(-1500));
}
async function stopSidecar() {
  if (!processChild || processChild.exitCode !== null) return;
  const exited = once(processChild, "exit");
  processChild.kill("SIGTERM");
  const timer = setTimeout(() => processChild?.kill("SIGKILL"), 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
  expect(
    processChild.exitCode === 0 ||
      (processChild.signalCode === "SIGTERM" && logs.includes("Application shutdown complete"))
  ).toBe(true);
  processChild = undefined;
}
function service(repository = new PostgresFinalizedIngestionRepository(pool)) {
  return new FinalizedIngestionService(
    repository,
    undefined,
    new JournalMemoryGroundingResolver(journal)
  );
}
async function appendReceipt(text: string, speech = false): Promise<JournalEventRef> {
  const ref = {
    namespace: "input:opaque:" + "n".repeat(400),
    payloadId: randomUUID(),
    version: "v1"
  };
  const descriptor: JournalPayloadDescriptor = {
    ref,
    modality: "TEXT",
    retention: "RETAINED",
    origin: speech ? "EXTERNAL_RESULT" : "USER_INPUT",
    selectable: true,
    characterCount: Array.from(text).length
  };
  const result = await journal.appendWithHostAuthority(
    {
      command: {
        version: JOURNAL_COMMAND_VERSION,
        kind: "RECEIPT",
        causalParents: [],
        occurrenceTime: { state: "UNKNOWN" },
        data: {
          receiptClass: speech ? "DIRECT_OBSERVATION" : "ATTRIBUTED_ASSERTION",
          evidenceSelectors: [
            {
              version: "source-selector.v1",
              modality: "TEXT",
              payload: ref,
              range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(text).length }
            }
          ]
        }
      },
      retainedText: [{ ref, text }]
    },
    {
      principal: { state: "UNRESOLVED", reason: "no authenticated principal 🍵" },
      subjects: [],
      binding: { state: "UNRESOLVED", reason: "no governed binding" },
      audience: { kind: "UNKNOWN", reason: "no audience snapshot" },
      surface: { kind: "LOCAL", reference: "test-http" },
      correlations: [],
      disclosurePolicy: { state: "UNRESOLVED", reason: "test" },
      policyVersion: "a10.1d-test",
      producer: { name: "host-test", version: "1" },
      sourceReferences: [{ kind: "UNRESOLVED_SOURCE", reason: "no upstream identity" }],
      payloads: [descriptor]
    }
  );
  return {
    kind: "JOURNAL_EVENT",
    namespace: result.envelope.journalNamespace,
    eventId: result.envelope.eventId
  };
}
function input(id: string, text: string, ref?: JournalEventRef | null) {
  return {
    finalizedTurnId: id,
    assistantMessageId: `assistant:${id}`,
    sourceUserEventId: `user:${id}`,
    conversationId: `conversation:${id}`,
    traceId: `trace:${id}`,
    personaId: "persona",
    subjectUserId: "compat-only",
    finalizedAt: "2026-09-30T09:00:00.000Z",
    ingestionRequested: true,
    userMessage: text,
    sourceText: text,
    sourceJournalRef: ref,
    assistantMessage: "Understood."
  };
}

describe.skipIf(!databaseUrl || (!python && !executable))(
  "A10.1d real Journal / ledger / Mem0 / pgvector",
  () => {
    beforeAll(async () => {
      runtimeDir = await mkdtemp(path.join(tmpdir(), "yuvi-a10-1d-live-"));
      await writeFile(
        path.join(runtimeDir, ".env"),
        "MEM0_PG_CONNECTION_STRING=postgresql://poison@127.0.0.1:1/poison\nMEM0_LLM_MODEL=poison\n"
      );
      admin = createPostgresPool(databaseUrl!);
      await admin.query(`create schema ${schema}`);
      pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema},public` });
      for (const migration of await readSqlMigrations()) await pool.query(migration.sql);
      journal = new PostgresJournalRepository(pool, {
        namespace: `journal:${schema}`,
        now: () => new Date("2026-09-30T08:00:00.000Z"),
        authorityBuilder() {
          throw new Error("host required");
        }
      });
      // Pre-upgrade table layout and old row; no user data is modified or re-embedded.
      await pool.query(
        `create table ${collection} (id uuid primary key, vector vector(1024), payload jsonb)`
      );
      const embedding = (await (
        await fetch("http://127.0.0.1:11434/api/embed", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "yuvi-embedding:0.6b",
            input: "Legacy compatibility probe"
          })
        })
      ).json()) as { embeddings: number[][] };
      expect(embedding.embeddings[0]).toHaveLength(1024);
      legacyId = randomUUID();
      await pool.query(`insert into ${collection} (id, vector, payload) values ($1, $2, $3)`, [
        legacyId,
        JSON.stringify(embedding.embeddings[0]),
        {
          user_id: "legacy-test",
          data: "Legacy compatibility probe",
          created_at: "2025-01-01T00:00:00Z"
        }
      ]);
      const uri = new URL(databaseUrl!);
      uri.searchParams.set("options", `-csearch_path=${schema},public`);
      url = uri.toString();
      await startSidecar();
    }, 30_000);
    afterAll(async () => {
      await stopSidecar();
      await pool?.end();
      if (admin) {
        await admin.query(`drop schema if exists ${schema} cascade`);
        await admin.end();
      }
      if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true });
    }, 30_000);

    it("preserves existing pgvector layout, embedding, collection and historical row", async () => {
      expect(await backend.health()).toMatchObject({
        components: {
          mem0: "healthy",
          vectorStore: "healthy",
          embedder: "healthy",
          memoryLlm: "not_configured"
        },
        embedding: { model: "yuvi-embedding:0.6b", dimensions: 1024 },
        collection
      });
      const old = await provider.getEvent({ id: `mem0:${legacyId}`, scope: "legacy-test" });
      expect(old?.content).toBe("Legacy compatibility probe");
      expect(old?.lineage).toBeUndefined();
    });
    it("freezes real committed lineage through DB reopen, outbound submit, backend metadata, get/search, replay/conflict and process restart", async () => {
      const text = "Remember that I prefer tea 🍵.";
      const ref = await appendReceipt(text);
      const repository = new PostgresFinalizedIngestionRepository(pool);
      const admission = await service(repository).admit(input("real-typed", text, ref));
      const child = admission.events[0]!;
      expect(child).toBeDefined();
      const reopenedPool = createPostgresPool(databaseUrl!, {
        options: `-c search_path=${schema},public`
      });
      try {
        const reloaded = (
          await new PostgresFinalizedIngestionRepository(reopenedPool).listEvents(
            child.finalizedTurnId
          )
        )[0]!;
        expect(reloaded.eventPayload).toEqual(child.eventPayload);
        const write = vi.spyOn(provider, "writeEventIdempotent");
        const coordinator = new MemoryIngestionCoordinator({ repository, provider });
        await coordinator.drain();
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0]![0].lineage).toEqual(child.eventPayload.lineage);
        const completed = (await repository.listEvents(child.finalizedTurnId))[0]!;
        const backendId = completed.backendMemoryId!.replace(/^mem0:/, "");
        const row = await pool.query(`select payload from ${collection} where id = $1`, [
          backendId
        ]);
        expect(decodeMemoryLineage(row.rows[0]!["payload"])).toEqual(child.eventPayload.lineage);
        expect(
          (await provider.getEvent({ id: `mem0:${backendId}`, scope: child.eventPayload.scope }))
            ?.lineage
        ).toEqual(child.eventPayload.lineage);
        const search = await provider.retrieveRelevant({
          text: "tea preference",
          scope: child.eventPayload.scope
        });
        expect(search.status, JSON.stringify(search) + logs.slice(-2500)).toBe("ok");
        expect(search.events[0]?.lineage).toEqual(
          MemoryLineageV1Schema.parse(child.eventPayload.lineage)
        );
        expect((await provider.writeEventIdempotent(child.eventPayload)).status).toBe("unchanged");
        expect(
          await provider.writeEventIdempotent({
            ...child.eventPayload,
            payloadDigest: "conflicting-digest"
          })
        ).toMatchObject({ status: "rejected", failureClass: "definitive_rejection" });
        expect(await provider.reconcileEvent(child.eventPayload)).toMatchObject({
          status: "applied"
        });
        expect(
          await provider.reconcileEvent({ idempotencyKey: "never-admitted", payloadDigest: "none" })
        ).toMatchObject({ status: "not_applied" });
        const mutation = await backend
          .update({
            memoryId: backendId,
            scope: child.eventPayload.scope,
            content: "forged replacement",
            metadata: { yuviLineageJson: "{}" }
          })
          .catch((error) => error);
        expect(mutation.code).toBe("VALIDATION_ERROR");
        await stopSidecar();
        await startSidecar();
        expect((await provider.writeEventIdempotent(child.eventPayload)).status).toBe("unchanged");
        expect(
          (await provider.getEvent({ id: `mem0:${backendId}`, scope: child.eventPayload.scope }))
            ?.lineage
        ).toEqual(child.eventPayload.lineage);
        expect(
          (
            await pool.query(`select count(*)::int as count from ${collection} where id=$1`, [
              backendId
            ])
          ).rows[0]!["count"]
        ).toBe(1);
      } finally {
        await reopenedPool.end();
      }
    }, 30_000);
    it("runs current OSS infer=false add/list/update/history/delete without an evidence LLM", async () => {
      const added = await backend.add({
        scope: "crud-test",
        content: "A private CRUD probe.",
        infer: false,
        metadata: { source: "test" }
      });
      expect(added.operation).toBe("created");
      expect((await backend.list({ scope: "crud-test" })).items.map((item) => item.id)).toContain(
        added.memoryId
      );
      expect((await backend.get({ memoryId: added.memoryId, scope: "crud-test" }))?.content).toBe(
        "A private CRUD probe."
      );
      expect(
        (
          await backend.update({
            memoryId: added.memoryId,
            scope: "crud-test",
            content: "Updated private CRUD probe."
          })
        ).content
      ).toBe("Updated private CRUD probe.");
      expect(
        (await backend.history({ memoryId: added.memoryId, scope: "crud-test" })).length
      ).toBeGreaterThanOrEqual(2);
      await backend.delete({ memoryId: added.memoryId, scope: "crud-test" });
      expect((await backend.list({ scope: "crud-test" })).items).toEqual([]);
    });
    it("reconciles backend effect applied before outcome without blind replay after coordinator restart", async () => {
      const text = "Remember that I prefer quiet rooms.";
      const ref = await appendReceipt(text, true);
      const repository = new PostgresFinalizedIngestionRepository(pool);
      const admission = await service(repository).admit(input("response-lost", text, ref));
      const child = admission.events[0]!;
      const write = vi.spyOn(provider, "writeEventIdempotent");
      const crashed = new MemoryIngestionCoordinator({
        repository,
        provider,
        leaseSeconds: 1,
        hooks: {
          afterBackendApplied() {
            throw new Error("simulated process loss before ledger outcome");
          }
        }
      });
      await crashed.drain(50);
      expect((await repository.listEvents(child.finalizedTurnId))[0]?.status).toBe("processing");
      const recovered = new MemoryIngestionCoordinator({
        repository: new PostgresFinalizedIngestionRepository(pool),
        provider,
        clock: () => new Date(Date.now() + 300_000)
      });
      await recovered.drain();
      expect(write).toHaveBeenCalledTimes(1);
      expect((await repository.listEvents(child.finalizedTurnId))[0]?.status).toBe("complete");
      expect(child.eventPayload.lineage).toMatchObject({
        origin: "EXTERNAL_OBSERVATION",
        authority: { binding: { state: "UNRESOLVED" } }
      });
    });
    it.each(["grounded", "legacy"])(
      "discovers missing admission with %s persisted conversation ancestry",
      async (mode) => {
        const text = "Remember that I prefer paper notebooks.";
        const ref = mode === "grounded" ? await appendReceipt(text) : null;
        const source = input(`recovery-${mode}`, text, ref);
        const conversation = new PostgresConversationRepository(pool);
        await conversation.appendMessage({
          id: source.sourceUserEventId,
          sessionId: source.conversationId,
          traceId: source.traceId,
          parentMessageId: null,
          role: "user",
          content: text,
          status: "completed",
          createdAt: source.finalizedAt,
          completedAt: source.finalizedAt,
          metadata: {},
          sourceJournalRef: ref
        });
        await conversation.appendMessage({
          id: source.assistantMessageId,
          sessionId: source.conversationId,
          traceId: source.traceId,
          parentMessageId: source.sourceUserEventId,
          role: "assistant",
          content: source.assistantMessage,
          status: "completed",
          createdAt: source.finalizedAt,
          completedAt: source.finalizedAt,
          metadata: {},
          finalizedTurnId: source.finalizedTurnId,
          sourceUserEventId: source.sourceUserEventId,
          personaId: source.personaId,
          subjectUserId: source.subjectUserId,
          ingestionRequested: true
        });
        const repository = new PostgresFinalizedIngestionRepository(pool);
        const write = vi.spyOn(provider, "writeEventIdempotent");
        const coordinator = new MemoryIngestionCoordinator({
          repository,
          provider,
          conversation,
          admit: (value) => service(repository).admit(value)
        });
        await coordinator.drain();
        expect(write).toHaveBeenCalledTimes(mode === "grounded" ? 1 : 0);
        expect((await repository.getTurn(source.finalizedTurnId))?.status).toBe(
          mode === "grounded" ? "complete" : "terminal_failed"
        );
        if (mode === "grounded")
          expect(
            (await repository.listEvents(source.finalizedTurnId))[0]?.eventPayload.lineage
          ).toMatchObject({ parents: [{ ref }] });
      }
    );
  }
);
