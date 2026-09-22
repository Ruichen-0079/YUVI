import { parseProductConfiguration, modelEndpoint, type ProductConfiguration, type CapabilityRoute } from "./product-configuration.js";
import type {
  ChatInput,
  ChatOutput,
  ChatProvider,
  ChatStreamEvent,
  ChatStreamOptions,
  ChatStreamingMode
} from "./types/chat.js";
import type { EmbeddingProvider } from "./types/embedding.js";
import type {
  AssistantContinuationInput,
  AssistantContinuationProvider,
  ProactiveDecisionOutput,
  ProactiveDecisionProvider
} from "./types/proactive.js";
import type {
  ProviderCallOptions,
  ProviderAttempt,
  ProviderCapability,
  ProviderHealth,
  ProviderObservedState,
  ProviderReadinessState,
  ProviderRouteStatus,
  TokenUsage
} from "./types/common.js";
import {
  normalizeReasoningOutput,
  type ReasoningInput,
  type ReasoningCallOptions,
  type ReasoningOutput,
  type ReasoningProvider
} from "./types/reasoning.js";
import type {
  STTInput,
  STTOutput,
  STTProvider,
  VoiceActivityInput,
  VoiceActivityOutput
} from "./types/stt.js";
import type { TTSInput, TTSOutput, TTSProvider } from "./types/tts.js";
import type {
  VisionCallOptions,
  VisionInput,
  VisionOutput,
  VisionProvider
} from "./types/vision.js";
import {
  ProviderError,
  ProviderErrorCode,
  canFallbackProviderError,
  cloneProviderError,
  mapHttpStatusToProviderErrorCode,
  normalizeProviderError,
  type ProviderEffectState
} from "./types/errors.js";
import { DeepSeekChatProvider } from "./deepseek/DeepSeekChatProvider.js";
import { DeepSeekReasoningProvider } from "./deepseek/DeepSeekReasoningProvider.js";
import { XAITTSProvider } from "./xai/XAITTSProvider.js";
import { XAIVisionProvider } from "./xai/XAIVisionProvider.js";
import { DashScopeSTTProvider } from "./alibaba/DashScopeSTTProvider.js";
import { streamOpenAICompatibleChatCompletion } from "./openai-compatible-stream.js";
import { DotsTTSProvider } from "./local/DotsTTSProvider.js";
import { GPTSoVITSTTSProvider } from "./local/GPTSoVITSTTSProvider.js";
import { LocalSTTProvider } from "./local/LocalSTTProvider.js";
import { createTransportAbort, type TransportAbort } from "./transport-abort.js";

export type ProviderRegistryConfig = {
  product?: ProductConfiguration;
  observeProductCall?: (cap: CapabilityRoute, id: string, available: boolean) => void;
  chatContextWindows?: Partial<Record<string, number>>;
  environment: "development" | "test" | "production";
  allowMocks: boolean;
  includeRawProviderResponses: boolean;
  databaseUrl: string | undefined;
  defaults: {
    chat: string;
    reasoning: string;
    tts: string;
    stt: string;
    vision: string;
    embedding: string;
  };
  chains: Record<ProviderCapability, string[]>;
  deepseek: {
    apiKey: string | undefined;
    baseUrl: string;
    chatModel: string | undefined;
    reasoningModel: string | undefined;
  };
  xai: {
    apiKey: string | undefined;
    baseUrl: string;
    ttsModel: string | undefined;
    ttsVoice: string | undefined;
    visionModel: string | undefined;
  };
  dashscope: {
    apiKey: string | undefined;
    baseUrl: string;
    sttModel: string | undefined;
  };
  embedding: {
    apiKey: string | undefined;
    baseUrl: string | undefined;
    model: string | undefined;
    dimensions: number;
  };
  openaiCompatible: {
    apiKey: string | undefined;
    baseUrl: string | undefined;
    chatModel: string | undefined;
    reasoningModel: string | undefined;
    proactiveDecisionModel: string | undefined;
    assistantContinuationFormat: "deepseek-v4" | undefined;
  };
  nvidia: {
    apiKey: string | undefined;
    baseUrl: string;
    chatModel: string | undefined;
    reasoningModel: string | undefined;
    embeddingModel: string | undefined;
    embeddingDimensions: number;
    visionModel: string | undefined;
  };
  local: {
    baseUrl: string | undefined;
    sttBaseUrl?: string | undefined;
    ttsBaseUrl?: string | undefined;
    chatModel: string | undefined;
    reasoningModel: string | undefined;
    embeddingModel: string | undefined;
    embeddingDimensions: number;
    ttsModel: string | undefined;
    sttModel: string | undefined;
    visionModel: string | undefined;
  };
  gptSovits: {
    wrapperBaseUrl: string;
    upstreamBaseUrl: string;
    gptWeightsPath: string | undefined;
    sovitsWeightsPath: string | undefined;
    defaultLanguage: string;
    speaker: string;
    style: string;
    referenceRank: number;
    referenceAudioPath: string | undefined;
    referenceText: string | undefined;
    referenceLanguage: string;
    textSplitMethod: string;
    topK: number;
    topP: number;
    temperature: number;
    repetitionPenalty: number;
    sampleSteps: number;
    timeoutMs: number;
  };
};

type ProviderEnv = Record<string, string | undefined>;

export interface ProviderResolver {
  getChatProvider(): ChatProvider;
  getChatStreamingMode?(): ChatStreamingMode;
  hasProactiveRoute?(): boolean;
  getChatContextWindow?(): number | undefined;
  getProactiveDecisionProvider?(): ProactiveDecisionProvider;
  getAssistantContinuationProvider?(): AssistantContinuationProvider;
  getReasoningProvider(): ReasoningProvider;
  getTTSProvider(): TTSProvider;
  getSTTProvider(): STTProvider;
  getVisionProvider(): VisionProvider;
  getEmbeddingProvider(): EmbeddingProvider;
  getStatus?(): ProviderStatusMap;
}

export type ProviderStatusMap = {
  providers: Record<ProviderCapability, ProviderHealth>;
  routes?: Record<ProviderCapability, ProviderRouteStatus[]>;
};

export type LiveProviderVerification = {
  capability: ProviderCapability;
  provider: string;
  observed: Exclude<ProviderObservedState, "unknown">;
  verifiedAt?: string | undefined;
  latencyMs?: number | undefined;
  errorCode?: string | undefined;
  error?: string | undefined;
};

type ProviderObservation = Omit<LiveProviderVerification, "capability" | "provider"> & {
  verifiedAt: string;
};

export class ProviderRegistry implements ProviderResolver {
  private readonly chatProviders = new Map<string, ChatProvider>();
  private readonly reasoningProviders = new Map<string, ReasoningProvider>();
  private readonly ttsProviders = new Map<string, TTSProvider>();
  private readonly sttProviders = new Map<string, STTProvider>();
  private readonly visionProviders = new Map<string, VisionProvider>();
  private readonly embeddingProviders = new Map<string, EmbeddingProvider>();
  private readonly proactiveObservations = new Map<string, "available" | "unavailable">();
  recordProactiveObservation(id: string, available: boolean) { this.proactiveObservations.set(id, available ? "available" : "unavailable"); }
  getProactiveRouteObservations() { return Object.fromEntries(this.proactiveObservations); }
  private proactiveDecisionProvider: ProactiveDecisionProvider | undefined;
  private assistantContinuationProvider: AssistantContinuationProvider | undefined;
  /**
   * Live observations belong to this registry instance only. Runtime config
   * reload replaces the registry, which intentionally starts with an empty
   * cache; observations are never persisted or copied between registries.
   */
  private readonly observationCache = new Map<string, ProviderObservation>();

  constructor(private readonly config: ProviderRegistryConfig) {}

  registerChatProvider(provider: ChatProvider): void {
    this.chatProviders.set(provider.name, provider);
  }

  registerReasoningProvider(provider: ReasoningProvider): void {
    this.reasoningProviders.set(provider.name, provider);
  }

  registerTTSProvider(provider: TTSProvider): void {
    this.ttsProviders.set(provider.name, provider);
  }

  registerSTTProvider(provider: STTProvider): void {
    this.sttProviders.set(provider.name, provider);
  }

  registerVisionProvider(provider: VisionProvider): void {
    this.visionProviders.set(provider.name, provider);
  }

  registerEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProviders.set(provider.name, provider);
  }

  registerProactiveDecisionProvider(provider: ProactiveDecisionProvider): void {
    this.proactiveDecisionProvider = provider;
  }

  registerAssistantContinuationProvider(provider: AssistantContinuationProvider): void {
    this.assistantContinuationProvider = provider;
  }

  getChatProvider(): ChatProvider {
    return this.getRequiredProvider(this.chatProviders, this.config.defaults.chat, "chat");
  }

  getChatStreamingMode(): ChatStreamingMode {
    return getChatStreamingMode(this.getChatProvider());
  }

  getProactiveDecisionProvider(): ProactiveDecisionProvider {
    return (
      this.proactiveDecisionProvider ??
      new UnavailableProactiveDecisionProvider("Proactive decision provider is not configured.")
    );
  }

  getAssistantContinuationProvider(): AssistantContinuationProvider {
    return (
      this.assistantContinuationProvider ??
      new UnavailableAssistantContinuationProvider(
        "Assistant continuation provider is not configured."
      )
    );
  }

  getReasoningProvider(): ReasoningProvider {
    return this.getRequiredProvider(
      this.reasoningProviders,
      this.config.defaults.reasoning,
      "reasoning"
    );
  }

  getTTSProvider(): TTSProvider {
    return this.getRequiredProvider(this.ttsProviders, this.config.defaults.tts, "tts");
  }

  getSTTProvider(): STTProvider {
    return this.getRequiredProvider(this.sttProviders, this.config.defaults.stt, "stt");
  }

  getVisionProvider(): VisionProvider {
    return this.getRequiredProvider(this.visionProviders, this.config.defaults.vision, "vision");
  }

  getEmbeddingProvider(): EmbeddingProvider {
    return this.getRequiredProvider(
      this.embeddingProviders,
      this.config.defaults.embedding,
      "embedding"
    );
  }

  hasProactiveRoute(): boolean {
    if (this.config.product) return this.config.product.routes.proactive.length > 0;
    return (
      Boolean(
        this.config.openaiCompatible.baseUrl &&
        this.config.openaiCompatible.apiKey &&
        this.config.openaiCompatible.proactiveDecisionModel
      ) || this.config.allowMocks
    );
  }

  getChatContextWindow(): number | undefined {
    const windows = this.createRouteStatuses("chat")
      .filter((route) => route.configured && !route.mock)
      .map((route) => this.config.chatContextWindows?.[route.provider]);
    // A fallback route with unknown metadata must retain the conservative budget.
    return windows.length && windows.every((window): window is number => window !== undefined)
      ? Math.min(...windows)
      : undefined;
  }

  getStatus(): ProviderStatusMap {
    return {
      providers: {
        chat: this.createStatus("chat", this.config.defaults.chat),
        reasoning: this.createStatus("reasoning", this.config.defaults.reasoning),
        tts: this.createStatus("tts", this.config.defaults.tts),
        stt: this.createStatus("stt", this.config.defaults.stt),
        vision: this.createStatus("vision", this.config.defaults.vision),
        embedding: this.createStatus("embedding", this.config.defaults.embedding)
      },
      routes: {
        chat: this.createRouteStatuses("chat"),
        reasoning: this.createRouteStatuses("reasoning"),
        tts: this.createRouteStatuses("tts"),
        stt: this.createRouteStatuses("stt"),
        vision: this.createRouteStatuses("vision"),
        embedding: this.createRouteStatuses("embedding")
      }
    };
  }

  /**
   * Record an explicitly performed live observation. getStatus() never calls
   * this method and never performs provider I/O. The observation is retained
   * only by this registry instance and therefore resets on configuration
   * reload when the runtime replaces the registry.
   */
  recordLiveVerification(input: LiveProviderVerification): void {
    const verifiedAt = input.verifiedAt ?? new Date().toISOString();
    this.observationCache.set(observationKey(input.capability, input.provider), {
      observed: input.observed,
      verifiedAt,
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.error ? { error: input.error } : {})
    });
  }

  private createRouteStatuses(capability: ProviderCapability): ProviderRouteStatus[] {
    return this.config.chains[capability].map((name, index) => {
      const status = this.createStatus(capability, name);
      return {
        ...status,
        capability,
        provider: name,
        name,
        enabled: true,
        priority: index + 1,
        fallbackEligible: Boolean(status.available)
      };
    });
  }

  private getRequiredProvider<TProvider>(
    providers: Map<string, TProvider>,
    name: string,
    capability: "chat" | "reasoning" | "tts" | "stt" | "vision" | "embedding"
  ): TProvider {
    const provider = providers.get(name);
    if (!provider) {
      throw new ProviderError({
        provider: name,
        capability,
        code: ProviderErrorCode.ProviderUnavailable,
        message: `Provider '${name}' is not registered for capability '${capability}'.`,
        retryable: false
      });
    }

    return provider;
  }

  private createStatus(capability: ProviderCapability, name: string): ProviderHealth {
    const configured = this.isConfigured(capability, name);
    // PROVIDER_ALLOW_MOCKS permits the explicit `mock` route; it does not
    // turn an unconfigured real provider identity into a mock route.
    const mock = this.config.allowMocks && name === "mock";
    const required = capability === "chat";
    const readiness: ProviderReadinessState = configured || mock ? "ready" : "not_ready";
    const available = readiness === "ready";
    const observation = this.observationCache.get(observationKey(capability, name));
    const observed: ProviderObservedState = observation?.observed ?? "unknown";
    const status = providerHealthStatus({ readiness, observed, mock });
    const missingFields = readiness === "ready" ? [] : this.missingFieldsFor(capability, name);

    return {
      provider: name,
      name,
      capability,
      readiness,
      observed,
      configured,
      available,
      mock,
      mode: mock ? "mock" : configured ? "real" : "unavailable",
      mockAllowed: this.config.allowMocks,
      missingFields,
      required,
      status,
      checkedAt: new Date().toISOString(),
      ...(observation
        ? {
            lastVerifiedAt: observation.verifiedAt,
            ...(observation.latencyMs !== undefined ? { latencyMs: observation.latencyMs } : {}),
            ...(observation.errorCode ? { lastErrorCode: observation.errorCode } : {}),
            ...(observation.error ? { lastError: observation.error } : {})
          }
        : {}),
      ...this.safeProviderMetadata(capability, name),
      ...(capability === "embedding" && name === "mock"
        ? {
            semanticEmbedding: false,
            embeddingNote:
              "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
          }
        : capability === "embedding"
          ? { semanticEmbedding: configured }
          : {}),
      message: providerStatusMessage({
        capability,
        name,
        configured,
        mock,
        required,
        readiness,
        observed
      })
    };
  }

  private isConfigured(capability: ProviderCapability, name: string): boolean {
    if (this.config.product) {
      const m = this.config.product.models.find(m => m.id === name);
      const p = this.config.product.providers.find(p => p.id === m?.providerId);
      return Boolean(m?.enabled && m.capabilities.includes(capability) && p && (!["dashscope", "xai-tts"].includes(p.adapter) || p.apiKey));
    }
    if ((capability === "chat" || capability === "reasoning") && name === "deepseek") {
      return Boolean(
        this.config.deepseek.apiKey &&
        (capability === "chat"
          ? this.config.deepseek.chatModel
          : this.config.deepseek.reasoningModel)
      );
    }

    if ((capability === "chat" || capability === "reasoning") && name === "openai-compatible") {
      return Boolean(
        this.config.openaiCompatible.apiKey &&
        this.config.openaiCompatible.baseUrl &&
        (capability === "chat"
          ? this.config.openaiCompatible.chatModel
          : this.config.openaiCompatible.reasoningModel)
      );
    }

    if (name === "nvidia") {
      if (capability === "chat")
        return Boolean(this.config.nvidia.apiKey && this.config.nvidia.chatModel);
      if (capability === "reasoning")
        return Boolean(this.config.nvidia.apiKey && this.config.nvidia.reasoningModel);
      if (capability === "embedding")
        return Boolean(this.config.nvidia.apiKey && this.config.nvidia.embeddingModel);
      if (capability === "vision")
        return Boolean(this.config.nvidia.apiKey && this.config.nvidia.visionModel);
      return false;
    }

    if (name === "local") {
      if (capability === "chat")
        return Boolean(this.config.local.baseUrl && this.config.local.chatModel);
      if (capability === "reasoning")
        return Boolean(this.config.local.baseUrl && this.config.local.reasoningModel);
      if (capability === "embedding")
        return Boolean(this.config.local.baseUrl && this.config.local.embeddingModel);
      if (capability === "tts") return Boolean(this.config.local.ttsModel);
      if (capability === "stt")
        return Boolean(this.config.local.sttBaseUrl && this.config.local.sttModel);
      if (capability === "vision")
        return Boolean(this.config.local.baseUrl && this.config.local.visionModel);
    }

    if (capability === "tts" && name === "xai") {
      return Boolean(this.config.xai.apiKey && this.config.xai.ttsModel);
    }

    if (capability === "vision" && name === "xai") {
      return Boolean(this.config.xai.apiKey && this.config.xai.visionModel);
    }

    if (capability === "stt" && name === "dashscope") {
      return Boolean(this.config.dashscope.apiKey && this.config.dashscope.sttModel);
    }

    if (capability === "embedding") {
      if (name === "mock") {
        return this.config.allowMocks;
      }
      return Boolean(this.config.embedding.apiKey && this.config.embedding.model);
    }

    return false;
  }

  private missingFieldsFor(capability: ProviderCapability, name: string): string[] {
    if ((capability === "chat" || capability === "reasoning") && name === "deepseek") {
      return [
        ...(!this.config.deepseek.apiKey ? ["DEEPSEEK_API_KEY"] : []),
        ...(capability === "chat" && !this.config.deepseek.chatModel
          ? ["DEEPSEEK_CHAT_MODEL"]
          : []),
        ...(capability === "reasoning" && !this.config.deepseek.reasoningModel
          ? ["DEEPSEEK_REASONING_MODEL"]
          : [])
      ];
    }
    if ((capability === "chat" || capability === "reasoning") && name === "openai-compatible") {
      return [
        ...(!this.config.openaiCompatible.baseUrl ? ["OPENAI_COMPATIBLE_API_BASEURL"] : []),
        ...(!this.config.openaiCompatible.apiKey ? ["OPENAI_COMPATIBLE_API_KEY"] : []),
        ...(capability === "chat" && !this.config.openaiCompatible.chatModel
          ? ["OPENAI_COMPATIBLE_CHAT_MODEL"]
          : []),
        ...(capability === "reasoning" && !this.config.openaiCompatible.reasoningModel
          ? ["OPENAI_COMPATIBLE_REASONING_MODEL"]
          : [])
      ];
    }
    if (name === "nvidia") {
      return [
        ...(!this.config.nvidia.apiKey ? ["NVIDIA_API_KEY"] : []),
        ...(capability === "chat" && !this.config.nvidia.chatModel ? ["NVIDIA_CHAT_MODEL"] : []),
        ...(capability === "reasoning" && !this.config.nvidia.reasoningModel
          ? ["NVIDIA_REASONING_MODEL"]
          : []),
        ...(capability === "embedding" && !this.config.nvidia.embeddingModel
          ? ["NVIDIA_EMBEDDING_MODEL"]
          : []),
        ...(capability === "vision" && !this.config.nvidia.visionModel
          ? ["NVIDIA_VISION_MODEL"]
          : [])
      ];
    }
    if (name === "local") {
      return [
        ...(capability === "stt"
          ? !this.config.local.sttBaseUrl
            ? ["LOCAL_STT_BASE_URL"]
            : []
          : capability !== "tts" && !this.config.local.baseUrl
            ? ["LOCAL_MODEL_BASEURL"]
            : []),
        ...(capability === "chat" && !this.config.local.chatModel ? ["LOCAL_CHAT_MODEL"] : []),
        ...(capability === "reasoning" && !this.config.local.reasoningModel
          ? ["LOCAL_REASONING_MODEL"]
          : []),
        ...(capability === "embedding" && !this.config.local.embeddingModel
          ? ["LOCAL_EMBEDDING_MODEL"]
          : []),
        ...(capability === "tts" && !this.config.local.ttsModel ? ["LOCAL_TTS_MODEL"] : []),
        ...(capability === "stt" && !this.config.local.sttModel ? ["LOCAL_STT_MODEL"] : []),
        ...(capability === "vision" && !this.config.local.visionModel ? ["LOCAL_VISION_MODEL"] : [])
      ];
    }
    if (capability === "tts" && name === "xai") {
      return [
        ...(!this.config.xai.apiKey ? ["XAI_API_KEY"] : []),
        ...(!this.config.xai.ttsModel ? ["XAI_TTS_MODEL"] : [])
      ];
    }
    if (capability === "vision" && name === "xai") {
      return [
        ...(!this.config.xai.apiKey ? ["XAI_API_KEY"] : []),
        ...(!this.config.xai.visionModel ? ["XAI_VISION_MODEL"] : [])
      ];
    }
    if (capability === "stt" && name === "dashscope") {
      return [
        ...(!this.config.dashscope.apiKey ? ["DASHSCOPE_API_KEY"] : []),
        ...(!this.config.dashscope.sttModel ? ["DASHSCOPE_STT_MODEL"] : [])
      ];
    }
    if (capability === "embedding" && name === "openai-compatible") {
      return [
        ...(!this.config.embedding.apiKey ? ["EMBEDDING_API_KEY"] : []),
        ...(!this.config.embedding.model ? ["EMBEDDING_MODEL"] : [])
      ];
    }
    return [];
  }

  private safeProviderMetadata(
    capability: ProviderCapability,
    name: string
  ): Pick<ProviderHealth, "baseUrl" | "model" | "dimensions"> {
    if (this.config.product) {
      const m = this.config.product.models.find(m => m.id === name);
      const p = this.config.product.providers.find(p => p.id === m?.providerId);
      return { model: m?.modelId, baseUrl: p?.baseUrl, dimensions: m?.dimensions };
    }
    if ((capability === "chat" || capability === "reasoning") && name === "deepseek") {
      return {
        baseUrl: this.config.deepseek.baseUrl,
        model:
          capability === "chat"
            ? this.config.deepseek.chatModel
            : this.config.deepseek.reasoningModel
      };
    }

    if ((capability === "chat" || capability === "reasoning") && name === "openai-compatible") {
      return {
        baseUrl: this.config.openaiCompatible.baseUrl,
        model:
          capability === "chat"
            ? this.config.openaiCompatible.chatModel
            : this.config.openaiCompatible.reasoningModel
      };
    }

    if (name === "nvidia") {
      return {
        baseUrl: this.config.nvidia.baseUrl,
        model:
          capability === "chat"
            ? this.config.nvidia.chatModel
            : capability === "reasoning"
              ? this.config.nvidia.reasoningModel
              : capability === "embedding"
                ? this.config.nvidia.embeddingModel
                : capability === "vision"
                  ? this.config.nvidia.visionModel
                  : undefined,
        dimensions: capability === "embedding" ? this.config.nvidia.embeddingDimensions : undefined
      };
    }

    if (name === "local") {
      return {
        baseUrl:
          capability === "tts"
            ? (this.config.local.ttsBaseUrl ?? this.config.gptSovits.wrapperBaseUrl)
            : capability === "stt"
              ? this.config.local.sttBaseUrl
              : this.config.local.baseUrl,
        model:
          capability === "chat"
            ? this.config.local.chatModel
            : capability === "reasoning"
              ? this.config.local.reasoningModel
              : capability === "embedding"
                ? this.config.local.embeddingModel
                : capability === "tts"
                  ? this.config.local.ttsModel
                  : capability === "stt"
                    ? this.config.local.sttModel
                    : capability === "vision"
                      ? this.config.local.visionModel
                      : undefined,
        dimensions: capability === "embedding" ? this.config.local.embeddingDimensions : undefined
      };
    }

    if ((capability === "tts" || capability === "vision") && name === "xai") {
      return {
        baseUrl: this.config.xai.baseUrl,
        model: capability === "tts" ? this.config.xai.ttsModel : this.config.xai.visionModel
      };
    }

    if (capability === "stt" && name === "dashscope") {
      return {
        baseUrl: this.config.dashscope.baseUrl,
        model: this.config.dashscope.sttModel
      };
    }

    if (capability === "embedding") {
      return {
        baseUrl: this.config.embedding.baseUrl,
        model: this.config.embedding.model ?? (name === "mock" ? "mock" : undefined),
        dimensions: this.config.embedding.dimensions
      };
    }

    return {};
  }
}

function observationKey(capability: ProviderCapability, provider: string): string {
  return `${capability}:${provider}`;
}

function providerHealthStatus(input: {
  readiness: ProviderReadinessState;
  observed: ProviderObservedState;
  mock: boolean;
}): ProviderHealth["status"] {
  if (input.readiness === "not_ready") {
    return "unavailable";
  }

  // Mock providers are locally available without remote verification. Keep
  // the observation axis honest (normally unknown) while retaining the
  // existing healthy status projection for intentional offline mode.
  if (input.mock) {
    return "healthy";
  }

  if (input.observed === "available") {
    return "healthy";
  }
  if (input.observed === "unavailable") {
    return "unavailable";
  }
  return "degraded";
}

function providerStatusMessage(input: {
  capability: ProviderCapability;
  name: string;
  configured: boolean;
  mock: boolean;
  required: boolean;
  readiness: ProviderReadinessState;
  observed: ProviderObservedState;
}): string {
  if (input.mock) {
    return `${input.name} ${input.capability} provider is locally ready in mock mode; remote availability is not verified.`;
  }

  if (input.readiness === "ready" && input.observed === "available") {
    return `${input.name} ${input.capability} provider was verified available.`;
  }

  if (input.readiness === "ready" && input.observed === "unavailable") {
    return `${input.name} ${input.capability} provider was verified unavailable.`;
  }

  if (input.readiness === "ready" && input.observed === "degraded") {
    return `${input.name} ${input.capability} provider was verified with degraded availability.`;
  }

  if (input.configured) {
    return `${input.name} ${input.capability} provider is locally ready; remote availability is unverified.`;
  }

  return input.required
    ? `${input.name} ${input.capability} provider is required but not configured.`
    : `${input.name} ${input.capability} provider is optional and not configured.`;
}

