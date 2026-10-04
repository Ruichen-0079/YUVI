import { createProviderRegistryFromEnv } from "@companion/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { readProductSettings } from "../services/product-store.js";
import { requireLocalDashboardAccess } from "./security.js";

/**
 * Simplified local-model connection probes.
 *
 * Read-only: detection never persists Product configuration. Only exact
 * candidate URLs are probed (saved Product endpoints plus YUVI's known
 * loopback defaults) — no port scanning, no LAN discovery. Explicit probes
 * are restricted to loopback hosts. Supplied API keys are used for the
 * single probe request only and are never echoed or stored.
 */

export const LOCAL_CONNECTION_DEFAULTS = {
  embedding: "http://127.0.0.1:8128/v1",
  stt: "http://127.0.0.1:9876",
  tts: "http://127.0.0.1:9881"
} as const;

export type LocalConnectionService = keyof typeof LOCAL_CONNECTION_DEFAULTS;
export type LocalConnectionState =
  | "ready"
  | "hibernated"
  | "warming"
  | "unavailable"
  | "needs-key"
  | "not-configured";

export type LocalConnectionFinding = {
  service: LocalConnectionService;
  testedEndpoint: string;
  source: "saved" | "default" | "explicit";
  state: LocalConnectionState;
  model?: string;
  dimensions?: number;
  voice?: string;
  detail?: string;
};

const PROBE_TIMEOUT_MS = 8000;
const EMBEDDING_CHECK_TEXT = "YUVI local embedding check";

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Bare origins keep the OpenAI /v1 convenience default; supplied API paths win. */
function openAiBase(baseUrl: string): string {
  const base = normalizeBase(baseUrl);
  try {
    return new URL(base).pathname === "/" ? `${base}/v1` : base;
  } catch {
    return base;
  }
}

function isLoopbackHttp(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  });
  let body: unknown = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

async function probeEmbedding(
  endpoint: string,
  source: LocalConnectionFinding["source"],
  apiKey?: string,
  context?: AppContext
): Promise<LocalConnectionFinding> {
  const base = openAiBase(endpoint);
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  let models: { status: number; body: unknown };
  try {
    models = await fetchJson(`${base}/models`, { headers });
  } catch {
    return {
      service: "embedding",
      testedEndpoint: endpoint,
      source,
      state: "unavailable",
      detail: "Connection unavailable. Check that the embedding service is running."
    };
  }
  if (models.status === 401) {
    return {
      service: "embedding",
      testedEndpoint: endpoint,
      source,
      state: "needs-key",
      detail: "Endpoint is reachable but needs an API key."
    };
  }
  const record = asRecord(models.body);
  const entries = Array.isArray(record?.["data"]) ? (record?.["data"] as unknown[]) : [];
  const first = asRecord(entries[0]);
  const modelId = typeof first?.["id"] === "string" ? (first?.["id"] as string) : undefined;
  const metaDims = asRecord(first?.["meta"])?.["n_embd"];
  const listedDims =
    Number.isSafeInteger(metaDims) && (metaDims as number) > 0 ? (metaDims as number) : undefined;
  if (models.status !== 200 || !modelId) {
    return {
      service: "embedding",
      testedEndpoint: endpoint,
      source,
      state: "unavailable",
      detail:
        models.status !== 200
          ? `Invalid response (HTTP ${models.status}).`
          : "Invalid response: no model listed."
    };
  }
  // A real embedding call confirms usable dimensions; the listed metadata is the fallback.
  if (apiKey !== undefined || models.status === 200) {
    try {
      const registry = createProviderRegistryFromEnv({
        NODE_ENV: "production",
        PROVIDER_ALLOW_MOCKS: "false",
        DEFAULT_EMBEDDING_PROVIDER: "openai-compatible",
        EMBEDDING_PROVIDER_CHAIN: "openai-compatible",
        EMBEDDING_API_BASEURL: base,
        EMBEDDING_API_KEY: apiKey ?? "local-no-key",
        EMBEDDING_MODEL: modelId,
        EMBEDDING_DIMENSIONS: String(listedDims ?? 1536)
      });
      if (!context?.outwardEffects) throw Error("Durable inference probe unavailable.");
      registry.setAccounting(context.outwardEffects);
      const vector = await registry
        .getEmbeddingProvider()
        .embedText(EMBEDDING_CHECK_TEXT, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return {
        service: "embedding",
        testedEndpoint: endpoint,
        source,
        state: "ready",
        model: modelId,
        dimensions: vector.length,
        detail: `Verified with a real embedding (${vector.length} dimensions).`
      };
    } catch {
      /* fall through to listed metadata */
    }
  }
  return {
    service: "embedding",
    testedEndpoint: endpoint,
    source,
    state: "ready",
    model: modelId,
    ...(listedDims !== undefined ? { dimensions: listedDims } : {}),
    detail: "Endpoint responded with a model listing."
  };
}

async function probeStt(
  endpoint: string,
  source: LocalConnectionFinding["source"]
): Promise<LocalConnectionFinding> {
  const base = normalizeBase(endpoint);
  let result: { status: number; body: unknown };
  try {
    result = await fetchJson(`${base}/health`);
  } catch {
    return {
      service: "stt",
      testedEndpoint: endpoint,
      source,
      state: "unavailable",
      detail: "Connection unavailable. Check that the speech recognition service is running."
    };
  }
  const body = asRecord(result.body);
  if (result.status === 200 && body?.["ok"] === true && body?.["service"] === "yuvi-local-stt") {
    const asrModel =
      typeof body?.["asrModel"] === "string" ? (body?.["asrModel"] as string) : undefined;
    return {
      service: "stt",
      testedEndpoint: endpoint,
      source,
      state: "ready",
      ...(asrModel ? { model: asrModel } : {}),
      detail: "SenseVoice recognition service is responding."
    };
  }
  return {
    service: "stt",
    testedEndpoint: endpoint,
    source,
    state: "unavailable",
    detail:
      result.status !== 200
        ? `Invalid response (HTTP ${result.status}).`
        : "Invalid response: not a yuvi-local-stt service."
  };
}

async function probeTts(
  endpoint: string,
  source: LocalConnectionFinding["source"]
): Promise<LocalConnectionFinding> {
  const base = normalizeBase(endpoint);
  let result: { status: number; body: unknown };
  try {
    result = await fetchJson(`${base}/health`);
  } catch {
    return {
      service: "tts",
      testedEndpoint: endpoint,
      source,
      state: "unavailable",
      detail: "Connection unavailable. Check that the speech synthesis service is running."
    };
  }
  const body = asRecord(result.body);
  // Hibernated is a healthy available state: the wrapper wakes on demand.
  if (result.status === 200 && body?.["service"] === "yuvi-dots-tts") {
    const state = body?.["state"];
    const readyOnDemand = body?.["ready_on_demand"] === true;
    const voice = typeof body?.["voice"] === "string" ? (body?.["voice"] as string) : undefined;
    if (state === "ready" && body?.["model_loaded"] === true)
      return {
        service: "tts",
        testedEndpoint: endpoint,
        source,
        state: "ready",
        ...(voice ? { voice } : {}),
        detail: "Speech synthesis is ready."
      };
    if (state === "hibernated" || (readyOnDemand && state !== "error" && state !== "warming"))
      return {
        service: "tts",
        testedEndpoint: endpoint,
        source,
        state: "hibernated",
        ...(voice ? { voice } : {}),
        detail: "Hibernated. The service wakes automatically for synthesis."
      };
    if (state === "warming")
      return {
        service: "tts",
        testedEndpoint: endpoint,
        source,
        state: "warming",
        ...(voice ? { voice } : {}),
        detail: "Speech synthesis is warming up."
      };
  }
  return {
    service: "tts",
    testedEndpoint: endpoint,
    source,
    state: "unavailable",
    detail:
      result.status !== 200
        ? `Invalid response (HTTP ${result.status}).`
        : "Invalid response: not a yuvi-dots-tts service."
  };
}

type Candidate = { endpoint: string; source: "saved" | "default"; apiKey?: string };

function savedCandidates(): Record<LocalConnectionService, Candidate[]> {
  const found: Record<LocalConnectionService, Candidate[]> = { embedding: [], stt: [], tts: [] };
  let settings: ReturnType<typeof readProductSettings> = null;
  try {
    settings = readProductSettings();
  } catch {
    settings = null;
  }
  for (const provider of settings?.configuration.providers ?? []) {
    const entry: Candidate = {
      endpoint: provider.baseUrl,
      source: "saved",
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {})
    };
    if (provider.adapter === "openai-compatible") found.embedding.push(entry);
    else if (provider.adapter === "local-stt") found.stt.push(entry);
    else if (provider.adapter === "dots-tts" || provider.adapter === "gpt-sovits")
      found.tts.push(entry);
  }
  return found;
}

