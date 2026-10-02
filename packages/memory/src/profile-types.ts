import { createHash } from "node:crypto";
import { JournalEventRefSchema, SourceSelectorSchema } from "@companion/protocol";
import { z } from "zod";
import { MEMORY_CLAIM_PROVENANCE_CLASSES, type MemoryClaimProvenanceClass, type MemoryEventKind } from "./provider.js";
import { MemorySubtypes, MemoryScopes, MemoryTypes } from "./types.js";
import { buildMemoryScope, parseMemoryScope } from "./scope.js";
import {
  GroundedAuthoritySchema,
  MemoryLineageV1Schema,
  OccurrenceTimeSchema,
  type GroundedMemoryLineageV1
} from "./lineage.js";
import { canonicalLineageJson, lineageDigest as sha256Hex } from "./lineage-encoding.js";
import type { SourceSelector } from "@companion/protocol";

export const PROFILE_VERSION = "yuvi-profile.v1" as const;
export const PROFILE_EVIDENCE_SOURCE_VERSION = "yuvi-profile-evidence-source.v1" as const;
export const PROFILE_MATERIALIZER_VERSION = "a10.1f1-deterministic-evidence.v1" as const;
export const PROFILE_SOURCE_SET_VERSION = "yuvi-profile-source-set.v1" as const;
export const PROFILE_MAX_RAW_RECORDS = 4096;
export const PROFILE_MAX_ROOTS_PER_SOURCE = 256;
export const PROFILE_MAX_CONTENT_BYTES = 65_536;
export const PROFILE_MAX_LINEAGE_BYTES = 65_536;
export const PROFILE_MAX_SOURCE_SET_BYTES = 16_777_216;
export const PROFILE_MAX_SNAPSHOT_BYTES = 67_108_864;
export const PROFILE_IO_TIMEOUT_MS = 30_000;

const MAX_REF_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const Opaque512 = z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= MAX_REF_BYTES);
const Instant = z.string().datetime({ offset: true });
const EventKind = z.enum(["episodic", "fact", "user_claim", "interaction", "correction", "commitment_evidence"]);
const Subtype = z.enum(MemorySubtypes);
const ClaimClass = z.enum(MEMORY_CLAIM_PROVENANCE_CLASSES);
const TextSelectorSchema = SourceSelectorSchema
  .refine((selector) => selector.modality === "TEXT")
  .transform((selector) => selector as Extract<SourceSelector, { modality: "TEXT" }>);

export const ProfileSubjectV1Schema = z.object({
  kind: z.literal("MEMORY_SCOPE"),
  scope: z.string().min(1).refine((scope) => Buffer.byteLength(scope, "utf8") <= 2048).superRefine((scope, ctx) => {
    try {
      const parts = parseMemoryScope(scope);
      if (buildMemoryScope(parts.userId, parts.characterId) !== scope ||
          Buffer.byteLength(parts.userId, "utf8") > MAX_REF_BYTES ||
          Buffer.byteLength(parts.characterId, "utf8") > MAX_REF_BYTES ||
          parts.userId.trim() !== parts.userId || parts.characterId.trim() !== parts.characterId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Scope is not canonical." });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Scope is invalid." });
    }
  }),
  subjectReference: z.string().min(1).refine((s) => s.trim() === s && Buffer.byteLength(s, "utf8") <= MAX_REF_BYTES)
}).strict().partial({ subjectReference: true });
export type ProfileSubjectV1 = z.infer<typeof ProfileSubjectV1Schema>;

export const ProfileMemoryRefSchema = z.object({
  memoryId: z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= MAX_REF_BYTES),
  backend: z.enum(["legacy", "mem0"]),
  sourceRecordId: z.string().regex(UUID)
}).strict().superRefine((ref, ctx) => {
  const prefix = ref.backend === "legacy" ? "legacy:" : "mem0:";
  if (ref.memoryId !== `${prefix}${ref.sourceRecordId}`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Memory reference identity does not match its backend." });
  }
});
export type ProfileMemoryRef = z.infer<typeof ProfileMemoryRefSchema>;

