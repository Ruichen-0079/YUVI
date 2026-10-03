import type { ProviderCallOptions, ProviderHealth, ProviderMetadata } from "./common.js";

export type STTInput = {
  audio?: Uint8Array | undefined;
  audioBuffer?: Uint8Array | undefined;
  audioUrl?: string | undefined;
  localFilePath?: string | undefined;
  audioBase64?: string | undefined;
  mimeType?: string | undefined;
  language?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export const VOICE_PROFILE_MATCH_STATUSES = ["MATCHED", "NO_MATCH"] as const;

export type VoiceProfileMatchStatus = (typeof VOICE_PROFILE_MATCH_STATUSES)[number];

/**
 * Provider-neutral acoustic template evidence.
 *
 * `voiceProfileId` is the durable acoustic template identity, mapped from the
 * local sidecar's legacy `speakerId` at the adapter boundary. It is not a
 * person id, not a capture-local cluster id, and not a display name.
 * Similarity scores stay sidecar-internal diagnostics.
 */
export type VoiceProfileMatch = {
  status: VoiceProfileMatchStatus;
  voiceProfileId?: string | undefined;
};

export type STTSegment = {
  /** Stable identity of this finalized segment; never derived from transcript text. */
  segmentId?: string | undefined;
  /**
   * Transcript attributed to this segment. Diarization-only spans carry no
   * per-span transcript and omit this field.
   */
  text?: string | undefined;
  startMs?: number | undefined;
  endMs?: number | undefined;
  confidence?: number | undefined;
  /**
   * Diarization cluster label, valid only inside this one finalized
   * observation. It is not a person id, not a voice profile id, and must
   * never be persisted as identity truth.
   */
  speakerClusterId?: string | undefined;
  /**
   * Cluster-scoped acoustic template match. Present only when this cluster's
   * own audio spans were matched. Never copied from a mixed whole-audio
   * identify() result.
   */
  voiceProfileMatch?: VoiceProfileMatch | undefined;
};

export type STTOutput = ProviderMetadata & {
  /**
   * Stable identity of this finalized speech observation; distinct for every
   * transcription result and never derived from transcript text. A finalized
   * observation is not a user interaction on its own.
   */
  observationId?: string | undefined;
  /**
   * Opaque capture generation identity. Runtime owns assignment and fencing;
   * it is never derived from transcript text or speakerClusterId.
   */
  captureEpoch?: string | undefined;
  text: string;
  language?: string | undefined;
  confidence?: number | undefined;
  segments?: STTSegment[] | undefined;
  /**
   * Whole-audio acoustic template match. Omitted for mixed-cluster captures
   * so one mixed embedding cannot name every speaker.
   */
  voiceProfileMatch?: VoiceProfileMatch | undefined;
};

export type VoiceActivityInput = {
  captureEpoch: string;
  pcmBase64: string;
  sampleRate?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type VoiceActivityOutput = {
  active: boolean;
  captureEpoch: string;
};

export interface STTProvider {
  readonly name: string;
  readonly voiceProfiles?: VoiceProfileProvider | undefined;
  healthCheck(): Promise<ProviderHealth>;
  transcribeAudio(input: STTInput, options?: ProviderCallOptions): Promise<STTOutput>;
  detectVoiceActivity?(
    input: VoiceActivityInput,
    options?: ProviderCallOptions
  ): Promise<VoiceActivityOutput>;
}

/** Acoustic profiles only; semantic person binding remains Memory/P8 authority. */
export interface VoiceProfileProvider {
  list(): Promise<Array<{ voiceProfileId: string; label: string }>>;
  enroll(
    input: STTInput & { voiceProfileId: string; label: string }
  ): Promise<{ voiceProfileId: string; label: string }>;
  identify(input: STTInput): Promise<VoiceProfileMatch>;
  delete(voiceProfileId: string): Promise<void>;
  /** Native acoustic-owner snapshot used for exact CAS, never a Person binding. */
  readAuthorityState?(): Promise<VoiceProfileAuthoritySnapshot>;
  fenceNativeCommand?(command: VoiceProfileNativeCommand): Promise<"READY" | "APPLIED" | "UNKNOWN" | "CONFLICT">;
  applyNativeCommand?(command: VoiceProfileNativeCommand & { audioBase64?: string }): Promise<VoiceProfileNativeCommandResult>;
  reconcileNativeCommand?(command: VoiceProfileNativeCommand): Promise<VoiceProfileNativeCommandResult>;
}

export type VoiceProfileAuthoritySnapshot = Readonly<{
  complete: boolean;
  revision: string | null;
  profiles: readonly { voiceProfileId: string; label: string }[];
  cleanupPending?: boolean;
}>;
export type VoiceProfileNativeCommand = Readonly<{
  operation: "ENROLL" | "DELETE";
  commandHandle: string;
  intentId: string;
  attemptId: string;
  fence: string;
  payloadDigest: string;
  expectedRevision: string | null;
  voiceProfileId: string;
  label?: string;
  causalRefs: readonly { kind: "JOURNAL_EVENT"; namespace: string; eventId: string }[];
}>;
export type VoiceProfileNativeCommandReceipt = Readonly<{
  commandHandle: string;
  intentId: string;
  attemptId: string;
  fence: string;
  payloadDigest: string;
  operation: "ENROLL" | "DELETE";
  voiceProfileId: string;
  priorRevision: string | null;
  resultingRevision: string;
  causalRefs: VoiceProfileNativeCommand["causalRefs"];
}>;
export type VoiceProfileNativeCommandResult = Readonly<
  | { status: "APPLIED" | "ALREADY_APPLIED"; receipt: VoiceProfileNativeCommandReceipt; cleanupPending?: boolean }
  | { status: "PROVEN_NOT_APPLIED"; reason: "REVISION_MISMATCH" | "PROFILE_EXISTS" | "PROFILE_ABSENT" | "EXACT_PREDECESSOR_REMAINS" | "INVALID_ACOUSTIC_SAMPLE" | "MIXED_ACOUSTIC_SAMPLE"; revision?: string | null }
  | { status: "UNKNOWN" | "CONFLICT" }
>;
