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

/** Bounded, already-normalized facts from the external proactive-turn request. */
export type ProactiveTurnReceiptInput = Readonly<{
  sessionId: string;
  readMemory: boolean;
  promptPreview: boolean;
}>;

export interface ProactiveTurnReceiptAdmission {
  admit(input: ProactiveTurnReceiptInput): Promise<void>;
}

const ProactiveTurnReceiptInputSchema = z
  .object({
    sessionId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim().length > 0),
    readMemory: z.boolean(),
    promptPreview: z.boolean()
  })
  .strict();

/** Host-only builder for an external request receipt; it has no Runtime/provider authority. */
export class HostProactiveTurnReceiptAdmission implements ProactiveTurnReceiptAdmission {
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly createPayloadId: () => string = createOpaqueProactiveTurnPayloadId
  ) {}

  async admit(rawInput: ProactiveTurnReceiptInput): Promise<void> {
    const parsed = ProactiveTurnReceiptInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Invalid normalized proactive-turn request.",
        parsed.error
      );
    }
    if (!this.journal) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is not configured.");
    }

    const input = parsed.data;
    const summary = JSON.stringify({
      operation: "proactive-turn.request",
      readMemory: input.readMemory,
      promptPreview: input.promptPreview
    });
    const payloadRef = {
      namespace: "yuvi:proactive-turn-request",
      payloadId: `text_${this.createPayloadId()}`,
      version: "v1"
    };
    const characterCount = [...summary].length;
    const payloads: JournalPayloadDescriptor[] = [
      {
        ref: payloadRef,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "USER_INPUT",
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
        reason: "local dashboard access does not authenticate a transport principal"
      },
      subjects: [],
      binding: {
        state: "UNRESOLVED",
        reason: "local dashboard access does not establish a Person binding"
      },
      surface: { kind: "LOCAL", reference: "yuvi:http:/v1/proactive-turns/stream" },
      correlations: [{ kind: "CONVERSATION", sessionId: input.sessionId }],
      audience: { kind: "UNKNOWN", reason: "external proactive request has no audience snapshot" },
      disclosurePolicy: {
        state: "UNRESOLVED",
        reason: "no disclosure-policy snapshot is available for this request"
      },
      policyVersion: "yuvi-external-proactive-turn-request.v1",
      producer: { name: "yuvi-proactive-turn-ingress", version: "0.1.3-a8.2f3" },
      sourceReferences: [
        {
          kind: "UNRESOLVED_SOURCE",
          reason: "the request has no stable authenticated transport delivery identity"
        }
      ],
      payloads
    };

    // The Runtime idempotency key is a volatile logical claim key, not transport dedup identity.
    await this.journal.appendWithHostAuthority(appendInput, authority);
  }
}

export function createOpaqueProactiveTurnPayloadId(): string {
  return randomBytes(24).toString("base64url");
}

export function toProactiveTurnAdmissionFailure(error: unknown): {
  statusCode: 400 | 503;
  code: "JOURNAL_UNAVAILABLE" | "JOURNAL_PERSISTENCE_FAILED" | "JOURNAL_ADMISSION_REJECTED";
  message: string;
} {
  if (error instanceof JournalStoreError) {
    switch (error.code) {
      case "DATABASE_UNAVAILABLE":
        return {
          statusCode: 503,
          code: "JOURNAL_UNAVAILABLE",
          message: "Durable proactive-turn request admission is temporarily unavailable."
        };
      case "INVALID_PROPOSAL":
      case "UNSUPPORTED_SCHEMA_VERSION":
        return {
          statusCode: 400,
          code: "JOURNAL_ADMISSION_REJECTED",
          message: "Proactive-turn request could not be admitted to the Journal."
        };
      default:
        break;
    }
  }
  return {
    statusCode: 503,
    code: "JOURNAL_PERSISTENCE_FAILED",
    message: "Durable proactive-turn request admission did not commit."
  };
}
