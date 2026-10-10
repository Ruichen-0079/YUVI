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
import { RuntimeOrchestrator } from "./index.js";
describe("Runtime preserves semantics without keyword affect labels", () => {
  it.each([
    "我不担心这个问题。",
    "她引用了“我很担心”这句话。",
    "如果我担心这个问题，请先问我。",
    "I am not worried about this",
    "Explain the word anxious",
    "我很担心这个问题。"
  ])("preserves raw evidence rather than asserting inferred affect: %s", async (content) => {
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: {
        retrieveRelevantMemories: async () => [],
        scoreImportance: () => 0,
        rememberInteraction: async () => null
      },
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
      { sessionId: "affect-session", content, subjectUserId: "u", personaId: "alice" },
      { readMemory: false, writeMemory: false }
    );
    const preview = runtime.getLatestPromptPreview();
    expect(preview?.userMessage).toBe(content);
    expect(preview?.finalPrompt).toContain(content);
    expect(preview?.finalPrompt).not.toContain("<CurrentAffect>");
    expect(preview?.finalPrompt).not.toContain("User appears anxious");
    expect(preview?.finalPrompt).toContain("<CurrentTime>");
    expect(preview?.traceId).toBeTruthy();
    expect(preview?.timestamp).toBeTruthy();
    await runtime.sealAndDrainMemoryWrites();
  });
});
