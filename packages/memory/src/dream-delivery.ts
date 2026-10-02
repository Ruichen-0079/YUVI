/**
 * Dream semantic delivery adapter.
 *
 * Reuses the same MemoryProvider reliability authority as finalized C1
 * delivery: `writeEventIdempotent` plus `reconcileEvent`. Dream does not call
 * `writeEvent`, does not invent a second retry machine, and does not retry a
 * write after an ambiguous external outcome.
 *
 * Idempotency keys follow the C1 pattern:
 *   yuvi:dream-job:<jobId>:event:<payloadDigest>
 */
import { sha256Hex } from "./memory-vnext-text.js";
import type {
  MemoryProvider,
  MemoryReconciliationResult,
  MemoryWriteEventInput,
  MemoryWriteEventOutcome
} from "./provider.js";

export const DREAM_DELIVERY_KEY_PREFIX = "yuvi:dream-job" as const;
export const DREAM_SEMANTIC_DELIVERY_AUTHORITY =
  "MemoryProvider.writeEventIdempotent + MemoryProvider.reconcileEvent" as const;

export function stampDreamWriteEvent(
  jobId: string,
  event: MemoryWriteEventInput
): MemoryWriteEventInput {
  const digest = sha256Hex(canonicalJson(withoutDeliveryKeys(event)));
  const idempotencyKey = `${DREAM_DELIVERY_KEY_PREFIX}:${jobId}:event:${digest}`;
  return {
    ...event,
    idempotencyKey,
    payloadDigest: digest
  };
}

export async function deliverDreamEventsIdempotent(
  provider: Pick<MemoryProvider, "writeEventIdempotent">,
  events: MemoryWriteEventInput[]
): Promise<MemoryWriteEventOutcome[]> {
  if (!provider.writeEventIdempotent) {
    return events.map(() => ({
      status: "rejected" as const,
      errorCode: "MEMORY_IDEMPOTENCY_UNSUPPORTED",
      failureClass: "definitive_rejection" as const
    }));
  }
  const outcomes: MemoryWriteEventOutcome[] = [];
  for (const event of events) {
    try {
      outcomes.push(await provider.writeEventIdempotent(event));
    } catch {
      outcomes.push({
        status: "rejected",
        errorCode: "MEMORY_WRITE_AMBIGUOUS",
        failureClass: "ambiguous"
      });
    }
  }
  return outcomes;
}

export async function reconcileDreamEvent(
  provider: Pick<MemoryProvider, "reconcileEvent">,
  event: MemoryWriteEventInput
): Promise<MemoryReconciliationResult> {
  const idempotencyKey = event.idempotencyKey?.trim();
  const payloadDigest = event.payloadDigest?.trim();
  if (!idempotencyKey || !payloadDigest) {
    return { status: "unknown", errorCode: "MEMORY_PAYLOAD_DIGEST_MISSING" };
  }
  if (!provider.reconcileEvent) {
    return { status: "unknown", errorCode: "MEMORY_RECONCILIATION_UNSUPPORTED" };
  }
  try {
    return await provider.reconcileEvent({ idempotencyKey, payloadDigest, scope: event.scope });
  } catch {
    return { status: "unknown", errorCode: "MEMORY_RECONCILIATION_UNAVAILABLE" };
  }
}

export function isAmbiguousWriteOutcome(outcome: MemoryWriteEventOutcome): boolean {
  return outcome.failureClass === "ambiguous" || outcome.errorCode === "MEMORY_WRITE_AMBIGUOUS";
}

export function isSuccessfulWriteOutcome(outcome: MemoryWriteEventOutcome): boolean {
  return outcome.status === "written" || outcome.status === "unchanged";
}

function withoutDeliveryKeys(event: MemoryWriteEventInput): Record<string, unknown> {
  const { signal: _signal, idempotencyKey: _key, payloadDigest: _digest, ...payload } = event;
  return payload;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )
    .join(",")}}`;
}
