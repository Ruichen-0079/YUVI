import { CHARACTER_OUTPUT_LANGUAGES } from "@companion/character-abi";

export const editableKeys = [
  "YUVI_PRODUCT_CONFIGURATION",
  "MEMORY_SUBJECT_USER_ID",
  "MEMORY_PERSONA_ID",
  "PROACTIVE_SCORE_THRESHOLD",
  "PROACTIVE_EVALUATION_INTERVAL_MS",
  "OUTPUT_LANGUAGE",
  "MEMORY_REPOSITORY",
  "MEMORY_BACKEND",
  "MEM0_BASE_URL",
  "MEM0_OLLAMA_BASE_URL",
  "DATABASE_URL",
  "MEMORY_EXTRACTOR",
  "MEMORY_MAINTENANCE_ENABLED",
  "MEMORY_MAINTENANCE_RUN_ON_STARTUP",
  "MEMORY_MAINTENANCE_INTERVAL_MINUTES",
  "MEMORY_MAINTENANCE_LIMIT",
  "MEMORY_VECTOR_INDEX_ENABLED",
  "MEMORY_VECTOR_INDEX_TYPE",
  "MEMORY_VECTOR_DISTANCE",
  "MEMORY_VECTOR_IVFFLAT_PROBES",
  "MEMORY_VECTOR_HNSW_EF_SEARCH",
  "YUVI_AUTO_MIGRATE",
  "YUVI_DEV_SUPERVISOR",
  "EVENT_BUS",
  "PROVIDER_ALLOW_MOCKS",
  "DEFAULT_CHAT_PROVIDER",
  "DEFAULT_REASONING_PROVIDER",
  "CHAT_PROVIDER_CHAIN",
  "REASONING_PROVIDER_CHAIN",
  "EMBEDDING_PROVIDER_CHAIN",
  "TTS_PROVIDER_CHAIN",
  "STT_PROVIDER_CHAIN",
  "VISION_PROVIDER_CHAIN",
  "SERVER_HOST",
  "SERVER_PORT",
  "DEEPSEEK_API_BASEURL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_CHAT_MODEL",
  "DEEPSEEK_REASONING_MODEL",
  "OPENAI_COMPATIBLE_API_BASEURL",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_CHAT_MODEL",
  "OPENAI_COMPATIBLE_REASONING_MODEL",
  "OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL",
  "OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT",
  "XAI_API_BASEURL",
  "XAI_API_KEY",
  "XAI_TTS_MODEL",
  "XAI_TTS_VOICE",
  "XAI_VISION_MODEL",
  "DASHSCOPE_API_BASEURL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_STT_MODEL",
  "NVIDIA_API_BASEURL",
  "NVIDIA_API_KEY",
  "NVIDIA_CHAT_MODEL",
  "NVIDIA_REASONING_MODEL",
  "NVIDIA_EMBEDDING_MODEL",
  "NVIDIA_EMBEDDING_DIMENSIONS",
  "NVIDIA_VISION_MODEL",
  "LOCAL_MODEL_BASEURL",
  "LOCAL_CHAT_MODEL",
  "LOCAL_REASONING_MODEL",
  "LOCAL_EMBEDDING_MODEL",
  "LOCAL_EMBEDDING_DIMENSIONS",
  "LOCAL_TTS_MODEL",
  "LOCAL_TTS_BASE_URL",
  "GPT_SOVITS_TTS_BASE_URL",
  "GPT_SOVITS_TTS_UPSTREAM_URL",
  "GPT_SOVITS_TTS_GPT_WEIGHTS",
  "GPT_SOVITS_TTS_SOVITS_WEIGHTS",
  "GPT_SOVITS_TTS_LANGUAGE",
  "GPT_SOVITS_TTS_SPEAKER",
  "GPT_SOVITS_TTS_STYLE",
  "GPT_SOVITS_TTS_REFERENCE_RANK",
  "GPT_SOVITS_TTS_REFERENCE_AUDIO",
  "GPT_SOVITS_TTS_REFERENCE_TEXT",
  "GPT_SOVITS_TTS_REFERENCE_LANGUAGE",
  "GPT_SOVITS_TTS_TEXT_SPLIT_METHOD",
  "GPT_SOVITS_TTS_TOP_K",
  "GPT_SOVITS_TTS_TOP_P",
  "GPT_SOVITS_TTS_TEMPERATURE",
  "GPT_SOVITS_TTS_REPETITION_PENALTY",
  "GPT_SOVITS_TTS_SAMPLE_STEPS",
  "GPT_SOVITS_TTS_TIMEOUT_MS",
  "LOCAL_STT_MODEL",
  "LOCAL_STT_BASE_URL",
  "LOCAL_VISION_MODEL",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_API_BASEURL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS"
] as const;

