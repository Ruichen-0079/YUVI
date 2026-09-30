import { describe, expect, it, vi } from "vitest";
import {
  encodeMemoryLineage,
  decodeMemoryLineage,
  LINEAGE_ENCODING,
  canonicalLineageJson,
  MAX_LINEAGE_BYTES
} from "./lineage-encoding.js";
import { MemoryLineageV1Schema } from "./lineage.js";
import { finalizedTestResolver, finalizedTestParent } from "./finalized-test-fixture.js";
import { freezeFinalizedMemoryEvent } from "./finalized-memory-lineage.js";
import {
  Mem0MemoryProvider,
  buildWriteMetadata,
  mapMem0RecordToMemoryEvent,
  sanitizeSemanticMetadata
} from "./providers/mem0-memory-provider.js";
import type { MemoryBackend, MemoryRecord } from "./backend.js";

async function event() {
  const source = await finalizedTestResolver.resolve({
    sourceJournalRef: finalizedTestParent,
    sourceText: "我喜欢茶 🍵"
  });
  source.parent.namespace = "opaque:🍵:" + "n".repeat(490);
  source.selector.payload = {
    namespace: "opaque:" + "p".repeat(490),
    payloadId: "载荷".repeat(160),
    version: "immutable-v1"
  };
  source.authority.principal = { state: "UNRESOLVED", reason: "没有认证 🍵".repeat(50) };
  return freezeFinalizedMemoryEvent(
    source,
    { kind: "fact", content: "User likes tea", scope: "isolated" },
    "a10.1d-test.v1"
  );
}
describe("YUVI lineage encoding and Mem0 round-trip", () => {
  it.each(["UNKNOWN", "INSTANT", "INTERVAL"] as const)(
    "losslessly preserves long refs, Unicode, unresolved authority and %s time",
    async (state) => {
      const input = await event();
      if (input.lineage?.state !== "GROUNDED") throw new Error("expected grounded lineage");
      input.lineage.sourceTime.occurrenceTime =
        state === "UNKNOWN"
          ? { state }
          : state === "INSTANT"
            ? { state, at: "2026-09-30T08:00:00+08:00", clockSource: "source", uncertaintyMs: 12 }
            : {
                state,
                start: "2026-09-30T08:00:00+08:00",
                end: "2026-09-30T09:00:00+08:00",
                clockSource: "source",
                uncertaintyMs: 40
              };
      const encoded = encodeMemoryLineage(input.lineage);
      expect(encoded["yuviLineageJson"]!.length).toBeGreaterThan(512);
      expect(decodeMemoryLineage(sanitizeSemanticMetadata(encoded))).toEqual(
        MemoryLineageV1Schema.parse(input.lineage)
      );
      expect(buildWriteMetadata(input)).toMatchObject(encoded);
      expect(encodeMemoryLineage(decodeMemoryLineage(encoded)!)).toEqual(encoded);
    }
  );
  it("keeps generic sanitizer bounded and prevents caller metadata from overriding host authority", async () => {
    const input = await event();
    const metadata = buildWriteMetadata({
      ...input,
      payloadDigest: "host-digest",
      metadata: {
        yuviLineageEncoding: "forged",
        yuviLineageJson: "{}",
        yuviLineageDigest: "forged",
        yuviParentEventId: "forged",
        selector: "forged",
        consumerKey: "forged",
        yuviPayloadDigest: "forged",
        yuviVerification: "verified",
        yuviBinding: "resolved",
        nested: { forged: true },
        harmless: "x".repeat(600)
      }
    });
    expect(decodeMemoryLineage(metadata)).toEqual(input.lineage);
    expect(metadata["yuviVerification"]).toBe("unverified");
    expect(metadata["yuviPayloadDigest"]).toBe("host-digest");
    for (const key of ["yuviParentEventId", "selector", "consumerKey", "yuviBinding", "nested"])
      expect(metadata[key]).toBeUndefined();
    expect((metadata["harmless"] as string).length).toBe(513);
  });
  it("proves exact outbound, persisted, add/submit, get and search lineage equality", async () => {
    const input = await event();
    let persisted: MemoryRecord | null = null;
    const add = vi.fn(async (request) => {
      expect(request.infer).toBe(false);
      expect(decodeMemoryLineage(request.metadata)).toEqual(input.lineage);
      persisted = {
        id: "backend-uuid",
        content: request.content,
        scope: request.scope,
        metadata: JSON.parse(JSON.stringify(request.metadata))
      };
      return { memoryId: persisted.id, operation: "created" as const, record: persisted };
    });
    const backend = {
      kind: "mem0",
      add,
      submitIdempotent: add,
      get: async () => persisted,
      search: async () => (persisted ? [{ ...persisted, score: 0.9 }] : [])
    } as unknown as MemoryBackend;
    const provider = new Mem0MemoryProvider(backend);
    expect((await provider.writeEvent(input)).event?.lineage).toEqual(input.lineage);
    expect(
      (
        await provider.writeEventIdempotent({
          ...input,
          idempotencyKey: "key",
          payloadDigest: "digest"
        })
      ).event?.lineage
    ).toEqual(input.lineage);
    expect(
      (await provider.getEvent({ id: "mem0:backend-uuid", scope: input.scope }))?.lineage
    ).toEqual(input.lineage);
    expect(
      (await provider.retrieveRelevant({ text: "tea", scope: input.scope })).events[0]?.lineage
    ).toEqual(input.lineage);
  });
  it.each([
    "broken JSON",
    "unknown encoding",
    "conflicting digest",
    "missing JSON",
    "oversized",
    "conflicting origin",
    "conflicting source time",
    "conflicting verification"
  ])("fails closed on backend %s", async (mode) => {
    const input = await event();
    const metadata = buildWriteMetadata(input);
    if (mode === "broken JSON") metadata["yuviLineageJson"] = "{";
    if (mode === "unknown encoding") metadata["yuviLineageEncoding"] = "v999";
    if (mode === "conflicting digest") metadata["yuviLineageDigest"] = "x";
    if (mode === "missing JSON") delete metadata["yuviLineageJson"];
    if (mode === "oversized") metadata["yuviLineageJson"] = "x".repeat(MAX_LINEAGE_BYTES + 1);
    if (mode === "conflicting origin") metadata["yuviAssertionSource"] = "system";
    if (mode === "conflicting source time") metadata["yuviObservedAt"] = "2030-01-01T00:00:00Z";
    if (mode === "conflicting verification") metadata["yuviVerification"] = "verified";
    const record: MemoryRecord = {
      id: "backend",
      content: input.content,
      scope: input.scope,
      metadata
    };
    expect(() => mapMem0RecordToMemoryEvent(record, input.scope)).toThrow();
    const provider = new Mem0MemoryProvider({
      kind: "mem0",
      get: async () => record,
      search: async () => [{ ...record, score: 0.9 }],
      submitIdempotent: async () => ({ memoryId: "backend", operation: "created", record })
    } as unknown as MemoryBackend);
    await expect(
      provider.getEvent({ id: "mem0:backend", scope: input.scope })
    ).rejects.toMatchObject({ code: "MEMORY_LINEAGE_INVALID" });
    expect(await provider.retrieveRelevant({ text: "tea", scope: input.scope })).toMatchObject({
      status: "error",
      events: [],
      errorCode: "MEMORY_LINEAGE_INVALID"
    });
    expect(
      await provider.writeEventIdempotent({
        ...input,
        idempotencyKey: "key",
        payloadDigest: "digest"
      })
    ).toMatchObject({ status: "rejected", failureClass: "ambiguous" });
  });
  it("refuses to silently accept missing or different valid lineage in an applied response", async () => {
    const input = await event();
    const backend = {
      kind: "mem0",
      submitIdempotent: async () => ({
        memoryId: "backend",
        operation: "created",
        record: { id: "backend", content: input.content, scope: input.scope, metadata: {} }
      })
    } as unknown as MemoryBackend;
    expect(
      await new Mem0MemoryProvider(backend).writeEventIdempotent({
        ...input,
        idempotencyKey: "key",
        payloadDigest: "digest"
      })
    ).toMatchObject({ failureClass: "ambiguous", errorCode: "MEMORY_LINEAGE_INVALID" });
    expect(LINEAGE_ENCODING).toBe("yuvi.memory-lineage-json.v1");
    expect(canonicalLineageJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
