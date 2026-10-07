import { randomUUID } from "node:crypto";
import type { JournalRepository } from "@companion/journal";
import type { JournalEventRef, JournalPayloadDescriptor } from "@companion/protocol";
import { z } from "zod";

export const SurfaceReceiptSchema = z
  .object({
    namespace: z.string().min(1).max(256),
    actorId: z.string().min(1).max(128),
    channelRef: z.string().min(1).max(512),
    conversationKind: z.enum(["PRIVATE", "GROUP"]),
    sessionId: z.string().min(1).max(512),
    runtimeEventId: z.string().min(1).max(128),
    content: z.string().min(1).max(4096),
    // Opaque, bounded codec facts (including temporary-private provenance).
    transportFacts: z.string().max(8192),
    hasImage: z.boolean(),
    binding: z
      .object({ personId: z.string().min(1).max(256), version: z.string().min(1).max(256) })
      .strict()
      .optional()
  })
  .strict();
export type SurfaceReceipt = z.infer<typeof SurfaceReceiptSchema>;
export interface SurfaceReceiptAdmission {
  admit(input: SurfaceReceipt): Promise<JournalEventRef>;
}

/** Host-authored authority; no plugin can supply a Person binding through wire metadata. */
export class HostSurfaceReceiptAdmission implements SurfaceReceiptAdmission {
  constructor(private readonly journal: JournalRepository | null) {}
  async admit(raw: SurfaceReceipt): Promise<JournalEventRef> {
    const input = SurfaceReceiptSchema.parse(raw);
    if (!this.journal) throw Error("Surface receipts require the durable Journal.");
    const text = { namespace: "yuvi:surface-text", payloadId: randomUUID(), version: "v1" };
    const facts = { namespace: "yuvi:surface-facts", payloadId: randomUUID(), version: "v1" };
    const payloads: JournalPayloadDescriptor[] = [
      {
        ref: text,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "USER_INPUT",
        selectable: true,
        characterCount: [...input.content].length
      },
      {
        ref: facts,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "USER_INPUT",
        selectable: false,
        characterCount: [...input.transportFacts].length
      }
    ];
    if (input.hasImage)
      payloads.push({
        ref: { namespace: "yuvi:surface-image", payloadId: randomUUID(), version: "v1" },
        modality: "IMAGE",
        retention: "NOT_RETAINED",
        origin: "USER_INPUT",
        selectable: false
      });
    const result = await this.journal.appendWithHostAuthority(
      {
        command: {
          version: "life-event-command.v1",
          kind: "RECEIPT",
          occurrenceTime: { state: "UNKNOWN" },
          causalParents: [],
          data: {
            receiptClass: "ATTRIBUTED_ASSERTION",
            evidenceSelectors: [
              {
                version: "source-selector.v1",
                modality: "TEXT",
                payload: text,
                range: { unit: "UNICODE_CODE_POINT", start: 0, end: [...input.content].length }
              }
            ]
          }
        },
        retainedText: [
          { ref: text, text: input.content },
          { ref: facts, text: input.transportFacts }
        ]
      },
      {
        principal: {
          state: "RESOLVED",
          kind: "PRINCIPAL",
          namespace: input.namespace,
          actorId: input.actorId
        },
        subjects: input.binding
          ? [{ kind: "PERSON", personId: input.binding.personId, resolution: "RESOLVED" }]
          : [
              {
                kind: "PRINCIPAL",
                namespace: input.namespace,
                actorId: input.actorId,
                resolution: "RESOLVED"
              }
            ],
        binding: input.binding
          ? {
              state: "RESOLVED",
              kind: "PERSON_BINDING",
              personId: input.binding.personId,
              bindingVersion: input.binding.version
            }
          : { state: "UNRESOLVED", reason: "No host-granted Product Person binding" },
        surface: {
          kind: input.conversationKind === "PRIVATE" ? "PRIVATE_CHANNEL" : "GROUP_CHANNEL",
          reference: input.channelRef
        },
        audience:
          input.conversationKind === "PRIVATE"
            ? { kind: "PRIVATE", channelRef: input.channelRef }
            : {
                kind: "GROUP",
                channelRef: input.channelRef,
                membership: {
                  state: "UNKNOWN",
                  reason: "No historical audience membership snapshot"
                }
              },
        disclosurePolicy: {
          state: "UNRESOLVED",
          reason: "Public replies do not certify audience membership"
        },
        correlations: [
          { kind: "CONVERSATION", sessionId: input.sessionId },
          { kind: "RUNTIME_EVENT", runtimeEventId: input.runtimeEventId }
        ],
        policyVersion: "yuvi-surface-receipt.v1",
        producer: { name: "yuvi-character-surface", version: "1" },
        sourceReferences: [
          {
            kind: "UNRESOLVED_SOURCE",
            reason:
              "Transport handles are bounded local correlation hints, not globally stable source identities"
          }
        ],
        payloads
      }
    );
    return {
      kind: "JOURNAL_EVENT",
      namespace: result.envelope.journalNamespace,
      eventId: result.envelope.eventId
    };
  }
}