export type EditableRuntimeSetting = (typeof editableKeys)[number];

export const secretKeys = new Set<EditableRuntimeSetting>([
  "YUVI_PRODUCT_CONFIGURATION",
  "DATABASE_URL",
  "DEEPSEEK_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "XAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "NVIDIA_API_KEY",
  "EMBEDDING_API_KEY"
]);

const restartRequiredKeys = new Set<EditableRuntimeSetting>([
  "MEMORY_BACKEND",
  "MEM0_BASE_URL",
  "MEM0_OLLAMA_BASE_URL",
  "MEMORY_REPOSITORY",
  "DATABASE_URL",
  "MEMORY_MAINTENANCE_ENABLED",
  "MEMORY_MAINTENANCE_RUN_ON_STARTUP",
  "MEMORY_MAINTENANCE_INTERVAL_MINUTES",
  "MEMORY_MAINTENANCE_LIMIT",
  "MEMORY_VECTOR_INDEX_ENABLED",
  "MEMORY_VECTOR_INDEX_TYPE",
  "MEMORY_VECTOR_DISTANCE",
  "MEMORY_VECTOR_IVFFLAT_PROBES",
  "MEMORY_VECTOR_HNSW_EF_SEARCH",
  "EMBEDDING_PROVIDER_CHAIN",
  "EMBEDDING_PROVIDER",
  "NVIDIA_EMBEDDING_MODEL",
  "NVIDIA_EMBEDDING_DIMENSIONS",
  "LOCAL_EMBEDDING_MODEL",
  "LOCAL_EMBEDDING_DIMENSIONS",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "YUVI_AUTO_MIGRATE",
  "YUVI_DEV_SUPERVISOR",
  "EVENT_BUS",
  "SERVER_HOST",
  "SERVER_PORT",
  "GPT_SOVITS_TTS_GPT_WEIGHTS",
  "GPT_SOVITS_TTS_SOVITS_WEIGHTS"
]);

export type RuntimeSettingApplyMode = "hot_reload" | "restart_required";

export function getRuntimeSettingApplyMode(key: EditableRuntimeSetting): RuntimeSettingApplyMode {
  return restartRequiredKeys.has(key) ? "restart_required" : "hot_reload";
}

export function getRestartRequiredKeys(): EditableRuntimeSetting[] {
  return editableKeys.filter((key) => getRuntimeSettingApplyMode(key) === "restart_required");
}

export function getPendingRestartKeys(
  desired: Record<string, string | undefined>,
  active: Record<string, string | undefined>
): EditableRuntimeSetting[] {
  return getRestartRequiredKeys().filter(
    (key) => normalizeForComparison(key, desired[key]) !== normalizeForComparison(key, active[key])
  );
}

export function snapshotRestartSettings(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  return Object.fromEntries(getRestartRequiredKeys().map((key) => [key, env[key]]));
}

export type RuntimeSettingsValidationResult = {
  fieldErrors: Record<string, string>;
};

const booleanKeys = new Set<EditableRuntimeSetting>([
  "MEMORY_MAINTENANCE_ENABLED",
  "MEMORY_MAINTENANCE_RUN_ON_STARTUP",
  "MEMORY_VECTOR_INDEX_ENABLED",
  "YUVI_AUTO_MIGRATE",
  "YUVI_DEV_SUPERVISOR",
  "PROVIDER_ALLOW_MOCKS"
]);

