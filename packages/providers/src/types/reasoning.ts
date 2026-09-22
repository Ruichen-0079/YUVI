import { ProviderError, ProviderErrorCode } from "./errors.js";
import type {
  ProviderCallOptions,
  ProviderHealth,
  ProviderMetadata,
  TextMessage
} from "./common.js";

export type ReasoningInput = {
  messages: TextMessage[];
  model?: string | undefined;
  effort?: "low" | "medium" | "high" | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  /**
   * @deprecated `generateReasoning()` is always non-streaming. This field is
   * retained only for input compatibility and must not change the transport
   * mode.
   */
  stream?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ReasoningOutput = ProviderMetadata & {
  /**
   * Legacy structural compatibility field. It is not a raw provider
   * reasoning/internal-trace channel; normalized adapters leave it empty
   * unless a future explicitly safe summary is defined.
   */
  reasoning: string;
  /** Authoritative normalized business result for the reasoning operation. */
  answer: string;
  /** Reserved compatibility value; Runtime tool/function calling is unsupported. */
  finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "unknown" | undefined;
};

type ReasoningOutputCandidate = ProviderMetadata & {
  reasoning?: string | undefined;
  answer?: string | undefined;
  finishReason?: ReasoningOutput["finishReason"];
};

/**
 * Normalize a provider reasoning result at the capability boundary.
 *
 * Raw vendor reasoning content is intentionally discarded. A successful
 * reasoning operation must expose a non-empty final answer, while the legacy
 * `reasoning` field remains structurally valid without carrying hidden
 * provider deliberation into Runtime, UI, or Memory.
 */
export function normalizeReasoningOutput(
  provider: string,
  output: ReasoningOutputCandidate
): ReasoningOutput {
  if (typeof output.answer !== "string" || output.answer.trim().length === 0) {
    throw new ProviderError({
      provider,
      capability: "reasoning",
      code: ProviderErrorCode.MalformedResponse,
      message: `${provider} reasoning response did not include a non-empty final answer.`,
      retryable: false
    });
  }

  return {
    ...output,
    reasoning: "",
    answer: output.answer
  };
}

export type ReasoningCallOptions = ProviderCallOptions & {
  /** Runtime-bounded interactions may prohibit hidden provider-chain expansion. */
  allowFallback?: boolean | undefined;
};

export interface ReasoningProvider {
  readonly name: string;
  healthCheck(): Promise<ProviderHealth>;
  generateReasoning(input: ReasoningInput, options?: ReasoningCallOptions): Promise<ReasoningOutput>;
}
