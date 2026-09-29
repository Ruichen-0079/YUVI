import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMemoryRepositoryEnv } from "./env.js";
import {
  MissingDatabaseUrlError,
  parseDotEnv,
  readSqlMigrations,
  resolveDatabaseUrl
} from "./migrations.js";
import {
  InMemoryMemoryRepository,
  createMemoryRepositoryFromEnv,
  PostgresMemoryRepository
} from "./repository.js";
import { MemoryMaintenanceService } from "./maintenance.js";
import { MemoryScorer } from "./scorer.js";
import { createMemoryDisplayText, extractSearchKeywords, MemoryService } from "./service.js";
import { LlmMemoryExtractor, RuleBasedMemoryExtractor } from "./extractor.js";
import type { MemoryCandidate, MemoryExtractionInput, MemoryExtractor } from "./types.js";
import { detectCurrentAffect } from "./affect.js";
import { buildCandidateFingerprint } from "./candidate-dedupe.js";
import { detectCorrectionRequest, detectExplicitRememberRequest } from "./intent.js";
import {
  canonicalEventDate,
  hasUnresolvedRelativeTime,
  normalizeContentForFingerprint,
  normalizeTemporalCandidate,
  resolveCanonicalTemporalBounds,
  resolveTemporalDebug,
  resolveTimezoneFromObservedAt
} from "./temporal.js";

