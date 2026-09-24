/**
 * Packaged Runtime entry. Loads the server after applying env files from
 * YUVI_RUNTIME_DATA_DIR / YUVI_RUNTIME_ENV_DIR (never install-dir writes).
 */
import { loadServerConfig } from "../apps/server/src/config.ts";
import {
  applyRuntimeEnv,
  getLegacyServerLocalEnvWarning,
  readRuntimeEnvFiles
} from "../apps/server/src/env.ts";
import { buildServer } from "../apps/server/src/server.ts";
import { parseMemoryRepositoryEnv } from "../packages/memory/src/env.ts";
import { readSqlMigrations, runPostgresMigrations } from "../packages/memory/src/migrations.ts";
import { createProviderRegistryFromEnv } from "../packages/providers/src/index.ts";

async function preparePackagedPostgres(): Promise<void> {
  const isPackaged =
    process.env["YUVI_PACKAGED"] === "1" || process.env["YUVI_PACKAGED"] === "true";
  if (!isPackaged) return;

  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (!databaseUrl) {
    if (parseMemoryRepositoryEnv(process.env).kind === "postgres") {
      throw new Error("Packaged PostgreSQL Runtime requires DATABASE_URL.");
    }
    return;
  }
  const migrationsDir = process.env["YUVI_RUNTIME_MIGRATIONS_DIR"]?.trim();
  if (!migrationsDir) {
    throw new Error("Packaged PostgreSQL Runtime migrations directory is not configured.");
  }
  const migrations = await readSqlMigrations(migrationsDir);
  if (migrations.length === 0) {
    throw new Error(`No SQL migration files found in ${migrationsDir}.`);
  }
  const embeddingProvider = createProviderRegistryFromEnv(process.env).getEmbeddingProvider();
  console.info(
    `[postgres] applying ${migrations.length} migration(s); embedding=${embeddingProvider.name} dimensions=${embeddingProvider.dimensions}`
  );
  await runPostgresMigrations({
    databaseUrl,
    migrations,
    settings: {
      "yuvi.memory_vector_index_enabled": process.env["MEMORY_VECTOR_INDEX_ENABLED"] ?? "true",
      "yuvi.memory_vector_index_type": process.env["MEMORY_VECTOR_INDEX_TYPE"] ?? "hnsw",
      "yuvi.memory_vector_distance": process.env["MEMORY_VECTOR_DISTANCE"] ?? "cosine",
      "yuvi.memory_vector_dimensions": String(embeddingProvider.dimensions)
    },
    logger: console
  });
  console.info("[postgres] database schema is ready.");
}

async function main(): Promise<void> {
  const runtimeEnvFiles = await readRuntimeEnvFiles();
  applyRuntimeEnv(runtimeEnvFiles.env);
  console.info("[env] runtimeEnvDir:", runtimeEnvFiles.runtimeEnvDir);
  console.info("[env] .env exists:", runtimeEnvFiles.base.exists);
  console.info("[env] .env.local exists:", runtimeEnvFiles.local.exists);
  console.info("[env] DEEPSEEK_API_KEY configured:", Boolean(process.env["DEEPSEEK_API_KEY"]));
  console.info("[env] DEEPSEEK_CHAT_MODEL:", process.env["DEEPSEEK_CHAT_MODEL"] ?? "");
  console.info("[env] MEMORY_REPOSITORY:", process.env["MEMORY_REPOSITORY"] ?? "in-memory");
  console.info("[env] DATABASE_URL configured:", Boolean(process.env["DATABASE_URL"]));
  console.info("[env] YUVI_PACKAGED:", process.env["YUVI_PACKAGED"] ?? "");

  if (process.env["YUVI_PACKAGED"] !== "1" && process.env["YUVI_PACKAGED"] !== "true") {
    const legacyWarning = await getLegacyServerLocalEnvWarning();
    if (legacyWarning) {
      console.warn("[env]", legacyWarning);
    }
  }

  await preparePackagedPostgres();
  if (process.env["YUVI_PACKAGED_MIGRATE_ONLY"] === "1") {
    console.info("[postgres] packaged migration-only gate completed.");
    return;
  }

  const config = loadServerConfig();
  const app = await buildServer(config);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down server");
    await app.close();
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(
    "[runtime.fatal]",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
