import { PostgresMemoryAuthority } from "./store.js";
import { canonicalScope, MemoryAuthorityError, type AuthorityQuery } from "./types.js";
import { expectedState } from "./maintenance.js";
import type { QueryResultRow } from "pg";

const anchorState = expectedState.replaceAll("e.kind=", "e.version<=$3::bigint and e.kind=");
export type ProjectionRebuildState = {
  schema: "memory.rebuild.v1";
  id: string;
  generation: string;
  anchor: string;
  checkpoint: string;
  deltaVersion: string;
  deltaId: string;
  records: string;
  status: string;
  errorCode: string | null;
};
/** Each advance commits both one bounded batch and its checkpoint. The job row lock
 * fences concurrent operators; no external call runs while holding a transaction.
 * Current reads use the active view until an authority-version-fenced pointer swap.
 */
export class MemoryProjectionRebuild {
  constructor(private readonly authority: PostgresMemoryAuthority) {}
  async start(scope: string, id: string, actor: string): Promise<ProjectionRebuildState> {
    canonicalScope(scope);
    if (!id || id.length > 160 || !actor)
      throw new MemoryAuthorityError("MEMORY_REBUILD_ID_INVALID");
    return this.authority.transaction(async (tx) => {
      const scopeRow = (
        await tx.query("select * from memory_authority_scopes where scope=$1 for update", [scope])
      ).rows[0];
      if (!scopeRow) throw new MemoryAuthorityError("MEMORY_REBUILD_SCOPE_MISSING");
      const old = (
        await tx.query("select * from memory_projection_rebuilds where scope=$1 and build_id=$2", [
          scope,
          id
        ])
      ).rows[0];
      if (old) return map(old);
      if (
        (
          await tx.query(
            "select build_id from memory_projection_rebuilds where scope=$1 and status in ('SCANNING','CATCHING_UP','PAUSED')",
            [scope]
          )
        ).rows.length
      )
        throw new MemoryAuthorityError("MEMORY_REBUILD_BUSY");
      await tx.query(
        `insert into memory_projection_rebuilds(scope,build_id,generation,anchor,checkpoint,status,phase,record_count,current_count,legacy_count,unattributed_count,actor)
        values($1,$2,$3,$4,$4,'ACTIVE','CATCHING_UP',$5,$6,$7,$8,'generation-adoption') on conflict do nothing`,
        [
          scope,
          "adopted-generation-" + scopeRow["projection_generation"],
          scopeRow["projection_generation"],
          scopeRow["version"],
          scopeRow["record_count"],
          scopeRow["current_count"],
          scopeRow["legacy_count"],
          scopeRow["unattributed_count"]
        ]
      );
      const row = (
        await tx.query(
          `insert into memory_projection_rebuilds(scope,build_id,generation,anchor,status,actor)
        values($1,$2,$3,$4,'SCANNING',$5) returning *`,
          [scope, id, scopeRow["next_projection_generation"], scopeRow["version"], actor]
        )
      ).rows[0]!;
      await tx.query(
        "update memory_authority_scopes set next_projection_generation=next_projection_generation+1 where scope=$1",
        [scope]
      );
      return map(row);
    });
  }
  async status(scope: string, id: string) {
    canonicalScope(scope);
    const row = (
      await this.authority.pool.query(
        "select * from memory_projection_rebuilds where scope=$1 and build_id=$2",
        [scope, id]
      )
    ).rows[0];
    return row ? map(row) : null;
  }
  async pause(scope: string, id: string, paused: boolean) {
    canonicalScope(scope);
    return this.authority.transaction(async (tx) => {
      // Always scope then job for lifecycle actions/cutover; ordinary batches only lock job.
      await tx.query("select scope from memory_authority_scopes where scope=$1 for update", [
        scope
      ]);
      const row = (
        await tx.query(
          `update memory_projection_rebuilds set status=case when $3 then 'PAUSED' else phase end,updated_at=now()
        where scope=$1 and build_id=$2 and status in ('SCANNING','CATCHING_UP','PAUSED') returning *`,
          [scope, id, paused]
        )
      ).rows[0];
      if (!row) throw new MemoryAuthorityError("MEMORY_REBUILD_NOT_RUNNING");
      return map(row);
    });
  }
  async advance(scope: string, id: string, limit = 200): Promise<ProjectionRebuildState> {
    canonicalScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new MemoryAuthorityError("MEMORY_REBUILD_BOUND");
    const state = await this.authority.transaction(async (tx) => {
      const row = (
        await tx.query(
          "select * from memory_projection_rebuilds where scope=$1 and build_id=$2 for update",
          [scope, id]
        )
      ).rows[0];
      if (!row) throw new MemoryAuthorityError("MEMORY_REBUILD_MISSING");
      if (!["SCANNING", "CATCHING_UP"].includes(String(row["status"]))) return map(row);
      const generation = row["generation"];
      let records: QueryResultRow[], deltaLast: QueryResultRow | undefined;
      if (row["status"] === "SCANNING") {
        records = (
          await tx.query(
            `select r.scope,r.id,r.version,${anchorState} as state,to_tsvector('simple',r.search_terms) as search
          from memory_authority_records r where scope=$1 and version>$2::bigint and version<=$3::bigint order by version limit $4`,
            [scope, row["checkpoint"], row["anchor"], limit]
          )
        ).rows;
      } else {
        const deltas = (
          await tx.query(
            `select version,id from memory_projection_deltas where scope=$1 and build_id=$2 and (version,id)>($3::bigint,$4::text) order by version,id limit $5`,
            [scope, id, row["delta_version"], row["delta_id"], limit]
          )
        ).rows;
        deltaLast = deltas.at(-1);
        const ids = [...new Set(deltas.map((d) => String(d["id"])))];
        records = ids.length
          ? (
              await tx.query(
                `select r.scope,r.id,r.version,${expectedState} as state,to_tsvector('simple',r.search_terms) as search from memory_authority_records r where scope=$1 and id=any($2::text[])`,
                [scope, ids]
              )
            ).rows
          : [];
        if (records.length !== ids.length)
          throw new MemoryAuthorityError("MEMORY_REBUILD_DELTA_SOURCE_MISSING");
      }
      const counts = { record: 0, current: 0, legacy: 0, unattributed: 0 };
      const oldRows = records.length
        ? (
            await tx.query(
              "select id,state from memory_authority_projection_rows where scope=$1 and generation=$2 and id=any($3::text[])",
              [scope, generation, records.map((r) => r["id"])]
            )
          ).rows
        : [];
      const oldStates = new Map(oldRows.map((r) => [String(r["id"]), String(r["state"])]));
      for (const r of records) {
        const old = oldStates.get(String(r["id"]));
        counts.record += old === undefined ? 1 : 0;
        counts.current += current(String(r["state"])) - current(old);
        counts.legacy +=
          Number(r["state"] === "legacy_unverified") - Number(old === "legacy_unverified");
        counts.unattributed +=
          Number(r["state"] === "unattributed") - Number(old === "unattributed");
      }
      if (records.length)
        await tx.query(
          `insert into memory_authority_projection_rows(scope,generation,id,version,state,search)
        select $1,$2,x.id,x.version::bigint,x.state,x.search::tsvector from jsonb_to_recordset($3::jsonb) x(id text,version text,state text,search text)
        on conflict(scope,generation,id) do update set version=excluded.version,state=excluded.state,search=excluded.search`,
          [scope, generation, JSON.stringify(records)]
        );
      const phase =
        row["status"] === "SCANNING" && records.length < limit
          ? "CATCHING_UP"
          : String(row["status"]);
      const updated = (
        await tx.query(
          `update memory_projection_rebuilds set checkpoint=$3,delta_version=$4,delta_id=$5,status=$6,phase=$6,record_count=record_count+$7,current_count=current_count+$8,legacy_count=legacy_count+$9,unattributed_count=unattributed_count+$10,updated_at=now() where scope=$1 and build_id=$2 returning *`,
          [
            scope,
            id,
            row["status"] === "SCANNING"
              ? (records.at(-1)?.["version"] ?? row["checkpoint"])
              : row["checkpoint"],
            deltaLast?.["version"] ?? row["delta_version"],
            deltaLast?.["id"] ?? row["delta_id"],
            phase,
            counts.record,
            counts.current,
            counts.legacy,
            counts.unattributed
          ]
        )
      ).rows[0]!;
      return map(updated);
    });
    // Never acquire scope while retaining job: writers lock scope before delta/job operations.
    if (state.status !== "CATCHING_UP") return state;
    return this.cutover(scope, id);
  }
  private async cutover(scope: string, id: string): Promise<ProjectionRebuildState> {
    return this.authority
      .transaction(async (tx) => {
        await tx.query("set local lock_timeout='250ms'");
        const s = (
          await tx.query("select * from memory_authority_scopes where scope=$1 for update", [scope])
        ).rows[0]!;
        const b = (
          await tx.query(
            "select * from memory_projection_rebuilds where scope=$1 and build_id=$2 for update",
            [scope, id]
          )
        ).rows[0]!;
        if (b["status"] !== "CATCHING_UP") return map(b);
        const pending = (
          await tx.query(
            "select 1 from memory_projection_deltas where scope=$1 and build_id=$2 and (version,id)>($3::bigint,$4::text) limit 1",
            [scope, id, b["delta_version"], b["delta_id"]]
          )
        ).rows.length;
        if (pending) return map(b);
        if (String(b["record_count"]) !== String(s["record_count"])) {
          const failed = (
            await tx.query(
              "update memory_projection_rebuilds set status='FAILED',error_code='MEMORY_REBUILD_COUNT_MISMATCH',updated_at=now() where scope=$1 and build_id=$2 returning *",
              [scope, id]
            )
          ).rows[0]!;
          return map(failed);
        }
        await tx.query(
          `update memory_authority_scopes set projection_generation=$2,projection_version=version,current_count=$3,legacy_count=$4,unattributed_count=$5 where scope=$1`,
          [scope, b["generation"], b["current_count"], b["legacy_count"], b["unattributed_count"]]
        );
        const activated = (
          await tx.query(
            "update memory_projection_rebuilds set status='ACTIVE',updated_at=now() where scope=$1 and build_id=$2 returning *",
            [scope, id]
          )
        ).rows[0]!;
        return map(activated);
      })
      .catch((error) => {
        if ((error as { code?: string }).code === "55P03")
          return this.status(scope, id).then((s) => s!);
        throw error;
      });
  }
  /** Bounded retirement of an inactive generation. It cannot erase authority history. */
  async retire(scope: string, id: string, limit = 200) {
    canonicalScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new MemoryAuthorityError("MEMORY_REBUILD_BOUND");
    return this.authority.transaction(async (tx) => {
      const s = (
        await tx.query(
          "select projection_generation from memory_authority_scopes where scope=$1 for update",
          [scope]
        )
      ).rows[0];
      const b = (
        await tx.query(
          "select * from memory_projection_rebuilds where scope=$1 and build_id=$2 for update",
          [scope, id]
        )
      ).rows[0];
      if (
        !b ||
        String(b["generation"]) === String(s?.["projection_generation"]) ||
        ["SCANNING", "CATCHING_UP", "PAUSED"].includes(String(b["status"]))
      )
        throw new MemoryAuthorityError("MEMORY_REBUILD_RETIRE_FORBIDDEN");
      const deleted = await tx.query(
        `delete from memory_authority_projection_rows where (scope,generation,id) in (select scope,generation,id from memory_authority_projection_rows where scope=$1 and generation=$2 order by id limit $3) returning id`,
        [scope, b["generation"], limit]
      );
      if (deleted.rows.length < limit) {
        await tx.query(
          "delete from memory_projection_deltas where scope=$1 and build_id=$2 and (version,id) in (select version,id from memory_projection_deltas where scope=$1 and build_id=$2 limit $3)",
          [scope, id, limit]
        );
        const remain = (
          await tx.query(
            "select 1 from memory_projection_deltas where scope=$1 and build_id=$2 limit 1",
            [scope, id]
          )
        ).rows.length;
        if (!remain)
          await tx.query(
            "update memory_projection_rebuilds set status='RETIRED',updated_at=now() where scope=$1 and build_id=$2",
            [scope, id]
          );
      }
      return {
        schema: "memory.rebuild.retirement.v1" as const,
        removed: deleted.rows.length,
        status: (await this.read(tx, scope, id)).status
      };
    });
  }
  private async read(tx: AuthorityQuery, scope: string, id: string) {
    return map(
      (
        await tx.query("select * from memory_projection_rebuilds where scope=$1 and build_id=$2", [
          scope,
          id
        ])
      ).rows[0]!
    );
  }
}
function current(state?: string) {
  return Number(state === "current" || state === "conflicted");
}
function map(r: QueryResultRow): ProjectionRebuildState {
  return {
    schema: "memory.rebuild.v1",
    id: String(r["build_id"]),
    generation: String(r["generation"]),
    anchor: String(r["anchor"]),
    checkpoint: String(r["checkpoint"]),
    deltaVersion: String(r["delta_version"]),
    deltaId: String(r["delta_id"]),
    records: String(r["record_count"]),
    status: String(r["status"]),
    errorCode: r["error_code"] as string | null
  };
}
