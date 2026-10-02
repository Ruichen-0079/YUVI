import { applyRuntimeEnv, readRuntimeEnvFiles } from "../packages/config/src/index.js";
import {
  MemoryMaintenanceService,
  PostgresProfileLifecycleStore,
  createMemoryRepositoryFromEnv,
  type MemoryMaintenanceOptions,
  type MemoryScope
} from "../packages/memory/src/index.js";

const DEFAULT_LIMIT = 100;

async function main(): Promise<void> {
  await loadRuntimeEnv();
  const options = parseArgs(process.argv.slice(2));
  const repository = createMemoryRepositoryFromEnv(process.env);
  const databaseClient = repository.getDatabaseClient?.();
  if (repository.kind === "postgres" && databaseClient && "connect" in databaseClient) {
    const lifecycleStore = new PostgresProfileLifecycleStore(
      databaseClient as ConstructorParameters<typeof PostgresProfileLifecycleStore>[0]
    );
    repository.setProfileMutationNotifier?.(({ scope, reason }) =>
      lifecycleStore.invalidateScope(scope, reason)
    );
  }
  const service = new MemoryMaintenanceService(repository);

  try {
    console.log(
      `Memory maintenance repository=${repository.kind} dryRun=${String(options.dryRun)} limit=${options.limit ?? DEFAULT_LIMIT}`
    );
    if (options.scope) {
      console.log(`Scope ${options.scope}${options.scopeId ? `:${options.scopeId}` : ""}`);
    }

    const summary = await service.run(options);
    for (const warning of summary.warnings) {
      console.warn(
        `warning kind=${warning.kind} memoryId=${warning.memoryId} relatedId=${warning.relatedId ?? "none"} fixed=${String(Boolean(warning.fixed))}`
      );
    }
    console.log(
      `Summary scanned=${summary.scanned} expired=${summary.expired} stale=${summary.stale} supersessionWarnings=${summary.supersessionWarnings} skipped=${summary.skipped} failed=${summary.failed}`
    );
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await repository.close?.();
  }
}

function parseArgs(args: string[]): MemoryMaintenanceOptions {
  const options: MemoryMaintenanceOptions = {
    dryRun: false,
    limit: DEFAULT_LIMIT
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--include-archived") options.includeArchived = true;
    else if (arg === "--include-superseded") options.includeSuperseded = true;
    else if (arg === "--limit") options.limit = parsePositiveInteger(args[++index], DEFAULT_LIMIT);
    else if (arg.startsWith("--limit=")) {
      options.limit = parsePositiveInteger(arg.slice("--limit=".length), DEFAULT_LIMIT);
    } else if (arg === "--scope") options.scope = parseScope(args[++index]);
    else if (arg.startsWith("--scope=")) options.scope = parseScope(arg.slice("--scope=".length));
    else if (arg === "--scopeId") options.scopeId = args[++index];
    else if (arg.startsWith("--scopeId=")) options.scopeId = arg.slice("--scopeId=".length);
    else if (arg === "--now") options.now = args[++index];
    else if (arg.startsWith("--now=")) options.now = arg.slice("--now=".length);
    else throw new Error(`Unsupported option '${arg}'.`);
  }

  return options;
}

function parseScope(value: string | undefined): MemoryScope {
  if (
    value === "user" ||
    value === "project" ||
    value === "agent" ||
    value === "plugin" ||
    value === "session"
  ) {
    return value;
  }
  throw new Error("Unsupported --scope. Valid values: user, project, agent, plugin, session.");
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadRuntimeEnv(): Promise<void> {
  const runtimeEnvFiles = await readRuntimeEnvFiles();
  applyRuntimeEnv(runtimeEnvFiles.env);
  for (const [label, file] of [
    [".env", runtimeEnvFiles.base],
    [".env.local", runtimeEnvFiles.local]
  ] as const) {
    if (file.exists) {
      console.log(`[env] Loaded ${label}: keys=${Object.keys(file.values).sort().join(",")}`);
    }
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(DATABASE_URL|API_KEY|TOKEN|SECRET|PASSWORD)=([^\s]+)/giu, "$1=[REDACTED]")
    .slice(0, 300);
}

try {
  await main();
} catch (error) {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
}
