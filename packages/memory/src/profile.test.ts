import { InMemoryEvidenceAdmissionStore, EvidenceAdmissionV1Schema, memoryEffectDigest } from "./evidence-admission.js";
import { describe, expect, it, vi } from "vitest";
import { MemoryBackendError, type MemoryBackend, type MemoryRecord } from "./backend.js";
import { encodeMemoryLineage, canonicalLineageJson, LINEAGE_ENCODING, lineageDigest } from "./lineage-encoding.js";
import { MemoryLineageV1Schema, type GroundedMemoryLineageV1 } from "./lineage.js";
import { buildMemoryScope } from "./scope.js";
import { InMemoryMemoryRepository, type MemoryRepository } from "./repository.js";
import { LegacyProfileMemorySourceReader, Mem0ProfileMemorySourceReader } from "./profile-source-reader.js";
import {
  canonicalizeGroundedLineage,
  materializeProfileSnapshot,
  rootsForLineage
} from "./profile-materializer.js";
import {
  ProfileSnapshotCorruptionError,
  ProfileSnapshotConflictError,
  ProfileEvidenceSourceV1Schema,
  PROFILE_MATERIALIZER_VERSION,
  profileSubjectKey,
  profileRevisionFor,
  profileSourceSetDigest,
  type ProfileEvidenceSourceV1,
  type ProfileSubjectV1
} from "./profile-types.js";
import { InMemoryProfileSnapshotStore } from "./profile-snapshot-store.js";
import { LocalProfileProvider } from "./profile-provider.js";
import { mapMem0RecordToMemoryEvent } from "./providers/mem0-memory-provider.js";

const scope = buildMemoryScope("profile-user", "profile-persona");
const subject: ProfileSubjectV1 = { kind: "MEMORY_SCOPE", scope };
const recordedAt = "2026-09-30T08:00:00.000Z";
const authority = {
  principal: { state: "UNRESOLVED" as const, reason: "transport identity is unavailable" },
  binding: { state: "UNRESOLVED" as const, reason: "Person binding is unavailable" },
  audience: { kind: "UNKNOWN" as const, reason: "audience is unavailable" }
};

function ref(index: number) {
  return { kind: "JOURNAL_EVENT" as const, namespace: "profile-test", eventId: `jev1_${index.toString(16).padStart(16, "0")}` };
}

function selector(index: number) {
  const parent = ref(index);
  return {
    version: "source-selector.v1" as const,
    modality: "TEXT" as const,
    payload: { namespace: parent.namespace, payloadId: `payload-${index}`, version: "v1" },
    range: { unit: "UNICODE_CODE_POINT" as const, start: 0, end: 40 }
  };
}

function directLineage(index: number, consumerKey = `consumer-${index}`, derivation = "RULE_BASED_EXTRACTION" as const): GroundedMemoryLineageV1 {
  return MemoryLineageV1Schema.parse({
    version: "memory-lineage.v1",
    state: "GROUNDED",
    parents: [{ ref: ref(index), selector: selector(index) }],
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey,
    derivation: { kind: derivation, producer: "profile-test", producerVersion: "1", policyVersion: "test.v1" },
    origin: "USER_ASSERTION",
    authority,
    sourceTime: { recordedAt, occurrenceTime: { state: "UNKNOWN" } }
  }) as GroundedMemoryLineageV1;
}

function dreamLineage(index: number, consumerKey = `dream-${index}`): GroundedMemoryLineageV1 {
  const parent = ref(index);
  const sourceSelector = selector(index);
  return MemoryLineageV1Schema.parse({
    version: "memory-lineage.v1",
    state: "GROUNDED",
    origin: "DERIVED",
    parents: [{ ref: parent, selector: sourceSelector }],
    sources: [{ ref: parent, selector: sourceSelector, origin: "USER_ASSERTION", authority, sourceTime: { recordedAt, occurrenceTime: { state: "UNKNOWN" } } }],
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey,
    derivation: { kind: "DREAM_DERIVATION", producer: "yuvi-dream", producerVersion: "1", policyVersion: "dream.v1" }
  }) as GroundedMemoryLineageV1;
}

