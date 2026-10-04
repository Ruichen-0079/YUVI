import {
  FallbackChatProvider,
  ProviderRegistry,
  ProviderError,
  ProviderErrorCode,
  createMockChatProvider,
  createMockStreamingChatProvider,
  createProviderRegistryConfigFromEnv,
  getChatStreamingMode,
  type ChatInput,
  type ChatOutput,
  type ChatProvider,
  type ChatStreamEvent,
  type ProviderCallOptions
} from "./index.js";
import { describe, expect, it, vi } from "vitest";

const input: ChatInput = {
  messages: [{ role: "user", content: "hello" }]
};

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function trackedStream(events: ChatStreamEvent[]) {
  let index = 0;
  const returnSpy = vi.fn(
    async (): Promise<IteratorResult<ChatStreamEvent>> => ({ done: true, value: undefined })
  );
  const iterable: AsyncIterable<ChatStreamEvent> & AsyncIterator<ChatStreamEvent> = {
    async next() {
      const event = events[index++];
      return event ? { done: false, value: event } : { done: true, value: undefined };
    },
    return: returnSpy,
    [Symbol.asyncIterator]() {
      return this;
    }
  };
  return { iterable, returnSpy };
}

function providerError(
  provider: string,
  code: ProviderErrorCode,
  message = `${provider} failed`
): ProviderError {
  return new ProviderError({
    provider,
    capability: "chat",
    code,
    message
  });
}

