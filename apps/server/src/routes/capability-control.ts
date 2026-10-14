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
          .refine((value) => value === value.trim())
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success || !isAbsolute(parsed.data.path))
      return reply.code(400).send({ error: "invalid_read_text_authorization" });

    try {
      await context.runtimeControlReceiptAdmission.admit({ operation: "READ_TEXT_AUTHORIZE" });
    } catch (error) {
      const failure = toRuntimeControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }
    try {
      context.runtime.authorizeReadText(parsed.data.sessionId, parsed.data.path);
    } catch {
      // Route preflight and Runtime share the accepted input constraints. If
      // Runtime still rejects, the committed receipt remains admission only.
      return reply.code(400).send({ error: "invalid_read_text_authorization" });
    }
    return { status: "AUTHORIZED" };
  });
}
