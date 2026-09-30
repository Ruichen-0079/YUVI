import { assembleDreamFixtureEpisodes } from "./dream-test-fixture.js";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { activateAssociativeMemories } from "./associative-recall.js";
import { compressHierarchicalContext } from "./context-compression.js";
import type { ConversationMessage } from "./conversation-repository.js";
import { DreamConsolidationEngine, InMemoryDreamJobStore } from "./dream-consolidation.js";
import { MemoryIngestionPolicy } from "./ingestion.js";
import { assembleMemoryVNextContext } from "./memory-vnext.js";
import { runPostgresMigrations } from "./migrations.js";
import { normalizePostgresConnectionString } from "./postgres-connection.js";
import type { MemoryEvent, MemoryWriteEventOutcome } from "./provider.js";
import { assembleRecentEpisodes } from "./recent-episode.js";
import { InMemoryRecentEpisodeStore, PostgresRecentEpisodeStore } from "./recent-episode-store.js";
import { projectThinTemporalContext } from "./temporal-projection.js";

const now = new Date("2026-08-31T10:00:00.000Z");
const timezone = "Asia/Shanghai";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  createdAt: string,
  sessionId = "session-train"
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

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "opaque-1",
    kind: "fact",
    content: "The user prefers short replies.",
    source: "test",
    sourceRecordId: "record-1",
    metadata: {},
    assertion: { source: "user", verification: "unverified" },
    ...overrides
  };
}

describe("Memory vNext hierarchical context", () => {
  it("keeps detailed L1 episodes so 昨天那个训练 resolves after DirectContext rolls off", async () => {
    const messages = [
      message(
        "1",
        "user",
        "下午把训练脚本改到 6121 端口，继续跑 Qwen 训练。",
        "2026-08-30T07:00:00.000Z"
      ),
      message("2", "assistant", "好的，训练端口现在是 6121。", "2026-08-30T07:00:05.000Z"),
      message("3", "user", "报错先记着，明天再看。", "2026-08-30T07:01:00.000Z"),
      message("4", "assistant", "记下了训练报错还没处理。", "2026-08-30T07:01:04.000Z"),
      message("5", "user", "今天天气不错。", "2026-08-31T09:50:00.000Z"),
      message("6", "assistant", "是啊。", "2026-08-31T09:50:02.000Z")
    ];
    const store = new InMemoryRecentEpisodeStore();
    const assembly = await assembleMemoryVNextContext({
      now,
      timezone,
      queryText: "昨天那个训练怎么样了？",
      currentTurnText: "昨天那个训练怎么样了？",
      sessionId: "session-train",
      subjectUserId: "user-a",
      personaId: "lumi",
      directContextText: "- User: 今天天气不错。\n- Assistant: 是啊。",
      messages: messages.map((message) => ({
        ...message,
        subjectUserId: "user-a",
        personaId: "lumi"
      })),
      episodeStore: store,
      persistEpisodes: true
    });

    expect(assembly.recentEpisodicText).toContain("训练");
    expect(assembly.recentEpisodicText).toContain("6121");
    expect(assembly.promptEpisodes.some((episode) => episode.whatHappened.includes("训练"))).toBe(
      true
    );
    expect(assembly.temporal.lastInteractionAgeBand).not.toBe("unknown");
    expect(assembly.characterProjection.memoryEvidence.state).toBe("KNOWN");
  });

  it("reconstructs L1 after store restart from conversation messages", async () => {
    const messages = [
      message("1", "user", "上午说的那个问题是 pnpm check 失败。", "2026-08-31T01:00:00.000Z"),
      message("2", "assistant", "我看到是类型错误。", "2026-08-31T01:00:04.000Z")
    ];
    const first = new InMemoryRecentEpisodeStore();
    await assembleMemoryVNextContext({
      now,
      timezone,
      queryText: "上午说的那个问题",
      directContextText: "",
      messages,
      episodeStore: first,
      persistEpisodes: true
    });
    const restarted = new InMemoryRecentEpisodeStore();
    const assembly = await assembleMemoryVNextContext({
      now,
      timezone,
      queryText: "上午说的那个问题",
      directContextText: "",
      messages,
      episodeStore: restarted,
      persistEpisodes: true
    });
    expect(assembly.recentEpisodicText).toContain("pnpm check");
  });

  it("does not reduce recent interaction to tiny fact triples", () => {
    const episodes = assembleRecentEpisodes({
      messages: [
        message(
          "1",
          "user",
          "刚才不是决定了把 Companion 窗口先放一边，专心修 Memory 吗？",
          "2026-08-31T09:00:00.000Z"
        ),
        message(
          "2",
          "assistant",
          "对，Live2D 先不动。我们继续 Memory vNext。",
          "2026-08-31T09:00:06.000Z"
        )
      ],
      now,
      timezone
    });
    expect(episodes[0]?.userStatements.join(" ")).toContain("刚才不是决定了");
    expect(episodes[0]?.whatHappened.length).toBeGreaterThan(40);
  });

  it("redacts secrets and does not keep raw transcripts forever in the episode body", () => {
    const episodes = assembleRecentEpisodes({
      messages: [
        message(
          "1",
          "user",
          `DATABASE_URL=postgres://secret ${"很长的原文 ".repeat(80)}`,
          "2026-08-31T09:00:00.000Z"
        ),
        message("2", "assistant", "ok", "2026-08-31T09:00:01.000Z")
      ],
      now,
      timezone,
      episodeChars: 400
    });
    expect(episodes[0]?.whatHappened).not.toContain("postgres://secret");
    expect(episodes[0]?.whatHappened.includes("[redacted]")).toBe(true);
  });
});

