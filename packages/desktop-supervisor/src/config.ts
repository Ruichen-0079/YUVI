import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { envFlag, envString, loadYuviEnvFiles, loadYuviRuntimeEnvDir } from "./env.js";
import {
  canonicalPath,
  defaultStateDirectory,
  isWindowsStylePath,
  parseUrlOrigin
} from "./paths.js";
import { defaultYuviLocalDataRoot, resolveAppRoots } from "./app-roots.js";
import { readMem0Manifest, resolveMem0ManifestExecutable } from "./mem0-manifest.js";
import {
  readLocalSttManifest,
  resolveLocalSttManifestExecutable,
  resolveLocalSttManifestPath
} from "./local-stt-manifest.js";
import { readRuntimeManifest, resolveManifestFile } from "./runtime-manifest.js";
import { resolvePostgresDistribution } from "./postgres-distribution.js";
import { resolvePostgresLayout } from "./postgres-layout.js";
import type { PostgresLayout } from "./postgres-layout.js";
import type { PostgresDistribution } from "./postgres-distribution.js";
import type {
  PostgresMode,
  StartCommandSpec,
  SupervisorConfig,
  SupervisorLayout
} from "./types.js";

export type LoadSupervisorConfigInput = {
  repositoryRoot: string;
  stateDirectory?: string | undefined;
  instanceId?: string | undefined;
  ownershipToken?: string | undefined;
  controlToken?: string | undefined;
  controlPort?: number | undefined;
  controlHost?: string | undefined;
};

export type LoadPackagedSupervisorConfigInput = {
  resourceRoot: string;
  dataRoot: string;
  /** Optional AppRoots overrides; defaults resolve via resolveAppRoots(env). */
  configRoot?: string | undefined;
  cacheRoot?: string | undefined;
  runtimeManifestPath?: string | undefined;
  mem0ManifestPath?: string | undefined;
  stateDirectory?: string | undefined;
  instanceId?: string | undefined;
  ownershipToken?: string | undefined;
  controlToken?: string | undefined;
  controlPort?: number | undefined;
  controlHost?: string | undefined;
  /** Optional non-secret public env seed (never load install-dir .env). */
  env?: Record<string, string> | undefined;
};

/** 256-bit hex control token (never log). */
export function generateControlToken(): string {
  return randomBytes(32).toString("hex");
}

export function assertLoopbackHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (normalized !== "127.0.0.1" && normalized !== "localhost" && normalized !== "::1") {
    throw new Error(`Supervisor control plane must bind loopback only (got '${host}').`);
  }
}

export function loadSupervisorConfig(input: LoadSupervisorConfigInput): SupervisorConfig {
  const repositoryRoot = canonicalPath(input.repositoryRoot);
  const env = loadYuviEnvFiles(repositoryRoot);
  const instanceId = input.instanceId ?? randomUUID();
  const ownershipToken = input.ownershipToken ?? randomUUID();
  const controlToken = input.controlToken ?? generateControlToken();
  const stateDirectory = canonicalPath(
    input.stateDirectory ?? path.join(defaultStateDirectory(), instanceId)
  );

  const controlPort = input.controlPort ?? Number(envString(env, "YUVI_SUPERVISOR_PORT", "0"));
  const controlHost = input.controlHost ?? "127.0.0.1";
  assertLoopbackHost(controlHost);

  const layout: SupervisorLayout = { mode: "development", repositoryRoot };
  const derived = deriveConfigFromEnv(layout, env);

  return {
    layout,
    repositoryRoot,
    stateDirectory,
    instanceId,
    ownershipToken,
    controlToken,
    controlHost,
    controlPort: Number.isFinite(controlPort) ? controlPort : 0,
    env,
    ...derived
  };
}

/**
 * Packaged install layout: no repo .env, no PowerShell dev runner, no pnpm/tsx.
 */

