import type { ProviderAttempt, ProviderCapability } from "./common.js";

export const ProviderErrorCode = {
  MissingApiKey: "MISSING_API_KEY",
  InvalidApiKey: "INVALID_API_KEY",
  PermissionDenied: "PERMISSION_DENIED",
  ModelNotFound: "MODEL_NOT_FOUND",
  RateLimited: "RATE_LIMITED",
  Timeout: "TIMEOUT",
  Cancelled: "CANCELLED",
  NetworkError: "NETWORK_ERROR",
  MalformedResponse: "MALFORMED_RESPONSE",
  UnsupportedInput: "UNSUPPORTED_INPUT",
  ProviderUnavailable: "PROVIDER_UNAVAILABLE"
} as const;

export type ProviderErrorCode = (typeof ProviderErrorCode)[keyof typeof ProviderErrorCode];

/**
 * Whether a normalized provider operation may be executed again without
 * producing a second Runtime/user-consumed business result.
 *
 * `committed` is intentionally not named "completed": Chat streams use
 * `completed` as an event type, and the first visible text-delta already
 * commits the business effect.
 */
export type ProviderEffectState = "not_started" | "unknown" | "committed";

export type ProviderErrorPolicy = {
  retryable: boolean;
  fallbackEligible: boolean;
  effectState: ProviderEffectState;
};

export type ProviderErrorOptions = {
  provider: string;
  capability: ProviderCapability;
  code: ProviderErrorCode;
  message: string;
  retryable?: boolean;
  /**
   * Call-error permission to switch provider identity. This is not route
   * readiness; see `ProviderRouteStatus.fallbackEligible`.
   */
  fallbackEligible?: boolean;
  effectState?: ProviderEffectState;
  statusCode?: number;
  cause?: unknown;
  attemptedProviders?: ProviderAttempt[];
};

export type ProviderFallbackContext = {
  signal?: AbortSignal | undefined;
  anotherProviderExists: boolean;
  visibleOutput?: boolean | undefined;
  completed?: boolean | undefined;
};

export class ProviderError extends Error {
  readonly provider: string;
  readonly capability: ProviderCapability;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  /** Call-error permission to switch provider identity. */
  readonly fallbackEligible: boolean;
  readonly effectState: ProviderEffectState;
  readonly statusCode: number | undefined;
  override readonly cause: unknown;
  readonly attemptedProviders: ProviderAttempt[] | undefined;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.capability = options.capability;
    this.code = options.code;
    const policy = resolveProviderErrorPolicy({
      code: options.code,
      statusCode: options.statusCode,
      retryable: options.retryable,
      fallbackEligible: options.fallbackEligible,
      effectState: options.effectState
    });
    this.retryable = policy.retryable;
    this.fallbackEligible = policy.fallbackEligible;
    this.effectState = policy.effectState;
    this.statusCode = options.statusCode;
    this.cause = options.cause;
    this.attemptedProviders = options.attemptedProviders;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      provider: this.provider,
      capability: this.capability,
      code: this.code,
      retryable: this.retryable,
      statusCode: this.statusCode,
      // Transport messages may include upstream response bodies. Keep the
      // public diagnostic useful without serializing prompts, credentials or
      // provider supplied error text.
      message: `${this.provider} ${this.capability} failed (${this.code}).`
    };
  }
}

export function isProviderReplaySafe(effectState: ProviderEffectState): boolean {
  return effectState === "not_started";
}

export function isSafeToReplay(error: ProviderError): boolean {
  return isProviderReplaySafe(error.effectState);
}

/**
 * Coarse code-only retryability. Prefer `ProviderError.retryable` or
 * `resolveProviderErrorPolicy` when status/effect context exists.
 *
 * `PROVIDER_UNAVAILABLE` is not retryable without remote status context;
 * local placeholders are configuration failures, not transient transport
 * faults.
 */
export function isRetryableProviderError(code: ProviderErrorCode): boolean {
  return resolveProviderErrorPolicy({ code }).retryable;
}

export function resolveProviderErrorPolicy(input: {
  code: ProviderErrorCode;
  statusCode?: number | undefined;
  retryable?: boolean | undefined;
  fallbackEligible?: boolean | undefined;
  effectState?: ProviderEffectState | undefined;
}): ProviderErrorPolicy {
  const effectState = input.effectState ?? defaultEffectState(input.code, input.statusCode);
  return {
    retryable: input.retryable ?? defaultRetryable(input.code, input.statusCode),
    fallbackEligible: input.fallbackEligible ?? defaultFallbackEligible(input.code, effectState),
    effectState
  };
}

export function normalizeProviderError(
  error: unknown,
  context: {
    provider: string;
    capability: ProviderCapability;
    signal?: AbortSignal | undefined;
    effectState?: ProviderEffectState | undefined;
  }
): ProviderError {
  if (context.signal?.aborted) {
    const provider = error instanceof ProviderError ? error.provider : context.provider;
    return new ProviderError({
      provider,
      capability: context.capability,
      code: ProviderErrorCode.Cancelled,
      message: `${provider} ${context.capability} was cancelled.`,
      retryable: false,
      fallbackEligible: false,
      effectState:
        context.effectState ?? (error instanceof ProviderError ? error.effectState : "unknown"),
      cause: error instanceof ProviderError ? error.cause : error,
      ...(error instanceof ProviderError && error.attemptedProviders
        ? { attemptedProviders: error.attemptedProviders }
        : {})
    });
  }

  if (error instanceof ProviderError) {
    return error;
  }

  return new ProviderError({
    provider: context.provider,
    capability: context.capability,
    code: ProviderErrorCode.ProviderUnavailable,
    message: `${context.provider} ${context.capability} failed.`,
    retryable: false,
    fallbackEligible: true,
    effectState: context.effectState ?? "unknown",
    cause: error
  });
}

