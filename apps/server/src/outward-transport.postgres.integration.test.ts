import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
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
let admin: PostgresPool, pool: PostgresPool, adapter: Server, endpoint: string, scopedUrl: string;
const runs: Array<{ app: ReturnType<typeof Fastify>; context: AppContext; dir: string }> = [];
async function composition() {
  const dir = await mkdtemp(join(tmpdir(), "yuvi-a93-transport-"));
  process.env = {
    NODE_ENV: "development",
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
        const body = JSON.parse(raw);
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
