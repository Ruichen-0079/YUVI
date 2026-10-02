import {
  type GroundedMemoryLineageV1,
  GroundedAuthoritySchema,
  MemoryLineageV1Schema,
  OccurrenceTimeSchema
} from "./lineage.js";
import { canonicalLineageJson } from "./lineage-encoding.js";
import {
  PROFILE_MAX_SNAPSHOT_BYTES,
  PROFILE_MAX_SOURCE_SET_BYTES,
  PROFILE_MATERIALIZER_VERSION,
  PROFILE_VERSION,
  ProfileEvidenceSourceV1Schema,
  ProfileSnapshotV1Schema,
  profileRevisionFor,
  profileRootKey,
  profileSha256,
  profileSourceSetDigest,
  parseProfileSubject,
  type ProfileEntryV1,
  type ProfileEvidenceSourceV1,
  type ProfileMemoryRef,
  type ProfileRootConstraintV1,
  type ProfileSnapshotV1,
  type ProfileSubjectV1
} from "./profile-types.js";
import { z } from "zod";

type OccurrenceTime = z.infer<typeof OccurrenceTimeSchema>;

export class ProfileMaterializationError extends Error {
  constructor(readonly code: "SOURCE_IDENTITY_CONFLICT" | "ROOT_SNAPSHOT_CONFLICT" | "SNAPSHOT_BOUND") {
    super("Profile evidence could not be materialized under the frozen contract.");
    this.name = "ProfileMaterializationError";
  }
}

export function canonicalizeGroundedLineage(input: GroundedMemoryLineageV1): GroundedMemoryLineageV1 {
  const parsed = MemoryLineageV1Schema.parse(input);
  if (parsed.state !== "GROUNDED") throw new TypeError("Grounded lineage required.");
  const lineage = structuredClone(parsed) as GroundedMemoryLineageV1;
  if (lineage.origin === "DERIVED" && "sources" in lineage) {
    lineage.sources = lineage.sources.map((source) => ({
      ...source,
      authority: canonicalizeAuthority(source.authority),
      sourceTime: canonicalizeSourceTime(source.sourceTime)
    }));
    lineage.sources = dedupeSort(lineage.sources);
    lineage.parents = lineage.sources.map(({ ref, selector }) => ({ ref, selector }));
  } else if ("parents" in lineage) {
    lineage.parents = dedupeSort(lineage.parents);
    lineage.authority = canonicalizeAuthority(lineage.authority);
    lineage.sourceTime = canonicalizeSourceTime(lineage.sourceTime);
  }
  const checked = MemoryLineageV1Schema.parse(lineage);
  if (checked.state !== "GROUNDED") throw new TypeError("Grounded lineage required.");
  return checked;
}

export function rootsForLineage(lineage: GroundedMemoryLineageV1): ProfileRootConstraintV1[] {
  const roots: ProfileRootConstraintV1[] = [];
  if (lineage.origin === "DERIVED" && "sources" in lineage) {
    for (const source of lineage.sources) {
      roots.push({
        rootKey: profileRootKey(source.ref),
        ref: structuredClone(source.ref),
        selector: structuredClone(source.selector),
        origin: source.origin,
        authority: canonicalizeAuthority(source.authority),
        sourceTime: structuredClone(source.sourceTime)
      });
    }
  } else if ("parents" in lineage) {
    if (lineage.origin !== "USER_ASSERTION" && lineage.origin !== "EXTERNAL_OBSERVATION") {
      throw new TypeError("Direct profile lineage must retain user or observation origin.");
    }
    for (const parent of lineage.parents) {
      if (parent.selector.modality !== "TEXT") continue;
      roots.push({
        rootKey: profileRootKey(parent.ref),
        ref: structuredClone(parent.ref),
        selector: structuredClone(parent.selector),
        origin: lineage.origin,
        authority: canonicalizeAuthority(lineage.authority),
        sourceTime: structuredClone(lineage.sourceTime)
      });
    }
  }
  const normalized = dedupeSort(roots);
  assertNoRootSnapshotConflicts(normalized);
  return normalized;
}

export function canonicalizeProfileEvidenceSource(source: ProfileEvidenceSourceV1): ProfileEvidenceSourceV1 {
  const lineage = canonicalizeGroundedLineage(source.lineage);
  const roots = rootsForLineage(lineage);
  return ProfileEvidenceSourceV1Schema.parse({
    ...structuredClone(source),
    lineage,
    lineageDigest: profileSha256(lineage),
    relationships: {
      ...structuredClone(source.relationships),
      supersedes: dedupeSort(source.relationships.supersedes),
      contradicts: dedupeSort(source.relationships.contradicts)
    },
    roots
  });
}

