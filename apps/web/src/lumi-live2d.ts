import { LumiPresentationMotion } from "./lumi-presentation-motion.js";
import {
  LUMI_PRESENTATION_CALIBRATION,
  type LumiExpression
} from "./lumi-presentation-calibration.js";
import {
  AudioMouthEnvelope,
  type AudioEnvelopeHost,
  type MouthParameterTarget
} from "./lumi-audio.js";
import type { SpeechPlaybackEvent } from "./speech-queue.js";
import {
  executeEmbodiedPresentationRequest,
  type EmbodiedPresentationExecutorActions
} from "./embodied-presentation-executor.js";
import {
  createEmbodiedPresentationRequest,
  createEmbodiedPresentationOutcomeReport,
  type EmbodiedPresentationRequest,
  type EmbodiedPresentationOutcomeReport
} from "@companion/protocol";
import {
  composeCompanionPresenceAnimation,
  createGazeScheduler,
  type GazeScheduler,
  type SuppliedGazeTarget
} from "./companion-gaze.js";
import {
  createCompanionBlinkScheduler,
  createInitialCompanionPresence,
  createPresenceBehaviorTransition,
  getCompanionAnimation,
  getCompanionPresentationState,
  type CompanionPresenceProjection,
  type CompanionPresentationState
} from "./companion-presence.js";
import {
  correlateSpeechPlayback,
  createSpeechPlaybackCorrelation,
  type SpeechPlaybackCorrelationState
} from "./speech-playback-correlation.js";
import {
  loadLumiCubismModel,
  type LumiParameterInfo,
  type LumiCubismModel,
  type LumiFraming
} from "./lumi-cubism-model.js";

export const lumiMapping = {
  mouthOpen: { id: "ParamMouthOpenY", min: 0, max: 2.1 },
  mouthForm: { id: "ParamMouthForm", min: -1, max: 1 },
  breath: { id: "ParamBreath", min: 0, max: 1 },
  eyeLeft: "ParamEyeLOpen",
  eyeRight: "ParamEyeROpen"
} as const;

/** Central mapping for the Presence-owned gaze, head, and body channels. */
export const LUMI_PRESENCE_PARAMETER_MAP = {
  eyeBallX: { id: "ParamEyeBallX", min: -1, max: 1, neutral: 0 },
  eyeBallY: { id: "ParamEyeBallY", min: -1, max: 1, neutral: 0 },
  headAngleX: { id: "ParamAngleX", min: -30, max: 30, neutral: 0 },
  headAngleY: { id: "ParamAngleY", min: -30, max: 30, neutral: 0 },
  headAngleZ: { id: "ParamAngleZ", min: -30, max: 30, neutral: 0 },
  bodyAngleX: { id: "ParamBodyAngleX", min: -30, max: 30, neutral: 0 },
  bodyAngleY: { id: "ParamBodyAngleY", min: -30, max: 30, neutral: 0 },
  bodyAngleZ: { id: "ParamBodyAngleZ", min: -30, max: 30, neutral: 0 }
} as const;

export type LumiPresenceAnimation = {
  mouthForm?: number;
  translateX?: number;
  translateY?: number;
  blink?: number;
  breath?: number;
  eyeBallX?: number;
  eyeBallY?: number;
  headAngleX?: number;
  headAngleY?: number;
  headAngleZ?: number;
  bodyAngleX?: number;
  bodyAngleY?: number;
  bodyAngleZ?: number;
};

export type LumiModelLifecycle = "loading" | "ready" | "failed" | "disposed";

/** Identity supplied with the exact model source owned by a LumiController. */
export type LumiModelIdentity = Readonly<{ id: string; name: string }>;

export interface Live2DAdapter extends MouthParameterTarget {
  load(source: string): Promise<void>;
  setParameter(id: string, value: number): void;
  getPendingParameter?(id: string): number | undefined;
  getParameterInfo?(id: string): LumiParameterInfo | undefined;
  getCoreParameterValue?(id: string): number | undefined;
  getLastPreUpdateParameters?(): Readonly<Record<string, number>>;
  getOwnedParameterIds?(): ReadonlySet<string>;
  setTranslation?(x: number, y: number): void;
  setBreath(value: number): void;
  setFraming(framing: LumiFraming): void;
  getFraming?(): LumiFraming;
  getFramingDiagnostics?(): import("./lumi-framing.js").LumiFramingDiagnostics | null;
  resize(width: number, height: number): void;
  dispose(): void;
}

export type LumiPresentationClockOptions = {
  random?: () => number;
  now?: () => number;
  requestFrame?: (callback: (now: number) => void) => number;
  cancelFrame?: (frame: number) => void;
  isHidden?: () => boolean;
};

export type LumiPresentationDebug = {
  running: boolean;
  generation: number;
  state: CompanionPresentationState;
  frameDeltaMs: number;
  transitionProgress: number;
  gaze: ReturnType<GazeScheduler["getDebug"]>;
  blinkPhase: ReturnType<ReturnType<typeof createCompanionBlinkScheduler>["getPhase"]>;
};

