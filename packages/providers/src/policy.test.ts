import { describe, expect, it, vi } from "vitest";
import {
  DeepSeekReasoningProvider,
  FallbackChatProvider,
  ProviderError,
  ProviderErrorCode,
  canFallbackProviderError,
  createMockStreamingChatProvider,
  createProviderRegistryFromEnv,
  isProviderReplaySafe,
  isSafeToReplay,
  mapHttpStatusToProviderErrorCode,
  normalizeProviderError,
  resolveProviderErrorPolicy,
  type ChatInput,
  type ChatOutput,
  type ChatProvider,
  type ChatStreamEvent,
  type ProviderErrorOptions,
  type ProviderHealth
} from "./index.js";

const input: ChatInput = { messages: [{ role: "user", content: "hello" }] };

function health(provider: string): Promise<ProviderHealth> {
  return Promise.resolve({
    provider,
    status: "healthy",
    checkedAt: new Date().toISOString()
  });
}

function providerError(
  provider: string,
  code: ProviderErrorCode,
  overrides: Partial<
    Omit<ProviderErrorOptions, "provider" | "capability" | "code" | "message">
  > = {}
): ProviderError {
  return new ProviderError({
    provider,
    capability: "chat",
    code,
    message: `${provider} ${code}`,
    ...overrides
  });
}

function ok(content: string): ChatOutput {
  return { message: { role: "assistant", content } };
}

