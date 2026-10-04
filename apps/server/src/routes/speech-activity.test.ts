import Fastify from "fastify";
import { SpeechCaptureFenceError } from "@companion/core";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { registerSpeechActivityRoutes } from "./speech-activity.js";

async function createApp(runtime: Record<string, unknown>, providers?: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  await registerSpeechActivityRoutes(app, {
    runtime,
    providers: providers ?? {
      getSTTProvider: () => ({})
    }
  } as unknown as AppContext);
  return app;
}

describe("speech activity routes", () => {
  it("observes classified VAD transitions through Runtime", async () => {
    const observeSpeechActivity = vi.fn(() => ({
      speechActive: true,
      captureEpoch: "epoch-1",
      activityRevision: 4
    }));
    const app = await createApp({
      observeSpeechActivity,
      getSpeechActivitySnapshot: () => ({
        speechActive: false,
        captureEpoch: null,
        activityRevision: 3
      })
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/speech-activity",
      payload: { sessionId: "s", captureEpoch: "epoch-1", active: true }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      speechActive: true,
      captureEpoch: "epoch-1",
      activityRevision: 4
    });
    expect(observeSpeechActivity).toHaveBeenCalledWith({
      sessionId: "s",
      captureEpoch: "epoch-1",
      active: true
    });
    await app.close();
  });

  it("classifies PCM frames with sidecar VAD then observes Runtime", async () => {
    const detectVoiceActivity = vi.fn(async () => ({ active: true, captureEpoch: "epoch-1" }));
    const observeSpeechActivity = vi.fn(() => ({
      speechActive: true,
      captureEpoch: "epoch-1",
      activityRevision: 1
    }));
    const app = await createApp(
      { observeSpeechActivity },
      { getSTTProvider: () => ({ detectVoiceActivity }) }
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/speech-activity/frames",
      payload: {
        sessionId: "s",
        captureEpoch: "epoch-1",
        pcmBase64: Buffer.from([0, 0, 1, 0]).toString("base64"),
        sampleRate: 16000
      }
    });
    expect(response.statusCode).toBe(200);
    expect(detectVoiceActivity).toHaveBeenCalled();
    expect(observeSpeechActivity).toHaveBeenCalledWith({
      sessionId: "s",
      captureEpoch: "epoch-1",
      active: true
    });
    await app.close();
  });

  it("retires legacy playback admission without invoking a second authority", async () => {
    const admitSpeechPlayback = vi.fn(() => ({
      effectId: "speech.1",
      requestId: "turn-1",
      sessionId: "s",
      state: "ADMITTED"
    }));
    const reportSpeechPlaybackOutcome = vi.fn(() => ({
      effectId: "speech.1",
      requestId: "turn-1",
      sessionId: "s",
      state: "INTERRUPTED"
    }));
    const app = await createApp({ admitSpeechPlayback, reportSpeechPlaybackOutcome });
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/speech-playback",
      payload: { sessionId: "s", requestId: "turn-1" }
    });
    expect(admitted.statusCode).toBe(410);
    expect(admitted.json()).toMatchObject({ error: "canonical_media_permission_required" });
    const outcome = await app.inject({
      method: "POST",
      url: "/v1/speech-playback/outcome",
      payload: { effectId: "speech.1", outcome: "INTERRUPTED" }
    });
    expect(outcome.statusCode).toBe(410);
    expect(admitSpeechPlayback).not.toHaveBeenCalled();
    expect(reportSpeechPlaybackOutcome).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not admit a user turn when VAD is unavailable", async () => {
    const app = await createApp({ observeSpeechActivity: vi.fn() }, { getSTTProvider: () => ({}) });
    const response = await app.inject({
      method: "POST",
      url: "/v1/speech-activity/frames",
      payload: {
        sessionId: "s",
        captureEpoch: "epoch-1",
        pcmBase64: "AAA="
      }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("vad_unavailable");
    await app.close();
  });

  it("maps stale capture epochs to 409", async () => {
    const app = await createApp({
      observeSpeechActivity: () => {
        throw new SpeechCaptureFenceError("stale-epoch", "epoch-old");
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/speech-activity",
      payload: { captureEpoch: "epoch-old", active: true }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "stale-epoch" });
    await app.close();
  });
});