/**
 * Lifecycle-owned continuous presentation mechanics. It consumes normalized
 * Presence and execution-level gaze input, then emits parameter intent to the
 * Lumi model adapter. It never owns product Presence or writes Cubism Core.
 */
export class LumiPresentationController {
  private readonly motion: LumiPresentationMotion;
  private wasHidden = false;
  private gazeEffect: {
    request: EmbodiedPresentationRequest;
    startedAt: number;
    releasing: boolean;
  } | null = null;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly requestFrame: ((callback: (now: number) => void) => number) | null;
  private readonly cancelFrame: ((frame: number) => void) | null;
  private readonly isHidden: () => boolean;
  private projection: CompanionPresenceProjection = createInitialCompanionPresence();
  private suppliedGazeTarget: SuppliedGazeTarget | null = null;
  private blinkScheduler: ReturnType<typeof createCompanionBlinkScheduler> | null = null;
  private gazeScheduler: GazeScheduler | null = null;
  private behaviorTransition = createPresenceBehaviorTransition("idle");
  private frame: number | null = null;
  private previousNow: number | null = null;
  private frameDeltaMs = 0;
  private generation = 0;
  private disposed = false;
  private running = false;
  private debug: LumiPresentationDebug = {
    running: false,
    generation: 0,
    state: "idle",
    frameDeltaMs: 0,
    transitionProgress: 1,
    gaze: createGazeScheduler(() => 0, 0).getDebug(),
    blinkPhase: "waiting"
  };

