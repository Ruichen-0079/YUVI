import type { Pool, PoolClient } from "pg";
import {
  EffectIntentError,
  EffectIntentSchema,
  canonicalEffectJson,
  effectIntentId,
  freezeEffectRequest,
  requestEffectDigest,
  type EffectIntent
} from "./model.js";

/** Repository write access belongs to the host admission facade, never Runtime callers. */
export interface EffectIntentStore {
  decide(value: EffectIntent, beforeCommit?: () => void): Promise<EffectIntent>;
  get(intentId: string): Promise<EffectIntent | null>;
  cancel(intentId: string): Promise<EffectIntent | null>;
  listPending(limit: number): Promise<EffectIntent[]>;
  expire(): Promise<number>;
}
function copy(value: EffectIntent): EffectIntent {
  return JSON.parse(canonicalEffectJson(value));
}
function checkReplay(existing: EffectIntent, proposed: EffectIntent): EffectIntent {
  if (
    existing.payloadDigest !== proposed.payloadDigest ||
    existing.contractRef !== proposed.contractRef
  )
    throw new EffectIntentError(
      "CONFLICT",
      "Logical effect key already has a different semantic payload."
    );
  // First decision wins, including DENIED/CANCELED/EXPIRED; replay never reactivates work.
  return copy(existing);
}
function boundLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new EffectIntentError("INVALID_REQUEST", "Pending work limit must be from 1 to 1000.");
  return limit;
}
export function decodeEffectIntent(row: Record<string, unknown>): EffectIntent {
  const parsed = EffectIntentSchema.safeParse(row["intent"]);
  if (!parsed.success)
    throw new EffectIntentError("INTEGRITY_FAILURE", "Invalid durable effect intent.");
  const value = parsed.data;
  if (
    value.intentId !== row["intent_id"] ||
    value.intentId !== effectIntentId(value.contractRef, value.logicalKey) ||
    value.payloadDigest !== row["payload_digest"] ||
    value.logicalKey !== row["logical_key"] ||
    value.contractRef !== row["contract_ref"] ||
    (value.decision === "ADMITTED" &&
      requestEffectDigest(freezeEffectRequest(value.request)) !== value.payloadDigest) ||
    (value.decision === "DENIED" && Object.hasOwn(value.request, "payload"))
  )
    throw new EffectIntentError("INTEGRITY_FAILURE", "Contradictory durable effect intent.");
  const projected = EffectIntentSchema.safeParse({
    ...value,
    state: row["state"],
    workState: row["work_state"]
  });
  if (!projected.success)
    throw new EffectIntentError("INTEGRITY_FAILURE", "Contradictory durable work projection.");
  return copy(projected.data);
}

