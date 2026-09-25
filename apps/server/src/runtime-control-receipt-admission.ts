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

export type RuntimeControlReceiptInput =
  | {
      operation: "P8_CORRECTION";
      action: "REVISE" | "RETRACT";
      targetKind: "INTERPRETATION";
    }
  | {
      operation: "P8_CORRECTION";
      action: "REVISE" | "RETRACT";
      targetKind: "AUTHORED_INVARIANT";
      invariantTarget: "identity" | "persona";
    }
  | { operation: "READ_TEXT_AUTHORIZE" };

export interface RuntimeControlReceiptAdmission {
  admit(input: RuntimeControlReceiptInput): Promise<void>;
}

const RuntimeControlReceiptInputSchema = z.union([
  z
    .object({
      operation: z.literal("P8_CORRECTION"),
      action: z.enum(["REVISE", "RETRACT"]),
      targetKind: z.literal("INTERPRETATION")
    })
    .strict(),
  z
    .object({
      operation: z.literal("P8_CORRECTION"),
      action: z.enum(["REVISE", "RETRACT"]),
      targetKind: z.literal("AUTHORED_INVARIANT"),
      invariantTarget: z.enum(["identity", "persona"])
    })
    .strict(),
  z.object({ operation: z.literal("READ_TEXT_AUTHORIZE") }).strict()
]);

const SURFACE_REFERENCE: Record<RuntimeControlReceiptInput["operation"], string> = {
  P8_CORRECTION: "yuvi:http:/p8/corrections",
  READ_TEXT_AUTHORIZE: "yuvi:http:/capabilities/read-text/authorize"
};

/** Host-only admission seam. It receives only fixed control facts, never domain inputs. */
export class HostRuntimeControlReceiptAdmission implements RuntimeControlReceiptAdmission {
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly createPayloadId: () => string = createOpaqueRuntimeControlPayloadId
  ) {}

  async admit(rawInput: RuntimeControlReceiptInput): Promise<void> {
    const parsed = RuntimeControlReceiptInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Invalid normalized Runtime control receipt input.",
        parsed.error
      );
    }
    if (!this.journal) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is not configured.");
    }

    const input = parsed.data;
    const summary = summarizeRuntimeControl(input);
    const payloadRef = {
      namespace: "yuvi:runtime-control",
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
              range: {
                unit: "UNICODE_CODE_POINT",
                start: 0,
                end: characterCount
              }
            }
          ]
        }
      },
      retainedText: [{ ref: payloadRef, text: summary }]
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
      policyVersion: "yuvi-runtime-control-receipt.v1",
      producer: { name: "yuvi-runtime-control-ingress", version: "0.1.3-a8.2e2" },
      sourceReferences: [
        {
          kind: "UNRESOLVED_SOURCE",
          reason: "local dashboard requests provide no stable command identity"
        }
      ],
      payloads
    };

    // Deliberately no sourceDedup: these controls have no stable transport retry identity.
    await this.journal.appendWithHostAuthority(appendInput, authority);
  }
}

function summarizeRuntimeControl(input: RuntimeControlReceiptInput): string {
  switch (input.operation) {
    case "P8_CORRECTION":
      return JSON.stringify({
        operation: "p8.correction",
        action: input.action,
        targetKind: input.targetKind,
        ...(input.targetKind === "AUTHORED_INVARIANT"
          ? { invariantTarget: input.invariantTarget }
          : {})
      });
    case "READ_TEXT_AUTHORIZE":
      return JSON.stringify({ operation: "capability.read-text.authorize" });
  }
}

export function createOpaqueRuntimeControlPayloadId(): string {
  return randomBytes(24).toString("base64url");
}

export function toRuntimeControlAdmissionFailure(error: unknown): {
  statusCode: 400 | 503;
  code: "JOURNAL_UNAVAILABLE" | "JOURNAL_PERSISTENCE_FAILED" | "JOURNAL_ADMISSION_REJECTED";
} {
  if (error instanceof JournalStoreError) {
    switch (error.code) {
      case "DATABASE_UNAVAILABLE":
        return { statusCode: 503, code: "JOURNAL_UNAVAILABLE" };
      case "INVALID_PROPOSAL":
      case "UNSUPPORTED_SCHEMA_VERSION":
        return { statusCode: 400, code: "JOURNAL_ADMISSION_REJECTED" };
      default:
        return { statusCode: 503, code: "JOURNAL_PERSISTENCE_FAILED" };
    }
  }
  return { statusCode: 503, code: "JOURNAL_PERSISTENCE_FAILED" };
}
