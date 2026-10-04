import type { SpeechSegmentSeal } from "@companion/protocol";
import { apiClient, type TTSResponse } from "./api/client.js";
import type { SpeechSegmentIdentity } from "./speech-identity.js";

export type SpeechQueueItem = {
  seal?: SpeechSegmentSeal;
  text: string;
  language: string;
};

export type SpeechQueueState = "idle" | "synthesizing" | "playing" | "stopped" | "error";

/**
 * Per-item lifecycle used for idempotent accounting: every enqueued segment
 * moves through a subset of these states and always reaches a terminal state
 * (completed / cancelled / failed) so a finished turn never leaves pending
 * fragments behind.
 */
export type SpeechItemState =
  | "queued"
  | "synthesizing"
  | "ready"
  | "playing"
  | "completed"
  | "cancelled"
  | "failed";

export type SpeechSynthesizer = (
  item: SpeechQueueItem,
  signal: AbortSignal,
  segment?: SpeechSegmentIdentity
) => Promise<TTSResponse>;

export type SpeechPlayer = (
  output: TTSResponse,
  signal: AbortSignal,
  lifecycle?: SpeechPlayerLifecycle
) => Promise<void>;

export type SpeechQueueCallbacks = {
  onState?: (state: SpeechQueueState) => void;
  onError?: (error: unknown) => void;
  onItemState?: (segment: SpeechSegmentIdentity, state: SpeechItemState) => void;
  onSynthesisCompleted?: (item: PendingSpeech) => void;
  onPlaybackEvent?: (event: SpeechPlaybackEvent) => void;
};

export type SpeechPlaybackEventInput =
  | { type: "audioElementAttached"; audio: HTMLAudioElement }
  | { type: "playbackStarted"; audio: HTMLAudioElement }
  | { type: "playbackEnded"; audio: HTMLAudioElement }
  | { type: "playbackStopped"; audio: HTMLAudioElement }
  | { type: "playbackError"; audio: HTMLAudioElement; error: unknown }
  | { type: "audioElementDetached"; audio: HTMLAudioElement };

export type SpeechPlaybackEvent = SpeechPlaybackEventInput & {
  /** Queue-local scheduling order. Not the product segment identity. */
  sequence: number;
  segment: SpeechSegmentIdentity;
};

export type SpeechPlayerLifecycle = {
  sequence: number;
  segment: SpeechSegmentIdentity;
  emit(event: SpeechPlaybackEventInput): void;
};

let nextSpeechAudioDebugId = 1;
const speechAudioDebugIds = new WeakMap<HTMLAudioElement, number>();
const speechAudioData = new WeakMap<HTMLAudioElement, Uint8Array>();

/**
 * Ownership boundary: lip-sync may observe a copy of synthesized bytes.
 * Do not share the playback ArrayBuffer or Blob backing store as an
 * optimization — decodeAudioData detaches its argument, and observers must
 * never be able to mutate or reroute audible output.
 */
export function getSpeechAudioData(audio: HTMLAudioElement): ArrayBuffer | null {
  return speechAudioData.get(audio)?.slice().buffer ?? null;
}

/** Development-only identity for correlating queue, playback and analyser logs. */
export function getSpeechAudioDebugId(audio: HTMLAudioElement): number {
  const existing = speechAudioDebugIds.get(audio);
  if (existing !== undefined) return existing;
  const id = nextSpeechAudioDebugId++;
  speechAudioDebugIds.set(audio, id);
  return id;
}

export type PendingSpeech = {
  sequence: number;
  segment: SpeechSegmentIdentity;
  item: SpeechQueueItem;
};

/**
 * Synthesis and playback are separate ordered stages. Synthesis is limited to
 * one in-flight request, but it does not wait for the previous audio to end;
 * playback still waits for the next sequence so audio can never be reordered.
 */
export class SpeechPlaybackQueue {
  private readonly pending: PendingSpeech[] = [];
  private readonly ready: Array<{
    sequence: number;
    segment: SpeechSegmentIdentity;
    output: TTSResponse;
  }> = [];
  private readonly controller = new AbortController();
  private nextSequence = 0;
  private synthesisRunning = false;
  private playbackRunning = false;
  private accepting = true;
  private synthesizingItem: { sequence: number; segment: SpeechSegmentIdentity } | null = null;
  private playingItem: { sequence: number; segment: SpeechSegmentIdentity } | null = null;

