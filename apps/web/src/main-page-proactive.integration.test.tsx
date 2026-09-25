import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const mockState = vi.hoisted(() => ({
  buses: [] as MockCompanionBus[],
  streamProactiveTurn: vi.fn(),
  subscribeProactiveLive: vi.fn(),
  projectProactiveConsent: vi.fn(async () => ({ ok: true, applied: true, state: "READY" }))
}));

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
    reportSpeechPlaybackOutcome: vi.fn(async () => ({})),
    admitSpeechPlayback: vi.fn(async () => ({ effectId: "effect-test" })),
    streamProactiveTurn: mockState.streamProactiveTurn,
    subscribeProactiveLive: mockState.subscribeProactiveLive,
    projectProactiveConsent: mockState.projectProactiveConsent,
    // Main product path now opens a dashboard event stream; keep proactive
    // tests isolated by providing a no-op socket.
    createDashboardWebSocket: () => {
      const listeners = new Map<string, Set<(event: { data?: string }) => void>>();
      return {
        addEventListener(type: string, listener: (event: { data?: string }) => void) {
          const set = listeners.get(type) ?? new Set();
          set.add(listener);
          listeners.set(type, set);
        },
        removeEventListener(type: string, listener: (event: { data?: string }) => void) {
          listeners.get(type)?.delete(listener);
        },
        close() {}
      };
    }
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
  subscribeUserSettingsChanged: vi.fn((_listener: (event: unknown) => void) => () => undefined)
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

import { installFakeDom, readText } from "./test-dom.js";

afterEach(() => {
  mockState.buses.length = 0;
  mockState.streamProactiveTurn.mockReset();
  mockState.subscribeProactiveLive.mockReset();
  mockState.projectProactiveConsent.mockClear();
});

