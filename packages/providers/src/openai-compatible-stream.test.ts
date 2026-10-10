import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekChatProvider } from "./deepseek/DeepSeekChatProvider.js";
import { ProviderErrorCode, createProviderRegistryFromEnv, type ChatProvider } from "./index.js";

function streamResponse(chunks: Uint8Array[], onCancel?: () => void): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) {
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
    cancel() {
      onCancel?.();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function frame(data: unknown, newline = "\n"): string {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}${newline}${newline}`;
}

function createProvider() {
  return new DeepSeekChatProvider({
    apiKey: "test-key",
    baseUrl: "https://deepseek.test/v1",
    model: "deepseek-chat"
  });
}

async function collect(provider: ChatProvider, signal?: AbortSignal) {
  const events = [];
  if (!provider.streamReply) {
    throw new Error("Provider does not support streaming in this test.");
  }
  for await (const event of provider.streamReply(
    { messages: [{ role: "user", content: "hello" }] },
    { signal }
  )) {
    events.push(event);
  }
  return events;
}

describe("OpenAI-compatible native chat streaming", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["\n", "\r\n", "\r"])(
    "ignores comment heartbeats before, between and after business frames (%j)",
    async (newline) => {
      const heartbeat = `: ping - 2026-10-10 04:41:32+00:00${newline}${newline}`;
      const body = [
        heartbeat,
        frame({ choices: [{ delta: { content: "first" } }] }, newline),
        heartbeat,
        frame({ choices: [{ delta: { content: " second" }, finish_reason: "stop" }] }, newline),
        frame("[DONE]", newline),
        heartbeat
      ].join("");
      const bytes = encoded(body);
      // One byte per pull also splits Unicode and CRLF boundaries.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => streamResponse(Array.from(bytes, (byte) => new Uint8Array([byte]))))
      );
      const events = await collect(createProvider());
      expect(events.filter((event) => event.type === "text-delta")).toEqual([
        { type: "text-delta", text: "first" },
        { type: "text-delta", text: " second" }
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        output: { message: { content: "first second" }, finishReason: "stop" }
      });
    }
  );

  it("reads split UTF-8 SSE frames, role-only and usage frames, then emits one completed", async () => {
    const responseText = [
      `event: message\r\n${frame({ model: "deepseek-chat", choices: [{ delta: { role: "assistant" }, finish_reason: null }] }, "\r\n")}`,
      frame({ choices: [{ delta: { content: "你" }, finish_reason: null }] }, "\r\n"),
      frame({ choices: [{ delta: { content: "好\n" }, finish_reason: null }] }, "\r\n"),
      frame(
        {
          choices: [],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
            prompt_tokens_details: { cached_tokens: 2 }
          }
        },
        "\r\n"
      ),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }, "\r\n"),
      frame("[DONE]", "\r\n")
    ].join("");
    const bytes = encoded(responseText);
    const splitAt = Math.max(1, Math.floor(bytes.length / 3));
    const secondSplitAt = Math.max(splitAt + 1, Math.floor((bytes.length * 2) / 3));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        streamResponse([
          bytes.slice(0, splitAt),
          bytes.slice(splitAt, secondSplitAt),
          bytes.slice(secondSplitAt)
        ])
      )
    );

    const events = await collect(createProvider());
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "你" },
      { type: "text-delta", text: "好\n" }
    ]);
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: {
        message: { content: "你好\n" },
        model: "deepseek-chat",
        tokenUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedInputTokens: 2 }
      }
    });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body).toContain('"stream":true');
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer test-key"
    });
  });

  it("keeps generateReply non-streaming when the legacy input flag is true", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: "deepseek-chat",
            choices: [{ message: { content: "reply" }, finish_reason: "stop" }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await createProvider().generateReply({
      messages: [{ role: "user", content: "hello" }],
      stream: true
    });

    expect(output.message.content).toBe("reply");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({ stream: false });
  });

  it("accepts a nullable usage frame from an OpenAI-compatible gateway", async () => {
    const body = [
      frame({ choices: [{ delta: { content: "nullable usage" } }] }),
      frame({ choices: [], usage: null }),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      frame("[DONE]")
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse([encoded(body)]))
    );

    const events = await collect(createProvider());

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: { message: { content: "nullable usage" }, tokenUsage: undefined }
    });
  });

  it("does not expose provider reasoning_content as normalized stream output", async () => {
    const body = [
      frame({ choices: [{ delta: { reasoning_content: "private trace", content: "visible" } }] }),
      frame({ choices: [{ delta: { reasoning_content: "more private trace" } }] }),
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      frame("[DONE]")
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse([encoded(body)]))
    );

    const events = await collect(createProvider());
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "visible" }
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: { message: { content: "visible" } }
    });
    expect(JSON.stringify(events)).not.toContain("private trace");
  });

  it("joins multiple data lines in one SSE frame", async () => {
    const body = [
      'data: {"choices": [\n',
      'data: {"delta": {"content": "split"}}]}\n\n',
      frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      frame("[DONE]")
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse([encoded(body)]))
    );

    const events = await collect(createProvider());
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "split" }
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: { message: { content: "split" } }
    });
  });

  it("uses the same native client for an OpenAI-compatible NVIDIA chat route", async () => {
    const body = `${frame({ model: "nvidia-model", choices: [{ delta: { content: "NVIDIA" } }] })}${frame({ choices: [{ delta: {}, finish_reason: "stop" }] })}${frame("[DONE]")}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse([encoded(body)]))
    );
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "nvidia",
      CHAT_PROVIDER_CHAIN: "nvidia",
      NVIDIA_API_KEY: "nvidia-key",
      NVIDIA_CHAT_MODEL: "nvidia-model"
    });

    const provider = registry.getChatProvider();
    expect(registry.getChatStreamingMode()).toBe("native");
    const events = await collect(provider);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: { message: { content: "NVIDIA" }, finalProvider: "nvidia" }
    });
  });

  it("uses the generic OpenAI-compatible Chat route with the configured model and Bearer key", async () => {
    const body = `${frame({ model: "deepseek-ai/DeepSeek-V4-Flash-0731", choices: [{ delta: { content: "remote" } }] })}${frame({ choices: [{ delta: {}, finish_reason: "stop" }] })}${frame("[DONE]")}`;
    const fetchMock = vi.fn(async () => streamResponse([encoded(body)]));
    vi.stubGlobal("fetch", fetchMock);
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "openai-compatible",
      CHAT_PROVIDER_CHAIN: "openai-compatible",
      OPENAI_COMPATIBLE_API_BASEURL: "https://api.deepinfra.com/v1/openai",
      OPENAI_COMPATIBLE_API_KEY: "deepinfra-key",
      OPENAI_COMPATIBLE_CHAT_MODEL: "deepseek-ai/DeepSeek-V4-Flash-0731"
    });

    const events = await collect(registry.getChatProvider());

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: {
        message: { content: "remote" },
        model: "deepseek-ai/DeepSeek-V4-Flash-0731",
        finalProvider: "openai-compatible"
      }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepinfra.com/v1/openai/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"deepseek-ai/DeepSeek-V4-Flash-0731"'),
        headers: expect.objectContaining({ authorization: "Bearer deepinfra-key" })
      })
    );
  });

  it("preserves the saved Product API path when streaming chat", async () => {
    const body = `${frame({ choices: [{ delta: { content: "remote" } }] })}${frame("[DONE]")}`;
    const fetchMock = vi.fn(async () => streamResponse([encoded(body)]));
    vi.stubGlobal("fetch", fetchMock);
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "false",
      YUVI_PRODUCT_CONFIGURATION: JSON.stringify({
        version: 1,
        providers: [
          {
            id: "remote",
            displayName: "Remote",
            adapter: "openai-compatible",
            baseUrl: "https://api.deepinfra.com/v1/openai/",
            apiKey: "test-key"
          }
        ],
        models: [
          {
            id: "chat",
            providerId: "remote",
            displayName: "Chat",
            modelId: "remote-model",
            enabled: true,
            temperature: 0.7,
            contextWindow: null,
            capabilities: ["chat"]
          }
        ],
        routes: {
          chat: ["chat"],
          reasoning: [],
          proactive: [],
          embedding: [],
          vision: [],
          stt: [],
          tts: []
        }
      })
    });
    expect((await collect(registry.getChatProvider())).at(-1)).toMatchObject({
      type: "completed",
      output: { message: { content: "remote" } }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepinfra.com/v1/openai/chat/completions",
      expect.objectContaining({ body: expect.stringContaining('"model":"remote-model"') })
    );
  });
  it("does not fall back after a dispatched streaming provider rejection", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("deepseek")) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      }
      const body = `${frame({ model: "nvidia-model", choices: [{ delta: { content: "backup" } }] })}${frame({ choices: [{ delta: {}, finish_reason: "stop" }] })}${frame("[DONE]")}`;
      return streamResponse([encoded(body)]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek,nvidia",
      DEEPSEEK_API_KEY: "deepseek-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      NVIDIA_API_KEY: "nvidia-key",
      NVIDIA_CHAT_MODEL: "nvidia-model"
    });

    await expect(collect(registry.getChatProvider())).rejects.toMatchObject({
      code: ProviderErrorCode.RateLimited,
      effectState: "unknown"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("deepseek");
  });

  it.each([
    {
      name: "invalid JSON",
      body: `${frame("not-json")}\n`,
      expected: "invalid JSON"
    },
    {
      name: "missing done",
      body: frame({ choices: [{ delta: { content: "partial" } }] }),
      expected: "before [DONE]"
    },
    {
      name: "incomplete frame",
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}`,
      expected: "incomplete SSE frame"
    },
    {
      name: "empty answer",
      body: `${frame({ choices: [{ delta: { role: "assistant" } }] })}${frame("[DONE]")}`,
      expected: "empty assistant response"
    }
  ])("rejects $name", async ({ body, expected }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse([encoded(body)]))
    );

    await expect(collect(createProvider())).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      message: expect.stringContaining(expected)
    });
  });

  it("rejects business frames after [DONE]", async () => {
    const body = `${frame({ choices: [{ delta: { content: "ok" } }] })}${frame("[DONE]")}${frame({ choices: [{ delta: { content: "late" } }] })}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse([encoded(body)]))
    );

    await expect(collect(createProvider())).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      message: expect.stringContaining("after [DONE]")
    });
  });

  it("maps external abort to CANCELLED and does not emit completed", async () => {
    const controller = new AbortController();
    const body = `${frame({ choices: [{ delta: { content: "first" } }] })}`;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          async pull(streamController) {
            streamController.enqueue(encoded(body));
            await waiting;
          },
          cancel() {
            release?.();
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      })
    );

    const provider = createProvider();
    const iterator = provider
      .streamReply(
        { messages: [{ role: "user", content: "hello" }] },
        { signal: controller.signal }
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text-delta", text: "first" }
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
  });

  it("rejects a signal that was already aborted before fetch starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect(createProvider(), controller.signal)).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects truncated UTF-8 and non-SSE responses safely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded(frame({ choices: [{ delta: { content: "ok" } }] })));
            controller.enqueue(new Uint8Array([0xff]));
            controller.close();
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      })
    );
    await expect(collect(createProvider())).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      message: expect.stringContaining("UTF-8")
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      )
    );
    await expect(collect(createProvider())).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      message: expect.stringContaining("text/event-stream")
    });
  });

  it("cancels and releases the underlying reader when the consumer returns early", async () => {
    let cancelled = false;
    const body = `${frame({ choices: [{ delta: { content: "first" } }] })}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded(body));
          },
          cancel() {
            cancelled = true;
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      })
    );

    const iterator = createProvider()
      .streamReply({ messages: [{ role: "user", content: "hello" }] })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text-delta", text: "first" }
    });
    await iterator.return?.();
    expect(cancelled).toBe(true);
  });
});
