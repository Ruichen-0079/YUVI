import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type {
  ProviderCallOptions,
  ProviderHealth,
  TextMessage,
  TokenUsage
} from "../types/common.js";
import { ProviderError, ProviderErrorCode } from "../types/errors.js";
import { createTransportAbort } from "../transport-abort.js";
import type { VisionInput, VisionOutput, VisionProvider } from "../types/vision.js";
import {
  createXAIStatusError,
  createXAITransportAbortError,
  ensureXAIConfig,
  healthCheckXAI,
  parseJsonResponse,
  throwIfXAITransportAborted,
  xaiFetch,
  type XAIProviderOptions
} from "./common.js";

type XAIChatResponse = {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Map([
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/png", "image/png"]
]);

export class XAIVisionProvider implements VisionProvider {
  get name(): string {
    return this.options.provider ?? "xai";
  }

  constructor(private readonly options: XAIProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    return healthCheckXAI(this.name, "vision", this.options);
  }

  async analyzeImage(input: VisionInput, options?: ProviderCallOptions): Promise<VisionOutput> {
    const transport = createTransportAbort({
      signal: options?.signal,
      timeoutMs: this.options.timeoutMs ?? 30000
    });
    let transportStarted = false;

    try {
      throwIfXAITransportAborted(this.name, "vision", transport);
      ensureXAIConfig(this.name, "vision", this.options);

      const start = performance.now();
      const imageUrl = await resolveImageUrl(input, transport);
      throwIfXAITransportAborted(this.name, "vision", transport);
      if (!transport.markStarted()) {
        throwIfXAITransportAborted(this.name, "vision", transport);
        throw new Error("xAI vision transport could not start.");
      }
      transportStarted = true;
      const response = await xaiFetch(
        this.options,
        "/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: buildVisionMessages(input, imageUrl),
            // The shared OpenAI-compatible adapter also serves official DeepSeek Vision.
            // Visual grounding supplies bounded observations; Character owns cognition.
            ...(new URL(this.options.baseUrl).hostname === "api.deepseek.com"
              ? { thinking: { type: "disabled" }, max_tokens: 1024 }
              : {})
          })
        },
        transport.signal
      );
      if (!response.ok) {
        throw await createXAIStatusError(this.name, "vision", response);
      }

      const rawResponse = await parseJsonResponse(this.name, "vision", response);
      throwIfXAITransportAborted(this.name, "vision", transport);
      const normalized = normalizeVisionResponse(rawResponse);

      return {
        text: normalized.text,
        sceneSummary: normalized.text,
        latencyMs: Math.round(performance.now() - start),
        model: normalized.model,
        tokenUsage: normalized.tokenUsage,
        debug: this.options.includeRawResponse ? { rawResponse } : undefined
      };
    } catch (error) {
      if (transport.source !== null) {
        throw createXAITransportAbortError(this.name, "vision", transport);
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      if (!transportStarted) {
        throw error;
      }
      throw new ProviderError({
        provider: this.name,
        capability: "vision",
        code: ProviderErrorCode.NetworkError,
        message: "xAI vision network request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }
}

async function resolveImageUrl(
  input: VisionInput,
  transport: ReturnType<typeof createTransportAbort>
): Promise<string> {
  if (input.imageUrl) {
    return normalizeImageUrl(input.imageUrl);
  }

  if (input.imageBase64) {
    return normalizeImageBase64(input.imageBase64, input.mimeType);
  }

  const buffer = input.imageBuffer ?? input.image;
  if (buffer) {
    return normalizeImageBytes(buffer, input.mimeType);
  }

  if (input.localFilePath) {
    const fileMimeType = mimeTypeFromPath(input.localFilePath);
    const requestedMimeType = input.mimeType
      ? normalizeImageMimeType(input.mimeType)
      : fileMimeType;
    if (requestedMimeType !== fileMimeType) {
      throw unsupportedVisionInput(
        `Vision local file MIME type ${requestedMimeType} does not match ${fileMimeType}.`
      );
    }

    throwIfXAITransportAborted("xai", "vision", transport);
    const fileStats = await stat(input.localFilePath);
    throwIfXAITransportAborted("xai", "vision", transport);
    if (fileStats.size === 0) {
      throw unsupportedVisionInput("Vision local image files must not be empty.");
    }
    if (fileStats.size > MAX_IMAGE_BYTES) {
      throw unsupportedVisionInput("Vision local image files must not exceed 20 MiB.");
    }

    const file = await readFile(input.localFilePath, { signal: transport.signal });
    throwIfXAITransportAborted("xai", "vision", transport);
    if (file.byteLength === 0) {
      throw unsupportedVisionInput("Vision local image files must not be empty.");
    }
    if (file.byteLength > MAX_IMAGE_BYTES) {
      throw unsupportedVisionInput("Vision local image files must not exceed 20 MiB.");
    }
    return toDataUrl(file.toString("base64"), fileMimeType);
  }

  throw unsupportedVisionInput(
    "Vision input must include imageUrl, localFilePath, imageBase64, imageBuffer, or image."
  );
}

function buildVisionMessages(
  input: VisionInput,
  imageUrl: string
): Array<{
  role: TextMessage["role"];
  content: string | Array<Record<string, unknown>>;
}> {
  const prompt = input.prompt ?? "Analyze this image.";
  const priorMessages =
    input.messages?.map((message) => ({
      role: message.role,
      content: message.content
    })) ?? [];

  return [
    ...priorMessages,
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: imageUrl
          }
        },
        {
          type: "text",
          text: prompt
        }
      ]
    }
  ];
}