describe("MainPage proactive CompanionBus bridge", () => {
  it("projects only a current accepted SettingsView as READY", async () => {
    mockState.subscribeProactiveLive.mockImplementation(async () => undefined);
    const { fetchUserSettings } = await import("./user-settings-client.js");
    vi.mocked(fetchUserSettings).mockResolvedValueOnce({
      loadError: null,
      revision: 42,
      settings: {
        proactive: { enabled: true },
        tts: { enabled: true, mode: "external" },
        memory: { enabled: true }
      }
    } as never);
    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement((await import("./main-page.js")).MainPage));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockState.projectProactiveConsent).toHaveBeenCalledWith({
        state: "READY",
        revision: 42,
        enabled: true
      });
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("projects settings read failure as UNKNOWN_DENIED, never authored false", async () => {
    mockState.subscribeProactiveLive.mockImplementation(async () => undefined);
    const { fetchUserSettings } = await import("./user-settings-client.js");
    vi.mocked(fetchUserSettings).mockRejectedValueOnce(new Error("settings unavailable"));
    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement((await import("./main-page.js")).MainPage));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockState.projectProactiveConsent).toHaveBeenCalledWith({
        state: "UNKNOWN_DENIED",
        revisionFloor: 0
      });
      expect(mockState.projectProactiveConsent).not.toHaveBeenCalledWith(
        expect.objectContaining({ state: "READY", enabled: false })
      );
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("invalidates immediately on settings.changed and does not project a stale SettingsView", async () => {
    mockState.subscribeProactiveLive.mockImplementation(async () => undefined);
    const { fetchUserSettings, subscribeUserSettingsChanged } = await import(
      "./user-settings-client.js"
    );
    let resolveInitial!: (view: Awaited<ReturnType<typeof fetchUserSettings>>) => void;
    vi.mocked(fetchUserSettings).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitial = resolve;
      })
    );
    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement((await import("./main-page.js")).MainPage));
        await Promise.resolve();
      });
      const listener = vi.mocked(subscribeUserSettingsChanged).mock.calls.at(-1)?.[0];
      expect(listener).toBeDefined();
      vi.mocked(fetchUserSettings).mockResolvedValueOnce({
        loadError: null,
        revision: 3,
        settings: {
          proactive: { enabled: true },
          tts: { enabled: true, mode: "external" },
          memory: { enabled: true }
        }
      } as never);
      await act(async () => {
        listener?.({ revision: 4, changedSections: ["proactive"] } as Parameters<
          NonNullable<typeof listener>
        >[0]);
        await Promise.resolve();
        await Promise.resolve();
        resolveInitial({
          loadError: null,
          revision: 3,
          settings: {
            proactive: { enabled: true },
            tts: { enabled: true, mode: "external" },
            memory: { enabled: true }
          }
        } as never);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockState.projectProactiveConsent).toHaveBeenCalledWith({
        state: "UNKNOWN_DENIED",
        revisionFloor: 4
      });
      expect(mockState.projectProactiveConsent).not.toHaveBeenCalledWith(
        expect.objectContaining({ state: "READY" })
      );
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("does not let a companion opportunity start a Runtime proactive attempt", async () => {
    mockState.subscribeProactiveLive.mockImplementation(async () => undefined);

    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement((await import("./main-page.js")).MainPage));
        await Promise.resolve();
        await Promise.resolve();
      });

      const bus = mockState.buses[0];
      expect(bus?.role).toBe("main");
      await act(async () => {
        bus?.emit({
          kind: "proactive-text-request",
          decisionId: "decision-live",
          modality: "text"
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockState.streamProactiveTurn).not.toHaveBeenCalled();
      expect(bus?.posted).toContainEqual({
        kind: "proactive-text-admission-result",
        decisionId: "decision-live",
        decision: "denied",
        reason: "not-eligible"
      });
      expect(readText(dom.container)).not.toContain("proactive reply");
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("projects a Runtime-scheduled assistant-only reply and ignores NO_OP", async () => {
    mockState.subscribeProactiveLive.mockImplementation(async (_sessionId, options) => {
      options?.onEvent?.({
        type: "proactive-decision",
        decision: "NO_OP",
        sessionId: "default",
        traceId: "trace-no-op"
      });
      options?.onEvent?.({
        type: "proactive-decision",
        decision: "REQUEST_TEXT",
        sessionId: "default",
        traceId: "trace-proactive"
      });
      options?.onEvent?.({
        type: "text-delta",
        text: "proactive reply",
        messageId: "assistant-message",
        sessionId: "default",
        traceId: "trace-proactive"
      });
      options?.onEvent?.({
        type: "completed",
        content: "proactive reply",
        messageId: "assistant-message",
        sessionId: "default",
        traceId: "trace-proactive",
        provider: "mock"
      });
    });

    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement((await import("./main-page.js")).MainPage));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockState.subscribeProactiveLive).toHaveBeenCalled();
      expect(mockState.streamProactiveTurn).not.toHaveBeenCalled();
      expect(readText(dom.container)).toContain("proactive reply");
      expect(readText(dom.container)).not.toContain("assistant");
      expect(readText(dom.container)).not.toContain("user");
      expect(readText(dom.container)).not.toContain("trace-no-op");
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("still subscribes to Runtime-scheduled turns when the local settings toggle is off", async () => {
    const { fetchUserSettings } = await import("./user-settings-client.js");
    vi.mocked(fetchUserSettings).mockResolvedValueOnce({
      loadError: null,
      revision: 1,
      settings: {
        proactive: { enabled: false },
        tts: { enabled: true, mode: "external" },
        memory: { enabled: true }
      }
    } as never);
    mockState.subscribeProactiveLive.mockImplementation(async () => undefined);

    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement((await import("./main-page.js")).MainPage));
        await Promise.resolve();
        await Promise.resolve();
      });
      const bus = mockState.buses[0];
      await act(async () => {
        bus?.emit({
          kind: "proactive-text-request",
          decisionId: "decision-consent-off",
          modality: "text"
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockState.subscribeProactiveLive).toHaveBeenCalled();
      expect(mockState.streamProactiveTurn).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });
});


it("converges Main and Companion TTS after a WebUI settings change", async () => {
  mockState.subscribeProactiveLive.mockImplementation(async () => undefined);
  const { fetchUserSettings, subscribeUserSettingsChanged } = await import("./user-settings-client.js");
  const dom = installFakeDom();
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(dom.container as unknown as Element);
      root.render(createElement((await import("./main-page.js")).MainPage));
    });
    const listener = vi.mocked(subscribeUserSettingsChanged).mock.calls.at(-1)?.[0];
    expect(listener).toBeDefined();
    vi.mocked(fetchUserSettings).mockResolvedValueOnce({
      loadError: null, revision: 2,
      settings: {
        proactive: { enabled: true },
        tts: { enabled: false, mode: "external" },
        memory: { enabled: true }
      }
    } as Awaited<ReturnType<typeof fetchUserSettings>>);
    await act(async () => {
      listener?.({ revision: 2, changedSections: ["tts"] } as Parameters<NonNullable<typeof listener>>[0]);
    });
    expect(mockState.buses[0]?.posted).toContainEqual({
      kind: "tts-config", config: { enabled: false, mode: "external" }
    });
  } finally {
    await act(async () => root?.unmount());
    dom.restore();
  }
});

