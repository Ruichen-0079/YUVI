import {
  AccountedPresentationRequestSchema,
  type AccountedPresentationRequest
} from "@companion/protocol";
import type { SpeechSegmentSeal } from "@companion/protocol";
import type { SpeechQueueState } from "./speech-queue.js";
import type {
  ProactiveTurnAdmission,
  ProactiveTurnAdmissionDecision
} from "./proactive-turn-admission.js";
import {
  createEmbodiedPresentationOutcomeReport,
  createEmbodiedPresentationRequest,
  type EmbodiedPresentationRequest,
  type EmbodiedPresentationOutcomeReport
} from "@companion/protocol";

/**
 * Minimal cross-window bus for the YUVI desktop split.
 *
 * The main window owns chat input and the text stream; the companion window
 * exclusively owns Lumi, the speech queue, audio playback and the Web Audio
 * analyser. Messages travel main -> companion (speech commands) and
 * companion -> main (speech status).
 *
 * Transport: BroadcastChannel works across same-origin browser tabs and
 * across Tauri v2 windows, which share one WebView2 environment and origin.
 * No Tauri IPC permissions are required for this prototype.
 */

export type CompanionBusRole = "main" | "companion";

export type CompanionGenerationState = "listening" | "thinking" | "idle" | "interrupted";
export type CompanionPlaybackState = "started" | "ended" | "stopped" | "error";
export type CompanionTtsConfiguration = {
  enabled: boolean;
  mode: "managed" | "external";
};

export type CompanionProactiveTextRequest = {
  kind: "proactive-text-request";
  decisionId: string;
  modality: "text";
};

export type CompanionProactiveTextAdmissionResult = {
  kind: "proactive-text-admission-result";
  decisionId: string;
} & ProactiveTurnAdmission;

export type CompanionBusMessage =
  | { kind: "user-gesture" }
  | { kind: "start-generation"; requestId: string; sessionId: string }
  | { kind: "voice-enabled"; enabled: boolean }
  | { kind: "tts-config"; config: CompanionTtsConfiguration | null }
  | {
      kind: "speak";
      requestId: string;
      sequence: number;
      text: string;
      language: string;
      seal?: SpeechSegmentSeal;
    }
  | { kind: "speech-end"; requestId: string }
  | { kind: "stop-speech"; requestId: string }
  | { kind: "generation-state"; requestId: string; state: CompanionGenerationState }
  | { kind: "companion-ready" }
  | {
      kind: "playback-status";
      requestId: string;
      segmentSequence: number;
      state: CompanionPlaybackState;
    }
  | { kind: "speech-status"; requestId: string; state: SpeechQueueState }
  | { kind: "accounted-presentation-request"; envelope: AccountedPresentationRequest }
  | { kind: "embodied-presentation-request"; request: EmbodiedPresentationRequest }
  | { kind: "embodied-presentation-outcome"; report: EmbodiedPresentationOutcomeReport }
  | CompanionProactiveTextRequest
  | CompanionProactiveTextAdmissionResult;

type WireMessage = { from: CompanionBusRole; message: CompanionBusMessage };

const busChannelName = "yuvi-companion-bus-v1";

const knownKinds = new Set<string>([
  "user-gesture",
  "start-generation",
  "voice-enabled",
  "tts-config",
  "speak",
  "speech-end",
  "stop-speech",
  "generation-state",
  "companion-ready",
  "playback-status",
  "speech-status",
  "accounted-presentation-request",
  "embodied-presentation-request",
  "embodied-presentation-outcome",
  "proactive-text-request",
  "proactive-text-admission-result"
]);

export class CompanionBus {
  private readonly channel: BroadcastChannel | null;
  private readonly listeners = new Set<(message: CompanionBusMessage) => void>();
  private readonly onWireMessage: (event: MessageEvent<WireMessage>) => void;

  constructor(private readonly role: CompanionBusRole) {
    this.channel =
      typeof BroadcastChannel === "function" ? new BroadcastChannel(busChannelName) : null;
    this.onWireMessage = (event) => {
      const payload = event.data;
      if (!isWireMessage(payload)) return;
      if (payload.from === this.role) return;
      const listeners = Array.from(this.listeners);
      for (const listener of listeners) listener(payload.message);
    };
    this.channel?.addEventListener("message", this.onWireMessage);
  }

