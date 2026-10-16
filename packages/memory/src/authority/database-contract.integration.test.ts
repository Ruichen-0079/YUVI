import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readSqlMigrations, applySqlMigrations } from "../migrations.js";
import { assertMemoryAuthorityDatabase } from "./database-contract.js";
import { PostgresMemoryAuthority } from "./store.js";
import { MemoryProjectionRebuild } from "./projection-rebuild.js";
import { buildMemoryScope } from "../scope.js";
const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
describe.skipIf(!url)("Authority application role database enforcement", () => {
  const admin = new pg.Pool({ connectionString: url });
  const role = "r5p2_app_" + randomUUID().replaceAll("-", "");
  const app = new pg.Pool({ connectionString: url, max: 1, options: `-c role=${role}` });
  beforeAll(async () => {
    await applySqlMigrations(admin, await readSqlMigrations());
    await admin.query(`create role ${role} nologin nosuperuser nocreatedb nocreaterole`);
    await admin.query(`grant usage on schema public to ${role}`);
    await admin.query(
      `grant select,insert,update,delete on all tables in schema public to ${role}`
    );
    await admin.query(`grant usage,select on all sequences in schema public to ${role}`);
    await admin.query(`revoke update,delete on retained_observations from ${role}`);
    await admin.query(
      `grant update(evidence,image_bytes,erased_at,erased_by_source) on retained_observations to ${role}`
    );

    await admin.query(`revoke truncate on all tables in schema public from ${role}`);
    await admin.query(
      `revoke update,delete on memory_authority_records,memory_authority_relations,memory_authority_admissions,context_use_manifests,context_use_exposures,journal_events,journal_event_parents from ${role}`
    );
    await admin.query(`revoke insert,update,delete on yuvi_schema_migrations from ${role}`);
    await app.query(`set role ${role}`);
  });
  afterAll(async () => {
    await app.end();
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role ${role}`);
    await admin.end();
  });
  it("supports real Authority commits and shadow cutover while rejecting history edits, schema changes and receipt forgery", async () => {
    expect(await assertMemoryAuthorityDatabase(app, true)).toMatchObject({
      schemaReady: true,
      leastPrivilege: true
    });
    const authority = new PostgresMemoryAuthority(app),
      scope = buildMemoryScope(randomUUID(), "restricted-role");
    await authority.importLegacy({
      scope,
      source: "isolated-fixture",
      sourceId: "one",
      event: {
        id: "one",
        source: "legacy",
        sourceRecordId: "one",
        scope,
        kind: "fact",
        content: "Retained role fixture",
        recordedAt: "2026-10-01T00:00:00Z",
        metadata: {}
      }
    });
    const rebuild = new MemoryProjectionRebuild(authority),
      id = randomUUID();
    await rebuild.start(scope, id, "operator");
    let state = await rebuild.status(scope, id);
    for (let n = 0; n < 10 && state?.status !== "ACTIVE"; n++)
      state = await rebuild.advance(scope, id, 100);
    expect(state?.status).toBe("ACTIVE");
    for (const sql of [
      "update memory_authority_records set digest=digest",
      "delete from memory_authority_records",
      "truncate memory_authority_records",
      "create table forbidden_ddl(x int)",
      "update yuvi_schema_migrations set digest=digest",
      "delete from retained_observations where false",
      "update retained_observations set actor_id='forged' where false",
      "update retained_observations set expires_at=now() where false"
    ])
      await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
    expect(
      (await app.query("select count(*) from memory_authority_records where scope=$1", [scope]))
        .rows[0]!.count
    ).toBe("1");
  });
  it("refuses a missing or mismatched required schema receipt", async () => {
    const db = {
      async query(sql: string, params?: unknown[]) {
        const result = await app.query(sql, params);
        if (sql.includes("select name,digest"))
          result.rows = result.rows.filter((r) => !r.name.startsWith("035_"));
        return result;
      }
    };
    await expect(assertMemoryAuthorityDatabase(db, true)).rejects.toThrow(
      "MEMORY_AUTHORITY_SCHEMA_NOT_READY"
    );
  });
});