export function createProviderRegistryFromEnv(env: ProviderEnv = process.env): ProviderRegistry {
  const config = createProviderRegistryConfigFromEnv(env);
  if (env["YUVI_PRODUCT_CONFIGURATION"]) {
    config.product = parseProductConfiguration(JSON.parse(env["YUVI_PRODUCT_CONFIGURATION"]));
    for (const cap of ["chat", "reasoning", "embedding", "vision", "stt", "tts"] as const) {
      config.chains[cap] = config.product.routes[cap];
      config.defaults[cap] = config.chains[cap][0] ?? "unavailable";
    }
    config.chatContextWindows = Object.fromEntries(config.product.models.filter(m => m.contextWindow !== null).map(m => [m.id, m.contextWindow!]));
    config.allowMocks = false;
  }
  validateQwen512DurableEmbeddingConfig(config);

  const registry = new ProviderRegistry(config);
  config.observeProductCall = (cap, id, available) => {
    if (cap === "proactive") registry.recordProactiveObservation(id, available);
    else registry.recordLiveVerification({ capability: cap, provider: id, observed: available ? "available" : "unavailable" });
  };
  registry.registerChatProvider(resolveChatProvider(config));
  registry.registerReasoningProvider(resolveReasoningProvider(config));
  registry.registerTTSProvider(resolveTTSProvider(config));
  registry.registerSTTProvider(resolveSTTProvider(config));
  registry.registerVisionProvider(resolveVisionProvider(config));
  registry.registerEmbeddingProvider(resolveEmbeddingProvider(config));
  registry.registerProactiveDecisionProvider(resolveProactiveDecisionProvider(config));
  registry.registerAssistantContinuationProvider(resolveAssistantContinuationProvider(config));

  return registry;
}

export function createProviderRegistryConfigFromEnv(env: ProviderEnv): ProviderRegistryConfig {
  const environment = parseEnvironment(env["NODE_ENV"]);
  const allowMocks = parseBoolean(env["PROVIDER_ALLOW_MOCKS"]);
  const defaultEmbeddingProvider =
    env["DEFAULT_EMBEDDING_PROVIDER"] ??
    env["EMBEDDING_PROVIDER"] ??
    (allowMocks ? "mock" : "openai-compatible");

  return {
    environment,
    chatContextWindows: Object.fromEntries(
      [
        ["deepseek", env["DEEPSEEK_CHAT_CONTEXT_WINDOW"]],
        ["openai-compatible", env["OPENAI_COMPATIBLE_CHAT_CONTEXT_WINDOW"]],
        ["nvidia", env["NVIDIA_CHAT_CONTEXT_WINDOW"]],
        ["local", env["LOCAL_CHAT_CONTEXT_WINDOW"]]
      ]
        .filter((entry) => Number.isSafeInteger(Number(entry[1])) && Number(entry[1]) >= 1024)
        .map(([provider, value]) => [provider, Number(value)])
    ),
    allowMocks,
    includeRawProviderResponses: parseBoolean(env["PROVIDER_INCLUDE_RAW_RESPONSES"]),
    databaseUrl: emptyToUndefined(env["DATABASE_URL"]),
    defaults: {
      chat: env["DEFAULT_CHAT_PROVIDER"] ?? "deepseek",
      reasoning: env["DEFAULT_REASONING_PROVIDER"] ?? "deepseek",
      tts: env["DEFAULT_TTS_PROVIDER"] ?? "xai",
      stt: env["DEFAULT_STT_PROVIDER"] ?? "dashscope",
      vision: env["DEFAULT_VISION_PROVIDER"] ?? "xai",
      embedding: defaultEmbeddingProvider
    },
    chains: {
      chat: parseProviderChain(
        env["CHAT_PROVIDER_CHAIN"],
        env["DEFAULT_CHAT_PROVIDER"] === "openai-compatible"
          ? ["openai-compatible", "deepseek", "nvidia", "local", "mock"]
          : ["deepseek", "nvidia", "local", "mock"],
        allowMocks
      ),
      reasoning: parseProviderChain(
        env["REASONING_PROVIDER_CHAIN"],
        env["DEFAULT_REASONING_PROVIDER"] === "openai-compatible"
          ? ["openai-compatible", "deepseek", "nvidia", "local", "mock"]
          : ["deepseek", "nvidia", "local", "mock"],
        allowMocks
      ),
      embedding: parseProviderChain(
        env["EMBEDDING_PROVIDER_CHAIN"],
        defaultEmbeddingProvider === "mock"
          ? ["mock"]
          : ["openai-compatible", "nvidia", "local", "mock"],
        allowMocks
      ),
      tts: parseProviderChain(env["TTS_PROVIDER_CHAIN"], ["xai", "local", "mock"], allowMocks),
      stt: parseProviderChain(
        env["STT_PROVIDER_CHAIN"],
        ["dashscope", "local", "mock"],
        allowMocks
      ),
      vision: parseProviderChain(
        env["VISION_PROVIDER_CHAIN"],
        ["xai", "nvidia", "local", "mock"],
        allowMocks
      )
    },
    deepseek: {
      apiKey: emptyToUndefined(env["DEEPSEEK_API_KEY"]),
      baseUrl:
        env["DEEPSEEK_API_BASEURL"] ?? env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com",
      chatModel: emptyToUndefined(env["DEEPSEEK_CHAT_MODEL"]),
      reasoningModel: emptyToUndefined(env["DEEPSEEK_REASONING_MODEL"])
    },
    xai: {
      apiKey: emptyToUndefined(env["XAI_API_KEY"]),
      baseUrl: env["XAI_API_BASEURL"] ?? env["XAI_BASE_URL"] ?? "https://api.x.ai/v1",
      ttsModel: emptyToUndefined(env["XAI_TTS_MODEL"]),
      ttsVoice: emptyToUndefined(env["XAI_TTS_VOICE"]),
      visionModel: emptyToUndefined(env["XAI_VISION_MODEL"])
    },
    dashscope: {
      apiKey: emptyToUndefined(env["DASHSCOPE_API_KEY"]),
      baseUrl:
        env["DASHSCOPE_API_BASEURL"] ??
        env["DASHSCOPE_BASE_URL"] ??
        "https://dashscope.aliyuncs.com/api/v1",
      sttModel: emptyToUndefined(env["DASHSCOPE_STT_MODEL"])
    },
    embedding: {
      apiKey: emptyToUndefined(env["EMBEDDING_API_KEY"]),
      baseUrl:
        emptyToUndefined(env["EMBEDDING_API_BASEURL"]) ??
        emptyToUndefined(env["EMBEDDING_BASE_URL"]),
      model: emptyToUndefined(env["EMBEDDING_MODEL"]),
      dimensions: parsePositiveInteger(env["EMBEDDING_DIMENSIONS"], 1536)
    },
    openaiCompatible: {
      apiKey: emptyToUndefined(env["OPENAI_COMPATIBLE_API_KEY"]),
      baseUrl: emptyToUndefined(env["OPENAI_COMPATIBLE_API_BASEURL"]),
      chatModel: emptyToUndefined(env["OPENAI_COMPATIBLE_CHAT_MODEL"]),
      reasoningModel: emptyToUndefined(env["OPENAI_COMPATIBLE_REASONING_MODEL"]),
      proactiveDecisionModel: emptyToUndefined(env["OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL"]),
      assistantContinuationFormat: parseAssistantContinuationFormat(
        env["OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT"]
      )
    },
    nvidia: {
      apiKey: emptyToUndefined(env["NVIDIA_API_KEY"]),
      baseUrl: env["NVIDIA_API_BASEURL"] ?? "https://integrate.api.nvidia.com/v1",
      chatModel: emptyToUndefined(env["NVIDIA_CHAT_MODEL"]),
      reasoningModel: emptyToUndefined(env["NVIDIA_REASONING_MODEL"]),
      embeddingModel: emptyToUndefined(env["NVIDIA_EMBEDDING_MODEL"]),
      embeddingDimensions: parsePositiveInteger(env["NVIDIA_EMBEDDING_DIMENSIONS"], 1536),
      visionModel: emptyToUndefined(env["NVIDIA_VISION_MODEL"])
    },
    local: {
      baseUrl: emptyToUndefined(env["LOCAL_MODEL_BASEURL"]),
      sttBaseUrl: emptyToUndefined(env["LOCAL_STT_BASE_URL"]),
      chatModel: emptyToUndefined(env["LOCAL_CHAT_MODEL"]),
      reasoningModel: emptyToUndefined(env["LOCAL_REASONING_MODEL"]),
      embeddingModel: emptyToUndefined(env["LOCAL_EMBEDDING_MODEL"]),
      embeddingDimensions: parsePositiveInteger(env["LOCAL_EMBEDDING_DIMENSIONS"], 1536),
      ttsModel: emptyToUndefined(env["LOCAL_TTS_MODEL"]),
      ttsBaseUrl: emptyToUndefined(env["LOCAL_TTS_BASE_URL"]),
      sttModel: emptyToUndefined(env["LOCAL_STT_MODEL"]),
      visionModel: emptyToUndefined(env["LOCAL_VISION_MODEL"])
    },
    gptSovits: {
      wrapperBaseUrl: env["GPT_SOVITS_TTS_BASE_URL"] ?? "http://127.0.0.1:9881",
      upstreamBaseUrl: env["GPT_SOVITS_TTS_UPSTREAM_URL"] ?? "http://127.0.0.1:9880",
      gptWeightsPath: emptyToUndefined(env["GPT_SOVITS_TTS_GPT_WEIGHTS"]),
      sovitsWeightsPath: emptyToUndefined(env["GPT_SOVITS_TTS_SOVITS_WEIGHTS"]),
      defaultLanguage: env["GPT_SOVITS_TTS_LANGUAGE"] ?? "ja",
      speaker: env["GPT_SOVITS_TTS_SPEAKER"] ?? "alice",
      style: env["GPT_SOVITS_TTS_STYLE"] ?? "neutral",
      referenceRank: parseBoundedInteger(env["GPT_SOVITS_TTS_REFERENCE_RANK"], 0, 3, 0),
      referenceAudioPath: emptyToUndefined(env["GPT_SOVITS_TTS_REFERENCE_AUDIO"]),
      referenceText: emptyToUndefined(env["GPT_SOVITS_TTS_REFERENCE_TEXT"]),
      referenceLanguage: env["GPT_SOVITS_TTS_REFERENCE_LANGUAGE"] ?? "ja",
      textSplitMethod: env["GPT_SOVITS_TTS_TEXT_SPLIT_METHOD"] ?? "cut0",
      topK: parseBoundedInteger(env["GPT_SOVITS_TTS_TOP_K"], 1, 100, 15),
      topP: parseBoundedNumber(env["GPT_SOVITS_TTS_TOP_P"], 0, 1, 1),
      temperature: parseBoundedNumber(env["GPT_SOVITS_TTS_TEMPERATURE"], 0, 2, 1),
      repetitionPenalty: parseBoundedNumber(env["GPT_SOVITS_TTS_REPETITION_PENALTY"], 0.1, 5, 1.35),
      sampleSteps: parseBoundedInteger(env["GPT_SOVITS_TTS_SAMPLE_STEPS"], 1, 100, 32),
      timeoutMs: parseBoundedInteger(env["GPT_SOVITS_TTS_TIMEOUT_MS"], 1000, 300000, 60000)
    }
  };
}

export function validateRequiredProviderConfig(config: ProviderRegistryConfig): void {
  const errors: string[] = [];

  if (!config.allowMocks && config.defaults.chat === "deepseek" && !config.deepseek.apiKey) {
    errors.push("DEEPSEEK_API_KEY is required when DEFAULT_CHAT_PROVIDER=deepseek.");
  }

  if (!config.allowMocks && config.defaults.chat === "deepseek" && !config.deepseek.chatModel) {
    errors.push("DEEPSEEK_CHAT_MODEL is required when DEFAULT_CHAT_PROVIDER=deepseek.");
  }

  if (
    !config.allowMocks &&
    config.defaults.chat === "openai-compatible" &&
    !config.openaiCompatible.baseUrl
  ) {
    errors.push(
      "OPENAI_COMPATIBLE_API_BASEURL is required when DEFAULT_CHAT_PROVIDER=openai-compatible."
    );
  }

  if (
    !config.allowMocks &&
    config.defaults.reasoning === "openai-compatible" &&
    !config.openaiCompatible.baseUrl
  ) {
    errors.push(
      "OPENAI_COMPATIBLE_API_BASEURL is required when DEFAULT_REASONING_PROVIDER=openai-compatible."
    );
  }

  if (
    !config.allowMocks &&
    config.defaults.reasoning === "openai-compatible" &&
    !config.openaiCompatible.apiKey
  ) {
    errors.push(
      "OPENAI_COMPATIBLE_API_KEY is required when DEFAULT_REASONING_PROVIDER=openai-compatible."
    );
  }

  if (
    !config.allowMocks &&
    config.defaults.reasoning === "openai-compatible" &&
    !config.openaiCompatible.reasoningModel
  ) {
    errors.push(
      "OPENAI_COMPATIBLE_REASONING_MODEL is required when DEFAULT_REASONING_PROVIDER=openai-compatible."
    );
  }

  if (
    !config.allowMocks &&
    config.defaults.chat === "openai-compatible" &&
    !config.openaiCompatible.apiKey
  ) {
    errors.push(
      "OPENAI_COMPATIBLE_API_KEY is required when DEFAULT_CHAT_PROVIDER=openai-compatible."
    );
  }

  if (
    !config.allowMocks &&
    config.defaults.chat === "openai-compatible" &&
    !config.openaiCompatible.chatModel
  ) {
    errors.push(
      "OPENAI_COMPATIBLE_CHAT_MODEL is required when DEFAULT_CHAT_PROVIDER=openai-compatible."
    );
  }

  if (!config.allowMocks && config.defaults.reasoning === "deepseek" && !config.deepseek.apiKey) {
    errors.push("DEEPSEEK_API_KEY is required when DEFAULT_REASONING_PROVIDER=deepseek.");
  }

  if (
    !config.allowMocks &&
    config.defaults.reasoning === "deepseek" &&
    !config.deepseek.reasoningModel
  ) {
    errors.push("DEEPSEEK_REASONING_MODEL is required when DEFAULT_REASONING_PROVIDER=deepseek.");
  }

  if (errors.length > 0) {
    throw new ProviderError({
      provider: "registry",
      capability: "chat",
      code: ProviderErrorCode.MissingApiKey,
      message: `Provider startup configuration is incomplete:\n- ${errors.join("\n- ")}`,
      retryable: false
    });
  }
}

