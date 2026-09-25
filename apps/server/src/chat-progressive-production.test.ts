import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createProviderRegistryFromEnv } from "@companion/providers";
import { modelContextBudget } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import { createAppContext } from "./context.js";
import { createServerCharacterPort } from "./character-runtime.js";
import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";

const originalEnv = { ...process.env };
const databaseUrl = process.env["DATABASE_URL"];
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function chatEnv() {
  const dir = await mkdtemp(path.join(tmpdir(), "yuvi-chat-core-"));
  dirs.push(dir);
  return {
    NODE_ENV: "development",
    RUNTIME_MODE: "development",
    LOG_LEVEL: "silent",
    YUVI_RUNTIME_ENV_DIR: dir,
    PROVIDER_ALLOW_MOCKS: "false",
    MEMORY_REPOSITORY: "in-memory",
    EVENT_BUS: "in-memory",
    DEFAULT_CHAT_PROVIDER: "openai-compatible",
    CHAT_PROVIDER_CHAIN: "openai-compatible",
    OPENAI_COMPATIBLE_API_BASEURL: "https://chat.example/v1",
    OPENAI_COMPATIBLE_API_KEY: "test-key",
    OPENAI_COMPATIBLE_CHAT_MODEL: "chat-only",
    MEMORY_MAINTENANCE_ENABLED: "false",
    MEMORY_INGESTION_COORDINATOR_ENABLED: "false"
  };
}

