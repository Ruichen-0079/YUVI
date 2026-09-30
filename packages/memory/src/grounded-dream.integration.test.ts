import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readSqlMigrations } from "./migrations.js";
import { PostgresRecentEpisodeStore } from "./recent-episode-store.js";
import { PostgresDreamJobStore, DreamConsolidationEngine } from "./dream-consolidation.js";
import { assembleDreamFixtureEpisodes } from "./dream-test-fixture.js";
import type { ConversationMessage } from "./conversation-repository.js";
function sourceMessage(id: string): ConversationMessage {
  return {
    id,
    sessionId: `s-${id}`,
    role: "user",
    status: "completed",
    content: "Please remember: I prefer tea 🍵.",
    traceId: `trace-${id}`,
    parentMessageId: null,
    createdAt: "2026-09-30T08:01:00Z",
    completedAt: "2026-09-30T08:01:00Z",
    metadata: {},
    sequence: 1
  };
}
import { withEpisodeEvidence, episodeEvidenceDigest } from "./episode-source-evidence.js";
import { canonicalLineageJson } from "./lineage-encoding.js";
import { stampDreamWriteEvent } from "./dream-delivery.js";
const url = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `a10_1e_${randomBytes(6).toString("hex")}`;
const now = new Date("2026-09-30T08:01:00Z");
let admin: Pool, pool: Pool, store: PostgresRecentEpisodeStore, jobs: PostgresDreamJobStore;
function episode(id: string) {
  return assembleDreamFixtureEpisodes({ messages: [sourceMessage(id)], now })[0]!;
}