  constructor(
    private readonly apply: (animation: LumiPresenceAnimation) => void,
    options: LumiPresentationClockOptions = {},
    private readonly report?: (report: EmbodiedPresentationOutcomeReport) => void
  ) {
    this.motion = new LumiPresentationMotion(report);
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => (typeof performance === "undefined" ? 0 : performance.now()));
    this.requestFrame =
      options.requestFrame ??
      (typeof requestAnimationFrame === "function"
        ? (callback) => requestAnimationFrame(callback)
        : null);
    this.cancelFrame =
      options.cancelFrame ??
      (typeof cancelAnimationFrame === "function" ? (frame) => cancelAnimationFrame(frame) : null);
    this.isHidden =
      options.isHidden ??
      (() => typeof document !== "undefined" && document.visibilityState === "hidden");
    // The initial scheduler is diagnostics-only until start() creates the
    // lifecycle-owned pair. It avoids a nullable debug shape before mount.
    this.disposeSchedulers();
  }

  setProjection(projection: CompanionPresenceProjection): void {
    if (this.disposed) return;
    if (
      projection.epoch !== this.projection.epoch ||
      projection.transition === "interrupted" ||
      projection.speech === "cancelled" ||
      projection.lifecycle === "cancelled" ||
      projection.lifecycle === "invalidated"
    ) {
      this.motion.clear();
      this.finishGaze("INTERRUPTED");
    }
    this.projection = projection;
  }

  setGazeTarget(target: SuppliedGazeTarget | null): void {
    if (this.disposed) return;
    this.finishGaze("INTERRUPTED");
    this.suppliedGazeTarget = target;
    this.gazeScheduler?.setSuppliedTarget(target);
  }

  setSemanticGaze(request: EmbodiedPresentationRequest, target: SuppliedGazeTarget | null): void {
    if (this.disposed) return;
    this.setGazeTarget(target);
    this.gazeEffect = { request, startedAt: this.now(), releasing: false };
  }

  private finishGaze(outcome: "INTERRUPTED" | "COMPLETED"): void {
    const effect = this.gazeEffect;
    this.gazeEffect = null;
    if (!effect) return;
    this.suppliedGazeTarget = null;
    this.gazeScheduler?.setSuppliedTarget(null);
    this.report?.({
      version: "embodied-presentation-outcome-7k.v1",
      effectId: effect.request.effectId,
      outcome
    });
  }

  setExpression(request: EmbodiedPresentationRequest, intent: LumiExpression): void {
    if (!this.disposed) this.motion.replace(request, intent, this.now());
  }

  recoverVisibility(): void {
    if (this.disposed) return;
    this.motion.clear();
    this.finishGaze("INTERRUPTED");
    this.suppliedGazeTarget = null;
    this.gazeScheduler?.setSuppliedTarget(null);
    this.gazeScheduler?.reset(this.now());
    this.blinkScheduler?.dispose();
    this.blinkScheduler = this.running
      ? createCompanionBlinkScheduler(this.random, this.now())
      : null;
    this.previousNow = null;
    this.apply({
      blink: 0,
      mouthForm: 0,
      translateX: 0,
      translateY: 0,
      eyeBallX: 0,
      eyeBallY: 0,
      headAngleX: 0,
      headAngleY: 0,
      headAngleZ: 0,
      bodyAngleX: 0,
      bodyAngleY: 0,
      bodyAngleZ: 0
    });
  }

  start(): void {
    if (this.disposed || this.running || this.requestFrame === null) return;
    this.running = true;
    this.previousNow = null;
    this.generation += 1;
    const generation = this.generation;
    this.blinkScheduler = createCompanionBlinkScheduler(this.random, this.now());
    this.gazeScheduler = createGazeScheduler(this.random, this.now());
    this.gazeScheduler.setSuppliedTarget(this.suppliedGazeTarget);
    this.behaviorTransition = createPresenceBehaviorTransition(this.currentState());

    const animate = (now: number) => {
      if (this.disposed || !this.running || generation !== this.generation) return;
      if (this.isHidden()) {
        if (!this.wasHidden) this.recoverVisibility();
        this.wasHidden = true;
        this.previousNow = now;
        this.schedule(animate);
        return;
      }
      if (this.wasHidden || (this.previousNow !== null && now - this.previousNow > 1000)) {
        this.recoverVisibility();
        this.wasHidden = false;
      }
      const previous = this.previousNow;
      const delta = previous === null ? 0 : Math.max(0, now - previous);
      this.previousNow = now;
      this.frameDeltaMs = Math.min(100, delta);

      const gazeEffect = this.gazeEffect;
      if (gazeEffect) {
        const age = now - gazeEffect.startedAt;
        if (age >= LUMI_PRESENTATION_CALIBRATION.gazeHoldMs && !gazeEffect.releasing) {
          gazeEffect.releasing = true;
          this.suppliedGazeTarget = null;
          this.gazeScheduler?.setSuppliedTarget(null);
        }
        if (
          age >=
          LUMI_PRESENTATION_CALIBRATION.gazeHoldMs + LUMI_PRESENTATION_CALIBRATION.gazeSettleMs
        )
          this.finishGaze("COMPLETED");
      }
      const state = this.currentState();
      const behavior = this.behaviorTransition.sample(state, this.frameDeltaMs, now);
      const interrupted = state === "interrupted";
      const blink = interrupted
        ? 0
        : (this.blinkScheduler?.sample(now, state, behavior.effective) ?? 0);
      const animation = getCompanionAnimation(state, now, blink, behavior.effective);
      const gaze = this.gazeScheduler?.sample(
        now,
        this.frameDeltaMs,
        interrupted,
        behavior.effective
      );
      if (gaze) {
        const forceGaze =
          import.meta.env.DEV &&
          typeof window !== "undefined" &&
          (window as typeof window & { __yuviForceGaze?: boolean }).__yuviForceGaze === true;
        this.apply(
          this.motion.sample(
            composeCompanionPresenceAnimation(animation, gaze, forceGaze),
            state,
            now,
            this.frameDeltaMs
          )
        );
      }
      this.debug = {
        running: true,
        generation,
        state,
        frameDeltaMs: this.frameDeltaMs,
        transitionProgress: behavior.transitionProgress,
        gaze: gaze ?? this.gazeScheduler!.getDebug(),
        blinkPhase: this.blinkScheduler?.getPhase(now) ?? "waiting"
      };
      this.schedule(animate);
    };
    this.schedule(animate);
  }

  stop(): void {
    this.motion.clear();
    this.finishGaze("INTERRUPTED");
    if (!this.running && this.frame === null) return;
    this.running = false;
    this.generation += 1;
    if (this.frame !== null) this.cancelFrame?.(this.frame);
    this.frame = null;
    this.previousNow = null;
    this.disposeSchedulers();
    this.debug = { ...this.debug, running: false, frameDeltaMs: 0 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.projection = createInitialCompanionPresence();
    this.suppliedGazeTarget = null;
  }

  getDebug(): LumiPresentationDebug {
    return this.debug;
  }

  private currentState(): CompanionPresentationState {
    const forced = readForcedPresentationState();
    if (forced !== null) return forced;
    return getCompanionPresentationState(this.projection);
  }

  private schedule(callback: (now: number) => void): void {
    if (!this.running || this.requestFrame === null) return;
    this.frame = this.requestFrame(callback);
  }

  private disposeSchedulers(): void {
    this.blinkScheduler?.dispose();
    this.gazeScheduler?.dispose();
    this.blinkScheduler = null;
    this.gazeScheduler = null;
  }
}

/** Official Cubism Framework/WebGL adapter for the Cubism 3 Lumi model. */
export class CubismLive2DAdapter implements Live2DAdapter {
  private model: LumiCubismModel | null = null;
  private disposed = false;
  private frame: number | null = null;
  private previousFrameAt: number | null = null;
  private loadAbort: AbortController | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async load(source: string): Promise<void> {
    if (this.disposed) throw new Error("Live2D adapter is disposed.");
    const loadAbort = new AbortController();
    this.loadAbort = loadAbort;
    const model = await loadLumiCubismModel(this.canvas, source, loadAbort.signal);
    if (this.disposed || loadAbort.signal.aborted) {
      model.dispose();
      throw new Error("Live2D adapter is disposed.");
    }
    this.model = model;
    this.loadAbort = null;
    this.resize(this.canvas.clientWidth || 320, this.canvas.clientHeight || 420);
    this.resetMouth();
    this.startRenderLoop();
  }

