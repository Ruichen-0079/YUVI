import { EvidenceAdmissionIntegrityError, matchesEvidenceEffect, type EvidenceAdmissionStore, type EvidenceAdmissionV1 } from "./evidence-admission.js";
import { Buffer } from "node:buffer";
import {
  MemoryBackendError,
  type MemoryBackend,
  type MemoryRecord
} from "./backend.js";
import { currentCorrectedMemoryEvents } from "./correction.js";
import { deserializeClaimMetadata } from "./claim.js";
import { MemoryLineageV1Schema, type GroundedMemoryLineageV1, type MemoryLineageV1 } from "./lineage.js";
import { canonicalLineageJson, lineageDigest as sha256Text, MemoryLineageEncodingError } from "./lineage-encoding.js";
import { mapMem0RecordToMemoryEvent, Mem0MemoryProviderError } from "./providers/mem0-memory-provider.js";
import { parseMemoryScope } from "./scope.js";
import {
  MemoryScopes,
  MemoryStatuses,
  MemorySubtypes,
  MemoryTypes,
  type MemoryScope
} from "./types.js";
import {
  PROFILE_MAX_CONTENT_BYTES,
  PROFILE_MAX_LINEAGE_BYTES,
  PROFILE_MAX_ROOTS_PER_SOURCE,
  PROFILE_MAX_RAW_RECORDS,
  PROFILE_MAX_SOURCE_SET_BYTES,
  ProfileEvidenceSourceV1Schema,
  ProfileValidationError,
  parseProfileSubject,
  type ProfileEvidenceSourceV1,
  type ProfileExclusionReason,
  type ProfileMemorySourceReader,
  type ProfileRootConstraintV1,
  type ProfileSourceReadInput,
  type ProfileSourceReadOutcome,
  type ProfileSourceReadReason,
  type ProfileSubjectV1
} from "./profile-types.js";
import { canonicalizeGroundedLineage, rootsForLineage } from "./profile-materializer.js";
import type { MemoryRepository, ProfileLegacySourceRow } from "./repository.js";
import type { MemoryEvent } from "./provider.js";

const EXCLUSIONS: ProfileExclusionReason[] = [
  "LEGACY_INCOMPLETE", "NON_EVIDENCE", "PAYLOAD_UNAVAILABLE", "UNSUPPORTED_ORIGIN",
  "UNSUPPORTED_DERIVATION", "UNSUPPORTED_SELECTOR", "INACTIVE", "SUPERSEDED",
  "NOT_YET_VALID", "EXPIRED", "ROOT_RETIRED"
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CLAIM_METADATA_KEYS = [
  "yuviClaimProvenanceClass", "yuviClaimAssertorEntityId", "yuviClaimAssertorSurfaceMention",
  "yuviClaimAssertorResolution", "yuviClaimSubjectEntityId", "yuviClaimSubjectSurfaceMention",
  "yuviClaimSubjectResolution", "yuviClaimRawText", "yuviSourceObservationId",
  "yuviSourceCaptureEpoch", "yuviSourceSegmentId"
] as const;

export class UnavailableProfileMemorySourceReader implements ProfileMemorySourceReader {
  async listEligibleSources(input: ProfileSourceReadInput): Promise<ProfileSourceReadOutcome> {
    const subject = validateReadInput(input);
    return emptyOutcome("UNAVAILABLE", null, ["MEMORY_DISABLED"], input.asOf, false);
  }
}

export class LegacyProfileMemorySourceReader implements ProfileMemorySourceReader {
  constructor(private readonly repository: MemoryRepository) {}

  async listEligibleSources(input: ProfileSourceReadInput): Promise<ProfileSourceReadOutcome> {
    const subject = validateReadInput(input);
    if (input.signal?.aborted) return emptyOutcome("UNAVAILABLE", "legacy", ["CANCELLED"], input.asOf, false);
    try {
      const snapshot = await this.repository.listProfileSourceSnapshot({
        scope: subject.scope,
        rawLimit: PROFILE_MAX_RAW_RECORDS,
        ...(input.signal ? { signal: input.signal } : {})
      });
      if (snapshot.rawBytesExceeded) {
        return emptyOutcome("PARTIAL", "legacy", ["SOURCE_BYTES_BOUND"], input.asOf, false);
      }
      const rows = snapshot.records.slice(0, PROFILE_MAX_RAW_RECORDS);
      const rowBound = snapshot.records.length > PROFILE_MAX_RAW_RECORDS || !snapshot.exhausted;
      const classified = classifyLegacyRows(rows, subject, input.asOf, rowBound);
      return classified;
    } catch (error) {
      if (error instanceof ProfileReadIntegrityError) return emptyOutcome("ERROR", "legacy", [error.reason], input.asOf, false);
      if (error instanceof Error && error.name === "ZodError") return emptyOutcome("ERROR", "legacy", ["RECORD_INVALID"], input.asOf, false);
      if (error instanceof Error && error.name === "ProfileMaterializationError") return emptyOutcome("ERROR", "legacy", ["LINEAGE_INVALID"], input.asOf, false);
      if (input.signal?.aborted || (error instanceof Error && error.name === "ProfileSnapshotReadAbortError")) {
        return emptyOutcome("UNAVAILABLE", "legacy", ["CANCELLED"], input.asOf, false);
      }
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "57014" || code === "ETIMEDOUT") return emptyOutcome("UNAVAILABLE", "legacy", ["TIMEOUT"], input.asOf, false);
      if (["ECONNREFUSED", "ECONNRESET", "57P01", "57P03"].includes(code)) return emptyOutcome("UNAVAILABLE", "legacy", ["BACKEND_UNAVAILABLE"], input.asOf, false);
      return emptyOutcome("ERROR", "legacy", ["BACKEND_ERROR"], input.asOf, false);
    }
  }
}

