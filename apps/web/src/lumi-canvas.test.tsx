import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { LumiCanvas } from "./lumi-canvas.js";
import type { LumiControllerHandle } from "./lumi-live2d.js";
import { createInitialCompanionPresence } from "./companion-presence.js";

vi.mock("./api/client.js", () => ({
  apiClient: {
    getLive2DModels: async () => ({
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
    })
  }
}));

vi.mock("./lumi-live2d.js", async () => {
  const actual = await vi.importActual<typeof import("./lumi-live2d.js")>("./lumi-live2d.js");

  class TestAdapter {
    async load(): Promise<void> {}
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
});

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
    const selections: unknown[] = [];
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
            onModelSelection: (selection) => selections.push(selection),
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
      expect(selections).toContainEqual({ kind: "selected", id: "test", name: "Test model" });
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });
});
