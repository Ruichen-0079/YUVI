import { createHash } from "node:crypto";
import { readSqlMigrations } from "../migrations.js";
import { MemoryAuthorityError, type AuthorityQuery } from "./types.js";
/** Read-only startup gate. Provisioning is a separate operator/migration credential action. */
export async function assertMemoryAuthorityDatabase(
  db: AuthorityQuery,
  requireLeastPrivilege: boolean
) {
  const required = (await readSqlMigrations()).filter(
    (m) =>
      m.name.startsWith("033_") ||
      m.name.startsWith("034_") ||
      m.name.startsWith("035_") ||
      m.name.startsWith("036_") ||
      m.name.startsWith("037_") ||
      m.name.startsWith("038_") ||
      m.name.startsWith("039_") ||
      m.name.startsWith("040_")
  );
  const receipts = (
    await db.query("select name,digest from yuvi_schema_migrations where name=any($1::text[])", [
      required.map((m) => m.name)
    ])
  ).rows;
  if (
    required.length !== 8 ||
    required.some(
      (m) =>
        receipts.find((r) => r["name"] === m.name)?.["digest"] !==
        createHash("sha256").update(m.sql).digest("hex")
    )
  )
    throw new MemoryAuthorityError("MEMORY_AUTHORITY_SCHEMA_NOT_READY");
  const role = (
    await db.query(`select r.rolsuper as superuser,r.rolcreaterole as creates_roles,
   has_schema_privilege(current_schema(),'CREATE') as creates_schema_objects,
   exists(select 1 from pg_class c where c.oid=any(array[to_regclass('memory_authority_records'),to_regclass('memory_authority_relations'),to_regclass('memory_authority_admissions')]) and pg_has_role(c.relowner,'USAGE')) as owns_history,
   exists(select 1 from unnest(array['memory_authority_records','memory_authority_relations','memory_authority_admissions']) t where has_table_privilege(t,'UPDATE') or has_table_privilege(t,'DELETE') or has_table_privilege(t,'TRUNCATE')) as destroys_history,
   (has_table_privilege('retained_observations','DELETE') or has_table_privilege('retained_observations','TRUNCATE') or
    exists(select 1 from unnest(array['namespace','persona_id','person_id','actor_id','source_ref','attempt_id','expires_at','evidence_digest','image_digest','commit_digest']) c
      where has_column_privilege('retained_observations',c,'UPDATE'))) as rewrites_observation_authority,
   (select relkind='v' from pg_class where oid=to_regclass('memory_authority_current')) as active_view
   from pg_roles r where rolname=current_user`)
  ).rows[0];
  if (!role || role["active_view"] !== true)
    throw new MemoryAuthorityError("MEMORY_AUTHORITY_SCHEMA_NOT_READY");
  const restricted =
    !role["superuser"] &&
    !role["creates_roles"] &&
    !role["creates_schema_objects"] &&
    !role["owns_history"] &&
    !role["destroys_history"] &&
    !role["rewrites_observation_authority"];
  if (requireLeastPrivilege && !restricted)
    throw new MemoryAuthorityError("MEMORY_AUTHORITY_APPLICATION_ROLE_REQUIRED");
  return {
    schema: "memory.database-contract.v1" as const,
    schemaReady: true,
    leastPrivilege: restricted
  };
}
