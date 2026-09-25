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
import { z } from "zod";

export const VISION_RECEIPT_IMAGE_SOURCES = ["INLINE_BYTES", "URL_REFERENCE"] as const;
export type VisionReceiptImageSource = (typeof VISION_RECEIPT_IMAGE_SOURCES)[number];

/** Safe normalized facts only; this boundary cannot receive image bytes or an image URL. */
export type VisionReceiptInput = Readonly<{
  imageSource: VisionReceiptImageSource;
  prompt?: string;
}>;

export interface VisionReceiptAdmission {
  admit(input: VisionReceiptInput): Promise<void>;
}

const VisionReceiptInputSchema = z
  .object({
    imageSource: z.enum(VISION_RECEIPT_IMAGE_SOURCES),
    prompt: z.string().optional()
  })
  .strict();

/** Host-only vision receipt builder. It has no Runtime, identity, provider or image-store authority. */
export class HostVisionReceiptAdmission implements VisionReceiptAdmission {
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly createPayloadId: () => string = createOpaqueVisionPayloadId
  ) {}

  async admit(rawInput: VisionReceiptInput): Promise<void> {
    const parsed = VisionReceiptInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Invalid normalized vision receipt input.",
        parsed.error
      );
    }
    if (!this.journal) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is not configured.");
    }

    const input = parsed.data;
    const imageRef = {
      namespace: "yuvi:vision-input",
      payloadId: `image_${this.createPayloadId()}`,
      version: "v1"
    };
    const payloads: JournalPayloadDescriptor[] = [
      {
        ref: imageRef,
        modality: "IMAGE",
        retention: "NOT_RETAINED",
        origin: "USER_INPUT",
        selectable: false
      }
    ];
    const retainedText: JournalRetainedTextPayload[] = [];
    const evidenceSelectors: SourceSelector[] = [];

    if (input.prompt !== undefined) {
      const promptRef = {
        namespace: "yuvi:vision-prompt",
        payloadId: `text_${this.createPayloadId()}`,
        version: "v1"
      };
      const characterCount = [...input.prompt].length;
      payloads.push({
        ref: promptRef,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "USER_INPUT",
        selectable: characterCount > 0,
        characterCount
      });
      retainedText.push({ ref: promptRef, text: input.prompt });
      if (characterCount > 0) {
        evidenceSelectors.push({
          version: JOURNAL_SELECTOR_VERSION,
          modality: "TEXT" as const,
          payload: promptRef,
          range: {
            unit: "UNICODE_CODE_POINT" as const,
            start: 0,
            end: characterCount
          }
        });
      }
    }

    const command = {
      version: JOURNAL_COMMAND_VERSION,
      kind: "RECEIPT" as const,
      occurrenceTime: { state: "UNKNOWN" as const },
      causalParents: [],
      data: {
        // Inline bytes establish receipt of image material. A URL establishes only
        // that the caller supplied a reference; neither class asserts visual truth.
        receiptClass:
          input.imageSource === "INLINE_BYTES"
            ? ("DIRECT_OBSERVATION" as const)
            : ("ATTRIBUTED_ASSERTION" as const),
        evidenceSelectors
      }
    };
    const authority: JournalAuthorityDraft = {
      principal: {
        state: "UNRESOLVED",
        reason: "vision transport does not authenticate a principal"
      },
      subjects: [],
      binding: { state: "UNRESOLVED", reason: "vision input does not establish a Person binding" },
      surface: { kind: "LOCAL", reference: "yuvi:http:/v1/vision/analyze" },
      correlations: [],
      audience: { kind: "UNKNOWN", reason: "vision route has no authenticated audience snapshot" },
      disclosurePolicy: {
        state: "UNRESOLVED",
        reason: "no vision-route disclosure-policy snapshot is available"
      },
      policyVersion: "yuvi-standalone-vision-receipt.v1",
      producer: { name: "yuvi-vision-ingress", version: "0.1.3-a8.2d" },
      sourceReferences: [
        {
          kind: "UNRESOLVED_SOURCE",
          reason: "vision transport supplies no stable authenticated upstream request identity"
        }
      ],
      payloads
    };
    const appendInput: JournalHostAppendInput = {
      command,
      ...(retainedText.length > 0 ? { retainedText } : {})
    };
    await this.journal.appendWithHostAuthority(appendInput, authority);
  }
}

export function createOpaqueVisionPayloadId(): string {
  return randomBytes(24).toString("base64url");
}

export function toVisionAdmissionFailure(error: unknown): {
  code: "JOURNAL_UNAVAILABLE" | "JOURNAL_PERSISTENCE_FAILED" | "JOURNAL_ADMISSION_REJECTED";
  message: string;
} {
  if (error instanceof JournalStoreError) {
    switch (error.code) {
      case "DATABASE_UNAVAILABLE":
        return {
          code: "JOURNAL_UNAVAILABLE",
          message: "Durable vision admission is temporarily unavailable."
        };
      case "INVALID_PROPOSAL":
      case "UNSUPPORTED_SCHEMA_VERSION":
        return {
          code: "JOURNAL_ADMISSION_REJECTED",
          message: "Vision input could not be admitted to the Journal."
        };
      default:
        return {
          code: "JOURNAL_PERSISTENCE_FAILED",
          message: "Durable vision admission did not commit."
        };
    }
  }
  return {
    code: "JOURNAL_PERSISTENCE_FAILED",
    message: "Durable vision admission did not commit."
  };
}
