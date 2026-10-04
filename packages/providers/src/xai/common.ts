import { providerFetch as fetch } from "../invocation-witness.js";
import type { ProviderCapability, ProviderHealth } from "../types/common.js";
import {
  ProviderError,
  ProviderErrorCode,
  mapHttpStatusToProviderErrorCode
} from "../types/errors.js";
import { createTransportAbort, type TransportAbort } from "../transport-abort.js";

export type XAIProviderOptions = {
  provider?: string;
  allowAnonymous?: boolean;
  apiKey: string | undefined;
  baseUrl: string;
  model: string | undefined;
  timeoutMs?: number | undefined;
  includeRawResponse?: boolean | undefined;
};

export async function healthCheckXAI(
  provider: string,
  capability: ProviderCapability,
  options: XAIProviderOptions
): Promise<ProviderHealth> {
  const start = performance.now();
  const transport = createTransportAbort({ timeoutMs: options.timeoutMs ?? 30000 });

  try {
    ensureXAIConfig(provider, capability, options);
    if (!transport.markStarted()) {
      throwIfXAITransportAborted(provider, capability, transport);
      throw new Error("xAI health-check transport could not start.");
    }
    const response = await xaiFetch(options, "/models", { method: "GET" }, transport.signal);
    throwIfXAITransportAborted(provider, capability, transport);
    if (!response.ok) {
      throw await createXAIStatusError(provider, capability, response);
    }

    return {
      provider,
      status: "healthy",
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start)
    };
  } catch (error) {
    return {
      provider,
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start),
      message: error instanceof Error ? error.message : "xAI health check failed."
    };
  } finally {
    transport.cleanup();
  }
}

export function ensureXAIConfig(
  provider: string,
  capability: ProviderCapability,
  options: XAIProviderOptions
): void {
  if (!options.apiKey && !options.allowAnonymous) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MissingApiKey,
      message: "XAI_API_KEY is required.",
      retryable: false
    });
  }

  if (!options.model) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.ModelNotFound,
      message: `xAI ${capability} model is not configured.`,
      retryable: false
    });
  }
}

export async function xaiFetch(
  options: XAIProviderOptions,
  path: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  return fetch(`${trimTrailingSlash(options.baseUrl)}${path}`, {
    ...init,
    headers: {
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      ...init.headers
    },
    signal
  });
}

export async function parseJsonResponse(
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
      message: "xAI returned a non-JSON response.",
      retryable: false,
      cause: error
    });
  }
}

export async function createXAIStatusError(
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
      ? `xAI request failed with ${response.status}: ${safeBody}`
      : `xAI request failed with ${response.status}.`
  });
}

export function throwIfXAITransportAborted(
  provider: string,
  capability: ProviderCapability,
  transport: TransportAbort
): void {
  if (transport.source !== null) {
    throw createXAITransportAbortError(provider, capability, transport);
  }
}

export function createXAITransportAbortError(
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
    message: "xAI request timed out.",
    effectState: transport.effectState ?? "unknown"
  });
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