function buildServerWithAdmission(env: NodeJS.ProcessEnv) {
  return buildServer(loadServerConfig(env), {
    conversationReceiptAdmission: {
      async admit() {
        return {
          status: "APPENDED" as const,
          envelope: { eventId: "jev1_chatproductionreceipt000001" } as never
        };
      }
    }
  });
}
function completion(content: string, init?: RequestInit) {
  const body = JSON.parse(String(init?.body ?? "{}"));
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    /* Non-Character provider. */
  }
  if (body.stream) {
    const text = parsed?.text ?? content;
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } }
    );
  }
  if (parsed?.disposition === "RESPOND") {
    const { text: _text, ...gate } = parsed;
    content = JSON.stringify(gate);
  }
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
async function contextFor(env: Record<string, string | undefined>) {
  process.env = { ...env };
  const app = Fastify({ logger: false });
  const context = await createAppContext(app.log, loadServerConfig(env));
  return {
    context,
    async close() {
      context.runtime.stopProactiveScheduler();
      await context.runtime.sealAndDrainMemoryWrites();
      context.embodiedPresentationBridge.close();
      await context.memoryIngestionCoordinator.shutdown({ graceMs: 2000 });
      await context.conversationRepository.close?.();
      await context.finalizedIngestionRepository.close?.();
      await context.memoryRepository.close?.();
      await app.close();
    }
  };
}
async function collect(stream: AsyncIterable<unknown>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Chat core production capability activation", () => {
  it("boots first-run configuration without Chat and reports NOT_CONFIGURED", async () => {
    const env = { ...(await chatEnv()), OPENAI_COMPATIBLE_CHAT_MODEL: "" };
    process.env = env;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const app = await buildServerWithAdmission(env);
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        server: { status: "healthy" },
        conversationalReadiness: "NOT_CONFIGURED"
      });
      expect((await app.inject({ method: "GET", url: "/settings/runtime" })).statusCode).toBe(200);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("activates each optional capability only when its own enabled route has a model", async () => {
    const base = await chatEnv();
    const cases = [
      [
        "reasoning",
        "OPENAI_COMPATIBLE_REASONING_MODEL",
        {
          DEFAULT_REASONING_PROVIDER: "openai-compatible",
          REASONING_PROVIDER_CHAIN: "openai-compatible"
        }
      ],
      [
        "embedding",
        "LOCAL_EMBEDDING_MODEL",
        {
          DEFAULT_EMBEDDING_PROVIDER: "local",
          EMBEDDING_PROVIDER_CHAIN: "local",
          LOCAL_MODEL_BASEURL: "http://localhost:9999/v1"
        }
      ],
      [
        "vision",
        "LOCAL_VISION_MODEL",
        {
          DEFAULT_VISION_PROVIDER: "local",
          VISION_PROVIDER_CHAIN: "local",
          LOCAL_MODEL_BASEURL: "http://localhost:9999/v1"
        }
      ],
      [
        "stt",
        "LOCAL_STT_MODEL",
        {
          DEFAULT_STT_PROVIDER: "local",
          STT_PROVIDER_CHAIN: "local",
          LOCAL_STT_BASE_URL: "http://localhost:9999"
        }
      ],
      [
        "tts",
        "LOCAL_TTS_MODEL",
        {
          DEFAULT_TTS_PROVIDER: "local",
          TTS_PROVIDER_CHAIN: "local",
          LOCAL_TTS_BASE_URL: "http://localhost:9999"
        }
      ]
    ] as const;
    const requestedModels: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        requestedModels.push(JSON.parse(String(init?.body)).model);
        return completion('{"disposition":"RESPOND","text":"Chat remains available."}', init);
      })
    );
    const handle = await contextFor(base);
    try {
      for (const [capability, key, connection] of cases) {
        for (const model of ["", "compatible-model", ""]) {
          const registry = createProviderRegistryFromEnv({ ...base, ...connection, [key]: model });
          expect(
            registry
              .getStatus()
              .routes?.[capability].some((route) => route.enabled && route.configured)
          ).toBe(Boolean(model));
          expect(registry.getStatus().providers.chat.readiness).toBe("ready");
          await handle.context.reloadRuntimeConfig({ ...base, ...connection, [key]: model });
          const reply = await handle.context.runtime.handleUserMessage(
            { sessionId: `route-${capability}`, content: "Hello" },
            { readMemory: false, writeMemory: false }
          );
          expect(reply?.payload.content).toBe("Chat remains available.");
          for (const other of ["reasoning", "embedding", "vision", "stt", "tts"] as const) {
            if (other !== capability)
              expect(registry.getStatus().routes?.[other].some((route) => route.configured)).toBe(
                false
              );
          }
        }
      }
      expect(requestedModels).toEqual(Array(30).fill("chat-only"));
    } finally {
      await handle.close();
    }
    expect(createProviderRegistryFromEnv(base).hasProactiveRoute()).toBe(false);
    expect(
      createProviderRegistryFromEnv({
        ...base,
        OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL: "chat-only"
      }).hasProactiveRoute()
    ).toBe(true);
    expect(
      createProviderRegistryFromEnv({
        ...base,
        OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL: ""
      }).hasProactiveRoute()
    ).toBe(false);
  });

  it("does not arm or evaluate Proactive without a route, and keeps extraction rule-based on Reasoning activation", async () => {
    const env = await chatEnv();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const handle = await contextFor(env);
    try {
      const timer = vi.spyOn(globalThis, "setTimeout");
      handle.context.runtime.startProactiveScheduler({ sessionId: "no-route", readMemory: false });
      expect(timer).not.toHaveBeenCalled();
      timer.mockRestore();
      await expect(
        collect(
          handle.context.runtime.streamAssistantInitiatedTurn({
            sessionId: "no-route",
            idempotencyKey: "never",
            readMemory: false
          })
        )
      ).rejects.toMatchObject({ name: "ProactiveAdmissionError" });
      expect(fetch).not.toHaveBeenCalled();
      expect(handle.context.memory.getExtractorStatus().active).toBe("rule-based");
      await handle.context.reloadRuntimeConfig({
        ...env,
        OPENAI_COMPATIBLE_REASONING_MODEL: "chat-only",
        DEFAULT_REASONING_PROVIDER: "openai-compatible",
        REASONING_PROVIDER_CHAIN: "openai-compatible"
      });
      expect(handle.context.memory.getExtractorStatus().active).toBe("rule-based");
    } finally {
      await handle.close();
    }
  });

  it("uses bounded scores, leaves quiet state unchanged on low scores, and writes prose through Chat at threshold", async () => {
    const env = {
      ...(await chatEnv()),
      OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL: "speak-score",
      PROACTIVE_SCORE_THRESHOLD: "0.65",
      PROACTIVE_EVALUATION_INTERVAL_MS: "90000"
    };
    let score = 0.64;
    const models: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        models.push(body.model);
        return completion(
          body.model === "speak-score"
            ? JSON.stringify({ score })
            : "One useful addition to our open thread."
        );
      })
    );
    const handle = await contextFor(env);
    handle.context.runtime.applyProactiveConsentProjection({
      state: "READY",
      revision: 0,
      enabled: true
    });
    const clock = vi.spyOn(Date, "now");
    let now = 1_000_000;
    clock.mockImplementation(() => now);
    try {
      const before = handle.context.runtime.getProactiveState();
      for (let index = 0; index < 3; index++) {
        const events = await collect(
          handle.context.runtime.streamAssistantInitiatedTurn({
            sessionId: "score",
            idempotencyKey: String(index),
            readMemory: false
          })
        );
        expect(events).toContainEqual(expect.objectContaining({ decision: "NO_OP" }));
        expect(handle.context.runtime.getProactiveState()).toEqual(before);
        now += 89_999;
        await expect(
          collect(
            handle.context.runtime.streamAssistantInitiatedTurn({
              sessionId: "score",
              idempotencyKey: `early-${index}`,
              readMemory: false
            })
          )
        ).rejects.toMatchObject({ name: "ProactiveAdmissionError" });
        now += 1;
      }
      score = 0.65;
      const events = await collect(
        handle.context.runtime.streamAssistantInitiatedTurn({
          sessionId: "score",
          idempotencyKey: "speak",
          readMemory: false
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "completed",
          content: "One useful addition to our open thread."
        })
      );
      expect(models).toEqual([
        "speak-score",
        "speak-score",
        "speak-score",
        "speak-score",
        "chat-only"
      ]);
    } finally {
      clock.mockRestore();
      await handle.close();
    }
  });

  it("fails closed when Cognition is absent and continues ordinary Chat afterwards", async () => {
    const env = await chatEnv();
    let calls = 0;
    const models: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        models.push(body.model);
        calls += 1;
        if (calls === 1) return completion('{"disposition":"NEED_COGNITION","focus":"verify"}');
        return completion('{"disposition":"RESPOND","text":"I cannot verify that yet."}', init);
      })
    );
    const handle = await contextFor(env);
    try {
      const reply = await handle.context.runtime.handleUserMessage(
        { sessionId: "no-cognition", content: "Please verify this." },
        { readMemory: false, writeMemory: false }
      );
      expect(reply?.payload.content).toBe("I cannot verify that yet.");
      const next = await handle.context.runtime.handleUserMessage(
        { sessionId: "no-cognition", content: "Hello" },
        { readMemory: false, writeMemory: false }
      );
      expect(next).not.toBeNull();
      expect(models.every((model) => model === "chat-only")).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("keeps Character/P8 and the complete current UserMessage while adapting compressed context to metadata", async () => {
    const base = await chatEnv();
    const registry = createProviderRegistryFromEnv({
      ...base,
      OPENAI_COMPATIBLE_CHAT_CONTEXT_WINDOW: "131072"
    });
    expect(registry.getChatContextWindow()).toBe(131072);
    expect(modelContextBudget(131072).workingTokens).toBe(24576);
    expect(modelContextBudget().maxInputCharacters).toBeLessThan(
      modelContextBudget(131072).maxInputCharacters
    );
    expect(modelContextBudget(NaN)).toEqual(modelContextBudget());
    const userMessage = "完整当前请求。".repeat(180);
    const stable = "stable persona invariant. ".repeat(65);
    const summaries: string[] = [];
    for (const contextWindow of [undefined, registry.getChatContextWindow()]) {
      await createServerCharacterPort().generate({
        contextWindow,
        userMessage,
        prompt: new PromptBuilder().buildPrompt({ systemIdentity: "YUVI", userMessage }),
        semanticSections: [
          { kind: "IDENTITY", state: "KNOWN", summary: "YUVI" },
          { kind: "PERSONA", state: "KNOWN", summary: stable },
          { kind: "RECENT_CONVERSATION", state: "KNOWN", summary: "recent context. ".repeat(250) },
          { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "older episode. ".repeat(250) }
        ],
        async generateChat(input) {
          expect(input.messages.at(-1)?.content).toBe(userMessage);
          expect(input.messages[0]?.content).toContain(stable);
          summaries.push(input.messages[0]!.content);
          return {
            finishReason: "stop",
            message: { role: "assistant", content: '{"disposition":"RESPOND"}' }
          };
        }
      });
    }
    expect(summaries[0]!.length).toBeLessThan(summaries[1]!.length);
  });

  it("rejects oversized protected context before provider I/O without truncating P8 or the current user", async () => {
    const generateChat = vi.fn();
    for (const userMessage of ["hello", "current user ".repeat(2000)]) {
      await expect(
        createServerCharacterPort().generate({
          userMessage,
          prompt: new PromptBuilder().buildPrompt({ systemIdentity: "YUVI", userMessage }),
          semanticSections: [
            { kind: "IDENTITY", state: "KNOWN", summary: "identity ".repeat(440) },
            { kind: "PERSONA", state: "KNOWN", summary: "persona ".repeat(495) },
            { kind: "RELATIONSHIP_CONTEXT", state: "KNOWN", summary: "relationship ".repeat(300) }
          ],
          generateChat
        })
      ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    }
    expect(generateChat).not.toHaveBeenCalled();
  });

  it("accepts Character quiet proposal and restores the existing Runtime suppression snapshot", async () => {
    const env = await chatEnv();
    process.env = env;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) =>
        completion(
          '{"disposition":"RESPOND","text":"好，你先忙。","proactive":{"action":"SUPPRESS","scope":{"kind":"UNTIL","duration":"PT30M"}}}',
          init
        )
      )
    );
    let app = await buildServerWithAdmission(env);
    try {
      const reply = await app.inject({
        method: "POST",
        url: "/message",
        payload: { text: "半小时内别主动说话", options: { readMemory: false, writeMemory: false } }
      });
      expect(reply.statusCode, reply.body).toBe(200);
      await app.close();
      app = await buildServerWithAdmission(env);
      const { readFile } = await import("node:fs/promises");
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(env.YUVI_RUNTIME_ENV_DIR);
      const policyFile = files.find((file) => file.includes("proactive"));
      expect(policyFile).toBeDefined();
      const snapshot = JSON.parse(
        await readFile(path.join(env.YUVI_RUNTIME_ENV_DIR, policyFile!), "utf8")
      );
      expect(JSON.stringify(snapshot)).toContain('"UNTIL"');
      const handle = await contextFor(env);
      try {
        const restored = handle.context.runtime.getProactiveState().suppression;
        expect(restored).toEqual(snapshot.suppression);
        expect(restored.kind).toBe("UNTIL");
        if (restored.kind === "UNTIL") {
          expect(restored.untilMs - Date.now()).toBeGreaterThan(29 * 60_000);
          expect(restored.untilMs - Date.now()).toBeLessThanOrEqual(30 * 60_000);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await app.close();
    }
  });

  it.skipIf(!databaseUrl)(
    "restores persistent Chat-only L0/L1 and lexical Memory after a real repository restart",
    async () => {
      const env = {
        ...(await chatEnv()),
        MEMORY_REPOSITORY: "postgres",
        DATABASE_URL: databaseUrl!,
        DIRECT_CONTEXT_MAX_TURNS: "2"
      };
      process.env = env;
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init?: RequestInit) => {
          requests.push(String(init?.body));
          return completion('{"disposition":"RESPOND","text":"I will keep that in mind."}', init);
        })
      );
      let app = await buildServerWithAdmission(env);
      const sessionId = `chat-only-${crypto.randomUUID()}`;
      async function message(text: string) {
        const reply = await app.inject({
          method: "POST",
          url: "/message",
          payload: { sessionId, text, options: { readMemory: true, writeMemory: true } }
        });
        expect(reply.statusCode, reply.body).toBe(200);
      }
      try {
        await message("Remember that my favorite drink is jasmine tea.");
        await message("The project codename is Orchid and the launch is on Friday.");
        await message("I am planning the invitation.");
        await app.close();
        app = await buildServerWithAdmission(env);
        await message("What drink and project were we discussing?");
        expect(requests.at(-1)).toContain("jasmine");
        expect(requests.at(-1)).toContain("Orchid");
        expect(requests.at(-1)).toContain("RECENT_CONVERSATION");
        expect(requests.at(-1)).toContain("MEMORY_EVIDENCE");
        const health = await app.inject({ method: "GET", url: "/health" });
        expect(health.json().conversationalReadiness).toBe("READY");
        const preview = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
        expect(preview.json()).toMatchObject({
          memoryExtractorMode: "rule-based",
          vectorUsed: false
        });
        expect(preview.json().directContextTurnCount).toBeGreaterThan(0);
        const lexical = await app.inject({
          method: "GET",
          url: "/memory/search?q=jasmine&limit=5"
        });
        expect(lexical.statusCode).toBe(200);
        expect(JSON.stringify(lexical.json().memories)).toContain("jasmine");
      } finally {
        await app.close();
      }
    }
  );
});
