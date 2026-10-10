import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "@companion/event-bus";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createMockChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockTTSProvider,
  createMockVisionProvider,
  MockEmbeddingProvider
} from "@companion/providers";
import { RuntimeOrchestrator, type RuntimeMemoryPort } from "./index.js";
describe("Runtime conversational text cannot grant destructive memory authority", () => {
  it.each([
    "Don't forget I prefer tea",
    "请删除我喜欢茶的记忆",
    'She said "forget the tea preference"',
    "If I say forget tea, ask me first"
  ])("preserves text and existing retrieval without deleting: %s", async (content) => {
    const forget = vi.fn(async () => ({
      deleted: 1,
      notFound: false,
      memoryIds: ["fact"],
      query: content
    }));
    const retrieve = vi.fn(async () => []);
    const memory: RuntimeMemoryPort = {
      isMem0Backend: () => true,
      forgetExplicitMemory: forget,
      retrieveRelevantMemories: retrieve,
      scoreImportance: () => 0,
      rememberInteraction: async () => null
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      promptBuilder: new PromptBuilder(),
      providers: {
        getChatProvider: () => createMockChatProvider("boundary-chat"),
        getReasoningProvider: () => createMockReasoningProvider("boundary-reasoning"),
        getSTTProvider: () => createMockSTTProvider("boundary-stt"),
        getTTSProvider: () => createMockTTSProvider("boundary-tts"),
        getVisionProvider: () => createMockVisionProvider("boundary-vision"),
        getEmbeddingProvider: () => new MockEmbeddingProvider(3)
      }
    });
    await runtime.handleUserMessage(
      { sessionId: "scope", content, personaId: "alice", subjectUserId: "u" },
      { readMemory: true, writeMemory: true }
    );
    expect(forget).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalled();
    const preview = runtime.getLatestPromptPreview();
    expect(preview?.userMessage).toBe(content);
    expect(JSON.stringify(preview)).not.toContain("deleted 1");
    await runtime.sealAndDrainMemoryWrites();
  });
});
