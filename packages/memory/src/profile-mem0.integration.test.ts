import { describe, expect, it, vi } from "vitest";
import { Mem0MemoryBackend } from "./backends/mem0-memory-backend.js";
import { encodeMemoryLineage } from "./lineage-encoding.js";
import { MemoryLineageV1Schema } from "./lineage.js";
import { buildMemoryScope } from "./scope.js";
import { Mem0MemoryProvider, mapMem0RecordToMemoryEvent } from "./providers/mem0-memory-provider.js";
import { Mem0ProfileMemorySourceReader } from "./profile-source-reader.js";
import { materializeProfileSnapshot } from "./profile-materializer.js";
import { InMemoryProfileSnapshotStore } from "./profile-snapshot-store.js";
import { LocalProfileProvider } from "./profile-provider.js";

const sidecarUrl = process.env["YUVI_MEM0_PROFILE_INTEGRATION_URL"];
const asOf = "2026-10-02T00:00:00.000Z";

describe.skipIf(!sidecarUrl)("A10.1f1 real local Mem0 integration", () => {
  it("reads a complete 101-record scope, maps finalized and Dream lineage, and replays locally", async () => {
    const identity = crypto.randomUUID().replace(/-/gu, "");
    const scope = buildMemoryScope(`profile-mem0-${identity}`, "local-profile-test");
    const otherScope = buildMemoryScope(`profile-mem0-other-${identity}`, "local-profile-test");
    const subject = { kind: "MEMORY_SCOPE" as const, scope };
    const backend = new Mem0MemoryBackend({ baseUrl: sidecarUrl!, timeoutMs: 30_000, writeTimeoutMs: 30_000 });
    const added: Array<{ memoryId: string; scope: string }> = [];
    const direct = makeLineage(identity, "direct", "FINALIZED_INGESTION");
    const dream = makeDreamLineage(identity, direct);
    const directText = "Please remember that I prefer concise explanations.";
    const dreamText = "A grounded Dream representation of the same receipt.";
    try {
      const directWrite = await backend.add({
        scope, content: directText, infer: false,
        metadata: {
          ...encodeMemoryLineage(direct), memoryType: "fact",
          yuviAssertionSource: "user", yuviVerification: "unverified", yuviObservedAt: direct.sourceTime.recordedAt
        }
      });
      added.push({ memoryId: directWrite.memoryId, scope });
      const dreamWrite = await backend.add({
        scope, content: dreamText, infer: false,
        metadata: { ...encodeMemoryLineage(dream), memoryType: "fact", yuviAssertionSource: "system", yuviVerification: "unverified" }
      });
      added.push({ memoryId: dreamWrite.memoryId, scope });
      for (let index = 0; index < 99; index += 1) {
        const result = await backend.add({
          scope,
          content: `non-grounded raw profile boundary record ${index}`,
          infer: false,
          metadata: { memoryType: "fact" }
        });
        added.push({ memoryId: result.memoryId, scope });
      }
      const isolated = await backend.add({ scope: otherScope, content: "foreign scope sentinel", infer: false, metadata: { memoryType: "fact" } });
      added.push({ memoryId: isolated.memoryId, scope: otherScope });

      const reader = new Mem0ProfileMemorySourceReader(backend);
      const firstRead = await reader.listEligibleSources({ subject, asOf });
      expect(firstRead.state, JSON.stringify(firstRead)).toBe("COMPLETE");
      expect(firstRead.diagnostics.scannedCount).toBe(101);
      expect(firstRead.sources).toHaveLength(2);
      expect(firstRead.diagnostics.excludedCounts.LEGACY_INCOMPLETE).toBe(99);
      expect(firstRead.sources.map((source) => source.lineage.origin).sort()).toEqual(["DERIVED", "USER_ASSERTION"]);
      expect(firstRead.sources[0]!.roots.map((root) => root.rootKey)).toEqual(firstRead.sources[1]!.roots.map((root) => root.rootKey));
      expect(firstRead.sources.every((source) => source.scope === scope)).toBe(true);

      const semanticProvider = new Mem0MemoryProvider(backend);
      for (const source of firstRead.sources) {
        const record = await backend.get({ memoryId: source.memory.sourceRecordId, scope });
        expect(record).not.toBeNull();
        if (!record) throw new Error("Profile source could not be read through the existing Mem0 get path.");
        const mapped = mapMem0RecordToMemoryEvent(record, scope);
        const semanticGet = await semanticProvider.getEvent({ id: mapped.id, scope });
        expect(source.lineage).toEqual(mapped.lineage);
        expect(semanticGet?.lineage).toEqual(mapped.lineage);
      }

      const store = new InMemoryProfileSnapshotStore();
      const provider = new LocalProfileProvider({
        resolveSourceReader: () => reader,
        store,
        now: () => asOf
      });
      const generated = await provider.generate({ subject });
      expect(generated.state).toBe("COMPLETE");
      if (generated.state === "COMPLETE" || generated.state === "PARTIAL" || generated.state === "INSUFFICIENT_EVIDENCE") {
        if (!generated.snapshot) throw new Error("Generation returned no snapshot.");
        expect(generated.snapshot.sourceSet.sources).toHaveLength(2);
      } else throw new Error("Local profile generation did not complete.");
      const again = await provider.generate({ subject });
      expect(again).toMatchObject({ state: "COMPLETE", persistence: "REPLAY" });
      if (generated.snapshot && again.snapshot) expect(again.snapshot.profileRevision).toBe(generated.snapshot.profileRevision);
      expect(provider.capabilities()).toMatchObject({ hosted: false, asyncGeneration: false, providerId: "yuvi-local-profile" });
      expect(vi.isMockFunction(backend.search)).toBe(false);
    } finally {
      for (const item of added) await backend.delete({ memoryId: item.memoryId, scope: item.scope }).catch(() => undefined);
    }
  }, 60_000);
});

