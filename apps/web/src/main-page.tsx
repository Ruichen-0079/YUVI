import { useConversationSession, useConversationHistory } from "./use-conversation-history.js";
import { t } from "./locale.js";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ApiError,
  apiClient,
  type MessageStreamEvent,
  type ProactiveMessageStreamEvent,
  type TranscriptionResponse
} from "./api/client.js";
import {
  releaseMicrophoneCapture,
  startMicrophoneCapture,
  stopMicrophoneCapture,
  type ActiveAudioCapture,
  type RecordedAudio
} from "./audio-capture.js";
import {
  startLiveSpeechCapture,
  type LiveSpeechCapture,
  type MicrophoneTrackSettings
} from "./live-speech-capture.js";
import {
  createHandsFreeUtteranceBuffer,
  type HandsFreeUtteranceBuffer
} from "./hands-free-utterance.js";
import { encodePcm16Wav, wavBlobToBase64 } from "./pcm-wav.js";
import {
  beginControlledDraftSubmit,
  reduceChatMessages,
  shouldSubmitChatKey,
  type ChatMessage
} from "./chat-state.js";
import { ChatMessageContent } from "./markdown-message.js";
import { detectSpeechLanguage, type SpeechQueueState } from "./speech-queue.js";
import { SpeechSegmenter } from "./speech-segmenter.js";
import {
  createSpeechPipelineFeedback,
  reduceSpeechPipelineFeedback,
  type SpeechPipelineFeedback
} from "./speech-pipeline-feedback.js";
import {
  CompanionBus,
  type CompanionBusMessage,
  type CompanionPlaybackState,
  type CompanionTtsConfiguration
} from "./companion-bus.js";
import { forwardEmbodiedPresentationRequest } from "./embodied-presentation-bus-forward.js";
import { useDashboardEventStream } from "./hooks/useDashboardEventStream.js";
import { deriveCapabilityProjection, deriveEffectiveVoiceOutput } from "./capability-projection.js";
import {
  correlateSpeechPlayback,
  createSpeechPlaybackCorrelation,
  retireActiveSpeechPlayback,
  type SpeechPlaybackCorrelationState
} from "./speech-playback-correlation.js";
import type { SpeechSegmentIdentity } from "./speech-identity.js";
import { isTauriRuntime } from "./tauri-window.js";
import {
  readVisionImageAttachment,
  type VisionImageAttachmentDraft
} from "./vision-input.js";
import { fetchUserSettings, subscribeUserSettingsChanged } from "./user-settings-client.js";
import { initialServiceStatusState, type ServiceStatusState } from "./service-status-state.js";
import {
  isServiceSupervisorAvailable,
  subscribeServiceStatusState
} from "./service-supervisor-client.js";
import {
  createInitialProactiveConsentState,
  reduceProactiveConsent,
  type ProactiveConsentAction
} from "./proactive-consent.js";
import { admissionFromRuntimeError, RUNTIME_ADMITTED } from "./proactive-turn-admission.js";
import {
  createProactiveTurnExecution,
  isCurrentProactiveEffect,
  isCurrentRequest,
  preemptProactiveRequest,
  type ActiveRequestOwnership,
  type ProactiveTurnEffect
} from "./proactive-turn-execution.js";

type RequestStatus = "idle" | "sending" | "success" | "error";
type VoicePlaybackStatus = SpeechQueueState;
type VoiceCaptureStatus = "idle" | "requesting" | "recording" | "stopping" | "transcribing";
type LiveSpeechStatus = "idle" | "requesting" | "listening";

let surfaceSequence = 0;