export class Mem0ProfileMemorySourceReader implements ProfileMemorySourceReader {
  constructor(private readonly backend: MemoryBackend, private readonly admissions?: EvidenceAdmissionStore, private readonly ready?: Promise<unknown>) {
    if (backend.kind !== "mem0") throw new TypeError("Mem0 source reader requires a Mem0 backend.");
  }

  async listEligibleSources(input: ProfileSourceReadInput): Promise<ProfileSourceReadOutcome> {
    const subject = validateReadInput(input);
    if (input.signal?.aborted) return emptyOutcome("UNAVAILABLE", "mem0", ["CANCELLED"], input.asOf, false);
    let result;
    try {
      result = await this.backend.list({ scope: subject.scope, limit: PROFILE_MAX_RAW_RECORDS, mode: "bounded_snapshot" }, input.signal);
    } catch (error) {
      const mapped = mapBackendFailure(error, input.signal);
      return emptyOutcome(mapped.state, "mem0", [mapped.reason], input.asOf, false);
    }
    if (result.snapshot?.rawBytesExceeded) {
      if (result.items.length !== 0 || result.snapshot.exhausted) {
        return emptyOutcome("ERROR", "mem0", ["RECORD_INVALID"], input.asOf, false);
      }
      return emptyOutcome("PARTIAL", "mem0", ["SOURCE_BYTES_BOUND"], input.asOf, false);
    }
    const markerValid = result.snapshot?.mode === "bounded_snapshot" &&
      typeof result.snapshot.exhausted === "boolean" &&
      typeof result.snapshot.rawBytesExceeded === "boolean";
    if (result.items.length > PROFILE_MAX_RAW_RECORDS) {
      return emptyOutcome("ERROR", "mem0", ["RECORD_INVALID"], input.asOf, false);
    }
    const initialReasons: ProfileSourceReadReason[] = [];
    if (!markerValid) initialReasons.push("EXHAUSTION_UNPROVEN");
    else if (!result.snapshot!.exhausted) initialReasons.push("ROW_BOUND");
    let admissions: EvidenceAdmissionV1[];
    try {
      if (!this.admissions) throw new Error("Host admission authority is not configured.");
      await this.ready;
      admissions = await this.admissions.listBound(subject.scope, result.items.map((record) => record.id));
    } catch (error) {
      if (error instanceof EvidenceAdmissionIntegrityError) return emptyOutcome("ERROR", "mem0", ["ADMISSION_INVALID"], input.asOf, false);
      return emptyOutcome("UNAVAILABLE", "mem0", ["ADMISSION_UNAVAILABLE"], input.asOf, false);
    }
    try {
      return classifyMem0Records(result.items, subject, input.asOf, initialReasons, admissions);
    } catch (error) {
      if (error instanceof ProfileReadIntegrityError) return emptyOutcome("ERROR", "mem0", [error.reason], input.asOf, false);
      if (error instanceof Error && error.name === "ZodError") return emptyOutcome("ERROR", "mem0", ["RECORD_INVALID"], input.asOf, false);
      return emptyOutcome("ERROR", "mem0", ["LINEAGE_INVALID"], input.asOf, false);
    }
  }
}