async function detectService(
  service: LocalConnectionService,
  candidates: Candidate[],
  context: AppContext
): Promise<LocalConnectionFinding> {
  const seen = new Set<string>();
  const ordered = [
    ...candidates,
    { endpoint: LOCAL_CONNECTION_DEFAULTS[service], source: "default" as const }
  ].filter((candidate) => {
    const key = candidate.endpoint.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let first: LocalConnectionFinding | null = null;
  for (const candidate of ordered) {
    const finding =
      service === "embedding"
        ? await probeEmbedding(candidate.endpoint, candidate.source, candidate.apiKey, context)
        : service === "stt"
          ? await probeStt(candidate.endpoint, candidate.source)
          : await probeTts(candidate.endpoint, candidate.source);
    if (!first) first = finding;
    if (
      finding.state === "ready" ||
      finding.state === "hibernated" ||
      finding.state === "warming" ||
      finding.state === "needs-key"
    )
      return finding;
  }
  return (
    first ?? {
      service,
      testedEndpoint: LOCAL_CONNECTION_DEFAULTS[service],
      source: "default",
      state: "not-configured",
      detail: "No endpoint configured yet."
    }
  );
}

const probeBody = z
  .object({
    service: z.enum(["embedding", "stt", "tts"]),
    endpoint: z.string().trim().min(1).max(2048),
    apiKey: z.string().max(4096).optional()
  })
  .strict();

export async function registerLocalConnectionRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
) {
  app.get("/product/local-services/detect", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const saved = savedCandidates();
    const [embedding, stt, tts] = await Promise.all([
      detectService("embedding", saved.embedding, context),
      detectService("stt", saved.stt, context),
      detectService("tts", saved.tts, context)
    ]);
    return { checkedAt: new Date().toISOString(), services: { embedding, stt, tts } };
  });

  app.post("/product/local-services/probe", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = probeBody.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Service, endpoint and optional API key are required." });
    const { service, endpoint, apiKey } = parsed.data;
    if (!isLoopbackHttp(endpoint))
      return reply.code(400).send({ error: "Only loopback HTTP(S) endpoints can be probed." });
    const key = apiKey?.trim() ? apiKey.trim() : undefined;
    return service === "embedding"
      ? probeEmbedding(endpoint, "explicit", key, context)
      : service === "stt"
        ? probeStt(endpoint, "explicit")
        : probeTts(endpoint, "explicit");
  });
}
