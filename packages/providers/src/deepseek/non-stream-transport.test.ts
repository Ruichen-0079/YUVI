import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderErrorCode } from "../types/errors.js";
import { DeepSeekChatProvider } from "./DeepSeekChatProvider.js";
import { DeepSeekReasoningProvider } from "./DeepSeekReasoningProvider.js";

const chatInput = { messages: [{ role: "user" as const, content: "hello" }] };
const reasoningInput = { messages: [{ role: "user" as const, content: "think" }] };

function createChatProvider(timeoutMs = 100): DeepSeekChatProvider {
  return new DeepSeekChatProvider({
    apiKey: "test-key",
    baseUrl: "https://deepseek.test/v1",
    model: "deepseek-chat",
    timeoutMs
  });
}

function createReasoningProvider(timeoutMs = 100): DeepSeekReasoningProvider {
  return new DeepSeekReasoningProvider({
    apiKey: "test-key",
    baseUrl: "https://deepseek.test/v1",
    model: "deepseek-reasoner",
    timeoutMs
  });
}

function completionResponse(content = "reply", reasoningContent?: string): Response {
  return new Response(
    JSON.stringify({
      model: "deepseek-model",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content,
            ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent })
          }
        }
      ]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function startPendingChatFetch(): Promise<{
  caller: AbortController;
  pending: Promise<unknown>;
  signal: AbortSignal;
}> {
  const caller = new AbortController();
  let markFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  let receivedSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      receivedSignal = init?.signal;
      markFetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new Error("mock fetch aborted"));
        if (receivedSignal?.aborted) {
          abort();
        } else {
          receivedSignal?.addEventListener("abort", abort, { once: true });
        }
      });
    })
  );

  const pending = createChatProvider().generateReply(chatInput, { signal: caller.signal });
  await fetchStarted;
  if (!receivedSignal) {
    throw new Error("DeepSeek fetch did not receive a transport signal.");
  }

  return { caller, pending, signal: receivedSignal };
}