  constructor(
    private readonly synthesize: SpeechSynthesizer,
    private readonly play: SpeechPlayer,
    private readonly callbacks: SpeechQueueCallbacks = {}
  ) {}

  enqueue(item: SpeechQueueItem, segment: SpeechSegmentIdentity): void {
    if (!this.accepting || !item.text.trim()) return;
    const sequence = this.nextSequence++;
    const pending = { sequence, segment, item };
    this.pending.push(pending);
    this.callbacks.onItemState?.(pending.segment, "queued");
    void this.pumpSynthesis();
    void this.pumpPlayback();
  }

  finish(): void {
    this.accepting = false;
    this.maybeIdle();
  }

  cancel(): void {
    this.accepting = false;
    if (!this.controller.signal.aborted) {
      for (const pending of this.pending) {
        this.callbacks.onItemState?.(pending.segment, "cancelled");
      }
      for (const ready of this.ready) {
        this.callbacks.onItemState?.(ready.segment, "cancelled");
      }
      if (this.synthesizingItem) {
        this.callbacks.onItemState?.(this.synthesizingItem.segment, "cancelled");
      }
      if (this.playingItem) {
        this.callbacks.onItemState?.(this.playingItem.segment, "cancelled");
      }
    }
    this.pending.length = 0;
    this.ready.length = 0;
    this.synthesizingItem = null;
    this.playingItem = null;
    this.controller.abort();
    this.callbacks.onState?.("stopped");
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private async pumpSynthesis(): Promise<void> {
    if (this.synthesisRunning) return;
    this.synthesisRunning = true;
    try {
      while (this.pending.length > 0 && !this.controller.signal.aborted) {
        const pending = this.pending.shift();
        if (!pending) continue;
        this.synthesizingItem = { sequence: pending.sequence, segment: pending.segment };
        this.callbacks.onState?.("synthesizing");
        this.callbacks.onItemState?.(pending.segment, "synthesizing");
        let output: TTSResponse;
        try {
          output = await this.synthesize(pending.item, this.controller.signal, pending.segment);
        } catch (error) {
          this.synthesizingItem = null;
          if (this.controller.signal.aborted) break;
          this.callbacks.onItemState?.(pending.segment, "failed");
          this.callbacks.onState?.("error");
          this.callbacks.onError?.(error);
          continue;
        }
        this.synthesizingItem = null;
        if (this.controller.signal.aborted) break;
        this.ready.push({ sequence: pending.sequence, segment: pending.segment, output });
        this.callbacks.onItemState?.(pending.segment, "ready");
        this.callbacks.onSynthesisCompleted?.(pending);
        void this.pumpPlayback();
      }
    } finally {
      this.synthesisRunning = false;
      this.maybeIdle();
    }
  }

  private async pumpPlayback(): Promise<void> {
    if (this.playbackRunning) return;
    this.playbackRunning = true;
    try {
      // Always play the lowest ready sequence next so concurrent synthesis
      // completion cannot reorder audio (sequence 0 must always lead).
      while (!this.controller.signal.aborted) {
        if (this.ready.length === 0) break;
        this.ready.sort((left, right) => left.sequence - right.sequence);
        const next = this.ready.shift();
        if (!next) break;
        this.playingItem = { sequence: next.sequence, segment: next.segment };
        this.callbacks.onState?.("playing");
        this.callbacks.onItemState?.(next.segment, "playing");
        try {
          await this.play(next.output, this.controller.signal, {
            sequence: next.sequence,
            segment: next.segment,
            emit: (event) =>
              this.callbacks.onPlaybackEvent?.({
                ...event,
                sequence: next.sequence,
                segment: next.segment
              } as SpeechPlaybackEvent)
          });
        } catch (error) {
          this.playingItem = null;
          if (this.controller.signal.aborted) break;
          // First play failure (including autoplay policy) is a terminal
          // failed state for that segment — never treat it as completed.
          this.callbacks.onItemState?.(next.segment, "failed");
          this.callbacks.onState?.("error");
          this.callbacks.onError?.(error);
          continue;
        }
        this.playingItem = null;
        if (!this.controller.signal.aborted)
          this.callbacks.onItemState?.(next.segment, "completed");
      }
    } finally {
      this.playbackRunning = false;
      this.maybeIdle();
    }
  }

  private maybeIdle(): void {
    if (
      !this.accepting &&
      !this.controller.signal.aborted &&
      this.pending.length === 0 &&
      this.ready.length === 0 &&
      !this.synthesisRunning &&
      !this.playbackRunning
    ) {
      this.callbacks.onState?.("idle");
    }
  }
}

export function detectSpeechLanguage(text: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  return "en";
}

export type BrowserPlaybackAccounting = {
  authorize(
    output: TTSResponse,
    signal: AbortSignal
  ): Promise<{
    report(
      observation: "ATTACHED" | "PLAYING" | "COMPLETED" | "INTERRUPTED" | "ERROR"
    ): Promise<void>;
  }>;
};
const canonicalPlayback: BrowserPlaybackAccounting = {
  async authorize(output, signal) {
    if (!output.media || signal.aborted)
      throw Error("Active sealed audio is required for playback.");
    const permission = await apiClient.mediaPermission({ ...output.media, kind: "PLAYBACK" });
    if (Date.parse(permission.expiresAt) <= Date.now()) throw Error("Playback permission expired.");
    if (signal.aborted) throw new DOMException("Speech playback cancelled.", "AbortError");
    return { report: (observation) => apiClient.reportMedia({ permission, observation }) };
  }
};
export function createBrowserSpeechPlayer(
  accounting: BrowserPlaybackAccounting = canonicalPlayback
): SpeechPlayer {
  let current: HTMLAudioElement | null = null;
  return async (output, signal, lifecycle) => {
    const permit = await accounting.authorize(output, signal);
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Speech playback cancelled.", "AbortError"));
        return;
      }
      const bytes = Uint8Array.from(atob(output.audioBase64), (char) => char.charCodeAt(0));
      const playbackBytes = bytes.slice();
      const url = URL.createObjectURL(
        new Blob([playbackBytes], { type: output.mimeType || "audio/wav" })
      );
      const audio = new Audio(url);
      // Separate copy from the blob URL above. This is an ownership
      // boundary, not a cache: lip-sync must not share mutable playback data.
      speechAudioData.set(audio, bytes.slice());
      // Keep a real media element in the companion document. This makes the
      // WebView2 output path deterministic and gives us an explicit cleanup
      // point; the element stays hidden and never shows native controls.
      audio.preload = "auto";
      audio.autoplay = false;
      audio.controls = false;
      audio.volume = 1;
      audio.setAttribute?.("aria-hidden", "true");
      if (typeof document !== "undefined" && document.body) {
        if (audio.style) audio.style.display = "none";
        document.body.appendChild(audio);
      }
      getSpeechAudioDebugId(audio);
      current = audio;
      let settled = false;
      const cleanup = () => {
        speechAudioData.delete(audio);
        URL.revokeObjectURL(url);
        audio.onplaying = null;
        audio.onended = null;
        audio.onerror = null;
        audio.removeAttribute?.("src");
        audio.load?.();
        audio.remove?.();
        signal.removeEventListener("abort", abort);
        if (current === audio) current = null;
      };
      const emit = (event: SpeechPlaybackEventInput) => lifecycle?.emit(event);
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        emit({ type: "audioElementDetached", audio });
        error ? reject(error) : resolve();
      };
      const abort = () => {
        audio.pause();
        void permit.report("INTERRUPTED").catch(() => {});
        emit({ type: "playbackStopped", audio });
        finish(new DOMException("Speech playback cancelled.", "AbortError"));
      };
      audio.onplaying = () => {
        if (settled || signal.aborted) return;
        void permit.report("PLAYING").then(
          () => {
            if (!settled && !signal.aborted) emit({ type: "playbackStarted", audio });
          },
          () => {
            audio.pause();
            finish(new Error("Playback report was fenced."));
          }
        );
      };
      audio.onended = () => {
        void permit.report("COMPLETED").catch(() => {});
        emit({ type: "playbackEnded", audio });
        finish();
      };
      audio.onerror = () => {
        const error = new Error("Speech playback failed.");
        void permit.report("ERROR").catch(() => {});
        emit({ type: "playbackError", audio, error });
        finish(error);
      };
      void permit.report("ATTACHED").catch(() => {});
      emit({ type: "audioElementAttached", audio });
      signal.addEventListener("abort", abort, { once: true });
      void audio
        .play()
        .then(() => {
          /* play acceptance is not device PLAYING evidence. */
        })
        .catch((error) => {
          if (settled) return;
          void permit.report("ERROR").catch(() => {});
          emit({ type: "playbackError", audio, error });
          finish(error);
        });
    });
  };
}
