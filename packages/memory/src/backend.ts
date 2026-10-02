/**
 * Stable MemoryBackend contract for YUVI.
 *
 * MemoryService owns business policy (admission, recall, prompt formatting).
 * Backends own storage operations only (add/search/get/list/update/delete/history/health).
 *
 * Implementations: LegacyMemoryBackend (existing repository), Mem0MemoryBackend (HTTP sidecar).
 */

export type MemoryBackendKind = "legacy" | "mem0" | "shadow";

export type MemoryBackendComponentStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export type MemoryBackendHealth = {
  status: "healthy" | "degraded" | "unhealthy";
  backend: MemoryBackendKind | string;
  components?: Record<string, MemoryBackendComponentStatus | string>;
  embedding?: {
    provider?: string;
    model?: string;
    dimensions?: number;
  };
  collection?: string;
  message?: string;
  durationMs?: number;
};

export type MemoryRecordMetadata = {
  userId?: string;
  characterId?: string;
  conversationId?: string | null;
  sourceMessageId?: string | null;
  sourceTraceId?: string | null;
  memoryType?: string | null;
  explicit?: boolean;
  language?: string | null;
  schemaVersion?: number;
  createdBy?: string | null;
  supersedesMemoryId?: string | null;
  [key: string]: unknown;
};

export type MemoryRecord = {
  id: string;
  content: string;
  scope: string;
  metadata: MemoryRecordMetadata;
  score?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type MemoryWriteOperation = "created" | "updated" | "deleted" | "unchanged";

export type MemoryWriteResult = {
  memoryId: string;
  operation: MemoryWriteOperation;
  record?: MemoryRecord | null;
};

export type MemorySearchResult = MemoryRecord & {
  score: number;
};

export type MemoryHistoryEntry = {
  id: string;
  memoryId: string;
  event: string;
  previousValue?: string | null;
  newValue?: string | null;
  createdAt?: string | null;
};

export type AddMemoryInput = {
  scope: string;
  /** Free-text fact for infer=false, or ignored when messages are provided. */
  content?: string;
  messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** When true, backend may extract/update facts (Mem0 infer). */
  infer?: boolean;
  metadata?: MemoryRecordMetadata;
};

export type IdempotentMemoryWriteInput = AddMemoryInput & {
  idempotencyKey: string;
  payloadDigest: string;
};

export type MemoryReconciliationStatus =
  | "applied"
  | "not_applied"
  | "in_flight"
  | "payload_conflict"
  | "unknown";

export type MemoryReconciliationResult = {
  status: MemoryReconciliationStatus;
  memoryId?: string;
  operation?: MemoryWriteOperation | string;
  errorCode?: string | null;
};

export type SearchMemoryInput = {
  scope: string;
  query: string;
  limit?: number;
  metadataFilter?: Record<string, unknown>;
};

export type GetMemoryInput = {
  memoryId: string;
  scope?: string;
};

export type ListMemoryInput = {
  scope: string;
  limit?: number;
  offset?: number;
  mode?: "bounded_snapshot";
};

export type ListMemoryResult = {
  items: MemoryRecord[];
  total?: number;
  snapshot?: {
    mode: "bounded_snapshot";
    exhausted: boolean;
    rawBytesExceeded: boolean;
  };
};

export type UpdateMemoryInput = {
  memoryId: string;
  content: string;
  scope?: string;
  metadata?: MemoryRecordMetadata;
};

export type DeleteMemoryInput = {
  memoryId: string;
  scope?: string;
};

export type MemoryHistoryInput = {
  memoryId: string;
  scope?: string;
};

export interface MemoryBackend {
  readonly kind: MemoryBackendKind;
  health(signal?: AbortSignal): Promise<MemoryBackendHealth>;
  add(input: AddMemoryInput, signal?: AbortSignal): Promise<MemoryWriteResult>;
  search(input: SearchMemoryInput, signal?: AbortSignal): Promise<MemorySearchResult[]>;
  get(input: GetMemoryInput, signal?: AbortSignal): Promise<MemoryRecord | null>;
  list(input: ListMemoryInput, signal?: AbortSignal): Promise<ListMemoryResult>;
  update(input: UpdateMemoryInput, signal?: AbortSignal): Promise<MemoryRecord>;
  delete(input: DeleteMemoryInput, signal?: AbortSignal): Promise<void>;
  history(input: MemoryHistoryInput, signal?: AbortSignal): Promise<MemoryHistoryEntry[]>;
  submitIdempotent?(
    input: IdempotentMemoryWriteInput,
    signal?: AbortSignal
  ): Promise<MemoryWriteResult>;
  reconcileIdempotency?(
    input: Pick<IdempotentMemoryWriteInput, "idempotencyKey" | "payloadDigest">,
    signal?: AbortSignal
  ): Promise<MemoryReconciliationResult>;
}

export class MemoryBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    options?: {
      retryable?: boolean;
      details?: Record<string, unknown> | undefined;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MemoryBackendError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}
