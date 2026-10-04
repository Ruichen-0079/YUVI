import { SyntheticSurface, FaultPlan } from "../../../scripts/conformance/fault-surface.mjs";
import type { ControllerBindingCommand } from "@companion/memory";
import { createFileP8CorrectionStore } from "@companion/core";
import { createDefaultP8IdentityAddress } from "@companion/p8";
import {
  writeProductSettings,
  defaultProductSettings,
  readProductSettings,
  productEnvironment,
  importLegacyConfiguration
} from "./services/product-store.js";
import { PostgresContextUseRepository, contextUseDigest } from "@companion/memory";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { readSqlMigrations } from "@companion/memory";
import { createEvent } from "@companion/protocol";
import { createAppContext, type AppContext } from "./context.js";
import { loadServerConfig } from "./config.js";
import { registerMessageRoutes } from "./routes/message.js";
import { registerMessageStreamRoutes } from "./routes/message-stream.js";
import { registerWebSocketRoutes } from "./routes/websocket.js";
import { registerProactiveTurnStreamRoutes } from "./routes/proactive-turn-stream.js";
const databaseUrl = process.env["YUVI_EFFECT_TEST_DATABASE_URL"],
  originalEnv = { ...process.env };
const schema = `a93_transport_${randomBytes(6).toString("hex")}`;
let admin: PostgresPool,
  pool: PostgresPool,
  adapter: Server,
  endpoint: string,
  scopedUrl: string,
  calls = 0;
