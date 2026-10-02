import { describe, expect, it, vi } from "vitest";
import { InMemoryMemoryRepository, MemoryLineageConflictError } from "./repository.js";
import { MemoryService } from "./service.js";
import { RuleBasedMemoryExtractor } from "./extractor.js";
import {
  getMemoryLineageState,
  type GroundedMemorySource,
  type MemoryGroundingContext
} from "./lineage.js";
import type { MemoryCandidate } from "./types.js";

const sourceRecordedAt = "2026-09-29T23:30:00.000Z";
const parent = {
  kind: "JOURNAL_EVENT" as const,
  namespace: "grounded-memory-test",
  eventId: "jev1_aaaaaaaaaaaaaaaa"
};

function createService(repository = new InMemoryMemoryRepository()): MemoryService {
  return new MemoryService(
    repository,
    undefined,
    undefined,
    new RuleBasedMemoryExtractor(),
    undefined,
    {
      kind: "legacy",
      groundingResolver: {
        async resolve(context: MemoryGroundingContext): Promise<GroundedMemorySource> {
          const sourceParent = context.sourceJournalRef;
          const count = Array.from(context.sourceText).length;
          const payload = {
            namespace: sourceParent.namespace,
            payloadId: "payload-" + sourceParent.eventId,
            version: "v1"
          };
          return {
            parent: sourceParent,
            selector: {
              version: "source-selector.v1",
              modality: "TEXT",
              payload,
              range: { unit: "UNICODE_CODE_POINT", start: 0, end: count }
            },
            payload: {
              ref: payload,
              modality: "TEXT",
              retention: "RETAINED",
              origin: "USER_INPUT",
              selectable: true,
              characterCount: count
            },
            selectedText: context.sourceText,
            origin: "USER_ASSERTION",
            recordedAt: sourceRecordedAt,
            occurrenceTime: { state: "UNKNOWN" },
            authority: {
              principal: {
                state: "UNRESOLVED",
                reason: "test receipt has no authenticated principal"
              },
              binding: { state: "UNRESOLVED", reason: "test receipt has no Person binding" },
              audience: { kind: "UNKNOWN", reason: "test audience is unavailable" }
            }
          };
        }
      }
    }
  );
}

const context = (sourceText: string, eventId = parent.eventId): MemoryGroundingContext => ({
  sourceJournalRef: { ...parent, eventId },
  sourceText
});

function candidate(content: string): MemoryCandidate {
  return {
    type: "semantic",
    subtype: "preference",
    content,
    summary: content,
    importance: 0.92,
    confidence: 0.99,
    reason: "stable-preference",
    tags: [],
    originRole: "user",
    sourceTraceId: "runtime-trace-not-journal-parent",
    subjectUserId: "caller-asserted-person",
    personaId: "caller-asserted-persona",
    voiceProfileId: "caller-asserted-profile",
    observedAt: "2001-01-01T00:00:00.000Z"
  };
}

