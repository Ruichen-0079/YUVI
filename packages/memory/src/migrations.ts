import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresPool } from "@companion/database";

export type SqlMigration = {
  name: string;
  sql: string;
};

export class MissingDatabaseUrlError extends Error {
  constructor() {
    super("DATABASE_URL is required to run PostgreSQL migrations.");
    this.name = "MissingDatabaseUrlError";
  }
}

export async function readSqlMigrations(
  migrationsDir = defaultMigrationsDir()
): Promise<SqlMigration[]> {
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql")).sort();

  return Promise.all(
    sqlFiles.map(async (name) => ({
      name,
      sql: await readFile(join(migrationsDir, name), "utf8")
    }))
  );
}

export async function runPostgresMigrations(input: {
  databaseUrl: string;
  migrations?: SqlMigration[] | undefined;
  migrationsDir?: string | undefined;
  logger?: Pick<Console, "log"> | undefined;
  settings?: Record<string, string | undefined> | undefined;
}): Promise<string[]> {
  const migrations = input.migrations ?? (await readSqlMigrations(input.migrationsDir));
  const pool = createPostgresPool(input.databaseUrl, {
    idleTimeoutMillis: 10_000,
    query_timeout: 30_000
  });

  try {
    for (const [key, value] of Object.entries(input.settings ?? {})) {
      if (value !== undefined) {
        await pool.query("select set_config($1, $2, false)", [key, value]);
      }
    }

    for (const migration of migrations) {
      await pool.query(migration.sql);
      input.logger?.log(`Applied migration: ${migration.name}`);
    }

    return migrations.map((migration) => migration.name);
  } finally {
    await pool.end();
  }
}

export function resolveDatabaseUrl(
  env: Record<string, string | undefined>,
  envFileText?: string | undefined
): string {
  const fileEnv = envFileText ? parseDotEnv(envFileText) : {};
  const databaseUrl = env["DATABASE_URL"] ?? fileEnv["DATABASE_URL"];

  if (!databaseUrl?.trim()) {
    throw new MissingDatabaseUrlError();
  }

  return databaseUrl;
}

export function parseDotEnv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripOptionalQuotes(line.slice(separatorIndex + 1).trim());
    parsed[key] = value;
  }

  return parsed;
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../migrations");
}
