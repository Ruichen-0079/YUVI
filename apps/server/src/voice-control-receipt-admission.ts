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

export type VoiceControlReceiptInput =
  | { operation: "VOICE_PROFILE_ENROLL"; voiceProfileId: string }
  | { operation: "VOICE_PROFILE_BIND_PERSON"; voiceProfileId: string; personId: string }
  | { operation: "VOICE_PROFILE_DELETE"; voiceProfileId: string }
  | { operation: "VOICE_PROFILE_BINDING_REMOVE"; voiceProfileId: string };

export interface VoiceControlReceiptAdmission {
  admit(input: VoiceControlReceiptInput): Promise<void>;
}

const id = z.string().min(1).max(160);
const VoiceControlReceiptInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("VOICE_PROFILE_ENROLL"), voiceProfileId: id }).strict(),
  z
    .object({ operation: z.literal("VOICE_PROFILE_BIND_PERSON"), voiceProfileId: id, personId: id })
    .strict(),
  z.object({ operation: z.literal("VOICE_PROFILE_DELETE"), voiceProfileId: id }).strict(),
  z.object({ operation: z.literal("VOICE_PROFILE_BINDING_REMOVE"), voiceProfileId: id }).strict()
]);

const SURFACE_REFERENCE: Record<VoiceControlReceiptInput["operation"], string> = {
  VOICE_PROFILE_ENROLL: "yuvi:http:/voice-profiles",
  VOICE_PROFILE_BIND_PERSON: "yuvi:http:/voice-profiles/:id/person",
  VOICE_PROFILE_DELETE: "yuvi:http:/voice-profiles/:id",
  VOICE_PROFILE_BINDING_REMOVE: "yuvi:http:/product/voices/:id/binding"
};

/** Host-only builder for sanitized voice-control facts; it owns no audio, Memory, Runtime or provider access. */
export class HostVoiceControlReceiptAdmission implements VoiceControlReceiptAdmission {
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly createPayloadId: () => string = createOpaqueVoiceControlPayloadId
  ) {}

  async admit(rawInput: VoiceControlReceiptInput): Promise<void> {
    const parsed = VoiceControlReceiptInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Invalid normalized voice control receipt input.",
        parsed.error
      );
    }
    if (!this.journal) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is not configured.");
    }

    const input = parsed.data;
    const summary = summarize(input);
    const textRef = {
      namespace: "yuvi:voice-control",
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

    if (input.operation === "VOICE_PROFILE_ENROLL") {
      payloads.push({
        ref: {
          namespace: "yuvi:voice-enrollment-audio",
          payloadId: `audio_${this.createPayloadId()}`,
          version: "v1"
        },
        modality: "AUDIO",
        retention: "NOT_RETAINED",
        origin: "USER_INPUT",
        selectable: false
      });
    }

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
              payload: textRef,
              range: { unit: "UNICODE_CODE_POINT", start: 0, end: characterCount }
            }
          ]
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
        reason: "local dashboard access does not establish a caller Person binding"
      },
      surface: { kind: "LOCAL", reference: SURFACE_REFERENCE[input.operation] },
      correlations: [],
      audience: { kind: "UNKNOWN", reason: "local control has no audience or membership snapshot" },
      disclosurePolicy: {
        state: "UNRESOLVED",
        reason: "no local-control disclosure-policy snapshot is available"
      },
      policyVersion: "yuvi-voice-control-receipt.v1",
      producer: { name: "yuvi-voice-control-ingress", version: "0.1.3-a8.2f1" },
      sourceReferences: [
        {
          kind: "UNRESOLVED_SOURCE",
          reason: "local controller requests provide no stable transport identity"
        }
      ],
      payloads
    };

    // No sourceDedup: profile and Person identifiers are domain targets, not transport identities.
    await this.journal.appendWithHostAuthority(appendInput, authority);
  }
}

function summarize(input: VoiceControlReceiptInput): string {
  switch (input.operation) {
    case "VOICE_PROFILE_ENROLL":
      return JSON.stringify({
        operation: "voice.profile.enroll",
        voiceProfileId: input.voiceProfileId
      });
    case "VOICE_PROFILE_BIND_PERSON":
      return JSON.stringify({
        operation: "voice.profile.bind-person",
        voiceProfileId: input.voiceProfileId,
        personId: input.personId
      });
    case "VOICE_PROFILE_DELETE":
      return JSON.stringify({
        operation: "voice.profile.delete",
        voiceProfileId: input.voiceProfileId
      });
    case "VOICE_PROFILE_BINDING_REMOVE":
      return JSON.stringify({
        operation: "voice.profile.binding-remove",
        voiceProfileId: input.voiceProfileId
      });
  }
}

export function createOpaqueVoiceControlPayloadId(): string {
  return randomBytes(24).toString("base64url");
}

export function toVoiceControlAdmissionFailure(error: unknown): {
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
