import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeepSeekReasoningProvider,
  ProviderError,
  ProviderErrorCode,
  createMockChatProvider,
  createProviderRegistryFromEnv
} from "./index.js";

const DEEPINFRA_GLM_COGNITION_MODEL = "zai-org/GLM-5.3-Flash";

describe("ProviderRegistry", () => {
  it("keeps local speech and acoustic profiles separate from the local chat endpoint", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? { ok: true, service: "yuvi-local-stt" }
              : url.endsWith("/speakers")
                ? { speakers: [{ speakerId: "acoustic-1", label: "Voice", embedding: [0.1] }] }
                : {
                    text: "hello",
                    segments: [
                      {
                        speaker: "cluster-1",
                        text: "hello",
                        voiceProfileMatch: { status: "MATCHED", voiceProfileId: "acoustic-1" }
                      }
                    ]
                  }
          ),
          { headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "true",
      STT_PROVIDER_CHAIN: "local",
      DEFAULT_STT_PROVIDER: "local",
      LOCAL_MODEL_BASEURL: "http://127.0.0.1:8088/v1",
      LOCAL_CHAT_MODEL: "existing-chat",
      LOCAL_STT_BASE_URL: "http://127.0.0.1:9876",
      LOCAL_STT_MODEL: "sensevoice"
    });
    expect(registry.getStatus().providers.stt.baseUrl).toBe("http://127.0.0.1:9876");
    const provider = registry.getSTTProvider();
    expect(await provider.healthCheck()).toMatchObject({ status: "healthy" });
    expect(await provider.voiceProfiles!.list()).toEqual([
      { voiceProfileId: "acoustic-1", label: "Voice" }
    ]);
    expect(await provider.transcribeAudio({ audioBase64: "AAAA" })).toMatchObject({
      segments: [
        {
          text: "hello",
          speakerClusterId: "cluster-1",
          voiceProfileMatch: { voiceProfileId: "acoustic-1" }
        }
      ]
    });
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith("http://127.0.0.1:9876/"))).toBe(
      true
    );
  });

  it("rejects a successful HTTP response from an unrelated STT endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    );
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "true",
      STT_PROVIDER_CHAIN: "local",
      DEFAULT_STT_PROVIDER: "local",
      LOCAL_STT_BASE_URL: "http://localhost:9876",
      LOCAL_STT_MODEL: "sensevoice"
    });
    expect(await registry.getSTTProvider().healthCheck()).toMatchObject({ status: "unavailable" });
    expect(registry.getStatus().providers.stt.readiness).toBe("ready");
  });
  it("does not infer a speech endpoint or TTS voice from other local capabilities", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_STT_PROVIDER: "local",
      STT_PROVIDER_CHAIN: "local",
      DEFAULT_TTS_PROVIDER: "local",
      TTS_PROVIDER_CHAIN: "local",
      LOCAL_MODEL_BASEURL: "http://127.0.0.1:8088/v1",
      LOCAL_CHAT_MODEL: "existing-chat",
      LOCAL_STT_MODEL: "sensevoice"
    });
    expect(registry.getStatus().providers.stt.missingFields).toContain("LOCAL_STT_BASE_URL");
    expect(registry.getStatus().providers.tts).toMatchObject({ readiness: "not_ready" });
    expect(registry.getStatus().providers.tts.model).toBeUndefined();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initializes mock providers without real API keys", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "true",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEFAULT_TTS_PROVIDER: "xai",
      DEFAULT_STT_PROVIDER: "dashscope",
      DEFAULT_VISION_PROVIDER: "xai",
      DEFAULT_EMBEDDING_PROVIDER: "mock",
      EMBEDDING_DIMENSIONS: "1024"
    });

    const chat = registry.getChatProvider();
    const reply = await chat.generateReply({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(reply.message.content).toContain("Mock reply");
    const embedding = await registry.getEmbeddingProvider().embedText("hello");
    expect(embedding.length).toBe(1024);
    await expect(registry.getEmbeddingProvider().embedText("hello")).resolves.toEqual(embedding);

    const status = registry.getStatus();
    expect(status.providers.chat).toMatchObject({
      provider: "deepseek",
      capability: "chat",
      configured: false,
      readiness: "not_ready",
      available: false,
      mock: false,
      required: true
    });
    expect(status.routes?.chat.at(-1)).toMatchObject({
      provider: "mock",
      readiness: "ready",
      available: true,
      mock: true
    });
    expect(JSON.stringify(status)).not.toContain("test_deepseek_secret");
  });

  it("uses real-provider-first behavior unless mock fallback is explicitly allowed", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek"
    });

    const status = registry.getStatus();
    expect(status.providers.chat).toMatchObject({
      provider: "deepseek",
      capability: "chat",
      configured: false,
      available: false,
      mock: false,
      required: true,
      status: "unavailable"
    });
    expect(status.providers.embedding).toMatchObject({
      provider: "openai-compatible",
      capability: "embedding",
      configured: false,
      available: false,
      mock: false,
      status: "unavailable"
    });
    await expect(
      registry.getChatProvider().generateReply({ messages: [{ role: "user", content: "hello" }] })
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      provider: "local",
      capability: "chat",
      retryable: false,
      fallbackEligible: true,
      effectState: "not_started"
    });
  });

  it("reports embedding provider status without leaking secrets", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      DEFAULT_EMBEDDING_PROVIDER: "openai-compatible",
      EMBEDDING_API_KEY: "embedding-secret-key",
      EMBEDDING_API_BASEURL: "https://embedding.example/v1",
      EMBEDDING_MODEL: "text-embedding-test",
      EMBEDDING_DIMENSIONS: "3"
    });

    const status = registry.getStatus().providers.embedding;

    expect(status).toMatchObject({
      provider: "openai-compatible",
      capability: "embedding",
      configured: true,
      available: true,
      mock: false,
      baseUrl: "https://embedding.example/v1",
      model: "text-embedding-test",
      dimensions: 3
    });
    expect(status.semanticEmbedding).toBe(true);
    expect(JSON.stringify(status)).not.toContain("embedding-secret-key");
  });

  it("uses the selected local provider dimension instead of generic or NVIDIA dimensions", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      DEFAULT_EMBEDDING_PROVIDER: "local",
      EMBEDDING_PROVIDER: "local",
      EMBEDDING_PROVIDER_CHAIN: "local",
      EMBEDDING_DIMENSIONS: "1024",
      NVIDIA_EMBEDDING_DIMENSIONS: "256",
      LOCAL_MODEL_BASEURL: "http://127.0.0.1:8128/v1",
      LOCAL_EMBEDDING_MODEL: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      LOCAL_EMBEDDING_DIMENSIONS: "512"
    });

    expect(registry.getEmbeddingProvider()).toMatchObject({
      name: "local",
      model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      dimensions: 512
    });
    expect(registry.getStatus().providers.embedding).toMatchObject({
      provider: "local",
      model: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      dimensions: 512
    });
  });

  it("rejects heterogeneous chains for the Qwen512 durable embedding contract", () => {
    expect(() =>
      createProviderRegistryFromEnv({
        NODE_ENV: "production",
        DEFAULT_EMBEDDING_PROVIDER: "local",
        EMBEDDING_PROVIDER: "local",
        EMBEDDING_PROVIDER_CHAIN: "local,nvidia",
        LOCAL_MODEL_BASEURL: "http://127.0.0.1:8128/v1",
        LOCAL_EMBEDDING_MODEL: "Qwen3-Embedding-0.6B-Q8_0.gguf",
        LOCAL_EMBEDDING_DIMENSIONS: "512"
      })
    ).toThrow(
      "Heterogeneous embedding chains are not supported for this production embedding space."
    );
  });

  it("registers the generic OpenAI-compatible Chat provider without exposing its key", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "openai-compatible",
      CHAT_PROVIDER_CHAIN: "openai-compatible",
      OPENAI_COMPATIBLE_API_BASEURL: "https://gateway.example/v1",
      OPENAI_COMPATIBLE_API_KEY: "openai-compatible-secret",
      OPENAI_COMPATIBLE_CHAT_MODEL: "gateway/chat-model"
    });

    const status = registry.getStatus().providers.chat;

    expect(status).toMatchObject({
      provider: "openai-compatible",
      capability: "chat",
      configured: true,
      readiness: "ready",
      available: true,
      mock: false,
      required: true,
      baseUrl: "https://gateway.example/v1",
      model: "gateway/chat-model"
    });
    expect(registry.getChatStreamingMode()).toBe("native");
    expect(JSON.stringify(status)).not.toContain("openai-compatible-secret");
  });

  it("binds Chat and Cognition to separate provider-facing model IDs", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        const model = body["model"] === "deepseek-flash" ? "chat answer" : "cognition answer";
        return new Response(
          JSON.stringify({
            model: body["model"],
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: model,
                  reasoning_content: "<think>provider-private-trace</think>"
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "openai-compatible",
      CHAT_PROVIDER_CHAIN: "openai-compatible",
      DEFAULT_REASONING_PROVIDER: "openai-compatible",
      REASONING_PROVIDER_CHAIN: "openai-compatible",
      OPENAI_COMPATIBLE_API_BASEURL: "https://gateway.example/v1",
      OPENAI_COMPATIBLE_API_KEY: "shared-secret",
      OPENAI_COMPATIBLE_CHAT_MODEL: "deepseek-flash",
      OPENAI_COMPATIBLE_REASONING_MODEL: DEEPINFRA_GLM_COGNITION_MODEL
    });

    expect(registry.getChatProvider().name).toBe("openai-compatible");
    expect(registry.getReasoningProvider().name).toBe("openai-compatible");
    const chat = await registry.getChatProvider().generateReply({
      messages: [{ role: "user", content: "hello" }]
    });
    const cognition = await registry.getReasoningProvider().generateReasoning({
      messages: [{ role: "user", content: "decide" }]
    });

    expect(requests.map((request) => request["model"])).toEqual([
      "deepseek-flash",
      DEEPINFRA_GLM_COGNITION_MODEL
    ]);
    expect(chat.message.content).toBe("chat answer");
    expect(cognition.answer).toBe("cognition answer");
    expect(cognition.reasoning).toBe("");
    expect(JSON.stringify(cognition)).not.toContain("<think>");
    expect(JSON.stringify(cognition)).not.toContain("provider-private-trace");
    expect(registry.getStatus().providers.reasoning).toMatchObject({
      provider: "openai-compatible",
      configured: true,
      baseUrl: "https://gateway.example/v1",
      model: DEEPINFRA_GLM_COGNITION_MODEL
    });
    expect(JSON.stringify(registry.getStatus())).not.toContain("shared-secret");
  });

  it("reports missing OpenAI-compatible Cognition configuration", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_REASONING_PROVIDER: "openai-compatible",
      REASONING_PROVIDER_CHAIN: "openai-compatible"
    });

    expect(registry.getStatus().providers.reasoning).toMatchObject({
      provider: "openai-compatible",
      configured: false,
      readiness: "not_ready",
      missingFields: [
        "OPENAI_COMPATIBLE_API_BASEURL",
        "OPENAI_COMPATIBLE_API_KEY",
        "OPENAI_COMPATIBLE_REASONING_MODEL"
      ]
    });
    await expect(
      registry.getReasoningProvider().generateReasoning({
        messages: [{ role: "user", content: "decide" }]
      })
    ).rejects.toMatchObject({
      provider: "openai-compatible",
      capability: "reasoning",
      code: ProviderErrorCode.ProviderUnavailable
    });
  });

  it("reports missing generic OpenAI-compatible Chat configuration as unavailable", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "openai-compatible",
      CHAT_PROVIDER_CHAIN: "openai-compatible"
    });

    expect(registry.getStatus().providers.chat).toMatchObject({
      provider: "openai-compatible",
      configured: false,
      readiness: "not_ready",
      available: false,
      mock: false,
      status: "unavailable",
      missingFields: [
        "OPENAI_COMPATIBLE_API_BASEURL",
        "OPENAI_COMPATIBLE_API_KEY",
        "OPENAI_COMPATIBLE_CHAT_MODEL"
      ]
    });
    await expect(
      registry.getChatProvider().generateReply({ messages: [{ role: "user", content: "hello" }] })
    ).rejects.toMatchObject({
      provider: "openai-compatible",
      capability: "chat",
      code: ProviderErrorCode.ProviderUnavailable
    });
  });

  it("reports configured DeepSeek providers without making health HTTP calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });

    const status = registry.getStatus();
    expect(status.providers.chat).toMatchObject({
      configured: true,
      available: true,
      mock: false,
      required: true,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat"
    });
    expect(status.providers.reasoning).toMatchObject({
      configured: true,
      available: true,
      mock: false,
      required: false,
      model: "deepseek-reasoner"
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain("test-key");
  });

  it("projects all six capabilities with independent local readiness and cached observation", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEFAULT_TTS_PROVIDER: "xai",
      DEFAULT_STT_PROVIDER: "dashscope",
      DEFAULT_VISION_PROVIDER: "xai",
      DEFAULT_EMBEDDING_PROVIDER: "openai-compatible",
      DEEPSEEK_API_KEY: "deepseek-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner",
      XAI_API_KEY: "xai-key",
      XAI_TTS_MODEL: "xai-tts",
      XAI_VISION_MODEL: "xai-vision",
      DASHSCOPE_API_KEY: "dashscope-key",
      DASHSCOPE_STT_MODEL: "dashscope-stt",
      EMBEDDING_API_KEY: "embedding-key",
      EMBEDDING_API_BASEURL: "https://embedding.example/v1",
      EMBEDDING_MODEL: "embedding-model"
    });

    const providers = registry.getStatus().providers;
    for (const capability of ["chat", "reasoning", "embedding", "tts", "stt", "vision"] as const) {
      expect(providers[capability]).toMatchObject({
        readiness: "ready",
        observed: "unknown",
        available: true
      });
      expect(providers[capability].lastVerifiedAt).toBeUndefined();
    }
  });

  it("keeps local readiness separate from unverified remote observation", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat"
    });

    const status = registry.getStatus().providers.chat;

    expect(status).toMatchObject({
      readiness: "ready",
      observed: "unknown",
      configured: true,
      available: true,
      status: "degraded"
    });
    expect(status.lastVerifiedAt).toBeUndefined();
  });

  it("does not make an unconfigured real route mock-ready when mocks are permitted", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "true",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek"
    });

    expect(registry.getStatus().providers.chat).toMatchObject({
      provider: "deepseek",
      configured: false,
      readiness: "not_ready",
      available: false,
      mock: false,
      status: "unavailable"
    });
    expect(registry.getStatus().routes?.chat).toMatchObject([
      expect.objectContaining({
        provider: "deepseek",
        readiness: "not_ready",
        mock: false
      })
    ]);
  });

  it("reports only an explicit mock route as mock-ready", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "true",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek,mock"
    });

    expect(registry.getStatus().routes?.chat).toMatchObject([
      expect.objectContaining({
        provider: "deepseek",
        readiness: "not_ready",
        available: false,
        mock: false
      }),
      expect.objectContaining({
        provider: "mock",
        readiness: "ready",
        available: true,
        mock: true
      })
    ]);

    await expect(
      registry.getChatProvider().generateReply({
        messages: [{ role: "user", content: "hello" }]
      })
    ).resolves.toMatchObject({ finalProvider: "mock" });
  });

  it("does not report a disabled default mock provider as ready", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "mock"
    });
    const status = registry.getStatus();

    expect(status.providers.chat).toMatchObject({
      provider: "mock",
      configured: false,
      mock: false,
      readiness: "not_ready",
      available: false
    });
    expect(status.routes?.chat).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: "mock", readiness: "ready" })])
    );
  });

  it("keeps getStatus zero-I/O and does not mutate cached observation", () => {
    const fetchSpy = vi.fn();
    const healthCheck = vi.fn(async () => {
      throw new Error("healthCheck must not run during status inspection");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat"
    });
    registry.registerChatProvider({
      ...createMockChatProvider("deepseek"),
      healthCheck
    });

    const first = registry.getStatus();
    const second = registry.getStatus();

    expect(first.providers.chat.observed).toBe("unknown");
    expect(second.providers.chat.observed).toBe("unknown");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it("keeps live observations in one registry and resets them on registry reload", () => {
    const config = {
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat"
    };
    const registry = createProviderRegistryFromEnv(config);
    registry.recordLiveVerification({
      capability: "chat",
      provider: "deepseek",
      observed: "unavailable",
      verifiedAt: "2026-08-15T12:00:00.000Z",
      latencyMs: 42,
      errorCode: ProviderErrorCode.ProviderUnavailable,
      error: "Provider verification failed safely."
    });

    expect(registry.getStatus().providers.chat).toMatchObject({
      readiness: "ready",
      observed: "unavailable",
      status: "unavailable",
      lastVerifiedAt: "2026-08-15T12:00:00.000Z",
      latencyMs: 42,
      lastErrorCode: ProviderErrorCode.ProviderUnavailable,
      lastError: "Provider verification failed safely."
    });

    const reloaded = createProviderRegistryFromEnv(config);
    expect(reloaded.getStatus().providers.chat).toMatchObject({
      readiness: "ready",
      observed: "unknown",
      status: "degraded"
    });
    expect(reloaded.getStatus().providers.chat.lastVerifiedAt).toBeUndefined();

    registry.recordLiveVerification({
      capability: "chat",
      provider: "deepseek",
      observed: "available",
      verifiedAt: "2026-08-15T12:01:00.000Z"
    });
    expect(registry.getStatus().providers.chat.observed).toBe("available");
    expect(reloaded.getStatus().providers.chat.observed).toBe("unknown");
  });

  it("normalizes provider errors", () => {
    const error = new ProviderError({
      provider: "deepseek",
      capability: "chat",
      code: ProviderErrorCode.InvalidApiKey,
      message: "bad key",
      statusCode: 401
    });

    expect(error.code).toBe("INVALID_API_KEY");
    expect(error.statusCode).toBe(401);
    expect(error.toJSON()).toMatchObject({
      provider: "deepseek",
      capability: "chat",
      code: "INVALID_API_KEY"
    });
  });

  it("omits raw provider responses unless explicitly enabled", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-test",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "hello from deepseek"
                }
              }
            ],
            usage: {
              prompt_tokens: 2,
              completion_tokens: 3,
              total_tokens: 5
            }
          }),
          { status: 200 }
        )
    );

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DATABASE_URL: "postgres://example",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });

    const reply = await registry.getChatProvider().generateReply({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(reply.debug).toBeUndefined();
  });

  it("can include raw provider responses behind an explicit debug flag", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-test",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "hello from deepseek"
                }
              }
            ]
          }),
          { status: 200 }
        )
    );

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      PROVIDER_INCLUDE_RAW_RESPONSES: "true",
      DATABASE_URL: "postgres://example",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });

    const reply = await registry.getChatProvider().generateReply({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(reply.debug?.rawResponse).toMatchObject({
      model: "deepseek-test"
    });
  });

  it("normalizes provider reasoning_content away from the legacy reasoning field", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-reasoner",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "the safe final answer",
                  reasoning_content: "private provider reasoning trace"
                }
              }
            ]
          }),
          { status: 200 }
        )
    );

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });

    const output = await registry.getReasoningProvider().generateReasoning({
      messages: [{ role: "user", content: "answer this" }]
    });

    expect(output).toMatchObject({
      answer: "the safe final answer",
      reasoning: ""
    });
    expect(JSON.stringify(output)).not.toContain("private provider reasoning trace");
  });

  it("keeps final content when a provider omits reasoning_content", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-reasoner",
            choices: [
              {
                finish_reason: "stop",
                message: { content: "final content without a reasoning trace" }
              }
            ]
          }),
          { status: 200 }
        )
    );

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });

    const output = await registry.getReasoningProvider().generateReasoning({
      messages: [{ role: "user", content: "answer this" }]
    });

    expect(output.answer).toBe("final content without a reasoning trace");
    expect(output.reasoning).toBe("");
  });

  it("normalizes reasoning for the OpenAI-compatible reasoning adapter", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "local-reasoner",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "local final answer",
                  reasoning_content: "local private trace"
                }
              }
            ]
          }),
          { status: 200 }
        )
    );

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_REASONING_PROVIDER: "local",
      REASONING_PROVIDER_CHAIN: "local",
      LOCAL_MODEL_BASEURL: "https://local.example/v1",
      LOCAL_REASONING_MODEL: "local-reasoner"
    });

    const output = await registry.getReasoningProvider().generateReasoning({
      messages: [{ role: "user", content: "answer this" }]
    });

    expect(output).toMatchObject({ answer: "local final answer", reasoning: "" });
    expect(JSON.stringify(output)).not.toContain("local private trace");
  });

  it("rejects a successful reasoning response without a non-empty final answer", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-reasoner",
            choices: [
              {
                finish_reason: "stop",
                message: { content: "", reasoning_content: "private trace" }
              }
            ]
          }),
          { status: 200 }
        )
    );

    await expect(
      new DeepSeekReasoningProvider({
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-reasoner"
      }).generateReasoning({
        messages: [{ role: "user", content: "answer this" }]
      })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.MalformedResponse,
      capability: "reasoning",
      retryable: false
    });
  });

  it("does not fall back after a dispatched primary provider response", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.deepseek.com")) {
        return new Response(JSON.stringify({ error: "bad upstream sk-secret-value" }), {
          status: 500
        });
      }
      return new Response(
        JSON.stringify({
          model: "local-chat",
          choices: [{ finish_reason: "stop", message: { content: "hello from local" } }]
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek,local",
      DEEPSEEK_API_KEY: "deepseek-secret",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      LOCAL_MODEL_BASEURL: "https://local.example/v1",
      LOCAL_CHAT_MODEL: "local-chat"
    });

    await expect(
      registry.getChatProvider().generateReply({
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.toMatchObject({
      code: ProviderErrorCode.ProviderUnavailable,
      effectState: "unknown"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.deepseek.com");
  });

  it("reports local and NVIDIA provider routes without health calls or secret leakage", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      CHAT_PROVIDER_CHAIN: "deepseek,nvidia,local",
      NVIDIA_API_KEY: "nvidia-secret",
      NVIDIA_CHAT_MODEL: "nvidia-chat",
      LOCAL_MODEL_BASEURL: "https://local.example/v1",
      LOCAL_CHAT_MODEL: "local-chat"
    });

    const routes = registry.getStatus().routes?.chat ?? [];

    expect(routes.map((route) => route.provider)).toEqual(["deepseek", "nvidia", "local"]);
    expect(routes.find((route) => route.provider === "nvidia")).toMatchObject({
      configured: true,
      available: true,
      model: "nvidia-chat"
    });
    expect(routes.find((route) => route.provider === "local")).toMatchObject({
      configured: true,
      available: true,
      baseUrl: "https://local.example/v1",
      model: "local-chat"
    });
    expect(JSON.stringify(routes)).not.toContain("nvidia-secret");
  });

  it("configures the local GPT-SoVITS adapter without requiring a generic model URL", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_TTS_PROVIDER: "local",
      TTS_PROVIDER_CHAIN: "local",
      LOCAL_TTS_MODEL: "alice-v4",
      GPT_SOVITS_TTS_BASE_URL: "http://127.0.0.1:9881",
      GPT_SOVITS_TTS_GPT_WEIGHTS: "D:/GPT.ckpt",
      GPT_SOVITS_TTS_SOVITS_WEIGHTS: "D:/SoVITS.pth",
      GPT_SOVITS_TTS_REFERENCE_AUDIO: "D:/reference.wav",
      GPT_SOVITS_TTS_REFERENCE_TEXT: "reference"
    });

    expect(registry.getStatus().providers.tts).toMatchObject({
      provider: "local",
      configured: true,
      baseUrl: "http://127.0.0.1:9881",
      model: "alice-v4"
    });
  });

  it("uses mock STT/TTS/Vision runtime fallback only when explicitly enabled", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "true",
      DEFAULT_STT_PROVIDER: "dashscope",
      DEFAULT_TTS_PROVIDER: "xai",
      DEFAULT_VISION_PROVIDER: "xai",
      STT_PROVIDER_CHAIN: "dashscope,local,mock",
      TTS_PROVIDER_CHAIN: "xai,local,mock",
      VISION_PROVIDER_CHAIN: "xai,nvidia,local,mock"
    });

    const transcript = await registry.getSTTProvider().transcribeAudio({
      metadata: { mockTranscription: "烦死了，这个报错我看不懂" }
    });
    expect(transcript.text).toContain("烦死了");
    expect(transcript.fallbackUsed).toBe(true);
    expect(transcript.finalProvider).toBe("mock");
    expect(transcript.attemptedProviders?.at(-1)).toMatchObject({
      provider: "mock",
      status: "success"
    });

    const speech = await registry.getTTSProvider().synthesizeSpeech({ text: "hello" });
    expect(speech.mimeType).toBe("audio/wav");
    expect(speech.finalProvider).toBe("mock");

    const vision = await registry.getVisionProvider().analyzeImage({ prompt: "describe" });
    expect(vision.text).toContain("Mock image analysis");
    expect(vision.finalProvider).toBe("mock");
  });

  it("does not silently mock STT when mock fallback is disabled", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_STT_PROVIDER: "dashscope",
      STT_PROVIDER_CHAIN: "dashscope,local,mock"
    });

    await expect(registry.getSTTProvider().transcribeAudio({})).rejects.toMatchObject({
      capability: "stt",
      code: "PROVIDER_UNAVAILABLE"
    });
  });

  it("delegates live VAD through the STT fallback chain to the local sidecar", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ active: true, captureEpoch: "epoch-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "true",
      DEFAULT_STT_PROVIDER: "local",
      STT_PROVIDER_CHAIN: "dashscope,local,mock",
      LOCAL_STT_BASE_URL: "http://127.0.0.1:9876",
      LOCAL_STT_MODEL: "sense-voice"
    });
    const output = await registry.getSTTProvider().detectVoiceActivity!({
      captureEpoch: "epoch-1",
      pcmBase64: "AAEC",
      sampleRate: 16000
    });
    expect(output).toEqual({ active: true, captureEpoch: "epoch-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/vad",
      expect.objectContaining({ method: "POST" })
    );
  });
});

