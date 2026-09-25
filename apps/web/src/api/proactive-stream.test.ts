import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiClient,
  MessageStreamProtocolError,
  type ProactiveMessageStreamEvent,
  type ProactiveTurnStreamRequest
} from "./client.js";

const encoder = new TextEncoder();

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responseFromChunks(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}

const request: ProactiveTurnStreamRequest = {
  sessionId: "session-1",
  idempotencyKey: "caller-key-1",
  modality: "text",
  options: { readMemory: true, promptPreview: true }
};

const textDelta = {
  type: "text-delta" as const,
  text: "你好",
  messageId: "message-1",
  sessionId: "session-1",
  traceId: "trace-1"
};

const decision = {
  type: "proactive-decision" as const,
  decision: "REQUEST_TEXT" as const,
  sessionId: "session-1",
  traceId: "trace-1"
};

const noOpDecision = {
  ...decision,
  decision: "NO_OP" as const
};

const completed = {
  type: "completed" as const,
  content: "你好",
  messageId: "message-1",
  sessionId: "session-1",
  traceId: "trace-1",
  provider: "mock"
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apiClient.streamProactiveTurn", () => {
  it("posts the explicit proactive consent projection protocol", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, applied: true, state: "READY" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      apiClient.projectProactiveConsent({
        state: "READY",
        revision: 12,
        enabled: false
      })
    ).resolves.toEqual({ ok: true, applied: true, state: "READY" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v1/proactive/consent");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      state: "READY",
      revision: 12,
      enabled: false
    });
  });

  it("posts only the frozen text request body and emits the existing stream events", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        responseFromChunks([
          encoder.encode(frame("proactive-decision", decision)),
          encoder.encode(frame("text-delta", textDelta)),
          encoder.encode(frame("completed", completed))
        ])
      );
    vi.stubGlobal("fetch", fetchMock);
    const events: ProactiveMessageStreamEvent[] = [];

    await expect(
      apiClient.streamProactiveTurn(request, { onEvent: (event) => events.push(event) })
    ).resolves.toEqual(completed);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v1/proactive-turns/stream");
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(requestInit.body))).toEqual({
      sessionId: "session-1",
      idempotencyKey: "caller-key-1",
      modality: "text",
      options: { readMemory: true, promptPreview: true }
    });
    expect(events.map((event) => event.type)).toEqual([
      "proactive-decision",
      "text-delta",
      "completed"
    ]);
  });

  it("validates completed content against accumulated deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          responseFromChunks([
            encoder.encode(
              frame("proactive-decision", decision) +
                frame("text-delta", textDelta) +
                frame("completed", { ...completed, content: "不同" })
            )
          ])
        )
    );

    await expect(apiClient.streamProactiveTurn(request)).rejects.toBeInstanceOf(
      MessageStreamProtocolError
    );
  });

  it("accepts NO_OP as a successful terminal proactive result", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          responseFromChunks([encoder.encode(frame("proactive-decision", noOpDecision))])
        )
    );
    const events: ProactiveMessageStreamEvent[] = [];

    await expect(
      apiClient.streamProactiveTurn(request, { onEvent: (event) => events.push(event) })
    ).resolves.toEqual(noOpDecision);
    expect(events).toEqual([noOpDecision]);
  });

  it("rejects proactive text before a decision", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          responseFromChunks([
            encoder.encode(frame("text-delta", textDelta) + frame("completed", completed))
          ])
        )
    );

    await expect(apiClient.streamProactiveTurn(request)).rejects.toBeInstanceOf(
      MessageStreamProtocolError
    );
  });

  it("rejects a second decision and events after NO_OP", async () => {
    for (const chunks of [
      [
        frame("proactive-decision", decision),
        frame("proactive-decision", noOpDecision),
        frame("text-delta", textDelta),
        frame("completed", completed)
      ],
      [frame("proactive-decision", noOpDecision), frame("text-delta", textDelta)]
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(responseFromChunks([encoder.encode(chunks.join(""))]))
      );
      await expect(apiClient.streamProactiveTurn(request)).rejects.toBeInstanceOf(
        MessageStreamProtocolError
      );
      vi.unstubAllGlobals();
    }
  });

  it("surfaces a pre-SSE idempotency conflict without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "idempotency_conflict",
          message: "The assistant turn idempotency key has already been used."
        }),
        { status: 409, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiClient.streamProactiveTurn(request)).rejects.toMatchObject({
      name: "ApiError",
      status: 409
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes the caller AbortSignal to the one request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiClient.streamProactiveTurn(request, { signal: controller.signal })
    ).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});
