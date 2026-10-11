import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { requireLocalDashboardAccess } from "./security.js";
import { ConversationHostIdentityError } from "../conversation-host-identity.js";

/** Explicit operator credential required in every mode, including packaged production. */
export async function registerConversationHostRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
) {
  for (const action of ["issue", "revoke"] as const)
    app.post(`/host/v1/conversation-grants/${action}`, async (request, reply) => {
      if (!requireLocalDashboardAccess(config, request, reply)) return;
      const presented = request.headers.authorization?.match(/^Bearer\s+(.+)$/u)?.[1];
      const expected = config.dashboardDevToken;
      if (
        !expected ||
        !presented ||
        Buffer.byteLength(presented) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
      )
        return reply
          .code(401)
          .send({
            schema: "host.error.v1",
            status: "FAILED",
            error: "HOST_OPERATOR_CREDENTIAL_REQUIRED"
          });
      if (!context.conversationHost)
        return reply
          .code(503)
          .send({ schema: "host.error.v1", status: "UNKNOWN", error: "HOST_IDENTITY_UNAVAILABLE" });
      const parsed = (
        action === "issue"
          ? z
              .object({
                personId: z.string().min(1).max(512),
                lifetimeSeconds: z.number().int().min(60).max(2592000).optional()
              })
              .strict()
          : z.object({ grantId: z.string().min(1).max(512) }).strict()
      ).safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ schema: "host.error.v1", status: "FAILED", error: "HOST_GRANT_REQUEST_INVALID" });
      reply.header("Cache-Control", "no-store");
      try {
        const data = parsed.data;
        return "personId" in data
          ? await context.conversationHost.issue(data.personId, data.lifetimeSeconds)
          : await context.conversationHost.revoke(data.grantId);
      } catch (e) {
        return reply
          .code(e instanceof ConversationHostIdentityError ? e.statusCode : 503)
          .send({
            schema: "host.error.v1",
            status: e instanceof ConversationHostIdentityError ? "FAILED" : "UNKNOWN",
            error: e instanceof ConversationHostIdentityError ? e.code : "HOST_GRANT_COMMIT_UNKNOWN"
          });
      }
    });
}