export const ProfileRootConstraintV1Schema = z.object({
  rootKey: z.string().regex(/^pr1_[a-f0-9]{64}$/u),
  ref: JournalEventRefSchema,
  selector: TextSelectorSchema,
  origin: z.enum(["USER_ASSERTION", "EXTERNAL_OBSERVATION"]),
  authority: GroundedAuthoritySchema,
  sourceTime: z.object({ recordedAt: Instant, occurrenceTime: OccurrenceTimeSchema }).strict()
}).strict();
export type ProfileRootConstraintV1 = z.infer<typeof ProfileRootConstraintV1Schema>;

const ProfileGroundedLineage = MemoryLineageV1Schema.refine(
  (lineage): lineage is GroundedMemoryLineageV1 => lineage.state === "GROUNDED",
  "Profile evidence requires grounded lineage."
);

export const ProfileEvidenceSourceV1Schema = z.object({
  version: z.literal(PROFILE_EVIDENCE_SOURCE_VERSION),
  memory: ProfileMemoryRefSchema,
  scope: z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= 2048),
  nativeScope: z.object({ kind: z.enum(MemoryScopes), scopeId: z.string().nullable().refine((s) => s === null || Buffer.byteLength(s, "utf8") <= MAX_REF_BYTES) }).strict().nullable(),
  kind: EventKind,
  subtype: Subtype.nullable(),
  content: z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= PROFILE_MAX_CONTENT_BYTES),
  claimClass: ClaimClass.nullable(),
  lineage: ProfileGroundedLineage,
  lineageDigest: z.string().regex(SHA256),
  lifecycle: z.object({
    state: z.literal("ACTIVE"),
    coverage: z.enum(["NATIVE", "PRESENT_RECORD_ONLY"]),
    validFrom: Instant.nullable(),
    validUntil: Instant.nullable(),
    expiresAt: Instant.nullable()
  }).strict(),
  relationships: z.object({
    coverage: z.enum(["NATIVE", "NOT_PROVIDED"]),
    supersedes: z.array(ProfileMemoryRefSchema).max(PROFILE_MAX_RAW_RECORDS),
    supersededBy: ProfileMemoryRefSchema.nullable(),
    contradicts: z.array(ProfileMemoryRefSchema).max(PROFILE_MAX_RAW_RECORDS)
  }).strict(),
  roots: z.array(ProfileRootConstraintV1Schema).min(1).max(PROFILE_MAX_ROOTS_PER_SOURCE)
}).strict();
export type ProfileEvidenceSourceV1 = z.infer<typeof ProfileEvidenceSourceV1Schema>;

export const ProfileEntryV1Schema = z.object({
  entryId: z.string().regex(/^pe1_[a-f0-9]{64}$/u),
  content: z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= PROFILE_MAX_CONTENT_BYTES),
  kind: EventKind,
  subtype: Subtype.nullable(),
  claimClass: ClaimClass.nullable(),
  status: z.enum(["EVIDENCE", "CONFLICTING"]),
  epistemicStatus: z.literal("UNVERIFIED"),
  derivation: z.enum(["DIRECT", "DERIVED"]),
  evidenceRefs: z.array(ProfileMemoryRefSchema).min(1).max(PROFILE_MAX_RAW_RECORDS),
  rootEvidenceKeys: z.array(z.string().regex(/^pr1_[a-f0-9]{64}$/u)).min(1).max(PROFILE_MAX_ROOTS_PER_SOURCE),
  constraints: z.array(ProfileRootConstraintV1Schema).min(1).max(PROFILE_MAX_ROOTS_PER_SOURCE),
  conflictAssessment: z.literal("EXPLICIT_LINKS_ONLY"),
  semanticConflictAssessment: z.literal("NOT_ASSESSED"),
  conflicts: z.array(z.object({
    entryId: z.string().regex(/^pe1_[a-f0-9]{64}$/u),
    reason: z.enum(["CONTRADICTS", "UNRESOLVED_SUPERSESSION"])
  }).strict()).max(8192)
}).strict();
export type ProfileEntryV1 = z.infer<typeof ProfileEntryV1Schema>;

