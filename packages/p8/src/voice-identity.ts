import {
  currentEligibleMemoryEvents,
  isVoiceProfileBindingEvent,
  readVoiceProfileId,
  type MemoryClaimIdentityInput,
  type MemoryClaimProvenanceClass,
  type MemoryEvent
} from "@companion/memory";
import type { P8IdentityAddress } from "./index.js";

/**
 * Voice profile → person resolution (Atom 13B).
 *
 * Acoustic match identifies a voice profile. Runtime supplies an exact,
 * host-validated projection of LocalControllerEvidenceProvider authority, and
 * P8 checks the referenced owner events before resolving a person. Generic
 * Memory records are not binding authority. Similarity scores, sidecar labels,
 * cluster ids, and transcript self-identification cannot resolve a person.
 *
 * RESOLVED_SUPPORTED is part of the published status vocabulary for contract
 * compatibility, but current evidence architecture has no legal "supported
 * but not trusted" voice-person binding. Only trusted explicit controller
 * assignment can resolve. This module never emits RESOLVED_SUPPORTED.
 */

export const P8_VOICE_PERSON_VERSION = "p8-voice-person.v1" as const;

export const P8_VOICE_PERSON_STATUSES = [
  "RESOLVED_TRUSTED",
  "RESOLVED_SUPPORTED",
  "UNRESOLVED",
  "CONFLICTING"
] as const;

export type P8VoicePersonStatus = (typeof P8_VOICE_PERSON_STATUSES)[number];

export const P8_VOICE_PROFILE_MATCH_STATUSES = ["MATCHED", "NO_MATCH"] as const;

export type P8VoiceProfileMatchStatus = (typeof P8_VOICE_PROFILE_MATCH_STATUSES)[number];

export type P8VoiceProfileMatch = Readonly<{
  status: P8VoiceProfileMatchStatus;
  voiceProfileId?: string;
}>;

export type P8AcousticObservationReference = Readonly<{
  kind: "JOURNAL_EVENT";
  namespace: string;
  eventId: string;
  observationId: string;
}>;

/** Host-validated current binding facts consumed by the pure P8 resolver. */
export type P8VoiceBindingProjection = Readonly<{
  projectionVersion: "p8-host-voice-binding.v1";
  status: "CURRENT" | "UNBOUND" | "CONFLICT" | "UNAVAILABLE";
  voiceProfileId: string;
  personaId: string;
  scopeReference: string;
  nativeOwnerRevision: string | null;
  bindingRevision: string | null;
  issuerPolicy: "LOCAL_EXPLICIT_CONTROLLER";
  eligibility: "CURRENT" | "INELIGIBLE";
  evidenceReferences: readonly string[];
  acousticObservationReference: P8AcousticObservationReference;
}>;

export type P8VoicePersonUnresolvedReason =
  | "no-acoustic-match"
  | "no-person-binding"
  | "mixed-capture-unattributed"
  | "speaker-cluster-only"
  | "voice-profile-only"
  | "sidecar-label-only"
  | "similarity-score-only"
  | "assistant-inference-only"
  | "transcript-self-identification"
  | "no-per-span-transcript";

export type P8VoicePersonResolution = Readonly<{
  resolutionVersion: typeof P8_VOICE_PERSON_VERSION;
  status: P8VoicePersonStatus;
  speakerClusterId?: string;
  voiceProfileId?: string;
  personId?: string;
  evidenceReferences: readonly string[];
  unresolvedReason?: P8VoicePersonUnresolvedReason;
}>;

export type P8CharacterSpeakerView = Readonly<
  { speaker: "resolved"; personId: string } | { speaker: "unknown" } | { speaker: "conflicting" }
>;

export type P8VoicePersonResolutionInput = Readonly<{
  address: P8IdentityAddress;
  scopeReference: string;
  speakerClusterId?: string;
  voiceProfileMatch?: P8VoiceProfileMatch;
  longTermEvents?: readonly MemoryEvent[];
  trustedAssertorEntityIds?: readonly string[];
  /** Presence selects the host-projection path; absent profiles fail closed. */
  bindingProjections?: readonly P8VoiceBindingProjection[];
  acousticObservationReference?: P8AcousticObservationReference;
  /**
   * Forbidden bootstrap inputs. Presence never creates a person binding.
   */
  sidecarLabel?: string;
  similarityScore?: number;
  transcriptClaim?: string;
}>;

