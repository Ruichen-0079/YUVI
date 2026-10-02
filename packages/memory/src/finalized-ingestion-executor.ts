import { MemoryLineageV1Schema } from "./lineage.js";
import type {
  FinalizedIngestionEvent,
  FinalizedIngestionRepository,
  FinalizedIngestionEventOutcome
} from "./finalized-ingestion-ledger.js";
import type { MemoryProvider } from "./provider.js";

/** Conservative default for actual durable backend dispatches, not claims or reconcile probes. */
export const DEFAULT_MEMORY_INGESTION_MAX_DELIVERY_ATTEMPTS = 8;

export const MEMORY_WRITE_RETRY_EXHAUSTED = "MEMORY_WRITE_RETRY_EXHAUSTED";

export type FinalizedIngestionDeliveryResult = {
  claimed: boolean;
  dispatched: boolean;
  event: FinalizedIngestionEvent | null;
  outcome: FinalizedIngestionEventOutcome | null;
};

export async function executeFinalizedIngestionEvent(input: {
  repository: Pick<
    FinalizedIngestionRepository,
    "claimEvent" | "markEventDispatchStarted" | "recordEventOutcome"
  >;
  provider: MemoryProvider;
  event: FinalizedIngestionEvent;
  leaseOwner: string;
  leaseSeconds: number;
  maxDeliveryAttempts?: number;
}): Promise<FinalizedIngestionDeliveryResult> {
  const maxDeliveryAttempts = Math.max(
    1,
    Math.trunc(input.maxDeliveryAttempts ?? DEFAULT_MEMORY_INGESTION_MAX_DELIVERY_ATTEMPTS)
  );
  const claimed = await input.repository.claimEvent({
    finalizedTurnId: input.event.finalizedTurnId,
    eventId: input.event.eventId,
    leaseOwner: input.leaseOwner,
    leaseSeconds: input.leaseSeconds,
    expectedVersion: input.event.version
  });
  if (!claimed) {
    return { claimed: false, dispatched: false, event: null, outcome: null };
  }

  const lineage = MemoryLineageV1Schema.safeParse(claimed.eventPayload.lineage);
  if (
    !lineage.success ||
    lineage.data.state !== "GROUNDED" ||
    lineage.data.derivation.kind !== "FINALIZED_INGESTION"
  ) {
    const outcome: FinalizedIngestionEventOutcome = {
      status: "rejected",
      errorCode: "MEMORY_FINALIZED_LINEAGE_MISSING",
      failureClass: "definitive_rejection"
    };
    const recorded = await input.repository.recordEventOutcome({
      finalizedTurnId: claimed.finalizedTurnId,
      eventId: claimed.eventId,
      leaseOwner: input.leaseOwner,
      expectedVersion: claimed.version,
      outcome
    });
    return { claimed: true, dispatched: false, event: recorded, outcome };
  }

  // Budget is previous durable dispatches only. Claim/preflight is not an attempt.
  // Ordinary C1 claims are pending/retryable_failed with no unresolved dispatch marker.
  if (claimed.attemptCount >= maxDeliveryAttempts) {
    const outcome: FinalizedIngestionEventOutcome = {
      status: "rejected",
      errorCode: MEMORY_WRITE_RETRY_EXHAUSTED,
      failureClass: "definitive_rejection"
    };
    const recorded = await input.repository.recordEventOutcome({
      finalizedTurnId: claimed.finalizedTurnId,
      eventId: claimed.eventId,
      leaseOwner: input.leaseOwner,
      expectedVersion: claimed.version,
      outcome
    });
    return { claimed: true, dispatched: false, event: recorded, outcome };
  }

  if (!input.provider.writeEventIdempotent) {
    const outcome: FinalizedIngestionEventOutcome = {
      status: "rejected",
      errorCode: "MEMORY_IDEMPOTENCY_UNSUPPORTED",
      failureClass: "definitive_rejection"
    };
    const recorded = await input.repository.recordEventOutcome({
      finalizedTurnId: claimed.finalizedTurnId,
      eventId: claimed.eventId,
      leaseOwner: input.leaseOwner,
      expectedVersion: claimed.version,
      outcome
    });
    return { claimed: true, dispatched: false, event: recorded, outcome };
  }

  const payloadDigest = claimed.eventPayload.payloadDigest?.trim();
  if (!payloadDigest) {
    const outcome: FinalizedIngestionEventOutcome = {
      status: "rejected",
      errorCode: "MEMORY_PAYLOAD_DIGEST_MISSING",
      failureClass: "definitive_rejection"
    };
    const recorded = await input.repository.recordEventOutcome({
      finalizedTurnId: claimed.finalizedTurnId,
      eventId: claimed.eventId,
      leaseOwner: input.leaseOwner,
      expectedVersion: claimed.version,
      outcome
    });
    return { claimed: true, dispatched: false, event: recorded, outcome };
  }

  await input.provider.prepareEvidence?.("FINALIZED_INGESTION", claimed.eventPayload);

  const dispatching = await input.repository.markEventDispatchStarted({
    finalizedTurnId: claimed.finalizedTurnId,
    eventId: claimed.eventId,
    leaseOwner: input.leaseOwner,
    expectedVersion: claimed.version
  });
  if (!dispatching) {
    return { claimed: true, dispatched: false, event: null, outcome: null };
  }

  let outcome: FinalizedIngestionEventOutcome;
  try {
    outcome = await input.provider.writeEventIdempotent({
      ...dispatching.eventPayload,
      idempotencyKey: dispatching.backendIdempotencyKey,
      payloadDigest
    });
  } catch (error) {
    outcome = {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  const recorded = await input.repository.recordEventOutcome({
    finalizedTurnId: dispatching.finalizedTurnId,
    eventId: dispatching.eventId,
    leaseOwner: input.leaseOwner,
    expectedVersion: dispatching.version,
    outcome
  });
  return { claimed: true, dispatched: true, event: recorded, outcome };
}
