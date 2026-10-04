import { providerFetch as fetch } from "../invocation-witness.js";
import type { ProviderCallOptions, ProviderHealth } from "../types/common.js";
import {
  ProviderError,
  ProviderErrorCode,
  mapHttpStatusToProviderErrorCode
} from "../types/errors.js";
import { createTransportAbort, type TransportAbort } from "../transport-abort.js";
import type { TTSInput, TTSOutput, TTSProvider } from "../types/tts.js";

export type GPTSoVITSTTSProviderOptions = {
  wrapperBaseUrl: string;
  upstreamBaseUrl: string;
  model: string;
  /** Paths are recorded as deployment configuration; the managed service loads them at startup. */
  gptWeightsPath?: string | undefined;
  sovitsWeightsPath?: string | undefined;
  defaultLanguage?: string | undefined;
  speaker?: string | undefined;
  style?: string | undefined;
  referenceRank?: number | undefined;
  referenceAudioPath?: string | undefined;
  referenceText?: string | undefined;
  referenceLanguage?: string | undefined;
  textSplitMethod?: string | undefined;
  topK?: number | undefined;
  topP?: number | undefined;
  temperature?: number | undefined;
  repetitionPenalty?: number | undefined;
  sampleSteps?: number | undefined;
  timeoutMs?: number | undefined;
};

/**
 * Adapter for the local Alice GPT-SoVITS stack. Japanese requests use the
 * managed 9881 wrapper; other configured languages use api_v2 directly so a
 * Japanese reference clip can drive English or mixed-language synthesis.
 */
export class GPTSoVITSTTSProvider implements TTSProvider {
  readonly name = "local";

  constructor(private readonly options: GPTSoVITSTTSProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = performance.now();
    const transport = createTransportAbort({ timeoutMs: this.options.timeoutMs ?? 10_000 });

    try {
      const response = await fetch(`${trimTrailingSlash(this.options.wrapperBaseUrl)}/health`, {
        method: "GET",
        signal: transport.signal
      });
      throwIfGPTSoVITSTransportAborted(transport);
      if (!response.ok) {
        throw new Error(`local GPT-SoVITS health returned ${response.status}`);
      }
      const body = (await response.json()) as { model_loaded?: unknown };
      throwIfGPTSoVITSTransportAborted(transport);
      if (body.model_loaded !== true) {
        throw new Error("local GPT-SoVITS model is not loaded");
      }
      return {
        provider: this.name,
        name: this.name,
        capability: "tts",
        status: "healthy",
        configured: true,
        available: true,
        mock: false,
        baseUrl: this.options.wrapperBaseUrl,
        model: this.options.model,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        message: "Local GPT-SoVITS wrapper is ready."
      };
    } catch (error) {
      return {
        provider: this.name,
        name: this.name,
        capability: "tts",
        status: "unavailable",
        configured: true,
        available: false,
        mock: false,
        baseUrl: this.options.wrapperBaseUrl,
        model: this.options.model,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : "Local GPT-SoVITS health check failed."
      };
    } finally {
      transport.cleanup();
    }
  }

  async synthesizeSpeech(input: TTSInput, options?: ProviderCallOptions): Promise<TTSOutput> {
    const callerSignal = options?.signal ?? input.signal;
    const transport = createTransportAbort({
      signal: callerSignal,
      timeoutMs: this.options.timeoutMs ?? 60_000
    });
    let transportStarted = false;

    try {
      throwIfGPTSoVITSTransportAborted(transport);
      if (!input.text.trim()) {
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: ProviderErrorCode.UnsupportedInput,
          message: "TTS text must not be empty.",
          retryable: false
        });
      }

