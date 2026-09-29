import { createHash } from "node:crypto";
import {
  JournalEventRefSchema,
  SourceSelectorSchema,
  type JournalAuthoritySnapshot,
  type JournalCommittedEnvelope,
  type JournalEventRef,
  type JournalPayloadDescriptor,
  type JournalOccurrenceTime,
  type SourceSelector
} from "@companion/protocol";
import { z } from "zod";
import { detectCorrectionRequest, detectExplicitRememberRequest } from "./intent.js";

export const MEMORY_LINEAGE_VERSION = "memory-lineage.v1" as const;
export const LEGACY_MEMORY_GROUNDING_POLICY = "a10.1c-legacy-rule-extraction.v1" as const;

const opaque = z.string().min(1).max(512);
const PrincipalSnapshotSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("RESOLVED"), kind: z.literal("PRINCIPAL"), namespace: opaque, actorId: opaque }).strict(),
  z.object({ state: z.literal("UNRESOLVED"), reason: opaque }).strict(),
  z.object({ state: z.literal("AMBIGUOUS"), candidates: z.array(z.object({ namespace: opaque, actorId: opaque }).strict()).min(2) }).strict()
]);
const BindingSnapshotSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("RESOLVED"), kind: z.literal("PERSON_BINDING"), personId: opaque, bindingVersion: opaque }).strict(),
  z.object({ state: z.literal("UNRESOLVED"), reason: opaque }).strict(),
  z.object({ state: z.literal("CONFLICTING"), candidates: z.array(opaque).min(2) }).strict()
]);
const MembershipSnapshotSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("KNOWN"), snapshotRef: opaque, version: opaque }).strict(),
  z.object({ state: z.literal("UNKNOWN"), reason: opaque }).strict(),
  z.object({ state: z.literal("INCOMPLETE"), snapshotRef: opaque.optional(), reason: opaque }).strict()
]);
const AudienceSnapshotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PRIVATE"), channelRef: opaque }).strict(),
  z.object({ kind: z.literal("GROUP"), channelRef: opaque, membership: MembershipSnapshotSchema }).strict(),
  z.object({ kind: z.literal("UNKNOWN"), reason: opaque }).strict()
]);
const OccurrenceTimeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("UNKNOWN") }).strict(),
  z.object({ state: z.literal("INSTANT"), at: z.string().datetime({ offset: true }), clockSource: opaque, uncertaintyMs: z.number().finite().nonnegative() }).strict(),
  z.object({ state: z.literal("INTERVAL"), start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), clockSource: opaque, uncertaintyMs: z.number().finite().nonnegative() }).strict()
]);
const GroundedAuthoritySchema = z.object({
  principal: PrincipalSnapshotSchema,
  binding: BindingSnapshotSchema,
  audience: AudienceSnapshotSchema
}).strict();

export const MemoryLineageV1Schema = z.discriminatedUnion("state", [
  z.object({
    version: z.literal(MEMORY_LINEAGE_VERSION),
    state: z.literal("GROUNDED"),
    parents: z.array(z.object({ ref: JournalEventRefSchema, selector: SourceSelectorSchema }).strict()).min(1),
    sourceAvailability: z.object({ state: z.literal("RETAINED_SELECTABLE") }).strict(),
    consumerKey: opaque,
    derivation: z.object({
      kind: z.enum(["RULE_BASED_EXTRACTION", "EXPLICIT_REMEMBER", "CORRECTION"]),
      producer: opaque,
      producerVersion: opaque,
      policyVersion: opaque
    }).strict(),
    origin: z.enum(["USER_ASSERTION", "EXTERNAL_OBSERVATION", "ASSISTANT_GENERATED", "DERIVED"]),
    authority: GroundedAuthoritySchema,
    sourceTime: z.object({ recordedAt: z.string().datetime({ offset: true }), occurrenceTime: OccurrenceTimeSchema }).strict()
  }).strict(),
  z.object({
    version: z.literal(MEMORY_LINEAGE_VERSION),
    state: z.literal("PAYLOAD_UNAVAILABLE"),
    parents: z.array(JournalEventRefSchema).min(1),
    reason: opaque
  }).strict(),
  z.object({
    version: z.literal(MEMORY_LINEAGE_VERSION),
    state: z.literal("LEGACY_INCOMPLETE")
  }).strict()
]);

export type MemoryLineageV1 = z.infer<typeof MemoryLineageV1Schema>;
export type GroundedMemoryLineageV1 = Extract<MemoryLineageV1, { state: "GROUNDED" }>;
export type MemoryLineageState = MemoryLineageV1["state"] | "NON_EVIDENCE";

/** Runtime-owned ancestry plus the exact source text supplied to deterministic extraction. */
export type MemoryGroundingContext = Readonly<{
  sourceJournalRef: JournalEventRef;
  sourceText: string;
}>;

