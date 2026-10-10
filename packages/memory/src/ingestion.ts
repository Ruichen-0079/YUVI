import type { GroundedMemorySource } from "./lineage.js";
import { admitDurableMemoryClaim, serializeClaimMetadata } from "./claim.js";
import type {
  MemoryClaimAttributionInput,
  MemoryEventKind,
  MemoryWriteEventInput
} from "./provider.js";
import type { MemoryCandidate, MemoryExtractor } from "./types.js";
import { classifyMem0Turn, type Mem0TurnKind } from "./mem0-chat.js";
import { stripExplicitRememberPrefix } from "./intent.js";
import { RuleBasedMemoryExtractor, isNonAssertiveMemoryInput } from "./extractor.js";
import { MEMORY_CLAIM_METADATA } from "./claim.js";
import type { MemoryEvent } from "./provider.js";

export type MemoryIngestionInput = {
  userMessage: string;
  assistantMessage?: string | null | undefined;
  scope: string;
  sessionId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  userMessageId?: string | null | undefined;
  assistantMessageId?: string | null | undefined;
  traceId?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  conversationId?: string | null | undefined;
  language?: string | null | undefined;
  observedAt?: string | undefined;
  cancelledOrFailed?: boolean | undefined;
  turnKind?: Mem0TurnKind | undefined;
  claim?: MemoryClaimAttributionInput | undefined;
  /** Host authority; compatibility subjectUserId remains storage scope only. */
  groundedSource?: GroundedMemorySource | undefined;
};

export type MemoryIngestionResult = {
  turnKind: Mem0TurnKind;
  events: MemoryWriteEventInput[];
  skippedReason?: string | undefined;
};

/**
 * Deterministic boundary between a completed conversation turn and semantic
 * memory evidence. Only user-grounded candidates become events; assistant
 * prose is context and never a source of long-term memory.
 */
export class MemoryIngestionPolicy {
  constructor(
    private readonly extractor: MemoryExtractor = new RuleBasedMemoryExtractor(),
    private readonly readPrior?: (scope: string) => Promise<MemoryEvent[]>
  ) {}

  ingest(input: MemoryIngestionInput): Promise<MemoryIngestionResult> {
    return this.build(input);
  }

