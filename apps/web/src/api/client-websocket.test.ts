import { afterEach, describe, expect, it, vi } from "vitest";
import { setDesktopRuntimeBinding } from "../desktop-runtime.js";
import { resolveWebSocketUrl } from "./client.js";

describe("Runtime-bound WebSocket URL", () => {
  afterEach(() => {
    setDesktopRuntimeBinding("owned", null);
    vi.unstubAllGlobals();
  });

  it("uses the packaged WebUI origin outside Tauri instead of guessing Runtime port 6121", () => {
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        host: "127.0.0.1:15173"
      }
    });

    expect(resolveWebSocketUrl("/ws?dashboard=true")).toBe(
      "ws://127.0.0.1:15173/ws?dashboard=true"
    );
  });

  it("uses the verified Runtime origin for an attached Tauri instance", () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
      location: {
        protocol: "http:",
        host: "tauri.localhost"
      }
    });
    setDesktopRuntimeBinding("attach", "http://127.0.0.1:16121");

    expect(resolveWebSocketUrl("/ws?dashboard=true")).toBe(
      "ws://127.0.0.1:16121/ws?dashboard=true"
    );
  });

  it("fails instead of inventing a browser WebSocket origin", () => {
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        host: ""
      }
    });

    expect(() => resolveWebSocketUrl("/ws?dashboard=true")).toThrow(
      /WebSocket origin is unavailable/
    );
  });
});

describe("Dashboard WebSocket credentials", () => {
  afterEach(async () => {
    const { apiClient } = await import("./client.js");
    apiClient.setDashboardDevToken("");
    vi.unstubAllGlobals();
  });
  it("keeps the existing development token out of the URL and sends it in a browser-supported credential header", async () => {
    const { apiClient } = await import("./client.js");
    const open = vi.fn();
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string, protocols: string[]) {
          open(url, protocols);
        }
      }
    );
    vi.stubGlobal("window", { location: { protocol: "http:", host: "127.0.0.1:6121" } });
    apiClient.setDashboardDevToken("dashboard-secret-令牌");
    apiClient.createDashboardWebSocket();
    const [url, protocols] = open.mock.calls[0]!;
    expect(url).toBe("ws://127.0.0.1:6121/ws?dashboard=true");
    expect(protocols[0]).toBe("yuvi-dashboard");
    expect(
      Buffer.from(protocols[1].slice("yuvi-dev-token.".length), "base64url").toString("utf8")
    ).toBe("dashboard-secret-令牌");
  });
});