  post(message: CompanionBusMessage): void {
    this.channel?.postMessage({ from: this.role, message } satisfies WireMessage);
  }

  subscribe(listener: (message: CompanionBusMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.channel?.removeEventListener("message", this.onWireMessage);
    this.channel?.close();
    this.listeners.clear();
  }
}

export function isCompanionBusMessage(value: unknown): value is CompanionBusMessage {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !knownKinds.has(kind)) return false;
  const message = value as Record<string, unknown>;
  switch (kind) {
    case "user-gesture":
    case "companion-ready":
      return Object.keys(message).every((key) => key === "kind");
    case "voice-enabled":
      return typeof message["enabled"] === "boolean";
    case "tts-config": {
      const config = message["config"];
      if (config === null) return true;
      if (typeof config !== "object" || config === null) return false;
      const candidate = config as Record<string, unknown>;
      return (
        typeof candidate["enabled"] === "boolean" &&
        (candidate["mode"] === "managed" || candidate["mode"] === "external")
      );
    }
    case "start-generation":
      return isNonEmptyString(message["requestId"]) && isNonEmptyString(message["sessionId"]);
    case "speak":
      return (
        isNonEmptyString(message["requestId"]) &&
        isNonNegativeInteger(message["sequence"]) &&
        typeof message["text"] === "string" &&
        typeof message["language"] === "string"
      );
    case "speech-end":
    case "stop-speech":
      return isNonEmptyString(message["requestId"]);
    case "generation-state":
      return isNonEmptyString(message["requestId"]) && isGenerationState(message["state"]);
    case "playback-status":
      return (
        isNonEmptyString(message["requestId"]) &&
        isNonNegativeInteger(message["segmentSequence"]) &&
        isPlaybackState(message["state"])
      );
    case "speech-status":
      return isNonEmptyString(message["requestId"]) && isSpeechQueueState(message["state"]);
    case "accounted-presentation-request":
      return (
        hasExactKeys(message, ["kind", "envelope"]) &&
        AccountedPresentationRequestSchema.safeParse(message["envelope"]).success
      );
    case "embodied-presentation-request":
      try {
        if (!hasExactKeys(message, ["kind", "request"])) return false;
        createEmbodiedPresentationRequest(message["request"]);
        return true;
      } catch {
        return false;
      }
    case "embodied-presentation-outcome":
      try {
        if (!hasExactKeys(message, ["kind", "report"])) return false;
        createEmbodiedPresentationOutcomeReport(message["report"]);
        return true;
      } catch {
        return false;
      }
    case "proactive-text-request":
      return (
        hasExactKeys(message, ["kind", "decisionId", "modality"]) &&
        isNonEmptyString(message["decisionId"]) &&
        message["modality"] === "text"
      );
    case "proactive-text-admission-result":
      return (
        hasExactKeys(message, ["kind", "decisionId", "decision", "reason"]) &&
        isNonEmptyString(message["decisionId"]) &&
        isProactiveTurnAdmissionResult(message["decision"], message["reason"])
      );
  }
  return false;
}

function hasExactKeys(message: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(message);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isGenerationState(value: unknown): value is CompanionGenerationState {
  return (
    value === "listening" || value === "thinking" || value === "idle" || value === "interrupted"
  );
}

function isPlaybackState(value: unknown): value is CompanionPlaybackState {
  return value === "started" || value === "ended" || value === "stopped" || value === "error";
}

function isSpeechQueueState(value: unknown): value is SpeechQueueState {
  return (
    value === "idle" ||
    value === "synthesizing" ||
    value === "playing" ||
    value === "stopped" ||
    value === "error"
  );
}

function isProactiveTurnAdmissionResult(
  decision: unknown,
  reason: unknown
): decision is ProactiveTurnAdmissionDecision {
  if (decision === "accepted") return reason === "runtime-admitted";
  if (decision === "denied") {
    return (
      reason === "consent-disabled" ||
      reason === "consent-unavailable" ||
      reason === "suppressed" ||
      reason === "not-eligible" ||
      reason === "stale-revision" ||
      reason === "execution-busy"
    );
  }
  return false;
}

function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WireMessage>;
  if (candidate.from !== "main" && candidate.from !== "companion") return false;
  return isCompanionBusMessage(candidate.message);
}
