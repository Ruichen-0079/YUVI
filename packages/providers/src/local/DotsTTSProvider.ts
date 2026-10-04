import { providerFetch as fetch } from "../invocation-witness.js";
import type { ProviderCallOptions, ProviderHealth } from "../types/common.js";
import type { TTSInput, TTSOutput, TTSProvider } from "../types/tts.js";
import {
  ProviderError,
  ProviderErrorCode,
  mapHttpStatusToProviderErrorCode
} from "../types/errors.js";
import { createTransportAbort } from "../transport-abort.js";

/** Concrete dots complete-audio transport. Model and reference assets belong to the service. */
export class DotsTTSProvider implements TTSProvider {
  readonly name = "local";
  constructor(private readonly config: { baseUrl: string; model: string; timeoutMs?: number }) {}

  async healthCheck(): Promise<ProviderHealth> {
    let available = false;
    let message = "Local TTS service unavailable.";
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      const body = (await response.json()) as {
        service?: string;
        state?: string;
        model_loaded?: boolean;
        ready_on_demand?: boolean;
      };
      const hibernated = body.state === "hibernated" || body.ready_on_demand === true;
      available =
        response.ok &&
        body.service === "yuvi-dots-tts" &&
        ((body.state === "ready" && body.model_loaded === true) ||
          (hibernated && body.state !== "error" && body.state !== "warming"));
      message = available
        ? body.state === "hibernated" ||
          (body.ready_on_demand === true && body.model_loaded !== true)
          ? "Local TTS ready on demand."
          : "Local TTS ready."
        : body.state === "warming"
          ? "Local TTS warming."
          : "Local TTS unavailable.";
    } catch {
      /* sanitized public diagnostic */
    }
    return {
      provider: this.name,
      capability: "tts",
      status: available ? "healthy" : "unavailable",
      configured: true,
      available,
      mock: false,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      checkedAt: new Date().toISOString(),
      message
    };
  }

  async synthesizeSpeech(input: TTSInput, options?: ProviderCallOptions): Promise<TTSOutput> {
    const transport = createTransportAbort({
      signal: options?.signal ?? input.signal,
      timeoutMs: this.config.timeoutMs ?? 120_000
    });
    const requestId = crypto.randomUUID();
    const base = this.config.baseUrl.replace(/\/$/, "");
    // Aborting the transport preserves UNKNOWN; no hidden remote cancel invocation.
    try {
      transport.signal.throwIfAborted();
      const language =
        typeof input.metadata?.["language"] === "string"
          ? input.metadata["language"].toUpperCase()
          : undefined;
      if (
        !input.text.trim() ||
        (input.format && input.format !== "wav") ||
        input.speed !== undefined ||
        (language !== undefined && !["JA", "EN", "ZH"].includes(language))
      ) {
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: ProviderErrorCode.UnsupportedInput,
          message: "Local TTS requires text, WAV format and a supported language.",
          retryable: false
        });
      }
      transport.markStarted();
      transport.signal.throwIfAborted();
      let response: Response;
      response = await fetch(`${base}/tts`, {
        method: "POST",
        signal: transport.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          text: input.text,
          language,
          ...(input.voice ? { voice: input.voice } : {})
        })
      });
      // A status code alone is not certified non-invocation evidence. A9 owns
      // any subsequent attempt; this concrete transport performs exactly one write.
      transport.signal.throwIfAborted();
      if (!response.ok)
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: mapHttpStatusToProviderErrorCode(response.status),
          statusCode: response.status,
          effectState: "unknown",
          message: `Local TTS returned HTTP ${response.status}.`,
          retryable: false
        });
      const audio = new Uint8Array(await response.arrayBuffer());
      transport.signal.throwIfAborted();
      if (
        audio.length < 44 ||
        new TextDecoder().decode(audio.slice(0, 4)) !== "RIFF" ||
        new TextDecoder().decode(audio.slice(8, 12)) !== "WAVE"
      ) {
        throw new Error("Invalid WAV");
      }
      return {
        audio,
        mimeType: "audio/wav",
        model: this.config.model,
        finalProvider: this.name,
        providerMetadata: { language }
      };
    } catch (error) {
      if (transport.source !== null)
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code:
            transport.source === "caller" ? ProviderErrorCode.Cancelled : ProviderErrorCode.Timeout,
          message: transport.source === "caller" ? "Local TTS cancelled." : "Local TTS timed out.",
          effectState: transport.effectState ?? "unknown",
          retryable: false
        });
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: ProviderErrorCode.NetworkError,
        message: "Local TTS transport failed.",
        retryable: false
      });
    } finally {
      transport.cleanup();
    }
  }
}