  setParameter(id: string, value: number): void {
    this.model?.setParameter(id, value);
  }

  getPendingParameter(id: string): number | undefined {
    return this.model?.getPendingParameter(id);
  }

  getParameterInfo(id: string): LumiParameterInfo | undefined {
    return this.model?.getParameterInfo?.(id);
  }

  getCoreParameterValue(id: string): number | undefined {
    return this.model?.getCoreParameterValue?.(id);
  }

  getLastPreUpdateParameters(): Readonly<Record<string, number>> {
    return this.model?.getLastPreUpdateParameters?.() ?? {};
  }

  getOwnedParameterIds(): ReadonlySet<string> {
    return this.model?.parameterIds ?? new Set();
  }

  setTranslation(x: number, y: number): void {
    this.model?.setTranslation?.(x, y);
  }

  setMouthOpen(value: number): void {
    this.setParameter(
      lumiMapping.mouthOpen.id,
      clamp(value, lumiMapping.mouthOpen.min, lumiMapping.mouthOpen.max)
    );
  }

  setMouthForm(value: number): void {
    this.setParameter(
      lumiMapping.mouthForm.id,
      clamp(value, lumiMapping.mouthForm.min, lumiMapping.mouthForm.max)
    );
  }

  setBreath(value: number): void {
    this.setParameter(
      lumiMapping.breath.id,
      clamp(value, lumiMapping.breath.min, lumiMapping.breath.max)
    );
  }

  setFraming(framing: LumiFraming): void {
    this.model?.setFraming(framing);
  }

  getFraming(): LumiFraming {
    return this.model?.getFraming() ?? "half";
  }

  getFramingDiagnostics(): import("./lumi-framing.js").LumiFramingDiagnostics | null {
    return this.model?.getFramingDiagnostics() ?? null;
  }

  resetMouth(): void {
    this.setMouthOpen(0);
    this.setMouthForm(0);
  }

  resize(width: number, height: number): void {
    this.model?.resize(width, height);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadAbort?.abort();
    this.loadAbort = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.model?.dispose();
    this.model = null;
  }

  private startRenderLoop(): void {
    const render = (now: number) => {
      if (this.disposed || !this.model) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        this.previousFrameAt = now;
        this.frame = requestAnimationFrame(render);
        return;
      }
      const delta =
        this.previousFrameAt === null
          ? 1 / 60
          : Math.min(0.1, Math.max(0, (now - this.previousFrameAt) / 1000));
      this.previousFrameAt = now;
      this.model.render(delta);
      this.frame = requestAnimationFrame(render);
    };
    this.frame = requestAnimationFrame(render);
  }
}

export type LumiControllerHandle = {
  load(): Promise<void>;
  runMouthCalibration(): Promise<void>;
  setFraming(framing: LumiFraming): void;
  setPresentationProjection(projection: CompanionPresenceProjection): void;
  setGazeTarget(target: SuppliedGazeTarget | null): void;
  executeEmbodiedPresentationRequest(
    request: EmbodiedPresentationRequest
  ): EmbodiedPresentationOutcomeReport;
  setPresenceAnimation(animation: LumiPresenceAnimation): void;
  setPresenceAnimation(blink: number, breath: number): void;
  resumeAudio(): void;
  handlePlaybackEvent(event: SpeechPlaybackEvent): void;
  resize(width: number, height: number): void;
  dispose(): void;
  getPresentationState(): CompanionPresentationState;
  getModelLifecycle(): LumiModelLifecycle;
  getFramingDiagnostics(): import("./lumi-framing.js").LumiFramingDiagnostics | null;
  getDebugInfo(): {
    instanceId: number;
    generation: number;
    pendingEyeLeft?: number;
    pendingEyeRight?: number;
    pendingBreath?: number;
    pendingMouth?: number;
    pendingEyeBallX?: number;
    pendingEyeBallY?: number;
    pendingHeadAngleX?: number;
    pendingHeadAngleY?: number;
    pendingHeadAngleZ?: number;
    pendingBodyAngleX?: number;
    pendingBodyAngleY?: number;
    pendingBodyAngleZ?: number;
    preUpdateEyeBallX?: number;
    preUpdateEyeBallY?: number;
    preUpdateAngleX?: number;
    preUpdateAngleY?: number;
    preUpdateAngleZ?: number;
    preUpdateBodyAngleX?: number;
    preUpdateBodyAngleY?: number;
    preUpdateBodyAngleZ?: number;
    preUpdateEyeBallPhysicsX?: number;
    preUpdateEyeBallPhysicsY?: number;
    ownedParameterIds?: string[];
    presentationClockRunning?: boolean;
    presentationGeneration?: number;
    activePresentationState?: CompanionPresentationState;
    presentationTransitionProgress?: number;
    presentationFrameDeltaMs?: number;
  };
};