export const ProfileSnapshotV1Schema = z.object({
  version: z.literal(PROFILE_VERSION),
  subject: ProfileSubjectV1Schema,
  profileRevision: z.string().regex(/^pf1_[a-f0-9]{64}$/u),
  producer: z.object({
    providerId: z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= 160),
    providerVersion: z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= 160),
    materializerVersion: z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= 160)
  }).strict(),
  generationState: z.enum(["COMPLETE", "PARTIAL", "INSUFFICIENT_EVIDENCE"]),
  generatedAt: Instant,
  sourceSet: z.object({
    completeness: z.literal("COMPLETE"),
    backend: z.enum(["legacy", "mem0"]),
    sourceSetDigest: z.string().regex(SHA256),
    sources: z.array(ProfileEvidenceSourceV1Schema).max(PROFILE_MAX_RAW_RECORDS)
  }).strict(),
  entries: z.array(ProfileEntryV1Schema).max(PROFILE_MAX_RAW_RECORDS),
  narrative: z.null()
}).strict();
export type ProfileSnapshotV1 = z.infer<typeof ProfileSnapshotV1Schema>;

export type ProfileSourceReadReason =
  | "ROW_BOUND" | "CONTENT_BOUND" | "LINEAGE_BOUND" | "SOURCE_BYTES_BOUND"
  | "EXHAUSTION_UNPROVEN" | "MEMORY_DISABLED" | "ENUMERATION_UNSUPPORTED"
  | "BACKEND_UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "RECORD_INVALID"
  | "LINEAGE_INVALID" | "SCOPE_MISMATCH" | "SOURCE_IDENTITY_CONFLICT" | "BACKEND_ERROR";
export type ProfileExclusionReason =
  | "LEGACY_INCOMPLETE" | "NON_EVIDENCE" | "PAYLOAD_UNAVAILABLE" | "UNSUPPORTED_ORIGIN"
  | "UNSUPPORTED_DERIVATION" | "UNSUPPORTED_SELECTOR" | "INACTIVE" | "SUPERSEDED"
  | "NOT_YET_VALID" | "EXPIRED" | "ROOT_RETIRED";
export type ProfileSourceReadOutcome = {
  state: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "ERROR";
  backend: "legacy" | "mem0" | null;
  sources: ProfileEvidenceSourceV1[];
  reasons: ProfileSourceReadReason[];
  diagnostics: {
    asOf: string;
    scannedCount: number;
    eligibleCount: number;
    excludedCounts: Record<ProfileExclusionReason, number>;
    exhausted: boolean;
  };
};

export type ProfileSourceReadInput = { subject: ProfileSubjectV1; asOf: string; signal?: AbortSignal };
export interface ProfileMemorySourceReader {
  listEligibleSources(input: ProfileSourceReadInput): Promise<ProfileSourceReadOutcome>;
}

export type ProfileProviderCapabilities = {
  providerId: string;
  providerVersion: string;
  localPrivate: boolean;
  hosted: boolean;
  asyncGeneration: boolean;
  schemaVersion: typeof PROFILE_VERSION;
  materializerVersion: string;
  sourceBackends: ("legacy" | "mem0")[];
};
export type ProfileFailureCode =
  | "SOURCE_UNAVAILABLE" | "SOURCE_ERROR" | "SOURCE_PARTIAL" | "SNAPSHOT_BOUND"
  | "STORE_UNAVAILABLE" | "STORE_ERROR" | "PROFILE_REVISION_CONFLICT" | "GENERATION_NOT_FOUND";
export type ProfileReadOutcome =
  | { state: "COMPLETE" | "PARTIAL" | "INSUFFICIENT_EVIDENCE"; snapshot: ProfileSnapshotV1; freshness: "UNCHECKED" }
  | { state: "NOT_FOUND"; snapshot: null }
  | { state: "FAILED" | "UNAVAILABLE"; snapshot: null; code: ProfileFailureCode };
export type ProfileGenerationOutcome =
  | { state: "COMPLETE" | "PARTIAL" | "INSUFFICIENT_EVIDENCE"; snapshot: ProfileSnapshotV1; persistence: "CREATED" | "REPLAY"; sourceRead: ProfileSourceReadOutcome }
  | { state: "PARTIAL" | "FAILED" | "UNAVAILABLE"; snapshot: null; code: ProfileFailureCode; sourceRead: ProfileSourceReadOutcome | null }
  | { state: "PENDING"; snapshot: null; generationId: string };
export type ProfileGenerationStatus =
  | { state: "PENDING"; generationId: string }
  | { state: "COMPLETE" | "PARTIAL" | "INSUFFICIENT_EVIDENCE"; generationId: string; subject: ProfileSubjectV1; profileRevision: string }
  | { state: "FAILED" | "UNAVAILABLE"; generationId: string; code: ProfileFailureCode };

