/** Test-only source seam for delivery fault suites. Grounding acceptance uses the real resolver in finalized-grounding.test.ts. */
import type { JournalEventRef } from "@companion/protocol";
import {
  FinalizedIngestionService as Service,
  type FinalizedIngestionAdmissionInput
} from "./finalized-ingestion-ledger.js";
import type { MemoryGroundingResolver } from "./lineage.js";

export const finalizedTestParent: JournalEventRef = {
  kind: "JOURNAL_EVENT",
  namespace: "delivery-test",
  eventId: "jev1_aaaaaaaaaaaaaaaa"
};
export const finalizedTestResolver: MemoryGroundingResolver = {
  async resolve(context) {
    return {
      parent: context.sourceJournalRef,
      selectedText: context.sourceText,
      selector: {
        version: "source-selector.v1",
        modality: "TEXT",
        payload: {
          namespace: context.sourceJournalRef.namespace,
          payloadId: "test-payload",
          version: "1"
        },
        range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(context.sourceText).length }
      },
      payload: {
        ref: {
          namespace: context.sourceJournalRef.namespace,
          payloadId: "test-payload",
          version: "1"
        },
        modality: "TEXT",
        origin: "USER_INPUT",
        retention: "RETAINED",
        selectable: true,
        characterCount: Array.from(context.sourceText).length
      },
      origin: "USER_ASSERTION",
      recordedAt: "2026-09-30T08:00:00.000Z",
      occurrenceTime: { state: "UNKNOWN" },
      authority: {
        principal: { state: "UNRESOLVED", reason: "delivery fixture" },
        binding: { state: "UNRESOLVED", reason: "delivery fixture" },
        audience: { kind: "UNKNOWN", reason: "delivery fixture" }
      }
    };
  }
};
export class FinalizedIngestionService extends Service {
  constructor(
    repository: ConstructorParameters<typeof Service>[0],
    policy?: ConstructorParameters<typeof Service>[1]
  ) {
    super(repository, policy, finalizedTestResolver);
  }
  override admit(input: FinalizedIngestionAdmissionInput) {
    return super.admit({
      ...input,
      sourceJournalRef: input.sourceJournalRef ?? finalizedTestParent,
      sourceText: input.sourceText ?? input.userMessage
    });
  }
}