function externalPackagedSidecarsEnabled(env: Record<string, string>): boolean {
  const v = env["YUVI_PACKAGED_EXTERNAL_SIDECARS"]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function packagedLocalSttManifestPath(layout: SupervisorLayout): string | null {
  if (layout.mode !== "packaged") return null;
  return path.join(layout.resourceRoot, "local-stt", "local-stt-manifest.json");
}

function packagedLocalSttPresent(layout: SupervisorLayout): boolean {
  const manifestPath = packagedLocalSttManifestPath(layout);
  return Boolean(manifestPath && fs.existsSync(manifestPath));
}

function shouldUsePackagedLocalStt(layout: SupervisorLayout, env: Record<string, string>): boolean {
  if (layout.mode !== "packaged") return false;
  if (!externalPackagedSidecarsEnabled(env)) return true;
  return packagedLocalSttPresent(layout);
}

export function loadPackagedSupervisorConfig(
  input: LoadPackagedSupervisorConfigInput
): SupervisorConfig {
  const resourceRoot = canonicalPath(input.resourceRoot);
  const dataRoot = canonicalPath(input.dataRoot);
  if (!fs.existsSync(resourceRoot)) {
    throw new Error(`Supervisor resource root missing: ${resourceRoot}`);
  }
  const runtimeManifestPath = canonicalPath(
    input.runtimeManifestPath ?? path.join(resourceRoot, "runtime", "runtime-manifest.json")
  );
  // Packaged: process env + optional seed. Never read install-dir / cwd .env.
  // Linux daily may set YUVI_RUNTIME_ENV_DIR to an absolute user config dir
  // (e.g. ~/.config/yuvi-daily); load .env/.env.local from there only.
  const seed: Record<string, string> = { ...(input.env ?? {}) };
  const runtimeEnvDir =
    seed["YUVI_RUNTIME_ENV_DIR"]?.trim() || process.env["YUVI_RUNTIME_ENV_DIR"]?.trim() || "";
  let env: Record<string, string>;
  if (runtimeEnvDir && path.isAbsolute(runtimeEnvDir)) {
    env = loadYuviRuntimeEnvDir(runtimeEnvDir);
    Object.assign(env, seed);
  } else {
    env = { ...seed };
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string" && env[key] === undefined) {
        env[key] = value;
      }
    }
  }
  // Product routes are the activation authority; bundling alone never activates STT.
  const productFile = path.join(runtimeEnvDir || input.configRoot || resolveAppRoots({ env }).configRoot, "product-settings.json");
  if (fs.existsSync(productFile)) {
    const product = JSON.parse(fs.readFileSync(productFile, "utf8"));
    const catalog = product.configuration;
    const localUrl = env["LOCAL_STT_BASE_URL"] || "http://127.0.0.1:9876";
    const assigned = catalog.routes.stt.some((id: string) => {
      const model = catalog.models.find((m: { id: string }) => m.id === id);
      const provider = catalog.providers.find((p: { id: string }) => p.id === model?.providerId);
      return model?.enabled && provider?.adapter === "local-stt" && provider.baseUrl.replace(/\/$/, "") === localUrl;
    });
    env["YUVI_AUTOSTART_LOCAL_STT"] = assigned ? "1" : "0";
  }
  const externalSidecars = externalPackagedSidecarsEnabled(env);
  const mem0ManifestPath = canonicalPath(
    input.mem0ManifestPath?.trim() || path.join(resourceRoot, "mem0", "mem0-manifest.json")
  );
  // Validate early so bootstrap fails with a clear packaging error.
  readRuntimeManifest(runtimeManifestPath);
  if (!externalSidecars) {
    const mem0Manifest = readMem0Manifest(mem0ManifestPath);
    resolveMem0ManifestExecutable(mem0ManifestPath, mem0Manifest);
  }

  const appRoots = resolveAppRoots({ env });
  const configRoot = canonicalPath(input.configRoot ?? appRoots.configRoot);
  const cacheRoot = canonicalPath(input.cacheRoot ?? appRoots.cacheRoot);

  const instanceId = input.instanceId ?? randomUUID();
  const ownershipToken = input.ownershipToken ?? randomUUID();
  const controlToken = input.controlToken ?? generateControlToken();
  const stateDirectory = canonicalPath(
    input.stateDirectory ?? path.join(dataRoot, "instances", instanceId)
  );
  fs.mkdirSync(stateDirectory, { recursive: true });

  const controlPort = input.controlPort ?? Number(envString(env, "YUVI_SUPERVISOR_PORT", "0"));
  const controlHost = input.controlHost ?? "127.0.0.1";
  assertLoopbackHost(controlHost);

  const layout: SupervisorLayout = {
    mode: "packaged",
    resourceRoot,
    configRoot,
    dataRoot,
    cacheRoot,
    runtimeManifestPath,
    mem0ManifestPath
  };
  const derived = deriveConfigFromEnv(layout, env);

  return {
    layout,
    // Ownership root for packaged services is the resource root.
    repositoryRoot: resourceRoot,
    stateDirectory,
    instanceId,
    ownershipToken,
    controlToken,
    controlHost,
    controlPort: Number.isFinite(controlPort) ? controlPort : 0,
    env,
    ...derived
  };
}

