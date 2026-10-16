import type { JournalEventRef } from "@companion/protocol";
import type { VisionOutput } from "@companion/providers";

import type { ObservationEvidence } from "@companion/protocol";
export type { ObservationEvidence } from "@companion/protocol";
export type ObservationContext = {
  sourceJournalRef?: JournalEventRef | undefined;
  sessionId: string;
};
/** Host owns persistence, disclosure, retention and execution provenance. No queue or new execution ledger. */
export interface RuntimeObservationPort {
  read(
    context: ObservationContext
  ): Promise<{ status: "OK" | "UNAVAILABLE"; records: ObservationEvidence[] }>;
  verify(context: ObservationContext, ids: string[]): Promise<boolean>;
  image(
    context: ObservationContext,
    id: string
  ): Promise<{ imageBase64: string; mimeType: string } | null>;
}

/** Preserve independently budgeted fields; OCR cannot consume scene/object space. */
export function structuredVisualEvidence(
  output: Pick<VisionOutput, "text" | "sceneSummary" | "objects" | "confidence">
) {
  let fields = output;
  try {
    const parsed: unknown = JSON.parse(output.text.replace(/^```(?:json)?\s*|\s*```$/gu, ""));
    if (
      parsed &&
      typeof parsed === "object" &&
      "text" in parsed &&
      typeof parsed.text === "string"
    ) {
      const p = parsed as Record<string, unknown>;
      fields = {
        text: p["text"] as string,
        sceneSummary:
          typeof p["sceneSummary"] === "string" ? p["sceneSummary"] : output.sceneSummary,
        objects:
          Array.isArray(p["objects"]) && p["objects"].every((o) => typeof o === "string")
            ? (p["objects"] as string[])
            : output.objects,
        confidence: typeof p["confidence"] === "number" ? p["confidence"] : output.confidence
      };
    }
  } catch {
    /* Free text stays explicitly a Provider report, never a Runtime instruction. */
  }
  return {
    // Serialized per-field bounds also fit the 80 KB PostgreSQL JSONB contract
    // for CJK/control text. Preserve both ends and mark omissions at storage,
    // before the smaller Context projection applies its separate budget.
    text: boundedJsonText(fields.text ?? "", 16000),
    sceneSummary: boundedJsonText(fields.sceneSummary ?? "", 4000),
    objects: (fields.objects ?? []).slice(0, 32).map((o) => boundedJsonText(o, 160)),
    confidence:
      typeof fields.confidence === "number" && Number.isFinite(fields.confidence)
        ? Math.max(0, Math.min(1, fields.confidence))
        : null
  };
}
function boundedJsonText(value: string, budget: number): string {
  if (JSON.stringify(value).length <= budget) return value;
  let low = 0,
    high = Math.min(value.length - 1, budget);
  let best = "[…omitted…]";
  while (low <= high) {
    const half = Math.floor((low + high) / 2);
    const text = value.slice(0, half) + " […middle omitted…] " + value.slice(-half);
    if (JSON.stringify(text).length <= budget) {
      best = text;
      low = half + 1;
    } else high = half - 1;
  }
  return best;
}
export function observationContextText(e: NonNullable<ObservationEvidence["evidence"]>) {
  const text = boundedJsonText(e.text, 2000),
    sceneSummary = boundedJsonText(e.sceneSummary, 950);
  const objects = e.objects.slice(0, 8).map((o) => boundedJsonText(o, 70));
  return JSON.stringify({
    epistemicState: "UNTRUSTED_PROVIDER_REPORT",
    text,
    textTruncated: text.length < e.text.length,
    sceneSummary,
    sceneTruncated: sceneSummary.length < e.sceneSummary.length,
    objects,
    objectsTruncated:
      e.objects.length > objects.length || objects.some((o, i) => o.length < e.objects[i]!.length),
    confidence: e.confidence
  });
}