it("bounds one-shot Vision to one selected provider even when fallback is eligible", async () => {
  const { FallbackVisionProvider } = await import("./registry.js");
  const first = vi.fn(async () => {
    throw new ProviderError({
      provider: "first",
      capability: "vision",
      code: ProviderErrorCode.ProviderUnavailable,
      message: "Unavailable",
      retryable: true,
      fallbackEligible: true,
      effectState: "not_started"
    });
  });
  const second = vi.fn(async () => ({ text: "must not run" }));
  const healthCheck = async () => ({ provider: "test", status: "healthy" as const, checkedAt: "" });
  const provider = new FallbackVisionProvider([
    { name: "first", analyzeImage: first, healthCheck },
    { name: "second", analyzeImage: second, healthCheck }
  ]);
  await expect(
    provider.analyzeImage({ image: new Uint8Array([1]) }, { allowFallback: false })
  ).rejects.toThrow();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
});

it("does not advertise configured Vision placeholders as implemented", () => {
  for (const name of ["local", "nvidia"]) {
    const registry = createProviderRegistryFromEnv({
      VISION_PROVIDER_CHAIN: name,
      LOCAL_MODEL_BASEURL: "http://127.0.0.1:1234/v1",
      LOCAL_VISION_MODEL: "vision",
      NVIDIA_API_KEY: "test",
      NVIDIA_VISION_MODEL: "vision"
    });
    expect(registry.getVisionProvider().implemented).toBe(false);
  }
});
