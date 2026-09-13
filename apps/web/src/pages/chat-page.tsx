import { useConversationSession, useConversationHistory } from "../use-conversation-history.js";
import { t } from "../locale.js";
import { useEffect, useMemo, useReducer, useRef, useState, type MutableRefObject } from "react";
import {
  ApiError,
  apiClient,
  type MessageStreamEvent,
  type ProviderCallMetadata
} from "../api/client.js";
import { reduceChatMessages, shouldSubmitChatKey, type ChatMessage } from "../chat-state.js";
import { ChatMessageContent } from "../markdown-message.js";
import { SpeechSegmenter } from "../speech-segmenter.js";
import {
  createSpeechPipelineFeedback,
  reduceSpeechPipelineFeedback,
  type SpeechPipelineFeedback
} from "../speech-pipeline-feedback.js";
import {
  applyCapabilityProjection,
  deriveCapabilityProjection,
  deriveEffectiveVoiceOutput,
  detectBrowserAudioCapability
} from "../capability-projection.js";
import {
  createBrowserSpeechPlayer,
  detectSpeechLanguage,
  SpeechPlaybackQueue,
  type SpeechQueueState,
  type SpeechPlaybackEvent
} from "../speech-queue.js";
import {
  correlateSpeechPlayback,
  createSpeechPlaybackCorrelation,
  type SpeechPlaybackCorrelationState
} from "../speech-playback-correlation.js";
import { LumiCanvas } from "../lumi-canvas.js";
import type { LumiControllerHandle, LumiModelLifecycle } from "../lumi-live2d.js";
import {
  canInterruptGeneration,
  createCompanionPresenceEpochGuard,
  createInitialCompanionPresence,
  createInterruptedResetScheduler,
  reduceCompanionPresence,
  type CompanionPresenceEvent,
  type CompanionPresenceProjection
} from "../companion-presence.js";
import type { CompanionTtsConfiguration } from "../companion-bus.js";
import {
  isServiceSupervisorAvailable,
  subscribeServiceStatusState
} from "../service-supervisor-client.js";
import { initialServiceStatusState, type ServiceStatusState } from "../service-status-state.js";
import { fetchUserSettings } from "../user-settings-client.js";
import { isTauriRuntime } from "../tauri-window.js";
import {
  dashboardVoicePlaybackStatusLabel,
  deriveDashboardTtsPolicy,
  flushDashboardSpeechTail
} from "../dashboard-chat-speech.js";
import { formatLatency, formatTokenUsage } from "../dashboard-provider-verification.js";
import { EmptyState, Field, Notice, PageShell, Panel, Pill, Toggle } from "../dashboard-ui.js";

type RequestStatus = "idle" | "sending" | "success" | "error";
type VoicePlaybackStatus = SpeechQueueState;
type ChatTimingMetrics = {
  userSendAt: number;
  firstTextDeltaAt?: number;
  firstSegmentSubmittedAt?: number;
  firstTtsCompletedAt?: number;
  firstAudioStartedAt?: number;
  presenceSpeakingAt?: number;
  stopRequestedAt?: number;
  audioPausedAt?: number;
  mouthZeroAt?: number;
  finalAudioEndedAt?: number;
  assistantCompletedAt?: number;
};

function recordChatTiming(
  timingRef: MutableRefObject<ChatTimingMetrics | null>,
  patch: Partial<ChatTimingMetrics>
): void {
  if (!timingRef.current) return;
  Object.assign(timingRef.current, patch);
  if (import.meta.env.DEV && typeof window !== "undefined") {
    document.documentElement.dataset["yuviLumiTiming"] = JSON.stringify(timingRef.current);
  }
}

let chatMessageSequence = 0;

