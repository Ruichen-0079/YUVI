import { describe, expect, it, vi } from "vitest";
import { RuntimeOrchestrator } from "@companion/core";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  InMemoryMemoryRepository,
  InMemoryConversationRepository,
  InMemoryRecentEpisodeStore,
  MemoryService
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import { createProviderRegistryFromEnv, type ChatInput } from "@companion/providers";
import { createServerCharacterPort } from "./character-runtime.js";

describe("production Character → Runtime → Vision → same-turn reply", () => {
  it.each([false, true])(
    "does not seed Memory episodes, including subsequent turns (conversation repository: %s)",
    (durableConversation) => {
      return run(durableConversation);
    }
  );
});
async function run(durableConversation: boolean) {
  const providers = createProviderRegistryFromEnv({
    PROVIDER_ALLOW_MOCKS: "true",
    CHAT_PROVIDER_CHAIN: "mock",
    VISION_PROVIDER_CHAIN: "xai",
    XAI_API_KEY: "test",
    XAI_VISION_MODEL: "test"
  });
  const responses = [
    '{"visualNeed":"Read the error dialog"}',
    '{"disposition":"RESPOND"}',
    '{"disposition":"RESPOND"}'
  ];
  const generateReply = vi.fn(async (_input: ChatInput) => ({
    message: { role: "assistant" as const, content: responses.shift()! },
    finishReason: "stop" as const
  }));
  vi.spyOn(providers, "getChatProvider").mockReturnValue({
    name: "character",
    generateReply,
    async *streamReply(input) {
      const text =
        input.messages[1]?.content === "Hello" ? "Hello again." : "SCREEN_FACT: permission denied.";
      if (text.startsWith("SCREEN_FACT")) expect(JSON.stringify(input)).toContain("SCREEN_FACT");
      yield { type: "text-delta", text };
      yield {
        type: "completed",
        output: { message: { role: "assistant", content: text }, finishReason: "stop" }
      };
    },
    healthCheck: async () => ({ provider: "character", status: "healthy", checkedAt: "" })
  });
  const analyzeImage = vi.fn(async () => ({ text: "SCREEN_FACT: permission denied." }));
  vi.spyOn(providers, "getVisionProvider").mockReturnValue({
    name: "vision",
    analyzeImage,
    healthCheck: async () => ({ provider: "vision", status: "healthy", checkedAt: "" })
  });
  const captureScreen = vi.fn(async () => new Uint8Array([1]));
  const memory = new MemoryService(new InMemoryMemoryRepository());
  const extract = vi.spyOn(memory, "extractCandidates");
  const episodes = new InMemoryRecentEpisodeStore();
  const upsert = vi.spyOn(episodes, "upsert");
  const conversation = new InMemoryConversationRepository();
  const runtime = new RuntimeOrchestrator({
    providers,
    captureScreen,
    character: createServerCharacterPort(),
    memory,
    recentEpisodeStore: episodes,
    eventBus: new InMemoryEventBus({ development: false }),
    promptBuilder: new PromptBuilder(),
    ...(durableConversation ? { conversation } : {})
  });
  expect(runtime.getVisualGroundingAvailability()).toBe(true);
  const reply = await runtime.handleUserMessage({
    sessionId: "s",
    content: "Read the current error dialog"
  });
  expect(reply?.payload.content).toBe("SCREEN_FACT: permission denied.");
  expect(generateReply).toHaveBeenCalledTimes(2);
  const current = generateReply.mock.calls[1]![0].messages[1]!.content;
  expect(current).toMatch(/^Read the current error dialog\n/);
  expect(current.split("Read the current error dialog")).toHaveLength(2);
  expect(current).toContain("[PERCEPTION:");
  expect(captureScreen).toHaveBeenCalledTimes(1);
  expect(analyzeImage).toHaveBeenCalledTimes(1);
  expect(extract).not.toHaveBeenCalled();
  await runtime.handleUserMessage({ sessionId: "s", content: "Hello" }, { writeMemory: false });
  await runtime.sealAndDrainMemoryWrites();
  expect(JSON.stringify(upsert.mock.calls)).not.toContain("SCREEN_FACT");
  if (durableConversation) {
    const messages = await conversation.listRecentMessages("s", { limit: 10 });
    expect(messages.find((message) => message.content.includes("SCREEN_FACT"))).toMatchObject({
      ingestionRequested: false,
      metadata: { memoryEphemeral: true }
    });
  }
}
