/** Read-only mapping from authoritative existing Memory work. Never creates A9 work. */
import { effectIntentId, type ExistingEffectIntent } from "@companion/effects";
import type { FinalizedIngestionEvent } from "./finalized-ingestion-ledger.js";
import type { DreamJob } from "./dream-consolidation.js";
import { canonicalLineageJson, lineageDigest } from "./lineage-encoding.js";
import { stampDreamWriteEvent } from "./dream-delivery.js";

export function projectFinalizedEffectIntent(event: FinalizedIngestionEvent): ExistingEffectIntent {
  const { idempotencyKey, payloadDigest, ...semantic } = event.eventPayload;
  if (
    !event.eventPayload.scope ||
    idempotencyKey !== event.backendIdempotencyKey ||
    !payloadDigest ||
    payloadDigest !== lineageDigest(canonicalLineageJson(semantic))
  )
    throw new Error("FINALIZED_EFFECT_IDENTITY_UNAVAILABLE");
  return {
    version: "effect-intent-compatibility.v1",
    intentId: effectIntentId("yuvi.finalized-memory.v1", event.backendIdempotencyKey),
    logicalKey: event.backendIdempotencyKey,
    contractRef: "yuvi.finalized-memory.v1",
    payloadDigest,
    scope: event.eventPayload.scope,
    work: { owner: "FINALIZED_INGESTION", reference: event.eventId }
  };
}
export function projectDreamEffectIntents(job: DreamJob): ExistingEffectIntent[] {
  return (job.resultEventPayloads ?? []).map((event) => {
    const stamped = stampDreamWriteEvent(job.jobId, event);
    if (
      !job.memoryScope ||
      event.scope !== job.memoryScope ||
      !event.idempotencyKey ||
      !event.payloadDigest ||
      stamped.idempotencyKey !== event.idempotencyKey ||
      stamped.payloadDigest !== event.payloadDigest
    )
      throw new Error("DREAM_EFFECT_IDENTITY_UNAVAILABLE");
    return {
      version: "effect-intent-compatibility.v1",
      intentId: effectIntentId("yuvi.dream-memory.v1", event.idempotencyKey),
      logicalKey: event.idempotencyKey,
      contractRef: "yuvi.dream-memory.v1",
      payloadDigest: event.payloadDigest,
      scope: job.memoryScope,
      work: { owner: "DREAM_JOB", reference: job.jobId }
    };
  });
}