function makeLineage(identity: string, suffix: string, kind: "FINALIZED_INGESTION"): ReturnType<typeof MemoryLineageV1Schema.parse> & { state: "GROUNDED"; origin: "USER_ASSERTION" } {
  const parent = { kind: "JOURNAL_EVENT" as const, namespace: `mem0-profile-${identity}`, eventId: `jev1_${identity.slice(0, 16)}` };
  const content = "Please remember that I prefer concise explanations.";
  const lineage = MemoryLineageV1Schema.parse({
    version: "memory-lineage.v1",
    state: "GROUNDED",
    parents: [{
      ref: parent,
      selector: {
        version: "source-selector.v1",
        modality: "TEXT",
        payload: { namespace: parent.namespace, payloadId: `payload-${suffix}`, version: "v1" },
        range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(content).length }
      }
    }],
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey: `mem0-profile-${identity}-${suffix}`,
    derivation: { kind, producer: "profile-mem0-integration", producerVersion: "1", policyVersion: "test.v1" },
    origin: "USER_ASSERTION",
    authority: {
      principal: { state: "UNRESOLVED", reason: "the local test scope does not authenticate a principal" },
      binding: { state: "UNRESOLVED", reason: "the local test scope does not bind a Person" },
      audience: { kind: "UNKNOWN", reason: "the test has no audience snapshot" }
    },
    sourceTime: { recordedAt: asOf, occurrenceTime: { state: "UNKNOWN" } }
  });
  if (lineage.state !== "GROUNDED" || lineage.origin !== "USER_ASSERTION") throw new Error("Invalid direct lineage fixture.");
  return lineage as typeof lineage & { state: "GROUNDED"; origin: "USER_ASSERTION" };
}

function makeDreamLineage(identity: string, parentLineage: ReturnType<typeof makeLineage>) {
  if (parentLineage.state !== "GROUNDED" || !("parents" in parentLineage)) throw new Error("Direct lineage parent missing.");
  const parent = parentLineage.parents[0]!;
  const lineage = MemoryLineageV1Schema.parse({
    version: "memory-lineage.v1",
    state: "GROUNDED",
    origin: "DERIVED",
    parents: [{ ref: parent.ref, selector: parent.selector }],
    sources: [{ ref: parent.ref, selector: parent.selector, origin: "USER_ASSERTION", authority: parentLineage.authority, sourceTime: parentLineage.sourceTime }],
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey: `mem0-profile-${identity}-dream`,
    derivation: { kind: "DREAM_DERIVATION", producer: "yuvi-dream", producerVersion: "1", policyVersion: "test.v1" }
  });
  if (lineage.state !== "GROUNDED" || lineage.origin !== "DERIVED") throw new Error("Invalid Dream lineage fixture.");
  return lineage;
}
