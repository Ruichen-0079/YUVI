import { InMemoryEvidenceAdmissionStore, prepareEvidenceAdmission, memoryEffectDigest, type EvidenceAdmissionStore, type EvidenceProducer } from "../evidence-admission.js";
import {
  decodeMemoryLineage,
  encodeMemoryLineage,
  isReservedMemoryMetadataKey,
  LINEAGE_METADATA_KEYS,
  canonicalLineageJson,
  MemoryLineageEncodingError
} from "../lineage-encoding.js";
import {
  MemoryBackendError,
  type MemoryBackend,
  type MemoryReconciliationResult,
  type MemoryRecord,
  type MemoryRecordMetadata
} from "../backend.js";
import { deserializeClaimMetadata, serializeClaimMetadata } from "../claim.js";
import { buildMemoryScope } from "../scope.js";
import type {
  MemoryEvent,
  MemoryEventAssertion,
  MemoryEventId,
  MemoryEventKind,
  MemoryEventSource,
  MemoryGetEventInput,
  MemoryProvider,
  MemoryRetrievalInput,
  MemoryRetrievalOutcome,
  MemoryWriteFailureClass,
  MemoryWriteEventInput,
  MemoryWriteEventOutcome
} from "../provider.js";

export const MEM0_MEMORY_SOURCE: MemoryEventSource = "mem0";
export const MEM0_EVENT_ID_PREFIX = "mem0:";

const LEGAL_EVENT_KINDS: ReadonlySet<string> = new Set([
  "episodic",
  "fact",
  "user_claim",
  "interaction",
  "correction",
  "commitment_evidence"
]);
const LEGAL_ASSERTION_SOURCES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "mixed",
  "system",
  "unknown"
]);
const LEGAL_VERIFICATIONS: ReadonlySet<string> = new Set(["unverified", "verified", "unknown"]);
const SENSITIVE_METADATA_KEY =
  /key|secret|password|authorization|token|connection|embedding|rawEmbedding|waveform|biometric|speakerEmbedding/i;
const MAX_METADATA_KEY_LENGTH = 128;
const MAX_METADATA_STRING_LENGTH = 512;
const MAX_METADATA_ARRAY_LENGTH = 32;

export class Mem0MemoryProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "Mem0MemoryProviderError";
    this.code = code;
  }
}

/** Mem0 UUIDs are stable storage IDs, not rank- or scope-derived identities. */
export function canonicalMem0EventId(sourceRecordId: string): MemoryEventId {
  return `${MEM0_EVENT_ID_PREFIX}${sourceRecordId}`;
}

/**
 * Convert one backend record to the vendor-neutral evidence contract.
 * This is shared by retrieval, getEvent, and writeEvent so their identity and
 * provenance semantics cannot drift.
 */
export function mapMem0RecordToMemoryEvent(
  record: MemoryRecord,
  expectedScope: string
): MemoryEvent {
  const scope = normalizeRequiredScope(expectedScope);
  if (record.scope !== scope) {
    throw new Mem0MemoryProviderError(
      "MEMORY_SCOPE_MISMATCH",
      "Mem0 returned a record outside the requested memory scope."
    );
  }

  const sourceRecordId = typeof record.id === "string" ? record.id.trim() : "";
  if (!sourceRecordId) {
    throw new Mem0MemoryProviderError("MEMORY_RECORD_INVALID", "Mem0 record is missing an id.");
  }
  const lineage = decodeMemoryLineage(record.metadata ?? {});
  const metadata = sanitizeSemanticMetadata(record.metadata);
  const memoryType = readString(metadata, "memoryType")?.toLowerCase();
  const kind = resolveKind(metadata, memoryType);
  const assertion = resolveAssertion(metadata, memoryType);
  const sourceTurnIds = resolveSourceTurnIds(metadata);
  const participants = resolveParticipants(metadata);
  const event: MemoryEvent = {
    id: canonicalMem0EventId(sourceRecordId),
    kind,
    content: typeof record.content === "string" ? record.content.trim() : "",
    source: MEM0_MEMORY_SOURCE,
    sourceRecordId,
    scope,
    metadata,
    ...(lineage ? { lineage } : {})
  };

  const recordedAt = normalizeTimestamp(record.createdAt);
  if (recordedAt !== undefined) event.recordedAt = recordedAt;
  const observedAt = normalizeTimestamp(readString(metadata, "yuviObservedAt"));
  if (observedAt !== undefined) event.observedAt = observedAt;
  const occurredAt = normalizeTimestamp(readString(metadata, "yuviOccurredAt"));
  if (occurredAt !== undefined) event.occurredAt = occurredAt;
  if (sourceTurnIds.length > 0) event.sourceTurnIds = sourceTurnIds;

  const conversationId = readString(metadata, "conversationId");
  if (conversationId !== undefined) event.conversationId = conversationId;
  if (participants.length > 0) event.participants = participants;
  if (assertion !== undefined) event.assertion = assertion;
  const claim = deserializeClaimMetadata(metadata);
  if (claim !== undefined) event.claim = claim;
  return event;
}

