import { createHash } from "node:crypto";
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
    return await applySqlMigrations(pool, migrations, input.settings, input.logger);
  } finally {
    await pool.end();
  }
}

/** A dedicated connection owns both the schema lock and each SQL+receipt transaction.
 * Old installations without a ledger replay the historical idempotent migrations once.
 * Never edit an applied file: add a new migration instead.
 */
export async function applySqlMigrations(
  pool: ReturnType<typeof createPostgresPool>,
  migrations: SqlMigration[],
  settings: Record<string, string | undefined> = {},
  logger?: Pick<Console, "log">
): Promise<string[]> {
  const client = await pool.connect();
  const ignoreDisconnect = () => {};
  client.on("error", ignoreDisconnect);
  let lock: string | undefined;
  try {
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) await client.query("select set_config($1,$2,false)", [key, value]);
    }
    const schema = (await client.query("select current_schema() as schema")).rows[0]?.["schema"] as
      | string
      | undefined;
    if (!schema) throw Error("MIGRATION_SCHEMA_UNRESOLVED");
    const ledger = '"' + schema.replaceAll('"', '""') + '".yuvi_schema_migrations';
    lock = "yuvi-schema-migrations:" + schema;
    await client.query("select pg_advisory_lock(hashtextextended($1,0))", [lock]);
    await client.query(
      `create table if not exists ${ledger}(name text primary key,digest text not null,applied_at timestamptz not null default now())`
    );
    const applied: string[] = [];
    for (const migration of migrations) {
      const digest = createHash("sha256").update(migration.sql).digest("hex");
      const old = (
        await client.query(`select digest from ${ledger} where name=$1`, [migration.name])
      ).rows[0];
      if (old) {
        if (old["digest"] !== digest) throw Error("MIGRATION_DIGEST_MISMATCH:" + migration.name);
        continue;
      }
      // 010 predates the ledger and owns an outer BEGIN/COMMIT. The runner now owns it.
      const sql =
        migration.name === "010_embedding_mrl_512_v1.sql"
          ? migration.sql.replace(/^begin;\s*$/im, "").replace(/^commit;\s*$/im, "")
          : migration.sql;
      if (/^(?:begin|commit|rollback)\s*;/im.test(sql))
        throw Error("MIGRATION_TRANSACTION_CONTROL_UNSUPPORTED:" + migration.name);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into ${ledger}(name,digest) values($1,$2)`, [
          migration.name,
          digest
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
      applied.push(migration.name);
      logger?.log(`Applied migration: ${migration.name}`);
    }
    return applied;
  } finally {
    if (lock)
      await client
        .query("select pg_advisory_unlock(hashtextextended($1,0))", [lock])
        .catch(() => {});
    client.off("error", ignoreDisconnect);
    client.release();
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
  // Bundled Runtime has no monorepo module layout. Its authenticated packaged
  // bootstrap selects the immutable SQL directory used by both migration and
  // the read-only Authority digest gate.
  return process.env["YUVI_RUNTIME_MIGRATIONS_DIR"]?.trim() ||
    join(dirname(fileURLToPath(import.meta.url)), "../migrations");
}