describe("Dream consolidation", () => {
  it("does not summarize every turn and requires recurrence or salience", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const engine = new DreamConsolidationEngine(jobs, store);
    const [episode] = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "你好", "2026-08-31T09:00:00.000Z"),
        message("2", "assistant", "你好", "2026-08-31T09:00:01.000Z")
      ],
      now,
      timezone
    });
    await store.upsert(episode!);
    const result = await engine.consider({ episode: episode!, existing: [episode!], now });
    expect(result.triggered).toBe(false);
    expect(result.skippedReason).toBe("no-trigger");
  });

  it("never lets repeated assistant prose become user truth", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const writes: string[] = [];
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => {
        writes.push(...events.map((event) => event.content));
        return events.map((): MemoryWriteEventOutcome => ({ status: "written" }));
      }
    });
    const first = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "我喜欢蓝色。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "我们关系更好了，你现在更信任我。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    const second = assembleDreamFixtureEpisodes({
      messages: [
        message("3", "user", "我还是喜欢蓝色。", "2026-08-31T09:00:00.000Z"),
        message("4", "assistant", "我们关系更好了，你现在更信任我。", "2026-08-31T09:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(first);
    await store.upsert(second);
    const considered = await engine.consider({ episode: second, existing: [first, second], now });
    expect(considered.triggered).toBe(true);
    await engine.runDue(now, "test-lease");
    expect(writes.join("\n")).toMatch(/蓝色/);
    expect(writes.join("\n")).not.toMatch(/关系更好了|更信任/);
    const ingestion = await new MemoryIngestionPolicy().build({
      userMessage: "你好",
      assistantMessage: "我们关系更好了。我现在更信任你。",
      scope: "user"
    });
    expect(ingestion.events).toEqual([]);
  });

  it("does not upgrade confidence merely because something repeats", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) =>
        events.map((event) => {
          expect(event.assertion).toEqual({ source: "system", verification: "unverified" });
          expect(event.metadata?.["recurrenceDoesNotUpgradeConfidence"]).toBe(true);
          return { status: "written" as const };
        })
    });
    const first = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "我喜欢蓝色。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "记下了。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    const second = assembleDreamFixtureEpisodes({
      messages: [
        message("3", "user", "我还是喜欢蓝色。", "2026-08-31T09:00:00.000Z"),
        message("4", "assistant", "好。", "2026-08-31T09:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(first);
    await store.upsert(second);
    await engine.consider({ episode: second, existing: [first, second], now });
    const jobsRun = await engine.runDue(now, "test-lease");
    expect(jobsRun[0]?.status).toBe("complete");
  });

  it("is idempotent across duplicate execution and recoverable after a crash mid-job", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    let writeCount = 0;
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => {
        writeCount += events.length;
        return events.map(() => ({ status: "written" as const }));
      }
    });
    const first = assembleDreamFixtureEpisodes({
      messages: [
        message("1", "user", "记住：我用 DeepSeek 做 Reasoning。", "2026-08-31T08:00:00.000Z"),
        message("2", "assistant", "好。", "2026-08-31T08:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    await store.upsert(first);
    const considered = await engine.consider({
      episode: first,
      existing: [first],
      now,
      explicitImportance: true
    });
    const processing = await engine.runJob(considered.job!, now, "owner-1");
    expect(processing.status === "complete" || processing.status === "skipped").toBe(true);
    const duplicate = await engine.consider({
      episode: first,
      existing: [first],
      now,
      explicitImportance: true
    });
    expect(duplicate.skippedReason).toMatch(/already/);
    const crashed = await jobs.save({
      ...((await jobs.getById(considered.job!.jobId)) ?? considered.job!),
      status: "processing",
      completedAt: null,
      leaseOwner: "dead-owner",
      leaseExpiresAt: new Date(now.getTime() - 1000).toISOString()
    });
    const recoveredEngine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => {
        writeCount += events.length;
        return events.map(() => ({ status: "written" as const }));
      }
    });
    const recovered = await recoveredEngine.runDue(now, "owner-2");
    expect(recovered[0]?.jobId).toBe(crashed.jobId);
  });

  it("keeps ambiguous writer outcomes as reconcile_required instead of terminal failure", async () => {
    const store = new InMemoryRecentEpisodeStore();
    const jobs = new InMemoryDreamJobStore();
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async () => [{ status: "rejected", failureClass: "ambiguous", errorCode: "TIMEOUT" }]
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
    const ran = await engine.runJob(considered.job!, now, "owner");
    expect(ran.status).toBe("reconcile_required");
  });
});