let nextLumiControllerInstanceId = 1;

export class LumiController {
  private readonly instanceId = nextLumiControllerInstanceId++;
  private adapter: Live2DAdapter | null = null;
  private envelope: AudioEnvelopeHost | null = null;
  private presentationState: CompanionPresentationState = "idle";
  private modelLifecycle: LumiModelLifecycle = "loading";
  private generation = 0;
  private playbackCorrelation: SpeechPlaybackCorrelationState = createSpeechPlaybackCorrelation();
  private presentationProjection: CompanionPresenceProjection = createInitialCompanionPresence();
  private readonly presentationController: LumiPresentationController;
  private disposed = false;
  private viewport: { width: number; height: number } | null = null;
  private framing: LumiFraming = "half";
  private readonly seenEffects = new Map<string, EmbodiedPresentationOutcomeReport>();
  private latestSourceAt = -Infinity;
  private readonly visibilityHandler = () => {
    this.presentationController.recoverVisibility();
    this.adapter?.setMouthOpen(0);
  };

  constructor(
    private readonly createAdapter: () => Live2DAdapter,
    private readonly source: string,
    private readonly onState?: (state: CompanionPresentationState) => void,
    private readonly createEnvelope: (target: MouthParameterTarget) => AudioEnvelopeHost = (
      target
    ) => new AudioMouthEnvelope(target),
    private readonly onModelLifecycle?: (state: LumiModelLifecycle) => void,
    private readonly onPresentationOutcome?: (report: EmbodiedPresentationOutcomeReport) => void,
    private readonly modelIdentity: LumiModelIdentity | null = null
  ) {
    this.presentationController = new LumiPresentationController(
      (animation) => {
        this.applyPresenceAnimation(animation);
      },
      {},
      (report) => {
        if (this.seenEffects.has(report.effectId)) this.seenEffects.set(report.effectId, report);
        this.onPresentationOutcome?.(report);
      }
    );
    if (typeof document !== "undefined")
      document.addEventListener?.("visibilitychange", this.visibilityHandler);
  }

  async load(): Promise<void> {
    if (this.disposed) return;
    this.setModelLifecycle("loading");
    const generation = ++this.generation;
    this.presentationController.stop();
    this.envelope?.dispose();
    this.envelope = null;
    this.adapter?.dispose();
    this.adapter = null;
    this.playbackCorrelation = createSpeechPlaybackCorrelation();
    const adapter = this.createAdapter();
    this.adapter = adapter;
    try {
      await adapter.load(this.source);
      if (generation !== this.generation) {
        adapter.dispose();
        return;
      }
      // ResizeObserver can fire before/during asynchronous model loading.
      // Reapply the latest container size and framing after the adapter is ready.
      if (this.viewport) adapter.resize(this.viewport.width, this.viewport.height);
      adapter.setFraming(this.framing);
      this.envelope = this.createEnvelope(adapter);
      adapter.resetMouth();
      this.setModelLifecycle("ready");
      this.setPresentationState(getCompanionPresentationState(this.presentationProjection));
      this.presentationController.start();
    } catch (error) {
      if (generation !== this.generation) {
        adapter.dispose();
        return;
      }
      if (import.meta.env.DEV && typeof window !== "undefined") {
        console.warn("Lumi model is unavailable.", error);
      }
      adapter.dispose();
      this.adapter = null;
      this.envelope?.dispose();
      this.envelope = null;
      this.setModelLifecycle("failed");
    }
  }

  setPresenceAnimation(animation: LumiPresenceAnimation): void;
  setPresenceAnimation(blink: number, breath: number): void;
  setPresenceAnimation(
    animationOrBlink: LumiPresenceAnimation | number,
    positionalBreath?: number
  ): void {
    this.applyPresenceAnimation(
      typeof animationOrBlink === "number"
        ? positionalBreath === undefined
          ? { blink: animationOrBlink }
          : { blink: animationOrBlink, breath: positionalBreath }
        : animationOrBlink
    );
  }

  setPresentationProjection(projection: CompanionPresenceProjection): void {
    if (this.disposed) return;
    if (projection.epoch !== this.presentationProjection.epoch) {
      this.seenEffects.clear();
      this.latestSourceAt = -Infinity;
    }
    if (
      projection.transition === "interrupted" ||
      projection.speech === "cancelled" ||
      projection.lifecycle === "cancelled" ||
      projection.lifecycle === "invalidated"
    ) {
      this.envelope?.stop();
    }
    this.presentationProjection = projection;
    this.presentationController.setProjection(projection);
    this.setPresentationState(getCompanionPresentationState(projection));
  }

  setGazeTarget(target: SuppliedGazeTarget | null): void {
    this.presentationController.setGazeTarget(target);
  }

