import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { defineCharacter } from "@companion/core";
import { readSqlMigrations } from "../../../../packages/memory/src/migrations.js";
import { createAppContext, type AppContext } from "../context.js";
import { characterComposition } from "../character-composition.js";
import { loadServerConfig } from "../config.js";
import { HostCharacterSurfaces, type SurfaceInput } from "../character-surface-host.js";
import { QQSocialAdapter } from "./qq-social.js";
import { decodeQQPacket } from "./qq-codec.js";
import { wire } from "./qq-fixture.js";
const databaseUrl =
  process.env["YUVI_PLUNGE_TEST_DATABASE_URL"] ?? process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const prefix = "plunge_contract_" + randomBytes(6).toString("hex");
let root: string,
  admin: PostgresPool,
  alice: AppContext,
  yuvi: AppContext,
  pool: PostgresPool,
  host: HostCharacterSurfaces;
let mode = "RESPOND";
const requests: unknown[] = [];
const contexts: AppContext[] = [];
function env(index: number) {
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", "-c search_path=" + prefix + "_" + index + ",public");
  return {
    NODE_ENV: "development",
    PROVIDER_ALLOW_MOCKS: "false",
    YUVI_RUNTIME_ENV_DIR: join(root, String(index)),
    DATABASE_URL: url.toString(),
    MEMORY_REPOSITORY: "postgres",
    CONVERSATION_REPOSITORY: "postgres",
    MEMORY_BACKEND: "legacy",
    MEMORY_EXTRACTOR: "rule-based",
    MEMORY_MAINTENANCE_ENABLED: "false",
    MEMORY_INGESTION_ENABLED: "false",
    MEMORY_INGESTION_COORDINATOR_ENABLED: "false",
    DEFAULT_CHAT_PROVIDER: "openai-compatible",
    CHAT_PROVIDER_CHAIN: "openai-compatible",
    DEFAULT_REASONING_PROVIDER: "openai-compatible",
    REASONING_PROVIDER_CHAIN: "openai-compatible",
    OPENAI_COMPATIBLE_API_BASEURL: "https://fixture.example/v1",
    OPENAI_COMPATIBLE_API_KEY: "fixture",
    OPENAI_COMPATIBLE_CHAT_MODEL: "fixture-model",
    OPENAI_COMPATIBLE_REASONING_MODEL: "fixture-model",
    XAI_API_BASEURL: "https://fixture.example/v1",
    XAI_API_KEY: "fixture",
    XAI_VISION_MODEL: "fixture-vision",
    EMBEDDING_PROVIDER: "mock",
    EMBEDDING_PROVIDER_CHAIN: "mock",
    DEFAULT_EMBEDDING_PROVIDER: "mock",
    DEFAULT_TTS_PROVIDER: "xai",
    DEFAULT_STT_PROVIDER: "dashscope",
    DEFAULT_VISION_PROVIDER: "xai"
  };
}
async function open(index: number) {
  const e = env(index);
  const composition = characterComposition({
    binding: {
      instanceId: index ? "alice.fixture" : "yuvi.fixture",
      definition: defineCharacter({
        id: index ? "alice" : "yuvi",
        revision: "1",
        name: index ? "Alice" : "Yuvi",
        persona: index ? "Alice is curious and concise." : "Yuvi is thoughtful and kind."
      })
    },
    envDirectory: e.YUVI_RUNTIME_ENV_DIR,
    env: e,
    people: {
      readPerson: (id) =>
        id === "person:7"
          ? { person: { id, displayName: "Shared Person" }, revision: "world:1" }
          : null
    }
  });
  const c = await createAppContext(
    Fastify({ logger: false }).log,
    loadServerConfig(composition.env),
    undefined,
    composition
  );
  contexts.push(c);
  return c;
}
async function close(c: AppContext) {
  c.runtime.stopProactiveScheduler();
  await c.runtime.sealAndDrainMemoryWrites();
  c.outwardEffects.seal();
  c.mediaEffects.seal();
  c.presentationEffects.seal();
  await c.readTextEffects.shutdown();
  await c.memoryIngestionCoordinator.shutdown({ graceMs: 2000 });
  await c.profileLifecycle.shutdown({ graceMs: 2000 });
  c.embodiedPresentationBridge.close();
  await c.finalizedIngestionRepository.close?.();
  await c.conversationRepository.close?.();
  await c.memoryRepository.close?.();
  await c.closeDatabasePool();
  contexts.splice(contexts.indexOf(c), 1);
}
function port() {
  return host.bind({
    surfaceId: "qq",
    principalNamespace: "fixture:42",
    resolvePerson: (actor) =>
      actor === "7"
        ? { personId: "person:7", displayName: "Shared Person", bindingVersion: "binding:1" }
        : null,
    acceptsChannel: () => true
  });
}
const base: SurfaceInput = {
  channelRef: "fixture:42:private:7",
  conversationKind: "PRIVATE",
  actorId: "7",
  content: "hello Alice",
  transportFacts: "{}",
  hasImage: false,
  admission: "PRIVATE",
  mentions: [],
  observations: []
};
const connection = (write: (text: string) => Promise<void>) => ({
  generation: "generation:" + randomBytes(6).toString("hex"),
  signal: new AbortController().signal,
  isCurrent: () => true,
  write
});
describe.skipIf(!databaseUrl)(
  "Plunge uses the actual Core, Character, Journal and canonical A9",
  () => {
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "plunge-core-"));
      admin = createPostgresPool(databaseUrl!);
      const migrations = await readSqlMigrations();
      for (let i = 0; i < 2; i++) {
        await admin.query('create schema "' + prefix + "_" + i + '"');
        const db = createPostgresPool(env(i).DATABASE_URL);
        try {
          for (const m of migrations) await db.query(m.sql);
        } finally {
          await db.end();
        }
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, options?: RequestInit) => {
          const b = JSON.parse(String(options?.body)) as {
            model: string;
            stream?: boolean;
            messages: unknown[];
          };
          requests.push(b);
          if (b.stream)
            return new Response(
              `data: ${JSON.stringify({ model: b.model, choices: [{ delta: { content: "Alice fixture reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } }
            );
          return new Response(
            JSON.stringify({
              model: b.model,
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content:
                      b.model === "fixture-vision"
                        ? "A red triangle marked VISUAL_FIXTURE_42."
                        : JSON.stringify({ disposition: mode })
                  }
                }
              ],
              usage: { prompt_tokens: 10, completion_tokens: 10 }
            }),
            { headers: { "content-type": "application/json" } }
          );
        })
      );
      yuvi = await open(0);
      alice = await open(1);
      pool = createPostgresPool(env(1).DATABASE_URL);
      host = new HostCharacterSurfaces(alice);
    }, 60_000);
    afterAll(async () => {
      await host?.close();
      for (const c of [...contexts]) await close(c);
      vi.unstubAllGlobals();
      await pool?.end();
      if (admin) {
        for (let i = 0; i < 2; i++)
          await admin.query('drop schema if exists "' + prefix + "_" + i + '" cascade');
        await admin.end();
      }
      if (root) await rm(root, { recursive: true, force: true });
    });
    it("ambient bypasses Character and @Alice SILENCE persists a receipt with zero outbound effect", async () => {
      const social = new QQSocialAdapter(port()),
        send = vi.fn(async () => {});
      mode = "SILENCE";
      const before = requests.length;
      const ambient = decodeQQPacket(wire(), "42", "fixture:42")!;
      expect((await social.receive(ambient, connection(send))).outcome).toBe("OBSERVED");
      expect(requests).toHaveLength(before);
      const mentioned = decodeQQPacket(
        wire({
          message_id: 4,
          message: [
            { type: "at", data: { qq: 42 } },
            { type: "text", data: { text: "Alice listen silently" } }
          ]
        }),
        "42",
        "fixture:42"
      )!;
      expect((await social.receive(mentioned, connection(send))).outcome).toBe("SILENCE");
      expect(send).not.toHaveBeenCalled();
      const effects = await pool.query(
        "select * from effect_intents where contract_ref='yuvi.publication.v1'"
      );
      expect(effects.rows).toHaveLength(0);
      const serialized = JSON.stringify(requests);
      expect(serialized).toContain("Surface observations");
      expect(serialized).toContain("Alice listen silently");
      expect(serialized).toContain("observed card");
      const messages = await alice.conversationRepository.listRecentMessages(mentioned.channel, {
        limit: 10
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe("user");
    });
    it("RESPOND sends through atomically admitted publication and records external ACK at its actual layer", async () => {
      mode = "RESPOND";
      const send = vi.fn(async () => {});
      expect((await port().receive(base, connection(send))).outcome).toBe("RESPOND");
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith("Alice fixture reply", expect.any(AbortSignal));
      const o = await pool.query(
        "select evidence from effect_observations where evidence->>'layer'='EXTERNAL_SERVICE_ACCEPTED'"
      );
      expect(o.rows).toHaveLength(1);
      expect(o.rows[0]?.["evidence"]).toMatchObject({
        certainty: "APPLIED",
        layer: "EXTERNAL_SERVICE_ACCEPTED"
      });
      const receipt = await pool.query(
        "select envelope from journal_events where envelope->'authority'->'binding'->>'personId'='person:7' and envelope->'command'->>'kind'='RECEIPT'"
      );
      expect(receipt.rows.length).toBeGreaterThan(0);
      const messages = await yuvi.conversationRepository.listRecentMessages(base.channelRef, {
        limit: 10
      });
      expect(messages).toHaveLength(0);
    });
    it("QQ image bytes pass through the existing Core Vision provider and enter Character evidence", async () => {
      mode = "RESPOND";
      const send = vi.fn(async () => {});
      const before = requests.length;
      const imageBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString("base64");
      expect(
        (
          await port().receive(
            {
              ...base,
              hasImage: true,
              content: "Describe this image",
              channelRef: base.channelRef + ":image"
            },
            {
              ...connection(send),
              readImage: async () => ({ imageBase64, mimeType: "image/png" as const })
            }
          )
        ).outcome
      ).toBe("RESPOND");
      const calls = requests.slice(before);
      expect(JSON.stringify(calls)).toContain("data:image/png;base64," + imageBase64);
      expect(JSON.stringify(calls)).toContain("VISUAL_FIXTURE_42");
      expect(send).toHaveBeenCalledOnce();
    });
    it("ambiguous send has a canonical UNKNOWN outcome, no blind retry and durable one-attempt state", async () => {
      const send = vi.fn(async () => {
        throw Error("lost native ACK");
      });
      expect(
        (await port().receive({ ...base, content: "another turn" }, connection(send))).outcome
      ).toBe("UNKNOWN");
      expect(send).toHaveBeenCalledOnce();
      const o = await pool.query(
        "select * from effect_observations where evidence->>'certainty'='UNKNOWN'"
      );
      expect(o.rows).toHaveLength(1);
      const a = await pool.query(
        "select intent_id,count(*) as n from effect_attempts group by intent_id"
      );
      expect(a.rows.every((r) => r["n"] === "1")).toBe(true);
    });
    it("Alice restart preserves its conversation, does not restore Yuvi state, and keeps independent Persona", async () => {
      await host.close();
      await close(alice);
      alice = await open(1);
      host = new HostCharacterSurfaces(alice);
      const a = await alice.conversationRepository.listRecentMessages(base.channelRef, {
        limit: 10
      });
      const y = await yuvi.conversationRepository.listRecentMessages(base.channelRef, {
        limit: 10
      });
      expect(a.length).toBeGreaterThan(0);
      expect(y).toHaveLength(0);
      expect(alice.runtime.characterBinding.definition.id).toBe("alice");
      expect(yuvi.runtime.characterBinding.definition.id).toBe("yuvi");
    });
  }
);
