export { LegacyMemoryBackend } from "./legacy-memory-backend.js";
export { Mem0MemoryBackend, type Mem0MemoryBackendOptions } from "./mem0-memory-backend.js";

import { LegacyMemoryBackend } from "./legacy-memory-backend.js";
import { Mem0MemoryBackend } from "./mem0-memory-backend.js";
import type { MemoryBackend, MemoryBackendKind } from "../backend.js";
import type { MemoryRepository } from "../repository.js";
import { MemoryBackendError } from "../backend.js";

export type MemoryBackendFactoryOptions = {
  kind?: MemoryBackendKind | string;
  repository?: MemoryRepository;
  mem0BaseUrl?: string;
  mem0TimeoutMs?: number;
  mem0WriteTimeoutMs?: number;
  mem0HealthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onProfileMutation?: (input: {
    scope: string;
    reason: "DELIVERY_DISPATCHED" | "DELIVERY_OBSERVED" | "MEMORY_CHANGED" | "MEMORY_WITHDRAWN";
  }) => Promise<void> | void;
};

/**
 * Build a MemoryBackend from configuration.
 * Default kind is always "legacy" so chat paths remain unchanged.
 */
export function createMemoryBackend(options: MemoryBackendFactoryOptions = {}): MemoryBackend {
  const kind = (options.kind ?? "legacy").toString().trim().toLowerCase() as MemoryBackendKind;
  if (kind === "legacy" || kind === "shadow") {
    if (!options.repository) {
      throw new MemoryBackendError(
        "CONFIG_INVALID",
        "Legacy/shadow MemoryBackend requires a MemoryRepository."
      );
    }
    return new LegacyMemoryBackend(options.repository);
  }
  if (kind === "mem0") {
    const baseUrl = options.mem0BaseUrl ?? process.env["MEM0_BASE_URL"] ?? "http://127.0.0.1:6131";
    const mem0Options: {
      baseUrl: string;
      timeoutMs?: number;
      writeTimeoutMs?: number;
      healthTimeoutMs?: number;
      fetchImpl?: typeof fetch;
      onProfileMutation?: NonNullable<MemoryBackendFactoryOptions["onProfileMutation"]>;
    } = { baseUrl };
    if (options.mem0TimeoutMs !== undefined) mem0Options.timeoutMs = options.mem0TimeoutMs;
    if (options.mem0WriteTimeoutMs !== undefined) {
      mem0Options.writeTimeoutMs = options.mem0WriteTimeoutMs;
    }
    if (options.mem0HealthTimeoutMs !== undefined) {
      mem0Options.healthTimeoutMs = options.mem0HealthTimeoutMs;
    }
    if (options.fetchImpl !== undefined) mem0Options.fetchImpl = options.fetchImpl;
    if (options.onProfileMutation) mem0Options.onProfileMutation = options.onProfileMutation;
    return new Mem0MemoryBackend(mem0Options);
  }
  throw new MemoryBackendError(
    "CONFIG_INVALID",
    `Unsupported MEMORY_BACKEND '${kind}'. Supported: legacy, mem0.`
  );
}
