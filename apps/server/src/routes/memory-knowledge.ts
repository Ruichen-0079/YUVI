import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { requireLocalDashboardAccess } from "./security.js";
import { MemoryAuthorityError } from "@companion/memory";

const query = z
  .object({
    scope: z.string().min(1).max(1024),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().max(4096).optional(),
    state: z
      .enum([
        "current",
        "superseded",
        "conflicted",
        "supporting",
        "legacy_unverified",
        "unattributed"
      ])
      .optional()
  })
  .strict();
/** Operator API, same local-dashboard disclosure boundary as existing administrative reads.
 * Persona ownership is enforced by MemoryService; scope is never inferred from model text.
 */
export async function registerMemoryKnowledgeRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
) {
  for (const operation of [
    "overview",
    "current",
    "timeline",
    "detail",
    "relations",
    "ingestion",
    "processing"
  ] as const) {
    app.get(`/memory/v1/${operation}`, async (request, reply) => {
      if (!requireLocalDashboardAccess(config, request, reply)) return;
      const parsed = query
        .extend({ id: z.string().min(1).max(4096).optional() })
        .safeParse(request.query);
      if (!parsed.success)
        return reply
          .status(400)
          .send({ schema: "memory.error.v1", status: "FAILED", error: "MEMORY_QUERY_INVALID" });
      const input = parsed.data;
      let reader;
      try {
        reader = context.memory.getKnowledgeReader(input.scope);
      } catch {
        return reply
          .status(403)
          .send({ schema: "memory.error.v1", status: "FAILED", error: "MEMORY_SCOPE_FORBIDDEN" });
      }
      if (!reader)
        return reply.status(503).send({
          schema: "memory.error.v1",
          status: "UNKNOWN",
          error: "MEMORY_AUTHORITY_NOT_ENABLED"
        });
      try {
        if (operation === "overview")
          return {
            ...(await reader.overview(input.scope)),
            workers: context.memory.getAuthorityDiagnostics(),
            migrations: await reader.migrations(input.scope)
          };
        if (operation === "current") return await reader.page(input);
        if (operation === "timeline") return await reader.timeline(input);
        if (!input.id)
          return reply
            .status(400)
            .send({ schema: "memory.error.v1", status: "FAILED", error: "MEMORY_ID_REQUIRED" });
        if (operation === "processing") return await reader.processing(input.scope, input.id);
        if (operation === "ingestion") {
          const turn = await context.finalizedIngestion.getTurn(input.id);
          if (!turn || turn.memoryScope !== input.scope)
            return reply.status(404).send({ schema: "memory.ingestion.v1", status: "UNKNOWN" });
          // No raw source or frozen payload is returned through the product status endpoint.
          return {
            schema: "memory.ingestion.v1",
            id: turn.finalizedTurnId,
            status: turn.status,
            stage: turn.failureStage,
            eligible: turn.eligibleEventCount,
            complete: turn.completeEventCount,
            unchanged: turn.unchangedEventCount,
            pending: turn.pendingEventCount,
            failed: turn.failedEventCount,
            errorCode: turn.lastErrorCode,
            nextAttemptAt: turn.nextAttemptAt,
            completedAt: turn.completedAt
          };
        }
        if (operation === "relations")
          return await reader.relations(input.scope, input.id, input.limit);
        const detail = await reader.detail(input.scope, input.id);
        return (
          detail ??
          reply
            .status(404)
            .send({ schema: "memory.error.v1", status: "UNKNOWN", error: "MEMORY_NOT_FOUND" })
        );
      } catch (error) {
        return reply
          .status(
            error instanceof MemoryAuthorityError && error.code.includes("INVALID") ? 400 : 503
          )
          .send({
            schema: "memory.error.v1",
            status: "UNKNOWN",
            error:
              error instanceof MemoryAuthorityError ? error.code : "MEMORY_AUTHORITY_READ_FAILED"
          });
      }
    });
  }
}
