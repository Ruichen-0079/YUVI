import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanionPage } from "./companion-page.js";

const mockState = vi.hoisted(() => ({
  subtitles: [] as any[],
  buses: [] as any[],
  queues: [] as any[],
  projections: [] as any[],
  controllers: [] as any[],
  canvasProps: [] as any[],
  surfaceStates: [] as any[],
  surfaceSubscribes: [] as any[]
}));

vi.mock("./subtitle-bus.js", () => ({
  publishSubtitleProjection: (message: any) => mockState.subtitles.push(message)
}));

vi.mock("./behavior-policy-controller.js", () => ({
  createBehaviorPolicyController: (options: any) => {
    const visibilityCalls: boolean[] = [];
    const controller = {
      visibilityCalls,
      updatePresence: () => undefined,
      updateVisibility: (visible: boolean) => visibilityCalls.push(visible),
      getState: () => ({ active: { kind: "none" } }),
      getPreviousPresence: () => null,
      dispose: () => undefined
    };
    mockState.controllers.push({ controller, options });
    return controller;
  }
}));

vi.mock("./companion-bus.js", () => {
  class MockCompanionBus {
    private readonly listeners = new Set<(message: any) => void>();
    readonly posted: any[] = [];

    constructor(public readonly role: string) {
      mockState.buses.push(this);
    }

    post(message: any): void {
      this.posted.push(message);
    }

    subscribe(listener: (message: any) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(message: any): void {
      for (const listener of this.listeners) listener(message);
    }

    close(): void {
      this.listeners.clear();
    }
  }

  return { CompanionBus: MockCompanionBus };
});

vi.mock("./companion-voice-sync.js", () => ({
  createCompanionReadyAnnouncer: () => ({
    start: () => undefined,
    markSynced: () => undefined,
    stop: () => undefined
  })
}));

vi.mock("./lumi-canvas.js", async () => {
  const react = await import("react");
  const LumiCanvas = react.forwardRef((props: any, ref) => {
    mockState.canvasProps.push(props);
    const framingToggleVisible =
      props.presentationOnly === true
        ? props.showFramingToggle === true
        : props.showFramingToggle !== false;
    react.useImperativeHandle(ref, () => ({
      handlePlaybackEvent: () => undefined,
      resumeAudio: () => undefined,
      setFraming: () => undefined,
      setPresentationProjection: (projection: any) => {
        mockState.projections.push(projection);
      },
      setGazeTarget: () => undefined,
      setPresenceAnimation: () => undefined,
      load: async () => undefined,
      runMouthCalibration: async () => undefined,
      resize: () => undefined,
      dispose: () => undefined,
      getPresentationState: () => "idle",
      getModelLifecycle: () => "ready",
      getFramingDiagnostics: () => null,
      getDebugInfo: () => ({ instanceId: 0, generation: 0 })
    }));
    return react.createElement(
      "div",
      { "aria-label": "Companion avatar" },
      "Companion avatar",
      framingToggleVisible ? react.createElement("button", { type: "button" }, "显示全身") : null
    );
  });
  return { LumiCanvas };
});

vi.mock("./speech-queue.js", () => {
  class MockSpeechPlaybackQueue {
    readonly callbacks: any;
    cancelCalls = 0;

    constructor(_synthesize: any, _play: any, callbacks: any) {
      this.callbacks = callbacks;
      mockState.queues.push(this);
    }

    enqueue(): void {}

    finish(): void {
      this.callbacks.onState?.("idle");
    }

    cancel(): void {
      this.cancelCalls += 1;
      this.callbacks.onPlaybackEvent?.({
        type: "playbackStopped",
        audio: {},
        sequence: 0,
        segment: { requestId: "turn-a", sequence: 0 }
      });
      this.callbacks.onState?.("stopped");
    }

    emitPlayback(type: "playbackStarted" | "playbackEnded", sequence = 0): void {
      this.callbacks.onPlaybackEvent?.({
        type,
        audio: {},
        sequence: 0,
        segment: { requestId: "turn-a", sequence }
      });
    }
  }

  return {
    SpeechPlaybackQueue: MockSpeechPlaybackQueue,
    createBrowserSpeechPlayer: () => () => Promise.resolve()
  };
});

vi.mock("./tauri-window.js", () => ({
  isTauriRuntime: () =>
    Boolean(
      (globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }).window?.__TAURI_INTERNALS__
    ),
  preloadTauriWindowApi: async () => undefined,
  startWindowDragging: async () => undefined,
  startWindowResizeDragging: async () => undefined,
  getCompanionPresentationState: async () =>
    mockState.surfaceStates.at(-1) ?? { locked: false },
  subscribeSurfaceChanged: (refresh: () => void, onError: (error: unknown) => void) => {
    mockState.surfaceSubscribes.push({ refresh, onError });
    return () => undefined;
  }
}));

type FakeNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  nodeValue?: string | null;
  style: Record<string, string>;
  attributes: Record<string, string>;
  appendChild(node: FakeNode): FakeNode;
  insertBefore(node: FakeNode, before: FakeNode | null): FakeNode;
  removeChild(node: FakeNode): FakeNode;
  setAttribute(name: string, value: unknown): void;
  removeAttribute(name: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  textContent: string;
  namespaceURI: string;
};

type FakeDocument = {
  nodeType: 9;
  visibilityState: "visible" | "hidden";
  body: FakeNode;
  documentElement: FakeNode;
  activeElement: FakeNode;
  defaultView: Record<string, unknown>;
  createElement(tag: string): FakeNode;
  createElementNS(namespace: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  createComment(text: string): FakeNode;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

function installFakeDom(
  options: {
    initialVisibility?: "visible" | "hidden";
    onVisibilityListenerInstall?: () => void;
    tauri?: boolean;
  } = {}
): {
  container: FakeNode;
  document: FakeDocument;
  visibilityListeners: Set<() => void>;
  visibilityListenerHistory: Array<() => void>;
  visibilityAdds: number;
  visibilityRemoves: number;
  setVisibility(value: "visible" | "hidden"): void;
  restore(): void;
} {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousActEnvironment = (globalThis as Record<string, unknown>)[
    "IS_REACT_ACT_ENVIRONMENT"
  ];
  const makeNode = (tag: string, nodeType = 1, nodeValue: string | null = null): FakeNode => {
    const node = {
      nodeType,
      nodeName: nodeType === 3 ? "#text" : tag.toUpperCase(),
      tagName: tag.toUpperCase(),
      ownerDocument: undefined as unknown as FakeDocument,
      parentNode: null,
      childNodes: [],
      nodeValue,
      style: {},
      attributes: {},
      appendChild(child: FakeNode) {
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      insertBefore(child: FakeNode, before: FakeNode | null) {
        const index = before === null ? -1 : this.childNodes.indexOf(before);
        if (index < 0) this.childNodes.push(child);
        else this.childNodes.splice(index, 0, child);
        child.parentNode = this;
        return child;
      },
      removeChild(child: FakeNode) {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      setAttribute(name: string, value: unknown) {
        this.attributes[name] = String(value);
      },
      removeAttribute(name: string) {
        delete this.attributes[name];
      },
      addEventListener() {},
      removeEventListener() {},
      textContent: nodeValue ?? "",
      namespaceURI: "http://www.w3.org/1999/xhtml"
    } satisfies FakeNode;
    return node;
  };

  const windowObject = {
    HTMLIFrameElement: class {},
    HTMLElement: class {},
    SVGElement: class {},
    Element: class {},
    Node: class {},
    Document: class {},
    __TAURI_INTERNALS__: options.tauri ? {} : undefined,
    addEventListener() {},
    removeEventListener() {},
    document: undefined as unknown as FakeDocument
  };
  const visibilityListeners = new Set<() => void>();
  const visibilityListenerHistory: Array<() => void> = [];
  let visibilityAdds = 0;
  let visibilityRemoves = 0;
  let onVisibilityListenerInstall = options.onVisibilityListenerInstall;
  const documentObject = {
    nodeType: 9,
    visibilityState: options.initialVisibility ?? "visible",
    body: undefined as unknown as FakeNode,
    documentElement: undefined as unknown as FakeNode,
    activeElement: undefined as unknown as FakeNode,
    defaultView: windowObject,
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_namespace: string, tag: string) => makeNode(tag),
    createTextNode: (text: string) => makeNode("#text", 3, text),
    createComment: (text: string) => makeNode("#comment", 8, text),
    addEventListener(type: string, listener: () => void) {
      if (type !== "visibilitychange") return;
      visibilityAdds += 1;
      visibilityListeners.add(listener);
      visibilityListenerHistory.push(listener);
      const hook = onVisibilityListenerInstall;
      onVisibilityListenerInstall = undefined;
      hook?.();
    },
    removeEventListener(type: string, listener: () => void) {
      if (type !== "visibilitychange") return;
      visibilityRemoves += 1;
      visibilityListeners.delete(listener);
    }
  } satisfies FakeDocument;
  documentObject.body = makeNode("body");
  documentObject.documentElement = makeNode("html");
  documentObject.activeElement = documentObject.body;
  for (const node of [documentObject.body, documentObject.documentElement]) {
    node.ownerDocument = documentObject;
  }
  windowObject.document = documentObject;
  globalThis.document = documentObject as unknown as Document;
  globalThis.window = windowObject as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "node" }
  });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => undefined;
  (globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;
  const container = makeNode("div");
  container.ownerDocument = documentObject;

  return {
    container,
    document: documentObject,
    visibilityListeners,
    visibilityListenerHistory,
    get visibilityAdds() {
      return visibilityAdds;
    },
    get visibilityRemoves() {
      return visibilityRemoves;
    },
    setVisibility(value) {
      documentObject.visibilityState = value;
      for (const listener of [...visibilityListeners]) listener();
    },
    restore() {
      const globalObject = globalThis as Record<string, unknown>;
      if (previousDocument === undefined) delete globalObject["document"];
      else globalObject["document"] = previousDocument;
      if (previousWindow === undefined) delete globalObject["window"];
      else globalObject["window"] = previousWindow;
      if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
      else delete (globalThis as { navigator?: unknown }).navigator;
      globalThis.requestAnimationFrame = previousRequestAnimationFrame;
      globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
      if (previousActEnvironment === undefined) {
        delete globalObject["IS_REACT_ACT_ENVIRONMENT"];
      } else {
        globalObject["IS_REACT_ACT_ENVIRONMENT"] = previousActEnvironment;
      }
    }
  };
}

function readText(node: FakeNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  return node.childNodes.map(readText).join("");
}

async function mountCompanionPage(domOptions?: Parameters<typeof installFakeDom>[0]): Promise<{
  root: Root;
  container: FakeNode;
  restore(): void;
  document: FakeDocument;
  visibilityListeners: Set<() => void>;
  visibilityListenerHistory: Array<() => void>;
  visibilityAdds: number;
  visibilityRemoves: number;
  setVisibility(value: "visible" | "hidden"): void;
}> {
  const dom = installFakeDom(domOptions);
  let root!: Root;
  await act(async () => {
    root = createRoot(dom.container as unknown as Element);
    root.render(createElement(CompanionPage));
    await Promise.resolve();
  });
  return {
    root,
    container: dom.container,
    document: dom.document,
    visibilityListeners: dom.visibilityListeners,
    visibilityListenerHistory: dom.visibilityListenerHistory,
    get visibilityAdds() {
      return dom.visibilityAdds;
    },
    get visibilityRemoves() {
      return dom.visibilityRemoves;
    },
    setVisibility: dom.setVisibility,
    restore: dom.restore
  };
}

async function emitBus(bus: any, message: any): Promise<void> {
  await act(async () => {
    bus.emit(message);
    await Promise.resolve();
  });
}

async function emitPlayback(
  queue: any,
  type: "playbackStarted" | "playbackEnded",
  sequence = 0
): Promise<void> {
  await act(async () => {
    queue.emitPlayback(type, sequence);
    await Promise.resolve();
  });
}

afterEach(() => {
  mockState.subtitles.length = 0;
  mockState.buses.length = 0;
  mockState.queues.length = 0;
  mockState.projections.length = 0;
  mockState.controllers.length = 0;
  mockState.canvasProps.length = 0;
  mockState.surfaceStates.length = 0;
  mockState.surfaceSubscribes.length = 0;
  delete (globalThis as { window?: unknown }).window;
});

describe("CompanionPage product overlay", () => {
  it("renders as an avatar-only surface without visible product chrome in a plain browser", () => {
    expect(() => renderToStaticMarkup(<CompanionPage />)).not.toThrow();
    const markup = renderToStaticMarkup(<CompanionPage />);
    expect(markup).toContain("Companion avatar");
    expect(markup).not.toContain("data-tauri-drag-region");
    expect(markup).not.toContain("Resize window");
    expect(markup).not.toContain("Full body");
    expect(markup).not.toContain("Portrait");
    expect(markup).not.toContain("companion window · open the main window to chat");
  });

  it("keeps only an invisible hover resize affordance in Tauri", () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    const markup = renderToStaticMarkup(<CompanionPage />);
    expect(markup).not.toContain("data-tauri-drag-region");
    expect(markup).toContain("data-yuvi-resize-handle");
    expect(markup).toContain('aria-label="Resize window"');
    expect(markup).toContain("opacity-0");
    expect(markup).toContain("hover:opacity-100");
    expect(markup).not.toContain("Full body");
    expect(markup).not.toContain("Portrait");
  });
});