export function createProfileMemorySourceReader(input: {
  backend: "legacy" | "mem0";
  repository: MemoryRepository;
  mem0Backend?: MemoryBackend;
  admissions?: EvidenceAdmissionStore;
}): ProfileMemorySourceReader {
  if (input.backend === "legacy") return new LegacyProfileMemorySourceReader(input.repository);
  if (!input.mem0Backend) return new UnavailableProfileMemorySourceReader();
  return new Mem0ProfileMemorySourceReader(input.mem0Backend, input.admissions);
}

function validateReadInput(input: ProfileSourceReadInput): ProfileSubjectV1 {
  const subject = parseProfileSubject(input.subject);
  if (typeof input.asOf !== "string" || !Number.isFinite(Date.parse(input.asOf))) throw new ProfileValidationError("asOf must be an ISO instant.");
  if (new Date(input.asOf).toISOString() !== input.asOf) throw new ProfileValidationError("asOf must be canonical ISO UTC.");
  return subject;
}

function classifyLegacyRows(
  rows: ProfileLegacySourceRow[],
  subject: ProfileSubjectV1,
  asOf: string,
  rowBound: boolean
): ProfileSourceReadOutcome {
  const parts = parseMemoryScope(subject.scope);
  const parsedRows = rows.map((row) => parseLegacyRow(row, subject, parts.userId, parts.characterId));
  const retiredRoots = new Set<string>();
  for (const row of parsedRows) {
    if (row.lineage?.state === "GROUNDED" && row.lineage.origin !== "DERIVED" && isRetired(row, asOf)) {
      for (const parent of row.lineage.parents) {
        if (parent.selector.modality === "TEXT") retiredRoots.add(rootIdentity(parent.ref));
      }
    }
  }
  const state = emptyCounts();
  const sources: ProfileEvidenceSourceV1[] = [];
  const reasons: ProfileSourceReadReason[] = rowBound ? ["ROW_BOUND"] : [];
  let partialBytes = false;
  let eligibleCount = 0;
  let keptBytes = 2;
  for (const row of parsedRows) {
    if (row.contentByteLength > PROFILE_MAX_CONTENT_BYTES) {
      partialBytes = true;
      reasons.push("CONTENT_BOUND");
      continue;
    }
    if (row.lineageByteLength > PROFILE_MAX_LINEAGE_BYTES) {
      partialBytes = true;
      reasons.push("LINEAGE_BOUND");
      continue;
    }
    if (row.relationshipsOversized) {
      partialBytes = true;
      reasons.push("SOURCE_BYTES_BOUND");
      continue;
    }
    const exclusion = exclusionForLegacy(row, asOf, retiredRoots);
    if (exclusion) { state[exclusion] += 1; continue; }
    const lineage = canonicalizeGroundedLineage(row.lineage as GroundedMemoryLineageV1);
    const roots = rootsForLineage(lineage);
    if (roots.length > PROFILE_MAX_ROOTS_PER_SOURCE) {
      partialBytes = true;
      reasons.push("SOURCE_BYTES_BOUND");
      continue;
    }
    const source = buildLegacySource(row, subject, lineage, roots);
    eligibleCount += 1;
    const bytes = Buffer.byteLength(canonicalLineageJson(source), "utf8") + (sources.length ? 1 : 0);
    if (keptBytes + bytes > PROFILE_MAX_SOURCE_SET_BYTES) {
      partialBytes = true;
      reasons.push("SOURCE_BYTES_BOUND");
      continue;
    }
    keptBytes += bytes;
    sources.push(source);
  }
  if (rowBound) reasons.push("ROW_BOUND");
  if (partialBytes) reasons.push("SOURCE_BYTES_BOUND");
  const sorted = sortSources(sources);
  return {
    state: reasons.length ? "PARTIAL" : "COMPLETE",
    backend: "legacy",
    sources: sorted,
    reasons: uniqueSorted(reasons),
    diagnostics: { asOf, scannedCount: rows.length, eligibleCount, excludedCounts: state, exhausted: !rowBound && !partialBytes }
  };
}