export class Mem0MemoryProvider implements MemoryProvider {
  private profileNotificationFailureCount = 0;
  constructor(
    private readonly backend: MemoryBackend,
    private readonly onProfileMutation?: (input: {
      scope: string;
      reason: "DELIVERY_OBSERVED";
    }) => Promise<void> | void,
    readonly evidenceAdmissions: EvidenceAdmissionStore = new InMemoryEvidenceAdmissionStore()
  ) {
    if (backend.kind !== "mem0") {
      throw new Mem0MemoryProviderError(
        "MEMORY_BACKEND_KIND_INVALID",
        `Mem0MemoryProvider requires a mem0 backend; received ${backend.kind}.`
      );
    }
  }

  getProfileNotificationFailureCount(): number {
    return this.profileNotificationFailureCount;
  }

  async retrieveRelevant(input: MemoryRetrievalInput): Promise<MemoryRetrievalOutcome> {
    const scope = resolveRetrievalScope(input);
    if (!scope) {
      return retrievalError("MEMORY_SCOPE_MISSING");
    }
    const query = typeof input.text === "string" ? input.text.trim() : "";
    if (!query) {
      return {
        status: "empty",
        events: [],
        source: MEM0_MEMORY_SOURCE,
        limited: false,
        rawCount: 0,
        selectedCount: 0
      };
    }

    const limit = normalizeLimit(input.limit);
    try {
      const records = await this.backend.search(
        limit === undefined ? { scope, query } : { scope, query, limit },
        input.signal
      );
      const events: MemoryEvent[] = [];
      const seen = new Set<MemoryEventId>();
      for (const record of records) {
        const event = mapMem0RecordToMemoryEvent(record, scope);
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
      }
      const limited = limit !== undefined && records.length >= limit;
      return {
        status: events.length === 0 ? "empty" : "ok",
        events,
        source: MEM0_MEMORY_SOURCE,
        limited,
        ...(limited ? { limitReason: "top-k-cap" } : {}),
        rawCount: records.length,
        selectedCount: events.length
      };
    } catch (error) {
      return retrievalError(classifyRetrievalError(error));
    }
  }

  async getEvent(input: MemoryGetEventInput): Promise<MemoryEvent | null> {
    const scope = normalizeOptionalScope(input.scope);
    if (!scope || !hasCanonicalMem0Prefix(input.id)) return null;
    const sourceRecordId = input.id.slice(MEM0_EVENT_ID_PREFIX.length).trim();
    if (!sourceRecordId) return null;

    const record = await this.backend.get({ memoryId: sourceRecordId, scope }, input.signal);
    if (!record) return null;
    try {
      return mapMem0RecordToMemoryEvent(record, scope);
    } catch (error) {
      if (error instanceof Mem0MemoryProviderError && error.code === "MEMORY_SCOPE_MISMATCH") {
        return null;
      }
      throw error;
    }
  }