describe("MemoryRepository", () => {
  it("creates and retrieves memory records", async () => {
    const repository = new InMemoryMemoryRepository();
    const created = await repository.createMemory({
      type: "semantic",
      content: "The user is testing memory.",
      source: "test",
      metadata: { origin: "unit-test" },
      tags: ["test"]
    });

    const byId = await repository.getMemoryById(created.id);
    const recent = await repository.listRecentMemories(5);

    expect(byId?.content).toBe("The user is testing memory.");
    expect(byId?.subtype).toBeNull();
    expect(byId?.sourceTraceId).toBeNull();
    expect(byId?.metadata).toEqual({ origin: "unit-test" });
    expect(recent.map((memory) => memory.id)).toContain(created.id);
  });

  it("normalizes supported MEMORY_REPOSITORY values", () => {
    expect(parseMemoryRepositoryEnv({ MEMORY_REPOSITORY: "memory" }).kind).toBe("in-memory");
    expect(parseMemoryRepositoryEnv({ MEMORY_REPOSITORY: "in-memory" }).kind).toBe("in-memory");
    expect(parseMemoryRepositoryEnv({ MEMORY_REPOSITORY: "postgres" }).kind).toBe("postgres");
    expect(createMemoryRepositoryFromEnv({ MEMORY_REPOSITORY: "memory" }).kind).toBe("in-memory");
  });

  it("fails clearly for invalid MEMORY_REPOSITORY values", () => {
    expect(() => parseMemoryRepositoryEnv({ MEMORY_REPOSITORY: "sqlite" })).toThrow(/Valid values/);
  });

  it("assigns Memory Model v2 defaults for existing create paths", async () => {
    const repository = new InMemoryMemoryRepository();
    const created = await repository.createMemory({
      type: "semantic",
      subtype: "project",
      content: "用户正在开发 YUVI Runtime。",
      source: "test",
      tags: ["yuvi"]
    });

    expect(created).toMatchObject({
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      status: "active",
      supersedes: [],
      supersededBy: null,
      contradicts: []
    });
    expect(created.observedAt).toBeInstanceOf(Date);
    expect(created.validFrom).toBeInstanceOf(Date);
    expect(created.expiresAt).toBeNull();
  });

  it("defaults identity fields safely and filters by subject user and persona", async () => {
    const repository = new InMemoryMemoryRepository();
    const defaultMemory = await repository.createMemory({
      type: "semantic",
      subtype: "identity",
      content: "用户的名字是 Alex。",
      source: "test",
      tags: ["identity"]
    });
    await repository.createMemory({
      type: "semantic",
      subtype: "preference",
      content: "另一个用户喜欢深色主题。",
      source: "test",
      personaId: "default-persona",
      subjectUserId: "other-user",
      createdByUserId: "other-user",
      tags: ["preference"]
    });

    expect(defaultMemory.personaId).toBe("default-persona");
    expect(defaultMemory.subjectUserId).toBe("default-user");
    expect(defaultMemory.createdByUserId).toBe("default-user");

    const results = await repository.searchMemoriesByTextFallback({
      text: "用户",
      personaId: "default-persona",
      subjectUserId: "default-user",
      limit: 10
    });
    expect(results.map((memory) => memory.content)).toContain("用户的名字是 Alex。");
    expect(results.map((memory) => memory.content)).not.toContain("另一个用户喜欢深色主题。");
  });

  it("detects CurrentAffect without storing one-off mood as long-term memory", async () => {
    const affect = detectCurrentAffect({
      text: "这个报错我看不懂，快崩溃了",
      sourceTraceId: "trace-affect"
    });
    expect(affect?.affectLabel).toBe("frustrated");
    expect(affect?.sourceTraceId).toBe("trace-affect");

    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const candidates = await service.extractCandidates({
      userMessage: "今天有点烦。",
      timestamp: "2026-05-26T10:00:00.000Z"
    });
    expect(candidates).toHaveLength(0);
  });

  it("stores stable user preferences as semantic core memory", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(
      repository,
      undefined,
      undefined,
      new RuleBasedMemoryExtractor()
    );
    const candidates = await service.extractCandidates({
      userMessage: "我喜欢芒果蛋糕。",
      timestamp: "2026-05-26T10:00:00.000Z"
    });

    expect(candidates[0]).toMatchObject({
      type: "semantic",
      subtype: "preference",
      memoryLayer: "core",
      reason: "stable-preference"
    });

    const stored = await service.processCandidateForStorage(candidates[0]!, { source: "runtime" });
    expect(stored.decision).toBe("stored");
    expect(stored.memory).toMatchObject({
      type: "semantic",
      subtype: "preference",
      memoryLayer: "core",
      status: "active"
    });
    expect(stored.memory?.metadata["retentionClass"]).toBe("durable-user");
    expect(stored.memory?.expiresAt).toBeNull();
  });

  it("stores durable emotional patterns but not one-off emotional state", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(
      repository,
      undefined,
      undefined,
      new RuleBasedMemoryExtractor()
    );
    const stored = await service.processCandidateForStorage(
      {
        type: "emotional",
        subtype: "emotional-pattern",
        memoryLayer: "recall",
        content: "用户在长时间项目调试失败时容易焦虑，偏好直接、分步骤排错。",
        importance: 0.72,
        tags: ["emotional-pattern", "debugging"],
        reason: "durable-emotional-pattern",
        observedAt: "2026-05-26T10:00:00.000Z"
      },
      { source: "runtime" }
    );
    expect(stored.decision).toBe("stored");
    expect(stored.memory?.metadata["retentionClass"]).toBe("emotional-pattern");
    expect(stored.memory?.expiresAt).toBeInstanceOf(Date);

    const oneOff = await service.extractCandidates({
      userMessage: "今天有点焦虑。",
      timestamp: "2026-05-26T10:00:00.000Z"
    });
    expect(oneOff).toHaveLength(0);
  });

  it("applies retention policy for explicit daily and smoke memories", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const daily = await service.processCandidateForStorage(
      {
        type: "episodic",
        subtype: "event",
        memoryLayer: "recall",
        content: "记住：用户在 2026-05-26 早上吃了芒果蛋糕。",
        importance: 0.55,
        tags: ["meal"],
        reason: "explicit-remember",
        metadata: { explicitRemember: true },
        observedAt: "2026-05-26T08:00:00.000Z"
      },
      { source: "runtime" }
    );
    expect(daily.decision).toBe("stored");
    expect(daily.memory?.expiresAt?.toISOString()).toBe("2026-06-02T08:00:00.000Z");
    expect(daily.memory?.metadata["retentionClass"]).toBe("episodic-daily");

    const smoke = await service.rememberCandidate(
      {
        type: "semantic",
        subtype: "test",
        content: "Smoke test memory should expire quickly.",
        importance: 0.5,
        tags: ["smoke"],
        reason: "smoke-test"
      },
      { source: "smoke" }
    );
    expect(smoke.expiresAt).toBeInstanceOf(Date);
    expect((smoke.expiresAt?.getTime() ?? 0) - smoke.createdAt.getTime()).toBeLessThanOrEqual(
      86_400_000 + 1000
    );
    expect(smoke.metadata["testMemory"]).toBe(true);
  });

  it("keeps smoke/test memories out of normal retrieval and fallback recent", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const smoke = await service.createMemory({
      type: "semantic",
      content: "Smoke test memory.",
      source: "smoke",
      tags: ["smoke"]
    });
    await service.createMemory({
      type: "semantic",
      content: "Durable provider preference uses DeepSeek.",
      source: "manual",
      tags: ["provider"]
    });

    expect(smoke.metadata["testMemory"]).toBe(true);
    expect(smoke.memoryLayer).not.toBe("core");
    expect(smoke.importance).toBeLessThanOrEqual(0.3);
    expect(smoke.expiresAt).toBeInstanceOf(Date);

    const normal = await service.retrieveRelevantMemoriesWithMetadata({
      text: "Smoke test memory.",
      limit: 5
    });
    expect(normal.selectedMemories.map((memory) => memory.id)).not.toContain(smoke.id);
    expect(normal.rawMemories.find((memory) => memory.id === smoke.id)?.excludedReason).toBe(
      "test-memory"
    );

    const fallback = await service.retrieveRelevantMemoriesWithMetadata({
      text: "zzzz-no-match",
      limit: 5
    });
    expect(fallback.retrievalMode).toBe("fallback-recent");
    expect(fallback.selectedMemories.map((memory) => memory.id)).not.toContain(smoke.id);

    const included = await service.retrieveRelevantMemoriesWithMetadata({
      text: "Smoke test memory.",
      includeTestMemories: true,
      limit: 5
    });
    expect(included.selectedMemories.map((memory) => memory.id)).toContain(smoke.id);
  });

  it("maintenance repairs legacy smoke memories without hard delete", async () => {
    const repository = new InMemoryMemoryRepository();
    const legacy = await repository.createMemory({
      type: "semantic",
      memoryLayer: "core",
      content: "Smoke test memory.",
      source: "runtime",
      importance: 0.95,
      observedAt: "2026-05-20T00:00:00.000Z",
      validFrom: "2026-05-20T00:00:00.000Z"
    });
    expect(legacy.expiresAt).toBeNull();

    const maintenance = new MemoryMaintenanceService(repository);
    const summary = await maintenance.run({
      now: new Date(legacy.createdAt.getTime() + 8 * 86_400_000)
    });
    const repaired = await repository.getMemoryById(legacy.id);

    expect(summary.expired).toBe(1);
    expect(repaired).toMatchObject({
      id: legacy.id,
      status: "expired",
      memoryLayer: "recall"
    });
    expect(repaired?.expiresAt?.getTime()).toBe((repaired?.createdAt.getTime() ?? 0) + 86_400_000);
    expect(repaired?.metadata["testMemory"]).toBe(true);
  });

  it("updates and deletes in-memory memory records", async () => {
    const repository = new InMemoryMemoryRepository();
    const created = await repository.createMemory({
      type: "working",
      content: "Temporary memory.",
      source: "test",
      tags: ["draft"]
    });

    const updated = await repository.updateMemory(created.id, {
      type: "semantic",
      subtype: "fact",
      content: "Stable memory.",
      summary: "Stable summary.",
      importance: 0.9,
      emotionValence: 0.2,
      emotionArousal: 0.3,
      metadata: { edited: true },
      tags: ["stable"]
    });

    expect(updated).toMatchObject({
      id: created.id,
      type: "semantic",
      subtype: "fact",
      content: "Stable memory.",
      summary: "Stable summary.",
      importance: 0.9,
      emotionValence: 0.2,
      emotionArousal: 0.3,
      metadata: { edited: true },
      tags: ["stable"]
    });
    expect(updated?.createdAt).toEqual(created.createdAt);
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    await expect(repository.updateMemory("missing", { content: "nope" })).resolves.toBeNull();
    await expect(repository.deleteMemory(created.id)).resolves.toBe(true);
    await expect(repository.getMemoryById(created.id)).resolves.toBeNull();
    await expect(repository.deleteMemory(created.id)).resolves.toBe(false);
  });

  it("retrieves mixed Chinese and English memories from a natural-language turn", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。",
      source: "test",
      tags: ["yuvi", "runtime"]
    });

    const memories = await service.retrieveRelevantMemories({
      text: "YUVI Runtime 是什么项目？",
      limit: 5
    });

    expect(memories.length).toBeGreaterThan(0);
    expect(memories[0]?.content).toContain("YUVI Runtime");
  });

  it("stores deterministic embedding metadata when an embedding provider is available", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createTestEmbeddingProvider()
    });

    const created = await service.createMemory({
      type: "semantic",
      content: "YUVI Runtime uses DeepSeek for chat.",
      summary: "YUVI provider choice.",
      source: "test",
      tags: ["yuvi", "deepseek"]
    });

    expect(created.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(created.embeddingProvider).toBe("mock-test");
    expect(created.embeddingModel).toBe("mock-test-model");
    expect(created.embeddingDimensions).toBe(3);
    expect(created.embeddedAt).toBeInstanceOf(Date);
  });

  it("stores memory without embedding if embedding generation fails", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createFailingEmbeddingProvider()
    });

    const created = await service.createMemory({
      type: "semantic",
      content: "YUVI Runtime survives embedding outages.",
      source: "test",
      tags: ["yuvi"]
    });

    expect(created.content).toContain("survives");
    expect(created.embedding).toBeNull();
    expect(created.embeddingProvider).toBeNull();
    expect(created.metadata["embeddingError"]).toContain("embedding unavailable");
    expect(created.metadata["embeddingError"]).toContain("provider=failing-test");

    const retrieved = await service.retrieveRelevantMemoriesWithMetadata({
      text: "embedding outages",
      limit: 5
    });
    expect(retrieved.memories[0]?.displayText).toContain("embedding outages");
    expect(retrieved.vectorEnabled).toBe(true);
    expect(retrieved.vectorUsed).toBe(false);
    expect(retrieved.fallbackUsed).toBe(true);
    expect(retrieved.fallbackReason).toContain("embedding unavailable");
  });

  it("does not store vectors when embedding dimensions mismatch", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createWrongDimensionEmbeddingProvider()
    });

    const created = await service.createMemory({
      type: "semantic",
      content: "YUVI Runtime avoids storing wrong-size vectors.",
      source: "test",
      tags: ["yuvi"]
    });

    expect(created.embedding).toBeNull();
    expect(created.embeddingProvider).toBeNull();
    expect(created.embeddingDimensions).toBeNull();
    expect(created.metadata["embeddingError"]).toContain("expectedDimensions=3");
    expect(created.metadata["embeddingError"]).not.toContain("Bearer");
  });

  it("regenerates embedding metadata when memory text changes", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createTestEmbeddingProvider()
    });
    const created = await service.createMemory({
      type: "semantic",
      content: "Old content",
      source: "test",
      tags: ["old"]
    });

    const updated = await service.updateMemory(created.id, {
      content: "New content for embedding regeneration.",
      tags: ["new"]
    });

    expect(updated?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(updated?.embeddingProvider).toBe("mock-test");
    expect(updated?.embeddedAt).toBeInstanceOf(Date);
  });

  it("uses vector retrieval when configured but keeps exact keyword matches ranked first", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createTestEmbeddingProvider()
    });
    await service.createMemory({
      type: "semantic",
      subtype: "provider-choice",
      content: "用户偏好 Chat 和 Reasoning 使用 DeepSeek。",
      source: "manual",
      tags: ["provider", "deepseek"],
      importance: 0.9
    });
    await service.createMemory({
      type: "semantic",
      content: "A vague companion architecture preference.",
      source: "manual",
      tags: ["general"],
      importance: 0.2
    });

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "DeepSeek provider",
      limit: 5
    });

    expect(result.vectorEnabled).toBe(true);
    expect(result.vectorUsed).toBe(true);
    expect(result.queryEmbeddingGenerated).toBe(true);
    expect(result.vectorResultCount).toBeGreaterThan(0);
    expect(result.retrievalMode).toBe("in-memory-hybrid");
    expect(result.memories[0]?.displayText).toContain("DeepSeek");
    expect(result.memories[0]?.matchedBy).not.toBe("vector");
  });

  it("excludes non-active or temporally invalid memories from prompt retrieval", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "Active YUVI Runtime memory.",
      source: "test",
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Forgotten YUVI Runtime memory.",
      source: "test",
      status: "forgotten",
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Archived YUVI Runtime memory.",
      source: "test",
      status: "archived",
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Superseded YUVI Runtime memory.",
      source: "test",
      status: "superseded",
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Expired YUVI Runtime memory.",
      source: "test",
      expiresAt: new Date(Date.now() - 1000),
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Future-valid YUVI Runtime memory.",
      source: "test",
      validFrom: new Date(Date.now() + 60_000),
      tags: ["yuvi"]
    });

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime",
      limit: 10
    });

    expect(result.memories.map((memory) => memory.displayText)).toEqual([
      "Active YUVI Runtime memory."
    ]);
    expect(result.excludedByStatus).toBeGreaterThanOrEqual(3);
    expect(result.excludedByTime).toBeGreaterThanOrEqual(2);
    expect(result.currentTime).toMatch(/T/);
  });

  it("supports scope-filtered retrieval", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "Project-scoped YUVI Runtime memory.",
      source: "test",
      scope: "project",
      scopeId: "yuvi-runtime"
    });
    await repository.createMemory({
      type: "semantic",
      content: "User-scoped YUVI Runtime memory.",
      source: "test",
      scope: "user"
    });

    const projectResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime",
      scope: "project",
      scopeId: "yuvi-runtime",
      limit: 10
    });

    expect(projectResult.memories).toHaveLength(1);
    expect(projectResult.memories[0]?.scope).toBe("project");
    expect(projectResult.memories[0]?.scopeId).toBe("yuvi-runtime");
  });

  it("excludes unrelated project scope memories while keeping matching project and session memory", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "YUVI Runtime uses DeepSeek for chat.",
      source: "test",
      scope: "project",
      scopeId: "yuvi-runtime"
    });
    await repository.createMemory({
      type: "semantic",
      content: "Other project uses a different provider.",
      source: "test",
      scope: "project",
      scopeId: "other-project",
      tags: ["provider"]
    });
    await repository.createMemory({
      type: "working",
      content: "This session is debugging Memory Read Pipeline v2.",
      source: "test",
      scope: "session",
      scopeId: "session-1"
    });

    const projectResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "provider",
      projectId: "yuvi-runtime",
      limit: 10
    });
    const sessionResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "Memory Read Pipeline",
      sessionId: "session-1",
      projectId: "yuvi-runtime",
      limit: 10
    });

    expect(projectResult.memories.map((memory) => memory.scopeId)).not.toContain("other-project");
    expect(projectResult.excludedByScope).toBeGreaterThan(0);
    expect(sessionResult.memories.some((memory) => memory.scope === "session")).toBe(true);
    expect(sessionResult.includedScopes).toContainEqual({
      scope: "session",
      scopeId: "session-1"
    });
  });

  it("allows archived memories only when manual search opts in", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "Archived YUVI Runtime provider decision.",
      source: "test",
      status: "archived",
      tags: ["yuvi"]
    });

    const defaultResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime",
      limit: 10
    });
    const includedResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime",
      includeArchived: true,
      limit: 10
    });

    expect(defaultResult.memories).toHaveLength(0);
    expect(defaultResult.excludedByStatus).toBe(1);
    expect(includedResult.memories).toHaveLength(1);
    expect(includedResult.memories[0]?.status).toBe("archived");
    expect(includedResult.includeArchived).toBe(true);
  });

  it("updates lastAccessedAt when a memory is selected", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const created = await repository.createMemory({
      type: "semantic",
      content: "YUVI Runtime prompt retrieval uses scoped memory.",
      source: "test",
      tags: ["yuvi"]
    });
    const before = created.lastAccessedAt.getTime();
    await new Promise((resolve) => setTimeout(resolve, 2));

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "scoped memory",
      limit: 5
    });
    const after = await repository.getMemoryById(created.id);

    expect(result.memories[0]?.id).toBe(created.id);
    expect(after?.lastAccessedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("deduplicates display-equivalent memories and prefers semantic memory", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const content = "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。";
    await repository.createMemory({
      type: "working",
      content,
      importance: 1,
      source: "test",
      scope: "project",
      scopeId: "yuvi-runtime"
    });
    await repository.createMemory({
      type: "semantic",
      content: `" ${content} "`,
      importance: 0.5,
      source: "test"
    });

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime 是什么项目？",
      limit: 5
    });

    expect(result.retrievalMode).toBe("in-memory-keyword");
    expect(result.rawCount).toBeGreaterThan(1);
    expect(result.count).toBe(1);
    expect(result.memories[0]?.type).toBe("semantic");
    expect(result.memories[0]?.displayText).toBe(content);
    expect(result.rawMemories.some((memory) => memory.excludedReason?.startsWith("deduped"))).toBe(
      true
    );
  });

  it("ranks concise semantic memories ahead of verbose runtime episodic memories", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "episodic",
      content: [
        "User intent: YUVI Runtime 是什么项目？",
        `Assistant response summary: ${"This was a long generated answer. ".repeat(30)}`
      ].join("\n"),
      importance: 1,
      source: "runtime"
    });
    await repository.createMemory({
      type: "semantic",
      content: "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。",
      importance: 0.4,
      source: "manual"
    });

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime 是什么项目？",
      limit: 5
    });

    expect(result.memories[0]?.type).toBe("semantic");
    expect(result.memories[0]?.displayText).toContain("AI Companion Runtime");
  });

  it("normalizes noisy display text without mutating stored content", async () => {
    const repository = new InMemoryMemoryRepository();
    const stored = await repository.createMemory({
      type: "semantic",
      content: "“  - - 用户偏好 DeepSeek。\n\n\n  ”",
      source: "test"
    });

    expect(createMemoryDisplayText(stored)).toBe("用户偏好 DeepSeek。");
    expect(stored.content).toContain("“");
    expect(stored.content).toContain("- -");
  });

  it("searches memory tags and metadata through the local repository fallback", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      subtype: "project",
      content: "A stable project memory.",
      source: "dashboard",
      metadata: { project: "YUVI Runtime" },
      tags: ["项目", "runtime"]
    });

    const tagResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "项目",
      limit: 5
    });
    const metadataResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI",
      limit: 5
    });

    expect(tagResult.count).toBeGreaterThan(0);
    expect(metadataResult.count).toBeGreaterThan(0);
    expect(metadataResult.memories[0]?.metadata).toMatchObject({ project: "YUVI Runtime" });
  });

  it("returns retrieval debug metadata for summary, tag, command, and path matches", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      subtype: "project",
      content: "A concise project fact.",
      summary: "YUVI Runtime is an AI Companion Runtime.",
      source: "manual",
      tags: ["runtime"]
    });
    await repository.createMemory({
      type: "procedural",
      subtype: "command",
      content: "Run pnpm db:migrate before Postgres smoke tests.",
      source: "manual",
      tags: ["command"]
    });
    await repository.createMemory({
      type: "semantic",
      subtype: "path",
      content: "Windows source path is C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main.",
      source: "manual",
      tags: ["path"]
    });

    const summaryResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "AI Companion Runtime",
      limit: 5
    });
    const tagResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "command",
      limit: 5
    });
    const commandResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "pnpm db:migrate",
      limit: 5
    });
    const pathResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main",
      limit: 5
    });

    expect(summaryResult.memories[0]).toMatchObject({ matchedBy: "summary" });
    expect(summaryResult.retrievalMode).toBe("in-memory-keyword");
    expect(summaryResult.memories[0]?.score).toBeGreaterThan(0);
    expect(tagResult.memories[0]?.matchedBy).toBe("tag");
    expect(commandResult.memories[0]?.displayText).toContain("pnpm db:migrate");
    expect(pathResult.memories[0]?.displayText).toContain("Administrator.DESKTOP-NPU6DHJ");
  });

  it("supports Postgres Search v2 filter shape in the in-memory fallback", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      status: "active",
      content: "用户偏好 Chat 和 Reasoning 使用 DeepSeek。",
      source: "dashboard",
      tags: ["provider", "deepseek"],
      importance: 0.9
    });
    await repository.createMemory({
      type: "procedural",
      subtype: "command",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "recall",
      status: "active",
      content: "Run pnpm db:migrate before Postgres smoke tests.",
      source: "manual",
      tags: ["command", "postgres"],
      importance: 0.7
    });
    await repository.createMemory({
      type: "semantic",
      subtype: "path",
      scope: "user",
      memoryLayer: "core",
      status: "active",
      content: "Windows source path is C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main.",
      source: "manual",
      tags: ["path"],
      importance: 0.8
    });
    await repository.createMemory({
      type: "episodic",
      subtype: "milestone",
      scope: "project",
      scopeId: "other-project",
      memoryLayer: "recall",
      status: "archived",
      content: "Other project archived milestone.",
      source: "runtime",
      tags: ["provider"],
      importance: 1
    });

    const providerResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "DashScope STT DeepSeek provider",
      subtypes: ["provider-choice"],
      memoryLayers: ["core"],
      statuses: ["active"],
      sources: ["dashboard"],
      tags: ["provider"],
      minImportance: 0.8,
      projectId: "yuvi-runtime",
      limit: 5
    });
    const commandResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "pnpm db:migrate",
      subtypes: ["command"],
      tags: ["command"],
      projectId: "yuvi-runtime",
      limit: 5
    });
    const pathResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main",
      subtypes: ["path"],
      limit: 5
    });
    const archivedDefault = await service.retrieveRelevantMemoriesWithMetadata({
      text: "archived milestone",
      statuses: ["archived"],
      limit: 5
    });
    const archivedIncluded = await service.retrieveRelevantMemoriesWithMetadata({
      text: "archived milestone",
      statuses: ["archived"],
      includeArchived: true,
      includeSuperseded: true,
      includeExpired: true,
      projectId: "other-project",
      limit: 5
    });

    expect(providerResult.memories).toHaveLength(1);
    expect(providerResult.memories[0]).toMatchObject({
      subtype: "provider-choice",
      source: "dashboard"
    });
    expect(["content", "tag"]).toContain(providerResult.memories[0]?.matchedBy);
    expect(commandResult.memories[0]).toMatchObject({ subtype: "command" });
    expect(pathResult.memories[0]?.displayText).toContain("Administrator.DESKTOP-NPU6DHJ");
    expect(archivedDefault.memories).toHaveLength(0);
    expect(archivedIncluded.memories[0]).toMatchObject({ status: "archived" });
  });

  it("scores only durable memory-worthy interactions highly", () => {
    const scorer = new MemoryScorer();

    expect(scorer.scoreImportance("hi")).toBe(0);
    expect(scorer.scoreImportance("What is TypeScript?")).toBe(0);
    expect(scorer.scoreImportance("What is the current repo? I cannot determine the answer.")).toBe(
      0
    );
    expect(scorer.scoreImportance("记住：用户偏好 Chat 使用 DeepSeek。")).toBeGreaterThan(0.9);
    expect(
      scorer.scoreImportance("用户偏好 Chat/Reasoning 使用 DeepSeek，TTS 使用 xAI。")
    ).toBeGreaterThanOrEqual(0.8);
    expect(scorer.scoreImportance("项目里程碑：Dashboard provider observability 已完成。")).toBe(
      0.75
    );
  });

  it("stores runtime source trace and subtype metadata", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);

    const memory = await service.rememberInteraction({
      userMessage: "记住：用户偏好 Chat 使用 DeepSeek。",
      assistantMessage: "OK",
      source: "runtime",
      sourceTraceId: "trace-123"
    });

    expect(memory).toMatchObject({
      type: "semantic",
      subtype: "provider-choice",
      source: "runtime",
      sourceTraceId: "trace-123"
    });
    expect(memory?.metadata).toMatchObject({
      generatedBy: "rule-based-memory-extractor",
      reason: expect.any(String)
    });
  });

  it("does not store ordinary interactions without extractor candidates", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);

    const memory = await service.rememberInteraction({
      userMessage: "What is TypeScript?",
      assistantMessage: "TypeScript is JavaScript with types.",
      source: "runtime",
      sourceTraceId: "trace-ordinary"
    });

    expect(memory).toBeNull();
    await expect(repository.listRecentMemories()).resolves.toEqual([]);
  });

  it("extracts explicit remembered project paths as semantic path memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    const candidates = await extractor.extractCandidates({
      userMessage: "记住：我的项目路径是 /home/administrator/uv-main/uv-main",
      sourceTraceId: "trace-path"
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        type: "semantic",
        subtype: "path",
        content: "我的项目路径是 /home/administrator/uv-main/uv-main",
        importance: expect.any(Number),
        sourceTraceId: "trace-path"
      })
    ]);
    expect(candidates[0]?.importance).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts provider preferences as provider-choice memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    const candidates = await extractor.extractCandidates({
      userMessage: "以后 chat 用 DeepSeek，TTS 用 xAI"
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "semantic",
        subtype: "provider-choice",
        reason: "provider-choice"
      })
    );
  });

  it("classifies ordinary relative-time daily events as rejected episodic candidates", async () => {
    const extractor = new RuleBasedMemoryExtractor();
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, extractor);

    const candidates = await extractor.extractCandidates({
      userMessage: "我今早吃了芒果蛋糕",
      timestamp: "2026-05-23T02:00:00.000Z",
      sourceTraceId: "trace-mango"
    });
    const result = await service.processCandidateForStorage(candidates[0]!, {
      source: "runtime",
      tags: ["session-1"]
    });

    expect(candidates[0]).toMatchObject({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall"
    });
    expect(result.decision).toBe("rejected");
    expect(result.rejectedReason).toBe("ordinary-one-off-daily-event");
    expect(result.candidate.content).toContain("2026-05-23");
    expect(result.candidate.content).not.toContain("今早");
    expect(result.candidate.importance).toBeLessThan(0.65);
    expect(result.candidate.eventTime).toBeTruthy();
    expect(canonicalEventDate(result.candidate)).toBe("2026-05-23");
    expect(result.candidate.validFrom).toBeTruthy();
    expect(result.candidate.validUntil).toBeTruthy();
    expect(result.candidate.metadata).toMatchObject({
      originalTemporalText: "我今早吃了芒果蛋糕",
      temporalResolution: {
        relativeExpression: "今早",
        resolvedDate: "2026-05-23"
      }
    });
    await expect(repository.listRecentMemories()).resolves.toEqual([]);
  });

  it("stores explicit remembered daily events as time-bound episodic recall memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, extractor);
    const candidates = await extractor.extractCandidates({
      userMessage: "记住：我今早吃了芒果蛋糕",
      timestamp: "2026-05-23T02:00:00.000Z",
      sourceTraceId: "trace-explicit-mango"
    });

    const result = await service.processCandidateForStorage(candidates[0]!, {
      source: "runtime",
      tags: ["session-1"]
    });

    expect(result.decision).toBe("stored");
    expect(result.memory).toMatchObject({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall",
      sourceTraceId: "trace-explicit-mango"
    });
    expect(result.memory?.content).toContain("2026-05-23");
    expect(result.memory?.content).not.toContain("今早");
    expect(result.memory?.importance).toBeLessThan(0.65);
    expect(result.memory?.eventTime?.toISOString()).toContain("2026-05-23");
    expect(
      canonicalEventDate({
        type: "episodic",
        content: result.memory?.content ?? "",
        importance: 0.4,
        tags: [],
        reason: "test",
        ...(result.memory?.eventTime ? { eventTime: result.memory.eventTime.toISOString() } : {}),
        validFrom: result.memory?.validFrom.toISOString() ?? null
      })
    ).toBe("2026-05-23");
    expect(result.memory?.expiresAt?.toISOString()).toContain("2026-05-30");
    expect(result.storageReason).toBe("explicit-user-memory-request");
  });

  describe("explicit intent, provenance, temporal, and dedupe fixes", () => {
    const observedAt = "2026-06-22T09:44:28+08:00";

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-22T12:00:00+08:00"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("A stores explicit breakfast remember requests even when ordinary one-off", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        new RuleBasedMemoryExtractor()
      );
      const candidates = await service.extractCandidates({
        userMessage: "请记住，我今天早上没吃早饭。",
        timestamp: observedAt
      });

      expect(candidates[0]).toMatchObject({
        explicitRememberRequested: true,
        originRole: "user"
      });
      const result = await service.processCandidateForStorage(candidates[0]!, {
        source: "runtime"
      });
      expect(result).toMatchObject({
        decision: "stored",
        storageReason: "explicit-user-memory-request"
      });
      expect(result.memory).toMatchObject({
        type: "episodic",
        memoryLayer: "recall"
      });
      expect(result.memory?.metadata?.["retentionReason"]).toBe(
        "explicitly requested short-lived episodic event"
      );
    });

    it("B rejects ordinary one-off breakfast statements without explicit remember intent", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        new RuleBasedMemoryExtractor()
      );
      const candidates = await service.extractCandidates({
        userMessage: "我今天早上没吃早饭。",
        timestamp: observedAt
      });
      const result = await service.processCandidateForStorage(candidates[0]!, {
        source: "runtime"
      });
      expect(result.decision).toBe("rejected");
      expect(result.rejectedReason).toBe("ordinary-one-off-daily-event");
    });

    it("C keeps only the user-source candidate when assistant restates the same fact", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        createBreakfastScenarioExtractor()
      );
      const candidates = await service.extractCandidates({
        userMessage: "请记住，我今天早上没吃早饭。",
        assistantMessage: "好的，我记住了，你今天早上没吃早饭。",
        timestamp: observedAt
      });
      const decisions = await Promise.all(
        candidates.map((candidate) =>
          service.processCandidateForStorage(candidate, { source: "runtime" })
        )
      );
      const stored = decisions.filter((decision) => decision.decision === "stored");
      const rejected = decisions.filter((decision) => decision.decision === "rejected");
      expect(stored).toHaveLength(1);
      expect(stored[0]?.candidate.originRole ?? stored[0]?.candidate.metadata?.["originRole"]).toBe(
        "user"
      );
      expect(
        rejected.some(
          (decision) =>
            decision.rejectedReason === "assistant-only-restatement" ||
            decision.rejectedReason === "duplicate-candidate"
        )
      ).toBe(true);
    });

    it("D does not create a second memory when assistant recalls a prior saved fact", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        new RuleBasedMemoryExtractor()
      );
      const first = await service.extractCandidates({
        userMessage: "请记住，我今天早上没吃早饭。",
        timestamp: observedAt
      });
      await service.processCandidateForStorage(first[0]!, { source: "runtime" });

      const second = await service.extractCandidates({
        userMessage: "我刚才说了什么？",
        assistantMessage: "你说今天早上没有吃早饭。",
        timestamp: "2026-06-22T10:00:00+08:00"
      });
      const assistantOnly = second.find(
        (candidate) =>
          candidate.originRole === "assistant" || candidate.metadata?.["originRole"] === "assistant"
      );
      if (assistantOnly) {
        const rejected = await service.processCandidateForStorage(assistantOnly, {
          source: "runtime"
        });
        expect(rejected.decision).toBe("rejected");
        expect(rejected.rejectedReason).toBe("assistant-only-restatement");
      }
      expect(
        (await repository.listRecentMemories(10)).filter((memory) => memory.status === "active")
      ).toHaveLength(1);
    });

    it("E allows user correction candidates without assistant-only rejection", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        new RuleBasedMemoryExtractor()
      );
      const correction: MemoryCandidate = {
        type: "episodic",
        subtype: "event",
        memoryLayer: "recall",
        content: "用户今天早上其实吃了一个面包。",
        importance: 0.55,
        tags: ["meal", "event"],
        reason: "user-correction",
        originRole: "user",
        metadata: {
          extractionUserMessage: "不对，我其实吃了一个面包。",
          extractionAssistantMessage: "明白了，你今天早上吃了一个面包。"
        },
        observedAt
      };
      const result = await service.processCandidateForStorage(correction, { source: "runtime" });
      expect(result.rejectedReason).not.toBe("assistant-only-restatement");
    });

    it("F keeps temporal normalization idempotent", () => {
      const base: MemoryCandidate = {
        type: "episodic",
        subtype: "event",
        content: "我今天早上没吃早饭。",
        importance: 0.4,
        tags: ["meal"],
        reason: "ordinary-one-off-daily-event",
        observedAt
      };
      const first = normalizeTemporalCandidate(base, {
        timestamp: observedAt,
        timezone: "Asia/Shanghai"
      });
      const second = normalizeTemporalCandidate(first.candidate, {
        timestamp: observedAt,
        timezone: "Asia/Shanghai"
      });
      expect(second.candidate.content).toBe(first.candidate.content);
      expect(second.candidate.summary).toBe(first.candidate.summary);
      expect(second.candidate.eventTime).toBe(first.candidate.eventTime);
      expect(second.candidate.validFrom).toBe(first.candidate.validFrom);
      expect(second.candidate.validUntil).toBe(first.candidate.validUntil);
      expect(second.candidate.expiresAt).toBe(first.candidate.expiresAt);
    });

    it("G does not inject duplicate absolute dates into already dated content", () => {
      const candidate: MemoryCandidate = {
        type: "episodic",
        subtype: "event",
        content: "用户在 2026-06-22 早上没吃早饭。",
        importance: 0.4,
        tags: ["meal"],
        reason: "test",
        observedAt
      };
      const normalized = normalizeTemporalCandidate(candidate, {
        timestamp: observedAt,
        timezone: "Asia/Shanghai"
      }).candidate;
      expect(normalized.content).not.toMatch(/2026-06-22.*2026-06-22/);
      expect(normalized.content).not.toContain("在 2026-06-22 在");
    });

    it("H canonicalizes Chinese date expressions to a single absolute date", () => {
      const candidate: MemoryCandidate = {
        type: "episodic",
        subtype: "event",
        content: "用户于2026年6月22日早上没吃早饭。",
        importance: 0.4,
        tags: ["meal"],
        reason: "test",
        observedAt
      };
      const normalized = normalizeTemporalCandidate(candidate, {
        timestamp: observedAt,
        timezone: "Asia/Shanghai"
      }).candidate;
      expect(normalized.content).toContain("2026-06-22");
      expect(normalized.content).not.toMatch(/2026年6月22日/);
      expect((normalized.content.match(/2026-06-22/g) ?? []).length).toBe(1);
    });

    it("normalizes near-identical breakfast phrasing to the same fingerprint content", () => {
      const left = normalizeContentForFingerprint("用户在 2026-06-22 早上没吃早饭。");
      const right = normalizeContentForFingerprint("用户于2026年6月22日上午未吃早餐。");
      expect(left).toBe("用户2026-06-22早上没吃早饭");
      expect(right).toBe(left);
    });

    it("I deduplicates near-identical breakfast candidates by fingerprint", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        createNearDuplicateExtractor()
      );
      const candidates = await service.extractCandidates({
        userMessage: "请记住，我今天早上没吃早饭。",
        assistantMessage: "好的，我记住了。",
        timestamp: observedAt
      });
      const fingerprints = candidates.map((candidate) => buildCandidateFingerprint(candidate));
      expect(new Set(fingerprints).size).toBe(1);
      const decisions = await Promise.all(
        candidates.map((candidate) =>
          service.processCandidateForStorage(candidate, { source: "runtime" })
        )
      );
      expect(decisions.filter((decision) => decision.decision === "stored")).toHaveLength(1);
      expect(
        decisions.filter((decision) => decision.rejectedReason === "duplicate-candidate").length
      ).toBeGreaterThan(0);
    });

    it("J allows manual accept to bypass ordinary one-off rejection", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        new RuleBasedMemoryExtractor()
      );
      const candidates = await service.extractCandidates({
        userMessage: "我今天早上没吃早饭。",
        timestamp: observedAt
      });
      const auto = await service.processCandidateForStorage(candidates[0]!, { source: "runtime" });
      expect(auto.decision).toBe("rejected");
      const manual = await service.processCandidateForStorage(candidates[0]!, {
        source: "dashboard",
        skipAdmissionPolicy: true,
        storageReason: "manual-accept"
      });
      expect(manual).toMatchObject({
        decision: "stored",
        storageReason: "manual-accept"
      });
    });

    it("A stores user corrections over ordinary one-off daily event rejection", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        new RuleBasedMemoryExtractor()
      );
      const first = await service.extractCandidates({
        userMessage: "请记住，我今天早上没吃早饭。",
        timestamp: observedAt
      });
      await service.processCandidateForStorage(first[0]!, { source: "runtime" });

      const correction = await service.extractCandidates({
        userMessage: "不对，我后来想起来了，今天早上其实吃了一个面包。",
        timestamp: "2026-06-22T10:45:58+08:00"
      });
      expect(correction[0]).toMatchObject({
        correctionRequested: true,
        originRole: "user"
      });
      const result = await service.processCandidateForStorage(correction[0]!, {
        source: "runtime"
      });
      expect(result).toMatchObject({
        decision: "stored",
        storageReason: "user-correction"
      });
    });

    it("B auto-supersedes stale breakfast memory after user correction", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        new RuleBasedMemoryExtractor()
      );
      const first = await service.extractCandidates({
        userMessage: "请记住，我今天早上没吃早饭。",
        timestamp: observedAt
      });
      const stored = await service.processCandidateForStorage(first[0]!, { source: "runtime" });
      const oldId = stored.memory?.id;
      expect(oldId).toBeTruthy();

      const correction = await service.extractCandidates({
        userMessage: "不对，我后来想起来了，今天早上其实吃了一个面包。",
        timestamp: "2026-06-22T10:45:58+08:00"
      });
      const result = await service.processCandidateForStorage(correction[0]!, {
        source: "runtime"
      });
      const old = await repository.getMemoryById(oldId!);
      expect(result.memory?.status).toBe("active");
      expect(result.memory?.supersedes).toContain(oldId);
      expect(old).toMatchObject({
        status: "superseded",
        supersededBy: result.memory?.id
      });
    });

    it("C does not treat unrelated 其实 statements as correction without prior memory", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        new RuleBasedMemoryExtractor()
      );
      expect(detectCorrectionRequest("其实我今天下午喝了一杯水。")).toBe(true);
      const candidates = await service.extractCandidates({
        userMessage: "其实我今天下午喝了一杯水。",
        timestamp: observedAt
      });
      const result = await service.processCandidateForStorage(candidates[0]!, {
        source: "runtime"
      });
      expect(result.decision).toBe("rejected");
      expect(result.storageReason).toBeUndefined();
    });

    it("D marks canonicalized breakfast content as resolved temporal status", () => {
      const candidate: MemoryCandidate = {
        type: "episodic",
        subtype: "event",
        content: "在2026-06-22早上，用户没吃早饭。",
        importance: 0.4,
        tags: ["meal"],
        reason: "test",
        observedAt,
        metadata: {
          temporalNormalized: true,
          canonicalEventDate: "2026-06-22"
        }
      };
      expect(hasUnresolvedRelativeTime(candidate)).toBe(false);
      expect(resolveTemporalDebug(candidate)).toMatchObject({
        temporalStatus: "normalized"
      });
      expect(resolveTemporalDebug(candidate).temporalSuggestion).toBeUndefined();
    });

    it("E reports unresolved relative time only before canonical normalization", () => {
      const unresolved: MemoryCandidate = {
        type: "episodic",
        subtype: "event",
        content: "用户今天早上没吃早饭。",
        importance: 0.4,
        tags: ["meal"],
        reason: "test",
        observedAt
      };
      expect(hasUnresolvedRelativeTime(unresolved)).toBe(true);
      const normalized = normalizeTemporalCandidate(unresolved, {
        timestamp: observedAt,
        timezone: "Asia/Shanghai"
      }).candidate;
      expect(hasUnresolvedRelativeTime(normalized)).toBe(false);
    });

    it("G uses local day boundaries for validFrom and validUntil", () => {
      const candidate: MemoryCandidate = {
        type: "episodic",
        subtype: "event",
        content: "用户在 2026-06-22 早上没吃早饭。",
        importance: 0.4,
        tags: ["meal"],
        reason: "test",
        observedAt: "2026-06-22T10:45:58+08:00"
      };
      const normalized = normalizeTemporalCandidate(candidate, {
        timestamp: "2026-06-22T10:45:58+08:00",
        timezone: "Asia/Shanghai"
      }).candidate;
      const bounds = resolveCanonicalTemporalBounds(normalized, "Asia/Shanghai");
      expect(bounds?.validFrom).toBe("2026-06-21T16:00:00.000Z");
      expect(bounds?.validUntil).toBe("2026-06-22T16:00:00.000Z");
      expect(normalized.observedAt).toBe("2026-06-22T10:45:58+08:00");
    });

    it("H recomputes temporal fields after edited canonical content", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(repository);
      const original = await service.processCandidateForStorage(
        {
          type: "episodic",
          subtype: "event",
          content: "用户在 2026-06-22 早上没吃早饭。",
          importance: 0.4,
          tags: ["meal"],
          reason: "test",
          observedAt,
          metadata: { temporalNormalized: true, canonicalEventDate: "2026-06-22" }
        },
        { source: "dashboard", skipAdmissionPolicy: true, storageReason: "manual-accept" }
      );
      const edited = await service.processCandidateForStorage(
        {
          ...original.candidate,
          content: "用户在 2026-06-23 早上吃了一个面包。",
          metadata: {
            ...(original.candidate.metadata ?? {}),
            temporalNormalized: false,
            canonicalEventDate: undefined,
            canonicalFingerprint: undefined,
            canonicalEventKey: undefined
          }
        },
        { source: "dashboard", skipAdmissionPolicy: true, storageReason: "manual-accept" }
      );
      expect(canonicalEventDate(edited.candidate)).toBe("2026-06-23");
      expect(edited.candidate.metadata?.["canonicalEventDate"]).toBe("2026-06-23");
    });

    it("I retrieves corrected breakfast fact instead of superseded memory", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        new RuleBasedMemoryExtractor()
      );
      const first = await service.extractCandidates({
        userMessage: "请记住，我今天早上没吃早饭。",
        timestamp: observedAt
      });
      await service.processCandidateForStorage(first[0]!, { source: "runtime" });
      const correction = await service.extractCandidates({
        userMessage: "不对，我后来想起来了，今天早上其实吃了一个面包。",
        timestamp: "2026-06-22T10:45:58+08:00"
      });
      await service.processCandidateForStorage(correction[0]!, { source: "runtime" });

      const result = await service.retrieveRelevantMemoriesWithMetadata({
        text: "我今天早上到底吃饭了吗",
        currentTime: "2026-06-22T12:00:00+08:00",
        limit: 5
      });
      expect(result.memories.some((memory) => memory.displayText.includes("面包"))).toBe(true);
      expect(
        result.memories.every(
          (memory) => !memory.displayText.includes("没吃早饭") || memory.status === "superseded"
        )
      ).toBe(true);
    });

    it("K keeps canonical event date stable across near-identical phrasing", async () => {
      const repository = new InMemoryMemoryRepository();
      const service = new MemoryService(
        repository,
        undefined,
        undefined,
        createNearDuplicateExtractor()
      );
      const candidates = await service.extractCandidates({
        userMessage: "请记住，我今天早上没吃早饭。",
        timestamp: observedAt
      });
      const normalized = candidates.map(
        (candidate) =>
          normalizeTemporalCandidate(candidate, {
            timestamp: observedAt,
            timezone: "Asia/Shanghai"
          }).candidate
      );
      const dates = normalized.map((candidate) => canonicalEventDate(candidate));
      expect(new Set(dates)).toEqual(new Set(["2026-06-22"]));
    });
  });

  it("keeps stable mango cake preferences semantic core memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();
    const candidates = await extractor.extractCandidates({
      userMessage: "我喜欢芒果蛋糕",
      timestamp: "2026-05-23T02:00:00.000Z"
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "semantic",
        subtype: "preference",
        memoryLayer: "core"
      })
    );
  });

  it("excludes stale episodic memories from normal retrieval but allows historical episodic lookup", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall",
      content: "用户在 2026-05-23 早上吃了芒果蛋糕。",
      source: "test",
      tags: ["meal"],
      observedAt: "2026-05-23T02:00:00.000Z",
      eventTime: "2026-05-23T08:00:00.000Z",
      validFrom: "2026-05-23T08:00:00.000Z",
      validUntil: "2026-05-23T23:59:59.999Z",
      expiresAt: "2026-05-30T02:00:00.000Z"
    });
    await repository.createMemory({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall",
      status: "forgotten",
      content: "用户在 2026-05-23 晚上吃了芒果蛋糕秘密甜点。",
      source: "test",
      tags: ["meal"],
      validUntil: "2026-05-23T23:59:59.999Z",
      expiresAt: "2026-05-30T02:00:00.000Z"
    });

    const normal = await service.retrieveRelevantMemoriesWithMetadata({
      text: "芒果蛋糕",
      currentTime: "2026-06-02T00:00:00.000Z",
      limit: 5
    });
    const historical = await service.retrieveRelevantMemoriesWithMetadata({
      text: "之前吃过什么芒果蛋糕",
      includeHistoricalEpisodic: true,
      currentTime: "2026-06-02T00:00:00.000Z",
      limit: 5
    });

    expect(normal.memories).toHaveLength(0);
    expect(normal.excludedByTime).toBeGreaterThan(0);
    expect(historical.memories).toHaveLength(1);
    expect(historical.memories[0]?.displayText).toContain("芒果蛋糕");
    expect(historical.rawMemories.some((memory) => memory.status === "forgotten")).toBe(true);
    expect(historical.memories.some((memory) => memory.status === "forgotten")).toBe(false);
  });

  it("rejects low-confidence temporal normalization instead of rewriting aggressively", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const result = await service.processCandidateForStorage({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall",
      content: "最近我看了电影",
      importance: 0.5,
      tags: ["activity"],
      reason: "ordinary-one-off-daily-event",
      observedAt: "2026-05-23T02:00:00.000Z"
    });

    expect(result.decision).toBe("rejected");
    expect(result.rejectedReason).toBe("low-confidence-temporal-resolution");
    expect(result.candidate.content).toContain("最近");
    expect(result.candidate.metadata).toMatchObject({
      temporalResolution: {
        relativeExpression: "最近",
        confidence: 0.55
      }
    });
  });

  it("marks elapsed active memories expired without deleting them", async () => {
    const repository = new InMemoryMemoryRepository();
    const maintenance = new MemoryMaintenanceService(repository);
    const memory = await repository.createMemory({
      type: "semantic",
      subtype: "fact",
      content: "Temporary preference expires.",
      source: "test",
      status: "active",
      expiresAt: "2026-05-20T00:00:00.000Z",
      metadata: { safe: true }
    });

    const summary = await maintenance.run({ now: "2026-05-24T00:00:00.000Z" });
    const updated = await repository.getMemoryById(memory.id);

    expect(summary).toMatchObject({
      scanned: 1,
      expired: 1,
      failed: 0
    });
    expect(updated).toMatchObject({
      id: memory.id,
      status: "expired",
      content: "Temporary preference expires.",
      metadata: {
        safe: true,
        maintenanceReason: "expiresAt elapsed",
        expiredByMaintenance: true
      }
    });
  });

  it("dry-runs maintenance without modifying expired memories", async () => {
    const repository = new InMemoryMemoryRepository();
    const maintenance = new MemoryMaintenanceService(repository);
    const memory = await repository.createMemory({
      type: "semantic",
      content: "Dry run expired memory.",
      source: "test",
      status: "active",
      expiresAt: "2026-05-20T00:00:00.000Z"
    });

    const summary = await maintenance.run({
      dryRun: true,
      now: "2026-05-24T00:00:00.000Z"
    });
    const unchanged = await repository.getMemoryById(memory.id);

    expect(summary.expired).toBe(1);
    expect(unchanged?.status).toBe("active");
    expect(unchanged?.metadata).toEqual({});
  });

  it("reports stale episodic validity without expiring the memory", async () => {
    const repository = new InMemoryMemoryRepository();
    const maintenance = new MemoryMaintenanceService(repository);
    const memory = await repository.createMemory({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall",
      content: "用户在 2026-05-20 早上吃了早餐。",
      source: "test",
      status: "active",
      validUntil: "2026-05-20T23:59:59.999Z",
      expiresAt: "2026-05-30T00:00:00.000Z"
    });

    const summary = await maintenance.run({ now: "2026-05-24T00:00:00.000Z" });
    const updated = await repository.getMemoryById(memory.id);

    expect(summary.expired).toBe(0);
    expect(summary.stale).toBe(1);
    expect(updated).toMatchObject({
      status: "active",
      metadata: {
        maintenanceReason: "validUntil elapsed",
        staleByValidity: true
      }
    });
  });

  it("audits and safely fixes obvious supersession inconsistencies", async () => {
    const repository = new InMemoryMemoryRepository();
    const maintenance = new MemoryMaintenanceService(repository);
    const target = await repository.createMemory({
      type: "semantic",
      content: "Old provider choice.",
      source: "test"
    });
    const activeWithSupersededBy = await repository.createMemory({
      type: "semantic",
      content: "Active but points at newer memory.",
      source: "test",
      status: "active",
      supersededBy: target.id
    });
    const supersededMissingAt = await repository.createMemory({
      type: "semantic",
      content: "Superseded without timestamp.",
      source: "test",
      status: "superseded"
    });
    const missingRelation = await repository.createMemory({
      type: "semantic",
      content: "Supersedes missing memory id.",
      source: "test",
      supersedes: ["missing-memory-id"]
    });

    const summary = await maintenance.run({ now: "2026-05-24T00:00:00.000Z" });

    expect(summary.supersessionWarnings).toBe(3);
    expect(summary.warnings.map((warning) => warning.kind)).toEqual(
      expect.arrayContaining([
        "active-has-supersededBy",
        "superseded-missing-supersededAt",
        "supersedes-missing-memory"
      ])
    );
    expect((await repository.getMemoryById(activeWithSupersededBy.id))?.status).toBe("superseded");
    expect((await repository.getMemoryById(supersededMissingAt.id))?.supersededAt).toBeInstanceOf(
      Date
    );
    expect((await repository.getMemoryById(missingRelation.id))?.supersedes).toEqual([
      "missing-memory-id"
    ]);
    expect(JSON.stringify(summary)).not.toContain("Bearer");
  });

  it("auto-supersedes provider preferences in the same project scope", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const old = await repository.createMemory({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "用户偏好 Chat provider 使用 OpenAI。",
      source: "test",
      tags: ["provider", "chat", "openai"],
      importance: 0.9
    });

    const result = await service.processCandidateForStorage({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "用户偏好 Chat provider 使用 DeepSeek。",
      importance: 0.9,
      tags: ["provider", "chat", "deepseek"],
      reason: "provider-choice"
    });

    expect(result.decision).toBe("stored");
    expect(result.candidate.possibleSupersedes).toContain(old.id);
    expect(result.candidate.relationshipConfidence).toBeGreaterThanOrEqual(0.9);
    expect(result.memory?.supersedes).toContain(old.id);
    const superseded = await repository.getMemoryById(old.id);
    expect(superseded).toMatchObject({
      status: "superseded",
      supersededBy: result.memory?.id
    });
    expect(superseded?.supersededAt).toBeInstanceOf(Date);
  });

  it("auto-supersedes project paths in the same project scope only", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const sameProjectOld = await repository.createMemory({
      type: "semantic",
      subtype: "path",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "项目路径是 C:\\old-path",
      source: "test",
      tags: ["path", "project"],
      importance: 0.9
    });
    const otherProjectOld = await repository.createMemory({
      type: "semantic",
      subtype: "path",
      scope: "project",
      scopeId: "other-project",
      memoryLayer: "core",
      content: "项目路径是 C:\\other-old-path",
      source: "test",
      tags: ["path", "project"],
      importance: 0.9
    });

    const result = await service.processCandidateForStorage({
      type: "semantic",
      subtype: "path",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "项目路径改为 C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main",
      importance: 0.9,
      tags: ["path", "project"],
      reason: "project-path"
    });

    expect(result.decision).toBe("stored");
    expect(result.candidate.possibleSupersedes).toContain(sameProjectOld.id);
    expect(result.candidate.possibleSupersedes).not.toContain(otherProjectOld.id);
    expect((await repository.getMemoryById(sameProjectOld.id))?.status).toBe("superseded");
    expect((await repository.getMemoryById(otherProjectOld.id))?.status).toBe("active");
  });

  it("suggests but does not auto-apply safety-sensitive contradictions", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const old = await repository.createMemory({
      type: "semantic",
      subtype: "fact",
      scope: "user",
      memoryLayer: "core",
      content: "用户对芒果过敏。",
      source: "test",
      tags: ["health", "allergy"],
      importance: 0.9
    });

    const result = await service.processCandidateForStorage({
      type: "semantic",
      subtype: "fact",
      scope: "user",
      memoryLayer: "core",
      content: "用户不过敏芒果。",
      importance: 0.9,
      tags: ["health", "allergy"],
      reason: "health-note"
    });

    expect(result.decision).toBe("stored");
    expect(result.candidate.possibleContradictions).toContain(old.id);
    expect(result.memory?.supersedes).not.toContain(old.id);
    expect(result.memory?.contradicts).toContain(old.id);
    expect((await repository.getMemoryById(old.id))?.status).toBe("active");
  });

  it("keeps superseded memories out of normal retrieval but available in historical search", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const old = await repository.createMemory({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "用户偏好 Chat provider 使用 OpenAI。",
      source: "test",
      tags: ["provider", "chat", "openai"],
      importance: 0.9
    });
    await service.processCandidateForStorage({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "用户偏好 Chat provider 使用 DeepSeek。",
      importance: 0.9,
      tags: ["provider", "chat", "deepseek"],
      reason: "provider-choice"
    });

    const normal = await service.retrieveRelevantMemoriesWithMetadata({
      text: "Chat provider",
      scope: "project",
      scopeId: "yuvi-runtime",
      limit: 10
    });
    const historical = await service.retrieveRelevantMemoriesWithMetadata({
      text: "Chat provider",
      scope: "project",
      scopeId: "yuvi-runtime",
      includeSuperseded: true,
      limit: 10
    });

    expect(normal.memories.map((memory) => memory.id)).not.toContain(old.id);
    expect(normal.rawMemories.some((memory) => memory.id === old.id)).toBe(true);
    expect(historical.memories.map((memory) => memory.id)).toContain(old.id);
    expect(JSON.stringify(historical)).not.toContain("secret");
  });

  it("extracts startup commands, config decisions, and troubleshooting conclusions", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    await expect(
      extractor.extractCandidates({
        userMessage: "以后启动开发环境使用命令 pnpm dev"
      })
    ).resolves.toContainEqual(
      expect.objectContaining({
        type: "procedural",
        subtype: "command",
        reason: "command-or-startup-instruction"
      })
    );

    await expect(
      extractor.extractCandidates({
        userMessage: "默认使用 SERVER_PORT=6121 作为本地开发端口"
      })
    ).resolves.toContainEqual(
      expect.objectContaining({
        type: "semantic",
        subtype: "preference"
      })
    );

    await expect(
      extractor.extractCandidates({
        userMessage: "排错结论：Memory action failed 的原因是 DELETE 请求带了空 JSON body"
      })
    ).resolves.toContainEqual(
      expect.objectContaining({
        type: "procedural",
        subtype: "troubleshooting",
        reason: "troubleshooting-conclusion"
      })
    );
  });

  it("does not extract trivial greetings or ordinary questions", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    await expect(extractor.extractCandidates({ userMessage: "hi" })).resolves.toEqual([]);
    await expect(
      extractor.extractCandidates({ userMessage: "What is TypeScript?" })
    ).resolves.toEqual([]);
    await expect(
      extractor.extractCandidates({
        userMessage: "What is the current project path?",
        assistantMessage: "I cannot determine the answer because I lack context."
      })
    ).resolves.toEqual([]);
  });

  it("extracts project milestones as episodic milestone memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    const candidates = await extractor.extractCandidates({
      userMessage: "项目里程碑：Dashboard provider observability 已完成，并且 validation passed"
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "episodic",
        subtype: "milestone",
        reason: "project-milestone"
      })
    );
  });

  it("fails closed on ungrounded legacy LLM evidence before durable storage", async () => {
    let providerCalls = 0;
    const proposed = {
      candidates: [
        {
          type: "semantic",
          subtype: "preference",
          content: "User strongly prefers astronomy.",
          summary: "Strong astronomy preference",
          importance: 0.99,
          confidence: 0.99,
          tags: ["astronomy"],
          reason: "model inference",
          originRole: "user",
          metadata: { originRole: "user", evidenceText: "The weather is nice today." },
          sourceTraceId: "forged-trace-999",
          observedAt: "2020-01-01T00:00:00.000Z",
          eventTime: "2020-01-01T00:00:00.000Z",
          validFrom: "2020-01-01T00:00:00.000Z",
          validUntil: "2099-01-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      ]
    };
    const extractor = new LlmMemoryExtractor(
      {
        name: "test-reasoner",
        async generateReasoning() {
          providerCalls += 1;
          return { reasoning: JSON.stringify(proposed) };
        }
      },
      new RuleBasedMemoryExtractor(),
      { enabled: true, providerConfigured: true, providerName: "test-reasoner" }
    );
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, extractor);

    const candidates = await service.extractCandidates({
      userMessage: "The weather is nice today.",
      assistantMessage: "Okay.",
      sourceTraceId: "host-trace-1",
      timestamp: "2026-09-29T00:00:00.000Z"
    });
    for (const candidate of candidates) {
      await service.processCandidateForStorage(candidate, { source: "runtime" });
    }

    const stored = await repository.listRecentMemories(20);
    expect(candidates).toEqual([]);
    expect(stored.some((memory) => /astronomy/i.test(memory.content))).toBe(false);
    expect(stored.some((memory) => memory.sourceTraceId === "forged-trace-999")).toBe(false);
    expect(JSON.stringify(stored)).not.toContain("2020-01-01T00:00:00.000Z");
    expect(JSON.stringify(stored)).not.toContain("2099-01-01T00:00:00.000Z");
    expect(providerCalls).toBe(0);
    expect(extractor.getStatus()).toMatchObject({
      mode: "llm",
      active: "fallback-rule-based",
      enabled: true,
      provider: "test-reasoner",
      fallbackUsed: true,
      candidateCount: 0,
      skippedReason: expect.stringContaining("committed grounding")
    });
    expect(extractor.getStatus().skippedReason).toContain("unsupported-grounding");
    expect(extractor.getStatus().failureStage).toBeUndefined();
    expect(extractor.getStatus().error).toBeUndefined();
  });

  it("does not let assistant paraphrase or model-declared user provenance create evidence", async () => {
    let providerCalls = 0;
    const extractor = new LlmMemoryExtractor(
      {
        async generateReasoning() {
          providerCalls += 1;
          return {
            reasoning: JSON.stringify({
              candidates: [
                {
                  type: "semantic",
                  content: "User strongly prefers astronomy.",
                  importance: 0.99,
                  confidence: 0.99,
                  tags: [],
                  reason: "assistant paraphrase",
                  originRole: "user",
                  sourceTraceId: "forged-trace-999",
                  observedAt: "1900-01-01T00:00:00.000Z"
                }
              ]
            })
          };
        }
      },
      new RuleBasedMemoryExtractor(),
      { enabled: true, providerConfigured: true }
    );
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, extractor);

    const candidates = await service.extractCandidates({
      userMessage: "What do you think of astronomy?",
      assistantMessage: "You strongly prefer astronomy."
    });
    for (const candidate of candidates) {
      await service.processCandidateForStorage(candidate, { source: "runtime" });
    }

    expect(candidates).toEqual([]);
    expect(await repository.listRecentMemories(20)).toEqual([]);
    expect(providerCalls).toBe(0);
    expect(extractor.getStatus().skippedReason).toContain("committed grounding");
  });

  it("preserves explicit remember and correction behavior through the LLM-mode fallback", async () => {
    let providerCalls = 0;
    const extractor = new LlmMemoryExtractor(
      {
        async generateReasoning() {
          providerCalls += 1;
          throw new Error("must not call the reasoning provider");
        }
      },
      new RuleBasedMemoryExtractor(),
      { enabled: true, providerConfigured: true }
    );
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, extractor);
    const firstObservedAt = new Date();
    const correctionObservedAt = new Date(firstObservedAt.getTime() + 60_000);

    const remembered = await service.extractCandidates({
      userMessage: "请记住，我今天早上没吃早饭。",
      timestamp: firstObservedAt.toISOString()
    });
    expect(remembered[0]).toMatchObject({ explicitRememberRequested: true, originRole: "user" });
    expect(
      await service.processCandidateForStorage(remembered[0]!, { source: "runtime" })
    ).toMatchObject({
      decision: "stored",
      storageReason: "explicit-user-memory-request"
    });

    const correction = await service.extractCandidates({
      userMessage: "不对，我后来想起来了，今天早上其实吃了一个面包。",
      timestamp: correctionObservedAt.toISOString()
    });
    expect(correction[0]).toMatchObject({ correctionRequested: true, originRole: "user" });
    expect(
      await service.processCandidateForStorage(correction[0]!, { source: "runtime" })
    ).toMatchObject({
      decision: "stored",
      storageReason: "user-correction"
    });
    expect(providerCalls).toBe(0);
  });

  it("reports disabled and unconfigured LLM selections without calling a provider", async () => {
    let providerCalls = 0;
    const reasoner = {
      async generateReasoning() {
        providerCalls += 1;
        throw new Error("must not call the reasoning provider");
      }
    };
    const disabled = new LlmMemoryExtractor(reasoner);
    await disabled.extractCandidates({ userMessage: "以后 chat 用 DeepSeek" });
    expect(disabled.getStatus()).toMatchObject({
      mode: "llm",
      active: "fallback-rule-based",
      enabled: false,
      skippedReason: "LLM memory extraction is disabled until explicitly enabled."
    });

    const unconfigured = new LlmMemoryExtractor(reasoner, new RuleBasedMemoryExtractor(), {
      enabled: true,
      providerConfigured: false
    });
    await unconfigured.extractCandidates({ userMessage: "以后 chat 用 DeepSeek" });
    expect(unconfigured.getStatus().skippedReason).toContain("provider is not configured");
    expect(providerCalls).toBe(0);
  });

  it("extracts useful keywords from mixed Chinese and English input", () => {
    expect(extractSearchKeywords("YUVI Runtime 是什么项目？")).toEqual(
      expect.arrayContaining(["yuvi", "runtime", "项目"])
    );
  });

  it("uses in-memory storage by default unless postgres is explicit", () => {
    expect(createMemoryRepositoryFromEnv({ DATABASE_URL: "postgres://example" })).toBeInstanceOf(
      InMemoryMemoryRepository
    );
    expect(
      createMemoryRepositoryFromEnv({
        MEMORY_REPOSITORY: "postgres",
        DATABASE_URL: "postgres://example"
      })
    ).toBeInstanceOf(PostgresMemoryRepository);
    expect(() => createMemoryRepositoryFromEnv({ MEMORY_REPOSITORY: "postgres" })).toThrow(
      "DATABASE_URL"
    );
  });

  it("resolves DATABASE_URL from process env or .env text without printing it", () => {
    expect(
      resolveDatabaseUrl(
        { DATABASE_URL: "postgres://from-env" },
        "DATABASE_URL=postgres://from-file"
      )
    ).toBe("postgres://from-env");
    expect(resolveDatabaseUrl({}, "DATABASE_URL=postgres://from-file")).toBe(
      "postgres://from-file"
    );
    expect(parseDotEnv("# comment\nDATABASE_URL='postgres://quoted'\n")).toEqual({
      DATABASE_URL: "postgres://quoted"
    });
    expect(() => resolveDatabaseUrl({})).toThrow(MissingDatabaseUrlError);
  });

  it("ships idempotent PostgreSQL migration SQL", async () => {
    const migrations = await readSqlMigrations();
    const combinedSql = migrations
      .map((migration) => migration.sql)
      .join("\n")
      .toLowerCase();

    expect(combinedSql).toContain("create extension if not exists vector");
    expect(combinedSql).toContain("create extension if not exists pg_trgm");
    expect(combinedSql).toContain("metadata jsonb");
    expect(combinedSql).toContain("troubleshooting");
    expect(combinedSql).toContain("config");
    expect(combinedSql).toContain("create table if not exists memories");
    expect(combinedSql).toContain("create table if not exists entities");
    expect(combinedSql).toContain("create table if not exists relations");
    expect(combinedSql).toContain("memories_summary_trgm_idx");
    expect(combinedSql).toContain("memories_metadata_idx");
    expect(combinedSql).toContain("memories_subtype_idx");
    expect(combinedSql).toContain("memories_source_trace_id_idx");
    expect(combinedSql).toContain("memories_created_at_idx");
    expect(combinedSql).toContain("scope text not null default 'user'");
    expect(combinedSql).toContain("memory_layer text not null default 'recall'");
    expect(combinedSql).toContain("status text not null default 'active'");
    expect(combinedSql).toContain("valid_until");
    expect(combinedSql).toContain("expires_at");
    expect(combinedSql).toContain("superseded_by");
    expect(combinedSql).toContain("memories_scope_scope_id_idx");
    expect(combinedSql).toContain("memories_memory_layer_idx");
    expect(combinedSql).toContain("create table if not exists conversation_sessions");
    expect(combinedSql).toContain("create table if not exists conversation_messages");
    expect(combinedSql).toContain("sequence bigserial");
    expect(combinedSql).not.toMatch(/max\s*\(\s*sequence\s*\)/i);
    expect(combinedSql).toContain("conversation_messages_session_sequence_idx");
    expect(combinedSql).toContain("memories_status_idx");
    expect(combinedSql).toContain("memories_search_tsv_idx");
    expect(combinedSql).toContain("memories_scope_scope_id_status_idx");
    expect(combinedSql).toContain("memories_type_subtype_idx");
    expect(combinedSql).toContain("memories_source_trace_id_trgm_idx");
    expect(combinedSql).toContain("to_tsvector('simple'");
    expect(combinedSql).toContain("embedding_model");
    expect(combinedSql).toContain("embedding_provider");
    expect(combinedSql).toContain("embedding_dimensions");
    expect(combinedSql).toContain("embedded_at");
    expect(combinedSql).toContain("memories_embedding_provider_model_idx");
    expect(combinedSql).toContain("create index if not exists memories_embedding_hnsw_idx");
    expect(combinedSql).toContain("using hnsw");
    expect(combinedSql).toContain("create index if not exists memories_embedding_ivfflat_idx");
    expect(combinedSql).toContain("using ivfflat");
    expect(combinedSql).toContain("exception");
    expect(combinedSql).toContain("vector_cosine_ops");
    expect(combinedSql).toContain("memory_vector_index_enabled");
    expect(combinedSql).toContain("memory_vector_index_type");
    expect(combinedSql).toContain("memory_vector_distance");
    expect(migrations.map((migration) => migration.name)).toContain("010_embedding_mrl_512_v1.sql");
    expect(combinedSql).toContain("l2_normalize(subvector(embedding, 1, 512))");
    expect(combinedSql).toContain("alter column embedding type vector(512)");
    expect(combinedSql).toContain("mixed 512 and 1024 dimensional vectors");
    expect(combinedSql).toContain("unsupported qwen production provenance");
    expect(combinedSql).toContain("incompatible qwen production provenance");
    expect(migrations.map((migration) => migration.name)).toContain("011_p8_corrections_v1.sql");
    expect(combinedSql).toContain("create table if not exists p8_corrections");
    expect(combinedSql).toContain("p8_corrections_address_scope_idx");
    expect(combinedSql).toContain("explicit_user_correction");
    expect(combinedSql).toContain("p8_corrections_action_shape");
    expect(combinedSql).toContain("p8_corrections_target_shape");
    expect(combinedSql).toContain("p8_corrections_no_self_lineage");
  });
});

