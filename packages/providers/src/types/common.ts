export type ProviderCapability = "chat" | "reasoning" | "tts" | "stt" | "vision" | "embedding";

/** Local configuration state. This zero-I/O axis never implies remote reachability. */
export type ProviderReadinessState = "ready" | "not_ready";

/**
 * The most recent explicitly observed provider state. This is a registry-local
 * cache populated only by explicit live verification and reset when that
 * registry instance is replaced or reloaded.
 */
export type ProviderObservedState = "unknown" | "available" | "degraded" | "unavailable";

/**
 * How an explicit provider verification request was performed. Config-only
 * inspection performs no provider I/O; live verification may perform remote
 * (and potentially billable) provider I/O.
 */
export type ProviderVerificationMode = "live" | "config_only";

/**
 * Call-level controls shared by every provider capability.
 *
 * A caller-owned signal is the canonical cancellation channel. Provider
 * adapters are responsible for propagating it to their underlying transport;
 * capability-specific input fields must not become a second control plane.
 */
export type ProviderCallOptions = {
  signal?: AbortSignal | undefined;
};

export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable";

export type ProviderHealth = {
  status: ProviderHealthStatus;
  provider: string;
  name?: string | undefined;
  capability?: ProviderCapability | undefined;
  /** Canonical local configuration/readiness axis. */
  readiness?: ProviderReadinessState | undefined;
  /** Canonical cached observation axis; unknown means not live-verified. */
  observed?: ProviderObservedState | undefined;
  configured?: boolean | undefined;
  /** Compatibility projection of local readiness; never remote availability. */
  available?: boolean | undefined;
  mock?: boolean | undefined;
  mode?: "real" | "mock" | "unavailable" | undefined;
  mockAllowed?: boolean | undefined;
  missingFields?: string[] | undefined;
  required?: boolean | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  dimensions?: number | undefined;
  semanticEmbedding?: boolean | undefined;
  embeddingNote?: string | undefined;
  latencyMs?: number;
  checkedAt: string;
  message?: string;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  /**
   * Route/readiness projection: whether this configured identity is locally
   * ready to occupy a fallback-chain slot. This is not call-error permission;
   * see `ProviderError.fallbackEligible`.
   */
  fallbackEligible?: boolean | undefined;
  lastVerifiedAt?: string | undefined;
  lastErrorCode?: string | undefined;
  lastError?: string | undefined;
};

export type ProviderRouteStatus = ProviderHealth & {
  capability: ProviderCapability;
  provider: string;
  enabled: boolean;
  priority: number;
  /**
   * Local readiness of this configured route inside the fallback chain.
   * A true value means the route can be constructed from local config (or
   * intentional mock mode). It does not mean a thrown call error permits
   * switching providers; that permission lives on `ProviderError.fallbackEligible`.
   */
  fallbackEligible: boolean;
};

export type ProviderAttempt = {
  provider: string;
  model?: string | undefined;
  /**
   * `success`/`failed`/`unavailable` describe a call outcome. `skipped` means
   * that this route was not called, including config-only route inspection.
   */
  status: "success" | "failed" | "skipped" | "unavailable";
  errorCode?: string | undefined;
  error?: string | undefined;
  latencyMs?: number | undefined;
  configured?: boolean | undefined;
  enabled?: boolean | undefined;
  priority?: number | undefined;
};

export type TokenUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  /** Provider-reported input tokens served from a prompt cache, when available. */
  cachedInputTokens?: number | undefined;
};

export type ProviderDebug = {
  rawResponse?: unknown | undefined;
};

export type ProviderMetadata = {
  sourceAttemptId?: string | undefined;
  /** Capability that produced this output when the output is carried alone. */
  capability?: ProviderCapability | undefined;
  /** Concrete provider identity that produced this output. */
  provider?: string | undefined;
  model?: string | undefined;
  requestId?: string | undefined;
  providerRequestId?: string | undefined;
  latencyMs?: number | undefined;
  firstByteLatencyMs?: number | undefined;
  firstTokenLatencyMs?: number | undefined;
  tokenUsage?: TokenUsage | undefined;
  audioInputDurationMs?: number | undefined;
  audioOutputDurationMs?: number | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
  fallbackUsed?: boolean | undefined;
  attemptedProviders?: ProviderAttempt[] | undefined;
  finalProvider?: string | undefined;
  /**
   * Debug metadata is opt-in and must never be emitted in runtime protocol events.
   */
  debug?: ProviderDebug | undefined;
};

export type TextMessageRole = "system" | "user" | "assistant" | "tool";

export type TextMessage = {
  role: TextMessageRole;
  content: string;
};
