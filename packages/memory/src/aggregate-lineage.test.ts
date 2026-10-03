import { describe, expect, it, vi } from "vitest";
import { JournalMemoryGroundingResolver } from "./lineage.js";
import { parent, receipt, readerFor, recordedAt } from "./journal-evidence.test-fixture.js";
import { InMemoryMemoryRepository } from "./repository.js";
import { MemoryService } from "./service.js";
import { RuleBasedMemoryExtractor, LlmMemoryExtractor } from "./extractor.js";
import {
  LegacyProfileMemorySourceReader,
  UnavailableProfileMemorySourceReader
} from "./profile-source-reader.js";
import { LocalProfileProvider } from "./profile-provider.js";
import { InMemoryProfileSnapshotStore } from "./profile-snapshot-store.js";
import { InMemoryProfileLifecycleStore } from "./profile-lifecycle-store.js";
import { ProfileLifecycleCoordinator, ScopePeopleModelReader } from "./profile-lifecycle.js";
import { buildMemoryScope } from "./scope.js";
import type { MemoryCandidate } from "./types.js";
import type { ProfileMemorySourceReader } from "./profile-types.js";

const subject = {
  kind: "MEMORY_SCOPE" as const,
  scope: buildMemoryScope("aggregate-user", "aggregate-persona")
};
const text = "Remember that I prefer tea.";
const candidate = (content = text): MemoryCandidate => ({
  type: "semantic",
  subtype: "preference",
  content,
  summary: content,
  tags: [],
  importance: 0.99,
  confidence: 1,
  reason: "explicit-remember",
  originRole: "user",
  subjectUserId: "aggregate-user",
  personaId: "aggregate-persona",
  explicitRememberRequested: true
});
function service(
  repository: InMemoryMemoryRepository,
  resolver = new JournalMemoryGroundingResolver(readerFor(receipt({ text }), text))
) {
  return new MemoryService(
    repository,
    undefined,
    undefined,
    new RuleBasedMemoryExtractor(),
    undefined,
    { kind: "legacy", groundingResolver: resolver }
  );
}
function projection(reader: ProfileMemorySourceReader) {
  let instant = new Date("2026-10-03T00:00:00.000Z");
  const now = () => new Date(instant);
  const snapshots = new InMemoryProfileSnapshotStore();
  const store = new InMemoryProfileLifecycleStore(now);
  const provider = new LocalProfileProvider({
    resolveSourceReader: () => reader,
    store: snapshots,
    now
  });
  const composition = { reader, provider, backend: "legacy" as const, compositionToken: {} };
  let coordinator = new ProfileLifecycleCoordinator(store, undefined, composition, now);
  return {
    provider,
    snapshots,
    store,
    get coordinator() {
      return coordinator;
    },
    async generate() {
      await coordinator.requestGeneration({ subject });
      instant = new Date(instant.getTime() + 1000);
      for (let i = 0; i < 3; i++) {
        instant = new Date(instant.getTime() + 1000);
        await (coordinator as unknown as { runTick(): Promise<void> }).runTick();
      }
      return coordinator.readScopeModel({ subject, readMemory: true });
    },
    async restart() {
      coordinator = new ProfileLifecycleCoordinator(store, undefined, composition, now);
      await (coordinator as unknown as { recheckStartup(): Promise<void> }).recheckStartup();
    },
    advance() {
      instant = new Date(instant.getTime() + 1000);
    }
  };
}
async function assertEmpty(repository: InMemoryMemoryRepository) {
  const reader = new LegacyProfileMemorySourceReader(repository);
  expect(
    (await reader.listEligibleSources({ subject, asOf: "2026-10-03T00:00:00.000Z" })).sources
  ).toEqual([]);
  const p = projection(reader);
  const result = await p.generate();
  expect(result.state).toBe("EMPTY");
  expect(result.model!.snapshot.entries).toEqual([]);
}

