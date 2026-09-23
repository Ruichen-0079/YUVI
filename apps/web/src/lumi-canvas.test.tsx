import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { LumiCanvas } from "./lumi-canvas.js";
import type { LumiControllerHandle } from "./lumi-live2d.js";
import { createInitialCompanionPresence } from "./companion-presence.js";
import type { CompanionRendererPresentation } from "./companion-presentation-projection.js";

const mocks = vi.hoisted(() => ({
  getLive2DModels: vi.fn(async (_signal?: AbortSignal) => ({
    activeId: "test" as string | null,
    activeUrl: "/api/live2d/test/test.model3.json" as string | null,
    intendedDefault: "test" as string | null,
    models: [
      {
        id: "test",
        name: "Test model",
        model: "test.model3.json",
        source: "user" as const,
        url: "/api/live2d/test/test.model3.json"
      }
    ]
  })),
  adapterLoad: vi.fn(async (): Promise<void> => undefined)
}));

vi.mock("./api/client.js", () => ({
  apiClient: {
    getLive2DModels: mocks.getLive2DModels
  }
}));

vi.mock("./lumi-live2d.js", async () => {
  const actual = await vi.importActual<typeof import("./lumi-live2d.js")>("./lumi-live2d.js");

  class TestAdapter {
    load(): Promise<void> { return mocks.adapterLoad(); }
    setParameter(): void {}
    setBreath(): void {}
    setFraming(): void {}
    resize(): void {}
    dispose(): void {}
    setMouthOpen(): void {}
    setMouthForm(): void {}
    resetMouth(): void {}
  }

  return { ...actual, CubismLive2DAdapter: TestAdapter };
});

type TestNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: TestDocument;
  parentNode: TestNode | null;
  childNodes: TestNode[];
  nodeValue: string | null;
  style: Record<string, string>;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  appendChild(node: TestNode): TestNode;
  insertBefore(node: TestNode, before: TestNode | null): TestNode;
  removeChild(node: TestNode): TestNode;
  setAttribute(name: string, value: unknown): void;
  removeAttribute(name: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  textContent: string;
  namespaceURI: string;
  clientWidth: number;
  clientHeight: number;
};

type TestDocument = {
  nodeType: 9;
  body: TestNode;
  documentElement: TestNode;
  activeElement: TestNode;
  defaultView: Record<string, unknown>;
  createElement(tag: string): TestNode;
  createElementNS(namespace: string, tag: string): TestNode;
  createTextNode(text: string): TestNode;
  createComment(text: string): TestNode;
  addEventListener(): void;
  removeEventListener(): void;
};

