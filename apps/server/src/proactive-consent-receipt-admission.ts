import { randomBytes } from "node:crypto";
import {
  JOURNAL_COMMAND_VERSION,
  JOURNAL_SELECTOR_VERSION,
  type JournalPayloadDescriptor
} from "@companion/protocol";
import {
  JournalStoreError,
  type JournalAuthorityDraft,
  type JournalHostAppendInput,
  type JournalRepository
} from "@companion/journal";
import { z } from "zod";

export type ProactiveConsentReadyProjection = {
  enabled: boolean;
  settingsRevision: number;
};

export interface ProactiveConsentReceiptAdmission {
  admit(input: ProactiveConsentReadyProjection): Promise<void>;
}

const InputSchema = z
  .object({
    enabled: z.boolean(),
    settingsRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict();

/** Host-only receipt builder for an already-persisted Desktop settings projection. */
export class HostProactiveConsentReceiptAdmission implements ProactiveConsentReceiptAdmission {
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly createPayloadId: () => string = () => randomBytes(24).toString("base64url")
  ) {}

  async admit(rawInput: ProactiveConsentReadyProjection): Promise<void> {
    const parsed = InputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Invalid normalized proactive settings projection.",
        parsed.error
      );
    }
    if (!this.journal) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is not configured.");
    }

    const { enabled, settingsRevision } = parsed.data;
    const summary = JSON.stringify({
      operation: "proactive.consent.settings-projection",
      enabled,
      settingsRevision
    });
    const payloadRef = {
      namespace: "yuvi:proactive-consent-projection",
      payloadId: `text_${this.createPayloadId()}`,
      version: "v1"
    };
    const characterCount = [...summary].length;
    const payloads: JournalPayloadDescriptor[] = [
      {
        ref: payloadRef,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "EXTERNAL_RESULT",
        selectable: characterCount > 0,
        characterCount
      }
    ];
    const appendInput: JournalHostAppendInput = {
      command: {
        version: JOURNAL_COMMAND_VERSION,
        kind: "RECEIPT",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [],
        data: {
          receiptClass: "CONTROL",
          evidenceSelectors: [
            {
              version: JOURNAL_SELECTOR_VERSION,
              modality: "TEXT",
              payload: payloadRef,
              range: { unit: "UNICODE_CODE_POINT", start: 0, end: characterCount }
            }
          ]
        }
      },
      retainedText: [{ ref: payloadRef, text: summary }]
    };
    const authority: JournalAuthorityDraft = {
      principal: {
        state: "UNRESOLVED",
        reason: "local access does not authenticate the author of Desktop settings"
      },
      subjects: [],
      binding: {
        state: "UNRESOLVED",
        reason: "local access does not establish a Person binding"
      },
      surface: { kind: "LOCAL", reference: "yuvi:http:/v1/proactive/consent" },
      correlations: [],
      audience: { kind: "UNKNOWN", reason: "settings projection has no audience snapshot" },
      disclosurePolicy: {
        state: "UNRESOLVED",
        reason: "no disclosure-policy snapshot is available for this projection"
      },
      policyVersion: "yuvi-proactive-consent-projection.v1",
      producer: { name: "yuvi-proactive-consent-ingress", version: "0.1.3-a8.2e3" },
      sourceReferences: [
        {
          kind: "UNRESOLVED_SOURCE",
          reason: "settings revision orders projections but is not a transport identity"
        }
      ],
      payloads
    };

    // Settings revisions are deliberately not used as sourceDedup identities.
    await this.journal.appendWithHostAuthority(appendInput, authority);
  }
}
