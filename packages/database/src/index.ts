import { Pool, type PoolConfig } from "pg";

export type PostgresPool = Pool;

/** Create a PostgreSQL pool while leaving its lifetime with the caller. */
export function createPostgresPool(
  connectionString: string,
  options: Omit<PoolConfig, "connectionString"> = {}
): Pool {
  return new Pool({
    connectionString: normalizePostgresConnectionString(connectionString),
    connectionTimeoutMillis: 10_000,
    ...options
  });
}

export function normalizePostgresConnectionString(
  connectionString: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") {
    return connectionString;
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    url.hostname !== "localhost"
  ) {
    return connectionString;
  }

  url.hostname = "127.0.0.1";
  return url.toString();
}
