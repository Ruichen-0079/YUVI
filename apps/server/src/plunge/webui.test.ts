import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { protectPlunge } from "./webui.js";
import { PlungeInspector } from "./inspector.js";
import type { ChatInput, ChatProvider, ProviderRegistry } from "@companion/providers";

const token = "a".repeat(64);
describe("Plunge management access boundary", () => {
  it("protects private reads and direct writes in production, rejects foreign Origin and Host, and serves only fixed assets publicly", async () => {
    const app = Fastify();
    protectPlunge(app, token);
    for (const url of ["/memory/recent", "/plunge/api/prompts", "/plunge", "/plunge/app.js"])
      app.get(url, async () => ({ ok: true }));
    app.post("/memory", async () => ({ bypass: true }));
    app.post("/memory/search", async () => ({ ok: true }));
    app.post("/plunge/api/apps/qq/open", async () => ({ opened: true }));
    const headers = { host: "127.0.0.1:6135", authorization: `Bearer ${token}` };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/plunge/api/apps/qq/open",
          headers: { host: headers.host }
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/plunge/api/apps/qq/open",
          headers: { ...headers, origin: "https://attacker.example" }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await app.inject({ url: "/memory/recent", headers: { host: headers.host } })).statusCode
    ).toBe(401);
    expect((await app.inject({ url: "/plunge/api/prompts", headers })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: "/plunge/api/prompts",
          headers: { ...headers, origin: "https://attacker.example" }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/plunge/api/prompts",
          headers: { ...headers, host: "attacker.example" }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await app.inject({ url: "/plunge/api/prompts", headers, remoteAddress: "192.168.1.2" }))
        .statusCode
    ).toBe(403);
    expect((await app.inject({ url: "/plunge", headers: { host: headers.host } })).statusCode).toBe(
      200
    );
    expect((await app.inject({ method: "POST", url: "/memory", headers })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/memory?bypass=1", headers })).statusCode
    ).toBe(403);
    expect((await app.inject({ method: "POST", url: "/memory/search", headers })).statusCode).toBe(
      200
    );
    await app.close();
  });
});
describe("actual ChatModel input inspection", () => {
  it("captures the exact submitted input once, copies spans without rebuilding and preserves provider outputs and failure", async () => {
    const received: ChatInput[] = [];
    const provider: ChatProvider = {
      name: "fixture",
      healthCheck: async () => ({
        provider: "fixture",
        status: "healthy",
        checkedAt: new Date().toISOString()
      }),
      generateReply: async (input) => {
        received.push(input);
        if (input.model === "fail") throw Error("failure");
        return {
          message: {
            role: "assistant",
            content: input.model === "none" ? '{"authorization":"NONE"}' : "SILENCE"
          },
          model: "model-live"
        };
      },
      async *streamReply(input) {
        received.push(input);
        yield { type: "text-delta", text: "same" };
        yield {
          type: "completed",
          output: {
            message: { role: "assistant", content: "same" },
            finalProvider: "fallback-live"
          }
        };
      }
    };
    const inspector = new PlungeInspector(),
      registry = { getChatProvider: () => provider } as ProviderRegistry;
    inspector.observe(registry);
    inspector.observe(registry);
    const input: ChatInput = {
      messages: [
        { role: "system", content: "authored\nexact persona" },
        { role: "user", content: 'quote "literal"\ncurrent' }
      ],
      contextProjectionSpans: [{ key: "PERSONA", messageIndex: 0, offset: 9, characters: 13 }]
    };
    expect((await provider.generateReply(input)).message.content).toBe("SILENCE");
    expect(received[0]).toBe(input);
    const record = inspector.get(inspector.list()[0]!.id)!;
    expect(record.input).toEqual(input);
    expect(record.parts[0]?.text).toBe(input.messages[0]!.content.slice(9, 22));
    input.messages[0]!.content = "changed later";
    expect(record.input.messages[0]!.content).toBe("authored\nexact persona");
    await provider.generateReply({ ...input, model: "none" });
    expect(inspector.list()[0]?.decision?.["authorization"]).toBe("NONE");
    const stream = [];
    for await (const event of provider.streamReply!(input)) stream.push(event);
    expect(stream[0]).toEqual({ type: "text-delta", text: "same" });
    expect(inspector.list()[0]?.finalProvider).toBe("fallback-live");
    await expect(provider.generateReply({ ...input, model: "fail" })).rejects.toThrow("failure");
    expect(inspector.list()[0]?.outcome).toBe("FAILED");
    for (let i = 0; i < 14; i++) await provider.generateReply(input);
    expect(inspector.list()).toHaveLength(12);
    expect(inspector.get(record.id)).toBeNull();
  });
});
