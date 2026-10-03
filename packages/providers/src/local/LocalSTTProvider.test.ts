import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSTTProvider } from "./LocalSTTProvider.js";
import { ProviderErrorCode } from "../types/errors.js";

afterEach(() => vi.unstubAllGlobals());

const BASE_URL = "http://127.0.0.1:9876";

function sidecarResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function transcribeWithSidecar(
  body: Record<string, unknown>,
  requestMetadata?: Record<string, unknown>
) {
  const fetchMock = vi.fn(async () => sidecarResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new LocalSTTProvider({ baseUrl: BASE_URL, model: "sense-voice" });
  const output = await provider.transcribeAudio({
    audioBase64: Buffer.from("RIFF").toString("base64"),
    ...requestMetadata
  });
  return { output, fetchMock };
}

describe("LocalSTTProvider", () => {
  it("posts PCM frames to the sidecar Silero VAD endpoint", async () => {
    const fetchMock = vi.fn(async () => sidecarResponse({ active: true, captureEpoch: "epoch-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new LocalSTTProvider({ baseUrl: BASE_URL, model: "sense-voice" });
    const output = await provider.detectVoiceActivity({
      captureEpoch: "epoch-1",
      pcmBase64: "AAEC",
      sampleRate: 16000
    });
    expect(output).toEqual({ active: true, captureEpoch: "epoch-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/vad",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("requires audio input before contacting the sidecar", async () => {
    const provider = new LocalSTTProvider({
      baseUrl: "http://127.0.0.1:65534",
      model: "sense-voice"
    });
    await expect(provider.transcribeAudio({})).rejects.toMatchObject({
      code: ProviderErrorCode.UnsupportedInput
    });
  });

  it("normalizes diarization spans into typed speaker-aware segments", async () => {
    const { output } = await transcribeWithSidecar({
      text: "你好 hello",
      language: "zh",
      latencyMs: 12,
      segments: [
        { startMs: 0, endMs: 1500, speaker: "0" },
        { startMs: 1600, endMs: 3100, speaker: "1" }
      ]
    });

    expect(output.observationId).toEqual(expect.any(String));
    expect(output.segments).toHaveLength(2);
    const [first, second] = output.segments ?? [];
    expect(first).toMatchObject({ startMs: 0, endMs: 1500, speakerClusterId: "0" });
    expect(second).toMatchObject({ startMs: 1600, endMs: 3100, speakerClusterId: "1" });
    // Diarization spans carry time + cluster evidence; they have no per-span
    // transcript of their own.
    expect(first?.text).toBeUndefined();
    expect(second?.text).toBeUndefined();
    expect(first?.segmentId).toEqual(expect.any(String));
    expect(second?.segmentId).toEqual(expect.any(String));
    expect(first?.segmentId).not.toBe(second?.segmentId);
  });

  it("keeps providerMetadata free of semantic speaker contracts", async () => {
    const { output } = await transcribeWithSidecar({
      text: "hello",
      language: "en",
      identity: { identity: "KNOWN", speakerId: "vp_7", score: 0.9, label: "desk" },
      segments: [{ startMs: 0, endMs: 900, speaker: "0" }],
      embedding: [0.1, 0.2]
    });

    expect(output.providerMetadata).toEqual({ device: "cpu" });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("diarization");
    expect(serialized).not.toContain('"identity"');
    expect(serialized).not.toContain("speakerId");
    expect(serialized).not.toContain("0.1");
    expect(serialized).not.toContain("0.9");
    expect(serialized).not.toContain("desk");
    expect(output).not.toHaveProperty("personId");
  });

  it("maps legacy sidecar speakerId to opaque voiceProfileId, never personId", async () => {
    const { output } = await transcribeWithSidecar({
      text: "one speaker",
      language: "en",
      identity: { identity: "KNOWN", speakerId: "vp_7", score: 0.93, label: "ruichen" },
      segments: [
        { startMs: 0, endMs: 1000, speaker: "0" },
        { startMs: 1100, endMs: 2600, speaker: "0" }
      ]
    });

    for (const segment of output.segments ?? []) {
      expect(segment.speakerClusterId).toBe("0");
      expect(segment.voiceProfileMatch).toEqual({ status: "MATCHED", voiceProfileId: "vp_7" });
    }
    expect(output.voiceProfileMatch).toEqual({ status: "MATCHED", voiceProfileId: "vp_7" });
    expect(output).not.toHaveProperty("personId");
    expect(output).not.toHaveProperty("identity");
    expect(JSON.stringify(output)).not.toContain("0.93");
    expect(JSON.stringify(output)).not.toContain("ruichen");
  });

  it("does not apply a whole-audio identity to every mixed-capture cluster", async () => {
    const { output } = await transcribeWithSidecar({
      text: "two speakers",
      language: "en",
      identity: { identity: "KNOWN", speakerId: "vp_7", score: 0.99 },
      segments: [
        { startMs: 0, endMs: 1000, speaker: "0" },
        { startMs: 1100, endMs: 2600, speaker: "1" }
      ]
    });

    expect(output.voiceProfileMatch).toBeUndefined();
    expect(output.segments).toHaveLength(2);
    expect(output.segments?.map((segment) => segment.speakerClusterId)).toEqual(["0", "1"]);
    expect(
      output.segments?.every((segment) => segment.voiceProfileMatch?.status === "NO_MATCH")
    ).toBe(true);
    expect(JSON.stringify(output)).not.toContain("vp_7");
    expect(output).not.toHaveProperty("personId");
  });

  it("keeps cluster-scoped matches distinct on mixed captures", async () => {
    const { output } = await transcribeWithSidecar({
      text: "two speakers",
      language: "en",
      segments: [
        {
          startMs: 0,
          endMs: 1000,
          speaker: "0",
          voiceProfileMatch: { status: "MATCHED", voiceProfileId: "vp_7" }
        },
        {
          startMs: 1100,
          endMs: 2600,
          speaker: "1",
          voiceProfileMatch: { status: "NO_MATCH" }
        }
      ]
    });

    expect(output.voiceProfileMatch).toBeUndefined();
    expect(output.segments?.[0]?.voiceProfileMatch).toEqual({
      status: "MATCHED",
      voiceProfileId: "vp_7"
    });
    expect(output.segments?.[1]?.voiceProfileMatch).toEqual({ status: "NO_MATCH" });
  });

  it("maps below-threshold sidecar identify to NO_MATCH without embeddings", async () => {
    const { output } = await transcribeWithSidecar({
      text: "unknown",
      language: "en",
      identity: { identity: "UNKNOWN", speakerId: null, score: 0.2, threshold: 0.55 },
      embedding: [0.4, 0.5, 0.6]
    });

    expect(output.voiceProfileMatch).toEqual({ status: "NO_MATCH" });
    expect(JSON.stringify(output)).not.toContain("0.4");
    expect(JSON.stringify(output)).not.toContain("embedding");
  });

  it("gives two identical transcripts distinct observation identity", async () => {
    const sidecarBody = { text: "same words", language: "en", latencyMs: 5 };
    const first = await transcribeWithSidecar(sidecarBody);
    const second = await transcribeWithSidecar(sidecarBody);

    expect(first.output.text).toBe(second.output.text);
    expect(first.output.observationId).toEqual(expect.any(String));
    expect(second.output.observationId).toEqual(expect.any(String));
    expect(first.output.observationId).not.toBe(second.output.observationId);
  });

  it("omits segments when the sidecar reports no diarization", async () => {
    const { output } = await transcribeWithSidecar({ text: "solo speech", language: "en" });

    expect(output.segments).toBeUndefined();
    expect(output.observationId).toEqual(expect.any(String));
  });

  it("uses the sidecar generation owner protocol and keeps audio out of command metadata", async () => {
    const causalRefs = [{ kind: "JOURNAL_EVENT" as const, namespace: "test", eventId: "control" }];
    const command = {
      operation: "ENROLL" as const,
      commandHandle: "acoustic-command-1",
      intentId: "intent-1",
      attemptId: "attempt-1",
      fence: "1",
      payloadDigest: "a".repeat(64),
      expectedRevision: "revision-before",
      voiceProfileId: "profile-a",
      label: "Acoustic label",
      causalRefs
    };
    const receipt = {
      commandHandle: command.commandHandle,
      intentId: command.intentId,
      attemptId: command.attemptId,
      fence: command.fence,
      payloadDigest: command.payloadDigest,
      operation: command.operation,
      voiceProfileId: command.voiceProfileId,
      priorRevision: command.expectedRevision,
      resultingRevision: "revision-after",
      causalRefs
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/speakers")) return sidecarResponse({ speakers: [], revision: "revision-before", complete: true });
      if (target.endsWith("/commands/fence")) return sidecarResponse({ status: "READY" });
      if (target.endsWith("/commands")) return sidecarResponse({ status: "APPLIED", receipt });
      if (target.endsWith("/commands/reconcile")) return sidecarResponse({ status: "ALREADY_APPLIED", receipt });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new LocalSTTProvider({ baseUrl: BASE_URL, model: "sense-voice" });
    const profiles = provider.voiceProfiles;
    await expect(profiles.readAuthorityState?.()).resolves.toEqual({ complete: true, revision: "revision-before", profiles: [] });
    await expect(profiles.fenceNativeCommand?.(command)).resolves.toBe("READY");
    await expect(profiles.applyNativeCommand?.({ ...command, audioBase64: "PRIVATE_WAV" })).resolves.toEqual({ status: "APPLIED", receipt });
    await expect(profiles.reconcileNativeCommand?.(command)).resolves.toEqual({ status: "ALREADY_APPLIED", receipt });
    const fenceBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const applyBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    const reconcileBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(fenceBody.command).not.toHaveProperty("audioBase64");
    expect(applyBody.command).not.toHaveProperty("audioBase64");
    expect(applyBody.audioBase64).toBe("PRIVATE_WAV");
    expect(reconcileBody.command).not.toHaveProperty("audioBase64");
  });

  it("rejects legacy direct acoustic mutations when the sidecar requires A9 commands", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ error: "governed_acoustic_command_required" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const profiles = new LocalSTTProvider({ baseUrl: BASE_URL, model: "sense-voice" }).voiceProfiles;
    await expect(profiles.enroll({ voiceProfileId: "profile", label: "label", audioBase64: "audio" })).rejects.toThrow();
    await expect(profiles.delete("profile")).rejects.toThrow();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:9876/speakers",
      "http://127.0.0.1:9876/speakers/profile"
    ]);
  });
});
