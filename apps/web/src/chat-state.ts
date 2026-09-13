import type { ProviderCallMetadata } from "./api/client.js";

export type ChatMessageStatus = "streaming" | "completed" | "failed" | "cancelled";

export type ChatMessage = {
  id: string;
  requestId?: string;
  role: "user" | "assistant";
  content: string;
  status?: ChatMessageStatus;
  error?: string;
  traceId?: string;
  useMemory?: boolean;
  readMemory?: boolean;
  writeMemory?: boolean;
  voiceOutput?: boolean;
  /** Presentation-only attachment preview; never a persisted conversation field. */
  imageAttachment?: {
    name: string;
    dataUrl: string;
  };
  provider?: ProviderCallMetadata | string;
};

export type StreamingAssistantChatMessage = Omit<ChatMessage, "role" | "status"> & {
  role: "assistant";
  status: "streaming";
};

export type ChatMessageAction =
  | { type: "reset" }
  | { type: "hydrate"; messages: ChatMessage[] }
  | { type: "bind-trace"; assistantId: string; traceId: string }
  | { type: "append-turn"; user: ChatMessage; assistant: ChatMessage }
  | { type: "append-assistant"; assistant: StreamingAssistantChatMessage }
  | { type: "append-delta"; assistantId: string; text: string; traceId: string }
  | {
      type: "complete";
      assistantId: string;
      content: string;
      traceId: string;
      provider: string;
    }
  | { type: "fail"; assistantId: string; error: string }
  | { type: "cancel"; assistantId: string; error: string };

export function reduceChatMessages(
  messages: ChatMessage[],
  action: ChatMessageAction
): ChatMessage[] {
  if (action.type === "reset") return [];
  if (action.type === "hydrate") {
    // Keep local IDs while their stream callbacks still reference them. Repository
    // status/content wins once the request is idle; hydration never plays speech.
    const remaining = [...messages];
    const restored = action.messages.map((stored) => {
      const index = remaining.findIndex((local) => local.id === stored.id ||
        (local.traceId && local.traceId === stored.traceId && local.role === stored.role));
      if (index < 0) return stored;
      const local = remaining.splice(index, 1)[0]!;
      return { ...local, ...stored, id: local.id };
    });
    return [...restored, ...remaining];
  }
  if (action.type === "bind-trace") {
    const target = messages.find((message) => message.id === action.assistantId);
    return messages.map((message) => message.id === action.assistantId ||
      (target?.requestId && message.requestId === target.requestId)
      ? { ...message, traceId: action.traceId } : message);
  }
  if (action.type === "append-turn") {
    return [...messages, action.user, action.assistant];
  }
  if (action.type === "append-assistant") {
    return [...messages, action.assistant];
  }

  const target = messages.find(
    (message) => message.id === action.assistantId && message.role === "assistant"
  );
  if (!target) {
    return messages;
  }

  if (action.type === "append-delta") {
    if (target.status !== "streaming") {
      return messages;
    }
    return replaceAssistant(messages, action.assistantId, {
      content: target.content + action.text,
      traceId: action.traceId
    });
  }

  if (action.type === "complete") {
    if (target.status === "completed") {
      return messages;
    }
    if (target.status !== "streaming") {
      return messages;
    }
    return replaceAssistant(messages, action.assistantId, {
      content: action.content,
      traceId: action.traceId,
      provider: action.provider,
      status: "completed"
    });
  }

  if (target.status !== "streaming") {
    return messages;
  }
  return replaceAssistant(messages, action.assistantId, {
    status: action.type === "cancel" ? "cancelled" : "failed",
    error: action.error
  });
}

export function shouldSubmitChatKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

/** Preserve the exact submitted text while rejecting blank-only messages. */
export function getSubmittedChatText(input: string): string | null {
  return input.trim() ? input : null;
}

/**
 * Begin a controlled-draft submit: capture payload and the empty next draft in
 * one step so callers never re-read the textarea for the request body.
 */
export function beginControlledDraftSubmit(draft: string): {
  submittedText: string;
  nextDraft: "";
} | null {
  const submittedText = getSubmittedChatText(draft);
  if (submittedText === null) return null;
  return { submittedText, nextDraft: "" };
}

function replaceAssistant(
  messages: ChatMessage[],
  assistantId: string,
  update: Partial<ChatMessage>
): ChatMessage[] {
  return messages.map((message) =>
    message.id === assistantId ? { ...message, ...update } : message
  );
}
