/**
 * HTTP adapter to the YUVI Mem0 OSS sidecar.
 * Does not generate scopes, format prompts, or decide admission.
 */

import {
  MemoryBackendError,
  type AddMemoryInput,
  type IdempotentMemoryWriteInput,
  type DeleteMemoryInput,
  type GetMemoryInput,
  type ListMemoryInput,
  type ListMemoryResult,
  type MemoryBackend,
  type MemoryBackendHealth,
  type MemoryHistoryEntry,
  type MemoryHistoryInput,
  type MemoryRecord,
  type MemorySearchResult,
  type MemoryWriteResult,
  type MemoryReconciliationResult,
  type SearchMemoryInput,
  type UpdateMemoryInput
} from "../backend.js";

export type Mem0MemoryBackendOptions = {
  baseUrl: string;
  /** Default request timeout (search/get/list). Chat search default is 600ms. */
  timeoutMs?: number;
  /** Optional longer timeout for add/update/delete (infer=true writes). */
  writeTimeoutMs?: number;
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onProfileMutation?: (input: {
    scope: string;
    reason: "DELIVERY_DISPATCHED" | "DELIVERY_OBSERVED" | "MEMORY_CHANGED" | "MEMORY_WITHDRAWN";
  }) => Promise<void> | void;
};

type SidecarEnvelope<T> = {
  ok: boolean;
  data?: T;
  meta?: { durationMs?: number; backend?: string };
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
};

type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  query?: Record<string, string>;
};

export class Mem0MemoryBackend implements MemoryBackend {
  readonly kind = "mem0" as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onProfileMutation: Mem0MemoryBackendOptions["onProfileMutation"];
  private profileNotificationFailureCount = 0;

  constructor(options: Mem0MemoryBackendOptions) {
    const base = options.baseUrl?.trim();
    if (!base) {
      throw new MemoryBackendError("CONFIG_INVALID", "MEM0_BASE_URL is required.");
    }
    this.baseUrl = base.replace(/\/+$/, "");
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 5000);
    this.writeTimeoutMs = Math.max(this.timeoutMs, options.writeTimeoutMs ?? 180_000);
    this.healthTimeoutMs = Math.max(100, options.healthTimeoutMs ?? 1000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onProfileMutation = options.onProfileMutation;
  }

  getProfileNotificationFailureCount(): number {
    return this.profileNotificationFailureCount;
  }

  async health(signal?: AbortSignal): Promise<MemoryBackendHealth> {
    const opts: RequestOptions = { timeoutMs: this.healthTimeoutMs };
    if (signal) opts.signal = signal;
    const payload = await this.request<MemoryBackendHealth>("GET", "/health", undefined, opts);
    const health: MemoryBackendHealth = {
      status: (payload.status as MemoryBackendHealth["status"]) ?? "unhealthy",
      backend: "mem0"
    };
    if (payload.components) health.components = payload.components;
    if (payload.embedding) health.embedding = payload.embedding;
    if (payload.collection) health.collection = payload.collection;
    if (payload.message) health.message = payload.message;
    if (payload.durationMs !== undefined) health.durationMs = payload.durationMs;
    return health;
  }

  async add(input: AddMemoryInput, signal?: AbortSignal): Promise<MemoryWriteResult> {
    assertScope(input.scope);
    const opts: RequestOptions = { timeoutMs: this.writeTimeoutMs };
    if (signal) opts.signal = signal;
    await this.notifyProfileMutation(input.scope, "DELIVERY_DISPATCHED");
    let data: MemoryWriteResult;
    try {
      data = await this.request<MemoryWriteResult>(
        "POST",
        "/v1/memories",
        {
          scope: input.scope,
          content: input.content,
          messages: input.messages,
          infer: input.infer ?? true,
          metadata: input.metadata ?? {}
        },
        opts
      );
    } finally {
      await this.notifyProfileMutation(input.scope, "DELIVERY_OBSERVED");
    }
    if (!data?.memoryId) {
      throw new MemoryBackendError("INTERNAL_ERROR", "Sidecar add response missing memoryId.");
    }
    return data;
  }

