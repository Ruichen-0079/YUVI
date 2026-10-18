import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { ConversationHostIdentityError } from "../conversation-host-identity.js";
export async function registerProductHostRoutes(app: FastifyInstance, context: AppContext) {
  app.post("/host/v1/product/pairings", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const host = context.productHost;
    if (!host?.isController(request))
      return reply.code(401).send({ error: "PRODUCT_CONTROLLER_REQUIRED" });
    const body = z
      .object({ personId: z.string().min(1).max(512), origin: z.string().max(256) })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "PRODUCT_PAIRING_INVALID" });
    try {
      return await host.createPairing(body.data.personId, body.data.origin);
    } catch {
      return reply.code(403).send({ error: "PRODUCT_PAIRING_FORBIDDEN" });
    }
  });
  app.post("/host/v1/product/pair", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = z
      .object({ code: z.string().regex(/^yup_[A-Za-z0-9_-]{43}$/u) })
      .strict()
      .safeParse(request.body);
    if (!body.success || !context.productHost)
      return reply.code(401).send({ error: "PRODUCT_HOST_UNAUTHORIZED" });
    try {
      const paired = await context.productHost.pair(request, body.data.code);
      reply.header("Set-Cookie", paired.cookie);
      return {
        schema: "host.product-paired.v1",
        personId: paired.grant.personId,
        personaId: paired.grant.personaId
      };
    } catch (e) {
      return reply.code(e instanceof ConversationHostIdentityError ? 401 : 503).send({
        error:
          e instanceof ConversationHostIdentityError
            ? "PRODUCT_HOST_UNAUTHORIZED"
            : "PRODUCT_PAIRING_COMMIT_UNKNOWN"
      });
    }
  });
  for (const action of ["status", "renew", "revoke", "memory"] as const) {
    app.route({
      method: action === "status" ? "GET" : "POST",
      url: `/host/v1/product/${action}`,
      handler: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (!context.productHost)
          return reply.code(503).send({ error: "PRODUCT_HOST_UNAVAILABLE" });
        const body =
          action === "memory"
            ? z.object({ enabled: z.boolean() }).strict().safeParse(request.body)
            : undefined;
        if (body && !body.success)
          return reply.code(400).send({ error: "PRODUCT_HOST_REQUEST_INVALID" });
        try {
          const { cookie, ...result } = await context.productHost.state(
            request,
            action,
            body?.success ? body.data.enabled : undefined
          );
          if (cookie) reply.header("Set-Cookie", cookie);
          if (action === "revoke")
            reply.header(
              "Set-Cookie",
              "yuvi_product_host=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
            );
          return result;
        } catch (e) {
          return reply.code(e instanceof ConversationHostIdentityError ? 401 : 503).send({
            error:
              e instanceof ConversationHostIdentityError
                ? "PRODUCT_HOST_UNAUTHORIZED"
                : "PRODUCT_HOST_STATE_UNKNOWN"
          });
        }
      }
    });
  }
}