export interface ProfileProvider {
  capabilities(): ProfileProviderCapabilities;
  getProfile(input: { subject: ProfileSubjectV1; profileRevision?: string; signal?: AbortSignal }): Promise<ProfileReadOutcome>;
  generate(input: { subject: ProfileSubjectV1; signal?: AbortSignal }): Promise<ProfileGenerationOutcome>;
  getGenerationStatus?(input: { subject: ProfileSubjectV1; generationId: string; signal?: AbortSignal }): Promise<ProfileGenerationStatus>;
}

export class ProfileValidationError extends TypeError {
  readonly code = "PROFILE_INPUT_INVALID";
  constructor(message = "Profile input is invalid.") { super(message); this.name = "ProfileValidationError"; }
}

export class ProfileSnapshotConflictError extends Error {
  readonly code = "PROFILE_REVISION_CONFLICT";
  constructor() { super("Profile revision is already bound to a different immutable payload."); this.name = "ProfileSnapshotConflictError"; }
}

export class ProfileSnapshotCorruptionError extends Error {
  constructor() { super("Stored profile snapshot failed integrity validation."); this.name = "ProfileSnapshotCorruptionError"; }
}

export function parseProfileSubject(value: unknown): ProfileSubjectV1 {
  const parsed = ProfileSubjectV1Schema.safeParse(value);
  if (!parsed.success) throw new ProfileValidationError();
  return parsed.data;
}

export function profileSha256(value: unknown): string {
  return createHash("sha256").update(canonicalLineageJson(value), "utf8").digest("hex");
}

export function profileSubjectKey(subject: ProfileSubjectV1): string {
  return `ps1_${profileSha256(parseProfileSubject(subject))}`;
}

export function profileSourceSetDigest(sources: ProfileEvidenceSourceV1[]): string {
  return profileSha256({ version: PROFILE_SOURCE_SET_VERSION, sources });
}

export function profileRevisionFor(input: {
  subject: ProfileSubjectV1; sourceSetDigest: string; materializerVersion: string
}): string {
  return `pf1_${profileSha256({ schemaVersion: PROFILE_VERSION, materializerVersion: input.materializerVersion, subject: parseProfileSubject(input.subject), sourceSetDigest: input.sourceSetDigest })}`;
}

export function profileRootKey(ref: z.infer<typeof JournalEventRefSchema>): string {
  return `pr1_${profileSha256(ref)}`;
}