  async submitIdempotent(
    input: IdempotentMemoryWriteInput,
    signal?: AbortSignal
  ): Promise<MemoryWriteResult> {
    assertScope(input.scope);
    if (!input.idempotencyKey?.trim() || !input.payloadDigest?.trim()) {
      throw new MemoryBackendError(
        "VALIDATION_ERROR",
        "idempotencyKey and payloadDigest are required."
      );
    }
    const opts: RequestOptions = { timeoutMs: this.writeTimeoutMs };
    if (signal) opts.signal = signal;
    await this.notifyProfileMutation(input.scope, "DELIVERY_DISPATCHED");
    let data: MemoryWriteResult;
    try {
      data = await this.request<MemoryWriteResult>(
        "POST",
        "/v1/memories/idempotent",
        {
          scope: input.scope,
          content: input.content,
          messages: input.messages,
          infer: false,
          metadata: input.metadata ?? {},
          idempotencyKey: input.idempotencyKey,
          payloadDigest: input.payloadDigest
        },
        opts
      );
    } finally {
      await this.notifyProfileMutation(input.scope, "DELIVERY_OBSERVED");
    }
    if (!data?.memoryId) {
      throw new MemoryBackendError(
        "INTERNAL_ERROR",
        "Sidecar idempotent response missing memoryId."
      );
    }
    return data;
  }

  async reconcileIdempotency(
    input: Pick<IdempotentMemoryWriteInput, "idempotencyKey" | "payloadDigest">,
    signal?: AbortSignal
  ): Promise<MemoryReconciliationResult> {
    if (!input.idempotencyKey?.trim() || !input.payloadDigest?.trim()) {
      throw new MemoryBackendError(
        "VALIDATION_ERROR",
        "idempotencyKey and payloadDigest are required."
      );
    }
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    return this.request<MemoryReconciliationResult>(
      "POST",
      "/v1/memories/idempotent/reconcile",
      {
        idempotencyKey: input.idempotencyKey,
        payloadDigest: input.payloadDigest
      },
      opts
    );
  }

