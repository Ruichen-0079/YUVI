import Fastify from "fastify";
import { HostOutwardEffects } from "../test-support/offline-outward-effects.js";
import { afterEach, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { registerLocalConnectionRoutes } from "./local-connection.js";

vi.mock("../services/product-store.js", () => ({ readProductSettings: vi.fn() }));
import { readProductSettings } from "../services/product-store.js";

const mockedSettings = vi.mocked(readProductSettings);
const config = { runtimeMode: "development", dashboardDevToken: "test-token" } as ServerConfig;
const auth = { authorization: "Bearer test-token" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function buildApp() {
  const app = Fastify();
  await registerLocalConnectionRoutes(
    app,
    { outwardEffects: new HostOutwardEffects() } as unknown as AppContext,
    config
  );
  return app;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init))
  );
}

it("detects the known local endpoints without persisting anything", async () => {
  mockedSettings.mockReturnValue(null);
  stubFetch((url, init) => {
    if (url === "http://127.0.0.1:8128/v1/models")
      return jsonResponse(200, {
        data: [{ id: "Qwen3-Embedding-0.6B-Q8_0.gguf", meta: { n_embd: 1024 } }]
      });
    if (url === "http://127.0.0.1:8128/v1/embeddings")
      return jsonResponse(200, { data: [{ embedding: [0.1, 0.2, 0.3] }] });
    if (url === "http://127.0.0.1:9876/health")
      return jsonResponse(200, {
        ok: true,
        service: "yuvi-local-stt",
        asrModel: "model.int8.onnx"
      });
    if (url === "http://127.0.0.1:9881/health")
      return jsonResponse(200, {
        service: "yuvi-dots-tts",
        state: "hibernated",
        ready_on_demand: true,
        voice: "rei"
      });
    throw new Error(`unexpected probe ${url} ${JSON.stringify(init?.method)}`);
  });
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/product/local-services/detect",
      headers: auth
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.services.embedding).toMatchObject({
      service: "embedding",
      testedEndpoint: "http://127.0.0.1:8128/v1",
      source: "default",
      state: "ready",
      model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      dimensions: 3
    });
    expect(body.services.stt).toMatchObject({
      testedEndpoint: "http://127.0.0.1:9876",
      state: "ready",
      model: "model.int8.onnx"
    });
    // Hibernated is a healthy available state, not an error.
    expect(body.services.tts).toMatchObject({
      testedEndpoint: "http://127.0.0.1:9881",
      state: "hibernated",
      voice: "rei"
    });
    expect(JSON.stringify(body)).not.toContain("Bearer");
  } finally {
    await app.close();
  }
});

it("prefers saved endpoints and reports truthful failures with the tested endpoint", async () => {
  mockedSettings.mockReturnValue({
    configuration: {
      version: 1,
      providers: [
        {
          id: "emb",
          displayName: "Saved embedding",
          baseUrl: "http://127.0.0.1:8128/v1",
          adapter: "openai-compatible",
          apiKey: "saved-key"
        }
      ],
      models: [],
      routes: {
        chat: [],
        reasoning: [],
        proactive: [],
        embedding: [],
        vision: [],
        stt: [],
        tts: []
      }
    },
    people: [],
    primaryPersonId: null,
    proactive: { threshold: 0.7, intervalMs: 60000 },
    revision: 1
  } as unknown as ReturnType<typeof readProductSettings>);
  stubFetch((url, init) => {
    if (url === "http://127.0.0.1:8128/v1/models") {
      expect((init?.headers as Record<string, string>)?.["authorization"]).toBe("Bearer saved-key");
      return jsonResponse(200, { data: [{ id: "saved-model", meta: { n_embd: 512 } }] });
    }
    if (url === "http://127.0.0.1:8128/v1/embeddings")
      return jsonResponse(200, { data: [{ embedding: [0.5, 0.5] }] });
    if (url === "http://127.0.0.1:9876/health") throw new Error("connection refused");
    if (url === "http://127.0.0.1:9881/health")
      return jsonResponse(200, { service: "something-else", state: "ready" });
    throw new Error(`unexpected probe ${url}`);
  });
  const app = await buildApp();
  try {
    const body = (
      await app.inject({ method: "GET", url: "/product/local-services/detect", headers: auth })
    ).json();
    expect(body.services.embedding).toMatchObject({
      source: "saved",
      state: "ready",
      dimensions: 2,
      model: "saved-model"
    });
    expect(body.services.stt).toMatchObject({
      testedEndpoint: "http://127.0.0.1:9876",
      state: "unavailable"
    });
    expect(body.services.stt.detail).toContain("running");
    expect(body.services.tts).toMatchObject({
      testedEndpoint: "http://127.0.0.1:9881",
      state: "unavailable"
    });
    expect(body.services.tts.detail).toContain("yuvi-dots-tts");
  } finally {
    await app.close();
  }
});

it("reports needs-key when the embedding endpoint requires authentication", async () => {
  mockedSettings.mockReturnValue(null);
  stubFetch((url) => {
    if (url === "http://127.0.0.1:8128/v1/models")
      return jsonResponse(401, { error: { message: "Invalid API Key" } });
    if (url === "http://127.0.0.1:9876/health") throw new Error("down");
    if (url === "http://127.0.0.1:9881/health") throw new Error("down");
    throw new Error(`unexpected probe ${url}`);
  });
  const app = await buildApp();
  try {
    const body = (
      await app.inject({ method: "GET", url: "/product/local-services/detect", headers: auth })
    ).json();
    expect(body.services.embedding).toMatchObject({
      state: "needs-key",
      testedEndpoint: "http://127.0.0.1:8128/v1"
    });
  } finally {
    await app.close();
  }
});

it("restricts explicit probes to loopback endpoints and never echoes keys", async () => {
  mockedSettings.mockReturnValue(null);
  stubFetch((url) => {
    if (url === "http://127.0.0.1:8128/v1/models")
      return jsonResponse(200, { data: [{ id: "m" }] });
    if (url === "http://127.0.0.1:8128/v1/embeddings")
      return jsonResponse(200, { data: [{ embedding: [1] }] });
    throw new Error(`unexpected probe ${url}`);
  });
  const app = await buildApp();
  try {
    const lan = await app.inject({
      method: "POST",
      url: "/product/local-services/probe",
      headers: auth,
      payload: { service: "embedding", endpoint: "http://192.168.1.10:8128/v1" }
    });
    expect(lan.statusCode).toBe(400);
    const probed = await app.inject({
      method: "POST",
      url: "/product/local-services/probe",
      headers: auth,
      payload: { service: "embedding", endpoint: "http://127.0.0.1:8128/v1", apiKey: "typed-key" }
    });
    expect(probed.statusCode).toBe(200);
    expect(probed.json()).toMatchObject({ source: "explicit", state: "ready", dimensions: 1 });
    expect(probed.body).not.toContain("typed-key");
  } finally {
    await app.close();
  }
});

it("protects detection behind local dashboard access", async () => {
  const app = await buildApp();
  try {
    expect(
      (await app.inject({ method: "GET", url: "/product/local-services/detect" })).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/product/local-services/detect",
          remoteAddress: "192.0.2.1",
          headers: auth
        })
      ).statusCode
    ).toBe(403);
  } finally {
    await app.close();
  }
});