export function ChatPage(): JSX.Element {
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useConversationSession("dashboard");
  const [readMemory, setReadMemory] = useState(true);
  const [writeMemory, setWriteMemory] = useState(true);
  const [promptPreview, setPromptPreview] = useState(true);
  const [voiceOutput, setVoiceOutput] = useState(false);
  const [presence, setPresenceProjection] = useState<CompanionPresenceProjection>(() =>
    createInitialCompanionPresence()
  );
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusState>(initialServiceStatusState);
  const [ttsConfig, setTtsConfig] = useState<CompanionTtsConfiguration | null>(() =>
    isTauriRuntime() ? null : { enabled: true, mode: "external" }
  );
  const [modelLifecycle, setModelLifecycle] = useState<LumiModelLifecycle>("loading");
  const [messages, dispatchMessages] = useReducer(reduceChatMessages, [] as ChatMessage[]);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const historyError = useConversationHistory(sessionId, requestStatus === "sending", dispatchMessages);
  const [lastTraceId, setLastTraceId] = useState<string | null>(null);
  const [voicePlaybackStatus, setVoicePlaybackStatus] = useState<VoicePlaybackStatus>("idle");
  const [actualPlaybackActive, setActualPlaybackActive] = useState(false);
  const mountedRef = useRef(true);
  const lumiRef = useRef<LumiControllerHandle>(null);
  const presenceProjectionRef = useRef(presence);
  const epochGuardRef = useRef(createCompanionPresenceEpochGuard());
  const interruptedResetRef = useRef<ReturnType<typeof createInterruptedResetScheduler> | null>(
    null
  );
  const effectiveVoiceOutputRef = useRef<ReturnType<typeof deriveEffectiveVoiceOutput>>({
    requestTts: false,
    reason: "settings-pending"
  });
  const timingRef = useRef<ChatTimingMetrics | null>(null);
  const speechSessionRef = useRef<{
    generation: string;
    segmenter: SpeechSegmenter;
    queue: SpeechPlaybackQueue;
    nextSegmentSequence: number;
    feedback: SpeechPipelineFeedback;
  } | null>(null);
  const playbackCorrelationRef = useRef<SpeechPlaybackCorrelationState>(
    createSpeechPlaybackCorrelation()
  );
  const activeRequestRef = useRef<{
    id: string;
    assistantId: string;
    controller: AbortController;
    completedObserved: boolean;
  } | null>(null);

  presenceProjectionRef.current = presence;

  const capabilityProjection = useMemo(
    () =>
      deriveCapabilityProjection({
        serviceStatus,
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        ttsConfiguration: ttsConfig,
        audio: detectBrowserAudioCapability(),
        live2dLifecycle: modelLifecycle
      }),
    [modelLifecycle, serviceStatus, ttsConfig]
  );
  const effectiveVoiceOutput = useMemo(
    () =>
      deriveDashboardTtsPolicy({
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        perTurnVoiceOutput: voiceOutput,
        ttsCapability: capabilityProjection.capabilities.tts,
        ttsConfiguration: ttsConfig
      }),
    [capabilityProjection.capabilities.tts, ttsConfig?.enabled, ttsConfig?.mode, voiceOutput]
  );
  effectiveVoiceOutputRef.current = effectiveVoiceOutput;

  function updatePresence(
    update: (current: CompanionPresenceProjection) => CompanionPresenceProjection
  ): void {
    const current = presenceProjectionRef.current;
    const next = update(current);
    if (next === current) return;
    presenceProjectionRef.current = next;
    // Forward synchronously; React state is only the dashboard render surface.
    lumiRef.current?.setPresentationProjection(next);
    setPresenceProjection(next);
  }

  function applyPresenceEvent(event: CompanionPresenceEvent): void {
    updatePresence((current) => reduceCompanionPresence(current, event));
  }

  useEffect(() => {
    if (!isTauriRuntime() && !isServiceSupervisorAvailable()) return;
    return subscribeServiceStatusState(setServiceStatus);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void fetchUserSettings()
      .then((view) => {
        if (!cancelled) {
          setTtsConfig({ enabled: view.settings.tts.enabled, mode: view.settings.tts.mode });
        }
      })
      .catch(() => {
        // Keep persisted TTS configuration unknown when the authority cannot be read.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    updatePresence((current) =>
      applyCapabilityProjection(current, capabilityProjection, (value, event) =>
        reduceCompanionPresence(value, event)
      )
    );
  }, [capabilityProjection]);

  useEffect(() => {
    const resetScheduler = createInterruptedResetScheduler(() => {
      const epoch = presenceProjectionRef.current.epoch;
      if (epoch) applyPresenceEvent({ type: "transition-expired", epoch });
    });
    interruptedResetRef.current = resetScheduler;
    return () => {
      resetScheduler.dispose();
      if (interruptedResetRef.current === resetScheduler) interruptedResetRef.current = null;
      epochGuardRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    if (presence.transition === "interrupted" && presence.epoch) {
      interruptedResetRef.current?.schedule();
    } else {
      interruptedResetRef.current?.invalidate();
    }
  }, [presence.transition, presence.epoch]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      speechSessionRef.current?.queue.cancel();
      speechSessionRef.current = null;
      playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
    };
  }, []);

  const outgoingPayload = useMemo(
    () => ({
      text: input || "<message text>",
      options: {
        readMemory,
        writeMemory,
        promptPreview,
        voiceOutput: false,
        browserVoiceOutput: voiceOutput,
        effectiveTtsRequest: effectiveVoiceOutput.requestTts,
        effectiveTtsReason: effectiveVoiceOutput.reason
      }
    }),
    [effectiveVoiceOutput, input, promptPreview, readMemory, voiceOutput, writeMemory]
  );

  function enqueueDashboardSpeech(
    speech: NonNullable<typeof speechSessionRef.current>,
    text: string
  ): void {
    const segment = {
      requestId: speech.generation,
      sequence: speech.nextSegmentSequence++
    };
    speech.queue.enqueue({ text, language: detectSpeechLanguage(text) }, segment);
  }

  async function send(): Promise<void> {
    // Capture the draft once, clear the controlled textarea immediately, then
    // use only the captured payload for the rest of the turn.
    const submittedText = input.trim() ? input : null;
    if (submittedText === null || activeRequestRef.current) {
      return;
    }

    speechSessionRef.current?.queue.cancel();
    speechSessionRef.current = null;
    playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
    setActualPlaybackActive(false);
    const content = submittedText;
    setInput("");
    setError(null);
    const requestId = createChatMessageId("turn");
    const assistantId = createChatMessageId("assistant");
    const controller = new AbortController();
    if (!epochGuardRef.current.accept(requestId)) return;
    activeRequestRef.current = {
      id: requestId,
      assistantId,
      controller,
      completedObserved: false
    };
    timingRef.current = { userSendAt: performance.now() };
    recordChatTiming(timingRef, {});
    const shouldRequestTts = effectiveVoiceOutputRef.current.requestTts;
    applyPresenceEvent({ type: "turn-start", epoch: requestId });
    if (shouldRequestTts) {
      // Resume the shared Web Audio context while this send is still a user gesture.
      lumiRef.current?.resumeAudio();
      const generation = requestId;
      const feedback = createSpeechPipelineFeedback();
      const segmenter = new SpeechSegmenter({
        pipeline: () => {
          const session = speechSessionRef.current;
          return session?.generation === generation ? session.feedback : undefined;
        }
      });
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
            if (mountedRef.current && speechSessionRef.current?.generation === generation) {
              speechSessionRef.current.feedback = reduceSpeechPipelineFeedback(
                speechSessionRef.current.feedback,
                { type: "queue-state", state }
              );
              setVoicePlaybackStatus(state);
              applyPresenceEvent({ type: "queue", epoch: generation, state });
              // An item failure does not terminate the queue. Retain ownership
              // so subsequent deltas, playback events and cancellation reach it.
              if (state === "idle" || state === "stopped") {
                speechSessionRef.current = null;
              }
            }
          },
          onError: () => {
            if (mountedRef.current && speechSessionRef.current?.generation === generation) {
              setVoicePlaybackStatus("error");
              applyPresenceEvent({ type: "queue", epoch: generation, state: "error" });
            }
          },
          onSynthesisCompleted: () => {
            const timing = timingRef.current;
            if (timing)
              recordChatTiming(timingRef, {
                firstTtsCompletedAt: timing.firstTtsCompletedAt ?? performance.now()
              });
          },
          onPlaybackEvent: (event: SpeechPlaybackEvent) => {
            if (mountedRef.current && speechSessionRef.current?.generation === generation) {
              const phase =
                event.type === "audioElementAttached"
                  ? "attached"
                  : event.type === "playbackStarted"
                    ? "started"
                    : event.type === "audioElementDetached"
                      ? "detached"
                      : "terminal";
              const result = correlateSpeechPlayback(
                playbackCorrelationRef.current,
                phase,
                event.segment
              );
              playbackCorrelationRef.current = result.state;
              if (!result.accepted) return;
              if (event.type === "playbackEnded") {
                speechSessionRef.current.feedback = reduceSpeechPipelineFeedback(
                  speechSessionRef.current.feedback,
                  { type: "playback-ended" }
                );
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
              if (playbackState !== null) {
                applyPresenceEvent({
                  type: "playback",
                  epoch: generation,
                  state: playbackState
                });
              }
              lumiRef.current?.handlePlaybackEvent(event);
              if (event.type === "playbackStarted") {
                setActualPlaybackActive(true);
                timingRef.current ??= { userSendAt: performance.now() };
                const now = performance.now();
                recordChatTiming(timingRef, {
                  firstAudioStartedAt: timingRef.current.firstAudioStartedAt ?? now,
                  presenceSpeakingAt: timingRef.current.presenceSpeakingAt ?? now
                });
              } else if (event.type === "playbackStopped") {
                setActualPlaybackActive(false);
                recordChatTiming(timingRef, {
                  audioPausedAt: performance.now(),
                  mouthZeroAt: performance.now()
                });
              } else if (event.type === "playbackEnded") {
                setActualPlaybackActive(false);
                recordChatTiming(timingRef, {
                  finalAudioEndedAt: performance.now(),
                  mouthZeroAt: performance.now()
                });
              } else if (event.type === "playbackError") {
                setActualPlaybackActive(false);
              }
            }
          }
        }
      );
      speechSessionRef.current = {
        generation,
        segmenter,
        queue,
        nextSegmentSequence: 0,
        feedback
      };
    }
    setRequestStatus("sending");
    dispatchMessages({
      type: "append-turn",
      user: {
        id: createChatMessageId("user"),
        requestId,
        role: "user",
        content,
        useMemory: readMemory && writeMemory,
        readMemory,
        writeMemory,
        voiceOutput,
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
          options: {
            readMemory,
            writeMemory,
            // Browser playback owns sentence-level TTS for this path. Avoid
            // asking Runtime to synthesize the complete reply a second time.
            voiceOutput: false,
            promptPreview
          }
        },
        {
          signal: controller.signal,
          onEvent: (event: MessageStreamEvent) => {
            if (!mountedRef.current || activeRequestRef.current?.id !== requestId) {
              return;
            }
            if ("traceId" in event) dispatchMessages({ type: "bind-trace", assistantId, traceId: event.traceId });
            if (event.type === "text-delta") {
              if (timingRef.current && timingRef.current.firstTextDeltaAt === undefined) {
                recordChatTiming(timingRef, { firstTextDeltaAt: performance.now() });
              }
              setLastTraceId(event.traceId);
              dispatchMessages({
                type: "append-delta",
                assistantId,
                text: event.text,
                traceId: event.traceId
              });
              const speech = speechSessionRef.current;
              if (speech?.generation === requestId && effectiveVoiceOutputRef.current.requestTts) {
                for (const text of speech.segmenter.push(event.text)) {
                  if (
                    timingRef.current &&
                    timingRef.current.firstSegmentSubmittedAt === undefined
                  ) {
                    recordChatTiming(timingRef, { firstSegmentSubmittedAt: performance.now() });
                  }
                  enqueueDashboardSpeech(speech, text);
                }
              }
              return;
            }
            if (event.type === "error") {
              dispatchMessages({ type: "fail", assistantId, error: event.message });
              setError(event.message);
              applyPresenceEvent({ type: "generation", epoch: requestId, state: "idle" });
              const speech = speechSessionRef.current;
              if (speech?.generation === requestId) {
                for (const text of speech.segmenter.flush("failed")) {
                  if (effectiveVoiceOutputRef.current.requestTts)
                    enqueueDashboardSpeech(speech, text);
                }
                speech.queue.finish();
              }
              return;
            }
            activeRequestRef.current.completedObserved = true;
            setLastTraceId(event.traceId);
            dispatchMessages({
              type: "complete",
              assistantId,
              content: event.content,
              traceId: event.traceId,
              provider: event.provider
            });
            setRequestStatus("success");
            applyPresenceEvent({ type: "generation", epoch: requestId, state: "idle" });
            recordChatTiming(timingRef, { assistantCompletedAt: performance.now() });
            const speech = speechSessionRef.current;
            if (speech?.generation === requestId) {
              for (const text of speech.segmenter.flush("completed")) {
                if (effectiveVoiceOutputRef.current.requestTts)
                  enqueueDashboardSpeech(speech, text);
              }
              speech.queue.finish();
            }
          }
        }
      );

      if (!mountedRef.current || activeRequestRef.current?.id !== requestId) {
        return;
      }
      dispatchMessages({
        type: "complete",
        assistantId,
        content: response.content,
        traceId: response.traceId,
        provider: response.provider
      });
      setLastTraceId(response.traceId);
      setRequestStatus("success");
      applyPresenceEvent({ type: "generation", epoch: requestId, state: "idle" });
      recordChatTiming(timingRef, { assistantCompletedAt: performance.now() });
      const speech = speechSessionRef.current;
      if (speech?.generation === requestId) {
        for (const text of speech.segmenter.flush("completed")) {
          if (effectiveVoiceOutputRef.current.requestTts) enqueueDashboardSpeech(speech, text);
        }
        speech.queue.finish();
      }
    } catch (caught) {
      if (!mountedRef.current || activeRequestRef.current?.id !== requestId) {
        return;
      }
      if (controller.signal.aborted) {
        const speech = speechSessionRef.current;
        if (speech?.generation === requestId) {
          speech.queue.cancel();
          speech.segmenter.reset();
        }
        dispatchMessages({
          type: "cancel",
          assistantId,
          error: "生成已取消，以上内容可能不完整。"
        });
        setRequestStatus("idle");
        applyPresenceEvent({ type: "generation", epoch: requestId, state: "interrupted" });
        return;
      }
      const message = friendlyChatError(caught);
      const speech = speechSessionRef.current;
      if (speech?.generation === requestId) {
        flushDashboardSpeechTail(
          speech.segmenter.flush("failed"),
          effectiveVoiceOutputRef.current.requestTts,
          (text) => enqueueDashboardSpeech(speech, text),
          () => speech.queue.finish()
        );
      }
      dispatchMessages({ type: "fail", assistantId, error: message });
      setError(message);
      setRequestStatus("error");
      applyPresenceEvent({ type: "generation", epoch: requestId, state: "idle" });
    } finally {
      if (activeRequestRef.current?.id === requestId) {
        activeRequestRef.current = null;
      }
    }
  }

  function stopGeneration(): void {
    const active = activeRequestRef.current;
    if (!active || active.completedObserved) {
      return;
    }
    recordChatTiming(timingRef, { stopRequestedAt: performance.now() });
    if (canInterruptGeneration(presenceProjectionRef.current, active.id)) {
      applyPresenceEvent({ type: "generation", epoch: active.id, state: "interrupted" });
    }
    active.controller.abort();
    if (speechSessionRef.current?.generation === active.id) {
      speechSessionRef.current.queue.cancel();
      speechSessionRef.current = null;
    }
    activeRequestRef.current = null;
    if (!mountedRef.current) {
      return;
    }
    dispatchMessages({
      type: "cancel",
      assistantId: active.assistantId,
      error: "生成已取消，以上内容可能不完整。"
    });
    setRequestStatus("idle");
  }

  function stopSpeech(): void {
    recordChatTiming(timingRef, { stopRequestedAt: performance.now() });
    const epoch = speechSessionRef.current?.generation ?? presenceProjectionRef.current.epoch;
    if (epoch) applyPresenceEvent({ type: "speech-cancelled", epoch });
    speechSessionRef.current?.queue.cancel();
    speechSessionRef.current = null;
    if (mountedRef.current) setVoicePlaybackStatus("stopped");
  }

  return (
    <PageShell title={t("Chat")} subtitle="Send text turns through the persistent Runtime stream.">
      <div className="grid grid-cols-[1fr_280px] gap-4">
        <Panel title={t("Chat History")} actions={<Pill status={requestStatus} />}>
          <div className="h-[420px] overflow-auto rounded-md border border-ink-100 bg-ink-50 p-3">
            {historyError && <p role="status">{t("Unable to load chat history. Retrying…")}</p>}
            {messages.length === 0 ? (
              <EmptyState title={t("No chat yet")} message={t("Send a message to exercise the runtime.")} />
            ) : (
              <div className="space-y-3">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-md border p-3 ${message.role === "user" ? "border-cyan-100 bg-white" : "border-ink-200 bg-white"}`}
                  >
                    <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase text-ink-500">
                      <span>{message.role}</span>
                      {message.role === "assistant" && message.status && (
                        <span aria-live="polite">{t(chatStatusLabel(message.status))}</span>
                      )}
                    </div>
                    <ChatMessageContent role={message.role} content={message.content} />
                    {message.error && (
                      <div className="mt-2 text-xs text-red-700" role="alert">
                        {message.error}
                      </div>
                    )}
                    {message.traceId && (
                      <div className="mt-2 font-mono text-xs text-ink-500">
                        traceId: {message.traceId}
                      </div>
                    )}
                    {message.role === "user" && message.useMemory !== undefined && (
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink-500">
                        <span>{t("readMemory:")}{" "}{message.readMemory ? "true" : "false"}</span>
                        <span>{t("writeMemory:")}{" "}{message.writeMemory ? "true" : "false"}</span>
                        <span>{t("voice output:")}{" "}{message.voiceOutput ? t("enabled") : t("disabled")}</span>
                      </div>
                    )}
                    {message.role === "assistant" && (
                      <ProviderMetadataSummary provider={message.provider} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {error && <Notice tone="error" title={t("Send failed")} message={error} />}
          {lastTraceId && (
            <Notice
              tone="info"
              title={t("Latest trace")}
              message={t("{0}. Open Prompt Preview to inspect the generated prompt for the latest turn.", lastTraceId)}
            />
          )}
          <div className="mt-3 flex gap-2">
            <textarea
              className="field min-h-20"
              placeholder={t("Type a runtime test message")}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (shouldSubmitChatKey(event)) {
                  event.preventDefault();
                  void send();
                }
              }}
              aria-label={t("Chat message")}
            />
            {requestStatus === "sending" && activeRequestRef.current ? (
              <button
                type="button"
                className="button-secondary h-20 w-24"
                onClick={stopGeneration}
                aria-label={t("Stop generating")}
              >{t("Stop")}</button>
            ) : (
              <button
                type="button"
                className="button-primary h-20 w-24"
                disabled={Boolean(activeRequestRef.current) || !input.trim()}
                onClick={() => void send()}
                aria-label={t("Send message")}
              >{t("Send")}</button>
            )}
            {(voicePlaybackStatus === "synthesizing" || voicePlaybackStatus === "playing") && (
              <button
                type="button"
                className="button-secondary h-20 w-24"
                onClick={stopSpeech}
                aria-label={t("Stop speech")}
              >{t("Stop speech")}</button>
            )}
          </div>
          {voiceOutput && voicePlaybackStatus !== "idle" && (
            <div className="mt-2 text-xs text-ink-500" aria-live="polite">
              {t(dashboardVoicePlaybackStatusLabel(voicePlaybackStatus, actualPlaybackActive))}
            </div>
          )}
        </Panel>
        <div className="space-y-4">
          <Panel title="Lumi">
            <LumiCanvas
              ref={lumiRef}
              requestedProjection={presence}
              onModelLifecycle={setModelLifecycle}
              className="h-[420px] rounded-md bg-ink-900"
            />
          </Panel>
          <Panel title={t("Turn Options")}>
            <div className="space-y-4">
              <Field label={t("Session ID")}>
                <input
                  className="field"
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                />
              </Field>
              <Toggle
                label={t("Read Memory")}
                checked={readMemory}
                onChange={setReadMemory}
                note={t("Controls retrieval and prompt injection.")}
              />
              <Toggle
                label={t("Write Memory")}
                checked={writeMemory}
                onChange={setWriteMemory}
                note={t("Controls whether this turn can create runtime memory.")}
              />
              <Toggle
                label={t("Prompt Preview")}
                checked={promptPreview}
                onChange={setPromptPreview}
                note={t("The latest prompt preview remains available in the Prompt page.")}
              />
              <Toggle
                label={t("TTS output")}
                checked={voiceOutput}
                onChange={setVoiceOutput}
                note={t("Synthesizes sentence segments locally while the text stream is arriving.")}
              />
              <div className="rounded-md border border-ink-100 bg-ink-50 p-3">
                <div className="label mb-2">{t("Outgoing Payload")}</div>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-700">
                  {JSON.stringify(outgoingPayload, null, 2)}
                </pre>
              </div>
              <p className="text-xs leading-5 text-ink-500">{t("Chat uses the persistent SSE endpoint. Refreshing the page does not restore chat history yet because no session-history API is available.")}</p>
            </div>
          </Panel>
        </div>
      </div>
    </PageShell>
  );
}

function createChatMessageId(prefix: string): string {
  chatMessageSequence += 1;
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? chatMessageSequence}`;
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
function ProviderMetadataSummary(props: {
  provider?: ProviderCallMetadata | string | undefined;
}): JSX.Element {
  const provider = props.provider;
  if (!provider) {
    return <></>;
  }

  if (typeof provider === "string") {
    return <div className="mt-2 text-xs text-ink-500">{t("provider:")}{" "}{provider}</div>;
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink-500">
      <span
        className={`rounded-full px-2 py-0.5 font-semibold ${
          provider.mock ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
        }`}
      >
        {provider.mock ? "MOCK MODE" : t("REAL PROVIDER / {0}", provider.name)}
      </span>
      {provider.name && <span>{t("provider:")}{" "}{provider.name}</span>}
      {provider.model && <span>{t("model:")}{" "}{provider.model}</span>}
      {provider.latencyMs !== undefined && (
        <span>{t("latency:")}{" "}{formatLatency(provider.latencyMs)}</span>
      )}
      {provider.healthStatus && <span>{t("health:")}{" "}{provider.healthStatus}</span>}
      {provider.tokenUsage && <span>{t("tokens:")}{" "}{formatTokenUsage(provider.tokenUsage)}</span>}
      {provider.mock && (
        <span className="basis-full text-amber-700">{t("Configure Chat in Product configuration (Provider → Model → Capability Route), or restart the server.")}</span>
      )}
    </div>
  );
}
