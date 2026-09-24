import type { STTOutput, STTSegment } from "@companion/providers";

export const SPEECH_CAPTURE_CLAIM_LIMIT = 256;
export const SPEECH_CAPTURE_RESERVATION_LIMIT = 64;

export type SpeechCaptureReservationRecord = Readonly<{
  token: string;
  sessionId: string;
  captureEpoch: string;
  priorLiveEpoch?: string;
  observation: STTOutput;
  newlyClaimedKeys: readonly string[];
}>;

export type SpeechCaptureReservationResult = Readonly<{
  token: string;
  sessionId: string;
  captureEpoch: string;
  observation: STTOutput;
}>;

export type SpeechCaptureFinalizeResult = Readonly<{
  status: "ready" | "stale" | "not-handoff-ready";
  sessionId: string;
  captureEpoch: string;
  observation: STTOutput;
}>;

export type SpeechCaptureStore = {
  liveEpochBySession: Map<string, string>;
  obsoleteEpochs: Set<string>;
  obsoleteOrder: string[];
  claims: Map<string, true>;
  reservations: Map<string, SpeechCaptureReservationRecord>;
  reservationBySession: Map<string, string>;
  provisionalClaims: Map<string, string>;
  provisionalObservationIds: Map<string, string>;
};

export function createSpeechCaptureStore(): SpeechCaptureStore {
  return {
    liveEpochBySession: new Map(),
    obsoleteEpochs: new Set(),
    obsoleteOrder: [],
    claims: new Map(),
    reservations: new Map(),
    reservationBySession: new Map(),
    provisionalClaims: new Map(),
    provisionalObservationIds: new Map()
  };
}

export function claimKey(captureEpoch: string, segmentId: string): string {
  return `${captureEpoch}\0${segmentId}`;
}

/**
 * Bind a live capture generation to a session without a finalized segment.
 * VAD state is independent of provisional Journal reservations and remains
 * synchronous so barge-in is never held behind database I/O.
 */
export function beginLiveSpeechCapture(
  store: SpeechCaptureStore,
  sessionId: string | undefined,
  captureEpoch: string
): string {
  const epoch = opaqueIdentity(captureEpoch, defaultCreateId, "captureEpoch");
  if (store.obsoleteEpochs.has(epoch)) {
    throw new SpeechCaptureFenceError("stale-epoch", epoch);
  }
  const session = normalizeSessionId(sessionId);
  const live = store.liveEpochBySession.get(session);
  if (live !== undefined && live !== epoch) {
    markObsolete(store, live);
  }
  store.liveEpochBySession.set(session, epoch);
  return epoch;
}

/**
 * Reserve the capture-fence decision before durable receipt append. The
 * reservation is token-owned and provisional: it claims conflicting work but
 * does not advance the live epoch, accepted segment claims or turn state.
 */
export function reserveFinalizedSpeechCapture(
  store: SpeechCaptureStore,
  input: {
    observation: STTOutput;
    sessionId?: string | undefined;
    captureEpoch?: string | undefined;
    createId?: () => string;
  }
): SpeechCaptureReservationResult {
  const createId = input.createId ?? defaultCreateId;
  const captureEpoch = opaqueIdentity(
    input.captureEpoch ?? input.observation.captureEpoch,
    createId,
    "captureEpoch"
  );
  if (store.obsoleteEpochs.has(captureEpoch)) {
    throw new SpeechCaptureFenceError("stale-epoch", captureEpoch);
  }

  const sessionId = normalizeSessionId(input.sessionId);
  if (store.reservationBySession.has(sessionId)) {
    throw new SpeechCaptureFenceError("reservation-in-progress", captureEpoch);
  }
  if (store.reservations.size >= SPEECH_CAPTURE_RESERVATION_LIMIT) {
    throw new SpeechCaptureFenceError("reservation-capacity", captureEpoch);
  }

  const observation = normalizeObservation(input.observation, captureEpoch, createId);
  const observationId = observation.observationId!;
  if (store.provisionalObservationIds.has(observationId)) {
    throw new SpeechCaptureFenceError("reservation-in-progress", captureEpoch);
  }

  const segmentIds = [
    ...new Set((observation.segments ?? []).map((segment) => segment.segmentId!))
  ];
  const newlyClaimedKeys: string[] = [];
  for (const segmentId of segmentIds) {
    const key = claimKey(captureEpoch, segmentId);
    if (store.provisionalClaims.has(key)) {
      throw new SpeechCaptureFenceError(
        "reservation-in-progress",
        captureEpoch,
        undefined,
        segmentId
      );
    }
    if (!store.claims.has(key)) newlyClaimedKeys.push(key);
  }
  if (newlyClaimedKeys.length === 0) {
    throw new SpeechCaptureFenceError("duplicate", captureEpoch);
  }

  const token = createId();
  if (store.reservations.has(token)) {
    throw new SpeechCaptureFenceError(
      "invalid-reservation",
      captureEpoch,
      "Speech reservation token collided with an active reservation."
    );
  }
  const record: SpeechCaptureReservationRecord = {
    token,
    sessionId,
    captureEpoch,
    ...(store.liveEpochBySession.has(sessionId)
      ? { priorLiveEpoch: store.liveEpochBySession.get(sessionId)! }
      : {}),
    observation,
    newlyClaimedKeys
  };
  store.reservations.set(token, record);
  store.reservationBySession.set(sessionId, token);
  store.provisionalObservationIds.set(observationId, token);
  for (const key of newlyClaimedKeys) store.provisionalClaims.set(key, token);
  return { token, sessionId, captureEpoch, observation };
}

