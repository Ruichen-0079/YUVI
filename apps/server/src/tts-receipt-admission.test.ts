import { describe, expect, it, vi } from "vitest";
import {
  JournalStoreError,
  type JournalAuthorityDraft,
  type JournalHostAppendInput,
  type JournalRepository
} from "@companion/journal";
import type { JournalEventCommand } from "@companion/protocol";
import {
  HostTtsReceiptAdmission,
  toTtsAdmissionFailure
} from "./tts-receipt-admission.js";

describe("HostTtsReceiptAdmission", () => {
  it("builds a CONTROL receipt without retaining text or option values", async () => {
    const appendWithHostAuthority = vi.fn(
      async (_input: JournalHostAppendInput, _authority: JournalAuthorityDraft) => ({
        status: "APPENDED" as const,
        envelope: {} as never
      })
    );
    const journal = { appendWithHostAuthority } as unknown as JournalRepository;
    let payloadId = 0;
    const admission = new HostTtsReceiptAdmission(journal, () => `opaque-${++payloadId}`);

    await admission.admit({
      sessionId: "tts-session-correlation",
      textCharacterCount: [..."秘密 speech 🐈"].length,
      voiceSupplied: true,
      languageSupplied: true,
      format: "opus"
    });

    expect(appendWithHostAuthority).toHaveBeenCalledTimes(1);
    const [input, authority] = appendWithHostAuthority.mock.calls[0]!;
    const command = input.command as JournalEventCommand;
    expect(Object.keys(input).sort()).toEqual(["command", "retainedText"]);
    expect(command).toMatchObject({
      kind: "RECEIPT",
      data: { receiptClass: "CONTROL" }
    });
    expect(command.kind === "RECEIPT" && command.data.evidenceSelectors).toHaveLength(1);
    expect(input.retainedText).toHaveLength(1);
    expect(input.retainedText?.[0]?.text).toBe(
      '{"operation":"tts.synthesize","textCharacterCount":11,"voiceSupplied":true,"languageSupplied":true,"format":"opus"}'
    );
    const payloads = authority.payloads;
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      modality: "TEXT",
      retention: "NOT_RETAINED",
      origin: "USER_INPUT",
      selectable: false,
      characterCount: 11
    });
    expect(payloads[1]).toMatchObject({
      modality: "TEXT",
      retention: "RETAINED",
      selectable: true
    });
    if (command.kind !== "RECEIPT") throw new Error("Expected receipt command.");
    const selector = command.data.evidenceSelectors[0];
    expect(selector).toMatchObject({
      modality: "TEXT",
      payload: payloads[1]!.ref,
      range: { unit: "UNICODE_CODE_POINT", start: 0 }
    });
    expect(authority).toMatchObject({
      principal: { state: "UNRESOLVED" },
      subjects: [],
      binding: { state: "UNRESOLVED" },
      surface: { kind: "LOCAL", reference: "yuvi:http:/v1/tts" },
      correlations: [{ kind: "CONVERSATION", sessionId: "tts-session-correlation" }],
      audience: { kind: "UNKNOWN" },
      sourceReferences: [{ kind: "UNRESOLVED_SOURCE" }],
      producer: { version: "0.1.3-a8.2f4" }
    });
    const durableDraft = JSON.stringify({ input, authority });
    expect(durableDraft).not.toContain("秘密 speech");
    expect(durableDraft).not.toContain("PRIVATE_VOICE");
    expect(durableDraft).not.toContain("PRIVATE_LANGUAGE");
    expect(durableDraft).not.toContain("sourceDedup");
  });

  it("omits an oversized session correlation and maps Journal failures safely", async () => {
    const appendWithHostAuthority = vi.fn(async () => ({
      status: "APPENDED" as const,
      envelope: {} as never
    }));
    const admission = new HostTtsReceiptAdmission(
      { appendWithHostAuthority } as unknown as JournalRepository,
      () => "opaque-id"
    );
    await expect(
      admission.admit({
        textCharacterCount: 1,
        voiceSupplied: false,
        languageSupplied: false,
        format: null,
        sessionId: "s".repeat(513)
      } as never)
    ).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });

    const unavailable = new HostTtsReceiptAdmission(null);
    await expect(
      unavailable.admit({
        textCharacterCount: 1,
        voiceSupplied: false,
        languageSupplied: false,
        format: null
      })
    ).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(
      toTtsAdmissionFailure(
        new JournalStoreError("DATABASE_UNAVAILABLE", "private database details")
      )
    ).toEqual({
      statusCode: 503,
      code: "JOURNAL_UNAVAILABLE",
      message: "Durable TTS request admission is temporarily unavailable."
    });
    expect(
      toTtsAdmissionFailure(new JournalStoreError("INVALID_PROPOSAL", "internal details"))
    ).toEqual({
      statusCode: 400,
      code: "JOURNAL_ADMISSION_REJECTED",
      message: "TTS request could not be admitted to the Journal."
    });
  });
});
