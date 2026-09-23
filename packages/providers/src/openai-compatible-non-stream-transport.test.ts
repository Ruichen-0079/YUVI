import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatProvider } from "./types/chat.js";
import type { EmbeddingProvider } from "./types/embedding.js";
import { ProviderErrorCode } from "./types/errors.js";
import type { ReasoningProvider } from "./types/reasoning.js";
import { createProviderRegistryFromEnv } from "./registry.js";

const chatInput = { messages: [{ role: "user" as const, content: "hello" }] };
const reasoningInput = { messages: [{ role: "user" as const, content: "think" }] };

function openAICompatibleLeaves(embeddingOverrides: Record<string, string> = {}): {
  chat: ChatProvider;
  reasoning: ReasoningProvider;
  embedding: EmbeddingProvider;
} {
  const registry = createProviderRegistryFromEnv({
    NODE_ENV: "test",
    PROVIDER_ALLOW_MOCKS: "false",
    DEFAULT_CHAT_PROVIDER: "nvidia",
    CHAT_PROVIDER_CHAIN: "nvidia",
    DEFAULT_REASONING_PROVIDER: "nvidia",
    REASONING_PROVIDER_CHAIN: "nvidia",
    DEFAULT_EMBEDDING_PROVIDER: "openai-compatible",
    EMBEDDING_PROVIDER_CHAIN: "openai-compatible",
    NVIDIA_API_KEY: "nvidia-key",
    NVIDIA_API_BASEURL: "https://nvidia.test/v1",
    NVIDIA_CHAT_MODEL: "nvidia-chat",
    NVIDIA_REASONING_MODEL: "nvidia-reasoner",
    EMBEDDING_API_KEY: "embedding-key",
    EMBEDDING_API_BASEURL: "https://embedding.test/v1",
    EMBEDDING_MODEL: "embedding-model",
    EMBEDDING_DIMENSIONS: "2",
    ...embeddingOverrides
  });

  return {
    chat: firstLeaf(registry.getChatProvider()),
    reasoning: firstLeaf(registry.getReasoningProvider()),
    embedding: firstLeaf(registry.getEmbeddingProvider())
  };
}

function firstLeaf<TProvider>(provider: TProvider): TProvider {
  const leaves = (provider as TProvider & { providers?: TProvider[] }).providers;
  const leaf = leaves?.[0];
  if (!leaf) {
    throw new Error("OpenAI-compatible fallback wrapper did not contain a leaf provider.");
  }
  return leaf;
}

function chatCompletionPayload(content = "reply", reasoningContent?: string): Record<string, unknown> {
  return {
    model: "openai-compatible-model",
    choices: [
      {
        finish_reason: "stop",
        message: {
          content,
          ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent })
        }
      }
    ]
  };
}

