import { providerFetch as fetch } from "../invocation-witness.js";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import type { ProviderCallOptions, ProviderHealth, TokenUsage } from "../types/common.js";
import {
  ProviderError,
  ProviderErrorCode,
  mapHttpStatusToProviderErrorCode
} from "../types/errors.js";
import { createTransportAbort, type TransportAbort } from "../transport-abort.js";
import type { STTInput, STTOutput, STTProvider } from "../types/stt.js";

export type DashScopeSTTProviderOptions = {
  apiKey: string | undefined;
  baseUrl: string;
  model: string | undefined;
  timeoutMs?: number | undefined;
  maxInlineAudioBytes?: number | undefined;
  includeRawResponse?: boolean | undefined;
};

type DashScopeSyncResponse = {
  output?: {
    choices?: Array<{
      message?: {
        content?: Array<{
          text?: string;
        }>;
      };
    }>;
  };
  usage?: Record<string, unknown>;
};

type OpenAICompatibleASRResponse = {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      annotations?: Array<{
        type?: string;
        language?: string;
        confidence?: number;
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    seconds?: number;
  };
};

type DashScopeAudioSourceKind = "url" | "base64" | "buffer" | "localFilePath";

type ResolvedAudioInput = {
  audio: string;
  sourceKind: DashScopeAudioSourceKind;
};

export class DashScopeSTTProvider implements STTProvider {
  readonly name = "dashscope";

