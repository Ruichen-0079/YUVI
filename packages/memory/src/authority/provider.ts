import { validateSearchNeeds, type MemorySearchPlan } from "./query-expansion.js";
import { coverageSelection } from "./coverage.js";
import {
  unavailableEvidenceSupport,
  validateEvidenceSupport,
  type SupportInput,
  type EvidenceSupport
} from "./evidence-support.js";
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
    readonly expandQuery?: (input: MemoryRetrievalInput) => Promise<MemorySearchPlan>,
    readonly assessSupport?: (input: SupportInput) => Promise<EvidenceSupport>
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
      const queryInputLimited = input.text.length > 4000;
      let textError = false;
      let lexicalPending = false;
      let planError = false;
      let plan: MemorySearchPlan | undefined;
      // An explicit configured option; no new model call is hidden in the default path.
      if (this.expandQuery)
        try {
          plan = await this.expandQuery(input);
          if (plan.needs) plan.needs = validateSearchNeeds(input.text, plan.needs);
        } catch (error) {
          if (error instanceof MemoryAuthorityError && error.code.includes("AUTHORITY"))
            throw error;
          plan = undefined;
          planError = true;
        }
      const needs = plan?.needs ?? [];
      const queries = [...new Set([input.text.slice(0, 4000), ...(plan?.queries ?? [])])];
      const tasks = [
        ...queries.map((query) => ({ query, needId: null as string | null })),
        ...needs.flatMap((n) => n.queries.map((query) => ({ query, needId: n.id })))
      ];
      const channels: Array<{
        query: string;
        needId: string | null;
        status: "OK" | "UNAVAILABLE";
        ids: string[];
        lexicalIndex?: string;
        queryTermsLimited?: boolean;
        candidateLimited?: boolean;
      }> = [];
      let textNeedRanks = new Map<string, string[]>();
      let textNeedScores = new Map<string, Map<string, number>>();
      const loadText = async () => {
        const results = await Promise.allSettled(
          tasks.map((t) =>
            this.knowledge.search(
              input.scope!,
              t.query,
              needs.length ? 8 : queries.length === 1 ? 32 : 16
            )
          )
        );
        const scores = new Map<string, number>();
        const needScores = new Map<string, Map<string, number>>();
        const records = new Map<
          string,
          Awaited<ReturnType<MemoryKnowledgeReader["search"]>>["records"][number]
        >();
        let limited = false,
          watermark = "0";
        for (const [ordinal, channel] of results.entries()) {
          const task = tasks[ordinal]!;
          const available =
            channel.status === "fulfilled"
              ? channel.value.records.filter((r) => matchesReader(r.event, input.access!))
              : [];
          channels.push({
            ...task,
            status: channel.status === "rejected" ? "UNAVAILABLE" : "OK",
            ids: available.map((r) => r.id),
            ...(channel.status === "fulfilled" && channel.value.lexicalIndex
              ? {
                  lexicalIndex: channel.value.lexicalIndex,
                  queryTermsLimited: channel.value.queryTermsLimited ?? false,
                  candidateLimited: channel.value.candidateLimited
                }
              : {})
          });
          if (channel.status === "rejected") {
            textError = true;
            continue;
          }
          watermark = channel.value.watermark;
          lexicalPending ||= channel.value.lexicalIndex === "BACKFILL_PENDING_GIN_FALLBACK";
          limited ||= channel.value.candidateLimited;
          available.forEach((record, index) => {
            records.set(record.id, record);
            // Rank alone loses the distinction between a translated phrase hit
            // and one incidental character in another language channel.
            const strength = channel.value.relevanceById?.[record.id];
            const value = (strength === undefined ? 1 : Math.log1p(strength)) / (60 + index);
            scores.set(record.id, (scores.get(record.id) ?? 0) + value);
            if (task.needId) {
              const values = needScores.get(task.needId) ?? new Map<string, number>();
              values.set(record.id, (values.get(record.id) ?? 0) + value);
              needScores.set(task.needId, values);
            }
          });
        }
        const order = (values: Map<string, number>) =>
          [...values.keys()].sort(
            (a, b) =>
              (values.get(b) ?? 0) - (values.get(a) ?? 0) ||
              (BigInt(records.get(a)!.version) > BigInt(records.get(b)!.version) ? -1 : 1)
          );
        textNeedRanks = new Map([...needScores].map(([id, values]) => [id, order(values)]));
        textNeedScores = needScores;
        const chosen = coverageSelection(
          order(scores),
          needs.map((n) => ({ id: n.id, ranking: textNeedRanks.get(n.id) ?? [] })),
          32
        );
        return {
          records: chosen.map((id) => records.get(id)!),
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
      const vectorNeedRanks = new Map<string, string[]>();
      const vectorChannels: Array<{
        needId: string | null;
        query: string;
        status: "OK" | "UNAVAILABLE";
        ids: string[];
      }> = [];
      if (this.vectors) {
        try {
          vectorPending = await this.vectors.hasPending(input.scope);
        } catch {
          vectorError = true;
        }
        const requests = [
          { needId: null as string | null, query: input.text, limit: needs.length ? 8 : 32 },
          ...needs.map((n) => ({ needId: n.id, query: n.queries.join(" "), limit: 4 }))
        ];
        const values = await Promise.allSettled(
          requests.map((t) => this.vectors!.searchWithEvidence(input.scope!, t.query, t.limit))
        );
        for (const [i, value] of values.entries()) {
          const task = requests[i]!;
          if (value.status === "rejected") {
            vectorError = true;
            vectorChannels.push({ ...task, status: "UNAVAILABLE", ids: [] });
            continue;
          }
          vectorLimited ||= value.value.limited;
          vectorChannels.push({ ...task, status: "OK", ids: value.value.ids });
          indexedIds.push(...value.value.ids);
          if (task.needId) vectorNeedRanks.set(task.needId, value.value.ids);
        }
        indexedIds = [...new Set(indexedIds)].slice(0, 32);
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
      const ranked = [
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
        );
      const eligible = new Map(ranked.map((r) => [r.id, r]));
      const needRanks = needs.map((n) => {
        const text = textNeedRanks.get(n.id) ?? [],
          vector = vectorNeedRanks.get(n.id) ?? [];
        const ids = [...new Set([...text, ...vector])].filter((id) => eligible.has(id));
        const score = (id: string) =>
          (textNeedScores.get(n.id)?.get(id) ?? 0) +
          (vector.includes(id) ? 1 / (60 + vector.indexOf(id)) : 0);
        return { id: n.id, ranking: ids.sort((a, b) => score(b) - score(a) || a.localeCompare(b)) };
      });
      const selected = coverageSelection(
        ranked.map((r) => r.id),
        needRanks,
        input.limit ?? 8
      ).map((id) => eligible.get(id)!);
      const events = selected
        .map((r) => r.event)
        .filter((event) => matchesReader(event, input.access!));
      const coverage = needs.map((n) => {
        const candidates = needRanks.find((v) => v.id === n.id)!.ranking;
        const selectedIds = selected.filter((r) => candidates.includes(r.id)).map((r) => r.id);
        const preferredId = candidates[0] ?? null;
        const preferredSelected = preferredId !== null && selectedIds.includes(preferredId);
        return {
          id: n.id,
          quote: n.quote,
          candidateIds: candidates,
          selectedIds,
          preferredId,
          preferredSelected,
          status: preferredSelected
            ? ("SELECTED_CANDIDATE" as const)
            : candidates.length
              ? ("RESULT_BOUND" as const)
              : channels.some((c) => c.needId === n.id && c.status === "UNAVAILABLE") ||
                  vectorChannels.some((c) => c.needId === n.id && c.status === "UNAVAILABLE")
                ? ("CHANNEL_UNAVAILABLE" as const)
                : ("NO_AUTHORIZED_CANDIDATE" as const)
        };
      });
      const coverageLimited = coverage.some((n) => !n.preferredSelected);
      const outcome: MemoryRetrievalOutcome = {
        status:
          vectorError || textError
            ? events.length
              ? "partial"
              : "unavailable"
            : queryInputLimited ||
                coverageLimited ||
                planError ||
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
        ...(coverage.length ? { coverage } : {}),
        limited:
          queryInputLimited ||
          coverageLimited ||
          result.candidateLimited ||
          planError ||
          textError ||
          vectorError ||
          vectorPending ||
          vectorLimited ||
          compatibilityPending,
        limitReason: queryInputLimited
          ? "MEMORY_QUERY_INPUT_BOUND"
          : coverageLimited
            ? "MEMORY_DEMAND_COVERAGE_INCOMPLETE"
            : textError && vectorError
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
                        : lexicalPending
                          ? "MEMORY_LEXICAL_INDEX_PENDING"
                          : result.candidateLimited
                            ? "MEMORY_TEXT_CANDIDATE_BOUND"
                            : compatibilityPending
                              ? "MEMORY_LEGACY_OR_UNATTRIBUTED_REQUIRES_REVIEW"
                              : null,
        selectedCount: events.length,
        watermark: result.watermark
      };
      const candidateChosen = new Set(events.map((e) => e.id));
      if (this.assessSupport) {
        const supportNeeds = needs.length
          ? needs.map(({ id, quote }) => ({ id, quote }))
          : [{ id: "q0", quote: input.text.slice(0, 4000) }];
        const started = performance.now();
        try {
          outcome.evidenceSupport =
            queryInputLimited || outcome.status === "unavailable" || outcome.status === "error"
              ? unavailableEvidenceSupport(supportNeeds)
              : validateEvidenceSupport(
                  { request: input, needs: supportNeeds, events },
                  await this.assessSupport({ request: input, needs: supportNeeds, events })
                );
        } catch (error) {
          if (error instanceof MemoryAuthorityError && error.code.includes("AUTHORITY"))
            throw error;
          outcome.evidenceSupport = unavailableEvidenceSupport(
            supportNeeds,
            performance.now() - started
          );
        }
        const supported = new Set(
          outcome.evidenceSupport.needs
            .filter((n) => ["SUPPORTED", "CONTRADICTED"].includes(n.verdict))
            .flatMap((n) => n.citations.map((c) => c.id))
        );
        outcome.events = events.filter((e) => supported.has(e.id));
        outcome.selectedCount = outcome.events.length;
        if (
          outcome.evidenceSupport.needs.some(
            (n) => !["SUPPORTED", "CONTRADICTED"].includes(n.verdict)
          )
        ) {
          outcome.status = "partial";
          outcome.limited = true;
          outcome.limitReason ??=
            outcome.evidenceSupport.status === "UNAVAILABLE"
              ? "MEMORY_EVIDENCE_SUPPORT_UNAVAILABLE"
              : "MEMORY_EVIDENCE_INSUFFICIENT";
        }
      }
      const chosen = new Set(outcome.events.map((e) => e.id));
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
              : candidateChosen.has(r.id)
                ? "EVIDENCE_NOT_ESTABLISHED"
                : "RESULT_BOUND"
        }));
      outcome.retrievalId = await this.retrievalEvidence.record(input, outcome, {
        watermark: result.watermark,
        candidates,
        modelTag: this.vectors?.modelTag,
        queryPlan: {
          schema: "memory.search-plan.v1",
          originalQueryTruncated: queryInputLimited,
          status: this.expandQuery ? (planError ? "UNAVAILABLE" : "APPLIED") : "DISABLED",
          queries,
          model: plan?.model ?? null,
          usage: plan?.usage ?? null,
          channels,
          vectorChannels: vectorChannels.map((c) => ({
            ...c,
            ids: c.ids.filter((id) => eligible.has(id))
          })),
          ...(needs.length ? { coverage } : {}),
          ...(outcome.evidenceSupport ? { evidenceSupport: outcome.evidenceSupport } : {}),
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
