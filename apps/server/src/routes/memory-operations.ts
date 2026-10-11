import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  retryStaleFinalizedDecision,
  PostgresMemoryProvider,
  verifyMemoryProjection,
  enqueueVectorIndexBatch,
  MemoryAuthorityError
} from "@companion/memory";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { requireLocalDashboardAccess } from "./security.js";

export async function registerMemoryOperationRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
) {
  const input = z
    .object({
      scope: z.string().min(1).max(1024),
      operation: z.enum([
        "AUDIT_START",
        "AUDIT_ADVANCE",
        "AUDIT_STATUS",
        "PROJECTION_VERIFY",
        "VECTOR_REQUEUE",
        "RETRY_FINALIZED"
      ]),
      id: z.string().min(1).max(160).optional(),
      actionId: z.string().min(1).max(160).optional(),
      after: z.string().regex(/^\d+$/u).optional(),
      limit: z.number().int().min(1).max(200).optional()
    })
    .strict();
  app.post("/memory/v1/operations", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/u)?.[1],
      expected = config.dashboardDevToken;
    if (
      !token ||
      !expected ||
      Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    )
      return reply.code(401).send({
        schema: "memory.error.v1",
        status: "FAILED",
        error: "MEMORY_OPERATOR_CREDENTIAL_REQUIRED"
      });
    const parsed = input.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ schema: "memory.error.v1", status: "FAILED", error: "MEMORY_OPERATION_INVALID" });
    try {
      const i = parsed.data;
      context.memory.getKnowledgeReader(i.scope);
      const provider = context.memory.getMemoryProvider();
      if (!(provider instanceof PostgresMemoryProvider) || !context.memoryIntegrity)
        throw new MemoryAuthorityError("MEMORY_AUTHORITY_NOT_ENABLED");
      if (i.operation === "RETRY_FINALIZED") {
        if (!i.id || !i.actionId) throw new MemoryAuthorityError("MEMORY_OPERATION_ID_REQUIRED");
        return await retryStaleFinalizedDecision(provider.authority, {
          scope: i.scope,
          turnId: i.id,
          actionId: i.actionId,
          actor: "authenticated-local-operator"
        });
      }
      if (i.operation === "PROJECTION_VERIFY")
        return await verifyMemoryProjection(provider.authority.pool, i.scope, i.after, i.limit);
      if (i.operation === "VECTOR_REQUEUE") {
        if (!provider.vectors) throw new MemoryAuthorityError("MEMORY_VECTOR_UNAVAILABLE");
        return {
          schema: "memory.operation.v1",
          status: "COMMITTED",
          ...(await enqueueVectorIndexBatch(
            provider.authority,
            i.scope,
            provider.vectors.modelTag,
            i.after,
            i.limit
          ))
        };
      }
      if (!i.id) throw new MemoryAuthorityError("MEMORY_OPERATION_ID_REQUIRED");
      if (i.operation === "AUDIT_START") return await context.memoryIntegrity.start(i.scope, i.id);
      if (i.operation === "AUDIT_ADVANCE")
        return await context.memoryIntegrity.advance(i.scope, i.id, i.limit);
      return await context.memoryIntegrity.status(i.scope, i.id);
    } catch (e) {
      return reply.code(e instanceof MemoryAuthorityError ? 409 : 503).send({
        schema: "memory.error.v1",
        status: e instanceof MemoryAuthorityError ? "FAILED" : "UNKNOWN",
        error: e instanceof MemoryAuthorityError ? e.code : "MEMORY_OPERATION_UNKNOWN"
      });
    }
  });
}