const runs: Array<{ app: ReturnType<typeof Fastify>; context: AppContext; dir: string }> = [];
async function composition(person = false, plain = false) {
  const dir = await mkdtemp(join(tmpdir(), "yuvi-a93-transport-"));
  process.env = {
    NODE_ENV: plain ? "test" : "development",
    RUNTIME_MODE: "development",
    LOG_LEVEL: "silent",
    YUVI_RUNTIME_ENV_DIR: dir,
    DATABASE_URL: scopedUrl,
    YUVI_JOURNAL_NAMESPACE: `transport:${randomBytes(5).toString("hex")}`,
    MEMORY_REPOSITORY: "postgres",
    EVENT_BUS: "in-memory",
    PROVIDER_ALLOW_MOCKS: "false",
    MEMORY_MAINTENANCE_ENABLED: "false",
    MEMORY_INGESTION_COORDINATOR_ENABLED: "false",
    DEFAULT_CHAT_PROVIDER: "openai-compatible",
    CHAT_PROVIDER_CHAIN: "openai-compatible",
    OPENAI_COMPATIBLE_API_BASEURL: endpoint,
    OPENAI_COMPATIBLE_API_KEY: "controlled-fixture",
    OPENAI_COMPATIBLE_CHAT_MODEL: "chat",
    OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL: "proactive",
    DASHBOARD_DEV_TOKEN: "fixture-token"
  };
  if (person)
    writeProductSettings({
      ...importLegacyConfiguration(process.env),
      people: [
        {
          id: "historical-person",
          displayName: "Fixture",
          notes: "private fixture notes",
          personaId: "historical-persona"
        }
      ],
      primaryPersonId: "historical-person",
      personRevisionById: { "historical-person": "person-revision-old" },
      primaryPersonRevision: "primary-old"
    });
  const app = Fastify({ logger: false }),
    config = loadServerConfig(process.env),
    context = await createAppContext(app.log, config);
  context.runtime.stopProactiveScheduler();
  await app.register(websocket);
  await registerMessageRoutes(app, context);
  await registerMessageStreamRoutes(app, context);
  await registerWebSocketRoutes(app, context);
  await registerProactiveTurnStreamRoutes(app, context, config);
  const observation = { started: false };
  app.addHook("onSend", async (req, _reply, payload) => {
    if (req.url === "/message") {
      expect((await latestPublication("HTTP"))?.dispatch_started_at).toBeTruthy();
      observation.started = true;
    }
    return payload;
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const run = { app, context, dir };
  runs.push(run);
  return {
    ...run,
    observation,
    origin: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  };
}
async function latestPublication(surface: string) {
  return (
    await pool.query(
      `select a.dispatch_started_at,o.evidence from effect_intents i join effect_attempts a using(intent_id)
 left join effect_observations o on o.attempt_id=a.attempt_id and o.category='TERMINAL'
 where i.contract_ref='yuvi.publication.v1' and i.intent->'request'->'payload'->'target'->>'surface'=$1 order by i.created_at desc,o.observation_id desc limit 1`,
      [surface]
    )
  ).rows[0];
}
describe.skipIf(!databaseUrl)(
  "A9.3 actual Runtime/Registry/transport composition on PostgreSQL",
  () => {
    beforeAll(async () => {
      admin = createPostgresPool(databaseUrl!);
      await admin.query(`create schema "${schema}"`);
      pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema},public` });
      for (const m of await readSqlMigrations()) await pool.query(m.sql);
      const u = new URL(databaseUrl!);
      u.searchParams.set("options", `-c search_path=${schema},public`);
      scopedUrl = u.toString();
      adapter = createServer(async (req, res) => {
        let raw = "";
        for await (const c of req) raw += c;
        calls++;
        const body = JSON.parse(raw);
        const historical = await pool.query(
          "select count(*) n from effect_intents i join context_use_exposures x on x.exposure_id=i.intent->'request'->'payload'->'inputSnapshot'->'manifest'->>'exposureId' join context_use_manifests m on m.manifest_id=x.manifest_id where i.contract_ref='yuvi.provider.v1'"
        );
        expect(Number(historical.rows[0]?.n)).toBeGreaterThan(0);
        const started = await pool.query(
          "select count(*) n from effect_attempts where contract_ref='yuvi.provider.v1' and dispatch_started_at is not null"
        );
        expect(Number(started.rows[0]?.n)).toBeGreaterThan(0);
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " }, finish_reason: null }] })}\n\n`
          );
          res.end(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "world." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
          );
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content:
                      body.model === "proactive" ? '{"score":0.95}' : '{"disposition":"RESPOND"}'
                  }
                }
              ]
            })
          );
        }
      });
      await new Promise<void>((r) => adapter.listen(0, "127.0.0.1", r));
      endpoint = `http://127.0.0.1:${(adapter.address() as { port: number }).port}/v1`;
    });
    afterEach(async () => {
      for (const { app, context, dir } of runs.splice(0)) {
        context.outwardEffects.seal();
        context.mediaEffects.seal();
        context.presentationEffects.seal();
        await context.readTextEffects.shutdown();
        await context.runtime.sealAndDrainMemoryWrites();
        await context.profileLifecycle.shutdown({ graceMs: 2000 });
        await context.memoryIngestionCoordinator.shutdown({ graceMs: 100 });
        context.embodiedPresentationBridge.close();
        await app.close();
        await context.closeDatabasePool();
        await rm(dir, { recursive: true, force: true });
      }
      process.env = { ...originalEnv };
    });
    afterAll(async () => {
      await new Promise<void>((r) => adapter?.close(() => r()));
      await pool?.end();
      await admin?.query(`drop schema "${schema}" cascade`);
      await admin?.end();
    });
    async function send(app: ReturnType<typeof Fastify>, sessionId: string) {
      return app.inject({
        method: "POST",
        url: "/message",
        payload: {
          text: "historical context request",
          sessionId,
          options: { readMemory: false, writeMemory: false }
        }
      });
    }
    async function latestHistory(sessionId: string) {
      const row = await pool.query(
        "select manifest_id from context_use_manifests where body->>'scope'=$1 and body->>'assemblyVersion' like 'canonical-context%' order by created_at desc limit 1",
        [`session:${sessionId}`]
      );
      return new PostgresContextUseRepository(pool).get(row.rows[0]?.manifest_id);
    }
    it.each(["PRIVATE", "GROUP"])("A11.1 %s hints never become authenticated disclosure or binding authority", async kind => {
      const { app } = await composition(true);
      const faults = new FaultPlan();
      const surface = new SyntheticSurface(async input => app.inject({
        method: "POST", url: "/message", payload: {
          sessionId: `synthetic-${kind}`, text: input.text,
          principal: input.principalHint, audience: input.audienceHint,
          members: input.members, options: { readMemory: false, writeMemory: false }
        }
      }), faults);
      const gate = faults.arm("receipt.before", "PAUSE");
      const response = surface.receive({ kind, upstreamId: "untrusted-id", principalHint: "person",
        audienceHint: "private", members: ["old-member"], text: "bounded surface request" });
      await gate.ready; gate.release();
      expect((await response).statusCode).toBe(200);
      const receipt = await pool.query("select envelope from journal_events order by recorded_at desc limit 1");
      expect(receipt.rows[0]?.envelope.authority).toMatchObject({
        principal: { state: "UNRESOLVED" }, binding: { state: "UNRESOLVED" },
        audience: { kind: "UNKNOWN" }, disclosurePolicy: { state: "UNRESOLVED" }
      });
      const history = await latestHistory(`synthetic-${kind}`);
      expect(JSON.stringify(history)).not.toContain("private fixture notes");
      expect(JSON.stringify(history)).not.toContain("old-member");
    });
    it("A10.3 persists historical Person scope revision and withholds stale boot composition", async () => {
      const { app, context } = await composition(true);
      expect((await send(app, "person-history")).statusCode).toBe(200);
      const historical = await latestHistory("person-history");
      expect(historical?.manifest.sources.find((s) => s.owner === "PERSON")).toMatchObject({
        revision: "person-revision-old",
        roots: ["primary-old"]
      });
      expect(JSON.stringify(historical)).not.toContain("private fixture notes");
      const old = readProductSettings()!;
      writeProductSettings({
        ...old,
        people: old.people.map((p) => ({ ...p, displayName: "Changed" })),
        personRevisionById: { "historical-person": "person-revision-new" }
      });
      const before = calls;
      expect((await send(app, "person-stale")).statusCode).toBeGreaterThanOrEqual(400);
      expect(calls).toBe(before);
      const replacement = readProductSettings()!;
      await context.reloadRuntimeConfig(
        productEnvironment(context.activeRuntimeEnv, replacement),
        replacement
      );
      context.runtime.stopProactiveScheduler();
      expect((await send(app, "person-regenerated")).statusCode).toBe(200);
      expect(
        (await latestHistory("person-regenerated"))?.manifest.sources.find(
          (s) => s.owner === "PERSON"
        )?.revision
      ).toBe("person-revision-new");
      expect(
        await new PostgresContextUseRepository(pool).get(historical!.exposures[0]!.manifestId)
      ).toEqual(historical);
    });
    it("A10.3 manifest insert failure prevents real transport invocation", async () => {
      const { app } = await composition();
      await pool.query(
        `create function fail_manifest_test() returns trigger language plpgsql as $$ begin raise exception 'required manifest fault'; end $$`
      );
      await pool.query(
        "create trigger fail_manifest_test before insert on context_use_manifests for each row execute function fail_manifest_test()"
      );
      const before = calls;
      try {
        expect((await send(app, "manifest-failure")).statusCode).toBeGreaterThanOrEqual(400);
        expect(calls).toBe(before);
      } finally {
        await pool.query("drop trigger fail_manifest_test on context_use_manifests");
      }
    });
    it("A10.3 conversation replacement invalidates current context and preserves old checkpoint", async () => {
      const { app } = await composition();
      expect((await send(app, "conversation-history")).statusCode).toBe(200);
      expect((await send(app, "conversation-history")).statusCode).toBe(200);
      const old = await latestHistory("conversation-history");
      const checkpoint = old?.manifest.sources.find((s) => s.reference === "direct-context");
      expect(checkpoint?.roots.length).toBeGreaterThan(0);
      const directSource = old!.manifest.sources.find((s) => s.reference === checkpoint!.roots[0])!;
      const sourceMessageId = JSON.parse(directSource.semanticReferences![0]!).messageId;
      await pool.query(
        "update conversation_messages set content='owner corrected previous user content' where id=$1",
        [sourceMessageId]
      );
      expect((await send(app, "conversation-history")).statusCode).toBe(200);
      const newer = await latestHistory("conversation-history");
      expect(
        newer?.manifest.sources.find((s) => s.reference === "direct-context")?.digest
      ).not.toBe(checkpoint?.digest);
      expect(
        (await new PostgresContextUseRepository(pool).get(old!.exposures[0]!.manifestId))?.manifest
      ).toEqual(old?.manifest);
    });
    it("A10.3 concurrent owner replacement retains distinct L0 and L1 observed revisions", async () => {
      const { app, context } = await composition();
      expect((await send(app, "conversation-read-slots")).statusCode).toBe(200);
      const repository = context.conversationRepository;
      const read = repository.listRecentMessages.bind(repository);
      let replacedId: string | undefined, priorDigest: string | undefined;
      const spy = vi
        .spyOn(repository, "listRecentMessages")
        .mockImplementation(async (session, options) => {
          const rows = await read(session, options);
          // L0 restore is a 36-message read; L1 uses its separate bounded window.
          if (session === "conversation-read-slots" && options?.limit === 36 && !replacedId) {
            const previous = rows.find((message) => message.role === "user")!;
            replacedId = previous.id;
            priorDigest = contextUseDigest(previous.content);
            await pool.query(
              "update conversation_messages set content='replacement between independent owner read slots' where id=$1",
              [previous.id]
            );
          }
          return rows;
        });
      try {
        expect((await send(app, "conversation-read-slots")).statusCode).toBe(200);
        expect(replacedId).toBeTruthy();
        const h = await latestHistory("conversation-read-slots");
        const direct = h!.manifest.sources.find((s) =>
          s.reference.startsWith(`direct:${replacedId}:`)
        )!;
        expect(JSON.parse(direct.semanticReferences![0]!).contentDigest).toBe(priorDigest);
        const later = h!.manifest.sources.find((s) => s.reference === replacedId)!;
        expect(later.revision).toContain(
          contextUseDigest("replacement between independent owner read slots")
        );
        expect(later.digest).not.toBe(direct.digest);
        expect(
          h!.manifest.blocks.find((b) => b.key === "DirectContext")!.sourceReferences
        ).toContain(direct.reference);
        expect(
          h!.manifest.blocks.find((b) => b.key === "DirectContext")!.sourceReferences
        ).not.toContain(later.reference);
      } finally {
        spy.mockRestore();
      }
    });
    it("A10.3 preserves an omitted backend candidate without fabricating selection or exposure", async () => {
      const { app, context } = await composition(false, true);
      const rejected = {
        id: "omitted-memory-candidate",
        kind: "fact" as const,
        content: " ",
        source: "controlled-memory-reader",
        sourceRecordId: "source-row",
        metadata: {}
      };
      const spy = vi.spyOn(context.memory, "getMemoryProvider").mockReturnValue({
        retrieveRelevant: async () => ({
          status: "ok",
          source: "controlled-memory-reader",
          limited: true,
          events: [rejected]
        }),
        getEvent: async () => rejected,
        writeEvent: async () => ({ status: "rejected", errorCode: "READ_ONLY_FIXTURE" })
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/message",
          payload: {
            text: "available candidate read",
            sessionId: "candidate-history",
            options: { readMemory: true, writeMemory: false }
          }
        });
        expect(response.statusCode, response.body).toBe(200);
        const h = await latestHistory("candidate-history");
        expect(h!.manifest.sources.find((s) => s.reference === rejected.id)).toMatchObject({
          selection: "OMITTED",
          reason: "empty-content"
        });
        expect(
          h!.exposures.flatMap((e) => e.blocks.flatMap((b) => b.sourceReferences))
        ).not.toContain(rejected.id);
      } finally {
        spy.mockRestore();
      }
    });
    it("A10.3 records the exact P8 native revision and correction order across replacement", async () => {
      const { app, dir, context } = await composition();
      const store = createFileP8CorrectionStore(join(dir, "p8-corrections.json"));
      expect((await send(app, "p8-initial")).statusCode).toBe(200);
      const initial = await latestHistory("p8-initial");
      const { address, scopeReference } = JSON.parse(
        initial!.manifest.sources.find((s) => s.owner === "P8")!.reference
      );
      const command = {
        commandHandle: "p8-historical-use",
        intentId: "fixture-intent",
        attemptId: "fixture-attempt",
        fence: "1",
        payloadDigest: contextUseDigest("private correction"),
        expectedRevision: null,
        causalRefs: [
          await context.outwardEffects.operationCause("p8-history-fixture", "p8-history")
        ]
      };
      expect(await store.fenceCorrectionCommand!(command)).toBe("READY");
      const applied = await store.appendCorrectionCommand!(
        {
          correctionReference: "historical-correction",
          address,
          scopeReference,
          target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
          action: "REVISE",
          replacementMeaning: "A private historical relationship correction.",
          provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "controller-fixture" },
          supersededEvidenceReferences: []
        },
        command
      );
      expect(applied.status).toBe("STORED");
      expect((await send(app, "p8-history")).statusCode).toBe(200);
      const old = await latestHistory("p8-history");
      const used = old?.manifest.sources.find((s) => s.owner === "P8");
      expect(await store.loadCorrections({ address, scopeReference })).toMatchObject({
        nativeRevision: "receipt" in applied ? applied.receipt.resultingRevision : null
      });
      expect(
        used,
        JSON.stringify({ used, dir, env: process.env["YUVI_RUNTIME_ENV_DIR"] })
      ).toMatchObject({
        revision: "receipt" in applied ? applied.receipt.resultingRevision : null
      });
      expect(used?.roots).toEqual(["historical-correction"]);
      const nextCommand = {
        ...command,
        commandHandle: "p8-history-retraction",
        intentId: "second-intent",
        attemptId: "second-attempt",
        expectedRevision: used!.revision,
        payloadDigest: contextUseDigest("retraction")
      };
      expect(await store.fenceCorrectionCommand!(nextCommand)).toBe("READY");
      expect(
        (
          await store.appendCorrectionCommand!(
            {
              correctionReference: "historical-retraction",
              address,
              scopeReference,
              target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
              action: "RETRACT",
              provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "controller-fixture" },
              supersedesCorrectionReference: "historical-correction",
              supersededEvidenceReferences: []
            },
            nextCommand
          )
        ).status
      ).toBe("STORED");
      expect((await send(app, "p8-history")).statusCode).toBe(200);
      const current = await latestHistory("p8-history");
      expect(current?.manifest.sources.find((s) => s.owner === "P8")?.revision).not.toBe(
        used?.revision
      );
      expect(
        (await new PostgresContextUseRepository(pool).get(old!.exposures[0]!.manifestId))?.manifest
      ).toEqual(old?.manifest);
    });
    it("A10.3 legacy Memory correction preserves captured content/lifecycle revision", async () => {
      const { app, context } = await composition(false, true);
      const row = await context.memory.createMemory({
        type: "episodic",
        content: "manifestfencememory workshop scheduled in November with notebooks and maps",
        source: "diagnostic-fixture",
        evidenceClassification: "NON_EVIDENCE",
        importance: 0.9
      });
      const request = () =>
        app.inject({
          method: "POST",
          url: "/message",
          payload: {
            text: "Tell me what manifestfencememory meant last month",
            sessionId: "memory-history",
            options: { readMemory: true, writeMemory: false }
          }
        });
      expect((await request()).statusCode).toBe(200);
      const old = await latestHistory("memory-history"),
        source = old?.manifest.sources.find((s) => s.owner === "MEMORY" && s.reference === row.id);
      expect(source?.revisionKind).toBe("OBSERVED_SNAPSHOT");
      expect(source?.availability).toBe("LEGACY_UNLINEAGED");
      expect(
        old?.manifest.sources.find((s) => s.reference === "retrieval-window")?.availability
      ).toBe("AVAILABLE");
      await context.memory.updateMemory(row.id, {
        content: "manifestfencememory workshop corrected to December with notebooks and maps"
      });
      expect((await request()).statusCode).toBe(200);
      const current = await latestHistory("memory-history");
      expect(current?.manifest.sources.find((s) => s.reference === row.id)?.revision).not.toBe(
        source?.revision
      );
      expect(
        (await new PostgresContextUseRepository(pool).get(old!.exposures[0]!.manifestId))?.manifest
      ).toEqual(old?.manifest);
    });
    it("A10.3 checks Memory again at dispatch despite a lost invalidation notification", async () => {
      const { app, context } = await composition(false, true);
      const row = await context.memory.createMemory({
        type: "episodic",
        content: "manifestfencememory workshop scheduled in November with notebooks and maps",
        source: "diagnostic-fixture",
        evidenceClassification: "NON_EVIDENCE",
        importance: 0.9
      });
      const repository = new PostgresContextUseRepository(pool);
      let changed = false;
      context.outwardEffects.setContextUseRepository(
        new Proxy(repository, {
          get(target, key) {
            if (key === "admit")
              return async (...args: Parameters<typeof repository.admit>) => {
                const admitted = await repository.admit(...args);
                if (!changed && args[0].sources.some((s) => s.reference === row.id)) {
                  changed = true;
                  await context.memory.updateMemory(row.id, {
                    content: "manifestfencememory workshop changed while admission committed"
                  });
                }
                return admitted;
              };
            const v = Reflect.get(target, key);
            return typeof v === "function" ? v.bind(target) : v;
          }
        })
      );
      const before = calls;
      const response = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          text: "Tell me what manifestfencememory meant last month",
          sessionId: "memory-dispatch-fence",
          options: { readMemory: true, writeMemory: false }
        }
      });
      expect(changed).toBe(true);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(calls).toBe(before);
      const history = await latestHistory("memory-dispatch-fence");
      expect(history?.exposures[0]?.boundary).toBe("PREPARED_FOR_USE");
      const reconstructed = await repository.reconstruct(
        history!.exposures[0]!.manifestId,
        async (s) => ({ availability: "UNAVAILABLE", revision: s.revision, digest: s.digest })
      );
      expect(
        reconstructed?.consumerUse.some((e) =>
          e.canonicalA9Evidence.some((a) => a.certainty === "PROVEN_NOT_APPLIED")
        )
      ).toBe(true);
    });
    it("A10.3 native voice rebind and binding-index rebuild preserve old use", async () => {
      const { context, dir } = await composition(true),
        owner = context.memory.getNativeVoiceBindingOwner()!;
      const cause = await context.outwardEffects.operationCause("binding-test", "voice-history");
      const command: ControllerBindingCommand = {
        commandHandle: "voice-history-assignment",
        intentId: "voice-history-intent",
        attemptId: "voice-history-attempt",
        fence: "1",
        payloadDigest: contextUseDigest("voice-assignment"),
        causalRefs: [cause],
        operation: "ASSIGN",
        voiceProfileId: "historical-voice",
        personaId: "historical-persona",
        personId: "historical-person",
        expectedBindingRevision: null
      };
      expect(await owner.fenceBindingCommand(command)).toBe("READY");
      const applied = await owner.applyBindingCommand(command);
      expect(applied.status).toBe("APPLIED");
      async function turn(suffix: string) {
        const observation = {
          provider: "offline-acoustic-fixture",
          model: "fixture",
          latencyMs: 0,
          text: "historical voice transcript",
          observationId: `voice-use-${suffix}`,
          captureEpoch: `voice-capture-${suffix}`,
          segments: [
            {
              segmentId: `voice-segment-${suffix}`,
              text: "historical voice transcript",
              speakerClusterId: "one",
              voiceProfileMatch: { status: "MATCHED" as const, voiceProfileId: "historical-voice" }
            }
          ]
        };
        const reservation = context.runtime.reserveFinalizedSpeechObservation(observation, {
          sessionId: "voice-history",
          captureEpoch: observation.captureEpoch
        });
        const receipt = await context.speechReceiptAdmission.admit({
          surface: "HTTP_VOICE_MESSAGE",
          sessionId: "voice-history",
          observation: reservation.observation,
          audioReceived: true
        });
        expect(context.runtime.finalizeSpeechReservation(reservation.token, receipt).status).toBe(
          "ready"
        );
        const event = context.runtime.commitSpeechTurn(
          observation.observationId,
          "voice-history",
          observation.text
        );
        await context.runtime.handleUserMessage(event, { readMemory: false, writeMemory: false });
        return latestHistory("voice-history");
      }
      const old = await turn("one"),
        used = old?.manifest.sources.find((s) => s.owner === "VOICE_BINDING");
      expect(used?.revision).toBe("state" in applied ? applied.state.revision : null);
      await rm(join(dir, "voice-binding-references.json"), { force: true });
      const rebuilt = await turn("index-rebuilt");
      expect(rebuilt?.manifest.sources.find((s) => s.owner === "VOICE_BINDING")?.revision).toBe(
        used?.revision
      );
      const next = {
        ...command,
        operation: "REPLACE" as const,
        commandHandle: "voice-history-rebind",
        intentId: "voice-history-new-intent",
        attemptId: "voice-history-new-attempt",
        personId: "another-authored-person",
        payloadDigest: contextUseDigest("voice-rebind"),
        expectedBindingRevision: used!.revision
      };
      expect(await owner.fenceBindingCommand(next)).toBe("READY");
      expect((await owner.applyBindingCommand(next)).status).toBe("APPLIED");
      const newer = await turn("rebound");
      expect(newer?.manifest.sources.find((s) => s.owner === "VOICE_BINDING")?.revision).not.toBe(
        used?.revision
      );
      expect(
        (await new PostgresContextUseRepository(pool).get(old!.exposures[0]!.manifestId))?.manifest
      ).toEqual(old?.manifest);
    });
    it("A10.3 disabled retrieval and unused Profile remain explicit, with actual consumer exposure", async () => {
      const { app } = await composition();
      expect((await send(app, "unused-profile")).statusCode).toBe(200);
      const h = await latestHistory("unused-profile");
      expect(h?.manifest.sources.find((s) => s.owner === "PROFILE")).toMatchObject({
        availability: "NOT_USED",
        selection: "OMITTED"
      });
      expect(h?.exposures.length).toBeGreaterThanOrEqual(2);
      expect(h?.exposures.some((e) => e.blocks.some((b) => b.state === "EXPOSED"))).toBe(true);
      expect(h?.manifest.stable.version).toBe("canonical-context-stability.v1");
      expect(
        h?.exposures.some((e) => e.declaredVersions?.includes("character-transport-context.v1"))
      ).toBe(true);
      expect(h?.manifest.sources.find((s) => s.owner === "JOURNAL")?.revision).toBeTruthy();
    });
    it("A10.3 failed conversation reads cannot manufacture EMPTY checkpoints", async () => {
      const { app, context } = await composition();
      const spy = vi
        .spyOn(context.conversationRepository, "listRecentMessages")
        .mockRejectedValue(Error("controlled conversation read outage"));
      try {
        expect((await send(app, "unavailable-window")).statusCode).toBe(200);
        const h = await latestHistory("unavailable-window");
        expect(
          h?.manifest.sources.find((s) => s.reference === "direct-context")?.availability
        ).toBe("UNAVAILABLE");
        expect(
          h?.manifest.sources.find((s) => s.reference === "conversation-window:L1")?.availability
        ).toBe("UNAVAILABLE");
        expect(
          h?.manifest.sources.find((s) => s.reference === "retrieval-window")?.availability
        ).toBe("NOT_USED");
      } finally {
        spy.mockRestore();
      }
    });
    it("ordinary HTTP publishes only after component projection and canonical start", async () => {
      const { app, observation } = await composition();
      const r = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          text: "hello",
          sessionId: "http",
          options: { readMemory: false, writeMemory: false }
        }
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().reply).toBe("Hello world.");
      expect(observation.started).toBe(true);
      expect(
        (await pool.query("select * from conversation_reply_seals")).rows.length
      ).toBeGreaterThan(0);
    });
    it("real SSE socket preserves projected deltas and records target acceptance", async () => {
      const { origin } = await composition();
      const response = await fetch(`${origin}/v1/messages/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "sse",
          text: "hello",
          options: { readMemory: false, writeMemory: false }
        })
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("event: text-delta");
      expect(body).toContain("rc1_");
      expect(body).toContain("event: completed");
      expect((await latestPublication("HTTP_SSE"))?.evidence?.layer).toBe(
        "LOCAL_GATEWAY_WRITE_ACCEPTED"
      );
    });
    it("WebSocket/EventBus fanout has one assistant reply and canonical gateway acceptance", async () => {
      const { origin } = await composition();
      const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws");
      await new Promise<void>((r, j) => {
        socket.onopen = () => r();
        socket.onerror = () => j(Error("socket failed"));
      });
      const received: unknown[] = [];
      const result = new Promise<Record<string, any>>((r, j) => {
        const timer = setTimeout(() => j(Error("reply missing")), 4000);
        socket.onmessage = (e) => {
          const event = JSON.parse(String(e.data));
          received.push(event);
          if (event.type === "agent.reply") {
            clearTimeout(timer);
            r(event);
          }
        };
      });
      socket.send(
        JSON.stringify(createEvent("user.message", { sessionId: "ws", content: "hello" }))
      );
      const reply = await result;
      expect(reply["payload"].content).toBe("Hello world.");
      await new Promise((r) => setTimeout(r, 20));
      expect(received.filter((e: any) => e.type === "agent.reply")).toHaveLength(1);
      expect((await latestPublication("WEBSOCKET"))?.evidence?.layer).toBe(
        "LOCAL_GATEWAY_WRITE_ACCEPTED"
      );
      socket.close();
    });
    it("proactive POST and internal live subscriber use the same committed component fanout", async () => {
      const { app, origin, context } = await composition();
      context.runtime.applyProactiveConsentProjection({
        state: "READY",
        revision: 1,
        enabled: true
      });
      const controller = new AbortController();
      const live = await fetch(`${origin}/v1/proactive-turns/live?sessionId=proactive`, {
        signal: controller.signal
      });
      const reader = live.body!.getReader();
      const pending = reader.read();
      const response = await app.inject({
        method: "POST",
        url: "/v1/proactive-turns/stream",
        headers: { authorization: "Bearer fixture-token" },
        payload: {
          sessionId: "proactive",
          idempotencyKey: "proactive-one",
          modality: "text",
          options: { readMemory: false }
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("event: completed");
      expect((await pending).done).toBe(false);
      controller.abort();
      await reader.cancel().catch(() => {});
      const rows = await pool.query(
        "select count(*) n from effect_intents where contract_ref='yuvi.publication.v1' and intent->'request'->'payload'->>'operation'='reply-component'"
      );
      expect(Number(rows.rows[0]?.n)).toBeGreaterThanOrEqual(4);
    });
  }
);
