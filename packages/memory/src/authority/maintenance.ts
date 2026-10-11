import { PostgresMemoryAuthority } from "./store.js";
import type { AuthorityQuery } from "./types.js";

export const expectedState = `case
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
/** Compatibility maintenance entry point. Uses the resumable production rebuild.
 * Operators normally advance bounded batches through the operations API.
 */
export async function rebuildMemoryProjection(authority: PostgresMemoryAuthority, scope: string) {
  const { MemoryProjectionRebuild } = await import("./projection-rebuild.js");
  const rebuild = new MemoryProjectionRebuild(authority);
  const id = "mpr_" + crypto.randomUUID();
  await rebuild.start(scope, id, "host-maintenance");
  for (;;) {
    const result = await rebuild.advance(scope, id, 1000);
    if (result.status === "ACTIVE") return { status: "COMMITTED" as const };
    if (result.status !== "SCANNING" && result.status !== "CATCHING_UP")
      throw Error(result.errorCode ?? "MEMORY_REBUILD_INCOMPLETE");
  }
}