  async writeEvent(input: MemoryWriteEventInput): Promise<MemoryWriteEventOutcome> {
    const scope = normalizeOptionalScope(input.scope);
    if (!scope)
      return {
        status: "rejected",
        errorCode: "MEMORY_SCOPE_MISSING",
        failureClass: "definitive_rejection"
      };
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!content)
      return {
        status: "rejected",
        errorCode: "MEMORY_CONTENT_MISSING",
        failureClass: "definitive_rejection"
      };

    try {
      const result = await this.backend.add(
        {
          scope,
          content,
          infer: false,
          metadata: buildWriteMetadata(input)
        },
        input.signal
      );
      const memoryId = typeof result.memoryId === "string" ? result.memoryId.trim() : "";
      if (!memoryId)
        return {
          status: "rejected",
          errorCode: "MEMORY_WRITE_ID_MISSING",
          failureClass: "ambiguous"
        };
      const eventId = canonicalMem0EventId(memoryId);
      if (result.operation === "deleted") {
        return {
          status: "rejected",
          eventId,
          errorCode: "MEMORY_WRITE_UNEXPECTED_DELETE",
          failureClass: "definitive_rejection"
        };
      }
      if (
        result.operation !== "created" &&
        result.operation !== "updated" &&
        result.operation !== "unchanged"
      ) {
        return {
          status: "rejected",
          eventId,
          errorCode: "MEMORY_WRITE_OPERATION_INVALID",
          failureClass: "definitive_rejection"
        };
      }

      let event: MemoryEvent | null = null;
      if (result.record) {
        try {
          event = mapMem0RecordToMemoryEvent(result.record, scope);
        } catch (error) {
          return {
            status: "rejected",
            eventId,
            errorCode: safeErrorCode(error, "MEMORY_RECORD_INVALID"),
            failureClass: "ambiguous"
          };
        }
      }
      try {
        assertReturnedLineage(input, event);
      } catch (error) {
        return {
          status: "rejected",
          eventId,
          errorCode: safeErrorCode(error, "MEMORY_LINEAGE_INVALID"),
          failureClass: "ambiguous"
        };
      }
      return {
        status: result.operation === "unchanged" ? "unchanged" : "written",
        eventId,
        event
      };
    } catch (error) {
      return {
        status: "rejected",
        errorCode: safeErrorCode(error, "MEMORY_WRITE_FAILED"),
        failureClass: classifyWriteFailure(error)
      };
    }
  }

  async prepareEvidence(producer: EvidenceProducer, event: MemoryWriteEventInput): Promise<void> {
    await this.evidenceAdmissions.prepare(prepareEvidenceAdmission(producer, event));
  }

  private async bindPreparedEffect(scope: string, key: string, digest: string, memoryId: string): Promise<void> {
    const admission = await this.evidenceAdmissions.get(scope, key);
    if (!admission) return; // Reliability is not admission.
    const record = await this.backend.get({ scope, memoryId });
    if (admission.payloadDigest !== digest || !record || record.id !== memoryId || record.scope !== scope ||
        admission.effectDigest !== memoryEffectDigest(record)) throw new Error("EVIDENCE_EFFECT_MISMATCH");
    await this.evidenceAdmissions.bind(scope, key, memoryId);
    await this.notifyReconciliation(scope);
  }

  async writeEventIdempotent(input: MemoryWriteEventInput): Promise<MemoryWriteEventOutcome> {
    const scope = normalizeOptionalScope(input.scope);
    const key = input.idempotencyKey?.trim();
    const digest = input.payloadDigest?.trim();
    if (!scope) {
      return {
        status: "rejected",
        errorCode: "MEMORY_SCOPE_MISSING",
        failureClass: "definitive_rejection"
      };
    }
    if (!key || !digest) {
      return {
        status: "rejected",
        errorCode: "MEMORY_IDEMPOTENCY_INPUT_MISSING",
        failureClass: "definitive_rejection"
      };
    }
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!content) {
      return {
        status: "rejected",
        errorCode: "MEMORY_CONTENT_MISSING",
        failureClass: "definitive_rejection"
      };
    }
    const backend = this.backend;
    if (!backend.submitIdempotent) {
      return {
        status: "rejected",
        errorCode: "MEMORY_IDEMPOTENCY_UNSUPPORTED",
        failureClass: "definitive_rejection"
      };
    }

    let result: Awaited<ReturnType<NonNullable<MemoryBackend["submitIdempotent"]>>>;
    try {
      result = await backend.submitIdempotent(
        {
          scope,
          content,
          infer: false,
          metadata: buildWriteMetadata(input),
          idempotencyKey: key,
          payloadDigest: digest
        },
        input.signal
      );
    } catch (error) {
      return {
        status: "rejected",
        errorCode: safeErrorCode(error, "MEMORY_IDEMPOTENT_WRITE_FAILED"),
        failureClass: classifyWriteFailure(error)
      };
    }

    // A successful keyed submit may already have committed the semantic effect.
    // Any failure validating or mapping that success response is therefore
    // ambiguous, regardless of the local mapping exception class.
    let eventId: MemoryEventId | undefined;
    try {
      const response = result as unknown as {
        memoryId?: unknown;
        operation?: unknown;
        record?: unknown;
      } | null;
      const memoryId = typeof response?.memoryId === "string" ? response.memoryId.trim() : "";
      if (!memoryId) {
        return {
          status: "rejected",
          errorCode: "MEMORY_WRITE_ID_MISSING",
          failureClass: "ambiguous"
        };
      }
      eventId = canonicalMem0EventId(memoryId);
      if (
        response?.operation !== "created" &&
        response?.operation !== "updated" &&
        response?.operation !== "unchanged"
      ) {
        return {
          status: "rejected",
          eventId,
          errorCode: "MEMORY_WRITE_OPERATION_INVALID",
          failureClass: "ambiguous"
        };
      }
      const event =
        response.record === undefined || response.record === null
          ? null
          : mapMem0RecordToMemoryEvent(response.record as MemoryRecord, scope);
      assertReturnedLineage(input, event);
      await this.bindPreparedEffect(scope, key, digest, memoryId);
      return {
        status: response.operation === "unchanged" ? "unchanged" : "written",
        eventId,
        event
      };
    } catch (error) {
      return {
        status: "rejected",
        ...(eventId ? { eventId } : {}),
        errorCode: safeErrorCode(error, "MEMORY_IDEMPOTENT_RESPONSE_INVALID"),
        failureClass: "ambiguous"
      };
    }
  }

  async reconcileEvent(
    input: Pick<MemoryWriteEventInput, "idempotencyKey" | "payloadDigest"> & { scope?: string }
  ): Promise<MemoryReconciliationResult> {
    const key = input.idempotencyKey?.trim();
    const digest = input.payloadDigest?.trim();
    if (!key || !digest)
      return { status: "unknown", errorCode: "MEMORY_IDEMPOTENCY_INPUT_MISSING" };
    if (!this.backend.reconcileIdempotency) {
      if (input.scope) await this.notifyReconciliation(input.scope);
      return { status: "unknown", errorCode: "MEMORY_RECONCILIATION_UNSUPPORTED" };
    }
    try {
      const result = await this.backend.reconcileIdempotency(
        { idempotencyKey: key, payloadDigest: digest }, undefined
      );
      if (result.status === "applied" && result.memoryId && input.scope) {
        await this.bindPreparedEffect(input.scope, key, digest, result.memoryId);
      }
      const { memoryId, ...semantic } = result;
      return { ...semantic, ...(memoryId ? { eventId: canonicalMem0EventId(memoryId) } : {}) };
    } catch (error) {
      return {
        status: "unknown",
        errorCode: safeErrorCode(error, "MEMORY_RECONCILIATION_UNAVAILABLE")
      };
    } finally {
      if (input.scope) await this.notifyReconciliation(input.scope);
    }
  }

  private async notifyReconciliation(scope: string): Promise<void> {
    if (!this.onProfileMutation) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        Promise.resolve(this.onProfileMutation({ scope, reason: "DELIVERY_OBSERVED" })).then(
          () => true,
          () => false
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1_000);
        })
      ]);
      if (!completed) this.profileNotificationFailureCount += 1;
    } catch {
      this.profileNotificationFailureCount += 1;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function buildWriteMetadata(input: MemoryWriteEventInput): MemoryRecordMetadata {
  const metadata = sanitizeSemanticMetadata(
    Object.fromEntries(
      Object.entries(input.metadata ?? {}).filter(([key]) => !isReservedMemoryMetadataKey(key))
    )
  );
  metadata["yuviEventKind"] = input.kind;
  if (input.assertion) {
    metadata["yuviAssertionSource"] = input.assertion.source;
    metadata["yuviVerification"] = input.assertion.verification;
  }
  const observedAt = normalizeTimestamp(input.observedAt);
  if (observedAt !== undefined) metadata["yuviObservedAt"] = observedAt;
  const occurredAt = normalizeTimestamp(input.occurredAt);
  if (occurredAt !== undefined) metadata["yuviOccurredAt"] = occurredAt;
  const sourceTurnIds = normalizeStringArray(input.sourceTurnIds);
  if (sourceTurnIds.length > 0) metadata["yuviSourceTurnIds"] = sourceTurnIds;
  const participants = normalizeStringArray(input.participants);
  if (participants.length > 0) metadata["yuviParticipants"] = participants;
  if (input.conversationId?.trim()) metadata.conversationId = input.conversationId.trim();
  if (input.idempotencyKey?.trim()) metadata["yuviIngestionKey"] = input.idempotencyKey.trim();
  if (input.payloadDigest?.trim()) metadata["yuviPayloadDigest"] = input.payloadDigest.trim();
  if (input.claim) {
    Object.assign(metadata, serializeClaimMetadata(input.claim));
  }
  if (input.lineage) Object.assign(metadata, encodeMemoryLineage(input.lineage));
  return metadata;
}

export function sanitizeSemanticMetadata(value: unknown): MemoryRecordMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const lineage = decodeMemoryLineage(value as Record<string, unknown>);
  const out: MemoryRecordMetadata = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (LINEAGE_METADATA_KEYS.includes(key as (typeof LINEAGE_METADATA_KEYS)[number])) continue;
    if (
      key.length === 0 ||
      key.length > MAX_METADATA_KEY_LENGTH ||
      SENSITIVE_METADATA_KEY.test(key)
    ) {
      continue;
    }
    const safe = sanitizeMetadataValue(entry);
    if (safe !== undefined) out[key] = safe;
  }
  if (lineage) Object.assign(out, encodeMemoryLineage(lineage));
  return out;
}