describe("provider-neutral chat streaming", () => {
  it("emits ordered deltas and one completed output for native streaming", async () => {
    const provider = createMockStreamingChatProvider("native", {
      chunks: ["hel", "lo"],
      output: { model: "native-model", tokenUsage: { totalTokens: 7 } }
    });
    const events = await collect(provider.streamReply!(input));

    expect(events).toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      expect.objectContaining({
        type: "completed",
        output: expect.objectContaining({
          message: { role: "assistant", content: "hello" },
          model: "native-model",
          tokenUsage: { totalTokens: 7 }
        })
      })
    ]);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(getChatStreamingMode(provider)).toBe("native");

    const registry = new ProviderRegistry(
      createProviderRegistryConfigFromEnv({
        NODE_ENV: "test",
        DEFAULT_CHAT_PROVIDER: "native",
        CHAT_PROVIDER_CHAIN: "native"
      })
    );
    registry.registerChatProvider(provider);
    expect(registry.getChatStreamingMode()).toBe("native");
  });

  it("adapts a legacy non-streaming provider without mislabeling its capability", async () => {
    const legacy = createMockChatProvider("legacy");
    const chain = new FallbackChatProvider([legacy]);
    const events = await collect(chain.streamReply(input));

    expect(events[0]).toMatchObject({ type: "text-delta" });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: expect.objectContaining({
        finalProvider: "legacy",
        fallbackUsed: false
      })
    });
    expect(getChatStreamingMode(legacy)).toBe("compatible");
    expect(chain.streamingMode).toBe("compatible");

    const unsupported: ChatProvider = {
      ...legacy,
      name: "unsupported",
      streamingMode: "unsupported"
    };
    expect(getChatStreamingMode(unsupported)).toBe("unsupported");
  });

  it("forwards the exact ProviderCallOptions through the compatible adapter", async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    let receivedOptions: ProviderCallOptions | undefined;
    const legacy: ChatProvider = {
      name: "legacy-options",
      healthCheck: async () => ({
        provider: "legacy-options",
        status: "healthy",
        checkedAt: new Date().toISOString()
      }),
      async generateReply(_input, received) {
        receivedOptions = received;
        return { message: { role: "assistant", content: "legacy reply" } };
      }
    };

    const events = await collect(new FallbackChatProvider([legacy]).streamReply(input, options));

    expect(receivedOptions).toBe(options);
    expect(receivedOptions?.signal).toBe(controller.signal);
    expect(events[0]).toEqual({ type: "text-delta", text: "legacy reply" });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: { message: { role: "assistant", content: "legacy reply" } }
    });
  });

  it("falls back before the first delta and exposes only the successful provider stream", async () => {
    const primary = createMockStreamingChatProvider("primary", {
      failBeforeFirst: new ProviderError({
        provider: "primary",
        capability: "chat",
        code: ProviderErrorCode.ProviderUnavailable,
        message: "provider unavailable before transport dispatch",
        effectState: "not_started"
      })
    });
    const backup = createMockStreamingChatProvider("backup", {
      chunks: ["backup ", "reply"],
      output: { model: "backup-model", tokenUsage: { totalTokens: 11 } }
    });
    const events = await collect(new FallbackChatProvider([primary, backup]).streamReply(input));
    const deltas = events.filter((event) => event.type === "text-delta").map((event) => event.text);
    const completed = events.find((event) => event.type === "completed");

    expect(deltas).toEqual(["backup ", "reply"]);
    expect(completed?.type).toBe("completed");
    if (completed?.type === "completed") {
      expect(completed.output.message.content).toBe("backup reply");
      expect(completed.output.model).toBe("backup-model");
      expect(completed.output.finalProvider).toBe("backup");
      expect(completed.output.fallbackUsed).toBe(true);
      expect(
        completed.output.attemptedProviders?.map((attempt) => [attempt.provider, attempt.status])
      ).toEqual([
        ["primary", "unavailable"],
        ["backup", "success"]
      ]);
    }
  });

  it("does not fall back after partial output", async () => {
    const primary = createMockStreamingChatProvider("primary", {
      chunks: ["partial", " output"],
      failAfterChunks: 1,
      failAfter: providerError("primary", ProviderErrorCode.NetworkError)
    });
    const backupStream = vi.fn(async function* (): AsyncIterable<ChatStreamEvent> {
      yield { type: "text-delta", text: "backup" };
    });
    const backup: ChatProvider = {
      name: "backup",
      healthCheck: async () => ({
        provider: "backup",
        status: "healthy",
        checkedAt: new Date().toISOString()
      }),
      generateReply: async () => ({ message: { role: "assistant", content: "backup" } }),
      streamReply: backupStream
    };
    const events: ChatStreamEvent[] = [];
    const stream = new FallbackChatProvider([primary, backup]).streamReply(input);

    await expect(
      (async () => {
        for await (const event of stream) {
          events.push(event);
        }
      })()
    ).rejects.toMatchObject({
      provider: "primary",
      code: ProviderErrorCode.NetworkError
    });
    expect(events).toEqual([{ type: "text-delta", text: "partial" }]);
    expect(backupStream).not.toHaveBeenCalled();
  });

  it("stops on cancellation and does not try a backup provider", async () => {
    const controller = new AbortController();
    const primary = createMockStreamingChatProvider("primary", {
      chunks: ["first", "second"],
      delayMs: 5
    });
    const backup = createMockStreamingChatProvider("backup", { chunks: ["backup"] });
    const events: ChatStreamEvent[] = [];
    const stream = new FallbackChatProvider([primary, backup]).streamReply(input, {
      signal: controller.signal
    });

    await expect(
      (async () => {
        for await (const event of stream) {
          events.push(event);
          if (event.type === "text-delta") {
            controller.abort();
          }
        }
      })()
    ).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(events).toEqual([{ type: "text-delta", text: "first" }]);
  });

  it("closes the native iterator when cancellation interrupts consumption", async () => {
    const controller = new AbortController();
    const tracked = trackedStream([
      { type: "text-delta", text: "first" },
      { type: "text-delta", text: "second" },
      { type: "completed", output: { message: { role: "assistant", content: "firstsecond" } } }
    ]);
    const provider: ChatProvider = {
      name: "tracked",
      healthCheck: async () => ({
        provider: "tracked",
        status: "healthy",
        checkedAt: new Date().toISOString()
      }),
      generateReply: async () => ({ message: { role: "assistant", content: "tracked" } }),
      streamReply: () => tracked.iterable
    };

    await expect(
      (async () => {
        for await (const event of new FallbackChatProvider([provider]).streamReply(input, {
          signal: controller.signal
        })) {
          if (event.type === "text-delta") {
            controller.abort();
          }
        }
      })()
    ).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(tracked.returnSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the native iterator when validation fails", async () => {
    const tracked = trackedStream([{ type: "text-delta", text: "" }]);
    const provider: ChatProvider = {
      name: "tracked-invalid",
      healthCheck: async () => ({
        provider: "tracked-invalid",
        status: "healthy",
        checkedAt: new Date().toISOString()
      }),
      generateReply: async () => ({ message: { role: "assistant", content: "tracked" } }),
      streamReply: () => tracked.iterable
    };

    await expect(
      collect(new FallbackChatProvider([provider]).streamReply(input))
    ).rejects.toMatchObject({ code: ProviderErrorCode.MalformedResponse });
    expect(tracked.returnSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the native iterator when the consumer ends early", async () => {
    const tracked = trackedStream([
      { type: "text-delta", text: "first" },
      { type: "text-delta", text: "second" }
    ]);
    const provider: ChatProvider = {
      name: "tracked-early-close",
      healthCheck: async () => ({
        provider: "tracked-early-close",
        status: "healthy",
        checkedAt: new Date().toISOString()
      }),
      generateReply: async () => ({ message: { role: "assistant", content: "tracked" } }),
      streamReply: () => tracked.iterable
    };
    const iterator = new FallbackChatProvider([provider])
      .streamReply(input)
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text-delta", text: "first" }
    });
    await iterator.return?.();
    expect(tracked.returnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fall back after visible output even when the error is fallback-eligible", async () => {
    const backup = vi.fn(async function* (): AsyncIterable<ChatStreamEvent> {
      yield { type: "text-delta", text: "backup" };
    });
    await expect(
      collect(
        new FallbackChatProvider([
          createMockStreamingChatProvider("primary", {
            chunks: ["seen", " later"],
            failAfterChunks: 1,
            failAfter: providerError("primary", ProviderErrorCode.InvalidApiKey)
          }),
          {
            name: "backup",
            healthCheck: async () => ({
              provider: "backup",
              status: "healthy",
              checkedAt: new Date().toISOString()
            }),
            generateReply: async () => ({ message: { role: "assistant", content: "backup" } }),
            streamReply: backup
          }
        ]).streamReply(input)
      )
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidApiKey,
      effectState: "committed"
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it("preserves the existing chain policy for non-retryable pre-first errors", async () => {
    const primary = createMockStreamingChatProvider("primary", {
      failBeforeFirst: providerError("primary", ProviderErrorCode.InvalidApiKey)
    });
    const backup = createMockStreamingChatProvider("backup", { chunks: ["ok"] });
    const events = await collect(new FallbackChatProvider([primary, backup]).streamReply(input));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: expect.objectContaining({ finalProvider: "backup" })
    });
  });

  it("returns safe attempted-provider diagnostics when every provider fails", async () => {
    const primary = createMockStreamingChatProvider("primary", {
      failBeforeFirst: providerError(
        "primary",
        ProviderErrorCode.ProviderUnavailable,
        "Bearer sk-primary-secret"
      )
    });
    const backup = createMockStreamingChatProvider("backup", {
      failBeforeFirst: providerError("backup", ProviderErrorCode.Timeout, "token=backup-secret")
    });

    let error: unknown;
    try {
      await collect(new FallbackChatProvider([primary, backup]).streamReply(input));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: ProviderErrorCode.Timeout,
      attemptedProviders: expect.arrayContaining([
        expect.objectContaining({ provider: "primary", status: "unavailable" }),
        expect.objectContaining({ provider: "backup", status: "failed" })
      ])
    });
    expect(JSON.stringify(error)).not.toContain("sk-primary-secret");
    expect(JSON.stringify(error)).not.toContain("backup-secret");
  });

  it.each([
    {
      name: "empty delta",
      events: [{ type: "text-delta", text: "" }]
    },
    {
      name: "mismatched completion",
      events: [
        { type: "text-delta", text: "a" },
        { type: "completed", output: { message: { role: "assistant", content: "b" } } }
      ]
    },
    {
      name: "multiple completed events",
      events: [
        { type: "completed", output: { message: { role: "assistant", content: "" } } },
        { type: "completed", output: { message: { role: "assistant", content: "" } } }
      ]
    },
    {
      name: "delta after completed",
      events: [
        { type: "completed", output: { message: { role: "assistant", content: "" } } },
        { type: "text-delta", text: "late" }
      ]
    }
  ])("rejects protocol violation: $name", async ({ events }) => {
    const provider: ChatProvider = {
      name: "invalid",
      healthCheck: async () => ({
        provider: "invalid",
        status: "healthy",
        checkedAt: new Date().toISOString()
      }),
      generateReply: async () => ({ message: { role: "assistant", content: "" } }),
      async *streamReply() {
        for (const event of events) {
          yield event as ChatStreamEvent;
        }
      }
    };

    await expect(
      collect(new FallbackChatProvider([provider]).streamReply(input))
    ).rejects.toMatchObject({ code: ProviderErrorCode.MalformedResponse });
  });
});
