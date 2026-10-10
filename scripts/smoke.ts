import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 3137;
const memoryRepository = process.env["MEMORY_REPOSITORY"] ?? "in-memory";
if (!process.env["DATABASE_URL"]?.trim()) {
  throw new Error(
    "Smoke requires an isolated, migrated PostgreSQL DATABASE_URL for durable Journal admission. Run pnpm db:migrate before pnpm smoke."
  );
}
const runtimeEnvDir = mkdtempSync(join(tmpdir(), "yuvi-smoke-env-"));
const env = {
  ...process.env,
  SERVER_PORT: String(port),
  YUVI_RUNTIME_ENV_DIR: runtimeEnvDir,
  NODE_ENV: "development",
  PROVIDER_ALLOW_MOCKS: "true",
  MEMORY_REPOSITORY: memoryRepository,
  DEFAULT_CHAT_PROVIDER: "deepseek",
  DEFAULT_REASONING_PROVIDER: "deepseek",
  DEFAULT_TTS_PROVIDER: "xai",
  DEFAULT_STT_PROVIDER: "dashscope",
  DEFAULT_VISION_PROVIDER: "xai",
  DEFAULT_EMBEDDING_PROVIDER: "mock"
};

const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  env,
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth();

  const health = await step("GET /health", () => getJson(`http://127.0.0.1:${port}/health`));
  assert(health.ok === true, "GET /health should return ok=true");

  const message = await step("POST /message", () =>
    postJson(`http://127.0.0.1:${port}/message`, {
      sessionId: "smoke",
      text: "hello",
      options: {
        useMemory: true,
        voiceOutput: false
      }
    })
  );
  assert(message.type === "agent.reply", "POST /message should return agent.reply");

  const memory = await step("POST /memory", () =>
    postJson(`http://127.0.0.1:${port}/memory`, {
      type: "episodic",
      subtype: "test",
      memoryLayer: "recall",
      content: "Smoke test memory.",
      source: "smoke",
      importance: 0.2,
      metadata: { testMemory: true },
      tags: ["smoke", "test"]
    })
  );
  assert(memory.type === "episodic", "POST /memory should create a smoke memory");
  assert(memory.metadata?.testMemory === true, "Smoke memory should be marked as test memory");
  assert(memory.memoryLayer !== "core", "Smoke memory should not be core memory");
  assert(Boolean(memory.expiresAt), "Smoke memory should expire quickly");

  const recent = await step("GET /memory/recent", () =>
    getJson(`http://127.0.0.1:${port}/memory/recent?limit=5`)
  );
  assert(
    Array.isArray(recent.memories) && recent.memories.length > 0,
    "GET /memory/recent should return memories"
  );

  const search = await step("GET /memory/search", () =>
    getJson(`http://127.0.0.1:${port}/memory/search?q=Smoke&includeTestMemories=true&limit=5`)
  );
  assert(
    Array.isArray(search.memories) && search.memories.length > 0,
    "GET /memory/search?q=... should return matching memories"
  );

  const unicodeSearch = await step("POST /memory/search", () =>
    postJson(`http://127.0.0.1:${port}/memory/search`, {
      q: "Smoke test memory.",
      includeTestMemories: true,
      limit: 5
    })
  );
  assert(
    Array.isArray(unicodeSearch.memories) && unicodeSearch.memories.length > 0,
    "POST /memory/search should return matching memories"
  );

  console.log("Smoke checks passed.");
} finally {
  server.kill("SIGTERM");
  rmSync(runtimeEnvDir, { recursive: true, force: true });
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    console.log(`✓ ${label}`);
    return result;
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForHealth(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try {
      await getJson(`http://127.0.0.1:${port}/health`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Server did not become healthy. stderr: ${stderr}`);
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}`);
  }
  return response.json();
}

async function postJson(url: string, payload: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
