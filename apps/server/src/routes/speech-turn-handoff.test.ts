import Fastify from "fastify";
import { createEvent } from "@companion/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { registerMessageRoutes } from "./message.js";
import { registerMessageStreamRoutes } from "./message-stream.js";

describe.each(["/v1/messages", "/v1/messages/stream"])("speech handoff %s", (url) => {
  it("passes server-owned per-segment evidence to Runtime", async () => {
    const voice = createEvent("user.voice.transcript", {
      sessionId: "s",
      content: "hello",
      observationId: "observation",
      segments: [
        {
          speakerClusterId: "cluster",
          voiceProfileMatch: { status: "MATCHED", voiceProfileId: "acoustic" }
        }
      ]
    });
    const commitSpeechTurn = vi.fn(() => voice);
    const admitConversationalReceipt = vi.fn();
    const received: unknown[] = [];
    const context = {
      runtime: {
        commitSpeechTurn,
        handleUserMessage: async (event: unknown) => {
          received.push(event);
          return null;
        },
        streamUserMessage: async function* (event: unknown) {
          received.push(event);
          yield {
            type: "completed",
            messageId: "assistant",
            sessionId: "s",
            traceId: "trace",
            content: "hello",
            language: "ja",
            provider: "test"
          };
        }
      },
      conversationalReceiptAdmission: { admit: admitConversationalReceipt }
    } as unknown as AppContext;
    const app = Fastify({ logger: false });
    await registerMessageRoutes(app, context);
    await registerMessageStreamRoutes(app, context);
    try {
      const response = await app.inject({
        method: "POST",
        url,
        payload: {
          sessionId: "s",
          text: "hello",
          speechObservationId: "observation",
          subjectUserId: "untrusted-identity"
        }
      });
      expect(response.statusCode).toBe(200);
      expect(commitSpeechTurn).toHaveBeenCalledWith("observation", "s", "hello");
      expect(admitConversationalReceipt).not.toHaveBeenCalled();
      expect(received).toEqual([voice]);
      if (url.endsWith("stream")) expect(response.body).toContain('"language":"ja"');
      commitSpeechTurn.mockImplementation(() => {
        throw new Error("stale observation");
      });
      const stale = await app.inject({
        method: "POST",
        url,
        payload: { sessionId: "s", text: "hello", speechObservationId: "observation" }
      });
      expect(stale.statusCode).toBe(409);
      expect(received).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