export function materializeProfileSnapshot(input: {
  subject: ProfileSubjectV1;
  backend: "legacy" | "mem0";
  sources: ProfileEvidenceSourceV1[];
  generatedAt: string;
}): ProfileSnapshotV1 {
  const subject = parseProfileSubject(input.subject);
  const physical = new Map<string, ProfileEvidenceSourceV1>();
  for (const source of input.sources.map(canonicalizeProfileEvidenceSource)) {
    const key = `${source.memory.backend}:${source.memory.sourceRecordId}`;
    const previous = physical.get(key);
    if (previous && canonicalLineageJson(previous) !== canonicalLineageJson(source)) {
      throw new ProfileMaterializationError("SOURCE_IDENTITY_CONFLICT");
    }
    physical.set(key, source);
  }
  const sources = [...physical.values()].sort(compareSources);
  const normalizedSourceBytes = Buffer.byteLength(canonicalLineageJson(sources), "utf8");
  if (normalizedSourceBytes > PROFILE_MAX_SOURCE_SET_BYTES) throw new ProfileMaterializationError("SNAPSHOT_BOUND");
  validateRootSnapshotSet(sources);
  const sourceSetDigest = profileSourceSetDigest(sources);
  const profileRevision = profileRevisionFor({
    subject,
    sourceSetDigest,
    materializerVersion: PROFILE_MATERIALIZER_VERSION
  });
  const entries = materializeEntries(subject, sources);
  const snapshot: ProfileSnapshotV1 = {
    version: PROFILE_VERSION,
    subject,
    profileRevision,
    producer: {
      providerId: "yuvi-local-profile",
      providerVersion: "1",
      materializerVersion: PROFILE_MATERIALIZER_VERSION
    },
    generationState: sources.length === 0
      ? "INSUFFICIENT_EVIDENCE"
      : entries.some((entry) => entry.status === "CONFLICTING") ? "PARTIAL" : "COMPLETE",
    generatedAt: new Date(input.generatedAt).toISOString(),
    sourceSet: { completeness: "COMPLETE", backend: input.backend, sourceSetDigest, sources },
    entries,
    narrative: null
  };
  const parsed = ProfileSnapshotV1Schema.parse(snapshot);
  if (Buffer.byteLength(canonicalLineageJson(parsed), "utf8") > PROFILE_MAX_SNAPSHOT_BYTES) {
    throw new ProfileMaterializationError("SNAPSHOT_BOUND");
  }
  return parsed;
}

function materializeEntries(subject: ProfileSubjectV1, sources: ProfileEvidenceSourceV1[]): ProfileEntryV1[] {
  const groups = new Map<string, ProfileEvidenceSourceV1[]>();
  for (const source of sources) {
    const key = `${source.scope}\u0000${source.lineage.consumerKey}`;
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  const logical = new Map<string, { id: string; key: string; sources: ProfileEvidenceSourceV1[]; base: ProfileEvidenceSourceV1 }>();
  for (const [key, group] of groups) {
    const base = group[0]!;
    const payload = canonicalLineageJson(withoutMemory(base));
    if (group.some((source) => canonicalLineageJson(withoutMemory(source)) !== payload)) {
      throw new ProfileMaterializationError("SOURCE_IDENTITY_CONFLICT");
    }
    const entryId = `pe1_${profileSha256({ scope: subject.scope, consumerKey: base.lineage.consumerKey })}`;
    logical.set(key, { id: entryId, key, sources: group, base });
  }
  const byPhysicalRef = new Map<string, string>();
  for (const item of logical.values()) {
    for (const source of item.sources) {
      const refKey = canonicalLineageJson(source.memory);
      const previous = byPhysicalRef.get(refKey);
      if (previous && previous !== item.id) throw new ProfileMaterializationError("SOURCE_IDENTITY_CONFLICT");
      byPhysicalRef.set(refKey, item.id);
    }
  }
  const conflicts = new Map<string, Map<string, "CONTRADICTS" | "UNRESOLVED_SUPERSESSION">>();
  const addConflict = (a: string, b: string, reason: "CONTRADICTS" | "UNRESOLVED_SUPERSESSION") => {
    if (a === b) throw new ProfileMaterializationError("SOURCE_IDENTITY_CONFLICT");
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const edges = conflicts.get(from) ?? new Map();
      edges.set(`${to}\u0000${reason}`, reason);
      conflicts.set(from, edges);
    }
  };
  for (const item of logical.values()) {
    for (const source of item.sources) {
      for (const ref of source.relationships.contradicts) {
        const target = byPhysicalRef.get(canonicalLineageJson(ref));
        if (target) addConflict(item.id, target, "CONTRADICTS");
      }
      for (const ref of source.relationships.supersedes) {
        const target = byPhysicalRef.get(canonicalLineageJson(ref));
        if (target) addConflict(item.id, target, "UNRESOLVED_SUPERSESSION");
      }
    }
  }
  const entries: ProfileEntryV1[] = [];
  for (const item of logical.values()) {
    const rootConstraints = dedupeSort(item.sources.flatMap((source) => source.roots));
    const rootKeys = [...new Set(rootConstraints.map((root) => root.rootKey))].sort(ordinal);
    const source = item.base;
    const edges = [...(conflicts.get(item.id) ?? new Map()).entries()]
      .map(([key, reason]) => ({ entryId: key.slice(0, key.indexOf("\u0000")), reason }))
      .sort((a, b) => ordinal(canonicalLineageJson(a), canonicalLineageJson(b)));
    entries.push({
      entryId: item.id,
      content: source.content,
      kind: source.kind,
      subtype: source.subtype,
      claimClass: source.claimClass,
      status: edges.length ? "CONFLICTING" : "EVIDENCE",
      epistemicStatus: "UNVERIFIED",
      derivation: source.lineage.origin === "DERIVED" ? "DERIVED" : "DIRECT",
      evidenceRefs: dedupeSort(item.sources.map(({ memory }) => memory)),
      rootEvidenceKeys: rootKeys,
      constraints: rootConstraints,
      conflictAssessment: "EXPLICIT_LINKS_ONLY",
      semanticConflictAssessment: "NOT_ASSESSED",
      conflicts: edges
    });
  }
  return entries.sort((a, b) => ordinal(a.entryId, b.entryId));
}

