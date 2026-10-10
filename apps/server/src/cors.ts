/** CORS headers required by the Tauri desktop WebView's loopback requests. */
export function desktopCorsHeaders(origin: string | undefined): Record<string, string> {
  if (typeof origin !== "string" || !isDesktopAllowedOrigin(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Yuvi-Control-Token",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    Vary: "Origin"
  };
}

export function isDesktopAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (
      host === "tauri.localhost" ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    ) {
      return true;
    }
    if (url.protocol === "tauri:" || url.protocol === "asset:") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