function source(input: {
  id: string;
  lineage: GroundedMemoryLineageV1;
  content?: string;
  scope?: string;
  contradicts?: string[];
  supersedes?: string[];
  claimClass?: ProfileEvidenceSourceV1["claimClass"];
}): ProfileEvidenceSourceV1 {
  const lineage = canonicalizeGroundedLineage(input.lineage);
  return ProfileEvidenceSourceV1Schema.parse({
    version: "yuvi-profile-evidence-source.v1",
    memory: { memoryId: `legacy:${input.id}`, backend: "legacy", sourceRecordId: input.id },
    scope: input.scope ?? scope,
    nativeScope: { kind: "user", scopeId: null },
    kind: "fact",
    subtype: null,
    content: input.content ?? "The source text is retained verbatim.",
    claimClass: input.claimClass ?? null,
    lineage,
    lineageDigest: lineageDigest(canonicalLineageJson(lineage)),
    lifecycle: { state: "ACTIVE", coverage: "NATIVE", validFrom: "2025-01-01T00:00:00.000Z", validUntil: null, expiresAt: null },
    relationships: {
      coverage: "NATIVE",
      supersedes: (input.supersedes ?? []).map((id) => ({ memoryId: `legacy:${id}`, backend: "legacy", sourceRecordId: id })),
      supersededBy: null,
      contradicts: (input.contradicts ?? []).map((id) => ({ memoryId: `legacy:${id}`, backend: "legacy", sourceRecordId: id }))
    },
    roots: rootsForLineage(lineage)
  });
}

