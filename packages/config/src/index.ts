import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeCharacterOutputLanguage,
  type CharacterOutputLanguage
} from "@companion/character-abi";

export type RuntimeEnvironment = "development" | "test" | "production";
export type MemoryRepositoryDriver = "in-memory" | "postgres";
export type MemoryExtractorDriver = "rule-based" | "llm";
export type MemoryBackendDriver = "legacy" | "mem0" | "shadow";
export type EventBusDriver = "in-memory" | "nats";

export type ProviderCapability = "chat" | "reasoning" | "tts" | "stt" | "vision" | "embedding";

export type ProviderSelection = Record<ProviderCapability, string>;

export type ProviderEndpointConfig = {
  provider: string;
  enabled: boolean;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  voice?: string | undefined;
  dimensions?: number | undefined;
};

export type RuntimeProviderConfig = {
  allowMocks: boolean;
  includeRawResponses: boolean;
  defaults: ProviderSelection;
  endpoints: Record<ProviderCapability, ProviderEndpointConfig>;
};

export type RuntimeConfig = {
  /** Semantic final-expression preference consumed by Character. */
  outputLanguage: CharacterOutputLanguage;
  environment: RuntimeEnvironment;
  server: {
    host: string;
    port: number;
    logLevel: string;
  };
  memory: {
    repository: MemoryRepositoryDriver;
    extractor: MemoryExtractorDriver;
    /** Storage backend selector. Default remains legacy for chat path safety. */
    backend: MemoryBackendDriver;
    databaseUrl?: string | undefined;
    mem0BaseUrl?: string | undefined;
    mem0TimeoutMs?: number | undefined;
    mem0HealthTimeoutMs?: number | undefined;
    /**
     * Explicit local single-user identity for Mem0 scopes.
     * Required when MEMORY_BACKEND=mem0 and the request omits subjectUserId/personaId.
     * Never silently defaults to default-user / default-persona.
     */
    subjectUserId?: string | undefined;
    personaId?: string | undefined;
  };
  providers: RuntimeProviderConfig;
  infrastructure: {
    redisUrl?: string | undefined;
    natsUrl?: string | undefined;
    eventBusDriver: EventBusDriver;
  };
};

export type RuntimeConfigEnv = Record<string, string | undefined>;

export type RuntimeEnvFile = {
  path: string;
  exists: boolean;
  values: Record<string, string>;
};

