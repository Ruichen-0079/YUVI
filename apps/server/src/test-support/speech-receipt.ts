import type { JournalCommittedEnvelope } from "@companion/protocol";
import type { SpeechReceiptAdmission } from "../speech-receipt-admission.js";

/** Host-controlled fixture for tests that exercise Runtime after speech admission. */
export function createTestSpeechReceiptAdmission(): SpeechReceiptAdmission {
  let sequence = 0;
  return {
    async admit({ observation, sessionId }) {
      const observationId = observation.observationId;
      const captureEpoch = observation.captureEpoch;
      if (!observationId || !captureEpoch) {
        throw new Error("Test speech receipt needs normalized observation identity.");
      }
      sequence += 1;
      return {
        version: "life-event-envelope.v1",
        eventId: `jev1_${String(sequence).padStart(16, "0")}`,
        journalNamespace: "test:speech",
        commitSeq: sequence,
        recordedAt: "2026-09-25T00:00:00.000Z",
        command: {
          version: "life-event-command.v1",
          kind: "RECEIPT",
          occurrenceTime: { state: "UNKNOWN" },
          causalParents: [],
          data: { receiptClass: "DIRECT_OBSERVATION", evidenceSelectors: [] }
        },
        authority: {
          journalNamespace: "test:speech",
          principal: { state: "UNRESOLVED", reason: "test fixture" },
          subjects: [],
          binding: { state: "UNRESOLVED", reason: "test fixture" },
          surface: { kind: "LOCAL", reference: "test:speech" },
          correlations: [
            { kind: "CONVERSATION", sessionId },
            { kind: "VOICE_OBSERVATION", observationId, captureEpoch }
          ],
          audience: { kind: "UNKNOWN", reason: "test fixture" },
          disclosurePolicy: { state: "UNRESOLVED", reason: "test fixture" },
          policyVersion: "test.v1",
          producer: { name: "test", version: "1" },
          sourceReferences: [{ kind: "VOICE_OBSERVATION", observationId, captureEpoch }],
          payloads: []
        }
      } as JournalCommittedEnvelope;
    }
  };
}
