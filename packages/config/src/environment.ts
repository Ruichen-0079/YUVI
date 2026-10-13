/** Cross-process environment contract. Missing values use the same defaults;
 * unknown storage drivers never silently select a different persistence backend.
 */
export type RuntimeEnvironment = "development" | "test" | "production";
export type MemoryRepositoryDriver = "in-memory" | "postgres";
export type MemoryBackendDriver = "legacy" | "mem0" | "postgres";

export function parseRuntimeEnvironment(value?: string): RuntimeEnvironment {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "development";
  if (normalized === "development" || normalized === "test" || normalized === "production")
    return normalized;
  throw new Error("Unsupported Runtime environment. Use development, test, or production.");
}

export function parseMemoryBackend(value?: string): MemoryBackendDriver {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "legacy";
  if (normalized === "legacy" || normalized === "mem0" || normalized === "postgres")
    return normalized;
  throw new Error("Unsupported MEMORY_BACKEND. Use legacy, mem0, or postgres; shadow is retired.");
}

export function parseMemoryRepository(value?: string): MemoryRepositoryDriver {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "memory") return "in-memory";
  if (normalized === "postgres" || normalized === "in-memory") return normalized;
  throw new Error("Invalid MEMORY_REPOSITORY. Valid values: in-memory, memory, postgres.");
}

export function parseBooleanSetting(value: string | undefined, fallback = false): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Unsupported boolean setting. Use true/false, 1/0, yes/no, or on/off.");
}
