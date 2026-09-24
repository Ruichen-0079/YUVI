import Fastify from "fastify";
import { ConversationPersistenceError, type RuntimeReplyStreamEvent } from "@companion/core";
import { ProviderError, ProviderErrorCode } from "@companion/providers";
import type { AppContext } from "../context.js";
import { registerMessageStreamRoutes } from "./message-stream.js";
import { encodeSseFrame, writeSseFrame } from "./sse.js";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

function runtimeFor(
  streamUserMessage: AppContext["runtime"]["streamUserMessage"],
  admission: NonNullable<AppContext["conversationalReceiptAdmission"]> = {
    async admit() {
      return {
        status: "APPENDED",
        envelope: { eventId: "jev1_ssefixture0000000000000001" } as never
      };
    }
  }
): AppContext {
  return { runtime: { streamUserMessage }, conversationalReceiptAdmission: admission } as unknown as AppContext;
}

async function createTestApp(context: AppContext) {
  const app = Fastify({ logger: false });
  await registerMessageStreamRoutes(app, context);
  return app;
}

function parseFrames(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .trim()
    .split("\n\n")
    .map((frame) => {
      const lines = frame.split("\n");
      return {
        event: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "",
        data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null")
      };
    });
}

describe("versioned message SSE route", () => {
  it("streams ordered deltas and one completed event", async () => {
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        yield {
          type: "text-delta",
          text: "hel",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1"
        };
        yield {
          type: "text-delta",
          text: "lo",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1"
        };
        yield {
          type: "completed",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1",
          content: "hello",
          provider: "mock"
        };
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/stream",
      headers: { origin: "http://tauri.localhost" },
      payload: { sessionId: "session-1", content: "hi" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers["connection"]).toBe("keep-alive");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    const frames = parseFrames(response.body);
    expect(frames.map((frame) => frame.event)).toEqual([
      "text-delta",
      "text-delta",
      "completed"
    ]);
    expect(frames.map((frame) => frame.data["text"]).filter(Boolean).join("")).toBe("hello");
    expect(frames.at(-1)?.data).toMatchObject({ type: "completed", content: "hello" });
    await app.close();
  });

  it("forwards one validated PNG/JPEG attachment to the same Runtime stream turn", async () => {
    let runtimeInput: unknown;
    let runtimeOptions: unknown;
    const app = await createTestApp(
      runtimeFor(async function* (input, options): AsyncIterable<RuntimeReplyStreamEvent> {
        runtimeInput = input;
        runtimeOptions = options;
        yield {
          type: "completed",
          messageId: "assistant-image",
          sessionId: "session-image",
          traceId: "trace-image",
          content: "I can see it.",
          provider: "mock"
        };
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/stream",
      payload: {
        sessionId: "session-image",
        content: "What is shown?",
        imageAttachment: { imageBase64: "AQID", mimeType: "image/png" }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(runtimeInput).toMatchObject({
      type: "user.message",
      payload: {
        sessionId: "session-image",
        content: "What is shown?"
      }
    });
    expect(runtimeOptions).toMatchObject({
      imageAttachment: { imageBase64: "AQID", mimeType: "image/png" }
    });
    await app.close();
  });

  it.each([
    {
      name: "unsupported MIME",
      imageAttachment: { imageBase64: "AQID", mimeType: "image/gif" }
    },
    {
      name: "invalid base64",
      imageAttachment: { imageBase64: "***", mimeType: "image/png" }
    },
    {
      name: "empty base64",
      imageAttachment: { imageBase64: "", mimeType: "image/jpeg" }
    }
  ])("rejects $name before Runtime", async ({ imageAttachment }) => {
    const runtime = vi.fn(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
      yield {
        type: "completed",
        messageId: "should-not-run",
        sessionId: "default",
        traceId: "should-not-run",
        content: "",
        provider: "mock"
      };
    });
    const app = await createTestApp(runtimeFor(runtime as AppContext["runtime"]["streamUserMessage"]));

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/stream",
      payload: { content: "inspect this", imageAttachment }
    });

    expect(response.statusCode).toBe(400);
    expect(runtime).not.toHaveBeenCalled();
    await app.close();
  });

  it("accepts a valid attachment request larger than Fastify's default body limit", async () => {
    const imageBase64 = Buffer.alloc(1_100_000, 7).toString("base64");
    let observedLength = 0;
    const app = await createTestApp(
      runtimeFor(async function* (_input, options): AsyncIterable<RuntimeReplyStreamEvent> {
        observedLength = options?.imageAttachment?.imageBase64.length ?? 0;
        yield {
          type: "completed",
          messageId: "assistant-large-image",
          sessionId: "large-image",
          traceId: "trace-large-image",
          content: "done",
          provider: "mock"
        };
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/stream",
      payload: {
        sessionId: "large-image",
        content: "inspect",
        imageAttachment: { imageBase64, mimeType: "image/jpeg" }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(observedLength).toBe(imageBase64.length);
    await app.close();
  });

  it("does not abort Runtime when the completed response closes normally", async () => {
    let signal: AbortSignal | undefined;
    const app = await createTestApp(
      runtimeFor(async function* (_input, options): AsyncIterable<RuntimeReplyStreamEvent> {
        signal = options?.signal;
        yield {
          type: "completed",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1",
          content: "done",
          provider: "mock"
        };
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/stream",
      payload: { sessionId: "session-1", content: "hi" }
    });

    expect(response.statusCode).toBe(200);
    expect(parseFrames(response.body).map((frame) => frame.event)).toEqual(["completed"]);
    expect(signal?.aborted).toBe(false);
    await app.close();
  });

  it("returns ordinary JSON before the first event on provider or persistence failure", async () => {
    for (const failure of [
      new ProviderError({
        provider: "mock",
        capability: "chat",
        code: ProviderErrorCode.RateLimited,
        message: "rate limited"
      }),
      new ConversationPersistenceError("assistant_stream_create", "persistence unavailable")
    ]) {
      const app = await createTestApp(
        runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
          throw failure;
        })
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages/stream",
        payload: { content: "hello" }
      });
      expect(response.statusCode).toBe(failure instanceof ProviderError ? 503 : 503);
      expect(response.headers["content-type"]).not.toContain("text/event-stream");
      expect(response.body).not.toContain("event:");
      await app.close();
    }
  });

  it("sends one safe error frame after partial output", async () => {
    const app = await createTestApp(
      runtimeFor(async function* (): AsyncIterable<RuntimeReplyStreamEvent> {
        yield {
          type: "text-delta",
          text: "partial",
          messageId: "assistant-1",
          sessionId: "session-1",
          traceId: "trace-1"
        };
        throw new ProviderError({
          provider: "mock",
          capability: "chat",
          code: ProviderErrorCode.Timeout,
          message: "secret=should-not-leak"
        });
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/stream",
      payload: { content: "hello" }
    });
    const frames = parseFrames(response.body);
    expect(response.statusCode).toBe(200);
    expect(frames.map((frame) => frame.event)).toEqual(["text-delta", "error"]);
    expect(frames.at(-1)?.data).toMatchObject({
      type: "error",
      code: ProviderErrorCode.Timeout,
      retryable: true,
      traceId: expect.any(String)
    });
    expect(response.body).not.toContain("secret=should-not-leak");
    await app.close();
  });

  it("propagates a real client disconnect to Runtime and cancels a pending TTS side effect", async () => {
    let pending: ((result: IteratorResult<RuntimeReplyStreamEvent>) => void) | undefined;
    let resolveReturnObserved!: () => void;
    const returnObserved = new Promise<void>((resolve) => {
      resolveReturnObserved = resolve;
    });
    let returnCalled = false;
    let ttsSignal: AbortSignal | undefined;
    let ttsObservedCancellation = false;
    const runtime = runtimeFor((_input, options) => {
      let first = true;
      const iterator: AsyncIterator<RuntimeReplyStreamEvent> &
        AsyncIterable<RuntimeReplyStreamEvent> = {
        async next() {
          if (first) {
            first = false;
            return {
              done: false,
              value: {
                type: "text-delta",
                text: "partial",
                messageId: "assistant-1",
                sessionId: "session-1",
                traceId: "trace-1"
              }
            };
          }
          return new Promise((resolve) => {
            pending = resolve;
            options?.signal?.addEventListener(
              "abort",
              () => {
                ttsSignal = options.signal;
                ttsObservedCancellation = true;
                resolve({ done: true, value: undefined });
              },
              { once: true }
            );
          });
        },
        async return() {
          returnCalled = true;
          pending?.({ done: true, value: undefined });
          resolveReturnObserved();
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        }
      };
      return iterator;
    });
    const app = await createTestApp(runtime);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(address).port);
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
      signal: controller.signal
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: text-delta");
    await reader.cancel();
    controller.abort();
    await returnObserved;
    expect(returnCalled).toBe(true);
    expect(ttsSignal).toBeInstanceOf(AbortSignal);
    expect(ttsObservedCancellation).toBe(true);
    await app.close();
  });
});

describe("SSE encoding and backpressure", () => {
  it("keeps user text inside one JSON data line", () => {
    const encoded = encodeSseFrame("text-delta", {
      text: "第一行\nevent: forged\ndata: forged\n\n最后一行"
    });
    expect(encoded.split("\n\n")).toHaveLength(2);
    expect(encoded.match(/^event: /gm)).toHaveLength(1);
    const dataLine = encoded.split("\n").find((line) => line.startsWith("data: "))!;
    expect(JSON.parse(dataLine.slice(6))["text"]).toContain(
      "event: forged"
    );
  });

  it("waits for drain when a writable applies backpressure", async () => {
    const response = new EventEmitter() as EventEmitter &
      Pick<ServerResponse, "write" | "destroyed" | "writableEnded">;
    Object.assign(response, { destroyed: false, writableEnded: false });
    response.write = () => {
      setImmediate(() => response.emit("drain"));
      return false;
    };
    await writeSseFrame(response as ServerResponse, "text-delta", { text: "hello" });
  });
});
