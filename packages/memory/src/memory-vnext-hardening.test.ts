import { assembleDreamFixtureEpisodes } from "./dream-test-fixture.js";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { activateAssociativeMemories } from "./associative-recall.js";
import type { ConversationMessage } from "./conversation-repository.js";
import { CONTEXT_COMPRESSION_RUNTIME_STATUS } from "./context-compression.js";
import {
  DreamConsolidationEngine,
  InMemoryDreamJobStore,
  PostgresDreamJobStore
} from "./dream-consolidation.js";
import { DREAM_DELIVERY_KEY_PREFIX } from "./dream-delivery.js";
import { assembleMemoryVNextContext } from "./memory-vnext.js";
import { runPostgresMigrations } from "./migrations.js";
import { normalizePostgresConnectionString } from "./postgres-connection.js";
import type { MemoryProvider, MemoryWriteEventOutcome } from "./provider.js";
import {
  assembleRecentEpisodes,
  ASSISTANT_CONTEXT_DISCLAIMER,
  formatRecentEpisodeForPrompt,
  sourceTurnIdsOverlap
} from "./recent-episode.js";
import { InMemoryRecentEpisodeStore, PostgresRecentEpisodeStore } from "./recent-episode-store.js";

const now = new Date("2026-08-31T10:00:00.000Z");
const timezone = "Asia/Shanghai";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  createdAt: string,
  sessionId = "session-hard"
): ConversationMessage {
  return {
    id,
    sessionId,
    traceId: `trace-${id}`,
    parentMessageId: null,
    role,
    content,
    status: "completed",
    createdAt,
    completedAt: createdAt,
    metadata: {},
    sequence: Number(id.replace(/\D/g, "") || 1)
  };
}

