import {
  DEFAULT_COGNITION_LIMITS,
  MAX_COGNITION_LIMITS,
  type RuntimeCognitionLimits
} from "@companion/core";

export type ServerConfig = {
  cognitionInteraction: RuntimeCognitionLimits;
  host: string;
  port: number;
  logLevel: string;
  runtimeMode: "development" | "test" | "production";
  eventBus: "in-memory" | "nats";
  memoryExtractor: "rule-based" | "llm";
  directContext: {
    enabled: boolean;
    maxTurns: number;
    maxChars: number;
  };
  memoryMaintenance: {
    enabled: boolean;
    runOnStartup: boolean;
    intervalMinutes: number;
    limit: number;
  };
  memoryIngestion: {
    enabled: boolean;
    pollIntervalMs: number;
    concurrency: number;
    leaseSeconds: number;
    scanLimit: number;
    retryInitialDelayMs: number;
    retryMaxDelayMs: number;
    retryMultiplier: number;
    maxDeliveryAttempts: number;
    missingAdmissionEnabled: boolean;
  };
  memoryVectorIndex: {
    enabled: boolean;
    type: "hnsw" | "ivfflat" | "none";
    distance: "cosine";
    ivfflatProbes?: number | undefined;
    hnswEfSearch?: number | undefined;
  };
  devSupervisor: {
    active: boolean;
    autoMigrate: boolean;
    restartMarkerPath?: string | undefined;
  };
  dashboardDevToken?: string | undefined;
  live2dModelsRoot?: string | undefined;
  live2dAssetRoot?: string | undefined;
  live2dCorePath?: string | undefined;
};

export function loadServerConfig(
  env: Record<string, string | undefined> = process.env
): ServerConfig {
  return {
    cognitionInteraction: {
      maxReasoningRounds: cognitionLimit(
        env["COGNITION_MAX_REASONING_ROUNDS"],
        "maxReasoningRounds"
      ),
      maxCapabilityCalls: cognitionLimit(
        env["COGNITION_MAX_CAPABILITY_CALLS"],
        "maxCapabilityCalls"
      ),
      timeBudgetMs: cognitionLimit(env["COGNITION_TIME_BUDGET_MS"], "timeBudgetMs")
    },
    host: env["SERVER_HOST"] ?? "127.0.0.1",
    port: Number.parseInt(env["SERVER_PORT"] ?? "6121", 10),
    logLevel: env["LOG_LEVEL"] ?? "info",
    runtimeMode: parseRuntimeMode(env["RUNTIME_MODE"] ?? env["NODE_ENV"]),
    eventBus: parseEventBus(env["EVENT_BUS"] ?? env["EVENT_BUS_DRIVER"]),
    memoryExtractor: parseMemoryExtractor(env["MEMORY_EXTRACTOR"]),
    directContext: {
      enabled: parseBoolean(env["DIRECT_CONTEXT_ENABLED"], true),
      maxTurns: parsePositiveInteger(env["DIRECT_CONTEXT_MAX_TURNS"], 6),
      maxChars: parsePositiveInteger(env["DIRECT_CONTEXT_MAX_CHARS"], 6000)
    },
    memoryMaintenance: {
      enabled: parseBoolean(env["MEMORY_MAINTENANCE_ENABLED"], false),
      runOnStartup: parseBoolean(env["MEMORY_MAINTENANCE_RUN_ON_STARTUP"], false),
      intervalMinutes: parsePositiveInteger(env["MEMORY_MAINTENANCE_INTERVAL_MINUTES"], 0),
      limit: parseStrictPositiveInteger(env["MEMORY_MAINTENANCE_LIMIT"], 500)
    },
    memoryIngestion: {
      enabled: parseBoolean(env["MEMORY_INGESTION_COORDINATOR_ENABLED"], true),
      pollIntervalMs: parseStrictPositiveInteger(env["MEMORY_INGESTION_POLL_INTERVAL_MS"], 15_000),
      concurrency: parseStrictPositiveInteger(env["MEMORY_INGESTION_CONCURRENCY"], 4),
      leaseSeconds: parseStrictPositiveInteger(env["MEMORY_INGESTION_LEASE_SECONDS"], 300),
      scanLimit: parseStrictPositiveInteger(env["MEMORY_INGESTION_SCAN_LIMIT"], 50),
      retryInitialDelayMs: parseStrictPositiveInteger(
        env["MEMORY_INGESTION_RETRY_INITIAL_MS"],
        5_000
      ),
      retryMaxDelayMs: parseStrictPositiveInteger(env["MEMORY_INGESTION_RETRY_MAX_MS"], 300_000),
      retryMultiplier: parseStrictPositiveInteger(env["MEMORY_INGESTION_RETRY_MULTIPLIER"], 2),
      maxDeliveryAttempts: parseStrictPositiveInteger(
        env["MEMORY_INGESTION_MAX_DELIVERY_ATTEMPTS"],
        8
      ),
      missingAdmissionEnabled: parseBoolean(env["MEMORY_INGESTION_MISSING_ADMISSION_ENABLED"], true)
    },
    memoryVectorIndex: {
      enabled: parseBoolean(env["MEMORY_VECTOR_INDEX_ENABLED"], true),
      type: parseVectorIndexType(env["MEMORY_VECTOR_INDEX_TYPE"]),
      distance: parseVectorDistance(env["MEMORY_VECTOR_DISTANCE"]),
      ivfflatProbes: parseOptionalStrictPositiveInteger(env["MEMORY_VECTOR_IVFFLAT_PROBES"]),
      hnswEfSearch: parseOptionalStrictPositiveInteger(env["MEMORY_VECTOR_HNSW_EF_SEARCH"])
    },
    devSupervisor: {
      active: parseBoolean(env["YUVI_DEV_SUPERVISOR"], false),
      autoMigrate: env["YUVI_AUTO_MIGRATE"] !== "0",
      restartMarkerPath: emptyToUndefined(env["YUVI_RESTART_MARKER"])
    },
    dashboardDevToken: emptyToUndefined(env["DASHBOARD_DEV_TOKEN"]),
    live2dAssetRoot: emptyToUndefined(env["LIVE2D_ASSET_ROOT"]),
    live2dCorePath: emptyToUndefined(env["LIVE2D_CORE_PATH"])
  };
}

