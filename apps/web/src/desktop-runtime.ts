import { convertFileSrc } from "@tauri-apps/api/core";
/**
 * Desktop (Tauri) runtime helpers shared by API client and surface routing.
 * Packaged builds have no Vite /api proxy — talk to local Runtime directly.
 */

export const DEFAULT_RUNTIME_HTTP = "http://127.0.0.1:6121";

export type DesktopRuntimeBindingMode = "owned" | "attach";

let desktopRuntimeHttpOverride: string | null = null;
let desktopRuntimeBindingMode: DesktopRuntimeBindingMode = "owned";

export class DesktopRuntimeBindingUnavailableError extends Error {
  constructor() {
    super("Desktop Runtime binding is unavailable for this attach-only instance.");
    this.name = "DesktopRuntimeBindingUnavailableError";
  }
}

export function setDesktopRuntimeBinding(
  mode: DesktopRuntimeBindingMode,
  runtimeUrl: string | null
): void {
  desktopRuntimeBindingMode = mode;
  // Never retain a previously verified origin if the replacement binding is
  // absent or invalid.
  desktopRuntimeHttpOverride = null;
  setDesktopRuntimeHttpOverride(runtimeUrl);
}

export function setDesktopRuntimeHttpOverride(value: string | null): void {
  if (value === null) {
    desktopRuntimeHttpOverride = null;
    return;
  }
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  if (
    parsed.protocol !== "http:" ||
    !loopback ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("Desktop Runtime URL must be a loopback HTTP origin.");
  }
  desktopRuntimeHttpOverride = parsed.origin;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * HTTP base for Runtime API.
 * - Explicit VITE_API_BASE_URL wins
 * - Tauri: loopback Runtime (no Vite proxy)
 * - Browser/dev: /api (proxied by Vite)
 */
export function resolveApiBaseUrl(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>
): string {
  if (isTauriRuntime()) {
    if (!desktopRuntimeHttpOverride) {
      throw new DesktopRuntimeBindingUnavailableError();
    }
    return desktopRuntimeHttpOverride;
  }
  const configured = env["VITE_API_BASE_URL"]?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  if (isTauriRuntime()) {
    return desktopRuntimeHttpOverride ?? DEFAULT_RUNTIME_HTTP;
  }
  return "/api";
}

/** Map legacy `/api/...` asset paths to absolute Runtime URLs in Tauri. */
export function resolveRuntimeAssetUrl(pathOrUrl: string): string {
  if (
    pathOrUrl.startsWith("http://") ||
    pathOrUrl.startsWith("https://") ||
    pathOrUrl.startsWith("data:") ||
    pathOrUrl.startsWith("blob:")
  ) {
    return pathOrUrl;
  }
  if (!isTauriRuntime()) {
    return pathOrUrl;
  }
  const path = pathOrUrl.startsWith("/api/") ? pathOrUrl.slice(4) : pathOrUrl;
  if (path.startsWith("/live2d/") || path === "/live2d-core/live2dcubismcore.min.js") return convertFileSrc(path, "yuvi-asset");
  return `${resolveApiBaseUrl()}${path}`;
}

export type DesktopSurface = "dashboard" | "main" | "companion" | "webui" | "subtitle";

/**
 * Prefer Tauri window label (reliable in packaged builds) over hash routing.
 * Hash is kept for browser debugging and as a fallback.
 */
export async function resolveDesktopSurface(): Promise<DesktopSurface> {
  if (isTauriRuntime()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const label = getCurrentWindow().label;
      if (label === "main") return "main";
      if (label === "companion") return "companion";
      if (label === "webui") return "webui";
      if (label === "subtitle") return "subtitle";
    } catch {
      // fall through to hash
    }
  }

  if (typeof window === "undefined") return "dashboard";
  const hash = window.location.hash;
  if (hash.startsWith("#/webui")) return "webui";
  if (hash.startsWith("#/main")) return "main";
  if (hash.startsWith("#/companion")) return "companion";
  if (hash.startsWith("#/subtitle")) return "subtitle";
  const path = window.location.pathname;
  if (path === "/main" || path.endsWith("/main")) return "main";
  if (path === "/companion" || path.endsWith("/companion")) return "companion";
  return "dashboard";
}
