import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/** Ingress for device observations; it cannot publish or mutate Runtime state. */
export async function registerEmbodiedPresentationRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.post("/v1/embodied-presentation/permit", async (request, reply) => {
    const accepted = await context.presentationEffects.accept(
      (await import("@companion/protocol")).PresentationPermissionSchema.parse(request.body)
    );
    return reply.code(accepted ? 204 : 409).send();
  });
  app.post("/v1/embodied-presentation/outcome", async (request, reply) => {
    let resolved: boolean;
    try {
      resolved = await context.presentationEffects.report(request.body);
    } catch {
      return reply.code(400).send({ error: "invalid_presentation_outcome" });
    }
    if (!resolved) {
      return reply.code(409).send({ error: "stale_or_unknown_effect" });
    }
    return reply.code(204).send();
  });
}
