import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { requireLocalDashboardAccess } from "./security.js";

export async function registerDebugRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  app.get("/debug/prompt/latest", async (request, reply) => {
    if (config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Prompt preview is only available in development mode."
      });
    }

    if (!requireLocalDashboardAccess(config, request, reply)) return;

    const promptPreview = context.runtime.getLatestPromptPreview();
    if (!promptPreview) {
      return reply.send({
        mock: true,
        message: "No prompt has been generated yet. Send a message first.",
        promptPreview: null
      });
    }

    return reply.send({
      mock: false,
      ...promptPreview,
      promptPreview
    });
  });
}
