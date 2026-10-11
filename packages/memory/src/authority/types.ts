import { buildMemoryScope, parseMemoryScope } from "../scope.js";
import type { MemoryEvent, MemoryWriteEventInput } from "../provider.js";
import type { QueryResultRow } from "pg";

export type AuthorityQuery = {
  query(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: QueryResultRow[]; rowCount?: number | null }>;
};
export type AuthorityPool = AuthorityQuery & {
  on?(event: "error", listener: (error: Error) => void): unknown;
  connect(): Promise<
    AuthorityQuery & {
      release(): void;
      on?(event: "error", listener: (error: Error) => void): unknown;
      off?(event: "error", listener: (error: Error) => void): unknown;
    }
  >;
};
export type KnowledgeState =
  | "current"
  | "superseded"
  | "conflicted"
  | "supporting"
  | "legacy_unverified"
  | "unattributed";
export type KnowledgeRecord = {
  schema: "memory.knowledge.v1";
  id: string;
  version: string;
  state: KnowledgeState;
  classification: "GROUNDED" | "LEGACY_UNVERIFIED";
  sourceAt: string;
  committedAt: string;
  event: MemoryEvent;
  evidence: {
    sourceOrigin: string;
    interpretation: "MODEL_PROPOSED" | "HOST_OR_LEGACY";
    selectedSpan: unknown;
  };
};
export type KnowledgePage = {
  schema: "memory.page.v1";
  status: "OK";
  records: KnowledgeRecord[];
  nextCursor: string | null;
  watermark: string;
};
export type AuthorityRelation = {
  fromId: string;
  toId: string;
  kind: "supersedes" | "conflicts" | "supports";
  version: string;
};
export type KnowledgeOverview = {
  schema: "memory.overview.v1";
  status: "OK" | "PARTIAL";
  version: string;
  projectionVersion: string;
  records: string;
  current: string;
  legacy: string;
  unattributed: string;
  integrity: "NOT_VERIFIED";
  compatibility: "NO_LEGACY_IMPORT" | "LEGACY_UNVERIFIED_PRESENT";
};
export class MemoryAuthorityError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function canonicalScope(scope: string): void {
  let parts;
  try {
    parts = parseMemoryScope(scope);
  } catch {
    throw new MemoryAuthorityError("MEMORY_SCOPE_INVALID");
  }
  if (!scope || scope.length > 1024 || buildMemoryScope(parts.userId, parts.characterId) !== scope)
    throw new MemoryAuthorityError("MEMORY_SCOPE_INVALID");
}
export function eventSemantic(input: MemoryWriteEventInput) {
  const { signal: _signal, idempotencyKey: _key, payloadDigest: _digest, ...semantic } = input;
  return semantic;
}
/** Lexical tokenization only; never used to admit or reject a proposition. */
export function searchTerms(text: string): string[] {
  const parts =
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? [];
  const terms = new Set<string>();
  for (const part of parts) {
    if (/^\p{Script=Han}+$/u.test(part)) {
      const chars = Array.from(part);
      if (chars.length === 1) terms.add(part);
      for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i]! + chars[i + 1]!);
    } else terms.add(part.slice(0, 100));
  }
  return [...terms].slice(0, 256);
}
export type MemoryJobState =
  | "pending"
  | "processing"
  | "complete"
  | "retryable_failed"
  | "terminal_failed";
export type SemanticJobView = {
  id: string;
  state: MemoryJobState;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  model: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};
export type VectorIndexView = {
  modelTag: string;
  state: MemoryJobState;
  attempts: number;
  errorCode: string | null;
  nextAttemptAt: string | null;
  completedAt: string | null;
  projection: "CURRENT" | "MISSING" | "RETIRED";
};
export type MemoryProcessingView = {
  schema: "memory.processing.v1";
  semantic: SemanticJobView | null;
  indexes: VectorIndexView[];
};
export type MemoryMigrationView = {
  id: string;
  source: string;
  checkpoint: string | null;
  importedCount: string;
  state: "running" | "complete" | "failed" | "reconcile_required";
  errorCode: string | null;
  updatedAt: string;
};