describe("Memory vNext adversarial hardening", () => {
  it("does not automatically replay a writer after an ambiguous outcome", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    let writes = 0;
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => {
        writes += 1;
        return events.map(
          (): MemoryWriteEventOutcome => ({
            status: "rejected",
            failureClass: "ambiguous",
            errorCode: "TIMEOUT"
          })
        );
      }
    });
    const episode = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "记住：我住在上海。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "好。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(episode);
    const considered = await engine.consider({
      episode,
      existing: [episode],
      now,
      explicitImportance: true
    });
    const first = await engine.runJob(considered.job!, now, "owner-1");
    expect(first.status).toBe("reconcile_required");
    expect(writes).toBe(1);

    await engine.runDue(now, "owner-2");
    await engine.runDue(now, "owner-3");
    const persisted = await jobs.getById(first.jobId);
    expect(persisted?.status).toBe("reconcile_required");
    expect(writes).toBe(1);
    expect(episode.status).toBe("active");
  });

  it("stamps Dream writes with C1-style idempotency keys instead of writeEvent", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const keys: string[] = [];
    const provider: Pick<MemoryProvider, "writeEventIdempotent" | "reconcileEvent"> = {
      writeEventIdempotent: async (input) => {
        keys.push(input.idempotencyKey ?? "");
        return { status: "written" };
      },
      reconcileEvent: async () => ({ status: "unknown" })
    };
    const engine = new DreamConsolidationEngine(jobs, store, { provider });
    const episode = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "记住：我喜欢蓝色。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "好。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(episode);
    const considered = await engine.consider({
      episode,
      existing: [episode],
      now,
      explicitImportance: true
    });
    const ran = await engine.runJob(considered.job!, now, "owner");
    expect(ran.status).toBe("complete");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith(`${DREAM_DELIVERY_KEY_PREFIX}:`))).toBe(true);
  });

  it("lets only one concurrent worker claim and execute a Dream job", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    let writes = 0;
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => {
        writes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return events.map((): MemoryWriteEventOutcome => ({ status: "written" }));
      }
    });
    const episode = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "记住：我用 DeepSeek。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "好。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(episode);
    await engine.consider({ episode, existing: [episode], now, explicitImportance: true });
    const [first, second] = await Promise.all([
      engine.runDue(now, "worker-a"),
      engine.runDue(now, "worker-b")
    ]);
    const executed = [...first, ...second].filter(
      (job) => job.status === "complete" || job.status === "processing"
    );
    expect(writes).toBe(1);
    expect(executed).toHaveLength(1);
  });

  it("does not treat overlapping episode snapshots as independent recurrence", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => events.map((): MemoryWriteEventOutcome => ({ status: "written" }))
    });
    const firstMessages = [
      message("u1", "user", "我喜欢蓝色。", "2026-08-31T09:00:00.000Z"),
      message("a1", "assistant", "好的。", "2026-08-31T09:00:01.000Z")
    ];
    const snapshotA = assembleDreamFixtureEpisodes({ messages: firstMessages, now, timezone })[0]!;
    await store.upsert(snapshotA);
    const snapshotB = assembleDreamFixtureEpisodes({
      messages: [
        ...firstMessages,
        message("u2", "user", "我们继续刚才的话题。", "2026-08-31T09:05:00.000Z"),
        message("a2", "assistant", "好。", "2026-08-31T09:05:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    expect(snapshotB.id).toBe(snapshotA.id);
    expect(sourceTurnIdsOverlap(snapshotA.sourceTurnIds, snapshotB.sourceTurnIds)).toBe(true);
    await store.upsert(snapshotB);
    const listed = await store.listActive({ now, sessionId: "session-hard" });
    expect(listed).toHaveLength(1);
    const considered = await engine.consider({
      episode: snapshotB,
      existing: listed,
      now
    });
    expect(considered.triggered).toBe(false);
    expect(considered.skippedReason).toBe("no-trigger");
  });

  it("still triggers recurrence for genuinely distinct user-grounded episodes", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const engine = new DreamConsolidationEngine(jobs, store);
    const first = assembleDreamFixtureEpisodes({
      messages: [
        message("a-u", "user", "我喜欢蓝色。", "2026-08-31T08:00:00.000Z", "session-a"),
        message("a-a", "assistant", "好。", "2026-08-31T08:00:01.000Z", "session-a")
      ],
      now,
      timezone,
      sessionId: "session-a"
    })[0]!;
    const second = assembleDreamFixtureEpisodes({
      messages: [
        message("b-u", "user", "我还是喜欢蓝色。", "2026-08-31T09:40:00.000Z", "session-b"),
        message("b-a", "assistant", "明白。", "2026-08-31T09:40:01.000Z", "session-b")
      ],
      now,
      timezone,
      sessionId: "session-b"
    })[0]!;
    expect(sourceTurnIdsOverlap(first.sourceTurnIds, second.sourceTurnIds)).toBe(false);
    const considered = await engine.consider({
      episode: second,
      existing: [first, second],
      now
    });
    expect(considered.triggered).toBe(true);
    expect(considered.triggerKind).toBe("recurrence");
  });

  it("projects historical open state once and keeps generated assistant text out of factual model memory", () => {
    const episode = assembleDreamFixtureEpisodes({
      messages: [message("1", "user", "What is in this image?", "2026-08-31T09:00:00.000Z")],
      now,
      timezone
    })[0]!;
    const oldSnapshot = JSON.stringify(episode);
    const projected = formatRecentEpisodeForPrompt(
      { ...episode, assistantContext: "I cannot see images. GENERATED_NOT_OBSERVED" },
      timezone,
      { includeAssistantContext: false }
    );
    expect(projected).toContain("What is in this image?");
    expect(projected.match(/Unresolved then:/g)).toHaveLength(1);
    expect(projected).not.toContain("Still unresolved:");
    expect(projected).not.toContain("GENERATED_NOT_OBSERVED");
    expect(JSON.stringify(episode)).toBe(oldSnapshot);
  });

  it("does not present assistant hallucination as L1 factual evidence", async () => {
    const episodes = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "木星有几颗卫星？", "2026-08-31T09:00:00.000Z"),
        message(
          "2",
          "assistant",
          "木星有 79 颗卫星，这是已核实的事实。",
          "2026-08-31T09:00:01.000Z"
        )
      ],
      now,
      timezone
    });
    const episode = episodes[0]!;
    expect(episode.whatHappened).toContain("木星有几颗卫星");
    expect(episode.whatHappened).not.toContain("79");
    expect(episode.whatHappened).not.toMatch(/Latest result|Outcome:/);
    const prompt = formatRecentEpisodeForPrompt(episode, timezone);
    expect(prompt).toContain(ASSISTANT_CONTEXT_DISCLAIMER);
    expect(prompt).toContain("79");
    const recall = activateAssociativeMemories({
      queryText: "木星卫星 79",
      now,
      timezone,
      episodes: [episode]
    });
    expect(
      recall.items.every(
        (item) => !item.content.includes("79") || item.content.includes("User said")
      )
    ).toBe(true);
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const extracted: string[] = [];
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => {
        extracted.push(...events.map((event) => event.content));
        return events.map((): MemoryWriteEventOutcome => ({ status: "written" }));
      }
    });
    await store.upsert(episode);
    await engine.consider({ episode, existing: [episode], now, explicitImportance: true });
    await engine.runDue(now, "owner");
    expect(extracted.join("\n")).not.toContain("79");
  });

  it("does not mark episodes consolidated when no Memory writer exists", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const engine = new DreamConsolidationEngine(jobs, store);
    const episode = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "记住：我住在上海。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "好。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(episode);
    const considered = await engine.consider({
      episode,
      existing: [episode],
      now,
      explicitImportance: true
    });
    const ran = await engine.runJob(considered.job!, now, "owner");
    expect(ran.status).toBe("skipped");
    expect(ran.lastErrorCode).toBe("MEMORY_WRITER_UNAVAILABLE");
    const stored = await store.getById(episode.id);
    expect(stored?.status).toBe("active");
    expect(stored?.consolidatedAt).toBeNull();
  });

  it("computes elapsed gap from the prior interaction, not the current user turn", async () => {
    const assembly = await assembleMemoryVNextContext({
      now,
      timezone,
      queryText: "我回来了",
      currentTurnText: "我回来了",
      sessionId: "session-gap",
      directContextText: "",
      messages: [
        message("old-u", "user", "昨天那个训练开始了。", "2026-08-30T10:00:00.000Z", "session-gap"),
        message("old-a", "assistant", "好。", "2026-08-30T10:00:05.000Z", "session-gap"),
        message("now-u", "user", "我回来了", "2026-08-31T10:00:00.000Z", "session-gap")
      ]
    });
    expect(assembly.temporal.lastInteractionAgeBand).not.toBe("just-now");
    expect(assembly.temporal.lastInteractionAgeBand).not.toBe("minutes-ago");
    expect(assembly.temporal.elapsedSinceLastInteractionMs).toBeGreaterThan(12 * 60 * 60 * 1000);
    expect(assembly.temporal.gapAcknowledged).toBe(true);
  });

  it("marks deterministic compression as active in Runtime", () => {
    expect(CONTEXT_COMPRESSION_RUNTIME_STATUS).toBe("RUNTIME_ACTIVE");
  });

  it("does not enqueue idle Dream unless idleMs is explicitly supplied", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const engine = new DreamConsolidationEngine(jobs, store);
    const episode = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "我喜欢蓝色。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "好。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    const withoutIdle = await engine.consider({ episode, existing: [episode], now });
    expect(withoutIdle.triggered).toBe(false);
    expect(withoutIdle.skippedReason).toBe("no-trigger");
    const withIdle = await engine.consider({
      episode,
      existing: [episode],
      now,
      idleMs: 31 * 60 * 1000
    });
    expect(withIdle.triggered).toBe(true);
    expect(withIdle.triggerKind).toBe("idle");
  });

  it("proves applied Dream effects via reconcileEvent without rewriting", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    let writes = 0;
    let reconciles = 0;
    const provider: Pick<MemoryProvider, "writeEventIdempotent" | "reconcileEvent"> = {
      writeEventIdempotent: async () => {
        writes += 1;
        return { status: "rejected", failureClass: "ambiguous", errorCode: "TIMEOUT" };
      },
      reconcileEvent: async () => {
        reconciles += 1;
        return { status: "applied" };
      }
    };
    const engine = new DreamConsolidationEngine(jobs, store, { provider });
    const episode = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "记住：我住在上海。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "好。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(episode);
    const considered = await engine.consider({
      episode,
      existing: [episode],
      now,
      explicitImportance: true
    });
    const first = await engine.runJob(considered.job!, now, "owner-1");
    expect(first.status).toBe("reconcile_required");
    expect(writes).toBeGreaterThan(0);
    const writesAfterAmbiguous = writes;
    await engine.runDue(now, "owner-2");
    expect(writes).toBe(writesAfterAmbiguous);
    const reconciled = await engine.reconcileJob(first, now, "owner-3");
    expect(reconciled.status).toBe("complete");
    expect(reconciles).toBeGreaterThan(0);
    expect(writes).toBe(writesAfterAmbiguous);
    const stored = await store.getById(episode.id);
    expect(stored?.status).toBe("consolidated");
  });

  it("rewrites Dream events only after reconcileEvent proves not_applied", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    let writes = 0;
    const provider: Pick<MemoryProvider, "writeEventIdempotent" | "reconcileEvent"> = {
      writeEventIdempotent: async () => {
        writes += 1;
        if (writes === 1) {
          return { status: "rejected", failureClass: "ambiguous", errorCode: "TIMEOUT" };
        }
        return { status: "written" };
      },
      reconcileEvent: async () => ({ status: "not_applied" })
    };
    const engine = new DreamConsolidationEngine(jobs, store, { provider });
    const episode = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "记住：我用 DeepSeek。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "好。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(episode);
    const considered = await engine.consider({
      episode,
      existing: [episode],
      now,
      explicitImportance: true
    });
    const first = await engine.runJob(considered.job!, now, "owner-1");
    expect(first.status).toBe("reconcile_required");
    const writesAfterAmbiguous = writes;
    const stillDue = await engine.runDue(now, "owner-2");
    expect(stillDue).toEqual([]);
    expect(writes).toBe(writesAfterAmbiguous);
    const reconciled = await engine.reconcileJob(first, now, "owner-3");
    expect(reconciled.status).toBe("complete");
    expect(writes).toBeGreaterThan(writesAfterAmbiguous);
    const stored = await store.getById(episode.id);
    expect(stored?.status).toBe("consolidated");
  });

  it("keeps reconcile_required when canonical evidence is still unknown", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    let writes = 0;
    const provider: Pick<MemoryProvider, "writeEventIdempotent" | "reconcileEvent"> = {
      writeEventIdempotent: async () => {
        writes += 1;
        return { status: "rejected", failureClass: "ambiguous", errorCode: "TIMEOUT" };
      },
      reconcileEvent: async () => ({ status: "unknown" })
    };
    const engine = new DreamConsolidationEngine(jobs, store, { provider });
    const episode = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "记住：我喜欢蓝色。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "好。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(episode);
    const considered = await engine.consider({
      episode,
      existing: [episode],
      now,
      explicitImportance: true
    });
    const first = await engine.runJob(considered.job!, now, "owner-1");
    expect(first.status).toBe("reconcile_required");
    const writesAfterAmbiguous = writes;
    const reconciled = await engine.reconcileJob(first, now, "owner-2");
    expect(reconciled.status).toBe("reconcile_required");
    expect(writes).toBe(writesAfterAmbiguous);
    const stored = await store.getById(episode.id);
    expect(stored?.status).toBe("active");
  });
});

