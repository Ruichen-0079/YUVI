import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  InMemoryMemoryRepository,
  InMemoryConversationRepository,
  MemoryService
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import { createProviderRegistryFromEnv } from "@companion/providers";
import {
  RuntimeOrchestrator,
  type RuntimeCharacterTurnInput,
  defineCharacter,
  PRIMARY_CHARACTER,
  normalizeCharacterBinding
} from "./index.js";

const binding = (name: string) => ({
  instanceId: name.toLowerCase() + ".production",
  definition: defineCharacter({
    id: name.toLowerCase(),
    revision: "1",
    name,
    persona: name + " has a distinct private perspective."
  })
});
function composition(
  name: string,
  observed: RuntimeCharacterTurnInput[],
  beforeGenerate?: (input: RuntimeCharacterTurnInput) => Promise<void>
) {
  const characterBinding = binding(name);
  const providers = createProviderRegistryFromEnv({
    NODE_ENV: "test",
    PROVIDER_ALLOW_MOCKS: "true"
  });
  const memory = new MemoryService(new InMemoryMemoryRepository());
  const conversation = new InMemoryConversationRepository();
  const generate = async (input: RuntimeCharacterTurnInput) => {
    await beforeGenerate?.(input);
    observed.push(input);
    return {
      decision: {
        addressing: "DIRECTED_TO_YUVI" as const,
        reply: { disposition: "SILENCE" as const },
        proactive:
          name === "Yuvi"
            ? { action: "SUPPRESS" as const, scope: { kind: "UNTIL_EXPLICIT_RESUME" as const } }
            : { action: "KEEP" as const }
      },
      providerMetadata: { model: "test" }
    };
  };
  const options = {
    characterBinding,
    eventBus: new InMemoryEventBus({ development: false }),
    memory,
    conversation,
    providers,
    p8CorrectionStore: {
      loadCorrections: async () => ({
        status: "SUCCESS_WITH_NO_CORRECTIONS" as const,
        corrections: []
      }),
      loadCorrectionByReference: async () => ({ status: "SUCCESS_WITH_NO_CORRECTION" as const }),
      appendCorrection: async () => ({ status: "UNAVAILABLE" as const })
    },
    promptBuilder: new PromptBuilder(),
    character: { generate, generateAfterCognition: generate }
  };
  return { options, runtime: new RuntimeOrchestrator(options) };
}
describe("independent Runtime compositions", () => {
  it("assembles authored Identity/Persona and P8 owner from immutable bindings, not persona aliases", async () => {
    const observedA: RuntimeCharacterTurnInput[] = [],
      observedB: RuntimeCharacterTurnInput[] = [];
    const a = composition("Yuvi", observedA),
      b = composition("Alice", observedB);
    for (const c of [a, b])
      await c.runtime.handleUserMessage(
        { content: "hello", sessionId: "same", subjectUserId: "person:chen" },
        { readMemory: false, writeMemory: false }
      );
    const contextA = JSON.stringify(observedA[0]!.semanticSections),
      contextB = JSON.stringify(observedB[0]!.semanticSections);
    expect(contextA).toContain("Yuvi");
    expect(contextA).toContain("Yuvi has a distinct private perspective");
    expect(contextB).toContain("Alice");
    expect(contextB).toContain("Alice has a distinct private perspective");
    expect(contextB).not.toContain("Yuvi");
    expect(a.runtime.getProactiveState().suppression.kind).toBe("UNTIL_EXPLICIT_RESUME");
    expect(b.runtime.getProactiveState().suppression.kind).toBe("NONE");
    await expect(
      b.runtime.handleUserMessage({
        sessionId: "same",
        content: "attempt",
        personaId: "character-instance:yuvi.production"
      })
    ).rejects.toThrow(/another Character/);
    await a.runtime.sealAndDrainMemoryWrites();
    await b.runtime.handleUserMessage(
      { content: "still alive", sessionId: "same" },
      { readMemory: false, writeMemory: false }
    );
    expect(observedB).toHaveLength(2);
    expect(() => b.runtime.adoptProactiveConsentProjection(a.runtime)).toThrow(/another Character/);
  });
  it("rejects sharing mutable composition resources even with separate persona text", () => {
    const a = composition("Yuvi", []);
    for (const key of ["memory", "providers", "eventBus", "conversation"] as const) {
      const b = composition("Alice", []);
      expect(() => new RuntimeOrchestrator({ ...b.options, [key]: a.options[key] })).toThrow(
        /mutable coordination/
      );
    }
  });
  it("cancels one in-flight Character turn without aborting the other execution", async () => {
    const signals: AbortSignal[] = [];
    let releaseB: (() => void) | undefined;
    const a = composition("Yuvi", [], async (input) => {
      signals.push(input.signal!);
      await new Promise<void>((_resolve, reject) =>
        input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true })
      );
    });
    const b = composition("Alice", [], async (input) => {
      signals.push(input.signal!);
      await new Promise<void>((resolve) => {
        releaseB = resolve;
      });
    });
    const abortA = new AbortController();
    const consume = async (runtime: RuntimeOrchestrator, signal?: AbortSignal) => {
      const events: string[] = [];
      try {
        for await (const event of runtime.streamUserMessage(
          { sessionId: "same", content: "hello", subjectUserId: "person:chen" },
          { signal, readMemory: false, writeMemory: false }
        ))
          events.push(event.type);
      } catch {
        events.push("aborted");
      }
      return events;
    };
    const pendingA = consume(a.runtime, abortA.signal),
      pendingB = consume(b.runtime);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    abortA.abort(new Error("cancel Yuvi only"));
    await pendingA;
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    releaseB!();
    await pendingB;
    expect(b.runtime.getLatestPromptPreview()).not.toBeNull();
  });
  it("keeps omitted binding as the primary Yuvi and rejects inconsistent authored identity", () => {
    const a = composition("Yuvi", []);
    const { characterBinding: _binding, ...options } = a.options;
    // Separate resources: explicit Yuvi.production is not the legacy primary.
    expect(() => new RuntimeOrchestrator(options)).toThrow(/mutable coordination/);
    const legacy = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: new MemoryService(new InMemoryMemoryRepository()),
      providers: createProviderRegistryFromEnv({ NODE_ENV: "test", PROVIDER_ALLOW_MOCKS: "true" }),
      promptBuilder: new PromptBuilder()
    });
    expect(legacy.characterBinding).toEqual(normalizeCharacterBinding(PRIMARY_CHARACTER));
    expect(() =>
      normalizeCharacterBinding({
        instanceId: "invalid",
        definition: { ...PRIMARY_CHARACTER.definition, name: "Alice" }
      })
    ).toThrow(/consistent identity/);
  });
});
