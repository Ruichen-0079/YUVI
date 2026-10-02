/**
 * Desktop service orchestration types.
 * Single source of truth for managed Runtime / Mem0 / TTS lifecycle.
 */

export type ServiceId =
  | "runtime"
  | "mem0"
  | "tts_wrapper"
  | "tts_upstream"
  | "ollama"
  | "postgres"
  | "local_stt";

export type ServiceLifecycle =
  | "starting"
  | "healthy"
  | "degraded"
  | "unavailable"
  | "stopped"
  | "restarting";

export type ServiceOwnership = "owned" | "external" | "none";

export type ServiceSnapshot = {
  id: ServiceId;
  label: string;
  status: ServiceLifecycle;
  ownership: ServiceOwnership;
  url: string | null;
  /** Safe, user-facing one-liner. Never secrets. */
  summary: string;
  /** Expandable detail; may include non-secret diagnostics. */
  detail: string | null;
  lastError: string | null;
  pid: number | null;
  startedAt: string | null;
  managed: boolean;
  canRestart: boolean;
  canStop: boolean;
  checkedAt: string;
};

export type LocalSttControlSnapshot = {
  manuallySuspended: boolean;
  activeVoiceLeases: number;
};

export type SupervisorSnapshot = {
  instanceId: string;
  shuttingDown: boolean;
  services: ServiceSnapshot[];
  updatedAt: string;
  postgres?: PostgresDiagnostics | undefined;
  localSttControl?: LocalSttControlSnapshot | undefined;
};

export type LocalSttSuspendOutcome = "STOPPED" | "BUSY" | "RECONCILE_REQUIRED";

export type LocalSttSuspendResult = {
  outcome: LocalSttSuspendOutcome;
  reason:
    | "STOPPED"
    | "LEASE_ACTIVE"
    | "EXTERNAL_PROCESS"
    | "OWNERSHIP_UNCERTAIN"
    | "CONFIG_CHANGED";
  activeVoiceLeases: number;
  snapshot: SupervisorSnapshot;
};

export type PostgresMode = "private" | "external";

export type PostgresDiagnostics = {
  mode: PostgresMode;
  status: string;
  host: string | null;
  port: number | null;
  postgresMajor: number | null;
  clusterId: string | null;
  dataDirectory: string | null;
  dataDirectoryKind: "yuvi-local" | "none";
  initializationState: "missing" | "initializing" | "ready" | "failed" | null;
  ownership: ServiceOwnership;
  distributionError: string | null;
};

export type ProcessMetadata = {
  schemaVersion: 1;
  role: string;
  pid: number;
  repositoryRoot: string;
  stateDirectory: string;
  commandMarker: string;
  processStartedAtUtc: string;
  createdAtUtc: string;
  /** Unique to this YUVI desktop instance — never kill without matching token. */
  ownershipToken: string;
  instanceId: string;
};

export type ProcessInspectionReason =
  | "invalid-pid"
  | "process-not-alive"
  | "query-timeout"
  | "query-failed"
  | "empty-output"
  | "parse-failed";

export type ProcessInspectionResult =
  | {
      status: "resolved";
      processId: number;
      info: ProcessInfo;
    }
  | {
      status: "not-running";
      processId: number;
      reason: "invalid-pid" | "process-not-alive";
    }
  | {
      status: "unavailable";
      processId: number;
      reason: "query-timeout" | "query-failed" | "empty-output" | "parse-failed";
    };

export type OwnershipStatus =
  | "running"
  | "missing"
  | "not-running"
  | "unavailable"
  | "verification-pending"
  | "mismatch"
  | "foreign"
  | "invalid";

export type OwnershipResult = {
  status: OwnershipStatus;
  owned: boolean;
  processId: number;
  message: string;
  metadata: ProcessMetadata | null;
  cleanupAllowed: boolean;
  cleanupReason: string;
  processInspectionStatus: ProcessInspectionResult["status"] | "missing";
  processInspectionReason: string | null;
  processAlive: boolean;
  processInfoComplete: boolean;
  currentChildMatch: boolean;
  metadataSnapshotMatch: boolean;
};

export type ProcessInfo = {
  processId: number;
  parentProcessId: number;
  commandLine: string;
  createdAtUtc: Date | null;
  executablePath?: string | null | undefined;
};

export type HealthProbeResult = {
  warming?: boolean;
  ok: boolean;
  degraded?: boolean;
  statusCode: number | null;
  /** High-level protocol match (expected JSON shape / keyword). */
  protocolOk: boolean;
  message: string;
  latencyMs: number;
};

export type ManagedServiceSpec = {
  id: ServiceId;
  role: string;
  label: string;
  /** When false, only probe — never spawn. */
  managed: boolean;
  /** Prefer connect if already healthy. */
  autostart: boolean;
  healthUrl: string | null;
  /** Optional host:port for TCP-only dependency checks. */
  tcp?: { host: string; port: number } | undefined;
  startTimeoutMs: number;
  readinessIntervalMs: number;
  /** Spawn definition; null means detect-only. */
  startCommand: StartCommandSpec | null;
  metadataFile: string;
  logFile: string;
  /** Optional health body validator. */
  validateHealthBody?: ((body: unknown) => boolean) | undefined;
  /** Optional SQL/process readiness probe. TCP listen alone is not sufficient. */
  readinessCheck?: (() => Promise<boolean>) | undefined;
};