export function validateProfileSnapshot(value: unknown): ProfileSnapshotV1 {
  const parsed = ProfileSnapshotV1Schema.safeParse(value);
  if (!parsed.success) throw new ProfileSnapshotCorruptionError();
  const snapshot = parsed.data;
  const normalizedBytes = Buffer.byteLength(canonicalLineageJson(snapshot.sourceSet.sources), "utf8");
  if (normalizedBytes > PROFILE_MAX_SOURCE_SET_BYTES || Buffer.byteLength(canonicalLineageJson(snapshot), "utf8") > PROFILE_MAX_SNAPSHOT_BYTES) {
    throw new ProfileSnapshotCorruptionError();
  }
  const sortedSources = [...snapshot.sourceSet.sources].sort(compareSources);
  if (canonicalLineageJson(sortedSources) !== canonicalLineageJson(snapshot.sourceSet.sources) ||
      profileSourceSetDigest(snapshot.sourceSet.sources) !== snapshot.sourceSet.sourceSetDigest ||
      profileRevisionFor({ subject: snapshot.subject, sourceSetDigest: snapshot.sourceSet.sourceSetDigest, materializerVersion: snapshot.producer.materializerVersion }) !== snapshot.profileRevision) {
    throw new ProfileSnapshotCorruptionError();
  }
  const physical = new Set<string>();
  const sourceByRef = new Map<string, ProfileEvidenceSourceV1>();
  for (const source of snapshot.sourceSet.sources) {
    if (source.scope !== snapshot.subject.scope ||
        source.lineageDigest !== sha256Hex(canonicalLineageJson(source.lineage)) ||
        Buffer.byteLength(canonicalLineageJson(source.lineage), "utf8") > PROFILE_MAX_LINEAGE_BYTES ||
        source.roots.some((root) => root.rootKey !== profileRootKey(root.ref)) ||
        !sourceRootsMatchLineage(source) ||
        !isCanonicalSource(source) ||
        source.memory.backend !== snapshot.sourceSet.backend ||
        source.claimClass === "ASSISTANT_INFERENCE" ||
        !isEligibleProfileLineage(source.lineage) ||
        source.relationships.supersededBy !== null ||
        source.relationships.supersedes.some((ref) => ref.backend !== source.memory.backend) ||
        source.relationships.contradicts.some((ref) => ref.backend !== source.memory.backend)) {
      throw new ProfileSnapshotCorruptionError();
    }
    const key = `${source.memory.backend}:${source.memory.sourceRecordId}`;
    if (physical.has(key)) throw new ProfileSnapshotCorruptionError();
    physical.add(key);
    sourceByRef.set(canonicalLineageJson(source.memory), source);
  }
  const entryIds = new Set(snapshot.entries.map((entry) => entry.entryId));
  if (!sameArray(snapshot.entries.map((entry) => entry.entryId), [...snapshot.entries.map((entry) => entry.entryId)].sort(ordinal))) {
    throw new ProfileSnapshotCorruptionError();
  }
  for (const entry of snapshot.entries) {
    const refs = entry.evidenceRefs.map((ref) => canonicalLineageJson(ref));
    const sourceEntries = entry.evidenceRefs.map((ref) => sourceByRef.get(canonicalLineageJson(ref)));
    const sourceGroup = sourceEntries.filter((source): source is ProfileEvidenceSourceV1 => source !== undefined);
    const constraints = sortCanonical(sourceGroup.flatMap((source) => source.roots));
    const rootKeys = [...new Set(constraints.map((root) => root.rootKey))].sort(ordinal);
    const base = sourceGroup[0];
    if (!base || entry.entryId !== `pe1_${profileSha256({ scope: snapshot.subject.scope, consumerKey: entryConsumerKey(entry, sourceByRef) })}` ||
        sourceEntries.some((source) => source === undefined) ||
        !sameArray(refs, [...refs].sort(ordinal)) ||
        sourceGroup.some((source) => source.lineage.consumerKey !== base.lineage.consumerKey ||
          canonicalLineageJson(sourceWithoutMemory(source)) !== canonicalLineageJson(sourceWithoutMemory(base))) ||
        entry.content !== base.content || entry.kind !== base.kind || entry.subtype !== base.subtype ||
        entry.claimClass !== base.claimClass || entry.derivation !== (base.lineage.origin === "DERIVED" ? "DERIVED" : "DIRECT") ||
        canonicalLineageJson(entry.constraints) !== canonicalLineageJson(constraints) ||
        canonicalLineageJson(entry.rootEvidenceKeys) !== canonicalLineageJson(rootKeys) ||
        !sameArray(entry.conflicts.map((edge) => canonicalLineageJson(edge)), [...entry.conflicts.map((edge) => canonicalLineageJson(edge))].sort(ordinal)) ||
        entry.conflicts.some((edge) => edge.entryId === entry.entryId || !entryIds.has(edge.entryId)) ||
        entry.status !== (entry.conflicts.length ? "CONFLICTING" : "EVIDENCE")) {
      throw new ProfileSnapshotCorruptionError();
    }
  }
  for (const entry of snapshot.entries) {
    for (const edge of entry.conflicts) {
      const peer = snapshot.entries.find((candidate) => candidate.entryId === edge.entryId);
      if (!peer?.conflicts.some((reverse) => reverse.entryId === entry.entryId && reverse.reason === edge.reason)) throw new ProfileSnapshotCorruptionError();
    }
  }
  const expectedState = snapshot.sourceSet.sources.length === 0
    ? "INSUFFICIENT_EVIDENCE"
    : snapshot.entries.some((entry) => entry.status === "CONFLICTING") ? "PARTIAL" : "COMPLETE";
  if (snapshot.generationState !== expectedState) throw new ProfileSnapshotCorruptionError();
  return snapshot;
}

function compareSources(a: ProfileEvidenceSourceV1, b: ProfileEvidenceSourceV1): number {
  return ordinal(a.memory.backend, b.memory.backend) || ordinal(a.memory.sourceRecordId, b.memory.sourceRecordId);
}