export type RuntimeEnvFiles = {
  runtimeEnvDir: string;
  base: RuntimeEnvFile;
  local: RuntimeEnvFile;
  env: RuntimeConfigEnv;
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export class ConfigValidationError extends Error {
  readonly issues: ConfigValidationIssue[];

  constructor(issues: ConfigValidationIssue[]) {
    super(
      `Runtime configuration is invalid:\n- ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n- ")}`
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

const defaultProviderSelection: ProviderSelection = {
  chat: "deepseek",
  reasoning: "deepseek",
  tts: "xai",
  stt: "dashscope",
  vision: "xai",
  embedding: "openai-compatible"
};

export function parseRuntimeConfig(env: RuntimeConfigEnv = process.env): RuntimeConfig {
  const environment = parseEnvironment(env["NODE_ENV"]);
  const allowMocks = parseBoolean(env["PROVIDER_ALLOW_MOCKS"], false);
  const defaults = parseProviderSelection(env);
  const chatEndpoint: ProviderEndpointConfig =
    defaults.chat === "openai-compatible"
      ? {
          provider: defaults.chat,
          enabled: true,
          baseUrl: emptyToUndefined(env["OPENAI_COMPATIBLE_API_BASEURL"]),
          apiKey: emptyToUndefined(env["OPENAI_COMPATIBLE_API_KEY"]),
          model: emptyToUndefined(env["OPENAI_COMPATIBLE_CHAT_MODEL"])
        }
      : {
          provider: defaults.chat,
          enabled: true,
          baseUrl: readProviderBaseUrl(
            defaults.chat,
            env["DEEPSEEK_API_BASEURL"],
            "https://api.deepseek.com"
          ),
          apiKey: emptyToUndefined(env["DEEPSEEK_API_KEY"]),
          model: emptyToUndefined(env["DEEPSEEK_CHAT_MODEL"])
        };
  const reasoningEndpoint: ProviderEndpointConfig =
    defaults.reasoning === "openai-compatible"
      ? {
          provider: defaults.reasoning,
          enabled: true,
          baseUrl: emptyToUndefined(env["OPENAI_COMPATIBLE_API_BASEURL"]),
          apiKey: emptyToUndefined(env["OPENAI_COMPATIBLE_API_KEY"]),
          model: emptyToUndefined(env["OPENAI_COMPATIBLE_REASONING_MODEL"])
        }
      : {
          provider: defaults.reasoning,
          enabled: true,
          baseUrl: readProviderBaseUrl(
            defaults.reasoning,
            env["DEEPSEEK_API_BASEURL"],
            "https://api.deepseek.com"
          ),
          apiKey: emptyToUndefined(env["DEEPSEEK_API_KEY"]),
          model: emptyToUndefined(env["DEEPSEEK_REASONING_MODEL"])
        };

  return {
    outputLanguage: normalizeCharacterOutputLanguage(env["OUTPUT_LANGUAGE"]),
    environment,
    server: {
      host: readString(env["SERVER_HOST"], "127.0.0.1"),
      port: parsePort(env["SERVER_PORT"], 6121),
      logLevel: readString(env["LOG_LEVEL"], "info")
    },
    memory: {
      repository: parseMemoryRepository(env["MEMORY_REPOSITORY"]),
      extractor: parseMemoryExtractorDriver(env["MEMORY_EXTRACTOR"]),
      backend: parseMemoryBackend(env["MEMORY_BACKEND"]),
      databaseUrl: emptyToUndefined(env["DATABASE_URL"]),
      mem0BaseUrl: emptyToUndefined(env["MEM0_BASE_URL"]) ?? "http://127.0.0.1:6131",
      /** Chat-path Mem0 search timeout (default 600ms). */
      mem0TimeoutMs: parsePositiveInteger(env["MEM0_RUNTIME_TIMEOUT_MS"], 600),
      mem0HealthTimeoutMs: parsePositiveInteger(env["MEM0_RUNTIME_HEALTH_TIMEOUT_MS"], 1000),
      subjectUserId: emptyToUndefined(env["MEMORY_SUBJECT_USER_ID"]),
      personaId: emptyToUndefined(env["MEMORY_PERSONA_ID"])
    },
    providers: {
      allowMocks,
      includeRawResponses: parseBoolean(env["PROVIDER_INCLUDE_RAW_RESPONSES"], false),
      defaults,
      endpoints: {
        chat: chatEndpoint,
        reasoning: reasoningEndpoint,
        tts: {
          provider: defaults.tts,
          enabled: parseBoolean(env["TTS_ENABLED"], true),
          baseUrl: readProviderBaseUrl(defaults.tts, env["XAI_API_BASEURL"], "https://api.x.ai/v1"),
          apiKey: emptyToUndefined(env["XAI_API_KEY"]),
          model: emptyToUndefined(env["XAI_TTS_MODEL"]),
          voice: emptyToUndefined(env["XAI_TTS_VOICE"])
        },
        stt: {
          provider: defaults.stt,
          enabled: parseBoolean(env["STT_ENABLED"], true),
          baseUrl: readProviderBaseUrl(
            defaults.stt,
            env["DASHSCOPE_API_BASEURL"],
            "https://dashscope.aliyuncs.com/api/v1"
          ),
          apiKey: emptyToUndefined(env["DASHSCOPE_API_KEY"]),
          model: emptyToUndefined(env["DASHSCOPE_STT_MODEL"])
        },
        vision: {
          provider: defaults.vision,
          enabled: parseBoolean(env["VISION_ENABLED"], true),
          baseUrl: readProviderBaseUrl(
            defaults.vision,
            env["XAI_API_BASEURL"],
            "https://api.x.ai/v1"
          ),
          apiKey: emptyToUndefined(env["XAI_API_KEY"]),
          model: emptyToUndefined(env["XAI_VISION_MODEL"])
        },
        embedding: {
          provider: defaults.embedding,
          enabled: parseBoolean(env["EMBEDDING_ENABLED"], true),
          baseUrl: emptyToUndefined(env["EMBEDDING_API_BASEURL"]),
          apiKey: emptyToUndefined(env["EMBEDDING_API_KEY"]),
          model: emptyToUndefined(env["EMBEDDING_MODEL"]),
          dimensions: parsePositiveInteger(env["EMBEDDING_DIMENSIONS"], 1536)
        }
      }
    },
    infrastructure: {
      redisUrl: emptyToUndefined(env["REDIS_URL"]),
      natsUrl: emptyToUndefined(env["NATS_URL"]),
      eventBusDriver: parseEventBus(env["EVENT_BUS"] ?? env["EVENT_BUS_DRIVER"])
    }
  };
}

export function validateRuntimeConfig(config: RuntimeConfig): void {
  const issues = collectRuntimeConfigIssues(config);

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}

export function collectRuntimeConfigIssues(config: RuntimeConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];

  if (config.memory.repository === "postgres" && !config.memory.databaseUrl) {
    issues.push({
      path: "memory.databaseUrl",
      message: "DATABASE_URL is required when MEMORY_REPOSITORY=postgres."
    });
  }

  if (config.infrastructure.eventBusDriver === "nats") {
    issues.push({
      path: "infrastructure.eventBusDriver",
      message: "EVENT_BUS=nats is reserved for future NATS support and is not implemented yet."
    });
  }

  for (const capability of providerCapabilities) {
    const endpoint = config.providers.endpoints[capability];

    if (!endpoint.enabled || endpoint.provider === "mock") {
      continue;
    }

    const requiresSecrets =
      !config.providers.allowMocks &&
      (capability === "chat" || capability === "reasoning" || capability === "embedding");

    if (requiresSecrets && !endpoint.apiKey) {
      issues.push({
        path: `providers.endpoints.${capability}.apiKey`,
        message: `${providerEnvPrefix(endpoint.provider)} API key is required when ${capability} provider '${endpoint.provider}' is enabled.`
      });
    }

    if (requiresSecrets && !endpoint.model) {
      issues.push({
        path: `providers.endpoints.${capability}.model`,
        message: `Model is required when ${capability} provider '${endpoint.provider}' is enabled.`
      });
    }

    if (
      (capability === "chat" || capability === "reasoning") &&
      endpoint.provider === "openai-compatible" &&
      !endpoint.baseUrl
    ) {
      issues.push({
        path: `providers.endpoints.${capability}.baseUrl`,
        message: `OPENAI_COMPATIBLE_API_BASEURL is required when ${capability === "chat" ? "Chat" : "Cognition"} provider 'openai-compatible' is enabled.`
      });
    }
  }

  return issues;
}

export function redactSecret(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  if (value.length <= 8) {
    return "[redacted]";
  }

  return `${value.slice(0, 3)}...[redacted]...${value.slice(-3)}`;
}

export function redactConfig<T>(value: T): T {
  return redactValue(value) as T;
}

export function getRuntimeEnvDir(env: RuntimeConfigEnv = process.env, cwd = process.cwd()): string {
  // Explicit CONFIG wins. DATA is a compatibility fallback for older packaged launches.
  const configured = env["YUVI_RUNTIME_ENV_DIR"]?.trim();
  if (configured) return path.resolve(configured);
  const dataDir = env["YUVI_RUNTIME_DATA_DIR"]?.trim();
  if (dataDir) return path.resolve(dataDir);
  // Packaged flag: do not walk for a workspace root (no source tree).
  if (env["YUVI_PACKAGED"] === "1" || env["YUVI_PACKAGED"] === "true") {
    return path.resolve(cwd);
  }

  return findWorkspaceRoot(cwd) ?? cwd;
}

export function getRuntimeEnvPath(
  filename: ".env" | ".env.local",
  env: RuntimeConfigEnv = process.env,
  cwd = process.cwd()
): string {
  return path.join(getRuntimeEnvDir(env, cwd), filename);
}

export async function readRuntimeEnvFiles(
  input: {
    env?: RuntimeConfigEnv | undefined;
    cwd?: string | undefined;
  } = {}
): Promise<RuntimeEnvFiles> {
  const shellEnv = input.env ?? process.env;
  const runtimeEnvDir = getRuntimeEnvDir(shellEnv, input.cwd ?? process.cwd());
  const base = await readRuntimeEnvFile(path.join(runtimeEnvDir, ".env"));
  const local = await readRuntimeEnvFile(path.join(runtimeEnvDir, ".env.local"));

  return {
    runtimeEnvDir,
    base,
    local,
    env: {
      ...base.values,
      ...shellEnv,
      ...local.values
    }
  };
}

export async function readRuntimeEnvFile(envPath: string): Promise<RuntimeEnvFile> {
  try {
    await access(envPath);
    return {
      path: envPath,
      exists: true,
      values: parseEnvText(await readFile(envPath, "utf8"))
    };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return {
        path: envPath,
        exists: false,
        values: {}
      };
    }
    throw error;
  }
}

export function applyRuntimeEnv(env: RuntimeConfigEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

export function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    result[trimmed.slice(0, separator).trim()] = unquoteEnvValue(trimmed.slice(separator + 1));
  }
  return result;
}

export function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export async function getLegacyServerLocalEnvWarning(
  input: {
    env?: RuntimeConfigEnv | undefined;
    cwd?: string | undefined;
  } = {}
): Promise<string | undefined> {
  const runtimeEnvDir = getRuntimeEnvDir(input.env ?? process.env, input.cwd ?? process.cwd());
  const repoRoot = findWorkspaceRoot(runtimeEnvDir);
  if (!repoRoot || path.resolve(runtimeEnvDir) !== path.resolve(repoRoot)) {
    return undefined;
  }

  const legacyPath = path.join(repoRoot, "apps", "server", ".env.local");
  if (await fileExists(legacyPath)) {
    return `${legacyPath} exists but YUVI_RUNTIME_ENV_DIR points to the repository root; this legacy misplaced file will not be used. Move its settings to ${path.join(repoRoot, ".env.local")}.`;
  }

  return undefined;
}

const providerCapabilities: ProviderCapability[] = [
  "chat",
  "reasoning",
  "tts",
  "stt",
  "vision",
  "embedding"
];

function parseProviderSelection(env: RuntimeConfigEnv): ProviderSelection {
  return {
    chat: readString(env["DEFAULT_CHAT_PROVIDER"], defaultProviderSelection.chat),
    reasoning: readString(env["DEFAULT_REASONING_PROVIDER"], defaultProviderSelection.reasoning),
    tts: readString(env["DEFAULT_TTS_PROVIDER"], defaultProviderSelection.tts),
    stt: readString(env["DEFAULT_STT_PROVIDER"], defaultProviderSelection.stt),
    vision: readString(env["DEFAULT_VISION_PROVIDER"], defaultProviderSelection.vision),
    embedding: readString(
      env["DEFAULT_EMBEDDING_PROVIDER"] ?? env["EMBEDDING_PROVIDER"],
      defaultProviderSelection.embedding
    )
  };
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }

  return "development";
}