describe("Memory vNext postgres atomic claim", () => {
  const databaseUrl = process.env["DATABASE_URL"];
  const pools: Pool[] = [];

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it.skipIf(!databaseUrl)("claims a pending Dream job once under concurrent workers", async () => {
    await runPostgresMigrations({ databaseUrl: databaseUrl! });
    const pool = new Pool({
      connectionString: normalizePostgresConnectionString(databaseUrl!)
    });
    pools.push(pool);
    const jobs = new PostgresDreamJobStore(pool);
    const episodeStore = new PostgresRecentEpisodeStore(pool);
    const jobId = `dream-claim-${Date.now()}`;
    await jobs.upsertPending({
      jobId,
      triggerKind: "explicit",
      status: "pending",
      memoryScope: "user",
      personaId: null,
      subjectUserId: null,
      sourceEpisodeIds: [],
      sourceDigest: jobId
        .replace(/[^0-9a-f]/gi, "a")
        .padEnd(64, "c")
        .slice(0, 64),
      payload: {},
      resultEventPayloads: null,
      resultSummary: null,
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null
    });
    const [first, second] = await Promise.all([
      jobs.claimDue({ now, leaseOwner: "pg-a", leaseMs: 30_000, limit: 4 }),
      jobs.claimDue({ now, leaseOwner: "pg-b", leaseMs: 30_000, limit: 4 })
    ]);
    const claimed = [...first, ...second].filter((job) => job.jobId === jobId);
    expect(claimed).toHaveLength(1);
    expect(new Set(claimed.map((job) => job.leaseOwner)).size).toBe(1);
    await episodeStore.listActive({ now, limit: 1 });
  });
});