/**
 * Recompute URLs, autostart flags, and start-command specs from an env map.
 * Used at bootstrap and when Tauri pushes a runtime config update.
 */
export function deriveConfigFromEnv(
  layoutOrRepoRoot: SupervisorLayout | string,
  env: Record<string, string>
): Pick<
  SupervisorConfig,
  | "memoryBackend"
  | "autostartRuntime"
  | "autostartMem0"
  | "autostartTts"
  | "runtimeUrl"
  | "mem0Url"
  | "ttsWrapperUrl"
  | "ttsUpstreamUrl"
  | "ollamaUrl"
  | "localSttUrl"
  | "localSttStart"
  | "autostartLocalStt"
  | "databaseUrl"
  | "runtimeStart"
  | "mem0Start"
  | "mem0StartError"
  | "ttsWrapperStart"
  | "ttsUpstreamStart"
  | "postgresMode"
  | "postgresLayout"
  | "postgresDistribution"
  | "postgresStart"
  | "postgresDistributionError"
  | "postgresSecretAuthority"
> {
  const layout: SupervisorLayout =
    typeof layoutOrRepoRoot === "string"
      ? { mode: "development", repositoryRoot: layoutOrRepoRoot }
      : layoutOrRepoRoot;

  const runtimeHost = envString(env, "SERVER_HOST", "127.0.0.1");
  const runtimePort = envString(env, "SERVER_PORT", "6121");
  const runtimeUrl = `http://${runtimeHost}:${runtimePort}`;
  const mem0Url = envString(env, "MEM0_BASE_URL", "http://127.0.0.1:6131");
  const ttsWrapperUrl = envString(
    env,
    "LOCAL_TTS_BASE_URL",
    envString(env, "GPT_SOVITS_TTS_BASE_URL", "http://127.0.0.1:9881")
  );
  const ttsUpstreamUrl = envString(env, "GPT_SOVITS_TTS_UPSTREAM_URL", "http://127.0.0.1:9880");
  const ollamaUrl = envString(
    env,
    "MEM0_OLLAMA_BASE_URL",
    envString(env, "OLLAMA_HOST", "http://127.0.0.1:11434")
  );
  const localSttUrl = envString(env, "LOCAL_STT_BASE_URL", "http://127.0.0.1:9876");
  const databaseUrl = env["DATABASE_URL"]?.trim() || null;
  const memoryBackend = envString(env, "MEMORY_BACKEND", "mem0") === "legacy" ? "legacy" : "mem0";

  const ownershipRoot = layout.mode === "development" ? layout.repositoryRoot : layout.resourceRoot;
  const externalSidecars = externalPackagedSidecarsEnabled(env);
  const managedMem0 =
    layout.mode === "packaged" &&
    !externalSidecars &&
    memoryBackend === "mem0" &&
    envFlag(env, "YUVI_AUTOSTART_MEM0", false);

  const postgres = resolvePostgresConfig(layout, env);

  return {
    memoryBackend,
    autostartRuntime: envFlag(env, "YUVI_AUTOSTART_RUNTIME", true),
    autostartMem0:
      layout.mode === "packaged" && !externalSidecars
        ? managedMem0
        : envFlag(env, "YUVI_AUTOSTART_MEM0", memoryBackend === "mem0"),
    autostartTts: envFlag(env, "YUVI_AUTOSTART_TTS", false),
    runtimeUrl,
    mem0Url,
    ttsWrapperUrl,
    ttsUpstreamUrl,
    ollamaUrl,
    localSttUrl,
    localSttStart: shouldUsePackagedLocalStt(layout, env)
      ? resolvePackagedLocalSttStart(
          layout as Extract<SupervisorLayout, { mode: "packaged" }>,
          env,
          localSttUrl
        )
      : resolveOptionalStartCommand(env, "YUVI_LOCAL_STT_START_COMMAND", ownershipRoot),
    autostartLocalStt: envFlag(env, "YUVI_AUTOSTART_LOCAL_STT", false),
    databaseUrl,
    runtimeStart: resolveRuntimeStartForLayout(layout, env, runtimePort),
    ...(() => {
      if (layout.mode === "packaged" && !externalPackagedSidecarsEnabled(env)) {
        return {
          mem0Start: managedMem0 ? resolvePackagedMem0Start(layout, env, mem0Url) : null,
          mem0StartError: null as string | null
        };
      }
      const resolved = resolveMem0StartDetailed(ownershipRoot, env, mem0Url, {
        runDefaultPreflight: env["YUVI_MEM0_SKIP_INTERPRETER_PREFLIGHT"] !== "1"
      });
      return { mem0Start: resolved.start, mem0StartError: resolved.error };
    })(),
    ttsWrapperStart:
      layout.mode === "packaged" && !externalPackagedSidecarsEnabled(env)
        ? null
        : resolveOptionalStartCommand(env, "YUVI_TTS_WRAPPER_START_COMMAND", ownershipRoot),
    ttsUpstreamStart:
      layout.mode === "packaged" && !externalPackagedSidecarsEnabled(env)
        ? null
        : resolveOptionalStartCommand(env, "YUVI_TTS_UPSTREAM_START_COMMAND", ownershipRoot),
    ...postgres
  };
}