  executeEmbodiedPresentationRequest(
    request: EmbodiedPresentationRequest
  ): EmbodiedPresentationOutcomeReport {
    request = createEmbodiedPresentationRequest(request);
    const projection = this.presentationProjection;
    const previous = this.seenEffects.get(request.effectId);
    if (previous && !this.disposed && this.modelLifecycle === "ready") return previous;
    const foreignTurn =
      projection.epoch !== null &&
      request.behavior.correlation.kind === "turn" &&
      request.behavior.correlation.reference !== projection.epoch;
    if (
      this.disposed ||
      !this.adapter ||
      this.modelLifecycle !== "ready" ||
      foreignTurn ||
      this.seenEffects.size >= 256 ||
      request.behavior.sourceInstance.createdAtMs < this.latestSourceAt ||
      projection.transition === "interrupted" ||
      projection.speech === "cancelled" ||
      projection.lifecycle === "cancelled" ||
      projection.lifecycle === "invalidated" ||
      (typeof document !== "undefined" && document.visibilityState === "hidden")
    ) {
      const validated = createEmbodiedPresentationRequest(request);
      return createEmbodiedPresentationOutcomeReport({
        version: "embodied-presentation-outcome-7k.v1",
        effectId: validated.effectId,
        outcome: "REJECTED"
      });
    }
    const actions: EmbodiedPresentationExecutorActions = {
      setGazeTarget: (target) => this.presentationController.setSemanticGaze(request, target),
      setExpression: (effect, intent) => this.presentationController.setExpression(effect, intent)
    };
    const report = executeEmbodiedPresentationRequest(request, actions);
    if (report.outcome === "STARTED") {
      this.seenEffects.set(request.effectId, report);
      this.latestSourceAt = request.behavior.sourceInstance.createdAtMs;
    }
    return report;
  }

  private applyPresenceAnimation(animation: LumiPresenceAnimation): void {
    if (!this.adapter || this.disposed) return;
    if (animation.mouthForm !== undefined)
      this.adapter.setMouthForm(clamp(animation.mouthForm, -1, 1));
    if (animation.translateX !== undefined || animation.translateY !== undefined)
      this.adapter.setTranslation?.(animation.translateX ?? 0, animation.translateY ?? 0);
    // The composed Presentation frame owns expression, pose, eyes and breath. ParamMouthOpenY remains exclusively
    // driven by the active AudioMouthEnvelope while playback is speaking.
    // ParamMouthForm is composed here and is never written by lip-sync.
    if (animation.blink !== undefined) {
      const eyeOpen = 1 - clamp(animation.blink, 0, 1);
      this.adapter.setParameter(lumiMapping.eyeLeft, eyeOpen);
      this.adapter.setParameter(lumiMapping.eyeRight, eyeOpen);
    }
    if (animation.breath !== undefined) this.adapter.setBreath(clamp(animation.breath, 0, 1));
    this.setOwnedParameter("eyeBallX", animation.eyeBallX);
    this.setOwnedParameter("eyeBallY", animation.eyeBallY);
    this.setOwnedParameter("headAngleX", animation.headAngleX);
    this.setOwnedParameter("headAngleY", animation.headAngleY);
    this.setOwnedParameter("headAngleZ", animation.headAngleZ);
    this.setOwnedParameter("bodyAngleX", animation.bodyAngleX);
    this.setOwnedParameter("bodyAngleY", animation.bodyAngleY);
    this.setOwnedParameter("bodyAngleZ", animation.bodyAngleZ);
  }

  handlePlaybackEvent(event: SpeechPlaybackEvent): void {
    const phase =
      event.type === "audioElementAttached"
        ? "attached"
        : event.type === "playbackStarted"
          ? "started"
          : event.type === "audioElementDetached"
            ? "detached"
            : "terminal";
    const result = correlateSpeechPlayback(this.playbackCorrelation, phase, event.segment);
    this.playbackCorrelation = result.state;
    if (!result.accepted) return;

    if (event.type === "audioElementAttached") {
      this.envelope?.attach(event.audio);
    } else if (event.type === "playbackStarted") {
      this.envelope?.startPlayback?.(event.audio);
    } else if (event.type === "playbackEnded") {
      this.envelope?.stop();
    } else if (event.type === "playbackStopped" || event.type === "playbackError") {
      this.envelope?.stop();
    } else if (event.type === "audioElementDetached") {
      this.envelope?.detach();
    }
  }

  resumeAudio(): void {
    this.envelope?.resume?.();
  }

  async runMouthCalibration(): Promise<void> {
    const adapter = this.adapter;
    const generation = this.generation;
    if (!adapter || this.presentationState === "speaking") return;
    for (const value of [0, 1, 2.1, 0]) {
      if (
        generation !== this.generation ||
        adapter !== this.adapter ||
        this.getPresentationState() === "speaking"
      )
        return;
      adapter.setMouthOpen(value);
      await pause(700);
    }
  }

