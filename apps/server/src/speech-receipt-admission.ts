import { randomBytes } from "node:crypto";
import {
  JOURNAL_COMMAND_VERSION,
  type JournalCommittedEnvelope,
  type JournalPayloadDescriptor
} from "@companion/protocol";
import {
  JournalStoreError,
  type JournalAuthorityDraft,
  type JournalHostAppendInput,
  type JournalRepository
} from "@companion/journal";
import type { STTOutput } from "@companion/providers";
import { z } from "zod";

export const SPEECH_RECEIPT_SURFACES = ["HTTP_AUDIO_TRANSCRIPTIONS", "HTTP_VOICE_MESSAGE"] as const;
export type SpeechReceiptSurface = (typeof SPEECH_RECEIPT_SURFACES)[number];

export type SpeechReceiptInput = Readonly<{
  surface: SpeechReceiptSurface;
  sessionId: string;
  observation: STTOutput;
  audioReceived: boolean;
  mockTextSupplied?: boolean;
}>;

export interface SpeechReceiptAdmission {
  admit(input: SpeechReceiptInput): Promise<JournalCommittedEnvelope>;
}

const SpeechReceiptInputSchema = z
  .object({
    surface: z.enum(SPEECH_RECEIPT_SURFACES),
    sessionId: z.string().min(1).max(512),
    observation: z
      .object({
        observationId: z.string().min(1).max(512),
        captureEpoch: z.string().min(1).max(512),
        text: z.string(),
        segments: z
          .array(z.object({ segmentId: z.string().min(1).max(512) }).passthrough())
          .optional()
      })
      .passthrough(),
    audioReceived: z.boolean(),
    mockTextSupplied: z.boolean().optional()
  })
  .strict();

const SURFACE_REFERENCE: Record<SpeechReceiptSurface, string> = {
  HTTP_AUDIO_TRANSCRIPTIONS: "yuvi:http:/v1/audio/transcriptions",
  HTTP_VOICE_MESSAGE: "yuvi:http:/v1/voice/message"
};

/** Host-only authority builder for finalized speech. It has no Runtime or identity authority. */
export class HostSpeechReceiptAdmission implements SpeechReceiptAdmission {
  constructor(
    private readonly journal: JournalRepository | null,
    private readonly createPayloadId: () => string = createOpaqueSpeechPayloadId
  ) {}

  async admit(rawInput: SpeechReceiptInput): Promise<JournalCommittedEnvelope> {
    const parsed = SpeechReceiptInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Invalid normalized speech receipt input.",
        parsed.error
      );
    }
    if (!this.journal) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is not configured.");
    }

    const input = parsed.data;
    const mockTextOnly = input.mockTextSupplied === true && !input.audioReceived;
    const observation = input.observation;
    const textRef = {
      namespace: "yuvi:speech-transcript",
      payloadId: `text_${this.createPayloadId()}`,
      version: "v1"
    };
    const characterCount = [...observation.text].length;
    const payloads: JournalPayloadDescriptor[] = [
      {
        ref: textRef,
        modality: "TEXT",
        retention: "RETAINED",
        origin: mockTextOnly ? "USER_INPUT" : "EXTERNAL_RESULT",
        selectable: characterCount > 0,
        characterCount
      }
    ];
    if (input.audioReceived) {
      payloads.push({
        ref: {
          namespace: "yuvi:speech-input",
          payloadId: `audio_${this.createPayloadId()}`,
          version: "v1"
        },
        modality: "AUDIO",
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
        receiptClass: mockTextOnly
          ? ("ATTRIBUTED_ASSERTION" as const)
          : ("DIRECT_OBSERVATION" as const),
        evidenceSelectors:
          characterCount > 0
            ? [
                {
                  version: "source-selector.v1" as const,
                  modality: "TEXT" as const,
                  payload: textRef,
                  range: {
                    unit: "UNICODE_CODE_POINT" as const,
                    start: 0,
                    end: characterCount
                  }
                }
              ]
            : []
      }
    };

    const voiceSource = {
      kind: "VOICE_OBSERVATION" as const,
      observationId: observation.observationId,
      captureEpoch: observation.captureEpoch
    };
    const segmentIds = new Set(
      (observation.segments ?? []).map((segment) => segment.segmentId)
    );
    const voiceSources = [
      voiceSource,
      ...[...segmentIds].map((segmentId) => ({
        kind: "VOICE_OBSERVATION" as const,
        observationId: observation.observationId,
        captureEpoch: observation.captureEpoch,
        segmentId
      }))
    ];
    const authority: JournalAuthorityDraft = {
      principal: {
        state: "UNRESOLVED",
        reason: "speech transport does not authenticate a principal"
      },
      subjects: [],
      binding: {
        state: "UNRESOLVED",
        reason: "voice evidence is not receipt-time Person binding authority"
      },
      surface: { kind: "LOCAL", reference: SURFACE_REFERENCE[input.surface] },
      correlations: [{ kind: "CONVERSATION", sessionId: input.sessionId }, ...voiceSources],
      audience: { kind: "UNKNOWN", reason: "speech route has no authenticated audience snapshot" },
      disclosurePolicy: {
        state: "UNRESOLVED",
        reason: "no speech-route disclosure snapshot is available"
      },
      policyVersion: "yuvi-finalized-speech-receipt.v1",
      producer: { name: "yuvi-speech-ingress", version: "0.1.3-a8.2c" },
      ...(typeof observation["model"] === "string" ? { modelVersion: observation["model"] } : {}),
      sourceReferences: voiceSources,
      payloads
    };

    const appendInput: JournalHostAppendInput = {
      command,
      retainedText: [{ ref: textRef, text: observation.text }]
    };
    const result = await this.journal.appendWithHostAuthority(appendInput, authority);
    return result.envelope as JournalCommittedEnvelope;
  }
}

export function createOpaqueSpeechPayloadId(): string {
  return randomBytes(24).toString("base64url");
}

export function toSpeechAdmissionFailure(error: unknown): {
  code: "JOURNAL_UNAVAILABLE" | "JOURNAL_PERSISTENCE_FAILED" | "JOURNAL_ADMISSION_REJECTED";
  message: string;
} {
  if (error instanceof JournalStoreError) {
    switch (error.code) {
      case "DATABASE_UNAVAILABLE":
        return {
          code: "JOURNAL_UNAVAILABLE",
          message: "Durable speech admission is temporarily unavailable."
        };
      case "INVALID_PROPOSAL":
      case "UNSUPPORTED_SCHEMA_VERSION":
        return {
          code: "JOURNAL_ADMISSION_REJECTED",
          message: "Speech could not be admitted to the Journal."
        };
      default:
        return {
          code: "JOURNAL_PERSISTENCE_FAILED",
          message: "Durable speech admission did not commit."
        };
    }
  }
  return {
    code: "JOURNAL_PERSISTENCE_FAILED",
    message: "Durable speech admission did not commit."
  };
}
