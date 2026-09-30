import { createHash } from "node:crypto";
import {
  MEMORY_LINEAGE_VERSION,
  MemoryLineageV1Schema,
  type GroundedMemorySource
} from "./lineage.js";
import {
  canonicalLineageJson,
  encodeMemoryLineage,
  isReservedMemoryMetadataKey
} from "./lineage-encoding.js";
import type { MemoryWriteEventInput } from "./provider.js";

/** Grounding has already happened. No Journal reads occur during delivery/replay. */
export function freezeFinalizedMemoryEvent(
  source: GroundedMemorySource,
  event: MemoryWriteEventInput,
  policyVersion: string
): MemoryWriteEventInput {
  const {
    lineage: _lineage,
    claim: _claim,
    occurredAt: _occurredAt,
    observedAt: _observedAt,
    payloadDigest: _digest,
    idempotencyKey: _key,
    signal: _signal,
    participants: _participants,
    ...rest
  } = event;
  const metadata = Object.fromEntries(
    Object.entries(event.metadata ?? {}).filter(([key]) => !isReservedMemoryMetadataKey(key))
  );
  const semantic = {
    ...rest,
    metadata,
    assertion: {
      source: source.origin === "USER_ASSERTION" ? ("user" as const) : ("unknown" as const),
      verification: "unverified" as const
    },
    observedAt: source.recordedAt,
    ...(source.occurrenceTime.state === "INSTANT" ? { occurredAt: source.occurrenceTime.at } : {})
  };
  // Excludes lineage and all delivery identities: consumer key cannot be circular.
  const fingerprint = createHash("sha256")
    .update(
      canonicalLineageJson({
        kind: semantic.kind,
        content: semantic.content.normalize("NFC"),
        scope: semantic.scope
      })
    )
    .digest("hex");
  const consumerKey = `mlf1_${createHash("sha256")
    .update(canonicalLineageJson({ parent: source.parent, policyVersion, fingerprint }))
    .digest("base64url")}`;
  const lineage = MemoryLineageV1Schema.parse({
    version: MEMORY_LINEAGE_VERSION,
    state: "GROUNDED",
    parents: [{ ref: source.parent, selector: source.selector }],
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey,
    derivation: {
      kind: "FINALIZED_INGESTION",
      producer: "@companion/memory",
      producerVersion: "0.1.0",
      policyVersion
    },
    origin: source.origin,
    authority: source.authority,
    sourceTime: { recordedAt: source.recordedAt, occurrenceTime: source.occurrenceTime }
  });
  encodeMemoryLineage(lineage); // Bound before durable admission, never silently truncate.
  return { ...semantic, lineage };
}