const providerChainRules: Record<string, Set<string>> = {
  CHAT_PROVIDER_CHAIN: new Set(["openai-compatible", "deepseek", "nvidia", "local", "mock"]),
  REASONING_PROVIDER_CHAIN: new Set(["openai-compatible", "deepseek", "nvidia", "local", "mock"]),
  EMBEDDING_PROVIDER_CHAIN: new Set(["openai-compatible", "nvidia", "local", "mock"]),
  TTS_PROVIDER_CHAIN: new Set(["xai", "local", "mock"]),
  STT_PROVIDER_CHAIN: new Set(["dashscope", "local", "mock"]),
  VISION_PROVIDER_CHAIN: new Set(["xai", "nvidia", "local", "mock"])
};

const providerSelectionRules: Record<string, Set<string>> = {
  DEFAULT_CHAT_PROVIDER: new Set(["openai-compatible", "deepseek", "nvidia", "local", "mock"]),
  DEFAULT_REASONING_PROVIDER: new Set(["openai-compatible", "deepseek", "nvidia", "local", "mock"])
};

const embeddingProviderNames = new Set(["openai-compatible", "nvidia", "local", "mock"]);

const urlKeys = new Set<EditableRuntimeSetting>([
  "MEM0_BASE_URL",
  "MEM0_OLLAMA_BASE_URL",
  "LOCAL_STT_BASE_URL",
  "DEEPSEEK_API_BASEURL",
  "OPENAI_COMPATIBLE_API_BASEURL",
  "XAI_API_BASEURL",
  "DASHSCOPE_API_BASEURL",
  "NVIDIA_API_BASEURL",
  "LOCAL_MODEL_BASEURL",
  "LOCAL_TTS_BASE_URL",
  "GPT_SOVITS_TTS_BASE_URL",
  "GPT_SOVITS_TTS_UPSTREAM_URL",
  "EMBEDDING_API_BASEURL"
]);