  resize(width: number, height: number): void {
    if (this.disposed || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    this.viewport = { width, height };
    this.adapter?.resize(width, height);
  }

  setFraming(framing: LumiFraming): void {
    this.framing = framing;
    this.adapter?.setFraming(framing);
  }

  getFramingDiagnostics(): import("./lumi-framing.js").LumiFramingDiagnostics | null {
    return this.adapter?.getFramingDiagnostics?.() ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof document !== "undefined")
      document.removeEventListener?.("visibilitychange", this.visibilityHandler);
    this.generation += 1;
    this.presentationController.dispose();
    this.playbackCorrelation = createSpeechPlaybackCorrelation();
    this.applyPresenceAnimation({
      blink: 0,
      breath: 0,
      eyeBallX: 0,
      eyeBallY: 0,
      headAngleX: 0,
      headAngleY: 0,
      headAngleZ: 0,
      bodyAngleX: 0,
      bodyAngleY: 0,
      bodyAngleZ: 0
    });
    this.adapter?.resetMouth();
    this.envelope?.dispose();
    this.envelope = null;
    this.adapter?.dispose();
    this.adapter = null;
    this.presentationProjection = createInitialCompanionPresence();
    this.setModelLifecycle("disposed");
  }

  getPresentationState(): CompanionPresentationState {
    return this.presentationState;
  }

  getModelLifecycle(): LumiModelLifecycle {
    return this.modelLifecycle;
  }

  /** A configured/requested identity is active only while this controller is ready. */
  getActiveModelIdentity(): LumiModelIdentity | null {
    return this.modelLifecycle === "ready" ? this.modelIdentity : null;
  }