type ProviderFactory<TProvider> = (config: ProviderRegistryConfig) => TProvider | undefined;

const chatProviderFactories: Record<string, ProviderFactory<ChatProvider>> = {
  "openai-compatible"(config) {
    if (
      !config.openaiCompatible.apiKey ||
      !config.openaiCompatible.baseUrl ||
      !config.openaiCompatible.chatModel
    ) {
      return undefined;
    }

    return new OpenAICompatibleChatProvider({
      provider: "openai-compatible",
      apiKey: config.openaiCompatible.apiKey,
      baseUrl: config.openaiCompatible.baseUrl,
      model: config.openaiCompatible.chatModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  },
  deepseek(config) {
    if (!config.deepseek.apiKey || !config.deepseek.chatModel) {
      return undefined;
    }

    return new DeepSeekChatProvider({
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
      model: config.deepseek.chatModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  },
  nvidia(config) {
    if (!config.nvidia.apiKey || !config.nvidia.chatModel) return undefined;
    return new OpenAICompatibleChatProvider({
      provider: "nvidia",
      apiKey: config.nvidia.apiKey,
      baseUrl: config.nvidia.baseUrl,
      model: config.nvidia.chatModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  },
  local(config) {
    if (!config.local.baseUrl || !config.local.chatModel) return undefined;
    return new OpenAICompatibleChatProvider({
      provider: "local",
      baseUrl: config.local.baseUrl,
      model: config.local.chatModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  }
};

const reasoningProviderFactories: Record<string, ProviderFactory<ReasoningProvider>> = {
  "openai-compatible"(config) {
    if (
      !config.openaiCompatible.apiKey ||
      !config.openaiCompatible.baseUrl ||
      !config.openaiCompatible.reasoningModel
    ) {
      return undefined;
    }

    return new OpenAICompatibleReasoningProvider({
      provider: "openai-compatible",
      apiKey: config.openaiCompatible.apiKey,
      baseUrl: config.openaiCompatible.baseUrl,
      model: config.openaiCompatible.reasoningModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  },
  deepseek(config) {
    if (!config.deepseek.apiKey || !config.deepseek.reasoningModel) {
      return undefined;
    }

    return new DeepSeekReasoningProvider({
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
      model: config.deepseek.reasoningModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  },
  nvidia(config) {
    if (!config.nvidia.apiKey || !config.nvidia.reasoningModel) return undefined;
    return new OpenAICompatibleReasoningProvider({
      provider: "nvidia",
      apiKey: config.nvidia.apiKey,
      baseUrl: config.nvidia.baseUrl,
      model: config.nvidia.reasoningModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  },
  local(config) {
    if (!config.local.baseUrl || !config.local.reasoningModel) return undefined;
    return new OpenAICompatibleReasoningProvider({
      provider: "local",
      baseUrl: config.local.baseUrl,
      model: config.local.reasoningModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  }
};

const ttsProviderFactories: Record<string, ProviderFactory<TTSProvider>> = {
  xai(config) {
    if (!config.xai.apiKey || !config.xai.ttsModel) {
      return undefined;
    }

    return new XAITTSProvider({
      apiKey: config.xai.apiKey,
      baseUrl: config.xai.baseUrl,
      model: config.xai.ttsModel,
      defaultVoice: config.xai.ttsVoice
    });
  },
  local(config) {
    if (!config.local.ttsModel) {
      return undefined;
    }

    if (config.local.ttsModel === "dots-studio/dots.tts-soar") {
      return new DotsTTSProvider({
        baseUrl: config.local.ttsBaseUrl ?? "http://127.0.0.1:9881",
        model: config.local.ttsModel
      });
    }
    return new GPTSoVITSTTSProvider({
      wrapperBaseUrl: config.gptSovits.wrapperBaseUrl,
      upstreamBaseUrl: config.gptSovits.upstreamBaseUrl,
      model: config.local.ttsModel,
      gptWeightsPath: config.gptSovits.gptWeightsPath,
      sovitsWeightsPath: config.gptSovits.sovitsWeightsPath,
      defaultLanguage: config.gptSovits.defaultLanguage,
      speaker: config.gptSovits.speaker,
      style: config.gptSovits.style,
      referenceRank: config.gptSovits.referenceRank,
      referenceAudioPath: config.gptSovits.referenceAudioPath,
      referenceText: config.gptSovits.referenceText,
      referenceLanguage: config.gptSovits.referenceLanguage,
      textSplitMethod: config.gptSovits.textSplitMethod,
      topK: config.gptSovits.topK,
      topP: config.gptSovits.topP,
      temperature: config.gptSovits.temperature,
      repetitionPenalty: config.gptSovits.repetitionPenalty,
      sampleSteps: config.gptSovits.sampleSteps,
      timeoutMs: config.gptSovits.timeoutMs
    });
  }
};

const sttProviderFactories: Record<string, ProviderFactory<STTProvider>> = {
  dashscope(config) {
    if (!config.dashscope.apiKey || !config.dashscope.sttModel) {
      return undefined;
    }

    return new DashScopeSTTProvider({
      apiKey: config.dashscope.apiKey,
      baseUrl: config.dashscope.baseUrl,
      model: config.dashscope.sttModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  },
  local(config) {
    const baseUrl = config.local.sttBaseUrl;
    if (!baseUrl || !config.local.sttModel) {
      return undefined;
    }

    return new LocalSTTProvider({
      baseUrl,
      model: config.local.sttModel
    });
  }
};

const visionProviderFactories: Record<string, ProviderFactory<VisionProvider>> = {
  xai(config) {
    if (!config.xai.apiKey || !config.xai.visionModel) {
      return undefined;
    }

    return new XAIVisionProvider({
      apiKey: config.xai.apiKey,
      baseUrl: config.xai.baseUrl,
      model: config.xai.visionModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  },
  nvidia(config) {
    if (!config.nvidia.apiKey || !config.nvidia.visionModel) {
      return undefined;
    }

    return new UnimplementedVisionProvider(
      "nvidia",
      "NVIDIA vision provider is configured, but chat-style image analysis compatibility is not implemented in v1."
    );
  },
  local(config) {
    if (!config.local.baseUrl || !config.local.visionModel) {
      return undefined;
    }

    return new UnimplementedVisionProvider(
      "local",
      "Local vision provider is configured, but runtime image analysis is not implemented in v1."
    );
  }
};

const embeddingProviderFactories: Record<string, ProviderFactory<EmbeddingProvider>> = {
  "openai-compatible"(config) {
    if (!config.embedding.apiKey || !config.embedding.model) {
      return undefined;
    }

    return new OpenAICompatibleEmbeddingProvider(config);
  },
  nvidia(config) {
    if (!config.nvidia.apiKey || !config.nvidia.embeddingModel) return undefined;
    return new OpenAICompatibleEmbeddingProvider(config, {
      provider: "nvidia",
      apiKey: config.nvidia.apiKey,
      baseUrl: config.nvidia.baseUrl,
      model: config.nvidia.embeddingModel,
      dimensions: config.nvidia.embeddingDimensions
    });
  },
  local(config) {
    if (!config.local.baseUrl || !config.local.embeddingModel) return undefined;
    return new OpenAICompatibleEmbeddingProvider(config, {
      provider: "local",
      baseUrl: config.local.baseUrl,
      model: config.local.embeddingModel,
      dimensions: config.local.embeddingDimensions
    });
  },
  mock(config) {
    return new MockEmbeddingProvider(config.embedding.dimensions);
  }
};

function resolveChatProvider(config: ProviderRegistryConfig): ChatProvider {
  return new FallbackChatProvider(
    createProviderChain(
      config,
      "chat",
      chatProviderFactories,
      createMockChatProvider,
      (name) => new UnavailableChatProvider(name, unavailableProviderMessage("chat", name, config))
    ),
    config.defaults.chat
  );
}

function resolveProactiveDecisionProvider(
  config: ProviderRegistryConfig
): ProactiveDecisionProvider {
  if (config.product) {
    const providers = config.product.routes.proactive.map(id => productAdapter(config, "proactive", id) as ProactiveDecisionProvider);
    return providers.length ? { name: providers[0]!.name, decide: (input, options) => runProviderChain(providers, "chat", p => p.decide(input, options), options) } : new UnavailableProactiveDecisionProvider("Proactive is not configured.");
  }
  const { apiKey, baseUrl, proactiveDecisionModel } = config.openaiCompatible;
  if (!apiKey || !baseUrl || !proactiveDecisionModel) {
    if (config.allowMocks) {
      return createMockProactiveDecisionProvider();
    }
    return new UnavailableProactiveDecisionProvider(
      "OPENAI_COMPATIBLE_API_BASEURL, OPENAI_COMPATIBLE_API_KEY, and OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL are required for proactive decisions."
    );
  }
  return new OpenAICompatibleProactiveDecisionProvider({
    provider: "openai-compatible-proactive-decision",
    apiKey,
    baseUrl,
    model: proactiveDecisionModel,
    includeRawResponse: config.includeRawProviderResponses
  });
}

function resolveAssistantContinuationProvider(
  config: ProviderRegistryConfig
): AssistantContinuationProvider {
  if (config.product) {
    const m = config.product.models.find(m => m.id === config.product!.routes.chat[0]);
    const p = config.product.providers.find(p => p.id === m?.providerId);
    return m?.continuationFormat && p ? new OpenAICompatibleAssistantContinuationProvider({ provider: m.id, baseUrl: modelEndpoint(p.baseUrl), model: m.modelId, apiKey: p.apiKey }, m.continuationFormat) : new UnavailableAssistantContinuationProvider("Assistant continuation format is not configured.");
  }
  const { apiKey, baseUrl, chatModel, assistantContinuationFormat } = config.openaiCompatible;
  if (!apiKey || !baseUrl || !chatModel || !assistantContinuationFormat) {
    if (config.allowMocks) {
      return createMockAssistantContinuationProvider();
    }
    return new UnavailableAssistantContinuationProvider(
      "OPENAI_COMPATIBLE Chat configuration and OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT are required for assistant continuation."
    );
  }
  return new OpenAICompatibleAssistantContinuationProvider(
    {
      provider: "openai-compatible-assistant-continuation",
      apiKey,
      baseUrl,
      model: chatModel,
      includeRawResponse: config.includeRawProviderResponses
    },
    assistantContinuationFormat
  );
}

function resolveReasoningProvider(config: ProviderRegistryConfig): ReasoningProvider {
  return new FallbackReasoningProvider(
    createProviderChain(
      config,
      "reasoning",
      reasoningProviderFactories,
      createMockReasoningProvider,
      (name) =>
        new UnavailableReasoningProvider(
          name,
          unavailableProviderMessage("reasoning", name, config)
        )
    ),
    config.defaults.reasoning
  );
}

function resolveTTSProvider(config: ProviderRegistryConfig): TTSProvider {
  return new FallbackTTSProvider(
    createProviderChain(
      config,
      "tts",
      ttsProviderFactories,
      createMockTTSProvider,
      (name) => new UnavailableTTSProvider(name, unavailableProviderMessage("tts", name, config))
    ),
    config.defaults.tts
  );
}

function resolveSTTProvider(config: ProviderRegistryConfig): STTProvider {
  return new FallbackSTTProvider(
    createProviderChain(
      config,
      "stt",
      sttProviderFactories,
      createMockSTTProvider,
      (name) => new UnavailableSTTProvider(name, unavailableProviderMessage("stt", name, config))
    ),
    config.defaults.stt
  );
}

function resolveVisionProvider(config: ProviderRegistryConfig): VisionProvider {
  return new FallbackVisionProvider(
    createProviderChain(
      config,
      "vision",
      visionProviderFactories,
      createMockVisionProvider,
      (name) =>
        new UnavailableVisionProvider(name, unavailableProviderMessage("vision", name, config))
    ),
    config.defaults.vision
  );
}

function resolveEmbeddingProvider(config: ProviderRegistryConfig): EmbeddingProvider {
  return new FallbackEmbeddingProvider(
    createProviderChain(
      config,
      "embedding",
      embeddingProviderFactories,
      () => new MockEmbeddingProvider(config.embedding.dimensions),
      (name) =>
        new UnavailableEmbeddingProvider(
          name,
          config.embedding.dimensions,
          unavailableProviderMessage("embedding", name, config)
        )
    ),
    config.defaults.embedding
  );
}

function unavailableProviderMessage(
  capability: ProviderCapability,
  name: string,
  config: ProviderRegistryConfig
): string {
  const fields = missingFieldsForConfig(capability, name, config);
  const missing = fields.length ? " Missing required credentials or model configuration." : "";
  return `${name} ${capability} provider is unavailable.${missing} Configure Provider → Model → Capability Route in Product configuration and use Save & apply, or set PROVIDER_ALLOW_MOCKS=true for intentional offline/mock mode.`;
}

function missingFieldsForConfig(
  capability: ProviderCapability,
  name: string,
  config: ProviderRegistryConfig
): string[] {
  if ((capability === "chat" || capability === "reasoning") && name === "deepseek") {
    return [
      ...(!config.deepseek.apiKey ? ["DEEPSEEK_API_KEY"] : []),
      ...(capability === "chat" && !config.deepseek.chatModel ? ["DEEPSEEK_CHAT_MODEL"] : []),
      ...(capability === "reasoning" && !config.deepseek.reasoningModel
        ? ["DEEPSEEK_REASONING_MODEL"]
        : [])
    ];
  }
  if ((capability === "chat" || capability === "reasoning") && name === "openai-compatible") {
    return [
      ...(!config.openaiCompatible.baseUrl ? ["OPENAI_COMPATIBLE_API_BASEURL"] : []),
      ...(!config.openaiCompatible.apiKey ? ["OPENAI_COMPATIBLE_API_KEY"] : []),
      ...(capability === "chat" && !config.openaiCompatible.chatModel
        ? ["OPENAI_COMPATIBLE_CHAT_MODEL"]
        : []),
      ...(capability === "reasoning" && !config.openaiCompatible.reasoningModel
        ? ["OPENAI_COMPATIBLE_REASONING_MODEL"]
        : [])
    ];
  }
  if (name === "nvidia") {
    return [
      ...(!config.nvidia.apiKey ? ["NVIDIA_API_KEY"] : []),
      ...(capability === "chat" && !config.nvidia.chatModel ? ["NVIDIA_CHAT_MODEL"] : []),
      ...(capability === "reasoning" && !config.nvidia.reasoningModel
        ? ["NVIDIA_REASONING_MODEL"]
        : []),
      ...(capability === "embedding" && !config.nvidia.embeddingModel
        ? ["NVIDIA_EMBEDDING_MODEL"]
        : []),
      ...(capability === "vision" && !config.nvidia.visionModel ? ["NVIDIA_VISION_MODEL"] : [])
    ];
  }
  if (name === "local") {
    return [
      ...(capability === "stt"
        ? !config.local.sttBaseUrl
          ? ["LOCAL_STT_BASE_URL"]
          : []
        : capability !== "tts" && !config.local.baseUrl
          ? ["LOCAL_MODEL_BASEURL"]
          : []),
      ...(capability === "chat" && !config.local.chatModel ? ["LOCAL_CHAT_MODEL"] : []),
      ...(capability === "reasoning" && !config.local.reasoningModel
        ? ["LOCAL_REASONING_MODEL"]
        : []),
      ...(capability === "embedding" && !config.local.embeddingModel
        ? ["LOCAL_EMBEDDING_MODEL"]
        : []),
      ...(capability === "tts" && !config.local.ttsModel ? ["LOCAL_TTS_MODEL"] : []),
      ...(capability === "stt" && !config.local.sttModel ? ["LOCAL_STT_MODEL"] : []),
      ...(capability === "vision" && !config.local.visionModel ? ["LOCAL_VISION_MODEL"] : [])
    ];
  }
  if (capability === "tts" && name === "xai") {
    return [
      ...(!config.xai.apiKey ? ["XAI_API_KEY"] : []),
      ...(!config.xai.ttsModel ? ["XAI_TTS_MODEL"] : [])
    ];
  }
  if (capability === "vision" && name === "xai") {
    return [
      ...(!config.xai.apiKey ? ["XAI_API_KEY"] : []),
      ...(!config.xai.visionModel ? ["XAI_VISION_MODEL"] : [])
    ];
  }
  if (capability === "stt" && name === "dashscope") {
    return [
      ...(!config.dashscope.apiKey ? ["DASHSCOPE_API_KEY"] : []),
      ...(!config.dashscope.sttModel ? ["DASHSCOPE_STT_MODEL"] : [])
    ];
  }
  if (capability === "embedding" && name === "openai-compatible") {
    return [
      ...(!config.embedding.apiKey ? ["EMBEDDING_API_KEY"] : []),
      ...(!config.embedding.model ? ["EMBEDDING_MODEL"] : [])
    ];
  }
  return [];
}

function resolveConfiguredProvider<TProvider>(input: {
  config: ProviderRegistryConfig;
  capability: "chat" | "reasoning" | "tts" | "stt" | "vision" | "embedding";
  name: string;
  factories: Record<string, ProviderFactory<TProvider>>;
  createMock(name: string): TProvider;
  createUnavailable(name: string): TProvider;
}): TProvider {
  const provider = input.config.product
    ? productAdapter(input.config, input.capability, input.name) as TProvider | undefined
    : input.factories[input.name]?.(input.config);
  if (provider) {
    return provider;
  }

  if (input.config.allowMocks && input.name === "mock") {
    return input.createMock(input.name);
  }

  return input.createUnavailable(input.name);
}

function createProviderChain<TProvider>(
  config: ProviderRegistryConfig,
  capability: ProviderCapability,
  factories: Record<string, ProviderFactory<TProvider>>,
  createMock: (name: string) => TProvider,
  createUnavailable: (name: string) => TProvider
): TProvider[] {
  const chain = config.chains[capability];
  const providers = chain.map((name) =>
    resolveConfiguredProvider({
      config,
      capability,
      name,
      factories,
      createMock,
      createUnavailable
    })
  );
  return providers.length > 0 ? providers : [createUnavailable("unavailable")];
}

export class FallbackChatProvider implements ChatProvider {
  readonly name: string;
  // Diagnostic projection of the preferred route; the fallback chain still
  // evaluates each provider's actual stream capability at execution time.
  readonly streamingMode: ChatStreamingMode;

  constructor(
    private readonly providers: ChatProvider[],
    name?: string
  ) {
    this.name = name ?? providers[0]?.name ?? "unavailable";
    this.streamingMode = providers[0] ? getChatStreamingMode(providers[0]) : "unsupported";
  }

  async healthCheck(): Promise<ProviderHealth> {
    return (
      this.providers[0]?.healthCheck() ??
      providerHealth("unavailable", "unavailable", "No chat providers configured.")
    );
  }

  async generateReply(input: ChatInput, options?: ProviderCallOptions): Promise<ChatOutput> {
    return runProviderChain(
      this.providers,
      "chat",
      (provider) => provider.generateReply(input, options),
      options
    );
  }

  async *streamReply(
    input: ChatInput,
    options: ChatStreamOptions = {}
  ): AsyncIterable<ChatStreamEvent> {
    yield* runProviderStreamChain(this.providers, input, options);
  }
}

export class FallbackReasoningProvider implements ReasoningProvider {
  readonly name: string;

  constructor(
    private readonly providers: ReasoningProvider[],
    name?: string
  ) {
    this.name = name ?? providers[0]?.name ?? "unavailable";
  }

  async healthCheck(): Promise<ProviderHealth> {
    return (
      this.providers[0]?.healthCheck() ??
      providerHealth("unavailable", "unavailable", "No reasoning providers configured.")
    );
  }

  async generateReasoning(
    input: ReasoningInput,
    options?: ReasoningCallOptions
  ): Promise<ReasoningOutput> {
    return runProviderChain(
      options?.allowFallback === false ? this.providers.slice(0, 1) : this.providers,
      "reasoning",
      (provider) => provider.generateReasoning(input, options),
      options
    );
  }
}

export class FallbackTTSProvider implements TTSProvider {
  readonly name: string;

  constructor(
    private readonly providers: TTSProvider[],
    name?: string
  ) {
    this.name = name ?? providers[0]?.name ?? "unavailable";
  }

  async healthCheck(): Promise<ProviderHealth> {
    return (
      this.providers[0]?.healthCheck() ??
      providerHealth("unavailable", "unavailable", "No TTS providers configured.")
    );
  }

  async synthesizeSpeech(input: TTSInput, options?: ProviderCallOptions): Promise<TTSOutput> {
    return runProviderChain(
      this.providers,
      "tts",
      (provider) => provider.synthesizeSpeech(input, options),
      options
    );
  }
}

export class FallbackSTTProvider implements STTProvider {
  readonly name: string;

  get voiceProfiles() {
    return this.providers.find((provider) => provider.voiceProfiles)?.voiceProfiles;
  }

  constructor(
    private readonly providers: STTProvider[],
    name?: string
  ) {
    this.name = name ?? providers[0]?.name ?? "unavailable";
  }

  async healthCheck(): Promise<ProviderHealth> {
    return (
      this.providers[0]?.healthCheck() ??
      providerHealth("unavailable", "unavailable", "No STT providers configured.")
    );
  }

  async transcribeAudio(input: STTInput, options?: ProviderCallOptions): Promise<STTOutput> {
    return runProviderChain(
      this.providers,
      "stt",
      (provider) => provider.transcribeAudio(input, options),
      options
    );
  }

  async detectVoiceActivity(
    input: VoiceActivityInput,
    options?: ProviderCallOptions
  ): Promise<VoiceActivityOutput> {
    const capable = this.providers.find(
      (provider) => typeof provider.detectVoiceActivity === "function"
    );
    if (!capable?.detectVoiceActivity) {
      throw new ProviderError({
        provider: this.name,
        capability: "stt",
        code: ProviderErrorCode.ProviderUnavailable,
        message: "Live speech activity requires the local STT sidecar Silero VAD.",
        retryable: false
      });
    }
    return capable.detectVoiceActivity(input, options);
  }
}

export class FallbackVisionProvider implements VisionProvider {
  readonly name: string;

  constructor(
    private readonly providers: VisionProvider[],
    name?: string
  ) {
    this.name = name ?? providers[0]?.name ?? "unavailable";
  }

  async healthCheck(): Promise<ProviderHealth> {
    return (
      this.providers[0]?.healthCheck() ??
      providerHealth("unavailable", "unavailable", "No vision providers configured.")
    );
  }

  get implemented(): boolean {
    return Boolean(this.providers[0] && this.providers[0].implemented !== false);
  }

  async analyzeImage(input: VisionInput, options?: VisionCallOptions): Promise<VisionOutput> {
    return runProviderChain(
      options?.allowFallback === false ? this.providers.slice(0, 1) : this.providers,
      "vision",
      (provider) => provider.analyzeImage(input, options),
      options
    );
  }
}

export class FallbackEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly model: string | undefined;
  readonly mock: boolean | undefined;

  constructor(
    private readonly providers: EmbeddingProvider[],
    name?: string
  ) {
    const first = providers[0];
    this.name = name ?? first?.name ?? "unavailable";
    this.dimensions = first?.dimensions ?? 1536;
    this.model = first?.model;
    this.mock = first?.mock;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return (
      this.providers[0]?.healthCheck() ??
      providerHealth("unavailable", "unavailable", "No embedding providers configured.")
    );
  }

  async embedText(text: string, options?: ProviderCallOptions): Promise<number[]> {
    const output = await runProviderChain(
      this.providers,
      "embedding",
      async (provider) => ({
        vector: await provider.embedText(text, options),
        model: provider.model
      }),
      options
    );
    return output.vector;
  }

  async embedBatch(texts: string[], options?: ProviderCallOptions): Promise<number[][]> {
    const output = await runProviderChain(
      this.providers,
      "embedding",
      async (provider) => ({
        vectors: await provider.embedBatch(texts, options),
        model: provider.model
      }),
      options
    );
    return output.vectors;
  }
}

async function runProviderChain<
  TProvider extends { name: string },
  TOutput extends {
    model?: string | undefined;
    latencyMs?: number | undefined;
    providerMetadata?: Record<string, unknown> | undefined;
    fallbackUsed?: boolean | undefined;
    attemptedProviders?: ProviderAttempt[] | undefined;
    finalProvider?: string | undefined;
  }
>(
  providers: TProvider[],
  capability: ProviderCapability,
  operation: (provider: TProvider) => Promise<TOutput>,
  options?: ProviderCallOptions
): Promise<TOutput> {
  const attempts: ProviderAttempt[] = [];
  let lastError: ProviderError | undefined;
  const initialProvider = providers[0]?.name;

  for (const [index, provider] of providers.entries()) {
    if (options?.signal?.aborted) {
      throw attachAttemptedProviders(
        createCancelledError(provider.name, undefined, {
          capability,
          effectState: "not_started"
        }),
        attempts
      );
    }

    const startedAt = performance.now();
    try {
      const output = await operation(provider);
      if (options?.signal?.aborted) {
        throw createCancelledError(provider.name, undefined, {
          capability,
          effectState: "unknown"
        });
      }
      const latencyMs = Math.round(performance.now() - startedAt);
      attempts.push({
        provider: provider.name,
        model: output.model,
        status: "success",
        latencyMs: output.latencyMs ?? latencyMs,
        enabled: true,
        priority: index + 1
      });
      const fallbackUsed = didUseProviderFallback(provider.name, initialProvider);
      return {
        ...output,
        fallbackUsed,
        attemptedProviders: attempts,
        finalProvider: provider.name,
        providerMetadata: {
          ...(output.providerMetadata ?? {}),
          fallbackUsed,
          attemptedProviders: attempts,
          finalProvider: provider.name
        }
      };
    } catch (error) {
      const providerError = normalizeProviderError(error, {
        provider: provider.name,
        capability,
        signal: options?.signal
      });
      lastError = providerError;
      attempts.push(failedProviderAttempt(providerError, provider.name, index, startedAt, error));

      if (options?.signal?.aborted) {
        throw attachAttemptedProviders(
          normalizeProviderError(providerError, {
            provider: provider.name,
            capability,
            signal: options.signal,
            effectState: providerError.effectState
          }),
          attempts
        );
      }
      const anotherProviderExists = index < providers.length - 1;
      if (
        !canFallbackProviderError(providerError, {
          signal: options?.signal,
          anotherProviderExists
        })
      ) {
        if (
          !anotherProviderExists &&
          canFallbackProviderError(providerError, {
            signal: options?.signal,
            anotherProviderExists: true
          })
        ) {
          throw createExhaustedChainError(capability, attempts, providerError, provider.name);
        }
        throw attachAttemptedProviders(providerError, attempts);
      }
    }
  }

  throw createExhaustedChainError(capability, attempts, lastError, providers[0]?.name);
}

export function getChatStreamingMode(provider: ChatProvider): ChatStreamingMode {
  return provider.streamingMode ?? (provider.streamReply ? "native" : "compatible");
}

async function* runProviderStreamChain(
  providers: ChatProvider[],
  input: ChatInput,
  options: ChatStreamOptions
): AsyncIterable<ChatStreamEvent> {
  const attempts: ProviderAttempt[] = [];
  let lastError: ProviderError | undefined;
  const initialProvider = providers[0]?.name;

  for (const [index, provider] of providers.entries()) {
    if (options.signal?.aborted) {
      throw attachAttemptedProviders(
        createCancelledError(provider.name, undefined, { effectState: "not_started" }),
        attempts
      );
    }

    const startedAt = performance.now();
    let emittedText = false;
    let completion: ChatOutput | undefined;

    try {
      const stream = streamProvider(provider, input, options);
      let text = "";

      for await (const event of stream) {
        if (options.signal?.aborted) {
          throw createCancelledError(provider.name, undefined, {
            effectState: emittedText || completion ? "committed" : "unknown"
          });
        }
        if (completion) {
          throw streamProtocolError(provider.name, "Stream emitted an event after completed.");
        }

        if (event?.type === "text-delta") {
          if (!event.text) {
            throw streamProtocolError(provider.name, "Stream emitted an empty text delta.");
          }
          emittedText = true;
          text += event.text;
          yield event;
          continue;
        }

        if (event?.type === "completed") {
          completion = event.output;
          if (completion.message.content !== text) {
            throw streamProtocolError(
              provider.name,
              "Completed output did not match the concatenated text deltas."
            );
          }
          continue;
        }

        throw streamProtocolError(provider.name, "Stream emitted an unknown event.");
      }

      if (!completion) {
        throw streamProtocolError(provider.name, "Stream ended without a completed event.");
      }

      const latencyMs = Math.round(performance.now() - startedAt);
      const providerAttempt: ProviderAttempt = {
        provider: provider.name,
        model: completion.model,
        status: "success",
        latencyMs: completion.latencyMs ?? latencyMs,
        enabled: true,
        priority: index + 1
      };
      attempts.push(providerAttempt);
      const fallbackUsed = didUseProviderFallback(provider.name, initialProvider);
      const output: ChatOutput = {
        ...completion,
        fallbackUsed,
        attemptedProviders: attempts,
        finalProvider: provider.name,
        providerMetadata: {
          ...(completion.providerMetadata ?? {}),
          fallbackUsed,
          attemptedProviders: attempts,
          finalProvider: provider.name
        }
      };

      if (options.signal?.aborted) {
        throw createCancelledError(provider.name, undefined, { effectState: "committed" });
      }
      yield { type: "completed", output };
      return;
    } catch (error) {
      let providerError = normalizeStreamError(error, provider.name, options.signal);
      if (emittedText || completion) {
        providerError = cloneProviderError(providerError, { effectState: "committed" });
      }
      lastError = providerError;
      attempts.push(
        failedProviderAttempt(providerError, provider.name, index, startedAt, providerError)
      );
      const attached = attachAttemptedProviders(providerError, attempts);
      const anotherProviderExists = index < providers.length - 1;
      const fallbackContext = {
        signal: options.signal,
        anotherProviderExists,
        visibleOutput: emittedText,
        completed: Boolean(completion)
      };

      if (!canFallbackProviderError(providerError, fallbackContext)) {
        if (
          !anotherProviderExists &&
          canFallbackProviderError(providerError, {
            ...fallbackContext,
            anotherProviderExists: true
          })
        ) {
          throw createExhaustedChainError("chat", attempts, providerError, provider.name);
        }
        throw attached;
      }
    }
  }

  throw createExhaustedChainError("chat", attempts, lastError, providers[0]?.name);
}

function streamProvider(
  provider: ChatProvider,
  input: ChatInput,
  options: ChatStreamOptions
): AsyncIterable<ChatStreamEvent> {
  if (provider.streamingMode === "unsupported") {
    throw unavailableError(provider.name, "chat", "Streaming is not supported by this provider.");
  }
  return provider.streamReply
    ? provider.streamReply(input, options)
    : adaptNonStreamingProvider(provider, input, options);
}

async function* adaptNonStreamingProvider(
  provider: ChatProvider,
  input: ChatInput,
  options: ChatStreamOptions
): AsyncIterable<ChatStreamEvent> {
  if (options.signal?.aborted) {
    throw createCancelledError(provider.name);
  }
  // A legacy generateReply() may already own a network request that cannot be
  // physically aborted. Once its promise settles, the adapter only guarantees
  // that no further output, fallback, or completed event is produced.
  const output = await provider.generateReply(input, options);
  if (options.signal?.aborted) {
    throw createCancelledError(provider.name);
  }
  if (output.message.content) {
    yield { type: "text-delta", text: output.message.content };
  }
  if (options.signal?.aborted) {
    throw createCancelledError(provider.name);
  }
  yield { type: "completed", output };
}

function normalizeStreamError(
  error: unknown,
  provider: string,
  signal?: AbortSignal | undefined
): ProviderError {
  if (signal?.aborted) {
    return createCancelledError(provider, error);
  }
  if (error instanceof ProviderError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProviderError({
      provider,
      capability: "chat",
      code: ProviderErrorCode.Timeout,
      message: "Chat stream timed out.",
      cause: error
    });
  }
  return normalizeProviderError(error, { provider, capability: "chat" });
}

function createCancelledError(
  provider: string,
  cause?: unknown,
  options?: {
    capability?: ProviderCapability;
    effectState?: ProviderEffectState;
  }
): ProviderError {
  const capability = options?.capability ?? "chat";
  return new ProviderError({
    provider,
    capability,
    code: ProviderErrorCode.Cancelled,
    message:
      capability === "chat"
        ? "Chat stream was cancelled."
        : `${provider} ${capability} was cancelled.`,
    retryable: false,
    fallbackEligible: false,
    effectState: options?.effectState ?? "unknown",
    cause
  });
}

function streamProtocolError(provider: string, message: string): ProviderError {
  return new ProviderError({
    provider,
    capability: "chat",
    code: ProviderErrorCode.MalformedResponse,
    message,
    retryable: false
  });
}

function attachAttemptedProviders(
  error: ProviderError,
  attempts: ProviderAttempt[]
): ProviderError {
  if (error.attemptedProviders === attempts) {
    return error;
  }
  return cloneProviderError(error, { attemptedProviders: attempts });
}

function didUseProviderFallback(
  successfulProvider: string,
  initialProvider: string | undefined
): boolean {
  return Boolean(initialProvider && successfulProvider !== initialProvider);
}

function failedProviderAttempt(
  providerError: ProviderError,
  fallbackProvider: string,
  index: number,
  startedAt: number,
  source: unknown
): ProviderAttempt {
  return {
    provider: providerError.provider || fallbackProvider,
    status:
      providerError.code === ProviderErrorCode.ProviderUnavailable &&
      providerError.statusCode === undefined
        ? "unavailable"
        : "failed",
    errorCode: providerError.code,
    error:
      source instanceof ProviderError
        ? safeProviderErrorMessage(providerError)
        : providerError.message,
    latencyMs: Math.round(performance.now() - startedAt),
    enabled: true,
    priority: index + 1
  };
}

function createExhaustedChainError(
  capability: ProviderCapability,
  attempts: ProviderAttempt[],
  lastError: ProviderError | undefined,
  fallbackProvider: string | undefined
): ProviderError {
  const message = `All ${capability} providers failed: ${attempts
    .map((attempt) => `${attempt.provider}:${attempt.errorCode ?? attempt.status}`)
    .join(", ")}`;
  if (lastError) {
    return cloneProviderError(lastError, {
      message,
      cause: lastError,
      attemptedProviders: attempts
    });
  }
  return new ProviderError({
    provider: fallbackProvider ?? "provider-chain",
    capability,
    code: ProviderErrorCode.ProviderUnavailable,
    message,
    retryable: false,
    fallbackEligible: true,
    effectState: "not_started",
    attemptedProviders: attempts
  });
}

class UnimplementedChatProvider implements ChatProvider {
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async generateReply(): Promise<ChatOutput> {
    throw unavailableError(this.name, "chat", this.message);
  }
}

class UnimplementedReasoningProvider implements ReasoningProvider {
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async generateReasoning(): Promise<ReasoningOutput> {
    throw unavailableError(this.name, "reasoning", this.message);
  }
}

class UnimplementedTTSProvider implements TTSProvider {
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async synthesizeSpeech(): Promise<TTSOutput> {
    throw unavailableError(this.name, "tts", this.message);
  }
}

class UnimplementedSTTProvider implements STTProvider {
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async transcribeAudio(): Promise<STTOutput> {
    throw unavailableError(this.name, "stt", this.message);
  }
}

class UnimplementedVisionProvider implements VisionProvider {
  readonly implemented = false;
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async analyzeImage(): Promise<VisionOutput> {
    throw unavailableError(this.name, "vision", this.message);
  }
}

class UnimplementedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    readonly name: string,
    readonly dimensions: number,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async embedText(_text: string): Promise<number[]> {
    throw unavailableError(this.name, "embedding", this.message);
  }

  async embedBatch(_texts: string[]): Promise<number[][]> {
    throw unavailableError(this.name, "embedding", this.message);
  }
}

class UnavailableChatProvider extends UnimplementedChatProvider {}
class UnavailableReasoningProvider extends UnimplementedReasoningProvider {}
class UnavailableTTSProvider extends UnimplementedTTSProvider {}
class UnavailableSTTProvider extends UnimplementedSTTProvider {}
class UnavailableVisionProvider extends UnimplementedVisionProvider {}
class UnavailableEmbeddingProvider extends UnimplementedEmbeddingProvider {}

class UnavailableProactiveDecisionProvider implements ProactiveDecisionProvider {
  readonly name = "unavailable-proactive-decision";

  constructor(private readonly message: string) {}

  async decide(): Promise<never> {
    throw unavailableError(this.name, "chat", this.message);
  }
}

class UnavailableAssistantContinuationProvider implements AssistantContinuationProvider {
  readonly name = "unavailable-assistant-continuation";

  constructor(private readonly message: string) {}

  async generateContinuation(): Promise<never> {
    throw unavailableError(this.name, "chat", this.message);
  }
}

type OpenAICompatibleTextOptions = {
  temperature?: number;
  provider: string;
  apiKey?: string | undefined;
  baseUrl: string;
  model: string;
  includeRawResponse?: boolean | undefined;
};

function formatAssistantContinuationPrompt(prompt: string, format: "deepseek-v4"): string {
  const safePrompt = prompt
    .trim()
    .replaceAll("<｜", "<\u200b｜")
    .replaceAll("<think>", "<\u200bthink>")
    .replaceAll("</think>", "</\u200bthink>");
  if (!safePrompt) {
    throw new ProviderError({
      provider: "openai-compatible-assistant-continuation",
      capability: "chat",
      code: ProviderErrorCode.MalformedResponse,
      message: "Assistant continuation prompt must not be empty.",
      retryable: false
    });
  }
  if (format === "deepseek-v4") {
    return `<｜begin▁of▁sentence｜>${safePrompt}<｜Assistant｜></think>`;
  }
  return safePrompt;
}

class OpenAICompatibleProactiveDecisionProvider implements ProactiveDecisionProvider {
  readonly name: string;

  constructor(private readonly options: OpenAICompatibleTextOptions) {
    this.name = options.provider;
  }

  async decide(
    input: { prompt: string },
    options?: ProviderCallOptions
  ): Promise<ProactiveDecisionOutput> {
    const completion = await createOpenAICompatibleChatCompletion(
      this.options,
      "chat",
      {
        messages: [
          { role: "system", content: input.prompt },
          {
            role: "user",
            content:
              'Return exactly one JSON object: {"score": number}. Score must be finite and normalized from 0 to 1. No prose.'
          }
        ],
        temperature: 0,
        maxTokens: 32,
        stopSequences: ["\n"]
      },
      options
    );
    let score: unknown;
    try {
      const decoded: unknown = JSON.parse(completion.content.trim());
      if (
        decoded &&
        typeof decoded === "object" &&
        !Array.isArray(decoded) &&
        Object.keys(decoded).length === 1 &&
        "score" in decoded
      )
        score = decoded.score;
    } catch {
      /* fail closed below */
    }
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new ProviderError({
        provider: this.name,
        capability: "chat",
        code: ProviderErrorCode.MalformedResponse,
        message: `${this.name} returned an invalid proactive decision.`,
        retryable: false
      });
    }
    return {
      score,
      model: completion.model,
      latencyMs: completion.latencyMs,
      tokenUsage: completion.tokenUsage,
      debug: completion.rawResponse ? { rawResponse: completion.rawResponse } : undefined
    };
  }
}

class OpenAICompatibleAssistantContinuationProvider implements AssistantContinuationProvider {
  readonly name: string;

  constructor(
    private readonly options: OpenAICompatibleTextOptions,
    private readonly format: "deepseek-v4"
  ) {
    this.name = options.provider;
  }

  async generateContinuation(
    input: AssistantContinuationInput,
    options?: ProviderCallOptions
  ): Promise<ChatOutput> {
    const completion = await createOpenAICompatibleRawCompletion(
      this.options,
      {
        prompt: formatAssistantContinuationPrompt(input.prompt, this.format),
        maxTokens: input.maxTokens,
        stopSequences: ["<｜end▁of▁sentence｜>"]
      },
      options
    );
    return {
      message: { role: "assistant", content: completion.content },
      finishReason: completion.finishReason,
      model: completion.model,
      latencyMs: completion.latencyMs,
      tokenUsage: completion.tokenUsage,
      debug: completion.rawResponse ? { rawResponse: completion.rawResponse } : undefined
    };
  }
}

class OpenAICompatibleChatProvider implements ChatProvider {
  readonly name: string;
  readonly streamingMode = "native" as const;

  constructor(private readonly options: OpenAICompatibleTextOptions) {
    this.name = options.provider;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      name: this.name,
      capability: "chat",
      configured: true,
      available: true,
      mock: false,
      required: false,
      baseUrl: this.options.baseUrl,
      model: this.options.model,
      status: "degraded",
      checkedAt: new Date().toISOString(),
      message: `${this.name} chat provider is configured but not verified by health check.`
    };
  }

  async generateReply(input: ChatInput, options?: ProviderCallOptions): Promise<ChatOutput> {
    const completion = await createOpenAICompatibleChatCompletion(
      this.options,
      "chat",
      {
        messages: input.messages,
        temperature: input.temperature ?? this.options.temperature,
        maxTokens: input.maxTokens ?? input.maxOutputTokens,
        stopSequences: input.stopSequences
      },
      options
    );
    return {
      message: { role: "assistant", content: completion.content },
      finishReason: completion.finishReason,
      model: completion.model,
      latencyMs: completion.latencyMs,
      tokenUsage: completion.tokenUsage,
      debug: completion.rawResponse ? { rawResponse: completion.rawResponse } : undefined
    };
  }

  streamReply(input: ChatInput, options: ChatStreamOptions = {}) {
    return streamOpenAICompatibleChatCompletion(this.options, "chat", { ...input, temperature: input.temperature ?? this.options.temperature }, options);
  }
}

class OpenAICompatibleReasoningProvider implements ReasoningProvider {
  readonly name: string;

  constructor(private readonly options: OpenAICompatibleTextOptions) {
    this.name = options.provider;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      name: this.name,
      capability: "reasoning",
      configured: true,
      available: true,
      mock: false,
      required: false,
      baseUrl: this.options.baseUrl,
      model: this.options.model,
      status: "degraded",
      checkedAt: new Date().toISOString(),
      message: `${this.name} reasoning provider is configured but not verified by health check.`
    };
  }

  async generateReasoning(
    input: ReasoningInput,
    options?: ProviderCallOptions
  ): Promise<ReasoningOutput> {
    const completion = await createOpenAICompatibleChatCompletion(
      this.options,
      "reasoning",
      {
        messages: input.messages,
        temperature: input.temperature ?? this.options.temperature,
        maxTokens: input.maxTokens ?? input.maxOutputTokens
      },
      options
    );
    return normalizeReasoningOutput(this.name, {
      // OpenAI-compatible reasoning_content is provider-internal trace and
      // is intentionally discarded at the normalized boundary.
      answer: completion.content,
      finishReason: completion.finishReason,
      model: completion.model,
      latencyMs: completion.latencyMs,
      tokenUsage: completion.tokenUsage
    });
  }
}

class OpenAICompatibleEmbeddingProvider extends UnimplementedEmbeddingProvider {
  readonly model: string | undefined;
  readonly mock = false;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs = 30000;

  constructor(
    private readonly config: ProviderRegistryConfig,
    override?: {
      provider: string;
      apiKey?: string | undefined;
      baseUrl?: string | undefined;
      model?: string | undefined;
      dimensions?: number | undefined;
    }
  ) {
    super(
      override?.provider ?? "openai-compatible",
      override?.dimensions ?? config.embedding.dimensions,
      "OpenAI-compatible embeddings."
    );
    this.model = override?.model ?? config.embedding.model;
    this.apiKey = override?.apiKey ?? config.embedding.apiKey;
    this.baseUrl = override?.baseUrl ?? config.embedding.baseUrl ?? "https://api.openai.com/v1";
  }

  override async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      name: this.name,
      capability: "embedding",
      configured: Boolean(this.apiKey && this.model),
      available: Boolean(this.apiKey && this.model),
      mock: false,
      required: false,
      baseUrl: this.baseUrl,
      model: this.model,
      dimensions: this.dimensions,
      semanticEmbedding: true,
      status: this.apiKey && this.model ? "degraded" : "unavailable",
      checkedAt: new Date().toISOString(),
      message:
        this.apiKey && this.model
          ? "OpenAI-compatible embedding provider is configured but not verified by health check."
          : "EMBEDDING_API_KEY and EMBEDDING_MODEL are required for real embeddings."
    };
  }

  override async embedText(text: string, options?: ProviderCallOptions): Promise<number[]> {
    const [vector] = await this.embedBatch([text], options);
    return vector ?? [];
  }

  override async embedBatch(texts: string[], options?: ProviderCallOptions): Promise<number[][]> {
    const transport = createTransportAbort({
      signal: options?.signal,
      timeoutMs: this.timeoutMs
    });

    try {
      throwIfOpenAICompatibleTransportAborted(this.name, "embedding", transport);
      if (!this.apiKey && !this.config.product) {
        throw unavailableError(this.name, "embedding", "EMBEDDING_API_KEY is required.");
      }
      if (!this.model) {
        throw unavailableError(this.name, "embedding", "EMBEDDING_MODEL is required.");
      }

      if (!transport.markStarted()) {
        throwIfOpenAICompatibleTransportAborted(this.name, "embedding", transport);
        throw new Error("OpenAI-compatible embedding transport could not start.");
      }
      const response = await fetch(`${trimTrailingSlash(this.baseUrl)}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimensions
        }),
        signal: transport.signal
      });
      if (!response.ok) {
        throw await createOpenAICompatibleStatusError(this.name, "embedding", response);
      }
      const raw = (await parseOpenAICompatibleJsonResponse(this.name, "embedding", response)) as {
        data?: Array<{ embedding?: unknown; index?: number }>;
      };
      throwIfOpenAICompatibleTransportAborted(this.name, "embedding", transport);
      const vectors = raw.data
        ?.slice()
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        .map((item) => item.embedding)
        .filter(
          (embedding): embedding is number[] =>
            Array.isArray(embedding) && embedding.every((value) => typeof value === "number")
        );
      if (!vectors || vectors.length !== texts.length) {
        throw new ProviderError({
          provider: this.name,
          capability: "embedding",
          code: ProviderErrorCode.MalformedResponse,
          message: "Embedding response did not include one vector per input.",
          retryable: false
        });
      }
      return vectors.map((vector) =>
        transformLocalMrlEmbedding(this.name, this.model, this.dimensions, vector)
      );
    } catch (error) {
      if (transport.source !== null) {
        throw createOpenAICompatibleTransportAbortError(this.name, "embedding", transport);
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError({
        provider: this.name,
        capability: "embedding",
        code: ProviderErrorCode.NetworkError,
        message: "Embedding network request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }
}

const QWEN3_EMBEDDING_MRL_MODEL = "Qwen3-Embedding-0.6B-Q8_0.gguf";

function validateQwen512DurableEmbeddingConfig(config: ProviderRegistryConfig): void {
  if (
    config.defaults.embedding !== "local" ||
    config.local.embeddingModel !== QWEN3_EMBEDDING_MRL_MODEL ||
    config.local.embeddingDimensions !== 512
  ) {
    return;
  }

  if (config.chains.embedding.length !== 1 || config.chains.embedding[0] !== "local") {
    throw new ProviderError({
      provider: "registry",
      capability: "embedding",
      code: ProviderErrorCode.UnsupportedInput,
      message:
        "Qwen512 durable embedding contract requires DEFAULT_EMBEDDING_PROVIDER=local, " +
        "LOCAL_EMBEDDING_MODEL=Qwen3-Embedding-0.6B-Q8_0.gguf, " +
        "LOCAL_EMBEDDING_DIMENSIONS=512, and EMBEDDING_PROVIDER_CHAIN=local. " +
        "Heterogeneous embedding chains are not supported for this production embedding space.",
      retryable: false
    });
  }
}

function transformLocalMrlEmbedding(
  provider: string,
  model: string | undefined,
  dimensions: number,
  vector: number[]
): number[] {
  // llama-server currently returns the model's native embedding length even
  // when the OpenAI-compatible request includes `dimensions`. Keep the MRL
  // transform at the existing local-provider boundary so Core and Memory see
  // only the configured production dimension.
  if (provider !== "local" || model !== QWEN3_EMBEDDING_MRL_MODEL || dimensions !== 512) {
    return vector;
  }

  const prefix = vector.slice(0, dimensions);
  if (prefix.length !== dimensions || prefix.some((value) => !Number.isFinite(value))) {
    throw malformedLocalMrlEmbedding(
      provider,
      "Embedding prefix is shorter than 512 or non-finite."
    );
  }

  const norm = Math.sqrt(prefix.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    throw malformedLocalMrlEmbedding(provider, "Embedding prefix has no finite non-zero norm.");
  }

  const normalized = prefix.map((value) => value / norm);
  const normalizedNorm = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
  if (
    normalized.length !== dimensions ||
    normalized.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(normalizedNorm) ||
    Math.abs(normalizedNorm - 1) > 1e-6
  ) {
    throw malformedLocalMrlEmbedding(
      provider,
      "Embedding normalization did not produce a finite unit vector."
    );
  }

  return normalized;
}

function malformedLocalMrlEmbedding(provider: string, message: string): ProviderError {
  return new ProviderError({
    provider,
    capability: "embedding",
    code: ProviderErrorCode.MalformedResponse,
    message,
    retryable: false
  });
}

export function createMockChatProvider(name = "mock-chat"): ChatProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock chat provider is available.");
    },
    async generateReply(input: ChatInput) {
      const start = performance.now();
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const content = `Mock reply: ${lastUserMessage?.content ?? ""}`;

      return {
        message: { role: "assistant", content },
        latencyMs: Math.round(performance.now() - start),
        tokenUsage: {
          inputTokens: estimateTokenCount(
            input.messages.map((message) => message.content).join("\n")
          ),
          outputTokens: estimateTokenCount(content),
          totalTokens: estimateTokenCount(
            input.messages.map((message) => message.content).join("\n") + content
          )
        },
        finishReason: "stop"
      };
    }
  };
}

export function createMockProactiveDecisionProvider(
  decision: "NO_OP" | "REQUEST_TEXT" = "REQUEST_TEXT",
  name = "mock-proactive-decision"
): ProactiveDecisionProvider {
  return {
    name,
    async decide() {
      return { decision, model: "mock", latencyMs: 0 };
    }
  };
}

export function createMockAssistantContinuationProvider(
  content = "Mock proactive continuation.",
  name = "mock-assistant-continuation"
): AssistantContinuationProvider {
  return {
    name,
    async generateContinuation() {
      return {
        message: { role: "assistant", content },
        model: "mock",
        latencyMs: 0,
        finishReason: "stop"
      };
    }
  };
}

export type MockStreamingChatProviderOptions = {
  chunks?: string[];
  delayMs?: number;
  failBeforeFirst?: Error | (() => Error);
  failAfterChunks?: number;
  failAfter?: Error | (() => Error);
  output?: Partial<Omit<ChatOutput, "message">>;
};

function resolveMockStreamingFailure(
  failure: Error | (() => Error) | undefined
): Error | undefined {
  return typeof failure === "function" ? failure() : failure;
}

export function createMockStreamingChatProvider(
  name = "mock-stream-chat",
  options: MockStreamingChatProviderOptions = {}
): ChatProvider {
  return {
    name,
    streamingMode: "native",
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock streaming chat provider is available.");
    },
    async generateReply(input: ChatInput): Promise<ChatOutput> {
      if (options.failBeforeFirst) {
        throw resolveMockStreamingFailure(options.failBeforeFirst);
      }
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const chunks = options.chunks ?? [`Mock reply: ${lastUserMessage?.content ?? ""}`];
      return {
        ...options.output,
        message: { role: "assistant", content: chunks.join("") },
        finishReason: options.output?.finishReason ?? "stop"
      };
    },
    async *streamReply(
      input: ChatInput,
      streamOptions: ChatStreamOptions = {}
    ): AsyncIterable<ChatStreamEvent> {
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const chunks = options.chunks ?? [`Mock reply: ${lastUserMessage?.content ?? ""}`];

      if (streamOptions.signal?.aborted) {
        throw createCancelledError(name);
      }
      if (options.failBeforeFirst) {
        throw resolveMockStreamingFailure(options.failBeforeFirst);
      }

      let emittedChunks = 0;
      for (const chunk of chunks) {
        if (options.failAfterChunks !== undefined && emittedChunks >= options.failAfterChunks) {
          const afterFailure = resolveMockStreamingFailure(options.failAfter);
          throw afterFailure ?? new Error("Mock streaming provider failed after partial output.");
        }
        await waitForStreamDelay(options.delayMs ?? 0, streamOptions.signal, name);
        if (!chunk) {
          yield { type: "text-delta", text: chunk };
        } else {
          yield { type: "text-delta", text: chunk };
        }
        emittedChunks += 1;
      }

      const content = chunks.join("");
      yield {
        type: "completed",
        output: {
          ...options.output,
          message: { role: "assistant", content },
          finishReason: options.output?.finishReason ?? "stop"
        }
      };
    }
  };
}

async function waitForStreamDelay(
  delayMs: number,
  signal: AbortSignal | undefined,
  provider: string
): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) {
      throw createCancelledError(provider);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(createCancelledError(provider));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockReasoningProvider(name = "mock-reasoning"): ReasoningProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock reasoning provider is available.");
    },
    async generateReasoning(input: ReasoningInput) {
      const joined = input.messages.map((message) => message.content).join("\n");
      return normalizeReasoningOutput(name, {
        reasoning: "",
        answer: joined.slice(0, 256) || "Mock reasoning result.",
        latencyMs: 0,
        tokenUsage: { inputTokens: estimateTokenCount(joined), outputTokens: 4 }
      });
    }
  };
}

export function createMockTTSProvider(name = "mock-tts"): TTSProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock TTS provider is available.");
    },
    async synthesizeSpeech(_input: TTSInput) {
      return {
        audio: new Uint8Array(),
        audioBase64: "",
        mimeType: "audio/wav",
        durationMs: 0,
        model: "mock",
        latencyMs: 0
      };
    }
  };
}

export function createMockSTTProvider(name = "mock-stt"): STTProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock STT provider is available.");
    },
    async transcribeAudio(input: STTInput) {
      const metadataText = input.metadata?.["mockTranscription"];
      const text =
        typeof metadataText === "string" && metadataText.trim()
          ? metadataText
          : (decodeMockText(input.audioBase64) ?? "Mock transcription.");
      return {
        text,
        language: input.language,
        confidence: 1,
        model: "mock",
        latencyMs: 0
      };
    }
  };
}

export function createMockVisionProvider(name = "mock-vision"): VisionProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock vision provider is available.");
    },
    async analyzeImage(_input: VisionInput) {
      return {
        text: "Mock image analysis.",
        labels: [],
        model: "mock",
        latencyMs: 0
      };
    }
  };
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock";
  readonly mock = true;

  constructor(readonly dimensions: number) {}

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ...providerHealth(this.name, "healthy", "Mock embedding provider is available."),
      name: this.name,
      capability: "embedding",
      configured: true,
      available: true,
      mock: true,
      required: false,
      model: this.model,
      dimensions: this.dimensions,
      semanticEmbedding: false,
      embeddingNote:
        "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
    };
  }

  async embedText(text: string): Promise<number[]> {
    return stableMockVector(text, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embedText(text)));
  }
}

function providerHealth(
  provider: string,
  status: ProviderHealth["status"],
  message: string
): ProviderHealth {
  return {
    provider,
    status,
    checkedAt: new Date().toISOString(),
    message
  };
}

function unavailableError(
  provider: string,
  capability: "chat" | "reasoning" | "tts" | "stt" | "vision" | "embedding",
  message: string
): ProviderError {
  return new ProviderError({
    provider,
    capability,
    code: ProviderErrorCode.ProviderUnavailable,
    message,
    retryable: false
  });
}

type OpenAICompatibleChatCompletion = {
  content: string;
  reasoningContent?: string | undefined;
  finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "unknown" | undefined;
  model?: string | undefined;
  tokenUsage?: TokenUsage | undefined;
  rawResponse?: unknown | undefined;
  latencyMs: number;
};

type OpenAICompatibleUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
};

async function createOpenAICompatibleChatCompletion(
  options: OpenAICompatibleTextOptions,
  capability: "chat" | "reasoning",
  request: {
    messages: ChatInput["messages"];
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    stopSequences?: string[] | undefined;
  },
  callOptions?: ProviderCallOptions
): Promise<OpenAICompatibleChatCompletion> {
  const response = await createOpenAICompatibleJsonCompletion(
    options,
    capability,
    "/chat/completions",
    {
      model: options.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stop: request.stopSequences,
      stream: false
    },
    callOptions
  );
  const raw = response.raw as {
    model?: string;
    choices?: Array<{
      finish_reason?: string | null;
      message?: { content?: string | null; reasoning_content?: string | null };
    }>;
    usage?: OpenAICompatibleUsage;
  };
  const choice = raw.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    throw new ProviderError({
      provider: options.provider,
      capability,
      code: ProviderErrorCode.MalformedResponse,
      message: `${options.provider} ${capability} response did not include assistant content.`,
      retryable: false
    });
  }
  return {
    content,
    reasoningContent: choice?.message?.reasoning_content ?? undefined,
    finishReason: normalizeFinishReason(choice?.finish_reason),
    model: raw.model ?? options.model,
    latencyMs: response.latencyMs,
    tokenUsage: normalizeOpenAICompatibleUsage(raw.usage),
    rawResponse: options.includeRawResponse ? raw : undefined
  };
}

async function createOpenAICompatibleRawCompletion(
  options: OpenAICompatibleTextOptions,
  request: {
    prompt: string;
    maxTokens?: number | undefined;
    stopSequences?: string[] | undefined;
  },
  callOptions?: ProviderCallOptions
): Promise<OpenAICompatibleChatCompletion> {
  const response = await createOpenAICompatibleJsonCompletion(
    options,
    "chat",
    "/completions",
    {
      model: options.model,
      prompt: request.prompt,
      max_tokens: request.maxTokens,
      stop: request.stopSequences
    },
    callOptions
  );
  const raw = response.raw as {
    model?: string;
    choices?: Array<{ finish_reason?: string | null; text?: string | null }>;
    usage?: OpenAICompatibleUsage;
  };
  const choice = raw.choices?.[0];
  if (typeof choice?.text !== "string" || !choice.text.trim()) {
    throw new ProviderError({
      provider: options.provider,
      capability: "chat",
      code: ProviderErrorCode.MalformedResponse,
      message: `${options.provider} assistant continuation did not include meaningful text.`,
      retryable: false
    });
  }
  return {
    content: choice.text.trim(),
    finishReason: normalizeFinishReason(choice.finish_reason),
    model: raw.model ?? options.model,
    latencyMs: response.latencyMs,
    tokenUsage: normalizeOpenAICompatibleUsage(raw.usage),
    rawResponse: options.includeRawResponse ? raw : undefined
  };
}

async function createOpenAICompatibleJsonCompletion(
  options: OpenAICompatibleTextOptions,
  capability: "chat" | "reasoning",
  path: "/chat/completions" | "/completions",
  body: Record<string, unknown>,
  callOptions?: ProviderCallOptions
): Promise<{ raw: unknown; latencyMs: number }> {
  const transport = createTransportAbort({ signal: callOptions?.signal, timeoutMs: 30000 });

  try {
    throwIfOpenAICompatibleTransportAborted(options.provider, capability, transport);
    const startedAt = performance.now();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) {
      headers["authorization"] = `Bearer ${options.apiKey}`;
    }
    if (!transport.markStarted()) {
      throwIfOpenAICompatibleTransportAborted(options.provider, capability, transport);
      throw new Error("OpenAI-compatible transport could not start.");
    }
    const response = await fetch(`${trimTrailingSlash(options.baseUrl)}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: transport.signal
    });

    if (!response.ok) {
      throw await createOpenAICompatibleStatusError(options.provider, capability, response);
    }

    const raw = await parseOpenAICompatibleJsonResponse(options.provider, capability, response);
    throwIfOpenAICompatibleTransportAborted(options.provider, capability, transport);
    return { raw, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    if (transport.source !== null) {
      throw createOpenAICompatibleTransportAbortError(options.provider, capability, transport);
    }
    if (error instanceof ProviderError) {
      throw error;
    }
    throw new ProviderError({
      provider: options.provider,
      capability,
      code: ProviderErrorCode.NetworkError,
      message: `${options.provider} ${capability} network request failed.`,
      cause: error
    });
  } finally {
    transport.cleanup();
  }
}

function normalizeOpenAICompatibleUsage(
  usage: OpenAICompatibleUsage | undefined
): OpenAICompatibleChatCompletion["tokenUsage"] {
  if (!usage) return undefined;
  return {
    ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(typeof usage.prompt_tokens_details?.cached_tokens === "number" &&
    Number.isFinite(usage.prompt_tokens_details.cached_tokens)
      ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }
      : {})
  };
}

async function createOpenAICompatibleStatusError(
  provider: string,
  capability: ProviderCapability,
  response: Response
): Promise<ProviderError> {
  try {
    await response.text();
  } catch {
    // The outer transport winner check determines cancellation precedence.
  }

  return new ProviderError({
    provider,
    capability,
    code: mapHttpStatusToProviderErrorCode(response.status),
    statusCode: response.status,
    message: `${provider} ${capability} request failed with ${response.status}.`
  });
}

async function parseOpenAICompatibleJsonResponse(
  provider: string,
  capability: ProviderCapability,
  response: Response
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MalformedResponse,
      message: `${provider} ${capability} returned a non-JSON response.`,
      retryable: false,
      cause: error
    });
  }
}

function throwIfOpenAICompatibleTransportAborted(
  provider: string,
  capability: ProviderCapability,
  transport: TransportAbort
): void {
  if (transport.source !== null) {
    throw createOpenAICompatibleTransportAbortError(provider, capability, transport);
  }
}

function createOpenAICompatibleTransportAbortError(
  provider: string,
  capability: ProviderCapability,
  transport: TransportAbort
): ProviderError {
  if (transport.source === "caller") {
    return new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.Cancelled,
      message: `${provider} ${capability} was cancelled.`,
      retryable: false,
      fallbackEligible: false,
      effectState: transport.effectState ?? "unknown"
    });
  }

  return new ProviderError({
    provider,
    capability,
    code: ProviderErrorCode.Timeout,
    message: `${provider} ${capability} request timed out.`,
    effectState: transport.effectState ?? "unknown"
  });
}

function normalizeFinishReason(
  value: string | null | undefined
): OpenAICompatibleChatCompletion["finishReason"] {
  if (
    value === "stop" ||
    value === "length" ||
    value === "tool_call" ||
    value === "content_filter"
  ) {
    return value;
  }
  return value ? "unknown" : undefined;
}

function safeProviderErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/:\s*(?:\{|\[)[\s\S]*$/, "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._~+/=-]+/g, "sk-[REDACTED]")
    .replace(/(api[-_]?key|authorization|token|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 300);
}

function parseEnvironment(value: string | undefined): ProviderRegistryConfig["environment"] {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }

  return "development";
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "TRUE";
}

function parseAssistantContinuationFormat(value: string | undefined): "deepseek-v4" | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized === "deepseek-v4") return normalized;
  throw new Error(
    "OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT must be deepseek-v4 when configured."
  );
}

function parseProviderChain(
  value: string | undefined,
  fallback: string[],
  allowMocks: boolean
): string[] {
  const parsed = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const chain = parsed?.length ? parsed : fallback;
  return Array.from(new Set(chain.filter((provider) => allowMocks || provider !== "mock")));
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function parseBoundedNumber(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

function stableMockVector(text: string, dimensions: number): number[] {
  let seed = 2166136261;
  for (const char of text) {
    seed ^= char.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }

  return Array.from({ length: dimensions }, (_, index) => {
    const value = Math.sin(seed + index * 101) * 10000;
    return Number((value - Math.floor(value)).toFixed(6));
  });
}

function decodeMockText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8").trim();
    return decoded || undefined;
  } catch {
    return undefined;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Instantiate only adapters with a real implementation for the declared route. */
function createProductAdapter(config: ProviderRegistryConfig, cap: CapabilityRoute, id: string): ChatProvider | ReasoningProvider | ProactiveDecisionProvider | EmbeddingProvider | VisionProvider | STTProvider | TTSProvider | undefined {
  const m = config.product!.models.find(m => m.id === id);
  const p = config.product!.providers.find(p => p.id === m?.providerId);
  if (!m?.enabled || !p || !m.capabilities.includes(cap)) return undefined;
  const options = { provider: m.id, baseUrl: modelEndpoint(p.baseUrl), apiKey: p.apiKey, model: m.modelId, temperature: m.temperature };
  if (p.adapter === "openai-compatible") {
    if (cap === "chat") return new OpenAICompatibleChatProvider(options);
    if (cap === "reasoning") return new OpenAICompatibleReasoningProvider(options);
    if (cap === "proactive") return new OpenAICompatibleProactiveDecisionProvider(options);
    if (cap === "embedding") return new OpenAICompatibleEmbeddingProvider(config, { ...options, dimensions: m.dimensions });
    if (cap === "vision") return new XAIVisionProvider({ ...options, allowAnonymous: true });
  }
  // Preserve method receivers on specialized adapters while giving every model its own route identity.
  let adapter: STTProvider | TTSProvider | undefined;
  if (p.adapter === "local-stt") adapter = new LocalSTTProvider({ baseUrl: p.baseUrl, model: m.modelId });
  if (p.adapter === "dashscope" && p.apiKey) adapter = new DashScopeSTTProvider({ ...options, baseUrl: p.baseUrl });
  if (p.adapter === "xai-tts" && p.apiKey) adapter = new XAITTSProvider({ ...options, defaultVoice: m.voice });
  if (p.adapter === "dots-tts") adapter = new DotsTTSProvider({ baseUrl: p.baseUrl, model: m.modelId });
  if (p.adapter === "gpt-sovits") adapter = ttsProviderFactories["local"]!({ ...config, local: { ...config.local, ttsModel: m.modelId }, gptSovits: { ...config.gptSovits, wrapperBaseUrl: p.baseUrl } });
  return adapter ? new Proxy(adapter, { get(target, key) { if (key === "name") return m.id; const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } }) : undefined;
}

function productAdapter(config: ProviderRegistryConfig, cap: CapabilityRoute, id: string) {
  const adapter = createProductAdapter(config, cap, id);
  if (!adapter) return undefined;
  const methods = new Set(["generateReply", "generateReasoning", "decide", "embedText", "analyzeImage", "transcribeAudio", "synthesizeSpeech"]);
  return new Proxy(adapter, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    if (key === "streamReply") return async function* (...args: unknown[]) {
      try { yield* value.apply(target, args); config.observeProductCall?.(cap, id, true); }
      catch (error) { if (!(error instanceof ProviderError && error.code === ProviderErrorCode.Cancelled)) config.observeProductCall?.(cap, id, false); throw error; }
    };
    if (!methods.has(String(key))) return value.bind(target);
    return async (...args: unknown[]) => {
      try { const output = await value.apply(target, args); config.observeProductCall?.(cap, id, true); return output; }
      catch (error) { if (!(error instanceof ProviderError && error.code === ProviderErrorCode.Cancelled)) config.observeProductCall?.(cap, id, false); throw error; }
    };
  } });
}