function ordinal(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function entryConsumerKey(entry: ProfileEntryV1, sources: Map<string, ProfileEvidenceSourceV1>): string {
  const keys = entry.evidenceRefs.map((ref) => sources.get(canonicalLineageJson(ref))?.lineage.consumerKey).filter((key): key is string => Boolean(key));
  if (!keys.length || keys.some((key) => key !== keys[0])) throw new ProfileSnapshotCorruptionError();
  return keys[0]!;
}

function sourceRootsMatchLineage(source: ProfileEvidenceSourceV1): boolean {
  const expected: ProfileRootConstraintV1[] = [];
  const lineage = source.lineage;
  if (lineage.origin === "DERIVED" && "sources" in lineage) {
    for (const parent of lineage.sources) expected.push({
      rootKey: profileRootKey(parent.ref), ref: parent.ref, selector: parent.selector,
      origin: parent.origin, authority: parent.authority, sourceTime: parent.sourceTime
    });
  } else if ("parents" in lineage && (lineage.origin === "USER_ASSERTION" || lineage.origin === "EXTERNAL_OBSERVATION")) {
    for (const parent of lineage.parents) {
      if (parent.selector.modality !== "TEXT") return false;
      expected.push({
        rootKey: profileRootKey(parent.ref), ref: parent.ref,
        selector: TextSelectorSchema.parse(parent.selector), origin: lineage.origin,
        authority: lineage.authority, sourceTime: lineage.sourceTime
      });
    }
  } else return false;
  const normalized = sortCanonical(expected);
  return canonicalLineageJson(normalized) === canonicalLineageJson(source.roots);
}

function isEligibleProfileLineage(lineage: GroundedMemoryLineageV1): boolean {
  if (lineage.origin === "DERIVED") return "sources" in lineage && lineage.derivation.kind === "DREAM_DERIVATION" && lineage.sources.every((source) => source.selector.modality === "TEXT");
  return (lineage.origin === "USER_ASSERTION" || lineage.origin === "EXTERNAL_OBSERVATION") &&
    "parents" in lineage && ["RULE_BASED_EXTRACTION", "EXPLICIT_REMEMBER", "CORRECTION", "FINALIZED_INGESTION"].includes(lineage.derivation.kind) &&
    lineage.parents.every((parent) => parent.selector.modality === "TEXT");
}

function isCanonicalSource(source: ProfileEvidenceSourceV1): boolean {
  if (!sameArray(source.relationships.supersedes.map(canonicalLineageJson), [...source.relationships.supersedes.map(canonicalLineageJson)].sort(ordinal)) ||
      !sameArray(source.relationships.contradicts.map(canonicalLineageJson), [...source.relationships.contradicts.map(canonicalLineageJson)].sort(ordinal)) ||
      !sameArray(source.roots.map(canonicalLineageJson), [...source.roots.map(canonicalLineageJson)].sort(ordinal))) return false;
  const lineage = source.lineage;
  if (lineage.origin === "DERIVED" && "sources" in lineage) {
    const sourceKeys = lineage.sources.map(canonicalLineageJson);
    return sameArray(sourceKeys, [...sourceKeys].sort(ordinal)) &&
      canonicalLineageJson(lineage.parents) === canonicalLineageJson(lineage.sources.map(({ ref, selector }) => ({ ref, selector })));
  }
  if ("parents" in lineage) {
    const parents = lineage.parents.map(canonicalLineageJson);
    return sameArray(parents, [...parents].sort(ordinal)) &&
      (lineage.authority.principal.state !== "AMBIGUOUS" || sortedUnique(lineage.authority.principal.candidates)) &&
      (lineage.authority.binding.state !== "CONFLICTING" || sortedUnique(lineage.authority.binding.candidates));
  }
  return false;
}

function sourceWithoutMemory(source: ProfileEvidenceSourceV1): unknown {
  const { memory: _memory, ...rest } = source;
  return rest;
}

function sortedUnique(values: unknown[]): boolean {
  const keys = values.map(canonicalLineageJson);
  return sameArray(keys, [...new Set(keys)].sort(ordinal));
}

function sortCanonical<T>(values: T[]): T[] {
  const byKey = new Map(values.map((value) => [canonicalLineageJson(value), value] as const));
  return [...byKey.entries()].sort(([a], [b]) => ordinal(a, b)).map(([, value]) => value);
}

function sameArray<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
