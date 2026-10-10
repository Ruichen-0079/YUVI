import type { ReplyPublicationTarget } from "@companion/memory";
import {
  RuntimeEventSchema,
  UserMessageEventSchema,
  createEvent,
  type JournalEventRef,
  type RuntimeEvent
} from "@companion/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadServerConfig, type ServerConfig } from "../config.js";
import { hasLocalDashboardWebSocketAccess, isLocalAddress } from "./security.js";
import type { AppContext } from "../context.js";
import { redactValue } from "../services/dashboard.js";
import {
  toConversationalAdmissionFailure,
  toConversationalJournalRef
} from "../conversational-receipt-admission.js";

export const ACTIVE_TRACE_MAX_ENTRIES = 256;
export const ACTIVE_TRACE_RETENTION_MS = 15 * 60 * 1000;

type ActiveTraceEntry = {
  lastSeenAtMs: number;
  terminal: boolean;
  owner: symbol;
  sessionId?: string;
  requestId?: string;
};

export class ActiveTraceRegistry {
  private readonly entries = new Map<string, ActiveTraceEntry>();

  add(traceId: string): boolean {
    return this.claim(traceId) !== null;
  }

  claim(
    traceId: string,
    sessionId?: string,
    requestId?: string
  ): { created: boolean; owner: symbol } | null {
    this.prune();
    const existing = this.entries.get(traceId);
    if (existing) {
      if (
        (existing.sessionId !== undefined &&
          sessionId !== undefined &&
          existing.sessionId !== sessionId) ||
        (existing.requestId !== undefined &&
          requestId !== undefined &&
          existing.requestId !== requestId)
      )
        return null;
      existing.lastSeenAtMs = Date.now();
      this.entries.delete(traceId);
      this.entries.set(traceId, existing);
      return { created: false, owner: existing.owner };
    }

    if (this.entries.size >= ACTIVE_TRACE_MAX_ENTRIES) {
      const oldestTerminal = [...this.entries.entries()].find(([, entry]) => entry.terminal);
      if (!oldestTerminal) {
        return null;
      }
      this.entries.delete(oldestTerminal[0]);
    }
    const owner = Symbol(traceId);
    this.entries.set(traceId, {
      lastSeenAtMs: Date.now(),
      terminal: false,
      owner,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(requestId === undefined ? {} : { requestId })
    });
    return { created: true, owner };
  }

  has(traceId: string): boolean {
    this.prune();
    return this.entries.has(traceId);
  }

  matches(traceId: string, sessionId: string | undefined): boolean {
    this.prune();
    const entry = this.entries.get(traceId);
    return (
      !!entry &&
      (entry.sessionId === undefined || sessionId === undefined || entry.sessionId === sessionId)
    );
  }

