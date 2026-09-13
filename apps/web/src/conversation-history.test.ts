import { describe, expect, it } from "vitest";
import { reduceChatMessages, type ChatMessage } from "./chat-state.js";
import { subtitlePageCapacity, paginateSubtitleText } from "./subtitle-projection.js";

describe("history reconciliation", () => {
  it("reconciles local turn IDs with persisted trace/role without a duplicate final", () => {
    let messages = reduceChatMessages([], {
      type: "append-turn",
      user: { id: "local-u", requestId: "request", role: "user", content: "hi" },
      assistant: {
        id: "local-a",
        requestId: "request",
        role: "assistant",
        content: "",
        status: "streaming"
      }
    });
    messages = reduceChatMessages(messages, {
      type: "bind-trace",
      assistantId: "local-a",
      traceId: "trace"
    });
    messages = reduceChatMessages(messages, {
      type: "complete",
      assistantId: "local-a",
      traceId: "trace",
      content: "hello",
      provider: "test"
    });
    const stored: ChatMessage[] = [
      { id: "db-u", role: "user", content: "hi", status: "completed", traceId: "trace" },
      { id: "db-a", role: "assistant", content: "hello", status: "completed", traceId: "trace" }
    ];
    for (let i = 0; i < 3; i++)
      messages = reduceChatMessages(messages, { type: "hydrate", messages: stored });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ id: "local-a", content: "hello", status: "completed" });
    expect(reduceChatMessages([], { type: "hydrate", messages: stored })).toEqual(stored);
    expect(reduceChatMessages(messages, { type: "reset" })).toEqual([]);
  });
  it("uses persisted failed/cancelled/streaming states without converting partials to finals", () => {
    for (const status of ["failed", "cancelled", "streaming"] as const) {
      expect(
        reduceChatMessages([], {
          type: "hydrate",
          messages: [{ id: status, role: "assistant", content: "partial", status }]
        })[0]?.status
      ).toBe(status);
    }
  });
});

describe("subtitle resized reflow", () => {
  it.each([
    [280, 100],
    [720, 140],
    [400, 300],
    [1000, 200]
  ])("preserves every character at %sx%s", (w, h) => {
    const text = "这是用于字幕窗口缩放的长文本。".repeat(20);
    const capacity = subtitlePageCapacity(w, h);
    const pages = paginateSubtitleText(text, capacity);
    expect(pages.join("")).toBe(text);
    expect(pages.every((page) => page.length <= capacity)).toBe(true);
  });
});