export function resolvePostgresMode(
  layout: SupervisorLayout,
  env: Record<string, string>
): PostgresMode {
  const explicit = env["YUVI_POSTGRES_MODE"]?.trim().toLowerCase();
  if (explicit === "external") return "external";
  if (explicit === "private") return "private";
  if (layout.mode === "packaged" && externalPackagedSidecarsEnabled(env)) return "external";
  return layout.mode === "packaged" ? "private" : "external";
}

export function resolvePostgresConfig(
  layout: SupervisorLayout,
  env: Record<string, string>
): {
  postgresMode: PostgresMode;
  postgresLayout: PostgresLayout | null;
  postgresDistribution: PostgresDistribution | null;
  postgresStart: StartCommandSpec | null;
  postgresDistributionError: string | null;
  postgresSecretAuthority: "credential-manager" | "development-file";
} {
  const postgresMode = resolvePostgresMode(layout, env);
  const postgresSecretAuthority =
    layout.mode === "packaged" ? "credential-manager" : "development-file";
  if (postgresMode !== "private") {
    return {
      postgresMode,
      postgresLayout: null,
      postgresDistribution: null,
      postgresStart: null,
      postgresDistributionError: null,
      postgresSecretAuthority
    };
  }

  const bounds = {
    resourceRoot: layout.mode === "packaged" ? layout.resourceRoot : undefined,
    repositoryRoot: layout.mode === "development" ? layout.repositoryRoot : layout.resourceRoot,
    packaged: layout.mode === "packaged"
  };
  let postgresLayout: PostgresLayout | null = null;
  try {
    postgresLayout = resolvePostgresLayout(env, bounds);
  } catch (error) {
    return {
      postgresMode,
      postgresLayout: null,
      postgresDistribution: null,
      postgresStart: null,
      postgresDistributionError:
        error instanceof Error ? error.message : "private PostgreSQL data root is invalid",
      postgresSecretAuthority
    };
  }

  const distribution = resolvePostgresDistribution(env, layout);
  if (!distribution.ok) {
    return {
      postgresMode,
      postgresLayout,
      postgresDistribution: null,
      postgresStart: null,
      postgresDistributionError: distribution.error.message,
      postgresSecretAuthority
    };
  }

  return {
    postgresMode,
    postgresLayout,
    postgresDistribution: distribution.distribution,
    postgresStart: null,
    postgresDistributionError: null,
    postgresSecretAuthority
  };
}

export function resolveRuntimeStartForLayout(
  layout: SupervisorLayout,
  env: Record<string, string>,
  runtimePort: string
): StartCommandSpec | null {
  if (layout.mode === "packaged") {
    return resolvePackagedRuntimeStart(layout, env, runtimePort);
  }
  return resolveRuntimeStart(layout.repositoryRoot, env, runtimePort);
}

/**
 * Resolve Live2D model root + Cubism Core for packaged Runtime.
 *
 * Priority for each path:
 * 1. Explicit env (process / seed / user settings push)
 * 2. Bundled next to resource root (`live2d/`, `cubism-core/live2dcubismcore.min.js`)
 * 3. Standard per-user layout under LOCALAPPDATA/YUVI (matches .env.local convention)
 *
 * Missing assets are omitted (Runtime returns 404 for /live2d/*) — never invent paths.
 */
