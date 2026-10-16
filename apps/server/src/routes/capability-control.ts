import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { toRuntimeControlAdmissionFailure } from "../runtime-control-receipt-admission.js";
import { requireLocalDashboardAccess } from "./security.js";

/** Controller authorization is scoped to this Runtime, not global product settings. */
export async function registerCapabilityControlRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
) {
  app.post("/capabilities/read-text/authorize", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = z
      .object({
        sessionId: z
          .string()
          .min(1)
          .refine((value) => value.trim().length > 0),
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => value === value.trim()),
        personId: z.string().min(1).max(256).optional()
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success || !isAbsolute(parsed.data.path))
      return reply.code(400).send({ error: "invalid_read_text_authorization" });

    try {
      await context.runtimeControlReceiptAdmission.admit({
        operation: "READ_TEXT_AUTHORIZE",
        sessionId: parsed.data.sessionId,
        personId: parsed.data.personId
      });
    } catch (error) {
      const failure = toRuntimeControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }
    try {
      if (parsed.data.personId && !context.conversationHost)
        throw Error("Trusted Person targeting unavailable");
      context.runtime.authorizeReadText(
        parsed.data.sessionId,
        parsed.data.path,
        context.conversationHost?.readTextTarget(parsed.data.personId)
      );
    } catch {
      // Route preflight and Runtime share the accepted input constraints. If
      // Runtime still rejects, the committed receipt remains admission only.
      return reply.code(400).send({ error: "invalid_read_text_authorization" });
    }
    return { status: "AUTHORIZED" };
  });
  app.post("/capabilities/read-text/revoke", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = z
      .object({ sessionId: z.string().trim().min(1).max(1024) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_read_text_revocation" });
    try {
      await context.runtimeControlReceiptAdmission.admit({
        operation: "READ_TEXT_REVOKE",
        sessionId: parsed.data.sessionId
      });
    } catch (error) {
      const failure = toRuntimeControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }
    context.runtime.revokeReadText(parsed.data.sessionId);
    return { status: "REVOKED" };
  });
}