function memoryId(index: number): string { return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`; }

async function addGrounded(repository: InMemoryMemoryRepository, index: number, options: {
  status?: "active" | "superseded" | "archived" | "forgotten" | "expired";
  expiresAt?: string | null;
  validFrom?: string;
  validUntil?: string | null;
  supersededAt?: string | null;
  supersededBy?: string | null;
  supersedes?: string[];
  contradicts?: string[];
  content?: string;
  userId?: string;
  personaId?: string;
} = {}) {
  const lineage = directLineage(index);
  return repository.createGroundedMemory!({
    memory: {
      type: "episodic",
      content: options.content ?? `grounded source ${index}`,
      source: "profile-test",
      ...(options.status === undefined ? {} : { status: options.status }),
      subjectUserId: options.userId ?? "profile-user",
      personaId: options.personaId ?? "profile-persona",
      observedAt: recordedAt,
      validFrom: options.validFrom ?? "2025-01-01T00:00:00.000Z",
      ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      ...(options.supersededAt === undefined ? {} : { supersededAt: options.supersededAt }),
      ...(options.supersededBy === undefined ? {} : { supersededBy: options.supersededBy }),
      ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
      ...(options.contradicts === undefined ? {} : { contradicts: options.contradicts })
    },
    lineage,
    payloadDigest: index.toString(16).padStart(64, "0")
  });
}

function mem0Record(index: number, lineage = MemoryLineageV1Schema.parse({ ...directLineage(index), derivation: { ...directLineage(index).derivation, kind: "FINALIZED_INGESTION" } }) as GroundedMemoryLineageV1, content = `mem0 evidence ${index}`): MemoryRecord {
  return {
    id: memoryId(index),
    content,
    scope,
    metadata: {
      ...encodeMemoryLineage(lineage),
      memoryType: "fact",
      yuviAssertionSource: "user",
      yuviVerification: "unverified",
      yuviObservedAt: recordedAt
    }
  };
}


async function admittedFixtureRecords(records: MemoryRecord[]) {
  const store = new InMemoryEvidenceAdmissionStore();
  for (const record of records) {
    const lineage = mapMem0RecordToMemoryEvent(record, scope).lineage!;
    const logicalEventId = `fixture:${record.id}`;
    const admissionId = `ea1_${lineageDigest(canonicalLineageJson({ scope, logicalEventId }))}`;
    await store.prepare(EvidenceAdmissionV1Schema.parse({
      version: "evidence-admission.v1", admissionId, scope, logicalEventId,
      producer: "FINALIZED_INGESTION", payloadDigest: "a".repeat(64), lineage,
      lineageDigest: lineageDigest(canonicalLineageJson(lineage)), effectDigest: memoryEffectDigest(record),
      backend: "mem0", backendRecordId: null, state: "PREPARED"
    }));
    await store.bind(scope, logicalEventId, record.id);
  }
  return store;
}

describe("A10.1f1 local profile materializer", () => {
  it("canonicalizes source order and excludes generatedAt from digest and revision", () => {
    const a = source({ id: memoryId(1), lineage: directLineage(1), content: "A" });
    const b = source({ id: memoryId(2), lineage: directLineage(2), content: "B" });
    const first = materializeProfileSnapshot({ subject, backend: "legacy", sources: [a, b], generatedAt: recordedAt });
    const reordered = materializeProfileSnapshot({ subject, backend: "legacy", sources: [b, a], generatedAt: "2026-10-01T08:00:00.000Z" });
    expect(reordered.sourceSet.sourceSetDigest).toBe(first.sourceSet.sourceSetDigest);
    expect(reordered.profileRevision).toBe(first.profileRevision);
    expect(reordered.generatedAt).not.toBe(first.generatedAt);
    expect(profileSourceSetDigest(first.sourceSet.sources)).toBe(first.sourceSet.sourceSetDigest);
  });

  it("binds content and Journal ancestry while keeping policy in profileRevision", () => {
    const original = source({ id: memoryId(3), lineage: directLineage(3), content: "Same text" });
    const changedText = source({ id: memoryId(3), lineage: directLineage(3), content: "Changed text" });
    const changedRoot = source({ id: memoryId(4), lineage: directLineage(4), content: "Same text" });
    const base = materializeProfileSnapshot({ subject, backend: "legacy", sources: [original], generatedAt: recordedAt });
    expect(materializeProfileSnapshot({ subject, backend: "legacy", sources: [changedText], generatedAt: recordedAt }).sourceSet.sourceSetDigest).not.toBe(base.sourceSet.sourceSetDigest);
    expect(materializeProfileSnapshot({ subject, backend: "legacy", sources: [changedRoot], generatedAt: recordedAt }).sourceSet.sourceSetDigest).not.toBe(base.sourceSet.sourceSetDigest);
    expect(profileRevisionFor({ subject, sourceSetDigest: base.sourceSet.sourceSetDigest, materializerVersion: "policy.next" })).not.toBe(base.profileRevision);
    expect(base.profileRevision).toMatch(/^pf1_[a-f0-9]{64}$/u);
  });

  it("normalizes equivalent lineage instants before source hashing", () => {
    const canonical = directLineage(140);
    const offset = structuredClone(canonical);
    if (!('sourceTime' in offset)) throw new Error("Expected direct lineage source time.");
    offset.sourceTime.recordedAt = "2026-09-30T10:00:00+02:00";
    offset.sourceTime.occurrenceTime = {
      state: "INTERVAL",
      start: "2026-09-30T10:00:00+02:00",
      end: "2026-09-30T11:00:00+02:00",
      clockSource: "test-clock",
      uncertaintyMs: 1
    };
    const canonicalOccurrence = structuredClone(canonical);
    if (!('sourceTime' in canonicalOccurrence)) throw new Error("Expected direct lineage source time.");
    canonicalOccurrence.sourceTime.occurrenceTime = {
      state: "INTERVAL",
      start: "2026-09-30T08:00:00.000Z",
      end: "2026-09-30T09:00:00.000Z",
      clockSource: "test-clock",
      uncertaintyMs: 1
    };
    const first = source({ id: memoryId(140), lineage: canonicalOccurrence, content: "Same instant." });
    const second = source({ id: memoryId(140), lineage: offset, content: "Same instant." });
    expect(second.lineage).toEqual(first.lineage);
    expect(materializeProfileSnapshot({ subject, backend: "legacy", sources: [second], generatedAt: recordedAt }).sourceSet.sourceSetDigest)
      .toBe(materializeProfileSnapshot({ subject, backend: "legacy", sources: [first], generatedAt: recordedAt }).sourceSet.sourceSetDigest);
  });

  it("keeps direct and Dream representations while sharing one original receipt root", () => {
    const direct = source({ id: memoryId(5), lineage: directLineage(5), content: "The original text." });
    const dream = source({ id: memoryId(6), lineage: dreamLineage(5), content: "The original text." });
    const snapshot = materializeProfileSnapshot({ subject, backend: "legacy", sources: [direct, dream], generatedAt: recordedAt });
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries.map((entry) => entry.derivation).sort()).toEqual(["DERIVED", "DIRECT"]);
    expect(snapshot.entries[0]!.rootEvidenceKeys).toEqual(snapshot.entries[1]!.rootEvidenceKeys);
    expect(snapshot.entries[0]!.rootEvidenceKeys).toHaveLength(1);
    expect(snapshot.entries.every((entry) => entry.epistemicStatus === "UNVERIFIED")).toBe(true);
  });

  it("preserves hearsay verbatim and keeps heterogeneous audience and identity constraints", () => {
    const hearsayText = "My friend says the restaurant is closed.";
    const hearsay = source({ id: memoryId(60), lineage: directLineage(60), content: hearsayText, claimClass: "EXTERNAL_CLAIM" });
    const privateRef = ref(61);
    const groupRef = ref(62);
    const privateSelector = selector(61);
    const groupSelector = selector(62);
    const dream = MemoryLineageV1Schema.parse({
      version: "memory-lineage.v1",
      state: "GROUNDED",
      origin: "DERIVED",
      parents: [{ ref: privateRef, selector: privateSelector }, { ref: groupRef, selector: groupSelector }],
      sources: [
        {
          ref: privateRef,
          selector: privateSelector,
          origin: "USER_ASSERTION",
          authority: { ...authority, audience: { kind: "PRIVATE", channelRef: "private-channel" } },
          sourceTime: { recordedAt, occurrenceTime: { state: "UNKNOWN" } }
        },
        {
          ref: groupRef,
          selector: groupSelector,
          origin: "EXTERNAL_OBSERVATION",
          authority: { ...authority, audience: { kind: "GROUP", channelRef: "group-channel", membership: { state: "UNKNOWN", reason: "membership snapshot is unavailable" } } },
          sourceTime: { recordedAt, occurrenceTime: { state: "UNKNOWN" } }
        }
      ],
      sourceAvailability: { state: "RETAINED_SELECTABLE" },
      consumerKey: "dream-with-heterogeneous-audience",
      derivation: { kind: "DREAM_DERIVATION", producer: "yuvi-dream", producerVersion: "1", policyVersion: "dream.v1" }
    }) as GroundedMemoryLineageV1;
    const derived = source({ id: memoryId(63), lineage: dream, content: "Attributed Dream representation." });
    const snapshot = materializeProfileSnapshot({ subject, backend: "legacy", sources: [derived, hearsay], generatedAt: recordedAt });
    const hearsayEntry = snapshot.entries.find((entry) => entry.content === hearsayText)!;
    const derivedEntry = snapshot.entries.find((entry) => entry.content === "Attributed Dream representation.")!;
    expect(hearsayEntry).toMatchObject({ content: hearsayText, claimClass: "EXTERNAL_CLAIM", epistemicStatus: "UNVERIFIED" });
    expect(derivedEntry.derivation).toBe("DERIVED");
    expect(derivedEntry.constraints.map((constraint) => constraint.authority.audience.kind).sort()).toEqual(["GROUP", "PRIVATE"]);
    expect(derivedEntry.constraints.find((constraint) => constraint.authority.audience.kind === "GROUP")?.authority.audience)
      .toEqual({ kind: "GROUP", channelRef: "group-channel", membership: { state: "UNKNOWN", reason: "membership snapshot is unavailable" } });
    expect(derivedEntry.constraints.every((constraint) => constraint.authority.binding.state === "UNRESOLVED")).toBe(true);
    expect(Object.keys(derivedEntry).some((key) => /person|identity/iu.test(key))).toBe(false);
    expect(snapshot.narrative).toBeNull();
  });

  it("deduplicates exact logical aliases but rejects same consumer key with different content", () => {
    const lineage = directLineage(7, "logical-key-7");
    const a = source({ id: memoryId(7), lineage, content: "Verbatim." });
    const alias = source({ id: memoryId(8), lineage, content: "Verbatim." });
    const snapshot = materializeProfileSnapshot({ subject, backend: "legacy", sources: [alias, a], generatedAt: recordedAt });
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]!.evidenceRefs).toHaveLength(2);
    expect(() => materializeProfileSnapshot({ subject, backend: "legacy", sources: [a, source({ id: memoryId(9), lineage, content: "Different." })], generatedAt: recordedAt })).toThrow();
  });

  it("preserves only explicit contradiction and supersession links as symmetric conflicts", () => {
    const aId = memoryId(10);
    const bId = memoryId(11);
    const a = source({ id: aId, lineage: directLineage(10), content: "I like tea.", contradicts: [bId], supersedes: [bId] });
    const b = source({ id: bId, lineage: directLineage(11), content: "I dislike tea." });
    const snapshot = materializeProfileSnapshot({ subject, backend: "legacy", sources: [a, b], generatedAt: recordedAt });
    expect(snapshot.generationState).toBe("PARTIAL");
    expect(snapshot.entries.every((entry) => entry.status === "CONFLICTING")).toBe(true);
    expect(snapshot.entries[0]!.conflicts).toHaveLength(2);
    const unlinked = materializeProfileSnapshot({
      subject,
      backend: "legacy",
      sources: [source({ id: memoryId(12), lineage: directLineage(12), content: "Tea is good." }), source({ id: memoryId(13), lineage: directLineage(13), content: "Tea is not good." })],
      generatedAt: recordedAt
    });
    expect(unlinked.generationState).toBe("COMPLETE");
    expect(unlinked.entries.every((entry) => entry.semanticConflictAssessment === "NOT_ASSESSED")).toBe(true);
  });

  it("lists more than the old recent-memory bound and keeps legacy state read-only", async () => {
    const repository = new InMemoryMemoryRepository();
    const accessTimes = new Map<string, string>();
    for (let index = 1; index <= 120; index += 1) {
      const result = await addGrounded(repository, index);
      accessTimes.set(result.memory.id, result.memory.lastAccessedAt.toISOString());
    }
    const reader = new LegacyProfileMemorySourceReader(repository);
    const outcome = await reader.listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(outcome.state).toBe("COMPLETE");
    expect(outcome.sources).toHaveLength(120);
    expect(outcome.diagnostics.scannedCount).toBe(120);
    const after = await Promise.all([...accessTimes.keys()].map(async (id) => (await repository.getMemoryById(id))?.lastAccessedAt.toISOString()));
    expect(after).toEqual([...accessTimes.values()]);
  });

  it("filters scope before the row bound and classifies lifecycle at exact expiry", async () => {
    const repository = new InMemoryMemoryRepository();
    for (let index = 1; index <= 24; index += 1) await addGrounded(repository, index, { userId: index <= 12 ? "other-user" : "profile-user" });
    await addGrounded(repository, 25, { status: "superseded" });
    await addGrounded(repository, 26, { status: "forgotten" });
    await addGrounded(repository, 27, { expiresAt: "2026-10-02T00:00:00.000Z" });
    await addGrounded(repository, 28, { validFrom: "2026-10-03T00:00:00.000Z" });
    const outcome = await new LegacyProfileMemorySourceReader(repository).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(outcome.state).toBe("COMPLETE");
    expect(outcome.sources).toHaveLength(12);
    expect(outcome.diagnostics.excludedCounts.SUPERSEDED).toBe(1);
    expect(outcome.diagnostics.excludedCounts.INACTIVE).toBe(1);
    expect(outcome.diagnostics.excludedCounts.EXPIRED).toBe(1);
    expect(outcome.diagnostics.excludedCounts.NOT_YET_VALID).toBe(1);
  });

  it("fails closed for malformed lineage and reports legacy raw-byte overflow", async () => {
    const row = {
      id: memoryId(30), subjectUserId: "profile-user", personaId: "profile-persona", scope: "user", scopeId: null,
      type: "episodic", subtype: null, content: "broken", status: "active", validFrom: "2025-01-01T00:00:00.000Z",
      validUntil: null, expiresAt: null, supersededAt: null, supersedes: [], supersededBy: null, contradicts: [],
      lineage: { version: "memory-lineage.v1", state: "GROUNDED" }, lineageConsumerKey: "key", evidenceClassification: null,
      claimMetadata: {}, contentByteLength: 6, lineageByteLength: 49, relationshipsOversized: false, rawByteLength: 100
    };
    const malformedRepository = { kind: "in-memory", listProfileSourceSnapshot: async () => ({ records: [row], exhausted: true, rawBytesExceeded: false }) } as unknown as MemoryRepository;
    const malformed = await new LegacyProfileMemorySourceReader(malformedRepository).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(malformed).toMatchObject({ state: "ERROR", reasons: ["LINEAGE_INVALID"], sources: [] });
    const overflowRepository = { kind: "in-memory", listProfileSourceSnapshot: async () => ({ records: [], exhausted: false, rawBytesExceeded: true }) } as unknown as MemoryRepository;
    const overflow = await new LegacyProfileMemorySourceReader(overflowRepository).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(overflow).toMatchObject({ state: "PARTIAL", reasons: ["SOURCE_BYTES_BOUND"], sources: [] });
  });

  it("marks oversized legacy relationship lists and valid oversized Mem0 lineage as partial", async () => {
    const row = {
      id: memoryId(31), subjectUserId: "profile-user", personaId: "profile-persona", scope: "user", scopeId: null,
      type: "episodic", subtype: null, content: "bounded", status: "active", validFrom: "2025-01-01T00:00:00.000Z",
      validUntil: null, expiresAt: null, supersededAt: null, supersedes: null, supersededBy: null, contradicts: null,
      lineage: directLineage(31), lineageConsumerKey: "consumer-31", evidenceClassification: null,
      claimMetadata: {}, contentByteLength: 7, lineageByteLength: 500, relationshipsOversized: true, rawByteLength: 1000
    };
    const legacy = await new LegacyProfileMemorySourceReader({
      kind: "in-memory",
      listProfileSourceSnapshot: async () => ({ records: [row], exhausted: true, rawBytesExceeded: false })
    } as unknown as MemoryRepository).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(legacy).toMatchObject({ state: "PARTIAL", reasons: ["SOURCE_BYTES_BOUND"], sources: [] });

    const base = directLineage(32);
    const oversizedLineage = MemoryLineageV1Schema.parse({
      ...base,
      parents: Array.from({ length: 400 }, () => ({ ref: ref(32), selector: selector(32) }))
    }) as GroundedMemoryLineageV1;
    const json = canonicalLineageJson(oversizedLineage);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(65_536);
    const record = mem0Record(32);
    record.metadata["yuviLineageEncoding"] = LINEAGE_ENCODING;
    record.metadata["yuviLineageJson"] = json;
    record.metadata["yuviLineageDigest"] = lineageDigest(json);
    const backend = {
      kind: "mem0",
      list: async () => ({ items: [record], snapshot: { mode: "bounded_snapshot" as const, exhausted: true, rawBytesExceeded: false } })
    } as unknown as MemoryBackend;
    const mem0 = await new Mem0ProfileMemorySourceReader(backend, new InMemoryEvidenceAdmissionStore()).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(mem0).toMatchObject({ state: "PARTIAL", reasons: ["LINEAGE_BOUND"], sources: [] });
  });

  it("excludes legacy gaps and NON_EVIDENCE, rejects wrong partitions, and proves the 4,096-row boundary", async () => {
    const repository = new InMemoryMemoryRepository();
    await addGrounded(repository, 80);
    const one = (await repository.listProfileSourceSnapshot({ scope, rawLimit: 4096 })).records[0]!;
    const legacyGap = { ...one, id: memoryId(81), lineage: null, lineageByteLength: 0, lineageConsumerKey: null };
    const nonEvidence = { ...one, id: memoryId(82), lineage: null, lineageByteLength: 0, lineageConsumerKey: null, evidenceClassification: "NON_EVIDENCE" as const };
    const exclusions = await new LegacyProfileMemorySourceReader({
      kind: "in-memory",
      listProfileSourceSnapshot: async () => ({ records: [legacyGap, nonEvidence], exhausted: true, rawBytesExceeded: false })
    } as unknown as MemoryRepository).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(exclusions).toMatchObject({ state: "COMPLETE", sources: [], diagnostics: { excludedCounts: { LEGACY_INCOMPLETE: 1, NON_EVIDENCE: 1 } } });

    const wrongPartition = await new LegacyProfileMemorySourceReader({
      kind: "in-memory",
      listProfileSourceSnapshot: async () => ({ records: [{ ...one, subjectUserId: "foreign-user" }], exhausted: true, rawBytesExceeded: false })
    } as unknown as MemoryRepository).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(wrongPartition).toMatchObject({ state: "ERROR", reasons: ["SCOPE_MISMATCH"], sources: [] });

    const boundedRows = Array.from({ length: 4097 }, (_, index) => ({ ...one, id: memoryId(1000 + index) }));
    const bounded = await new LegacyProfileMemorySourceReader({
      kind: "in-memory",
      listProfileSourceSnapshot: async () => ({ records: boundedRows, exhausted: false, rawBytesExceeded: false })
    } as unknown as MemoryRepository).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(bounded).toMatchObject({ state: "PARTIAL", reasons: ["ROW_BOUND"], diagnostics: { scannedCount: 4096, eligibleCount: 4096, exhausted: false } });
    expect(bounded.sources).toHaveLength(4096);
  });

  it("requires Mem0 snapshot exhaustion proof and reuses semantic lineage mapping", async () => {
    const records = Array.from({ length: 125 }, (_, index) => mem0Record(index + 100));
    const backend = {
      kind: "mem0",
      list: vi.fn(async () => ({ items: records, total: records.length, snapshot: { mode: "bounded_snapshot" as const, exhausted: true, rawBytesExceeded: false } }))
    } as unknown as MemoryBackend;
    const outcome = await new Mem0ProfileMemorySourceReader(backend, await admittedFixtureRecords(records)).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(backend.list).toHaveBeenCalledWith({ scope, limit: 4096, mode: "bounded_snapshot" }, undefined);
    expect(outcome.state).toBe("COMPLETE");
    expect(outcome.sources).toHaveLength(125);
    expect(outcome.sources[0]!.lineage).toEqual(mapMem0RecordToMemoryEvent(records[0]!, scope).lineage);
    expect(outcome.sources[0]!.lifecycle.coverage).toBe("PRESENT_RECORD_ONLY");
  });

  it("does not treat missing Mem0 marker as empty or unsupported enumeration as a fallback", async () => {
    const missing = { kind: "mem0", list: async () => ({ items: [], total: 0 }) } as unknown as MemoryBackend;
    const partial = await new Mem0ProfileMemorySourceReader(missing, new InMemoryEvidenceAdmissionStore()).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(partial).toMatchObject({ state: "PARTIAL", reasons: ["EXHAUSTION_UNPROVEN"] });
    const unsupported = { kind: "mem0", list: async () => { throw new MemoryBackendError("ENUMERATION_UNSUPPORTED", "unsupported"); } } as unknown as MemoryBackend;
    const unavailable = await new Mem0ProfileMemorySourceReader(unsupported, new InMemoryEvidenceAdmissionStore()).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
    expect(unavailable).toMatchObject({ state: "UNAVAILABLE", reasons: ["ENUMERATION_UNSUPPORTED"] });
    const olderCappedService = { kind: "mem0", list: async () => { throw new MemoryBackendError("VALIDATION_ERROR", "bounded mode rejected"); } } as unknown as MemoryBackend;
    expect(await new Mem0ProfileMemorySourceReader(olderCappedService, new InMemoryEvidenceAdmissionStore()).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" }))
      .toMatchObject({ state: "UNAVAILABLE", reasons: ["ENUMERATION_UNSUPPORTED"] });
    const timeout = { kind: "mem0", list: async () => { throw new MemoryBackendError("OPERATION_TIMEOUT", "timed out"); } } as unknown as MemoryBackend;
    expect(await new Mem0ProfileMemorySourceReader(timeout, new InMemoryEvidenceAdmissionStore()).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" }))
      .toMatchObject({ state: "UNAVAILABLE", reasons: ["TIMEOUT"] });
  });

  it("rejects malformed Mem0 records and lineage and returns explicit byte-bound partials", async () => {
    const marker = { mode: "bounded_snapshot" as const, exhausted: true, rawBytesExceeded: false };
    const invalidRecord = { kind: "mem0", list: async () => ({ items: [{ ...mem0Record(90), id: "not-a-uuid" }], snapshot: marker }) } as unknown as MemoryBackend;
    expect(await new Mem0ProfileMemorySourceReader(invalidRecord, new InMemoryEvidenceAdmissionStore()).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" }))
      .toMatchObject({ state: "ERROR", reasons: ["RECORD_INVALID"] });
    const badLineageRecord = mem0Record(91);
    badLineageRecord.metadata["yuviLineageJson"] = "{";
    const badLineage = { kind: "mem0", list: async () => ({ items: [badLineageRecord], snapshot: marker }) } as unknown as MemoryBackend;
    expect(await new Mem0ProfileMemorySourceReader(badLineage, new InMemoryEvidenceAdmissionStore()).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" }))
      .toMatchObject({ state: "ERROR", reasons: ["LINEAGE_INVALID"] });
    const rawOverflow = { kind: "mem0", list: async () => ({ items: [], snapshot: { ...marker, exhausted: false, rawBytesExceeded: true } }) } as unknown as MemoryBackend;
    expect(await new Mem0ProfileMemorySourceReader(rawOverflow, new InMemoryEvidenceAdmissionStore()).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" }))
      .toMatchObject({ state: "PARTIAL", reasons: ["SOURCE_BYTES_BOUND"], sources: [] });
  });

  it("keeps disabled and partial reads from manufacturing or persisting an empty profile", async () => {
    const store = new InMemoryProfileSnapshotStore();
    const historical = materializeProfileSnapshot({ subject, backend: "legacy", sources: [source({ id: memoryId(49), lineage: directLineage(49) })], generatedAt: recordedAt });
    await store.putImmutable(historical);
    const unavailableReader = vi.fn(() => ({ listEligibleSources: async () => ({
      state: "UNAVAILABLE" as const, backend: null, sources: [], reasons: ["MEMORY_DISABLED" as const],
      diagnostics: { asOf: recordedAt, scannedCount: 0, eligibleCount: 0, exhausted: false, excludedCounts: {
        LEGACY_INCOMPLETE: 0, NON_EVIDENCE: 0, PAYLOAD_UNAVAILABLE: 0, UNSUPPORTED_ORIGIN: 0, UNSUPPORTED_DERIVATION: 0,
        UNSUPPORTED_SELECTOR: 0, INACTIVE: 0, SUPERSEDED: 0, NOT_YET_VALID: 0, EXPIRED: 0, ROOT_RETIRED: 0
      } }
    }) }));
    const disabled = new LocalProfileProvider({
      store,
      resolveSourceReader: unavailableReader
    });
    expect(await disabled.getProfile({ subject })).toMatchObject({ state: "COMPLETE", freshness: "UNCHECKED", snapshot: { profileRevision: historical.profileRevision } });
    expect(unavailableReader).not.toHaveBeenCalled();
    const result = await disabled.generate({ subject });
    expect(result).toMatchObject({ state: "UNAVAILABLE", snapshot: null, code: "SOURCE_UNAVAILABLE" });
    expect(await store.getCurrent({ subject })).toMatchObject({ profileRevision: historical.profileRevision });
    expect(unavailableReader).toHaveBeenCalledTimes(1);
    expect(disabled.capabilities()).toMatchObject({ providerId: "yuvi-local-profile", hosted: false, asyncGeneration: false, materializerVersion: PROFILE_MATERIALIZER_VERSION });
  });

  it("keeps immutable replay timestamps and selects the last explicitly generated revision", async () => {
    const store = new InMemoryProfileSnapshotStore();
    const snapshot = materializeProfileSnapshot({ subject, backend: "legacy", sources: [source({ id: memoryId(50), lineage: directLineage(50) })], generatedAt: recordedAt });
    const created = await store.putImmutable(snapshot);
    const replay = await store.putImmutable({ ...snapshot, generatedAt: "2026-10-01T00:00:00.000Z" });
    expect(created.disposition).toBe("CREATED");
    expect(replay.disposition).toBe("REPLAY");
    expect(replay.snapshot.generatedAt).toBe(recordedAt);
    const returned = await store.getCurrent({ subject });
    returned!.entries[0]!.content = "tampered";
    expect((await store.getCurrent({ subject }))!.entries[0]!.content).not.toBe("tampered");
  });

  it("serializes concurrent pointer selection, preserves history, detects corruption, and handles empty-backend replay", async () => {
    const store = new InMemoryProfileSnapshotStore();
    const first = materializeProfileSnapshot({ subject, backend: "legacy", sources: [source({ id: memoryId(100), lineage: directLineage(100), content: "First." })], generatedAt: recordedAt });
    const second = materializeProfileSnapshot({ subject, backend: "legacy", sources: [source({ id: memoryId(101), lineage: directLineage(101), content: "Second." })], generatedAt: recordedAt });
    const [firstPut, secondPut] = await Promise.all([store.putImmutable(first), store.putImmutable(second)]);
    expect(firstPut.disposition).toBe("CREATED");
    expect(secondPut.disposition).toBe("CREATED");
    expect((await store.getCurrent({ subject }))?.profileRevision).toBe(second.profileRevision);
    expect((await store.getRevision({ subject, profileRevision: first.profileRevision }))?.profileRevision).toBe(first.profileRevision);
    const providerVariant = structuredClone(second);
    providerVariant.producer.providerVersion = "descriptive-version-2";
    await expect(store.putImmutable(providerVariant)).rejects.toBeInstanceOf(ProfileSnapshotConflictError);

    const stored = (store as unknown as { snapshots: Map<string, { payload: { entries: Array<{ content: string }> }; digest: string }> })
      .snapshots.get(`${profileSubjectKey(subject)}\u0000${second.profileRevision}`)!;
    stored.payload.entries[0]!.content = "corrupted payload";
    await expect(store.getRevision({ subject, profileRevision: second.profileRevision })).rejects.toBeInstanceOf(ProfileSnapshotCorruptionError);

    const emptyLegacy = materializeProfileSnapshot({ subject, backend: "legacy", sources: [], generatedAt: recordedAt });
    const emptyMem0 = materializeProfileSnapshot({ subject, backend: "mem0", sources: [], generatedAt: "2026-10-01T00:00:00.000Z" });
    const emptyStore = new InMemoryProfileSnapshotStore();
    await emptyStore.putImmutable(emptyLegacy);
    const replay = await emptyStore.putImmutable(emptyMem0);
    expect(replay.disposition).toBe("REPLAY");
    expect(replay.snapshot.sourceSet.backend).toBe("legacy");
  });
});
