import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ServerPluginLifecycle } from "../plugin-lifecycle.js";
import type {
  CharacterSurfacePort,
  SurfaceInput,
  SurfaceResult
} from "../character-surface-host.js";
import { QQTransport } from "./qq-transport.js";
import { wire } from "./qq-fixture.js";
const servers: WebSocketServer[] = [],
  lifecycles: ServerPluginLifecycle[] = [];
afterEach(async () => {
  for (const l of lifecycles.splice(0)) await l.shutdown();
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
async function fixture(mode: "RESPOND" | "SILENCE" = "RESPOND", loseAck = false) {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  if (typeof address === "string" || !address) throw Error("address unavailable");
  let sockets: WebSocket[] = [];
  const sends: unknown[] = [];
  const inputs: SurfaceInput[] = [];
  let hold: Promise<void> | undefined;
  server.on("connection", (s, request) => {
    expect(request.headers.authorization).toBe("Bearer fixture-token");
    sockets.push(s);
    s.on("message", (bytes) => {
      const e = JSON.parse(bytes.toString());
      if (e.action.startsWith("send_")) {
        sends.push(e);
        if (loseAck) {
          s.close();
          return;
        }
      }
      const data =
        e.action === "get_version_info"
          ? { app_name: "SnowLuma", app_version: "1.14.19-node", protocol_version: "v11" }
          : e.action === "get_login_info"
            ? { user_id: 42 }
            : e.action === "get_status"
              ? { online: true, good: true }
              : { message_id: -102 };
      s.send(JSON.stringify({ status: "ok", retcode: 0, echo: e.echo, data }));
    });
  });
  const receive = vi.fn<CharacterSurfacePort["receive"]>(async (input, connection) => {
    inputs.push(input);
    await hold;
    const result = (outcome: SurfaceResult["outcome"]): SurfaceResult => ({
      speaker: { principalId: input.actorId },
      sourceJournalRef: {
        kind: "JOURNAL_EVENT",
        namespace: "test",
        eventId: "jev1_0000000000000001"
      },
      outcome
    });
    if (!connection.isCurrent()) return result("STALE");
    if (!input.admission) return result("OBSERVED");
    if (mode === "SILENCE") return result("SILENCE");
    try {
      await connection.write("Alice says hello", connection.signal);
      return result("RESPOND");
    } catch {
      return result("UNKNOWN");
    }
  });
  const traces: unknown[] = [];
  const transport = new QQTransport(
    {
      endpoint: `ws://127.0.0.1:${address.port}/`,
      accessToken: "fixture-token",
      expectedAccount: "42",
      namespace: "fixture:42",
      privatePeers: ["7"],
      groups: ["99"],
      mediaRoots: []
    },
    { receive },
    (e) => traces.push(e)
  );
  const lifecycle = new ServerPluginLifecycle(() => [transport.source()], { warn: () => {} });
  lifecycles.push(lifecycle);
  await lifecycle.discover();
  await lifecycle.load();
  await lifecycle.start();
  expect(lifecycle.snapshot().plugins[0]?.state).toBe("STARTED");
  return {
    server,
    transport,
    lifecycle,
    receive,
    sends,
    inputs,
    traces,
    socket: () => sockets.at(-1)!,
    send: (e: unknown) => sockets.at(-1)!.send(JSON.stringify(e)),
    hold: (p: Promise<void>) => {
      hold = p;
    }
  };
}
describe("SnowLuma transport contract over actual fixture sockets", () => {
  it("authenticates readiness then handles private, @Alice, reply Alice, quote and self echo", async () => {
    const f = await fixture();
    f.send(wire({ message_type: "private" }));
    await vi.waitFor(() => expect(f.sends).toHaveLength(1));
    f.send(
      wire({
        message_id: 22,
        message: [
          { type: "at", data: { qq: 42 } },
          { type: "text", data: { text: "hi" } }
        ]
      })
    );
    await vi.waitFor(() => expect(f.sends).toHaveLength(2));
    f.send(
      wire({
        message_id: 23,
        message: [
          { type: "reply", data: { id: -102 } },
          { type: "text", data: { text: "quote" } }
        ]
      })
    );
    await vi.waitFor(() => expect(f.sends).toHaveLength(3));
    expect(f.inputs.at(-1)).toMatchObject({
      admission: "REPLY",
      reply: { state: "OBSERVED", text: "Alice says hello" }
    });
    f.send(
      wire({ message_id: 24, post_type: "message_sent", user_id: 42, sender: { user_id: 42 } })
    );
    await vi.waitFor(() => expect(f.inputs).toHaveLength(4));
    expect(f.sends).toHaveLength(3);
  });
  it("SILENCE produces no OneBot send action; outside-grant messages are not admitted", async () => {
    const f = await fixture("SILENCE");
    f.send(wire({ message_type: "private" }));
    await vi.waitFor(() => expect(f.receive).toHaveBeenCalledOnce());
    expect(f.sends).toHaveLength(0);
    f.send(wire({ group_id: 100 }));
    f.send(wire({ self_id: 43 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(f.receive).toHaveBeenCalledOnce();
  });
  it("restores readiness after reconnect and prevents stale generation publication", async () => {
    const f = await fixture();
    let release!: () => void;
    f.hold(
      new Promise<void>((r) => {
        release = r;
      })
    );
    f.send(wire({ message_type: "private" }));
    await vi.waitFor(() => expect(f.receive).toHaveBeenCalledOnce());
    const generation = f.transport.snapshot().generation;
    f.socket().close();
    await vi.waitFor(() => expect(f.transport.snapshot().ready).toBe(false));
    release();
    await vi.waitFor(() => expect(f.transport.snapshot().ready).toBe(true), { timeout: 2500 });
    expect(f.transport.snapshot().generation).not.toBe(generation);
    expect(f.sends).toHaveLength(0);
  });
  it("lost ACK remains UNKNOWN and reconnect never resends the action", async () => {
    const f = await fixture("RESPOND", true);
    f.send(wire({ message_type: "private" }));
    await vi.waitFor(() => expect(f.sends).toHaveLength(1));
    await vi.waitFor(() =>
      expect(f.traces).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "RECEIPT", outcome: "UNKNOWN" })])
      )
    );
    await vi.waitFor(() => expect(f.transport.snapshot().ready).toBe(true), { timeout: 2500 });
    expect(f.sends).toHaveLength(1);
    expect(f.transport.snapshot().pending).toBe(0);
  });
});