export function resolveP8VoicePerson(input: P8VoicePersonResolutionInput): P8VoicePersonResolution {
  validateScopeReference(input.scopeReference);
  const speakerClusterId = normalizeOptional(input.speakerClusterId);
  const match = input.voiceProfileMatch;
  const voiceProfileId =
    match?.status === "MATCHED" ? normalizeOptional(match.voiceProfileId) : undefined;

  const base = {
    resolutionVersion: P8_VOICE_PERSON_VERSION as typeof P8_VOICE_PERSON_VERSION,
    ...(speakerClusterId === undefined ? {} : { speakerClusterId }),
    ...(voiceProfileId === undefined ? {} : { voiceProfileId }),
    evidenceReferences: Object.freeze([]) as readonly string[]
  };

  if (match === undefined || match.status === "NO_MATCH" || voiceProfileId === undefined) {
    return Object.freeze({
      ...base,
      status: "UNRESOLVED" as const,
      unresolvedReason: unresolvedWithoutMatch(input)
    });
  }

  const projectionMode = input.bindingProjections !== undefined;
  const projection = projectionMode
    ? input.bindingProjections?.find((candidate) => candidate.voiceProfileId === voiceProfileId)
    : undefined;
  if (projectionMode) {
    if (!projection || projection.projectionVersion !== "p8-host-voice-binding.v1" ||
        projection.voiceProfileId !== voiceProfileId ||
        !sameAcousticReference(projection.acousticObservationReference, input.acousticObservationReference)) {
      return Object.freeze({ ...base, status: "UNRESOLVED" as const, unresolvedReason: "no-person-binding" as const });
    }
    if (projection.status === "CONFLICT") {
      return Object.freeze({
        ...base,
        status: "CONFLICTING" as const,
        evidenceReferences: Object.freeze([...projection.evidenceReferences].sort((a, b) => a.localeCompare(b)))
      });
    }
    if (projection.status !== "CURRENT" || projection.eligibility !== "CURRENT" ||
        projection.issuerPolicy !== "LOCAL_EXPLICIT_CONTROLLER" ||
        !projection.nativeOwnerRevision || !projection.bindingRevision ||
        !projection.scopeReference.trim()) {
      return Object.freeze({ ...base, status: "UNRESOLVED" as const, unresolvedReason: "no-person-binding" as const });
    }
  }
  const scopeReference = projectionMode ? projection?.scopeReference ?? input.scopeReference : input.scopeReference;
  const candidateEvents = projectionMode && projection
    ? (input.longTermEvents ?? []).filter((event) => projection.evidenceReferences.includes(event.id))
    : input.longTermEvents ?? [];
  const eligible = currentEligibleMemoryEvents(candidateEvents);
  const trustedAssertors = new Set(input.trustedAssertorEntityIds ?? []);
  const bindings = eligible.filter(
    (event) =>
      isVoiceProfileBindingEvent(event) &&
      readVoiceProfileId(event.metadata) === voiceProfileId &&
      event.scope === scopeReference
  );

  if (projectionMode && projection && (
    eligible.length !== projection.evidenceReferences.length ||
    new Set(eligible.map((event) => event.id)).size !== projection.evidenceReferences.length
  )) {
    return Object.freeze({ ...base, status: "UNRESOLVED" as const, unresolvedReason: "no-person-binding" as const });
  }

  const trustedPersons = new Map<string, string[]>();
  let assistantOnly = false;
  for (const event of bindings) {
    const personId = event.claim?.subject.entityId;
    const provenance = event.claim?.provenanceClass;
    if (!personId || event.claim?.subject.resolution !== "resolved") continue;
    if (provenance === "ASSISTANT_INFERENCE" || event.assertion?.source === "assistant") {
      assistantOnly = true;
      continue;
    }
    if (!isTrustedBinding(event, trustedAssertors, provenance)) continue;
    const refs = trustedPersons.get(personId) ?? [];
    refs.push(event.id);
    trustedPersons.set(personId, refs);
  }

  if (trustedPersons.size > 1) {
    return Object.freeze({
      ...base,
      status: "CONFLICTING" as const,
      evidenceReferences: Object.freeze(
        [...trustedPersons.values()].flat().sort((left, right) => left.localeCompare(right))
      )
    });
  }

  const resolved = [...trustedPersons.entries()][0];
  if (resolved) {
    return Object.freeze({
      ...base,
      status: "RESOLVED_TRUSTED" as const,
      personId: resolved[0],
      evidenceReferences: Object.freeze(
        resolved[1].slice().sort((left, right) => left.localeCompare(right))
      )
    });
  }

  return Object.freeze({
    ...base,
    status: "UNRESOLVED" as const,
    unresolvedReason: assistantOnly
      ? "assistant-inference-only"
      : transcriptLooksLikeSelfId(input.transcriptClaim)
        ? "transcript-self-identification"
        : "no-person-binding",
    evidenceReferences: Object.freeze(
      bindings.map((event) => event.id).sort((left, right) => left.localeCompare(right))
    )
  });
}

