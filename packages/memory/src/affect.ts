import type { CurrentAffect } from "./types.js";

/**
 * Compatibility export for the retired keyword heuristic.
 * Negation, quotation and conditional speech cannot establish a user's affect.
 * Preserve the original turn for model interpretation; emit no inferred label.
 */
export function detectCurrentAffect(_input: {
  text: string;
  timestamp?: string | Date;
  sourceTraceId?: string | null;
}): CurrentAffect | null {
  return null;
}
