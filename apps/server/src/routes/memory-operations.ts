import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MemoryProjectionRebuild,
  advanceLexicalIndex,
  rebuildLexicalIndex,
  verifyLexicalIndex,
  MemoryLegacyWorkflow,
  retryStaleFinalizedDecision,
  PostgresMemoryProvider,
  verifyMemoryProjection,
  enqueueVectorIndexBatch,
  MemoryAuthorityError
} from "@companion/memory";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { requireAuthenticatedLocalOperator } from "./security.js";

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
        "LEXICAL_ADVANCE",
        "LEXICAL_REBUILD",
        "LEXICAL_VERIFY",
        "RETRY_FINALIZED",
        "REBUILD_START",
        "REBUILD_ADVANCE",
        "REBUILD_STATUS",
        "REBUILD_PAUSE",
        "REBUILD_RESUME",
        "REBUILD_RETIRE",
        "MIGRATION_PREPARE",
        "MIGRATION_ADVANCE",
        "MIGRATION_STATUS",
        "MIGRATION_PAUSE",
        "MIGRATION_RESUME"
      ]),
      id: z.string().min(1).max(160).optional(),
      legacyPerson: z.string().min(1).max(200).optional(),
      legacyPersona: z.string().min(1).max(200).optional(),
      actionId: z.string().min(1).max(160).optional(),
      after: z.string().regex(/^\d+$/u).optional(),
      limit: z.number().int().min(1).max(200).optional()
    })
    .strict();
  app.post("/memory/v1/operations", async (request, reply) => {
    if (!requireAuthenticatedLocalOperator(config, request, reply)) return;
    const parsed = input.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ schema: "memory.error.v1", status: "FAILED", error: "MEMORY_OPERATION_INVALID" });
    try {
      const i = parsed.data;
      context.memory.getKnowledgeReader(i.scope);
      const provider = context.memory.getAuthorityInfrastructure();
      if (!(provider instanceof PostgresMemoryProvider) || !context.memoryIntegrity)
        throw new MemoryAuthorityError("MEMORY_AUTHORITY_NOT_ENABLED");
      if (i.operation === "LEXICAL_ADVANCE")
        return {
          schema: "memory.lexical-index.v1",
          ...(await advanceLexicalIndex(
            provider.authority,
            i.scope,
            i.limit,
            "authenticated-local-operator"
          ))
        };
      if (i.operation === "LEXICAL_REBUILD")
        return {
          schema: "memory.lexical-index.v1",
          ...(await rebuildLexicalIndex(
            provider.authority,
            i.scope,
            "authenticated-local-operator"
          ))
        };
      if (i.operation === "LEXICAL_VERIFY")
        return await verifyLexicalIndex(
          provider.authority,
          i.scope,
          i.id ?? "",
          i.limit,
          "authenticated-local-operator"
        );
      if (i.operation.startsWith("MIGRATION_")) {
        if (!i.id) throw new MemoryAuthorityError("MEMORY_OPERATION_ID_REQUIRED");
        const workflow = new MemoryLegacyWorkflow(provider.authority),
          actor = "authenticated-local-operator";
        if (i.operation === "MIGRATION_PREPARE") {
          if (!i.legacyPerson || !i.legacyPersona)
            throw new MemoryAuthorityError("MEMORY_MIGRATION_IDENTITY_INVALID");
          return await workflow.prepare({
            id: i.id,
            scope: i.scope,
            legacyPerson: i.legacyPerson,
            legacyPersona: i.legacyPersona,
            actor
          });
        }
        if (i.operation === "MIGRATION_ADVANCE")
          return await workflow.advance(i.scope, i.id, actor, Math.min(i.limit ?? 100, 100));
        if (i.operation === "MIGRATION_PAUSE" || i.operation === "MIGRATION_RESUME")
          return await workflow.pause(i.scope, i.id, actor, i.operation === "MIGRATION_PAUSE");
        return await workflow.status(i.scope, i.id);
      }
      if (i.operation.startsWith("REBUILD_")) {
        if (!i.id) throw new MemoryAuthorityError("MEMORY_OPERATION_ID_REQUIRED");
        const rebuild = new MemoryProjectionRebuild(provider.authority);
        if (i.operation === "REBUILD_START")
          return await rebuild.start(i.scope, i.id, "authenticated-local-operator");
        if (i.operation === "REBUILD_ADVANCE") return await rebuild.advance(i.scope, i.id, i.limit);
        if (i.operation === "REBUILD_PAUSE" || i.operation === "REBUILD_RESUME")
          return await rebuild.pause(i.scope, i.id, i.operation === "REBUILD_PAUSE");
        if (i.operation === "REBUILD_RETIRE") return await rebuild.retire(i.scope, i.id, i.limit);
        return await rebuild.status(i.scope, i.id);
      }
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