function parseMemoryRepository(value: string | undefined): MemoryRepositoryDriver {
  if (value === "postgres") {
    return "postgres";
  }

  return "in-memory";
}

export function parseMemoryExtractorDriver(value: string | undefined): MemoryExtractorDriver {
  if (value === "llm") {
    return "llm";
  }
  if (value === undefined || value === "rule-based") {
    return "rule-based";
  }

  throw new Error(`Unsupported MEMORY_EXTRACTOR '${value}'. Supported values: rule-based, llm.`);
}

/**
 * MEMORY_BACKEND=mem0 | legacy only.
 * Default remains legacy unless env explicitly sets mem0 (dev .env.example uses mem0).
 * Shadow dual-write is intentionally not supported.
 */
function parseMemoryBackend(value: string | undefined): MemoryBackendDriver {
  if (!value || value === "legacy") {
    return "legacy";
  }
  if (value === "mem0") {
    return "mem0";
  }
  // Unknown values (including retired "shadow") fall back to legacy.
  return "legacy";
}

function parseEventBus(value: string | undefined): EventBusDriver {
  if (!value || value === "memory" || value === "in-memory") {
    return "in-memory";
  }
  if (value === "nats") {
    return "nats";
  }

  return "in-memory";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = parsePositiveInteger(value, fallback);
  return port > 65535 ? fallback : port;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readString(value: string | undefined, fallback: string): string {
  return emptyToUndefined(value) ?? fallback;
}

function readProviderBaseUrl(
  provider: string,
  value: string | undefined,
  fallback: string
): string | undefined {
  if (provider === "mock") {
    return undefined;
  }

  return readString(value, fallback);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function findWorkspaceRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function providerEnvPrefix(provider: string): string {
  switch (provider) {
    case "deepseek":
      return "DEEPSEEK";
    case "xai":
      return "XAI";
    case "dashscope":
      return "DASHSCOPE";
    default:
      return provider.toUpperCase();
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] =
        isSensitiveKey(key) && typeof nestedValue === "string"
          ? redactSecret(nestedValue)
          : redactValue(nestedValue);
    }

    return result;
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("authorization") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password")
  );
}
