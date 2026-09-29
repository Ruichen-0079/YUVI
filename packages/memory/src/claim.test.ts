import { describe, expect, it } from "vitest";
import {
  admitDurableMemoryClaim,
  currentEligibleMemoryEvents,
  deserializeClaimMetadata,
  MemoryIngestionPolicy,
  MEMORY_CLAIM_METADATA,
  planClaimAttributionCorrection,
  serializeClaimMetadata,
  type MemoryEvent
} from "./index.js";
import { InMemoryMemoryRepository } from "./repository.js";
import { GroundedMemoryTestService } from "./test-grounding.js";
import { RuleBasedMemoryExtractor } from "./extractor.js";

const PRIMARY = "person_ruichen";
const XIAOMING = "person_xiaoming";
const XIAOHONG = "person_xiaohong";
const YUVI = "entity_yuvi";
const SCOPE = "user:person_ruichen|character:alice";

describe("Atom 12 memory claim attribution", () => {
  it("records primary self-report as assertor=subject SELF_REPORT", () => {
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "SELF_REPORT",
      content: "最近每天两点才睡",
      rawText: "我最近每天两点才睡。",
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      subject: { entityId: PRIMARY, resolution: "resolved" }
    });
    expect(admitted).toMatchObject({
      decision: "admit",
      content: "最近每天两点才睡",
      assertion: { source: "user", verification: "unverified" },
      claim: {
        provenanceClass: "SELF_REPORT",
        assertor: { entityId: PRIMARY, resolution: "resolved" },
        subject: { entityId: PRIMARY, resolution: "resolved" },
        rawText: "我最近每天两点才睡。"
      }
    });
  });

  it("keeps third-party claims about the primary unverified hearsay", () => {
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "EXTERNAL_CLAIM",
      content: "最近每天两点才睡",
      rawText: "小明：Ruichen 最近每天两点才睡。",
      assertor: { entityId: XIAOMING, surfaceMention: "小明", resolution: "resolved" },
      subject: { entityId: PRIMARY, surfaceMention: "Ruichen", resolution: "resolved" },
      confidence: 0.99,
      verification: "verified"
    });
    expect(admitted.decision).toBe("admit");
    if (admitted.decision !== "admit") return;
    expect(admitted.claim.assertor.entityId).toBe(XIAOMING);
    expect(admitted.claim.subject.entityId).toBe(PRIMARY);
    expect(admitted.claim.provenanceClass).toBe("EXTERNAL_CLAIM");
    expect(admitted.assertion.verification).toBe("unverified");
    expect(admitted.claim.rawText).toBe("小明：Ruichen 最近每天两点才睡。");
    expect(admitted.content).toBe("最近每天两点才睡");
    expect(admitted.content).not.toMatch(/小明每天两点/);
  });

  it("preserves third-party claims about another third party", () => {
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "EXTERNAL_CLAIM",
      content: "下周要出差",
      assertor: { entityId: XIAOMING, resolution: "resolved" },
      subject: { entityId: XIAOHONG, resolution: "resolved" }
    });
    expect(admitted).toMatchObject({
      decision: "admit",
      claim: {
        provenanceClass: "EXTERNAL_CLAIM",
        assertor: { entityId: XIAOMING, resolution: "resolved" },
        subject: { entityId: XIAOHONG, resolution: "resolved" }
      },
      assertion: { source: "user", verification: "unverified" }
    });
  });

  it("marks assistant inference as non-authoritative assistant evidence", () => {
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "ASSISTANT_INFERENCE",
      content: "用户可能睡眠不足",
      assertor: { entityId: "assistant_yuvi", resolution: "resolved" },
      subject: { entityId: PRIMARY, resolution: "resolved" },
      verification: "verified",
      confidence: 0.95
    });
    expect(admitted).toMatchObject({
      decision: "admit",
      assertion: { source: "assistant", verification: "unverified" },
      claim: { provenanceClass: "ASSISTANT_INFERENCE" }
    });
  });

  it("rejects unresolved ambient speech from durable write", () => {
    expect(
      admitDurableMemoryClaim({
        provenanceClass: "UNKNOWN_AMBIENT",
        rawText: "背景里有人在说话",
        assertor: { entityId: PRIMARY, resolution: "resolved" },
        subject: { entityId: PRIMARY, resolution: "resolved" }
      })
    ).toEqual({ decision: "reject", reason: "unresolved-ambient" });
  });

  it("does not let participants decide assertor or subject", () => {
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "EXTERNAL_CLAIM",
      content: "最近每天两点才睡",
      participants: [XIAOMING, PRIMARY, XIAOHONG],
      assertor: { entityId: XIAOMING, resolution: "resolved" },
      subject: { entityId: PRIMARY, resolution: "resolved" }
    });
    expect(admitted.decision).toBe("admit");
    if (admitted.decision !== "admit") return;
    expect(admitted.claim.assertor.entityId).toBe(XIAOMING);
    expect(admitted.claim.subject.entityId).toBe(PRIMARY);
    expect(admitted.claim.assertor.entityId).not.toBe(XIAOHONG);
  });

  it("preserves the raw surface mention and does not rewrite it", () => {
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "EXTERNAL_CLAIM",
      content: "今天怎么了",
      rawText: "UV 今天怎么了",
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      subject: { entityId: YUVI, surfaceMention: "UV", resolution: "resolved" }
    });
    expect(admitted.decision).toBe("admit");
    if (admitted.decision !== "admit") return;
    expect(admitted.claim.rawText).toBe("UV 今天怎么了");
    expect(admitted.claim.subject).toEqual({
      entityId: YUVI,
      surfaceMention: "UV",
      resolution: "resolved"
    });
    expect(admitted.content).toBe("今天怎么了");
    expect(admitted.content).not.toContain("YUVI");
    expect(admitted.claim.rawText).not.toContain("YUVI");
  });

  it("can store a resolved subject beside the original surface mention", async () => {
    const result = await new MemoryIngestionPolicy().build({
      scope: SCOPE,
      userMessage: "UV 今天怎么了",
      assistantMessage: "好的。",
      subjectUserId: PRIMARY,
      claim: {
        provenanceClass: "EXTERNAL_CLAIM",
        content: "今天怎么了",
        rawText: "UV 今天怎么了",
        assertor: { entityId: PRIMARY, resolution: "resolved" },
        subject: { entityId: YUVI, surfaceMention: "UV", resolution: "resolved" },
        sourceObservation: {
          observationId: "obs-1",
          captureEpoch: "epoch-1",
          segmentId: "seg-1"
        }
      }
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.claim).toMatchObject({
      rawText: "UV 今天怎么了",
      subject: { entityId: YUVI, surfaceMention: "UV", resolution: "resolved" },
      sourceObservation: {
        observationId: "obs-1",
        captureEpoch: "epoch-1",
        segmentId: "seg-1"
      }
    });
    expect(result.events[0]?.content).not.toBe("YUVI 今天怎么了");
  });

  it("does not guess YUVI from an unresolved UV alias", async () => {
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "EXTERNAL_CLAIM",
      rawText: "UV 今天怎么了",
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      subject: { entityId: null, surfaceMention: "UV", resolution: "unresolved" }
    });
    expect(admitted).toEqual({ decision: "reject", reason: "unresolved-identity" });

    const ingested = await new MemoryIngestionPolicy().build({
      scope: SCOPE,
      userMessage: "UV 今天怎么了",
      assistantMessage: "好的。",
      subjectUserId: PRIMARY,
      claim: {
        provenanceClass: "EXTERNAL_CLAIM",
        rawText: "UV 今天怎么了",
        assertor: { entityId: PRIMARY, resolution: "resolved" },
        subject: { surfaceMention: "UV", resolution: "unresolved" },
        participants: [PRIMARY, YUVI]
      }
    });
    expect(ingested.events).toEqual([]);
    expect(ingested.skippedReason).toBe("unresolved-identity");
    expect(JSON.stringify(ingested)).not.toMatch(/entity_yuvi|YUVI/i);
  });

  it("does not treat speaker clusters or voice profiles as people", () => {
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "SELF_REPORT",
      content: "我在说话",
      speakerId: "cluster-7",
      voiceProfileId: "vp-1",
      assertor: { resolution: "unresolved" },
      subject: { resolution: "unresolved" }
    });
    expect(admitted).toEqual({ decision: "reject", reason: "unresolved-identity" });
  });

  it("supersedes wrong-speaker evidence without rewriting the original", () => {
    const original = event({
      id: "mem-wrong-speaker",
      content: "最近每天两点才睡",
      claim: {
        provenanceClass: "EXTERNAL_CLAIM",
        rawText: "最近每天两点才睡",
        assertor: { entityId: XIAOMING, resolution: "resolved" },
        subject: { entityId: PRIMARY, resolution: "resolved" }
      }
    });
    const plan = planClaimAttributionCorrection({
      original,
      corrected: {
        provenanceClass: "EXTERNAL_CLAIM",
        content: "最近每天两点才睡",
        rawText: "最近每天两点才睡",
        assertor: { entityId: XIAOHONG, resolution: "resolved" },
        subject: { entityId: PRIMARY, resolution: "resolved" }
      }
    });
    expect(plan.decision).toBe("admit");
    if (plan.decision !== "admit" || !("corrected" in plan)) return;
    expect(plan.originalRemainsImmutable).toBe(true);
    expect(plan.supersededEventId).toBe(original.id);
    expect(original.claim?.assertor.entityId).toBe(XIAOMING);
    expect(plan.corrected.claim?.assertor.entityId).toBe(XIAOHONG);
    expect(plan.corrected.kind).toBe("correction");
    expect(plan.corrected.metadata?.[MEMORY_CLAIM_METADATA.supersedes]).toEqual([original.id]);

    const correctedEvent = event({
      id: "mem-corrected-speaker",
      kind: "correction",
      content: plan.corrected.content,
      ...(plan.corrected.assertion ? { assertion: plan.corrected.assertion } : {}),
      ...(plan.corrected.claim ? { claim: plan.corrected.claim } : {}),
      metadata: plan.corrected.metadata ?? {}
    });
    const eligible = currentEligibleMemoryEvents([original, correctedEvent]);
    expect(eligible.map((item) => item.id)).toEqual(["mem-corrected-speaker"]);
    expect(original.claim?.assertor.entityId).toBe(XIAOMING);
  });

  it("lets MemoryService supersede wrong attribution while keeping the old row auditable", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new GroundedMemoryTestService(
      repository,
      undefined,
      undefined,
      new RuleBasedMemoryExtractor()
    );
    const original = await service.processCandidateForStorage(
      {
        type: "semantic",
        subtype: "fact",
        content: "最近每天两点才睡",
        importance: 0.8,
        tags: ["sleep"],
        reason: "third-party-claim",
        subjectUserId: PRIMARY,
        claim: {
          provenanceClass: "EXTERNAL_CLAIM",
          rawText: "小明：Ruichen 最近每天两点才睡。",
          assertor: { entityId: XIAOMING, resolution: "resolved" },
          subject: { entityId: PRIMARY, resolution: "resolved" }
        }
      },
      { source: "runtime", skipAdmissionPolicy: true }
    );
    expect(original.decision).toBe("stored");
    const originalId = original.memory?.id;
    expect(originalId).toBeTruthy();

    const corrected = await service.processCandidateForStorage(
      {
        type: "semantic",
        subtype: "fact",
        content: "最近每天两点才睡",
        importance: 0.8,
        tags: ["sleep"],
        reason: "attribution-correction",
        subjectUserId: PRIMARY,
        correctionRequested: true,
        possibleSupersedes: [originalId!],
        claim: {
          provenanceClass: "EXTERNAL_CLAIM",
          rawText: "小明：Ruichen 最近每天两点才睡。",
          assertor: { entityId: XIAOHONG, resolution: "resolved" },
          subject: { entityId: PRIMARY, resolution: "resolved" }
        }
      },
      { source: "runtime", skipAdmissionPolicy: true },
      {
        sourceJournalRef: {
          kind: "JOURNAL_EVENT",
          namespace: "test-only-memory-journal",
          eventId: "jev1_bbbbbbbbbbbbbbbb"
        },
        sourceText: "A second committed source for this attribution correction."
      }
    );
    expect(corrected.decision).toBe("stored");
    const stale = await repository.getMemoryById(originalId!);
    expect(stale).toMatchObject({
      status: "superseded",
      supersededBy: corrected.memory?.id,
      metadata: {
        yuviClaimAssertorEntityId: XIAOMING
      }
    });
    expect(corrected.memory).toMatchObject({
      status: "active",
      metadata: {
        yuviClaimAssertorEntityId: XIAOHONG,
        yuviClaimSubjectEntityId: PRIMARY,
        yuviClaimRawText: "小明：Ruichen 最近每天两点才睡。"
      }
    });
    expect(stale?.content).toBe("最近每天两点才睡");
  });

  it("round-trips claim provenance through flattened metadata", () => {
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "EXTERNAL_CLAIM",
      content: "今天怎么了",
      rawText: "UV 今天怎么了",
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      subject: { entityId: YUVI, surfaceMention: "UV", resolution: "resolved" },
      sourceObservation: { observationId: "obs-9", captureEpoch: "epoch-9", segmentId: "seg-9" }
    });
    expect(admitted.decision).toBe("admit");
    if (admitted.decision !== "admit") return;
    const metadata = serializeClaimMetadata(admitted.claim);
    expect(metadata).not.toHaveProperty("embedding");
    expect(deserializeClaimMetadata(metadata)).toEqual(admitted.claim);
  });

  it("rejects ambient attributed ingestion instead of writing an unqualified fact", async () => {
    const result = await new MemoryIngestionPolicy().build({
      scope: SCOPE,
      userMessage: "谁在说话",
      assistantMessage: "我在听。",
      subjectUserId: PRIMARY,
      claim: {
        provenanceClass: "UNKNOWN_AMBIENT",
        rawText: "谁在说话",
        assertor: { surfaceMention: "unknown", resolution: "unresolved" },
        subject: { surfaceMention: "unknown", resolution: "unresolved" }
      }
    });
    expect(result.events).toEqual([]);
    expect(result.skippedReason).toBe("unresolved-ambient");
  });
});

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "memory-1",
    kind: "fact",
    content: "claim",
    source: "atom-12-test",
    sourceRecordId: "record-1",
    scope: SCOPE,
    metadata: {},
    ...overrides
  };
}