  constructor(private readonly options: DashScopeSTTProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    const start = performance.now();

    try {
      ensureDashScopeConfig(this.options);
      return {
        provider: this.name,
        status: "healthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - start)
      };
    } catch (error) {
      return {
        provider: this.name,
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - start),
        message: error instanceof Error ? error.message : "DashScope STT health check failed."
      };
    }
  }

  async transcribeAudio(input: STTInput, options?: ProviderCallOptions): Promise<STTOutput> {
    const transport = createTransportAbort({
      signal: options?.signal,
      timeoutMs: this.options.timeoutMs ?? 60000
    });
    let transportStarted = false;

    try {
      throwIfDashScopeTransportAborted(transport);
      ensureDashScopeConfig(this.options);

      const start = performance.now();
      const resolvedAudio = await resolveAudioInput(
        input,
        this.options.maxInlineAudioBytes ?? 10 * 1024 * 1024
      );
      throwIfDashScopeTransportAborted(transport);
      if (!transport.markStarted()) {
        throwIfDashScopeTransportAborted(transport);
        throw new Error("DashScope STT transport could not start.");
      }
      transportStarted = true;
      const response = await dashScopeFetch(
        this.options,
        "/services/aigc/multimodal-generation/generation",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: this.options.model,
            input: {
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      audio: resolvedAudio.audio
                    }
                  ]
                }
              ]
            },
            parameters: {
              asr_options: {
                language: input.language,
                enable_itn: input.metadata?.["enableItn"] ?? false
              }
            }
          })
        },
        transport.signal
      );
      if (!response.ok) {
        throw await createStatusError(response);
      }

      const rawResponse = await parseJsonResponse(response);
      throwIfDashScopeTransportAborted(transport);
      const normalized = normalizeDashScopeResponse(rawResponse);

      return {
        text: normalized.text,
        language: normalized.language ?? input.language,
        confidence: normalized.confidence,
        segments: normalized.segments,
        latencyMs: Math.round(performance.now() - start),
        model: this.options.model,
        tokenUsage: normalized.tokenUsage,
        providerMetadata: {
          usage: normalized.usage,
          sourceKind: resolvedAudio.sourceKind
        },
        debug: this.options.includeRawResponse ? { rawResponse } : undefined
      };
    } catch (error) {
      if (transport.source !== null) {
        throw createDashScopeTransportAbortError(transport);
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      if (!transportStarted) {
        throw error;
      }
      throw new ProviderError({
        provider: "dashscope",
        capability: "stt",
        code: ProviderErrorCode.NetworkError,
        message: "DashScope STT network request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }
}

function ensureDashScopeConfig(options: DashScopeSTTProviderOptions): void {
  if (!options.apiKey) {
    throw new ProviderError({
      provider: "dashscope",
      capability: "stt",
      code: ProviderErrorCode.MissingApiKey,
      message: "DASHSCOPE_API_KEY is required.",
      retryable: false
    });
  }

  if (!options.model) {
    throw new ProviderError({
      provider: "dashscope",
      capability: "stt",
      code: ProviderErrorCode.ModelNotFound,
      message: "DASHSCOPE_STT_MODEL is required.",
      retryable: false
    });
  }
}

async function resolveAudioInput(
  input: STTInput,
  maxInlineAudioBytes: number
): Promise<ResolvedAudioInput> {
  if (input.audioUrl) {
    return { audio: input.audioUrl, sourceKind: "url" };
  }

  if (input.audioBase64 !== undefined) {
    validateInlineAudioSize(input.audioBase64, maxInlineAudioBytes);
    return {
      audio: toDataUrl(input.audioBase64, input.mimeType),
      sourceKind: "base64"
    };
  }

  const buffer = input.audioBuffer ?? input.audio;
  if (buffer !== undefined) {
    validateBufferSize(buffer.byteLength, maxInlineAudioBytes);
    return {
      audio: toDataUrl(Buffer.from(buffer).toString("base64"), input.mimeType),
      sourceKind: "buffer"
    };
  }

  if (input.localFilePath) {
    if (!isAbsolute(input.localFilePath)) {
      throw new ProviderError({
        provider: "dashscope",
        capability: "stt",
        code: ProviderErrorCode.UnsupportedInput,
        message: "localFilePath must be an absolute path.",
        retryable: false
      });
    }

    const file = await readFile(input.localFilePath);
    validateBufferSize(file.byteLength, maxInlineAudioBytes);
    return {
      audio: toDataUrl(
        file.toString("base64"),
        input.mimeType ?? mimeTypeFromPath(input.localFilePath)
      ),
      sourceKind: "localFilePath"
    };
  }

  throw new ProviderError({
    provider: "dashscope",
    capability: "stt",
    code: ProviderErrorCode.UnsupportedInput,
    message: "STT input must include audioUrl, localFilePath, audioBase64, audioBuffer, or audio.",
    retryable: false
  });
}

async function dashScopeFetch(
  options: DashScopeSTTProviderOptions,
  path: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  return fetch(`${trimTrailingSlash(options.baseUrl)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      ...init.headers
    },
    signal
  });
}

async function createStatusError(response: Response): Promise<ProviderError> {
  const code = mapHttpStatusToProviderErrorCode(response.status);
  const safeBody = await readSafeErrorBody(response);

  return new ProviderError({
    provider: "dashscope",
    capability: "stt",
    code,
    statusCode: response.status,
    message: safeBody
      ? `DashScope STT request failed with ${response.status}: ${safeBody}`
      : `DashScope STT request failed with ${response.status}.`
  });
}

function throwIfDashScopeTransportAborted(transport: TransportAbort): void {
  if (transport.source !== null) {
    throw createDashScopeTransportAbortError(transport);
  }
}

function createDashScopeTransportAbortError(transport: TransportAbort): ProviderError {
  if (transport.source === "caller") {
    return new ProviderError({
      provider: "dashscope",
      capability: "stt",
      code: ProviderErrorCode.Cancelled,
      message: "DashScope STT was cancelled.",
      retryable: false,
      fallbackEligible: false,
      effectState: transport.effectState ?? "unknown"
    });
  }

  return new ProviderError({
    provider: "dashscope",
    capability: "stt",
    code: ProviderErrorCode.Timeout,
    message: "DashScope STT request timed out.",
    effectState: transport.effectState ?? "unknown"
  });
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError({
      provider: "dashscope",
      capability: "stt",
      code: ProviderErrorCode.MalformedResponse,
      message: "DashScope STT returned a non-JSON response.",
      retryable: false,
      cause: error
    });
  }
}

function normalizeDashScopeResponse(rawResponse: unknown): {
  text: string;
  language?: string | undefined;
  confidence?: number | undefined;
  segments?: STTOutput["segments"] | undefined;
  tokenUsage?: TokenUsage | undefined;
  usage?: unknown;
} {
  if (isDashScopeSyncResponse(rawResponse)) {
    const text = rawResponse.output?.choices?.[0]?.message?.content?.find(
      (item) => typeof item.text === "string"
    )?.text;
    if (typeof text === "string") {
      assertMeaningfulTranscript(text);
      return {
        text,
        usage: rawResponse.usage
      };
    }
  }

  if (isOpenAICompatibleASRResponse(rawResponse)) {
    const message = rawResponse.choices?.[0]?.message;
    if (typeof message?.content === "string") {
      assertMeaningfulTranscript(message.content);
      const audioInfo = message.annotations?.find((annotation) => annotation.type === "audio_info");
      return {
        text: message.content,
        language: audioInfo?.language,
        confidence: audioInfo?.confidence,
        tokenUsage: normalizeUsage(rawResponse.usage),
        usage: rawResponse.usage
      };
    }
  }

  throw new ProviderError({
    provider: "dashscope",
    capability: "stt",
    code: ProviderErrorCode.MalformedResponse,
    message: "DashScope STT response did not include normalized transcription text.",
    retryable: false,
    cause: rawResponse
  });
}

function assertMeaningfulTranscript(text: string): void {
  if (text.trim().length > 0) {
    return;
  }

  throw new ProviderError({
    provider: "dashscope",
    capability: "stt",
    code: ProviderErrorCode.MalformedResponse,
    message: "DashScope STT response contained an empty transcription.",
    retryable: false,
    effectState: "unknown"
  });
}

function isDashScopeSyncResponse(value: unknown): value is DashScopeSyncResponse {
  return typeof value === "object" && value !== null && "output" in value;
}

function isOpenAICompatibleASRResponse(value: unknown): value is OpenAICompatibleASRResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as OpenAICompatibleASRResponse).choices)
  );
}

function normalizeUsage(usage: OpenAICompatibleASRResponse["usage"]): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  };
}

function validateInlineAudioSize(base64OrDataUrl: string, maxInlineAudioBytes: number): void {
  const base64 = extractInlineBase64(base64OrDataUrl);
  if (!isValidBase64(base64)) {
    throw new ProviderError({
      provider: "dashscope",
      capability: "stt",
      code: ProviderErrorCode.UnsupportedInput,
      message: "audioBase64 must contain valid non-empty base64 audio data.",
      retryable: false
    });
  }

  validateBufferSize(Buffer.from(base64, "base64").byteLength, maxInlineAudioBytes);
}

function validateBufferSize(byteLength: number, maxInlineAudioBytes: number): void {
  if (byteLength === 0) {
    throw new ProviderError({
      provider: "dashscope",
      capability: "stt",
      code: ProviderErrorCode.UnsupportedInput,
      message: "Audio input must not be empty.",
      retryable: false
    });
  }

  if (byteLength > maxInlineAudioBytes) {
    throw new ProviderError({
      provider: "dashscope",
      capability: "stt",
      code: ProviderErrorCode.UnsupportedInput,
      message: `Audio input is too large for inline DashScope STT. Maximum supported inline size is ${maxInlineAudioBytes} bytes.`,
      retryable: false
    });
  }
}

function extractInlineBase64(value: string): string {
  if (!value.startsWith("data:")) {
    return value;
  }

  const comma = value.indexOf(",");
  if (comma < 0 || !/^data:[^,]*;base64$/i.test(value.slice(0, comma))) {
    return "";
  }

  return value.slice(comma + 1);
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    return false;
  }

  const paddingIndex = value.indexOf("=");
  if (paddingIndex >= 0 && value.length % 4 !== 0) {
    return false;
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0) {
    return false;
  }

  const normalizedInput = value.replace(/=+$/, "");
  const normalizedCanonical = decoded.toString("base64").replace(/=+$/, "");
  return normalizedInput === normalizedCanonical;
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

function toDataUrl(base64: string, mimeType = "audio/mpeg"): string {
  if (base64.startsWith("data:")) {
    return base64;
  }

  return `data:${mimeType};base64,${base64}`;
}

function mimeTypeFromPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".wav") {
    return "audio/wav";
  }

  if (extension === ".webm") {
    return "audio/webm";
  }

  if (extension === ".ogg") {
    return "audio/ogg";
  }

  if (extension === ".m4a") {
    return "audio/mp4";
  }

  return "audio/mpeg";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