function cognitionLimit(value: string | undefined, key: keyof RuntimeCognitionLimits): number {
  if (value === undefined) return DEFAULT_COGNITION_LIMITS[key];
  const parsed = Number(value);
  if (
    !value.trim() ||
    !Number.isSafeInteger(parsed) ||
    parsed < (key === "maxCapabilityCalls" ? 0 : 1) ||
    parsed > MAX_COGNITION_LIMITS[key]
  )
    throw new Error(`Invalid Cognition limit: ${key}`);
  return parsed;
}

function parseRuntimeMode(value: string | undefined): "development" | "test" | "production" {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }

  return "development";
}

function parseEventBus(value: string | undefined): "in-memory" | "nats" {
  if (!value || value === "in-memory" || value === "memory") {
    return "in-memory";
  }
  if (value === "nats") {
    return "nats";
  }

  throw new Error(`Unsupported EVENT_BUS '${value}'. Supported values: in-memory, nats.`);
}

function parseMemoryExtractor(value: string | undefined): "rule-based" | "llm" {
  if (value === "llm") {
    return "llm";
  }
  if (!value || value === "rule-based") {
    return "rule-based";
  }

  throw new Error(`Unsupported MEMORY_EXTRACTOR '${value}'. Supported values: rule-based, llm.`);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1" || value === "yes";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseStrictPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalStrictPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseVectorIndexType(value: string | undefined): "hnsw" | "ivfflat" | "none" {
  if (!value || value === "hnsw") {
    return "hnsw";
  }
  if (value === "ivfflat" || value === "none") {
    return value;
  }
  throw new Error(
    `Unsupported MEMORY_VECTOR_INDEX_TYPE '${value}'. Supported values: hnsw, ivfflat, none.`
  );
}

function parseVectorDistance(value: string | undefined): "cosine" {
  if (!value || value === "cosine") {
    return "cosine";
  }
  throw new Error(`Unsupported MEMORY_VECTOR_DISTANCE '${value}'. Supported value: cosine.`);
}