/** Admission + initial work is one atomic row. Dispatch accounting is in dispatch-store; the host owns the pool. */
export class PostgresEffectIntentStore implements EffectIntentStore {
  constructor(private readonly pool: Pool) {}
  async decide(value: EffectIntent, beforeCommit?: () => void): Promise<EffectIntent> {
    let inserted = false;
    return this.transaction(
      async (client) => {
        const result = await client.query(
          `insert into effect_intents (intent_id, logical_key, contract_ref, payload_digest, intent,
          state, work_state, expires_at, created_at)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
         on conflict do nothing returning *`,
          [
            value.intentId,
            value.logicalKey,
            value.contractRef,
            value.payloadDigest,
            canonicalEffectJson(value),
            value.state,
            value.workState,
            value.request.expiresAt,
            value.createdAt
          ]
        );
        if (result.rows.length) {
          inserted = true;
          return decodeEffectIntent(result.rows[0]!);
        }
        // Both uniqueness arbiters describe the same logical identity. Naming only the PK can
        // raise a secondary-index unique violation during concurrent exact replay.
        // INSERT waits for concurrent decisions to commit; this READ COMMITTED query sees the winner.
        const existing = await client.query(`select * from effect_intents where intent_id=$1`, [
          value.intentId
        ]);
        if (!existing.rows[0])
          throw new EffectIntentError("INTEGRITY_FAILURE", "Conflicting intent disappeared.");
        return checkReplay(decodeEffectIntent(existing.rows[0]), value);
      },
      () => {
        if (inserted) beforeCommit?.();
      }
    );
  }
  async get(id: string): Promise<EffectIntent | null> {
    return this.transaction(async (c) => {
      const result = await c.query(`select * from effect_intents where intent_id=$1`, [id]);
      return result.rows[0] ? decodeEffectIntent(result.rows[0]) : null;
    });
  }
  async cancel(id: string): Promise<EffectIntent | null> {
    return this.transaction(async (c) => {
      // First claim locks this same row. Post-claim cancellation uses EffectDispatchStore.cancel.
      const result = await c.query(`select * from effect_intents where intent_id=$1 for update`, [
        id
      ]);
      if (!result.rows[0]) return null;
      const current = decodeEffectIntent(result.rows[0]);
      if (current.state === "ADMITTED" && current.workState === "PENDING") {
        const changed = await c.query(
          `update effect_intents set state='CANCELED', work_state='WITHHELD'
          where intent_id=$1 returning *`,
          [id]
        );
        return decodeEffectIntent(changed.rows[0]!);
      }
      return current;
    });
  }
  async listPending(limit: number): Promise<EffectIntent[]> {
    boundLimit(limit);
    return this.transaction(async (c) => {
      const result = await c.query(
        `select * from effect_intents
        where state='ADMITTED' and work_state='PENDING' and expires_at > clock_timestamp()
        order by created_at, intent_id limit $1`,
        [limit]
      );
      return result.rows.map(decodeEffectIntent);
    });
  }
  async expire(): Promise<number> {
    return this.transaction(async (c) => {
      const result = await c.query(`update effect_intents set state='EXPIRED', work_state='WITHHELD'
        where state='ADMITTED' and work_state='PENDING' and expires_at <= clock_timestamp() returning intent_id`);
      return result.rows.length;
    });
  }
  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    beforeCommit?: () => void
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (e) {
      throw new EffectIntentError("UNAVAILABLE", "Effect PostgreSQL is unavailable.", e);
    }
    try {
      await client.query("begin");
      const result = await operation(client);
      // No asynchronous yield between the host fence and COMMIT submission.
      // A subsequent revocation does not retroactively revoke this admission snapshot.
      beforeCommit?.();
      await client.query("commit");
      return result;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      if (e instanceof EffectIntentError) throw e;
      // COMMIT response loss is a system failure, not DENIED or an effect outcome. Replay resolves it.
      throw new EffectIntentError(
        "PERSISTENCE_FAILED",
        "Effect transaction did not return a committed decision.",
        e
      );
    } finally {
      client.release();
    }
  }
}

/** Equivalent atomic admission within one process; deliberately no restart durability. */
export class InMemoryEffectIntentStore implements EffectIntentStore {
  private readonly intents = new Map<string, EffectIntent>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  async decide(value: EffectIntent, beforeCommit?: () => void): Promise<EffectIntent> {
    const prior = this.intents.get(value.intentId);
    if (prior) return checkReplay(prior, value);
    const frozen = copy(value);
    beforeCommit?.();
    this.intents.set(value.intentId, frozen);
    return copy(frozen);
  }
  async get(id: string) {
    const v = this.intents.get(id);
    return v ? copy(v) : null;
  }
  async cancel(id: string) {
    const v = this.intents.get(id);
    if (!v) return null;
    if (v.state === "ADMITTED" && v.workState === "PENDING") {
      v.state = "CANCELED";
      v.workState = "WITHHELD";
    }
    return copy(v);
  }
  async listPending(limit: number) {
    boundLimit(limit);
    return [...this.intents.values()]
      .filter(
        (v) =>
          v.state === "ADMITTED" &&
          v.workState === "PENDING" &&
          Date.parse(v.request.expiresAt) > this.now().getTime()
      )
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.intentId.localeCompare(b.intentId)
      )
      .slice(0, limit)
      .map(copy);
  }
  async expire() {
    let count = 0;
    for (const v of this.intents.values())
      if (
        v.state === "ADMITTED" &&
        v.workState === "PENDING" &&
        Date.parse(v.request.expiresAt) <= this.now().getTime()
      ) {
        v.state = "EXPIRED";
        v.workState = "WITHHELD";
        count++;
      }
    return count;
  }
}
