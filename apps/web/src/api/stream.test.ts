import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiClient,
  MessageSseParser,
  MessageStreamError,
  MessageStreamProtocolError,
  type MessageStreamEvent
} from "./client.js";

const encoder = new TextEncoder();

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function collect(chunks: Uint8Array[]): MessageStreamEvent[] {
  const parser = new MessageSseParser();
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  parser.finish();
  return events;
}

function responseFromChunks(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}

const textDelta = {
  type: "text-delta" as const,
  text: "你好",
  messageId: "message-1",
  sessionId: "session-1",
  traceId: "trace-1"
};

const completed = {
  type: "completed" as const,
  content: "你好",
  messageId: "message-1",
  sessionId: "session-1",
  traceId: "trace-1",
  provider: "mock"
};

const projectedDelta = {
  ...textDelta,
  replyId: "reply-1",
  componentId: `rc1_${"a".repeat(64)}`,
  sequence: "1"
};
const projectedCompleted = {
  ...completed,
  replyId: "reply-1",
  lastSequence: "1"
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MessageSseParser", () => {
  it("handles multiple frames in one chunk and a frame split across chunks", () => {
    const first = frame("text-delta", { ...textDelta, text: "你" });
    const second = frame("text-delta", { ...textDelta, text: "好" });
    const splitAt = Math.floor(second.length / 2);
    const events = collect([
      encoder.encode(first + second.slice(0, splitAt)),
      encoder.encode(second.slice(splitAt) + frame("completed", completed))
    ]);

    expect(events.map((event) => event.type)).toEqual(["text-delta", "text-delta", "completed"]);
    expect(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join("")
    ).toBe(completed.content);
  });

  it("preserves UTF-8 characters split across byte chunks", () => {
    const bytes = encoder.encode(frame("text-delta", textDelta) + frame("completed", completed));
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const events = collect(chunks);

    expect(events[0]).toMatchObject(textDelta);
    expect(events[1]).toMatchObject(completed);
  });

  it("preserves newlines across multiple SSE text deltas", () => {
    const firstText = "第一行\n";
    const secondText = "\n第三行🙂";
    const events = collect([
      encoder.encode(frame("text-delta", { ...textDelta, text: firstText })),
      encoder.encode(
        frame("text-delta", { ...textDelta, text: secondText }) +
          frame("completed", { ...completed, content: firstText + secondText })
      )
    ]);

    expect(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join("")
    ).toBe("第一行\n\n第三行🙂");
    expect(events.at(-1)).toMatchObject({ type: "completed", content: "第一行\n\n第三行🙂" });
  });

  it("does not let escaped user text inject an SSE frame", () => {
    const event = {
      ...textDelta,
      text: "第一行\nevent: forged\ndata: forged\n\n最后一行"
    };
    const events = collect([
      encoder.encode(
        frame("text-delta", event) + frame("completed", { ...completed, content: event.text })
      )
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "text-delta", text: event.text });
  });

  it("rejects malformed JSON, unknown events, and events after completed", () => {
    expect(() => collect([encoder.encode("event: text-delta\ndata: {bad}\n\n")])).toThrow(
      MessageStreamProtocolError
    );
    expect(() => collect([encoder.encode("event: unknown\ndata: {}\n\n")])).toThrow(
      MessageStreamProtocolError
    );
    const extra = frame("text-delta", { ...textDelta, text: "!" });
    expect(() => collect([encoder.encode(frame("completed", completed) + extra)])).toThrow(
      MessageStreamProtocolError
    );
  });

  it("accepts a sealed projected reply and rejects duplicate or conflicting component order", () => {
    expect(
      collect([
        encoder.encode(frame("text-delta", projectedDelta) + frame("completed", projectedCompleted))
      ])
    ).toHaveLength(2);

    const repeatedSequence = { ...projectedDelta, text: "different" };
    expect(() =>
      collect([
        encoder.encode(
          frame("text-delta", projectedDelta) +
            frame("text-delta", repeatedSequence) +
            frame("completed", projectedCompleted)
        )
      ])
    ).toThrow(MessageStreamProtocolError);

    expect(() =>
      collect([
        encoder.encode(
          frame("text-delta", projectedDelta) +
            frame("completed", { ...projectedCompleted, lastSequence: "2" })
        )
      ])
    ).toThrow(MessageStreamProtocolError);
  });

  it("rejects an incomplete stream and accepts one terminal error", () => {
    expect(() => collect([encoder.encode(frame("text-delta", textDelta))])).toThrow(
      MessageStreamProtocolError
    );
    const error = {
      type: "error" as const,
      code: "TIMEOUT",
      message: "Provider request timed out.",
      retryable: true,
      traceId: "trace-1"
    };
    expect(collect([encoder.encode(frame("error", error))])).toEqual([error]);
    expect(() => collect([encoder.encode(frame("error", error) + frame("error", error))])).toThrow(
      MessageStreamProtocolError
    );
  });

  it("rejects truncated UTF-8 when finishing the decoder", () => {
    const parser = new MessageSseParser();
    parser.push(new Uint8Array([0xe4]));

    expect(() => parser.finish()).toThrow(MessageStreamProtocolError);
  });
});