describe("A10.1f3 aggregate downstream boundary", () => {
  it.each(["high-confidence", "model-user-label"])(
    "generated %s never invokes the model or reaches Profile/People.Model",
    async () => {
      const repository = new InMemoryMemoryRepository();
      const invoke = vi.fn(async () => ({
        content: JSON.stringify([candidate("The user is a surgeon.")])
      }));
      const extractor = new LlmMemoryExtractor(
        { generate: invoke } as never,
        new RuleBasedMemoryExtractor(),
        { enabled: true, providerConfigured: true, providerName: "Cognition" }
      );
      const output = await extractor.extractCandidates({
        userMessage: "What is the weather?",
        assistantMessage: "You are a surgeon.",
        sourceTraceId: "model-user",
        timestamp: "2001-01-01T00:00:00.000Z"
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(output).toEqual([]);
      await assertEmpty(repository);
    }
  );

  it.each([
    "unrelated-text",
    "selected-text-mismatch",
    "selector-mismatch",
    "NOT_RETAINED",
    "payload-unavailable",
    "wrong-parent"
  ])("%s cannot reach downstream projections", async (mode) => {
    const repository = new InMemoryMemoryRepository();
    const envelope = receipt({
      text,
      ...(mode === "NOT_RETAINED" ? { retention: "NOT_RETAINED" as const } : {})
    });
    if (mode === "selector-mismatch") {
      const selector =
        envelope.command.kind === "RECEIPT"
          ? envelope.command.data.evidenceSelectors[0]
          : undefined;
      if (selector?.modality === "TEXT") selector.range.end += 1;
    }
    const resolver = new JournalMemoryGroundingResolver(
      readerFor(
        envelope,
        mode === "payload-unavailable"
          ? null
          : mode === "selected-text-mismatch"
            ? "Changed retained text."
            : text
      )
    );
    const stored = await service(repository, resolver).processCandidateForStorage(
      candidate(),
      {},
      {
        sourceJournalRef:
          mode === "wrong-parent" ? { ...parent, eventId: "jev1_bbbbbbbbbbbbbbbb" } : parent,
        sourceText: mode === "unrelated-text" ? "Unrelated retained Journal text." : text
      }
    );
    expect(stored.decision).toBe("rejected");
    await assertEmpty(repository);
  });

  it("assistant-only paraphrase is rejected even with a real resolved user source", async () => {
    const repository = new InMemoryMemoryRepository();
    const result = await service(repository).processCandidateForStorage(
      {
        ...candidate("The user is a surgeon."),
        originRole: "assistant",
        reason: "assistant-inference",
        explicitRememberRequested: false,
        metadata: { originRole: "assistant", extractionAssistantMessage: "You are a surgeon." }
      },
      {},
      { sourceJournalRef: parent, sourceText: text }
    );
    expect(result.decision).toBe("rejected");
    await assertEmpty(repository);
  });

  it("source trace/time, confidence and execution labels cannot replace committed ancestry or identity", async () => {
    const repository = new InMemoryMemoryRepository();
    const s = service(repository);
    const first = await s.processCandidateForStorage(
      {
        ...candidate(),
        sourceTraceId: "fake-journal-event",
        observedAt: "2001-01-01T00:00:00.000Z",
        metadata: {
          provider: "hosted",
          model: "Cognition",
          route: "Chat",
          confidence: 1,
          binding: "fake-person"
        }
      },
      {},
      { sourceJournalRef: parent, sourceText: text }
    );
    expect(first.memory!.lineage).toMatchObject({
      parents: [{ ref: parent }],
      sourceTime: { recordedAt },
      authority: {
        principal: { state: "UNRESOLVED" },
        binding: { state: "UNRESOLVED" },
        audience: { kind: "UNKNOWN" }
      }
    });
    const p = projection(new LegacyProfileMemorySourceReader(repository));
    const before = await p.generate();
    expect(before.state).toBe("AVAILABLE");
    expect(before.model!.personBinding.state).toBe("UNBOUND_SCOPE");
    expect(
      before.model!.snapshot.entries.every((entry) => entry.epistemicStatus === "UNVERIFIED")
    ).toBe(true);
    const replay = await s.processCandidateForStorage(
      {
        ...candidate(),
        confidence: 0.1,
        sourceTraceId: "another-runtime",
        metadata: { provider: "Local", model: "different-embedding", route: "local" }
      },
      {},
      { sourceJournalRef: parent, sourceText: text }
    );
    expect(replay.memory!.id).toBe(first.memory!.id);
    expect(
      (await p.coordinator.readScopeModel({ subject, readMemory: true })).model!.profileRevision
    ).toBe(before.model!.profileRevision);
    expect(new ScopePeopleModelReader(p.coordinator).readPersonModel()).toMatchObject({
      model: null,
      code: "BINDING_AUTHORITY_UNAVAILABLE"
    });
  });

  it("a grounded hearsay report reaches the model only as EXTERNAL_CLAIM / UNVERIFIED", async () => {
    const repository = new InMemoryMemoryRepository();
    const report = "My friend says the restaurant is closed.";
    const resolver = new JournalMemoryGroundingResolver(readerFor(receipt({ text: report }), report));
    const result = await service(repository, resolver).processCandidateForStorage({
      ...candidate("The restaurant is closed."), subtype: "fact", explicitRememberRequested: false,
      claim: { provenanceClass: "EXTERNAL_CLAIM", rawText: report, assertor: { entityId: "friend", resolution: "resolved" }, subject: { entityId: "restaurant", resolution: "resolved" }, verification: "verified" }
    }, { skipAdmissionPolicy: true }, { sourceJournalRef: parent, sourceText: report });
    expect(result.decision).toBe("stored");
    const outcome = await projection(new LegacyProfileMemorySourceReader(repository)).generate();
    expect(outcome.state).toBe("AVAILABLE");
    expect(outcome.model!.snapshot.entries[0]).toMatchObject({ claimClass: "EXTERNAL_CLAIM", epistemicStatus: "UNVERIFIED" });
    expect(outcome.model!.personBinding.state).toBe("UNBOUND_SCOPE");
  });

  it("old null-lineage and ordinary Profile prose remain stored but never become evidence", async () => {
    const repository = new InMemoryMemoryRepository();
    await repository.createMemory({
      type: "semantic",
      content: text,
      source: "historical",
      subjectUserId: "aggregate-user",
      personaId: "aggregate-persona"
    });
    await service(repository).createMemory({
      type: "semantic",
      content: "Profile says the user is a surgeon.",
      source: "profile-copy",
      evidenceClassification: "NON_EVIDENCE",
      subjectUserId: "aggregate-user",
      personaId: "aggregate-persona"
    });
    await assertEmpty(repository);
  });

  it("malformed unadmitted native lineage invalidates the bounded read rather than becoming empty evidence", async () => {
    const repository = new InMemoryMemoryRepository();
    const row = await repository.createMemory({
      type: "semantic",
      content: text,
      source: "historical",
      subjectUserId: "aggregate-user",
      personaId: "aggregate-persona"
    });
    // Simulates persisted corruption, not a production admission call.
    const raw = (
      repository as unknown as { memories: Array<{ id: string; lineage: unknown }> }
    ).memories.find((entry) => entry.id === row.id)!;
    raw.lineage = { state: "GROUNDED" };
    const reader = new LegacyProfileMemorySourceReader(repository);
    expect((await reader.listEligibleSources({ subject, asOf: recordedAt })).state).toBe("ERROR");
    const p = projection(reader);
    expect((await p.generate()).model).toBeNull();
    expect(await p.snapshots.getCurrent({ subject })).toBeNull();
  });

  it("A → correction B retires A, withholds PA despite notification loss, and verifies PB after restart", async () => {
    const repository = new InMemoryMemoryRepository();
    const sourceA = "Remember that I drank tea.";
    const sourceB = "Actually, I drank coffee, not tea.";
    const a = await service(
      repository,
      new JournalMemoryGroundingResolver(readerFor(receipt({ text: sourceA }), sourceA))
    ).processCandidateForStorage(
      {
        ...candidate("I drank tea."),
        type: "semantic",
        subtype: "preference",
        validUntil: "2027-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z"
      },
      {},
      { sourceJournalRef: parent, sourceText: sourceA }
    );
    expect(a.decision, JSON.stringify(a)).toBe("stored");
    const p = projection(new LegacyProfileMemorySourceReader(repository));
    const pa = await p.generate();
    expect(
      pa.state,
      JSON.stringify(
        await new LegacyProfileMemorySourceReader(repository).listEligibleSources({
          subject,
          asOf: "2026-10-03T00:00:00.000Z"
        })
      )
    ).toBe("AVAILABLE");
    // No repository notifier is attached. Both source writes still commit.
    const envelope = receipt({ text: sourceB });
    const ref = { ...parent, eventId: "jev1_cccccccccccccccc" };
    envelope.eventId = ref.eventId;
    const baseReader = readerFor(envelope, sourceB);
    const reader = {
      ...baseReader,
      get: async (value: typeof ref) => (value.eventId === ref.eventId ? envelope : null)
    };
    const b = await service(
      repository,
      new JournalMemoryGroundingResolver(reader)
    ).processCandidateForStorage(
      {
        ...candidate("I drank coffee."),
        type: "semantic",
        subtype: "preference",
        validUntil: "2027-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
        correctionRequested: true,
        possibleSupersedes: [a.memory!.id],
        explicitRememberRequested: false,
        reason: "user-correction"
      },
      { skipAdmissionPolicy: true },
      { sourceJournalRef: ref, sourceText: sourceB }
    );
    expect(b.memory!.lineage).toMatchObject({
      derivation: { kind: "CORRECTION" },
      parents: [{ ref }]
    });
    expect((await repository.getMemoryById(a.memory!.id))!.status).toBe("superseded");
    expect((await p.coordinator.readScopeModel({ subject, readMemory: true })).model).toBeNull();
    await p.restart();
    expect((await p.coordinator.readScopeModel({ subject, readMemory: true })).model).toBeNull();
    const pb = await p.generate();
    expect(pb.state).toBe("AVAILABLE");
    expect(pb.model!.profileRevision).not.toBe(pa.model!.profileRevision);
    expect(pb.model!.snapshot.entries.map((entry) => entry.content)).toEqual(["I drank coffee."]);
  });

  it("disabled and unavailable bounded authority withhold history until live recovery", async () => {
    const repository = new InMemoryMemoryRepository();
    await service(repository).processCandidateForStorage(
      candidate(),
      {},
      { sourceJournalRef: parent, sourceText: text }
    );
    const good = new LegacyProfileMemorySourceReader(repository);
    let active: ProfileMemorySourceReader = good;
    const proxy: ProfileMemorySourceReader = {
      listEligibleSources: (input) => active.listEligibleSources(input)
    };
    const p = projection(proxy);
    expect((await p.generate()).state).toBe("AVAILABLE");
    active = new UnavailableProfileMemorySourceReader();
    expect((await p.coordinator.readScopeModel({ subject, readMemory: true })).model).toBeNull();
    expect(await p.provider.getProfile({ subject })).toMatchObject({ freshness: "UNCHECKED" });
    expect((await p.provider.generate({ subject })).state).toBe("UNAVAILABLE");
    active = good;
    expect((await p.generate()).state).toBe("AVAILABLE");
    expect((await p.coordinator.readScopeModel({ subject, readMemory: false })).model).toBeNull();
  });
});