function createBreakfastScenarioExtractor(): MemoryExtractor {
  return {
    async extractCandidates(input: MemoryExtractionInput) {
      return [
        {
          type: "episodic",
          subtype: "event",
          memoryLayer: "recall",
          content: "用户明确要求记住今天早上没吃早饭。",
          importance: 0.4,
          confidence: 0.9,
          tags: ["meal", "event"],
          reason: "explicit remember request",
          explicitRememberRequested: true,
          originRole: "user",
          observedAt: input.timestamp ?? new Date().toISOString()
        },
        {
          type: "episodic",
          subtype: "event",
          memoryLayer: "recall",
          content: "用户今天早上没有吃早饭。",
          importance: 0.4,
          confidence: 0.85,
          tags: ["meal", "event"],
          reason:
            "The assistant recalled a prior statement from the user about skipping breakfast that morning.",
          originRole: "assistant",
          observedAt: input.timestamp ?? new Date().toISOString()
        }
      ];
    }
  };
}

function createNearDuplicateExtractor(): MemoryExtractor {
  return {
    async extractCandidates(input: MemoryExtractionInput) {
      const explicit = detectExplicitRememberRequest(input.userMessage);
      return [
        {
          type: "episodic",
          subtype: "event",
          memoryLayer: "recall",
          content: "用户在 2026-06-22 早上没吃早饭。",
          importance: 0.4,
          confidence: 0.9,
          tags: ["meal", "event"],
          reason: explicit ? "explicit remember request" : "daily event",
          explicitRememberRequested: explicit,
          originRole: "user",
          observedAt: input.timestamp ?? new Date().toISOString()
        },
        {
          type: "episodic",
          subtype: "event",
          memoryLayer: "recall",
          content: "用户于2026年6月22日上午未吃早餐。",
          importance: 0.4,
          confidence: 0.82,
          tags: ["meal", "event"],
          reason: "assistant paraphrase",
          originRole: "assistant",
          observedAt: input.timestamp ?? new Date().toISOString()
        }
      ];
    }
  };
}

function createTestEmbeddingProvider() {
  return {
    name: "mock-test",
    model: "mock-test-model",
    dimensions: 3,
    mock: true,
    async embedText(_text: string): Promise<number[]> {
      return [0.1, 0.2, 0.3];
    }
  };
}

function createFailingEmbeddingProvider() {
  return {
    name: "failing-test",
    model: "failing-test-model",
    dimensions: 3,
    mock: true,
    async embedText(_text: string): Promise<number[]> {
      throw new Error("embedding unavailable");
    }
  };
}

function createWrongDimensionEmbeddingProvider() {
  return {
    name: "wrong-dimension-test",
    model: "wrong-dimension-test-model",
    dimensions: 3,
    mock: false,
    async embedText(_text: string): Promise<number[]> {
      return [0.1, 0.2];
    }
  };
}
