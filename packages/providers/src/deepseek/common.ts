import { providerFetch as fetch } from "../invocation-witness.js";
import type {
  ProviderCapability,
  ProviderCallOptions,
  ProviderHealth,
  TextMessage,
  TokenUsage
} from "../types/common.js";
import type { ChatInput, ChatStreamEvent, ChatStreamOptions } from "../types/chat.js";
import {
  ProviderError,
  ProviderErrorCode,
  mapHttpStatusToProviderErrorCode
} from "../types/errors.js";
import {
  streamOpenAICompatibleChatCompletion,
  type OpenAICompatibleStreamOptions
} from "../openai-compatible-stream.js";
import { createTransportAbort, type TransportAbort } from "../transport-abort.js";

export type DeepSeekProviderOptions = {
  apiKey: string | undefined;
  baseUrl: string;
  model: string | undefined;
  timeoutMs?: number | undefined;
  includeRawResponse?: boolean | undefined;
};

export type DeepSeekChatRequest = {
  messages: TextMessage[];
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  stopSequences?: string[] | undefined;
  stream?: boolean | undefined;
};

export type DeepSeekChatCompletion = {
  content: string;
  reasoningContent?: string | undefined;
  finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "unknown" | undefined;
  model?: string | undefined;
  tokenUsage?: TokenUsage | undefined;
  rawResponse?: unknown | undefined;
};

type OpenAICompatibleUsage = {
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type OpenAICompatibleResponse = {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: OpenAICompatibleUsage;
};

export async function healthCheckDeepSeek(
  provider: string,
  capability: ProviderCapability,
  options: DeepSeekProviderOptions
): Promise<ProviderHealth> {
  try {
    ensureDeepSeekConfig(provider, capability, options);

    return {
      provider,
      name: provider,
      capability,
      configured: true,
      available: true,
      mock: false,
      required: capability === "chat",
      baseUrl: options.baseUrl,
      model: options.model,
      status: "degraded",
      checkedAt: new Date().toISOString(),
      message: "DeepSeek is configured but not verified by health check."
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        provider,
        name: provider,
        capability,
        configured: false,
        available: false,
        mock: false,
        required: capability === "chat",
        baseUrl: options.baseUrl,
        model: options.model,
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: error.message
      };
    }

    return {
      provider,
      name: provider,
      capability,
      configured: false,
      available: false,
      mock: false,
      required: capability === "chat",
      baseUrl: options.baseUrl,
      model: options.model,
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      message: "DeepSeek health check failed."
    };
  }
}

export async function createDeepSeekChatCompletion(
  provider: string,
  capability: ProviderCapability,
  options: DeepSeekProviderOptions,
  request: DeepSeekChatRequest,
  callOptions?: ProviderCallOptions
): Promise<DeepSeekChatCompletion & { latencyMs: number }> {
  const transport = createTransportAbort({
    signal: callOptions?.signal,
    timeoutMs: options.timeoutMs ?? 30000
  });

  try {
    throwIfTransportAborted(provider, capability, transport);
    ensureDeepSeekConfig(provider, capability, options);

    const model = request.model ?? options.model;
    if (!model) {
      throw new ProviderError({
        provider,
        capability,
        code: ProviderErrorCode.ModelNotFound,
        message: `${provider} ${capability} model is not configured.`,
        retryable: false
      });
    }

    const start = performance.now();
    if (!transport.markStarted()) {
      throwIfTransportAborted(provider, capability, transport);
      throw new Error("DeepSeek transport could not start.");
    }

    const response = await deepSeekFetch(
      options,
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stop: request.stopSequences,
          stream: request.stream ?? false
        })
      },
      transport.signal
    );
    if (!response.ok) {
      throw await createStatusError(provider, capability, response);
    }

    const rawResponse = await parseJsonResponse(provider, capability, response);
    throwIfTransportAborted(provider, capability, transport);
    const completion = normalizeDeepSeekChatCompletion(provider, capability, rawResponse);

    return {
      ...completion,
      rawResponse: options.includeRawResponse ? rawResponse : undefined,
      latencyMs: Math.round(performance.now() - start)
    };
  } catch (error) {
    const source = transport.source;
    if (source !== null) {
      throw createTransportAbortError(provider, capability, transport);
    }
    if (error instanceof ProviderError) {
      throw error;
    }
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.NetworkError,
      message: "DeepSeek network request failed.",
      cause: error
    });
  } finally {
    transport.cleanup();
  }
}

