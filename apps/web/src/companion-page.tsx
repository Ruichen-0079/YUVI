import { t } from "./locale.js";
import { publishSubtitleProjection } from "./subtitle-bus.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "./api/client.js";
import {
  CompanionBus,
  type CompanionBusMessage,
  type CompanionTtsConfiguration
} from "./companion-bus.js";
import {
  CompanionPresentationProjectionChannel,
  deriveCompanionRendererPresentation,
  type Live2DModelSelectionProjection
} from "./companion-presentation-projection.js";
import {
  applyCapabilityProjection,
  deriveCapabilityProjection,
  detectBrowserAudioCapability
} from "./capability-projection.js";
import {
  createCompanionPresenceEpochGuard,
  createInterruptedResetScheduler,
  createInitialCompanionPresence,
  canInterruptGeneration,
  reduceCompanionPresence,
  type CompanionPresenceProjection
} from "./companion-presence.js";
import type { BehaviorPolicyController } from "./behavior-policy-controller.js";
import { createCompanionEmbodiedBehaviorController } from "./companion-embodied-behavior-controller.js";

import { createCompanionSpeechBuffer } from "./companion-speech-buffer.js";
import { createCompanionReadyAnnouncer } from "./companion-voice-sync.js";
import { createSpeechSegmentDeduper } from "./speech-segment-dedup.js";
import {
  correlateSpeechPlayback,
  createSpeechPlaybackCorrelation,
  type SpeechPlaybackCorrelationState
} from "./speech-playback-correlation.js";
import { LumiCanvas } from "./lumi-canvas.js";
import type { LumiControllerHandle, LumiModelLifecycle } from "./lumi-live2d.js";
import { initialServiceStatusState, type ServiceStatusState } from "./service-status-state.js";
import {
  isServiceSupervisorAvailable,
  subscribeServiceStatusState
} from "./service-supervisor-client.js";
import {
  createBrowserSpeechPlayer,
  SpeechPlaybackQueue,
  type SpeechPlaybackEvent
} from "./speech-queue.js";
import type { SpeechSegmentIdentity } from "./speech-identity.js";
import {
  isTauriRuntime,
  preloadTauriWindowApi,
  startWindowDragging,
  startWindowResizeDragging,
  trackWindowDragGesture
} from "./tauri-window.js";

/**
 * Desktop companion window surface: exclusively owns Lumi, the speech queue,
 * HTMLAudioElement playback, the AudioContext, the analyser and the mouth
 * envelope. The main window only forwards speech segments and stop commands.
 */
