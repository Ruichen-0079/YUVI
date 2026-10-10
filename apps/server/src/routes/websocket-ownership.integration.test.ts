import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { InMemoryEventBus } from "@companion/event-bus";
import { createEvent } from "@companion/protocol";
import { describe, expect, it, vi } from "vitest";
import { registerWebSocketRoutes, ActiveTraceRegistry } from "./websocket.js";
import type { AppContext } from "../context.js";
import { loadServerConfig } from "../config.js";
const seed = 3211010;
async function scenario(
  kind: "unsupported" | "bad-payload" | "receipt-failure" | "runtime-failure",
  includeForeign = false
) {
  const app = Fastify();
  await app.register(websocket);
  const bus = new InMemoryEventBus({ development: false });
  const frames: Array<{ type: string; payload: { content?: string } }> = [];
  let started!: () => void, finish!: () => void;
  const running = new Promise<void>((r) => (started = r)),
    wait = new Promise<void>((r) => (finish = r));
  let admissions = 0,
    executions = 0;
  const context = {
    eventBus: bus,
    conversationalReceiptAdmission: {
      async admit(input: { content: string }) {
        if (++admissions === 2 && kind === "receipt-failure") throw Error("receipt rejected");
        return {
          envelope: { journalNamespace: "probe-journal", eventId: "jev1_aaaaaaaaaaaaaaaa" }
        };
      }
    },
    runtime: {
      async handleUserMessage(input: { payload: { content: string }; traceId: string }) {
        if (++executions === 2 && kind === "runtime-failure")
          throw Error("second operation failed");
        started();
        await wait;
        await bus.publish(
          createEvent(
            "agent.reply",
            { sessionId: "owned-session", content: "VALID_RESULT" },
            { traceId: input.traceId }
          )
        );
      }
    }
  } as unknown as AppContext;
  await registerWebSocketRoutes(app, context, loadServerConfig({ RUNTIME_MODE: "test" }));
  await app.ready();
  const socket = await app.injectWS(
    "/ws",
    {},
    {
      onInit(socket) {
        socket.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString())));
      }
    }
  );
  try {
    const valid = createEvent(
      "user.message",
      { sessionId: "owned-session", content: "first operation" },
      { traceId: "owned-trace" }
    );
    socket.send(JSON.stringify(valid));
    await running;
    const invalid =
      kind === "unsupported"
        ? createEvent(
            "agent.reply",
            { sessionId: "owned-session", content: "unsupported" },
            { traceId: valid.traceId }
          )
        : kind === "bad-payload"
          ? createEvent("user.message", { sessionId: "owned-session" }, { traceId: valid.traceId })
          : valid;
    socket.send(JSON.stringify(invalid));
    await vi.waitFor(() => expect(frames.some((f) => f.type === "runtime.error")).toBe(true));
    if (includeForeign)
      await bus.publish(
        createEvent(
          "agent.reply",
          { sessionId: "foreign-session", content: "FOREIGN_RESULT" },
          { traceId: valid.traceId }
        )
      );
    finish();
    await vi.waitFor(() =>
      expect(frames.some((f) => f.payload?.content === "VALID_RESULT")).toBe(true)
    );
    if (includeForeign) expect(JSON.stringify(frames)).not.toContain("FOREIGN_RESULT");
  } finally {
    finish();
    socket.terminate();
    await app.close();
  }
}
describe("WS resource ownership through actual route/EventBus", () => {
  it.each(["unsupported", "bad-payload", "receipt-failure", "runtime-failure"] as const)(
    "does not clear earlier valid work after %s",
    (kind) => scenario(kind)
  );
  it("does not disclose a different session on the same trace", () =>
    scenario("receipt-failure", true));
  it(`preserves admitted work under seeded invalid-event permutations; seed=${seed}`, async () => {
    let state = seed;
    const kinds = ["unsupported", "bad-payload", "receipt-failure", "runtime-failure"] as const;
    for (let i = 0; i < 16; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const kind = kinds[(state >>> 16) % 4]!;
      try {
        await scenario(kind, i % 2 === 0);
      } catch (e) {
        throw Error(`seed=${seed}; case=${i}; kind=${kind}; ${String(e)}`);
      }
    }
  });
});

it("keeps Publication predicates scoped and closing one connection leaves the other live", async () => {
  const app = Fastify();
  await app.register(websocket);
  const bus = new InMemoryEventBus({ development: false });
  const targets: Array<{
    match: (session: string, trace: string) => boolean;
    current: () => boolean;
    unregistered: boolean;
  }> = [];
  const context = {
    eventBus: bus,
    outwardEffects: {
      registerTarget(
        _target: unknown,
        match: (s: string, t: string) => boolean,
        current: () => boolean
      ) {
        const entry = { match, current, unregistered: false };
        targets.push(entry);
        return () => {
          entry.unregistered = true;
        };
      },
      async publish(input: { write: () => Promise<void> }) {
        await input.write();
      }
    },
    conversationalReceiptAdmission: {
      async admit() {
        return {
          envelope: { journalNamespace: "probe-journal", eventId: "jev1_aaaaaaaaaaaaaaaa" }
        };
      }
    },
    runtime: {
      async handleUserMessage(event: { payload: { sessionId: string }; traceId: string }) {
        await bus.publish(
          createEvent(
            "agent.reply",
            { sessionId: event.payload.sessionId, content: `answer:${event.payload.sessionId}` },
            { traceId: event.traceId }
          )
        );
      }
    }
  } as unknown as AppContext;
  await registerWebSocketRoutes(app, context, loadServerConfig({ RUNTIME_MODE: "test" }));
  await app.ready();
  const firstFrames: string[] = [],
    secondFrames: string[] = [];
  const first = await app.injectWS(
    "/ws",
    {},
    {
      onInit(ws) {
        ws.on("message", (data: Buffer) => firstFrames.push(data.toString()));
      }
    }
  );
  const second = await app.injectWS(
    "/ws",
    {},
    {
      onInit(ws) {
        ws.on("message", (data: Buffer) => secondFrames.push(data.toString()));
      }
    }
  );
  try {
    first.send(
      JSON.stringify(
        createEvent(
          "user.message",
          { sessionId: "first", content: "hello" },
          { traceId: "trace-first" }
        )
      )
    );
    second.send(
      JSON.stringify(
        createEvent(
          "user.message",
          { sessionId: "second", content: "hello" },
          { traceId: "trace-second" }
        )
      )
    );
    await vi.waitFor(() => {
      expect(firstFrames.join()).toContain("answer:first");
      expect(secondFrames.join()).toContain("answer:second");
    });
    expect(targets[0]!.match("first", "trace-first")).toBe(true);
    expect(targets[0]!.match("second", "trace-first")).toBe(false);
    expect(firstFrames.join()).not.toContain("answer:second");
    expect(secondFrames.join()).not.toContain("answer:first");
    first.terminate();
    await vi.waitFor(() => expect(targets[0]!.unregistered).toBe(true));
    expect(targets[0]!.current()).toBe(false);
    expect(targets[1]!.current()).toBe(true);
    second.send(
      JSON.stringify(
        createEvent(
          "user.message",
          { sessionId: "second", content: "again" },
          { traceId: "trace-second-2" }
        )
      )
    );
    await vi.waitFor(() => expect(secondFrames).toHaveLength(2));
  } finally {
    first.terminate();
    second.terminate();
    await app.close();
  }
});
