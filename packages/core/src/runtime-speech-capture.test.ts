import { describe, expect, it } from "vitest";
import {
  SPEECH_CAPTURE_RESERVATION_LIMIT,
  SpeechCaptureFenceError,
  beginLiveSpeechCapture,
  claimKey,
  createSpeechCaptureStore,
  finalizeSpeechCaptureReservation,
  releaseSpeechCaptureReservation,
  reserveFinalizedSpeechCapture
} from "./runtime-speech-capture.js";

const observation = (input: {
  text?: string;
  observationId?: string;
  captureEpoch?: string;
  segments?: Array<{ segmentId?: string; text?: string; speakerClusterId?: string }>;
}) => ({
  text: input.text ?? "hello",
  language: "en",
  confidence: 1,
  ...(input.observationId ? { observationId: input.observationId } : {}),
  ...(input.captureEpoch ? { captureEpoch: input.captureEpoch } : {}),
  ...(input.segments ? { segments: input.segments } : {})
});

describe("provisional finalized speech capture fence", () => {
  it("reserves synchronously without changing accepted claims or live epoch", () => {
    const store = createSpeechCaptureStore();
    const reservation = reserveFinalizedSpeechCapture(store, {
      observation: observation({ observationId: "obs-1", segments: [{ segmentId: "seg-1" }] }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    expect(store.claims.size).toBe(0);
    expect(store.liveEpochBySession.has("s")).toBe(false);
    expect(store.reservations.has(reservation.token)).toBe(true);
    expect(store.provisionalClaims.get(claimKey("epoch-1", "seg-1"))).toBe(reservation.token);
    expect(reservation.observation.observationId).toBe("obs-1");
  });

  it("does not let an overlapping reservation win, and release permits retry", () => {
    const store = createSpeechCaptureStore();
    const first = reserveFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-1" }] }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    expect(() =>
      reserveFinalizedSpeechCapture(store, {
        observation: observation({ segments: [{ segmentId: "seg-1" }] }),
        sessionId: "s",
        captureEpoch: "epoch-1"
      })
    ).toThrowError(SpeechCaptureFenceError);

    expect(releaseSpeechCaptureReservation(store, first.token)).toBe(true);
    const retry = reserveFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-1" }] }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    expect(retry.observation.segments?.[0]?.segmentId).toBe("seg-1");
  });

  it("serializes same-session finalized observations even when their segment keys differ", () => {
    const store = createSpeechCaptureStore();
    const first = reserveFinalizedSpeechCapture(store, {
      observation: observation({
        observationId: "obs-first",
        segments: [{ segmentId: "seg-first" }]
      }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    expect(() =>
      reserveFinalizedSpeechCapture(store, {
        observation: observation({
          observationId: "obs-second",
          segments: [{ segmentId: "seg-second" }]
        }),
        sessionId: "s",
        captureEpoch: "epoch-1"
      })
    ).toThrowError(expect.objectContaining({ reason: "reservation-in-progress" }));
    expect(releaseSpeechCaptureReservation(store, first.token)).toBe(true);
  });

  it("does not overwrite an active reservation if an injected token source collides", () => {
    const store = createSpeechCaptureStore();
    const first = reserveFinalizedSpeechCapture(store, {
      observation: observation({
        observationId: "obs-first",
        segments: [{ segmentId: "seg-first" }]
      }),
      sessionId: "first",
      captureEpoch: "epoch-first",
      createId: () => "same-token"
    });
    expect(() =>
      reserveFinalizedSpeechCapture(store, {
        observation: observation({
          observationId: "obs-second",
          segments: [{ segmentId: "seg-second" }]
        }),
        sessionId: "second",
        captureEpoch: "epoch-second",
        createId: () => "same-token"
      })
    ).toThrowError(expect.objectContaining({ reason: "invalid-reservation" }));
    expect(store.reservations.size).toBe(1);
    expect(store.reservations.has(first.token)).toBe(true);
  });

  it("turns provisional claims into accepted claims only after finalization", () => {
    const store = createSpeechCaptureStore();
    const reservation = reserveFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-1" }] }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    expect(finalizeSpeechCaptureReservation(store, reservation.token).status).toBe("ready");
    expect(store.claims.has(claimKey("epoch-1", "seg-1"))).toBe(true);
    expect(store.liveEpochBySession.get("s")).toBe("epoch-1");
    expect(store.reservations.size).toBe(0);
    expect(() =>
      reserveFinalizedSpeechCapture(store, {
        observation: observation({ segments: [{ segmentId: "seg-1" }] }),
        sessionId: "s",
        captureEpoch: "epoch-1"
      })
    ).toThrowError(expect.objectContaining({ reason: "duplicate" }));
  });

  it("preserves the at-least-one-new-segment behavior for a mixed duplicate/new set", () => {
    const store = createSpeechCaptureStore();
    const first = reserveFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-old" }] }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    finalizeSpeechCaptureReservation(store, first.token);
    const mixed = reserveFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-old" }, { segmentId: "seg-new" }] }),
      sessionId: "s",
      captureEpoch: "epoch-1"
    });
    expect(store.provisionalClaims.has(claimKey("epoch-1", "seg-old"))).toBe(false);
    expect(store.provisionalClaims.get(claimKey("epoch-1", "seg-new"))).toBe(mixed.token);
    expect(finalizeSpeechCaptureReservation(store, mixed.token).status).toBe("ready");
  });

  it("rejects a stale epoch before reservation", () => {
    const store = createSpeechCaptureStore();
    beginLiveSpeechCapture(store, "s", "epoch-old");
    beginLiveSpeechCapture(store, "s", "epoch-new");
    expect(() =>
      reserveFinalizedSpeechCapture(store, {
        observation: observation({ segments: [{ segmentId: "late" }] }),
        sessionId: "s",
        captureEpoch: "epoch-old"
      })
    ).toThrowError(expect.objectContaining({ reason: "stale-epoch" }));
  });

  it("keeps a new VAD epoch authoritative while an append reservation is active", () => {
    const store = createSpeechCaptureStore();
    beginLiveSpeechCapture(store, "s", "epoch-old");
    const reservation = reserveFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-old" }] }),
      sessionId: "s",
      captureEpoch: "epoch-old"
    });
    beginLiveSpeechCapture(store, "s", "epoch-new");
    const result = finalizeSpeechCaptureReservation(store, reservation.token);
    expect(result.status).toBe("stale");
    expect(store.liveEpochBySession.get("s")).toBe("epoch-new");
    expect(store.claims.has(claimKey("epoch-old", "seg-old"))).toBe(true);
    expect(store.reservations.size).toBe(0);
  });

  it("release does not roll back an independent VAD transition", () => {
    const store = createSpeechCaptureStore();
    beginLiveSpeechCapture(store, "s", "epoch-old");
    const reservation = reserveFinalizedSpeechCapture(store, {
      observation: observation({ segments: [{ segmentId: "seg-old" }] }),
      sessionId: "s",
      captureEpoch: "epoch-old"
    });
    beginLiveSpeechCapture(store, "s", "epoch-new");
    releaseSpeechCaptureReservation(store, reservation.token);
    expect(store.liveEpochBySession.get("s")).toBe("epoch-new");
    expect(store.claims.has(claimKey("epoch-old", "seg-old"))).toBe(false);
    expect(store.provisionalClaims.size).toBe(0);
  });

  it("does not evict active reservations when its bounded capacity is exhausted", () => {
    const store = createSpeechCaptureStore();
    const tokens: string[] = [];
    for (let index = 0; index < SPEECH_CAPTURE_RESERVATION_LIMIT; index += 1) {
      tokens.push(
        reserveFinalizedSpeechCapture(store, {
          observation: observation({ segments: [{ segmentId: `seg-${index}` }] }),
          sessionId: `session-${index}`,
          captureEpoch: `epoch-${index}`
        }).token
      );
    }
    expect(() =>
      reserveFinalizedSpeechCapture(store, {
        observation: observation({ segments: [{ segmentId: "overflow" }] }),
        sessionId: "overflow",
        captureEpoch: "epoch-overflow"
      })
    ).toThrowError(expect.objectContaining({ reason: "reservation-capacity" }));
    expect(store.reservations.size).toBe(SPEECH_CAPTURE_RESERVATION_LIMIT);
    for (const token of tokens) releaseSpeechCaptureReservation(store, token);
    expect(store.reservations.size).toBe(0);
  });

  it("does not derive captureEpoch from transcript or speaker cluster", () => {
    const store = createSpeechCaptureStore();
    const reservation = reserveFinalizedSpeechCapture(store, {
      observation: observation({
        text: "hello-world",
        segments: [{ segmentId: "seg-1", text: "hello-world", speakerClusterId: "spk_02" }]
      }),
      createId: (() => {
        let id = 0;
        return () => `generated-${++id}`;
      })()
    });
    expect(reservation.captureEpoch).toBe("generated-1");
    expect(reservation.captureEpoch).not.toBe("hello-world");
    expect(reservation.captureEpoch).not.toBe("spk_02");
    expect(reservation.observation.segments?.[0]?.speakerClusterId).toBe("spk_02");
  });
});