export type CommittedJournalEvidenceReader = Readonly<{
  namespace: string;
  get(ref: JournalEventRef): Promise<DeepReadonly<JournalCommittedEnvelope> | null>;
  resolveRetainedText(ref: JournalPayloadDescriptor["ref"]): Promise<{
    descriptor: DeepReadonly<JournalPayloadDescriptor>;
    text: string;
  } | null>;
}>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type GroundedMemorySource = Readonly<{
  parent: JournalEventRef;
  selector: Extract<SourceSelector, { modality: "TEXT" }>;
  payload: JournalPayloadDescriptor;
  selectedText: string;
  origin: "USER_ASSERTION" | "EXTERNAL_OBSERVATION";
  recordedAt: string;
  occurrenceTime: JournalOccurrenceTime;
  authority: Pick<JournalAuthoritySnapshot, "principal" | "binding" | "audience">;
}>;

export type MemoryGroundingResolver = Readonly<{
  resolve(context: MemoryGroundingContext): Promise<GroundedMemorySource>;
}>;

export type MemoryGroundingFailureCode =
  | "missing-committed-source"
  | "unknown-journal-parent"
  | "ineligible-journal-parent"
  | "source-payload-unavailable"
  | "source-selector-unavailable"
  | "source-text-mismatch"
  | "lineage-validation-failed";

export class MemoryGroundingError extends Error {
  constructor(readonly code: MemoryGroundingFailureCode, message: string) {
    super(message);
    this.name = "MemoryGroundingError";
  }
}

/**
 * Host-created resolver over committed Journal state. Candidate metadata is
 * never consulted for parent, selector, origin, identity, audience, or time.
 */
export class JournalMemoryGroundingResolver implements MemoryGroundingResolver {
  constructor(private readonly journal: CommittedJournalEvidenceReader) {}

  async resolve(context: MemoryGroundingContext): Promise<GroundedMemorySource> {
    const parsedParent = JournalEventRefSchema.safeParse(context.sourceJournalRef);
    if (!parsedParent.success) {
      throw new MemoryGroundingError(
        "lineage-validation-failed",
        "Memory grounding requires a valid typed Journal event reference."
      );
    }
    const parent = parsedParent.data;
    if (parent.namespace !== this.journal.namespace) {
      throw new MemoryGroundingError("unknown-journal-parent", "Journal parent namespace mismatch.");
    }
    const envelope = await this.journal.get(parent);
    if (
      !envelope ||
      envelope.eventId !== parent.eventId ||
      envelope.journalNamespace !== parent.namespace
    ) {
      throw new MemoryGroundingError("unknown-journal-parent", "Committed Journal parent is unavailable.");
    }
    if (envelope.command.kind !== "RECEIPT") {
      throw new MemoryGroundingError("ineligible-journal-parent", "Memory evidence requires a committed receipt.");
    }
    const receiptClass = envelope.command.data.receiptClass;
    if (receiptClass !== "ATTRIBUTED_ASSERTION" && receiptClass !== "DIRECT_OBSERVATION") {
      throw new MemoryGroundingError("ineligible-journal-parent", "Control receipts are not factual Memory evidence.");
    }

    const selectors = envelope.command.data.evidenceSelectors.filter(
      (selector): selector is Extract<SourceSelector, { modality: "TEXT" }> => selector.modality === "TEXT"
    );
    let resolvedTextMismatch = false;
    for (const selector of selectors) {
      const payload = envelope.authority.payloads.find((entry) => samePayload(entry.ref, selector.payload));
      if (!payload || payload.modality !== "TEXT") continue;
      if (
        payload.retention !== "RETAINED" ||
        !payload.selectable ||
        (payload.origin !== "USER_INPUT" && payload.origin !== "EXTERNAL_RESULT")
      ) {
        continue;
      }
      const retained = await this.journal.resolveRetainedText(payload.ref);
      if (!retained || !samePayload(retained.descriptor.ref, payload.ref)) continue;
      if (
        retained.descriptor.modality !== "TEXT" ||
        retained.descriptor.retention !== "RETAINED" ||
        !retained.descriptor.selectable ||
        retained.descriptor.origin !== payload.origin
      ) {
        continue;
      }
      const codePoints = Array.from(retained.text);
      if (selector.range.end > codePoints.length) continue;
      const selectedText = codePoints.slice(selector.range.start, selector.range.end).join("");
      if (selectedText !== context.sourceText) {
        resolvedTextMismatch = true;
        continue;
      }

      const origin =
        receiptClass === "ATTRIBUTED_ASSERTION" && payload.origin === "USER_INPUT"
          ? "USER_ASSERTION"
          : receiptClass === "DIRECT_OBSERVATION" && payload.origin === "EXTERNAL_RESULT"
            ? "EXTERNAL_OBSERVATION"
            : undefined;
      if (!origin) continue;
      return {
        parent,
        selector,
        payload,
        selectedText,
        origin,
        recordedAt: envelope.recordedAt,
        occurrenceTime: envelope.command.occurrenceTime,
        authority: GroundedAuthoritySchema.parse(JSON.parse(JSON.stringify({
          principal: envelope.authority.principal,
          binding: envelope.authority.binding,
          audience: envelope.authority.audience
        })))
      };
    }

    const hasTextPayload = envelope.authority.payloads.some((payload) => payload.modality === "TEXT");
    if (!hasTextPayload) {
      throw new MemoryGroundingError("source-payload-unavailable", "Receipt has no retained text payload.");
    }
    if (selectors.length === 0) {
      throw new MemoryGroundingError("source-selector-unavailable", "Receipt has no eligible text selector.");
    }
    const hasSelectableRetainedText = envelope.authority.payloads.some(
      (payload) =>
        payload.modality === "TEXT" &&
        payload.retention === "RETAINED" &&
        payload.selectable &&
        (payload.origin === "USER_INPUT" || payload.origin === "EXTERNAL_RESULT")
    );
    if (!hasSelectableRetainedText) {
      throw new MemoryGroundingError("source-payload-unavailable", "Receipt text is not retained and selectable.");
    }
    if (resolvedTextMismatch) {
      throw new MemoryGroundingError("source-text-mismatch", "Selected committed text does not equal the extraction source.");
    }
    throw new MemoryGroundingError("source-selector-unavailable", "No committed selector could be resolved.");
  }
}