      const language = normalizeLanguage(
        typeof input.metadata?.["language"] === "string"
          ? input.metadata["language"]
          : (this.options.defaultLanguage ?? "ja")
      );
      const start = performance.now();
      const useWrapper = isJapanese(language) || !this.hasReferenceConfig();
      const transportKind = useWrapper
        ? isJapanese(language)
          ? "wrapper"
          : "wrapper-fallback"
        : "api_v2";
      validateFormat(input.format, transportKind);
      if (useWrapper && input.speed !== undefined) {
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: ProviderErrorCode.UnsupportedInput,
          message: "The managed GPT-SoVITS wrapper does not support TTS speed.",
          retryable: false
        });
      }
      const request = useWrapper
        ? {
            url: `${trimTrailingSlash(this.options.wrapperBaseUrl)}/tts`,
            body: {
              text: input.text,
              // Alice's managed wrapper currently accepts Japanese requests
              // only. In packaged mode there is no user-supplied API-v2
              // reference pair, so preserve playback by using the managed
              // voice for every requested language instead of returning 503.
              language: isJapanese(language) ? language : "ja",
              speaker: input.voice ?? this.options.speaker ?? "alice",
              style: this.options.style ?? "neutral",
              reference_rank: this.options.referenceRank ?? 0
            }
          }
        : {
            url: `${trimTrailingSlash(this.options.upstreamBaseUrl)}/tts`,
            body: this.buildUpstreamRequest(input, language)
          };

      if (!transport.markStarted()) {
        throwIfGPTSoVITSTransportAborted(transport);
        throw new Error("Local GPT-SoVITS transport could not start.");
      }
      transportStarted = true;
      const response = await this.fetchAudio(
        request.url,
        request.body,
        transport,
        input.format ?? "wav"
      );
      throwIfGPTSoVITSTransportAborted(transport);
      const audio = response.audio;
      if (audio.byteLength === 0) {
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: ProviderErrorCode.MalformedResponse,
          message: "Local GPT-SoVITS returned empty audio.",
          retryable: false
        });
      }

      return {
        audio,
        audioBuffer: audio,
        audioBase64: Buffer.from(audio).toString("base64"),
        mimeType: response.mimeType,
        latencyMs: Math.round(performance.now() - start),
        model: this.options.model,
        finalProvider: this.name,
        providerMetadata: {
          language,
          speaker: input.voice ?? this.options.speaker ?? "alice",
          transport: transportKind
        }
      };
    } catch (error) {
      if (transport.source !== null) {
        throw createGPTSoVITSTransportAbortError(transport);
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      if (!transportStarted) {
        throw error;
      }
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: ProviderErrorCode.NetworkError,
        message: "Local GPT-SoVITS synthesis request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }

  private hasReferenceConfig(): boolean {
    return Boolean(this.options.referenceAudioPath && this.options.referenceText);
  }

  private buildUpstreamRequest(input: TTSInput, language: string): Record<string, unknown> {
    if (!this.options.referenceAudioPath || !this.options.referenceText) {
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: ProviderErrorCode.UnsupportedInput,
        message:
          "A reference audio path and reference text are required for non-Japanese GPT-SoVITS synthesis.",
        retryable: false
      });
    }

    return {
      text: input.text,
      text_lang: language,
      ref_audio_path: this.options.referenceAudioPath,
      prompt_text: this.options.referenceText,
      prompt_lang: this.options.referenceLanguage ?? "ja",
      text_split_method: this.options.textSplitMethod ?? "cut0",
      batch_size: 1,
      media_type: input.format === "pcm" ? "raw" : "wav",
      streaming_mode: false,
      top_k: this.options.topK ?? 15,
      top_p: this.options.topP ?? 1,
      temperature: this.options.temperature ?? 1,
      repetition_penalty: this.options.repetitionPenalty ?? 1.35,
      sample_steps: this.options.sampleSteps ?? 32,
      speed_factor: input.speed ?? 1
    };
  }

  private async fetchAudio(
    url: string,
    body: Record<string, unknown>,
    transport: TransportAbort,
    format: TTSInput["format"]
  ): Promise<{ audio: Uint8Array; mimeType: string }> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: transport.signal
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: mapHttpStatusToProviderErrorCode(response.status),
        statusCode: response.status,
        message: bodyText
          ? `Local GPT-SoVITS request failed with ${response.status}: ${redact(bodyText).slice(0, 200)}`
          : `Local GPT-SoVITS request failed with ${response.status}.`
      });
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    throwIfGPTSoVITSTransportAborted(transport);
    return {
      audio,
      mimeType: normalizeAudioMimeType(
        response.headers.get("content-type"),
        mimeTypeFromFormat(format)
      )
    };
  }
}

type GPTSoVITSTransportKind = "wrapper" | "wrapper-fallback" | "api_v2";

function validateFormat(format: TTSInput["format"], transport: GPTSoVITSTransportKind): void {
  if (format === undefined || format === "wav") {
    return;
  }

  if (transport === "api_v2" && format === "pcm") {
    return;
  }

  throw new ProviderError({
    provider: "local",
    capability: "tts",
    code: ProviderErrorCode.UnsupportedInput,
    message: `GPT-SoVITS ${transport} does not support the requested ${format} TTS format.`,
    retryable: false
  });
}

function normalizeAudioMimeType(contentType: string | null, fallback: string): string {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType || fallback;
}

function mimeTypeFromFormat(format: TTSInput["format"]): string {
  return format === "pcm" ? "audio/raw" : "audio/wav";
}

function normalizeLanguage(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "jp" || normalized === "japanese") return "ja";
  if (normalized === "en-us" || normalized === "english") return "en";
  return normalized || "ja";
}

function isJapanese(language: string): boolean {
  return language === "ja";
}

function throwIfGPTSoVITSTransportAborted(transport: TransportAbort): void {
  if (transport.source !== null) {
    throw createGPTSoVITSTransportAbortError(transport);
  }
}

function createGPTSoVITSTransportAbortError(transport: TransportAbort): ProviderError {
  if (transport.source === "caller") {
    return new ProviderError({
      provider: "local",
      capability: "tts",
      code: ProviderErrorCode.Cancelled,
      message: "Local GPT-SoVITS synthesis was cancelled.",
      retryable: false,
      fallbackEligible: false,
      effectState: transport.effectState ?? "unknown"
    });
  }

  return new ProviderError({
    provider: "local",
    capability: "tts",
    code: ProviderErrorCode.Timeout,
    message: "Local GPT-SoVITS synthesis timed out.",
    effectState: transport.effectState ?? "unknown"
  });
}

function redact(value: string): string {
  return value
    .replace(/(token|password|secret|api[-_]?key)=?[^\s&]+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z]:[\\/][^\r\n\"]+/g, "[LOCAL_PATH]");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