  async build(input: MemoryIngestionInput): Promise<MemoryIngestionResult> {
    const userMessage = normalize(input.userMessage);
    const assistantMessage = normalize(input.assistantMessage ?? "");
    const turnKind =
      input.turnKind ??
      classifyMem0Turn({
        userMessage,
        assistantMessage,
        cancelledOrFailed: input.cancelledOrFailed
      });

    if (turnKind === "cancelled_or_failed") {
      return { turnKind, events: [], skippedReason: "cancelled-or-failed" };
    }
    if (input.claim) {
      return this.buildAttributed(input, turnKind);
    }
    if (turnKind === "explicit_forget") {
      return { turnKind, events: [], skippedReason: "explicit-forget-skips-add" };
    }
    if (input.groundedSource && isNonAssertiveMemoryInput(userMessage)) {
      return { turnKind, events: [], skippedReason: "non-assertive-source" };
    }
    if (
      input.groundedSource &&
      this.extractor.getStatus?.().mode === "llm" &&
      this.extractor.getStatus?.().enabled
    ) {
      const prior = this.readPrior ? await this.readPrior(input.scope) : [];
      const candidates = await this.extractor.extractCandidates({
        userMessage: input.userMessage,
        assistantMessage,
        groundedSource: input.groundedSource,
        priorEvents: prior,
        memoryScope: input.scope,
        sourceTraceId: input.traceId,
        timestamp: input.observedAt,
        personaId: input.personaId,
        subjectUserId: input.subjectUserId
      });
      const events = dedupeEvents(
        candidates
          .filter(isFactualCandidate)
          .map((candidate) => this.eventForCandidate(candidate, input))
          .filter((event): event is MemoryWriteEventInput => event !== null)
      );
      const status = this.extractor.getStatus?.();
      if (status?.error) return { turnKind, events: [], skippedReason: status.error };
      return {
        turnKind,
        events,
        ...(events.length
          ? {}
          : {
              skippedReason: status?.error ?? status?.skippedReason ?? "no-factual-memory"
            })
      };
    }
    if (turnKind === "normal" && !assistantMessage) {
      return { turnKind, events: [], skippedReason: "empty-assistant" };
    }
    if (turnKind === "explicit_remember") {
      if (!assistantMessage) {
        return {
          turnKind,
          events: [],
          skippedReason: "explicit-remember-requires-assistant"
        };
      }
      const claim = stripExplicitRememberPrefix(userMessage) || userMessage;
      const event = this.eventForClaim(claim, input, {
        explicit: true,
        sourceReason: "explicit-remember"
      });
      return {
        turnKind,
        events: event ? [event] : [],
        ...(event ? {} : { skippedReason: "unresolved-identity" })
      };
    }

    // Relationship-duration statements are evidence of what the user claims,
    // not authoritative relationship state.
    if (isUserClaimStatement(userMessage)) {
      const event = this.eventForClaim(userMessage, input, {
        explicit: false,
        sourceReason: "user-claim"
      });
      return {
        turnKind,
        events: event ? [event] : [],
        ...(event ? {} : { skippedReason: "unresolved-identity" })
      };
    }

    const candidates = await this.extractor.extractCandidates({
      userMessage,
      assistantMessage,
      sourceTraceId: input.traceId ?? null,
      timestamp: input.observedAt,
      personaId: input.personaId,
      subjectUserId: input.subjectUserId,
      sessionId: input.sessionId
    });
    const events = dedupeEvents(
      candidates
        .filter(isFactualCandidate)
        .map((candidate) => this.eventForCandidate(candidate, input))
        .filter((event): event is MemoryWriteEventInput => event !== null)
    );
    if (events.length === 0 && isSimpleFactualUserStatement(userMessage)) {
      const fact = this.eventForFact(userMessage, input);
      if (fact) events.push(fact);
    }
    return {
      turnKind,
      events,
      ...(events.length === 0 ? { skippedReason: "no-factual-memory" } : {})
    };
  }

  private buildAttributed(
    input: MemoryIngestionInput,
    turnKind: Mem0TurnKind
  ): MemoryIngestionResult {
    const claimInput = input.claim!;
    const admitted = admitDurableMemoryClaim({
      ...claimInput,
      ...(claimInput.content
        ? { content: claimInput.content }
        : claimInput.rawText
          ? {}
          : { content: normalize(input.userMessage) }),
      rawText: claimInput.rawText ?? input.userMessage
    });
    if (admitted.decision === "reject") {
      return { turnKind, events: [], skippedReason: admitted.reason };
    }
    const kind: MemoryEventKind =
      admitted.claim.provenanceClass === "ASSISTANT_INFERENCE"
        ? "fact"
        : admitted.claim.provenanceClass === "DIRECT_OBSERVATION"
          ? "interaction"
          : "user_claim";
    const participants = claimInput.participants?.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
    const event = this.applyClaim(
      {
        kind,
        content: admitted.content,
        scope: input.scope,
        ...(input.observedAt ? { observedAt: input.observedAt } : {}),
        ...(input.userMessageId ? { sourceTurnIds: [input.userMessageId] } : {}),
        ...(input.conversationId !== undefined
          ? { conversationId: input.conversationId }
          : input.sessionId !== undefined
            ? { conversationId: input.sessionId }
            : {}),
        ...(participants && participants.length > 0
          ? { participants }
          : input.subjectUserId || input.personaId
            ? {
                participants: [
                  ...(input.subjectUserId ? [input.subjectUserId] : []),
                  ...(input.personaId ? [input.personaId] : [])
                ]
              }
            : {}),
        assertion: admitted.assertion,
        metadata: buildEventMetadata(input, {
          memoryType: kind,
          explicit: false,
          ingestionReason: `claim:${admitted.claim.provenanceClass}`
        }),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      },
      admitted
    );
    return { turnKind, events: [event] };
  }

