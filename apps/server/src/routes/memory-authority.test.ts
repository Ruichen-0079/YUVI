import Fastify from "fastify";
import {
  InMemoryMemoryRepository,
  type CreateMemoryInput,
  type MemoryStatus,
  type UpdateMemoryInput
} from "@companion/memory";
import { describe, expect, it, vi } from "vitest";
import { loadServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { registerMemoryRoutes } from "./memory.js";

const devToken = "memory-dev-token";
const local = { remoteAddress: "127.0.0.1" } as const;
const nonLocal = { remoteAddress: "192.0.2.40" } as const;
const bearer = { authorization: `Bearer ${devToken}` } as const;

function config(runtimeMode: "development" | "test" | "production", token?: string) {
  return loadServerConfig({
    NODE_ENV: runtimeMode,
    RUNTIME_MODE: runtimeMode,
    ...(token === undefined ? {} : { DASHBOARD_DEV_TOKEN: token })
  });
}

async function createHarness(
  runtimeMode: "development" | "test" | "production",
  token?: string
) {
  const app = Fastify({ logger: false });
  const repository = new InMemoryMemoryRepository();
  const createMemory = vi.fn((input: CreateMemoryInput) => repository.createMemory(input));
  const updateMemory = vi.fn((id: string, input: UpdateMemoryInput) =>
    repository.updateMemory(id, input)
  );
  const maintenanceRun = vi.fn(async () => {
    throw new Error("Maintenance must not run in this test.");
  });
  const getRecentMemoryCandidates = vi.fn(() => []);
  const acceptMemoryCandidate = vi.fn(async () => null);
  const rejectMemoryCandidate = vi.fn(() => null);
  const context = {
    memoryRepository: repository,
    activeMemoryRepository: "in-memory",
    memory: { createMemory, updateMemory },
    memoryMaintenanceScheduler: { run: maintenanceRun, getStatus: () => null },
    runtime: { getRecentMemoryCandidates, acceptMemoryCandidate, rejectMemoryCandidate }
    // Deliberately no Journal repository or receipt-admission facade: Memory
    // withdrawal must remain operable without Journal availability.
  } as unknown as AppContext;
  await registerMemoryRoutes(app, context, config(runtimeMode, token));
  return {
    app,
    context,
    repository,
    createMemory,
    updateMemory,
    maintenanceRun,
    getRecentMemoryCandidates,
    acceptMemoryCandidate,
    rejectMemoryCandidate
  };
}

async function seed(
  repository: InMemoryMemoryRepository,
  content: string,
  status: MemoryStatus = "active"
) {
  const memory = await repository.createMemory({
    type: "semantic",
    content,
    source: "manual",
    tags: []
  });
  if (status !== "active") {
    await repository.updateMemory(memory.id, { status });
    return (await repository.getMemoryById(memory.id))!;
  }
  return memory;
}

describe("Memory route authority by runtime mode", () => {
  it("hides manual create, edit, and restore in production even for localhost and the configured token", async () => {
    for (const token of [undefined, devToken]) {
      const harness = await createHarness("production", token);
      const archived = await seed(harness.repository, "Archived production record", "archived");
      const repositoryUpdate = vi.spyOn(harness.repository, "updateMemory");
      const repositoryDelete = vi.spyOn(harness.repository, "deleteMemory");

      try {
        const cases = [
          {
            method: "POST" as const,
            url: "/memory",
            payload: { type: "semantic", content: "Must not be authored", source: "manual" }
          },
          {
            method: "PATCH" as const,
            url: `/memory/${archived.id}`,
            payload: { content: "Must not be edited" }
          },
          {
            method: "POST" as const,
            url: `/memory/${archived.id}/restore`,
            payload: {}
          }
        ];

        for (const request of cases) {
          const response = await harness.app.inject({
            ...request,
            ...local,
            ...(token === undefined ? {} : { headers: bearer })
          });
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ error: "not_found" });
        }

        expect(harness.createMemory).not.toHaveBeenCalled();
        expect(harness.updateMemory).not.toHaveBeenCalled();
        expect(repositoryUpdate).not.toHaveBeenCalled();
        expect(repositoryDelete).not.toHaveBeenCalled();
        expect(await harness.repository.getMemoryById(archived.id)).toMatchObject({
          content: "Archived production record",
          status: "archived"
        });
        expect(await harness.repository.listRecentMemories()).toHaveLength(1);

        const malformedCreate = await harness.app.inject({
          method: "POST",
          url: "/memory",
          payload: { content: "" },
          ...local,
          ...(token === undefined ? {} : { headers: bearer })
        });
        const malformedPatch = await harness.app.inject({
          method: "PATCH",
          url: `/memory/${archived.id}`,
          payload: { content: "" },
          ...local,
          ...(token === undefined ? {} : { headers: bearer })
        });
        expect(malformedCreate.statusCode).toBe(404);
        expect(malformedPatch.statusCode).toBe(404);
        expect(harness.createMemory).not.toHaveBeenCalled();
        expect(harness.updateMemory).not.toHaveBeenCalled();
        expect(repositoryUpdate).not.toHaveBeenCalled();
      } finally {
        await harness.app.close();
      }
    }
  });

  it("preserves development create, edit, and restore with the configured dev token", async () => {
    const harness = await createHarness("development", devToken);
    const archived = await seed(harness.repository, "Development archived record", "archived");
    const repositoryUpdate = vi.spyOn(harness.repository, "updateMemory");

    try {
      const requests = [
        {
          method: "POST" as const,
          url: "/memory",
          payload: { type: "semantic", content: "Development console record", source: "manual" }
        },
        {
          method: "PATCH" as const,
          url: `/memory/${archived.id}`,
          payload: { content: "Edited only in development" }
        },
        { method: "POST" as const, url: `/memory/${archived.id}/restore`, payload: {} }
      ];

      for (const request of requests) {
        const response = await harness.app.inject({ ...request, ...nonLocal });
        expect(response.statusCode).toBe(401);
      }
      expect(harness.createMemory).not.toHaveBeenCalled();
      expect(harness.updateMemory).not.toHaveBeenCalled();
      expect(repositoryUpdate).not.toHaveBeenCalled();

      const created = await harness.app.inject({
        ...requests[0]!,
        ...nonLocal,
        headers: bearer
      });
      expect(created.statusCode).toBe(200);
      const createdId = created.json().id as string;

      const updated = await harness.app.inject({
        ...requests[1]!,
        ...nonLocal,
        headers: bearer
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().content).toBe("Edited only in development");

      const restored = await harness.app.inject({
        ...requests[2]!,
        ...nonLocal,
        headers: bearer
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().memory.status).toBe("active");

      expect(harness.createMemory).toHaveBeenCalledTimes(1);
      expect(harness.updateMemory).toHaveBeenCalledTimes(1);
      expect(repositoryUpdate).toHaveBeenCalledTimes(2);
      expect(await harness.repository.getMemoryById(createdId)).toMatchObject({
        content: "Development console record"
      });
    } finally {
      await harness.app.close();
    }
  });

  it("keeps production withdrawal routes localhost-only and independent of Journal", async () => {
    const harness = await createHarness("production", devToken);
    const archivedId = (await seed(harness.repository, "Archive target")).id;
    const forgottenId = (await seed(harness.repository, "Forget target")).id;
    const deletedId = (await seed(harness.repository, "Delete target")).id;
    const bulkDeletedId = (await seed(harness.repository, "Bulk-delete target")).id;
    const updateRepository = vi.spyOn(harness.repository, "updateMemory");
    const deleteRepository = vi.spyOn(harness.repository, "deleteMemory");

    try {
      const withdrawalRequests = [
        { method: "POST" as const, url: `/memory/${archivedId}/archive`, payload: {} },
        { method: "POST" as const, url: `/memory/${forgottenId}/forget`, payload: {} },
        { method: "DELETE" as const, url: `/memory/${deletedId}` },
        {
          method: "POST" as const,
          url: "/memory/bulk-delete",
          payload: { ids: [bulkDeletedId] }
        }
      ];
      for (const request of withdrawalRequests) {
        const response = await harness.app.inject({
          ...request,
          ...nonLocal,
          headers: bearer
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: "forbidden" });
      }
      expect(updateRepository).not.toHaveBeenCalled();
      expect(deleteRepository).not.toHaveBeenCalled();

      const archived = await harness.app.inject({ ...withdrawalRequests[0]!, ...local });
      const forgotten = await harness.app.inject({ ...withdrawalRequests[1]!, ...local });
      const deleted = await harness.app.inject({ ...withdrawalRequests[2]!, ...local });
      const bulkDeleted = await harness.app.inject({ ...withdrawalRequests[3]!, ...local });

      expect(archived.statusCode).toBe(200);
      expect(archived.json().memory.status).toBe("archived");
      expect(forgotten.statusCode).toBe(200);
      expect(forgotten.json().memory.status).toBe("forgotten");
      expect(deleted.statusCode).toBe(200);
      expect(bulkDeleted.statusCode).toBe(200);
      expect(bulkDeleted.json()).toMatchObject({ ok: true, deleted: 1 });
      expect(updateRepository).toHaveBeenCalledTimes(2);
      expect(deleteRepository).toHaveBeenCalledTimes(2);
      expect(await harness.repository.getMemoryById(deletedId)).toBeNull();
      expect(await harness.repository.getMemoryById(bulkDeletedId)).toBeNull();
      expect(harness.context).not.toHaveProperty("journalRepository");
      expect(harness.context).not.toHaveProperty("memoryReceiptAdmission");
    } finally {
      await harness.app.close();
    }
  });

  it("keeps production restore unavailable after withdrawal", async () => {
    const harness = await createHarness("production", devToken);
    const forgotten = await seed(harness.repository, "Forgotten record", "forgotten");
    const updateRepository = vi.spyOn(harness.repository, "updateMemory");

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: `/memory/${forgotten.id}/restore`,
        headers: bearer,
        payload: {},
        ...local
      });
      expect(response.statusCode).toBe(404);
      expect(updateRepository).not.toHaveBeenCalled();
      expect(await harness.repository.getMemoryById(forgotten.id)).toMatchObject({
        status: "forgotten"
      });
    } finally {
      await harness.app.close();
    }
  });

  it("keeps manual maintenance development-only regardless of production token", async () => {
    for (const token of [undefined, devToken]) {
      const harness = await createHarness("production", token);
      try {
        for (const headers of [undefined, ...(token ? [bearer] : [])]) {
          const response = await harness.app.inject({
            method: "POST",
            url: "/memory/maintenance/run",
            payload: { dryRun: "invalid" },
            ...local,
            ...(headers ? { headers } : {})
          });
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ error: "not_found" });
        }
        expect(harness.maintenanceRun).not.toHaveBeenCalled();
      } finally {
        await harness.app.close();
      }
    }
  });

  it("keeps candidate review unavailable in production", async () => {
    const harness = await createHarness("production", devToken);
    try {
      const recent = await harness.app.inject({
        method: "GET",
        url: "/memory/candidates/recent",
        headers: bearer,
        ...local
      });
      const accepted = await harness.app.inject({
        method: "POST",
        url: "/memory/candidates/candidate-1/accept",
        payload: {},
        headers: bearer,
        ...local
      });
      const rejected = await harness.app.inject({
        method: "POST",
        url: "/memory/candidates/candidate-1/reject",
        payload: { reason: "test" },
        headers: bearer,
        ...local
      });
      expect([recent.statusCode, accepted.statusCode, rejected.statusCode]).toEqual([
        404, 404, 404
      ]);
      expect(harness.getRecentMemoryCandidates).not.toHaveBeenCalled();
      expect(harness.acceptMemoryCandidate).not.toHaveBeenCalled();
      expect(harness.rejectMemoryCandidate).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });

  it("leaves production Memory reads available", async () => {
    const harness = await createHarness("production");
    const memory = await seed(harness.repository, "Read-only production record");
    const updateRepository = vi.spyOn(harness.repository, "updateMemory");
    const deleteRepository = vi.spyOn(harness.repository, "deleteMemory");

    try {
      const recent = await harness.app.inject({ method: "GET", url: "/memory/recent", ...local });
      const detail = await harness.app.inject({
        method: "GET",
        url: `/memory/${memory.id}`,
        ...local
      });
      const records = await harness.app.inject({
        method: "POST",
        url: "/memory/search",
        payload: { view: "records", q: "production record" },
        ...local
      });
      expect(recent.statusCode).toBe(200);
      expect(detail.statusCode).toBe(200);
      expect(records.statusCode).toBe(200);
      expect(records.json().memories).toHaveLength(1);
      expect(updateRepository).not.toHaveBeenCalled();
      expect(deleteRepository).not.toHaveBeenCalled();
    } finally {
      await harness.app.close();
    }
  });
});