function withoutMemory(source: ProfileEvidenceSourceV1): Omit<ProfileEvidenceSourceV1, "memory"> {
  const { memory: _memory, ...rest } = source;
  return rest;
}

function canonicalizeAuthority(authority: z.infer<typeof GroundedAuthoritySchema>) {
  const value = structuredClone(authority);
  if (value.principal.state === "AMBIGUOUS") value.principal.candidates = dedupeSort(value.principal.candidates);
  if (value.binding.state === "CONFLICTING") value.binding.candidates = dedupeSort(value.binding.candidates);
  return GroundedAuthoritySchema.parse(value);
}

function canonicalizeSourceTime<T extends { recordedAt: string; occurrenceTime: OccurrenceTime }>(sourceTime: T): T {
  const occurrenceTime = sourceTime.occurrenceTime;
  const normalizedOccurrence = occurrenceTime.state === "INSTANT"
    ? { ...occurrenceTime, at: new Date(occurrenceTime.at).toISOString() }
    : occurrenceTime.state === "INTERVAL"
      ? { ...occurrenceTime, start: new Date(occurrenceTime.start).toISOString(), end: new Date(occurrenceTime.end).toISOString() }
      : occurrenceTime;
  return {
    ...sourceTime,
    recordedAt: new Date(sourceTime.recordedAt).toISOString(),
    occurrenceTime: normalizedOccurrence
  } as T;
}

function assertNoRootSnapshotConflicts(roots: ProfileRootConstraintV1[]): void {
  const seen = new Map<string, string>();
  for (const root of roots) {
    const key = canonicalLineageJson({ ref: root.ref, selector: root.selector });
    const payload = canonicalLineageJson(root);
    const old = seen.get(key);
    if (old !== undefined && old !== payload) throw new ProfileMaterializationError("ROOT_SNAPSHOT_CONFLICT");
    seen.set(key, payload);
  }
}

function validateRootSnapshotSet(sources: ProfileEvidenceSourceV1[]): void {
  const roots = sources.flatMap((source) => source.roots);
  assertNoRootSnapshotConflicts(roots);
}

function dedupeSort<T>(values: T[]): T[] {
  const byJson = new Map<string, T>();
  for (const value of values) byJson.set(canonicalLineageJson(value), value);
  return [...byJson.entries()].sort(([a], [b]) => ordinal(a, b)).map(([, value]) => structuredClone(value));
}

function compareSources(a: ProfileEvidenceSourceV1, b: ProfileEvidenceSourceV1): number {
  return ordinal(a.memory.backend, b.memory.backend) || ordinal(a.memory.sourceRecordId, b.memory.sourceRecordId);
}
function ordinal(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
