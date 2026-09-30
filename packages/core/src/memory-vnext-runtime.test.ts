import { parent, receipt, readerFor } from "../../memory/src/journal-evidence.test-fixture.js";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  InMemoryConversationRepository,
  InMemoryRecentEpisodeStore,
  JournalMemoryGroundingResolver
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createMockChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockTTSProvider,
  createMockVisionProvider,
  MockEmbeddingProvider
} from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import { RuntimeOrchestrator, type RuntimeMemoryPort } from "./index.js";

function createProviders() {
  return {
    getChatProvider: () => createMockChatProvider("vnext-chat"),
    getReasoningProvider: () => createMockReasoningProvider("vnext-reasoning"),
    getTTSProvider: () => createMockTTSProvider("vnext-tts"),
    getSTTProvider: () => createMockSTTProvider("vnext-stt"),
    getVisionProvider: () => createMockVisionProvider("vnext-vision"),
    getEmbeddingProvider: () => new MockEmbeddingProvider(3)
  };
}

function createMemory(): RuntimeMemoryPort {
  return {
    retrieveRelevantMemories: async () => [],
    scoreImportance: () => 0,
    rememberInteraction: async () => null
  };
}

describe("Runtime Memory vNext vertical slice", () => {
  it("carries the persisted user receipt into episode grounding and a DERIVED Dream writer", async () => {
    const text = "Please remember: I prefer tea 🍵.";
    const conversation = new InMemoryConversationRepository(),
      recentEpisodeStore = new InMemoryRecentEpisodeStore();
    const writes: import("@companion/memory").MemoryWriteEventInput[] = [];
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMemory(),
      promptBuilder: new PromptBuilder(),
      providers: createProviders(),
      conversation,
      recentEpisodeStore,
      episodeGroundingResolver: new JournalMemoryGroundingResolver(
        readerFor(receipt({ text }), text)
      ),
      dreamWriter: async (events) => {
        writes.push(...events);
        return events.map(() => ({ status: "written" }));
      }
    });
    await runtime.handleUserMessage(
      { sessionId: "grounded-dream", content: text, sourceJournalRef: parent },
      { readMemory: true, writeMemory: true }
    );
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const rows = await conversation.listRecentMessages("grounded-dream", { limit: 10 });
    expect(rows.find((row) => row.role === "user")?.sourceJournalRef).toEqual(parent);
    const episodes = await recentEpisodeStore.listActive({
      now: new Date(),
      sessionId: "grounded-dream",
      includeRolled: true
    });
    // Completed episodes leave the active view; inspect by stable source identity.
    const episode = await recentEpisodeStore.getById(
      `episode:grounded-dream:${rows.find((row) => row.role === "user")!.id}`
    );
    expect(episode?.sourceEvidence?.statements[0]?.source?.ref).toEqual(parent);
    expect(writes[0]?.lineage?.state === "GROUNDED" ? writes[0].lineage.origin : undefined).toBe(
      "DERIVED"
    );
    expect(writes[0]?.assertion).toEqual({ source: "system", verification: "unverified" });
    expect(episodes.every((item) => item.sourceCoverage !== "LEGACY_INCOMPLETE")).toBe(true);
    await runtime.sealAndDrainMemoryWrites();
  });

  it("keeps alternating people in one production session out of each other's durable episodes", async () => {
    const conversation = new InMemoryConversationRepository();
    const recentEpisodeStore = new InMemoryRecentEpisodeStore();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMemory(),
      promptBuilder: new PromptBuilder(),
      providers: createProviders(),
      conversation,
      recentEpisodeStore
    });
    for (const person of ["person-a", "person-b"]) {
      await runtime.handleUserMessage(
        {
          sessionId: "shared",
          content: `Only ${person} said this`,
          subjectUserId: person,
          personaId: "persona"
        },
        { readMemory: true, writeMemory: true }
      );
      await vi.waitFor(async () => {
        const episodes = await recentEpisodeStore.listActive({
          now: new Date(),
          subjectUserId: person,
          personaId: "persona"
        });
        expect(episodes).toHaveLength(1);
        expect(episodes[0]?.userStatements.join(" ")).toContain(person);
        expect(episodes[0]?.userStatements.join(" ")).not.toContain(
          person === "person-a" ? "person-b" : "person-a"
        );
        expect(episodes[0]?.memoryScope).toBe(`yuvi:v1:user:${person}:character:persona`);
      });
    }
    const first = await recentEpisodeStore.listActive({
      now: new Date(),
      subjectUserId: "person-a"
    });
    expect(first).toHaveLength(1);
    await runtime.sealAndDrainMemoryWrites();
  });

  it("does not persist episodes for write-disabled turns, including after restart", async () => {
    const conversation = new InMemoryConversationRepository();
    const recentEpisodeStore = new InMemoryRecentEpisodeStore();
    const upsert = vi.spyOn(recentEpisodeStore, "upsert");
    const rollover = vi.spyOn(recentEpisodeStore, "rollover");
    let fail = false;
    const create = () =>
      new RuntimeOrchestrator({
        eventBus: new InMemoryEventBus({ development: false }),
        memory: createMemory(),
        promptBuilder: new PromptBuilder(),
        providers: {
          ...createProviders(),
          getChatProvider: () => ({
            ...createMockChatProvider("vnext-chat"),
            async generateReply(input, options) {
              if (fail) throw new Error("deliberate provider failure");
              return createMockChatProvider("vnext-chat").generateReply(input, options);
            }
          })
        },
        conversation,
        recentEpisodeStore
      });
    const runtime = create();
    await runtime.handleUserMessage(
      { sessionId: "disabled", content: "private read-only marker" },
      { readMemory: true, writeMemory: false }
    );
    for await (const event of runtime.streamUserMessage(
      { sessionId: "disabled", content: "private streamed marker" },
      { readMemory: true, writeMemory: false }
    )) {
      void event;
    }
    fail = true;
    await expect(
      runtime.handleUserMessage(
        { sessionId: "disabled", content: "private failed marker" },
        { readMemory: true, writeMemory: false }
      )
    ).rejects.toThrow("deliberate provider failure");
    fail = false;
    expect(upsert).not.toHaveBeenCalled();
    expect(rollover).not.toHaveBeenCalled();
    await runtime.sealAndDrainMemoryWrites();
    const restarted = create();
    await restarted.handleUserMessage(
      { sessionId: "disabled", content: "remember the public marker" },
      { readMemory: true, writeMemory: true }
    );
    await vi.waitFor(() => expect(upsert).toHaveBeenCalled());
    expect(
      upsert.mock.calls
        .flat()
        .map((episode) => episode.userStatements.join(" "))
        .join(" ")
    ).not.toContain("private");
    await restarted.sealAndDrainMemoryWrites();
  });

  it("injects L1 recent episodes after DirectContext rolls off the training turn", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMemory(),
      promptBuilder: new PromptBuilder(),
      providers: createProviders(),
      conversation,
      directContext: { enabled: true, maxTurns: 1, maxChars: 6000 }
    });

    await runtime.handleUserMessage(
      {
        sessionId: "vnext-train",
        content: "下午把训练脚本改到 6121 端口，继续跑训练。"
      },
      { readMemory: true, writeMemory: false }
    );
    await runtime.handleUserMessage(
      { sessionId: "vnext-train", content: "今天先聊点别的。" },
      { readMemory: true, writeMemory: false }
    );
    await runtime.handleUserMessage(
      { sessionId: "vnext-train", content: "昨天那个训练怎么样了？" },
      { readMemory: true, writeMemory: false }
    );

    const preview = runtime.getLatestPromptPreview();
    const direct =
      preview?.sections.find((section) => section.name === "DirectContext")?.content ?? "";
    const episodic =
      preview?.sections.find((section) => section.name === "RecentEpisodicMemory")?.content ?? "";

    expect(direct).not.toContain("训练脚本改到 6121");
    expect(episodic).toContain("6121");
    expect(preview?.sections.some((section) => section.name === "RecentEpisodicMemory")).toBe(true);
    expect(preview?.recentEpisodicCount).toBeGreaterThan(0);
  });

  it("reports elapsed time from the previous interaction, not the current user turn", async () => {
    const conversation = new InMemoryConversationRepository();
    const prior = new Date(Date.now() - 16 * 60 * 60 * 1000).toISOString();
    await conversation.appendMessage({
      id: "gap-old-user",
      sessionId: "vnext-gap",
      traceId: "trace-old-user",
      parentMessageId: null,
      role: "user",
      content: "昨天那个训练开始了。",
      status: "completed",
      createdAt: prior,
      completedAt: prior,
      metadata: {}
    });
    await conversation.appendMessage({
      id: "gap-old-assistant",
      sessionId: "vnext-gap",
      traceId: "trace-old-assistant",
      parentMessageId: "gap-old-user",
      role: "assistant",
      content: "好，先记着。",
      status: "completed",
      createdAt: prior,
      completedAt: prior,
      metadata: {}
    });

    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMemory(),
      promptBuilder: new PromptBuilder(),
      providers: createProviders(),
      conversation
    });

    await runtime.handleUserMessage(
      { sessionId: "vnext-gap", content: "我回来了" },
      { readMemory: true, writeMemory: false }
    );

    const preview = runtime.getLatestPromptPreview();
    const currentTime =
      preview?.sections.find((section) => section.name === "CurrentTime")?.content ?? "";
    expect(preview?.temporalAgeBand).not.toBe("just-now");
    expect(currentTime).not.toMatch(/Elapsed since last interaction: less than 2 minutes/);
    expect(currentTime).toMatch(/hours-ago|yesterday|this-week|hours/);
  });
});
