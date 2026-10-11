import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import { registerMemoryRoutes } from "./memory.js";
import { loadServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { MemoryMaintenanceScheduler } from "../services/memoryMaintenanceScheduler.js";

describe("Authority retirement of legacy semantic paths", () => {
  it("rejects legacy reads and writes, preserves v1 routing and checks local access first", async () => {
    const app = Fastify();
    const mutation = vi.fn();
    const context = {
      memory: { usesSemanticMemoryPolicy: () => true },
      memoryRepository: { deleteMemory: mutation }
    } as unknown as AppContext;
    await registerMemoryRoutes(app, context, loadServerConfig({ RUNTIME_MODE: "production" }));
    app.get("/memory/v1/example", async () => ({ schema: "example.v1" }));
    try {
      for (const request of [
        { method: "GET" as const, url: "/memory/search?q=private" },
        { method: "POST" as const, url: "/memory", payload: { content: "manual" } },
        { method: "POST" as const, url: "/memory/bulk-delete", payload: { ids: ["old"] } }
      ]) {
        const result = await app.inject(request);
        expect(result.statusCode).toBe(410);
        expect(result.json()).toMatchObject({
          error: "MEMORY_LEGACY_API_RETIRED",
          compatibility: "EXPLICIT_MIGRATION_REQUIRED"
        });
      }
      expect(
        (await app.inject({ url: "/memory/search", remoteAddress: "192.0.2.1" })).statusCode
      ).toBe(403);
      expect((await app.inject({ url: "/memory/v1/example" })).json()).toEqual({
        schema: "example.v1"
      });
      expect(mutation).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("keeps Conversation recovery without running legacy expiration or supersession", async () => {
    const app = Fastify();
    const recover = vi.fn(async () => []);
    const context = {
      memory: { usesSemanticMemoryPolicy: () => true },
      runtime: { recoverStaleStreamingMessages: recover },
      memoryRepository: new Proxy(
        {},
        {
          get() {
            throw Error("legacy repository must not be accessed");
          }
        }
      )
    } as unknown as AppContext;
    const scheduler = new MemoryMaintenanceScheduler(context, loadServerConfig({}), app.log);
    expect(await scheduler.run("manual")).toMatchObject({ scanned: 0, expired: 0, failed: 0 });
    expect(recover).toHaveBeenCalledOnce();
    expect(scheduler.getStatus().mode).toBe("CONVERSATION_RECOVERY_ONLY");
    await app.close();
  });
});
