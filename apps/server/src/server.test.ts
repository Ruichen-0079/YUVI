import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIngestionCoordinator, MemoryMaintenanceService } from "@companion/memory";
import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import { createTestSpeechReceiptAdmission } from "./test-support/speech-receipt.js";
import { createTestVisionReceiptAdmission } from "./test-support/vision-receipt.js";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const originalEnv = { ...process.env };
const testTmpDir = tmpdir();
const createdRuntimeEnvDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.exitCode = undefined;
  process.env = { ...originalEnv };
  for (const dir of createdRuntimeEnvDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("server", () => {
  it("handles health, message, and memory endpoints with mock providers", async () => {
    const app = await buildTestServer();

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json().ok).toBe(true);
      expect(health.json().memoryIngestion).toMatchObject({
        status: "running",
        diagnosticsAvailability: "ok",
        diagnosticsErrorCode: null,
        diagnosticsError: null,
        pendingCount: 0,
        processingCount: 0,
        reconcileRequiredCount: 0,
        activeWorkerCount: 0
      });
      expect(health.body).not.toContain("test_deepseek_secret");

      const message = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "hello",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(message.statusCode).toBe(200);
      expect(message.json().type).toBe("agent.reply");
      expect(message.json().reply).toContain("Mock reply");
      expect(message.json().traceId).toBeTypeOf("string");
      expect(message.json().provider).toMatchObject({
        name: "mock",
        capability: "chat",
        mock: true,
        healthStatus: "healthy"
      });
      expect(message.json().provider.latencyMs).toBeTypeOf("number");
      expect(message.json().provider.tokenUsage.totalTokens).toBeTypeOf("number");

      const messageEvents = (await app.inject({ method: "GET", url: "/events/recent?limit=50" }))
        .json()
        .events.filter((event: { traceId?: string }) => event.traceId === message.json().traceId);
      expect(
        messageEvents.filter((event: { type: string }) => event.type === "user.message")
      ).toHaveLength(1);
      expect(
        messageEvents.filter((event: { type: string }) => event.type === "agent.reply")
      ).toHaveLength(1);
      const assistantMessages = messageEvents.filter(
        (event: { type: string }) => event.type === "assistant.message"
      );
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]).toMatchObject({
        payload: {
          sessionId: "test",
          content: message.json().reply
        }
      });
      expect(assistantMessages[0].payload.provider.name).toBe(message.json().provider.name);

      const prompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(prompt.statusCode).toBe(200);
      expect(prompt.json().promptPreview.sections.length).toBeGreaterThan(0);
      expect(prompt.json().traceId).toBe(message.json().traceId);
      expect(prompt.json().retrievedMemoryCount).toBe(0);
      expect(prompt.json().providerName).toBe("mock");
      expect(prompt.json().providerMock).toBe(true);
      expect(prompt.json().memoryExtractorMode).toBe("llm");
      expect(prompt.json().fallbackUsed).toBe(true);
      expect(prompt.json().memoryExtractionCandidateCount).toBeTypeOf("number");
      expect(prompt.json().storedMemoryCount).toBeTypeOf("number");
      expect(prompt.json().rejectedMemoryCount).toBeTypeOf("number");
      expect(prompt.body).not.toContain("test_deepseek_secret");

      const providers = await app.inject({ method: "GET", url: "/providers/status" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.chat).toMatchObject({
        provider: "deepseek",
        capability: "chat",
        configured: false,
        readiness: "not_ready",
        available: false,
        mock: false,
        required: true
      });
      expect(providers.json().providers.reasoning).toMatchObject({
        provider: "deepseek",
        capability: "reasoning",
        configured: false,
        readiness: "not_ready",
        available: false,
        mock: false,
        required: false
      });
      expect(providers.json().routes.chat.at(-1)).toMatchObject({
        provider: "mock",
        readiness: "ready",
        mock: true
      });
      expect(providers.json().providers.embedding).toMatchObject({
        provider: "mock",
        capability: "embedding",
        configured: true,
        available: true,
        mock: true,
        semanticEmbedding: false,
        embeddingNote: expect.stringContaining("do not provide real semantic similarity")
      });
      expect(providers.body).not.toContain("test_deepseek_secret");
      expect(providers.body).not.toContain("Authorization");

      const stt = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        payload: {
          sessionId: "voice",
          mockText: "烦死了，这个报错我看不懂",
          language: "zh",
          speakerId: "speaker-1",
          voiceProfileId: "voice-1",
          subjectUserId: "user-1"
        }
      });
      expect(stt.statusCode).toBe(200);
      expect(stt.json()).toMatchObject({
        text: "烦死了，这个报错我看不懂",
        capability: "stt",
        provider: "mock",
        mock: true,
        speakerId: "speaker-1",
        voiceProfileId: "voice-1"
      });
      expect(stt.json().attemptedProviders.at(-1)).toMatchObject({
        provider: "mock",
        status: "success"
      });
      expect(stt.body).not.toContain("test_deepseek_secret");

      const beforeVoiceMemories = await app.inject({
        method: "GET",
        url: "/memory/recent?limit=20"
      });
      const voiceMessage = await app.inject({
        method: "POST",
        url: "/v1/voice/message",
        payload: {
          sessionId: "voice",
          mockText: "烦死了，这个报错我看不懂",
          language: "zh",
          speakerId: "speaker-1",
          voiceProfileId: "voice-1",
          subjectUserId: "user-1",
          options: {
            readMemory: false,
            writeMemory: false,
            promptPreview: true
          }
        }
      });
      expect(voiceMessage.statusCode).toBe(200);
      expect(voiceMessage.json().transcription).toMatchObject({
        text: "烦死了，这个报错我看不懂",
        finalProvider: "mock"
      });
      expect(voiceMessage.json().reply).toContain("Mock reply");
      expect(voiceMessage.json().promptPreview.currentAffect).toMatchObject({
        affectLabel: expect.stringMatching(/frustrated|confused/)
      });
      expect(voiceMessage.json().chat).toMatchObject({
        capability: "chat",
        mock: true
      });
      const afterVoiceMemories = await app.inject({
        method: "GET",
        url: "/memory/recent?limit=20"
      });
      expect(afterVoiceMemories.json().memories).toHaveLength(
        beforeVoiceMemories.json().memories.length
      );
      expect(voiceMessage.body).not.toContain("test_deepseek_secret");

      const tts = await app.inject({
        method: "POST",
        url: "/v1/tts",
        payload: {
          sessionId: "voice",
          text: "hello"
        }
      });
      expect(tts.statusCode).toBe(200);
      expect(tts.json()).toMatchObject({
        capability: "tts",
        provider: "mock",
        mock: true,
        mimeType: "audio/wav"
      });

      const vision = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: {
          sessionId: "vision",
          imageBase64: "AQID",
          mimeType: "image/png",
          prompt: "Describe"
        }
      });
      expect(vision.statusCode).toBe(200);
      expect(vision.json()).toMatchObject({
        capability: "vision",
        provider: "mock",
        mock: true,
        analysis: "Mock image analysis."
      });

      const verifyStt = await app.inject({
        method: "POST",
        url: "/providers/verify/stt"
      });
      expect(verifyStt.statusCode).toBe(200);
      expect(verifyStt.json()).toMatchObject({
        capability: "stt",
        configOnly: true
      });

      const memory = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Server test memory.",
          source: "test"
        }
      });
      expect(memory.statusCode).toBe(200);
      expect(memory.json()).toMatchObject({
        embedding: null,
        hasEmbedding: true,
        embeddingProvider: "mock",
        embeddingModel: "mock",
        semanticEmbedding: false
      });
      expect(memory.body).not.toContain("[0.");
      const memoryId = memory.json().id as string;

      const memoryDetail = await app.inject({ method: "GET", url: `/memory/${memoryId}` });
      expect(memoryDetail.statusCode).toBe(200);
      expect(memoryDetail.json()).toMatchObject({
        id: memoryId,
        type: "semantic",
        scope: "user",
        memoryLayer: "core",
        status: "active",
        content: "Server test memory.",
        source: "test",
        embedding: null,
        hasEmbedding: true,
        semanticEmbedding: false
      });

      const invalidImportance = await app.inject({
        method: "PATCH",
        url: `/memory/${memoryId}`,
        payload: { importance: 2 }
      });
      expect(invalidImportance.statusCode).toBe(400);

      const unsafeMetadata = await app.inject({
        method: "PATCH",
        url: `/memory/${memoryId}`,
        payload: { metadata: { apiKey: "secret-value" } }
      });
      expect(unsafeMetadata.statusCode).toBe(400);
      expect(unsafeMetadata.body).not.toContain("secret-value");

      const updatedMemory = await app.inject({
        method: "PATCH",
        url: `/memory/${memoryId}`,
        payload: {
          type: "procedural",
          subtype: "workflow",
          scope: "project",
          scopeId: "yuvi-runtime",
          memoryLayer: "recall",
          status: "active",
          content: "Server test memory updated.",
          summary: "Server test memory updated.",
          importance: 0.8,
          tags: ["updated", "server"],
          validUntil: new Date(Date.now() + 60_000).toISOString()
        }
      });
      expect(updatedMemory.statusCode).toBe(200);
      expect(updatedMemory.json()).toMatchObject({
        id: memoryId,
        type: "procedural",
        subtype: "workflow",
        scope: "project",
        scopeId: "yuvi-runtime",
        memoryLayer: "recall",
        status: "active",
        content: "Server test memory updated.",
        summary: "Server test memory updated.",
        importance: 0.8,
        tags: ["updated", "server"]
      });

      const archiveMemory = await app.inject({
        method: "POST",
        url: `/memory/${memoryId}/archive`
      });
      expect(archiveMemory.statusCode).toBe(200);
      expect(archiveMemory.json().memory.status).toBe("archived");
      const archivedPromptSearch = await app.inject({
        method: "GET",
        url: "/memory/search?q=Server%20test%20memory%20updated&limit=5"
      });
      expect(
        archivedPromptSearch
          .json()
          .memories.some((memory: { id: string }) => memory.id === memoryId)
      ).toBe(false);
      const restoreMemory = await app.inject({
        method: "POST",
        url: `/memory/${memoryId}/restore`
      });
      expect(restoreMemory.statusCode).toBe(200);
      expect(restoreMemory.json().memory.status).toBe("active");
      const forgetMemory = await app.inject({
        method: "POST",
        url: `/memory/${memoryId}/forget`
      });
      expect(forgetMemory.statusCode).toBe(200);
      expect(forgetMemory.json().memory.status).toBe("forgotten");
      const restoreForgottenMemory = await app.inject({
        method: "POST",
        url: `/memory/${memoryId}/restore`
      });
      expect(restoreForgottenMemory.statusCode).toBe(200);
      expect(restoreForgottenMemory.json().memory.status).toBe("active");

      const missingUpdate = await app.inject({
        method: "PATCH",
        url: "/memory/missing",
        payload: { content: "nope" }
      });
      expect(missingUpdate.statusCode).toBe(404);

      const deleteCandidate = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Delete me from memory.",
          source: "test"
        }
      });
      expect(deleteCandidate.statusCode).toBe(200);
      const deleteId = deleteCandidate.json().id as string;
      const deleteMemory = await app.inject({ method: "DELETE", url: `/memory/${deleteId}` });
      expect(deleteMemory.statusCode).toBe(200);
      expect(deleteMemory.json()).toMatchObject({ ok: true, id: deleteId });

      const noBodyDeleteCandidate = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Delete me with no JSON content type.",
          source: "test"
        }
      });
      expect(noBodyDeleteCandidate.statusCode).toBe(200);
      const noBodyDeleteId = noBodyDeleteCandidate.json().id as string;
      const noBodyDelete = await app.inject({
        method: "DELETE",
        url: `/memory/${noBodyDeleteId}`,
        headers: {}
      });
      expect(noBodyDelete.statusCode).toBe(200);
      expect(noBodyDelete.json()).toMatchObject({ ok: true, id: noBodyDeleteId });

      const deletedDetail = await app.inject({ method: "GET", url: `/memory/${deleteId}` });
      expect(deletedDetail.statusCode).toBe(404);
      const deletedSearch = await app.inject({
        method: "GET",
        url: "/memory/search?q=Delete%20me&limit=5"
      });
      expect(deletedSearch.statusCode).toBe(200);
      expect(
        deletedSearch.json().memories.some((candidate: { id: string }) => candidate.id === deleteId)
      ).toBe(false);

      const missingDelete = await app.inject({ method: "DELETE", url: "/memory/missing" });
      expect(missingDelete.statusCode).toBe(404);

      const yuviMemory = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "“  用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。  ”",
          source: "test",
          tags: ["yuvi", "runtime"]
        }
      });
      expect(yuviMemory.statusCode).toBe(200);

      const duplicateWorkingMemory = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "working",
          content: "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。",
          importance: 1,
          source: "test"
        }
      });
      expect(duplicateWorkingMemory.statusCode).toBe(200);

      const smokeMemory = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          subtype: "test",
          memoryLayer: "recall",
          content: "Smoke test memory.",
          source: "smoke",
          importance: 0.2,
          metadata: { testMemory: true },
          tags: ["smoke", "test"]
        }
      });
      expect(smokeMemory.statusCode).toBe(200);

      const messageWithMemory = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "What do you know about Server test details?",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(messageWithMemory.statusCode).toBe(200);

      const promptWithMemory = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      const relevantMemory = findPromptSection(promptWithMemory.json().sections, "RelevantMemory");
      expect(promptWithMemory.json().useMemory).toBe(true);
      expect(promptWithMemory.json().retrievedMemoryCount).toBeGreaterThan(0);
      expect(findPromptSection(promptWithMemory.json().sections, "CurrentTime")?.content).toContain(
        "ISO timestamp:"
      );
      expect(relevantMemory?.content).toContain("Server test memory");
      expect(relevantMemory?.content).not.toContain("Smoke test memory.");

      const yuviMessageWithMemory = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "YUVI Runtime 是什么项目？",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(yuviMessageWithMemory.statusCode).toBe(200);

      const yuviPromptWithMemory = await app.inject({
        method: "GET",
        url: "/debug/prompt/latest"
      });
      const yuviRelevantMemory = findPromptSection(
        yuviPromptWithMemory.json().sections,
        "RelevantMemory"
      );
      const yuviDirectContext = findPromptSection(
        yuviPromptWithMemory.json().sections,
        "DirectContext"
      );
      expect(yuviPromptWithMemory.json().useMemory).toBe(true);
      expect(yuviPromptWithMemory.json().userMessage).toBe("YUVI Runtime 是什么项目？");
      expect(yuviPromptWithMemory.json().directContextEnabled).toBe(true);
      expect(yuviPromptWithMemory.json().directContextTurnCount).toBeGreaterThan(0);
      expect(yuviPromptWithMemory.json().directContextCharCount).toBeGreaterThan(0);
      expect(yuviDirectContext?.content).toContain("Server test details");
      expect(yuviDirectContext?.content).not.toContain("test_deepseek_secret");
      expect(yuviPromptWithMemory.json().retrievedMemoryCountRaw).toBeGreaterThan(
        yuviPromptWithMemory.json().retrievedMemoryCount
      );
      expect(yuviPromptWithMemory.json().retrievedMemoryCount).toBeGreaterThan(0);
      expect(yuviPromptWithMemory.json().retrievalScope).toContain("project:yuvi-runtime");
      expect(yuviPromptWithMemory.json().includedScopes).toContainEqual({
        scope: "session",
        scopeId: "test"
      });
      expect(yuviPromptWithMemory.json().excludedByStatus).toBeGreaterThanOrEqual(0);
      expect(yuviPromptWithMemory.json().excludedByTime).toBeGreaterThanOrEqual(0);
      expect(yuviPromptWithMemory.json().excludedByScope).toBeGreaterThanOrEqual(0);
      expect(yuviPromptWithMemory.json().currentTime).toMatch(/T/);
      expect(yuviRelevantMemory?.content).toMatch(/YUVI Runtime|AI Companion Runtime/);
      expect(yuviRelevantMemory?.content).toContain("[project:yuvi-runtime][core][active]");
      expect(countOccurrences(yuviRelevantMemory?.content ?? "", "YUVI Runtime")).toBe(1);
      expect(yuviRelevantMemory?.content).not.toContain("“");
      expect(yuviPromptWithMemory.json().retrievedMemories[0]).toMatchObject({
        type: "semantic",
        scope: "project",
        scopeId: "yuvi-runtime",
        memoryLayer: "core",
        status: "active",
        source: "test",
        displayText: "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。"
      });
      expect(
        yuviPromptWithMemory
          .json()
          .promptPreview.retrievedMemories.some((memory: { excludedReason?: string }) =>
            memory.excludedReason?.startsWith("deduped")
          )
      ).toBe(true);
      expect(yuviPromptWithMemory.body).not.toContain("test_deepseek_secret");

      const messageWithoutMemory = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "YUVI Runtime 是什么项目？",
          options: {
            useMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(messageWithoutMemory.statusCode).toBe(200);

      const promptWithoutMemory = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      const emptyRelevantMemory = findPromptSection(
        promptWithoutMemory.json().sections,
        "RelevantMemory"
      );
      expect(promptWithoutMemory.json().useMemory).toBe(false);
      expect(promptWithoutMemory.json().retrievedMemoryCountRaw).toBe(0);
      expect(promptWithoutMemory.json().retrievedMemoryCount).toBe(0);
      expect(emptyRelevantMemory?.content).toBe("Memory was disabled for this turn.");
      expect(promptWithoutMemory.body).not.toContain("Server test memory");
      expect(promptWithoutMemory.body).not.toContain("用户正在开发 YUVI Runtime");

      const recent = await app.inject({ method: "GET", url: "/memory/recent?limit=5" });
      expect(recent.statusCode).toBe(200);
      expect(recent.json().memories.length).toBeGreaterThan(0);

      const search = await app.inject({ method: "GET", url: "/memory/search?q=Server&limit=5" });
      expect(search.statusCode).toBe(200);
      expect(search.json().query).toBe("Server");
      expect(search.json().repository).toBe("in-memory");
      expect(search.json().retrievalMode).toMatch(/^in-memory-|fallback-recent$/);
      expect(search.json().semanticEmbedding).toBe(false);
      expect(search.json().embeddingNote).toContain("Mock embeddings");
      expect(search.json().rawCount).toBeGreaterThanOrEqual(search.json().count);
      expect(search.json().memories.length).toBeGreaterThan(0);
      expect(search.json().retrievalScope).toBeTruthy();
      expect(search.json().excludedByStatus).toBeGreaterThanOrEqual(0);

      const filteredSearch = await app.inject({
        method: "GET",
        url: `/memory/search?${new URLSearchParams({
          q: "Server test memory updated",
          type: "procedural",
          subtype: "workflow",
          source: "test",
          scope: "project",
          scopeId: "yuvi-runtime",
          memoryLayer: "recall",
          status: "active",
          tags: "updated,server",
          minImportance: "0.7",
          limit: "5"
        }).toString()}`
      });
      expect(filteredSearch.statusCode).toBe(200);
      expect(filteredSearch.json().memories[0]).toMatchObject({
        id: memoryId,
        type: "procedural",
        subtype: "workflow",
        source: "test",
        scope: "project",
        scopeId: "yuvi-runtime",
        memoryLayer: "recall",
        status: "active"
      });
      expect(filteredSearch.json().debugMemories[0]).toMatchObject({
        matchedBy: expect.any(String),
        score: expect.any(Number)
      });

      const postChineseSearch = await app.inject({
        method: "POST",
        url: "/memory/search",
        payload: {
          q: "模型供应商偏好",
          limit: 10,
          scope: "project",
          scopeId: "yuvi-runtime"
        }
      });
      expect(postChineseSearch.statusCode).toBe(200);
      expect(postChineseSearch.json().query).toBe("模型供应商偏好");
      expect(postChineseSearch.json().repository).toBe("in-memory");
      expect(postChineseSearch.json().retrievalMode).not.toMatch(/^postgres-/);

      const invalidSearch = await app.inject({
        method: "GET",
        url: "/memory/search?limit=999"
      });
      expect(invalidSearch.statusCode).toBe(400);
      expect(invalidSearch.json().message).toContain("POST /memory/search");

      const encodedChineseSearch = await app.inject({
        method: "GET",
        url: `/memory/search?${new URLSearchParams({ q: "项目", limit: "5" }).toString()}`
      });
      expect(encodedChineseSearch.statusCode).toBe(200);
      expect(encodedChineseSearch.json().memories.length).toBeGreaterThan(0);
      expect(encodedChineseSearch.json().memories[0].content).toContain("YUVI Runtime");

      const archived = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Archived manual search memory for YUVI Runtime.",
          status: "archived",
          source: "test",
          tags: ["yuvi"]
        }
      });
      expect(archived.statusCode).toBe(200);
      const archivedDefaultSearch = await app.inject({
        method: "GET",
        url: "/memory/search?q=Archived%20manual%20search&limit=5"
      });
      expect(archivedDefaultSearch.json().memories).toHaveLength(0);
      const archivedIncludedSearch = await app.inject({
        method: "GET",
        url: "/memory/search?q=Archived%20manual%20search&includeArchived=true&limit=5"
      });
      expect(archivedIncludedSearch.json().memories[0].status).toBe("archived");

      const events = await app.inject({ method: "GET", url: "/events/recent?limit=20" });
      expect(events.statusCode).toBe(200);
      expect(events.json().events.some((event: { traceId?: string }) => event.traceId)).toBe(true);
      expect(events.body).not.toContain("test_deepseek_secret");

      await app.listen({ host: "127.0.0.1", port: 0 });
      const dashboardMessage = await readFirstWebSocketMessage(
        `${getServerOrigin(app.server.address())}/ws?dashboard=true`
      );
      expect(dashboardMessage.kind).toBe("dashboard.connected");
      expect(dashboardMessage.traceId).toBeTypeOf("string");
    } finally {
      await app.close();
    }
  });

  it("keeps /health available when memory-ingestion diagnostics throw", async () => {
    const app = await buildTestServer();
    try {
      vi.spyOn(MemoryIngestionCoordinator.prototype, "getDiagnostics").mockRejectedValue(
        new Error("DATABASE_URL=postgres://secret stats query failed")
      );
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      const body = health.json();
      expect(body.ok).toBe(true);
      expect(body.database.status).toBe("healthy");
      expect(body.providers.chat.available).toBe(false);
      expect(body.providers.chatCapability).toMatchObject({
        readiness: "ready",
        observed: "unknown",
        operational: true,
        readyRouteCount: 1,
        readyProviders: [expect.objectContaining({ provider: "mock" })]
      });
      expect(body.memoryIngestion).toMatchObject({
        diagnosticsAvailability: "error",
        diagnosticsErrorCode: "MEMORY_INGESTION_DIAGNOSTICS_UNAVAILABLE",
        pendingCount: null,
        processingCount: null,
        retryableFailedCount: null,
        dueRetryCount: null,
        reconcileRequiredCount: null,
        terminalFailedCount: null,
        staleLeaseCount: null,
        historicalUnknownCount: null,
        activeWorkerCount: null
      });
      expect(body.memoryIngestion.diagnosticsError).toContain("stats query failed");
      expect(health.body).not.toContain("postgres://secret");
      expect(body.memoryIngestion.pendingCount).not.toBe(0);
      expect(body.memoryIngestion.processingCount).not.toBe(0);
      expect(body.memoryIngestion.reconcileRequiredCount).not.toBe(0);
    } finally {
      await app.close();
    }
  });

  it("does not mark the server unavailable merely because an ingestion backlog exists", async () => {
    const app = await buildTestServer();
    try {
      vi.spyOn(MemoryIngestionCoordinator.prototype, "getDiagnostics").mockResolvedValue({
        pendingCount: 4,
        processingCount: 1,
        retryableFailedCount: 0,
        dueRetryCount: 0,
        reconcileRequiredCount: 2,
        completeCount: 0,
        unchangedCount: 0,
        skippedCount: 0,
        terminalFailedCount: 0,
        partialParentCount: 1,
        staleLeaseCount: 0,
        historicalUnknownCount: 0,
        diagnosticsAvailability: "ok",
        diagnosticsErrorCode: null,
        diagnosticsError: null,
        activeWorkerCount: 1,
        configuredConcurrency: 4,
        lastScanAt: "2026-08-15T00:00:00.000Z",
        lastSuccessfulExecutionAt: null,
        lastError: null,
        status: "running",
        ownerId: "test-coordinator"
      });
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json().ok).toBe(true);
      expect(health.json().memoryIngestion).toMatchObject({
        diagnosticsAvailability: "ok",
        pendingCount: 4,
        reconcileRequiredCount: 2,
        partialCount: 1,
        status: "running"
      });
    } finally {
      await app.close();
    }
  });

  it("reports a stopped coordinator without failing /health", async () => {
    const app = await buildTestServer({ MEMORY_INGESTION_COORDINATOR_ENABLED: "false" });
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json().ok).toBe(true);
      expect(health.json().memoryIngestion).toMatchObject({
        status: "idle",
        diagnosticsAvailability: "ok",
        pendingCount: 0,
        activeWorkerCount: 0
      });
    } finally {
      await app.close();
    }
  });

  it("keeps unrelated runtime settings when ingestion diagnostics throw", async () => {
    const app = await buildTestServer();
    try {
      vi.spyOn(MemoryIngestionCoordinator.prototype, "getDiagnostics").mockRejectedValue(
        new Error("work stats unavailable")
      );
      const settings = await app.inject({ method: "GET", url: "/settings/runtime" });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().memory).toMatchObject({
        memoryExtractor: "llm",
        memoryExtractorDefault: "rule-based",
        ingestionCoordinator: {
          diagnosticsAvailability: "error",
          diagnosticsErrorCode: "MEMORY_INGESTION_DIAGNOSTICS_UNAVAILABLE",
          pendingCount: null,
          processingCount: null,
          reconcileRequiredCount: null
        }
      });
      expect(settings.json().memory.ingestionCoordinator.diagnosticsError).toContain(
        "work stats unavailable"
      );
      expect(settings.json().providers.deepseek).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("rejects ordinary relative-time daily events from runtime long-term memory", async () => {
    const app = await buildTestServer({ MEMORY_EXTRACTOR: "rule-based" });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "temporal",
          text: "我今早吃了芒果蛋糕",
          options: {
            readMemory: false,
            writeMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(response.statusCode).toBe(200);

      const memories = await app.inject({ method: "GET", url: "/memory/recent?limit=10" });
      expect(memories.statusCode).toBe(200);
      expect(
        memories
          .json()
          .memories.some((memory: { content: string }) => memory.content.includes("芒果蛋糕"))
      ).toBe(false);

      const candidates = await app.inject({
        method: "GET",
        url: "/memory/candidates/recent?limit=5"
      });
      expect(candidates.statusCode).toBe(200);
      expect(candidates.json().candidates[0]).toMatchObject({
        type: "episodic",
        subtype: "event",
        memoryLayer: "recall",
        decision: "rejected",
        rejectedReason: "ordinary-one-off-daily-event"
      });
      expect(candidates.json().candidates[0].content).not.toContain("今早");
      expect(candidates.body).not.toContain("test_deepseek_secret");
    } finally {
      await app.close();
    }
  });

  it("adds CurrentAffect to prompt preview for obvious immediate emotion without storing mood", async () => {
    const app = await buildTestServer({ MEMORY_EXTRACTOR: "rule-based" });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "affect",
          text: "烦死了，这个报错我完全看不懂",
          options: {
            readMemory: false,
            writeMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(response.statusCode).toBe(200);

      const prompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(prompt.statusCode).toBe(200);
      expect(prompt.json().currentAffect).toMatchObject({
        affectLabel: expect.stringMatching(/frustrated|confused/),
        confidence: expect.any(Number)
      });
      expect(findPromptSection(prompt.json().sections, "CurrentAffect")?.content).toContain(
        "current turn"
      );
      expect(prompt.body).not.toContain("test_deepseek_secret");

      const memories = await app.inject({ method: "GET", url: "/memory/recent?limit=10" });
      expect(memories.statusCode).toBe(200);
      expect(
        memories
          .json()
          .memories.some((memory: { subtype?: string }) => memory.subtype === "emotional-state")
      ).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("includes safe real-provider metadata when DeepSeek chat is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "deepseek-chat",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "Real provider test reply."
              }
            }
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 4,
            total_tokens: 15
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    try {
      const app = await buildTestServer({
        PROVIDER_ALLOW_MOCKS: "false",
        DEEPSEEK_API_KEY: "configured_deepseek_secret",
        DEEPSEEK_CHAT_MODEL: "deepseek-chat",
        DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
      });
      const message = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "hello real DeepSeek",
          options: {
            useMemory: false,
            voiceOutput: false
          }
        }
      });

      expect(message.statusCode).toBe(200);
      expect(message.json().reply).toBe("Real provider test reply.");
      expect(message.json().provider).toMatchObject({
        name: "deepseek",
        capability: "chat",
        model: "deepseek-chat",
        mock: false,
        healthStatus: "degraded",
        tokenUsage: {
          inputTokens: 11,
          outputTokens: 4,
          totalTokens: 15
        }
      });
      expect(message.json().provider.latencyMs).toBeTypeOf("number");
      expect(message.body).not.toContain("configured_deepseek_secret");
      expect(message.body).not.toContain("Authorization");

      const prompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(prompt.statusCode).toBe(200);
      expect(prompt.json().providerName).toBe("deepseek");
      expect(prompt.json().providerModel).toBe("deepseek-chat");
      expect(prompt.json().providerMock).toBe(false);
      expect(prompt.body).not.toContain("configured_deepseek_secret");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await app.close();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not silently mock required chat provider in real-first mode", async () => {
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      EMBEDDING_PROVIDER: "openai-compatible",
      DEFAULT_EMBEDDING_PROVIDER: "openai-compatible"
    });

    try {
      const providers = await app.inject({ method: "GET", url: "/providers/status" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.chat).toMatchObject({
        configured: false,
        available: false,
        mock: false,
        status: "unavailable"
      });

      const message = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "real-first",
          text: "hello",
          options: {
            readMemory: false,
            writeMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(message.statusCode).toBe(503);
      expect(message.json()).toMatchObject({
        error: "provider_unavailable",
        provider: "local",
        capability: "chat"
      });
      expect(message.json()).not.toHaveProperty("fallbackEligible");
      expect(message.json()).not.toHaveProperty("effectState");
      expect(message.json().setup).toContain("PROVIDER_ALLOW_MOCKS=true");
      expect(message.body).not.toContain("API_KEY");
    } finally {
      await app.close();
    }
  });

  it("returns clear STT setup errors when media mocks are disabled", async () => {
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      EMBEDDING_PROVIDER: "openai-compatible",
      DEFAULT_EMBEDDING_PROVIDER: "openai-compatible"
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        payload: {
          sessionId: "voice",
          mockText: "this should not be used"
        }
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: "provider_unavailable",
        capability: "stt"
      });
      expect(response.json().fallbackUsed).toBe(false);
      expect(response.json().attemptedProviders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "dashscope",
            status: "unavailable"
          })
        ])
      );
      expect(response.body).not.toContain("API_KEY");
      expect(response.body).not.toContain("Authorization");
    } finally {
      await app.close();
    }
  });

  it("separates memory read and write behavior", async () => {
    const app = await buildTestServer();

    try {
      const seeded = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "用户偏好 Chat 使用 DeepSeek。",
          source: "dashboard"
        }
      });
      expect(seeded.statusCode).toBe(200);

      const disabled = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "用户偏好什么 Chat provider？",
          options: {
            useMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(disabled.statusCode).toBe(200);
      const disabledPrompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(disabledPrompt.json()).toMatchObject({
        readMemory: false,
        writeMemory: false,
        retrievedMemoryCount: 0
      });
      expect(disabledPrompt.json().memoryCandidates).toEqual([]);
      expect(disabledPrompt.body).not.toContain("用户偏好 Chat 使用 DeepSeek");
      expect(
        (await app.inject({ method: "GET", url: "/memory/recent?limit=10" })).json().memories
      ).toHaveLength(1);

      const writeOnly = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "记住：用户偏好 Reasoning 使用 DeepSeek。",
          options: {
            useMemory: false,
            readMemory: false,
            writeMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(writeOnly.statusCode).toBe(200);
      const writeOnlyPrompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(writeOnlyPrompt.json()).toMatchObject({
        readMemory: false,
        writeMemory: true,
        retrievedMemoryCount: 0
      });
      const afterWriteOnly = await app.inject({ method: "GET", url: "/memory/recent?limit=10" });
      expect(afterWriteOnly.json().memories).toHaveLength(2);
      expect(afterWriteOnly.json().memories[0]).toMatchObject({
        type: "semantic",
        subtype: "provider-choice",
        source: "runtime",
        sourceTraceId: writeOnly.json().traceId
      });
      expect(writeOnlyPrompt.json().memoryCandidates[0]).toMatchObject({
        type: "semantic",
        subtype: "provider-choice",
        decision: "stored",
        sourceTraceId: writeOnly.json().traceId
      });

      const recentCandidates = await app.inject({
        method: "GET",
        url: "/memory/candidates/recent?limit=5"
      });
      expect(recentCandidates.statusCode).toBe(200);
      expect(recentCandidates.json()).toMatchObject({
        volatile: true,
        count: expect.any(Number),
        storedCount: expect.any(Number),
        rejectedCount: expect.any(Number),
        fallbackUsed: expect.any(Boolean)
      });
      const candidateId = recentCandidates.json().candidates[0].id as string;
      expect(recentCandidates.json().candidates[0]).toMatchObject({
        source: "runtime",
        extractorMode: "llm",
        fallbackUsed: true,
        createdAt: expect.any(String)
      });
      expect(recentCandidates.body).not.toContain("test_deepseek_secret");

      const acceptedCandidate = await app.inject({
        method: "POST",
        url: `/memory/candidates/${candidateId}/accept`,
        payload: {
          content: "用户偏好 Reasoning 使用 DeepSeek。",
          summary: "用户偏好 Reasoning 使用 DeepSeek。",
          importance: 0.9,
          tags: ["accepted"]
        }
      });
      expect(acceptedCandidate.statusCode).toBe(200);
      expect(acceptedCandidate.json()).toMatchObject({
        ok: true,
        alreadyStored: true,
        message: expect.stringContaining("already stored")
      });
      const afterAlreadyStoredAccept = await app.inject({
        method: "GET",
        url: "/memory/recent?limit=10"
      });
      expect(
        afterAlreadyStoredAccept
          .json()
          .memories.filter(
            (memory: { content: string }) => memory.content === "用户偏好 Reasoning 使用 DeepSeek。"
          )
      ).toHaveLength(1);

      const rejectedCandidate = await app.inject({
        method: "POST",
        url: `/memory/candidates/${candidateId}/reject`,
        payload: { reason: "Not useful now." }
      });
      expect(rejectedCandidate.statusCode).toBe(200);
      expect(rejectedCandidate.json().candidate).toMatchObject({
        id: candidateId,
        decision: "stored",
        rejectedReason: "Candidate is already stored and was not rejected."
      });

      const readOnly = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "Chat provider 偏好是什么？",
          options: {
            readMemory: true,
            writeMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(readOnly.statusCode).toBe(200);
      const readOnlyPrompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(readOnlyPrompt.json().readMemory).toBe(true);
      expect(readOnlyPrompt.json().writeMemory).toBe(false);
      expect(readOnlyPrompt.json().retrievedMemoryCount).toBeGreaterThan(0);
      expect(readOnlyPrompt.body).toContain("用户偏好 Chat 使用 DeepSeek");
      const afterReadOnly = await app.inject({ method: "GET", url: "/memory/recent?limit=10" });
      expect(afterReadOnly.json().memories).toHaveLength(2);

      const enabled = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "记住：项目里程碑是 provider observability 已完成。",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(enabled.statusCode).toBe(200);
      const enabledPrompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(enabledPrompt.json().readMemory).toBe(true);
      expect(enabledPrompt.json().writeMemory).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("avoids writing low-value runtime memories", async () => {
    const app = await buildTestServer();

    try {
      const greeting = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "hi",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(greeting.statusCode).toBe(200);

      const ordinaryQuestion = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "What is the weather?",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(ordinaryQuestion.statusCode).toBe(200);

      const recent = await app.inject({ method: "GET", url: "/memory/recent?limit=10" });
      expect(recent.json().memories).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("reports the selected OpenAI-compatible Chat and Cognition health metadata", async () => {
    const app = await buildTestServer({
      DEFAULT_CHAT_PROVIDER: "openai-compatible",
      CHAT_PROVIDER_CHAIN: "openai-compatible",
      DEFAULT_REASONING_PROVIDER: "openai-compatible",
      REASONING_PROVIDER_CHAIN: "openai-compatible",
      OPENAI_COMPATIBLE_API_BASEURL: "https://gateway.example/v1",
      OPENAI_COMPATIBLE_API_KEY: "shared-secret",
      OPENAI_COMPATIBLE_CHAT_MODEL: "deepseek-flash",
      OPENAI_COMPATIBLE_REASONING_MODEL: "zai-org/GLM-5.3-Flash"
    });

    try {
      const response = await app.inject({ method: "GET", url: "/providers/status" });
      expect(response.statusCode).toBe(200);
      expect(response.json().providers.chat).toMatchObject({
        provider: "openai-compatible",
        model: "deepseek-flash",
        baseUrl: "https://gateway.example/v1",
        configured: true,
        available: true
      });
      expect(response.json().providers.reasoning).toMatchObject({
        provider: "openai-compatible",
        model: "zai-org/GLM-5.3-Flash",
        baseUrl: "https://gateway.example/v1",
        configured: true,
        available: true
      });
      expect(response.body).not.toContain("shared-secret");
    } finally {
      await app.close();
    }
  });

  it("verifies providers only when explicit endpoints are called", async () => {
    const app = await buildTestServer();

    try {
      const chat = await app.inject({ method: "POST", url: "/providers/verify/chat" });
      expect(chat.statusCode).toBe(200);
      expect(chat.json()).toMatchObject({
        ok: true,
        provider: "mock",
        capability: "chat",
        mock: true
      });
      expect(chat.body).not.toContain("test_deepseek_secret");

      const reasoning = await app.inject({
        method: "POST",
        url: "/providers/verify/reasoning"
      });
      expect(reasoning.statusCode).toBe(200);
      expect(reasoning.json()).toMatchObject({
        ok: true,
        provider: "mock",
        capability: "reasoning",
        mock: true
      });
      expect(reasoning.body).not.toContain("test_deepseek_secret");

      const embedding = await app.inject({
        method: "POST",
        url: "/providers/verify/embedding"
      });
      expect(embedding.statusCode).toBe(200);
      expect(embedding.json()).toMatchObject({
        ok: true,
        provider: "mock",
        capability: "embedding",
        mock: true,
        semanticEmbedding: false
      });
      expect(embedding.json().dimensions).toBeTypeOf("number");
      expect(embedding.json().expectedDimensions).toBe(embedding.json().dimensions);
      expect(embedding.json().actualDimensions).toBe(embedding.json().dimensions);
      expect(embedding.body).not.toContain("test_deepseek_secret");
    } finally {
      await app.close();
    }
  });

  it("keeps config-only media verification from fabricating remote availability", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_TTS_PROVIDER: "xai",
      TTS_PROVIDER_CHAIN: "xai",
      XAI_API_KEY: "xai-secret",
      XAI_TTS_MODEL: "xai-tts"
    });

    try {
      const verify = await app.inject({ method: "POST", url: "/providers/verify/tts" });
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toMatchObject({
        ok: true,
        capability: "tts",
        provider: "xai",
        verificationMode: "config_only",
        readiness: "ready",
        observed: "unknown",
        configOnly: true
      });
      expect(verify.json().lastVerifiedAt).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();

      const status = await app.inject({ method: "GET", url: "/providers/status" });
      expect(status.json().providers.tts).toMatchObject({
        readiness: "ready",
        observed: "unknown"
      });
    } finally {
      await app.close();
    }
  });

  it("keeps config-only TTS, STT, and Vision verification zero-I/O and non-live", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_TTS_PROVIDER: "xai",
      TTS_PROVIDER_CHAIN: "xai",
      XAI_API_KEY: "xai-secret",
      XAI_TTS_MODEL: "xai-tts",
      DEFAULT_STT_PROVIDER: "dashscope",
      STT_PROVIDER_CHAIN: "dashscope",
      DASHSCOPE_API_KEY: "dashscope-secret",
      DASHSCOPE_STT_MODEL: "dashscope-stt",
      DEFAULT_VISION_PROVIDER: "xai",
      VISION_PROVIDER_CHAIN: "xai",
      XAI_VISION_MODEL: "xai-vision"
    });

    try {
      for (const capability of ["tts", "stt", "vision"] as const) {
        const verify = await app.inject({
          method: "POST",
          url: `/providers/verify/${capability}`
        });
        expect(verify.statusCode).toBe(200);
        expect(verify.json()).toMatchObject({
          ok: true,
          capability,
          configOnly: true,
          verificationMode: "config_only",
          readiness: "ready",
          observed: "unknown"
        });
        expect(verify.json().lastVerifiedAt).toBeUndefined();
        expect(verify.json().message).toContain("no provider call was made");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("keeps chain verification config-only and zero-cost", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek",
      DEEPSEEK_API_KEY: "deepseek-secret",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat"
    });

    try {
      const verify = await app.inject({
        method: "POST",
        url: "/providers/verify-chain/chat"
      });
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toMatchObject({
        ok: true,
        capability: "chat",
        configOnly: true,
        verificationMode: "config_only",
        readyRouteCount: 1,
        routes: [
          expect.objectContaining({
            provider: "deepseek",
            readiness: "ready",
            observed: "unknown"
          })
        ],
        attemptedProviders: [
          expect.objectContaining({
            provider: "deepseek",
            status: "skipped"
          })
        ]
      });
      expect(verify.json().attemptedProviders).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ status: "success" })])
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("records successful live chat verification and exposes the cached observation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "deepseek-chat",
          choices: [{ finish_reason: "stop", message: { content: "OK" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek",
      DEEPSEEK_API_KEY: "deepseek-secret",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat"
    });

    try {
      const verify = await app.inject({ method: "POST", url: "/providers/verify/chat" });
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toMatchObject({
        ok: true,
        provider: "deepseek",
        capability: "chat",
        verificationMode: "live",
        readiness: "ready",
        observed: "available",
        lastVerifiedAt: expect.any(String)
      });
      expect(verify.json().latencyMs).toBeTypeOf("number");
      expect(verify.body).not.toContain("deepseek-secret");

      const status = await app.inject({ method: "GET", url: "/providers/status" });
      expect(status.json().providers.chat).toMatchObject({
        readiness: "ready",
        observed: "available",
        status: "healthy",
        lastVerifiedAt: expect.any(String)
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("keeps chat health operational when live verification succeeds through a fallback", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.deepseek.com")) {
        return new Response(JSON.stringify({ error: "primary unavailable" }), { status: 503 });
      }

      return new Response(
        JSON.stringify({
          model: "local-chat",
          choices: [{ finish_reason: "stop", message: { content: "local verification" } }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek,local",
      DEEPSEEK_API_KEY: "deepseek-secret",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      LOCAL_MODEL_BASEURL: "https://local.example/v1",
      LOCAL_CHAT_MODEL: "local-chat"
    });

    try {
      const verify = await app.inject({ method: "POST", url: "/providers/verify/chat" });
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toMatchObject({
        ok: true,
        provider: "local",
        capability: "chat",
        verificationMode: "live",
        readiness: "ready",
        observed: "available"
      });

      const status = await app.inject({ method: "GET", url: "/providers/status" });
      expect(status.json().routes.chat).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "deepseek",
            readiness: "ready",
            observed: "unavailable"
          }),
          expect.objectContaining({
            provider: "local",
            readiness: "ready",
            observed: "available"
          })
        ])
      );

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json()).toMatchObject({
        ok: true,
        providers: {
          chat: {
            provider: "deepseek",
            observed: "unavailable"
          },
          chatCapability: {
            readiness: "ready",
            observed: "available",
            operational: true,
            routeCount: 2,
            readyRouteCount: 2,
            readyProviders: expect.arrayContaining([
              expect.objectContaining({ provider: "deepseek", observed: "unavailable" }),
              expect.objectContaining({ provider: "local", observed: "available" })
            ])
          }
        }
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("records failed live verification and makes cached chat unavailability visible to health", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "upstream secret should not escape" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      })
    );
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek",
      DEEPSEEK_API_KEY: "deepseek-secret",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat"
    });

    try {
      const verify = await app.inject({ method: "POST", url: "/providers/verify/chat" });
      expect(verify.statusCode).toBe(502);
      expect(verify.json()).toMatchObject({
        ok: false,
        capability: "chat",
        verificationMode: "live",
        readiness: "ready",
        observed: "unavailable",
        lastVerifiedAt: expect.any(String),
        lastErrorCode: "PROVIDER_UNAVAILABLE"
      });
      expect(verify.body).not.toContain("deepseek-secret");
      expect(verify.body).not.toContain("upstream secret");

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        ok: false,
        providers: {
          chat: {
            readiness: "ready",
            observed: "unavailable",
            status: "unavailable"
          },
          chatCapability: {
            readiness: "ready",
            observed: "unavailable",
            operational: false
          }
        }
      });
    } finally {
      await app.close();
    }
  });

  it("fails chat health when every locally ready route is known unavailable", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "all routes unavailable" }), { status: 503 })
      );
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek,local",
      DEEPSEEK_API_KEY: "deepseek-secret",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      LOCAL_MODEL_BASEURL: "https://local.example/v1",
      LOCAL_CHAT_MODEL: "local-chat"
    });

    try {
      const verify = await app.inject({ method: "POST", url: "/providers/verify/chat" });
      expect(verify.statusCode).toBe(502);

      const beforeHealth = fetchSpy.mock.calls.length;
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json()).toMatchObject({
        ok: false,
        providers: {
          chatCapability: {
            readiness: "ready",
            observed: "unavailable",
            operational: false,
            routeCount: 2,
            readyRouteCount: 2
          }
        }
      });
      expect(fetchSpy).toHaveBeenCalledTimes(beforeHealth);
    } finally {
      await app.close();
    }
  });

  it("keeps ready but unverified chat health honest without remote calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek",
      DEEPSEEK_API_KEY: "deepseek-secret",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat"
    });

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        ok: true,
        providers: {
          chat: {
            readiness: "ready",
            observed: "unknown",
            available: true,
            status: "degraded"
          },
          chatCapability: {
            readiness: "ready",
            observed: "unknown",
            operational: true
          }
        }
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not make a disabled default mock provider healthy", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const app = await buildTestServer({
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "mock"
    });

    try {
      const status = await app.inject({ method: "GET", url: "/providers/status" });
      expect(status.json().providers.chat).toMatchObject({
        provider: "mock",
        mock: false,
        readiness: "not_ready",
        available: false
      });
      expect(status.json().routes.chat).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ provider: "mock", readiness: "ready" })])
      );

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json()).toMatchObject({
        ok: false,
        providers: {
          chatCapability: {
            readiness: "not_ready",
            operational: false
          }
        }
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("verify embedding reports dimension mismatches safely", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2] }]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    try {
      const app = await buildTestServer({
        EMBEDDING_PROVIDER: "openai-compatible",
        DEFAULT_EMBEDDING_PROVIDER: "openai-compatible",
        EMBEDDING_API_BASEURL: "https://embedding.example/v1",
        EMBEDDING_API_KEY: "embedding-secret-key",
        EMBEDDING_MODEL: "text-embedding-test",
        EMBEDDING_DIMENSIONS: "3"
      });
      const embedding = await app.inject({
        method: "POST",
        url: "/providers/verify/embedding"
      });

      expect(embedding.statusCode).toBe(200);
      expect(embedding.json()).toMatchObject({
        ok: false,
        provider: "openai-compatible",
        capability: "embedding",
        mock: false,
        semanticEmbedding: true,
        expectedDimensions: 3,
        actualDimensions: 2,
        dimensions: 2,
        error: expect.stringContaining("Provider returned 2 dimensions")
      });
      expect(embedding.body).not.toContain("embedding-secret-key");
      expect(embedding.body).not.toContain("Authorization");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await app.close();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("requires the optional dashboard dev token for sensitive development endpoints", async () => {
    const app = await buildTestServer({ DASHBOARD_DEV_TOKEN: "dev-token" });

    try {
      const blockedSettings = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { values: { SERVER_PORT: "6121" } }
      });
      expect(blockedSettings.statusCode).toBe(401);
      expect(blockedSettings.body).not.toContain("dev-token");

      const blockedSettingsRead = await app.inject({
        method: "GET",
        url: "/settings/runtime"
      });
      expect(blockedSettingsRead.statusCode).toBe(401);

      const blockedVerify = await app.inject({
        method: "POST",
        url: "/providers/verify/chat"
      });
      expect(blockedVerify.statusCode).toBe(401);
      expect(blockedVerify.body).not.toContain("dev-token");

      const blockedMaintenance = await app.inject({
        method: "POST",
        url: "/memory/maintenance/run",
        payload: { dryRun: true }
      });
      expect(blockedMaintenance.statusCode).toBe(401);
      expect(blockedMaintenance.body).not.toContain("dev-token");

      const allowedVerify = await app.inject({
        method: "POST",
        url: "/providers/verify/chat",
        headers: {
          "X-YUVI-Dev-Token": "dev-token"
        }
      });
      expect(allowedVerify.statusCode).toBe(200);
      expect(allowedVerify.json()).toMatchObject({
        ok: true,
        capability: "chat"
      });
      expect(allowedVerify.body).not.toContain("dev-token");

      const allowedSettingsRead = await app.inject({
        method: "GET",
        url: "/settings/runtime",
        headers: {
          "X-YUVI-Dev-Token": "dev-token"
        }
      });
      expect(allowedSettingsRead.statusCode).toBe(200);

      const allowedMaintenance = await app.inject({
        method: "POST",
        url: "/memory/maintenance/run",
        headers: {
          "X-YUVI-Dev-Token": "dev-token"
        },
        payload: { dryRun: true, limit: 10 }
      });
      expect(allowedMaintenance.statusCode).toBe(200);
      expect(allowedMaintenance.json()).toMatchObject({
        ok: true,
        repository: "in-memory",
        summary: {
          dryRun: true,
          scanned: expect.any(Number),
          expired: expect.any(Number),
          stale: expect.any(Number),
          supersessionWarnings: expect.any(Number),
          skipped: expect.any(Number),
          failed: 0
        }
      });
      expect(allowedMaintenance.body).not.toContain("dev-token");
    } finally {
      await app.close();
    }
  });

  it("requires localhost for settings and explicit provider verification even without a token", async () => {
    const app = await buildTestServer();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const settings = await app.inject({
        method: "GET",
        url: "/settings/runtime",
        remoteAddress: "10.0.0.8"
      });
      expect(settings.statusCode).toBe(403);

      const verify = await app.inject({
        method: "POST",
        url: "/providers/verify/chat",
        remoteAddress: "10.0.0.8"
      });
      expect(verify.statusCode).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();

      const health = await app.inject({
        method: "GET",
        url: "/health",
        remoteAddress: "10.0.0.8"
      });
      expect(health.statusCode).toBe(200);
    } finally {
      fetchSpy.mockRestore();
      await app.close();
    }
  });

  it("reports ANN/vector index status safely", async () => {
    const app = await buildTestServer();

    try {
      const status = await app.inject({ method: "GET", url: "/memory/vector-index/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        ok: true,
        status: {
          vectorIndexEnabled: expect.any(Boolean),
          vectorIndexType: expect.stringMatching(/^(none|hnsw|ivfflat|unavailable)$/),
          vectorDistance: "cosine",
          indexCreated: expect.any(Boolean),
          indexAvailable: expect.any(Boolean),
          annAccelerationActive: expect.any(Boolean),
          embeddedCount: expect.any(Number),
          missingEmbeddingCount: expect.any(Number)
        }
      });
      expect(status.body).not.toContain("DATABASE_URL");
      expect(status.body).not.toContain("test_deepseek_secret");
      expect(status.body).not.toContain("[0.");
    } finally {
      await app.close();
    }
  });

  it("keeps deep restart dev-only, token-protected, and unsupported without supervisor", async () => {
    const productionApp = await buildTestServer({
      RUNTIME_MODE: "production",
      DASHBOARD_DEV_TOKEN: "restart-token"
    });
    try {
      const production = await productionApp.inject({
        method: "POST",
        url: "/system/restart/deep",
        headers: { "X-YUVI-Dev-Token": "restart-token" }
      });
      expect(production.statusCode).toBe(404);
      expect(production.body).not.toContain("restart-token");
    } finally {
      await productionApp.close();
    }

    const app = await buildTestServer({ DASHBOARD_DEV_TOKEN: "restart-token" });
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: "/system/restart/deep"
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.body).not.toContain("restart-token");

      const unsupported = await app.inject({
        method: "POST",
        url: "/system/restart/deep",
        headers: { "X-YUVI-Dev-Token": "restart-token" }
      });
      expect(unsupported.statusCode).toBe(409);
      expect(unsupported.json()).toMatchObject({
        error: "unsupported",
        supervisorActive: false
      });
      expect(unsupported.body).not.toContain("restart-token");
    } finally {
      await app.close();
    }
  });

  it("requests supervised deep restart with a safe marker", async () => {
    vi.useFakeTimers();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-restart-marker-"));
    const markerPath = path.join(tempDir, "restart-request.json");
    const app = await buildTestServer({
      YUVI_DEV_SUPERVISOR: "1",
      YUVI_RESTART_MARKER: markerPath,
      YUVI_AUTO_MIGRATE: "1"
    });

    try {
      const restart = await app.inject({
        method: "POST",
        url: "/system/restart/deep"
      });
      expect(restart.statusCode).toBe(200);
      expect(restart.json()).toMatchObject({
        ok: true,
        restartRequested: true,
        supervisorActive: true,
        autoMigrate: true
      });
      expect(restart.body).not.toContain("DATABASE_URL");

      const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
        reason?: string;
        requestedAt?: string;
      };
      expect(marker).toMatchObject({
        reason: "dashboard-deep-restart",
        requestedAt: expect.any(String)
      });

      await vi.advanceTimersByTimeAsync(150);
      expect(process.exitCode).toBe(42);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps memory maintenance scheduler disabled by default", async () => {
    const app = await buildTestServer();

    try {
      const status = await app.inject({ method: "GET", url: "/memory/maintenance/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        ok: true,
        repository: "in-memory",
        scheduler: {
          enabled: false,
          runOnStartup: false,
          intervalMinutes: 0,
          limit: 500,
          running: false,
          lastRunAt: null,
          lastSummary: null,
          lastError: null,
          nextRunAt: null
        }
      });
    } finally {
      await app.close();
    }
  });

  it("runs memory maintenance once on startup when enabled", async () => {
    const app = await buildTestServer({
      MEMORY_MAINTENANCE_ENABLED: "true",
      MEMORY_MAINTENANCE_RUN_ON_STARTUP: "true",
      MEMORY_MAINTENANCE_LIMIT: "25"
    });

    try {
      await vi.waitFor(async () => {
        const status = await app.inject({ method: "GET", url: "/memory/maintenance/status" });
        expect(status.json().scheduler.lastSummary).toMatchObject({
          dryRun: false,
          scanned: expect.any(Number),
          failed: 0
        });
      });
      const status = await app.inject({ method: "GET", url: "/memory/maintenance/status" });
      expect(status.json().scheduler).toMatchObject({
        enabled: true,
        runOnStartup: true,
        limit: 25,
        running: false
      });
      expect(status.body).not.toContain("test_deepseek_secret");
    } finally {
      await app.close();
    }
  });

  it("runs interval maintenance and clears the timer on close", async () => {
    vi.useFakeTimers();
    const runSpy = vi.spyOn(MemoryMaintenanceService.prototype, "run");
    const app = await buildTestServer({
      MEMORY_MAINTENANCE_ENABLED: "true",
      MEMORY_MAINTENANCE_INTERVAL_MINUTES: "1",
      MEMORY_MAINTENANCE_LIMIT: "7"
    });
    let closed = false;

    try {
      expect(runSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => {
        expect(runSpy).toHaveBeenCalledTimes(1);
      });
      expect(runSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dryRun: false,
          limit: 7
        })
      );
      const status = await app.inject({ method: "GET", url: "/memory/maintenance/status" });
      expect(status.json().scheduler).toMatchObject({
        enabled: true,
        intervalMinutes: 1,
        running: false,
        lastSummary: expect.any(Object)
      });

      await app.close();
      closed = true;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(runSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (!closed) {
        await app.close();
      }
    }
  });

  it("manual memory maintenance updates scheduler status and respects limit without deleting", async () => {
    const app = await buildTestServer();

    try {
      const first = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Expired maintenance content SECRET_SHOULD_NOT_LEAK one.",
          source: "test",
          expiresAt: "2026-05-20T00:00:00.000Z"
        }
      });
      const second = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Expired maintenance content SECRET_SHOULD_NOT_LEAK two.",
          source: "test",
          expiresAt: "2026-05-20T00:00:00.000Z"
        }
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const run = await app.inject({
        method: "POST",
        url: "/memory/maintenance/run",
        payload: {
          dryRun: false,
          limit: 1,
          now: "2026-05-24T00:00:00.000Z"
        }
      });
      expect(run.statusCode).toBe(200);
      expect(run.json().summary).toMatchObject({
        dryRun: false,
        scanned: 1,
        expired: 1,
        failed: 0
      });
      expect(run.body).not.toContain("SECRET_SHOULD_NOT_LEAK");

      const status = await app.inject({ method: "GET", url: "/memory/maintenance/status" });
      expect(status.json().scheduler.lastSummary).toMatchObject({
        scanned: 1,
        expired: 1,
        failed: 0
      });
      expect(status.body).not.toContain("SECRET_SHOULD_NOT_LEAK");

      const firstDetail = await app.inject({
        method: "GET",
        url: `/memory/${first.json().id as string}`
      });
      const secondDetail = await app.inject({
        method: "GET",
        url: `/memory/${second.json().id as string}`
      });
      expect([firstDetail.statusCode, secondDetail.statusCode]).toEqual([200, 200]);
      expect([firstDetail.json().status, secondDetail.json().status].sort()).toEqual([
        "active",
        "expired"
      ]);
    } finally {
      await app.close();
    }
  });

  it("ignores unrelated ambient env and runtime env files in ordinary server tests", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-ambient-env-"));
    process.env["YUVI_RUNTIME_ENV_DIR"] = tempDir;
    process.env["DASHBOARD_DEV_TOKEN"] = "ambient-token";
    process.env["PROVIDER_ALLOW_MOCKS"] = "false";
    process.env["DEEPSEEK_API_KEY"] = "ambient_deepseek_secret";
    await writeFile(
      path.join(tempDir, ".env.local"),
      [
        "DASHBOARD_DEV_TOKEN=file-token",
        "PROVIDER_ALLOW_MOCKS=false",
        "DEEPSEEK_API_KEY=file_deepseek_secret"
      ].join("\n"),
      "utf8"
    );

    const app = await buildTestServer();

    try {
      const message = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "ambient",
          text: "hello",
          options: {
            readMemory: false,
            writeMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(message.statusCode).toBe(200);
      expect(message.json().reply).toContain("Mock reply");

      const verify = await app.inject({ method: "POST", url: "/providers/verify/chat" });
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toMatchObject({
        ok: true,
        provider: "mock",
        mock: true
      });
      expect(`${message.body}\n${verify.body}`).not.toContain("ambient_deepseek_secret");
      expect(`${message.body}\n${verify.body}`).not.toContain("file_deepseek_secret");
      expect(`${message.body}\n${verify.body}`).not.toContain("ambient-token");
      expect(`${message.body}\n${verify.body}`).not.toContain("file-token");
    } finally {
      await app.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses optional memory extractor mode", () => {
    expect(loadServerConfig({}).memoryIngestion).toMatchObject({
      enabled: true,
      pollIntervalMs: 15_000,
      concurrency: 4,
      maxDeliveryAttempts: 8
    });
    expect(loadServerConfig({}).memoryExtractor).toBe("rule-based");
    expect(loadServerConfig({ MEMORY_EXTRACTOR: "rule-based" }).memoryExtractor).toBe("rule-based");
    expect(loadServerConfig({ MEMORY_EXTRACTOR: "llm" }).memoryExtractor).toBe("llm");
    expect(() => loadServerConfig({ MEMORY_EXTRACTOR: "external" })).toThrow(
      "Unsupported MEMORY_EXTRACTOR"
    );
  });

  it("parses event bus boundary values", async () => {
    expect(loadServerConfig({ EVENT_BUS: "in-memory" }).eventBus).toBe("in-memory");
    expect(loadServerConfig({ EVENT_BUS: "nats" }).eventBus).toBe("nats");
    await expect(buildServer(loadServerConfig({ EVENT_BUS: "nats" }))).rejects.toThrow(
      "EVENT_BUS=nats is reserved"
    );
    expect(() => loadServerConfig({ EVENT_BUS: "external" })).toThrow("Unsupported EVENT_BUS");
  });

  it("returns and updates safe runtime settings without exposing secrets", async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-settings-"));
    const env = createTestEnv({
      YUVI_RUNTIME_ENV_DIR: tempDir,
      PROVIDER_ALLOW_MOCKS: "false",
      DEEPSEEK_API_KEY: "configured_deepseek_secret",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });

    try {
      process.chdir(tempDir);
      process.env = { ...env };
      const app = await buildServer(loadServerConfig(env));

      const settings = await app.inject({ method: "GET", url: "/settings/runtime" });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().configFiles[".env"].exists).toBe(false);
      expect(settings.json().configFiles[".env.local"].exists).toBe(false);
      expect(settings.json().activeRuntimeConfig.outputLanguage).toBe("AUTO");
      expect(settings.json().providers.deepseek.apiKeyConfigured).toBe(true);
      expect(settings.json().providers.deepseek.apiKeyPreview).toBe("••••••••••••cret");
      expect(settings.json().providers.deepseek.apiKeyPreview).not.toBe(
        "configured_deepseek_secret"
      );
      expect(settings.json().providers.deepseek.apiKeyPreview.length).toBe(16);
      expect(settings.json().providers.xai.apiKeyConfigured).toBe(false);
      expect(settings.json().providers.xai.apiKeyPreview).toBeUndefined();
      expect(settings.json().activeRuntimeConfig.providers).toEqual(
        expect.objectContaining({
          chat: expect.any(Object),
          reasoning: expect.any(Object),
          embedding: expect.any(Object),
          tts: expect.any(Object),
          stt: expect.any(Object),
          vision: expect.any(Object)
        })
      );
      expect(settings.json().providers.xai.implementedCapabilities).toEqual(["tts", "vision"]);
      expect(settings.json().providers.dashscope.implementedCapabilities).toEqual(["stt"]);
      expect(settings.json().memory).toMatchObject({
        memoryExtractor: "llm",
        activeMemoryExtractor: "llm",
        memoryExtractorDefault: "rule-based",
        reasoningProviderConfigured: true
      });
      expect(settings.body).not.toContain("configured_deepseek_secret");
      expect(settings.body).not.toContain("Authorization");

      const outputLanguageUpdate = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { values: { OUTPUT_LANGUAGE: "zh" } }
      });
      expect(outputLanguageUpdate.statusCode).toBe(200);
      expect(outputLanguageUpdate.json()).toMatchObject({
        ok: true,
        restartRequired: false,
        changedKeys: ["OUTPUT_LANGUAGE"]
      });
      expect(outputLanguageUpdate.json().settings.settings.OUTPUT_LANGUAGE).toMatchObject({
        effective: "zh",
        source: ".env.local"
      });
      expect(outputLanguageUpdate.json().settings.activeRuntimeConfig.outputLanguage).toBe("AUTO");

      const outputLanguageReload = await app.inject({
        method: "POST",
        url: "/settings/runtime/reload"
      });
      expect(outputLanguageReload.statusCode).toBe(200);
      expect(outputLanguageReload.json()).toMatchObject({
        ok: true,
        applied: true,
        appliedKeys: ["OUTPUT_LANGUAGE"],
        restartRequired: false,
        settings: {
          activeRuntimeConfig: { outputLanguage: "ZH" }
        }
      });

      const unsafe = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            NODE_ENV: "production"
          }
        }
      });
      expect(unsafe.statusCode).toBe(400);
      expect(unsafe.json().error).toBe("unsafe_keys");

      const invalidExtractor = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            MEMORY_EXTRACTOR: "external"
          }
        }
      });
      expect(invalidExtractor.statusCode).toBe(400);
      expect(invalidExtractor.json().error).toBe("invalid_settings");
      expect(invalidExtractor.json().fieldErrors.MEMORY_EXTRACTOR).toEqual(expect.any(String));

      const update = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            MEMORY_REPOSITORY: "postgres",
            DATABASE_URL: "postgres://settings-test",
            MEMORY_EXTRACTOR: "rule-based",
            DEEPSEEK_API_KEY: "new_deepseek_secret",
            DEEPSEEK_CHAT_MODEL: "deepseek-chat"
          }
        }
      });
      expect(update.statusCode).toBe(200);
      expect(update.json()).toMatchObject({
        ok: true,
        restartRequired: true
      });
      expect(update.json().changedKeys).toEqual(
        expect.arrayContaining(["MEMORY_REPOSITORY", "MEMORY_EXTRACTOR", "DEEPSEEK_API_KEY"])
      );
      expect(update.json().settings.memory.memoryRepository).toBe("postgres");
      expect(update.json().settings.memory.memoryExtractor).toBe("rule-based");
      expect(update.json().settings.configFiles[".env.local"].exists).toBe(true);
      expect(update.json().settings.settings.MEMORY_REPOSITORY).toMatchObject({
        base: "",
        localOverride: "postgres",
        effective: "postgres",
        source: ".env.local"
      });
      expect(update.json().settings.settings.MEMORY_EXTRACTOR).toMatchObject({
        base: "",
        localOverride: "rule-based",
        effective: "rule-based",
        source: ".env.local"
      });
      expect(update.json().settings.settings.DEEPSEEK_API_KEY).toMatchObject({
        baseConfigured: false,
        localOverrideConfigured: true,
        effectiveConfigured: true,
        maskedValue: "••••••••••••cret",
        source: ".env.local"
      });
      expect(update.body).not.toContain("new_deepseek_secret");
      expect(update.body).not.toContain("configured_deepseek_secret");
      expect(update.json().settings.providers.deepseek.apiKeyConfigured).toBe(true);
      expect(update.json().settings.providers.deepseek.apiKeyPreview).toBe("••••••••••••cret");

      const localEnv = await readFile(path.join(tempDir, ".env.local"), "utf8");
      expect(localEnv.match(/^DEEPSEEK_API_KEY=/gmu)).toHaveLength(1);
      expect(localEnv).toContain("DEEPSEEK_API_KEY=new_deepseek_secret");
      if (process.platform !== "win32") {
        expect((await stat(path.join(tempDir, ".env.local"))).mode & 0o777).toBe(0o600);
      }

      const updateExisting = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            DEEPSEEK_API_KEY: "second_secret_value"
          }
        }
      });
      expect(updateExisting.statusCode).toBe(200);
      const updatedLocalEnv = await readFile(path.join(tempDir, ".env.local"), "utf8");
      expect(updatedLocalEnv.match(/^DEEPSEEK_API_KEY=/gmu)).toHaveLength(1);
      expect(updatedLocalEnv).toContain("DEEPSEEK_API_KEY=second_secret_value");
      expect(updateExisting.body).not.toContain("second_secret_value");

      const [concurrentModel, concurrentVoice] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/settings/runtime",
          payload: { values: { DEEPSEEK_CHAT_MODEL: "concurrent-model" } }
        }),
        app.inject({
          method: "POST",
          url: "/settings/runtime",
          payload: { values: { XAI_TTS_VOICE: "concurrent-voice" } }
        })
      ]);
      expect(concurrentModel.statusCode).toBe(200);
      expect(concurrentVoice.statusCode).toBe(200);
      const concurrentLocalEnv = await readFile(path.join(tempDir, ".env.local"), "utf8");
      expect(concurrentLocalEnv).toContain("DEEPSEEK_CHAT_MODEL=concurrent-model");
      expect(concurrentLocalEnv).toContain("XAI_TTS_VOICE=concurrent-voice");

      const beforeInvalidUpdate = concurrentLocalEnv;
      const invalidPort = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { values: { SERVER_PORT: "6121abc" } }
      });
      expect(invalidPort.statusCode).toBe(400);
      expect(invalidPort.json()).toMatchObject({
        error: "invalid_settings",
        fieldErrors: { SERVER_PORT: expect.any(String) }
      });
      expect(await readFile(path.join(tempDir, ".env.local"), "utf8")).toBe(beforeInvalidUpdate);

      const invalidEmbeddingProvider = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { values: { EMBEDDING_PROVIDER: "unsupported-provider" } }
      });
      expect(invalidEmbeddingProvider.statusCode).toBe(400);
      expect(invalidEmbeddingProvider.json()).toMatchObject({
        error: "invalid_settings",
        fieldErrors: { EMBEDDING_PROVIDER: expect.any(String) }
      });
      expect(await readFile(path.join(tempDir, ".env.local"), "utf8")).toBe(beforeInvalidUpdate);
      expect(process.env["EMBEDDING_PROVIDER"]).toBe("mock");

      const conflictingUpdate = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: { DEEPSEEK_CHAT_MODEL: "ignored" },
          removeOverrides: ["DEEPSEEK_CHAT_MODEL"]
        }
      });
      expect(conflictingUpdate.statusCode).toBe(400);

      const removedSecret = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { removeOverrides: ["DEEPSEEK_API_KEY"] }
      });
      expect(removedSecret.statusCode).toBe(200);
      expect(await readFile(path.join(tempDir, ".env.local"), "utf8")).not.toMatch(
        /^DEEPSEEK_API_KEY=/mu
      );
      expect(removedSecret.json().settings.settings.DEEPSEEK_API_KEY).toMatchObject({
        localOverrideConfigured: false,
        effectiveConfigured: true,
        source: "process.env/default"
      });

      await app.close();
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("shows .env.local overrides as pending safe settings without mutating .env", async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-settings-overlay-"));
    const env = createTestEnv({ YUVI_RUNTIME_ENV_DIR: tempDir });

    try {
      process.chdir(tempDir);
      await writeFile(path.join(tempDir, ".env"), "DEEPSEEK_CHAT_MODEL=from-env\n", "utf8");
      await writeFile(
        path.join(tempDir, ".env.local"),
        "DEEPSEEK_CHAT_MODEL=from-local\nXAI_API_KEY=local_xai_secret\n",
        "utf8"
      );

      process.env = { ...env };
      const app = await buildServer(loadServerConfig(env));
      const settings = await app.inject({ method: "GET", url: "/settings/runtime" });

      expect(settings.statusCode).toBe(200);
      expect(settings.json().configFiles[".env"]).toMatchObject({
        exists: true,
        gitIgnored: true
      });
      expect(settings.json().configFiles[".env.local"]).toMatchObject({
        exists: true,
        gitIgnored: true
      });
      expect(settings.json().providers.deepseek.chatModel).toBe("from-local");
      expect(settings.json().settings.DEEPSEEK_CHAT_MODEL).toMatchObject({
        base: "from-env",
        localOverride: "from-local",
        effective: "from-local",
        source: ".env.local"
      });
      expect(settings.json().baseConfig.DEEPSEEK_CHAT_MODEL).toBe("from-env");
      expect(settings.json().localOverrideConfig.DEEPSEEK_CHAT_MODEL).toBe("from-local");
      expect(settings.json().effectiveConfig.DEEPSEEK_CHAT_MODEL).toBe("from-local");
      expect(settings.json().providers.xai.apiKeyConfigured).toBe(true);
      expect(settings.json().providers.xai.apiKeyPreview).toBe("••••••••••••cret");
      expect(settings.json().settings.XAI_API_KEY).toMatchObject({
        baseConfigured: false,
        localOverrideConfigured: true,
        effectiveConfigured: true,
        maskedValue: "••••••••••••cret",
        source: ".env.local"
      });
      expect(settings.json().restartRequired).toBe(false);
      expect(settings.body).not.toContain("local_xai_secret");
      expect(await readFile(path.join(tempDir, ".env"), "utf8")).toBe(
        "DEEPSEEK_CHAT_MODEL=from-env\n"
      );

      await app.close();
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts URL userinfo across runtime settings and provider status responses", async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-settings-url-redaction-"));
    const configuredUrl = "https://synthetic_user:synthetic_password@example.test/v1";
    const sanitizedUrl = "https://example.test/v1";
    const env = createTestEnv({
      YUVI_RUNTIME_ENV_DIR: tempDir,
      PROVIDER_ALLOW_MOCKS: "false",
      DEEPSEEK_API_KEY: "synthetic_deepseek_api_key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });
    let app: Awaited<ReturnType<typeof buildServer>> | undefined;

    try {
      process.chdir(tempDir);
      process.env = { ...env };
      app = await buildServer(loadServerConfig(env));

      const update = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { values: { DEEPSEEK_API_BASEURL: configuredUrl } }
      });
      expect(update.statusCode).toBe(200);
      expect(update.body).not.toContain(configuredUrl);
      expect(update.body).not.toContain("synthetic_user");
      expect(update.body).not.toContain("synthetic_password");
      expect(update.json().settings.providers.deepseek.baseUrl).toBe(sanitizedUrl);
      expect(update.json().settings.effectiveConfig.DEEPSEEK_API_BASEURL).toBe(sanitizedUrl);

      const reload = await app.inject({ method: "POST", url: "/settings/runtime/reload" });
      expect(reload.statusCode).toBe(200);
      expect(reload.body).not.toContain(configuredUrl);
      expect(reload.body).not.toContain("synthetic_user");
      expect(reload.body).not.toContain("synthetic_password");
      expect(reload.json().active.providers.chat.baseUrl).toBe(sanitizedUrl);

      const settings = await app.inject({ method: "GET", url: "/settings/runtime" });
      expect(settings.statusCode).toBe(200);
      expect(settings.body).not.toContain(configuredUrl);
      expect(settings.body).not.toContain("synthetic_user");
      expect(settings.body).not.toContain("synthetic_password");
      expect(settings.json().providers.deepseek.baseUrl).toBe(sanitizedUrl);
      expect(settings.json().activeRuntimeConfig.providers.chat.baseUrl).toBe(sanitizedUrl);

      const providers = await app.inject({ method: "GET", url: "/providers/status" });
      expect(providers.statusCode).toBe(200);
      expect(providers.body).not.toContain(configuredUrl);
      expect(providers.body).not.toContain("synthetic_user");
      expect(providers.body).not.toContain("synthetic_password");
      expect(providers.json().providers.chat.baseUrl).toBe(sanitizedUrl);
      expect(
        providers
          .json()
          .routes.chat.find((route: { provider: string }) => route.provider === "deepseek").baseUrl
      ).toBe(sanitizedUrl);
    } finally {
      await app?.close();
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes local overrides so effective settings inherit from .env", async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-settings-inherit-"));
    const env = createTestEnv({
      YUVI_RUNTIME_ENV_DIR: tempDir,
      SERVER_PORT: "6121"
    });

    try {
      process.chdir(tempDir);
      await writeFile(
        path.join(tempDir, ".env"),
        "SERVER_PORT=6121\nPROVIDER_ALLOW_MOCKS=true\n",
        "utf8"
      );
      await writeFile(
        path.join(tempDir, ".env.local"),
        "SERVER_PORT=6121\nMANUALLY_ADDED_SETTING=preserve-me\n",
        "utf8"
      );
      process.env = { ...env };
      const app = await buildServer(loadServerConfig(env));

      const before = await app.inject({ method: "GET", url: "/settings/runtime" });
      expect(before.statusCode).toBe(200);
      expect(before.json().settings.SERVER_PORT).toMatchObject({
        base: "6121",
        localOverride: "6121",
        effective: "6121",
        source: ".env.local"
      });

      const changed = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { values: { SERVER_PORT: "6122" } }
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().pendingRestartKeys).toContain("SERVER_PORT");

      const removed = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { removeOverrides: ["SERVER_PORT"] }
      });
      expect(removed.statusCode).toBe(200);
      expect(await readFile(path.join(tempDir, ".env.local"), "utf8")).not.toMatch(
        /^SERVER_PORT=/mu
      );
      expect(await readFile(path.join(tempDir, ".env.local"), "utf8")).toContain(
        "MANUALLY_ADDED_SETTING=preserve-me"
      );
      expect(removed.json().settings.settings.SERVER_PORT).toMatchObject({
        base: "6121",
        localOverride: "",
        effective: "6121",
        source: ".env"
      });

      await app.close();
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reloads saved provider config into the active runtime without leaking secrets", async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-settings-reload-"));
    const env = createTestEnv({
      YUVI_RUNTIME_ENV_DIR: tempDir,
      DEEPSEEK_CHAT_MODEL: "old-active",
      SERVER_PORT: "6121"
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "deepseek-chat",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "Reloaded provider reply." }
            }
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 5,
            total_tokens: 17
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    try {
      process.chdir(tempDir);
      process.env = { ...env };
      const app = await buildServer(loadServerConfig(env), {
        conversationReceiptAdmission: {
          async admit() {
            return {
              status: "APPENDED",
              envelope: { eventId: "jev1_testserverreceipt00000002" } as never
            };
          }
        }
      });

      const initialProviders = await app.inject({ method: "GET", url: "/providers/status" });
      expect(initialProviders.statusCode).toBe(200);
      expect(initialProviders.json().providers.chat).toMatchObject({
        configured: false,
        readiness: "not_ready",
        mock: false
      });
      expect(initialProviders.json().routes.chat.at(-1)).toMatchObject({
        provider: "mock",
        readiness: "ready",
        mock: true
      });

      const update = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            DEEPSEEK_API_KEY: "reload_deepseek_secret",
            DEEPSEEK_CHAT_MODEL: "deepseek-chat",
            DEEPSEEK_REASONING_MODEL: "deepseek-reasoner",
            MEMORY_EXTRACTOR: "rule-based"
          }
        }
      });
      expect(update.statusCode).toBe(200);
      expect(update.body).not.toContain("reload_deepseek_secret");
      expect(process.env["DEEPSEEK_CHAT_MODEL"]).toBe("old-active");
      const desiredBeforeReload = await app.inject({
        method: "GET",
        url: "/settings/runtime"
      });
      expect(desiredBeforeReload.json().effectiveConfig.DEEPSEEK_CHAT_MODEL).toBe("deepseek-chat");
      expect(desiredBeforeReload.json().activeRuntimeConfig.providers.chat.model).toBe(
        "old-active"
      );

      const reload = await app.inject({ method: "POST", url: "/settings/runtime/reload" });
      expect(reload.statusCode).toBe(200);
      expect(reload.json()).toMatchObject({
        ok: true,
        applied: true,
        restartRequired: false
      });
      expect(reload.json().settings.memory.activeMemoryExtractor).toBe("rule-based");
      expect(process.env["DEEPSEEK_CHAT_MODEL"]).toBe("deepseek-chat");
      expect(reload.json().active.providers.chat).toMatchObject({
        provider: "deepseek",
        configured: true,
        mock: false,
        model: "deepseek-chat"
      });
      expect(reload.body).not.toContain("reload_deepseek_secret");

      const providers = await app.inject({ method: "GET", url: "/providers/status" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.chat).toMatchObject({
        configured: true,
        mock: false,
        model: "deepseek-chat"
      });
      expect(providers.body).not.toContain("reload_deepseek_secret");

      const message = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "reload",
          text: "hello after reload",
          options: {
            readMemory: false,
            writeMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(message.statusCode).toBe(200);
      expect(message.json().reply).toBe("Reloaded provider reply.");
      expect(message.json().provider).toMatchObject({
        name: "deepseek",
        capability: "chat",
        mock: false,
        model: "deepseek-chat"
      });
      expect(message.body).not.toContain("reload_deepseek_secret");

      const portUpdate = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { values: { SERVER_PORT: "6122" } }
      });
      expect(portUpdate.statusCode).toBe(200);
      expect(portUpdate.json().pendingRestartKeys).toContain("SERVER_PORT");
      expect(portUpdate.json().settings.runtime.serverPort).toBe(6122);
      expect(portUpdate.json().settings.runtime.activeServerPort).toBe(6121);
      expect(process.env["SERVER_PORT"]).toBe("6121");

      const memoryUpdate = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            MEMORY_REPOSITORY: "postgres",
            DATABASE_URL: "postgres://reload-settings-test"
          }
        }
      });
      expect(memoryUpdate.statusCode).toBe(200);
      const memoryReload = await app.inject({ method: "POST", url: "/settings/runtime/reload" });
      expect(memoryReload.statusCode).toBe(200);
      expect(memoryReload.json().restartRequired).toBe(true);
      expect(memoryReload.json().notHotReloaded).toContain("MEMORY_REPOSITORY");
      expect(memoryReload.json().notHotReloaded).toContain("SERVER_PORT");
      expect(memoryReload.json().active.memoryRepository).toBe("in-memory");
      expect(process.env["SERVER_PORT"]).toBe("6121");

      await app.close();
    } finally {
      fetchSpy.mockRestore();
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps embedding identity and dimension changes pending restart", async () => {
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-dimension-reload-"));
    const env = createTestEnv({
      YUVI_RUNTIME_ENV_DIR: tempDir,
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_EMBEDDING_PROVIDER: "local",
      EMBEDDING_PROVIDER: "local",
      EMBEDDING_PROVIDER_CHAIN: "local",
      EMBEDDING_DIMENSIONS: "1024",
      LOCAL_MODEL_BASEURL: "http://127.0.0.1:8128/v1",
      LOCAL_EMBEDDING_MODEL: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      LOCAL_EMBEDDING_DIMENSIONS: "512"
    });

    try {
      process.chdir(tempDir);
      process.env = { ...env };
      const app = await buildServer(loadServerConfig(env));

      try {
        const initial = await app.inject({ method: "GET", url: "/providers/status" });
        expect(initial.json().providers.embedding).toMatchObject({
          provider: "local",
          model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
          dimensions: 512
        });

        const update = await app.inject({
          method: "POST",
          url: "/settings/runtime",
          payload: {
            values: {
              LOCAL_EMBEDDING_MODEL: "pending-local-embedding-model",
              LOCAL_EMBEDDING_DIMENSIONS: "256"
            }
          }
        });
        expect(update.statusCode).toBe(200);
        expect(update.json().pendingRestartKeys).toContain("LOCAL_EMBEDDING_MODEL");
        expect(update.json().pendingRestartKeys).toContain("LOCAL_EMBEDDING_DIMENSIONS");

        const reload = await app.inject({
          method: "POST",
          url: "/settings/runtime/reload"
        });
        expect(reload.statusCode).toBe(200);
        expect(reload.json()).toMatchObject({
          ok: true,
          applied: true,
          restartRequired: true
        });
        expect(reload.json().notHotReloaded).toContain("LOCAL_EMBEDDING_MODEL");
        expect(reload.json().notHotReloaded).toContain("LOCAL_EMBEDDING_DIMENSIONS");
        expect(reload.json().active.providers.embedding).toMatchObject({
          provider: "local",
          model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
          dimensions: 512
        });

        const settings = await app.inject({ method: "GET", url: "/settings/runtime" });
        expect(settings.json().effectiveConfig.LOCAL_EMBEDDING_MODEL).toBe(
          "pending-local-embedding-model"
        );
        expect(settings.json().effectiveConfig.LOCAL_EMBEDDING_DIMENSIONS).toBe("256");
        expect(settings.json().activeRuntimeConfig.providers.embedding.model).toBe(
          "Qwen3-Embedding-0.6B-Q8_0.gguf"
        );
        expect(settings.json().activeRuntimeConfig.providers.embedding.dimensions).toBe(512);
      } finally {
        await app.close();
      }
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exposes memory extractor diagnostics only in development runtime settings", async () => {
    const devApp = await buildTestServer({ RUNTIME_MODE: "development" });
    try {
      const devSettings = await devApp.inject({ method: "GET", url: "/settings/runtime" });
      expect(devSettings.statusCode).toBe(200);
      const devMemory = devSettings.json().memory;
      expect(devMemory).toHaveProperty("memoryExtractorFailureStage");
      expect(devMemory).toHaveProperty("memoryExtractorSelectedOutputSource");
      expect(devMemory).toHaveProperty("memoryExtractorAnswerLength");
      expect(devMemory).toHaveProperty("memoryExtractorReasoningLength");
      expect(devMemory).toHaveProperty("memoryExtractorValidationIssues");
      expect(devMemory).toHaveProperty("memoryExtractorRawPreview");
    } finally {
      await devApp.close();
    }

    const prodApp = await buildTestServer({ RUNTIME_MODE: "production" });
    try {
      const prodSettings = await prodApp.inject({ method: "GET", url: "/settings/runtime" });
      expect(prodSettings.statusCode).toBe(200);
      expect(prodSettings.json().memory).not.toHaveProperty("memoryExtractorRawPreview");
      expect(prodSettings.json().memory).not.toHaveProperty("memoryExtractorFailureStage");
      expect(prodSettings.json().memory).not.toHaveProperty("memoryExtractorValidationIssues");
    } finally {
      await prodApp.close();
    }
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

type TestEnvOverrides = Record<string, string | undefined>;

function createTestEnv(overrides: TestEnvOverrides = {}): NodeJS.ProcessEnv {
  const runtimeEnvDir =
    overrides["YUVI_RUNTIME_ENV_DIR"] ??
    mkdtempSync(path.join(testTmpDir, "yuvi-server-test-env-"));
  if (!overrides["YUVI_RUNTIME_ENV_DIR"]) {
    createdRuntimeEnvDirs.push(runtimeEnvDir);
  }

  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    RUNTIME_MODE: "development",
    YUVI_RUNTIME_ENV_DIR: runtimeEnvDir,
    PROVIDER_ALLOW_MOCKS: "true",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_EXTRACTOR: "llm",
    EVENT_BUS: "in-memory",
    DEFAULT_CHAT_PROVIDER: "deepseek",
    DEFAULT_REASONING_PROVIDER: "deepseek",
    DEFAULT_TTS_PROVIDER: "xai",
    DEFAULT_STT_PROVIDER: "dashscope",
    DEFAULT_VISION_PROVIDER: "xai",
    EMBEDDING_PROVIDER: "mock",
    DEFAULT_EMBEDDING_PROVIDER: "mock",
    MEMORY_MAINTENANCE_ENABLED: "false",
    MEMORY_MAINTENANCE_RUN_ON_STARTUP: "false",
    MEMORY_MAINTENANCE_INTERVAL_MINUTES: "0",
    MEMORY_MAINTENANCE_LIMIT: "500"
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}

async function buildTestServer(overrides: TestEnvOverrides = {}) {
  const env = createTestEnv(overrides);
  process.env = { ...env };
  return buildServer(loadServerConfig(env), {
    conversationReceiptAdmission: {
      async admit() {
        return {
          status: "APPENDED" as const,
          envelope: { eventId: "jev1_testserverreceipt00000001" } as never
        };
      }
    },
    speechReceiptAdmission: createTestSpeechReceiptAdmission(),
    visionReceiptAdmission: createTestVisionReceiptAdmission()
  });
}

function findPromptSection(
  sections: Array<{ name: string; content: string }>,
  name: string
): { name: string; content: string } | undefined {
  return sections.find((section) => section.name === name);
}

function getServerOrigin(address: string | import("node:net").AddressInfo | null): string {
  if (!address || typeof address === "string") {
    throw new Error("Expected Fastify to listen on a TCP address.");
  }

  return `ws://${address.address}:${address.port}`;
}

async function readFirstWebSocketMessage(
  url: string
): Promise<{ kind?: string; traceId?: string }> {
  type MinimalWebSocket = {
    addEventListener(
      event: "open" | "message" | "error",
      listener: (event: { data?: unknown }) => void
    ): void;
    close(): void;
  };
  const WebSocketCtor = (
    globalThis as unknown as { WebSocket: new (url: string) => MinimalWebSocket }
  ).WebSocket;

  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for dashboard WebSocket message."));
    }, 2000);

    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(String(event.data)) as { kind?: string; traceId?: string });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Dashboard WebSocket connection failed."));
    });
  });
}
