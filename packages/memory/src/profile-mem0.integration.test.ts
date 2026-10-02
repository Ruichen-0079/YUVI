import { describe, expect, it, vi } from "vitest";
import { Mem0MemoryBackend } from "./backends/mem0-memory-backend.js";
import { encodeMemoryLineage } from "./lineage-encoding.js";
import { MemoryLineageV1Schema } from "./lineage.js";
import { buildMemoryScope } from "./scope.js";
import {
  Mem0MemoryProvider,
  mapMem0RecordToMemoryEvent
} from "./providers/mem0-memory-provider.js";
import { Mem0ProfileMemorySourceReader } from "./profile-source-reader.js";
import { materializeProfileSnapshot } from "./profile-materializer.js";
import { InMemoryProfileSnapshotStore } from "./profile-snapshot-store.js";
import { LocalProfileProvider } from "./profile-provider.js";
import { InMemoryProfileLifecycleStore } from "./profile-lifecycle-store.js";
import type { ProfileSubjectV1 } from "./profile-types.js";
import {
  ProfileLifecycleCoordinator,
  type CapturedProfileComposition
} from "./profile-lifecycle.js";

const sidecarUrl = process.env["YUVI_MEM0_PROFILE_INTEGRATION_URL"];
const asOf = "2026-10-02T00:00:00.000Z";

async function runUntilSelected(
  coordinator: ProfileLifecycleCoordinator,
  lifecycle: InMemoryProfileLifecycleStore,
  subject: ProfileSubjectV1,
  now: { value: Date }
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await lifecycle.get(subject);
    if (
      row?.candidateRevision &&
      row.candidateVersion === row.controlVersion &&
      !row.regenerationNeeded &&
      row.lastError === null
    )
      return row;
    if (row?.nextAttemptAt && Date.parse(row.nextAttemptAt) > now.value.getTime())
      now.value = new Date(row.nextAttemptAt);
    await (coordinator as unknown as { runTick(): Promise<void> }).runTick();
  }
  throw new Error("Profile lifecycle did not select a candidate within the bounded test ticks.");
}