type ParsedLegacyRow = ProfileLegacySourceRow & {
  lineage: MemoryLineageV1 | null;
  status: (typeof MemoryStatuses)[number];
  validFrom: string | null;
  validUntil: string | null;
  expiresAt: string | null;
  supersededAt: string | null;
  supersedes: string[];
  contradicts: string[];
  nativeScope: MemoryScope;
  claimClass: NonNullable<ReturnType<typeof deserializeClaimMetadata>>["provenanceClass"] | null;
};

function parseLegacyRow(row: ProfileLegacySourceRow, subject: ProfileSubjectV1, userId: string, personaId: string): ParsedLegacyRow {
  if (!row || typeof row !== "object" || typeof row.id !== "string" || !UUID.test(row.id) ||
      !MemoryScopes.includes(row.scope as MemoryScope) || (row.scopeId !== null && typeof row.scopeId !== "string") ||
      !MemoryTypes.includes(row.type as (typeof MemoryTypes)[number]) ||
      (row.subtype !== null && !MemorySubtypes.includes(row.subtype as (typeof MemorySubtypes)[number])) ||
      typeof row.contentByteLength !== "number" || !Number.isFinite(row.contentByteLength) ||
      typeof row.lineageByteLength !== "number" || !Number.isFinite(row.lineageByteLength) ||
      typeof row.rawByteLength !== "number" || !Number.isFinite(row.rawByteLength) ||
      !Number.isSafeInteger(row.contentByteLength) || row.contentByteLength < 0 ||
      !Number.isSafeInteger(row.lineageByteLength) || row.lineageByteLength < 0 ||
      !Number.isSafeInteger(row.rawByteLength) || row.rawByteLength < 0 ||
      typeof row.relationshipsOversized !== "boolean") {
    throw new ProfileReadIntegrityError("RECORD_INVALID");
  }
  if (row.subjectUserId !== userId || row.personaId !== personaId) throw new ProfileReadIntegrityError("SCOPE_MISMATCH");
  // `scope` is the native domain scope, while subject scope is the user×persona partition.
  const status = row.status;
  if (!MemoryStatuses.includes(status as (typeof MemoryStatuses)[number])) throw new ProfileReadIntegrityError("RECORD_INVALID");
  const validFrom = normalizeInstant(row.validFrom, false);
  const validUntil = normalizeInstant(row.validUntil, true);
  const expiresAt = normalizeInstant(row.expiresAt, true);
  const supersededAt = normalizeInstant(row.supersededAt, true);
  const supersedesResult = row.relationshipsOversized ? { refs: [], oversized: false } : validateRelationships(row.supersedes);
  const contradictsResult = row.relationshipsOversized ? { refs: [], oversized: false } : validateRelationships(row.contradicts);
  const relationshipsOversized = row.relationshipsOversized || supersedesResult.oversized || contradictsResult.oversized;
  const supersedes = relationshipsOversized ? [] : supersedesResult.refs;
  const contradicts = relationshipsOversized ? [] : contradictsResult.refs;
  if (row.supersededBy !== null && (typeof row.supersededBy !== "string" || !UUID.test(row.supersededBy))) throw new ProfileReadIntegrityError("RECORD_INVALID");
  if (row.evidenceClassification !== null && row.evidenceClassification !== "NON_EVIDENCE") throw new ProfileReadIntegrityError("RECORD_INVALID");
  if (row.content !== null && typeof row.content !== "string") throw new ProfileReadIntegrityError("RECORD_INVALID");
  if (row.contentByteLength <= PROFILE_MAX_CONTENT_BYTES && row.content === null) throw new ProfileReadIntegrityError("RECORD_INVALID");
  let lineage: MemoryLineageV1 | null = null;
  if (row.lineageByteLength <= PROFILE_MAX_LINEAGE_BYTES && row.lineage !== null) {
    const parsed = MemoryLineageV1Schema.safeParse(row.lineage);
    if (!parsed.success) throw new ProfileReadIntegrityError("LINEAGE_INVALID");
    lineage = parsed.data;
    if (lineage.state === "GROUNDED" && row.lineageConsumerKey !== null && row.lineageConsumerKey !== lineage.consumerKey) {
      throw new ProfileReadIntegrityError("LINEAGE_INVALID");
    }
  } else if (row.lineageByteLength <= PROFILE_MAX_LINEAGE_BYTES && row.lineage === null) {
    lineage = null;
  }
  if (row.lineageConsumerKey !== null && typeof row.lineageConsumerKey !== "string") throw new ProfileReadIntegrityError("RECORD_INVALID");
  const metadata = validateClaimMetadata(row.claimMetadata);
  const claim = deserializeClaimMetadata(metadata);
  return {
    ...row,
    relationshipsOversized,
    lineage,
    status: status as (typeof MemoryStatuses)[number],
    validFrom,
    validUntil,
    expiresAt,
    supersededAt,
    supersedes,
    contradicts,
    nativeScope: row.scope as MemoryScope,
    claimClass: claim?.provenanceClass ?? null
  };
}

