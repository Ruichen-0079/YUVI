import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { applySqlMigrations } from "./migrations.js";
const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
describe.skipIf(!url)("Durable migration ledger on PostgreSQL", () => {
  const schema = "r5_migration_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({
    connectionString: url,
    options: "-c search_path=" + schema + ",public",
    max: 4
  });
  beforeAll(() => admin.query(`create schema ${schema}`));
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  const migrations = [
    {
      name: "synthetic-001.sql",
      sql: "create table ledger_probe(id int primary key); insert into ledger_probe values(1);"
    }
  ];
  it("serializes simultaneous migrators, commits SQL+digest together and resumes without reapplying", async () => {
    const results = await Promise.all([
      applySqlMigrations(pool, migrations),
      applySqlMigrations(pool, migrations)
    ]);
    expect(results.flat()).toEqual(["synthetic-001.sql"]);
    expect((await pool.query("select count(*) from ledger_probe")).rows[0].count).toBe("1");
    expect(await applySqlMigrations(pool, migrations)).toEqual([]);
    await expect(
      applySqlMigrations(pool, [{ ...migrations[0]!, sql: "drop table ledger_probe" }])
    ).rejects.toThrow("MIGRATION_DIGEST_MISMATCH");
    expect((await pool.query("select count(*) from ledger_probe")).rows[0].count).toBe("1");
  });
  it("rolls back intermediate DDL/data and leaves no success receipt for a failed migration", async () => {
    await expect(
      applySqlMigrations(pool, [
        {
          name: "synthetic-002.sql",
          sql: "create table rolled_back(id int); insert into ledger_probe values(1);"
        }
      ])
    ).rejects.toThrow();
    expect(
      (await pool.query("select to_regclass($1) as t", [schema + ".rolled_back"])).rows[0].t
    ).toBeNull();
    expect(
      (await pool.query("select name from yuvi_schema_migrations where name='synthetic-002.sql'"))
        .rows
    ).toHaveLength(0);
    expect(
      await applySqlMigrations(pool, [
        {
          name: "synthetic-002.sql",
          sql: "create table rolled_back(id int); insert into ledger_probe values(2);"
        }
      ])
    ).toEqual(["synthetic-002.sql"]);
  });
  it("rejects transaction-control escape rather than recording a falsely atomic migration", async () => {
    await expect(
      applySqlMigrations(pool, [
        { name: "synthetic-003.sql", sql: "commit;\ncreate table unsafe(id int);" }
      ])
    ).rejects.toThrow("MIGRATION_TRANSACTION_CONTROL_UNSUPPORTED");
  });
});
