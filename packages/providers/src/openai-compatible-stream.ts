import { providerFetch as fetch } from "./invocation-witness.js";
import type { ChatInput, ChatOutput, ChatStreamEvent, ChatStreamOptions } from "./types/chat.js";
import type { ProviderCapability, TokenUsage } from "./types/common.js";
import { ProviderError, ProviderErrorCode } from "./types/errors.js";

export type OpenAICompatibleStreamOptions = {
  provider: string;
  apiKey?: string | undefined;
  baseUrl: string;
  model: string;
  includeRawResponse?: boolean | undefined;
  timeoutMs?: number | undefined;
};

type OpenAIStreamChunk = {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
};

type OpenAIStreamChoice = {
  delta?: unknown;
  finish_reason?: unknown;
};

type OpenAIStreamDelta = {
  role?: unknown;
  content?: unknown;
  reasoning_content?: unknown;
};

type OpenAIStreamUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  prompt_tokens_details?: unknown;
};

/**
 * Reads an OpenAI-compatible text/event-stream response one SSE frame at a time.
 * The generator owns the response reader and releases it when the consumer stops early.
 */
export async function* streamOpenAICompatibleChatCompletion(
  options: OpenAICompatibleStreamOptions,
  capability: ProviderCapability,
  input: ChatInput,
  streamOptions: ChatStreamOptions = {}
): AsyncIterable<ChatStreamEvent> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const externalSignal = streamOptions.signal;
  let externallyAborted = externalSignal?.aborted ?? false;
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let readerDone = false;
  let completed = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 30000);
  const abortExternal = () => {
    externallyAborted = true;
    controller.abort();
  };

  externalSignal?.addEventListener("abort", abortExternal, { once: true });

  try {
    if (externallyAborted) {
      throw cancelledError(options.provider, capability);
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.apiKey) {
      headers["authorization"] = `Bearer ${options.apiKey}`;
    }

    const response = await fetch(`${trimTrailingSlash(options.baseUrl)}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: options.model,
        messages: input.messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens ?? input.maxOutputTokens,
        stop: input.stopSequences,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw await createStatusError(options.provider, capability, response);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw protocolError(
        options.provider,
        capability,
        "OpenAI-compatible stream did not return text/event-stream."
      );
    }

    if (!response.body) {
      throw protocolError(options.provider, capability, "OpenAI-compatible stream had no body.");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parser = new SseFrameParser(options.provider, capability);
    let text = "";
    let model = options.model;
    let finishReason: ChatOutput["finishReason"];
    let tokenUsage: TokenUsage | undefined;
    let sawDone = false;

    const processFrame = (frame: string): void => {
      const data = parseSseData(frame, options.provider, capability);
      if (sawDone) {
        throw protocolError(
          options.provider,
          capability,
          "OpenAI-compatible stream emitted data after [DONE]."
        );
      }
      if (data === "[DONE]") {
        sawDone = true;
        return;
      }

      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAIStreamChunk;
      } catch {
        throw protocolError(
          options.provider,
          capability,
          "OpenAI-compatible stream emitted invalid JSON."
        );
      }

      if (!isRecord(chunk)) {
        throw protocolError(
          options.provider,
          capability,
          "OpenAI-compatible stream emitted an invalid chunk."
        );
      }

      if (typeof chunk.model === "string" && chunk.model) {
        model = chunk.model;
      }

      if (chunk.usage !== undefined && chunk.usage !== null) {
        tokenUsage = normalizeUsage(chunk.usage, options.provider, capability);
      }

      if (chunk.choices === undefined) {
        return;
      }
      if (!Array.isArray(chunk.choices)) {
        throw protocolError(
          options.provider,
          capability,
          "OpenAI-compatible stream choices were invalid."
        );
      }

      const firstChoice = chunk.choices[0] as OpenAIStreamChoice | undefined;
      if (firstChoice === undefined) {
        return;
      }
      if (!isRecord(firstChoice)) {
        throw protocolError(
          options.provider,
          capability,
          "OpenAI-compatible stream choice was invalid."
        );
      }

      if (firstChoice.finish_reason !== null && firstChoice.finish_reason !== undefined) {
        finishReason = normalizeFinishReason(firstChoice.finish_reason);
      }

      if (firstChoice.delta === undefined || firstChoice.delta === null) {
        return;
      }
      if (!isRecord(firstChoice.delta)) {
        throw protocolError(
          options.provider,
          capability,
          "OpenAI-compatible stream delta was invalid."
        );
      }

      const delta = firstChoice.delta as OpenAIStreamDelta;
      if (delta.content === undefined || delta.content === null || delta.content === "") {
        // role-only and metadata-only deltas are valid, but do not become empty text-delta events.
        return;
      }
      if (typeof delta.content !== "string") {
        throw protocolError(
          options.provider,
          capability,
          "OpenAI-compatible stream content delta was invalid."
        );
      }
      text += delta.content;
      pendingEvents.push({ type: "text-delta", text: delta.content });
    };

    const pendingEvents: ChatStreamEvent[] = [];
    while (true) {
      if (externallyAborted) {
        throw cancelledError(options.provider, capability);
      }
      const result = await reader.read();
      if (externallyAborted) {
        throw cancelledError(options.provider, capability);
      }
      if (result.done) {
        readerDone = true;
        let tail: string;
        try {
          tail = decoder.decode();
        } catch (error) {
          throw protocolError(
            options.provider,
            capability,
            "OpenAI-compatible stream ended with invalid UTF-8.",
            error
          );
        }
        for (const frame of parser.push(tail)) {
          processFrame(frame);
          while (pendingEvents.length > 0) {
            if (externallyAborted) {
              throw cancelledError(options.provider, capability);
            }
            yield pendingEvents.shift()!;
          }
        }
        parser.finish();
        if (!sawDone) {
          throw protocolError(
            options.provider,
            capability,
            "OpenAI-compatible stream ended before [DONE]."
          );
        }
        if (!text) {
          throw protocolError(
            options.provider,
            capability,
            "OpenAI-compatible stream returned an empty assistant response."
          );
        }
        const output: ChatOutput = {
          message: { role: "assistant", content: text },
          model,
          finishReason: finishReason ?? "stop",
          latencyMs: Math.round(performance.now() - startedAt),
          tokenUsage,
          debug: options.includeRawResponse
            ? { rawResponse: { model, usage: tokenUsage, streamed: true } }
            : undefined
        };
        if (externallyAborted) {
          throw cancelledError(options.provider, capability);
        }
        completed = true;
        yield { type: "completed", output };
        return;
      }

      let decoded: string;
      try {
        decoded = decoder.decode(result.value, { stream: true });
      } catch (error) {
        throw protocolError(
          options.provider,
          capability,
          "OpenAI-compatible stream emitted invalid UTF-8.",
          error
        );
      }
      for (const frame of parser.push(decoded)) {
        processFrame(frame);
        while (pendingEvents.length > 0) {
          if (externallyAborted) {
            throw cancelledError(options.provider, capability);
          }
          yield pendingEvents.shift()!;
        }
      }
    }
  } catch (error) {
    if (externallyAborted) {
      throw cancelledError(options.provider, capability, error);
    }
    if (timedOut) {
      throw new ProviderError({
        provider: options.provider,
        capability,
        code: ProviderErrorCode.Timeout,
        message: `${options.provider} ${capability} stream timed out.`,
        cause: error
      });
    }
    if (error instanceof ProviderError) {
      throw error;
    }
    if (isAbortError(error)) {
      throw new ProviderError({
        provider: options.provider,
        capability,
        code: ProviderErrorCode.Timeout,
        message: `${options.provider} ${capability} stream timed out.`,
        cause: error
      });
    }
    throw new ProviderError({
      provider: options.provider,
      capability,
      code: ProviderErrorCode.NetworkError,
      message: `${options.provider} ${capability} stream failed.`,
      cause: error
    });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortExternal);
    if (reader) {
      if (!readerDone && !completed) {
        try {
          await reader.cancel();
        } catch {
          // Reader cleanup must not replace the original stream result.
        }
      }
      try {
        reader.releaseLock();
      } catch {
        // The reader may already have been released by the underlying stream.
      }
    }
    controller.abort();
  }
}

class SseFrameParser {
  private buffer = "";

  constructor(
    private readonly provider: string,
    private readonly capability: ProviderCapability
  ) {}

  push(chunk: string): string[] {
    this.buffer += chunk;
    const frames: string[] = [];
    while (true) {
      const boundary = findFrameBoundary(this.buffer);
      if (!boundary) {
        break;
      }
      frames.push(this.buffer.slice(0, boundary.index));
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
    }
    return frames;
  }

  finish(): void {
    if (this.buffer.trim() !== "") {
      throw protocolError(
        this.provider,
        this.capability,
        "OpenAI-compatible stream ended with an incomplete SSE frame."
      );
    }
  }
}

function findFrameBoundary(value: string): { index: number; length: number } | undefined {
  let best: { index: number; length: number } | undefined;
  for (const [separator, length] of [
    ["\r\n\r\n", 4],
    ["\n\n", 2],
    ["\r\r", 2]
  ] as const) {
    const index = value.indexOf(separator);
    if (index >= 0 && (!best || index < best.index)) {
      best = { index, length };
    }
  }
  return best;
}

function parseSseData(frame: string, provider: string, capability: ProviderCapability): string {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      throw protocolError(
        provider,
        capability,
        "OpenAI-compatible SSE frame had an invalid field."
      );
    }
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      if (event !== undefined) {
        throw protocolError(provider, capability, "OpenAI-compatible SSE frame repeated event.");
      }
      event = value;
    } else if (field === "data") {
      data.push(value);
    } else {
      throw protocolError(
        provider,
        capability,
        "OpenAI-compatible SSE frame used an unknown field."
      );
    }
  }
  if (event !== undefined && event !== "message") {
    throw protocolError(provider, capability, "OpenAI-compatible SSE frame used an unknown event.");
  }
  if (data.length === 0) {
    throw protocolError(
      provider,
      capability,
      "OpenAI-compatible SSE frame must contain a data line."
    );
  }
  // SSE permits multiple data fields in one event. Per the event-stream
  // specification, they are joined with a newline before dispatching the
  // event payload. Some OpenAI-compatible gateways split large JSON payloads
  // this way, so rejecting them as malformed breaks otherwise valid streams.
  return data.join("\n");
}

function normalizeUsage(
  value: unknown,
  provider: string,
  capability: ProviderCapability
): TokenUsage | undefined {
  if (!isRecord(value)) {
    throw protocolError(provider, capability, "OpenAI-compatible usage frame was invalid.");
  }
  const usage = value as OpenAIStreamUsage;
  const promptTokenDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : undefined;
  return {
    inputTokens: numberOrUndefined(usage.prompt_tokens),
    outputTokens: numberOrUndefined(usage.completion_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
    cachedInputTokens: numberOrUndefined(promptTokenDetails?.["cached_tokens"])
  };
}

function normalizeFinishReason(value: unknown): ChatOutput["finishReason"] {
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

async function createStatusError(
  provider: string,
  capability: ProviderCapability,
  response: Response
): Promise<ProviderError> {
  let detail = "";
  try {
    detail = redactSecrets((await response.text()).slice(0, 500));
  } catch {
    // Keep the status-only message when the body cannot be read.
  }
  return new ProviderError({
    provider,
    capability,
    code:
      response.status === 401
        ? ProviderErrorCode.InvalidApiKey
        : response.status === 403
          ? ProviderErrorCode.PermissionDenied
          : response.status === 404
            ? ProviderErrorCode.ModelNotFound
            : response.status === 429
              ? ProviderErrorCode.RateLimited
              : ProviderErrorCode.ProviderUnavailable,
    statusCode: response.status,
    message: detail
      ? `${provider} ${capability} request failed with ${response.status}: ${detail}`
      : `${provider} ${capability} request failed with ${response.status}.`,
    retryable: response.status >= 500 || response.status === 429
  });
}

function protocolError(
  provider: string,
  capability: ProviderCapability,
  message: string,
  cause?: unknown
): ProviderError {
  return new ProviderError({
    provider,
    capability,
    code: ProviderErrorCode.MalformedResponse,
    message,
    retryable: false,
    cause
  });
}

function cancelledError(
  provider: string,
  capability: ProviderCapability,
  cause?: unknown
): ProviderError {
  return new ProviderError({
    provider,
    capability,
    code: ProviderErrorCode.Cancelled,
    message: `${provider} ${capability} stream was cancelled.`,
    retryable: false,
    cause
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._~+/=-]+/g, "sk-[REDACTED]")
    .replace(/(api[-_]?key|authorization|token|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
