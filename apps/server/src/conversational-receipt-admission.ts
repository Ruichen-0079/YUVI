import { randomBytes } from "node:crypto";
import { JOURNAL_COMMAND_VERSION, type JournalPayloadDescriptor } from "@companion/protocol";
import {
  JournalStoreError,
  type JournalAuthorityDraft,
  type JournalHostAppendInput,
  type JournalRepository,
  type JournalAppendResult
} from "@companion/journal";
import { z } from "zod";

export const CONVERSATIONAL_RECEIPT_SURFACES = [
  "HTTP_MESSAGE",
  "HTTP_V1_MESSAGES",
  "HTTP_SSE",
  "WEBSOCKET"
] as const;

export type ConversationalReceiptSurface = (typeof CONVERSATIONAL_RECEIPT_SURFACES)[number];

/** Already-normalized route facts. It deliberately has no identity or authority inputs. */
export type ConversationalReceiptInput = {
  surface: ConversationalReceiptSurface;
  sessionId: string;
  runtimeEventId: string;
  content: string;
  hasImageAttachment?: boolean;
};

export interface ConversationalReceiptAdmission {
  admit(input: ConversationalReceiptInput): Promise<JournalAppendResult>;
}

const ConversationalReceiptInputSchema = z
  .object({
    surface: z.enum(CONVERSATIONAL_RECEIPT_SURFACES),
    sessionId: z.string().min(1).max(512),
    runtimeEventId: z.string().min(1).max(512),
    content: z.string().min(1),
    hasImageAttachment: z.boolean().optional()
  })
  .strict();

const SURFACE_REFERENCE: Record<ConversationalReceiptSurface, string> = {
  HTTP_MESSAGE: "yuvi:http:/message",
  HTTP_V1_MESSAGES: "yuvi:http:/v1/messages",
  HTTP_SSE: "yuvi:http:/v1/messages/stream",
  WEBSOCKET: "yuvi:websocket:/ws"
};

/**
 * One host-owned seam for conversational RECEIPTs. It gives the Journal only
 * transport facts the server observes and intentionally has no Memory, Runtime,
 * provider, principal-binding, audience-membership or source-dedup authority.
 */
export class HostConversationalReceiptAdmission implements ConversationalReceiptAdmission {
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly createPayloadId: () => string = createOpaquePayloadId
  ) {}

  async admit(rawInput: ConversationalReceiptInput): Promise<JournalAppendResult> {
    const parsed = ConversationalReceiptInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Invalid normalized conversational receipt input.",
        parsed.error
      );
    }
    if (!this.journal) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is not configured.");
    }

    const input = parsed.data;
    const textRef = this.createPayloadRef("text");
    const textLength = [...input.content].length;
    const payloads: JournalPayloadDescriptor[] = [
      {
        ref: textRef,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "USER_INPUT",
        selectable: true,
        characterCount: textLength
      }
    ];
    if (input.hasImageAttachment) {
      payloads.push({
        ref: this.createPayloadRef("image"),
        modality: "IMAGE",
        retention: "NOT_RETAINED",
        origin: "USER_INPUT",
        selectable: false
      });
    }

    const command = {
      version: JOURNAL_COMMAND_VERSION,
      kind: "RECEIPT" as const,
      occurrenceTime: { state: "UNKNOWN" as const },
      causalParents: [],
      data: {
        receiptClass: "ATTRIBUTED_ASSERTION" as const,
        evidenceSelectors: [
          {
            version: "source-selector.v1" as const,
            modality: "TEXT" as const,
            payload: textRef,
            range: {
              unit: "UNICODE_CODE_POINT" as const,
              start: 0,
              end: textLength
            }
          }
        ]
      }
    };

    const authority: JournalAuthorityDraft = {
      principal: {
        state: "UNRESOLVED",
        reason: "conversational transport does not authenticate a principal"
      },
      subjects: [],
      binding: { state: "UNRESOLVED", reason: "no governed Person binding is established" },
      surface: { kind: "LOCAL", reference: SURFACE_REFERENCE[input.surface] },
      correlations: [
        { kind: "CONVERSATION", sessionId: input.sessionId },
        { kind: "RUNTIME_EVENT", runtimeEventId: input.runtimeEventId }
      ],
      audience: {
        kind: "UNKNOWN",
        reason: "conversational route has no authenticated audience snapshot"
      },
      disclosurePolicy: {
        state: "UNRESOLVED",
        reason: "no route-specific disclosure-policy snapshot is available"
      },
      policyVersion: "yuvi-conversation-receipt.v1",
      producer: { name: "yuvi-conversational-ingress", version: "0.1.3-a8.2b" },
      sourceReferences: [
        {
          kind: "UNRESOLVED_SOURCE",
          reason: "no stable authenticated upstream message identity is available"
        }
      ],
      payloads
    };

    const appendInput: JournalHostAppendInput = {
      command,
      retainedText: [{ ref: textRef, text: input.content }]
    };
    return this.journal.appendWithHostAuthority(appendInput, authority);
  }

  private createPayloadRef(modality: "text" | "image") {
    return {
      namespace: "yuvi:conversation-input",
      payloadId: `${modality}_${this.createPayloadId()}`,
      version: "v1"
    };
  }
}

export function createOpaquePayloadId(): string {
  return randomBytes(24).toString("base64url");
}

export function toConversationalAdmissionFailure(error: unknown): {
  code: "JOURNAL_UNAVAILABLE" | "JOURNAL_PERSISTENCE_FAILED" | "JOURNAL_ADMISSION_REJECTED";
  message: string;
} {
  if (error instanceof JournalStoreError) {
    switch (error.code) {
      case "DATABASE_UNAVAILABLE":
        return {
          code: "JOURNAL_UNAVAILABLE",
          message: "Durable message admission is temporarily unavailable."
        };
      case "INVALID_PROPOSAL":
      case "UNSUPPORTED_SCHEMA_VERSION":
        return {
          code: "JOURNAL_ADMISSION_REJECTED",
          message: "Message could not be admitted to the Journal."
        };
      default:
        return {
          code: "JOURNAL_PERSISTENCE_FAILED",
          message: "Durable message admission did not commit."
        };
    }
  }
  return {
    code: "JOURNAL_PERSISTENCE_FAILED",
    message: "Durable message admission did not commit."
  };
}