  private eventForClaim(
    claim: string,
    input: MemoryIngestionInput,
    options: { explicit: boolean; sourceReason: string }
  ): MemoryWriteEventInput | null {
    const content = canonicalizeUserClaim(claim);
    const event: MemoryWriteEventInput = {
      kind: "user_claim",
      content,
      scope: input.scope,
      ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      ...(input.userMessageId ? { sourceTurnIds: [input.userMessageId] } : {}),
      ...(input.conversationId !== undefined
        ? { conversationId: input.conversationId }
        : input.sessionId !== undefined
          ? { conversationId: input.sessionId }
          : {}),
      ...(input.subjectUserId || input.personaId
        ? {
            participants: [
              ...(input.subjectUserId ? [input.subjectUserId] : []),
              ...(input.personaId ? [input.personaId] : [])
            ]
          }
        : {}),
      assertion: { source: "user", verification: "unverified" },
      metadata: buildEventMetadata(input, {
        memoryType: "user_claim",
        explicit: options.explicit,
        ingestionReason: options.sourceReason
      }),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
    };
    return this.applyDefaultClaim(event, input);
  }

  private eventForCandidate(
    candidate: MemoryCandidate,
    input: MemoryIngestionInput
  ): MemoryWriteEventInput | null {
    const kind: MemoryEventKind = candidate.correctionRequested
      ? "correction"
      : candidate.type === "episodic"
        ? "episodic"
        : "fact";
    const observedAt = toTimestamp(candidate.observedAt);
    const occurredAt = toTimestamp(candidate.eventTime);
    const event: MemoryWriteEventInput = {
      kind,
      content: normalize(candidate.content),
      scope: input.scope,
      ...(observedAt !== undefined ? { observedAt } : {}),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
      ...(input.userMessageId ? { sourceTurnIds: [input.userMessageId] } : {}),
      ...(input.conversationId !== undefined
        ? { conversationId: input.conversationId }
        : input.sessionId !== undefined
          ? { conversationId: input.sessionId }
          : {}),
      ...(input.subjectUserId || input.personaId
        ? {
            participants: [
              ...(input.subjectUserId ? [input.subjectUserId] : []),
              ...(input.personaId ? [input.personaId] : [])
            ]
          }
        : {}),
      assertion: { source: "user", verification: "unverified" },
      metadata: buildEventMetadata(input, {
        memoryType: kind,
        explicit: false,
        ingestionReason: candidate.reason,
        ...(candidate.subtype ? { memorySubtype: candidate.subtype } : {})
      }),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
    };
    if (candidate.metadata?.["generatedBy"] === "source-selected-semantic-extraction") {
      const ids = candidate.metadata[MEMORY_CLAIM_METADATA.supersedes];
      if (candidate.correctionRequested && Array.isArray(ids))
        event.supersedes = ids.filter((id): id is string => typeof id === "string");
      event.metadata = {
        ...event.metadata,
        correctionReason: candidate.correctionRequested ? "explicit-user-source-correction" : null,
        extractionMethod: "source-selected-semantic-extraction"
      };
    }
    return this.applyDefaultClaim(event, input);
  }

  private eventForFact(text: string, input: MemoryIngestionInput): MemoryWriteEventInput | null {
    const event: MemoryWriteEventInput = {
      kind: "fact",
      content: normalize(text),
      scope: input.scope,
      ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      ...(input.userMessageId ? { sourceTurnIds: [input.userMessageId] } : {}),
      ...(input.conversationId !== undefined
        ? { conversationId: input.conversationId }
        : input.sessionId !== undefined
          ? { conversationId: input.sessionId }
          : {}),
      ...(input.subjectUserId || input.personaId
        ? {
            participants: [
              ...(input.subjectUserId ? [input.subjectUserId] : []),
              ...(input.personaId ? [input.personaId] : [])
            ]
          }
        : {}),
      assertion: { source: "user", verification: "unverified" },
      metadata: buildEventMetadata(input, {
        memoryType: "fact",
        explicit: false,
        ingestionReason: "stable-user-fact"
      }),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
    };
    return this.applyDefaultClaim(event, input);
  }