function installFakeDom(): {
  container: TestNode;
  frames: Array<(now: number) => void>;
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
  const frames: Array<(now: number) => void> = [];

  const makeNode = (tag: string, nodeType = 1, nodeValue: string | null = null): TestNode => {
    const node = {
      nodeType,
      nodeName: nodeType === 3 ? "#text" : tag.toUpperCase(),
      tagName: tag.toUpperCase(),
      ownerDocument: undefined as unknown as TestDocument,
      parentNode: null,
      childNodes: [],
      nodeValue,
      style: {},
      dataset: {},
      attributes: {},
      appendChild(child: TestNode) {
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      insertBefore(child: TestNode, before: TestNode | null) {
        const index = before === null ? -1 : this.childNodes.indexOf(before);
        if (index < 0) this.childNodes.push(child);
        else this.childNodes.splice(index, 0, child);
        child.parentNode = this;
        return child;
      },
      removeChild(child: TestNode) {
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
      namespaceURI: "http://www.w3.org/1999/xhtml",
      clientWidth: 320,
      clientHeight: 420
    } satisfies TestNode;
    return node;
  };

  const windowObject = {
    HTMLIFrameElement: class {},
    HTMLElement: class {},
    SVGElement: class {},
    Element: class {},
    Node: class {},
    Document: class {},
    addEventListener() {},
    removeEventListener() {},
    document: undefined as unknown as TestDocument
  };
  const documentObject = {
    nodeType: 9,
    body: undefined as unknown as TestNode,
    documentElement: undefined as unknown as TestNode,
    activeElement: undefined as unknown as TestNode,
    defaultView: windowObject,
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_namespace: string, tag: string) => makeNode(tag),
    createTextNode: (text: string) => makeNode("#text", 3, text),
    createComment: (text: string) => makeNode("#comment", 8, text),
    addEventListener() {},
    removeEventListener() {}
  } satisfies TestDocument;
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
  globalThis.requestAnimationFrame = (callback) => {
    frames.push((now) => callback(now));
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => undefined;
  (globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;
  const container = makeNode("div");
  container.ownerDocument = documentObject;

  return {
    container,
    frames,
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

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

beforeEach(() => {
  mocks.getLive2DModels.mockReset().mockResolvedValue({
    activeId: "test",
    activeUrl: "/api/live2d/test/test.model3.json",
    intendedDefault: "test",
    models: [
      {
        id: "test",
        name: "Test model",
        model: "test.model3.json",
        source: "user",
        url: "/api/live2d/test/test.model3.json"
      }
    ]
  });
  mocks.adapterLoad.mockReset().mockResolvedValue(undefined);
});

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("LumiCanvas normalized projection input", () => {
  it("presentationOnly emits the canvas without status or calibration chrome", () => {
    const markup = renderToStaticMarkup(
      createElement(LumiCanvas, {
        requestedProjection: createInitialCompanionPresence(),
        presentationOnly: true,
        showFramingToggle: false
      })
    );
    expect(markup).toContain("Companion avatar");
    expect(markup).toContain('data-framing="half"');
    expect(markup).not.toContain("Loading Live2D model");
    expect(markup).not.toContain("测试口型");
    expect(markup).not.toContain("显示全身");
    expect(markup).not.toContain("显示半身");
    expect(markup).not.toContain("待机");
  });

  it("mounts the real controller path with epoch-less normalized listening", async () => {
    const dom = installFakeDom();
    let root!: Root;
    const ref = createRef<LumiControllerHandle>();
    const lifecycles: string[] = [];
    const presentations: CompanionRendererPresentation[] = [];
    const projection = {
      ...createInitialCompanionPresence(),
      activity: "listening" as const
    };

    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(
          createElement(LumiCanvas, {
            ref,
            requestedProjection: projection,
            onModelLifecycle: (state) => lifecycles.push(state),
            onRendererPresentation: (state) => presentations.push(state),
            showFramingToggle: false
          })
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        const pendingFrames = dom.frames.splice(0);
        for (const frame of pendingFrames) frame(16);
        await Promise.resolve();
      });

      expect(ref.current?.getDebugInfo().activePresentationState).toBe("listening");
      expect(lifecycles).toContain("ready");
      expect(presentations).toContainEqual({
        status: "ready",
        activeModel: { id: "test", name: "Test model" }
      });
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("keeps a configured model in loading until Lumi confirms renderer readiness", async () => {
    const load = deferred();
    mocks.adapterLoad.mockReturnValue(load.promise);
    const dom = installFakeDom();
    let root!: Root;
    const presentations: CompanionRendererPresentation[] = [];
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement(LumiCanvas, {
          requestedProjection: createInitialCompanionPresence(),
          onRendererPresentation: (state) => presentations.push(state)
        }));
        await flushMicrotasks();
      });

      expect(presentations.at(-1)).toEqual({
        status: "loading",
        requestedModel: { id: "test", name: "Test model" }
      });
      expect(presentations.some((state) => state.status === "ready")).toBe(false);

      await act(async () => {
        load.resolve();
        await load.promise;
        await flushMicrotasks();
      });
      expect(presentations.at(-1)).toEqual({
        status: "ready",
        activeModel: { id: "test", name: "Test model" }
      });
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("reports no model and genuine renderer load failure as separate states", async () => {
    const dom = installFakeDom();
    let root!: Root;
    const presentations: CompanionRendererPresentation[] = [];
    try {
      mocks.getLive2DModels.mockRejectedValueOnce(new Error("discovery unavailable"));
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement(LumiCanvas, {
          requestedProjection: createInitialCompanionPresence(),
          onRendererPresentation: (state) => presentations.push(state)
        }));
        await flushMicrotasks();
      });
      expect(presentations.at(-1)).toEqual({ status: "unavailable" });
      expect(presentations.some((state) => state.status === "failed")).toBe(false);
      await act(async () => root.unmount());

      presentations.length = 0;
      mocks.getLive2DModels.mockResolvedValueOnce({
        activeId: "test",
        activeUrl: null,
        intendedDefault: "test",
        models: []
      });
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement(LumiCanvas, {
          requestedProjection: createInitialCompanionPresence(),
          onRendererPresentation: (state) => presentations.push(state)
        }));
        await flushMicrotasks();
      });
      expect(presentations.at(-1)).toEqual({ status: "unavailable" });
      expect(presentations.some((state) => state.status === "failed")).toBe(false);
      await act(async () => root.unmount());

      presentations.length = 0;
      mocks.getLive2DModels.mockResolvedValueOnce({
        activeId: null,
        activeUrl: null,
        intendedDefault: null,
        models: []
      });
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement(LumiCanvas, {
          requestedProjection: createInitialCompanionPresence(),
          onRendererPresentation: (state) => presentations.push(state)
        }));
        await flushMicrotasks();
      });
      expect(presentations.at(-1)).toEqual({ status: "no_model" });
      await act(async () => root.unmount());

      presentations.length = 0;
      root = createRoot(dom.container as unknown as Element);
      mocks.getLive2DModels.mockResolvedValue({
        activeId: "test",
        activeUrl: "/api/live2d/test/test.model3.json",
        intendedDefault: "test",
        models: [{
          id: "test", name: "Test model", model: "test.model3.json",
          source: "user", url: "/api/live2d/test/test.model3.json"
        }]
      });
      mocks.adapterLoad.mockRejectedValue(new Error("renderer load failed"));
      await act(async () => {
        root.render(createElement(LumiCanvas, {
          requestedProjection: createInitialCompanionPresence(),
          onRendererPresentation: (state) => presentations.push(state)
        }));
        await flushMicrotasks();
      });
      expect(presentations.at(-1)).toEqual({
        status: "failed",
        requestedModel: { id: "test", name: "Test model" }
      });
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("preserves ready state when model discovery fails transiently", async () => {
    vi.useFakeTimers();
    const dom = installFakeDom();
    let root!: Root;
    const presentations: CompanionRendererPresentation[] = [];
    try {
      mocks.getLive2DModels.mockResolvedValueOnce({
        activeId: "test",
        activeUrl: "/api/live2d/test/test.model3.json",
        intendedDefault: "test",
        models: [{
          id: "test", name: "Test model", model: "test.model3.json",
          source: "user", url: "/api/live2d/test/test.model3.json"
        }]
      }).mockRejectedValueOnce(new Error("discovery unavailable"));
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement(LumiCanvas, {
          requestedProjection: createInitialCompanionPresence(),
          onRendererPresentation: (state) => presentations.push(state)
        }));
        await flushMicrotasks();
      });
      expect(presentations.at(-1)).toEqual({
        status: "ready",
        activeModel: { id: "test", name: "Test model" }
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
        await flushMicrotasks();
      });
      expect(presentations.at(-1)).toEqual({
        status: "ready",
        activeModel: { id: "test", name: "Test model" }
      });
      expect(presentations.some((state) => state.status === "failed")).toBe(false);
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "keeps the replacement model active when an older load later %s",
    async (oldOutcome) => {
      vi.useFakeTimers();
      const oldLoad = deferred();
      const replacementLoad = deferred();
      mocks.getLive2DModels.mockResolvedValueOnce({
        activeId: "old",
        activeUrl: "/api/live2d/old/old.model3.json",
        intendedDefault: "old",
        models: [
          {
            id: "old",
            name: "Old model",
            model: "old.model3.json",
            source: "user",
            url: "/api/live2d/old/old.model3.json"
          }
        ]
      }).mockResolvedValueOnce({
        activeId: "new",
        activeUrl: "/api/live2d/new/new.model3.json",
        intendedDefault: "new",
        models: [
          {
            id: "new",
            name: "New model",
            model: "new.model3.json",
            source: "user",
            url: "/api/live2d/new/new.model3.json"
          }
        ]
      });
      mocks.adapterLoad
        .mockReturnValueOnce(oldLoad.promise)
        .mockReturnValueOnce(replacementLoad.promise);
      const dom = installFakeDom();
      let root!: Root;
      const presentations: CompanionRendererPresentation[] = [];
      try {
        await act(async () => {
          root = createRoot(dom.container as unknown as Element);
          root.render(createElement(LumiCanvas, {
            requestedProjection: createInitialCompanionPresence(),
            onRendererPresentation: (state) => presentations.push(state)
          }));
          await flushMicrotasks();
        });
        expect(presentations.at(-1)).toEqual({
          status: "loading",
          requestedModel: { id: "old", name: "Old model" }
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
          await flushMicrotasks();
        });
        expect(presentations.at(-1)).toEqual({
          status: "loading",
          requestedModel: { id: "new", name: "New model" }
        });
        await act(async () => {
          replacementLoad.resolve();
          await replacementLoad.promise;
          await flushMicrotasks();
        });
        expect(presentations.at(-1)).toEqual({
          status: "ready",
          activeModel: { id: "new", name: "New model" }
        });

        await act(async () => {
          if (oldOutcome === "resolve") oldLoad.resolve();
          else oldLoad.reject(new Error("stale renderer failure"));
          await oldLoad.promise.catch(() => undefined);
          await flushMicrotasks();
        });
        expect(presentations.at(-1)).toEqual({
          status: "ready",
          activeModel: { id: "new", name: "New model" }
        });
      } finally {
        await act(async () => root?.unmount());
        dom.restore();
      }
    }
  );
});
