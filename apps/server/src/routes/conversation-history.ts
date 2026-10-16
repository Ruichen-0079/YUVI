import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConversationHostIdentityError } from "../conversation-host-identity.js";
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
    try {
      await context.conversationHost?.authorize(request, { sessionId: query.data.sessionId });
    } catch (error) {
      return reply
        .code(error instanceof ConversationHostIdentityError ? error.statusCode : 503)
        .send({
          error:
            error instanceof ConversationHostIdentityError
              ? error.code
              : "HOST_IDENTITY_UNAVAILABLE"
        });
    }
    reply.header("Cache-Control", "no-store");
    const messages = await context.conversationRepository.listRecentMessages(query.data.sessionId, {
      limit: 200
    });
    return {
      sessionId: query.data.sessionId,
      messages: messages.map(
        ({
          id,
          role,
          content,
          status,
          traceId,
          sequence,
          metadata,
          finalizedTurnId,
          ingestionRequested
        }) => ({
          id,
          role,
          content:
            role === "assistant" && metadata["observationDependent"] === true
              ? "[Observation-dependent reply withheld from history; re-query authorized observation sources.]"
              : content,
          ...(role === "user" && finalizedTurnId?.startsWith("accepted-user:")
            ? {
                memoryIngestion: {
                  id: finalizedTurnId,
                  requested: ingestionRequested ?? null,
                  completion: "QUERY_INGESTION_STATUS"
                }
              }
            : {}),
          status,
          traceId,
          sequence
        })
      )
    };
  });
}