function exclusionForLegacy(row: ParsedLegacyRow, asOf: string, retiredRoots: Set<string>): ProfileExclusionReason | null {
  if (row.evidenceClassification === "NON_EVIDENCE") {
    if (row.lineage?.state === "GROUNDED") throw new ProfileReadIntegrityError("LINEAGE_INVALID");
    return "NON_EVIDENCE";
  }
  if (row.lineage === null || row.lineage.state === "LEGACY_INCOMPLETE") return "LEGACY_INCOMPLETE";
  if (row.lineage.state === "PAYLOAD_UNAVAILABLE") return "PAYLOAD_UNAVAILABLE";
  const eligibility = lineageEligibility(row.lineage);
  if (eligibility) return eligibility;
  if (row.claimClass === "ASSISTANT_INFERENCE") return "UNSUPPORTED_ORIGIN";
  if (row.supersededBy !== null || row.supersededAt !== null || row.status === "superseded") return "SUPERSEDED";
  if (row.status === "archived" || row.status === "forgotten" || row.status === "expired") return "INACTIVE";
  if ((row.expiresAt !== null && row.expiresAt <= asOf) || (row.validUntil !== null && row.validUntil <= asOf)) return "EXPIRED";
  if (row.validFrom !== null && row.validFrom > asOf) return "NOT_YET_VALID";
  if (row.lineage.origin === "DERIVED" && "sources" in row.lineage && row.lineage.sources.some((source) => retiredRoots.has(rootIdentity(source.ref)))) return "ROOT_RETIRED";
  if (!row.content || row.contentByteLength === 0) return "PAYLOAD_UNAVAILABLE";
  return null;
}

function lineageEligibility(lineage: MemoryLineageV1): ProfileExclusionReason | null {
  if (lineage.state !== "GROUNDED") return "LEGACY_INCOMPLETE";
  if (lineage.origin === "ASSISTANT_GENERATED") return "UNSUPPORTED_ORIGIN";
  if (lineage.origin === "DERIVED") {
    if (!(("sources" in lineage) && lineage.derivation.kind === "DREAM_DERIVATION")) return "UNSUPPORTED_DERIVATION";
    if (lineage.sources.some((source) => source.selector.modality !== "TEXT")) return "UNSUPPORTED_SELECTOR";
    return null;
  }
  if (lineage.origin !== "USER_ASSERTION" && lineage.origin !== "EXTERNAL_OBSERVATION") return "UNSUPPORTED_ORIGIN";
  if (!("parents" in lineage) || !["RULE_BASED_EXTRACTION", "EXPLICIT_REMEMBER", "CORRECTION", "FINALIZED_INGESTION"].includes(lineage.derivation.kind)) return "UNSUPPORTED_DERIVATION";
  if (lineage.parents.some((parent) => parent.selector.modality !== "TEXT")) return "UNSUPPORTED_SELECTOR";
  return null;
}

