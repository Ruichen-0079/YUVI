import { createHash } from "node:crypto";
import { MemoryLineageV1Schema, type MemoryLineageV1 } from "./lineage.js";

export const LINEAGE_ENCODING = "yuvi.memory-lineage-json.v1";
export const MAX_LINEAGE_BYTES = 65_536;
export const LINEAGE_METADATA_KEYS = [
  "yuviLineageEncoding",
  "yuviLineageJson",
  "yuviLineageDigest"
] as const;

export class MemoryLineageEncodingError extends Error {
  readonly code = "MEMORY_LINEAGE_INVALID";
  constructor() {
    super("Memory lineage encoding is missing, malformed, conflicting, or oversized.");
  }
}

export function canonicalLineageJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalLineageJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalLineageJson(record[key])}`)
    .join(",")}}`;
}
export function lineageDigest(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}
export function encodeMemoryLineage(lineage: MemoryLineageV1): Record<string, string> {
  const parsed = MemoryLineageV1Schema.safeParse(lineage);
  if (!parsed.success) throw new MemoryLineageEncodingError();
  const json = canonicalLineageJson(parsed.data);
  if (Buffer.byteLength(json, "utf8") > MAX_LINEAGE_BYTES) throw new MemoryLineageEncodingError();
  return {
    yuviLineageEncoding: LINEAGE_ENCODING,
    yuviLineageJson: json,
    yuviLineageDigest: lineageDigest(json)
  };
}
export function decodeMemoryLineage(
  metadata: Record<string, unknown>
): MemoryLineageV1 | undefined {
  if (!LINEAGE_METADATA_KEYS.some((key) => Object.hasOwn(metadata, key))) return undefined;
  const json = metadata["yuviLineageJson"];
  if (
    metadata["yuviLineageEncoding"] !== LINEAGE_ENCODING ||
    typeof json !== "string" ||
    Buffer.byteLength(json, "utf8") > MAX_LINEAGE_BYTES ||
    metadata["yuviLineageDigest"] !== lineageDigest(json)
  ) {
    throw new MemoryLineageEncodingError();
  }
  try {
    const lineage = MemoryLineageV1Schema.parse(JSON.parse(json));
    if (canonicalLineageJson(lineage) !== json) throw new MemoryLineageEncodingError();
    return lineage;
  } catch {
    throw new MemoryLineageEncodingError();
  }
}

/** Reserved semantic authority is populated from typed host fields only. */
export function isReservedMemoryMetadataKey(key: string): boolean {
  return (
    /^yuvi(?:Lineage|Parent|Selector|Consumer|Principal|Binding|Audience|PayloadDigest|IngestionKey|Assertion|Verification|Claim|ObservedAt|OccurredAt|EventKind|SourceTurnIds|Participants)/iu.test(
      key
    ) ||
    /^(?:lineage|parentEventId|selector|consumerKey|principal|binding|audience|verification)$/iu.test(
      key
    )
  );
}
