import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { loadServerConfig } from "../config.js";
import { registerMemoryRoutes } from "./memory.js";
describe("explicit Memory withdrawal result fidelity", () => {
  it("reports confirmed, absent and unknown individual outcomes without pretending rollback", async () => {
    const app = Fastify();
    const deleted = vi.fn(async (id: string) => {
      if (id === "unknown") throw new Error("connection lost");
      return id === "confirmed";
    });
    await registerMemoryRoutes(
      app,
      { memoryRepository: { deleteMemory: deleted } } as unknown as AppContext,
      loadServerConfig({ RUNTIME_MODE: "production" })
    );
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/memory/bulk-delete",
        remoteAddress: "192.0.2.1",
        payload: { ids: ["confirmed"] }
      });
      expect(denied.statusCode).toBe(403);
      expect(deleted).not.toHaveBeenCalled();
      const reply = await app.inject({
        method: "POST",
        url: "/memory/bulk-delete",
        remoteAddress: "127.0.0.1",
        payload: { ids: ["confirmed", "absent", "unknown", "confirmed"] }
      });
      expect(reply.statusCode).toBe(207);
      expect(reply.json()).toMatchObject({
        ok: false,
        deleted: 1,
        status: "PARTIAL",
        outcomes: [
          { id: "confirmed", status: "DELETED" },
          { id: "absent", status: "NOT_FOUND" },
          { id: "unknown", status: "UNKNOWN" }
        ]
      });
      expect(deleted).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });
  it("preserves successful local withdrawal without Journal availability", async () => {
    const app = Fastify();
    await registerMemoryRoutes(
      app,
      { memoryRepository: { deleteMemory: async () => true } } as unknown as AppContext,
      loadServerConfig({ RUNTIME_MODE: "production" })
    );
    try {
      const r = await app.inject({
        method: "POST",
        url: "/memory/bulk-delete",
        remoteAddress: "127.0.0.1",
        payload: { ids: ["one"] }
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, deleted: 1, status: "DELETED" });
    } finally {
      await app.close();
    }
  });
});