function buildLegacySource(
  row: ParsedLegacyRow,
  subject: ProfileSubjectV1,
  lineage: GroundedMemoryLineageV1,
  roots: ProfileRootConstraintV1[]
): ProfileEvidenceSourceV1 {
  if (!row.content) throw new ProfileReadIntegrityError("RECORD_INVALID");
  const memory = { memoryId: `legacy:${row.id}`, backend: "legacy" as const, sourceRecordId: row.id };
  const source = {
    version: "yuvi-profile-evidence-source.v1" as const,
    memory,
    scope: subject.scope,
    nativeScope: { kind: row.nativeScope, scopeId: row.scopeId },
    kind: lineage.derivation.kind === "CORRECTION" ? "correction" : lineage.derivation.kind === "EXPLICIT_REMEMBER" ? "user_claim" : row.type === "episodic" ? "episodic" : "fact",
    subtype: row.subtype,
    content: row.content,
    claimClass: row.claimClass,
    lineage,
    lineageDigest: "0".repeat(64),
    lifecycle: {
      state: "ACTIVE" as const,
      coverage: "NATIVE" as const,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      expiresAt: row.expiresAt
    },
    relationships: {
      coverage: "NATIVE" as const,
      supersedes: row.supersedes.map((id) => ({ memoryId: `legacy:${id}`, backend: "legacy" as const, sourceRecordId: id })),
      supersededBy: null,
      contradicts: row.contradicts.map((id) => ({ memoryId: `legacy:${id}`, backend: "legacy" as const, sourceRecordId: id }))
    },
    roots
  };
  return ProfileEvidenceSourceV1Schema.parse({ ...source, lineageDigest: sha256Canonical(lineage) });
}