export function buildGroundedMemoryLineage(input: {
  source: GroundedMemorySource;
  candidate: Readonly<{
    type: string;
    subtype?: string | null;
    content: string;
    scope?: string;
    scopeId?: string | null;
    claim?: unknown;
    reason?: string;
    correctionRequested?: boolean;
    explicitRememberRequested?: boolean;
  }>;
  sourceText: string;
}): GroundedMemoryLineageV1 {
  const derivationKind = explicitRemember(input.sourceText)
    ? "EXPLICIT_REMEMBER"
    : correction(input.sourceText)
      ? "CORRECTION"
      : "RULE_BASED_EXTRACTION";
  const candidateFingerprint = createHash("sha256")
    .update(JSON.stringify({
      type: input.candidate.type,
      subtype: input.candidate.subtype ?? null,
      content: normalizeSemanticContent(input.candidate.content),
      scope: input.candidate.scope ?? "user",
      scopeId: input.candidate.scopeId ?? null,
      reason: input.candidate.reason ?? null,
      claim: input.candidate.claim ?? null,
      correctionRequested: input.candidate.correctionRequested ?? false,
      explicitRememberRequested: input.candidate.explicitRememberRequested ?? false
    }))
    .digest("hex");
  const consumerKey = `mlc1_${createHash("sha256")
    .update(JSON.stringify({
      parent: input.source.parent,
      policyVersion: LEGACY_MEMORY_GROUNDING_POLICY,
      candidateFingerprint
    }))
    .digest("base64url")}`;

  const lineage = MemoryLineageV1Schema.parse({
    version: MEMORY_LINEAGE_VERSION,
    state: "GROUNDED",
    parents: [{ ref: input.source.parent, selector: input.source.selector }],
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey,
    derivation: {
      kind: derivationKind,
      producer: "@companion/memory",
      producerVersion: "0.1.0",
      policyVersion: LEGACY_MEMORY_GROUNDING_POLICY
    },
    origin: input.source.origin,
    authority: input.source.authority,
    sourceTime: {
      recordedAt: input.source.recordedAt,
      occurrenceTime: input.source.occurrenceTime
    }
  } as unknown as z.input<typeof MemoryLineageV1Schema>);
  if (lineage.state !== "GROUNDED") {
    throw new TypeError("Grounded Memory lineage construction returned a non-grounded state.");
  }
  return lineage;
}

export function groundedMemoryPayloadDigest(input: {
  type: string;
  subtype?: string | null | undefined;
  scope: string;
  scopeId?: string | null | undefined;
  memoryLayer: string;
  content: string;
  summary?: string | null | undefined;
  importance: number;
  tags: readonly string[];
  eventTime?: Date | string | null | undefined;
  lineage: GroundedMemoryLineageV1;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      type: input.type,
      subtype: input.subtype ?? null,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      memoryLayer: input.memoryLayer,
      content: input.content,
      summary: input.summary ?? null,
      importance: input.importance,
      tags: [...input.tags].sort(),
      eventTime: input.eventTime instanceof Date ? input.eventTime.toISOString() : input.eventTime ?? null,
      lineage: input.lineage
    }))
    .digest("hex");
}

export function getMemoryLineageState(lineage: MemoryLineageV1 | null | undefined, evidenceClassification?: "NON_EVIDENCE"):
  MemoryLineageState {
  return lineage?.state ?? evidenceClassification ?? "LEGACY_INCOMPLETE";
}

export function legacyIncompleteMemoryLineage(): Extract<MemoryLineageV1, { state: "LEGACY_INCOMPLETE" }> {
  return { version: MEMORY_LINEAGE_VERSION, state: "LEGACY_INCOMPLETE" };
}

function samePayload(left: JournalPayloadDescriptor["ref"], right: JournalPayloadDescriptor["ref"]): boolean {
  return left.namespace === right.namespace && left.payloadId === right.payloadId && left.version === right.version;
}

function normalizeSemanticContent(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function explicitRemember(value: string): boolean {
  return detectExplicitRememberRequest(value);
}

function correction(value: string): boolean {
  return detectCorrectionRequest(value);
}
