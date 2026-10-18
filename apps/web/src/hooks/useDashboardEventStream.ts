import { isTauriRuntime } from "../tauri-window.js";
import { useEffect, useRef, useState } from "react";
import { apiClient, type DashboardWebSocketMessage, type RuntimeEvent } from "../api/client.js";

export type DashboardEventStreamStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "paused"
  | "error";

/**
 * Shared dashboard Runtime event-stream subscription.
 * Used by Debug App and product MainPage so Presentation requests can be
 * forwarded without duplicating WebSocket reconnect / pause behavior.
 */
export function useDashboardEventStream({
  paused,
  onEvent
}: {
  paused: boolean;
  onEvent(event: RuntimeEvent): void;
}): DashboardEventStreamStatus {
  const [status, setStatus] = useState<DashboardEventStreamStatus>("connecting");
  const pausedRef = useRef(paused);
  const onEventRef = useRef(onEvent);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      setStatus((current) => (current === "connected" ? "paused" : current));
    } else {
      setStatus((current) => (current === "paused" ? "connected" : current));
    }
  }, [paused]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    // Product Host has conversational capabilities, never the operator event feed.
    if (isTauriRuntime()) { setStatus("paused"); return; }
    let closedByEffect = false;
    let socket: WebSocket | null = null;

    function connect(): void {
      setStatus((current) =>
        current === "disconnected" || current === "error" ? "reconnecting" : "connecting"
      );
      try { socket = apiClient.createDashboardWebSocket(); }
      catch { setStatus("error"); return; }

      socket.addEventListener("open", () => {
        if (closedByEffect) return;
        setStatus(pausedRef.current ? "paused" : "connected");
      });

      socket.addEventListener("message", (message) => {
        if (closedByEffect) return;
        const parsed = parseDashboardMessage(message.data);
        if (!parsed || isDashboardConnectedMessage(parsed) || pausedRef.current) {
          return;
        }
        onEventRef.current(parsed);
      });

      socket.addEventListener("error", () => {
        if (closedByEffect) return;
        setStatus("error");
      });

      socket.addEventListener("close", () => {
        if (closedByEffect) {
          return;
        }
        setStatus("disconnected");
        reconnectTimerRef.current = window.setTimeout(connect, 2000);
      });
    }

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      socket?.close();
    };
  }, []);

  return status;
}

export function parseDashboardMessage(raw: string): DashboardWebSocketMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (isDashboardConnectedMessage(parsed)) {
      return parsed;
    }
    if (isRuntimeEvent(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function isDashboardConnectedMessage(
  value: unknown
): value is Extract<DashboardWebSocketMessage, { kind: "dashboard.connected" }> {
  return Boolean(
    value && typeof value === "object" && "kind" in value && value.kind === "dashboard.connected"
  );
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  return Boolean(
    value &&
    typeof value === "object" &&
    "id" in value &&
    "type" in value &&
    "traceId" in value &&
    "payload" in value
  );
}