/**
 * Authoritative chain-switching predicate. `ProviderError.fallbackEligible`
 * is only the error-level permission snapshot.
 */
export function canFallbackProviderError(
  error: ProviderError,
  context: ProviderFallbackContext
): boolean {
  return (
    error.fallbackEligible &&
    error.code !== ProviderErrorCode.Cancelled &&
    !context.signal?.aborted &&
    // A provider hop is another concrete external invocation. Once the first
    // invocation crossed its boundary, UNKNOWN is not evidence that it did not
    // apply. Only an explicit pre-dispatch/no-invocation disposition permits
    // fallback; retryable and fallbackEligible are policy hints, not effect
    // evidence.
    error.effectState === "not_started" &&
    context.anotherProviderExists &&
    !context.visibleOutput &&
    !context.completed
  );
}

export function cloneProviderError(
  error: ProviderError,
  overrides: Partial<ProviderErrorOptions> = {}
): ProviderError {
  const statusCode = overrides.statusCode ?? error.statusCode;
  const attemptedProviders = overrides.attemptedProviders ?? error.attemptedProviders;
  const cause = "cause" in overrides ? overrides.cause : error.cause;
  return new ProviderError({
    provider: overrides.provider ?? error.provider,
    capability: overrides.capability ?? error.capability,
    code: overrides.code ?? error.code,
    message: overrides.message ?? error.message,
    retryable: overrides.retryable ?? error.retryable,
    fallbackEligible: overrides.fallbackEligible ?? error.fallbackEligible,
    effectState: overrides.effectState ?? error.effectState,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(attemptedProviders ? { attemptedProviders } : {})
  });
}

/**
 * Shared HTTP status → code contract. Leaf transports still have mapping
 * drift; P7-4C owns applying this helper across real fetch adapters.
 */
export function mapHttpStatusToProviderErrorCode(status: number): ProviderErrorCode {
  if (status === 400 || status === 413 || status === 415) {
    return ProviderErrorCode.UnsupportedInput;
  }
  if (status === 401) {
    return ProviderErrorCode.InvalidApiKey;
  }
  if (status === 403) {
    return ProviderErrorCode.PermissionDenied;
  }
  if (status === 404) {
    return ProviderErrorCode.ModelNotFound;
  }
  if (status === 408) {
    return ProviderErrorCode.Timeout;
  }
  if (status === 429) {
    return ProviderErrorCode.RateLimited;
  }
  return ProviderErrorCode.ProviderUnavailable;
}

function defaultEffectState(
  code: ProviderErrorCode,
  statusCode: number | undefined
): ProviderEffectState {
  switch (code) {
    case ProviderErrorCode.MissingApiKey:
      return "not_started";
    case ProviderErrorCode.InvalidApiKey:
    case ProviderErrorCode.ModelNotFound:
    case ProviderErrorCode.UnsupportedInput:
    case ProviderErrorCode.ProviderUnavailable:
      return statusCode === undefined ? "not_started" : "unknown";
    case ProviderErrorCode.Cancelled:
    case ProviderErrorCode.PermissionDenied:
    case ProviderErrorCode.RateLimited:
    case ProviderErrorCode.Timeout:
    case ProviderErrorCode.NetworkError:
    case ProviderErrorCode.MalformedResponse:
      return "unknown";
  }
}

function defaultRetryable(code: ProviderErrorCode, statusCode: number | undefined): boolean {
  switch (code) {
    case ProviderErrorCode.RateLimited:
    case ProviderErrorCode.Timeout:
    case ProviderErrorCode.NetworkError:
      return true;
    case ProviderErrorCode.ProviderUnavailable:
      return statusCode !== undefined;
    default:
      return false;
  }
}

function defaultFallbackEligible(
  code: ProviderErrorCode,
  effectState: ProviderEffectState
): boolean {
  if (code === ProviderErrorCode.Cancelled) {
    return false;
  }
  if (code === ProviderErrorCode.UnsupportedInput) {
    return effectState !== "not_started";
  }
  return true;
}

// Host transport/preflight evidence, deliberately absent from serialized ProviderError policy.
// Only code which has proved it never entered its concrete transport may call this helper.
const certifiedPreTransportErrors = new WeakSet<ProviderError>();
export function certifyProviderNotStarted(error: ProviderError): ProviderError {
  if (error.effectState !== "not_started" || error.statusCode !== undefined)
    throw new Error("Pre-transport certification requires no invocation and no remote response.");
  certifiedPreTransportErrors.add(error);
  return error;
}
export function isCertifiedProviderNotStarted(error: unknown): error is ProviderError {
  return error instanceof ProviderError && certifiedPreTransportErrors.has(error);
}
