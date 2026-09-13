import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

const querySchema = z.object({ sessionId: z.string().trim().min(1).max(256) });

/** Read-only product projection. ConversationRepository owns transcript and status. */
export async function registerConversationHistoryRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.get("/v1/conversations/history", async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    const messages = await context.conversationRepository.listRecentMessages(query.data.sessionId, {
      limit: 200
    });
    return {
      sessionId: query.data.sessionId,
      messages: messages.map(({ id, role, content, status, traceId, sequence }) => ({
        id,
        role,
        content,
        status,
        traceId,
        sequence
      }))
    };
  });
}
