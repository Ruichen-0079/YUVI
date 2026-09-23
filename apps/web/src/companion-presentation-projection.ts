import type { LumiModelIdentity, LumiModelLifecycle } from "./lumi-live2d.js";

export type Live2DRendererStatus = "no_model" | "loading" | "ready" | "failed" | "unavailable";

/**
 * Read-only projection of the renderer owner. Only READY carries an active
 * model identity; loading and failed models are explicitly requests instead.
 */
export type CompanionRendererPresentation =
  | { status: "no_model" }
  | { status: "loading"; requestedModel?: LumiModelIdentity }
  | { status: "ready"; activeModel: LumiModelIdentity }
  | { status: "failed"; requestedModel?: LumiModelIdentity }
  | { status: "unavailable" };

export function deriveCompanionRendererPresentation(
  lifecycle: LumiModelLifecycle | null,
  activeModel: LumiModelIdentity | null,
  requestedModel: LumiModelIdentity | null = null
): CompanionRendererPresentation {
  switch (lifecycle) {
    case "loading":
      return requestedModel ? { status: "loading", requestedModel } : { status: "loading" };
    case "ready":
      return activeModel && isLumiModelIdentity(activeModel)
        ? { status: "ready", activeModel }
        : { status: "unavailable" };
    case "failed":
      return requestedModel ? { status: "failed", requestedModel } : { status: "failed" };
    case "disposed":
    case null:
      return { status: "unavailable" };
  }
}

export function isCompanionRendererPresentation(
  value: unknown
): value is CompanionRendererPresentation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate["status"]) {
    case "no_model":
    case "unavailable":
      return hasOnlyKeys(candidate, ["status"]);
    case "loading":
    case "failed":
      return (
        hasOnlyKeys(candidate, ["status", "requestedModel"]) &&
        (candidate["requestedModel"] === undefined ||
          isLumiModelIdentity(candidate["requestedModel"]))
      );
    case "ready":
      return (
        hasOnlyKeys(candidate, ["status", "activeModel"]) &&
        isLumiModelIdentity(candidate["activeModel"])
      );
    default:
      return false;
  }
}

function isLumiModelIdentity(value: unknown): value is LumiModelIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    hasOnlyKeys(candidate, ["id", "name"]) &&
    typeof candidate["id"] === "string" &&
    candidate["id"].trim().length > 0 &&
    typeof candidate["name"] === "string" &&
    candidate["name"].trim().length > 0
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

type ProjectionWireMessage =
  | { kind: "request" }
  | { kind: "state"; state: CompanionRendererPresentation };

const channelName = "yuvi-companion-presentation-v1";

export class CompanionPresentationProjectionChannel {
  private readonly channel: BroadcastChannel | null;
  private readonly stateListeners = new Set<(state: CompanionRendererPresentation) => void>();
  private readonly requestListeners = new Set<() => void>();
  private readonly onMessage = (event: MessageEvent<ProjectionWireMessage>): void => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.kind === "request") {
      for (const listener of Array.from(this.requestListeners)) listener();
      return;
    }
    if (message.kind === "state" && isCompanionRendererPresentation(message.state)) {
      for (const listener of Array.from(this.stateListeners)) listener(message.state);
    }
  };

  constructor() {
    this.channel =
      typeof BroadcastChannel === "function" ? new BroadcastChannel(channelName) : null;
    this.channel?.addEventListener("message", this.onMessage);
  }

  postState(state: CompanionRendererPresentation): void {
    this.channel?.postMessage({ kind: "state", state } satisfies ProjectionWireMessage);
  }

  requestState(): void {
    this.channel?.postMessage({ kind: "request" } satisfies ProjectionWireMessage);
  }

  subscribeState(listener: (state: CompanionRendererPresentation) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  subscribeRequests(listener: () => void): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  close(): void {
    this.channel?.removeEventListener("message", this.onMessage);
    this.channel?.close();
    this.stateListeners.clear();
    this.requestListeners.clear();
  }
}
