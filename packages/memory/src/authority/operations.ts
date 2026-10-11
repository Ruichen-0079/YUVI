import { canonicalScope, MemoryAuthorityError } from "./types.js";
import { PostgresMemoryAuthority } from "./store.js";
import { canonicalLineageJson, lineageDigest } from "../lineage-encoding.js";

/** An explicit maintenance retry of a proved no-effect stale decision, never an unknown dispatch. */
export async function retryStaleFinalizedDecision(
  authority: PostgresMemoryAuthority,
  input: { scope: string; actionId: string; turnId: string; actor: string }
) {
  canonicalScope(input.scope);
  const digest = lineageDigest(canonicalLineageJson(input));
  return authority.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      input.scope + ":" + input.actionId
    ]);
    const old = (
      await tx.query(
        "select request_digest,result from memory_operator_actions where scope=$1 and action_id=$2",
        [input.scope, input.actionId]
      )
    ).rows[0];
    if (old) {
      if (old["request_digest"] !== digest)
        throw new MemoryAuthorityError("MEMORY_OPERATION_ID_CONFLICT");
      return old["result"];
    }
    const turn = (
      await tx.query(
        "select memory_scope,status,lease_owner,lease_expires_at from finalized_ingestion_turns where finalized_turn_id=$1 for update",
        [input.turnId]
      )
    ).rows[0];
    if (!turn || turn["memory_scope"] !== input.scope)
      throw new MemoryAuthorityError("MEMORY_OPERATION_TARGET_FORBIDDEN");
    if (turn["lease_owner"] && new Date(turn["lease_expires_at"]).getTime() > Date.now())
      throw new MemoryAuthorityError("MEMORY_OPERATION_TARGET_BUSY");
    const records = await tx.query(
      `update finalized_ingestion_events set status='retryable_failed',result_kind=null,error_code=null,error_message=null,next_attempt_at=now(),version=version+1,updated_at=now()
      where finalized_turn_id=$1 and status='terminal_failed' and error_code in ('MEMORY_TARGET_STALE_OR_INACCESSIBLE','MEMORY_TARGET_TIME_ORDER') returning event_id`,
      [input.turnId]
    );
    if (!records.rows.length) throw new MemoryAuthorityError("MEMORY_OPERATION_NO_SAFE_RETRY");
    await tx.query(
      `update finalized_ingestion_turns set status='retryable_failed',last_error_code=null,last_error_message=null,next_attempt_at=now(),completed_at=null,version=version+1,updated_at=now() where finalized_turn_id=$1`,
      [input.turnId]
    );
    const result = {
      schema: "memory.operation.v1",
      actionId: input.actionId,
      status: "QUEUED",
      events: records.rows.map((r) => String(r["event_id"])),
      memoryCompletion: "UNCONFIRMED"
    };
    await tx.query(
      `insert into memory_operator_actions(scope,action_id,operation,actor,request_digest,result) values($1,$2,'RETRY_STALE_FINALIZED',$3,$4,$5)`,
      [input.scope, input.actionId, input.actor, digest, result]
    );
    return result;
  });
}