/**
 * Commit token-owned claims after the durable Journal append. A live VAD epoch
 * that changed during append remains authoritative; the receipt is retained but
 * the observation becomes a terminal non-handoff state.
 */
export function finalizeSpeechCaptureReservation(
  store: SpeechCaptureStore,
  token: string
): SpeechCaptureFinalizeResult {
  const record = store.reservations.get(token);
  if (!record) throw new SpeechCaptureFenceError("invalid-reservation", "unknown");

  const live = store.liveEpochBySession.get(record.sessionId);
  const epochChangedIndependently = live !== record.priorLiveEpoch && live !== record.captureEpoch;
  const stale = store.obsoleteEpochs.has(record.captureEpoch) || epochChangedIndependently;

  for (const key of record.newlyClaimedKeys) {
    if (store.provisionalClaims.get(key) === token) {
      store.provisionalClaims.delete(key);
      store.claims.set(key, true);
    }
  }
  evictOldestClaims(store);
  removeReservation(store, record);

  if (stale) {
    return {
      status: "stale",
      sessionId: record.sessionId,
      captureEpoch: record.captureEpoch,
      observation: record.observation
    };
  }

  if (live !== record.captureEpoch) {
    if (live !== undefined) markObsolete(store, live);
    store.liveEpochBySession.set(record.sessionId, record.captureEpoch);
  }
  return {
    status: record.observation.text.trim().length > 0 ? "ready" : "not-handoff-ready",
    sessionId: record.sessionId,
    captureEpoch: record.captureEpoch,
    observation: record.observation
  };
}

/** Release only the provisional claims owned by this token. VAD is untouched. */
export function releaseSpeechCaptureReservation(store: SpeechCaptureStore, token: string): boolean {
  const record = store.reservations.get(token);
  if (!record) return false;
  for (const key of record.newlyClaimedKeys) {
    if (store.provisionalClaims.get(key) === token) store.provisionalClaims.delete(key);
  }
  removeReservation(store, record);
  return true;
}

function removeReservation(
  store: SpeechCaptureStore,
  record: SpeechCaptureReservationRecord
): void {
  store.reservations.delete(record.token);
  if (store.reservationBySession.get(record.sessionId) === record.token) {
    store.reservationBySession.delete(record.sessionId);
  }
  if (store.provisionalObservationIds.get(record.observation.observationId!) === record.token) {
    store.provisionalObservationIds.delete(record.observation.observationId!);
  }
}

function normalizeObservation(
  output: STTOutput,
  captureEpoch: string,
  createId: () => string
): STTOutput {
  const observationId = opaqueIdentity(output.observationId, createId, "observationId");
  const sourceSegments = output.segments;
  const segments: STTSegment[] =
    sourceSegments !== undefined && sourceSegments.length > 0
      ? sourceSegments.map((segment) =>
          Object.freeze({
            ...segment,
            segmentId: opaqueIdentity(segment.segmentId, createId, "segmentId")
          })
        )
      : [Object.freeze({ segmentId: observationId, text: output.text })];
  return Object.freeze({
    ...output,
    observationId,
    captureEpoch,
    segments: Object.freeze(segments) as unknown as STTSegment[]
  });
}

function normalizeSessionId(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}

function opaqueIdentity(value: string | undefined, createId: () => string, field: string): string {
  if (value === undefined) return createId();
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must be a non-empty opaque identity.`);
  return trimmed;
}

function markObsolete(store: SpeechCaptureStore, epoch: string): void {
  if (store.obsoleteEpochs.has(epoch)) return;
  store.obsoleteEpochs.add(epoch);
  store.obsoleteOrder.push(epoch);
  while (store.obsoleteOrder.length > SPEECH_CAPTURE_CLAIM_LIMIT) {
    const oldest = store.obsoleteOrder.shift();
    if (oldest) store.obsoleteEpochs.delete(oldest);
  }
}

function evictOldestClaims(store: SpeechCaptureStore): void {
  while (store.claims.size > SPEECH_CAPTURE_CLAIM_LIMIT) {
    const oldest = store.claims.keys().next().value;
    if (oldest === undefined) return;
    store.claims.delete(oldest);
  }
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}

export class SpeechCaptureFenceError extends Error {
  readonly reason:
    | "duplicate"
    | "stale-epoch"
    | "reservation-in-progress"
    | "reservation-capacity"
    | "invalid-reservation";
  readonly captureEpoch: string;
  readonly segmentId?: string;

  constructor(
    reason: SpeechCaptureFenceError["reason"],
    captureEpoch: string,
    message?: string,
    segmentId?: string
  ) {
    super(
      message ??
        (reason === "stale-epoch"
          ? "Finalized speech from an obsolete capture epoch was rejected."
          : reason === "duplicate"
            ? "Duplicate finalized speech segments were suppressed."
            : reason === "reservation-capacity"
              ? "Speech admission is at its bounded reservation capacity."
              : reason === "invalid-reservation"
                ? "Speech reservation is missing or already terminal."
                : "A conflicting finalized speech reservation is in progress.")
    );
    this.name = "SpeechCaptureFenceError";
    this.reason = reason;
    this.captureEpoch = captureEpoch;
    if (segmentId) this.segmentId = segmentId;
  }
}