export function resolvePackagedLive2DEnv(
  layout: Extract<SupervisorLayout, { mode: "packaged" }>,
  env: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};

  const explicitAsset = env["LIVE2D_ASSET_ROOT"]?.trim();
  const explicitCore = env["LIVE2D_CORE_PATH"]?.trim();

  const bundledAsset = path.join(layout.resourceRoot, "live2d");
  const bundledCore = path.join(layout.resourceRoot, "cubism-core", "live2dcubismcore.min.js");

  const localYuvi = defaultYuviLocalDataRoot(process.env);
  const userAsset = path.join(localYuvi, "Live2DModels");
  const userCore = path.join(localYuvi, "CubismCore", "live2dcubismcore.min.js");

  if (explicitAsset) {
    out["LIVE2D_ASSET_ROOT"] = explicitAsset;
  } else if (fs.existsSync(bundledAsset)) {
    out["LIVE2D_ASSET_ROOT"] = bundledAsset;
  } else if (fs.existsSync(userAsset)) {
    out["LIVE2D_ASSET_ROOT"] = userAsset;
  }

  if (explicitCore) {
    out["LIVE2D_CORE_PATH"] = explicitCore;
  } else if (fs.existsSync(bundledCore)) {
    out["LIVE2D_CORE_PATH"] = bundledCore;
  } else if (fs.existsSync(userCore)) {
    out["LIVE2D_CORE_PATH"] = userCore;
  }

  return out;
}

/**
 * Packaged Runtime: bundled node.exe + yuvi-runtime-server.mjs (never PATH node/pnpm/tsx).
 */
