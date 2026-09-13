import { useEffect, useState, type Dispatch } from "react";
import { apiClient } from "./api/client.js";
import type { ChatMessageAction } from "./chat-state.js";

/** Persist only the selected identity, never a transcript. Defaults retain existing sessions. */
export function useConversationSession(defaultId: string) {
  const key = `yuvi.conversation-session.${defaultId}`;
  const [sessionId, setSessionId] = useState(() => {
    try {
      return localStorage.getItem(key)?.trim() || defaultId;
    } catch {
      return defaultId;
    }
  });
  useEffect(() => {
    try {
      if (sessionId.trim()) localStorage.setItem(key, sessionId);
    } catch {
      /* Identity defaults remain stable. */
    }
  }, [key, sessionId]);
  return [sessionId, setSessionId] as const;
}

export function useConversationHistory(
  sessionId: string,
  busy: boolean,
  dispatch: Dispatch<ChatMessageAction>
): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    dispatch({ type: "reset" });
  }, [sessionId, dispatch]);
  useEffect(() => {
    if (busy || !sessionId.trim()) return;
    let disposed = false;
    let loading = false;
    const abort = new AbortController();
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const history = await apiClient.getConversationHistory(sessionId, abort.signal);
        if (!disposed) {
          dispatch({ type: "hydrate", messages: history.messages });
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        loading = false;
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      abort.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [sessionId, busy, dispatch]);
  return error;
}
