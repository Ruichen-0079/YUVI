import {
  JournalCommittedEnvelopeSchema,
  SourceSelectorSchema,
  type JournalCommittedEnvelope,
  type JournalEventRef,
  type JournalPayloadDescriptor
} from "@companion/protocol";
import type { CommittedJournalEvidenceReader } from "./lineage.js";

export const parent: JournalEventRef = {
  kind: "JOURNAL_EVENT",
  namespace: "test-journal",
  eventId: "jev1_aaaaaaaaaaaaaaaa"
};
const payloadRef = { namespace: "test-journal", payloadId: "payload-a", version: "v1" };
export const recordedAt = "2026-09-30T08:00:00.000Z";

export function receipt(input: {
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

export function readerFor(
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