export function resolvePackagedRuntimeStart(
  layout: Extract<SupervisorLayout, { mode: "packaged" }>,
  env: Record<string, string>,
  runtimePort: string
): StartCommandSpec | null {
  const manifest = readRuntimeManifest(layout.runtimeManifestPath);
  const runtimeDir = path.dirname(layout.runtimeManifestPath);
  const nodeExe = resolveManifestFile(runtimeDir, manifest.nodeExecutable);
  const entry = resolveManifestFile(runtimeDir, manifest.runtimeEntry);
  if (!fs.existsSync(nodeExe)) {
    throw new Error(`Bundled Node missing: ${nodeExe}`);
  }
  if (!fs.existsSync(entry)) {
    throw new Error(`Runtime entry missing: ${entry}`);
  }
  const dataDir = path.join(layout.dataRoot, "runtime-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const host = envString(env, "SERVER_HOST", "127.0.0.1");
  const live2dEnv = resolvePackagedLive2DEnv(layout, env);
  return {
    file: nodeExe,
    args: [entry],
    cwd: dataDir,
    env: {
      SERVER_HOST: host,
      SERVER_PORT: runtimePort,
      YUVI_RUNTIME_RESOURCE_DIR: layout.resourceRoot,
      YUVI_RUNTIME_DATA_DIR: dataDir,
      YUVI_STT_SPEAKER_DIR: path.join(layout.dataRoot, "local-stt", "speakers"),
      YUVI_RUNTIME_ENV_DIR: env["YUVI_RUNTIME_ENV_DIR"]?.trim() || layout.configRoot,
      YUVI_RUNTIME_MIGRATIONS_DIR: path.join(runtimeDir, "migrations"),
      YUVI_PACKAGED: "1",
      RUNTIME_MODE: "production",
      ...live2dEnv
    },
    // Specific marker — not bare "node.exe".
    commandMarker: "yuvi-runtime-server.mjs"
  };
}

export function resolvePackagedMem0Start(
  layout: Extract<SupervisorLayout, { mode: "packaged" }>,
  env: Record<string, string>,
  mem0Url: string
): StartCommandSpec {
  const manifest = readMem0Manifest(layout.mem0ManifestPath);
  const executable = resolveMem0ManifestExecutable(layout.mem0ManifestPath, manifest);
  const port = resolveManagedLoopbackPort(mem0Url, "MEM0_BASE_URL");
  const resourceDir = canonicalPath(path.dirname(layout.mem0ManifestPath));
  const dataDir = resolvePackagedMem0DataDir(layout, env);
  const logDir = resolvePackagedMem0LogDir(layout, env);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const commandEnv: Record<string, string> = {
    YUVI_MEM0_PACKAGED: "1",
    YUVI_MEM0_RESOURCE_DIR: resourceDir,
    YUVI_MEM0_DATA_DIR: dataDir,
    YUVI_MEM0_LOG_DIR: logDir,
    MEM0_DIR: dataDir,
    MEM0_TELEMETRY: "false",
    MEM0_SIDECAR_HOST: "127.0.0.1",
    MEM0_SIDECAR_PORT: String(port)
  };
  const optionalKeys = [
    "MEM0_OLLAMA_BASE_URL",
    "MEM0_LLM_PROVIDER",
    "MEM0_LLM_MODEL",
    "MEM0_LLM_API_KEY",
    "MEM0_LLM_BASE_URL",
    "MEM0_LLM_TEMPERATURE",
    "MEM0_LLM_TIMEOUT_MS",
    "MEM0_REQUEST_TIMEOUT_MS",
    "MEM0_LOG_CONTENT",
    "MEM0_HEALTH_EMBED_CACHE_TTL_S"
  ];
  for (const key of optionalKeys) {
    const value = env[key]?.trim();
    if (value) commandEnv[key] = value;
  }
  const pgConnection = env["MEM0_PG_CONNECTION_STRING"]?.trim() || env["DATABASE_URL"]?.trim();
  if (pgConnection) commandEnv["MEM0_PG_CONNECTION_STRING"] = pgConnection;

  return {
    file: executable,
    args: [],
    cwd: dataDir,
    env: commandEnv,
    commandMarker: executable
  };
}

export function resolvePackagedLocalSttStart(
  layout: Extract<SupervisorLayout, { mode: "packaged" }>,
  _env: Record<string, string>,
  localSttUrl: string
): StartCommandSpec {
  const manifestPath = path.join(layout.resourceRoot, "local-stt", "local-stt-manifest.json");
  const manifest = readLocalSttManifest(manifestPath);
  const executable = resolveLocalSttManifestExecutable(manifestPath, manifest);
  const modelRoot = resolveLocalSttManifestPath(
    manifestPath,
    manifest.modelDirectory,
    "modelDirectory"
  );
  const modelManifest = resolveLocalSttManifestPath(
    manifestPath,
    manifest.modelManifest,
    "modelManifest"
  );
  if (!fs.existsSync(modelRoot) || !fs.statSync(modelRoot).isDirectory()) {
    throw new Error(`Local STT model directory missing: ${modelRoot}`);
  }
  if (!fs.existsSync(modelManifest) || !fs.statSync(modelManifest).isFile()) {
    throw new Error(`Local STT model manifest missing: ${modelManifest}`);
  }
  const port = resolveManagedLoopbackPort(localSttUrl, "LOCAL_STT_BASE_URL");
  const dataDir = canonicalPath(path.join(layout.dataRoot, "local-stt"));
  const speakerDir = canonicalPath(path.join(dataDir, "speakers"));
  fs.mkdirSync(speakerDir, { recursive: true });
  return {
    file: executable,
    args: [
      "--host",
      manifest.defaultHost,
      "--port",
      String(port),
      "--model-dir",
      modelRoot,
      "--yuvi-local-stt"
    ],
    cwd: path.dirname(manifestPath),
    env: {
      YUVI_LOCAL_STT_PACKAGED: "1",
      YUVI_STT_SPEAKER_DIR: speakerDir
    },
    commandMarker: executable
  };
}

function resolveManagedLoopbackPort(url: string, key: string): number {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${key} must be a valid loopback HTTP URL.`);
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${key} must be a loopback HTTP URL without credentials.`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Managed ${key} must target loopback.`);
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new Error(`${key} must not include a path.`);
  }
  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key} port must be between 1 and 65535.`);
  }
  return port;
}

function resolvePackagedMem0DataDir(
  layout: Extract<SupervisorLayout, { mode: "packaged" }>,
  env: Record<string, string>
): string {
  const explicit = env["YUVI_MEM0_DATA_DIR"]?.trim();
  return explicit
    ? resolveAbsolutePackagedPath(explicit, "YUVI_MEM0_DATA_DIR")
    : canonicalPath(path.join(path.dirname(layout.dataRoot), "Mem0", "data"));
}

