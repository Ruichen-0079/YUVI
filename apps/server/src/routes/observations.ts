import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { toConversationalJournalRef } from "../conversational-receipt-admission.js";
import { ConversationHostIdentityError } from "../conversation-host-identity.js";

/** Host credentials grant only their own private audience. Operator bearer is not a read bypass. */
export async function registerObservationRoutes(app: FastifyInstance, context: AppContext) {
  const querySchema = z
    .object({
      sessionId: z.string().min(1).max(512),
      cursor: z.string().min(1).max(1024).optional(),
      limit: z.coerce.number().int().min(1).max(32).optional()
    })
    .strict();
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: method === "GET" ? "/observations/v1/:id" : "/observations/v1/:id",
      async handler(request, reply) {
        const query = querySchema.safeParse(request.query);
        const id = z
          .object({ id: z.string().regex(/^ob1_[a-f0-9]{64}$/u) })
          .safeParse(request.params);
        if (!query.success || !id.success)
          return reply
            .code(400)
            .send({ schema: "observation.error.v1", status: "FAILED", error: "INVALID_REQUEST" });
        try {
          const identity = await context.conversationHost?.authorize(request, {
            sessionId: query.data.sessionId
          });
          if (!identity)
            return reply
              .code(401)
              .send({
                schema: "observation.error.v1",
                status: "UNAVAILABLE",
                error: "HOST_IDENTITY_REQUIRED"
              });
          if (!context.observations)
            return reply
              .code(503)
              .send({
                schema: "observation.error.v1",
                status: "UNAVAILABLE",
                error: "OBSERVATION_STORAGE_UNAVAILABLE"
              });
          const source = await context.conversationalReceiptAdmission.admit({
            surface: "HTTP_MESSAGE",
            sessionId: query.data.sessionId,
            runtimeEventId: randomUUID(),
            content: `Observation ${method} ${id.data.id}`,
            hostIdentity: identity
          });
          const access = {
            sourceJournalRef: toConversationalJournalRef(source.envelope),
            sessionId: query.data.sessionId
          };
          reply.header("Cache-Control", "no-store");
          if (method === "DELETE") {
            const erased = await context.observations.erase(access, id.data.id);
            return erased
              ? {
                  schema: "observation.erasure.v1",
                  status: "COMPLETE",
                  id: id.data.id,
                  scope: "OBSERVATION_PAYLOAD_AND_IMAGE",
                  actionReceipt: "RETAINED"
                }
              : reply
                  .code(404)
                  .send({
                    schema: "observation.error.v1",
                    status: "UNAVAILABLE",
                    error: "NOT_FOUND_OR_NOT_VISIBLE"
                  });
          }
          const record = await context.observations.detail(access, id.data.id);
          return (
            record ??
            reply
              .code(404)
              .send({
                schema: "observation.error.v1",
                status: "UNAVAILABLE",
                error: "NOT_FOUND_OR_NOT_VISIBLE"
              })
          );
        } catch (error) {
          return reply
            .code(error instanceof ConversationHostIdentityError ? error.statusCode : 503)
            .send({
              schema: "observation.error.v1",
              status: "UNAVAILABLE",
              error:
                error instanceof ConversationHostIdentityError
                  ? error.code
                  : "OBSERVATION_QUERY_OR_COMMIT_UNKNOWN"
            });
        }
      }
    });
  }
  app.get("/observations/v1", async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success)
      return reply
        .code(400)
        .send({ schema: "observation.error.v1", status: "FAILED", error: "INVALID_REQUEST" });
    try {
      const identity = await context.conversationHost?.authorize(request, {
        sessionId: query.data.sessionId
      });
      if (!identity)
        return reply
          .code(401)
          .send({
            schema: "observation.error.v1",
            status: "UNAVAILABLE",
            error: "HOST_IDENTITY_REQUIRED"
          });
      if (!context.observations)
        return reply
          .code(503)
          .send({
            schema: "observation.error.v1",
            status: "UNAVAILABLE",
            error: "OBSERVATION_STORAGE_UNAVAILABLE"
          });
      const source = await context.conversationalReceiptAdmission.admit({
        surface: "HTTP_MESSAGE",
        sessionId: query.data.sessionId,
        runtimeEventId: randomUUID(),
        content: "Observation list",
        hostIdentity: identity
      });
      reply.header("Cache-Control", "no-store");
      return await context.observations.page(
        {
          sourceJournalRef: toConversationalJournalRef(source.envelope),
          sessionId: query.data.sessionId
        },
        query.data.limit,
        query.data.cursor
      );
    } catch (error) {
      return reply
        .code(error instanceof ConversationHostIdentityError ? error.statusCode : 503)
        .send({
          schema: "observation.error.v1",
          status: "UNAVAILABLE",
          error:
            error instanceof ConversationHostIdentityError
              ? error.code
              : "OBSERVATION_QUERY_UNAVAILABLE"
        });
    }
  });
}
