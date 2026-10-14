import { parseMemoryRepository, type MemoryRepositoryDriver } from "@companion/config/environment";
export type MemoryRepositoryKind = MemoryRepositoryDriver;

export type MemoryRepositorySelection = {
  kind: MemoryRepositoryKind;
  envValue: "in-memory" | "memory" | "postgres";
};

export function parseMemoryRepositoryEnv(
  env: Record<string, string | undefined> = process.env
): MemoryRepositorySelection {
  const kind = parseMemoryRepository(env["MEMORY_REPOSITORY"]);
  return {
    kind,
    envValue: env["MEMORY_REPOSITORY"]?.trim().toLowerCase() === "memory" ? "memory" : kind
  };
}