  async search(input: SearchMemoryInput, signal?: AbortSignal): Promise<MemorySearchResult[]> {
    assertScope(input.scope);
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    const data = await this.request<{ items: MemorySearchResult[] }>(
      "POST",
      "/v1/memories/search",
      {
        scope: input.scope,
        query: input.query,
        limit: input.limit ?? 8,
        metadataFilter: input.metadataFilter
      },
      opts
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    return items
      .map(normalizeSearchItem)
      .filter((item): item is MemorySearchResult => item !== null);
  }

  async get(input: GetMemoryInput, signal?: AbortSignal): Promise<MemoryRecord | null> {
    if (!input.memoryId?.trim()) {
      throw new MemoryBackendError("VALIDATION_ERROR", "memoryId is required.");
    }
    try {
      const opts: RequestOptions = {};
      if (signal) opts.signal = signal;
      if (input.scope) opts.query = { scope: input.scope };
      const data = await this.request<MemoryRecord>(
        "GET",
        `/v1/memories/${encodeURIComponent(input.memoryId)}`,
        undefined,
        opts
      );
      return data ?? null;
    } catch (error) {
      if (error instanceof MemoryBackendError && error.code === "MEMORY_NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  async list(input: ListMemoryInput, signal?: AbortSignal): Promise<ListMemoryResult> {
    assertScope(input.scope);
    if (
      input.mode === "bounded_snapshot" &&
      (input.limit !== 4096 || (input.offset !== undefined && input.offset !== 0))
    ) {
      throw new MemoryBackendError(
        "VALIDATION_ERROR",
        "Bounded snapshot listing requires limit 4096 and offset zero."
      );
    }
    const opts: RequestOptions = {
      query: {
        scope: input.scope,
        limit: String(input.limit ?? 20),
        offset: String(input.offset ?? 0),
        ...(input.mode === "bounded_snapshot" ? { mode: "bounded_snapshot" } : {})
      },
      ...(input.mode === "bounded_snapshot"
        ? { timeoutMs: 30_000, maxResponseBytes: 67_108_864 }
        : {})
    };
    if (signal) opts.signal = signal;
    const data = await this.request<ListMemoryResult>("GET", "/v1/memories", undefined, opts);
    const result: ListMemoryResult = {
      items: Array.isArray(data?.items) ? data.items : []
    };
    if (data?.total !== undefined) result.total = data.total;
    if (data?.snapshot !== undefined) result.snapshot = data.snapshot;
    return result;
  }

  async update(input: UpdateMemoryInput, signal?: AbortSignal): Promise<MemoryRecord> {
    if (!input.memoryId?.trim()) {
      throw new MemoryBackendError("VALIDATION_ERROR", "memoryId is required.");
    }
    if (!input.content?.trim()) {
      throw new MemoryBackendError("VALIDATION_ERROR", "content is required for update.");
    }
    const opts: RequestOptions = { timeoutMs: this.writeTimeoutMs };
    if (signal) opts.signal = signal;
    if (input.scope) await this.notifyProfileMutation(input.scope, "DELIVERY_DISPATCHED");
    try {
      return await this.request<MemoryRecord>(
        "PUT",
        `/v1/memories/${encodeURIComponent(input.memoryId)}`,
        { content: input.content, scope: input.scope, metadata: input.metadata },
        opts
      );
    } finally {
      if (input.scope) await this.notifyProfileMutation(input.scope, "MEMORY_CHANGED");
    }
  }

  async delete(input: DeleteMemoryInput, signal?: AbortSignal): Promise<void> {
    if (!input.memoryId?.trim()) {
      throw new MemoryBackendError("VALIDATION_ERROR", "memoryId is required.");
    }
    const opts: RequestOptions = { timeoutMs: this.writeTimeoutMs };
    if (signal) opts.signal = signal;
    if (input.scope) opts.query = { scope: input.scope };
    if (input.scope) await this.notifyProfileMutation(input.scope, "DELIVERY_DISPATCHED");
    try {
      await this.request<unknown>(
        "DELETE",
        `/v1/memories/${encodeURIComponent(input.memoryId)}`,
        undefined,
        opts
      );
    } finally {
      if (input.scope) await this.notifyProfileMutation(input.scope, "MEMORY_WITHDRAWN");
    }
  }

  async history(input: MemoryHistoryInput, signal?: AbortSignal): Promise<MemoryHistoryEntry[]> {
    if (!input.memoryId?.trim()) {
      throw new MemoryBackendError("VALIDATION_ERROR", "memoryId is required.");
    }
    const opts: RequestOptions = {};
    if (signal) opts.signal = signal;
    if (input.scope) opts.query = { scope: input.scope };
    const data = await this.request<{ items: MemoryHistoryEntry[] }>(
      "GET",
      `/v1/memories/${encodeURIComponent(input.memoryId)}/history`,
      undefined,
      opts
    );
    return Array.isArray(data?.items) ? data.items : [];
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(`${this.baseUrl}${path}`);
      if (options.query) {
        for (const [key, value] of Object.entries(options.query)) {
          url.searchParams.set(key, value);
        }
      }
      const init: RequestInit = {
        method,
        signal: controller.signal
      };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const response = await this.fetchImpl(url, init);
      let envelope: SidecarEnvelope<T>;
      if (options.maxResponseBytes !== undefined) {
        const text = await readResponseWithByteLimit(response, options.maxResponseBytes);
        try {
          envelope = JSON.parse(text) as SidecarEnvelope<T>;
        } catch {
          throw new MemoryBackendError(
            "BACKEND_ERROR",
            "Sidecar snapshot response was not valid JSON."
          );
        }
      } else {
        try {
          envelope = (await response.json()) as SidecarEnvelope<T>;
        } catch {
          throw new MemoryBackendError(
            "INTERNAL_ERROR",
            `Sidecar returned non-JSON response (${response.status}).`,
            { retryable: response.status >= 500 }
          );
        }
      }
      if (!response.ok || envelope.ok === false) {
        const code = envelope.error?.code ?? mapHttpCode(response.status);
        const errOpts: { retryable: boolean; details?: Record<string, unknown> } = {
          retryable: envelope.error?.retryable ?? response.status >= 500
        };
        const details = sanitizeDetails(envelope.error?.details);
        if (details) errOpts.details = details;
        throw new MemoryBackendError(
          code,
          envelope.error?.message ?? `Sidecar request failed (${response.status}).`,
          errOpts
        );
      }
      return envelope.data as T;
    } catch (error) {
      if (error instanceof MemoryBackendError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new MemoryBackendError(
          "OPERATION_TIMEOUT",
          `Mem0 sidecar timeout after ${timeoutMs}ms.`,
          { retryable: true }
        );
      }
      throw new MemoryBackendError(
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : "Mem0 sidecar request failed.",
        { retryable: true, cause: error }
      );
    } finally {
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  private async notifyProfileMutation(
    scope: string,
    reason: "DELIVERY_DISPATCHED" | "DELIVERY_OBSERVED" | "MEMORY_CHANGED" | "MEMORY_WITHDRAWN"
  ): Promise<void> {
    if (!this.onProfileMutation) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        Promise.resolve(this.onProfileMutation({ scope, reason })).then(
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

async function readResponseWithByteLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("Sidecar snapshot response body is unavailable.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new MemoryBackendError(
          "PROFILE_SOURCE_BYTES_BOUND",
          "Sidecar snapshot response exceeded its byte bound."
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function assertScope(scope: string): void {
  if (typeof scope !== "string" || !scope.trim()) {
    throw new MemoryBackendError("VALIDATION_ERROR", "scope is required.");
  }
}

function normalizeSearchItem(item: MemorySearchResult): MemorySearchResult | null {
  if (!item || typeof item !== "object") return null;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  if (typeof item.content !== "string") return null;
  const score =
    typeof item.score === "number" && Number.isFinite(item.score)
      ? Math.min(1, Math.max(0, item.score))
      : 0;
  const record: MemorySearchResult = {
    id: item.id,
    content: item.content,
    scope: typeof item.scope === "string" ? item.scope : "",
    metadata: sanitizeMetadata(item.metadata),
    score
  };
  if (item.createdAt !== undefined) record.createdAt = item.createdAt;
  if (item.updatedAt !== undefined) record.updatedAt = item.updatedAt;
  return record;
}

function sanitizeMetadata(value: unknown): MemorySearchResult["metadata"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const sensitiveKey = /key|secret|password|authorization|token|connection/i;
  const out: MemorySearchResult["metadata"] = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length > 128) continue;
    if (sensitiveKey.test(key)) continue;
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      out[key] = entry;
    } else if (
      Array.isArray(entry) &&
      entry.length <= 32 &&
      entry.every((item): item is string => typeof item === "string" && item.length <= 512)
    ) {
      out[key] = [...entry];
    }
  }
  return out;
}

function mapHttpCode(status: number): string {
  if (status === 404) return "MEMORY_NOT_FOUND";
  if (status === 400 || status === 422) return "VALIDATION_ERROR";
  if (status === 408) return "OPERATION_TIMEOUT";
  if (status >= 500) return "INTERNAL_ERROR";
  return "INTERNAL_ERROR";
}

function sanitizeDetails(
  details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const blocked = /key|secret|password|authorization|token|connection/i;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (blocked.test(key)) continue;
    if (typeof value === "string" && value.length > 200) {
      out[key] = `${value.slice(0, 200)}…`;
    } else {
      out[key] = value;
    }
  }
  return out;
}