it("renders at least two intermediate assistant states before completed", async () => {
  const { apiClient } = await import("./api/client.js");
  mockState.subscribeProactiveLive.mockResolvedValue(undefined);
  let options!: Parameters<typeof apiClient.streamMessage>[1];
  let finish!: (value: Awaited<ReturnType<typeof apiClient.streamMessage>>) => void;
  vi.mocked(apiClient.streamMessage).mockImplementation((_input, incoming) => {
    options = incoming;
    return new Promise(resolve => { finish = resolve; });
  });
  const dom = installFakeDom();
  let root!: Root;
  const nodes = (node: import("./test-dom.js").FakeNode): import("./test-dom.js").FakeNode[] =>
    [node, ...node.childNodes.flatMap(nodes)];
  const props = (node: import("./test-dom.js").FakeNode): any =>
    (node as any)[Object.keys(node).find(key => key.startsWith("__reactProps$"))!];
  try {
    await act(async () => {
      root = createRoot(dom.container as unknown as Element);
      root.render(createElement((await import("./main-page.js")).MainPage));
    });
    await act(async () => {
      props(nodes(dom.container).find(node => node.tagName === "TEXTAREA")!).onChange({
        target: { value: "tell a story", style: {}, scrollHeight: 30 },
        currentTarget: { style: {}, scrollHeight: 30 }
      });
    });
    await act(async () => {
      props(nodes(dom.container).find(node => node.attributes["aria-label"] === "Send message")!).onClick();
    });
    const base = { traceId: "trace-stream-render", provider: "test", language: "en" };
    await act(async () => options?.onEvent?.({ ...base, type: "text-delta", text: "First visible" } as never));
    expect(readText(dom.container)).toContain("First visible");
    expect(readText(dom.container)).not.toContain("second visible");
    await act(async () => options?.onEvent?.({ ...base, type: "text-delta", text: ", second visible" } as never));
    expect(readText(dom.container)).toContain("First visible, second visible");
    expect(nodes(dom.container).some(node => node.attributes["aria-label"] === "Stop generating")).toBe(true);
    await act(async () => {
      const completed = { ...base, type: "completed" as const, content: "First visible, second visible" };
      options?.onEvent?.(completed as never);
      finish(completed as never);
    });
    expect(readText(dom.container)).toContain("First visible, second visible");
    expect(nodes(dom.container).some(node => node.attributes["aria-label"] === "Stop generating")).toBe(false);
  } finally {
    await act(async () => root?.unmount());
    dom.restore();
  }
});

it("renders a single-delta Character response verbatim without artificial chunking", async () => {
  const { apiClient } = await import("./api/client.js");
  mockState.subscribeProactiveLive.mockResolvedValue(undefined);
  let options!: Parameters<typeof apiClient.streamMessage>[1];
  let finish!: (value: Awaited<ReturnType<typeof apiClient.streamMessage>>) => void;
  vi.mocked(apiClient.streamMessage).mockImplementation((_input, incoming) => {
    options = incoming;
    return new Promise(resolve => { finish = resolve; });
  });
  const dom = installFakeDom();
  let root!: Root;
  const nodes = (node: import("./test-dom.js").FakeNode): import("./test-dom.js").FakeNode[] =>
    [node, ...node.childNodes.flatMap(nodes)];
  const props = (node: import("./test-dom.js").FakeNode): any =>
    (node as any)[Object.keys(node).find(key => key.startsWith("__reactProps$"))!];
  try {
    await act(async () => {
      root = createRoot(dom.container as unknown as Element);
      root.render(createElement((await import("./main-page.js")).MainPage));
    });
    await act(async () => {
      props(nodes(dom.container).find(node => node.tagName === "TEXTAREA")!).onChange({
        target: { value: "single reply", style: {}, scrollHeight: 30 },
        currentTarget: { style: {}, scrollHeight: 30 }
      });
    });
    await act(async () => {
      props(nodes(dom.container).find(node => node.attributes["aria-label"] === "Send message")!).onClick();
    });
    const base = { traceId: "trace-single-delta", provider: "test", language: "en" };
    const single = "Complete Character answer in one delta.";
    await act(async () => options?.onEvent?.({ ...base, type: "text-delta", text: single } as never));
    // Frontend must dispatch exactly what it receives: no split, no merge.
    expect(readText(dom.container)).toContain(single);
    await act(async () => {
      const completed = { ...base, type: "completed" as const, content: single };
      options?.onEvent?.(completed as never);
      finish(completed as never);
    });
    expect(readText(dom.container)).toContain(single);
  } finally {
    await act(async () => root?.unmount());
    dom.restore();
  }
});

