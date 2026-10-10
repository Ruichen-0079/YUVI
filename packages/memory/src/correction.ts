import { canonicalLineageJson } from "./lineage-encoding.js";
import { currentEligibleMemoryEvents, MEMORY_CLAIM_METADATA } from "./claim.js";
import { sameLegacyMemoryPartition } from "./scope.js";
import type { Memory, MemoryCandidate } from "./types.js";
import {
  canonicalEventDate,
  canonicalEventKey,
  normalizeContentForFingerprint
} from "./temporal.js";

export type EpisodicCorrectionSuggestion = {
  supersedes: string[];
  contradicts: string[];
  relatedMemoryIds: string[];
};

export function detectEpisodicCorrectionRelationships(
  candidate: MemoryCandidate,
  existingMemories: Memory[]
): EpisodicCorrectionSuggestion {
  if (!hasCorrectionRequest(candidate)) {
    return { supersedes: [], contradicts: [], relatedMemoryIds: [] };
  }

  const eventKey = canonicalEventKey(candidate);
  if (!eventKey) {
    return { supersedes: [], contradicts: [], relatedMemoryIds: [] };
  }

  const contentFingerprint = normalizeContentForFingerprint(candidate.content);
  const supersedes: string[] = [];
  const contradicts: string[] = [];
  const relatedMemoryIds: string[] = [];

  for (const memory of existingMemories) {
    if (memory.status !== "active") {
      continue;
    }
    if (!isCompatibleCorrectionScope(candidate, memory)) {
      continue;
    }

    const memoryCandidate = memoryToCandidate(memory);
    const memoryKey = canonicalEventKey(memoryCandidate);
    if (!memoryKey || memoryKey !== eventKey) {
      continue;
    }

    relatedMemoryIds.push(memory.id);
    const memoryFingerprint = normalizeContentForFingerprint(memory.content);
    if (memoryFingerprint === contentFingerprint) {
      continue;
    }

    if (isConflictingEpisodicFact(memory.content, candidate.content)) {
      supersedes.push(memory.id);
      contradicts.push(memory.id);
    }
  }

  return {
    supersedes: [...new Set(supersedes)],
    contradicts: [...new Set(contradicts)],
    relatedMemoryIds: [...new Set(relatedMemoryIds)]
  };
}

export function hasCorrectionRelatedMemory(
  relationships: {
    supersedes: string[];
    contradicts: string[];
    autoSupersedes: string[];
    correctionRelated?: string[];
  } | null
): boolean {
  if (!relationships) {
    return false;
  }
  return (
    relationships.supersedes.length > 0 ||
    relationships.contradicts.length > 0 ||
    relationships.autoSupersedes.length > 0 ||
    (relationships.correctionRelated?.length ?? 0) > 0
  );
}

function hasCorrectionRequest(candidate: MemoryCandidate): boolean {
  return Boolean(
    candidate.correctionRequested || candidate.metadata?.["correctionRequested"] === true
  );
}

function isCompatibleCorrectionScope(candidate: MemoryCandidate, memory: Memory): boolean {
  if (!sameLegacyMemoryPartition(candidate, memory)) return false;
  if ((candidate.scope ?? "user") !== memory.scope) {
    return false;
  }
  return (candidate.scopeId ?? "") === (memory.scopeId ?? "");
}

function isConflictingEpisodicFact(left: string, right: string): boolean {
  const leftFp = normalizeContentForFingerprint(left);
  const rightFp = normalizeContentForFingerprint(right);
  if (leftFp === rightFp) {
    return false;
  }
  return /(没吃|未吃|不吃|skipped|no breakfast|吃|bread|面包|蛋糕|meal|breakfast)/iu.test(
    `${left} ${right}`
  );
}

function memoryToCandidate(memory: Memory): MemoryCandidate {
  return {
    type: memory.type,
    subtype: memory.subtype,
    scope: memory.scope,
    scopeId: memory.scopeId,
    content: memory.content,
    importance: memory.importance,
    tags: memory.tags,
    reason: typeof memory.metadata?.["reason"] === "string" ? memory.metadata["reason"] : "",
    subjectUserId: memory.subjectUserId ?? null,
    personaId: memory.personaId ?? null,
    eventTime: memory.eventTime?.toISOString() ?? null,
    validFrom: memory.validFrom.toISOString(),
    validUntil: memory.validUntil?.toISOString() ?? null,
    metadata: memory.metadata
  };
}

/** Corrections invalidate dependent derived evidence, never the original Journal. */
export function currentCorrectedMemoryEvents(
  events: readonly import("./provider.js").MemoryEvent[]
): import("./provider.js").MemoryEvent[] {
  const superseded = new Set<string>();
  for (const event of events) {
    if (event.kind !== "correction") continue;
    const ids = event.metadata[MEMORY_CLAIM_METADATA.supersedes];
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") superseded.add(id);
  }
  const retiredRoots = new Set<string>();
  for (const event of events) {
    if (!superseded.has(event.id) || event.lineage?.state !== "GROUNDED") continue;
    for (const parent of event.lineage.parents) retiredRoots.add(canonicalLineageJson(parent.ref));
  }
  return currentEligibleMemoryEvents(events).filter(
    (event) =>
      event.lineage?.state !== "GROUNDED" ||
      event.lineage.origin !== "DERIVED" ||
      !event.lineage.parents.some((parent) => retiredRoots.has(canonicalLineageJson(parent.ref)))
  );
}