describe("apiClient.streamMessage", () => {
  it("returns a completed message after deltas and emits typed events", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          responseFromChunks([
            encoder.encode(frame("text-delta", { ...textDelta, text: "你" })),
            encoder.encode(
              frame("text-delta", { ...textDelta, text: "好" }) + frame("completed", completed)
            )
          ])
        )
    );
    const events: MessageStreamEvent[] = [];
    const result = await apiClient.streamMessage(
      { sessionId: "session-1", text: "hello", options: { voiceOutput: false } },
      { onEvent: (event) => events.push(event) }
    );

    expect(result).toEqual(completed);
    expect(events.map((event) => event.type)).toEqual(["text-delta", "text-delta", "completed"]);
  });

  it("rejects completed content that differs from accumulated deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          responseFromChunks([
            encoder.encode(
              frame("text-delta", textDelta) + frame("completed", { ...completed, content: "不同" })
            )
          ])
        )
    );

    await expect(
      apiClient.streamMessage({
        sessionId: "session-1",
        text: "hello",
        options: { voiceOutput: false }
      })
    ).rejects.toBeInstanceOf(MessageStreamProtocolError);
  });

  it("maps HTTP JSON errors and SSE error events to safe errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "persistence_failed", message: "secret" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
      )
    );
    await expect(
      apiClient.streamMessage({
        sessionId: "session-1",
        text: "hello",
        options: { voiceOutput: false }
      })
    ).rejects.toMatchObject({ status: 503, message: "消息保存失败，请稍后重试。" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFromChunks([
          encoder.encode(
            frame("error", {
              type: "error",
              code: "TIMEOUT",
              message: "secret=not-for-ui",
              retryable: true,
              traceId: "trace-1"
            })
          )
        ])
      )
    );
    await expect(
      apiClient.streamMessage({
        sessionId: "session-1",
        text: "hello",
        options: { voiceOutput: false }
      })
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "Provider 请求超时。"
    } satisfies Partial<MessageStreamError>);
  });

  it("explains a missing provider model or endpoint without exposing upstream text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "MODEL_NOT_FOUND",
            message: "secret upstream details"
          }),
          { status: 404 }
        )
      )
    );
    await expect(
      apiClient.streamMessage({
        sessionId: "session-1",
        text: "hello",
        options: { voiceOutput: false }
      })
    ).rejects.toMatchObject({
      status: 404,
      message: "Provider 模型或 API 地址不存在，请检查模型 ID 和 API Base URL。"
    });
    expect(
      new MessageStreamError({
        type: "error",
        code: "MODEL_NOT_FOUND",
        message: "secret upstream details",
        retryable: false
      }).message
    ).toBe("Provider 模型或 API 地址不存在，请检查模型 ID 和 API Base URL。");
  });
  it("passes AbortSignal to fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiClient.streamMessage(
        { sessionId: "session-1", text: "hello", options: { voiceOutput: false } },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});