function createSurfaceId(prefix: string): string {
  surfaceSequence += 1;
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? surfaceSequence}`;
}

/**
 * Desktop main window surface: chat input and the streaming text reply.
 * Speech segments are forwarded to the companion window over CompanionBus;
 * this surface never owns audio playback, Live2D rendering, or the analyser chain.
 */

export function MainPage(): JSX.Element {
  const [sessionId, setSessionId] = useConversationSession("default");
  const [readMemory, setReadMemory] = useState(true);
  const [writeMemory, setWriteMemory] = useState(true);
  const [memoryPreferenceState, setMemoryPreferenceState] = useState<"loading" | "ready" | "unavailable">(
    () => (isTauriRuntime() ? "loading" : "ready")
  );
  const [promptPreview, setPromptPreview] = useState(true);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusState>(initialServiceStatusState);
  const [ttsConfig, setTtsConfig] = useState<CompanionTtsConfiguration | null>(() =>
    isTauriRuntime() ? null : { enabled: true, mode: "external" }
  );
  const [proactiveConsent, dispatchProactiveConsent] = useReducer(
    reduceProactiveConsent,
    undefined,
    createInitialProactiveConsentState
  );
  const [messages, dispatchMessages] = useReducer(reduceChatMessages, [] as ChatMessage[]);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const historyError = useConversationHistory(sessionId, requestStatus === "sending", dispatchMessages);
  const [voicePlaybackStatus, setVoicePlaybackStatus] = useState<VoicePlaybackStatus>("idle");
  const [actualPlaybackActive, setActualPlaybackActive] = useState(false);
  const [input, setInput] = useState("");
  const [imageAttachment, setImageAttachment] = useState<VisionImageAttachmentDraft | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [voiceCaptureStatus, setVoiceCaptureStatus] = useState<VoiceCaptureStatus>("idle");
  const [recordedAudio, setRecordedAudio] = useState<RecordedAudio | null>(null);
  const [voiceTranscription, setVoiceTranscription] = useState<TranscriptionResponse | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [liveSpeechStatus, setLiveSpeechStatus] = useState<LiveSpeechStatus>("idle");
  const [liveSpeechActive, setLiveSpeechActive] = useState(false);

  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const busRef = useRef<CompanionBus | null>(null);
  // Product Main must subscribe to Runtime Presentation requests and forward them
  // to Companion over CompanionBus (Debug App already does this). Fail-closed.
  useDashboardEventStream({
    paused: false,
    onEvent: (event) => {
      forwardEmbodiedPresentationRequest(event, (message) => {
        busRef.current?.post(message);
      });
    }
  });
  const ttsConfigRef = useRef(ttsConfig);
  const ttsConfigRevisionRef = useRef(-1);
  const memoryPreferenceRevisionRef = useRef(-1);
  const proactiveConsentRef = useRef(proactiveConsent);
  const runtimeContextRef = useRef({ sessionId, readMemory, promptPreview });
  runtimeContextRef.current = { sessionId, readMemory, promptPreview };
  const proactiveExecutionRef = useRef<ReturnType<typeof createProactiveTurnExecution> | null>(
    null
  );
  if (proactiveExecutionRef.current === null) {
    proactiveExecutionRef.current = createProactiveTurnExecution({
      createRequestId: () => createSurfaceId("proactive-turn"),
      createAssistantId: () => createSurfaceId("proactive-assistant")
    });
  }
  const speechSessionRef = useRef<{
    language?: string;
    generation: string;
    segmenter: SpeechSegmenter;
    sequence: number;
    ended: boolean;
    feedback: SpeechPipelineFeedback;
  } | null>(null);
  const speechEpochRef = useRef<string | null>(null);
  const playbackCorrelationRef = useRef<SpeechPlaybackCorrelationState>(
    createSpeechPlaybackCorrelation()
  );
  const activeRequestRef = useRef<ActiveRequestOwnership | null>(null);
  const audioCaptureRef = useRef<ActiveAudioCapture | null>(null);
  const liveSpeechCaptureRef = useRef<LiveSpeechCapture | null>(null);
  const handsFreeBufferRef = useRef<HandsFreeUtteranceBuffer | null>(null);
  const speechPlaybackByRequestRef = useRef(new Map<string, string>());
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const [micTrackSettings, setMicTrackSettings] = useState<MicrophoneTrackSettings | null>(null);

  const capabilityProjection = useMemo(
    () =>
      deriveCapabilityProjection({
        serviceStatus,
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        ttsConfiguration: ttsConfig,
        audio: "unknown",
        live2dLifecycle: "loading"
      }),
    [serviceStatus, ttsConfig]
  );
  const effectiveVoiceOutput = useMemo(
    () =>
      deriveEffectiveVoiceOutput({
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        // Main has no hidden per-turn TTS preference after A5. The durable
        // Product TTS setting is the user-facing authority.
        perTurnVoiceOutput: true,
        ttsCapability: capabilityProjection.capabilities.tts,
        ttsConfiguration: ttsConfig
      }),
    [capabilityProjection.capabilities.tts, ttsConfig?.enabled, ttsConfig?.mode]
  );
  const effectiveVoiceOutputRef = useRef(effectiveVoiceOutput);
  ttsConfigRef.current = ttsConfig;
  effectiveVoiceOutputRef.current = effectiveVoiceOutput;

  useEffect(() => {
    const end = threadEndRef.current;
    if (end && typeof end.scrollIntoView === "function") {
      end.scrollIntoView({ block: "end" });
    }
  }, [messages]);

  useEffect(() => {
    if (!isTauriRuntime() && !isServiceSupervisorAvailable()) return;
    return subscribeServiceStatusState(setServiceStatus);
  }, []);

  const applyProactiveConsent = useCallback((action: ProactiveConsentAction): boolean => {
    const current = proactiveConsentRef.current;
    const next = reduceProactiveConsent(current, action);
    if (next === current) return false;
    proactiveConsentRef.current = next;
    dispatchProactiveConsent(action);
    return true;
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const initialRequestRevision = proactiveConsentRef.current.revisionFloor;

    const applySettingsView = (
      view: Awaited<ReturnType<typeof fetchUserSettings>>,
      requestRevision: number
    ): void => {
      if (cancelled) return;

      // TTS is a live projection consumed by Main/Companion. Settings now live
      // in WebUI, so Main must converge through the settings.changed event
      // instead of relying on an inline settings-panel callback.
      if (view.revision >= ttsConfigRevisionRef.current) {
        const settings: CompanionTtsConfiguration = {
          enabled: view.settings.tts.enabled,
          mode: view.settings.tts.mode
        };
        ttsConfigRevisionRef.current = view.revision;
        ttsConfigRef.current = settings;
        setTtsConfig(settings);
      }

      // Main no longer exposes per-turn Memory switches. Follow the existing
      // durable Product setting instead of inventing a hidden replacement mode.
      // Fence stale async reads exactly like the existing TTS projection.
      if (view.revision >= memoryPreferenceRevisionRef.current) {
        memoryPreferenceRevisionRef.current = view.revision;
        setReadMemory(view.settings.memory.enabled);
        setWriteMemory(view.settings.memory.enabled);
        setMemoryPreferenceState(view.loadError === null ? "ready" : "unavailable");
      }

      if (view.loadError !== null) {
        applyProactiveConsent({
          type: "settings-read-failed",
          requestRevision: Math.max(requestRevision, view.revision)
        });
        void apiClient.setProactiveConsent(false).catch(() => undefined);
      } else {
        applyProactiveConsent({
          type: "settings-view",
          revision: view.revision,
          enabled: view.settings.proactive.enabled
        });
        void apiClient.setProactiveConsent(view.settings.proactive.enabled).catch(() => undefined);
      }
    };

    const refetchSettingsProjection = (requestRevision: number): void => {
      void fetchUserSettings()
        .then((view) => applySettingsView(view, requestRevision))
        .catch(() => {
          if (!cancelled) {
            setMemoryPreferenceState((current) =>
              current === "loading" ? "unavailable" : current
            );
            applyProactiveConsent({ type: "settings-read-failed", requestRevision });
            void apiClient.setProactiveConsent(false).catch(() => undefined);
          }
        });
    };

    void fetchUserSettings()
      .then((view) => applySettingsView(view, initialRequestRevision))
      .catch(() => {
        if (!cancelled) {
          setMemoryPreferenceState("unavailable");
          // Keep the existing TTS capability unknown and keep proactive consent denied.
          applyProactiveConsent({
            type: "settings-read-failed",
            requestRevision: initialRequestRevision
          });
          void apiClient.setProactiveConsent(false).catch(() => undefined);
        }
      });

    const unsubscribe = subscribeUserSettingsChanged((event) => {
      if (cancelled) return;
      const invalidated = applyProactiveConsent({
        type: "settings-changed",
        revision: event.revision,
        changedSections: event.changedSections
      });
      if (invalidated) {
        void apiClient.setProactiveConsent(false).catch(() => undefined);
      }
      if (event.changedSections.includes("memory")) {
        memoryPreferenceRevisionRef.current = Math.max(
          memoryPreferenceRevisionRef.current,
          event.revision
        );
        setMemoryPreferenceState("loading");
      }
      if (
        invalidated ||
        event.changedSections.includes("tts") ||
        event.changedSections.includes("memory")
      ) {
        refetchSettingsProjection(event.revision);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyProactiveConsent]);

  useEffect(() => {
    mountedRef.current = true;
    const bus = new CompanionBus("main");
    busRef.current = bus;
    const handleProactiveTextRequest = (
      message: Extract<CompanionBusMessage, { kind: "proactive-text-request" }>
    ): void => {
      bus.post({
        kind: "proactive-text-admission-result",
        decisionId: message.decisionId,
        decision: "denied",
        reason: "not-eligible"
      });
    };
    const unsubscribe = bus.subscribe((message: CompanionBusMessage) => {
      if (!mountedRef.current) return;
      if (message.kind === "companion-ready") {
        // A companion window may have been recreated; re-sync the active
        // voice channel so TTS state converges without a reload.
        bus.post({ kind: "voice-enabled", enabled: true });
        bus.post({ kind: "tts-config", config: ttsConfigRef.current });
      } else if (message.kind === "speech-status") {
        if (speechEpochRef.current !== message.requestId) return;
        const session = speechSessionRef.current;
        if (session && session.generation === message.requestId) {
          session.feedback = reduceSpeechPipelineFeedback(session.feedback, {
            type: "queue-state",
            state: message.state
          });
        }
        setVoicePlaybackStatus(message.state);
        if (message.state === "idle" || message.state === "stopped") {
          speechEpochRef.current = null;
          reportPlaybackTerminal(
            message.requestId,
            message.state === "stopped" ? "INTERRUPTED" : "COMPLETED"
          );
        }
      } else if (message.kind === "playback-status") {
        if (speechEpochRef.current !== message.requestId) return;
        const segment: SpeechSegmentIdentity = {
          requestId: message.requestId,
          sequence: message.segmentSequence
        };
        const result = correlateMainPlaybackStatus(
          playbackCorrelationRef.current,
          message.state === "started" ? "started" : "terminal",
          segment
        );
        playbackCorrelationRef.current = result.state;
        if (!result.accepted) return;
        if (message.state === "ended") {
          const session = speechSessionRef.current;
          if (session && session.generation === message.requestId) {
            session.feedback = reduceSpeechPipelineFeedback(session.feedback, {
              type: "playback-ended"
            });
          }
        }
        applyPlaybackStatus(message.state, setVoicePlaybackStatus, setActualPlaybackActive);
        if (message.state === "started") {
          reportPlaybackOutcome(message.requestId, "STARTED");
        } else if (message.state === "stopped") {
          reportPlaybackTerminal(message.requestId, "INTERRUPTED");
        } else if (message.state === "error") {
          reportPlaybackTerminal(message.requestId, "FAILED");
        }
      } else if (message.kind === "proactive-text-request") {
        handleProactiveTextRequest(message);
      }
    });
    // Main no longer owns a hidden per-turn TTS preference. Keep the
    // Companion voice channel enabled; persistent tts.enabled remains authoritative.
    bus.post({ kind: "voice-enabled", enabled: true });
    bus.post({ kind: "tts-config", config: ttsConfigRef.current });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      bus.close();
      busRef.current = null;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      speechSessionRef.current = null;
      speechEpochRef.current = null;
      releaseMicrophoneCapture(audioCaptureRef.current);
      audioCaptureRef.current = null;
      const live = liveSpeechCaptureRef.current;
      liveSpeechCaptureRef.current = null;
      void live?.stop();
      playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let assistantId: string | null = null;
    void apiClient
      .subscribeProactiveLive(sessionId, {
        signal: controller.signal,
        onEvent: (event: ProactiveMessageStreamEvent) => {
          if (!mountedRef.current) return;
          if (event.type === "proactive-decision") {
            if (event.decision === "NO_OP") assistantId = null;
            return;
          }
          if (event.type === "text-delta") {
            if (assistantId === null) {
              assistantId = createSurfaceId("proactive-assistant");
              dispatchMessages({
                type: "append-assistant",
                assistant: {
                  id: assistantId,
                  requestId: event.traceId,
                  role: "assistant",
                  content: event.text,
                  status: "streaming",
                  traceId: event.traceId
                }
              });
            } else {
              dispatchMessages({
                type: "append-delta",
                assistantId,
                text: event.text,
                traceId: event.traceId
              });
            }
            return;
          }
          if (event.type === "error") {
            if (assistantId) {
              dispatchMessages({ type: "fail", assistantId, error: event.message });
            }
            return;
          }
          if (assistantId) {
            dispatchMessages({
              type: "complete",
              assistantId,
              content: event.content,
              traceId: event.traceId,
              provider: event.provider
            });
            assistantId = null;
          }
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    busRef.current?.post({ kind: "tts-config", config: ttsConfig });
  }, [ttsConfig]);

  function cancelActiveProactiveRequest(active: ActiveRequestOwnership): void {
    if (!isCurrentRequest(activeRequestRef.current, active)) return;
    // Clear the page owner before aborting so the rejected promise and any
    // late stream event cannot touch the user request that follows.
    activeRequestRef.current = null;
    preemptProactiveRequest(active);
    dispatchMessages({
      type: "cancel",
      assistantId: active.assistantId,
      error: "生成已取消，以上内容可能不完整。"
    });
    setRequestStatus("idle");
  }

  async function send(): Promise<void> {
    if (memoryPreferenceState !== "ready") return;
    // Capture the exact draft once, then clear the controlled state immediately
    // so async work never re-reads or restores the textarea contents.
    const submit = beginControlledDraftSubmit(input);
    if (submit === null) return;
    const active = activeRequestRef.current;
    if (active?.origin === "user") return;
    if (active?.origin === "proactive") {
      cancelActiveProactiveRequest(active);
    }
    const content = submit.submittedText;
    const submittedAttachment = imageAttachment;
    setInput(submit.nextDraft);
    setImageAttachment(null);
    setAttachmentError(null);
    if (imageInputRef.current) imageInputRef.current.value = "";
    setError(null);
    if (inputRef.current) {
      inputRef.current.style.height = "";
      inputRef.current.focus();
    }
    const requestId = createSurfaceId("turn");
    const assistantId = createSurfaceId("assistant");
    const controller = new AbortController();
    const ownership: ActiveRequestOwnership = {
      id: requestId,
      assistantId,
      controller,
      completedObserved: false,
      origin: "user"
    };
    activeRequestRef.current = ownership;
    const shouldRequestTts = effectiveVoiceOutputRef.current.requestTts;
    speechEpochRef.current = shouldRequestTts ? requestId : null;
    playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
    setActualPlaybackActive(false);
    setRequestStatus("sending");
    const bus = busRef.current;
    bus?.post({ kind: "user-gesture" });
    bus?.post({ kind: "voice-enabled", enabled: true });
    bus?.post({ kind: "start-generation", requestId, sessionId });
    const feedback = createSpeechPipelineFeedback();
    const segmenter = new SpeechSegmenter({
      pipeline: () => {
        const session = speechSessionRef.current;
        return session?.generation === requestId ? session.feedback : undefined;
      }
    });
    // Speech segmentation doubles as the committed subtitle feed: always keep
    // a session so speak segments reach Companion even when TTS audio is off.
    // Only the playback admission remains TTS-gated.
    speechSessionRef.current = {
      generation: requestId,
      segmenter,
      sequence: 0,
      ended: false,
      feedback
    };
    if (shouldRequestTts) {
      void apiClient
        .admitSpeechPlayback({ sessionId, requestId })
        .then((effect) => {
          speechPlaybackByRequestRef.current.set(requestId, effect.effectId);
        })
        .catch(() => undefined);
    }
    dispatchMessages({
      type: "append-turn",
      user: {
        id: createSurfaceId("user"),
        requestId,
        role: "user",
        content,
        useMemory: readMemory && writeMemory,
        readMemory,
        writeMemory,
        voiceOutput: shouldRequestTts,
        ...(submittedAttachment
          ? {
              imageAttachment: {
                name: submittedAttachment.name,
                dataUrl: submittedAttachment.dataUrl
              }
            }
          : {}),
        status: "completed"
      },
      assistant: {
        id: assistantId,
        requestId,
        role: "assistant",
        content: "",
        status: "streaming"
      }
    });

    try {
      const response = await apiClient.streamMessage(
        {
          sessionId,
          text: content,
          ...(submittedAttachment
            ? {
                imageAttachment: {
                  imageBase64: submittedAttachment.imageBase64,
                  mimeType: submittedAttachment.mimeType
                }
              }
            : {}),
          options: {
            readMemory,
            writeMemory,
            // The companion window owns sentence-level TTS for this path;
            // avoid asking Runtime to synthesize the full reply a second time.
            voiceOutput: false,
            promptPreview
          }
        },
        {
          signal: controller.signal,
          onEvent: (event: MessageStreamEvent) => {
            if (!mountedRef.current || !isCurrentRequest(activeRequestRef.current, ownership)) {
              return;
            }
            if ("traceId" in event) dispatchMessages({ type: "bind-trace", assistantId, traceId: event.traceId });
            if (event.type === "text-delta") {
              dispatchMessages({
                type: "append-delta",
                assistantId,
                text: event.text,
                traceId: event.traceId
              });
              forwardSpeechSegments(requestId, event.text, event.language);
              return;
            }
            if (event.type === "error") {
              dispatchMessages({ type: "fail", assistantId, error: event.message });
              setError(event.message);
              forwardSpeechEnd(requestId, "failed");
              return;
            }
            ownership.completedObserved = true;
            dispatchMessages({
              type: "complete",
              assistantId,
              content: event.content,
              traceId: event.traceId,
              provider: event.provider
            });
            setRequestStatus("success");
            forwardSpeechEnd(requestId, "completed");
          }
        }
      );

      if (!mountedRef.current || !isCurrentRequest(activeRequestRef.current, ownership)) {
        return;
      }
      ownership.completedObserved = true;
      dispatchMessages({
        type: "complete",
        assistantId,
        content: response.content,
        traceId: response.traceId,
        provider: response.provider
      });
      setRequestStatus("success");
      forwardSpeechEnd(requestId, "completed");
    } catch (caught) {
      if (!mountedRef.current || !isCurrentRequest(activeRequestRef.current, ownership)) {
        return;
      }
      if (controller.signal.aborted) {
        const speech = speechSessionRef.current;
        if (speech?.generation === requestId) {
          speech.segmenter.reset();
        }
        dispatchMessages({
          type: "cancel",
          assistantId,
          error: "生成已取消，以上内容可能不完整。"
        });
        setRequestStatus("idle");
        return;
      }
      const message = friendlyChatError(caught);
      forwardSpeechEnd(requestId, "failed");
      dispatchMessages({ type: "fail", assistantId, error: message });
      setError(message);
      setRequestStatus("error");
    } finally {
      if (isCurrentRequest(activeRequestRef.current, ownership)) {
        activeRequestRef.current = null;
        bus?.post({ kind: "generation-state", requestId, state: "idle" });
      }
      if (speechSessionRef.current?.generation === requestId) {
        speechSessionRef.current = null;
      }
    }
  }

  async function executeProactiveTurn(effect: ProactiveTurnEffect): Promise<void> {
    const isCurrent = (): boolean =>
      mountedRef.current && isCurrentProactiveEffect(activeRequestRef.current, effect);
    let assistantProjected = false;

    try {
      const response = await apiClient.streamProactiveTurn(effect.request, {
        signal: effect.ownership.controller.signal,
        onEvent: (event: ProactiveMessageStreamEvent) => {
          if (!isCurrent()) return;
          if (event.type === "proactive-decision") {
            busRef.current?.post({
              kind: "proactive-text-admission-result",
              decisionId: effect.decisionId,
              ...RUNTIME_ADMITTED
            });
            if (event.decision === "NO_OP") {
              effect.ownership.completedObserved = true;
              setRequestStatus("idle");
            }
            return;
          }
          if (event.type === "text-delta") {
            if (!assistantProjected) {
              assistantProjected = true;
              dispatchMessages({
                type: "append-assistant",
                assistant: {
                  id: effect.assistantId,
                  requestId: effect.requestId,
                  role: "assistant",
                  content: event.text,
                  status: "streaming",
                  traceId: event.traceId
                }
              });
            } else {
              dispatchMessages({
                type: "append-delta",
                assistantId: effect.assistantId,
                text: event.text,
                traceId: event.traceId
              });
            }
            return;
          }
          if (event.type === "error") {
            dispatchMessages({
              type: "fail",
              assistantId: effect.assistantId,
              error: event.message
            });
            setError(event.message);
            return;
          }
          effect.ownership.completedObserved = true;
          dispatchMessages({
            type: "complete",
            assistantId: effect.assistantId,
            content: event.content,
            traceId: event.traceId,
            provider: event.provider
          });
          setRequestStatus("success");
        }
      });

      if (!isCurrent()) return;
      if (response.type === "proactive-decision") {
        effect.ownership.completedObserved = true;
        setRequestStatus("idle");
        return;
      }
      effect.ownership.completedObserved = true;
      dispatchMessages({
        type: "complete",
        assistantId: effect.assistantId,
        content: response.content,
        traceId: response.traceId,
        provider: response.provider
      });
      setRequestStatus("success");
    } catch (caught) {
      if (!isCurrent()) return;
      if (effect.ownership.controller.signal.aborted) {
        dispatchMessages({
          type: "cancel",
          assistantId: effect.assistantId,
          error: "生成已取消，以上内容可能不完整。"
        });
        setRequestStatus("idle");
        return;
      }
      const admission = admissionFromRuntimeError(caught);
      if (admission) {
        busRef.current?.post({
          kind: "proactive-text-admission-result",
          decisionId: effect.decisionId,
          ...admission
        });
        effect.ownership.completedObserved = true;
        setRequestStatus("idle");
        return;
      }
      const message = friendlyChatError(caught);
      dispatchMessages({ type: "fail", assistantId: effect.assistantId, error: message });
      setError(message);
      setRequestStatus("error");
    } finally {
      if (isCurrent()) {
        activeRequestRef.current = null;
      }
    }
  }

  function forwardSpeechSegments(requestId: string, text: string, language?: string): void {
    const speech = speechSessionRef.current;
    const bus = busRef.current;
    // Speak segments are the single committed-text feed for Companion speech
    // and Subtitle presentation. Always forward; Companion decides whether to
    // queue audio or publish subtitles immediately when TTS is off.
    if (!speech || speech.generation !== requestId || !bus) {
      return;
    }
    if (language) speech.language = language;
    for (const segment of speech.segmenter.push(text)) {
      bus.post({
        kind: "speak",
        requestId,
        sequence: speech.sequence++,
        text: segment,
        language: speech.language ?? detectSpeechLanguage(segment)
      });
    }
  }

  function forwardSpeechEnd(requestId: string, reason: "completed" | "failed"): void {
    const speech = speechSessionRef.current;
    const bus = busRef.current;
    if (!speech || speech.generation !== requestId || !bus) return;
    if (speech.ended) return;
    speech.ended = true;
    // Always flush committed segments for Subtitle even when TTS audio is
    // off; Companion suppresses audio queuing in that case but still
    // publishes subtitle fallbacks.
    for (const segment of speech.segmenter.flush(reason)) {
      bus.post({
        kind: "speak",
        requestId,
        sequence: speech.sequence++,
        text: segment,
        language: speech.language ?? detectSpeechLanguage(segment)
      });
    }
    bus.post({ kind: "speech-end", requestId });
  }

  function stopGeneration(): void {
    const active = activeRequestRef.current;
    if (!active) return;
    if (active.origin === "proactive") {
      cancelActiveProactiveRequest(active);
      return;
    }
    if (active.completedObserved) return;
    busRef.current?.post({ kind: "stop-speech", requestId: active.id });
    busRef.current?.post({
      kind: "generation-state",
      requestId: active.id,
      state: "interrupted"
    });
    active.controller.abort();
    activeRequestRef.current = null;
    speechSessionRef.current = null;
    dispatchMessages({
      type: "cancel",
      assistantId: active.assistantId,
      error: "生成已取消，以上内容可能不完整。"
    });
    setRequestStatus("idle");
    setVoicePlaybackStatus("idle");
  }

  function stopSpeech(): void {
    const requestId = resolveSpeechCommandEpoch(
      speechEpochRef.current,
      activeRequestRef.current?.id ?? null
    );
    if (requestId === null) return;
    busRef.current?.post({ kind: "stop-speech", requestId });
    setVoicePlaybackStatus("stopped");
    setActualPlaybackActive(false);
    playbackCorrelationRef.current = retireActiveSpeechPlayback(playbackCorrelationRef.current);
    reportPlaybackTerminal(requestId, "INTERRUPTED");
  }

  function reportPlaybackOutcome(
    requestId: string,
    outcome: "STARTED" | "COMPLETED" | "FAILED" | "INTERRUPTED"
  ): void {
    const effectId = speechPlaybackByRequestRef.current.get(requestId);
    if (!effectId) return;
    void apiClient.reportSpeechPlaybackOutcome({ effectId, outcome }).catch(() => undefined);
  }

  function reportPlaybackTerminal(
    requestId: string,
    outcome: "COMPLETED" | "FAILED" | "INTERRUPTED"
  ): void {
    reportPlaybackOutcome(requestId, outcome);
    if (outcome !== "COMPLETED") speechPlaybackByRequestRef.current.delete(requestId);
  }

  async function startLiveSpeech(): Promise<void> {
    if (
      memoryPreferenceState !== "ready" ||
      liveSpeechStatus !== "idle" ||
      voiceCaptureStatus !== "idle"
    )
      return;
    setVoiceError(null);
    setLiveSpeechStatus("requesting");
    try {
      const buffer = createHandsFreeUtteranceBuffer(
        globalThis.crypto?.randomUUID?.() ?? `epoch-${Date.now()}`
      );
      let wasSpeechActive = false;
      let previewPending = false;
      let previewAt = 0;
      const capture = await startLiveSpeechCapture({
        sessionId,
        createId: () => buffer.captureEpoch,
        onError: (error) => {
          setVoiceError(error.message);
          void stopLiveSpeech();
        },
        postFrame: async (frame, signal) => {
          const snapshot = await apiClient.postSpeechActivityFrame(frame, signal);
          if (!mountedRef.current || signal?.aborted || handsFreeBufferRef.current !== buffer)
            return snapshot;
          setLiveSpeechActive(snapshot.speechActive);
          // Pair VAD with its own PCM frame, never with newer microphone samples.
          const bytes = Uint8Array.from(atob(frame.pcmBase64), (char) => char.charCodeAt(0));
          const pcm = new Int16Array(bytes.buffer);
          const utterance = buffer.observeVad(snapshot.speechActive) ?? buffer.push(pcm);
          if (snapshot.speechActive && !wasSpeechActive) {
            transcribeAbortRef.current?.abort();
            // Silero already confirms sustained speech (150 ms). Barge-in is
            // independent of transcript completion, including synthesis-only turns.
            stopGeneration();
            stopSpeech();
          }
          wasSpeechActive = snapshot.speechActive;
          const preview = buffer.preview();
          if (preview && !previewPending && Date.now() - previewAt >= 500) {
            previewPending = true;
            previewAt = Date.now();
            void wavBlobToBase64(encodePcm16Wav(preview.pcm))
              .then((audioBase64) =>
                apiClient.transcribeAudio({ audioBase64, mimeType: "audio/wav", preview: true })
              )
              .then((result) => buffer.observeTranscript(result.text, preview.revision))
              .catch(() => undefined)
              .finally(() => {
                previewPending = false;
              });
          }
          if (snapshot.revokedSpeechRequestId) {
            busRef.current?.post({
              kind: "stop-speech",
              requestId: snapshot.revokedSpeechRequestId
            });
          }
          if (utterance) void finalizeHandsFreeUtterance(utterance.pcm, utterance.captureEpoch);
          return snapshot;
        }
      });
      if (!mountedRef.current) {
        buffer.dispose();
        await capture.stop();
        return;
      }
      handsFreeBufferRef.current = buffer;
      liveSpeechCaptureRef.current = capture;
      setMicTrackSettings(capture.trackSettings);
      setLiveSpeechStatus("listening");
    } catch (caught) {
      liveSpeechCaptureRef.current = null;
      handsFreeBufferRef.current?.dispose();
      handsFreeBufferRef.current = null;
      setLiveSpeechStatus("idle");
      setLiveSpeechActive(false);
      setMicTrackSettings(null);
      setVoiceError(friendlyAudioError(caught));
    }
  }

  async function finalizeHandsFreeUtterance(pcm: Int16Array, captureEpoch: string): Promise<void> {
    if (!mountedRef.current || liveSpeechCaptureRef.current === null) return;
    transcribeAbortRef.current?.abort();
    const controller = new AbortController();
    transcribeAbortRef.current = controller;
    try {
      const audioBase64 = await wavBlobToBase64(encodePcm16Wav(pcm));
      const result = await apiClient.transcribeAudio({
        sessionId,
        audioBase64,
        mimeType: "audio/wav",
        captureEpoch,
        signal: controller.signal
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      const text = result.text.trim();
      if (!text) return;
      await sendHandsFreeTurn(text, result.observationId);
    } catch (caught) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setVoiceError(friendlyAudioError(caught));
    }
  }

  async function sendHandsFreeTurn(content: string, observationId?: string): Promise<void> {
    if (memoryPreferenceState !== "ready") return;
    const active = activeRequestRef.current;
    if (active?.origin === "user") {
      if (active.completedObserved) {
        activeRequestRef.current = null;
      } else {
        stopGeneration();
      }
    }
    if (activeRequestRef.current?.origin === "proactive") {
      cancelActiveProactiveRequest(activeRequestRef.current);
    }
    if (activeRequestRef.current?.origin === "user") return;
    setError(null);
    const requestId = createSurfaceId("turn");
    const assistantId = createSurfaceId("assistant");
    const controller = new AbortController();
    const ownership: ActiveRequestOwnership = {
      id: requestId,
      assistantId,
      controller,
      completedObserved: false,
      origin: "user"
    };
    activeRequestRef.current = ownership;
    const shouldRequestTts = effectiveVoiceOutputRef.current.requestTts;
    speechEpochRef.current = shouldRequestTts ? requestId : null;
    playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
    setActualPlaybackActive(false);
    setRequestStatus("sending");
    const bus = busRef.current;
    bus?.post({ kind: "user-gesture" });
    bus?.post({ kind: "voice-enabled", enabled: true });
    bus?.post({ kind: "start-generation", requestId, sessionId });
    // Same committed-text authority as the user path: segmentation feeds
    // Subtitle via Companion even when TTS audio is off.
    const feedback = createSpeechPipelineFeedback();
    speechSessionRef.current = {
      generation: requestId,
      segmenter: new SpeechSegmenter({
        pipeline: () => {
          const session = speechSessionRef.current;
          return session?.generation === requestId ? session.feedback : undefined;
        }
      }),
      sequence: 0,
      ended: false,
      feedback
    };
    if (shouldRequestTts) {
      void apiClient
        .admitSpeechPlayback({ sessionId, requestId })
        .then((effect) => {
          speechPlaybackByRequestRef.current.set(requestId, effect.effectId);
        })
        .catch(() => undefined);
    }
    dispatchMessages({
      type: "append-turn",
      user: {
        id: createSurfaceId("user"),
        requestId,
        role: "user",
        content,
        useMemory: readMemory && writeMemory,
        readMemory,
        writeMemory,
        voiceOutput: shouldRequestTts,
        status: "completed"
      },
      assistant: {
        id: assistantId,
        requestId,
        role: "assistant",
        content: "",
        status: "streaming"
      }
    });
    try {
      const response = await apiClient.streamMessage(
        {
          sessionId,
          text: content,
          ...(observationId ? { speechObservationId: observationId } : {}),
          options: {
            readMemory,
            writeMemory,
            voiceOutput: false,
            promptPreview
          }
        },
        {
          signal: controller.signal,
          onEvent: (event: MessageStreamEvent) => {
            if (!mountedRef.current || !isCurrentRequest(activeRequestRef.current, ownership)) {
              return;
            }
            if ("traceId" in event) dispatchMessages({ type: "bind-trace", assistantId, traceId: event.traceId });
            if (event.type === "text-delta") {
              dispatchMessages({
                type: "append-delta",
                assistantId,
                text: event.text,
                traceId: event.traceId
              });
              forwardSpeechSegments(requestId, event.text, event.language);
              return;
            }
            if (event.type === "error") {
              dispatchMessages({ type: "fail", assistantId, error: event.message });
              setError(event.message);
              forwardSpeechEnd(requestId, "failed");
              return;
            }
            ownership.completedObserved = true;
            dispatchMessages({
              type: "complete",
              assistantId,
              content: event.content,
              traceId: event.traceId,
              provider: event.provider
            });
            setRequestStatus("success");
            forwardSpeechEnd(requestId, "completed");
          }
        }
      );
      if (!mountedRef.current || !isCurrentRequest(activeRequestRef.current, ownership)) return;
      ownership.completedObserved = true;
      dispatchMessages({
        type: "complete",
        assistantId,
        content: response.content,
        traceId: response.traceId,
        provider: response.provider
      });
      setRequestStatus("success");
      forwardSpeechEnd(requestId, "completed");
    } catch (caught) {
      if (!mountedRef.current || !isCurrentRequest(activeRequestRef.current, ownership)) return;
      if (controller.signal.aborted) {
        dispatchMessages({
          type: "cancel",
          assistantId,
          error: "生成已取消，以上内容可能不完整。"
        });
        setRequestStatus("idle");
        return;
      }
      const message = friendlyChatError(caught);
      forwardSpeechEnd(requestId, "failed");
      dispatchMessages({ type: "fail", assistantId, error: message });
      setError(message);
      setRequestStatus("error");
    } finally {
      if (isCurrentRequest(activeRequestRef.current, ownership)) {
        activeRequestRef.current = null;
        bus?.post({ kind: "generation-state", requestId, state: "idle" });
      }
      if (speechSessionRef.current?.generation === requestId) {
        speechSessionRef.current = null;
      }
    }
  }

  async function stopLiveSpeech(): Promise<void> {
    const capture = liveSpeechCaptureRef.current;
    if (!capture) return;
    liveSpeechCaptureRef.current = null;
    handsFreeBufferRef.current?.dispose();
    handsFreeBufferRef.current = null;
    transcribeAbortRef.current?.abort();
    transcribeAbortRef.current = null;
    try {
      await capture.stop();
    } catch {
      // Capture shutdown is best-effort; Runtime speechActive is cleared below.
    }
    try {
      await apiClient.postSpeechActivity({
        sessionId,
        captureEpoch: capture.captureEpoch,
        active: false
      });
    } catch {
      // Stopping the producer must not fail the UI if Runtime already dropped the epoch.
    }
    setLiveSpeechStatus("idle");
    setLiveSpeechActive(false);
    setMicTrackSettings(null);
  }

  async function startVoiceCapture(): Promise<void> {
    if (voiceCaptureStatus !== "idle" || liveSpeechStatus !== "idle") return;
    setVoiceError(null);
    setRecordedAudio(null);
    setVoiceTranscription(null);
    setVoiceCaptureStatus("requesting");
    try {
      const capture = await startMicrophoneCapture();
      if (!mountedRef.current) {
        releaseMicrophoneCapture(capture);
        return;
      }
      audioCaptureRef.current = capture;
      setVoiceCaptureStatus("recording");
    } catch (caught) {
      audioCaptureRef.current = null;
      setVoiceCaptureStatus("idle");
      setVoiceError(friendlyAudioError(caught));
    }
  }

  async function stopVoiceCapture(): Promise<void> {
    const capture = audioCaptureRef.current;
    if (!capture || voiceCaptureStatus !== "recording") return;
    audioCaptureRef.current = null;
    setVoiceCaptureStatus("stopping");
    setVoiceError(null);
    try {
      setRecordedAudio(await stopMicrophoneCapture(capture));
    } catch (caught) {
      setVoiceError(friendlyAudioError(caught));
    } finally {
      setVoiceCaptureStatus("idle");
    }
  }

  async function transcribeVoiceCapture(): Promise<void> {
    const recording = recordedAudio;
    if (!recording || voiceCaptureStatus !== "idle") return;
    setVoiceCaptureStatus("transcribing");
    setVoiceError(null);
    try {
      const result = await apiClient.transcribeAudio({
        sessionId,
        audioBase64: recording.audioBase64,
        mimeType: recording.mimeType
      });
      if (!mountedRef.current) return;
      setVoiceTranscription(result);
      if (result.text.trim()) {
        setInput((current) => (current.trim() ? current : result.text));
        inputRef.current?.focus();
      }
    } catch (caught) {
      if (mountedRef.current) setVoiceError(friendlyAudioError(caught));
    } finally {
      if (mountedRef.current) setVoiceCaptureStatus("idle");
    }
  }

  async function selectImageAttachment(file: File | undefined): Promise<void> {
    if (!file) return;
    setAttachmentError(null);
    try {
      const attachment = await readVisionImageAttachment(file);
      if (!mountedRef.current) return;
      setImageAttachment(attachment);
    } catch (caught) {
      if (!mountedRef.current) return;
      const message = caught instanceof Error ? caught.message : "The selected image could not be read.";
      setAttachmentError(t(message));
    }
  }

  function removeImageAttachment(): void {
    setImageAttachment(null);
    setAttachmentError(null);
    if (imageInputRef.current) imageInputRef.current.value = "";
    inputRef.current?.focus();
  }

  const microphoneActive = liveSpeechStatus === "listening";
  const microphoneBusy = liveSpeechStatus === "requesting";
  const microphoneLabel = microphoneActive ? t("Stop Voice Mode") : t("Start Voice Mode");
  const voiceStatus =
    liveSpeechStatus === "requesting"
      ? t("Connecting microphone…")
      : microphoneActive
        ? liveSpeechActive
          ? t("Listening…")
          : t("Voice input is on")
        : "";
  const playbackStatus =
    voicePlaybackStatus !== "idle"
      ? t(voicePlaybackStatusLabel(voicePlaybackStatus, actualPlaybackActive))
      : "";
  const settingsStatus =
    memoryPreferenceState === "loading"
      ? t("Loading conversation settings…")
      : memoryPreferenceState === "unavailable"
        ? t("Conversation settings unavailable")
        : "";

  return (
    <div className="yuvi-main-chat">
      <main className="yuvi-main-chat-shell" aria-label={t("YUVI Chat")}>
        <section className="yuvi-main-thread" aria-label={t("Chat History")}>
          <div className="yuvi-main-thread-inner">
            {historyError && <p role="status">{t("Unable to load chat history. Retrying…")}</p>}
            {messages.length === 0 ? (
              <div className="yuvi-main-empty">
                <div className="yuvi-main-empty-mark" aria-hidden="true">
                  y
                </div>
                <p>{t("What would you like to talk about?")}</p>
              </div>
            ) : (
              <div className="yuvi-main-message-list">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    className={
                      message.role === "user"
                        ? "yuvi-main-message is-user"
                        : "yuvi-main-message is-assistant"
                    }
                  >
                    <div className="yuvi-main-message-content">
                      {message.role === "user" && message.imageAttachment && (
                        <img
                          className="yuvi-main-message-image"
                          src={message.imageAttachment.dataUrl}
                          alt={message.imageAttachment.name}
                        />
                      )}
                      <ChatMessageContent role={message.role} content={message.content} />
                      {message.role === "assistant" &&
                        message.status === "streaming" &&
                        !message.content && (
                          <span className="yuvi-main-thinking" role="status" aria-label={t("Generating")}>
                            <span />
                            <span />
                            <span />
                          </span>
                        )}
                    </div>
                    {message.error && (
                      <div className="yuvi-main-message-error" role="alert">
                        {message.error}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
            <div ref={threadEndRef} aria-hidden="true" />
          </div>
        </section>

        <div className="yuvi-main-composer-dock">
          <div className="yuvi-main-composer-wrap">
            {imageAttachment && (
              <div className="yuvi-main-attachment-preview">
                <img src={imageAttachment.dataUrl} alt={imageAttachment.name} />
                <div className="yuvi-main-attachment-copy">
                  <span>{imageAttachment.name}</span>
                  <small>{t("Image attached")}</small>
                </div>
                <button
                  type="button"
                  className="yuvi-main-attachment-remove"
                  aria-label={t("Remove image")}
                  title={t("Remove image")}
                  onClick={removeImageAttachment}
                >
                  ×
                </button>
              </div>
            )}

            {(attachmentError || voiceError) && (
              <div className="yuvi-main-inline-error" role="alert">
                {attachmentError ?? voiceError}
              </div>
            )}

            <div
              className={[
                "yuvi-main-composer",
                microphoneActive ? "is-listening" : "",
                microphoneBusy ? "is-busy" : ""
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <input
                ref={imageInputRef}
                className="yuvi-main-file-input"
                type="file"
                accept="image/png,image/jpeg"
                aria-label={t("Image attachment")}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void selectImageAttachment(file);
                }}
              />
              <button
                type="button"
                className="yuvi-main-composer-button yuvi-main-attach"
                disabled={requestStatus === "sending" || microphoneActive || microphoneBusy}
                aria-label={t("Attach image")}
                title={t("Attach image")}
                onClick={() => imageInputRef.current?.click()}
              >
                <AttachIcon />
              </button>

              <textarea
                ref={inputRef}
                className="yuvi-main-composer-input"
                placeholder={t("Message YUVI")}
                value={input}
                rows={1}
                autoFocus
                onChange={(event) => {
                  setInput(event.target.value);
                  const target = event.currentTarget;
                  target.style.height = "auto";
                  target.style.height = `${Math.min(target.scrollHeight, 156)}px`;
                }}
                onKeyDown={(event) => {
                  if (shouldSubmitChatKey(event)) {
                    event.preventDefault();
                    void send();
                  }
                }}
                aria-label={t("Chat message")}
              />

              <button
                type="button"
                className="yuvi-main-composer-button yuvi-main-microphone"
                disabled={
                  memoryPreferenceState !== "ready" ||
                  imageAttachment !== null ||
                  microphoneBusy ||
                  voiceCaptureStatus !== "idle"
                }
                aria-pressed={microphoneActive}
                aria-label={microphoneLabel}
                title={microphoneLabel}
                onClick={() =>
                  void (microphoneActive ? stopLiveSpeech() : startLiveSpeech())
                }
              >
                <MicrophoneIcon active={microphoneActive} />
              </button>

              {requestStatus === "sending" ? (
                <button
                  type="button"
                  className="yuvi-main-composer-button yuvi-main-stop"
                  onClick={stopGeneration}
                  aria-label={t("Stop generating")}
                  title={t("Stop generating")}
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  type="button"
                  className="yuvi-main-composer-button yuvi-main-send"
                  disabled={memoryPreferenceState !== "ready" || !input.trim()}
                  onClick={() => void send()}
                  aria-label={t("Send message")}
                  title={t("Send message")}
                >
                  <SendIcon />
                </button>
              )}
            </div>

            {(settingsStatus || voiceStatus || playbackStatus) && (
              <div
                className={
                  memoryPreferenceState === "unavailable"
                    ? "yuvi-main-composer-status is-error"
                    : "yuvi-main-composer-status"
                }
                aria-live="polite"
              >
                {[settingsStatus, voiceStatus, playbackStatus].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function AttachIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MicrophoneIcon(props: { active: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 15.25a3.75 3.75 0 0 0 3.75-3.75V7a3.75 3.75 0 0 0-7.5 0v4.5A3.75 3.75 0 0 0 12 15.25Zm-6-4a6 6 0 0 0 12 0M12 17.25V21M9.25 21h5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={props.active ? 2.15 : 1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SendIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 18V6m0 0-4.5 4.5M12 6l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function chatStatusLabel(status: NonNullable<ChatMessage["status"]>): string {
  switch (status) {
    case "streaming":
      return "生成中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

export function resolveSpeechCommandEpoch(
  speechEpoch: string | null,
  generationEpoch: string | null
): string | null {
  return speechEpoch ?? generationEpoch;
}

export function correlateMainPlaybackStatus(
  current: SpeechPlaybackCorrelationState,
  phase: "started" | "terminal",
  segment: SpeechSegmentIdentity
) {
  return correlateSpeechPlayback(current, phase, segment);
}

export function voicePlaybackStatusLabel(
  status: VoicePlaybackStatus,
  actualPlaybackActive = false
): string {
  if (actualPlaybackActive) return "Speaking…";
  switch (status) {
    case "synthesizing":
      return "Preparing speech…";
    case "playing":
      return actualPlaybackActive ? "Speaking…" : "Speech queued…";
    case "stopped":
      return "Speech stopped; generated text is preserved.";
    case "error":
      return "Speech unavailable; text response is preserved.";
    default:
      return "";
  }
}

function applyPlaybackStatus(
  state: CompanionPlaybackState,
  setStatus: (status: VoicePlaybackStatus) => void,
  setActive: (active: boolean) => void
): void {
  if (state === "started") {
    setStatus("playing");
    setActive(true);
    return;
  }
  setActive(false);
  if (state === "error") setStatus("error");
}

function friendlyChatError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message || "消息请求失败。";
  }
  if (error instanceof Error && error.name === "MessageStreamProtocolError") {
    return "消息流协议错误，回复未完成。";
  }
  if (error instanceof Error && error.name === "MessageStreamError") {
    return error.message || "消息流处理失败。";
  }
  return "网络连接中断，回复未完成。";
}

function friendlyAudioError(error: unknown): string {
  if (error instanceof ApiError) return error.message || "语音转写请求失败。";
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return "麦克风访问被拒绝。请重新点击麦克风并允许访问；若桌面版没有权限提示，请重启更新后的 YUVI。";
    }
    if (error.name === "NotFoundError") return "未找到麦克风。请连接麦克风，并在系统声音设置中选择输入设备后重试。";
    if (error.name === "NotReadableError") return "无法打开麦克风。请在系统声音设置中检查输入设备，并关闭占用它的应用后重试。";
    if (error.message) return error.message;
  }
  return "语音录音或转写失败，请检查麦克风权限和本地语音服务。";
}
