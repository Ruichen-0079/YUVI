import type { Pool, PoolClient } from "pg";
import {
  canonicalEffectJson,
  effectDigest,
  EffectIntentError,
  type EffectIntent
} from "./model.js";
import { decodeEffectIntent } from "./store.js";
import {
  EFFECT_DELIVERY_CONTRACTS,
  EffectAttemptV1Schema,
  EffectEvidenceSchema,
  EffectObservationV1Schema,
  EffectObservationV2Schema,
  type EffectObservation,
  EffectProgressFactSchema,
  type EffectProgressFact,
  effectAttemptId,
  protocolEvidence,
  retryPermitted,
  type EffectAttemptV1,
  type EffectEvidence,
  type EffectDiagnostic
} from "./dispatch-model.js";

export type EffectClaim = {
  intent: EffectIntent;
  attempt: EffectAttemptV1;
  mode: "INVOKE" | "RECONCILE";
};
export interface EffectDispatchStore {
  discover(limit?: number, contracts?: EffectIntent["contractRef"][]): Promise<string[]>;
  claim(
    id: string,
    contract: EffectIntent["contractRef"],
    owner: string,
    leaseMs: number,
    current: (intent: EffectIntent) => boolean
  ): Promise<EffectClaim | null>;
  start(claim: EffectClaim, current: () => boolean): Promise<boolean>;
  record(
    attempt: EffectAttemptV1,
    evidence: EffectEvidence
  ): Promise<"RECORDED" | "REPLAY" | "STALE" | "CONFLICT">;
  cancel(id: string): Promise<boolean>;
  diagnostic(id: string): Promise<EffectDiagnostic | null>;
  observations(id: string): Promise<EffectObservation[]>;
  renew?(attempt: EffectAttemptV1, leaseMs: number): Promise<boolean>;
  progress?(
    attempt: EffectAttemptV1,
    fact: EffectProgressFact,
    report?: { reference: string; generation: string }
  ): Promise<"RECORDED" | "REPLAY" | "STALE" | "CONFLICT">;
}
function attempt(row: Record<string, unknown>): EffectAttemptV1 {
  const a = EffectAttemptV1Schema.parse({
    version: "effect-attempt.v1",
    attemptId: row["attempt_id"],
    intentId: row["intent_id"],
    attemptOrdinal: String(row["ordinal"]),
    contractRef: row["contract_ref"],
    adapter: row["adapter"],
    fence: String(row["fence"]),
    leaseOwner: row["lease_owner"],
    leaseExpiresAt: (row["lease_expires_at"] as Date).toISOString(),
    createdAt: (row["created_at"] as Date).toISOString(),
    dispatchStartedAt: row["dispatch_started_at"]
      ? (row["dispatch_started_at"] as Date).toISOString()
      : null,
    integrityConflict: row["integrity_conflict"]
  });
  if (
    a.attemptId !== effectAttemptId(a.intentId, a.attemptOrdinal) ||
    a.adapter !== EFFECT_DELIVERY_CONTRACTS[a.contractRef].adapter
  )
    throw new EffectIntentError("INTEGRITY_FAILURE", "Invalid attempt identity/adapter.");
  return a;
}
function live(fn: () => boolean) {
  try {
    return fn() === true;
  } catch {
    return false;
  }
}
/** Shares the host pool; all mutation locks INTENT then ATTEMPT in the same order. */
export class PostgresEffectDispatchStore implements EffectDispatchStore {
  constructor(private readonly pool: Pool) {}
  private async tx<T>(fn: (c: PoolClient) => Promise<T>, fence?: () => void): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const v = await fn(c);
      fence?.();
      await c.query("commit");
      return v;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  private async latest(c: PoolClient, id: string) {
    const r = await c.query(
      "select *,lease_expires_at>clock_timestamp() as live from effect_attempts where intent_id=$1 order by ordinal desc limit 1 for update",
      [id]
    );
    return r.rows[0] ? { a: attempt(r.rows[0]), live: r.rows[0]["live"] === true } : null;
  }
  private async evidence(c: PoolClient, id: string): Promise<EffectEvidence | null> {
    const r = await c.query(
      `select o.*,a.contract_ref,a.adapter from effect_observations o
       join effect_attempts a using(attempt_id) where o.attempt_id=$1 and o.category='TERMINAL' order by o.observation_id desc limit 1`,
      [id]
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    const version = row["observation_version"] ?? "effect-observation.v1";
    const base = {
      version,
      observationId: String(row["observation_id"]),
      attemptId: row["attempt_id"],
      fence: String(row["fence"]),
      contractRef: row["contract_ref"],
      adapter: row["adapter"],
      observedAt: (row["observed_at"] as Date).toISOString(),
      evidence: row["evidence"],
      evidenceDigest: row["evidence_digest"]
    };
    const observation =
      version === "effect-observation.v2"
        ? EffectObservationV2Schema.parse(base)
        : EffectObservationV1Schema.parse(base);
    if (effectDigest(observation.evidence) !== row["evidence_digest"])
      throw new EffectIntentError("INTEGRITY_FAILURE", "Invalid outcome digest.");
    return observation.evidence;
  }
  private async observe(c: PoolClient, a: EffectAttemptV1, e: EffectEvidence) {
    await c.query(
      "insert into effect_observations(attempt_id,fence,evidence,evidence_digest,observation_version) values($1,$2,$3::jsonb,$4,$5) on conflict do nothing",
      [
        a.attemptId,
        a.fence,
        canonicalEffectJson(e),
        effectDigest(e),
        a.contractRef === "yuvi.native-control.v1"
          ? "effect-observation.v2"
          : "effect-observation.v1"
      ]
    );
  }
  async discover(
    limit = 64,
    contracts: EffectIntent["contractRef"][] = [
      "yuvi.read-text.v1",
      "yuvi.embodied-presentation.v1",
      "yuvi.native-control.v1"
    ]
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new EffectIntentError("INVALID_REQUEST", "Invalid discovery bound.");
    const r = await this.pool.query(
      `select i.intent_id from effect_intents i
      left join lateral (select * from effect_attempts a where a.intent_id=i.intent_id order by ordinal desc limit 1) a on true
      left join lateral (select evidence from effect_observations o where o.attempt_id=a.attempt_id and o.category='TERMINAL' order by observation_id desc limit 1) o on true
      where i.state='ADMITTED' and i.pre_dispatch_reason is null and i.contract_ref=any($2::text[]) and (i.work_state='PENDING' or (i.work_state='CLAIMED' and not a.integrity_conflict and a.lease_expires_at<=clock_timestamp()
      and (o.evidence is null or o.evidence->>'certainty'='UNKNOWN' and o.evidence->>'reason'<>'RECONCILIATION_UNSUPPORTED'
      or o.evidence->>'certainty'='PROVEN_NOT_APPLIED' and o.evidence->>'reason' in ('UNSTARTED_RECOVERY','RECONCILED_NOT_APPLIED','HOST_CERTIFIED_NOT_STARTED'))))
      order by i.created_at,i.intent_id limit $1`,
      [limit, contracts]
    );
    return r.rows.map((r) => String(r["intent_id"]));
  }
  async claim(
    id: string,
    contract: EffectIntent["contractRef"],
    owner: string,
    leaseMs: number,
    current: (intent: EffectIntent) => boolean
  ) {
    if (
      !owner ||
      owner.length > 128 ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1 ||
      leaseMs > 300_000
    )
      throw new EffectIntentError("INVALID_REQUEST", "Invalid lease.");
    let invoking: EffectIntent | null = null;
    return this.tx(
      async (c) => {
        const r = await c.query(
          "select *,expires_at>clock_timestamp() as unexpired from effect_intents where intent_id=$1 for update",
          [id]
        );
        if (!r.rows[0]) return null;
        const i = decodeEffectIntent(r.rows[0]);
        if (
          i.contractRef !== contract ||
          i.state !== "ADMITTED" ||
          r.rows[0]["pre_dispatch_reason"] !== null ||
          !["PENDING", "CLAIMED"].includes(i.workState ?? "")
        )
          return null;
        const last = await this.latest(c, id);
        const e = last ? await this.evidence(c, last.a.attemptId) : null;
        if (last?.a.integrityConflict || last?.live) return null;
        if (last?.a.dispatchStartedAt && (!e || e.certainty === "UNKNOWN")) {
          const a = await c.query(
            "update effect_attempts set fence=fence+1,lease_owner=$2,lease_expires_at=clock_timestamp()+($3::int*interval '1 millisecond') where attempt_id=$1 returning *",
            [last.a.attemptId, owner, leaseMs]
          );
          return { intent: i, attempt: attempt(a.rows[0]), mode: "RECONCILE" as const };
        }
        if (last && !e)
          await this.observe(c, last.a, protocolEvidence("UNSTARTED_RECOVERY", false));
        if (last && !retryPermitted(last.a, e ?? protocolEvidence("UNSTARTED_RECOVERY", false)))
          return null;
        if (!r.rows[0]["unexpired"] || !live(() => current(i))) {
          if (!last)
            await c.query(
              "update effect_intents set state=case when expires_at<=clock_timestamp() then 'EXPIRED' else state end,work_state='WITHHELD',pre_dispatch_reason=case when expires_at<=clock_timestamp() then null else 'AUTHORITY_REVOKED' end where intent_id=$1",
              [id]
            );
          else
            // Withhold future work separately; expiry/revocation never rewrites prior evidence.
            await c.query("update effect_intents set pre_dispatch_reason=$2 where intent_id=$1", [
              id,
              r.rows[0]["unexpired"] ? "AUTHORITY_REVOKED" : "EXPIRED"
            ]);
          return null;
        }
        const ordinal = (last ? BigInt(last.a.attemptOrdinal) + 1n : 1n).toString();
        const a = await c.query(
          `insert into effect_attempts(attempt_id,intent_id,ordinal,contract_ref,adapter,fence,lease_owner,lease_expires_at)
        values($1,$2,$3,$4,$5,1,$6,clock_timestamp()+($7::int*interval '1 millisecond')) returning *`,
          [
            effectAttemptId(id, ordinal),
            id,
            ordinal,
            contract,
            EFFECT_DELIVERY_CONTRACTS[contract].adapter,
            owner,
            leaseMs
          ]
        );
        if (!last)
          await c.query("update effect_intents set work_state='CLAIMED' where intent_id=$1", [id]);
        invoking = i;
        return {
          intent: { ...i, workState: "CLAIMED" as const },
          attempt: attempt(a.rows[0]),
          mode: "INVOKE" as const
        };
      },
      () => {
        if (
          invoking &&
          (Date.parse(invoking.request.expiresAt) <= Date.now() || !live(() => current(invoking!)))
        )
          throw new EffectIntentError("AUTHORITY_CHANGED", "Dispatch claim authority changed.");
      }
    );
  }
  async start(claim: EffectClaim, current: () => boolean): Promise<boolean> {
    let starting: EffectAttemptV1 | null = null;
    return this.tx(
      async (c) => {
        const i = await c.query(
          "select *,expires_at>clock_timestamp() as unexpired from effect_intents where intent_id=$1 for update",
          [claim.intent.intentId]
        );
        const l = await this.latest(c, claim.intent.intentId);
        if (
          !l ||
          l.a.attemptId !== claim.attempt.attemptId ||
          l.a.fence !== claim.attempt.fence ||
          l.a.leaseOwner !== claim.attempt.leaseOwner ||
          !l.live ||
          l.a.dispatchStartedAt ||
          l.a.integrityConflict ||
          (await this.evidence(c, l.a.attemptId))
        )
          return false;
        if (!i.rows[0]["unexpired"] || !live(current)) {
          await this.observe(
            c,
            l.a,
            protocolEvidence(
              i.rows[0]["unexpired"] ? "AUTHORITY_REVOKED" : "EXPIRED_BEFORE_START",
              false
            )
          );
          return false;
        }
        await c.query(
          "update effect_attempts set dispatch_started_at=clock_timestamp() where attempt_id=$1",
          [l.a.attemptId]
        );
        starting = l.a;
        return true;
      },
      () => {
        if (
          starting &&
          (Date.parse(starting.leaseExpiresAt) <= Date.now() ||
            Date.parse(claim.intent.request.expiresAt) <= Date.now() ||
            !live(current))
        )
          throw new EffectIntentError("AUTHORITY_CHANGED", "Dispatch-start authority changed.");
      }
    );
  }
  async renew(a: EffectAttemptV1, leaseMs: number) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000)
      throw new EffectIntentError("INVALID_REQUEST", "Invalid renewal lease.");
    const result = await this.pool.query(
      `update effect_attempts a
      set lease_expires_at=clock_timestamp()+($5::int*interval '1 millisecond')
      where attempt_id=$1 and fence=$2 and lease_owner=$3 and adapter=$4
      and not integrity_conflict and lease_expires_at>clock_timestamp()
      and not exists(select 1 from effect_observations o where o.attempt_id=a.attempt_id and o.category='TERMINAL')`,
      [a.attemptId, a.fence, a.leaseOwner, a.adapter, leaseMs]
    );
    return result.rowCount === 1;
  }
  async progress(
    a: EffectAttemptV1,
    raw: EffectProgressFact,
    report?: { reference: string; generation: string }
  ) {
    const fact = EffectProgressFactSchema.parse(raw);
    return this.tx(async (c) => {
      await c.query("select intent_id from effect_intents where intent_id=$1 for update", [
        a.intentId
      ]);
      const last = await this.latest(c, a.intentId);
      if (
        !last ||
        last.a.attemptId !== a.attemptId ||
        last.a.fence !== a.fence ||
        last.a.leaseOwner !== a.leaseOwner ||
        last.a.adapter !== a.adapter ||
        last.a.contractRef !== a.contractRef ||
        !last.a.dispatchStartedAt ||
        last.a.integrityConflict
      )
        return "STALE" as const;
      const prior = await c.query(
        "select evidence_digest from effect_observations where attempt_id=$1 and category='PROGRESS' and fact_key=$2",
        [a.attemptId, fact.factKey]
      );
      const digest = effectDigest(fact);
      if (prior.rows[0]) {
        if (prior.rows[0]["evidence_digest"] === digest) return "REPLAY" as const;
        await c.query("update effect_attempts set integrity_conflict=true where attempt_id=$1", [
          a.attemptId
        ]);
        return "CONFLICT" as const;
      }
      // Ordinary active-worker facts require a live lease. Asynchronous device reports
      // must first acquire a current reconciliation fence through the host report owner.
      if (report) {
        const capability = await c.query(
          `select evidence from effect_observations where attempt_id=$1 and category='PROGRESS'
          and evidence->>'kind'='PERMISSION_ISSUED' and evidence->>'reference'=$2 and evidence->>'generation'=$3`,
          [a.attemptId, report.reference, report.generation]
        );
        if (!capability.rows.length || fact.generation !== report.generation)
          return "STALE" as const;
      } else if (!last.live) return "STALE" as const;
      await c.query(
        `insert into effect_observations(attempt_id,fence,evidence,evidence_digest,observation_version,category,fact_key)
        values($1,$2,$3::jsonb,$4,'effect-observation.v2','PROGRESS',$5)`,
        [a.attemptId, a.fence, canonicalEffectJson(fact), digest, fact.factKey]
      );
      return "RECORDED" as const;
    });
  }
  async record(a: EffectAttemptV1, raw: EffectEvidence) {
    const e = EffectEvidenceSchema.parse(JSON.parse(canonicalEffectJson(raw)));
    if (
      ![
        "LOCAL_PROTOCOL",
        "ADAPTER_RECONCILIATION",
        ...EFFECT_DELIVERY_CONTRACTS[a.contractRef].evidenceLayers
      ].includes(e.layer)
    )
      throw new EffectIntentError("INTEGRITY_FAILURE", "Outcome layer does not belong to adapter.");
    if (
      a.contractRef === "yuvi.native-control.v1" &&
      e.certainty === "APPLIED" &&
      e.layer.startsWith("NATIVE_OWNER_") &&
      !e.nativeOwnerCommit
    )
      throw new EffectIntentError(
        "INTEGRITY_FAILURE",
        "Native-owner APPLIED evidence requires its exact owner revision."
      );
    if (e.nativeOwnerCommit && a.contractRef !== "yuvi.native-control.v1")
      throw new EffectIntentError(
        "INTEGRITY_FAILURE",
        "Native-owner evidence belongs only to native-control."
      );
    return this.tx(async (c) => {
      await c.query("select intent_id from effect_intents where intent_id=$1 for update", [
        a.intentId
      ]);
      const l = await this.latest(c, a.intentId);
      if (
        !l ||
        l.a.attemptId !== a.attemptId ||
        l.a.fence !== a.fence ||
        l.a.leaseOwner !== a.leaseOwner ||
        l.a.adapter !== a.adapter ||
        l.a.contractRef !== a.contractRef
      )
        return "STALE" as const;
      const prior = await this.evidence(c, a.attemptId);
      if (prior && canonicalEffectJson(prior) === canonicalEffectJson(e)) return "REPLAY" as const;
      if (l.a.integrityConflict) return "CONFLICT" as const;
      if (
        (prior && prior.certainty !== "UNKNOWN") ||
        (!l.a.dispatchStartedAt && e.certainty !== "PROVEN_NOT_APPLIED")
      ) {
        await this.observe(c, l.a, e);
        await c.query("update effect_attempts set integrity_conflict=true where attempt_id=$1", [
          a.attemptId
        ]);
        return "CONFLICT" as const;
      }
      if (!l.live) return "STALE" as const;
      await this.observe(c, l.a, e);
      // Reconciliation/next attempt can acquire a NEW fence; late invocation callbacks then fail closed.
      await c.query(
        "update effect_attempts set lease_expires_at=clock_timestamp() where attempt_id=$1",
        [a.attemptId]
      );
      return "RECORDED" as const;
    });
  }
  async cancel(id: string) {
    return this.tx(async (c) => {
      const i = await c.query("select * from effect_intents where intent_id=$1 for update", [id]);
      if (!i.rows[0] || i.rows[0]["state"] !== "ADMITTED") return false;
      if (i.rows[0]["work_state"] === "PENDING") {
        await c.query(
          "update effect_intents set state='CANCELED',work_state='WITHHELD' where intent_id=$1",
          [id]
        );
        return true;
      }
      const l = await this.latest(c, id);
      if (!l || l.a.dispatchStartedAt || (await this.evidence(c, l.a.attemptId))) return false;
      await this.observe(c, l.a, protocolEvidence("CANCELED_BEFORE_START", false));
      return true;
    });
  }
  async observations(id: string): Promise<EffectObservation[]> {
    const r = await this.pool.query(
      `select o.*,a.contract_ref,a.adapter from effect_observations o
      join effect_attempts a using(attempt_id) where a.intent_id=$1 and o.category='TERMINAL' order by o.observation_id limit 1000`,
      [id]
    );
    return r.rows.map((row) => {
      const version = row["observation_version"] ?? "effect-observation.v1";
      const value = {
        version,
        observationId: String(row["observation_id"]),
        attemptId: row["attempt_id"],
        fence: String(row["fence"]),
        contractRef: row["contract_ref"],
        adapter: row["adapter"],
        observedAt: row["observed_at"].toISOString(),
        evidence: row["evidence"],
        evidenceDigest: row["evidence_digest"]
      };
      const v =
        version === "effect-observation.v2"
          ? EffectObservationV2Schema.parse(value)
          : EffectObservationV1Schema.parse(value);
      if (v.evidenceDigest !== effectDigest(v.evidence))
        throw new EffectIntentError("INTEGRITY_FAILURE", "Invalid observation digest.");
      return v;
    });
  }
  async diagnostic(id: string): Promise<EffectDiagnostic | null> {
    return this.tx(async (c) => {
      const r = await c.query("select * from effect_intents where intent_id=$1 for update", [id]);
      if (!r.rows[0]) return null;
      const i = decodeEffectIntent(r.rows[0]),
        l = await this.latest(c, id),
        e = l ? await this.evidence(c, l.a.attemptId) : null;
      return {
        intentId: id,
        contractRef: i.contractRef,
        admission: i.decision,
        intentState: i.state,
        certainty: l?.a.integrityConflict
          ? "INTEGRITY_CONFLICT"
          : (e?.certainty ?? (l?.a.dispatchStartedAt ? "UNKNOWN" : "NO_DISPATCH")),
        lastSafeReasonCode: l?.a.integrityConflict
          ? "OUTCOME_CONFLICT"
          : (r.rows[0]["pre_dispatch_reason"] ??
            e?.reason ??
            (l?.a.dispatchStartedAt ? "OUTCOME_UNOBSERVED" : null)),
        workState: i.workState,
        preDispatchReason: r.rows[0]["pre_dispatch_reason"] ?? null,
        currentAttempt: l?.a ?? null,
        evidence: e,
        reconciliationRequired:
          !!l?.a.integrityConflict ||
          (!!l?.a.dispatchStartedAt && (!e || e.certainty === "UNKNOWN"))
      };
    });
  }
}
