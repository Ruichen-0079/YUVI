import type { MemorySearchPlan } from "./query-expansion.js";
import type { MemoryDecisionReassessment } from "./reassessment.js";
import { MemoryRetrievalEvidence, type RetrievalCandidate } from "./retrieval-evidence.js";
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
  reassessment?: MemoryDecisionReassessment | undefined;
  readonly knowledge: MemoryKnowledgeReader;
  readonly retrievalEvidence: MemoryRetrievalEvidence;
  constructor(
    readonly authority: PostgresMemoryAuthority,
    readonly vectors?: MemoryVectorIndexer,
    readonly expandQuery?: (input: MemoryRetrievalInput) => Promise<MemorySearchPlan>
  ) {
    this.knowledge = new MemoryKnowledgeReader(authority.pool);
    this.retrievalEvidence = new MemoryRetrievalEvidence(authority.pool);
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
      let textError = false;
      let planError = false;
      let plan: MemorySearchPlan | undefined;
      // An explicit configured option; no new model call is hidden in the default path.
      if (this.expandQuery)
        try {
          plan = await this.expandQuery(input);
        } catch (error) {
          if (error instanceof MemoryAuthorityError && error.code.includes("AUTHORITY"))
            throw error;
          planError = true;
        }
      const queries = [...new Set([input.text.slice(0, 4000), ...(plan?.queries ?? [])])];
      const channels: Array<{ query: string; status: "OK" | "UNAVAILABLE"; ids: string[] }> = [];
      const loadText = async () => {
        const results = await Promise.allSettled(
          queries.map((q) => this.knowledge.search(input.scope!, q, queries.length === 1 ? 32 : 16))
        );
        const scores = new Map<string, number>();
        const records = new Map<
          string,
          Awaited<ReturnType<MemoryKnowledgeReader["search"]>>["records"][number]
        >();
        let limited = false,
          watermark = "0";
        for (const [ordinal, channel] of results.entries()) {
          channels.push({
            query: queries[ordinal]!,
            status: channel.status === "rejected" ? "UNAVAILABLE" : "OK",
            ids:
              channel.status === "rejected"
                ? []
                : channel.value.records
                    .filter((r) => matchesReader(r.event, input.access!))
                    .map((r) => r.id)
          });
          if (channel.status === "rejected") {
            textError = true;
            continue;
          }
          watermark = channel.value.watermark;
          limited ||= channel.value.candidateLimited;
          channel.value.records.forEach((record, index) => {
            records.set(record.id, record);
            scores.set(record.id, (scores.get(record.id) ?? 0) + 1 / (60 + index));
          });
        }
        return {
          records: [...records.values()]
            .sort(
              (a, b) =>
                (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
                (BigInt(a.version) > BigInt(b.version)
                  ? -1
                  : BigInt(a.version) < BigInt(b.version)
                    ? 1
                    : a.id.localeCompare(b.id))
            )
            .slice(0, 32),
          watermark,
          candidateLimited: limited || records.size > 32
        };
      };
      let result = await loadText();
      const observedTextIds = new Set(result.records.map((r) => r.id));
      const compatibility = await this.knowledge.overview(input.scope);
      const compatibilityPending =
        compatibility.legacy !== "0" || compatibility.unattributed !== "0";
      let vectorError = false;
      let vectorPending = false;
      let vectorLimited = false;
      let indexedIds: string[] = [];
      if (this.vectors)
        try {
          vectorPending = await this.vectors.hasPending(input.scope);
          const vectorResult = await this.vectors.searchWithEvidence(input.scope, input.text, 32);
          indexedIds = vectorResult.ids;
          vectorLimited = vectorResult.limited;
        } catch {
          vectorError = true;
        }
      let resolved = await this.knowledge.resolveCandidates(input.scope, [
        ...new Set([...observedTextIds, ...result.records.map((r) => r.id), ...indexedIds])
      ]);
      // At most one bounded text refresh; do not repeat a remote embedding call.
      if (resolved.watermark !== result.watermark) {
        result = await loadText();
        resolved = await this.knowledge.resolveCandidates(input.scope, [
          ...new Set([...observedTextIds, ...result.records.map((r) => r.id), ...indexedIds])
        ]);
      }
      const byId = new Map(resolved.records.map((r) => [r.id, r]));
      const indexed = indexedIds
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r));
      result = {
        ...result,
        watermark: resolved.watermark,
        records: result.records
          .map((r) => byId.get(r.id))
          .filter((r): r is NonNullable<typeof r> => Boolean(r))
      };
      const vectorRank = new Map(indexedIds.map((id, i) => [id, i]));
      const textRank = new Map(result.records.map((r, i) => [r.id, i]));
      const score = (id: string) =>
        (textRank.has(id) ? 1 / (60 + textRank.get(id)!) : 0) +
        (vectorRank.has(id) ? 1 / (32 + vectorRank.get(id)!) : 0);
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
      ]
        .filter(
          (r) =>
            ["current", "conflicted"].includes(r.state) && matchesReader(r.event, input.access!)
        )
        .sort(
          (a, b) =>
            score(b.id) - score(a.id) ||
            (BigInt(a.version) > BigInt(b.version)
              ? -1
              : BigInt(a.version) < BigInt(b.version)
                ? 1
                : a.id.localeCompare(b.id))
        )
        .slice(0, input.limit ?? 8);
      const events = selected
        .map((r) => r.event)
        .filter((event) => matchesReader(event, input.access!));
      const outcome: MemoryRetrievalOutcome = {
        status:
          vectorError || textError
            ? events.length
              ? "partial"
              : "unavailable"
            : planError ||
                result.candidateLimited ||
                vectorPending ||
                vectorLimited ||
                compatibilityPending
              ? "partial"
              : events.length
                ? "ok"
                : "empty",
        source: "postgres",
        events,
        limited:
          result.candidateLimited ||
          planError ||
          textError ||
          vectorError ||
          vectorPending ||
          vectorLimited ||
          compatibilityPending,
        limitReason:
          textError && vectorError
            ? "MEMORY_RETRIEVAL_CHANNELS_UNAVAILABLE"
            : textError
              ? "MEMORY_TEXT_UNAVAILABLE"
              : planError
                ? "MEMORY_QUERY_PLAN_UNAVAILABLE"
                : vectorError
                  ? "MEMORY_VECTOR_UNAVAILABLE"
                  : vectorPending
                    ? "MEMORY_VECTOR_INDEX_PENDING"
                    : vectorLimited
                      ? "MEMORY_VECTOR_CANDIDATE_BOUND"
                      : result.candidateLimited
                        ? "MEMORY_TEXT_CANDIDATE_BOUND"
                        : compatibilityPending
                          ? "MEMORY_LEGACY_OR_UNATTRIBUTED_REQUIRES_REVIEW"
                          : null,
        selectedCount: events.length,
        watermark: result.watermark
      };
      const chosen = new Set(events.map((e) => e.id));
      const textIds = new Set([...observedTextIds, ...result.records.map((r) => r.id)]);
      const vectorIds = new Set(indexedIds);
      const all = resolved.records;
      const candidates: RetrievalCandidate[] = all
        .filter((r) => matchesReader(r.event, input.access!))
        .map((r) => ({
          id: r.id,
          version: r.version,
          state: r.state,
          content: r.event.content,
          channels: [
            ...(textIds.has(r.id) ? ["TEXT" as const] : []),
            ...(vectorIds.has(r.id) ? ["VECTOR" as const] : [])
          ],
          selected: chosen.has(r.id),
          reason: chosen.has(r.id)
            ? "SELECTED"
            : !["current", "conflicted"].includes(r.state)
              ? "NO_LONGER_CURRENT"
              : "RESULT_BOUND"
        }));
      outcome.retrievalId = await this.retrievalEvidence.record(input, outcome, {
        watermark: result.watermark,
        candidates,
        modelTag: this.vectors?.modelTag,
        queryPlan: {
          schema: "memory.search-plan.v1",
          status: this.expandQuery ? (planError ? "UNAVAILABLE" : "APPLIED") : "DISABLED",
          queries,
          model: plan?.model ?? null,
          usage: plan?.usage ?? null,
          channels,
          textStatus: textError ? "PARTIAL_OR_UNAVAILABLE" : "OK",
          vectorStatus: this.vectors
            ? vectorError
              ? "UNAVAILABLE"
              : vectorPending
                ? "PENDING"
                : "OK"
            : "DISABLED"
        }
      });
      return outcome;
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
    const record = await this.knowledge.detail(input.scope, input.id);
    return record &&
      ["current", "conflicted"].includes(record.state) &&
      matchesReader(record.event, input.access)
      ? record.event
      : null;
  }
  async canUseSnapshot(input: Parameters<MemoryProvider["getEvent"]>[0]) {
    if (!input.access) return false;
    const record = await this.knowledge.detail(input.scope, input.id);
    return Boolean(record && matchesReader(record.event, input.access));
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
      if (
        this.reassessment &&
        error instanceof MemoryAuthorityError &&
        ["MEMORY_TARGET_STALE_OR_INACCESSIBLE", "MEMORY_TARGET_TIME_ORDER"].includes(error.code)
      ) {
        try {
          const result = await this.reassessment.apply(input);
          return { status: result.inserted ? "written" : "unchanged", eventId: result.eventId };
        } catch (e) {
          return {
            status: "rejected",
            failureClass: "ambiguous",
            errorCode:
              e instanceof MemoryAuthorityError ? e.code : "MEMORY_REASSESSMENT_PENDING_OR_UNKNOWN"
          };
        }
      }
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
      const reassessed = await this.reassessment?.reconcile(
        input.scope,
        input.idempotencyKey,
        input.payloadDigest
      );
      return (
        reassessed ??
        (await this.authority.reconcile(input.scope, input.idempotencyKey, input.payloadDigest))
      );
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
