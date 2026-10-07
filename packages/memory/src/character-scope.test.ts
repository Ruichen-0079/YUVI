import { describe, expect, it, vi } from "vitest";
import { characterMemoryProvider, characterProfileSourceReader } from "./character-provider.js";
import { characterMemoryPersonaId } from "./character-scope.js";
import { buildMemoryScope } from "./scope.js";
import { MemoryService } from "./service.js";
import { InMemoryMemoryRepository } from "./repository.js";
import type { MemoryProvider } from "./provider.js";

const yuvi = {
  instanceId: "yuvi.production",
  personaId: characterMemoryPersonaId("yuvi.production")
};
const alice = {
  instanceId: "alice.production",
  personaId: characterMemoryPersonaId("alice.production")
};
const scopeA = buildMemoryScope("person:chen", yuvi.personaId);
const scopeB = buildMemoryScope("person:chen", alice.personaId);
function backend(): MemoryProvider {
  return {
    retrieveRelevant: vi.fn(async () => ({
      status: "ok",
      events: [],
      source: "test",
      limited: false
    })),
    getEvent: vi.fn(async () => null),
    writeEvent: vi.fn(async () => ({ status: "stored" }))
  } as unknown as MemoryProvider;
}
describe("Character perspective access", () => {
  it("rejects foreign reads, writes, profile sources and unscoped provider operations before delegate invocation", async () => {
    const delegate = backend();
    const provider = characterMemoryProvider(delegate, () => yuvi);
    await expect(provider.retrieveRelevant({ text: "hello", scope: scopeB })).rejects.toThrow(
      /another Character/
    );
    await expect(provider.retrieveRelevant({ text: "hello" })).rejects.toThrow(/explicit scope/);
    await expect(provider.getEvent({ id: "foreign", scope: scopeB })).rejects.toThrow(
      /another Character/
    );
    await expect(
      provider.writeEvent({ content: "foreign", scope: scopeB } as never)
    ).rejects.toThrow(/another Character/);
    expect(delegate.retrieveRelevant).not.toHaveBeenCalled();
    expect(delegate.getEvent).not.toHaveBeenCalled();
    expect(delegate.writeEvent).not.toHaveBeenCalled();
    const source = { listEligibleSources: vi.fn() };
    const reader = characterProfileSourceReader(source, () => yuvi);
    expect(() => reader.listEligibleSources({ subject: { scope: scopeB } } as never)).toThrow(
      /another Character/
    );
    expect(source.listEligibleSources).not.toHaveBeenCalled();
  });
  it("checks backend results too, so a shared service cannot inject a foreign event", async () => {
    const delegate = backend();
    delegate.retrieveRelevant = async () => ({
      status: "ok",
      source: "test",
      limited: false,
      events: [
        {
          id: "foreign",
          source: "test",
          sourceRecordId: "foreign",
          kind: "fact",
          content: "secret",
          scope: scopeB,
          metadata: {}
        }
      ]
    });
    await expect(
      characterMemoryProvider(delegate, () => yuvi).retrieveRelevant({
        text: "secret",
        scope: scopeA
      })
    ).rejects.toThrow(/outside the requested scope/);
  });
  it("keeps old primary aliases readable while denying every reserved instance namespace", async () => {
    const delegate = backend();
    const provider = characterMemoryProvider(delegate, () => ({
      instanceId: "primary",
      personaId: null
    }));
    await provider.retrieveRelevant({
      text: "old",
      scope: buildMemoryScope("person:chen", "old-persona")
    });
    await expect(provider.retrieveRelevant({ text: "new", scope: scopeA })).rejects.toThrow(
      /Primary legacy/
    );
    expect(delegate.retrieveRelevant).toHaveBeenCalledTimes(1);
  });
  it("binds repositories once and stamps writes with stable instance identity", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    service.bindCharacterOwner(yuvi);
    await expect(
      service.createMemory({
        type: "semantic",
        content: "owned",
        evidenceClassification: "NON_EVIDENCE",
        source: "test",
        tags: []
      })
    ).resolves.toMatchObject({ personaId: yuvi.personaId });
    await expect(
      service.createMemory({
        type: "semantic",
        content: "foreign",
        personaId: alice.personaId,
        evidenceClassification: "NON_EVIDENCE",
        source: "test",
        tags: []
      })
    ).rejects.toThrow(/another Character/);
    expect(() => service.bindCharacterOwner(alice)).toThrow();
    expect(() => new MemoryService(repository).bindCharacterOwner(alice)).toThrow();
  });
});