  matchesEvent(event: RuntimeEvent): boolean {
    const session =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)["sessionId"]
        : undefined;
    return this.matches(event.traceId, typeof session === "string" ? session : undefined);
  }

  deleteOwned(traceId: string, owner: symbol): void {
    if (this.entries.get(traceId)?.owner === owner) this.entries.delete(traceId);
  }

  observe(event: RuntimeEvent): void {
    const entry = this.entries.get(event.traceId);
    if (!entry || !this.matchesEvent(event)) {
      return;
    }
    if (
      event.type === "avatar.speak" ||
      event.type === "provider.error" ||
      event.type === "runtime.error"
    ) {
      this.entries.delete(event.traceId);
      return;
    }
    entry.lastSeenAtMs = Date.now();
    if (event.type === "agent.reply") {
      entry.terminal = true;
    }
  }

  delete(traceId: string): void {
    this.entries.delete(traceId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(now = Date.now()): void {
    for (const [traceId, entry] of this.entries) {
      if (entry.terminal && now - entry.lastSeenAtMs >= ACTIVE_TRACE_RETENTION_MS) {
        this.entries.delete(traceId);
      }
    }
  }
}

const WebSocketQuerySchema = z.object({
  dashboard: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
    .optional()
    .default(false)
});

export async function registerWebSocketRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig = loadServerConfig()
): Promise<void> {
  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const query = WebSocketQuerySchema.safeParse(request.query);
        if (!query.success) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        if (query.data.dashboard && !hasLocalDashboardWebSocketAccess(config, request)) {
          return reply.code(isLocalAddress(request.ip) ? 401 : 403).send({ error: "forbidden" });
        }
      }
    },
    (socket, request) => {
      const dashboardMode = WebSocketQuerySchema.parse(request.query).dashboard;
      const activeTraceIds = new ActiveTraceRegistry();
      let live = true;
      const target: ReplyPublicationTarget = {
        surface: "WEBSOCKET",
        targetId: `WEBSOCKET:${crypto.randomUUID()}`,
        targetGeneration: crypto.randomUUID()
      };
      const unregister = context.outwardEffects?.registerTarget(
        target,
        (session, trace) => dashboardMode || activeTraceIds.matches(trace, session),
        () => live && socket.readyState === socket.OPEN,
        false
      );
      const sendAccounted = async (payload: unknown, event?: RuntimeEvent) => {
        if (!live || socket.readyState !== socket.OPEN) return;
        if (context.outwardEffects)
          await context.outwardEffects.publish({
            target,
            frameId: event?.id ?? crypto.randomUUID(),
            payload,
            scope: "websocket-target",
            ...(event?.type === "agent.reply" ? { replyId: event.id } : {}),
            write: () =>
              new Promise<void>((resolve, reject) =>
                socket.send(JSON.stringify(payload), (error?: Error) =>
                  error ? reject(error) : resolve()
                )
              )
          });
        else sendJson(socket, payload);
      };
      const subscription = context.eventBus.subscribe("*", async (event) => {
        if (dashboardMode) {
          await sendAccounted(redactRuntimeEvent(event), event);
          return;
        }

        if (activeTraceIds.matchesEvent(event) && shouldForwardEvent(event)) {
          await sendAccounted(redactRuntimeEvent(event), event);
          activeTraceIds.observe(event);
        }
      });

      if (dashboardMode) {
        void sendAccounted({
          kind: "dashboard.connected",
          traceId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          payload: {
            message:
              "Dashboard WebSocket connected. Recent event replay is available through GET /events/recent."
          }
        }).catch(() => socket.close());
      }

      socket.on("message", async (rawMessage: Buffer) => {
        let envelope: RuntimeEvent | undefined;
        let ownership: { traceId: string; owner: symbol } | undefined;
        try {
          const parsedEnvelope = RuntimeEventSchema.parse(
            JSON.parse(rawMessage.toString())
          ) as RuntimeEvent;
          envelope = parsedEnvelope;
          if (parsedEnvelope.type !== "user.message") {
            await sendAccounted(
              redactRuntimeEvent(
                createEvent(
                  "runtime.error",
                  {
                    rejectedTraceId: parsedEnvelope.traceId,
                    message: `Unsupported WebSocket event type '${parsedEnvelope.type}'.`
                  },
                  {
                    parentId: parsedEnvelope.id
                  }
                )
              )
            );
            return;
          }

          const parsed = UserMessageEventSchema.parse(parsedEnvelope);
          // Validate before claiming; a rejected packet has no resource to release.
          const claim = activeTraceIds.claim(parsed.traceId, parsed.payload.sessionId, parsed.id);
          if (!claim) {
            await sendAccounted(
              redactRuntimeEvent(
                createEvent(
                  "runtime.error",
                  {
                    rejectedTraceId: parsed.traceId,
                    message:
                      "WebSocket trace is full or belongs to a different request/session. Use a fresh trace ID for new work."
                  },
                  { parentId: parsed.id }
                )
              )
            );
            return;
          }
          if (claim.created) ownership = { traceId: parsed.traceId, owner: claim.owner };

          app.log.info(
            { traceId: parsed.traceId, sessionId: parsed.payload.sessionId },
            "websocket user.message received"
          );
          let sourceJournalRef: JournalEventRef;
          try {
            const receipt = await context.conversationalReceiptAdmission.admit({
              surface: "WEBSOCKET",
              sessionId: parsed.payload.sessionId,
              runtimeEventId: parsed.id,
              content: parsed.payload.content
            });
            sourceJournalRef = toConversationalJournalRef(receipt.envelope);
            app.log.info(
              {
                journalEventId: receipt.envelope.eventId,
                traceId: parsed.traceId,
                sessionId: parsed.payload.sessionId
              },
              "websocket conversation receipt committed"
            );
          } catch (error) {
            if (ownership) activeTraceIds.deleteOwned(ownership.traceId, ownership.owner);
            const failure = toConversationalAdmissionFailure(error);
            app.log.error(
              { traceId: parsed.traceId, sessionId: parsed.payload.sessionId, code: failure.code },
              "websocket conversation receipt admission failed"
            );
            await sendAccounted(
              redactRuntimeEvent(
                createEvent(
                  "runtime.error",
                  {
                    code: failure.code,
                    ...(!ownership ? { rejectedTraceId: parsed.traceId } : {}),
                    message: "Message was not admitted for processing."
                  },
                  { traceId: ownership ? parsed.traceId : undefined, parentId: parsed.id }
                )
              )
            );
            return;
          }
          await context.runtime.handleUserMessage({
            ...parsed,
            payload: { ...parsed.payload, sourceJournalRef }
          });
        } catch (error) {
          if (ownership) activeTraceIds.deleteOwned(ownership.traceId, ownership.owner);
          await sendAccounted(
            redactRuntimeEvent(
              createEvent(
                "runtime.error",
                {
                  ...(!ownership && envelope ? { rejectedTraceId: envelope.traceId } : {}),
                  message: error instanceof Error ? error.message : "Invalid WebSocket event"
                },
                {
                  traceId: ownership ? envelope?.traceId : undefined,
                  parentId: envelope?.id
                }
              )
            )
          );
        }
      });

      socket.on("close", () => {
        live = false;
        unregister?.();
        subscription.unsubscribe();
        activeTraceIds.clear();
      });
    }
  );

  app.get("/v1/events", { websocket: true }, (socket) => {
    socket.close(1000, "Use /ws");
  });
}

export function shouldForwardEvent(event: RuntimeEvent): boolean {
  // Keep agent.reply as the sole non-dashboard reply transport for compatibility with
  // existing WebSocket clients. Forwarding both reply events here would render the same
  // completed text twice; assistant.message remains available on the event bus and the
  // dashboard diagnostic stream.
  return (
    event.type === "agent.reply" ||
    event.type === "avatar.speak" ||
    event.type === "tts.started" ||
    event.type === "vision.completed" ||
    event.type === "perception.vision" ||
    event.type === "provider.error" ||
    event.type === "runtime.error"
  );
}

function redactRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return {
    ...event,
    payload: redactValue(event.payload)
  };
}

function sendJson(
  socket: { readyState: number; OPEN: number; send(data: string): void },
  payload: unknown
): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}
