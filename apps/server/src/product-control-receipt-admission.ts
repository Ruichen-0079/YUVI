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

export type ProductControlReceiptInput =
  | { operation: "CONFIGURATION_SAVE"; expectedRevision: number }
  | { operation: "PERSON_CREATE"; personId: string; requestedPrimary: boolean }
  | { operation: "PERSON_UPDATE"; personId: string; requestedPrimary: boolean }
  | { operation: "PROACTIVE_RESUME" };

export interface ProductControlReceiptAdmission {
  admit(input: ProductControlReceiptInput): Promise<void>;
}

const ProductControlReceiptInputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("CONFIGURATION_SAVE"),
      expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    })
    .strict(),
  z
    .object({
      operation: z.literal("PERSON_CREATE"),
      personId: z.string().min(1).max(512),
      requestedPrimary: z.boolean()
    })
    .strict(),
  z
    .object({
      operation: z.literal("PERSON_UPDATE"),
      personId: z.string().min(1).max(512),
      requestedPrimary: z.boolean()
    })
    .strict(),
  z.object({ operation: z.literal("PROACTIVE_RESUME") }).strict()
]);

const SURFACE_REFERENCE: Record<ProductControlReceiptInput["operation"], string> = {
  CONFIGURATION_SAVE: "yuvi:http:/product/configuration",
  PERSON_CREATE: "yuvi:http:/product/people",
  PERSON_UPDATE: "yuvi:http:/product/people",
  PROACTIVE_RESUME: "yuvi:http:/product/proactive/resume"
};

/** Host-only builder for sanitized Product control facts; it owns no domain writer or Runtime. */
export class HostProductControlReceiptAdmission implements ProductControlReceiptAdmission {
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly createPayloadId: () => string = createOpaqueProductControlPayloadId
  ) {}

  async admit(rawInput: ProductControlReceiptInput): Promise<void> {
    const parsed = ProductControlReceiptInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Invalid normalized Product control receipt input.",
        parsed.error
      );
    }
    if (!this.journal) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is not configured.");
    }

    const input = parsed.data;
    const summary = summarizeControl(input);
    const textRef = {
      namespace: "yuvi:product-control",
      payloadId: `text_${this.createPayloadId()}`,
      version: "v1"
    };
    const characterCount = [...summary].length;
    const payloads: JournalPayloadDescriptor[] = [
      {
        ref: textRef,
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
          evidenceSelectors:
            characterCount > 0
              ? [
                  {
                    version: JOURNAL_SELECTOR_VERSION,
                    modality: "TEXT",
                    payload: textRef,
                    range: {
                      unit: "UNICODE_CODE_POINT",
                      start: 0,
                      end: characterCount
                    }
                  }
                ]
              : []
        }
      },
      retainedText: [{ ref: textRef, text: summary }]
    };
    const authority: JournalAuthorityDraft = {
      principal: {
        state: "UNRESOLVED",
        reason: "local dashboard access does not authenticate a human principal"
      },
      subjects: [],
      binding: {
        state: "UNRESOLVED",
        reason: "local dashboard access does not establish a Person binding"
      },
      surface: { kind: "LOCAL", reference: SURFACE_REFERENCE[input.operation] },
      correlations: [],
      audience: { kind: "UNKNOWN", reason: "local control has no audience or membership snapshot" },
      disclosurePolicy: {
        state: "UNRESOLVED",
        reason: "no local-control disclosure-policy snapshot is available"
      },
      policyVersion: "yuvi-product-control-receipt.v1",
      producer: { name: "yuvi-product-control-ingress", version: "0.1.3-a8.2e1" },
      sourceReferences: [
        {
          kind: "UNRESOLVED_SOURCE",
          reason: "local dashboard requests provide no stable command identity"
        }
      ],
      payloads
    };

    await this.journal.appendWithHostAuthority(appendInput, authority);
  }
}

function summarizeControl(input: ProductControlReceiptInput): string {
  switch (input.operation) {
    case "CONFIGURATION_SAVE":
      return JSON.stringify({
        operation: "product.configuration.save",
        expectedRevision: input.expectedRevision
      });
    case "PERSON_CREATE":
    case "PERSON_UPDATE":
      return JSON.stringify({
        operation:
          input.operation === "PERSON_CREATE" ? "product.person.create" : "product.person.update",
        personId: input.personId,
        requestedPrimary: input.requestedPrimary
      });
    case "PROACTIVE_RESUME":
      return JSON.stringify({ operation: "product.proactive.resume" });
  }
}

export function createOpaqueProductControlPayloadId(): string {
  return randomBytes(24).toString("base64url");
}

export function toProductControlAdmissionFailure(error: unknown): {
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
          message: "Durable Product control admission is temporarily unavailable."
        };
      case "INVALID_PROPOSAL":
      case "UNSUPPORTED_SCHEMA_VERSION":
        return {
          statusCode: 400,
          code: "JOURNAL_ADMISSION_REJECTED",
          message: "Product control could not be admitted to the Journal."
        };
      default:
        return {
          statusCode: 503,
          code: "JOURNAL_PERSISTENCE_FAILED",
          message: "Durable Product control admission did not commit."
        };
    }
  }
  return {
    statusCode: 503,
    code: "JOURNAL_PERSISTENCE_FAILED",
    message: "Durable Product control admission did not commit."
  };
}
