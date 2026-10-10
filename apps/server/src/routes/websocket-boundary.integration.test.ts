import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { InMemoryEventBus } from "@companion/event-bus";
import { createEvent } from "@companion/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { registerWebSocketRoutes } from "./websocket.js";
import { registerEventRoutes } from "./events.js";
import { registerDebugRoutes } from "./debug.js";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(token?: string) {
  const app = Fastify();
  await app.register(websocket);
  const bus = new InMemoryEventBus({ development: false });
  const config = loadServerConfig({ RUNTIME_MODE: "development", DASHBOARD_DEV_TOKEN: token });
  const context = {
    eventBus: bus,
    runtime: {
      handleUserMessage: vi.fn(),
      getLatestPromptPreview: () => ({ userMessage: "PRIVATE_PROMPT" })
    },
    dashboard: { listRecentEvents: () => [{ payload: { content: "PRIVATE_HISTORY" } }] }
  } as unknown as AppContext;
  await registerWebSocketRoutes(app, context, config);
  await registerEventRoutes(app, context, config);
  await registerDebugRoutes(app, context, config);
  await app.ready();
  cleanup.push(() => app.close());
  return { app, bus };
}
async function connect(
  app: Awaited<ReturnType<typeof fixture>>["app"],
  path: string,
  headers: Record<string, string> = {}
) {
  const frames: unknown[] = [];
  const socket = await app.injectWS(
    path,
    { headers, socket: { remoteAddress: "127.0.0.1" } } as never,
    {
      onInit(socket) {
        socket.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString())));
      }
    }
  );
  cleanup.push(() => socket.terminate());
  return frames;
}
async function foreignReply(bus: InMemoryEventBus) {
  await bus.publish(
    createEvent(
      "agent.reply",
      { sessionId: "unrelated-session", content: "FOREIGN_BODY" },
      { traceId: "foreign-trace" }
    )
  );
  await new Promise((r) => setTimeout(r, 10));
}
describe("diagnostic boundary through real WS route and EventBus", () => {
  it.each(["/ws", "/ws?dashboard=false"])("keeps ordinary connection scoped: %s", async (path) => {
    const { app, bus } = await fixture();
    const frames = await connect(app, path);
    await foreignReply(bus);
    expect(JSON.stringify(frames)).not.toContain("FOREIGN_BODY");
  });
  it("retains authenticated local Dashboard events", async () => {
    const { app, bus } = await fixture("test-diagnostic-secret");
    const frames = await connect(app, "/ws?dashboard=true", {
      authorization: "Bearer test-diagnostic-secret"
    });
    await foreignReply(bus);
    expect(JSON.stringify(frames)).toContain("FOREIGN_BODY");
  });
  it("accepts existing token via browser WS subprotocol without putting it in the URL", async () => {
    const { app, bus } = await fixture("test-diagnostic-secret");
    const credential = Buffer.from("test-diagnostic-secret").toString("base64url");
    const frames = await connect(app, "/ws?dashboard=true", {
      "sec-websocket-protocol": `yuvi-dashboard, yuvi-dev-token.${credential}`
    });
    await foreignReply(bus);
    expect(JSON.stringify(frames)).toContain("FOREIGN_BODY");
  });
  it("rejects unauthenticated diagnostic upgrade", async () => {
    const { app } = await fixture("test-diagnostic-secret");
    await expect(
      app.injectWS("/ws?dashboard=true", { socket: { remoteAddress: "127.0.0.1" } } as never)
    ).rejects.toThrow("401");
  });
  it.each(["0", "1", "False", "TRUE", "yes", "", "null", "false&dashboard=true"])(
    "rejects ambiguous query %s rather than falling back",
    async (value) => {
      const { app } = await fixture();
      await expect(
        app.injectWS(`/ws?dashboard=${value}`, { socket: { remoteAddress: "127.0.0.1" } } as never)
      ).rejects.toThrow("400");
    }
  );
  it("does not expose equivalent replay/prompt routes without local permission", async () => {
    const { app } = await fixture("test-diagnostic-secret");
    for (const url of ["/events/recent", "/debug/prompt/latest"]) {
      expect((await app.inject({ url, remoteAddress: "127.0.0.1" })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url,
            remoteAddress: "192.0.2.9",
            headers: { authorization: "Bearer test-diagnostic-secret" }
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await app.inject({
            url,
            remoteAddress: "127.0.0.1",
            headers: { authorization: "Bearer test-diagnostic-secret" }
          })
        ).statusCode
      ).toBe(200);
    }
  });
  it("rejects remote diagnostic upgrade even with the development token", async () => {
    const { app } = await fixture("test-diagnostic-secret");
    await expect(
      app.injectWS("/ws?dashboard=true", {
        socket: { remoteAddress: "192.0.2.9" },
        headers: { authorization: "Bearer test-diagnostic-secret" }
      } as never)
    ).rejects.toThrow("403");
  });
});
