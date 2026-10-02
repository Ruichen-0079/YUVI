import { describe, expect, it, vi } from "vitest";
import { Mem0MemoryBackend } from "./mem0-memory-backend.js";
import { MemoryBackendError } from "../backend.js";
import { buildMemoryScope } from "../scope.js";

describe("Mem0MemoryBackend", () => {
  it("requires baseUrl", () => {
    expect(() => new Mem0MemoryBackend({ baseUrl: "" })).toThrow(MemoryBackendError);
  });

  it("calls health and validates envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        ok: true,
        data: {
          status: "healthy",
          backend: "mem0",
          embedding: {
            provider: "ollama",
            model: "yuvi-embedding:0.6b",
            dimensions: 1024
          },
          collection: "yuvi_mem0_qwen3_1024_v1"
        }
      })
    );
    const backend = new Mem0MemoryBackend({
      baseUrl: "http://127.0.0.1:6130",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const health = await backend.health();
    expect(health.status).toBe("healthy");
    expect(health.embedding?.dimensions).toBe(1024);
    expect(health.embedding?.model).toBe("yuvi-embedding:0.6b");
    expect(health.collection).toBe("yuvi_mem0_qwen3_1024_v1");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("adds with infer=false and returns memoryId", async () => {
    const scope = buildMemoryScope("user-a", "alice");
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.infer).toBe(false);
      expect(body.scope).toBe(scope);
      expect(body.content).toContain("蓝色");
      return Response.json({
        ok: true,
        data: {
          memoryId: "mem-1",
          operation: "created",
          record: {
            id: "mem-1",
            content: body.content,
            scope,
            metadata: body.metadata
          }
        }
      });
    });
    const backend = new Mem0MemoryBackend({
      baseUrl: "http://127.0.0.1:6130",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const result = await backend.add({
      scope,
      content: "用户最喜欢蓝色。",
      infer: false,
      metadata: { explicit: true, memoryType: "preference", language: "zh" }
    });
    expect(result.memoryId).toBe("mem-1");
    expect(result.operation).toBe("created");
  });

  it("runs bounded pre/finally mutation notices without changing a successful write", async () => {
    const scope = buildMemoryScope("user-a", "alice");
    const notices: Array<{ scope: string; reason: string }> = [];
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true, data: { memoryId: "mem-profile-notice", operation: "created" } })
    );
    const backend = new Mem0MemoryBackend({
      baseUrl: "http://127.0.0.1:6130",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onProfileMutation: async (notice) => {
        notices.push(notice);
        throw new Error("lifecycle store unavailable");
      }
    });
    await expect(backend.add({ scope, content: "fact", infer: false })).resolves.toMatchObject({
      memoryId: "mem-profile-notice"
    });
    expect(notices).toEqual([
      { scope, reason: "DELIVERY_DISPATCHED" },
      { scope, reason: "DELIVERY_OBSERVED" }
    ]);
    expect(backend.getProfileNotificationFailureCount()).toBe(2);
  });

  it("submits and reconciles keyed finalized writes through exact sidecar routes", async () => {
    const scope = buildMemoryScope("user-a", "alice");
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(_url).endsWith("/reconcile")) {
        expect(body).toEqual({ idempotencyKey: "key-1", payloadDigest: "digest-1" });
        return Response.json({ ok: true, data: { status: "applied", memoryId: "mem-1" } });
      }
      expect(String(_url)).toContain("/idempotent");
      expect(body).toMatchObject({
        scope,
        infer: false,
        idempotencyKey: "key-1",
        payloadDigest: "digest-1"
      });
      return Response.json({ ok: true, data: { memoryId: "mem-1", operation: "created" } });
    });
    const backend = new Mem0MemoryBackend({
      baseUrl: "http://127.0.0.1:6130",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(
      backend.submitIdempotent({
        scope,
        content: "fact",
        infer: false,
        idempotencyKey: "key-1",
        payloadDigest: "digest-1"
      })
    ).resolves.toMatchObject({ memoryId: "mem-1" });
    await expect(
      backend.reconcileIdempotency({ idempotencyKey: "key-1", payloadDigest: "digest-1" })
    ).resolves.toMatchObject({ status: "applied", memoryId: "mem-1" });
  });

  it("maps 404 to MEMORY_NOT_FOUND and get returns null", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          ok: false,
          error: { code: "MEMORY_NOT_FOUND", message: "missing", retryable: false }
        },
        { status: 404 }
      )
    );
    const backend = new Mem0MemoryBackend({
      baseUrl: "http://127.0.0.1:6130",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(backend.get({ memoryId: "missing" })).resolves.toBeNull();
  });

  it("times out with OPERATION_TIMEOUT", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );
    const backend = new Mem0MemoryBackend({
      baseUrl: "http://127.0.0.1:6130",
      timeoutMs: 30,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(
      backend.search({ scope: buildMemoryScope("u", "c"), query: "hello" })
    ).rejects.toMatchObject({ code: "OPERATION_TIMEOUT" });
  });

  it("rejects invalid JSON from sidecar", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));
    const backend = new Mem0MemoryBackend({
      baseUrl: "http://127.0.0.1:6130",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(backend.health()).rejects.toBeInstanceOf(MemoryBackendError);
  });

  it("does not invent scopes inside the adapter", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, data: { items: [], total: 0 } }));
    const backend = new Mem0MemoryBackend({
      baseUrl: "http://127.0.0.1:6130",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await expect(backend.list({ scope: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    });
  });

  it("preserves bounded string arrays while filtering secret-like metadata", async () => {
    const scope = buildMemoryScope("user-a", "alice");
    const fetchImpl = vi.fn(async () =>
      Response.json({
        ok: true,
        data: {
          items: [
            {
              id: "memory-1",
              content: "fact",
              scope,
              score: 0.5,
              metadata: {
                yuviSourceTurnIds: ["m-1", "a-1"],
                yuviParticipants: ["user-a", "alice"],
                apiKey: "must not escape",
                nested: { unsafe: true }
              }
            }
          ]
        }
      })
    );
    const backend = new Mem0MemoryBackend({
      baseUrl: "http://127.0.0.1:6130",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const result = await backend.search({ scope, query: "fact" });
    expect(result[0]?.metadata).toMatchObject({
      yuviSourceTurnIds: ["m-1", "a-1"],
      yuviParticipants: ["user-a", "alice"]
    });
    expect(result[0]?.metadata).not.toHaveProperty("apiKey");
    expect(result[0]?.metadata).not.toHaveProperty("nested");
  });
});
