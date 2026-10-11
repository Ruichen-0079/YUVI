import { PostgresMemoryAuthority } from "./store.js";
import type { AuthorityQuery } from "./types.js";

const expectedState = `case
 when r.classification='LEGACY_UNVERIFIED' then 'legacy_unverified'
 when r.event->'lineage'->'authority'->'principal'->>'state' is distinct from 'RESOLVED' or r.event->'lineage'->'authority'->'binding'->>'state' is distinct from 'RESOLVED' or r.event->'lineage'->'authority'->'audience'->>'kind' is distinct from 'PRIVATE' then 'unattributed'
 when exists(select 1 from memory_authority_relations e where e.scope=r.scope and e.to_id=r.id and e.kind='supersedes') then 'superseded'
 when exists(select 1 from memory_authority_relations e where e.scope=r.scope and (e.from_id=r.id or e.to_id=r.id) and e.kind='conflicts') then 'conflicted'
 when exists(select 1 from memory_authority_relations e where e.scope=r.scope and e.from_id=r.id and e.kind='supports') then 'supporting'
 else 'current' end`;
/** Admin-only incremental verification. Normal reads never scan history. */
export async function verifyMemoryProjection(
  db: AuthorityQuery,
  scope: string,
  after = "0",
  limit = 1000
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
    throw new Error("MEMORY_VERIFY_BOUND");
  const rows = await db.query(
    `with batch as (select * from memory_authority_records where scope=$1 and version>$2::bigint order by version limit $3)
    select r.version,r.id,${expectedState} as expected,c.state,
    (c.search is not distinct from to_tsvector('simple',r.search_terms)) as search_matches
    from batch r left join memory_authority_current c using(scope,id) order by r.version`,
    [scope, after, limit]
  );
  return {
    schema: "memory.verify.v1" as const,
    checked: rows.rows.length,
    checkpoint: String(rows.rows.at(-1)?.["version"] ?? after),
    mismatches: rows.rows
      .filter((r) => r["expected"] !== r["state"] || !r["search_matches"])
      .map((r) => ({
        id: String(r["id"]),
        expected: String(r["expected"]),
        actual: r["state"] ?? "MISSING"
      })),
    exhausted: rows.rows.length < limit
  };
}
/** Atomic rebuild: interruption rolls back the entire replacement; authority is untouched.
 * This maintenance operation takes a scope writer lock and can be long at 1M rows.
 */
export async function rebuildMemoryProjection(authority: PostgresMemoryAuthority, scope: string) {
  return authority.transaction(async (tx) => {
    await tx.query("select version from memory_authority_scopes where scope=$1 for update", [
      scope
    ]);
    await tx.query("delete from memory_authority_current where scope=$1", [scope]);
    await tx.query(
      `insert into memory_authority_current(scope,id,version,state,search)
      select r.scope,r.id,r.version,${expectedState},to_tsvector('simple',r.search_terms)
      from memory_authority_records r where r.scope=$1`,
      [scope]
    );
    await tx.query(
      `update memory_authority_scopes set projection_version=version,
      record_count=(select count(*) from memory_authority_records where scope=$1),
      current_count=(select count(*) from memory_authority_current where scope=$1 and state in ('current','conflicted')),
      legacy_count=(select count(*) from memory_authority_current where scope=$1 and state='legacy_unverified'),
      unattributed_count=(select count(*) from memory_authority_current where scope=$1 and state='unattributed') where scope=$1`,
      [scope]
    );
    return { status: "COMMITTED" as const };
  });
}