export type StartCommandSpec = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Substring that must appear in the live command line for ownership. */
  commandMarker: string;
};

/**
 * Explicit layout: development uses repo tooling; packaged uses resource tree.
 * Do not fake repositoryRoot to force packaged mode through dev logic.
 */
export type SupervisorLayout =
  | {
      mode: "development";
      repositoryRoot: string;
    }
  | {
      mode: "packaged";
      /** Immutable installation resources (bundled runtimes/models). Never writable state. */
      resourceRoot: string;
      /** User-editable configuration root (AppRoots contract, app-roots.ts). */
      configRoot: string;
      /** Durable user-owned state root; survives cache clears. */
      dataRoot: string;
      /** Rebuildable artifacts root; deletion must not erase durable state. */
      cacheRoot: string;
      runtimeManifestPath: string;
      mem0ManifestPath: string;
    };

export type Mem0Manifest = {
  schemaVersion: 1;
  protocolVersion: 2;
  profileSnapshotMode: "bounded_snapshot";
  platform: "win32" | "linux";
  arch: "x64";
  executable: string;
  healthPath: "/health";
  defaultHost: "127.0.0.1";
  defaultPort: number;
};

export type RuntimeManifest = {
  schemaVersion: 1;
  platform: string;
  arch: string;
  nodeVersion?: string;
  nodeExecutable: string;
  runtimeEntry: string;
};

export type LocalSttManifest = {
  schemaVersion: 1;
  protocolVersion: 1;
  platform: "win32" | "linux";
  arch: "x64";
  executable: string;
  modelDirectory: string;
  modelManifest: string;
  healthPath: "/health";
  defaultHost: "127.0.0.1";
  defaultPort: number;
};

export type SupervisorConfig = {
  layout: SupervisorLayout;
  /**
   * Ownership / metadata root path.
   * Development: repository root. Packaged: resource root.
   */
  repositoryRoot: string;
  stateDirectory: string;
  instanceId: string;
  ownershipToken: string;
  /**
   * High-entropy control-plane token for Supervisor HTTP write ops.
   * Never log or return this in status snapshots.
   */
  controlToken: string;
  controlHost: string;
  controlPort: number;
  env: Record<string, string>;
  memoryBackend: "mem0" | "legacy";
  autostartRuntime: boolean;
  autostartMem0: boolean;
  autostartTts: boolean;
  runtimeUrl: string;
  mem0Url: string;
  ttsWrapperUrl: string;
  ttsUpstreamUrl: string;
  ollamaUrl: string;
  /** Optional local CPU STT sidecar. A start command is required for ownership. */
  localSttUrl?: string | undefined;
  localSttStart?: StartCommandSpec | null | undefined;
  autostartLocalStt?: boolean | undefined;
  databaseUrl: string | null;
  runtimeStart: StartCommandSpec | null;
  mem0Start: StartCommandSpec | null;
  /** Development Mem0 env resolution error (missing/invalid venv); null when OK or N/A. */
  mem0StartError?: string | null | undefined;
  ttsWrapperStart: StartCommandSpec | null;
  ttsUpstreamStart: StartCommandSpec | null;
  postgresMode?: PostgresMode | undefined;
  postgresLayout?: import("./postgres-layout.js").PostgresLayout | null | undefined;
  postgresDistribution?:
    | import("./postgres-distribution.js").PostgresDistribution
    | null
    | undefined;
  postgresStart?: StartCommandSpec | null | undefined;
  postgresDistributionError?: string | null | undefined;
  postgresListenPort?: number | null | undefined;
  postgresSecretAuthority?: "credential-manager" | "development-file" | undefined;
};

/**
 * Runtime config push from Tauri ConfigService.
 * Secrets may appear in `env` for managed services only; never echoed in responses/logs.
 * `unsetEnv` keys must be removed from child process env (not merely left unoverwritten).
 */
export type RuntimeConfigUpdate = {
  env?: Record<string, string> | undefined;
  unsetEnv?: string[] | undefined;
};

/** Redacted ack for POST /v1/config — no secret values. */
export type RuntimeConfigUpdateResult = {
  ok: true;
  appliedEnvKeys: string[];
  unsetEnvKeys: string[];
  /** Services with a background config reconcile scheduled. */
  restartedServices?: string[];
  updatedAt: string;
};

/** Public endpoint file shape (controlToken is present for Rust only; never sent to React). */
export type ControlEndpointFile = {
  host: string;
  port: number;
  baseUrl: string;
  instanceId: string;
  pid: number;
  startedAt: string;
  /** Opaque token; Rust reads this file, React never does. */
  controlToken: string;
};
