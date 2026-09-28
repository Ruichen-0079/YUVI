import { randomBytes } from "node:crypto";
import {
  JOURNAL_COMMAND_VERSION,
  JOURNAL_SELECTOR_VERSION,
  type JournalPayloadDescriptor,
  type SourceSelector
} from "@companion/protocol";
import {
  JournalStoreError,
  type JournalAuthorityDraft,
  type JournalHostAppendInput,
  type JournalRetainedTextPayload,
  type JournalRepository
} from "@companion/journal";
import type { TTSInput } from "@companion/providers";
import { z } from "zod";

export type TtsOutputFormat = NonNullable<TTSInput["format"]>;

/** Structural request facts only; raw synthesis text and option values never cross this seam. */
export type TtsReceiptInput = Readonly<{
  sessionId?: string;
  textCharacterCount: number;
  voiceSupplied: boolean;
  languageSupplied: boolean;
  format: TtsOutputFormat | null;
}>;

export interface TtsReceiptAdmission {
  admit(input: TtsReceiptInput): Promise<void>;
}

const TtsReceiptInputSchema = z
  .object({
    sessionId: z.string().min(1).max(512).optional(),
    textCharacterCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    voiceSupplied: z.boolean(),
    languageSupplied: z.boolean(),
    format: z.enum(["mp3", "wav", "opus", "pcm", "mulaw", "alaw"]).nullable()
  })
  .strict();

/** Host-only TTS receipt builder; it has no provider, Runtime or text-retention authority. */
export class HostTtsReceiptAdmission implements TtsReceiptAdmission {
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly createPayloadId: () => string = createOpaqueTtsPayloadId
  ) {}

  async admit(rawInput: TtsReceiptInput): Promise<void> {
    const parsed = TtsReceiptInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Invalid normalized TTS receipt input.",
        parsed.error
      );
    }
    if (!this.journal) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is not configured.");
    }

    const input = parsed.data;
    const synthesisTextRef = {
      namespace: "yuvi:tts-synthesis-text",
      payloadId: `text_${this.createPayloadId()}`,
      version: "v1"
    };
    const summary = JSON.stringify({
      operation: "tts.synthesize",
      textCharacterCount: input.textCharacterCount,
      voiceSupplied: input.voiceSupplied,
      languageSupplied: input.languageSupplied,
      format: input.format
    });
    const summaryRef = {
      namespace: "yuvi:tts-control-summary",
      payloadId: `text_${this.createPayloadId()}`,
      version: "v1"
    };
    const summaryCharacterCount = [...summary].length;

    const payloads: JournalPayloadDescriptor[] = [
      {
        ref: synthesisTextRef,
        modality: "TEXT",
        retention: "NOT_RETAINED",
        // USER_INPUT denotes entry through this external request boundary, not authorship.
        origin: "USER_INPUT",
        selectable: false,
        characterCount: input.textCharacterCount
      },
      {
        ref: summaryRef,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "USER_INPUT",
        selectable: true,
        characterCount: summaryCharacterCount
      }
    ];
    const evidenceSelectors: SourceSelector[] = [
      {
        version: JOURNAL_SELECTOR_VERSION,
        modality: "TEXT",
        payload: summaryRef,
        range: {
          unit: "UNICODE_CODE_POINT",
          start: 0,
          end: summaryCharacterCount
        }
      }
    ];
    const retainedText: JournalRetainedTextPayload[] = [{ ref: summaryRef, text: summary }];
    const authority: JournalAuthorityDraft = {
      principal: {
        state: "UNRESOLVED",
        reason: "the standalone TTS request does not authenticate a transport principal"
      },
      subjects: [],
      binding: {
        state: "UNRESOLVED",
        reason: "the standalone TTS request does not establish a Person binding"
      },
      surface: { kind: "LOCAL", reference: "yuvi:http:/v1/tts" },
      correlations:
        input.sessionId === undefined
          ? []
          : [{ kind: "CONVERSATION", sessionId: input.sessionId }],
      audience: { kind: "UNKNOWN", reason: "the standalone TTS route has no audience snapshot" },
      disclosurePolicy: {
        state: "UNRESOLVED",
        reason: "no TTS-route disclosure-policy snapshot is available"
      },
      policyVersion: "yuvi-standalone-tts-receipt.v1",
      producer: { name: "yuvi-tts-ingress", version: "0.1.3-a8.2f4" },
      sourceReferences: [
        {
          kind: "UNRESOLVED_SOURCE",
          reason: "TTS transport supplies no stable authenticated upstream request identity"
        }
      ],
      payloads
    };
    const appendInput: JournalHostAppendInput = {
      command: {
        version: JOURNAL_COMMAND_VERSION,
        kind: "RECEIPT",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [],
        data: { receiptClass: "CONTROL", evidenceSelectors }
      },
      retainedText
    };

    // No sourceDedup is supplied: request options and content are not delivery identities.
    await this.journal.appendWithHostAuthority(appendInput, authority);
  }
}

export function createOpaqueTtsPayloadId(): string {
  return randomBytes(24).toString("base64url");
}

export function toTtsAdmissionFailure(error: unknown): {
  statusCode: 400 | 503;
  code: "JOURNAL_UNAVAILABLE" | "JOURNAL_PERSISTENCE_FAILED" | "JOURNAL_ADMISSION_REJECTED";
  message: string;
} {
  if (error instanceof JournalStoreError) {
    switch (error.code) {
      case "INVALID_PROPOSAL":
      case "UNSUPPORTED_SCHEMA_VERSION":
        return {
          statusCode: 400,
          code: "JOURNAL_ADMISSION_REJECTED",
          message: "TTS request could not be admitted to the Journal."
        };
      case "DATABASE_UNAVAILABLE":
        return {
          statusCode: 503,
          code: "JOURNAL_UNAVAILABLE",
          message: "Durable TTS request admission is temporarily unavailable."
        };
      default:
        break;
    }
  }
  return {
    statusCode: 503,
    code: "JOURNAL_PERSISTENCE_FAILED",
    message: "Durable TTS request admission did not commit."
  };
}