describe("CompanionPage locked framing toggle projection", () => {
  it("hides the framing toggle while locked and restores it after unlock", async () => {
    const containsText = (node: FakeNode, text: string): boolean =>
      (node.nodeValue ?? "").includes(text) ||
      (node.textContent ?? "").includes(text) ||
      node.childNodes.some((child) => containsText(child, text));
    mockState.surfaceStates.push({ locked: true });
    const mounted = await mountCompanionPage({ tauri: true });
    const flushSurfaceReads = async () => {
      await act(async () => {
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
      });
    };
    try {
      await flushSurfaceReads();
      expect(containsText(mounted.container, "显示全身")).toBe(false);
      expect(mockState.canvasProps.at(-1)?.showFramingToggle).toBe(false);

      mockState.surfaceStates.push({ locked: false });
      const subscription = mockState.surfaceSubscribes.at(-1);
      await act(async () => {
        subscription?.refresh();
      });
      await flushSurfaceReads();
      expect(containsText(mounted.container, "显示全身")).toBe(true);
      expect(mockState.canvasProps.at(-1)?.showFramingToggle).toBe(true);
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });
});

describe("CompanionPage visibility installation", () => {
  it("installs the listener before the initial visibility synchronization", async () => {
    const mounted = await mountCompanionPage({
      initialVisibility: "visible",
      onVisibilityListenerInstall: () => {
        (globalThis.document as unknown as FakeDocument).visibilityState = "hidden";
      }
    });
    try {
      const controller = mockState.controllers[0]?.controller;
      expect(controller.visibilityCalls).toEqual([false]);
      expect(mounted.visibilityAdds).toBe(1);
      expect(mounted.visibilityListeners.size).toBe(1);
    } finally {
      await act(async () => mounted.root.unmount());
      expect(mounted.visibilityRemoves).toBe(1);
      expect(mounted.visibilityListeners.size).toBe(0);
      mounted.restore();
    }
  });

  it("keeps one live listener across remount and fences the stale listener", async () => {
    const first = await mountCompanionPage();
    const staleListener = first.visibilityListenerHistory[0];
    const firstController = mockState.controllers[0]?.controller;
    await act(async () => first.root.unmount());
    expect(first.visibilityRemoves).toBe(1);
    expect(first.visibilityListeners.size).toBe(0);
    first.restore();

    const second = await mountCompanionPage();
    try {
      const secondController = mockState.controllers[1]?.controller;
      expect(second.visibilityAdds).toBe(1);
      expect(second.visibilityListeners.size).toBe(1);
      const secondCallsBeforeStaleListener = secondController.visibilityCalls.length;

      staleListener?.();

      expect(firstController.visibilityCalls).toHaveLength(2);
      expect(secondController.visibilityCalls).toHaveLength(secondCallsBeforeStaleListener);
    } finally {
      await act(async () => second.root.unmount());
      expect(second.visibilityRemoves).toBe(1);
      expect(second.visibilityListeners.size).toBe(0);
      second.restore();
    }
  });
});

describe("CompanionPage generation interruption admission", () => {
  it("forwards epoch-less normalized listening through the mounted Lumi path", async () => {
    const mounted = await mountCompanionPage();
    try {
      const bus = mockState.buses.at(-1);
      await emitBus(bus, { kind: "user-gesture" });

      const projection = mockState.projections.at(-1);
      expect(projection).toMatchObject({ epoch: null, activity: "listening" });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });

  it("ignores a terminal interruption without cancelling post-generation speech", async () => {
    const mounted = await mountCompanionPage();
    try {
      const bus = mockState.buses.at(-1);
      await emitBus(bus, { kind: "start-generation", requestId: "turn-a", sessionId: "session" });
      const queue = mockState.queues.at(-1);
      await emitPlayback(queue, "playbackStarted");
      await emitBus(bus, { kind: "generation-state", requestId: "turn-a", state: "idle" });

      await emitBus(bus, { kind: "generation-state", requestId: "turn-a", state: "interrupted" });

      expect(queue.cancelCalls).toBe(0);
      expect(mockState.projections.at(-1)).toMatchObject({
        lifecycle: "generation-complete",
        speech: "active",
        transition: "none"
      });

      await emitPlayback(queue, "playbackEnded");
      expect(mockState.projections.at(-1)).toMatchObject({
        lifecycle: "generation-complete",
        speech: "completed",
        transition: "none"
      });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });

  it("still cancels resources for an active interruption", async () => {
    const mounted = await mountCompanionPage();
    try {
      const bus = mockState.buses.at(-1);
      await emitBus(bus, { kind: "start-generation", requestId: "turn-a", sessionId: "session" });
      const queue = mockState.queues.at(-1);

      await emitBus(bus, { kind: "generation-state", requestId: "turn-a", state: "interrupted" });

      expect(queue.cancelCalls).toBe(1);
      expect(mockState.projections.at(-1)).toMatchObject({
        lifecycle: "cancelled",
        activity: "idle",
        speech: "cancelled",
        transition: "interrupted"
      });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });

  it("ignores a stale same-turn segment terminal callback", async () => {
    const mounted = await mountCompanionPage();
    try {
      const bus = mockState.buses.at(-1);
      await emitBus(bus, { kind: "start-generation", requestId: "turn-a", sessionId: "session" });
      const queue = mockState.queues.at(-1);
      await emitBus(bus, { kind: "generation-state", requestId: "turn-a", state: "idle" });
      await emitPlayback(queue, "playbackStarted", 0);
      await emitPlayback(queue, "playbackEnded", 0);
      await emitPlayback(queue, "playbackStarted", 1);
      await emitPlayback(queue, "playbackEnded", 0);

      expect(queue.cancelCalls).toBe(0);
      expect(mockState.projections.at(-1)).toMatchObject({
        lifecycle: "generation-complete",
        speech: "active",
        transition: "none"
      });

      await emitPlayback(queue, "playbackEnded", 1);
      expect(mockState.projections.at(-1)).toMatchObject({
        lifecycle: "generation-complete",
        speech: "completed",
        transition: "none"
      });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });
});

describe("spoken Subtitle lifecycle", () => {
  it("publishes only on playback, clears on interruption, and fences replaced speech", async () => {
    const mounted = await mountCompanionPage();
    try {
      const bus = mockState.buses.at(-1);
      await emitBus(bus, { kind: "start-generation", requestId: "turn-a", sessionId: "session" });
      const queue = mockState.queues.at(-1);
      queue.callbacks.onSynthesisCompleted({
        segment: { requestId: "turn-a", sequence: 0 },
        item: { text: "同じ文字", language: "ja" }
      });
      expect(mockState.subtitles.every((message) => message.kind === "clear")).toBe(true);
      await emitPlayback(queue, "playbackStarted");
      expect(mockState.subtitles.at(-1)).toMatchObject({
        text: "同じ文字",
        language: "ja",
        requestId: "turn-a"
      });
      await emitBus(bus, { kind: "stop-speech", requestId: "turn-a" });
      expect(mockState.subtitles.at(-1)).toEqual({ kind: "clear" });
      await emitBus(bus, { kind: "start-generation", requestId: "turn-b", sessionId: "session" });
      const count = mockState.subtitles.length;
      await emitPlayback(queue, "playbackStarted");
      await emitPlayback(queue, "playbackEnded");
      expect(mockState.subtitles).toHaveLength(count);
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });

  it("leaves failed synthesis blank", async () => {
    const mounted = await mountCompanionPage();
    try {
      await emitBus(mockState.buses.at(-1), {
        kind: "start-generation",
        requestId: "turn-a",
        sessionId: "session"
      });
      const queue = mockState.queues.at(-1);
      await act(async () => {
        queue.callbacks.onItemState({ requestId: "turn-a", sequence: 0 }, "failed");
        queue.callbacks.onError(new Error("synthesis failed"));
      });
      expect(mockState.subtitles.every((message) => message.kind === "clear")).toBe(true);
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });

  it("publishes committed text immediately when TTS is disabled", async () => {
    const mounted = await mountCompanionPage();
    try {
      const bus = mockState.buses.at(-1);
      await emitBus(bus, { kind: "start-generation", requestId: "turn-a", sessionId: "session" });
      await emitBus(bus, {
        kind: "tts-config",
        config: { enabled: false, mode: "external" }
      });
      await emitBus(bus, {
        kind: "speak",
        requestId: "turn-a",
        sequence: 0,
        text: "字幕回退文本",
        language: "zh"
      });
      expect(mockState.subtitles.at(-1)).toMatchObject({
        kind: "committed-assistant-text",
        requestId: "turn-a",
        messageId: "turn-a:0",
        text: "字幕回退文本",
        language: "zh"
      });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });

  it("publishes fallback text when synthesis fails after enqueue", async () => {
    const mounted = await mountCompanionPage();
    try {
      const bus = mockState.buses.at(-1);
      await emitBus(bus, { kind: "start-generation", requestId: "turn-a", sessionId: "session" });
      await emitBus(bus, {
        kind: "speak",
        requestId: "turn-a",
        sequence: 0,
        text: "fallback on failure",
        language: "en"
      });
      const queue = mockState.queues.at(-1);
      // No subtitle before terminal audio events; sync path still waits.
      expect(mockState.subtitles.every((message) => message.kind === "clear")).toBe(true);
      await act(async () => {
        queue.callbacks.onItemState({ requestId: "turn-a", sequence: 0 }, "failed");
        queue.callbacks.onError(new Error("synthesis failed"));
      });
      expect(mockState.subtitles.at(-1)).toMatchObject({
        kind: "committed-assistant-text",
        requestId: "turn-a",
        messageId: "turn-a:0",
        text: "fallback on failure",
        language: "en"
      });
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });
});