function resolvePackagedMem0LogDir(
  layout: Extract<SupervisorLayout, { mode: "packaged" }>,
  env: Record<string, string>
): string {
  const explicit = env["YUVI_MEM0_LOG_DIR"]?.trim();
  return explicit
    ? resolveAbsolutePackagedPath(explicit, "YUVI_MEM0_LOG_DIR")
    : canonicalPath(path.join(path.dirname(layout.dataRoot), "Mem0", "logs"));
}

function resolveAbsolutePackagedPath(value: string, key: string): string {
  if (!path.isAbsolute(value) && !isWindowsStylePath(value)) {
    throw new Error(`${key} must be an absolute path.`);
  }
  return canonicalPath(value);
}

/**
 * Build the env object used for managed child spawn.
 * Typical call: baseEnv + current config overrides, then commandEnv.
 * `unsetKeys` (optional) delete after merge — prefer restoring base fallbacks
 * in the Supervisor rather than permanently stripping shell env.
 */
export function buildChildProcessEnv(
  processEnv: NodeJS.ProcessEnv,
  commandEnv: Record<string, string>,
  unsetKeys: Iterable<string> = []
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...processEnv, ...commandEnv };
  for (const key of unsetKeys) {
    delete env[key];
  }
  return env;
}

export function resolveRuntimeStart(
  repositoryRoot: string,
  env: Record<string, string>,
  runtimePort: string
): StartCommandSpec | null {
  const explicit = resolveOptionalStartCommand(env, "YUVI_RUNTIME_START_COMMAND", repositoryRoot);
  if (explicit) return explicit;

  const isWindows = process.platform === "win32";
  const runnerName = isWindows ? "dev-server-runner.ps1" : "dev-server-runner.sh";
  const runner = path.join(repositoryRoot, "scripts", runnerName);
  if (!fs.existsSync(runner)) return null;
  const shell = isWindows ? "powershell.exe" : "bash";
  return {
    file: shell,
    args: isWindows
      ? [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          runner,
          "-RepoRoot",
          repositoryRoot,
          "-ServerPort",
          runtimePort
        ]
      : [runner, "--repo-root", repositoryRoot, "--server-port", runtimePort],
    cwd: repositoryRoot,
    env: {
      SERVER_PORT: runtimePort,
      YUVI_RUNTIME_ENV_DIR: env["YUVI_RUNTIME_ENV_DIR"]?.trim() || repositoryRoot
    },
    commandMarker: runnerName
  };
}

export const MEM0_DEV_ENV_SETUP_HINT =
  'Create services/memory-mem0/.venv with Python 3.11 and run: pip install -e ".[dev]"';

export type ResolveMem0StartResult = {
  start: StartCommandSpec | null;
  /** Actionable development-env failure; null when start resolved or Mem0 sources absent. */
  error: string | null;
};

export type ResolveMem0StartOptions = {
  /** Override platform detection (tests). */
  platform?: NodeJS.Platform;
  /**
   * Optional interpreter preflight. Return an error message to fail closed.
   * When omitted, `runDefaultPreflight` (default true) validates uvicorn/fastapi imports.
   */
  preflightInterpreter?: ((interpreter: string, sidecarDir: string) => string | null) | undefined;
  /** Set false in unit tests that use stub interpreter files. */
  runDefaultPreflight?: boolean | undefined;
};

/**
 * Resolve the development Mem0 sidecar start command.
 * Prefer an explicit override, then the repo-local venv interpreter.
 * Never fall back to bare `python`/`python3` on PATH.
 */
export function resolveMem0Start(
  repositoryRoot: string,
  env: Record<string, string>,
  mem0Url: string,
  options?: ResolveMem0StartOptions
): StartCommandSpec | null {
  return resolveMem0StartDetailed(repositoryRoot, env, mem0Url, options).start;
}

