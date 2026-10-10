import { createEvent } from "@companion/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_TRACE_MAX_ENTRIES,
  ACTIVE_TRACE_RETENTION_MS,
  ActiveTraceRegistry,
  shouldForwardEvent
} from "./websocket.js";

describe("WebSocket reply compatibility filter", () => {
  it("forwards agent.reply but does not forward assistant.message twice", () => {
    const user = createEvent("user.message", {
      sessionId: "session-1",
      content: "hello"
    });
    const agent = createEvent(
      "agent.reply",
      { sessionId: user.payload.sessionId, content: "hi" },
      { traceId: user.traceId, parentId: user.id }
    );
    const assistant = createEvent(
      "assistant.message",
      { sessionId: user.payload.sessionId, content: "hi" },
      { traceId: user.traceId, parentId: agent.id }
    );

    expect(shouldForwardEvent(agent)).toBe(true);
    expect(shouldForwardEvent(assistant)).toBe(false);
  });

  it("bounds terminal traces while preserving active in-flight traces", () => {
    const registry = new ActiveTraceRegistry();
    for (let index = 0; index < ACTIVE_TRACE_MAX_ENTRIES + 44; index += 1) {
      expect(registry.add(`terminal-${index}`)).toBe(true);
      registry.observe(
        createEvent(
          "agent.reply",
          {
            sessionId: "session-1",
            content: "done"
          },
          { traceId: `terminal-${index}` }
        )
      );
    }

    expect(registry.size).toBe(ACTIVE_TRACE_MAX_ENTRIES);
    expect(registry.has("terminal-0")).toBe(false);
    expect(registry.has(`terminal-${ACTIVE_TRACE_MAX_ENTRIES + 43}`)).toBe(true);

    const inFlight = new ActiveTraceRegistry();
    for (let index = 0; index < ACTIVE_TRACE_MAX_ENTRIES; index += 1) {
      expect(inFlight.add(`active-${index}`)).toBe(true);
    }
    expect(inFlight.add("overflow")).toBe(false);
    expect(inFlight.size).toBe(ACTIVE_TRACE_MAX_ENTRIES);
    expect(inFlight.has("active-0")).toBe(true);

    inFlight.observe(
      createEvent(
        "agent.reply",
        {
          sessionId: "session-1",
          content: "done"
        },
        { traceId: "active-0" }
      )
    );
    expect(inFlight.add("overflow")).toBe(true);
    expect(inFlight.has("active-0")).toBe(false);
  });

  it("expires terminal traces after the configured retention window", () => {
    vi.useFakeTimers();
    try {
      const registry = new ActiveTraceRegistry();
      registry.add("expiring-trace");
      registry.observe(
        createEvent(
          "agent.reply",
          { sessionId: "session-1", content: "done" },
          { traceId: "expiring-trace" }
        )
      );
      vi.advanceTimersByTime(ACTIVE_TRACE_RETENTION_MS);
      expect(registry.has("expiring-trace")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WebSocket trace ownership", () => {
  it("only releases the generation actually created by a request", () => {
    const registry = new ActiveTraceRegistry();
    const old = registry.claim("trace", "session", "request-a")!;
    expect(old.created).toBe(true);
    expect(registry.claim("trace", "session", "request-a")?.created).toBe(false);
    expect(registry.claim("trace", "foreign", "request-a")).toBeNull();
    expect(registry.claim("trace", "session", "request-b")).toBeNull();
    registry.deleteOwned("trace", old.owner);
    const fresh = registry.claim("trace", "session", "request-b")!;
    registry.deleteOwned("trace", old.owner);
    expect(registry.has("trace")).toBe(true);
    registry.deleteOwned("trace", fresh.owner);
    expect(registry.has("trace")).toBe(false);
  });
  it("rejects foreign session terminal events and retains genuine completion/expiry", () => {
    const registry = new ActiveTraceRegistry();
    vi.useFakeTimers();
    try {
      registry.claim("trace", "session", "request");
      registry.observe(
        createEvent("runtime.error", { sessionId: "foreign" }, { traceId: "trace" })
      );
      expect(registry.has("trace")).toBe(true);
      registry.observe(
        createEvent("agent.reply", { sessionId: "session", content: "done" }, { traceId: "trace" })
      );
      vi.advanceTimersByTime(ACTIVE_TRACE_RETENTION_MS);
      expect(registry.has("trace")).toBe(false);
      registry.claim("trace", "session", "new-request");
      registry.observe(
        createEvent("runtime.error", { sessionId: "session" }, { traceId: "trace" })
      );
      expect(registry.has("trace")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
