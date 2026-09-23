import { t } from "./locale.js";
import { apiClient } from "./api/client.js";
import { installPresentationRehearsal } from "./lumi-presentation-rehearsal.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  LumiController,
  CubismLive2DAdapter,
  type LumiControllerHandle,
  type LumiModelIdentity,
  type LumiModelLifecycle,
  type LumiPresenceAnimation
} from "./lumi-live2d.js";
import type { LumiFraming } from "./lumi-cubism-model.js";
import type { LumiFramingDiagnostics } from "./lumi-framing.js";
import type {
  CompanionPresenceProjection,
  CompanionPresentationState
} from "./companion-presence.js";
import type {
  EmbodiedPresentationOutcomeReport,
  EmbodiedPresentationRequest
} from "@companion/protocol";
import { resolveRuntimeAssetUrl } from "./desktop-runtime.js";
import {
  deriveCompanionRendererPresentation,
  type CompanionRendererPresentation
} from "./companion-presentation-projection.js";



function isHeadBoundsOverlayEnabled(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const flag = (window as typeof window & { __yuviShowHeadBounds?: boolean }).__yuviShowHeadBounds;
  return flag === true;
}

export const LumiCanvas = forwardRef(function LumiCanvas(
  props: {
    requestedProjection: CompanionPresenceProjection;
    className?: string;
    onPresentationOutcome?: (report: EmbodiedPresentationOutcomeReport) => void;
    onModelLifecycle?: (state: LumiModelLifecycle) => void;
    onRendererPresentation?: (state: CompanionRendererPresentation) => void;
    /** Hide all non-canvas chrome for the transparent desktop companion surface. */
    presentationOnly?: boolean;
    showFramingToggle?: boolean;
  },
  ref: Ref<LumiControllerHandle>
): JSX.Element {
  const [modelRequest, setModelRequest] = useState<{
    source: string;
    identity: LumiModelIdentity;
  } | null>(null);
  const [modelError, setModelError] = useState("");
  const modelRequestRef = useRef<typeof modelRequest>(null);
  const onModelLifecycleRef = useRef(props.onModelLifecycle);
  onModelLifecycleRef.current = props.onModelLifecycle;
  const onRendererPresentationRef = useRef(props.onRendererPresentation);
  onRendererPresentationRef.current = props.onRendererPresentation;
  const publishRendererPresentation = (presentation: CompanionRendererPresentation): void => {
    onRendererPresentationRef.current?.(presentation);
  };
  const publishModelLifecycle = (lifecycle: LumiModelLifecycle): void => {
    setModelLifecycle(lifecycle);
    onModelLifecycleRef.current?.(lifecycle);
  };
  const controllerRef = useRef<LumiController | null>(null);

  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await apiClient.getLive2DModels(abort.signal);
        if (!disposed) {
          if (result.activeId === null) {
            modelRequestRef.current = null;
            setModelRequest(null);
            publishModelLifecycle("disposed");
            if (!controllerRef.current) {
              publishRendererPresentation({ status: "no_model" });
            }
            setModelError("No active Live2D model. Open Settings to install Hiyori or select a model.");
          } else if (!result.activeUrl) {
            // Discovery did not provide a loadable source. Preserve any
            // renderer state the LumiController has already proved.
            if (modelRequestRef.current === null) {
              publishRendererPresentation({ status: "unavailable" });
            }
            setModelError("Unable to read the selected Live2D model.");
          } else {
            const activeModel = result.models.find((model) => model.id === result.activeId);
            const identity = {
              id: result.activeId,
              name: activeModel?.name ?? result.activeId
            };
            const request = { source: result.activeUrl, identity };
            const previous = modelRequestRef.current;
            if (
              previous === null ||
              previous.source !== request.source ||
              previous.identity.id !== request.identity.id ||
              previous.identity.name !== request.identity.name
            ) {
              modelRequestRef.current = request;
              setModelRequest(request);
              publishModelLifecycle("loading");
            }
            setModelError("");
          }
        }
      } catch {
        if (!disposed) {
          // Discovery errors say nothing about renderer readiness. In
          // particular, retain an already-proved active model unchanged.
          if (modelRequestRef.current === null) {
            publishRendererPresentation({ status: "unavailable" });
          }
          setModelError("Unable to read the selected Live2D model.");
        }
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 3000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CompanionPresentationState>("idle");
  const [modelLifecycle, setModelLifecycle] = useState<LumiModelLifecycle>("loading");
  const projectionRef = useRef(props.requestedProjection);
  projectionRef.current = props.requestedProjection;
  const onPresentationOutcomeRef = useRef(props.onPresentationOutcome);
  onPresentationOutcomeRef.current = props.onPresentationOutcome;
  // Default portrait (half). Full-body only after an explicit user toggle.
  const [framing, setFraming] = useState<LumiFraming>("half");
  const [overlay, setOverlay] = useState<LumiFramingDiagnostics | null>(null);

  useImperativeHandle(ref, () => {
    return {
      // Resolve the controller at call time. The imperative handle is created
      // before the mount effect installs the controller instance.
      load: () => controllerRef.current?.load() ?? Promise.resolve(),
      runMouthCalibration: () => controllerRef.current?.runMouthCalibration() ?? Promise.resolve(),
      setFraming: (next) => { setFraming(next); controllerRef.current?.setFraming(next); },
      setPresentationProjection: (projection) =>
        controllerRef.current?.setPresentationProjection(projection),
      setGazeTarget: (target) => controllerRef.current?.setGazeTarget(target),
      executeEmbodiedPresentationRequest: (
        request: EmbodiedPresentationRequest
      ): EmbodiedPresentationOutcomeReport =>
        controllerRef.current?.executeEmbodiedPresentationRequest(request) ?? {
          version: "embodied-presentation-outcome-7k.v1",
          effectId: request.effectId,
          outcome: "REJECTED"
        },
      setPresenceAnimation: ((
        animationOrBlink: LumiPresenceAnimation | number,
        breath?: number
      ) => {
        if (typeof animationOrBlink === "number") {
          controllerRef.current?.setPresenceAnimation(animationOrBlink, breath ?? 0);
        } else {
          controllerRef.current?.setPresenceAnimation(animationOrBlink);
        }
      }) as LumiControllerHandle["setPresenceAnimation"],
      resumeAudio: () => controllerRef.current?.resumeAudio(),
      handlePlaybackEvent: (event) => controllerRef.current?.handlePlaybackEvent(event),
      resize: (width, height) => controllerRef.current?.resize(width, height),
      dispose: () => controllerRef.current?.dispose(),
      getPresentationState: () => controllerRef.current?.getPresentationState() ?? "idle",
      getModelLifecycle: () => controllerRef.current?.getModelLifecycle() ?? "loading",
      getFramingDiagnostics: () => controllerRef.current?.getFramingDiagnostics() ?? null,
      getDebugInfo: () =>
        controllerRef.current?.getDebugInfo() ?? {
          instanceId: 0,
          generation: 0
        }
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !modelRequest) return;
    let disposed = false;
    const source = resolveRuntimeAssetUrl(modelRequest.source);
    const controller = new LumiController(
      () => new CubismLive2DAdapter(canvas),
      source,
      (next) => {
        if (!disposed) setState(next);
      },
      undefined,
      (next) => {
        if (!disposed) {
          publishModelLifecycle(next);
          publishRendererPresentation(
            deriveCompanionRendererPresentation(
              next,
              controller.getActiveModelIdentity(),
              modelRequest.identity
            )
          );
        }
      },
      (report) => {
        if (import.meta.env.DEV && report.effectId.startsWith("preview:")) return;
        onPresentationOutcomeRef.current?.(report);
      },
      modelRequest.identity
    );
    controllerRef.current = controller;
    const stopRehearsal = import.meta.env.DEV
      ? installPresentationRehearsal(controller, () => projectionRef.current)
      : () => {};
    const resize = () => controller.resize(container.clientWidth, container.clientHeight);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    // DPR / zoom changes do not always fire ResizeObserver; listen as well.
    window.addEventListener("resize", resize);
    resize();
    controller.setPresentationProjection(projectionRef.current);
    controller.setFraming(framing);
    void controller.load();

    let overlayFrame = 0;
    const tickOverlay = () => {
      if (disposed) return;
      if (isHeadBoundsOverlayEnabled()) {
        setOverlay(controller.getFramingDiagnostics());
      } else {
        setOverlay((current) => (current === null ? current : null));
      }
      overlayFrame = requestAnimationFrame(tickOverlay);
    };
    if (import.meta.env.DEV && !props.presentationOnly) {
      overlayFrame = requestAnimationFrame(tickOverlay);
    }

    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      if (overlayFrame) cancelAnimationFrame(overlayFrame);
      stopRehearsal();
      controller.dispose();
      controllerRef.current = null;
      const currentRequest = modelRequestRef.current;
      if (currentRequest === null) {
        publishRendererPresentation({ status: "no_model" });
      } else if (currentRequest === modelRequest) {
        publishRendererPresentation({ status: "unavailable" });
      } else {
        publishRendererPresentation({ status: "loading", requestedModel: currentRequest.identity });
      }
    };
  }, [modelRequest]);

  useEffect(() => {
    controllerRef.current?.setPresentationProjection(props.requestedProjection);
  }, [props.requestedProjection]);

  useEffect(() => {
    controllerRef.current?.setFraming(framing);
  }, [framing]);

  return (
    <div
      ref={containerRef}
      className={props.className ?? "relative min-h-[280px] overflow-hidden rounded-md bg-ink-900"}
      aria-label={t("Companion avatar")}
      data-presence={state}
      data-model-lifecycle={modelLifecycle}
      data-framing={framing}
    >
      {!props.presentationOnly && (modelError || modelLifecycle !== "ready") && <div className="absolute left-2 top-10 z-10 rounded bg-black/70 p-2 text-sm text-white" role={modelError || modelLifecycle === "failed" ? "alert" : "status"}>
        {t(modelError || (modelLifecycle === "failed" ? "Live2D model failed to load. Check model assets and Cubism Core in Settings." : "Loading Live2D model…"))}
        {!modelError && modelLifecycle === "loading" && <progress aria-label={t("Live2D loading")} />}
      </div>}
      {/*
        display:block avoids the inline-canvas baseline gap. No CSS transform /
        aspect-ratio so the WebGL buffer is never stretched by the browser.
      */}
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{ display: "block", width: "100%", height: "100%" }}
        aria-hidden="true"
      />
      {!props.presentationOnly && overlay && (
        <div className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
          {/* Viewport safe margins */}
          <div
            className="absolute border border-cyan-400/70"
            style={{
              left: overlay.safeViewportPx.left,
              top: overlay.safeViewportPx.top,
              width: Math.max(0, overlay.safeViewportPx.right - overlay.safeViewportPx.left),
              height: Math.max(0, overlay.safeViewportPx.bottom - overlay.safeViewportPx.top)
            }}
          />
          {/* Projected head bounds */}
          <div
            className="absolute border-2 border-amber-400/90"
            style={{
              left: overlay.headProjectionPx.left,
              top: overlay.headProjectionPx.top,
              width: Math.max(0, overlay.headProjectionPx.right - overlay.headProjectionPx.left),
              height: Math.max(0, overlay.headProjectionPx.bottom - overlay.headProjectionPx.top)
            }}
          />
          <div className="absolute left-2 top-8 max-w-[90%] rounded bg-black/60 px-2 py-1 text-[10px] leading-snug text-white">
            framing={overlay.framing} css={overlay.cssWidth}×{overlay.cssHeight} dpr=
            {overlay.devicePixelRatio.toFixed(2)}
            <br />
            uniformScale={overlay.uniformScale.toFixed(2)} px/unit x=
            {overlay.pixelsPerUnitX.toFixed(2)} y={overlay.pixelsPerUnitY.toFixed(2)}
            <br />
            head px L{overlay.headProjectionPx.left.toFixed(0)} R
            {overlay.headProjectionPx.right.toFixed(0)} T{overlay.headProjectionPx.top.toFixed(0)} B
            {overlay.headProjectionPx.bottom.toFixed(0)}
          </div>
        </div>
      )}
      {!props.presentationOnly && <div
        className="pointer-events-none absolute bottom-2 left-2 rounded bg-ink-900/70 px-2 py-1 text-xs text-white"
        aria-live="polite"
      >
        {t(presenceLabel(state))}
      </div>}
      {import.meta.env.DEV && !props.presentationOnly && (
        <button
          type="button"
          className="absolute right-2 top-2 rounded bg-ink-900/70 px-2 py-1 text-xs text-white"
          onClick={() => void controllerRef.current?.runMouthCalibration()}
        >
          测试口型
        </button>
      )}
      {(props.presentationOnly ? props.showFramingToggle === true : props.showFramingToggle !== false) && (
        <button
          type="button"
          className="absolute left-2 bottom-2 rounded bg-ink-900/70 px-2 py-1 text-xs text-white"
          aria-pressed={framing === "full"}
          onClick={() => setFraming((current) => (current === "half" ? "full" : "half"))}
        >
          {/* Label is the action target, not the current mode. */}
          {framing === "half" ? "显示全身" : "显示半身"}
        </button>
      )}
    </div>
  );
});

function presenceLabel(state: CompanionPresentationState): string {
  switch (state) {
    case "listening":
      return "正在聆听";
    case "thinking":
      return "正在思考";
    case "speaking":
      return "正在说话";
    case "interrupted":
      return "已中断";
    case "idle":
      return "待机";
  }
}
