import { describe, expect, it } from "vitest";
import {
  JournalCommittedEnvelopeSchema,
  SourceSelectorSchema,
  type JournalCommittedEnvelope,
  type JournalEventRef,
  type JournalPayloadDescriptor
} from "@companion/protocol";
import {
  JournalMemoryGroundingResolver,
  MemoryGroundingError,
  buildGroundedMemoryLineage,
  getMemoryLineageState,
  legacyIncompleteMemoryLineage,
  MEMORY_LINEAGE_VERSION,
  type CommittedJournalEvidenceReader,
  type MemoryGroundingContext
} from "./lineage.js";

const parent: JournalEventRef = {
  kind: "JOURNAL_EVENT",
  namespace: "test-journal",
  eventId: "jev1_aaaaaaaaaaaaaaaa"
};
const payloadRef = { namespace: "test-journal", payloadId: "payload-a", version: "v1" };
const recordedAt = "2026-09-30T08:00:00.000Z";

function receipt(input: {
  text: string;
  receiptClass?: "ATTRIBUTED_ASSERTION" | "DIRECT_OBSERVATION" | "CONTROL";
  origin?: "USER_INPUT" | "EXTERNAL_RESULT" | "ASSISTANT_GENERATED";
  retention?: "RETAINED" | "REDACTED" | "NOT_RETAINED" | "UNAVAILABLE";
  selectable?: boolean;
}): JournalCommittedEnvelope {
  const text = input.text;
  const descriptor: JournalPayloadDescriptor = {
    ref: payloadRef,
    modality: "TEXT",
    retention: input.retention ?? "RETAINED",
    origin: input.origin ?? "USER_INPUT",
    selectable: input.selectable ?? true,
    characterCount: Array.from(text).length
  };
  const selector = SourceSelectorSchema.parse({
    version: "source-selector.v1",
    modality: "TEXT",
    payload: payloadRef,
    range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(text).length }
  });
  return JournalCommittedEnvelopeSchema.parse({
    version: "life-event-envelope.v1",
    eventId: parent.eventId,
    journalNamespace: parent.namespace,
    commitSeq: 1,
    recordedAt,
    command: {
      version: "life-event-command.v1",
      kind: "RECEIPT",
      occurrenceTime: { state: "UNKNOWN" },
      causalParents: [],
      data: {
        receiptClass: input.receiptClass ?? "ATTRIBUTED_ASSERTION",
        evidenceSelectors: [selector]
      }
    },
    authority: {
      journalNamespace: parent.namespace,
      principal: { state: "UNRESOLVED", reason: "transport does not authenticate a principal" },
      subjects: [],
      binding: { state: "UNRESOLVED", reason: "no governed Person binding" },
      surface: { kind: "LOCAL", reference: "test" },
      correlations: [{ kind: "MESSAGE", sessionId: "s", messageId: "m" }],
      audience: { kind: "UNKNOWN", reason: "membership is unavailable" },
      disclosurePolicy: { state: "UNRESOLVED", reason: "test" },
      policyVersion: "test.policy.v1",
      producer: { name: "test", version: "1" },
      sourceReferences: [{ kind: "CONVERSATION_MESSAGE", sessionId: "s", messageId: "m" }],
      payloads: [descriptor]
    }
  });
}

function readerFor(
  envelope: JournalCommittedEnvelope | null,
  text: string | null
): CommittedJournalEvidenceReader {
  return {
    namespace: parent.namespace,
    async get(ref) {
      return ref.eventId === parent.eventId ? envelope : null;
    },
    async resolveRetainedText(ref) {
      if (ref.payloadId !== payloadRef.payloadId || text === null || !envelope) return null;
      return {
        descriptor: envelope.authority.payloads[0]!,
        text
      };
    }
  };
}

const context = (sourceText: string): MemoryGroundingContext => ({
  sourceJournalRef: parent,
  sourceText
});

describe("A10.1c Memory lineage", () => {
  it("resolves exact committed retained text with Unicode code-point bounds and unresolved authority", async () => {
    const sourceText = "我喜欢茶 🍵";
    const resolver = new JournalMemoryGroundingResolver(
      readerFor(receipt({ text: sourceText }), sourceText)
    );
    const source = await resolver.resolve(context(sourceText));
    const lineage = buildGroundedMemoryLineage({
      source,
      candidate: { type: "semantic", subtype: "preference", content: "喜欢茶" },
      sourceText
    });

    expect(source.selector).toMatchObject({
      modality: "TEXT",
      range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(sourceText).length }
    });
    expect(lineage).toMatchObject({
      version: MEMORY_LINEAGE_VERSION,
      state: "GROUNDED",
      parents: [{ ref: parent, selector: source.selector }],
      origin: "USER_ASSERTION",
      authority: {
        principal: { state: "UNRESOLVED" },
        binding: { state: "UNRESOLVED" },
        audience: { kind: "UNKNOWN" }
      },
      sourceTime: { recordedAt, occurrenceTime: { state: "UNKNOWN" } }
    });
  });

  it("preserves finalized transcript observation semantics rather than authenticating the speaker", async () => {
    const sourceText = "My friend says the shop is closed.";
    const source = await new JournalMemoryGroundingResolver(
      readerFor(
        receipt({
          text: sourceText,
          receiptClass: "DIRECT_OBSERVATION",
          origin: "EXTERNAL_RESULT"
        }),
        sourceText
      )
    ).resolve(context(sourceText));

    expect(source.origin).toBe("EXTERNAL_OBSERVATION");
    expect(source.authority.binding.state).toBe("UNRESOLVED");
  });

  it("rejects unrelated text even when the Journal parent exists", async () => {
    const resolver = new JournalMemoryGroundingResolver(
      readerFor(receipt({ text: "The weather is nice today." }), "The weather is nice today.")
    );
    await expect(resolver.resolve(context("I strongly prefer astronomy."))).rejects.toMatchObject({
      code: "source-text-mismatch"
    });
  });

  it.each([
    ["control receipt", { receiptClass: "CONTROL" as const }],
    ["not retained payload", { retention: "NOT_RETAINED" as const }],
    ["nonselectable payload", { selectable: false }],
    ["assistant generated text", { origin: "ASSISTANT_GENERATED" as const }]
  ])("rejects %s as factual source", async (_label, overrides) => {
    const text = "A committed source sentence.";
    const resolver = new JournalMemoryGroundingResolver(
      readerFor(receipt({ text, ...overrides }), text)
    );
    await expect(resolver.resolve(context(text))).rejects.toBeInstanceOf(MemoryGroundingError);
  });

  it("rejects missing parents and selector resolution failures", async () => {
    const missing = new JournalMemoryGroundingResolver(readerFor(null, null));
    await expect(missing.resolve(context("source"))).rejects.toMatchObject({
      code: "unknown-journal-parent"
    });
    const unavailable = new JournalMemoryGroundingResolver(
      readerFor(receipt({ text: "source" }), null)
    );
    await expect(unavailable.resolve(context("source"))).rejects.toMatchObject({
      code: "source-selector-unavailable"
    });
  });

  it("projects legacy null lineage explicitly without fabricating ancestry", () => {
    expect(legacyIncompleteMemoryLineage()).toEqual({
      version: MEMORY_LINEAGE_VERSION,
      state: "LEGACY_INCOMPLETE"
    });
    expect(getMemoryLineageState(null)).toBe("LEGACY_INCOMPLETE");
    expect(getMemoryLineageState(null, "NON_EVIDENCE")).toBe("NON_EVIDENCE");
  });
});