function sanitizeMetadataValue(
  value: unknown
): string | number | boolean | null | string[] | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return value.length <= MAX_METADATA_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_METADATA_STRING_LENGTH)}…`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY_LENGTH) return undefined;
    const values: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || item.length > MAX_METADATA_STRING_LENGTH) return undefined;
      values.push(item);
    }
    return values;
  }
  return undefined;
}

function resolveRetrievalScope(input: MemoryRetrievalInput): string | null {
  const direct = normalizeOptionalScope(input.scope);
  if (direct) return direct;
  if (input.subjectUserId?.trim() && input.personaId?.trim()) {
    try {
      return buildMemoryScope(input.subjectUserId, input.personaId);
    } catch {
      return null;
    }
  }
  return null;
}

function resolveKind(
  metadata: MemoryRecordMetadata,
  memoryType: string | undefined
): MemoryEventKind {
  const explicitKind = readString(metadata, "yuviEventKind");
  if (explicitKind && LEGAL_EVENT_KINDS.has(explicitKind)) return explicitKind as MemoryEventKind;
  if (memoryType === "explicit") return "user_claim";
  return "fact";
}

function resolveAssertion(
  metadata: MemoryRecordMetadata,
  memoryType: string | undefined
): MemoryEventAssertion | undefined {
  const source = readString(metadata, "yuviAssertionSource");
  const verification = readString(metadata, "yuviVerification");
  if (
    source &&
    verification &&
    LEGAL_ASSERTION_SOURCES.has(source) &&
    LEGAL_VERIFICATIONS.has(verification)
  ) {
    return {
      source: source as MemoryEventAssertion["source"],
      verification: verification as MemoryEventAssertion["verification"]
    };
  }
  if (memoryType === "explicit") return { source: "user", verification: "unverified" };
  return undefined;
}

function resolveSourceTurnIds(metadata: MemoryRecordMetadata): string[] {
  return dedupeStrings([
    ...readStringArray(metadata, "sourceMessageId"),
    ...readStringArray(metadata, "assistantMessageId"),
    ...readStringArray(metadata, "yuviSourceTurnIds")
  ]);
}

function resolveParticipants(metadata: MemoryRecordMetadata): string[] {
  const namespaced = readStringArray(metadata, "yuviParticipants");
  const identities = [readString(metadata, "userId"), readString(metadata, "characterId")];
  return dedupeStrings([
    ...namespaced,
    ...identities.filter((value): value is string => value !== undefined)
  ]);
}

function readString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? normalizeStringArray(value)
    : readString(metadata, key)
      ? [readString(metadata, key)!]
      : [];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? dedupeStrings(value.filter((item): item is string => typeof item === "string"))
    : [];
}

function dedupeStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value)))
    return undefined;
  return value.trim();
}

function normalizeRequiredScope(scope: string): string {
  const normalized = normalizeOptionalScope(scope);
  if (!normalized) throw new Mem0MemoryProviderError("MEMORY_SCOPE_MISSING", "scope is required.");
  return normalized;
}

function normalizeOptionalScope(scope: unknown): string | null {
  return typeof scope === "string" && scope.trim() ? scope.trim() : null;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

function hasCanonicalMem0Prefix(id: string): boolean {
  return typeof id === "string" && id.startsWith(MEM0_EVENT_ID_PREFIX);
}

function retrievalError(errorCode: string): MemoryRetrievalOutcome {
  return {
    status:
      errorCode === "OPERATION_TIMEOUT" || errorCode === "MEMORY_UNAVAILABLE"
        ? "unavailable"
        : "error",
    events: [],
    source: MEM0_MEMORY_SOURCE,
    limited: false,
    errorCode
  };
}

function classifyRetrievalError(error: unknown): string {
  if (error instanceof MemoryBackendError) {
    if (error.code === "OPERATION_TIMEOUT") return "OPERATION_TIMEOUT";
    if (error.code === "VALIDATION_ERROR") return error.code;
    if (error.retryable) return "MEMORY_UNAVAILABLE";
    return error.code || "MEMORY_BACKEND_ERROR";
  }
  if (error instanceof Mem0MemoryProviderError || error instanceof MemoryLineageEncodingError)
    return error.code;
  return "MEMORY_PROVIDER_ERROR";
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (
    error instanceof MemoryBackendError ||
    error instanceof Mem0MemoryProviderError ||
    error instanceof MemoryLineageEncodingError
  ) {
    return error.code || fallback;
  }
  return fallback;
}

function classifyWriteFailure(error: unknown): MemoryWriteFailureClass {
  if (error instanceof Mem0MemoryProviderError || error instanceof MemoryLineageEncodingError)
    return "definitive_rejection";
  if (error instanceof MemoryBackendError) {
    if (
      error.code === "VALIDATION_ERROR" ||
      error.code === "MEMORY_IDEMPOTENCY_CONFLICT" ||
      error.code === "MEMORY_IDEMPOTENCY_PAYLOAD_CONFLICT"
    ) {
      return "definitive_rejection";
    }
    // The backend request may already have reached the sidecar. Retryability
    // alone is not proof that no external effect occurred.
    return "ambiguous";
  }
  return "ambiguous";
}

function assertReturnedLineage(input: MemoryWriteEventInput, event: MemoryEvent | null): void {
  if (
    input.lineage &&
    (!event?.lineage || canonicalLineageJson(input.lineage) !== canonicalLineageJson(event.lineage))
  ) {
    throw new MemoryLineageEncodingError();
  }
}