function classifyMem0Records(records: MemoryRecord[], subject: ProfileSubjectV1, asOf: string, initialReasons: ProfileSourceReadReason[], admissions: EvidenceAdmissionV1[]): ProfileSourceReadOutcome {
  const state = emptyCounts();
  const admissionsById = new Map(admissions.map((entry) => [entry.backendRecordId, entry]));
  const sources: ProfileEvidenceSourceV1[] = [];
  const admittedEvents: MemoryEvent[] = [];
  const reasons = [...initialReasons];
  let eligibleCount = 0;
  let partialBytes = false;
  let keptBytes = 2;
  const seenIds = new Map<string, string>();
  for (const record of records) {
    let event: MemoryEvent;
    try {
      event = mapMem0RecordToMemoryEvent(record, subject.scope);
    } catch (error) {
      if (error instanceof Mem0MemoryProviderError && error.code === "MEMORY_SCOPE_MISMATCH") throw new ProfileReadIntegrityError("SCOPE_MISMATCH");
      const encodedLineage = record?.metadata?.["yuviLineageJson"];
      if (error instanceof MemoryLineageEncodingError && typeof encodedLineage === "string" &&
          Buffer.byteLength(encodedLineage, "utf8") > PROFILE_MAX_LINEAGE_BYTES) {
        reasons.push("LINEAGE_BOUND");
        partialBytes = true;
        continue;
      }
      throw new ProfileReadIntegrityError("LINEAGE_INVALID");
    }
    if (!UUID.test(event.sourceRecordId) || typeof record.content !== "string" || !record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata)) throw new ProfileReadIntegrityError("RECORD_INVALID");
    const admission = admissionsById.get(record.id);
    const lineageValue = admission?.lineage ?? null;
    const transportIdentity = canonicalLineageJson({ event: { ...event, metadata: undefined }, rawContent: record.content });
    const previous = seenIds.get(event.sourceRecordId);
    if (previous !== undefined && previous !== transportIdentity) throw new ProfileReadIntegrityError("SOURCE_IDENTITY_CONFLICT");
    seenIds.set(event.sourceRecordId, transportIdentity);
    const lineageJsonBytes = lineageValue === null ? 0 : Buffer.byteLength(canonicalLineageJson(lineageValue), "utf8");
    const contentBytes = Buffer.byteLength(event.content, "utf8");
    if (contentBytes > PROFILE_MAX_CONTENT_BYTES) { reasons.push("CONTENT_BOUND"); partialBytes = true; continue; }
    if (lineageJsonBytes > PROFILE_MAX_LINEAGE_BYTES) { reasons.push("LINEAGE_BOUND"); partialBytes = true; continue; }
    if (!event.content) throw new ProfileReadIntegrityError("RECORD_INVALID");
    if (!admission || !matchesEvidenceEffect(admission, record)) { state.NON_EVIDENCE += 1; continue; }
    if (!event.lineage || canonicalLineageJson(event.lineage) !== canonicalLineageJson(admission.lineage)) throw new ProfileReadIntegrityError("LINEAGE_INVALID");
    if (lineageValue === null || lineageValue.state === "LEGACY_INCOMPLETE") { state.LEGACY_INCOMPLETE += 1; continue; }
    if (lineageValue.state === "PAYLOAD_UNAVAILABLE") { state.PAYLOAD_UNAVAILABLE += 1; continue; }
    if (lineageValue.state !== "GROUNDED") throw new ProfileReadIntegrityError("LINEAGE_INVALID");
    if (lineageEligibility(lineageValue)) { state[lineageEligibility(lineageValue)!] += 1; continue; }
    const claimClass = event.claim?.provenanceClass ?? null;
    if (claimClass === "ASSISTANT_INFERENCE") { state.UNSUPPORTED_ORIGIN += 1; continue; }
    const lineage = canonicalizeGroundedLineage(lineageValue);
    const roots = rootsForLineage(lineage);
    if (roots.length > PROFILE_MAX_ROOTS_PER_SOURCE) {
      reasons.push("SOURCE_BYTES_BOUND");
      partialBytes = true;
      continue;
    }
    admittedEvents.push(event);
    const source: ProfileEvidenceSourceV1 = ProfileEvidenceSourceV1Schema.parse({
      version: "yuvi-profile-evidence-source.v1",
      memory: { memoryId: `mem0:${event.sourceRecordId}`, backend: "mem0", sourceRecordId: event.sourceRecordId },
      scope: subject.scope,
      nativeScope: null,
      kind: event.kind,
      subtype: null,
      content: event.content,
      claimClass,
      lineage,
      lineageDigest: sha256Canonical(lineage),
      lifecycle: { state: "ACTIVE", coverage: "PRESENT_RECORD_ONLY", validFrom: null, validUntil: null, expiresAt: null },
      relationships: { coverage: "NOT_PROVIDED", supersedes: [], supersededBy: null, contradicts: [] },
      roots
    });
    eligibleCount += 1;
    const bytes = Buffer.byteLength(canonicalLineageJson(source), "utf8") + (sources.length ? 1 : 0);
    if (keptBytes + bytes > PROFILE_MAX_SOURCE_SET_BYTES) { reasons.push("SOURCE_BYTES_BOUND"); partialBytes = true; continue; }
    keptBytes += bytes;
    sources.push(source);
  }
  const currentIds = new Set(currentCorrectedMemoryEvents(admittedEvents).map((event) => event.id));
  const sorted = sortSources(sources.filter((source) => currentIds.has(source.memory.memoryId)));
  const correctedCount = admittedEvents.filter((event) => !currentIds.has(event.id)).length;
  state.SUPERSEDED += correctedCount;
  eligibleCount -= correctedCount;
  const status = reasons.length || partialBytes ? "PARTIAL" : "COMPLETE";
  return {
    state: status,
    backend: "mem0",
    sources: sorted,
    reasons: uniqueSorted(reasons),
    diagnostics: { asOf, scannedCount: records.length, eligibleCount, excludedCounts: state, exhausted: status === "COMPLETE" }
  };
}

class ProfileReadIntegrityError extends Error {
  constructor(readonly reason: "RECORD_INVALID" | "LINEAGE_INVALID" | "SCOPE_MISMATCH" | "SOURCE_IDENTITY_CONFLICT") { super("Profile source record failed integrity validation."); }
}