function sameAcousticReference(
  left: P8AcousticObservationReference,
  right: P8AcousticObservationReference | undefined
): boolean {
  return Boolean(right && left.kind === right.kind && left.namespace === right.namespace &&
    left.eventId === right.eventId && left.observationId === right.observationId);
}

export function projectVoicePersonForCharacter(
  resolution: P8VoicePersonResolution
): P8CharacterSpeakerView {
  if (resolution.status === "RESOLVED_TRUSTED" && resolution.personId) {
    return Object.freeze({ speaker: "resolved", personId: resolution.personId });
  }
  if (resolution.status === "CONFLICTING") {
    return Object.freeze({ speaker: "conflicting" });
  }
  return Object.freeze({ speaker: "unknown" });
}

/**
 * Atom 12 assertor from a speech observation. Fail-closed when transcript
 * attribution is not cluster-safe (multiple clusters, no per-span text).
 */
export function voicePersonClaimAssertor(input: {
  resolutions: readonly P8VoicePersonResolution[];
  segments?: readonly {
    speakerClusterId?: string;
    text?: string;
    voiceProfileMatch?: P8VoiceProfileMatch;
  }[];
  wholeTranscript?: string;
}): { assertor: MemoryClaimIdentityInput; reason?: P8VoicePersonUnresolvedReason } {
  const clusterIds = unique(
    (input.segments ?? [])
      .map((segment) => segment.speakerClusterId)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
  const perSpanTranscript = (input.segments ?? []).some(
    (segment) => typeof segment.text === "string" && segment.text.trim().length > 0
  );

  if (clusterIds.length > 1 && !perSpanTranscript) {
    return {
      assertor: { resolution: "unresolved" },
      reason: "no-per-span-transcript"
    };
  }

  // A whole-capture claim cannot inherit the one known person's authority
  // while another speaking cluster remains unidentified.
  if (
    clusterIds.length > 1 &&
    input.resolutions.some((resolution) => resolution.status !== "RESOLVED_TRUSTED")
  ) {
    return { assertor: { resolution: "unresolved" }, reason: "mixed-capture-unattributed" };
  }

  const distinctPersons = unique(
    input.resolutions
      .filter((resolution) => resolution.status === "RESOLVED_TRUSTED" && resolution.personId)
      .map((resolution) => resolution.personId as string)
  );
  const conflicting = input.resolutions.some((resolution) => resolution.status === "CONFLICTING");
  if (conflicting || distinctPersons.length !== 1) {
    return {
      assertor: { resolution: "unresolved" },
      reason: distinctPersons.length === 0 ? "no-person-binding" : "mixed-capture-unattributed"
    };
  }

  return {
    assertor: { entityId: distinctPersons[0], resolution: "resolved" }
  };
}

function isTrustedBinding(
  event: MemoryEvent,
  trustedAssertors: ReadonlySet<string>,
  provenance: MemoryClaimProvenanceClass | undefined
): boolean {
  const assertorId = event.claim?.assertor.entityId;
  if (!assertorId || event.claim?.assertor.resolution !== "resolved") return false;
  if (provenance === "SELF_REPORT") return true;
  if (provenance === "EXTERNAL_CLAIM") return trustedAssertors.has(assertorId);
  return false;
}

function unresolvedWithoutMatch(
  input: P8VoicePersonResolutionInput
): P8VoicePersonUnresolvedReason {
  if (input.similarityScore !== undefined && input.voiceProfileMatch === undefined) {
    return "similarity-score-only";
  }
  if (input.sidecarLabel !== undefined && input.voiceProfileMatch === undefined) {
    return "sidecar-label-only";
  }
  if (
    input.speakerClusterId !== undefined &&
    (input.voiceProfileMatch === undefined || input.voiceProfileMatch.status === "NO_MATCH")
  ) {
    return input.voiceProfileMatch === undefined ? "speaker-cluster-only" : "no-acoustic-match";
  }
  if (transcriptLooksLikeSelfId(input.transcriptClaim)) {
    return "transcript-self-identification";
  }
  if (input.voiceProfileMatch?.status === "MATCHED" && !input.voiceProfileMatch.voiceProfileId) {
    return "voice-profile-only";
  }
  return "no-acoustic-match";
}

function transcriptLooksLikeSelfId(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return /我是|i am\b|i'm\b/i.test(value);
}

function unique(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function validateScopeReference(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 160) {
    throw new Error(
      "P8 voice person scope reference must be a non-empty string of at most 160 characters."
    );
  }
}
