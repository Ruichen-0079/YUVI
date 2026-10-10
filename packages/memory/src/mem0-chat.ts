/**
 * Chat-path helpers for Mem0 long-term memory (read/write/forget).
 * Keeps Prompt injection free of memoryId / score / raw metadata leakage via displayText.
 */

import type { MemoryBackend, MemorySearchResult } from "./backend.js";
import { detectExplicitForgetRequest, detectExplicitRememberRequest } from "./intent.js";
import { buildMemoryScope } from "./scope.js";
import type { Memory, MemoryRetrievalResult, RetrievedMemoryDebug } from "./types.js";

export const MEM0_CHAT_SEARCH_TOP_K = 8;
export const MEM0_CHAT_PROMPT_MAX = 5;
/** Approximate token budget for memory narrative (~4 chars/token). */
export const MEM0_CHAT_PROMPT_TOKEN_BUDGET = 600;
export const MEM0_CHAT_PROMPT_CHAR_BUDGET = MEM0_CHAT_PROMPT_TOKEN_BUDGET * 4;
/** Default search timeout for chat path (ms). */
export const MEM0_CHAT_SEARCH_TIMEOUT_MS = 600;
/**
 * Background write timeout (ms).
 * Semantic ingestion writes are issued through MemoryProvider; this bounds the
 * asynchronous provider write without blocking the chat response.
 */
export const MEM0_CHAT_WRITE_TIMEOUT_MS = 180_000;
/** Minimum score for explicit forget candidates (when score present). */
export const MEM0_FORGET_MIN_SCORE = 0.35;
export const MEM0_FORGET_MAX_DELETE = 5;

export type Mem0ChatIdentity = {
  userId: string;
  characterId: string;
};

/** Stable skip code when Mem0 cannot build a user×character scope. */
export const MEMORY_SCOPE_MISSING = "MEMORY_SCOPE_MISSING";

export type Mem0IdentityResolution =
  | { ok: true; identity: Mem0ChatIdentity }
  | { ok: false; code: typeof MEMORY_SCOPE_MISSING; missing: Array<"subjectUserId" | "personaId"> };

/**
 * Resolve Mem0 chat identity without silent default-user / default-persona.
 * Callers must pass explicit IDs (request and/or configured local single-user env).
 */
export function resolveMem0ChatIdentity(input: {
  subjectUserId?: string | null | undefined;
  personaId?: string | null | undefined;
}): Mem0IdentityResolution {
  const userId = typeof input.subjectUserId === "string" ? input.subjectUserId.trim() : "";
  const characterId = typeof input.personaId === "string" ? input.personaId.trim() : "";
  const missing: Array<"subjectUserId" | "personaId"> = [];
  if (!userId) missing.push("subjectUserId");
  if (!characterId) missing.push("personaId");
  if (missing.length > 0) {
    return { ok: false, code: MEMORY_SCOPE_MISSING, missing };
  }
  return {
    ok: true,
    identity: {
      userId: userId.slice(0, 200),
      characterId: characterId.slice(0, 200)
    }
  };
}

export type Mem0TurnKind =
  | "normal"
  | "explicit_remember"
  | "explicit_forget"
  | "cancelled_or_failed";

/**
 * Classify a chat turn for Mem0 write routing.
 * explicit_forget/remember take precedence over normal factual ingestion.
 */
export function classifyMem0Turn(input: {
  userMessage: string;
  assistantMessage?: string | null | undefined;
  cancelledOrFailed?: boolean | undefined;
}): Mem0TurnKind {
  if (input.cancelledOrFailed) {
    return "cancelled_or_failed";
  }
  const user = (input.userMessage ?? "").trim();
  const assistant = (input.assistantMessage ?? "").trim();
  if (!user) {
    return "cancelled_or_failed";
  }
  if (detectExplicitForgetRequest(user)) {
    return "explicit_forget";
  }
  if (detectExplicitRememberRequest(user)) {
    // Explicit remember may still require an assistant ack, but the write path
    // is one user-claim event only (never an assistant-inferred turn).
    return "explicit_remember";
  }
  if (!assistant) {
    return "cancelled_or_failed";
  }
  return "normal";
}

export function buildChatMemoryScope(identity: Mem0ChatIdentity): string {
  return buildMemoryScope(identity.userId, identity.characterId);
}

