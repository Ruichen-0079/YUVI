import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { InMemoryConversationRepository } from "@companion/memory";
import type { AppContext } from "../context.js";
import { registerConversationHistoryRoutes } from "./conversation-history.js";

describe("conversation history product read", () => {
  it("reads ordered repository statuses, isolates sessions, and survives route remount plus append", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const context = { conversationRepository } as unknown as AppContext;
    const read = async () => {
      const app = Fastify();
      await registerConversationHistoryRoutes(app, context);
      try {
        expect((await app.inject("/v1/conversations/history")).statusCode).toBe(400);
        expect(
          (await app.inject("/v1/conversations/history?sessionId=other")).json().messages
        ).toEqual([]);
        return (await app.inject("/v1/conversations/history?sessionId=default")).json().messages;
      } finally {
        await app.close();
      }
    };
    for (const [index, status] of (
      ["completed", "streaming", "failed", "cancelled"] as const
    ).entries()) {
      await conversationRepository.appendMessage({
        id: `m${index}`,
        sessionId: "default",
        traceId: `t${index}`,
        parentMessageId: null,
        role: "assistant",
        content: `text ${index}`,
        status,
        createdAt: new Date().toISOString(),
        completedAt: null,
        metadata: { private: "omit" }
      });
    }
    const first = await read();
    expect(first.map((m: { status: string }) => m.status)).toEqual([
      "completed",
      "streaming",
      "failed",
      "cancelled"
    ]);
    expect(first[0]).not.toHaveProperty("metadata");
    await conversationRepository.completeMessage("m1");
    expect((await read())[1].status).toBe("completed");
    await conversationRepository.appendMessage({
      id: "append",
      sessionId: "default",
      traceId: "next",
      parentMessageId: null,
      role: "user",
      content: "append after restart",
      status: "completed",
      createdAt: new Date().toISOString(),
      completedAt: null,
      metadata: {}
    });
    expect((await read()).map((m: { id: string }) => m.id)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "append"
    ]);
  });
});
