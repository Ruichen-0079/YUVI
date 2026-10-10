import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { loadServerConfig, type ServerConfig } from "../config.js";
import { requireLocalDashboardAccess } from "./security.js";

const RecentEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export async function registerEventRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig = loadServerConfig()
): Promise<void> {
  app.get("/events/recent", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const query = RecentEventsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "invalid_request", details: query.error.flatten() });
    }

    return reply.send({
      mock: false,
      events: context.dashboard.listRecentEvents(query.data.limit)
    });
  });
}
