import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "../../journal/src/index.js";
import { HostEffectIntentAdmission } from "../src/admission.js";
import { PostgresEffectIntentStore } from "../src/store.js";
import { effectIntentId } from "../src/model.js";
import { effectAuthority, effectRequest, fixtureIdentity } from "../src/test-fixture.js";

const url = process.env["YUVI_EFFECT_TEST_DATABASE_URL"];
const schema = `effect_test_${randomBytes(6).toString("hex")}`;
let admin: Pool, pool: Pool, store: PostgresEffectIntentStore, port: HostEffectIntentAdmission;
let cause: ReturnType<typeof effectRequest>["causalRefs"][number];
let journal: PostgresJournalRepository;
const migration = await readFile(
  new URL("../../memory/migrations/020_effect_intents_v1.sql", import.meta.url),
  "utf8"
);
function request(key: string) {
  return { ...effectRequest(key), causalRefs: [cause] };
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

describe.skipIf(!url)("A9.1 real PostgreSQL atomic intent/outbox", () => {
  beforeAll(async () => {
    admin = createPostgresPool(url!);
    await admin.query(`create schema "${schema}"`);
    pool = createPostgresPool(url!, { options: `-c search_path=${schema},public` });
    // Apply Journal and A9 migrations in an isolated namespace. The task database also runs all migrations.
    await pool.query(
      await readFile(
        new URL("../../memory/migrations/013_life_event_journal_v1.sql", import.meta.url),
        "utf8"
      )
    );
    await pool.query(migration);
    journal = new PostgresJournalRepository(pool, {
      namespace: "test:effects",
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
        surface: { kind: "LOCAL", reference: "test:control" },
        correlations: [],
        policyVersion: "host-test.v1",
        producer: { name: "host-test", version: "1" },
        sourceReferences: [
          { kind: "UNRESOLVED_SOURCE", reason: "synthetic local control fixture" }
        ],
        payloads: []
      }
    );
    cause = {
      kind: "JOURNAL_EVENT",
      namespace: receipt.envelope.journalNamespace,
      eventId: receipt.envelope.eventId
    };
    store = new PostgresEffectIntentStore(pool);
    port = new HostEffectIntentAdmission(store, journal);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  it("migration replay preserves constraints and existing pending work", async () => {
    const v = await port.admit(request("migration-replay"), effectAuthority());
    await pool.query(migration);
    expect((await port.get(v.intentId))?.workState).toBe("PENDING");
    const checks = await pool.query(
      "select count(*)::int n from pg_constraint where conrelid='effect_intents'::regclass"
    );
    expect(checks.rows[0]?.n).toBeGreaterThanOrEqual(8);
  });
  it("24 concurrent identical admissions return exactly one durable intent/work", async () => {
    const all = await Promise.all(
      Array.from({ length: 24 }, () => port.admit(request("identical"), effectAuthority()))
    );
    expect(new Set(all.map((v) => v.intentId)).size).toBe(1);
    expect(
      (
        await pool.query(
          "select count(*)::int n from effect_intents where logical_key='identical' and work_state='PENDING'"
        )
      ).rows[0]?.n
    ).toBe(1);
  });
  it("16 concurrent conflicts elect one winner and 15 typed conflicts", async () => {
    const all = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        port.admit(
          {
            ...request("conflicts"),
            expiresAt: `2099-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`
          },
          effectAuthority()
        )
      )
    );
    expect(all.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    const rejected = all.filter((v) => v.status === "rejected");
    expect(rejected).toHaveLength(15);
    for (const v of rejected) if (v.status === "rejected") expect(v.reason.code).toBe("CONFLICT");
  });
  it("denied decisions are durable, replayable, payload-free and have no outbox", async () => {
    const a = effectAuthority();
    a.snapshot.allowed = false;
    const r = request("denied");
    const denied = await port.admit(r, a);
    const reopened = new HostEffectIntentAdmission(new PostgresEffectIntentStore(pool), journal);
    expect(await reopened.admit(r, effectAuthority())).toEqual(denied);
    expect(denied.request).not.toHaveProperty("payload");
    expect(
      (
        await pool.query("select work_state from effect_intents where intent_id=$1", [
          denied.intentId
        ])
      ).rows[0]?.work_state
    ).toBeNull();
  });
  it("one row cannot contain admitted intent without work or work without admission", async () => {
    const v = await port.admit(request("atomic-constraints"), effectAuthority());
    await expect(
      pool.query("update effect_intents set work_state=null where intent_id=$1", [v.intentId])
    ).rejects.toThrow();
    await expect(
      pool.query(
        'update effect_intents set intent=intent || \'{"payloadDigest":"forged"}\'::jsonb where intent_id=$1',
        [v.intentId]
      )
    ).rejects.toThrow(/IMMUTABLE/);
    const record = (
      await pool.query("select * from effect_intents where intent_id=$1", [v.intentId])
    ).rows[0]!;
    await expect(
      pool.query(
        `insert into effect_intents select $1, logical_key || '-broken', contract_ref,
      payload_digest, intent || jsonb_build_object('intentId',$1::text,'logicalKey',logical_key || '-broken'),
      'ADMITTED',null,expires_at,created_at from effect_intents where intent_id=$2`,
        ["ei1_" + "f".repeat(64), v.intentId]
      )
    ).rejects.toThrow();
    expect(record.work_state).toBe("PENDING");
  });
  it.each(["before", "insert", "after-insert", "commit"])(
    "%s transaction failure leaves zero partial intent/work",
    async (point) => {
      const key = `fault-${point}`;
      const r = request(key);
      const broken =
        point === "before"
          ? ({
              async connect() {
                throw Error("offline");
              }
            } as unknown as Pool)
          : faultyPool(async (sql, forward) => {
              if (
                (point === "insert" && sql.startsWith("insert")) ||
                (point === "commit" && sql === "commit")
              )
                throw Error("injected transaction failure");
              const result = await forward();
              if (point === "after-insert" && sql.startsWith("insert"))
                throw Error("after atomic row, before commit");
              return result;
            });
      await expect(
        new HostEffectIntentAdmission(new PostgresEffectIntentStore(broken), journal).admit(
          r,
          effectAuthority()
        )
      ).rejects.toMatchObject({ code: point === "before" ? "UNAVAILABLE" : "PERSISTENCE_FAILED" });
      expect(await port.get(effectIntentId(r.contractRef, key))).toBeNull();
    }
  );
  it("lost commit response returns a system failure; exact replay finds committed work", async () => {
    const r = request("lost-commit-response");
    const broken = faultyPool(async (sql, forward) => {
      const result = await forward();
      if (sql === "commit") throw Error("commit response lost");
      return result;
    });
    await expect(
      new HostEffectIntentAdmission(new PostgresEffectIntentStore(broken), journal).admit(
        r,
        effectAuthority()
      )
    ).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
    const replay = await port.admit(r, effectAuthority());
    expect(replay.workState).toBe("PENDING");
    expect(
      (
        await pool.query("select count(*)::int n from effect_intents where logical_key=$1", [
          r.logicalKey
        ])
      ).rows[0]?.n
    ).toBe(1);
  });
  it("Runtime fence revocation between insert and commit rolls back", async () => {
    const a = effectAuthority();
    let current = true;
    a.isCurrent = () => current;
    const broken = faultyPool(async (sql, forward) => {
      const result = await forward();
      if (sql.startsWith("insert")) current = false;
      return result;
    });
    const r = request("late-revocation");
    await expect(
      new HostEffectIntentAdmission(new PostgresEffectIntentStore(broken), journal).admit(r, a)
    ).rejects.toMatchObject({ code: "AUTHORITY_CHANGED" });
    expect(await port.get(effectIntentId(r.contractRef, r.logicalKey))).toBeNull();
  });
  it("submits COMMIT synchronously after the final host fence, with no microtask gap", async () => {
    let current = true;
    let checks = 0;
    const authority = effectAuthority();
    authority.isCurrent = () => {
      if (++checks === 2)
        queueMicrotask(() => {
          current = false;
        });
      return current;
    };
    let currentAtSubmission: boolean | undefined;
    const observed = faultyPool(async (sql, forward) => {
      if (sql === "commit") currentAtSubmission = current;
      return forward();
    });
    const admitted = await new HostEffectIntentAdmission(
      new PostgresEffectIntentStore(observed),
      journal
    ).admit(request("no-fence-submission-gap"), authority);
    expect(checks).toBe(2);
    expect(currentAtSubmission).toBe(true);
    expect(current).toBe(false);
    expect((await port.get(admitted.intentId))?.workState).toBe("PENDING");
  });
  it("cancel/admit replay race cannot reactivate canceled work", async () => {
    const r = request("cancel-race");
    const v = await port.admit(r, effectAuthority());
    await Promise.all([
      port.cancel(v.intentId),
      ...Array.from({ length: 8 }, () => port.admit(r, effectAuthority()))
    ]);
    expect((await port.get(v.intentId))?.state).toBe("CANCELED");
    expect((await port.admit(r, effectAuthority())).workState).toBe("WITHHELD");
  });
  it("initial admission racing cancellation has a serializable pre-attempt result", async () => {
    const r = request("initial-cancel-race");
    const id = effectIntentId(r.contractRef, r.logicalKey);
    const [admitted, canceled] = await Promise.all([
      port.admit(r, effectAuthority()),
      port.cancel(id)
    ]);
    const current = await port.get(id);
    // Cancellation before the initial insert may observe absence; it never claims cancellation succeeded.
    if (canceled === null) expect(current?.workState).toBe("PENDING");
    else {
      expect(canceled.state).toBe("CANCELED");
      expect(current?.workState).toBe("WITHHELD");
    }
    await port.cancel(admitted.intentId);
    expect((await port.admit(r, effectAuthority())).state).toBe("CANCELED");
  });
  it("future first-claim fence and cancellation cannot both win", async () => {
    for (let n = 0; n < 10; n++) {
      const v = await port.admit(request(`claim-cancel-${n}`), effectAuthority());
      const [claim] = await Promise.all([
        pool.query(
          `update effect_intents set work_state='CLAIMED' where intent_id=$1 and state='ADMITTED'
          and work_state='PENDING' and expires_at > clock_timestamp() returning intent_id`,
          [v.intentId]
        ),
        port.cancel(v.intentId)
      ]);
      const current = await port.get(v.intentId);
      if (claim.rows.length) expect(current?.workState).toBe("CLAIMED");
      else expect(current?.state).toBe("CANCELED");
    }
  });
  it("expiry sweep and cancellation race with terminal non-dispatchable work", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const v = await port.admit({ ...request("expiry-cancel"), expiresAt }, effectAuthority());
    // Advance PostgreSQL observation time by updating only the test session clock comparison stimulus,
    // without changing immutable semantic expiry: use an owner deadline then pg_sleep once below.
    const short = {
      ...request("short-expiry"),
      expiresAt: new Date(Date.now() + 300).toISOString()
    };
    const e = await port.admit(short, effectAuthority());
    await pool.query("select pg_sleep(0.35)");
    expect((await port.listPending()).some((x) => x.intentId === e.intentId)).toBe(false);
    await Promise.all([port.expire(), port.cancel(e.intentId)]);
    expect(["CANCELED", "EXPIRED"]).toContain((await port.get(e.intentId))?.state);
    await port.cancel(v.intentId);
    expect((await port.admit(short, effectAuthority())).workState).toBe("WITHHELD");
  });
  it("pool close/reopen preserves pending and canceled decisions and exact Journal causality", async () => {
    const pending = await port.admit(request("reopen-pending"), effectAuthority());
    const canceled = await port.admit(request("reopen-canceled"), effectAuthority());
    await port.cancel(canceled.intentId);
    await pool.end();
    pool = createPostgresPool(url!, { options: `-c search_path=${schema},public` });
    store = new PostgresEffectIntentStore(pool);
    journal = new PostgresJournalRepository(pool, {
      namespace: "test:effects",
      authorityBuilder() {
        throw Error("host only");
      }
    });
    port = new HostEffectIntentAdmission(store, journal);
    expect((await port.get(pending.intentId))?.workState).toBe("PENDING");
    expect((await port.get(pending.intentId))?.request.causalRefs).toEqual([cause]);
    expect((await port.get(canceled.intentId))?.state).toBe("CANCELED");
  });
  it("process death after INSERT before COMMIT rolls back the complete intent/work row", async () => {
    const r = request("killed-before-commit");
    const script = `import { createPostgresPool } from '../../database/dist/index.js';
      import { HostEffectIntentAdmission, PostgresEffectIntentStore } from '../dist/index.js';
      import { PostgresJournalRepository } from '../../journal/dist/index.js';
      const p=createPostgresPool(process.env.YUVI_EFFECT_TEST_DATABASE_URL,{options:'-c search_path=${schema},public'});
      const j=new PostgresJournalRepository(p,{namespace:'test:effects',authorityBuilder(){throw Error('host only')}});
      const fault={async connect(){const c=await p.connect(); return {
        async query(sql,values){const result=await c.query(sql,values);
          if(sql.startsWith('insert')) process.kill(process.pid,'SIGKILL'); return result;}, release(){c.release();}};}};
      await new HostEffectIntentAdmission(new PostgresEffectIntentStore(fault),j).admit(${JSON.stringify(r)},
        {snapshot:${JSON.stringify(effectAuthority().snapshot)},isCurrent:()=>true});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL(".", import.meta.url),
      env: process.env
    });
    let errors = "";
    child.stderr.on("data", (x) => (errors += x));
    const result = await new Promise<string | null>((resolve) =>
      child.on("exit", (_code, signal) => resolve(signal))
    );
    expect(errors).toBe("");
    expect(result).toBe("SIGKILL");
    expect(await port.get(effectIntentId(r.contractRef, r.logicalKey))).toBeNull();
    expect((await port.admit(r, effectAuthority())).workState).toBe("PENDING");
  });
  it("process death immediately after COMMIT leaves recoverable pending work", async () => {
    const r = request("killed-after-commit");
    // A fresh child admits through the real host facade; exits via SIGKILL after committed return.
    const script = `import { createPostgresPool } from '../../database/dist/index.js';
      import { HostEffectIntentAdmission, PostgresEffectIntentStore } from '../dist/index.js';
      import { PostgresJournalRepository } from '../../journal/dist/index.js';
      const p=createPostgresPool(process.env.YUVI_EFFECT_TEST_DATABASE_URL,{options:'-c search_path=${schema},public'});
      const j=new PostgresJournalRepository(p,{namespace:'test:effects',authorityBuilder(){throw Error('host only')}});
      const a=${JSON.stringify(effectAuthority().snapshot)};
      await new HostEffectIntentAdmission(new PostgresEffectIntentStore(p),j).admit(${JSON.stringify(r)},{snapshot:a,isCurrent:()=>true});
      process.kill(process.pid,'SIGKILL');`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL(".", import.meta.url),
      env: process.env
    });
    let errors = "";
    child.stderr.on("data", (x) => (errors += x));
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal }))
    );
    expect(errors).toBe("");
    expect(result.signal).toBe("SIGKILL");
    const recovered = await port.admit(r, effectAuthority());
    expect(recovered.workState).toBe("PENDING");
    await port.cancel(recovered.intentId);
    await port.expire();
  });
});