describe.skipIf(!sidecarUrl)("A10.1f1/f2 real local Mem0 integration", () => {
  it("reads a complete 101-record scope, maps finalized and Dream lineage, and replays locally", async () => {
    const identity = crypto.randomUUID().replace(/-/gu, "");
    const scope = buildMemoryScope(`profile-mem0-${identity}`, "local-profile-test");
    const otherScope = buildMemoryScope(`profile-mem0-other-${identity}`, "local-profile-test");
    const subject = { kind: "MEMORY_SCOPE" as const, scope };
    const backend = new Mem0MemoryBackend({
      baseUrl: sidecarUrl!,
      timeoutMs: 30_000,
      writeTimeoutMs: 30_000
    });
    const added: Array<{ memoryId: string; scope: string }> = [];
    const direct = makeLineage(identity, "direct", "FINALIZED_INGESTION");
    const dream = makeDreamLineage(identity, direct);
    const directText = "Please remember that I prefer concise explanations.";
    const dreamText = "A grounded Dream representation of the same receipt.";
    try {
      const directWrite = await backend.add({
        scope,
        content: directText,
        infer: false,
        metadata: {
          ...encodeMemoryLineage(direct),
          memoryType: "fact",
          yuviAssertionSource: "user",
          yuviVerification: "unverified",
          yuviObservedAt: direct.sourceTime.recordedAt
        }
      });
      added.push({ memoryId: directWrite.memoryId, scope });
      const dreamWrite = await backend.add({
        scope,
        content: dreamText,
        infer: false,
        metadata: {
          ...encodeMemoryLineage(dream),
          memoryType: "fact",
          yuviAssertionSource: "system",
          yuviVerification: "unverified"
        }
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
      const isolated = await backend.add({
        scope: otherScope,
        content: "foreign scope sentinel",
        infer: false,
        metadata: { memoryType: "fact" }
      });
      added.push({ memoryId: isolated.memoryId, scope: otherScope });

      const reader = new Mem0ProfileMemorySourceReader(backend);
      const firstRead = await reader.listEligibleSources({ subject, asOf });
      expect(firstRead.state, JSON.stringify(firstRead)).toBe("COMPLETE");
      expect(firstRead.diagnostics.scannedCount).toBe(101);
      expect(firstRead.sources).toHaveLength(2);
      expect(firstRead.diagnostics.excludedCounts.LEGACY_INCOMPLETE).toBe(99);
      expect(firstRead.sources.map((source) => source.lineage.origin).sort()).toEqual([
        "DERIVED",
        "USER_ASSERTION"
      ]);
      expect(firstRead.sources[0]!.roots.map((root) => root.rootKey)).toEqual(
        firstRead.sources[1]!.roots.map((root) => root.rootKey)
      );
      expect(firstRead.sources.every((source) => source.scope === scope)).toBe(true);

      const semanticProvider = new Mem0MemoryProvider(backend);
      for (const source of firstRead.sources) {
        const record = await backend.get({ memoryId: source.memory.sourceRecordId, scope });
        expect(record).not.toBeNull();
        if (!record)
          throw new Error("Profile source could not be read through the existing Mem0 get path.");
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
      if (
        generated.state === "COMPLETE" ||
        generated.state === "PARTIAL" ||
        generated.state === "INSUFFICIENT_EVIDENCE"
      ) {
        if (!generated.snapshot) throw new Error("Generation returned no snapshot.");
        expect(generated.snapshot.sourceSet.sources).toHaveLength(2);
      } else throw new Error("Local profile generation did not complete.");
      const again = await provider.generate({ subject });
      expect(again).toMatchObject({ state: "COMPLETE", persistence: "REPLAY" });
      if (generated.snapshot && again.snapshot)
        expect(again.snapshot.profileRevision).toBe(generated.snapshot.profileRevision);
      expect(provider.capabilities()).toMatchObject({
        hosted: false,
        asyncGeneration: false,
        providerId: "yuvi-local-profile"
      });
      expect(vi.isMockFunction(backend.search)).toBe(false);
    } finally {
      for (const item of added)
        await backend.delete({ memoryId: item.memoryId, scope: item.scope }).catch(() => undefined);
    }
  }, 60_000);

  it("uses COMPLETE live reads for scope freshness and withholds after present-state deletion", async () => {
    const identity = crypto.randomUUID().replace(/-/gu, "");
    const scope = buildMemoryScope(`profile-mem0-f2-${identity}`, "local-profile-test");
    const subject = { kind: "MEMORY_SCOPE" as const, scope };
    const backend = new Mem0MemoryBackend({
      baseUrl: sidecarUrl!,
      timeoutMs: 30_000,
      writeTimeoutMs: 30_000
    });
    const lineage = makeLineage(identity, "f2-live", "FINALIZED_INGESTION");
    const content = "Please remember that I prefer concise explanations.";
    let memoryId: string | null = null;
    let externalMemoryId: string | null = null;
    const now = { value: new Date(asOf) };
    const reader = new Mem0ProfileMemorySourceReader(backend);
    const provider = new LocalProfileProvider({
      resolveSourceReader: () => reader,
      store: new InMemoryProfileSnapshotStore(),
      now: () => new Date(now.value)
    });
    const composition: CapturedProfileComposition = {
      reader,
      provider,
      backend: "mem0",
      compositionToken: {}
    };
    const lifecycle = new InMemoryProfileLifecycleStore(() => new Date(now.value));
    const coordinator = new ProfileLifecycleCoordinator(
      lifecycle,
      undefined,
      composition,
      () => new Date(now.value)
    );
    try {
      const written = await backend.add({
        scope,
        content,
        infer: false,
        metadata: {
          ...encodeMemoryLineage(lineage),
          memoryType: "fact",
          yuviAssertionSource: "user",
          yuviVerification: "unverified",
          yuviObservedAt: lineage.sourceTime.recordedAt
        }
      });
      memoryId = written.memoryId;
      const initialRead = await reader.listEligibleSources({ subject, asOf });
      if (initialRead.state !== "COMPLETE") {
        expect(initialRead.state).toBe("UNAVAILABLE");
        expect(initialRead.reasons).toContain("ENUMERATION_UNSUPPORTED");
        const enrolled = await lifecycle.enroll(subject);
        now.value = new Date(enrolled.nextAttemptAt!);
        await (coordinator as unknown as { runTick(): Promise<void> }).runTick();
        const unavailableRow = await lifecycle.get(subject);
        expect(unavailableRow?.candidateRevision).toBeNull();
        expect(unavailableRow?.lastError).toBe("SOURCE_AUTHORITY_UNSUPPORTED");
        expect(await backend.get({ memoryId, scope })).not.toBeNull();
        await backend.delete({ memoryId, scope });
        expect(await backend.get({ memoryId, scope })).toBeNull();
        return;
      }
      expect(initialRead.state).toBe("COMPLETE");
      await lifecycle.enroll(subject);
      const firstCandidateRow = await runUntilSelected(coordinator, lifecycle, subject, now);
      const firstCandidateRevision = firstCandidateRow?.candidateRevision;
      expect(firstCandidateRevision).toMatch(/^pf1_/u);

      const verified = await coordinator.readScopeModel({ subject, readMemory: true });
      expect(verified.state).toBe("AVAILABLE");
      if (verified.state !== "AVAILABLE")
        throw new Error("Expected a live-verified Mem0 scope model.");
      expect(verified.model.freshness.completeness).toBe("COMPLETE");
      expect(verified.model.personBinding.state).toBe("UNBOUND_SCOPE");

      const externalLineage = makeLineage(
        identity + "-external",
        "f2-external-add",
        "FINALIZED_INGESTION"
      );
      const externalWrite = await backend.add({
        scope,
        content,
        infer: false,
        metadata: {
          ...encodeMemoryLineage(externalLineage),
          memoryType: "fact",
          yuviAssertionSource: "user",
          yuviVerification: "unverified",
          yuviObservedAt: externalLineage.sourceTime.recordedAt
        }
      });
      externalMemoryId = externalWrite.memoryId;
      const addedRead = await reader.listEligibleSources({ subject, asOf });
      expect(addedRead.state, JSON.stringify(addedRead)).toBe("COMPLETE");
      if (addedRead.state !== "COMPLETE")
        throw new Error("External present-state addition must remain completely readable.");
      expect(addedRead.sources).toHaveLength(2);

      const afterExternalAdd = await coordinator.readScopeModel({ subject, readMemory: true });
      expect(afterExternalAdd.state).toBe("WITHHELD");
      expect(afterExternalAdd.model).toBeNull();
      expect((await lifecycle.get(subject))?.regenerationNeeded).toBe(true);

      const expandedRow = await runUntilSelected(coordinator, lifecycle, subject, now);
      const expandedCandidateRevision = expandedRow.candidateRevision;
      expect(expandedCandidateRevision).toMatch(/^pf1_/u);
      expect(expandedCandidateRevision).not.toBe(firstCandidateRevision);
      const verifiedAfterAdd = await coordinator.readScopeModel({ subject, readMemory: true });
      expect(verifiedAfterAdd.state).toBe("AVAILABLE");

      await backend.delete({ memoryId, scope });
      const afterDelete = await reader.listEligibleSources({ subject, asOf });
      expect(afterDelete.state).toBe("COMPLETE");
      if (afterDelete.state !== "COMPLETE")
        throw new Error("Present-state deletion must remain a complete source read.");
      expect(afterDelete.sources).toHaveLength(1);

      const withheld = await coordinator.readScopeModel({ subject, readMemory: true });
      expect(withheld.state).toBe("WITHHELD");
      expect(withheld.model).toBeNull();
      expect((await lifecycle.get(subject))?.regenerationNeeded).toBe(true);

      await backend.delete({ memoryId: externalWrite.memoryId, scope });
      externalMemoryId = null;
    } finally {
      if (memoryId) await backend.delete({ memoryId, scope }).catch(() => undefined);
      if (externalMemoryId)
        await backend.delete({ memoryId: externalMemoryId, scope }).catch(() => undefined);
      await coordinator.shutdown({ graceMs: 2_000 });
    }
  }, 60_000);

  it("confirms present-state deletion through the real Mem0 get and list paths", async () => {
    const identity = crypto.randomUUID().replace(/-/gu, "");
    const scope = buildMemoryScope(`profile-mem0-delete-${identity}`, "local-profile-test");
    const backend = new Mem0MemoryBackend({
      baseUrl: sidecarUrl!,
      timeoutMs: 30_000,
      writeTimeoutMs: 30_000
    });
    const lineage = makeLineage(identity, "delete", "FINALIZED_INGESTION");
    const content = "Please remember that I prefer concise explanations.";
    let memoryId: string | null = null;
    try {
      const written = await backend.add({
        scope,
        content,
        infer: false,
        metadata: {
          ...encodeMemoryLineage(lineage),
          memoryType: "fact",
          yuviAssertionSource: "user",
          yuviVerification: "unverified"
        }
      });
      memoryId = written.memoryId;
      expect(await backend.get({ memoryId, scope })).not.toBeNull();
      await backend.delete({ memoryId, scope });
      expect(await backend.get({ memoryId, scope })).toBeNull();
      const current = await backend.list({ scope, limit: 20 });
      expect(current.items.some((item) => item.id === memoryId)).toBe(false);
    } finally {
      if (memoryId) await backend.delete({ memoryId, scope }).catch(() => undefined);
    }
  }, 60_000);
});

function makeLineage(
  identity: string,
  suffix: string,
  kind: "FINALIZED_INGESTION"
): ReturnType<typeof MemoryLineageV1Schema.parse> & {
  state: "GROUNDED";
  origin: "USER_ASSERTION";
} {
  const parent = {
    kind: "JOURNAL_EVENT" as const,
    namespace: `mem0-profile-${identity}`,
    eventId: `jev1_${identity.slice(0, 16)}`
  };
  const content = "Please remember that I prefer concise explanations.";
  const lineage = MemoryLineageV1Schema.parse({
    version: "memory-lineage.v1",
    state: "GROUNDED",
    parents: [
      {
        ref: parent,
        selector: {
          version: "source-selector.v1",
          modality: "TEXT",
          payload: { namespace: parent.namespace, payloadId: `payload-${suffix}`, version: "v1" },
          range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(content).length }
        }
      }
    ],
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey: `mem0-profile-${identity}-${suffix}`,
    derivation: {
      kind,
      producer: "profile-mem0-integration",
      producerVersion: "1",
      policyVersion: "test.v1"
    },
    origin: "USER_ASSERTION",
    authority: {
      principal: {
        state: "UNRESOLVED",
        reason: "the local test scope does not authenticate a principal"
      },
      binding: { state: "UNRESOLVED", reason: "the local test scope does not bind a Person" },
      audience: { kind: "UNKNOWN", reason: "the test has no audience snapshot" }
    },
    sourceTime: { recordedAt: asOf, occurrenceTime: { state: "UNKNOWN" } }
  });
  if (lineage.state !== "GROUNDED" || lineage.origin !== "USER_ASSERTION")
    throw new Error("Invalid direct lineage fixture.");
  return lineage as typeof lineage & { state: "GROUNDED"; origin: "USER_ASSERTION" };
}

function makeDreamLineage(identity: string, parentLineage: ReturnType<typeof makeLineage>) {
  if (parentLineage.state !== "GROUNDED" || !("parents" in parentLineage))
    throw new Error("Direct lineage parent missing.");
  const parent = parentLineage.parents[0]!;
  const lineage = MemoryLineageV1Schema.parse({
    version: "memory-lineage.v1",
    state: "GROUNDED",
    origin: "DERIVED",
    parents: [{ ref: parent.ref, selector: parent.selector }],
    sources: [
      {
        ref: parent.ref,
        selector: parent.selector,
        origin: "USER_ASSERTION",
        authority: parentLineage.authority,
        sourceTime: parentLineage.sourceTime
      }
    ],
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey: `mem0-profile-${identity}-dream`,
    derivation: {
      kind: "DREAM_DERIVATION",
      producer: "yuvi-dream",
      producerVersion: "1",
      policyVersion: "test.v1"
    }
  });
  if (lineage.state !== "GROUNDED" || lineage.origin !== "DERIVED")
    throw new Error("Invalid Dream lineage fixture.");
  return lineage;
}
