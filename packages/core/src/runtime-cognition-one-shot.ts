import {
  ProviderError,
  ProviderErrorCode,
  type ProviderResolver,
  type ReasoningInput,
  type ReasoningOutput
} from "@companion/providers";

export const RUNTIME_COGNITION_FAILURE_STATUSES = ["UNAVAILABLE", "CANCELLED", "ERROR"] as const;
export type RuntimeCognitionFailureStatus = (typeof RUNTIME_COGNITION_FAILURE_STATUSES)[number];

/**
 * Narrow Phase-6 seam owned by Runtime.
 *
 * The boundary owns semantic validation/normalization. Runtime owns provider
 * selection and one-shot execution. Keeping these functions injected prevents
 * Core from acquiring Character ABI or Harness authority.
 */
export type RuntimeCognitionBoundary<TResult> = Readonly<{
  createReasoningInput(task: unknown): ReasoningInput;
  normalizeReasoningOutput(output: ReasoningOutput): TResult;
  createFailureResult(input: Readonly<{ status: RuntimeCognitionFailureStatus }>): TResult;
}>;

export type RuntimeCognitionOneShotInput<TResult> = Readonly<{
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  boundary: RuntimeCognitionBoundary<TResult>;
  task: unknown;
  signal?: AbortSignal | undefined;
  allowFallback?: boolean | undefined;
}>;

/**
 * Execute one already-admitted cognition task through the existing reasoning
 * provider seam.
 *
 * Contract misuse is validated before provider selection and is allowed to
 * throw. Once a valid task reaches provider execution, provider/transport or
 * output-normalization failures are reduced to the bounded Phase-6 failure
 * statuses. This function never retries, falls back, persists, invokes tools,
 * or emits user-visible effects.
 */
export async function executeRuntimeCognitionOnce<TResult>(
  input: RuntimeCognitionOneShotInput<TResult>
): Promise<TResult> {
  const reasoningInput = input.boundary.createReasoningInput(input.task);

  if (input.signal?.aborted) {
    return input.boundary.createFailureResult({ status: "CANCELLED" });
  }

  let provider: ReturnType<ProviderResolver["getReasoningProvider"]>;
  try {
    provider = input.providers.getReasoningProvider();
  } catch (error) {
    return input.boundary.createFailureResult({
      status: classifyRuntimeCognitionFailure(error, input.signal)
    });
  }

  try {
    const output = await provider.generateReasoning(reasoningInput, {
      signal: input.signal,
      ...(input.allowFallback === undefined ? {} : { allowFallback: input.allowFallback })
    });

    if (input.signal?.aborted) {
      return input.boundary.createFailureResult({ status: "CANCELLED" });
    }

    try {
      return input.boundary.normalizeReasoningOutput(output);
    } catch {
      return input.boundary.createFailureResult({ status: "ERROR" });
    }
  } catch (error) {
    return input.boundary.createFailureResult({
      status: classifyRuntimeCognitionFailure(error, input.signal)
    });
  }
}

function classifyRuntimeCognitionFailure(
  error: unknown,
  signal: AbortSignal | undefined
): RuntimeCognitionFailureStatus {
  if (signal?.aborted) {
    return "CANCELLED";
  }
  if (!(error instanceof ProviderError)) {
    return "ERROR";
  }

  switch (error.code) {
    case ProviderErrorCode.Cancelled:
      return "CANCELLED";
    case ProviderErrorCode.MissingApiKey:
    case ProviderErrorCode.InvalidApiKey:
    case ProviderErrorCode.PermissionDenied:
    case ProviderErrorCode.ModelNotFound:
    case ProviderErrorCode.ProviderUnavailable:
      return "UNAVAILABLE";
    default:
      return "ERROR";
  }
}
