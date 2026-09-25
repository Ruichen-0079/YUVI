import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBODIED_PRESENTATION_REQUEST_7AD_VERSION } from "@companion/protocol";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

const mockState = vi.hoisted(() => ({
  buses: [] as MockCompanionBus[],
  sockets: [] as FakeWebSocket[],
  subscribeProactiveLive: vi.fn(async () => undefined)
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor(public readonly url: string) {
    mockState.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }
}

class MockCompanionBus {
  readonly posted: unknown[] = [];
  private readonly listeners = new Set<(message: unknown) => void>();

  constructor(readonly role: "main" | "companion") {
    mockState.buses.push(this);
  }

  post(message: unknown): void {
    this.posted.push(message);
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }

  close(): void {
    this.listeners.clear();
  }
}

vi.mock("./companion-bus.js", () => ({ CompanionBus: MockCompanionBus }));

vi.mock("./api/client.js", () => ({
  ApiError: class ApiError extends Error {},
  apiClient: {
    streamMessage: vi.fn(),
    streamProactiveTurn: vi.fn(),
    subscribeProactiveLive: mockState.subscribeProactiveLive,
    projectProactiveConsent: vi.fn(async () => ({ ok: true, applied: true, state: "READY" })),
    createDashboardWebSocket: () => new FakeWebSocket("ws://test/ws?dashboard=true")
  }
}));

vi.mock("./tauri-window.js", () => ({
  controlCompanionWindow: vi.fn(),
  controlWebUIWindow: vi.fn(),
  isTauriRuntime: () => true
}));

vi.mock("./service-supervisor-client.js", () => ({
  isServiceSupervisorAvailable: () => false,
  subscribeServiceStatusState: vi.fn()
}));

vi.mock("./service-status-panel.js", () => ({ ServiceStatusPanel: () => null }));
vi.mock("./user-settings-panel.js", () => ({ UserSettingsPanel: () => null }));
vi.mock("./voice-output.js", () => ({
  readVoiceOutputPreference: () => true,
  writeVoiceOutputPreference: vi.fn(),
  VOICE_OUTPUT_STORAGE_KEY: "yuvi.main.voiceOutput"
}));

vi.mock("./user-settings-client.js", () => ({
  fetchUserSettings: vi.fn(async () => ({
    loadError: null,
    revision: 1,
    settings: {
      proactive: { enabled: true },
      tts: { enabled: true, mode: "external" },
      memory: { enabled: true }
    }
  })),
  subscribeUserSettingsChanged: vi.fn(() => () => undefined)
}));

vi.mock("./markdown-message.js", async () => {
  const React = await import("react");
  return {
    ChatMessageContent: ({ content }: { content: string }) =>
      React.createElement("span", null, content)
  };
});

vi.mock("./surface-ui.js", async () => {
  const React = await import("react");
  const Slot = ({ children }: { children?: import("react").ReactNode }) =>
    React.createElement("div", null, children);
  return {
    EmptyState: Slot,
    Field: Slot,
    Notice: Slot,
    Panel: Slot,
    Pill: Slot,
    Toggle: Slot
  };
});

import { installFakeDom } from "./test-dom.js";

afterEach(() => {
  mockState.buses.length = 0;
  mockState.sockets.length = 0;
  mockState.subscribeProactiveLive.mockReset();
});

function validRequest() {
  return {
    version: EMBODIED_PRESENTATION_REQUEST_7AD_VERSION,
    effectId: "runtime-effect:main-ws:1",
    behavior: {
      version: "embodied-behavior-7b.v1" as const,
      behavior: {
        version: "embodied-behavior-7a.v1" as const,
        kind: "EXPRESSION" as const,
        cause: {
          kind: "character" as const,
          reference: "character-decision:main-ws:1"
        },
        intent: "soft-smile" as const
      },
      sourceInstance: {
        reference: "character-proposal:main-ws:1",
        createdAtMs: 1000
      },
      correlation: {
        kind: "turn" as const,
        reference: "turn:main-ws:1"
      }
    }
  };
}

describe("MainPage embodied Presentation product-path forward", () => {
  it.each([false, true])("forwards on the live socket only (StrictMode=%s)", async (strict) => {
    mockState.subscribeProactiveLive.mockResolvedValue(undefined);
    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        const element = createElement((await import("./main-page.js")).MainPage);
        root.render(strict ? createElement(StrictMode, null, element) : element);
        await Promise.resolve();
        await Promise.resolve();
      });

      const bus = mockState.buses.at(-1);
      expect(bus?.role).toBe("main");
      const socket = mockState.sockets.at(-1);
      expect(socket).toBeTruthy();

      await act(async () => {
        for (const candidate of mockState.sockets)
          candidate.emit("message", {
            data: JSON.stringify({
              id: "evt-main-presentation-1",
              traceId: "trace-main-presentation-1",
              type: "runtime.embodied.presentation.request",
              timestamp: new Date().toISOString(),
              payload: validRequest()
            })
          });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        bus?.posted.filter(
          (message) => (message as { kind: string }).kind === "embodied-presentation-request"
        )
      ).toHaveLength(1);
      expect(bus?.posted).toContainEqual({
        kind: "embodied-presentation-request",
        request: validRequest()
      });
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });
});