function emptyOutcome(state: ProfileSourceReadOutcome["state"], backend: "legacy" | "mem0" | null, reasons: ProfileSourceReadReason[], asOf: string, exhausted: boolean): ProfileSourceReadOutcome {
  return { state, backend, sources: [], reasons: uniqueSorted(reasons), diagnostics: { asOf, scannedCount: 0, eligibleCount: 0, excludedCounts: emptyCounts(), exhausted } };
}

function emptyCounts(): Record<ProfileExclusionReason, number> {
  return Object.fromEntries(EXCLUSIONS.map((reason) => [reason, 0])) as Record<ProfileExclusionReason, number>;
}

function normalizeInstant(value: string | null, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ProfileReadIntegrityError("RECORD_INVALID");
  return new Date(value).toISOString();
}

function validateRelationships(value: string[] | null): { refs: string[]; oversized: boolean } {
  if (!Array.isArray(value)) throw new ProfileReadIntegrityError("RECORD_INVALID");
  const result = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !UUID.test(id)) throw new ProfileReadIntegrityError("RECORD_INVALID");
    result.add(id);
  }
  return { refs: [...result].sort(), oversized: result.size > PROFILE_MAX_RAW_RECORDS };
}

function validateClaimMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ProfileReadIntegrityError("RECORD_INVALID");
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).filter(([key]) => CLAIM_METADATA_KEYS.includes(key as (typeof CLAIM_METADATA_KEYS)[number])));
}

function isRetired(row: ParsedLegacyRow, asOf: string): boolean {
  if (row.status === "superseded" || row.supersededBy !== null || row.supersededAt !== null) return true;
  if (["forgotten", "archived", "expired"].includes(row.status)) return true;
  return (row.expiresAt !== null && row.expiresAt <= asOf) || (row.validUntil !== null && row.validUntil <= asOf);
}

function rootIdentity(ref: unknown): string { return canonicalLineageJson(ref); }
function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalLineageJson(value));
}
function sortSources(sources: ProfileEvidenceSourceV1[]): ProfileEvidenceSourceV1[] {
  return sources.sort((a, b) => a.memory.backend < b.memory.backend ? -1 : a.memory.backend > b.memory.backend ? 1 : a.memory.sourceRecordId < b.memory.sourceRecordId ? -1 : a.memory.sourceRecordId > b.memory.sourceRecordId ? 1 : 0);
}
function uniqueSorted<T extends string>(values: T[]): T[] { return [...new Set(values)].sort() as T[]; }

function mapBackendFailure(error: unknown, signal?: AbortSignal): { state: "UNAVAILABLE" | "ERROR" | "PARTIAL"; reason: ProfileSourceReadReason } {
  if (signal?.aborted) return { state: "UNAVAILABLE", reason: "CANCELLED" };
  if (error instanceof MemoryBackendError) {
    if (error.code === "PROFILE_SOURCE_BYTES_BOUND") return { state: "PARTIAL", reason: "SOURCE_BYTES_BOUND" };
    if (error.code === "ENUMERATION_UNSUPPORTED" || error.code === "UNSUPPORTED_OPERATION") return { state: "UNAVAILABLE", reason: "ENUMERATION_UNSUPPORTED" };
    if (error.code === "OPERATION_TIMEOUT" || error.code === "REQUEST_TIMEOUT") return { state: "UNAVAILABLE", reason: "TIMEOUT" };
    if (error.code === "MEMORY_RECORD_INVALID") return { state: "ERROR", reason: "RECORD_INVALID" };
    if (error.code === "MEMORY_SCOPE_MISMATCH") return { state: "ERROR", reason: "SCOPE_MISMATCH" };
    if (error.code === "BACKEND_ERROR") return { state: "ERROR", reason: "BACKEND_ERROR" };
    // A static bounded request rejected by an older/capped sidecar is a capability gap.
    if (error.code === "VALIDATION_ERROR") return { state: "UNAVAILABLE", reason: "ENUMERATION_UNSUPPORTED" };
    return error.retryable
      ? { state: "UNAVAILABLE", reason: "BACKEND_UNAVAILABLE" }
      : { state: "ERROR", reason: "BACKEND_ERROR" };
  }
  return { state: "UNAVAILABLE", reason: "BACKEND_UNAVAILABLE" };
}
