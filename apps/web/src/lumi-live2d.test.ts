import { describe, expect, it, vi } from "vitest";
import { gatedEnvelope, rmsFromTimeDomain, smoothMouthEnvelope } from "./lumi-audio.js";
import {
  LUMI_PRESENCE_PARAMETER_MAP,
  LumiPresentationController,
  LumiController,
  lumiMapping
} from "./lumi-live2d.js";
import { createInitialCompanionPresence } from "./companion-presence.js";

const playbackSegment = { requestId: "turn-a", sequence: 0 };
const nextPlaybackSegment = { requestId: "turn-a", sequence: 1 };

function createPresentationHarness() {
  const callbacks: Array<(now: number) => void> = [];
  const controller = new LumiPresentationController(() => undefined, {
    random: () => 0,
    now: () => 0,
    requestFrame: (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancelFrame: () => undefined,
    isHidden: () => false
  });
  return { callbacks, controller };
}

function listeningProjection(epoch: string | null = null) {
  return {
    ...createInitialCompanionPresence(),
    epoch,
    activity: "listening" as const
  };
}

describe("Lumi presence and audio envelope", () => {
  it("uses normalized listening input when its epoch is null", () => {
    const { callbacks, controller } = createPresentationHarness();
    controller.setProjection(listeningProjection());
    controller.start();

    callbacks.shift()?.(16);

    expect(controller.getDebug().state).toBe("listening");
    controller.dispose();
  });

  it("keeps normalized epochful input behavior unchanged", () => {
    const { callbacks, controller } = createPresentationHarness();
    controller.setProjection({
      ...createInitialCompanionPresence(),
      epoch: "turn-a",
      lifecycle: "active",
      activity: "thinking"
    });
    controller.start();
    callbacks.shift()?.(16);

    expect(controller.getDebug().state).toBe("thinking");
    controller.dispose();
  });

  it("treats other epoch-less normalized activity as normalized input", () => {
    const { callbacks, controller } = createPresentationHarness();
    controller.setProjection({
      ...createInitialCompanionPresence(),
      activity: "idle"
    });
    controller.start();
    callbacks.shift()?.(16);

    expect(controller.getDebug().state).toBe("idle");
    controller.dispose();
  });

  it("combines epoch-less normalized listening with supplied gaze", () => {
    const { callbacks, controller } = createPresentationHarness();
    controller.setProjection(listeningProjection());
    controller.setGazeTarget({ x: 0.6, y: 0.2, strength: 1 });
    controller.start();
    callbacks.shift()?.(16);

    expect(controller.getDebug().state).toBe("listening");
    expect(controller.getDebug().gaze.targetX).toBeGreaterThan(0);
    controller.dispose();
  });

  it("owns one lifecycle-safe presentation clock independent of React rerenders", () => {
    const callbacks: Array<(now: number) => void> = [];
    const applied: Array<{ blink?: number; breath?: number; eyeBallX?: number }> = [];
    const controller = new LumiPresentationController((animation) => applied.push(animation), {
      random: () => 0,
      now: () => 0,
      requestFrame: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancelFrame: () => undefined,
      isHidden: () => false
    });
    const initial = createInitialCompanionPresence();
    controller.setProjection({
      ...initial,
      epoch: "turn-a",
      lifecycle: "active",
      activity: "thinking"
    });
    controller.start();
    controller.start();
    expect(callbacks).toHaveLength(1);

    const firstFrame = callbacks.shift();
    firstFrame?.(16);
    expect(applied).toHaveLength(1);
    expect(controller.getDebug().running).toBe(true);
    expect(controller.getDebug().state).toBe("thinking");

    const staleFrame = callbacks.shift();
    controller.dispose();
    staleFrame?.(32);
    expect(applied).toHaveLength(1);
    expect(controller.getDebug().running).toBe(false);
  });

  it("bounds the first frame after a hidden interval without stopping the controller", () => {
    const callbacks: Array<(now: number) => void> = [];
    let hidden = false;
    const controller = new LumiPresentationController(() => undefined, {
      random: () => 0,
      requestFrame: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancelFrame: () => undefined,
      isHidden: () => hidden
    });
    controller.start();
    callbacks.shift()?.(100);
    hidden = true;
    callbacks.shift()?.(200);
    hidden = false;
    callbacks.shift()?.(100_000);
    expect(controller.getDebug().running).toBe(true);
    expect(controller.getDebug().frameDeltaMs).toBeLessThanOrEqual(100);
    controller.dispose();
  });

  it("gates noise and clamps mouth values to Lumi's parameter range", () => {
    const config = { noiseGate: 0.02, gain: 10, attack: 0.04, release: 0.12, maxValue: 2.1 };
    expect(rmsFromTimeDomain(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(gatedEnvelope(0.01, config)).toBe(0);
    expect(gatedEnvelope(0.1, config)).toBeGreaterThan(0);
    expect(gatedEnvelope(1, config)).toBe(lumiMapping.mouthOpen.max);
    expect(smoothMouthEnvelope(0, 2.1, 1, config)).toBeCloseTo(2.1);
    expect(smoothMouthEnvelope(2.1, 0, 1, config)).toBeCloseTo(0);
  });

  it("does not require optional parameters to exist on a target", () => {
    const target = {
      setParameter: vi.fn(),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      resetMouth: vi.fn()
    };
    target.setMouthOpen(0);
    target.setMouthForm(0);
    expect(target.setMouthOpen).toHaveBeenCalledWith(0);
    expect(target.setMouthForm).toHaveBeenCalledWith(0);
  });

  it("enters speaking only after playbackStarted and closes on stop", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const envelope = {
      attach: vi.fn(),
      startPlayback: vi.fn(),
      detach: vi.fn(),
      stop: vi.fn(),
      dispose: vi.fn()
    };
    const states: string[] = [];
    const controller = new LumiController(
      () => adapter,
      "model3.json",
      (state) => states.push(state),
      () => envelope
    );
    await controller.load();
    const audio = {} as HTMLAudioElement;
    controller.handlePlaybackEvent({
      type: "audioElementAttached",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(controller.getPresentationState()).toBe("idle");
    controller.handlePlaybackEvent({
      type: "playbackStarted",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(controller.getPresentationState()).toBe("idle");
    expect(envelope.attach).toHaveBeenCalledWith(audio);
    expect(envelope.startPlayback).toHaveBeenCalledWith(audio);
    controller.handlePlaybackEvent({
      type: "playbackStopped",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(envelope.stop).toHaveBeenCalled();
    expect(controller.getPresentationState()).toBe("idle");
    expect(states).toContain("idle");
  });

  it("does not let text completion override an active audio mouth", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const envelope = { attach: vi.fn(), detach: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
    const controller = new LumiController(
      () => adapter,
      "model3.json",
      undefined,
      () => envelope
    );
    await controller.load();
    const audio = {} as HTMLAudioElement;
    controller.handlePlaybackEvent({
      type: "playbackStarted",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    adapter.resetMouth.mockClear();
    expect(controller.getPresentationState()).toBe("idle");
    expect(adapter.resetMouth).not.toHaveBeenCalled();
    controller.handlePlaybackEvent({
      type: "playbackEnded",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(controller.getPresentationState()).toBe("idle");
    controller.handlePlaybackEvent({
      type: "audioElementDetached",
      sequence: 0,
      segment: playbackSegment,
      audio
    });
    expect(envelope.detach).toHaveBeenCalledTimes(1);
  });

  it("does not let an old segment detach a newer active analyser", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const envelope = {
      attach: vi.fn(),
      startPlayback: vi.fn(),
      detach: vi.fn(),
      stop: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(
      () => adapter,
      "model3.json",
      undefined,
      () => envelope
    );
    await controller.load();
    const firstAudio = {} as HTMLAudioElement;
    const secondAudio = {} as HTMLAudioElement;

    controller.handlePlaybackEvent({
      type: "audioElementAttached",
      sequence: 0,
      segment: playbackSegment,
      audio: firstAudio
    });
    controller.handlePlaybackEvent({
      type: "playbackStarted",
      sequence: 0,
      segment: playbackSegment,
      audio: firstAudio
    });
    controller.handlePlaybackEvent({
      type: "playbackEnded",
      sequence: 0,
      segment: playbackSegment,
      audio: firstAudio
    });
    const detachCountAfterFirst = envelope.detach.mock.calls.length;
    controller.handlePlaybackEvent({
      type: "audioElementAttached",
      sequence: 1,
      segment: nextPlaybackSegment,
      audio: secondAudio
    });
    controller.handlePlaybackEvent({
      type: "playbackStarted",
      sequence: 1,
      segment: nextPlaybackSegment,
      audio: secondAudio
    });
    controller.handlePlaybackEvent({
      type: "audioElementDetached",
      sequence: 0,
      segment: playbackSegment,
      audio: firstAudio
    });

    expect(envelope.detach).toHaveBeenCalledTimes(detachCountAfterFirst);
    expect(controller.getPresentationState()).toBe("idle");
  });

  it("keeps speaking mouth ownership with RMS while presence animates eyes and breath", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    adapter.setParameter.mockClear();
    adapter.setMouthOpen.mockClear();
    adapter.setBreath.mockClear();

    controller.setPresenceAnimation(0.7, 0.2);

    expect(adapter.setParameter.mock.calls[0]?.[0]).toBe(lumiMapping.eyeLeft);
    expect(adapter.setParameter.mock.calls[0]?.[1]).toBeCloseTo(0.3);
    expect(adapter.setParameter.mock.calls[1]?.[0]).toBe(lumiMapping.eyeRight);
    expect(adapter.setParameter.mock.calls[1]?.[1]).toBeCloseTo(0.3);
    expect(adapter.setBreath).toHaveBeenCalledWith(0.2);
    expect(adapter.setMouthOpen).not.toHaveBeenCalled();
  });

  it("keeps gaze/head ownership separate from blink, breath and RMS mouth", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    adapter.setParameter.mockClear();
    adapter.setMouthOpen.mockClear();
    controller.setPresenceAnimation({
      blink: 0.2,
      breath: 0.3,
      eyeBallX: 0.25,
      eyeBallY: -0.1,
      headAngleX: 4,
      headAngleY: -2,
      headAngleZ: 1
    });
    expect(adapter.setParameter.mock.calls.map(([id]) => id)).toEqual([
      lumiMapping.eyeLeft,
      lumiMapping.eyeRight,
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.id,
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallY.id,
      LUMI_PRESENCE_PARAMETER_MAP.headAngleX.id,
      LUMI_PRESENCE_PARAMETER_MAP.headAngleY.id,
      LUMI_PRESENCE_PARAMETER_MAP.headAngleZ.id
    ]);
    expect(adapter.setMouthOpen).not.toHaveBeenCalled();
  });

  it("clamps presence-owned gaze and head values to the centralized ranges", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    adapter.setParameter.mockClear();
    controller.setPresenceAnimation({ eyeBallX: 9, eyeBallY: -9, headAngleX: 99 });
    expect(adapter.setParameter).toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.id,
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.max
    );
    expect(adapter.setParameter).toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallY.id,
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallY.min
    );
    expect(adapter.setParameter).toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.headAngleX.id,
      LUMI_PRESENCE_PARAMETER_MAP.headAngleX.max
    );
  });

  it("skips optional gaze channels when the loaded model does not expose them", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      getParameterInfo: vi.fn(() => undefined),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    adapter.setParameter.mockClear();
    controller.setPresenceAnimation({ eyeBallX: 0.2, headAngleX: 3 });
    expect(adapter.setParameter).not.toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.id,
      expect.anything()
    );
    expect(adapter.setParameter).not.toHaveBeenCalledWith(
      LUMI_PRESENCE_PARAMETER_MAP.headAngleX.id,
      expect.anything()
    );
  });

  it("does not write presence parameters after the controller is disposed", async () => {
    const adapter = {
      load: vi.fn(async () => undefined),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    controller.dispose();
    adapter.setParameter.mockClear();
    adapter.setBreath.mockClear();
    controller.setPresenceAnimation(1, 0.2);
    expect(adapter.setParameter).not.toHaveBeenCalled();
    expect(adapter.setBreath).not.toHaveBeenCalled();
  });

  it("runs the controlled mouth range and restores zero", async () => {
    vi.useFakeTimers();
    try {
      const adapter = {
        load: vi.fn(async () => undefined),
        setMouthOpen: vi.fn(),
        setMouthForm: vi.fn(),
        setParameter: vi.fn(),
        setBreath: vi.fn(),
        setFraming: vi.fn(),
        resetMouth: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn()
      };
      const controller = new LumiController(
        () => adapter,
        "model3.json",
        undefined,
        () => ({ attach: vi.fn(), detach: vi.fn(), stop: vi.fn(), dispose: vi.fn() })
      );
      await controller.load();
      const calibration = controller.runMouthCalibration();
      await vi.advanceTimersByTimeAsync(2800);
      await calibration;
      expect(adapter.setMouthOpen).toHaveBeenLastCalledWith(0);
      expect(adapter.setMouthOpen.mock.calls.slice(-4).map(([value]) => value)).toEqual([
        0, 1, 2.1, 0
      ]);
      expect(adapter.resetMouth).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a model failure unavailable without affecting its caller", async () => {
    const adapter = {
      load: vi.fn(async () => {
        throw new Error("model missing");
      }),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    };
    const controller = new LumiController(() => adapter, "model3.json");
    await controller.load();
    expect(controller.getModelLifecycle()).toBe("failed");
    expect(controller.getPresentationState()).toBe("idle");
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it("exposes the requested identity only after this controller is ready", async () => {
    let finish!: () => void;
    const adapter = {
      load: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
      setMouthOpen: vi.fn(), setMouthForm: vi.fn(), setParameter: vi.fn(),
      setBreath: vi.fn(), setFraming: vi.fn(), resetMouth: vi.fn(),
      resize: vi.fn(), dispose: vi.fn()
    };
    const lifecycle: string[] = [];
    const controller = new LumiController(
      () => adapter,
      "hiyori.model3.json",
      undefined,
      undefined,
      (state) => lifecycle.push(state),
      undefined,
      { id: "hiyori", name: "Hiyori Momose" }
    );

    const loading = controller.load();
    expect(controller.getModelLifecycle()).toBe("loading");
    expect(controller.getActiveModelIdentity()).toBeNull();
    finish();
    await loading;

    expect(controller.getModelLifecycle()).toBe("ready");
    expect(controller.getActiveModelIdentity()).toEqual({ id: "hiyori", name: "Hiyori Momose" });
    expect(lifecycle).toEqual(["loading", "ready"]);
    controller.dispose();
  });

  it("keeps the newer ready lifecycle when an older reload fails late", async () => {
    let rejectFirst!: (error: unknown) => void;
    const firstLoad = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const makeAdapter = (load: () => Promise<void>) => ({
      load: vi.fn(load),
      setMouthOpen: vi.fn(), setMouthForm: vi.fn(), setParameter: vi.fn(),
      setBreath: vi.fn(), setFraming: vi.fn(), resetMouth: vi.fn(),
      resize: vi.fn(), dispose: vi.fn()
    });
    const first = makeAdapter(() => firstLoad);
    const second = makeAdapter(async () => undefined);
    let next = 0;
    const controller = new LumiController(
      () => (next++ === 0 ? first : second),
      "hiyori.model3.json",
      undefined,
      undefined,
      undefined,
      undefined,
      { id: "hiyori", name: "Hiyori Momose" }
    );

    const oldRequest = controller.load();
    await controller.load();
    expect(controller.getActiveModelIdentity()).toEqual({ id: "hiyori", name: "Hiyori Momose" });
    rejectFirst(new Error("stale load failed"));
    await oldRequest;

    expect(controller.getModelLifecycle()).toBe("ready");
    expect(controller.getActiveModelIdentity()).toEqual({ id: "hiyori", name: "Hiyori Momose" });
    expect(first.dispose).toHaveBeenCalled();
    controller.dispose();
  });

  it("fences stale model loads when a reload replaces the adapter", async () => {
    let resolveFirst!: () => void;
    const firstLoad = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const makeAdapter = (load: () => Promise<void>) => ({
      load: vi.fn(load),
      setMouthOpen: vi.fn(),
      setMouthForm: vi.fn(),
      setParameter: vi.fn(),
      setBreath: vi.fn(),
      setFraming: vi.fn(),
      resetMouth: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn()
    });
    const first = makeAdapter(() => firstLoad);
    const second = makeAdapter(async () => undefined);
    let next = 0;
    const controller = new LumiController(
      () => (next++ === 0 ? first : second),
      "model3.json",
      undefined,
      undefined,
      undefined,
      undefined,
      { id: "second", name: "Second model" }
    );
    const firstRequest = controller.load();
    const secondRequest = controller.load();
    resolveFirst();
    await Promise.all([firstRequest, secondRequest]);

    expect(first.dispose).toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(controller.getPresentationState()).toBe("idle");
    expect(controller.getModelLifecycle()).toBe("ready");
    expect(controller.getActiveModelIdentity()).toEqual({ id: "second", name: "Second model" });
    controller.dispose();
  });

  it("preserves normalized epoch-less input across model reload", async () => {
    const callbacks: Array<(now: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push((now) => callback(now));
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    try {
      const makeAdapter = () => ({
        load: vi.fn(async () => undefined),
        setMouthOpen: vi.fn(),
        setMouthForm: vi.fn(),
        setParameter: vi.fn(),
        setBreath: vi.fn(),
        setFraming: vi.fn(),
        resetMouth: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn()
      });
      const adapters = [makeAdapter(), makeAdapter()];
      let next = 0;
      const controller = new LumiController(() => adapters[next++]!, "model3.json");
      controller.setPresentationProjection(listeningProjection());

      await controller.load();
      callbacks.pop()?.(16);
      expect(controller.getDebugInfo().activePresentationState).toBe("listening");

      callbacks.length = 0;
      await controller.load();
      callbacks.pop()?.(32);
      expect(controller.getDebugInfo().activePresentationState).toBe("listening");

      controller.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("reports expression execution only with a ready model and preserves the effect identity", async () => {
  const adapter = {
    load: vi.fn(async () => undefined),
    setMouthOpen: vi.fn(),
    setMouthForm: vi.fn(),
    setParameter: vi.fn(),
    setBreath: vi.fn(),
    setFraming: vi.fn(),
    resetMouth: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn()
  };
  const request = {
    version: "embodied-presentation-request-7ad.v1" as const,
    effectId: "runtime-effect:ready-smile:1",
    behavior: {
      version: "embodied-behavior-7b.v1" as const,
      behavior: {
        version: "embodied-behavior-7a.v1" as const,
        kind: "EXPRESSION" as const,
        cause: { kind: "character" as const, reference: "character:1" },
        intent: "soft-smile"
      },
      sourceInstance: { reference: "source:1", createdAtMs: 1 },
      correlation: { kind: "turn" as const, reference: "turn:1" }
    }
  };
  const controller = new LumiController(() => adapter, "model3.json");
  const report = (outcome: string) =>
    expect(controller.executeEmbodiedPresentationRequest(request)).toMatchObject({
      effectId: request.effectId,
      outcome
    });
  report("REJECTED");
  const loading = controller.load();
  report("REJECTED");
  expect(adapter.setMouthForm).not.toHaveBeenCalled();
  await loading;
  report("STARTED");
  // Expressions now enter the clock-owned envelope; no competing immediate write.
  expect(adapter.setMouthForm).not.toHaveBeenCalled();
  adapter.setMouthForm.mockClear();
  controller.setPresenceAnimation(0.3, 0.2);
  expect(adapter.setMouthForm).not.toHaveBeenCalled();
  controller.dispose();
  report("REJECTED");
  expect(adapter.setMouthForm).not.toHaveBeenCalled();
  adapter.load.mockRejectedValueOnce(new Error("missing model"));
  const failed = new LumiController(() => adapter, "missing.json");
  await failed.load();
  expect(failed.executeEmbodiedPresentationRequest(request)).toMatchObject({
    effectId: request.effectId,
    outcome: "REJECTED"
  });
  failed.dispose();
});

describe("Companion resize during asynchronous model load", () => {
  it.each(["half", "full"] as const)("replays the newest viewport and %s framing after load and reload", async (framing) => {
    let finish!: () => void;
    const adapter = {
      load: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
      setParameter: vi.fn(), setMouthOpen: vi.fn(), setMouthForm: vi.fn(), setBreath: vi.fn(),
      setFraming: vi.fn(), resetMouth: vi.fn(), resize: vi.fn(), dispose: vi.fn()
    };
    const envelope = { attach: vi.fn(), startPlayback: vi.fn(), detach: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
    const controller = new LumiController(() => adapter, "model3.json", undefined, () => envelope);
    controller.resize(480, 720);
    controller.setFraming(framing);
    const load = controller.load();
    controller.resize(800, 560);
    controller.resize(0, 0); // hidden measurement must not erase the last viewport
    finish(); await load;
    expect(adapter.resize).toHaveBeenLastCalledWith(800, 560);
    expect(adapter.setFraming).toHaveBeenLastCalledWith(framing);
    const reload = controller.load();
    controller.resize(1000, 600);
    finish(); await reload;
    expect(adapter.resize).toHaveBeenLastCalledWith(1000, 600);
    controller.dispose();
  });
});