describe("Associative memory intrusion", () => {
  it("surfaces a context-triggered prior episode without requiring an explicit memory query", () => {
    const episode = assembleRecentEpisodes({
      messages: [
        message(
          "1",
          "user",
          "训练脚本在 /home/ruichen/train.sh，端口 6121。",
          "2026-08-30T07:00:00.000Z"
        ),
        message("2", "assistant", "记下了。", "2026-08-30T07:00:01.000Z")
      ],
      now: new Date("2026-08-30T07:00:02.000Z"),
      timezone
    })[0]!;
    const result = activateAssociativeMemories({
      queryText: "训练端口还是 6121 吗？",
      now,
      timezone,
      currentTurnText: "训练端口还是 6121 吗？",
      directContextText: "",
      episodes: [episode],
      lastTurnIntruded: false
    });
    expect(result.status).toBe("ok");
    expect(result.items[0]?.content).toMatch(/6121|训练/);
    expect(result.items[0]?.reason).toMatch(/technical-overlap|lexical-overlap/);
    expect(JSON.stringify(result.items)).not.toMatch(/mem0|postgres|MemoryProvider/);
  });

  it("does not intrude every turn and decays stale memories", () => {
    const old = assembleRecentEpisodes({
      messages: [
        message("1", "user", "我曾经养过一只猫。", "2026-07-01T00:00:00.000Z"),
        message("2", "assistant", "好。", "2026-07-01T00:00:01.000Z")
      ],
      now: new Date("2026-07-01T00:00:02.000Z"),
      timezone
    })[0]!;
    const cooldown = activateAssociativeMemories({
      queryText: "继续刚才的代码。",
      now,
      timezone,
      episodes: [old],
      lastTurnIntruded: true
    });
    expect(cooldown.skippedReason).toBe("cooldown");
    const stale = activateAssociativeMemories({
      queryText: "今天的天气",
      now,
      timezone,
      episodes: [old]
    });
    expect(stale.items.length).toBe(0);
  });

  it("keeps unavailable long-term Memory distinct from empty and still allows L1", () => {
    const episode = assembleRecentEpisodes({
      messages: [
        message("1", "user", "pnpm test 刚失败了。", "2026-08-31T09:00:00.000Z"),
        message("2", "assistant", "我看日志。", "2026-08-31T09:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    const unavailable = activateAssociativeMemories({
      queryText: "pnpm test",
      now,
      timezone,
      episodes: [episode],
      longTerm: {
        status: "unavailable",
        events: [],
        source: "mem0",
        limited: false,
        errorCode: "DOWN"
      }
    });
    expect(unavailable.status).toBe("ok");
    expect(unavailable.items.length).toBeGreaterThan(0);
    const empty = activateAssociativeMemories({
      queryText: "zzzz-no-overlap",
      now,
      timezone,
      episodes: [],
      longTerm: { status: "empty", events: [], source: "mem0", limited: false }
    });
    expect(empty.status).toBe("empty");
  });
});

describe("Context compression and thin temporal projection", () => {
  it("protects epistemic markers and current user turn while compressing old context", () => {
    const result = compressHierarchicalContext({
      maxCharacters: 400,
      sections: [
        { name: "SystemIdentity", content: "You are YUVI.", stable: true },
        { name: "UserMessage", content: "昨天那个训练怎么样了？", stable: true },
        {
          name: "RelevantMemory",
          content: "Memory was disabled for this turn.\nUNAVAILABLE long-term evidence."
        },
        {
          name: "DirectContext",
          content: Array.from(
            { length: 12 },
            (_, index) => `- old turn ${index} ${"x".repeat(40)}`
          ).join("\n")
        }
      ]
    });
    expect(result.metrics.protectedPreserved).toBe(true);
    expect(result.metrics.epistemicMarkersPreserved).toBe(true);
    expect(result.sections.find((section) => section.name === "UserMessage")?.content).toBe(
      "昨天那个训练怎么样了？"
    );
    expect(result.metrics.afterTokens).toBeLessThanOrEqual(result.metrics.beforeTokens);
  });

  it("makes elapsed time and unknown timestamps explicit without inventing gap events", () => {
    const projection = projectThinTemporalContext({
      now,
      timezone,
      lastInteractionAt: "2026-08-30T10:00:00.000Z",
      episodes: assembleRecentEpisodes({
        messages: [
          message("1", "user", "训练", "2026-08-30T07:00:00.000Z"),
          message("2", "assistant", "好", "2026-08-30T07:00:01.000Z")
        ],
        now: new Date("2026-08-30T07:00:02.000Z"),
        timezone
      })
    });
    expect(projection.inventedGapEvents).toBe(false);
    expect(projection.gapAcknowledged).toBe(true);
    expect(projection.lastInteractionAgeBand).toBe("yesterday");
    expect(projection.promptText).toContain("Do not invent events");
    const unknown = projectThinTemporalContext({ now, timezone });
    expect(unknown.lastInteractionAgeBand).toBe("unknown");
    expect(unknown.elapsedSinceLastInteractionMs).toBeNull();
  });

  it("does not treat mixed Chinese/English technical tokens as vague similarity", () => {
    const episode = assembleRecentEpisodes({
      messages: [
        message(
          "1",
          "user",
          "YUVI Runtime 的入口是 pnpm check，端口 6121。",
          "2026-08-31T09:00:00.000Z"
        ),
        message("2", "assistant", "收到。", "2026-08-31T09:00:01.000Z")
      ],
      now,
      timezone
    })[0]!;
    const result = activateAssociativeMemories({
      queryText: "pnpm check 6121",
      now,
      timezone,
      episodes: [episode]
    });
    expect(result.items[0]?.reason).toBe("technical-overlap");
  });
});

describe("Memory vNext postgres persistence", () => {
  const databaseUrl = process.env["DATABASE_URL"];
  const pools: Pool[] = [];

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it.skipIf(!databaseUrl)("upserts L1 episodes idempotently and survives rollover", async () => {
    await runPostgresMigrations({ databaseUrl: databaseUrl! });
    const pool = new Pool({
      connectionString: normalizePostgresConnectionString(databaseUrl!)
    });
    pools.push(pool);
    const store = new PostgresRecentEpisodeStore(pool);
    const [episode] = assembleRecentEpisodes({
      messages: [
        message("pg-1", "user", "昨天那个训练还在 6121。", "2026-08-30T07:00:00.000Z"),
        message("pg-2", "assistant", "是的。", "2026-08-30T07:00:01.000Z")
      ],
      now,
      timezone
    });
    const first = await store.upsert(episode!);
    const second = await store.upsert(episode!);
    expect(second.id).toBe(first.id);
    const listed = await store.listActive({ now, sessionId: episode!.sessionId, limit: 10 });
    expect(listed.some((item) => item.sourceDigest === episode!.sourceDigest)).toBe(true);
  });
});

it.each(["ok", "partial", "empty", "unavailable", "error"] as const)(
  "projects the actual long-term producer state %s without requiring an associative hit",
  async (status) => {
    const events =
      status === "ok" || status === "partial"
        ? [
            {
              id: "evidence",
              kind: "fact" as const,
              content: "User grows mint.",
              source: "mem0",
              sourceRecordId: "evidence",
              metadata: {}
            }
          ]
        : [];
    const assembly = await assembleMemoryVNextContext({
      now: new Date("2026-09-08T10:00:00Z"),
      queryText: "Hello",
      directContextText: "",
      messages: [],
      longTerm: { status, events, source: "mem0", limited: status === "partial" }
    });
    expect(assembly.characterProjection.memoryEvidence.state).toBe(
      {
        ok: "KNOWN",
        partial: "PARTIAL",
        empty: "EMPTY",
        unavailable: "UNAVAILABLE",
        error: "ERROR"
      }[status]
    );
    if (events.length) {
      expect(assembly.characterProjection.memoryEvidence.summary).toContain("User grows mint.");
      expect(assembly.characterProjection.memoryEvidence.provenanceReferences).toContain(
        "evidence"
      );
    } else expect(assembly.characterProjection.memoryEvidence.summary).toBeUndefined();
    expect(assembly.characterProjection.temporalContext.state).toBe("PARTIAL");
    expect(assembly.characterProjection.temporalContext.summary).toContain("2026");
  }
);

it("uses compressed content in the live Character projection while folding older messages into L1", async () => {
  const directContextText = "recent conversational context. ".repeat(120);
  const input = {
    now,
    sessionId: "session-train",
    queryText: "Orchid",
    directContextText,
    messages: [
      message("older-user", "user", "The project is Orchid.", "2026-08-31T09:00:00.000Z"),
      message("older-assistant", "assistant", "We will plan Orchid.", "2026-08-31T09:00:01.000Z")
    ]
  };
  const full = await assembleMemoryVNextContext(input);
  const compressed = await assembleMemoryVNextContext({ ...input, maxPromptCharacters: 800 });
  expect(compressed.compression?.dropped).toBe(true);
  expect(compressed.episodes.length).toBeGreaterThan(0);
  expect(compressed.characterProjection.recentConversation.summary!.length).toBeLessThan(
    full.characterProjection.recentConversation.summary!.length
  );
  expect(compressed.characterProjection.memoryEvidence.summary).toContain("Orchid");
  expect(compressed.characterProjection.recentConversation.state).toBe("PARTIAL");
});

it("retains the newest L0 tail when long multiline history exceeds the ABI section cap", async () => {
  const directContextText =
    Array.from({ length: 8 }, (_, index) => `turn ${index}: ${"older detail ".repeat(300)}`).join(
      "\n"
    ) + "\nlatest-user-intent";
  const result = await assembleMemoryVNextContext({
    now,
    queryText: "latest",
    directContextText,
    messages: [],
    maxPromptCharacters: 10240
  });
  expect(result.characterProjection.recentConversation.summary!.length).toBeLessThanOrEqual(4000);
  expect(result.characterProjection.recentConversation.summary).toContain("latest-user-intent");
});