it("releases a soft boundary after current-turn playback ends and rejects old feedback", async () => {
  const { apiClient } = await import("./api/client.js");
  mockState.subscribeProactiveLive.mockResolvedValue(undefined);
  let options!: Parameters<typeof apiClient.streamMessage>[1];
  let finish!: (value: Awaited<ReturnType<typeof apiClient.streamMessage>>) => void;
  vi.mocked(apiClient.streamMessage).mockImplementation((_input, incoming) => {
    options = incoming;
    return new Promise(resolve => { finish = resolve; });
  });
  const dom = installFakeDom();
  let root!: Root;
  const nodes = (node: import("./test-dom.js").FakeNode): import("./test-dom.js").FakeNode[] =>
    [node, ...node.childNodes.flatMap(nodes)];
  const props = (node: import("./test-dom.js").FakeNode): any =>
    (node as any)[Object.keys(node).find(key => key.startsWith("__reactProps$"))!];
  try {
    await act(async () => {
      root = createRoot(dom.container as unknown as Element);
      root.render(createElement((await import("./main-page.js")).MainPage));
    });
    await act(async () => {
      props(nodes(dom.container).find(node => node.tagName === "TEXTAREA")!).onChange({
        target: { value: "single reply", style: {}, scrollHeight: 30 },
        currentTarget: { style: {}, scrollHeight: 30 }
      });
    });
    await act(async () => {
      props(nodes(dom.container).find(node => node.attributes["aria-label"] === "Send message")!).onClick();
    });
    const bus = mockState.buses[0]!;
    const turn = bus.posted.filter((message: any) => message.kind === "start-generation").at(-1) as { requestId: string };
    const delta = async (text: string) => act(async () => options?.onEvent?.({
      type: "text-delta", text, traceId: "feedback-test", language: "zh"
    } as never));
    const speaks = () => bus.posted.filter((message: any) => message.kind === "speak") as Array<{ text: string }>;
    await delta("第一句话完整。");
    // Terminal punctuation is held for one textual lookahead so a later
    // punctuation-only delta can still join the same TTS request.
    expect(speaks()).toHaveLength(0);
    await delta("接下来");
    expect(speaks().map(message => message.text)).toEqual(["第一句话完整。"]);
    await act(async () => {
      bus.emit({ kind: "speech-status", requestId: turn.requestId, state: "playing" });
      bus.emit({ kind: "playback-status", requestId: turn.requestId, segmentSequence: 0, state: "started" });
      bus.emit({ kind: "playback-status", requestId: "old-turn", segmentSequence: 0, state: "ended" });
    });
    await delta("这段话还在继续，");
    expect(speaks()).toHaveLength(1);
    await act(async () => bus.emit({
      kind: "playback-status", requestId: turn.requestId, segmentSequence: 0, state: "ended"
    }));
    await delta("随后");
    expect(speaks().map(message => message.text)).toEqual(["第一句话完整。", "接下来这段话还在继续，"]);
    await act(async () => {
      const completed = { type: "completed", content: "第一句话完整。接下来这段话还在继续，随后", traceId: "feedback-test" };
      options?.onEvent?.(completed as never);
      finish(completed as never);
    });
  } finally {
    await act(async () => root?.unmount());
    dom.restore();
  }
});
