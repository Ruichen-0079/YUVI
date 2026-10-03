import { describe, expect, it } from "vitest";
import { InMemoryEffectIntentStore } from "@companion/effects";
import {
  projectDreamEffectIntents,
  projectFinalizedEffectIntent
} from "./effect-intent-compatibility.js";
import { InMemoryFinalizedIngestionRepository } from "./finalized-ingestion-ledger.js";
import { FinalizedIngestionService } from "./finalized-test-fixture.js";
import { stampDreamWriteEvent } from "./dream-delivery.js";
import type { DreamJob } from "./dream-consolidation.js";

async function finalized() {
  const repository = new InMemoryFinalizedIngestionRepository();
  const input = {
    finalizedTurnId: "turn:compatibility",
    assistantMessageId: "assistant:compatibility",
    conversationId: "session:compatibility",
    traceId: "trace:compatibility",
    personaId: "persona:compatibility",
    subjectUserId: "scope:compatibility",
    finalizedAt: "2026-10-03T00:00:00.000Z",
    ingestionRequested: true,
    userMessage: "Please remember: I prefer tea.",
    assistantMessage: "Understood."
  };
  const service = new FinalizedIngestionService(repository);
  const first = await service.admit(input);
  const replay = await new FinalizedIngestionService(repository).admit(input);
  return { event: first.events[0]!, replay: replay.events[0]! };
}
function dream(event: Awaited<ReturnType<typeof finalized>>["event"]): DreamJob {
  return {
    jobId: "dream:compatibility",
    triggerKind: "explicit",
    status: "reconcile_required",
    memoryScope: event.eventPayload.scope,
    personaId: null,
    subjectUserId: null,
    sourceEpisodeIds: [],
    sourceDigest: "frozen-source-digest",
    payload: {},
    resultEventPayloads: [stampDreamWriteEvent("dream:compatibility", event.eventPayload)],
    resultSummary: null,
    attemptCount: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    completedAt: null
  };
}
describe("A9.1 read-only existing Memory effect identity", () => {
  it("maps finalized replay to one identity without creating any A9 pending work", async () => {
    const { event, replay } = await finalized();
    const before = structuredClone(event);
    const a9 = new InMemoryEffectIntentStore();
    const projection = projectFinalizedEffectIntent(event);
    expect(projectFinalizedEffectIntent(replay)).toEqual(projection);
    expect(projection.logicalKey).toBe(event.backendIdempotencyKey);
    expect(projection.payloadDigest).toBe(event.eventPayload.payloadDigest);
    expect(projection.work).toEqual({ owner: "FINALIZED_INGESTION", reference: event.eventId });
    expect(event).toEqual(before);
    expect(await a9.get(projection.intentId)).toBeNull();
    expect(await a9.listPending(100)).toEqual([]);
  });
  it("does not let lease, attempt/status bookkeeping change finalized identity", async () => {
    const { event } = await finalized();
    expect(
      projectFinalizedEffectIntent({
        ...event,
        attemptCount: 9,
        leaseOwner: "replacement",
        status: "reconcile_required"
      })
    ).toEqual(projectFinalizedEffectIntent(event));
  });
  it("exposes finalized payload/key mismatches instead of inventing an identity", async () => {
    const { event } = await finalized();
    expect(() =>
      projectFinalizedEffectIntent({ ...event, backendIdempotencyKey: "other" })
    ).toThrow(/IDENTITY_UNAVAILABLE/);
    expect(() =>
      projectFinalizedEffectIntent({
        ...event,
        eventPayload: { ...event.eventPayload, content: "changed" }
      })
    ).toThrow(/IDENTITY_UNAVAILABLE/);
  });
  it("maps frozen Dream children and reopen/reconciliation to the same identities without derivation or writes", async () => {
    const { event } = await finalized();
    const job = dream(event);
    const before = structuredClone(job);
    const projection = projectDreamEffectIntents(job);
    expect(
      projectDreamEffectIntents({
        ...structuredClone(job),
        status: "complete",
        attemptCount: 8,
        leaseOwner: "replacement"
      })
    ).toEqual(projection);
    expect(projection[0]?.work).toEqual({ owner: "DREAM_JOB", reference: job.jobId });
    expect(projection[0]?.intentId).not.toBe(projectFinalizedEffectIntent(event).intentId);
    expect(job).toEqual(before);
    expect(await new InMemoryEffectIntentStore().listPending(100)).toEqual([]);
  });
  it("empty/unfrozen historical Dream work creates no identity and invalid frozen work fails closed", async () => {
    const { event } = await finalized();
    const job = dream(event);
    expect(projectDreamEffectIntents({ ...job, resultEventPayloads: null })).toEqual([]);
    expect(() => projectDreamEffectIntents({ ...job, jobId: "other" })).toThrow(
      /IDENTITY_UNAVAILABLE/
    );
    expect(() => projectDreamEffectIntents({ ...job, memoryScope: "other" })).toThrow(
      /IDENTITY_UNAVAILABLE/
    );
    expect(() =>
      projectDreamEffectIntents({
        ...job,
        resultEventPayloads: [{ ...job.resultEventPayloads![0]!, content: "changed" }]
      })
    ).toThrow(/IDENTITY_UNAVAILABLE/);
  });
});
