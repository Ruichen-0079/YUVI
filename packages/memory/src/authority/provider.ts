import type { MemoryVectorIndexer } from "./vector.js";
import type {
  MemoryProvider,
  MemoryWriteEventInput,
  MemoryWriteEventOutcome,
  MemoryRetrievalInput,
  MemoryRetrievalOutcome
} from "../provider.js";
import { MemoryAuthorityError } from "./types.js";
import { PostgresMemoryAuthority } from "./store.js";
import { MemoryKnowledgeReader } from "./read.js";

export class PostgresMemoryProvider implements MemoryProvider {
  readonly knowledge: MemoryKnowledgeReader;
  constructor(
    readonly authority: PostgresMemoryAuthority,
    readonly vectors?: MemoryVectorIndexer
  ) {
    this.knowledge = new MemoryKnowledgeReader(authority.pool);
  }
  prepareEvidence: NonNullable<MemoryProvider["prepareEvidence"]> = (producer, input) =>
    this.authority.prepare(producer, input);
  async retrieveRelevant(input: MemoryRetrievalInput): Promise<MemoryRetrievalOutcome> {
    if (!input.access)
      return {
        status: "unavailable",
        events: [],
        source: "postgres",
        limited: false,
        errorCode: "MEMORY_READER_AUTHORITY_UNRESOLVED"
      };
    if (!input.scope)
      return {
        status: "unavailable",
        events: [],
        source: "postgres",
        limited: false,
        errorCode: "MEMORY_SCOPE_MISSING"
      };
    if (input.signal?.aborted)
      return {
        status: "error",
        events: [],
        source: "postgres",
        limited: false,
        errorCode: "MEMORY_CANCELLED"
      };
    try {
      const result = await this.knowledge.search(input.scope, input.text, input.limit ?? 8);
      let vectorError = false;
      let vectorPending = false;
      let indexedIds: string[] = [];
      if (this.vectors)
        try {
          vectorPending = await this.vectors.hasPending(input.scope);
          indexedIds = await this.vectors.search(
            input.scope,
            input.text,
            Math.min(32, input.limit ?? 8)
          );
        } catch {
          vectorError = true;
        }
      const indexed = await Promise.all(
        indexedIds.map((id) => this.knowledge.detail(input.scope!, id))
      );
      const selected = [
        ...new Map(
          [
            ...result.records,
            ...indexed.filter(
              (r): r is NonNullable<typeof r> =>
                r !== null && ["current", "conflicted"].includes(r.state)
            )
          ].map((r) => [r.id, r])
        ).values()
      ].slice(0, input.limit ?? 8);
      const events = selected
        .map((r) => r.event)
        .filter((event) => matchesReader(event, input.access!));
      return {
        status: vectorError
          ? events.length
            ? "partial"
            : "unavailable"
          : result.candidateLimited || vectorPending
            ? "partial"
            : events.length
              ? "ok"
              : "empty",
        source: "postgres",
        events,
        limited: result.candidateLimited || vectorError || vectorPending,
        limitReason: vectorError
          ? "MEMORY_VECTOR_UNAVAILABLE"
          : vectorPending
            ? "MEMORY_VECTOR_INDEX_PENDING"
            : result.candidateLimited
              ? "MEMORY_TEXT_CANDIDATE_BOUND"
              : null,
        selectedCount: events.length
      };
    } catch (error) {
      return {
        status: "error",
        events: [],
        source: "postgres",
        limited: false,
        errorCode:
          error instanceof MemoryAuthorityError ? error.code : "MEMORY_AUTHORITY_QUERY_FAILED"
      };
    }
  }
  async getEvent(input: Parameters<MemoryProvider["getEvent"]>[0]) {
    if (!input.access) throw new MemoryAuthorityError("MEMORY_READER_AUTHORITY_UNRESOLVED");
    const event = (await this.knowledge.detail(input.scope, input.id))?.event;
    return event && matchesReader(event, input.access) ? event : null;
  }
  writeEvent(input: MemoryWriteEventInput): Promise<MemoryWriteEventOutcome> {
    return this.writeEventIdempotent(input);
  }
  async writeEventIdempotent(input: MemoryWriteEventInput): Promise<MemoryWriteEventOutcome> {
    if (input.signal?.aborted)
      return {
        status: "rejected",
        failureClass: "retryable_no_effect",
        errorCode: "MEMORY_CANCELLED"
      };
    try {
      const result = await this.authority.commit(input);
      return {
        status: result.inserted ? "written" : "unchanged",
        event: result.event,
        eventId: result.event.id
      };
    } catch (error) {
      // Any unclassified DB/transport failure may include a lost COMMIT response.
      // Reconciliation, not blind retry, decides whether an effect exists.
      return {
        status: "rejected",
        failureClass: error instanceof MemoryAuthorityError ? "definitive_rejection" : "ambiguous",
        errorCode:
          error instanceof MemoryAuthorityError ? error.code : "MEMORY_AUTHORITY_COMMIT_UNKNOWN"
      };
    }
  }
  async reconcileEvent(input: Parameters<NonNullable<MemoryProvider["reconcileEvent"]>>[0]) {
    if (!input.scope || !input.idempotencyKey || !input.payloadDigest)
      return { status: "unknown" as const, errorCode: "MEMORY_RECONCILIATION_IDENTITY_MISSING" };
    try {
      return await this.authority.reconcile(input.scope, input.idempotencyKey, input.payloadDigest);
    } catch {
      return { status: "unknown" as const, errorCode: "MEMORY_AUTHORITY_QUERY_FAILED" };
    }
  }
}

function matchesReader(
  event: import("../provider.js").MemoryEvent,
  access: import("../provider.js").MemoryReadAuthority
) {
  const lineage = event.lineage;
  return (
    lineage?.state === "GROUNDED" &&
    "authority" in lineage &&
    lineage.authority.audience.kind === "PRIVATE" &&
    lineage.authority.principal.state === "RESOLVED" &&
    lineage.authority.binding.state === "RESOLVED" &&
    lineage.authority.principal.namespace === access.principal.namespace &&
    lineage.authority.principal.actorId === access.principal.actorId &&
    lineage.authority.binding.personId === access.personId
  );
}