  getDebugInfo(): {
    instanceId: number;
    generation: number;
    pendingEyeLeft?: number;
    pendingEyeRight?: number;
    pendingBreath?: number;
    pendingMouth?: number;
    pendingEyeBallX?: number;
    pendingEyeBallY?: number;
    pendingHeadAngleX?: number;
    pendingHeadAngleY?: number;
    pendingHeadAngleZ?: number;
    pendingBodyAngleX?: number;
    pendingBodyAngleY?: number;
    pendingBodyAngleZ?: number;
    preUpdateEyeBallX?: number;
    preUpdateEyeBallY?: number;
    preUpdateAngleX?: number;
    preUpdateAngleY?: number;
    preUpdateAngleZ?: number;
    preUpdateBodyAngleX?: number;
    preUpdateBodyAngleY?: number;
    preUpdateBodyAngleZ?: number;
    preUpdateEyeBallPhysicsX?: number;
    preUpdateEyeBallPhysicsY?: number;
    ownedParameterIds?: string[];
    presentationClockRunning?: boolean;
    presentationGeneration?: number;
    activePresentationState?: CompanionPresentationState;
    presentationTransitionProgress?: number;
    presentationFrameDeltaMs?: number;
  } {
    const info: {
      instanceId: number;
      generation: number;
      pendingEyeLeft?: number;
      pendingEyeRight?: number;
      pendingBreath?: number;
      pendingMouth?: number;
      pendingEyeBallX?: number;
      pendingEyeBallY?: number;
      pendingHeadAngleX?: number;
      pendingHeadAngleY?: number;
      pendingHeadAngleZ?: number;
      pendingBodyAngleX?: number;
      pendingBodyAngleY?: number;
      pendingBodyAngleZ?: number;
      preUpdateEyeBallX?: number;
      preUpdateEyeBallY?: number;
      preUpdateAngleX?: number;
      preUpdateAngleY?: number;
      preUpdateAngleZ?: number;
      preUpdateBodyAngleX?: number;
      preUpdateBodyAngleY?: number;
      preUpdateBodyAngleZ?: number;
      preUpdateEyeBallPhysicsX?: number;
      preUpdateEyeBallPhysicsY?: number;
      ownedParameterIds?: string[];
      presentationClockRunning?: boolean;
      presentationGeneration?: number;
      activePresentationState?: CompanionPresentationState;
      presentationTransitionProgress?: number;
      presentationFrameDeltaMs?: number;
    } = {
      instanceId: this.instanceId,
      generation: this.generation
    };
    const eyeLeft = this.adapter?.getPendingParameter?.(lumiMapping.eyeLeft);
    const eyeRight = this.adapter?.getPendingParameter?.(lumiMapping.eyeRight);
    const breath = this.adapter?.getPendingParameter?.(lumiMapping.breath.id);
    const mouth = this.adapter?.getPendingParameter?.(lumiMapping.mouthOpen.id);
    if (eyeLeft !== undefined) info.pendingEyeLeft = eyeLeft;
    if (eyeRight !== undefined) info.pendingEyeRight = eyeRight;
    if (breath !== undefined) info.pendingBreath = breath;
    if (mouth !== undefined) info.pendingMouth = mouth;
    const eyeBallX = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.id);
    const eyeBallY = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.eyeBallY.id);
    const headAngleX = this.adapter?.getPendingParameter?.(
      LUMI_PRESENCE_PARAMETER_MAP.headAngleX.id
    );
    const headAngleY = this.adapter?.getPendingParameter?.(
      LUMI_PRESENCE_PARAMETER_MAP.headAngleY.id
    );
    const headAngleZ = this.adapter?.getPendingParameter?.(
      LUMI_PRESENCE_PARAMETER_MAP.headAngleZ.id
    );
    const bodyAngleX = this.adapter?.getPendingParameter?.(
      LUMI_PRESENCE_PARAMETER_MAP.bodyAngleX.id
    );
    const bodyAngleY = this.adapter?.getPendingParameter?.(
      LUMI_PRESENCE_PARAMETER_MAP.bodyAngleY.id
    );
    const bodyAngleZ = this.adapter?.getPendingParameter?.(
      LUMI_PRESENCE_PARAMETER_MAP.bodyAngleZ.id
    );
    if (eyeBallX !== undefined) info.pendingEyeBallX = eyeBallX;
    if (eyeBallY !== undefined) info.pendingEyeBallY = eyeBallY;
    if (headAngleX !== undefined) info.pendingHeadAngleX = headAngleX;
    if (headAngleY !== undefined) info.pendingHeadAngleY = headAngleY;
    if (headAngleZ !== undefined) info.pendingHeadAngleZ = headAngleZ;
    if (bodyAngleX !== undefined) info.pendingBodyAngleX = bodyAngleX;
    if (bodyAngleY !== undefined) info.pendingBodyAngleY = bodyAngleY;
    if (bodyAngleZ !== undefined) info.pendingBodyAngleZ = bodyAngleZ;
    const preUpdate = this.adapter?.getLastPreUpdateParameters?.() ?? {};
    if (preUpdate["ParamEyeBallX"] !== undefined)
      info.preUpdateEyeBallX = preUpdate["ParamEyeBallX"];
    if (preUpdate["ParamEyeBallY"] !== undefined)
      info.preUpdateEyeBallY = preUpdate["ParamEyeBallY"];
    if (preUpdate["ParamAngleX"] !== undefined) info.preUpdateAngleX = preUpdate["ParamAngleX"];
    if (preUpdate["ParamAngleY"] !== undefined) info.preUpdateAngleY = preUpdate["ParamAngleY"];
    if (preUpdate["ParamAngleZ"] !== undefined) info.preUpdateAngleZ = preUpdate["ParamAngleZ"];
    if (preUpdate["ParamBodyAngleX"] !== undefined)
      info.preUpdateBodyAngleX = preUpdate["ParamBodyAngleX"];
    if (preUpdate["ParamBodyAngleY"] !== undefined)
      info.preUpdateBodyAngleY = preUpdate["ParamBodyAngleY"];
    if (preUpdate["ParamBodyAngleZ"] !== undefined)
      info.preUpdateBodyAngleZ = preUpdate["ParamBodyAngleZ"];
    if (preUpdate["ParamEyeBallPhysicsX"] !== undefined) {
      info.preUpdateEyeBallPhysicsX = preUpdate["ParamEyeBallPhysicsX"];
    }
    if (preUpdate["ParamEyeBallPhysicsY"] !== undefined) {
      info.preUpdateEyeBallPhysicsY = preUpdate["ParamEyeBallPhysicsY"];
    }
    const owned = this.adapter?.getOwnedParameterIds?.();
    if (owned) info.ownedParameterIds = [...owned];
    const presentation = this.presentationController.getDebug();
    info.presentationClockRunning = presentation.running;
    info.presentationGeneration = presentation.generation;
    info.activePresentationState = presentation.state;
    info.presentationTransitionProgress = presentation.transitionProgress;
    info.presentationFrameDeltaMs = presentation.frameDeltaMs;
    return info;
  }

  private setOwnedParameter(
    key: keyof typeof LUMI_PRESENCE_PARAMETER_MAP,
    value: number | undefined
  ): void {
    if (value === undefined || !this.adapter) return;
    const configured = LUMI_PRESENCE_PARAMETER_MAP[key];
    const actual = this.adapter.getParameterInfo?.(configured.id);
    // A real Cubism adapter exposes the model's parameter table. Missing
    // optional gaze/head channels are a supported degradation; do not stage a
    // value for an ID the model does not actually contain.
    if (this.adapter.getParameterInfo && !actual) return;
    this.adapter.setParameter(
      configured.id,
      clamp(value, actual?.min ?? configured.min, actual?.max ?? configured.max)
    );
  }

  private setPresentationState(state: CompanionPresentationState): void {
    this.presentationState = state;
    this.onState?.(state);
  }

  private setModelLifecycle(state: LumiModelLifecycle): void {
    this.modelLifecycle = state;
    this.onModelLifecycle?.(state);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function readForcedPresentationState(): CompanionPresentationState | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const value = (window as Window & { __yuviForcePresence?: unknown }).__yuviForcePresence;
  switch (value) {
    case "idle":
    case "listening":
    case "thinking":
    case "speaking":
    case "interrupted":
      return value;
    default:
      return null;
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