export function validateRuntimeSettings(
  env: Record<string, string | undefined>
): RuntimeSettingsValidationResult {
  const fieldErrors: Record<string, string> = {};
  const value = (key: string): string | undefined => env[key];
  const add = (key: string, message: string): void => {
    if (!fieldErrors[key]) fieldErrors[key] = message;
  };

  const memoryRepository = value("MEMORY_REPOSITORY")?.trim().toLowerCase();
  if (value("MEMORY_BACKEND") && !["legacy", "mem0"].includes(value("MEMORY_BACKEND")!)) {
    add("MEMORY_BACKEND", "Supported values are legacy and mem0.");
  }
  if (memoryRepository && !["in-memory", "memory", "postgres"].includes(memoryRepository)) {
    add("MEMORY_REPOSITORY", "Supported values are in-memory, memory, and postgres.");
  }
  if (memoryRepository === "postgres" && !value("DATABASE_URL")?.trim()) {
    add("MEMORY_REPOSITORY", "DATABASE_URL is required when MEMORY_REPOSITORY is postgres.");
  }

  const outputLanguage = value("OUTPUT_LANGUAGE")?.trim().toUpperCase();
  if (
    outputLanguage &&
    !(CHARACTER_OUTPUT_LANGUAGES as readonly string[]).includes(outputLanguage)
  ) {
    add("OUTPUT_LANGUAGE", `Supported values are ${CHARACTER_OUTPUT_LANGUAGES.join(", ")}.`);
  }

  const extractor = value("MEMORY_EXTRACTOR");
  if (extractor !== undefined && !["llm", "rule-based"].includes(extractor)) {
    add("MEMORY_EXTRACTOR", "Supported values are llm and rule-based.");
  }

  const assistantContinuationFormat = value(
    "OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT"
  )?.trim();
  if (assistantContinuationFormat && assistantContinuationFormat !== "deepseek-v4") {
    add("OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT", "Supported value is deepseek-v4.");
  }

  const embeddingProvider = value("EMBEDDING_PROVIDER");
  if (embeddingProvider !== undefined && !embeddingProviderNames.has(embeddingProvider.trim())) {
    add(
      "EMBEDDING_PROVIDER",
      `Supported providers: ${Array.from(embeddingProviderNames).join(", ")}.`
    );
  }

  const eventBus = value("EVENT_BUS")?.trim().toLowerCase();
  if (eventBus && !["in-memory", "memory"].includes(eventBus)) {
    add("EVENT_BUS", "Only the in-memory event bus is currently implemented.");
  }

  const host = value("SERVER_HOST");
  if (host !== undefined && host.trim().length === 0) {
    add("SERVER_HOST", "SERVER_HOST must not be empty.");
  }

  const serverPort = value("SERVER_PORT");
  if (serverPort === "") {
    add("SERVER_PORT", "SERVER_PORT must be an integer between 1 and 65535.");
  } else {
    validateInteger(serverPort, "SERVER_PORT", 1, 65535, add);
  }
  for (const key of booleanKeys) {
    const candidate = value(key);
    if (candidate !== undefined && candidate !== "" && !isBoolean(candidate)) {
      add(key, "Expected true, false, 1, 0, yes, no, on, or off.");
    }
  }

  validateInteger(
    value("MEMORY_MAINTENANCE_INTERVAL_MINUTES"),
    "MEMORY_MAINTENANCE_INTERVAL_MINUTES",
    0,
    Number.MAX_SAFE_INTEGER,
    add
  );
  validateInteger(
    value("MEMORY_MAINTENANCE_LIMIT"),
    "MEMORY_MAINTENANCE_LIMIT",
    1,
    Number.MAX_SAFE_INTEGER,
    add
  );
  validateInteger(
    value("MEMORY_VECTOR_IVFFLAT_PROBES"),
    "MEMORY_VECTOR_IVFFLAT_PROBES",
    1,
    Number.MAX_SAFE_INTEGER,
    add
  );
  validateInteger(
    value("MEMORY_VECTOR_HNSW_EF_SEARCH"),
    "MEMORY_VECTOR_HNSW_EF_SEARCH",
    1,
    Number.MAX_SAFE_INTEGER,
    add
  );

  const vectorType = value("MEMORY_VECTOR_INDEX_TYPE")?.trim().toLowerCase();
  if (vectorType && !["hnsw", "ivfflat", "none"].includes(vectorType)) {
    add("MEMORY_VECTOR_INDEX_TYPE", "Supported values are hnsw, ivfflat, and none.");
  }
  const vectorDistance = value("MEMORY_VECTOR_DISTANCE")?.trim().toLowerCase();
  if (vectorDistance && vectorDistance !== "cosine") {
    add("MEMORY_VECTOR_DISTANCE", "Only cosine distance is currently supported.");
  }

  for (const key of [
    "NVIDIA_EMBEDDING_DIMENSIONS",
    "LOCAL_EMBEDDING_DIMENSIONS",
    "EMBEDDING_DIMENSIONS"
  ] as const) {
    validateInteger(value(key), key, 1, Number.MAX_SAFE_INTEGER, add);
  }

  for (const [key, supported] of Object.entries(providerChainRules)) {
    const candidate = value(key);
    if (candidate === undefined || candidate.trim() === "") continue;
    const entries = candidate.split(",").map((entry) => entry.trim());
    if (entries.some((entry) => !entry || !supported.has(entry))) {
      add(
        key,
        `Unsupported provider chain. Supported providers: ${Array.from(supported).join(", ")}.`
      );
    }
  }

  for (const [key, supported] of Object.entries(providerSelectionRules)) {
    const candidate = value(key);
    if (candidate === undefined) continue;
    const selected = candidate.trim();
    if (!selected || !supported.has(selected)) {
      add(
        key,
        `Unsupported provider selection. Supported providers: ${Array.from(supported).join(", ")}.`
      );
    }
  }

  for (const key of urlKeys) {
    const candidate = value(key)?.trim();
    if (candidate && !isHttpUrl(candidate)) {
      add(key, "Expected a valid http:// or https:// URL.");
    } else if (
      candidate &&
      key === "OPENAI_COMPATIBLE_API_BASEURL" &&
      urlHasCredentials(candidate)
    ) {
      add(key, "URL credentials are not allowed; store the API key separately.");
    }
  }

  validateInteger(
    value("GPT_SOVITS_TTS_REFERENCE_RANK"),
    "GPT_SOVITS_TTS_REFERENCE_RANK",
    0,
    3,
    add
  );
  validateInteger(value("GPT_SOVITS_TTS_TOP_K"), "GPT_SOVITS_TTS_TOP_K", 1, 100, add);
  validateNumber(value("GPT_SOVITS_TTS_TOP_P"), "GPT_SOVITS_TTS_TOP_P", 0, 1, add);
  validateNumber(value("GPT_SOVITS_TTS_TEMPERATURE"), "GPT_SOVITS_TTS_TEMPERATURE", 0, 2, add);
  validateNumber(
    value("GPT_SOVITS_TTS_REPETITION_PENALTY"),
    "GPT_SOVITS_TTS_REPETITION_PENALTY",
    0.1,
    5,
    add
  );
  validateInteger(value("GPT_SOVITS_TTS_SAMPLE_STEPS"), "GPT_SOVITS_TTS_SAMPLE_STEPS", 1, 100, add);
  validateInteger(
    value("GPT_SOVITS_TTS_TIMEOUT_MS"),
    "GPT_SOVITS_TTS_TIMEOUT_MS",
    1000,
    300000,
    add
  );

  return { fieldErrors };
}

