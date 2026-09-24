import {
  RuntimeEventSchema,
  UserMessageEventSchema,
  createEvent,
  type RuntimeEvent
} from "@companion/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { redactValue } from "../services/dashboard.js";
import { toConversationalAdmissionFailure } from "../conversational-receipt-admission.js";

export const ACTIVE_TRACE_MAX_ENTRIES = 256;
export const ACTIVE_TRACE_RETENTION_MS = 15 * 60 * 1000;

type ActiveTraceEntry = {
  lastSeenAtMs: number;
  terminal: boolean;
};

export class ActiveTraceRegistry {
  private readonly entries = new Map<string, ActiveTraceEntry>();

  add(traceId: string): boolean {
    this.prune();
    const existing = this.entries.get(traceId);
    if (existing) {
      existing.lastSeenAtMs = Date.now();
      this.entries.delete(traceId);
      this.entries.set(traceId, existing);
      return true;
    }

    if (this.entries.size >= ACTIVE_TRACE_MAX_ENTRIES) {
      const oldestTerminal = [...this.entries.entries()].find(([, entry]) => entry.terminal);
      if (!oldestTerminal) {
        return false;
      }
      this.entries.delete(oldestTerminal[0]);
    }
    this.entries.set(traceId, { lastSeenAtMs: Date.now(), terminal: false });
    return true;
  }

  has(traceId: string): boolean {
    this.prune();
    return this.entries.has(traceId);
  }

  observe(event: RuntimeEvent): void {
    const entry = this.entries.get(event.traceId);
    if (!entry) {
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
  dashboard: z.coerce.boolean().optional().default(false)
});

export async function registerWebSocketRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.get("/ws", { websocket: true }, (socket, request) => {
    const query = WebSocketQuerySchema.safeParse(request.query);
    const dashboardMode = query.success ? query.data.dashboard : false;
    const activeTraceIds = new ActiveTraceRegistry();
    const subscription = context.eventBus.subscribe("*", (event) => {
      if (dashboardMode) {
        sendJson(socket, redactRuntimeEvent(event));
        return;
      }

      if (activeTraceIds.has(event.traceId) && shouldForwardEvent(event)) {
        sendJson(socket, redactRuntimeEvent(event));
        activeTraceIds.observe(event);
      }
    });

    if (dashboardMode) {
      sendJson(socket, {
        kind: "dashboard.connected",
        traceId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          message:
            "Dashboard WebSocket connected. Recent event replay is available through GET /events/recent."
        }
      });
    }

    socket.on("message", async (rawMessage: Buffer) => {
      let envelope: RuntimeEvent | undefined;
      try {
        const parsedEnvelope = RuntimeEventSchema.parse(
          JSON.parse(rawMessage.toString())
        ) as RuntimeEvent;
        envelope = parsedEnvelope;
        const traceAlreadyActive = activeTraceIds.has(parsedEnvelope.traceId);
        if (!activeTraceIds.add(parsedEnvelope.traceId)) {
          sendJson(
            socket,
            redactRuntimeEvent(
              createEvent(
                "runtime.error",
                { message: "WebSocket trace capacity is full; retry after active turns finish." },
                { traceId: parsedEnvelope.traceId, parentId: parsedEnvelope.id }
              )
            )
          );
          return;
        }

        if (parsedEnvelope.type !== "user.message") {
          activeTraceIds.delete(parsedEnvelope.traceId);
          sendJson(
            socket,
            redactRuntimeEvent(
              createEvent(
                "runtime.error",
                {
                  message: `Unsupported WebSocket event type '${parsedEnvelope.type}'.`
                },
                {
                  traceId: parsedEnvelope.traceId,
                  parentId: parsedEnvelope.id
                }
              )
            )
          );
          return;
        }

        const parsed = UserMessageEventSchema.parse(parsedEnvelope);
        app.log.info(
          { traceId: parsed.traceId, sessionId: parsed.payload.sessionId },
          "websocket user.message received"
        );
        try {
          const receipt = await context.conversationalReceiptAdmission.admit({
            surface: "WEBSOCKET",
            sessionId: parsed.payload.sessionId,
            runtimeEventId: parsed.id,
            content: parsed.payload.content
          });
          app.log.info(
            {
              journalEventId: receipt.envelope.eventId,
              traceId: parsed.traceId,
              sessionId: parsed.payload.sessionId
            },
            "websocket conversation receipt committed"
          );
        } catch (error) {
          if (!traceAlreadyActive) {
            activeTraceIds.delete(parsed.traceId);
          }
          const failure = toConversationalAdmissionFailure(error);
          app.log.error(
            { traceId: parsed.traceId, sessionId: parsed.payload.sessionId, code: failure.code },
            "websocket conversation receipt admission failed"
          );
          sendJson(
            socket,
            redactRuntimeEvent(
              createEvent(
                "runtime.error",
                {
                  code: failure.code,
                  message: "Message was not admitted for processing."
                },
                { traceId: parsed.traceId, parentId: parsed.id }
              )
            )
          );
          return;
        }
        await context.runtime.handleUserMessage(parsed);
      } catch (error) {
        if (envelope) {
          activeTraceIds.delete(envelope.traceId);
        }
        sendJson(
          socket,
          redactRuntimeEvent(
            createEvent(
              "runtime.error",
              {
                message: error instanceof Error ? error.message : "Invalid WebSocket event"
              },
              {
                traceId: envelope?.traceId,
                parentId: envelope?.id
              }
            )
          )
        );
      }
    });

    socket.on("close", () => {
      subscription.unsubscribe();
      activeTraceIds.clear();
    });
  });

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