function chatLeaf(
  name: string,
  generateReply: () => Promise<ChatOutput>,
  streamReply?: ChatProvider["streamReply"]
): ChatProvider {
  return {
    name,
    healthCheck: () => health(name),
    generateReply,
    ...(streamReply ? { streamReply, streamingMode: "native" as const } : {})
  };
}

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("provider error policy defaults", () => {
  it("keeps retryable and fallbackEligible independent", () => {
    const invalid = new ProviderError({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.InvalidApiKey,
      message: "bad key"
    });
    expect(invalid.retryable).toBe(false);
    expect(invalid.fallbackEligible).toBe(true);
    expect(invalid.effectState).toBe("not_started");

    const invalidHttp = new ProviderError({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.InvalidApiKey,
      message: "401",
      statusCode: 401
    });
    expect(invalidHttp.retryable).toBe(false);
    expect(invalidHttp.fallbackEligible).toBe(true);
    expect(invalidHttp.effectState).toBe("unknown");

    const rateLimited = new ProviderError({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.RateLimited,
      message: "slow down"
    });
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.fallbackEligible).toBe(true);
    expect(rateLimited.effectState).toBe("unknown");

    const cancelled = new ProviderError({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.Cancelled,
      message: "stop"
    });
    expect(cancelled.retryable).toBe(false);
    expect(cancelled.fallbackEligible).toBe(false);

    const forced = new ProviderError({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.RateLimited,
      message: "retryable but do not hop",
      retryable: true,
      fallbackEligible: false
    });
    expect(forced.retryable).toBe(true);
    expect(forced.fallbackEligible).toBe(false);
    expect(canFallbackProviderError(forced, { anotherProviderExists: true })).toBe(false);
  });

  it("permits replay only when dispatch is proven not to have started", () => {
    expect(isProviderReplaySafe("not_started")).toBe(true);
    expect(isProviderReplaySafe("unknown")).toBe(false);
    expect(isProviderReplaySafe("committed")).toBe(false);

    const unknown = new ProviderError({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.Timeout,
      message: "response was lost",
      effectState: "unknown"
    });
    expect(isSafeToReplay(unknown)).toBe(false);

    const committed = new ProviderError({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.NetworkError,
      message: "after visible output",
      effectState: "committed"
    });
    expect(isSafeToReplay(committed)).toBe(false);
    expect(committed.effectState).toBe("committed");
    expect(JSON.stringify(committed)).not.toContain("safeToReplay");
  });

  it("serializes a safe error summary without internal policy fields", () => {
    const error = new ProviderError({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.RateLimited,
      message: "limited",
      fallbackEligible: true,
      effectState: "unknown",
      attemptedProviders: [{ provider: "primary", status: "failed" }],
      cause: new Error("secret-cause")
    });
    expect(error.toJSON()).toEqual({
      name: "ProviderError",
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.RateLimited,
      retryable: true,
      statusCode: undefined,
      message: "primary chat failed (RATE_LIMITED)."
    });
    expect(JSON.stringify(error)).not.toContain("fallbackEligible");
    expect(JSON.stringify(error)).not.toContain("effectState");
    expect(JSON.stringify(error)).not.toContain("safeToReplay");
    expect(JSON.stringify(error)).not.toContain("secret-cause");
    expect(JSON.stringify(error)).not.toContain("attemptedProviders");
  });

  it("maps HTTP status codes through the shared contract", () => {
    expect(mapHttpStatusToProviderErrorCode(400)).toBe(ProviderErrorCode.UnsupportedInput);
    expect(mapHttpStatusToProviderErrorCode(401)).toBe(ProviderErrorCode.InvalidApiKey);
    expect(mapHttpStatusToProviderErrorCode(403)).toBe(ProviderErrorCode.PermissionDenied);
    expect(mapHttpStatusToProviderErrorCode(404)).toBe(ProviderErrorCode.ModelNotFound);
    expect(mapHttpStatusToProviderErrorCode(408)).toBe(ProviderErrorCode.Timeout);
    expect(mapHttpStatusToProviderErrorCode(409)).toBe(ProviderErrorCode.ProviderUnavailable);
    expect(mapHttpStatusToProviderErrorCode(413)).toBe(ProviderErrorCode.UnsupportedInput);
    expect(mapHttpStatusToProviderErrorCode(415)).toBe(ProviderErrorCode.UnsupportedInput);
    expect(mapHttpStatusToProviderErrorCode(429)).toBe(ProviderErrorCode.RateLimited);
    expect(mapHttpStatusToProviderErrorCode(500)).toBe(ProviderErrorCode.ProviderUnavailable);
    expect(mapHttpStatusToProviderErrorCode(418)).toBe(ProviderErrorCode.ProviderUnavailable);
  });

  it("normalizes unknown errors as non-retryable unavailable", () => {
    const error = normalizeProviderError(new Error("secret-ish implementation failure"), {
      provider: "primary",
      capability: "chat"
    });
    expect(error).toMatchObject({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.ProviderUnavailable,
      retryable: false,
      fallbackEligible: true,
      effectState: "unknown"
    });
    expect(error.message).not.toContain("secret-ish");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("defaults local vs remote provider unavailable separately", () => {
    const local = resolveProviderErrorPolicy({ code: ProviderErrorCode.ProviderUnavailable });
    expect(local).toEqual({
      retryable: false,
      fallbackEligible: true,
      effectState: "not_started"
    });
    const remote = resolveProviderErrorPolicy({
      code: ProviderErrorCode.ProviderUnavailable,
      statusCode: 503
    });
    expect(remote).toEqual({
      retryable: true,
      fallbackEligible: true,
      effectState: "unknown"
    });
  });
});

describe("non-stream provider chain policy", () => {
  it("falls back only when InvalidApiKey is explicitly known to precede dispatch", async () => {
    const primary = vi.fn(async () => {
      throw providerError("primary", ProviderErrorCode.InvalidApiKey);
    });
    const backup = vi.fn(async (): Promise<ChatOutput> => {
      return { ...ok("backup"), model: "backup-model" };
    });
    const output = await new FallbackChatProvider([
      chatLeaf("primary", primary),
      chatLeaf("backup", backup)
    ]).generateReply(input);

    expect(primary).toHaveBeenCalledTimes(1);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(output.fallbackUsed).toBe(true);
    expect(output.finalProvider).toBe("backup");
    expect(output.attemptedProviders?.map((attempt) => attempt.provider)).toEqual([
      "primary",
      "backup"
    ]);
  });

  it("anchors fallbackUsed to the first chain identity, not error attribution", async () => {
    const output = await new FallbackChatProvider([
      chatLeaf("primary-route", async () => {
        throw new ProviderError({
          provider: "backup",
          capability: "chat",
          code: ProviderErrorCode.InvalidApiKey,
          message: "misattributed"
        });
      }),
      chatLeaf("backup", async () => ok("backup"))
    ]).generateReply(input);

    expect(output.fallbackUsed).toBe(true);
    expect(output.finalProvider).toBe("backup");
    expect(output.attemptedProviders?.[0]).toMatchObject({
      provider: "backup",
      status: "failed",
      errorCode: ProviderErrorCode.InvalidApiKey
    });
  });

  it("does not mark fallbackUsed when the first attempted provider succeeds", async () => {
    const output = await new FallbackChatProvider([
      chatLeaf("primary", async () => ok("ok")),
      chatLeaf("backup", async () => ok("nope"))
    ]).generateReply(input);
    expect(output.fallbackUsed).toBe(false);
    expect(output.finalProvider).toBe("primary");
  });

  it("stops on Cancelled and does not invoke a backup", async () => {
    const backup = vi.fn(async () => ok("backup"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.Cancelled);
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      provider: "primary",
      fallbackEligible: false
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it("suppresses a late successful result after the caller aborts in flight", async () => {
    const controller = new AbortController();
    let releasePrimary!: (value: ChatOutput) => void;
    let markStarted!: () => void;
    const primaryStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const primaryWork = new Promise<ChatOutput>((resolve) => {
      releasePrimary = resolve;
    });
    const primary = vi.fn(async () => {
      markStarted();
      return primaryWork;
    });
    const backup = vi.fn(async () => ok("backup"));
    const pending = new FallbackChatProvider([
      chatLeaf("primary", primary),
      chatLeaf("backup", backup)
    ]).generateReply(input, { signal: controller.signal });

    await primaryStarted;
    controller.abort();
    releasePrimary(ok("too late"));

    await expect(pending).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      retryable: false,
      fallbackEligible: false,
      effectState: "unknown",
      provider: "primary"
    });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(backup).not.toHaveBeenCalled();
  });

  it("throws Cancelled with zero provider I/O when the caller signal is already aborted", async () => {
    const primary = vi.fn(async () => ok("primary"));
    const backup = vi.fn(async () => ok("backup"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", primary),
        chatLeaf("backup", backup)
      ]).generateReply(input, { signal: controller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      provider: "primary",
      effectState: "not_started"
    });
    expect(primary).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });

  it("does not start the next provider when the caller aborts after a fallback-eligible failure", async () => {
    const controller = new AbortController();
    const backup = vi.fn(async () => ok("backup"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          controller.abort();
          throw providerError("primary", ProviderErrorCode.RateLimited);
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input, { signal: controller.signal })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Cancelled,
      fallbackEligible: false
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it("does not hop to another provider for RateLimited UNKNOWN", async () => {
    const primary = vi.fn(async () => {
      throw providerError("primary", ProviderErrorCode.RateLimited);
    });
    const backup = vi.fn(async () => ok("backup"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", primary),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({
      provider: "primary",
      code: ProviderErrorCode.RateLimited,
      effectState: "unknown"
    });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(backup).not.toHaveBeenCalled();
  });

  it("does not switch providers when retryable is true but fallbackEligible is false", async () => {
    const backup = vi.fn(async () => ok("backup"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.RateLimited, {
            retryable: true,
            fallbackEligible: false
          });
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({
      provider: "primary",
      code: ProviderErrorCode.RateLimited,
      retryable: true,
      fallbackEligible: false
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it("does not fall back for malformed responses with UNKNOWN effect state", async () => {
    const backup = vi.fn(async (): Promise<ChatOutput> => ok("unused"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.MalformedResponse);
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      effectState: "unknown"
    });
    expect(backup).not.toHaveBeenCalled();
    const sample = new ProviderError({
      provider: "primary",
      capability: "chat",
      code: ProviderErrorCode.MalformedResponse,
      message: "bad json"
    });
    expect(sample.retryable).toBe(false);
    expect(sample.fallbackEligible).toBe(true);
    expect(sample.effectState).toBe("unknown");
  });

  it("stops the chain for local UnsupportedInput", async () => {
    const backup = vi.fn(async () => ok("backup"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.UnsupportedInput);
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({
      provider: "primary",
      code: ProviderErrorCode.UnsupportedInput,
      retryable: false,
      fallbackEligible: false,
      effectState: "not_started"
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it("does not fall back for an HTTP rejection without certified no-effect evidence", async () => {
    const backup = vi.fn(async (): Promise<ChatOutput> => ok("unused"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.UnsupportedInput, { statusCode: 400 });
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({
      code: ProviderErrorCode.UnsupportedInput,
      effectState: "unknown"
    });
    expect(backup).not.toHaveBeenCalled();
    const sample = providerError("primary", ProviderErrorCode.UnsupportedInput, {
      statusCode: 413
    });
    expect(sample.fallbackEligible).toBe(true);
    expect(sample.effectState).toBe("unknown");
  });

  it("attributes failure to the last provider only after a proven pre-dispatch fallback", async () => {
    let error: unknown;
    try {
      await new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.ProviderUnavailable, {
            effectState: "not_started"
          });
        }),
        chatLeaf("backup", async () => {
          throw providerError("backup", ProviderErrorCode.Timeout, { statusCode: 408 });
        })
      ]).generateReply(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: "backup",
      capability: "chat",
      code: ProviderErrorCode.Timeout,
      retryable: true,
      fallbackEligible: true,
      effectState: "unknown",
      statusCode: 408
    });
    const terminal = error as ProviderError;
    expect(
      terminal.attemptedProviders?.map((attempt) => [attempt.provider, attempt.status])
    ).toEqual([
      ["primary", "unavailable"],
      ["backup", "failed"]
    ]);
    expect(JSON.stringify(terminal)).not.toContain("fallbackUsed");
  });

  it("does not invoke another provider when the first failure is UNKNOWN", async () => {
    const backup = vi.fn(async () => ok("unused"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.NetworkError);
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({
      provider: "primary",
      attemptedProviders: [expect.objectContaining({ provider: "primary" })]
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it("requires explicit no-dispatch certainty even when fallbackEligible is true", async () => {
    const backup = vi.fn(async () => ok("unused"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.ProviderUnavailable, {
            fallbackEligible: true,
            effectState: "unknown"
          });
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({ effectState: "unknown", fallbackEligible: true });
    expect(backup).not.toHaveBeenCalled();
  });

  it("preserves one fallback after a definite pre-dispatch failure", async () => {
    const backup = vi.fn(async () => ok("backup"));
    const result = await new FallbackChatProvider([
      chatLeaf("primary", async () => {
        throw providerError("primary", ProviderErrorCode.ProviderUnavailable, {
          fallbackEligible: true,
          effectState: "not_started"
        });
      }),
      chatLeaf("backup", backup)
    ]).generateReply(input);
    expect(result.finalProvider).toBe("backup");
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a backup after remote timeout even if fallback is requested", async () => {
    const backup = vi.fn(async () => ok("unused"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.Timeout, {
            fallbackEligible: true,
            effectState: "unknown"
          });
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({ effectState: "unknown" });
    expect(backup).not.toHaveBeenCalled();
  });

  it("does not fabricate fallbackUsed on total failure", async () => {
    const backup = vi.fn(async () => {
      throw providerError("backup", ProviderErrorCode.ProviderUnavailable, { statusCode: 503 });
    });
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw providerError("primary", ProviderErrorCode.ProviderUnavailable, {
            effectState: "not_started"
          });
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({
      provider: "backup",
      attemptedProviders: [
        expect.objectContaining({ provider: "primary" }),
        expect.objectContaining({ provider: "backup" })
      ]
    });
  });

  it("keeps unknown leaf failures from invoking a fallback provider", async () => {
    const backup = vi.fn(async () => ok("ok"));
    await expect(
      new FallbackChatProvider([
        chatLeaf("primary", async () => {
          throw new Error("secret-ish implementation failure");
        }),
        chatLeaf("backup", backup)
      ]).generateReply(input)
    ).rejects.toMatchObject({
      provider: "primary",
      code: ProviderErrorCode.ProviderUnavailable,
      effectState: "unknown"
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it("keeps local placeholder unavailable fallback-eligible and not retryable", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "false",
      CHAT_PROVIDER_CHAIN: "deepseek"
    });
    await expect(registry.getChatProvider().generateReply(input)).rejects.toMatchObject({
      provider: "deepseek",
      code: ProviderErrorCode.ProviderUnavailable,
      retryable: false,
      fallbackEligible: true,
      effectState: "not_started"
    });
  });

  it("does not consult route fallbackEligible when switching", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat"
    });
    const route = registry.getStatus().routes?.chat[0];
    expect(route).toMatchObject({
      provider: "deepseek",
      fallbackEligible: true,
      readiness: "ready",
      available: true
    });
  });
});

describe("stream provider chain policy", () => {
  it("anchors stream fallbackUsed to the first chain identity, not error attribution", async () => {
    const events = await collect(
      new FallbackChatProvider([
        createMockStreamingChatProvider("primary-route", {
          failBeforeFirst: new ProviderError({
            provider: "backup",
            capability: "chat",
            code: ProviderErrorCode.InvalidApiKey,
            message: "misattributed"
          })
        }),
        createMockStreamingChatProvider("backup", { chunks: ["ok"] })
      ]).streamReply(input)
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: expect.objectContaining({
        finalProvider: "backup",
        fallbackUsed: true,
        attemptedProviders: [
          expect.objectContaining({
            provider: "backup",
            status: "failed",
            errorCode: ProviderErrorCode.InvalidApiKey
          }),
          expect.objectContaining({ provider: "backup", status: "success" })
        ]
      })
    });
  });

  it("allows fallback only for an explicit pre-dispatch provider failure", async () => {
    const events = await collect(
      new FallbackChatProvider([
        createMockStreamingChatProvider("primary", {
          failBeforeFirst: providerError("primary", ProviderErrorCode.InvalidApiKey)
        }),
        createMockStreamingChatProvider("backup", { chunks: ["ok"] })
      ]).streamReply(input)
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      output: expect.objectContaining({
        finalProvider: "backup",
        fallbackUsed: true
      })
    });
  });

  it("does not fall back on rate-limit or malformed-response UNKNOWN", async () => {
    const rateLimitedBackup = vi.fn(async function* (): AsyncIterable<ChatStreamEvent> {
      yield { type: "text-delta", text: "backup" };
    });
    await expect(
      collect(
        new FallbackChatProvider([
          createMockStreamingChatProvider("primary", {
            failBeforeFirst: providerError("primary", ProviderErrorCode.RateLimited)
          }),
          {
            ...createMockStreamingChatProvider("backup", { chunks: ["ok"] }),
            streamReply: rateLimitedBackup
          }
        ]).streamReply(input)
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.RateLimited, effectState: "unknown" });
    expect(rateLimitedBackup).not.toHaveBeenCalled();

    const malformedBackup = vi.fn(async function* (): AsyncIterable<ChatStreamEvent> {
      yield { type: "text-delta", text: "backup" };
    });
    await expect(
      collect(
        new FallbackChatProvider([
          createMockStreamingChatProvider("primary", {
            failBeforeFirst: providerError("primary", ProviderErrorCode.MalformedResponse)
          }),
          {
            ...createMockStreamingChatProvider("backup", { chunks: ["ok"] }),
            streamReply: malformedBackup
          }
        ]).streamReply(input)
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.MalformedResponse, effectState: "unknown" });
    expect(malformedBackup).not.toHaveBeenCalled();
  });

  it("treats visible output as a committed effect and does not fall back", async () => {
    const backup = vi.fn(async function* (): AsyncIterable<ChatStreamEvent> {
      yield { type: "text-delta", text: "backup" };
    });
    const events: ChatStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of new FallbackChatProvider([
          createMockStreamingChatProvider("primary", {
            chunks: ["partial", " more"],
            failAfterChunks: 1,
            failAfter: providerError("primary", ProviderErrorCode.NetworkError)
          }),
          {
            name: "backup",
            healthCheck: () => health("backup"),
            generateReply: async () => ({ message: { role: "assistant", content: "backup" } }),
            streamReply: backup
          }
        ]).streamReply(input)) {
          events.push(event);
        }
      })()
    ).rejects.toMatchObject({
      provider: "primary",
      code: ProviderErrorCode.NetworkError,
      effectState: "committed"
    });
    expect(
      isSafeToReplay(
        new ProviderError({
          provider: "primary",
          capability: "chat",
          code: ProviderErrorCode.NetworkError,
          message: "after delta",
          effectState: "committed"
        })
      )
    ).toBe(false);
    expect(events).toEqual([{ type: "text-delta", text: "partial" }]);
    expect(backup).not.toHaveBeenCalled();
  });
});

describe("reasoning legacy stream flag", () => {
  it("forces generateReasoning to request a non-stream JSON body", async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: "deepseek-reasoner",
            choices: [{ finish_reason: "stop", message: { content: "answer" } }]
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await new DeepSeekReasoningProvider({
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-reasoner"
      }).generateReasoning({
        messages: [{ role: "user", content: "think" }],
        stream: true
      });
      const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(body.stream).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
