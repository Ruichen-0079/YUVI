/**
 * Tauri-only window helpers. Every call is guarded by isTauriRuntime() so the
 * browser /companion debug page (and any non-Tauri test environment) never
 * touches the Tauri IPC bridge.
 */
import { withActionDeadline } from "./action-deadline.js";

export async function invokeDesktop<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return withActionDeadline(
    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
    })()
  );
}

/** Subscribe before the initial read; focus recovers from a missed desktop event. */
export function subscribeSurfaceChanged(
  refresh: () => void,
  onError: (error: unknown) => void
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  window.addEventListener("focus", refresh);
  void import("@tauri-apps/api/event")
    .then(async ({ listen }) => {
      if (disposed) return;
      const remove = await listen("desktop-surface.changed", refresh);
      if (disposed) remove();
      else {
        unlisten = remove;
        refresh();
      }
    })
    .catch((error) => {
      if (!disposed) onError(error);
    });
  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener("focus", refresh);
  };
}

/** Mirrors @tauri-apps/api/window's ResizeDirection (not exported in v2.11). */
export type TauriResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Warm the window API module so a pointerdown can start resizing in the same gesture. */
export async function preloadTauriWindowApi(): Promise<void> {
  if (!isTauriRuntime()) return;
  await import("@tauri-apps/api/window");
}

export async function startWindowResizeDragging(direction: TauriResizeDirection): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startResizeDragging(direction);
}

export async function startWindowDragging(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

/**
 * XWayland-safe drag initiation threshold.
 *
 * Calling native `startDragging` (GTK `begin_move_drag`) on every pointerdown
 * — including simple clicks without movement — can leave the pointer grab
 * active under XWayland, making the window appear stuck in a grab/drag state
 * until a fullscreen transition resets it. Require a small movement before
 * starting the native drag so clicks never grab.
 */
export const WINDOW_DRAG_THRESHOLD_PX = 5;

export function hasExceededWindowDragThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  thresholdPx: number = WINDOW_DRAG_THRESHOLD_PX
): boolean {
  const dx = currentX - startX;
  const dy = currentY - startY;
  return dx * dx + dy * dy >= thresholdPx * thresholdPx;
}

/**
 * Track one pointerdown gesture and start the native window drag only after
 * the pointer moves beyond the threshold. Simple clicks (no movement) never
 * touch the native drag grab. Returns a cleanup for unmount safety.
 */
export function trackWindowDragGesture(
  startX: number,
  startY: number,
  onDragStart: () => void,
  thresholdPx: number = WINDOW_DRAG_THRESHOLD_PX
): () => void {
  let dragged = false;
  const cleanup = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);
  };
  const onMove = (event: PointerEvent): void => {
    if (dragged) return;
    if (hasExceededWindowDragThreshold(startX, startY, event.clientX, event.clientY, thresholdPx)) {
      dragged = true;
      cleanup();
      onDragStart();
    }
  };
  const onEnd = (): void => {
    cleanup();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
  return cleanup;
}

export type CompanionWindowAction =
  | "show_companion"
  | "hide_companion"
  | "toggle_companion"
  | "reopen_companion";

export async function controlCompanionWindow(action: CompanionWindowAction): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeDesktop(action);
}

export type CompanionPresentationState = {
  visible: boolean;
  locked: boolean;
};

export async function getCompanionPresentationState(): Promise<CompanionPresentationState> {
  if (!isTauriRuntime()) return { visible: false, locked: false };
  return invokeDesktop<CompanionPresentationState>("get_companion_presentation_state");
}

/** Show the existing lazy WebUI desktop surface. Settings live there, not in Main Chat. */
export async function controlWebUIWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeDesktop("show_webui");
}

export type SubtitlePresentationState = {
  visible: boolean;
  locked: boolean;
};

export async function controlSubtitleWindow(action: "show" | "hide"): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeDesktop(action === "show" ? "show_subtitle" : "hide_subtitle");
}

export async function getSubtitlePresentationState(): Promise<SubtitlePresentationState> {
  if (!isTauriRuntime()) return { visible: false, locked: false };
  return invokeDesktop<SubtitlePresentationState>("get_subtitle_presentation_state");
}

export async function setSubtitleLocked(locked: boolean): Promise<SubtitlePresentationState> {
  if (!isTauriRuntime()) return { visible: false, locked };
  return invokeDesktop<SubtitlePresentationState>("set_subtitle_locked", { locked });
}

export async function setCompanionLocked(locked: boolean): Promise<CompanionPresentationState> {
  if (!isTauriRuntime()) return { visible: false, locked };
  return invokeDesktop<CompanionPresentationState>("set_companion_locked", { locked });
}