export function sanitizeUrlUserinfo(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/^(https?:\/\/)[^/?#@]+@/iu, "$1");
}

export function sanitizeSettingValue(key: string, value: string | undefined): string | undefined {
  return urlKeys.has(key as EditableRuntimeSetting) ? sanitizeUrlUserinfo(value) : value;
}

function validateInteger(
  value: string | undefined,
  key: string,
  minimum: number,
  maximum: number,
  add: (key: string, message: string) => void
): void {
  if (value === undefined || value === "") return;
  if (!/^\d+$/u.test(value)) {
    add(key, `Expected an integer between ${minimum} and ${maximum}.`);
    return;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    add(key, `Expected an integer between ${minimum} and ${maximum}.`);
  }
}

function validateNumber(
  value: string | undefined,
  key: string,
  minimum: number,
  maximum: number,
  add: (key: string, message: string) => void
): void {
  if (value === undefined || value === "") return;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) {
    add(key, `Expected a number between ${minimum} and ${maximum}.`);
    return;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    add(key, `Expected a number between ${minimum} and ${maximum}.`);
  }
}

function isBoolean(value: string): boolean {
  return ["true", "false", "1", "0", "yes", "no", "on", "off"].includes(value.toLowerCase());
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function urlHasCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function normalizeForComparison(key: string, value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (key === "MEMORY_REPOSITORY") {
    return !normalized || normalized.toLowerCase() === "memory"
      ? "in-memory"
      : normalized.toLowerCase();
  }
  if (key === "EVENT_BUS") {
    return !normalized || normalized.toLowerCase() === "memory"
      ? "in-memory"
      : normalized.toLowerCase();
  }
  if (key === "OUTPUT_LANGUAGE") {
    return normalized ? normalized.toUpperCase() : "AUTO";
  }
  if (booleanKeys.has(key as EditableRuntimeSetting)) {
    const truthy = ["true", "1", "yes", "on"].includes(normalized.toLowerCase());
    if (!normalized) {
      return ["MEMORY_VECTOR_INDEX_ENABLED", "YUVI_AUTO_MIGRATE"].includes(key) ? "true" : "false";
    }
    return truthy ? "true" : "false";
  }
  switch (key) {
    case "SERVER_HOST":
      return normalized || "127.0.0.1";
    case "SERVER_PORT":
      return normalized || "6121";
    case "MEMORY_MAINTENANCE_INTERVAL_MINUTES":
      return normalized || "0";
    case "MEMORY_MAINTENANCE_LIMIT":
      return normalized || "500";
    case "MEMORY_VECTOR_INDEX_TYPE":
      return normalized || "hnsw";
    case "MEMORY_VECTOR_DISTANCE":
      return normalized || "cosine";
    default:
      return normalized;
  }
}