  private applyDefaultClaim(
    event: MemoryWriteEventInput,
    input: MemoryIngestionInput
  ): MemoryWriteEventInput | null {
    if (input.groundedSource) return event;
    const subjectId = input.subjectUserId?.trim();
    if (!subjectId) return event;
    const admitted = admitDurableMemoryClaim({
      provenanceClass: "SELF_REPORT",
      content: event.content,
      rawText: input.userMessage,
      assertor: { entityId: subjectId, resolution: "resolved" },
      subject: { entityId: subjectId, resolution: "resolved" }
    });
    if (admitted.decision === "reject") return null;
    return this.applyClaim(event, admitted);
  }

  private applyClaim(
    event: MemoryWriteEventInput,
    admitted: Extract<ReturnType<typeof admitDurableMemoryClaim>, { decision: "admit" }>
  ): MemoryWriteEventInput {
    return {
      ...event,
      assertion: admitted.assertion,
      claim: admitted.claim,
      metadata: {
        ...(event.metadata ?? {}),
        ...serializeClaimMetadata(admitted.claim)
      }
    };
  }
}

function buildEventMetadata(
  input: MemoryIngestionInput,
  values: {
    memoryType: string;
    explicit: boolean;
    ingestionReason: string;
    memorySubtype?: string;
  }
): Record<string, unknown> {
  return {
    source: "yuvi",
    sourceRole: "user",
    userId: input.subjectUserId ?? null,
    characterId: input.personaId ?? null,
    conversationId: input.conversationId ?? input.sessionId ?? null,
    sourceMessageId: input.userMessageId ?? null,
    sourceTraceId: input.traceId ?? null,
    ...(input.idempotencyKey ? { yuviIngestionKey: input.idempotencyKey } : {}),
    assistantMessageId: input.assistantMessageId ?? null,
    memoryType: values.memoryType,
    explicit: values.explicit,
    ingestionPolicy: "factual-v1",
    ingestionReason: values.ingestionReason,
    ...(values.memorySubtype ? { memorySubtype: values.memorySubtype } : {}),
    language: input.language ?? null,
    schemaVersion: 1
  };
}

function isFactualCandidate(candidate: MemoryCandidate): boolean {
  if (!candidate.content.trim()) return false;
  if (candidate.originRole === "assistant" || candidate.originRole === "mixed") return false;
  // These are interpretations/state claims, not factual evidence for Mem0.
  return candidate.type !== "relationship" && candidate.type !== "emotional";
}

function isUserClaimStatement(text: string): boolean {
  return /^(?:我们(?:认识|见过|一起|的关系)|we(?:'ve| have)?\s+(?:known|met|been together)|our relationship)/iu.test(
    text
  );
}

function isSimpleFactualUserStatement(text: string): boolean {
  return /^(?:我|我的|i\b|i'm\b|i am\b|my\b).*(?:喜欢|不喜欢|通常|经常|总是|偏好|过敏|住在|来自|工作|prefer|usually|often|always|allerg|live\s+in|work\s+at)/iu.test(
    text
  );
}

export function canonicalizeUserClaim(value: string): string {
  const text = normalize(value);
  if (!text) return "";
  if (/^我们/iu.test(text)) {
    return `用户称双方${text.slice(2)}`;
  }
  if (/^我的/iu.test(text)) {
    return `用户的${text.slice(2)}`;
  }
  if (/^我/iu.test(text)) {
    return `用户${text.slice(1)}`;
  }
  if (/^(?:i|my)\b/iu.test(text)) {
    return `User claims: ${text}`;
  }
  return `用户称：${text}`;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toTimestamp(value: Date | string | null | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function dedupeEvents(events: MemoryWriteEventInput[]): MemoryWriteEventInput[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = event.content.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
