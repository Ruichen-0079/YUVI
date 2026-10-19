import { createHmac } from "node:crypto";
import { createPostgresPool } from "@companion/database";
import { assertMemoryAuthorityDatabase } from "./database-contract.js";

/** Managed private cluster only. Migrations retain their owner credential;
 * the running product uses the same restricted SQL contract as R5 acceptance. */
export async function provisionPrivateRuntimeRole(ownerUrl: string): Promise<string> {
  const url = new URL(ownerUrl);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username !== "yuvi" || url.pathname !== "/yuvi" || !url.password || url.search
  ) throw Error("PRIVATE_RUNTIME_DATABASE_BINDING_INVALID");
  const password = createHmac("sha256", decodeURIComponent(url.password))
    .update("yuvi.private-runtime-role.v1").digest("hex");
  const owner = createPostgresPool(ownerUrl);
  const connection = await owner.connect();
  try {
    await connection.query("begin");
    await connection.query("select pg_advisory_xact_lock(hashtextextended('yuvi.private-runtime-role.v1',0))");
    const existing = (await connection.query("select oid from pg_roles where rolname='yuvi_runtime'")).rows[0];
    if (!existing) await connection.query("create role yuvi_runtime login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls");
    const membership = await connection.query("select 1 from pg_auth_members where member=(select oid from pg_roles where rolname='yuvi_runtime')");
    if (membership.rows.length) throw Error("PRIVATE_RUNTIME_ROLE_HAS_MEMBERSHIP");
    await connection.query(`alter role yuvi_runtime with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password '${password}'`);
    await connection.query("revoke create on schema public from public");
    await connection.query("grant connect on database yuvi to yuvi_runtime");
    await connection.query("grant usage on schema public to yuvi_runtime");
    await connection.query("grant select on all tables in schema public to yuvi_runtime");
    // Views remain read-only; write permissions belong to their explicit tables.
    const tables = await connection.query("select quote_ident(relname) as name from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')");
    for (const table of tables.rows) {
      await connection.query(`grant insert,update,delete on public.${table["name"]} to yuvi_runtime`);
    }
    await connection.query("grant usage,select on all sequences in schema public to yuvi_runtime");
    await connection.query("revoke truncate on all tables in schema public from yuvi_runtime");
    await connection.query("revoke update,delete on memory_authority_records,memory_authority_relations,memory_authority_admissions,context_use_manifests,context_use_exposures,journal_events,journal_event_parents,retained_observations from yuvi_runtime");
    await connection.query("grant update(evidence,image_bytes,erased_at,erased_by_source) on retained_observations to yuvi_runtime");
    await connection.query("revoke insert,update,delete on yuvi_schema_migrations from yuvi_runtime");
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback").catch(() => {});
    throw error;
  } finally {
    connection.release();
    await owner.end();
  }
  url.username = "yuvi_runtime";
  url.password = password;
  const application = createPostgresPool(url.toString());
  try { await assertMemoryAuthorityDatabase(application, true); }
  finally { await application.end(); }
  return url.toString();
}
