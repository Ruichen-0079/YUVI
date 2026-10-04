import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { waitForCheckpoint } from "../../../scripts/conformance/fault-surface.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "../../journal/src/index.js";
import { HostEffectIntentAdmission } from "../src/admission.js";
import { PostgresEffectIntentStore } from "../src/store.js";
import {
  PostgresEffectDispatchStore,
  type EffectDispatchStore,
  type EffectClaim
} from "../src/dispatch-store.js";
import { EffectDispatcher, type EffectAdapter } from "../src/dispatcher.js";
import { protocolEvidence, type EffectEvidence } from "../src/dispatch-model.js";
import { EffectIntentError } from "../src/model.js";
import { effectRequest, effectAuthority, fixtureIdentity } from "../src/test-fixture.js";

const url = process.env["YUVI_EFFECT_TEST_DATABASE_URL"];
const schema = `a92_${randomBytes(6).toString("hex")}`;
let admin: Pool,
  pool: Pool,
  admission: HostEffectIntentAdmission,
  store: PostgresEffectDispatchStore;
let directory: string;
let cause: ReturnType<typeof effectRequest>["causalRefs"][number];
const applied: EffectEvidence = {
  certainty: "APPLIED",
  layer: "LOCAL_READ_RETURNED",
  reason: "RETURNED",
  remoteEffectId: null
};
const proof: EffectEvidence = {
  certainty: "PROVEN_NOT_APPLIED",
  layer: "ADAPTER_RECONCILIATION",
  reason: "RECONCILED_NOT_APPLIED",
  remoteEffectId: null
};
let sequence = 0;
async function admit(expiresAt = "2099-01-01T00:00:00.000Z") {
  const r = {
    ...effectRequest(`a92:${++sequence}`),
    contractRef: "yuvi.read-text.v1" as const,
    causalRefs: [cause],
    payload: { path: "/task-owned/file.txt" },
    expiresAt
  };
  const auth = effectAuthority();
  auth.snapshot.permissions = ["RUNTIME_AUTHORIZED_PATH_READ"];
  return admission.admit(r, auth);
}
async function claim(id: string, owner = "w1", lease = 30_000, current = () => true) {
  return store.claim(id, "yuvi.read-text.v1", owner, lease, current);
}
async function expireLease(c: EffectClaim) {
  await pool.query(
    "update effect_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where attempt_id=$1",
    [c.attempt.attemptId]
  );
}
function adapter(
  invoke: EffectAdapter["invoke"],
  reconcile?: EffectAdapter["reconcile"]
): EffectAdapter {
  return {
    contractRef: "yuvi.read-text.v1",
    adapter: "yuvi.local-read-text.v1",
    isCurrent: () => true,
    invoke,
    ...(reconcile ? { reconcile } : {})
  };
}
function faultyPool(
  fault: (sql: string, forward: () => Promise<unknown>) => Promise<unknown>
): Pool {
  return {
    async connect() {
      const c = await pool.connect();
      return {
        query(sql: string, values?: unknown[]) {
          return fault(sql, () => c.query(sql, values));
        },
        release() {
          c.release();
        }
      };
    }
  } as unknown as Pool;
}
describe.skipIf(!url)("A9.2 real PostgreSQL dispatch and crash certainty", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "yuvi-a92-crash-"));
    admin = createPostgresPool(url!);
    await admin.query(`create schema "${schema}"`);
    pool = createPostgresPool(url!, { options: `-c search_path=${schema},public` });
    for (const file of [
      "013_life_event_journal_v1.sql",
      "020_effect_intents_v1.sql",
      "021_effect_attempts_v1.sql",
      "022_native_control_effects_v1.sql",
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "023_reply_components_v1.sql"
    ])
      await pool.query(
        await readFile(new URL(`../../memory/migrations/${file}`, import.meta.url), "utf8")
      );
    const journal = new PostgresJournalRepository(pool, {
      namespace: "test:a92",
      authorityBuilder() {
        throw Error("host only");
      }
    });
    const receipt = await journal.appendWithHostAuthority(
      {
        command: {
          version: "life-event-command.v1",
          kind: "RECEIPT",
          occurrenceTime: { state: "UNKNOWN" },
          causalParents: [],
          data: { receiptClass: "CONTROL", evidenceSelectors: [] }
        }
      },
      {
        ...fixtureIdentity,
        surface: { kind: "LOCAL", reference: "task:a92" },
        correlations: [],
        policyVersion: "host-test.v1",
        producer: { name: "host-test", version: "1" },
        sourceReferences: [{ kind: "UNRESOLVED_SOURCE", reason: "task owned control" }],
        payloads: []
      }
    );
    cause = {
      kind: "JOURNAL_EVENT",
      namespace: receipt.envelope.journalNamespace,
      eventId: receipt.envelope.eventId
    };
    admission = new HostEffectIntentAdmission(new PostgresEffectIntentStore(pool), journal);
    store = new PostgresEffectDispatchStore(pool);
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    await pool?.end();
    if (admin) {
      await admin.query(`drop schema "${schema}" cascade`);
      await admin.end();
    }
  });
  it("concurrent workers allocate exactly one matching first attempt", async () => {
    const i = await admit();
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, n) => claim(i.intentId, `w${n}`))
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await admission.get(i.intentId))?.workState).toBe("CLAIMED");
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.attemptOrdinal).toBe("1");
  });
  it("DB rejects CLAIMED without attempt", async () => {
    const i = await admit();
    await expect(
      pool.query("update effect_intents set work_state='CLAIMED' where intent_id=$1", [i.intentId])
    ).rejects.toThrow("EFFECT_ATTEMPT_LINK_REQUIRED");
    expect((await admission.get(i.intentId))?.workState).toBe("PENDING");
  });
  it("DB rejects attempt without claimed intent", async () => {
    const i = await admit(),
      c = await claim(i.intentId);
    expect(c).not.toBeNull();
    await expect(
      pool.query("update effect_intents set work_state='PENDING' where intent_id=$1", [i.intentId])
    ).rejects.toThrow();
  });
  it("canceled pending cannot claim", async () => {
    const i = await admit();
    await admission.cancel(i.intentId);
    expect(await claim(i.intentId)).toBeNull();
  });
  it("expired pending cannot claim", async () => {
    const i = await admit(new Date(Date.now() + 100).toISOString());
    await new Promise((r) => setTimeout(r, 130));
    expect(await claim(i.intentId)).toBeNull();
    expect((await admission.get(i.intentId))?.state).toBe("EXPIRED");
  });
  it("revoked admission remains historically ADMITTED with no invocation/attempt", async () => {
    const i = await admit();
    expect(await claim(i.intentId, "w", 30000, () => false)).toBeNull();
    const d = await store.diagnostic(i.intentId);
    expect(d?.admission).toBe("ADMITTED");
    expect(d?.preDispatchReason).toBe("AUTHORITY_REVOKED");
    expect(d?.currentAttempt).toBeNull();
  });
  it("claim transaction rollback leaves pending and no attempt", async () => {
    const i = await admit();
    const broken = new PostgresEffectDispatchStore(
      faultyPool(async (sql, f) => {
        const r = await f();
        if (sql.startsWith("insert into effect_attempts")) throw Error("crash during claim");
        return r;
      })
    );
    await expect(
      broken.claim(i.intentId, "yuvi.read-text.v1", "w", 30000, () => true)
    ).rejects.toThrow();
    expect((await store.diagnostic(i.intentId))?.currentAttempt).toBeNull();
    expect((await admission.get(i.intentId))?.workState).toBe("PENDING");
  });
  it("lost claim COMMIT response preserves one concrete attempt", async () => {
    const i = await admit();
    const broken = new PostgresEffectDispatchStore(
      faultyPool(async (sql, f) => {
        const r = await f();
        if (sql === "commit") throw Error("response lost");
        return r;
      })
    );
    await expect(
      broken.claim(i.intentId, "yuvi.read-text.v1", "w", 30000, () => true)
    ).rejects.toThrow();
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.attemptOrdinal).toBe("1");
    expect(await claim(i.intentId, "w2")).toBeNull();
  });
  it("invocation sees the committed attempt and dispatch-start marker", async () => {
    const i = await admit();
    let calls = 0;
    const worker = new EffectDispatcher(store, [
      adapter(async (_, a) => {
        calls++;
        const d = await store.diagnostic(i.intentId);
        expect(d?.currentAttempt?.attemptId).toBe(a.attemptId);
        expect(d?.currentAttempt?.dispatchStartedAt).not.toBeNull();
        return { evidence: applied, transientResult: "not persisted" };
      })
    ]);
    expect(await worker.run(i.intentId)).toMatchObject({
      invoked: true,
      recorded: true,
      transientResult: "not persisted"
    });
    expect(calls).toBe(1);
    expect(await worker.run(i.intentId)).toMatchObject({ invoked: false });
    await worker.shutdown();
  });
  it("two workers cannot dispatch same attempt", async () => {
    const i = await admit();
    let calls = 0;
    const a = adapter(async () => {
      calls++;
      return { evidence: applied };
    });
    const x = new EffectDispatcher(store, [a]),
      y = new EffectDispatcher(store, [a]);
    await Promise.all([x.run(i.intentId), y.run(i.intentId)]);
    expect(calls).toBe(1);
    await x.shutdown();
    await y.shutdown();
  });
  it("unstarted expired claim safely recovers to a new concrete identity", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await expireLease(a);
    const b = (await claim(i.intentId, "w2"))!;
    expect(b.mode).toBe("INVOKE");
    expect(b.attempt.attemptOrdinal).toBe("2");
    expect(b.attempt.attemptId).not.toBe(a.attempt.attemptId);
    expect(await store.start(a, () => true)).toBe(false);
  });
  it("dispatch-start transaction rollback permits no invocation", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    const broken = new PostgresEffectDispatchStore(
      faultyPool(async (sql, f) => {
        const r = await f();
        if (sql.startsWith("update effect_attempts set dispatch_started_at"))
          throw Error("start rollback");
        return r;
      })
    );
    await expect(broken.start(a, () => true)).rejects.toThrow();
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.dispatchStartedAt).toBeNull();
  });
  it("lost dispatch-start COMMIT response is ambiguous despite no call", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    const broken = new PostgresEffectDispatchStore(
      faultyPool(async (sql, f) => {
        const r = await f();
        if (sql === "commit") throw Error("start response lost");
        return r;
      })
    );
    await expect(broken.start(a, () => true)).rejects.toThrow();
    expect((await store.diagnostic(i.intentId))?.reconciliationRequired).toBe(true);
    await expireLease(a);
    expect((await claim(i.intentId, "w2"))?.mode).toBe("RECONCILE");
  });
  it("lease expiration after start is UNKNOWN, never a second attempt", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    await expireLease(a);
    const b = (await claim(i.intentId, "w2"))!;
    expect(b.mode).toBe("RECONCILE");
    expect(b.attempt.attemptId).toBe(a.attempt.attemptId);
    expect(b.attempt.fence).toBe("2");
  });
  it("late old worker cannot overwrite replacement accounting", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    await expireLease(a);
    const b = (await claim(i.intentId, "w2"))!;
    expect(await store.record(a.attempt, applied)).toBe("STALE");
    expect(
      await store.record(b.attempt, {
        ...applied,
        layer: "ADAPTER_RECONCILIATION",
        reason: "RECONCILED_APPLIED"
      })
    ).toBe("RECORDED");
  });
  it("lost response remains UNKNOWN and unsupported reconciliation never resends", async () => {
    const i = await admit();
    let calls = 0;
    const worker = new EffectDispatcher(store, [
      adapter(async () => {
        calls++;
        throw Error("applied response lost");
      })
    ]);
    await worker.run(i.intentId);
    expect((await store.diagnostic(i.intentId))?.evidence?.certainty).toBe("UNKNOWN");
    await worker.run(i.intentId);
    await worker.run(i.intentId);
    expect(calls).toBe(1);
    expect((await store.diagnostic(i.intentId))?.evidence?.reason).toBe(
      "RECONCILIATION_UNSUPPORTED"
    );
    expect((await store.discover()).includes(i.intentId)).toBe(false);
    await worker.shutdown();
  });
  it("applied reconciliation closes same concrete attempt", async () => {
    const i = await admit();
    let calls = 0,
      lookups = 0;
    const worker = new EffectDispatcher(store, [
      adapter(
        async () => {
          calls++;
          throw Error("lost");
        },
        async () => {
          lookups++;
          return { ...applied, layer: "ADAPTER_RECONCILIATION", reason: "RECONCILED_APPLIED" };
        }
      )
    ]);
    await worker.run(i.intentId);
    const a = (await store.diagnostic(i.intentId))!.currentAttempt!;
    await worker.run(i.intentId);
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.attemptId).toBe(a.attemptId);
    expect(calls).toBe(1);
    expect(lookups).toBe(1);
    await worker.shutdown();
  });
  it("proven no-effect reconciliation permits only a NEW attempt", async () => {
    const i = await admit();
    let calls = 0;
    const worker = new EffectDispatcher(store, [
      adapter(
        async () => {
          calls++;
          return calls === 1
            ? { evidence: protocolEvidence("CALL_UNCERTAIN", true) }
            : { evidence: applied };
        },
        async () => proof
      )
    ]);
    await worker.run(i.intentId);
    const a = (await store.diagnostic(i.intentId))!.currentAttempt!;
    await worker.run(i.intentId);
    expect((await store.diagnostic(i.intentId))?.evidence).toEqual(proof);
    await worker.run(i.intentId);
    expect(calls).toBe(2);
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.attemptOrdinal).toBe("2");
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.attemptId).not.toBe(a.attemptId);
    await worker.shutdown();
  });
  it("exact duplicate outcome is idempotent", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    expect(await store.record(a.attempt, applied)).toBe("RECORDED");
    expect(await store.record(a.attempt, applied)).toBe("REPLAY");
  });
  it("conflicting definitive evidence persists integrity conflict", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    await store.record(a.attempt, applied);
    expect(await store.record(a.attempt, proof)).toBe("CONFLICT");
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.integrityConflict).toBe(true);
    expect((await store.diagnostic(i.intentId))?.certainty).toBe("INTEGRITY_CONFLICT");
    expect(await store.observations(i.intentId)).toHaveLength(2);
    expect(await claim(i.intentId, "w2")).toBeNull();
  });
  it("lost outcome COMMIT response replays same evidence", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    const broken = new PostgresEffectDispatchStore(
      faultyPool(async (sql, f) => {
        const r = await f();
        if (sql === "commit") throw Error("outcome response lost");
        return r;
      })
    );
    await expect(broken.record(a.attempt, applied)).rejects.toThrow();
    expect(await store.record(a.attempt, applied)).toBe("REPLAY");
  });
  it("received result before rollback remains ambiguous", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    const broken = new PostgresEffectDispatchStore(
      faultyPool(async (sql, f) => {
        const r = await f();
        if (sql.startsWith("insert into effect_observations")) throw Error("outcome rollback");
        return r;
      })
    );
    await expect(broken.record(a.attempt, applied)).rejects.toThrow();
    expect((await store.diagnostic(i.intentId))?.evidence).toBeNull();
    expect((await store.diagnostic(i.intentId))?.reconciliationRequired).toBe(true);
  });
  it("cancellation wins before dispatch start", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    expect(await store.cancel(i.intentId)).toBe(true);
    expect(await store.start(a, () => true)).toBe(false);
    await expireLease(a);
    expect(await claim(i.intentId, "w2")).toBeNull();
  });
  it("cancellation after dispatch cannot rewrite certainty", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    expect(await store.cancel(i.intentId)).toBe(false);
    expect((await store.diagnostic(i.intentId))?.reconciliationRequired).toBe(true);
  });
  it("expiry between claim and start suppresses invocation", async () => {
    const i = await admit(new Date(Date.now() + 120).toISOString()),
      a = (await claim(i.intentId))!;
    await new Promise((r) => setTimeout(r, 150));
    expect(await store.start(a, () => true)).toBe(false);
    expect((await store.diagnostic(i.intentId))?.evidence?.reason).toBe("EXPIRED_BEFORE_START");
  });
  it("expiry after start does not erase ambiguous effect", async () => {
    const i = await admit(new Date(Date.now() + 120).toISOString()),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    await new Promise((r) => setTimeout(r, 150));
    await expireLease(a);
    expect((await claim(i.intentId, "w2"))?.mode).toBe("RECONCILE");
  });
  it("revocation between claim and start suppresses invocation", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    expect(await store.start(a, () => false)).toBe(false);
    expect((await store.diagnostic(i.intentId))?.evidence?.reason).toBe("AUTHORITY_REVOKED");
  });
  it("graceful worker shutdown closes active results without publication", async () => {
    const i = await admit();
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => (release = r));
    const worker = new EffectDispatcher(store, [
      adapter(async () => {
        await wait;
        return { evidence: applied, transientResult: "private" };
      })
    ]);
    const running = worker.run(i.intentId);
    await expect
      .poll(async () => !!(await store.diagnostic(i.intentId))?.currentAttempt?.dispatchStartedAt)
      .toBe(true);
    const closing = worker.shutdown(1000);
    release();
    expect(await closing).toEqual({ drained: true });
    expect((await running).transientResult).toBeUndefined();
    expect((await store.diagnostic(i.intentId))?.evidence?.certainty).toBe("APPLIED");
  });
  it("forced drain after start persists UNKNOWN and fences late result", async () => {
    const i = await admit();
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => (release = r));
    const worker = new EffectDispatcher(store, [
      adapter(async () => {
        await wait;
        return { evidence: applied };
      })
    ]);
    const running = worker.run(i.intentId);
    await expect
      .poll(async () => !!(await store.diagnostic(i.intentId))?.currentAttempt?.dispatchStartedAt)
      .toBe(true);
    expect(await worker.shutdown(1)).toEqual({ drained: false });
    expect((await store.diagnostic(i.intentId))?.evidence?.certainty).toBe("UNKNOWN");
    release();
    expect((await running).recorded).toBe(false);
    expect((await store.diagnostic(i.intentId))?.evidence?.reason).toBe("SHUTDOWN");
    expect((await worker.run(i.intentId)).invoked).toBe(false);
  });
  it("diagnostic never returns payload, authorization, or transient contents", async () => {
    const i = await admit();
    const json = JSON.stringify(await store.diagnostic(i.intentId));
    expect(json).not.toContain("file.txt");
    expect(json).not.toContain("authorization");
  });
  it("DENIED under migration021 has no concrete attempt or work", async () => {
    const r = { ...effectRequest(`denied:${++sequence}`), causalRefs: [cause] };
    const auth = effectAuthority();
    auth.snapshot.allowed = false;
    const i = await admission.admit(r, auth);
    expect((await store.diagnostic(i.intentId))?.admission).toBe("DENIED");
    expect((await store.diagnostic(i.intentId))?.currentAttempt).toBeNull();
    expect(await claim(i.intentId)).toBeNull();
  });
  it("currentness revoked inside claim transaction rolls back allocation", async () => {
    const i = await admit();
    let current = true;
    const s = new PostgresEffectDispatchStore(
      faultyPool(async (sql, f) => {
        const r = await f();
        if (sql.startsWith("insert into effect_attempts")) current = false;
        return r;
      })
    );
    await expect(
      s.claim(i.intentId, "yuvi.read-text.v1", "w", 30000, () => current)
    ).rejects.toThrow("authority changed");
    expect((await store.diagnostic(i.intentId))?.currentAttempt).toBeNull();
  });
  it("currentness revoked inside dispatch-start transaction rolls back start", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    let current = true;
    const s = new PostgresEffectDispatchStore(
      faultyPool(async (sql, f) => {
        const r = await f();
        if (sql.startsWith("update effect_attempts set dispatch_started_at")) current = false;
        return r;
      })
    );
    await expect(s.start(a, () => current)).rejects.toThrow("authority changed");
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.dispatchStartedAt).toBeNull();
  });
  it("cancel/start race has a single winning boundary", async () => {
    for (let n = 0; n < 6; n++) {
      const i = await admit(),
        a = (await claim(i.intentId))!;
      const [cancel, started] = await Promise.all([
        store.cancel(i.intentId),
        store.start(a, () => true)
      ]);
      expect(Number(cancel) + Number(started)).toBe(1);
    }
  });
  it("unactivated presentation contract stays with original owner", async () => {
    const i = await admission.admit(
      { ...effectRequest(`presentation:${++sequence}`), causalRefs: [cause] },
      effectAuthority()
    );
    const worker = new EffectDispatcher(store, [
      adapter(async () => {
        throw Error("must not invoke");
      })
    ]);
    expect((await worker.run(i.intentId)).invoked).toBe(false);
    expect((await admission.get(i.intentId))?.workState).toBe("PENDING");
    await worker.shutdown();
  });
  it("worker A returns late after B wakes: one invocation, no stale publication", async () => {
    const i = await admit();
    let release: () => void = () => {},
      calls = 0;
    const gate = new Promise<void>((r) => (release = r));
    const a = adapter(async () => {
      calls++;
      await gate;
      return { evidence: applied, transientResult: "late private result" };
    });
    const x = new EffectDispatcher(store, [a]),
      y = new EffectDispatcher(store, [a]);
    const running = x.run(i.intentId);
    await expect
      .poll(async () => !!(await store.diagnostic(i.intentId))?.currentAttempt?.dispatchStartedAt)
      .toBe(true);
    const d = (await store.diagnostic(i.intentId))!;
    await pool.query(
      "update effect_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where attempt_id=$1",
      [d.currentAttempt!.attemptId]
    );
    expect((await y.run(i.intentId)).invoked).toBe(false);
    release();
    const late = await running;
    expect(late.recorded).toBe(false);
    expect(late.transientResult).toBeUndefined();
    expect(calls).toBe(1);
    expect((await store.diagnostic(i.intentId))?.evidence?.certainty).toBe("UNKNOWN");
    await x.shutdown();
    await y.shutdown();
  });
  it("observation envelope binds exact attempt/fence/adapter and excludes content", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    await store.record(a.attempt, applied);
    const o = (await store.observations(i.intentId))[0]!;
    expect(o).toMatchObject({
      version: "effect-observation.v1",
      attemptId: a.attempt.attemptId,
      fence: a.attempt.fence,
      contractRef: "yuvi.read-text.v1",
      adapter: a.attempt.adapter,
      evidence: applied
    });
    expect(JSON.stringify(o)).not.toContain("file.txt");
  });
  it("repeated concurrent identical admissions retain one decision under dispatch schema", async () => {
    for (let n = 0; n < 12; n++) {
      const r = { ...effectRequest(`replay-stress:${++sequence}`), causalRefs: [cause] };
      const all = await Promise.allSettled(
        Array.from({ length: 24 }, () => admission.admit(r, effectAuthority()))
      );
      for (const result of all)
        if (result.status === "rejected") {
          const cause =
            result.reason instanceof EffectIntentError ? result.reason.causeValue : result.reason;
          throw cause instanceof Error ? cause : Error("Unexpected concurrent admission rejection");
        }
      expect(all.filter((v) => v.status === "fulfilled")).toHaveLength(24);
    }
  });
  it.each([
    "before-claim",
    "after-claim",
    "before-start",
    "after-start",
    "during-call",
    "before-outcome",
    "after-outcome"
  ])("forced shutdown at %s preserves boundary certainty", async (boundary) => {
    const i = await admit();
    let release: () => void = () => {},
      ready: () => void = () => {},
      calls = 0;
    const gate = new Promise<void>((r) => (release = r)),
      reached = new Promise<void>((r) => (ready = r));
    const pause = async () => {
      ready();
      await gate;
    };
    const wrapped: EffectDispatchStore = {
      discover: (...args) => store.discover(...args),
      diagnostic: (id) => store.diagnostic(id),
      observations: (id) => store.observations(id),
      cancel: (id) => store.cancel(id),
      async claim(...args) {
        if (boundary === "before-claim") await pause();
        const v = await store.claim(...args);
        if (boundary === "after-claim") await pause();
        return v;
      },
      async start(...args) {
        if (boundary === "before-start") await pause();
        const v = await store.start(...args);
        if (boundary === "after-start") await pause();
        return v;
      },
      async record(a, e) {
        if (boundary === "before-outcome" && e.reason === "RETURNED") await pause();
        const v = await store.record(a, e);
        if (boundary === "after-outcome" && e.reason === "RETURNED") await pause();
        return v;
      }
    };
    const worker = new EffectDispatcher(wrapped, [
      adapter(async () => {
        calls++;
        if (boundary === "during-call") await pause();
        return { evidence: applied, transientResult: "private" };
      })
    ]);
    const running = worker.run(i.intentId);
    await reached;
    expect(await worker.shutdown(1)).toEqual({ drained: false });
    release();
    const result = await running;
    expect(result.transientResult).toBeUndefined();
    expect(calls).toBe(
      ["during-call", "before-outcome", "after-outcome"].includes(boundary) ? 1 : 0
    );
    const d = await store.diagnostic(i.intentId);
    if (boundary === "after-outcome") expect(d?.certainty).toBe("APPLIED");
    else if (["after-start", "during-call", "before-outcome"].includes(boundary))
      expect(d?.certainty).toBe("UNKNOWN");
    else expect(["NO_DISPATCH", "PROVEN_NOT_APPLIED"]).toContain(d?.certainty);
  });
  it("lease loss after start before invocation prevents the old worker from calling", async () => {
    const i = await admit();
    let calls = 0;
    const a = adapter(
      async () => {
        calls++;
        return { evidence: applied };
      },
      async () => proof
    );
    const replacement = new EffectDispatcher(store, [a]);
    const delayed: EffectDispatchStore = {
      discover: (...args) => store.discover(...args),
      diagnostic: (id) => store.diagnostic(id),
      observations: (id) => store.observations(id),
      cancel: (id) => store.cancel(id),
      claim: (...args) => store.claim(...args),
      record: (...args) => store.record(...args),
      async start(c, current) {
        const v = await store.start(c, current);
        await expireLease(c);
        await replacement.run(i.intentId);
        await replacement.run(i.intentId);
        return v;
      }
    };
    const original = new EffectDispatcher(delayed, [a]);
    expect((await original.run(i.intentId)).invoked).toBe(false);
    expect(calls).toBe(1);
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.attemptOrdinal).toBe("2");
    await original.shutdown();
    await replacement.shutdown();
  });
  it.each(["expiry", "revocation"])(
    "%s after a no-effect reconciliation withholds retry without rewriting evidence",
    async (kind) => {
      const i = await admit(
          kind === "expiry" ? new Date(Date.now() + 160).toISOString() : undefined
        ),
        a = (await claim(i.intentId))!;
      await store.start(a, () => true);
      await store.record(a.attempt, protocolEvidence("CALL_UNCERTAIN", true));
      const b = (await claim(i.intentId, "lookup"))!;
      expect(b.mode).toBe("RECONCILE");
      await store.record(b.attempt, proof);
      if (kind === "expiry") await new Promise((r) => setTimeout(r, 190));
      expect(await claim(i.intentId, "retry", 30000, () => kind !== "revocation")).toBeNull();
      const d = await store.diagnostic(i.intentId);
      expect(d?.evidence).toEqual(proof);
      expect(d?.preDispatchReason).toBe(kind === "expiry" ? "EXPIRED" : "AUTHORITY_REVOKED");
      expect(d?.currentAttempt?.attemptOrdinal).toBe("1");
      expect((await store.discover()).includes(i.intentId)).toBe(false);
    }
  );
  it("migration replay preserves immutable accounting", async () => {
    const i = await admit(),
      a = (await claim(i.intentId))!;
    await store.start(a, () => true);
    await pool.query(
      await readFile(
        new URL("../../memory/migrations/021_effect_attempts_v1.sql", import.meta.url),
        "utf8"
      )
    );
    expect((await store.diagnostic(i.intentId))?.currentAttempt?.attemptId).toBe(
      a.attempt.attemptId
    );
  });
  it.each([
    "before-claim",
    "during-claim",
    "after-claim",
    "during-start",
    "after-start",
    "during-call",
    "after-response",
    "after-outcome"
  ])(
    "real SIGKILL at %s preserves certainty",
    async (boundary) => {
      const i = await admit();
      const marker = join(directory, `target-${++sequence}`);
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
    import {appendFile} from 'node:fs/promises';import pg from 'pg';import {PostgresEffectDispatchStore} from ${JSON.stringify(new URL("../dist/dispatch-store.js", import.meta.url).href)};
    const pool=new pg.Pool({connectionString:process.env.YUVI_EFFECT_TEST_DATABASE_URL,options:'-c search_path=${schema},public'});
    import {FaultPlan} from ${JSON.stringify(new URL("../../../scripts/conformance/fault-surface.mjs", import.meta.url).href)};
    const faults=new FaultPlan();faults.arm('kill-boundary','IPC');
    async function stop(){await faults.hit('kill-boundary');}
    const wrapped={async connect(){const c=await pool.connect();return {async query(sql,values){const r=await c.query(sql,values);if(${JSON.stringify(boundary)}==='during-claim' && sql.startsWith('insert into effect_attempts') || ${JSON.stringify(boundary)}==='during-start' && sql.startsWith('update effect_attempts set dispatch_started_at'))await stop();return r;},release(){c.release();}};}};
    const s=new PostgresEffectDispatchStore(wrapped);
    if(${JSON.stringify(boundary)}==='before-claim')await stop();
    const c=await s.claim(${JSON.stringify(i.intentId)},'yuvi.read-text.v1','child',30000,()=>true);
    if(${JSON.stringify(boundary)}==='after-claim')await stop();
    await s.start(c,()=>true);
    if(${JSON.stringify(boundary)}==='after-start')await stop();
    await appendFile(${JSON.stringify(marker)},${JSON.stringify("invoked\n")});
    if(['during-call','after-response'].includes(${JSON.stringify(boundary)}))await stop();
    await s.record(c.attempt,${JSON.stringify(applied)});await stop();
  `
        ],
        { env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] }
      );
      await waitForCheckpoint(child, "kill-boundary");
      const dead = new Promise((r) => child.once("exit", r));
      child.kill("SIGKILL");
      await dead;
      const fresh = new PostgresEffectDispatchStore(pool);
      const d = await fresh.diagnostic(i.intentId);
      if (["before-claim", "during-claim"].includes(boundary)) {
        expect(d?.workState).toBe("PENDING");
        expect(d?.currentAttempt).toBeNull();
      } else if (["after-claim", "during-start"].includes(boundary)) {
        expect(d?.currentAttempt?.dispatchStartedAt).toBeNull();
      } else if (["after-start", "during-call", "after-response"].includes(boundary)) {
        expect(d?.reconciliationRequired).toBe(true);
        expect(d?.evidence).toBeNull();
      } else expect(d?.evidence?.certainty).toBe("APPLIED");
      const invocations = await readFile(marker, "utf8").catch(() => "");
      expect(invocations).toBe(
        ["during-call", "after-response", "after-outcome"].includes(boundary) ? "invoked\n" : ""
      );
    },
    10000
  );
});