export function CompanionPage(): JSX.Element {
  const presentationReportsRef = useRef(Promise.resolve());
  const submitPresentationOutcome = (report: import("@companion/protocol").EmbodiedPresentationOutcomeReport) => {
    companionBusRef.current?.post({ kind: "embodied-presentation-outcome", report });
    presentationReportsRef.current = presentationReportsRef.current
      .then(() => apiClient.postEmbodiedPresentationOutcome(report)).catch(() => undefined);
  };
  const lumiRef = useRef<LumiControllerHandle>(null);
  const sessionRef = useRef<{
    requestId: string;
    queue: SpeechPlaybackQueue;
    deduper: ReturnType<typeof createSpeechSegmentDeduper>;
  } | null>(null);
  const speechBufferRef = useRef(createCompanionSpeechBuffer());
  const announcerRef = useRef<ReturnType<typeof createCompanionReadyAnnouncer> | null>(null);
  const [presence, setPresence] = useState<CompanionPresenceProjection>(() =>
    createInitialCompanionPresence()
  );
  const voiceEnabledRef = useRef(true);
  const [ttsConfig, setTtsConfig] = useState<CompanionTtsConfiguration | null>(() =>
    isTauriRuntime() ? null : { enabled: true, mode: "external" }
  );
  const ttsConfigRef = useRef(ttsConfig);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusState>(initialServiceStatusState);
  const [modelLifecycle, setModelLifecycle] = useState<LumiModelLifecycle>("loading");
  const [modelSelection, setModelSelection] = useState<Live2DModelSelectionProjection | null>(null);
  const rendererPresentation = useMemo(
    () => deriveCompanionRendererPresentation(modelSelection, modelLifecycle),
    [modelLifecycle, modelSelection]
  );
  const audioCapability = useMemo(() => detectBrowserAudioCapability(), []);
  const presenceProjectionRef = useRef<CompanionPresenceProjection | null>(null);
  const activeEpochRef = useRef<string | null>(null);
  const speechStoppedEpochRef = useRef<string | null>(null);
  const playbackCorrelationRef = useRef<SpeechPlaybackCorrelationState>(
    createSpeechPlaybackCorrelation()
  );
  const epochGuardRef = useRef(createCompanionPresenceEpochGuard());
  const interruptedResetRef = useRef<ReturnType<typeof createInterruptedResetScheduler> | null>(
    null
  );
  const behaviorControllerRef = useRef<BehaviorPolicyController | null>(null);
  const companionBusRef = useRef<CompanionBus | null>(null);
  const presentationChannelRef = useRef<CompanionPresentationProjectionChannel | null>(null);
  const rendererPresentationRef = useRef(rendererPresentation);
  const behaviorSessionIdRef = useRef("companion-page-session");
  /**
   * Subtitle fallback state: committed text must reach the Subtitle surface
   * even when TTS synthesis/playback fails. The speech-synced path publishes
   * on playbackStarted; these track what was already published so failure
   * fallbacks never double-publish the same segment.
   */
  const subtitleFallbackCacheRef = useRef(new Map<string, { text: string; language: string }>());
  const subtitlePublishedRef = useRef(new Set<string>());
  presenceProjectionRef.current = presence;
  ttsConfigRef.current = ttsConfig;
  rendererPresentationRef.current = rendererPresentation;

  const capabilityProjection = useMemo(
    () =>
      deriveCapabilityProjection({
        serviceStatus,
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        ttsConfiguration: ttsConfig,
        audio: audioCapability,
        live2dLifecycle: modelLifecycle
      }),
    [audioCapability, modelLifecycle, serviceStatus, ttsConfig]
  );

  function updatePresence(
    update: (current: CompanionPresenceProjection) => CompanionPresenceProjection
  ): void {
    const current = presenceProjectionRef.current ?? presence;
    const next = update(current);
    if (next === current) return;
    presenceProjectionRef.current = next;
    // Feed the same normalized transition synchronously. React state remains
    // the render/configuration surface and is not the animation clock.
    behaviorControllerRef.current?.updatePresence(next);
    lumiRef.current?.setPresentationProjection(next);
    setPresence(next);
  }

  useEffect(() => {
    const controller = createCompanionEmbodiedBehaviorController({
      sessionId: behaviorSessionIdRef.current,
      controllerId: "companion-page",
      now: () => performance.now(),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      setGazeTarget: (target) => lumiRef.current?.setGazeTarget(target)
    });
    behaviorControllerRef.current = controller;
    const syncVisibility = (): void => {
      controller.updateVisibility(
        typeof document !== "undefined" && document.visibilityState === "visible"
      );
    };
    const handleVisibilityChange = (): void => {
      syncVisibility();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    syncVisibility();
    controller.updatePresence(presenceProjectionRef.current ?? presence);

    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      controller.dispose();
      if (behaviorControllerRef.current === controller) {
        behaviorControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() && !isServiceSupervisorAvailable()) return;
    return subscribeServiceStatusState(setServiceStatus);
  }, []);

  useEffect(() => {
    const channel = new CompanionPresentationProjectionChannel();
    presentationChannelRef.current = channel;
    const unsubscribeRequests = channel.subscribeRequests(() => {
      channel.postState(rendererPresentationRef.current);
    });
    channel.postState(rendererPresentationRef.current);
    return () => {
      unsubscribeRequests();
      if (presentationChannelRef.current === channel) presentationChannelRef.current = null;
      channel.close();
    };
  }, []);

  useEffect(() => {
    presentationChannelRef.current?.postState(rendererPresentation);
  }, [rendererPresentation]);

  useEffect(() => {
    updatePresence((current) =>
      applyCapabilityProjection(current, capabilityProjection, (value, event) =>
        reduceCompanionPresence(value, event)
      )
    );
  }, [capabilityProjection]);

  useEffect(() => {
    const bus = new CompanionBus("companion");
    companionBusRef.current = bus;
    const announcer = createCompanionReadyAnnouncer(bus);
    announcerRef.current = announcer;
    announcer.start();
    void preloadTauriWindowApi();
    const speechBuffer = speechBufferRef.current;

    function recordSpeechLedger(
      requestId: string,
      sequence: number | null,
      stage: string,
      extra?: Record<string, unknown>
    ): void {
      if (!import.meta.env.DEV || typeof window === "undefined") return;
      const debugWindow = window as typeof window & {
        __yuviSpeechLedger?: Array<Record<string, unknown>>;
      };
      const ledger = (debugWindow.__yuviSpeechLedger ??= []);
      ledger.push({
        at: performance.now(),
        requestId,
        sequence,
        stage,
        ...extra
      });
      // Keep the ledger bounded for multi-turn sessions.
      if (ledger.length > 400) ledger.splice(0, ledger.length - 400);
    }

    function enqueueSpeak(
      session: NonNullable<typeof sessionRef.current>,
      segment: { sequence: number; text: string; language: string }
    ): void {
      if (!session.deduper.isNew(session.requestId, segment.sequence)) {
        recordSpeechLedger(session.requestId, segment.sequence, "dedup-drop");
        return;
      }
      recordSpeechLedger(session.requestId, segment.sequence, "queued", {
        text: segment.text,
        language: segment.language
      });
      // Cache committed text for subtitle fallback if synthesis never
      // completes (TTS service failure). Playback-synced publish remains the
      // primary path; this cache is only read on failure.
      subtitleFallbackCacheRef.current.set(`${session.requestId}:${segment.sequence}`, {
        text: segment.text,
        language: segment.language
      });
      session.queue.enqueue(
        { text: segment.text, language: segment.language },
        { requestId: session.requestId, sequence: segment.sequence }
      );
    }

    function publishSubtitleFallback(
      requestId: string,
      sequence: number,
      text: string,
      language: string
    ): void {
      const key = `${requestId}:${sequence}`;
      if (subtitlePublishedRef.current.has(key)) return;
      subtitlePublishedRef.current.add(key);
      publishSubtitleProjection({
        kind: "committed-assistant-text",
        requestId,
        messageId: `${requestId}:${sequence}`,
        text,
        language
      });
    }

    function acceptPlaybackEvent(event: SpeechPlaybackEvent): {
      accepted: boolean;
      segment: SpeechSegmentIdentity;
    } {
      const phase =
        event.type === "audioElementAttached"
          ? "attached"
          : event.type === "playbackStarted"
            ? "started"
            : event.type === "audioElementDetached"
              ? "detached"
              : "terminal";
      const result = correlateSpeechPlayback(playbackCorrelationRef.current, phase, event.segment);
      playbackCorrelationRef.current = result.state;
      return { accepted: result.accepted, segment: event.segment };
    }

    function startGeneration(requestId: string, sessionId: string): void {
      if (!epochGuardRef.current.accept(requestId)) return;
      // A new turn replaces the previous speech session: old audio stops,
      // stale presence is reset and synthesis restarts from a fresh queue.
      recordSpeechLedger(requestId, null, "turn-start");
      publishSubtitleProjection({ kind: "clear" });
      activeEpochRef.current = requestId;
      speechStoppedEpochRef.current = null;
      // New turn owns its subtitle fallback state; never replay old turns.
      subtitlePublishedRef.current.clear();
      for (const key of Array.from(subtitleFallbackCacheRef.current.keys())) {
        if (!key.startsWith(`${requestId}:`)) subtitleFallbackCacheRef.current.delete(key);
      }
      const previous = sessionRef.current;
      previous?.queue.cancel();
      sessionRef.current = null;
      playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
      speechBuffer.setActiveTurn(requestId);
      updatePresence((current) =>
        reduceCompanionPresence(current, { type: "turn-start", epoch: requestId })
      );
      if (!voiceEnabledRef.current) {
        for (const buffered of speechBuffer.drain(requestId)) {
          publishSubtitleFallback(requestId, buffered.sequence, buffered.text, buffered.language);
        }
        speechBuffer.clear();
        return;
      }
      if (ttsConfigRef.current?.enabled !== true) {
        for (const buffered of speechBuffer.drain(requestId)) {
          publishSubtitleFallback(requestId, buffered.sequence, buffered.text, buffered.language);
        }
        speechBuffer.clear();
        return;
      }
      const subtitleText = new Map<number, { text: string; language: string }>();
      const queue = new SpeechPlaybackQueue(
        (item, signal) =>
          apiClient.synthesizeSpeech({
            text: item.text,
            language: item.language,
            format: "wav",
            sessionId,
            signal
          }),
        createBrowserSpeechPlayer(),
        {
          onState: (state) => {
            const session = sessionRef.current;
            if (!session || session.queue !== queue) return;
            updatePresence((current) =>
              reduceCompanionPresence(current, {
                type: "queue",
                epoch: session.requestId,
                state
              })
            );
            bus.post({ kind: "speech-status", requestId: session.requestId, state });
          },
          onSynthesisCompleted: (pending) => {
            subtitleText.set(pending.segment.sequence, pending.item);
          },
          onItemState: (segment, state) => {
            if (state === "failed") {
              // TTS failed but committed text must still reach Subtitle.
              // Prefer the synthesized payload; fall back to the enqueued
              // committed text when synthesis never completed.
              const key = `${segment.requestId}:${segment.sequence}`;
              if (!subtitlePublishedRef.current.has(key)) {
                const synced = subtitleText.get(segment.sequence);
                const fallback = subtitleFallbackCacheRef.current.get(key);
                const payload = synced ?? fallback;
                if (payload && segment.requestId === requestId) {
                  subtitlePublishedRef.current.add(key);
                  publishSubtitleProjection({
                    kind: "committed-assistant-text",
                    requestId,
                    messageId: key,
                    ...payload
                  });
                }
              }
            }
            if (state === "cancelled" || state === "failed" || state === "completed") {
              subtitleText.delete(segment.sequence);
              subtitleFallbackCacheRef.current.delete(
                `${segment.requestId}:${segment.sequence}`
              );
            }
            recordSpeechLedger(segment.requestId, segment.sequence, state);
            if (import.meta.env.DEV) {
              const states = ((
                window as unknown as {
                  __yuviSpeechStates?: Record<string, string>;
                }
              ).__yuviSpeechStates ??= {});
              states[`${segment.requestId}:${segment.sequence}`] = state;
            }
          },
          onError: () => {
            const session = sessionRef.current;
            if (!session || session.queue !== queue) return;
            updatePresence((current) =>
              reduceCompanionPresence(current, {
                type: "queue",
                epoch: session.requestId,
                state: "error"
              })
            );
            bus.post({ kind: "speech-status", requestId: session.requestId, state: "error" });
          },
          onPlaybackEvent: (event) => {
            const session = sessionRef.current;
            if (!session || session.queue !== queue || event.segment.requestId !== requestId)
              return;
            const accepted = acceptPlaybackEvent(event);
            if (!accepted.accepted) return;
            if (event.type === "playbackStarted") {
              const subtitle = subtitleText.get(event.segment.sequence);
              if (subtitle) {
                const key = `${requestId}:${event.segment.sequence}`;
                if (!subtitlePublishedRef.current.has(key)) {
                  subtitlePublishedRef.current.add(key);
                  publishSubtitleProjection({
                    kind: "committed-assistant-text",
                    requestId,
                    messageId: key,
                    ...subtitle
                  });
                }
              }
              recordSpeechLedger(requestId, event.segment.sequence, "audio.play", {
                queueSequence: event.sequence
              });
            }
            const playbackState =
              event.type === "playbackStarted"
                ? "started"
                : event.type === "playbackEnded"
                  ? "ended"
                  : event.type === "playbackStopped"
                    ? "stopped"
                    : event.type === "playbackError"
                      ? "error"
                      : null;
            if (playbackState !== null && playbackState !== "started")
              publishSubtitleProjection({ kind: "clear" });
            if (playbackState !== null) {
              updatePresence((current) =>
                reduceCompanionPresence(current, {
                  type: "playback",
                  epoch: requestId,
                  state: playbackState
                })
              );
              bus.post({
                kind: "playback-status",
                requestId,
                segmentSequence: event.segment.sequence,
                state: playbackState
              });
            }
            lumiRef.current?.handlePlaybackEvent(event);
          }
        }
      );
      const session = { requestId, queue, deduper: createSpeechSegmentDeduper() };
      sessionRef.current = session;

      // Flush any segments that arrived before the session existed. Buffer is
      // scoped to the active turn only — never replays old turns.
      for (const buffered of speechBuffer.drain(requestId)) {
        recordSpeechLedger(requestId, buffered.sequence, "pre-ready-flush");
        enqueueSpeak(session, buffered);
      }
    }

    function handleSpeak(message: Extract<CompanionBusMessage, { kind: "speak" }>): void {
      if (
        activeEpochRef.current !== message.requestId ||
        speechStoppedEpochRef.current === message.requestId
      ) {
        recordSpeechLedger(message.requestId, message.sequence, "stale-speak-drop");
        return;
      }
      if (!voiceEnabledRef.current) {
        recordSpeechLedger(message.requestId, message.sequence, "voice-disabled-drop");
        // Committed text still belongs on the Subtitle surface when audio is
        // disabled; speech sync simply has no playback to align to.
        publishSubtitleFallback(message.requestId, message.sequence, message.text, message.language);
        return;
      }
      if (ttsConfigRef.current?.enabled !== true) {
        recordSpeechLedger(message.requestId, message.sequence, "tts-disabled-drop");
        publishSubtitleFallback(message.requestId, message.sequence, message.text, message.language);
        return;
      }
      recordSpeechLedger(message.requestId, message.sequence, "companion-receive", {
        text: message.text,
        language: message.language
      });
      const session = sessionRef.current;
      if (session && session.requestId === message.requestId) {
        enqueueSpeak(session, message);
        return;
      }
      // Session not ready yet: keep a bounded pre-ready buffer for this turn.
      // Do not silently discard sequence 0 while start-generation is in flight.
      const accepted = speechBuffer.push({
        requestId: message.requestId,
        sequence: message.sequence,
        text: message.text,
        language: message.language
      });
      recordSpeechLedger(
        message.requestId,
        message.sequence,
        accepted ? "pre-ready-buffer" : "buffer-reject"
      );
    }

    function handleMessage(message: CompanionBusMessage): void {
      switch (message.kind) {
        case "user-gesture":
          updatePresence((current) =>
            reduceCompanionPresence(current, { type: "interaction", state: "listening" })
          );
          lumiRef.current?.resumeAudio();
          return;
        case "start-generation":
          startGeneration(message.requestId, message.sessionId);
          return;
        case "voice-enabled":
          // Preference sync must never cancel an in-flight turn. Only an
          // explicit disable stops speech; enable is a no-op for the queue.
          announcerRef.current?.markSynced();
          voiceEnabledRef.current = message.enabled;
          recordSpeechLedger("sync", null, "voice-enabled", { enabled: message.enabled });
          if (!message.enabled) {
            publishSubtitleProjection({ kind: "clear" });
            const session = sessionRef.current;
            const epoch = activeEpochRef.current;
            if (epoch) {
              speechStoppedEpochRef.current = epoch;
              updatePresence((current) =>
                reduceCompanionPresence(current, { type: "speech-cancelled", epoch })
              );
            }
            if (session) session.queue.cancel();
            sessionRef.current = null;
            playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
            speechBuffer.clear();
          }
          return;
        case "tts-config":
          // This is configuration intent from MainPage, not service health.
          // A disabled persistent setting suppresses future synthesis but does
          // not cancel already-playing local audio.
          ttsConfigRef.current = message.config;
          setTtsConfig(message.config);
          return;
        case "speak":
          handleSpeak(message);
          return;
        case "speech-end": {
          const session = sessionRef.current;
          if (
            session &&
            session.requestId === message.requestId &&
            speechStoppedEpochRef.current !== message.requestId
          ) {
            session.queue.finish();
          }
          return;
        }
        case "stop-speech": {
          if (activeEpochRef.current !== message.requestId) return;
          const session = sessionRef.current;
          publishSubtitleProjection({ kind: "clear" });
          speechStoppedEpochRef.current = message.requestId;
          updatePresence((current) =>
            reduceCompanionPresence(current, {
              type: "speech-cancelled",
              epoch: message.requestId
            })
          );
          if (session && session.requestId === message.requestId) {
            session.queue.cancel();
          }
          sessionRef.current = null;
          playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
          speechBuffer.clear();
          recordSpeechLedger(message.requestId, null, "stop-speech");
          return;
        }
        case "generation-state":
          if (activeEpochRef.current !== message.requestId) return;
          if (
            message.state === "interrupted" &&
            !canInterruptGeneration(presenceProjectionRef.current ?? presence, message.requestId)
          ) {
            return;
          }
          updatePresence((current) =>
            reduceCompanionPresence(current, {
              type: "generation",
              epoch: message.requestId,
              state: message.state
            })
          );
          if (message.state === "interrupted") {
            publishSubtitleProjection({ kind: "clear" });
            speechStoppedEpochRef.current = message.requestId;
            sessionRef.current?.queue.cancel();
            sessionRef.current = null;
            playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
            speechBuffer.clear();
          }
          return;
        case "companion-ready":
        case "playback-status":
        case "speech-status":
        case "proactive-text-admission-result":
          return;
        case "embodied-presentation-request": {
          const report = lumiRef.current?.executeEmbodiedPresentationRequest(message.request);
          if (report) {
            submitPresentationOutcome(report);
          }
          return;
        }
        case "embodied-presentation-outcome":
          return;
      }
    }

    const unsubscribe = bus.subscribe(handleMessage);
    return () => {
      unsubscribe();
      publishSubtitleProjection({ kind: "clear" });
      announcer.stop();
      announcerRef.current = null;
      sessionRef.current?.queue.cancel();
      sessionRef.current = null;
      playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
      activeEpochRef.current = null;
      speechStoppedEpochRef.current = null;
      epochGuardRef.current.dispose();
      speechBuffer.clear();
      if (companionBusRef.current === bus) {
        companionBusRef.current = null;
      }
      bus.close();
    };
  }, []);

  useEffect(() => {
    // Own the interrupted timer in this effect so React StrictMode remounts
    // get a live scheduler instead of a permanently disposed ref instance.
    const resetScheduler = createInterruptedResetScheduler(() => {
      updatePresence((current) =>
        current.epoch
          ? reduceCompanionPresence(current, {
              type: "transition-expired",
              epoch: current.epoch
            })
          : current
      );
    });
    interruptedResetRef.current = resetScheduler;
    return () => {
      resetScheduler.dispose();
      if (interruptedResetRef.current === resetScheduler) {
        interruptedResetRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (presence.transition === "interrupted" && presence.epoch) {
      interruptedResetRef.current?.schedule();
    } else {
      interruptedResetRef.current?.invalidate();
    }
  }, [presence.transition, presence.epoch]);

  const tauri = isTauriRuntime();

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-transparent text-white touch-none select-none"
      onPointerDown={(event) => {
        if (!tauri || event.button !== 0) return;
        const target = event.target as HTMLElement;
        if (target.closest?.("button, [data-yuvi-resize-handle]")) return;
        // Require movement before the native drag grab so simple clicks never
        // leave an XWayland pointer grab active (fullscreen was the recovery).
        const startX = event.clientX;
        const startY = event.clientY;
        trackWindowDragGesture(startX, startY, () => {
          void startWindowDragging();
        });
      }}
    >
      <LumiCanvas
        ref={lumiRef}
        requestedProjection={presence}
        onModelLifecycle={setModelLifecycle}
        onModelSelection={setModelSelection}
        onPresentationOutcome={submitPresentationOutcome}
        className="relative h-full w-full min-w-0 overflow-hidden rounded-none"
        presentationOnly
        showFramingToggle
      />
      {tauri && (
        <button
          type="button"
          data-yuvi-resize-handle
          aria-label={t("Resize window")}
          className="absolute bottom-0 right-0 z-20 flex h-6 w-6 cursor-se-resize items-end justify-end p-0.5 text-white/70 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void startWindowResizeDragging("SouthEast");
          }}
        >
          <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" aria-hidden="true">
            <path
              d="M11 1v10H1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