describe("DeepSeek non-stream transport", () => {
  it("serializes supplied Chat and Cognition semantics without adding product context", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return completionResponse("COMPLETE\nverified");
      })
    );
    const messages = [
      { role: "system" as const, content: "P8 identity and Memory evidence" },
      { role: "user" as const, content: "Current authorized task" }
    ];
    await createChatProvider().generateReply({ messages });
    await createReasoningProvider().generateReasoning({ messages });
    expect(bodies.map((body) => body["messages"])).toEqual([messages, messages]);
  });
  it.each([
    [{ prompt_tokens_details: { cached_tokens: 80 } }, 80],
    [{ prompt_cache_hit_tokens: 64 }, 64],
    [{ prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 64 }, 0],
    [{}, undefined]
  ])(
    "preserves observed cache usage without inventing missing telemetry: %j",
    async (usage, cached) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                choices: [
                  { finish_reason: "stop", message: { role: "assistant", content: "reply" } }
                ],
                usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, ...usage }
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
        )
      );
      const result = await createChatProvider().generateReply(chatInput);
      expect(result.tokenUsage).toEqual({
        inputTokens: 100,
        outputTokens: 5,
        totalTokens: 105,
        cachedInputTokens: cached
      });
    }
  );

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns Cancelled without fetch I/O for an already-aborted chat caller", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createChatProvider().generateReply(chatInput, { signal: caller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns Cancelled when the chat caller aborts while fetch is pending", async () => {
    vi.useFakeTimers();
    const { caller, pending, signal } = await startPendingChatFetch();

    caller.abort();

    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("keeps caller cancellation active while the chat JSON body is pending", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let markJsonStarted: (() => void) | undefined;
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              const abort = () => reject(new Error("mock JSON body aborted"));
              if (receivedSignal?.aborted) {
                abort();
              } else {
                receivedSignal?.addEventListener("abort", abort, { once: true });
              }
              markJsonStarted?.();
            })
        } as Response;
      })
    );

    const pending = createChatProvider().generateReply(chatInput, { signal: caller.signal });
    await jsonStarted;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("does not return chat success when caller cancellation wins during an abort-ignoring JSON body", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let resolveJson: ((value: unknown) => void) | undefined;
    let markJsonStarted: (() => void) | undefined;
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          json: () =>
            new Promise<unknown>((resolve) => {
              resolveJson = resolve;
              markJsonStarted?.();
            })
        } as Response;
      })
    );

    const pending = createChatProvider().generateReply(chatInput, { signal: caller.signal });
    await jsonStarted;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    resolveJson?.({
      model: "deepseek-model",
      choices: [{ finish_reason: "stop", message: { content: "late reply" } }]
    });

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("returns Timeout when the chat JSON body exceeds the transport timeout", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null | undefined;
    let markJsonStarted: (() => void) | undefined;
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              const abort = () => reject(new Error("mock JSON body aborted"));
              if (receivedSignal?.aborted) {
                abort();
              } else {
                receivedSignal?.addEventListener("abort", abort, { once: true });
              }
              markJsonStarted?.();
            })
        } as Response;
      })
    );

    const pending = createChatProvider().generateReply(chatInput);
    await jsonStarted;
    vi.advanceTimersByTime(100);

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("does not return chat success when timeout wins during an abort-ignoring JSON body", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null | undefined;
    let resolveJson: ((value: unknown) => void) | undefined;
    let markJsonStarted: (() => void) | undefined;
    const jsonStarted = new Promise<void>((resolve) => {
      markJsonStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        return {
          ok: true,
          json: () =>
            new Promise<unknown>((resolve) => {
              resolveJson = resolve;
              markJsonStarted?.();
            })
        } as Response;
      })
    );

    const pending = createChatProvider().generateReply(chatInput);
    await jsonStarted;
    vi.advanceTimersByTime(100);

    expect(receivedSignal?.aborted).toBe(true);
    resolveJson?.({
      model: "deepseek-model",
      choices: [{ finish_reason: "stop", message: { content: "late reply" } }]
    });

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("keeps Timeout when timeout wins the chat cancellation race", async () => {
    vi.useFakeTimers();
    const { caller, pending, signal } = await startPendingChatFetch();

    vi.advanceTimersByTime(100);
    caller.abort();

    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("keeps Cancelled when the caller wins the chat cancellation race", async () => {
    vi.useFakeTimers();
    const { caller, pending, signal } = await startPendingChatFetch();

    caller.abort();
    vi.advanceTimersByTime(100);

    expect(signal.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("classifies an ordinary started chat transport failure as NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("mock network failure");
      })
    );

    await expect(createChatProvider().generateReply(chatInput)).rejects.toMatchObject({
      code: ProviderErrorCode.NetworkError,
      retryable: true,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });

  it.each([
    [400, ProviderErrorCode.UnsupportedInput, false],
    [401, ProviderErrorCode.InvalidApiKey, false],
    [403, ProviderErrorCode.PermissionDenied, false],
    [404, ProviderErrorCode.ModelNotFound, false],
    [408, ProviderErrorCode.Timeout, true],
    [413, ProviderErrorCode.UnsupportedInput, false],
    [415, ProviderErrorCode.UnsupportedInput, false],
    [429, ProviderErrorCode.RateLimited, true],
    [500, ProviderErrorCode.ProviderUnavailable, true]
  ])("normalizes remote HTTP %i through the shared mapping", async (status, code, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("provider error", { status }))
    );

    await expect(createChatProvider().generateReply(chatInput)).rejects.toMatchObject({
      code,
      statusCode: status,
      retryable,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });

  it("returns Cancelled when the reasoning caller aborts while fetch is pending", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        markFetchStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new Error("mock reasoning fetch aborted"));
          if (receivedSignal?.aborted) {
            abort();
          } else {
            receivedSignal?.addEventListener("abort", abort, { once: true });
          }
        });
      })
    );

    const pending = createReasoningProvider().generateReasoning(reasoningInput, {
      signal: caller.signal
    });
    await fetchStarted;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("keeps reasoning non-streaming and hides provider reasoning_content", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      completionResponse("answer", "private trace")
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await createReasoningProvider().generateReasoning({
      ...reasoningInput,
      stream: true
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: false });
    expect(output).toMatchObject({ answer: "answer", reasoning: "" });
    expect(JSON.stringify(output)).not.toContain("private trace");
  });
});
