import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { readSqlMigrations, PostgresContextUseRepository } from "@companion/memory";
import { PostgresEffectDispatchStore, EffectDispatcher } from "@companion/effects";
import { PostgresJournalRepository } from "@companion/journal";
import { waitForCheckpoint } from "../../../scripts/conformance/fault-surface.mjs";
const url = process.env["YUVI_EFFECT_TEST_DATABASE_URL"];
if (process.env["YUVI_REQUIRE_DURABLE_CONFORMANCE"] === "1" && !url)
  throw Error("Release conformance requires real PostgreSQL; skips are forbidden");
const schema = `a112_${randomBytes(6).toString("hex")}`;
let admin: PostgresPool,
  pool: PostgresPool,
  directory: string,
  sequence = 0;
const contracts = {
  provider: "yuvi.provider.v1",
  publication: "yuvi.publication.v1",
  presentation: "yuvi.embodied-presentation.v1"
} as const;
type Mode = keyof typeof contracts;
const providerPoints = [
  "receipt.before",
  "receipt.commit.before",
  "receipt.commit.after",
  "receipt.after",
  "manifest.before",
  "manifest.commit.before",
  "manifest.commit.after",
  "manifest.after",
  "intent.before",
  "intent.commit.before",
  "intent.commit.after",
  "intent.after",
  "attempt.before",
  "attempt.after",
  "dispatch-start.before",
  "dispatch-start.after",
  "external-effect.before",
  "external-effect.after",
  "observation.before",
  "observation.after"
];
describe.skipIf(!url)("A11.2 retained host chain SIGKILL/reopen conformance", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "yuvi-a112-"));
    admin = createPostgresPool(url!);
    await admin.query(`create schema "${schema}"`);
    pool = createPostgresPool(url!, { options: `-c search_path=${schema},public` });
    for (const m of await readSqlMigrations()) await pool.query(m.sql);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop schema "${schema}" cascade`);
    await admin?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function killed(mode: Mode, point: string) {
    const execution = `execution-${++sequence}`,
      marker = join(directory, execution);
    const child = spawn(
      process.execPath,
      [new URL("../../../scripts/conformance/chain-worker.mjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          YUVI_CONFORMANCE_EXECUTION: execution,
          YUVI_CONFORMANCE_MODE: mode,
          YUVI_CONFORMANCE_POINT: point,
          YUVI_CONFORMANCE_SCHEMA: schema,
          YUVI_CONFORMANCE_MARKER: marker
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      }
    );
    try {
      await waitForCheckpoint(child, point);
    } finally {
      const dead = new Promise((r) => child.once("exit", r));
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await dead;
      }
    }
    const fresh = createPostgresPool(url!, { options: `-c search_path=${schema},public` });
    try {
      const rows = await fresh.query(
        "select intent_id,intent from effect_intents where contract_ref=$1 and intent->'request'->>'scope'=$2",
        [
          contracts[mode],
          mode === "presentation" ? `presentation:${execution}` : `session:${execution}`
        ]
      );
      const row = rows.rows[0];
      const store = new PostgresEffectDispatchStore(fresh);
      const diagnostic = row ? await store.diagnostic(row.intent_id) : null;
      const effects = await readFile(marker, "utf8").catch(() => "");
      const afterEffect = [
        "external-effect.after",
        "observation.before",
        "observation.after",
        "finished"
      ].includes(point);
      expect(effects).toBe(afterEffect ? "invoked\n" : "");
      if (afterEffect) expect(diagnostic?.currentAttempt?.dispatchStartedAt).toBeTruthy();
      if (
        [
          "dispatch-start.after",
          "external-effect.before",
          "external-effect.after",
          "observation.before"
        ].includes(point)
      ) {
        expect(diagnostic?.certainty).toBe("UNKNOWN");
        // Test-only lease expiry wakes the actual reconciliation path without timing sleeps.
        await fresh.query(
          "update effect_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where intent_id=$1",
          [row.intent_id]
        );
        let resends = 0;
        const dispatcher = new EffectDispatcher(store, [
          {
            contractRef: contracts[mode],
            adapter:
              mode === "provider"
                ? "yuvi.provider-leaf.v1"
                : mode === "publication"
                  ? "yuvi.target-publication.v1"
                  : "yuvi.presentation-bridge.v1",
            isCurrent: () => true,
            invoke: async () => {
              resends++;
              throw Error("Blind replay");
            }
          }
        ]);
        await dispatcher.run(row.intent_id);
        await dispatcher.run(row.intent_id);
        expect(resends).toBe(0);
        expect((await store.diagnostic(row.intent_id))?.certainty).toBe("UNKNOWN");
        await dispatcher.shutdown();
      }
      if (point === "observation.after" || point === "finished")
        expect(diagnostic?.certainty).toBe("APPLIED");
      if (mode === "provider") {
        const receipts = await fresh.query(
          "select event_id from journal_events where journal_namespace=$1",
          [execution]
        );
        const manifests = await fresh.query(
          "select manifest_id from context_use_manifests where body->>'executionId'=$1",
          [execution]
        );
        if (["receipt.before", "receipt.commit.before"].includes(point))
          expect(receipts.rows).toHaveLength(0);
        if (["manifest.before", "manifest.commit.before"].includes(point))
          expect(manifests.rows).toHaveLength(0);
        if (["intent.before", "intent.commit.before"].includes(point))
          expect(rows.rows).toHaveLength(0);
        if (
          providerPoints.indexOf(point) >= providerPoints.indexOf("receipt.commit.after") ||
          point === "finished"
        )
          expect(receipts.rows).toHaveLength(1);
        if (
          providerPoints.indexOf(point) >= providerPoints.indexOf("manifest.commit.after") ||
          point === "finished"
        )
          expect(manifests.rows).toHaveLength(1);
        if (
          providerPoints.indexOf(point) >= providerPoints.indexOf("intent.commit.after") ||
          point === "finished"
        )
          expect(rows.rows).toHaveLength(1);
        if (row) {
          const ref = row.intent.request.causalRefs[0];
          const journal = new PostgresJournalRepository(fresh, {
            namespace: execution,
            authorityBuilder() {
              throw Error("No new receipt");
            }
          });
          expect(await journal.get(ref)).not.toBeNull();
          const retained = await new PostgresContextUseRepository(fresh).get(
            row.intent.request.payload.inputSnapshot.manifest.manifestId
          );
          expect(retained?.exposures).toHaveLength(1);
          expect(retained?.manifest.executionId).toBe(execution);
          expect(retained?.manifest.sources[0]?.roots.map((r) => JSON.parse(r))).toContainEqual(
            ref
          );
        }
      }
    } finally {
      await fresh.end();
    }
  }
  it.each(providerPoints)(
    "I1/I3/I4/I5 provider process death at %s",
    (point) => killed("provider", point),
    15000
  );
  for (const mode of ["publication", "presentation"] as const)
    it.each([
      "dispatch-start.before",
      "dispatch-start.after",
      "external-effect.before",
      "external-effect.after",
      "observation.before",
      "observation.after"
    ])(`I1/I3/I4 ${mode} process death at %s`, (point) => killed(mode, point), 15000);
  it(
    "I1 publication admission is durable before writing a component",
    () => killed("publication", "publication-admission.after"),
    15000
  );
  it(
    "I5 complete retained receipt/manifest/exposure/intent/attempt/outcome after reopen",
    () => killed("provider", "finished"),
    15000
  );
  it("fresh migration 022 is not mistaken for a later schema visible through search_path", async () => {
    const isolated = `${schema}_fresh`;
    await admin.query(`create schema "${isolated}"`);
    const fresh = createPostgresPool(url!, {
      options: `-c search_path=${isolated},${schema},public`
    });
    try {
      for (const migration of await readSqlMigrations())
        if (/^02[012]_/.test(migration.name)) await fresh.query(migration.sql);
      const constraint = await fresh.query(
        "select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='effect_intents'::regclass and conname='effect_intents_contract_ref_check'"
      );
      expect(constraint.rows[0]?.definition).toContain("yuvi.native-control.v1");
      expect(constraint.rows[0]?.definition).not.toContain("yuvi.provider.v1");
    } finally {
      await fresh.end();
      await admin.query(`drop schema "${isolated}" cascade`);
    }
  });
  it("populated A9.3 provider/publication/presentation survives the full packaged migration replay", async () => {
    for (const mode of ["provider", "publication", "presentation"] as const)
      await killed(mode, "finished");
    const before = await pool.query(
      "select intent_id,intent from effect_intents order by intent_id"
    );
    for (const migration of await readSqlMigrations()) await pool.query(migration.sql);
    expect(
      (await pool.query("select intent_id,intent from effect_intents order by intent_id")).rows
    ).toEqual(before.rows);
    const store = new PostgresEffectDispatchStore(pool);
    for (const intent of before.rows)
      expect(await store.diagnostic(intent.intent_id)).not.toBeNull();
  }, 15000);
});