describe("A10.1c grounded legacy Memory admission", () => {

  it.each(["subjectUserId", "personaId"] as const)("cannot retire another legacy %s partition through automatic or suggested correction", async (field) => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const original = await service.processCandidateForStorage({ ...candidate("I ate breakfast yesterday."), [field]: "foreign-partition", explicitRememberRequested: true }, { skipAdmissionPolicy: true }, context("Remember that I ate breakfast yesterday."));
    const local = await service.processCandidateForStorage({ ...candidate("I ate breakfast yesterday."), explicitRememberRequested: true }, { skipAdmissionPolicy: true }, context("Remember that I ate breakfast yesterday.", "jev1_bbbbbbbbbbbbbbbb"));
    const corrected = await service.processCandidateForStorage({ ...candidate("I ate breakfast today."), correctionRequested: true, possibleSupersedes: [original.memory!.id, local.memory!.id], reason: "user-correction" }, { skipAdmissionPolicy: true }, context("Actually, I ate breakfast today, not yesterday.", "jev1_cccccccccccccccc"));
    expect(corrected.decision).toBe("stored");
    expect(await repository.getMemoryById(original.memory!.id)).toMatchObject({ status: "active", supersededBy: null });
    expect(await repository.getMemoryById(local.memory!.id)).toMatchObject({ status: "superseded", supersededBy: corrected.memory!.id });
  });

  it("rejects evidence-backed writes when committed Journal ancestry is absent", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, new RuleBasedMemoryExtractor());
    const result = await service.processCandidateForStorage(candidate("User prefers astronomy."), {
      source: "runtime"
    });

    expect(result).toMatchObject({
      decision: "rejected",
      rejectedReason: "missing-committed-source"
    });
    expect(await repository.listRecentMemories()).toHaveLength(0);
  });

  it("stores explicit remember with exact parent, selector and unresolved authority", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const sourceText = "Remember that I prefer concise technical answers.";
    const extracted = await service.extractCandidates({
      userMessage: sourceText,
      sourceTraceId: "runtime-trace"
    });
    expect(extracted).toHaveLength(1);

    const stored = await service.processCandidateForStorage(
      { ...extracted[0]!, ...candidate(extracted[0]!.content) },
      { source: "runtime" },
      context(sourceText)
    );
    expect(stored.decision).toBe("stored");
    expect(stored.memory).toMatchObject({
      content: extracted[0]!.content,
      observedAt: new Date(sourceRecordedAt),
      subjectUserId: "caller-asserted-person",
      personaId: "caller-asserted-persona",
      voiceProfileId: "caller-asserted-profile",
      lineage: {
        version: "memory-lineage.v1",
        state: "GROUNDED",
        parents: [{ ref: parent, selector: { modality: "TEXT" } }],
        origin: "USER_ASSERTION",
        authority: {
          principal: { state: "UNRESOLVED" },
          binding: { state: "UNRESOLVED" },
          audience: { kind: "UNKNOWN" }
        },
        sourceTime: {
          recordedAt: sourceRecordedAt,
          occurrenceTime: { state: "UNKNOWN" }
        }
      }
    });
    expect(stored.memory?.lineageConsumerKey).toBe(
      (stored.memory?.lineage as { consumerKey: string }).consumerKey
    );
    expect(getMemoryLineageState(stored.memory?.lineage)).toBe("GROUNDED");
    await expect(
      service.updateMemory(stored.memory!.id, { content: "Edited without a new receipt." })
    ).rejects.toThrow(/lineage is immutable/);
  });

  it("uses a stable consumer key for replay and a distinct key for another legitimate candidate", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const original = candidate("User prefers concise answers.");
    const first = await service.processCandidateForStorage(original, {}, context("I prefer concise answers."));
    const replay = await service.processCandidateForStorage(original, {}, context("I prefer concise answers."));
    const another = await service.processCandidateForStorage(
      candidate("User prefers detailed code examples."),
      {},
      context("I also prefer detailed code examples.")
    );

    expect(first.decision).toBe("stored");
    expect(replay.memory?.id).toBe(first.memory?.id);
    expect(replay.storageReason).toBe("grounded-idempotent-replay");
    expect(another.decision).toBe("stored");
    expect(another.memory?.lineageConsumerKey).not.toBe(first.memory?.lineageConsumerKey);
    expect(await repository.getMemoryById(first.memory!.id)).not.toBeNull();
    expect(await repository.getMemoryById(another.memory!.id)).not.toBeNull();
  });

  it("atomically coalesces concurrent in-memory grounded writes", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const proposed = candidate("User prefers concise answers.");
    const [first, concurrent] = await Promise.all([
      service.processCandidateForStorage(proposed, {}, context("I prefer concise answers.")),
      service.processCandidateForStorage(proposed, {}, context("I prefer concise answers."))
    ]);

    expect(first.decision).toBe("stored");
    expect(concurrent.decision).toBe("stored");
    expect(concurrent.memory?.id).toBe(first.memory?.id);
    expect(concurrent.memory?.lineage?.state).toBe("GROUNDED");
    expect(
      await repository.searchMemoriesByTextFallback({
        text: "concise answers",
        includeHistory: true,
        limit: 20
      })
    ).toHaveLength(1);
  });

  it("fails same-key conflicting payloads closed in the repository", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const result = await service.processCandidateForStorage(
      candidate("User prefers concise answers."),
      {},
      context("I prefer concise answers.")
    );
    expect(result.memory?.lineage?.state).toBe("GROUNDED");
    if (!result.memory?.lineage || result.memory.lineage.state !== "GROUNDED") {
      throw new Error("expected a grounded Memory row");
    }
    await expect(
      repository.createGroundedMemory!({
        lineage: result.memory.lineage,
        payloadDigest: "f".repeat(64),
        memory: {
          type: "semantic",
          subtype: "preference",
          content: "conflicting content",
          source: "runtime"
        }
      })
    ).rejects.toBeInstanceOf(MemoryLineageConflictError);
  });

  it("fails a replay whose stable consumer key has a changed logical payload", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const original = candidate("User prefers concise answers.");
    const stored = await service.processCandidateForStorage(
      original,
      {},
      context("I prefer concise answers.")
    );
    expect(stored.decision).toBe("stored");
    await expect(
      service.processCandidateForStorage(
        { ...original, importance: 0.99 },
        {},
        context("I prefer concise answers.")
      )
    ).rejects.toBeInstanceOf(MemoryLineageConflictError);
  });

  it("grounds a correction from its new receipt without rewriting prior lineage", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const original = await service.processCandidateForStorage(
      {
        ...candidate("I ate breakfast yesterday."),
        explicitRememberRequested: true,
        reason: "explicit-remember"
      },
      { source: "runtime", skipAdmissionPolicy: true },
      context("Remember that I ate breakfast yesterday.")
    );
    expect(original.decision).toBe("stored");
    const originalLineage = structuredClone(original.memory?.lineage);

    const correctionText = "Actually, I ate breakfast today, not yesterday.";
    const corrected = await service.processCandidateForStorage(
      {
        ...candidate("I ate breakfast today."),
        correctionRequested: true,
        possibleSupersedes: [original.memory!.id],
        reason: "user-correction"
      },
      { source: "runtime", skipAdmissionPolicy: true },
      context(correctionText, "jev1_bbbbbbbbbbbbbbbb")
    );

    expect(corrected.decision).toBe("stored");
    expect(corrected.memory?.lineage).toMatchObject({
      state: "GROUNDED",
      parents: [{ ref: { ...parent, eventId: "jev1_bbbbbbbbbbbbbbbb" } }],
      derivation: { kind: "CORRECTION" }
    });
    expect(await repository.getMemoryById(original.memory!.id)).toMatchObject({
      lineage: originalLineage,
      status: "superseded"
    });
  });

  it("rejects assistant-only paraphrase despite an unrelated user receipt", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const result = await service.processCandidateForStorage(
      {
        ...candidate("The user strongly prefers astronomy."),
        originRole: "assistant",
        metadata: {
          originRole: "assistant",
          extractionAssistantMessage: "You strongly prefer astronomy."
        },
        reason: "assistant-inference"
      },
      { source: "runtime" },
      context("What do you think of astronomy?")
    );

    expect(result).toMatchObject({
      decision: "rejected",
      rejectedReason: "assistant-only-restatement"
    });
    expect(
      await repository.searchMemoriesByTextFallback({ text: "astronomy", includeHistory: true })
    ).toEqual([]);
  });

  it("keeps historical rows explicitly incomplete and direct authored writes non-evidence", async () => {
    const repository = new InMemoryMemoryRepository();
    const historical = await repository.createMemory({
      type: "semantic",
      content: "Old compatibility row.",
      source: "legacy"
    });
    expect(historical.lineage).toBeNull();
    expect(getMemoryLineageState(historical.lineage)).toBe("LEGACY_INCOMPLETE");

    const service = createService(repository);
    await expect(
      service.createMemory({
        type: "semantic",
        content: "Unclassified direct Memory write.",
        source: "runtime"
      })
    ).rejects.toThrow(/NON_EVIDENCE/);
    await expect(
      service.createMemory({
        type: "working",
        content: "Synthetic internal item.",
        source: "runtime",
        evidenceClassification: "NON_EVIDENCE"
      })
    ).resolves.toMatchObject({ evidenceClassification: "NON_EVIDENCE", lineage: null });
  });

  it("does not promote hearsay into verified world truth", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const sourceText = "My friend says the restaurant is closed.";
    const extracted = await service.extractCandidates({ userMessage: sourceText });
    const store = vi.spyOn(repository, "createGroundedMemory");
    const result = extracted[0]
      ? await service.processCandidateForStorage(extracted[0], {}, context(sourceText))
      : null;

    expect(result?.decision).not.toBe("stored");
    expect(store).not.toHaveBeenCalled();
    expect(await repository.listRecentMemories()).toHaveLength(0);
  });

  it("keeps an explicitly represented third-party report unverified", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = createService(repository);
    const sourceText = "My friend says the restaurant is closed.";
    const result = await service.processCandidateForStorage(
      {
        type: "semantic",
        subtype: "fact",
        content: "The restaurant is closed.",
        summary: "A friend reported that the restaurant is closed.",
        importance: 0.8,
        tags: [],
        reason: "third-party-claim",
        claim: {
          provenanceClass: "EXTERNAL_CLAIM",
          rawText: sourceText,
          assertor: { entityId: "friend", resolution: "resolved" },
          subject: { entityId: "restaurant", resolution: "resolved" },
          verification: "verified"
        }
      },
      { source: "runtime", skipAdmissionPolicy: true },
      context(sourceText)
    );

    expect(result.decision).toBe("stored");
    expect(result.memory?.lineage).toMatchObject({
      state: "GROUNDED",
      origin: "USER_ASSERTION"
    });
    expect(result.memory?.metadata).toMatchObject({
      yuviClaimProvenanceClass: "EXTERNAL_CLAIM",
      yuviClaimAssertorEntityId: "friend",
      yuviClaimSubjectEntityId: "restaurant"
    });
    expect(result.memory?.metadata).not.toHaveProperty("yuviClaimVerification", "verified");
  });
});
