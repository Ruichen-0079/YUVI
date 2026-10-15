import type { JournalEventRef } from "@companion/protocol";
import type { VisionOutput } from "@companion/providers";

export type ObservationEvidence = Readonly<{
  schema: "observation.v1";
  id: string;
  kind: "VISION" | "READ_TEXT";
  availability: "AVAILABLE" | "UNAVAILABLE";
  unavailableReason?: "EXPIRED" | "DELETED" | "SOURCE_AUTHORITY_UNAVAILABLE" | undefined;
  source: JournalEventRef;
  observedAt: string;
  expiresAt: string;
  action: { attemptId: string; contractRef: string; certainty: "APPLIED" };
  /** Execution success says nothing about overall Cognition goal completion. */
  goalStatus: "NOT_INFERRED";
  coverage: "BOUNDED_PROVIDER_REPORT";
  provider: string | null;
  model: string | null;
  evidence?:
    | { text: string; sceneSummary: string; objects: string[]; confidence: number | null }
    | undefined;
  sourceArtifact: "AVAILABLE" | "NOT_RETAINED" | "UNAVAILABLE";
}>;
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
  saveVision(
    context: ObservationContext,
    output: VisionOutput,
    image?: { imageBase64: string; mimeType: string }
  ): Promise<void>;
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
    text: (fields.text ?? "").slice(0, 32000),
    sceneSummary: (fields.sceneSummary ?? "").slice(0, 4000),
    objects: (fields.objects ?? []).slice(0, 32).map((o) => o.slice(0, 160)),
    confidence:
      typeof fields.confidence === "number" && Number.isFinite(fields.confidence)
        ? Math.max(0, Math.min(1, fields.confidence))
        : null
  };
}
function boundedJsonText(value: string, budget: number): string {
  if (JSON.stringify(value).length <= budget) return value;
  let take = Math.min(value.length - 1, budget);
  while (take > 0) {
    const half = Math.floor(take / 2);
    const text = value.slice(0, half) + " […middle omitted…] " + value.slice(-half);
    if (JSON.stringify(text).length <= budget) return text;
    take -= Math.max(1, Math.ceil((JSON.stringify(text).length - budget) / 2));
  }
  return "[…omitted…]";
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
