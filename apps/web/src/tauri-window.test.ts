import { afterEach, describe, expect, it, vi } from "vitest";

const { startDragging, startResizeDragging, invoke } = vi.hoisted(() => ({
  startDragging: vi.fn(),
  startResizeDragging: vi.fn(),
  invoke: vi.fn()
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging, startResizeDragging })
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  isTauriRuntime,
  preloadTauriWindowApi,
  startWindowDragging,
  startWindowResizeDragging,
  controlCompanionWindow,
  getCompanionPresentationState,
  controlSubtitleWindow,
  controlWebUIWindow,
  getSubtitlePresentationState,
  setSubtitleLocked,
  hasExceededWindowDragThreshold,
  trackWindowDragGesture,
  WINDOW_DRAG_THRESHOLD_PX,
  type TauriResizeDirection
} from "./tauri-window.js";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  startDragging.mockClear();
  startResizeDragging.mockClear();
  invoke.mockClear();
});

describe("controlCompanionWindow", () => {
  it("does not touch Tauri IPC in a browser", async () => {
    await expect(controlCompanionWindow("show_companion")).resolves.toBeUndefined();
    await expect(getCompanionPresentationState()).resolves.toEqual({ visible: false, locked: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes controls and reads visibility from DesktopSurfaceManager inside Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    invoke.mockImplementation(async (command: string) => {
      if (command === "get_companion_presentation_state") return { visible: true };
      return undefined;
    });
    await controlCompanionWindow("reopen_companion");
    expect(invoke).toHaveBeenCalledWith("reopen_companion");
    await expect(getCompanionPresentationState()).resolves.toEqual({ visible: true });
    expect(invoke).toHaveBeenCalledWith("get_companion_presentation_state");
  });
});

describe("subtitle presentation helpers", () => {
  it("no-op/read defaults outside Tauri", async () => {
    await expect(controlSubtitleWindow("show")).resolves.toBeUndefined();
    await expect(getSubtitlePresentationState()).resolves.toEqual({ visible: false, locked: false });
    await expect(setSubtitleLocked(true)).resolves.toEqual({ visible: false, locked: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("routes visibility and lock state through the desktop surface commands", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    invoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "get_subtitle_presentation_state") return { visible: true, locked: false };
      if (command === "set_subtitle_locked") return { visible: true, locked: Boolean((args as { locked?: boolean })?.locked) };
      return undefined;
    });

    await controlSubtitleWindow("show");
    expect(invoke).toHaveBeenCalledWith("show_subtitle");
    await controlSubtitleWindow("hide");
    expect(invoke).toHaveBeenCalledWith("hide_subtitle");
    await expect(getSubtitlePresentationState()).resolves.toEqual({ visible: true, locked: false });
    await expect(setSubtitleLocked(true)).resolves.toEqual({ visible: true, locked: true });
    expect(invoke).toHaveBeenCalledWith("set_subtitle_locked", { locked: true });
  });
});

describe("controlWebUIWindow", () => {
  it("does not touch Tauri IPC in a browser", async () => {
    await expect(controlWebUIWindow()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows the lazy WebUI surface inside Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    await controlWebUIWindow();
    expect(invoke).toHaveBeenCalledWith("show_webui");
  });
});

describe("isTauriRuntime", () => {
  it("is false when no Tauri bridge exists", () => {
    expect(isTauriRuntime()).toBe(false);
  });

  it("is true when __TAURI_INTERNALS__ is present", () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(isTauriRuntime()).toBe(true);
  });
});

describe("startWindowDragging", () => {
  it("no-ops outside Tauri", async () => {
    await expect(startWindowDragging()).resolves.toBeUndefined();
    expect(startDragging).not.toHaveBeenCalled();
  });

  it("starts native dragging inside Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    await startWindowDragging();
    expect(startDragging).toHaveBeenCalledTimes(1);
  });
});

describe("startWindowResizeDragging", () => {
  it("no-ops outside Tauri and never calls the window API", async () => {
    await expect(
      startWindowResizeDragging("SouthEast" as TauriResizeDirection)
    ).resolves.toBeUndefined();
    await expect(preloadTauriWindowApi()).resolves.toBeUndefined();
    expect(startResizeDragging).not.toHaveBeenCalled();
  });

  it("starts SouthEast resize dragging inside Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    await startWindowResizeDragging("SouthEast" as TauriResizeDirection);
    expect(startResizeDragging).toHaveBeenCalledWith("SouthEast");
  });
});

describe("window drag threshold", () => {
  it("requires movement before the native grab", () => {
    expect(WINDOW_DRAG_THRESHOLD_PX).toBeGreaterThan(0);
    expect(hasExceededWindowDragThreshold(0, 0, 0, 0)).toBe(false);
    expect(hasExceededWindowDragThreshold(0, 0, 1, 1)).toBe(false);
    expect(
      hasExceededWindowDragThreshold(0, 0, WINDOW_DRAG_THRESHOLD_PX, 0)
    ).toBe(true);
    expect(hasExceededWindowDragThreshold(10, 10, 13, 14)).toBe(true);
  });

  it("starts drag only after movement, never on simple click", () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    (globalThis as { window?: unknown }).window = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.get(type)?.delete(listener);
      }
    };
    try {
      let drags = 0;
      const cleanup = trackWindowDragGesture(100, 100, () => {
        drags += 1;
      });
      // Simple click without movement: pointerup cleans up, no drag.
      for (const listener of Array.from(listeners.get("pointerup") ?? [])) {
        listener({});
      }
      expect(drags).toBe(0);

      let secondDrags = 0;
      trackWindowDragGesture(100, 100, () => {
        secondDrags += 1;
      });
      // Small jitter below threshold: no drag.
      for (const listener of Array.from(listeners.get("pointermove") ?? [])) {
        listener({ clientX: 101, clientY: 101 });
      }
      expect(secondDrags).toBe(0);
      // Real move beyond threshold: exactly one drag, then auto-cleanup.
      for (const listener of Array.from(listeners.get("pointermove") ?? [])) {
        listener({ clientX: 120, clientY: 100 });
      }
      expect(secondDrags).toBe(1);
      cleanup();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