export function resolveMem0StartDetailed(
  repositoryRoot: string,
  env: Record<string, string>,
  mem0Url: string,
  options: ResolveMem0StartOptions = {}
): ResolveMem0StartResult {
  const explicit = resolveOptionalStartCommand(env, "YUVI_MEM0_START_COMMAND", repositoryRoot);
  if (explicit) {
    // Explicit override wins — do not rewrite or invent another locator.
    return { start: explicit, error: null };
  }

  const sidecarDir = path.join(repositoryRoot, "services", "memory-mem0");
  const srcDir = path.join(sidecarDir, "src");
  if (!fs.existsSync(path.join(srcDir, "yuvi_mem0"))) {
    return { start: null, error: null };
  }

  const platform = options.platform ?? process.platform;
  const interpreter =
    env["YUVI_MEM0_PYTHON"]?.trim() || resolveMem0VenvInterpreter(sidecarDir, platform);
  if (!interpreter) {
    const expected =
      platform === "win32"
        ? path.join("services", "memory-mem0", ".venv", "Scripts", "python.exe")
        : path.join("services", "memory-mem0", ".venv", "bin", "python");
    return {
      start: null,
      error:
        `Mem0 development environment not installed/invalid (missing ${expected}). ` +
        MEM0_DEV_ENV_SETUP_HINT
    };
  }

  const preflight = options.preflightInterpreter;
  if (preflight) {
    const preflightError = preflight(interpreter, sidecarDir);
    if (preflightError) {
      return { start: null, error: preflightError };
    }
  } else if (options.runDefaultPreflight !== false) {
    // Fail closed on broken/incomplete venvs that would otherwise crash-loop.
    const preflightError = defaultMem0InterpreterPreflight(interpreter, sidecarDir);
    if (preflightError) {
      return { start: null, error: preflightError };
    }
  }

  const parsed = parseUrlOrigin(mem0Url);
  const port = parsed?.port ?? 6131;
  const pgConnection = env["MEM0_PG_CONNECTION_STRING"]?.trim() || env["DATABASE_URL"]?.trim();

  return {
    start: {
      file: interpreter,
      args: ["-m", "yuvi_mem0"],
      cwd: sidecarDir,
      env: {
        PYTHONPATH: "src",
        MEM0_SIDECAR_PORT: String(port),
        MEM0_SIDECAR_HOST: "127.0.0.1",
        ...(pgConnection ? { MEM0_PG_CONNECTION_STRING: pgConnection } : {})
      },
      commandMarker: "yuvi_mem0"
    },
    error: null
  };
}

/** Platform-specific repo-local Mem0 venv interpreter; never PATH python. */
export function resolveMem0VenvInterpreter(
  sidecarDir: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const candidates =
    platform === "win32"
      ? [path.join(sidecarDir, ".venv", "Scripts", "python.exe")]
      : [
          path.join(sidecarDir, ".venv", "bin", "python"),
          path.join(sidecarDir, ".venv", "bin", "python3")
        ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore unreadable candidates
    }
  }
  return null;
}

export function defaultMem0InterpreterPreflight(
  interpreter: string,
  sidecarDir: string
): string | null {
  try {
    if (!fs.existsSync(interpreter)) {
      return (
        `Mem0 development environment not installed/invalid (missing interpreter). ` +
        MEM0_DEV_ENV_SETUP_HINT
      );
    }
  } catch {
    return (
      `Mem0 development environment not installed/invalid (unreadable interpreter). ` +
      MEM0_DEV_ENV_SETUP_HINT
    );
  }

  const result = spawnSync(interpreter, ["-c", "import uvicorn, fastapi"], {
    encoding: "utf8",
    timeout: 8_000,
    env: {
      ...process.env,
      PYTHONPATH: path.join(sidecarDir, "src")
    }
  });
  if (result.error) {
    return (
      "Mem0 development environment not installed/invalid (failed to execute interpreter). " +
      MEM0_DEV_ENV_SETUP_HINT
    );
  }
  if (result.status !== 0) {
    const err = `${result.stderr ?? ""}${result.stdout ?? ""}`;
    if (/No module named ['"]?uvicorn['"]?/i.test(err)) {
      return (
        "Mem0 development environment not installed/invalid (No module named 'uvicorn'). " +
        MEM0_DEV_ENV_SETUP_HINT
      );
    }
    return (
      "Mem0 development environment not installed/invalid (dependency import failed). " +
      MEM0_DEV_ENV_SETUP_HINT
    );
  }
  return null;
}

/**
 * Explicit start command format: executable + args separated by spaces.
 * Example: C:\path\python.exe -m alice_wrapper
 * We do not invent model weight paths.
 */
function resolveOptionalStartCommand(
  env: Record<string, string>,
  key: string,
  repositoryRoot: string
): StartCommandSpec | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  const parts = splitCommandLine(raw);
  if (parts.length === 0) return null;
  const file = parts[0]!;
  const args = parts.slice(1);
  return {
    file,
    args,
    cwd: repositoryRoot,
    env: {},
    commandMarker: path.basename(file)
  };
}

function splitCommandLine(input: string): string[] {
  const matches = input.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  return matches.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}