export function dedupeSearchResults(items: MemorySearchResult[]): MemorySearchResult[] {
  const seen = new Set<string>();
  const out: MemorySearchResult[] = [];
  for (const item of items) {
    const content = (item.content ?? "").trim();
    if (!content) continue;
    const key = content.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function selectPromptMemories(
  items: MemorySearchResult[],
  options: { maxItems?: number; charBudget?: number } = {}
): MemorySearchResult[] {
  const maxItems = options.maxItems ?? MEM0_CHAT_PROMPT_MAX;
  const charBudget = options.charBudget ?? MEM0_CHAT_PROMPT_CHAR_BUDGET;
  const ranked = dedupeSearchResults(items).slice(0, MEM0_CHAT_SEARCH_TOP_K);
  const selected: MemorySearchResult[] = [];
  let used = 0;
  for (const item of ranked) {
    if (selected.length >= maxItems) break;
    const text = item.content.trim();
    if (!text) continue;
    const cost = text.length + 4;
    if (selected.length > 0 && used + cost > charBudget) break;
    selected.push(item);
    used += cost;
  }
  return selected;
}

/** Map Mem0 hits to prompt-safe debug memories (displayText is content only). */
export function toPromptMemoryDebug(item: MemorySearchResult): RetrievedMemoryDebug {
  const content = item.content.trim();
  const createdAt = item.createdAt ? new Date(item.createdAt) : new Date();
  const score = typeof item.score === "number" ? clamp01(item.score) : 0.7;
  const debug: RetrievedMemoryDebug = {
    id: item.id,
    type: "semantic",
    subtype: "fact",
    scope: "user",
    scopeId: null,
    memoryLayer: "recall",
    status: "active",
    source: "mem0",
    sourceTraceId: null,
    metadata: {},
    importance: score,
    createdAt,
    observedAt: createdAt,
    eventTime: null,
    validFrom: createdAt,
    validUntil: null,
    expiresAt: null,
    displayText: content,
    matchedBy: "vector",
    retrievalMode: "postgres-vector",
    hasEmbedding: true,
    semanticEmbedding: true,
    score,
    vectorScore: score
  };
  return debug;
}

export function toSelectedMemory(item: MemorySearchResult): Memory {
  const createdAt = item.createdAt ? new Date(item.createdAt) : new Date();
  return {
    id: item.id,
    type: "semantic",
    subtype: "fact",
    scope: "user",
    scopeId: null,
    memoryLayer: "recall",
    status: "active",
    content: item.content.trim(),
    summary: item.content.trim(),
    embedding: null,
    embeddingModel: null,
    embeddingProvider: null,
    embeddingDimensions: null,
    embeddedAt: null,
    importance: typeof item.score === "number" ? clamp01(item.score) : 0.7,
    emotionValence: 0,
    emotionArousal: 0,
    source: "mem0",
    sourceTraceId: null,
    metadata: {},
    tags: [],
    createdAt,
    updatedAt: createdAt,
    observedAt: createdAt,
    eventTime: null,
    validFrom: createdAt,
    validUntil: null,
    expiresAt: null,
    supersededAt: null,
    supersedes: [],
    supersededBy: null,
    contradicts: [],
    lastAccessedAt: createdAt
  };
}

export function emptyMem0RetrievalResult(query = ""): MemoryRetrievalResult {
  return {
    query,
    keywords: [],
    rawCount: 0,
    count: 0,
    retrievalMode: "postgres-vector",
    vectorEnabled: true,
    vectorUsed: false,
    embeddingProvider: "mem0-ollama",
    embeddingModel: "yuvi-embedding:0.6b",
    embeddingDimensions: 1024,
    semanticEmbedding: true,
    embeddingNote: "mem0-backend",
    queryEmbeddingGenerated: false,
    vectorResultCount: 0,
    keywordResultCount: 0,
    hybridResultCount: 0,
    fallbackUsed: false,
    retrievalScope: "user",
    includedScopes: [{ scope: "user", scopeId: null }],
    includeArchived: false,
    includeSuperseded: false,
    includeExpired: false,
    currentTime: new Date().toISOString(),
    excludedByStatus: 0,
    excludedByTime: 0,
    excludedByScope: 0,
    rawMemories: [],
    memories: [],
    selectedMemories: []
  };
}

export function buildMem0RetrievalResult(
  query: string,
  raw: MemorySearchResult[],
  selected: MemorySearchResult[]
): MemoryRetrievalResult {
  const rawDebug = raw.map(toPromptMemoryDebug);
  const selectedDebug = selected.map(toPromptMemoryDebug);
  return {
    ...emptyMem0RetrievalResult(query),
    rawCount: raw.length,
    count: selected.length,
    vectorUsed: raw.length > 0,
    queryEmbeddingGenerated: true,
    vectorResultCount: raw.length,
    hybridResultCount: selected.length,
    rawMemories: rawDebug,
    memories: selectedDebug,
    selectedMemories: selected.map(toSelectedMemory)
  };
}

export type ForgetMemoriesResult = {
  status:
    | "DELETED"
    | "NOT_FOUND"
    | "FAILED"
    | "PARTIAL"
    | "UNKNOWN"
    | "CANCELLED"
    | "CONFIRMATION_REQUIRED"
    | "SCOPE_REQUIRED";
  unknownMemoryIds?: string[];
  deleted: number;
  notFound: boolean;
  memoryIds: string[];
  query: string;
};

export async function forgetMemoriesInScope(
  backend: MemoryBackend,
  input: {
    scope: string;
    query: string;
    signal?: AbortSignal;
    minScore?: number;
    maxDelete?: number;
  }
): Promise<ForgetMemoriesResult> {
  const query = input.query.trim();
  const result = (
    status: ForgetMemoriesResult["status"],
    memoryIds: string[] = [],
    unknownMemoryIds: string[] = []
  ): ForgetMemoriesResult => ({
    status,
    deleted: memoryIds.length,
    notFound: status === "NOT_FOUND",
    memoryIds,
    query,
    ...(unknownMemoryIds.length ? { unknownMemoryIds } : {})
  });
  if (!query || !input.scope.trim()) return result("FAILED");
  if (input.signal?.aborted) return result("CANCELLED");
  const queryTokens = tokenizeForForget(query);
  let candidates: MemorySearchResult[];
  try {
    const hits = await backend.search(
      { scope: input.scope, query, limit: MEM0_CHAT_SEARCH_TOP_K },
      input.signal
    );
    candidates = dedupeSearchResults(hits).filter(
      (item) => item.scope === input.scope && contentOverlapsQuery(item.content, queryTokens)
    );
    if (candidates.length === 0) {
      const listed = await backend.list({ scope: input.scope, limit: 50, offset: 0 }, input.signal);
      candidates = dedupeSearchResults(
        listed.items.map((item) => ({ ...item, score: item.score ?? 0.5 }))
      ).filter(
        (item) => item.scope === input.scope && contentOverlapsQuery(item.content, queryTokens)
      );
    }
  } catch {
    return result(input.signal?.aborted ? "CANCELLED" : "FAILED");
  }
  if (input.signal?.aborted) return result("CANCELLED");
  candidates = candidates
    .sort(
      (a, b) =>
        overlapCount(b.content, queryTokens) - overlapCount(a.content, queryTokens) ||
        (b.score ?? 0) - (a.score ?? 0)
    )
    .slice(0, input.maxDelete ?? MEM0_FORGET_MAX_DELETE);
  if (!candidates.length) return result("NOT_FOUND");
  const deletedIds: string[] = [],
    unknownIds: string[] = [];
  for (const item of candidates) {
    if (input.signal?.aborted)
      return result(
        deletedIds.length || unknownIds.length ? "PARTIAL" : "CANCELLED",
        deletedIds,
        unknownIds
      );
    try {
      await backend.delete({ memoryId: item.id, scope: input.scope }, input.signal);
      deletedIds.push(item.id);
    } catch {
      // Transport failure cannot prove that a dispatched delete did not happen.
      unknownIds.push(item.id);
    }
  }
  return result(
    unknownIds.length ? (deletedIds.length ? "PARTIAL" : "UNKNOWN") : "DELETED",
    deletedIds,
    unknownIds
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function tokenizeForForget(text: string): string[] {
  const tokens = new Set<string>();
  const normalized = text.toLowerCase().trim();
  if (!normalized) return [];
  tokens.add(normalized);
  for (const part of normalized.split(/[\s,，。！？!?;；:：、]+/u)) {
    const t = part.trim();
    if (t.length >= 2) tokens.add(t);
  }
  // CJK bigrams/trigrams so "我喜欢科幻" overlaps "用户喜欢科幻作品".
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/gu) ?? [];
  for (const run of cjkRuns) {
    tokens.add(run);
    for (let n = 2; n <= Math.min(4, run.length); n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        tokens.add(run.slice(i, i + n));
      }
    }
  }
  // Prefer longer tokens first when counting overlap.
  return [...tokens].sort((a, b) => b.length - a.length).slice(0, 40);
}

/** Common verbs/pronouns that must not alone authorize a delete. */
const FORGET_STOP_TOKENS = new Set([
  "喜欢",
  "讨厌",
  "用户",
  "我们",
  "他们",
  "这个",
  "那个",
  "一个",
  "记得",
  "忘记",
  "like",
  "love",
  "hate",
  "user",
  "the",
  "and",
  "for",
  "that",
  "this"
]);

function contentOverlapsQuery(content: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = content.toLowerCase().trim();
  if (!hay) return false;
  // Exact / full-string containment (handles explicit facts verbatim).
  const full = tokens[0] ?? "";
  if (full.length >= 2 && (hay.includes(full) || full.includes(hay))) {
    return true;
  }
  const meaningful = tokens.filter((t) => t.length >= 2 && !FORGET_STOP_TOKENS.has(t));
  if (meaningful.length === 0) {
    return tokens.some((t) => t.length >= 4 && hay.includes(t));
  }
  const hits = meaningful.filter((t) => hay.includes(t));
  if (hits.some((t) => t.length >= 3)) return true;
  const total = hits.reduce((sum, t) => sum + t.length, 0);
  return total >= 4;
}

function overlapCount(content: string, tokens: string[]): number {
  const hay = content.toLowerCase();
  return tokens.reduce((n, t) => {
    if (t.length < 2 || FORGET_STOP_TOKENS.has(t) || !hay.includes(t)) return n;
    return n + t.length;
  }, 0);
}
