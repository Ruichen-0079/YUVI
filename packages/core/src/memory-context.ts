import type { MemoryEvent, MemoryRetrievalOutcome, MemoryRetrievalStatus } from "@companion/memory";
import type { RetrievedMemoryForPrompt } from "@companion/prompt-builder";

/**
 * Prompt-facing projection of canonical evidence.
 *
 * The extra provenance fields are intentionally diagnostic-only. PromptBuilder
 * consumes the structural RetrievedMemoryForPrompt subset and never receives
 * raw backend records or semantic metadata.
 */
export type PromptMemoryCompatibility = RetrievedMemoryForPrompt & {
  provenanceId: string;
  source: string;
  sourceRecordId: string;
};

export type MemoryContextDropReason =
  | "missing-id"
  | "missing-source"
  | "missing-record-id"
  | "empty-content"
  | "current_turn_echo"
  | "direct_context_echo"
  | "duplicate_memory";

export type MemoryContextDrop = {
  id: string;
  reason: MemoryContextDropReason;
  source?: string | undefined;
};

export type MemoryContextBuildOptions = {
  currentTurnText?: string | undefined;
  directContextText?: string | undefined;
};

export function deterministicMemoryEchoReason(
  value: string,
  options: MemoryContextBuildOptions
): "current_turn_echo" | "direct_context_echo" | undefined {
  if (isDeterministicEcho(value, options.currentTurnText)) return "current_turn_echo";
  if (isDeterministicEcho(value, options.directContextText)) return "direct_context_echo";
  return undefined;
}

export function normalizeMemoryTextForDedupe(value: string): string {
  return normalizeForDedupe(value);
}

export type MemoryContextDiagnostics = {
  coverage?: MemoryRetrievalOutcome["coverage"];
  selectedCount: number;
  droppedCount: number;
  droppedReasons?: Partial<Record<MemoryContextDropReason, number>>;
  dropped?: MemoryContextDrop[];
  retrievalStatus?: MemoryRetrievalStatus;
  retrievalErrorCode?: string | null;
  providerSource?: string;
  rawCount?: number;
  eventCount?: number;
  limited?: boolean;
  eventIds?: string[];
  metadataPresent?: boolean;
  sourceTurnLinkCount?: number;
  conversationLinked?: boolean;
  participantsCount?: number;
};

export type MemoryContext = {
  /** Canonical events retained for diagnostics and future Runtime wiring. */
  events: MemoryEvent[];
  /** Objects structurally accepted by the existing PromptBuilder input. */
  promptMemories: PromptMemoryCompatibility[];
  diagnostics: MemoryContextDiagnostics;
};

export type MemoryContextInput = MemoryEvent[] | MemoryRetrievalOutcome;

/**
 * Compatibility boundary between semantic evidence and the existing prompt
 * contract. It deliberately does not implement retrieval, ranking, prompt
 * formatting, or token budgeting; those remain in their current owners.
 */
export class MemoryContextBuilder {
  build(input: MemoryContextInput, options: MemoryContextBuildOptions = {}): MemoryContext {
    const outcome = Array.isArray(input) ? undefined : input;
    const sourceEvents = Array.isArray(input) ? input : input.events;
    const events: MemoryEvent[] = [];
    const promptMemories: PromptMemoryCompatibility[] = [];
    const droppedReasons: Partial<Record<MemoryContextDropReason, number>> = {};
    const dropped: MemoryContextDrop[] = [];
    const seenMemoryKeys = new Set<string>();
    let droppedCount = 0;

    const recordDrop = (event: MemoryEvent, reason: MemoryContextDropReason): void => {
      droppedCount += 1;
      droppedReasons[reason] = (droppedReasons[reason] ?? 0) + 1;
      if (event.id?.trim()) {
        dropped.push({
          id: event.id,
          reason,
          ...(event.source ? { source: event.source } : {})
        });
      }
    };

    for (const event of sourceEvents) {
      const reason = invalidEventReason(event);
      if (reason) {
        recordDrop(event, reason);
        continue;
      }

      events.push(event);
      const promptMemory = toPromptMemoryCompatibility(event);
      const normalizedMemory = normalizeForDedupe(event.content);
      if (seenMemoryKeys.has(normalizedMemory)) {
        recordDrop(event, "duplicate_memory");
        continue;
      }
      seenMemoryKeys.add(normalizedMemory);

      if (isDeterministicEcho(event.content, options.currentTurnText)) {
        recordDrop(event, "current_turn_echo");
        continue;
      }
      if (isDeterministicEcho(event.content, options.directContextText)) {
        recordDrop(event, "direct_context_echo");
        continue;
      }
      promptMemories.push(promptMemory);
    }

    const diagnostics: MemoryContextDiagnostics = {
      selectedCount: promptMemories.length,
      droppedCount,
      ...(Object.keys(droppedReasons).length > 0 ? { droppedReasons } : {}),
      ...(dropped.length > 0 ? { dropped } : {}),
      ...(outcome
        ? {
            retrievalStatus: outcome.status,
            ...(outcome.coverage ? { coverage: outcome.coverage } : {}),
            retrievalErrorCode: outcome.errorCode ?? null,
            providerSource: outcome.source,
            rawCount: outcome.rawCount ?? sourceEvents.length,
            eventCount: events.length,
            limited: outcome.limited,
            eventIds: events.map((event) => event.id),
            metadataPresent: events.some((event) => Object.keys(event.metadata).length > 0),
            sourceTurnLinkCount: events.reduce(
              (count, event) => count + (event.sourceTurnIds?.length ?? 0),
              0
            ),
            conversationLinked: events.some((event) => Boolean(event.conversationId)),
            participantsCount: events.reduce(
              (count, event) => count + (event.participants?.length ?? 0),
              0
            )
          }
        : {})
    };
    return {
      events,
      promptMemories,
      diagnostics
    };
  }
}

function toPromptMemoryCompatibility(event: MemoryEvent): PromptMemoryCompatibility {
  const content = event.content.trim();
  return {
    content,
    displayText: content,
    provenanceId: event.id,
    source: event.source,
    sourceRecordId: event.sourceRecordId
  };
}

function invalidEventReason(event: MemoryEvent): MemoryContextDropReason | undefined {
  if (!event.id?.trim()) return "missing-id";
  if (!event.source?.trim()) return "missing-source";
  if (!event.sourceRecordId?.trim()) return "missing-record-id";
  if (!event.content?.trim()) return "empty-content";
  return undefined;
}

function isDeterministicEcho(value: string, reference: string | undefined): boolean {
  if (!reference?.trim()) return false;
  if (reference.includes("\n")) {
    return reference.split(/\r?\n/u).some((line) => isDeterministicEcho(value, line));
  }
  const candidate = normalizeForDedupe(value);
  const normalizedReference = normalizeForDedupe(reference);
  if (!candidate || !normalizedReference) return false;
  if (candidate === normalizedReference) return true;

  const shorter = candidate.length <= normalizedReference.length ? candidate : normalizedReference;
  const longer = candidate.length > normalizedReference.length ? candidate : normalizedReference;
  if (shorter.length < 4) return false;
  const lengthDelta = longer.length - shorter.length;
  const allowedDelta = Math.max(12, Math.floor(shorter.length * 0.5));
  return lengthDelta <= allowedDelta && longer.includes(shorter);
}

function normalizeForDedupe(value: string): string {
  let normalized = value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  normalized = normalized
    .replace(/^用户(?:称|说)?\s*[:：]?/u, "我")
    .replace(/^user\s+claims?\s*:\s*/iu, "i ");
  return normalized.replace(/[\p{P}\p{S}\s]/gu, "");
}