export function streamDeepSeekChatCompletion(
  provider: string,
  options: DeepSeekProviderOptions,
  input: ChatInput,
  streamOptions?: ChatStreamOptions
): AsyncIterable<ChatStreamEvent> {
  const streamOptionsForClient: OpenAICompatibleStreamOptions = {
    provider,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: input.model ?? options.model ?? "",
    includeRawResponse: options.includeRawResponse,
    timeoutMs: options.timeoutMs
  };
  if (!streamOptionsForClient.model) {
    throw new ProviderError({
      provider,
      capability: "chat",
      code: ProviderErrorCode.ModelNotFound,
      message: `${provider} chat model is not configured.`,
      retryable: false
    });
  }
  if (!options.apiKey) {
    throw new ProviderError({
      provider,
      capability: "chat",
      code: ProviderErrorCode.MissingApiKey,
      message: "DEEPSEEK_API_KEY is required.",
      retryable: false
    });
  }
  return streamOpenAICompatibleChatCompletion(streamOptionsForClient, "chat", input, streamOptions);
}

function ensureDeepSeekConfig(
  provider: string,
  capability: ProviderCapability,
  options: DeepSeekProviderOptions
): void {
  if (!options.apiKey) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MissingApiKey,
      message: "DEEPSEEK_API_KEY is required.",
      retryable: false
    });
  }
}

async function deepSeekFetch(
  options: DeepSeekProviderOptions,
  path: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  return fetch(`${trimTrailingSlash(options.baseUrl)}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
      ...init.headers
    },
    signal
  });
}

async function createStatusError(
  provider: string,
  capability: ProviderCapability,
  response: Response
): Promise<ProviderError> {
  const code = mapHttpStatusToProviderErrorCode(response.status);
  const safeBody = await readSafeErrorBody(response);

  return new ProviderError({
    provider,
    capability,
    code,
    statusCode: response.status,
    message: safeBody
      ? `DeepSeek request failed with ${response.status}: ${safeBody}`
      : `DeepSeek request failed with ${response.status}.`
  });
}

function throwIfTransportAborted(
  provider: string,
  capability: ProviderCapability,
  transport: TransportAbort
): void {
  if (transport.source !== null) {
    throw createTransportAbortError(provider, capability, transport);
  }
}

function createTransportAbortError(
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
    message: "DeepSeek request timed out.",
    effectState: transport.effectState ?? "unknown"
  });
}

async function parseJsonResponse(
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
      message: "DeepSeek returned a non-JSON response.",
      retryable: false,
      cause: error
    });
  }
}

function normalizeDeepSeekChatCompletion(
  provider: string,
  capability: ProviderCapability,
  rawResponse: unknown
): DeepSeekChatCompletion {
  if (!isOpenAICompatibleResponse(rawResponse)) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MalformedResponse,
      message: "DeepSeek response did not match the expected chat completion shape.",
      retryable: false,
      cause: rawResponse
    });
  }

  const firstChoice = rawResponse.choices?.[0];
  const content = firstChoice?.message?.content;
  if (typeof content !== "string") {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MalformedResponse,
      message: "DeepSeek response did not include assistant message content.",
      retryable: false,
      cause: rawResponse
    });
  }

  return {
    content,
    reasoningContent: firstChoice?.message?.reasoning_content ?? undefined,
    finishReason: normalizeFinishReason(firstChoice?.finish_reason),
    model: rawResponse.model,
    tokenUsage: normalizeUsage(rawResponse.usage)
  };
}

function isOpenAICompatibleResponse(value: unknown): value is OpenAICompatibleResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as OpenAICompatibleResponse).choices)
  );
}

function normalizeUsage(usage: OpenAICompatibleUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  };
}

function normalizeFinishReason(
  value: string | null | undefined
): DeepSeekChatCompletion["finishReason"] {
  if (
    value === "stop" ||
    value === "length" ||
    value === "tool_call" ||
    value === "content_filter"
  ) {
    return value;
  }

  return "unknown";
}

async function readSafeErrorBody(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return redactSecrets(text).slice(0, 500) || undefined;
  } catch {
    return undefined;
  }
}

function redactSecrets(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