function chatCompletionResponse(content = "reply", reasoningContent?: string): Response {
  return new Response(JSON.stringify(chatCompletionPayload(content, reasoningContent)), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function embeddingPayload(vectors: number[][]): Record<string, unknown> {
  return {
    data: vectors.map((embedding, index) => ({ embedding, index }))
  };
}

describe("OpenAI-compatible non-stream transport", () => {
  it("serializes supplied Chat and Cognition semantics without adding product context", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return chatCompletionResponse("COMPLETE\nverified");
    }));
    const { chat, reasoning } = openAICompatibleLeaves();
    const messages = [
      { role: "system" as const, content: "P8 identity and Memory evidence" },
      { role: "user" as const, content: "Current authorized task" }
    ];
    await chat.generateReply({ messages });
    await reasoning.generateReasoning({ messages });
    expect(bodies.map((body) => body["messages"])).toEqual([messages, messages]);
  });
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
      openAICompatibleLeaves().chat.generateReply(chatInput, { signal: caller.signal })
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
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          receivedSignal = init?.signal;
          markFetchStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            receivedSignal?.addEventListener(
              "abort",
              () => reject(new Error("mock chat fetch aborted")),
              { once: true }
            );
          });
        }
      )
    );

    const pending = openAICompatibleLeaves().chat.generateReply(chatInput, {
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

  it("keeps Cancelled when caller wins during an abort-ignoring chat JSON body", async () => {
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

    const pending = openAICompatibleLeaves().chat.generateReply(chatInput, {
      signal: caller.signal
    });
    await jsonStarted;
    caller.abort();
    vi.advanceTimersByTime(30000);

    expect(receivedSignal?.aborted).toBe(true);
    resolveJson?.(chatCompletionPayload("late reply"));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });

  it("keeps Timeout when timeout wins during an abort-ignoring chat JSON body", async () => {
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

    const pending = openAICompatibleLeaves().chat.generateReply(chatInput, {
      signal: caller.signal
    });
    await jsonStarted;
    vi.advanceTimersByTime(30000);
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    resolveJson?.(chatCompletionPayload("late reply"));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("classifies an ordinary started chat failure as NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("mock network failure");
      })
    );

    await expect(openAICompatibleLeaves().chat.generateReply(chatInput)).rejects.toMatchObject({
      code: ProviderErrorCode.NetworkError,
      retryable: true,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });

  it("classifies a malformed successful chat response as MalformedResponse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON", { status: 200 })));

    await expect(openAICompatibleLeaves().chat.generateReply(chatInput)).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      retryable: false,
      effectState: "unknown"
    });
  });

  it.each([
    [401, ProviderErrorCode.InvalidApiKey, false],
    [429, ProviderErrorCode.RateLimited, true],
    [500, ProviderErrorCode.ProviderUnavailable, true]
  ])("normalizes remote chat HTTP %i through the shared mapping", async (status, code, retryable) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider error", { status })));

    await expect(openAICompatibleLeaves().chat.generateReply(chatInput)).rejects.toMatchObject({
      code,
      statusCode: status,
      retryable,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });

  it("keeps chat generateReply non-streaming", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => chatCompletionResponse()
    );
    vi.stubGlobal("fetch", fetchMock);

    await openAICompatibleLeaves().chat.generateReply({ ...chatInput, stream: true });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: false });
  });

  it("propagates reasoning caller cancellation to fetch", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          receivedSignal = init?.signal;
          markFetchStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            receivedSignal?.addEventListener(
              "abort",
              () => reject(new Error("mock reasoning fetch aborted")),
              { once: true }
            );
          });
        }
      )
    );

    const pending = openAICompatibleLeaves().reasoning.generateReasoning(reasoningInput, {
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
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        chatCompletionResponse("answer", "private trace")
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await openAICompatibleLeaves().reasoning.generateReasoning({
      ...reasoningInput,
      stream: true
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: false });
    expect(output).toMatchObject({ answer: "answer", reasoning: "" });
    expect(JSON.stringify(output)).not.toContain("private trace");
  });

  it("propagates embedText caller cancellation to the actual fetch", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          receivedSignal = init?.signal;
          markFetchStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            receivedSignal?.addEventListener(
              "abort",
              () => reject(new Error("mock embedding fetch aborted")),
              { once: true }
            );
          });
        }
      )
    );

    const pending = openAICompatibleLeaves().embedding.embedText("hello", {
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

  it("returns Cancelled without fetch I/O for an already-aborted embedText caller", async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openAICompatibleLeaves().embedding.embedText("hello", { signal: caller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates embedBatch caller cancellation to the actual fetch", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          receivedSignal = init?.signal;
          markFetchStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            receivedSignal?.addEventListener(
              "abort",
              () => reject(new Error("mock embedding fetch aborted")),
              { once: true }
            );
          });
        }
      )
    );

    const pending = openAICompatibleLeaves().embedding.embedBatch(["one", "two"], {
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

  it("returns Timeout when embedding transport exceeds its timeout", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          receivedSignal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            receivedSignal?.addEventListener(
              "abort",
              () => reject(new Error("mock embedding fetch aborted")),
              { once: true }
            );
          });
        }
      )
    );

    const pending = openAICompatibleLeaves().embedding.embedBatch(["one"]);
    vi.advanceTimersByTime(30000);

    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      effectState: "unknown"
    });
  });

  it("normalizes embedding HTTP 429 through the shared mapping", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));

    await expect(openAICompatibleLeaves().embedding.embedBatch(["one"])).rejects.toMatchObject({
      code: ProviderErrorCode.RateLimited,
      statusCode: 429,
      retryable: true,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });

  it("truncates and L2-normalizes local 1024-d embeddings at the provider boundary", async () => {
    const native = Array.from({ length: 1024 }, (_, index) =>
      index === 0 ? 3 : index === 1 ? 4 : 1
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(embeddingPayload([native])), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )
    );

    const output = await openAICompatibleLeaves({
      DEFAULT_EMBEDDING_PROVIDER: "local",
      EMBEDDING_PROVIDER_CHAIN: "local",
      LOCAL_MODEL_BASEURL: "http://127.0.0.1:8128/v1",
      LOCAL_EMBEDDING_MODEL: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      LOCAL_EMBEDDING_DIMENSIONS: "512"
    }).embedding.embedText("hello");
    const expectedNorm = Math.sqrt(3 * 3 + 4 * 4 + 510);

    expect(output).toHaveLength(512);
    expect(output[0]).toBeCloseTo(3 / expectedNorm, 8);
    expect(output[1]).toBeCloseTo(4 / expectedNorm, 8);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...output)).toBeCloseTo(1, 6);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      dimensions: 512
    });
  });

  it("does not apply Qwen MRL to an unrelated local embedding model", async () => {
    const native = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 3 : 1));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(embeddingPayload([native])), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )
    );

    const output = await openAICompatibleLeaves({
      DEFAULT_EMBEDDING_PROVIDER: "local",
      EMBEDDING_PROVIDER_CHAIN: "local",
      LOCAL_MODEL_BASEURL: "http://127.0.0.1:8128/v1",
      LOCAL_EMBEDDING_MODEL: "unrelated-local-embedding-model",
      LOCAL_EMBEDDING_DIMENSIONS: "512"
    }).embedding.embedText("hello");

    expect(output).toEqual(native);
    expect(output).toHaveLength(1024);
  });

  it.each([
    ["short", Array.from({ length: 511 }, () => 1)],
    ["zero prefix", Array.from({ length: 512 }, () => 0)],
    ["non-finite prefix", [Number.NaN, ...Array.from({ length: 511 }, () => 1)]]
  ])("fails closed for a local MRL %s embedding", async (_label, vector) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(embeddingPayload([vector])), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )
    );

    await expect(
      openAICompatibleLeaves({
        DEFAULT_EMBEDDING_PROVIDER: "local",
        EMBEDDING_PROVIDER_CHAIN: "local",
        LOCAL_MODEL_BASEURL: "http://127.0.0.1:8128/v1",
        LOCAL_EMBEDDING_MODEL: "Qwen3-Embedding-0.6B-Q8_0.gguf",
        LOCAL_EMBEDDING_DIMENSIONS: "512"
      }).embedding.embedText("hello")
    ).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      retryable: false,
      provider: "local",
      capability: "embedding"
    });
  });

  it("does not return embedding success when caller wins during an abort-ignoring JSON body", async () => {
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

    const pending = openAICompatibleLeaves().embedding.embedBatch(["one"], {
      signal: caller.signal
    });
    await jsonStarted;
    caller.abort();

    expect(receivedSignal?.aborted).toBe(true);
    resolveJson?.(embeddingPayload([[0.1, 0.2]]));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown"
    });
  });
});