function normalizeVisionResponse(rawResponse: unknown): {
  text: string;
  model?: string | undefined;
  tokenUsage?: TokenUsage | undefined;
} {
  if (!isXAIChatResponse(rawResponse)) {
    throw new ProviderError({
      provider: "xai",
      capability: "vision",
      code: ProviderErrorCode.MalformedResponse,
      message: "xAI vision response did not match the expected chat completion shape.",
      retryable: false,
      cause: rawResponse
    });
  }

  const text = rawResponse.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ProviderError({
      provider: "xai",
      capability: "vision",
      code: ProviderErrorCode.MalformedResponse,
      message: "xAI vision response did not include text content.",
      retryable: false,
      cause: rawResponse
    });
  }

  return {
    text,
    model: rawResponse.model,
    tokenUsage: normalizeUsage(rawResponse.usage)
  };
}

function isXAIChatResponse(value: unknown): value is XAIChatResponse {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as XAIChatResponse).choices)
  );
}

function normalizeUsage(usage: XAIChatResponse["usage"]): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const inputTokens = normalizeTokenCount(usage.prompt_tokens);
  const outputTokens = normalizeTokenCount(usage.completion_tokens);
  const totalTokens = normalizeTokenCount(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

function normalizeImageUrl(imageUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch (error) {
    throw unsupportedVisionInput("Vision imageUrl must be a valid URL.", error);
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return imageUrl;
  }
  if (parsed.protocol === "data:") {
    return normalizeDataUrl(imageUrl);
  }
  throw unsupportedVisionInput(`Vision imageUrl scheme ${parsed.protocol} is not supported.`);
}

function normalizeImageBase64(base64: string, mimeType: string | undefined): string {
  if (/^data:/i.test(base64)) {
    return normalizeDataUrl(base64);
  }

  if (!mimeType) {
    throw unsupportedVisionInput(
      "Vision raw imageBase64 requires a supported mimeType of image/jpeg or image/png."
    );
  }
  validateBase64Payload(base64);
  return toDataUrl(base64, normalizeImageMimeType(mimeType));
}

function normalizeImageBytes(bytes: Uint8Array, mimeType: string | undefined): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw unsupportedVisionInput("Vision image bytes must be a non-empty Uint8Array.");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw unsupportedVisionInput("Vision image bytes must not exceed 20 MiB.");
  }
  if (!mimeType) {
    throw unsupportedVisionInput(
      "Vision image bytes require a supported mimeType of image/jpeg or image/png."
    );
  }
  return toDataUrl(Buffer.from(bytes).toString("base64"), normalizeImageMimeType(mimeType));
}

function normalizeDataUrl(value: string): string {
  const match = /^data:([^;,\s]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) {
    throw unsupportedVisionInput(
      "Vision data URLs must use supported image MIME types and base64 encoding."
    );
  }
  const rawMimeType = match[1];
  const payload = match[2];
  if (rawMimeType === undefined || payload === undefined) {
    throw unsupportedVisionInput(
      "Vision data URLs must use supported image MIME types and base64 encoding."
    );
  }
  const mimeType = normalizeImageMimeType(rawMimeType);
  validateBase64Payload(payload);
  return toDataUrl(payload, mimeType);
}

function normalizeImageMimeType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  const normalized = mediaType ? SUPPORTED_IMAGE_MIME_TYPES.get(mediaType) : undefined;
  if (!normalized) {
    throw unsupportedVisionInput(
      `Vision MIME type ${value} is unsupported; use image/jpeg or image/png.`
    );
  }
  return normalized;
}

function validateBase64Payload(payload: string): void {
  if (payload.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    throw unsupportedVisionInput("Vision imageBase64 must contain valid non-empty base64 data.");
  }

  const paddingIndex = payload.indexOf("=");
  if (paddingIndex >= 0 && payload.length % 4 !== 0) {
    throw unsupportedVisionInput("Vision imageBase64 has invalid base64 padding.");
  }

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const estimatedBytes = Math.floor((payload.length * 3) / 4) - padding;
  if (estimatedBytes > MAX_IMAGE_BYTES) {
    throw unsupportedVisionInput("Vision inline images must not exceed 20 MiB.");
  }

  const decoded = Buffer.from(payload, "base64");
  if (decoded.byteLength === 0) {
    throw unsupportedVisionInput("Vision imageBase64 must decode to non-empty image bytes.");
  }
  if (decoded.byteLength > MAX_IMAGE_BYTES) {
    throw unsupportedVisionInput("Vision inline images must not exceed 20 MiB.");
  }

  const normalizedInput = payload.replace(/=+$/, "");
  const normalizedCanonical = decoded.toString("base64").replace(/=+$/, "");
  if (normalizedInput !== normalizedCanonical) {
    throw unsupportedVisionInput("Vision imageBase64 is not canonically encoded.");
  }
}

function normalizeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toDataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

function unsupportedVisionInput(message: string, cause?: unknown): ProviderError {
  return new ProviderError({
    provider: "xai",
    capability: "vision",
    code: ProviderErrorCode.UnsupportedInput,
    message,
    retryable: false,
    fallbackEligible: false,
    effectState: "not_started",
    ...(cause !== undefined ? { cause } : {})
  });
}

function mimeTypeFromPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".png") {
    return "image/png";
  }

  throw unsupportedVisionInput(
    `Vision local file extension ${extension || "(missing)"} is unsupported; use .jpg, .jpeg, or .png.`
  );
}