describe.skipIf(!url)("A10.1e real PostgreSQL episode/Dream persistence", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: url! });
    await admin.query(`create schema ${schema}`);
    pool = new Pool({ connectionString: url!, options: `-c search_path=${schema},public` });
    const migrations = await readSqlMigrations();
    for (const migration of migrations.filter((entry) => !entry.name.startsWith("016")))
      await pool.query(migration.sql);
    const old = episode("old");
    await pool.query(
      `insert into recent_episodes(episode_id,session_id,started_at,ended_at,recorded_at,temporal_confidence,status,source_turn_ids,source_digest,what_happened,user_statements,expires_at)
      values($1,$2,$3,$3,$3,'high','active',$4,$5,$6,$7,$8)`,
      [
        old.id,
        old.sessionId,
        now.toISOString(),
        JSON.stringify(old.sourceTurnIds),
        old.sourceDigest,
        old.whatHappened,
        JSON.stringify(old.userStatements),
        old.expiresAt
      ]
    );
    const migration = migrations.find((entry) => entry.name.startsWith("016"))!;
    await pool.query(migration.sql);
    await pool.query(migration.sql);
    store = new PostgresRecentEpisodeStore(pool);
    jobs = new PostgresDreamJobStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  });
  it("migrates twice without backfill and fences stable historical upserts", async () => {
    const old = episode("old");
    const loaded = await store.getById(old.id);
    expect(loaded?.sourceEvidence).toBeNull();
    expect(loaded?.sourceCoverage).toBe("LEGACY_INCOMPLETE");
    const reconstructed = await store.upsert(old);
    expect(reconstructed.sourceCoverage).toBe("LEGACY_INCOMPLETE");
    expect(reconstructed.sourceEvidence?.statements).toEqual([]);
    const newer = episode("old-new");
    const extended = withEpisodeEvidence(
      { ...old, sourceTurnIds: [...old.sourceTurnIds, ...newer.sourceTurnIds] },
      {
        ...old.sourceEvidence!,
        statements: [...old.sourceEvidence!.statements, ...newer.sourceEvidence!.statements]
      }
    );
    const merged = await store.upsert(extended);
    expect(merged.sourceCoverage).toBe("PARTIAL");
    expect(merged.sourceEvidence!.statements.map((entry) => entry.sourceMessageId)).toEqual([
      "old-new"
    ]);
  });
  it.each(["UNKNOWN", "INSTANT", "INTERVAL"] as const)(
    "round-trips exact Unicode selector, authority and %s occurrence",
    async (state) => {
      const input = episode(`time-${state}`);
      const entry = input.sourceEvidence!.statements[0]!;
      entry.source!.sourceTime.occurrenceTime =
        state === "UNKNOWN"
          ? { state }
          : state === "INSTANT"
            ? {
                state,
                at: "2026-09-29T00:00:00+08:00",
                clockSource: "source-clock",
                uncertaintyMs: 2
              }
            : {
                state,
                start: "2026-09-29T00:00:00+08:00",
                end: "2026-09-29T01:00:00+08:00",
                clockSource: "source-clock",
                uncertaintyMs: 3
              };
      input.sourceEvidenceDigest = episodeEvidenceDigest(input.sourceEvidence!);
      const stored = await store.upsert(input);
      expect(stored.sourceEvidence).toEqual(input.sourceEvidence);
      expect((await store.getById(input.id))?.sourceEvidenceDigest).toBe(
        input.sourceEvidenceDigest
      );
      const reorder = {
        ...input.sourceEvidence!,
        statements: [...input.sourceEvidence!.statements].reverse()
      };
      expect(episodeEvidenceDigest(reorder)).toBe(input.sourceEvidenceDigest);
      const changed = structuredClone(input);
      changed.sourceEvidence!.statements[0]!.source!.ref.eventId = "jev1_bbbbbbbbbbbbbbbb";
      await expect(store.upsert(changed)).rejects.toThrow("EPISODE_SOURCE_CONFLICT");
    }
  );
  it("persists source snapshot/results across reopen; keyed reconciliation never re-derives", async () => {
    const input = await store.upsert(episode("restart"));
    const write = vi.fn().mockResolvedValue({ status: "rejected", failureClass: "ambiguous" });
    const engine = new DreamConsolidationEngine(jobs, store, {
      provider: { writeEventIdempotent: write, reconcileEvent: async () => ({ status: "applied" }) }
    });
    const admitted = await engine.consider({
      episode: input,
      existing: [input],
      now,
      explicitImportance: true
    });
    const first = await engine.runJob(admitted.job!, now, "first");
    expect(first.status).toBe("reconcile_required");
    const reopenedPool = new Pool({
      connectionString: url!,
      options: `-c search_path=${schema},public`
    });
    try {
      const reopenedJobs = new PostgresDreamJobStore(reopenedPool),
        reopenedStore = new PostgresRecentEpisodeStore(reopenedPool);
      const loaded = (await reopenedJobs.getById(first.jobId))!;
      expect(loaded.sourceSnapshot).toEqual(first.sourceSnapshot);
      expect(loaded.resultEventPayloads).toEqual(first.resultEventPayloads);
      const restarted = new DreamConsolidationEngine(reopenedJobs, reopenedStore, {
        provider: {
          writeEventIdempotent: write,
          reconcileEvent: async () => ({ status: "applied" })
        }
      });
      expect((await restarted.reconcileJob(loaded, now, "restart")).status).toBe("complete");
      expect(write).toHaveBeenCalledTimes(1);
      const conflicting = {
        ...loaded,
        resultEventPayloads: [{ ...loaded.resultEventPayloads![0]!, content: "conflict" }]
      };
      await expect(reopenedJobs.save(conflicting)).rejects.toThrow("DREAM_FROZEN_PAYLOAD_CONFLICT");
    } finally {
      await reopenedPool.end();
    }
  });
  it("claims once, reclaims pre-dispatch, then fences frozen children before mutable episode reads", async () => {
    const input = await store.upsert(episode("claims"));
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => events.map(() => ({ status: "written" }))
    });
    const considered = await engine.consider({
      episode: input,
      existing: [input],
      now,
      explicitImportance: true
    });
    const claim = { jobId: considered.job!.jobId, now, leaseOwner: "one", leaseMs: 1 };
    const [a, b] = await Promise.all([
      jobs.claimJob(claim),
      jobs.claimJob({ ...claim, leaseOwner: "two" })
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const later = new Date(now.getTime() + 100);
    const completed = await engine.runJob((a ?? b)!, later, "restart");
    expect(completed.status).toBe("complete");
    await jobs.save({ ...completed, status: "processing", leaseExpiresAt: now.toISOString() });
    const spy = vi.spyOn(store, "getById").mockRejectedValue(new Error("no re-derivation"));
    const recovered = await engine.runJob({ ...completed, status: "processing" }, later, "recover");
    expect(recovered.status).toBe("reconcile_required");
    expect(recovered.resultEventPayloads).toEqual(completed.resultEventPayloads);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it("fences consolidation against an episode source revision changed during delivery", async () => {
    const input = await store.upsert(episode("during-delivery")),
      added = episode("during-added");
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => {
        await store.upsert(
          withEpisodeEvidence(
            { ...input, sourceTurnIds: [...input.sourceTurnIds, ...added.sourceTurnIds] },
            {
              ...input.sourceEvidence!,
              statements: [...input.sourceEvidence!.statements, ...added.sourceEvidence!.statements]
            }
          )
        );
        return events.map(() => ({ status: "written" }));
      }
    });
    const admitted = await engine.consider({
      episode: input,
      existing: [input],
      now,
      explicitImportance: true
    });
    expect((await engine.runJob(admitted.job!, now, "delivery")).status).toBe("complete");
    expect((await store.getById(input.id))?.status).toBe("active");
  });
  it("never newly delivers historical ungrounded not-applied payloads", async () => {
    const input = episode("legacy-job");
    const engine = new DreamConsolidationEngine(jobs, store);
    const considered = await engine.consider({
      episode: input,
      existing: [input],
      now,
      explicitImportance: true
    });
    const old = {
      ...considered.job!,
      jobId: "old-frozen-job",
      sourceDigest: "a".repeat(64),
      sourceSnapshot: null,
      status: "reconcile_required" as const,
      resultEventPayloads: [
        stampDreamWriteEvent("old-frozen-job", {
          kind: "fact" as const,
          content: "historical",
          scope: "user"
        })
      ]
    };
    await jobs.save(old);
    const write = vi.fn();
    const restarted = new DreamConsolidationEngine(jobs, store, {
      provider: {
        writeEventIdempotent: write,
        reconcileEvent: async () => ({ status: "not_applied" })
      }
    });
    const result = await restarted.reconcileJob((await jobs.getById(old.jobId))!, now, "restart");
    expect(result.lastErrorCode).toBe("DREAM_LEGACY_LINEAGE_MISSING");
    expect(write).not.toHaveBeenCalled();
    expect(canonicalLineageJson(result.resultEventPayloads)).not.toContain("lineage");
  });
});
