import type { QueryResultRow } from "pg";
import type { MemoryEvent } from "../provider.js";
import { canonicalLineageJson, lineageDigest } from "../lineage-encoding.js";
import { canonicalScope, MemoryAuthorityError, type AuthorityQuery } from "./types.js";
import { PostgresMemoryAuthority } from "./store.js";

const emptyDigest = lineageDigest("YUVI_LEGACY_COPY_V1");
const chain = (prior: string, id: string, digest: string) =>
  lineageDigest(canonicalLineageJson([prior, id, digest]));
const sourceName = (id: string) => `postgres-offline-copy:${id}`;
const digest = (payload: unknown) => lineageDigest(canonicalLineageJson(payload));
/** Operator-only, explicitly bound offline copy. No automatic promotion, source rewrite or live cutover.
 * Each bounded batch and its checkpoint/receipt share one Authority transaction. Historical payloads
 * and old correction metadata are retained without pretending their relationships were grounded.
 */
export class MemoryLegacyWorkflow {
  constructor(private readonly authority: PostgresMemoryAuthority) {}
  async prepare(input: {
    id: string;
    scope: string;
    legacyPerson: string;
    legacyPersona: string;
    actor: string;
  }) {
    canonicalScope(input.scope);
    for (const value of [input.id, input.actor, input.legacyPerson, input.legacyPersona])
      if (!value || value.length > 200)
        throw new MemoryAuthorityError("MEMORY_MIGRATION_IDENTITY_INVALID");
    if (
      ["default-user", "default-persona", "unknown", "anonymous"].includes(input.legacyPerson) ||
      ["default-persona", "unknown"].includes(input.legacyPersona)
    )
      throw new MemoryAuthorityError("MEMORY_MIGRATION_IDENTITY_UNVERIFIED");
    return this.authority.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        "legacy-copy:" + input.id
      ]);
      const old = (
        await tx.query("select * from memory_legacy_workflows where migration_id=$1", [input.id])
      ).rows[0];
      if (old) {
        if (
          old["scope"] !== input.scope ||
          old["legacy_person"] !== input.legacyPerson ||
          old["legacy_persona"] !== input.legacyPersona ||
          old["actor"] !== input.actor
        )
          throw new MemoryAuthorityError("MEMORY_MIGRATION_IDENTITY_CONFLICT");
        return view(old);
      }
      const anchor = (await tx.query("select transaction_timestamp() as t")).rows[0]!["t"];
      const count = (
        await tx.query(
          "select count(*) from memories where subject_user_id=$1 and persona_id=$2 and created_at<=$3",
          [input.legacyPerson, input.legacyPersona, anchor]
        )
      ).rows[0]!["count"];
      const row = (
        await tx.query(
          `insert into memory_legacy_workflows(migration_id,scope,source_kind,legacy_person,legacy_persona,actor,status,anchor,expected_count,snapshot_digest,verify_digest)
      values($1,$2,'POSTGRES_LEGACY_COPY',$3,$4,$5,'SNAPSHOTTING',$6,$7,$8,$8) returning *`,
          [
            input.id,
            input.scope,
            input.legacyPerson,
            input.legacyPersona,
            input.actor,
            anchor,
            count,
            emptyDigest
          ]
        )
      ).rows[0]!;
      await action(tx, row, input.actor, "PREPARE", null);
      return view(row);
    });
  }
  async status(scope: string, id: string) {
    canonicalScope(scope);
    const row = (
      await this.authority.pool.query(
        "select * from memory_legacy_workflows where scope=$1 and migration_id=$2",
        [scope, id]
      )
    ).rows[0];
    return row ? view(row) : null;
  }
  async pause(scope: string, id: string, actor: string, paused: boolean) {
    return this.authority.transaction(async (tx) => {
      const row = await lock(tx, scope, id);
      const previous = String(row["status"]);
      if (paused && ["SNAPSHOTTING", "IMPORTING", "VERIFYING"].includes(previous))
        await tx.query(
          "update memory_legacy_workflows set resume_status=status,status='PAUSED',updated_at=now() where migration_id=$1",
          [id]
        );
      else if (!paused && previous === "PAUSED")
        await tx.query(
          "update memory_legacy_workflows set status=resume_status,resume_status=null,updated_at=now() where migration_id=$1",
          [id]
        );
      const next = (
        await tx.query("select * from memory_legacy_workflows where migration_id=$1", [id])
      ).rows[0]!;
      await action(tx, next, actor, paused ? "PAUSE" : "RESUME", previous);
      return view(next);
    });
  }
  async advance(scope: string, id: string, actor: string, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new MemoryAuthorityError("MEMORY_MIGRATION_BATCH_BOUND");
    return this.authority.transaction(async (tx) => {
      const row = await lock(tx, scope, id),
        phase = String(row["status"]);
      if (!["SNAPSHOTTING", "IMPORTING", "VERIFYING"].includes(phase)) return view(row);
      const sources = (
        await tx.query(
          `select to_jsonb(m)-'embedding'-'content_tsv' as payload from memories m
       where subject_user_id=$1 and persona_id=$2 and created_at<=$3 and ($4::uuid is null or id>$4) order by id limit $5`,
          [row["legacy_person"], row["legacy_persona"], row["anchor"], row["checkpoint"], limit + 1]
        )
      ).rows;
      // Import consumes the immutable staged copy, not the mutable source.
      const items =
        phase === "IMPORTING"
          ? (
              await tx.query(
                "select * from memory_legacy_workflow_items where migration_id=$1 and ($2::uuid is null or source_id>$2) order by source_id limit $3",
                [id, row["checkpoint"], limit + 1]
              )
            ).rows
          : sources;
      let checkpoint = row["checkpoint"],
        rolling = String(phase === "VERIFYING" ? row["verify_digest"] : row["snapshot_digest"]),
        count = 0;
      for (const item of items.slice(0, limit)) {
        if (phase === "IMPORTING") {
          const payload = item["source_payload"] as QueryResultRow;
          const event = legacyEvent(payload, scope);
          if (digest(payload) !== item["source_digest"])
            throw new MemoryAuthorityError("MEMORY_MIGRATION_STAGE_DIGEST_INVALID");
          await this.authority.importLegacy(
            { scope, source: sourceName(id), sourceId: String(item["source_id"]), event },
            tx
          );
          const record = (
            await tx.query(
              "select id,digest from memory_authority_records where scope=$1 and logical_key=$2",
              [scope, `legacy:${sourceName(id)}:${item["source_id"]}`]
            )
          ).rows[0];
          if (!record || record["digest"] !== digest(event))
            throw new MemoryAuthorityError("MEMORY_MIGRATION_TARGET_DIGEST_INVALID");
          await tx.query(
            "update memory_legacy_workflow_items set target_id=$3,imported_at=coalesce(imported_at,now()) where migration_id=$1 and source_id=$2",
            [id, item["source_id"], record["id"]]
          );
          checkpoint = item["source_id"];
        } else {
          const payload = item["payload"] as QueryResultRow,
            sourceId = String(payload["id"]),
            hash = digest(payload);
          if (
            Date.parse(String(payload["updated_at"])) > new Date(row["anchor"] as string).getTime()
          )
            return await changed(tx, row, actor, "MEMORY_MIGRATION_SOURCE_CHANGED");
          if (phase === "SNAPSHOTTING")
            await tx.query(
              "insert into memory_legacy_workflow_items(migration_id,source_id,source_digest,source_payload) values($1,$2,$3,$4)",
              [id, sourceId, hash, payload]
            );
          else {
            const staged = (
              await tx.query(
                "select * from memory_legacy_workflow_items where migration_id=$1 and source_id=$2",
                [id, sourceId]
              )
            ).rows[0];
            if (!staged || staged["source_digest"] !== hash || !staged["target_id"])
              return await changed(tx, row, actor, "MEMORY_MIGRATION_SOURCE_CHANGED");
            const target = (
              await tx.query(
                "select digest,classification,semantic_payload from memory_authority_records where scope=$1 and id=$2",
                [scope, staged["target_id"]]
              )
            ).rows[0];
            if (
              !target ||
              target["classification"] !== "LEGACY_UNVERIFIED" ||
              target["digest"] !== digest(legacyEvent(payload, scope))
            )
              return await changed(tx, row, actor, "MEMORY_MIGRATION_TARGET_DIGEST_INVALID");
            await tx.query(
              "update memory_legacy_workflow_items set verified_at=now() where migration_id=$1 and source_id=$2",
              [id, sourceId]
            );
          }
          rolling = chain(rolling, sourceId, hash);
          checkpoint = sourceId;
        }
        count++;
      }
      const done = items.length <= limit;
      const countColumn =
        phase === "SNAPSHOTTING"
          ? "snapshot_count"
          : phase === "IMPORTING"
            ? "imported_count"
            : "verified_count";
      const total = BigInt(String(row[countColumn])) + BigInt(count);
      if (done && total !== BigInt(String(row["expected_count"])))
        return await changed(tx, row, actor, "MEMORY_MIGRATION_COUNT_MISMATCH");
      if (done && phase === "VERIFYING" && rolling !== row["snapshot_digest"])
        return await changed(tx, row, actor, "MEMORY_MIGRATION_CHAIN_MISMATCH");
      const next = done
        ? phase === "SNAPSHOTTING"
          ? "IMPORTING"
          : phase === "IMPORTING"
            ? "VERIFYING"
            : "IMPORT_VERIFIED"
        : phase;
      const updated = (
        await tx.query(
          `update memory_legacy_workflows set ${countColumn}=${countColumn}+$2, checkpoint=$3,status=$4,
       snapshot_digest=case when $5='SNAPSHOTTING' then $6 else snapshot_digest end,
       verify_digest=case when $5='VERIFYING' then $6 else verify_digest end,updated_at=now() where migration_id=$1 returning *`,
          [id, count, done ? null : checkpoint, next, phase, rolling]
        )
      ).rows[0]!;
      await action(tx, updated, actor, "ADVANCE", phase);
      return view(updated);
    });
  }
}
function legacyEvent(payload: QueryResultRow, scope: string): MemoryEvent {
  return {
    id: String(payload["id"]),
    sourceRecordId: String(payload["id"]),
    source: "legacy-postgres",
    scope,
    kind:
      payload["type"] === "episodic"
        ? "episodic"
        : payload["type"] === "semantic"
          ? "fact"
          : "interaction",
    content: String(payload["content"]),
    recordedAt: String(payload["created_at"]),
    observedAt: payload["observed_at"] ? String(payload["observed_at"]) : null,
    assertion: { source: "unknown", verification: "unknown" },
    metadata: {
      legacyPayload: payload,
      identityMapping: "OPERATOR_SELECTED_LEGACY_BINDING",
      sourceVerification: "UNKNOWN"
    }
  };
}
async function lock(tx: AuthorityQuery, scope: string, id: string) {
  canonicalScope(scope);
  const row = (
    await tx.query(
      "select * from memory_legacy_workflows where scope=$1 and migration_id=$2 for update",
      [scope, id]
    )
  ).rows[0];
  if (!row) throw new MemoryAuthorityError("MEMORY_MIGRATION_NOT_FOUND");
  return row;
}
async function action(
  tx: AuthorityQuery,
  row: QueryResultRow,
  actor: string,
  type: string,
  previous: string | null
) {
  if (!actor || actor.length > 200)
    throw new MemoryAuthorityError("MEMORY_OPERATOR_IDENTITY_REQUIRED");
  await tx.query(
    "insert into memory_legacy_workflow_actions(migration_id,actor,action,prior_status,final_status,checkpoint) values($1,$2,$3,$4,$5,$6)",
    [row["migration_id"], actor, type, previous, row["status"], row["checkpoint"]]
  );
}
async function changed(tx: AuthorityQuery, row: QueryResultRow, actor: string, error: string) {
  const next = (
    await tx.query(
      "update memory_legacy_workflows set status='SOURCE_CHANGED',error_code=$2,updated_at=now() where migration_id=$1 returning *",
      [row["migration_id"], error]
    )
  ).rows[0]!;
  await action(tx, next, actor, "VERIFY_REJECTED", String(row["status"]));
  return view(next);
}
function view(row: QueryResultRow) {
  return {
    schema: "memory.migration-workflow.v1" as const,
    id: String(row["migration_id"]),
    scope: String(row["scope"]),
    source: "POSTGRES_LEGACY_COPY" as const,
    status: String(row["status"]),
    anchor: new Date(row["anchor"] as string).toISOString(),
    expected: String(row["expected_count"]),
    snapshot: String(row["snapshot_count"]),
    imported: String(row["imported_count"]),
    verified: String(row["verified_count"]),
    checkpoint: row["checkpoint"] as string | null,
    sourceDigest: String(row["snapshot_digest"]),
    verifyDigest: String(row["verify_digest"]),
    errorCode: row["error_code"] as string | null,
    classification: "LEGACY_UNVERIFIED" as const,
    activation: "BLOCKED_SOURCE_REVIEW_REQUIRED" as const,
    rollback: "SOURCE_UNMODIFIED_TARGET_HISTORY_RETAINED" as const
  };
}
export type MemoryLegacyWorkflowView = Awaited<ReturnType<MemoryLegacyWorkflow["prepare"]>>;
