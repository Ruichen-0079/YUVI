import { expect, it, vi } from "vitest";
import type {
  JournalAuthorityDraft,
  JournalHostAppendInput,
  JournalRepository
} from "@companion/journal";
import { HostVoiceControlReceiptAdmission } from "./voice-control-receipt-admission.js";

it("builds sanitized unresolved CONTROL receipts and an unselectable enrollment audio descriptor", async () => {
  let captured: { input: JournalHostAppendInput; authority: JournalAuthorityDraft } | undefined;
  const append = vi.fn(async (input: JournalHostAppendInput, authority: JournalAuthorityDraft) => {
    captured = { input, authority };
    return { status: "APPENDED" as const, envelope: {} as never };
  });
  const journal = { appendWithHostAuthority: append } as unknown as JournalRepository;
  const admission = new HostVoiceControlReceiptAdmission(
    journal,
    () => "opaque-payload-id-12345678"
  );
  await admission.admit({ operation: "VOICE_PROFILE_ENROLL", voiceProfileId: "profile-target" });

  expect(append).toHaveBeenCalledTimes(1);
  expect(captured?.input).not.toHaveProperty("sourceDedup");
  expect(captured?.input.command).toMatchObject({
    kind: "RECEIPT",
    data: { receiptClass: "CONTROL" }
  });
  expect(captured?.authority).toMatchObject({
    principal: { state: "UNRESOLVED" },
    binding: { state: "UNRESOLVED" },
    subjects: [],
    audience: { kind: "UNKNOWN" }
  });
  expect(captured?.authority.payloads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ modality: "AUDIO", retention: "NOT_RETAINED", selectable: false })
    ])
  );
  const serialized = JSON.stringify(captured);
  for (const forbidden of ["audioBase64", "label", "displayName", "embedding", "PERSON_MARKER"]) {
    expect(serialized).not.toContain(forbidden);
  }
  expect(serialized).toContain("profile-target");
});

it("rejects unsupported voice control commands before calling the Journal", async () => {
  const append = vi.fn();
  const admission = new HostVoiceControlReceiptAdmission({
    appendWithHostAuthority: append
  } as unknown as JournalRepository);
  await expect(
    admission.admit({
      operation: "VOICE_PROFILE_ENROLL",
      voiceProfileId: "profile-a",
      audioBase64: "SECRET"
    } as never)
  ).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });
  await expect(
    admission.admit({ operation: "VOICE_PROFILE_IDENTIFY", voiceProfileId: "profile-a" } as never)
  ).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });
  expect(append).not.toHaveBeenCalled();
});

it("accepts only sanitized f2 control targets and marks consumed audio not retained", async () => {
  const captured: Array<{ input: JournalHostAppendInput; authority: JournalAuthorityDraft }> = [];
  const admission = new HostVoiceControlReceiptAdmission(
    {
      appendWithHostAuthority: vi.fn(async (input: JournalHostAppendInput, authority: JournalAuthorityDraft) => {
        captured.push({ input, authority });
        return { status: "APPENDED" as const, envelope: {} as never };
      })
    } as unknown as JournalRepository,
    () => "opaque-payload-id-12345678"
  );
  await admission.admit({ operation: "VOICE_SAMPLE_REVIEW_UNKNOWN", sampleId: "sample-target" });
  await admission.admit({
    operation: "VOICE_SAMPLE_REVIEW_PERSON",
    sampleId: "sample-target",
    personId: "person-target",
    voiceProfileId: "profile-target",
    enrollFromSample: true
  });
  await admission.admit({
    operation: "PRODUCT_VOICE_ENROLL",
    newVoiceProfileId: "new-profile-target",
    personId: "person-target",
    replaceVoiceProfileId: "old-profile-target"
  });

  expect(captured).toHaveLength(3);
  for (const row of captured) {
    expect(row.input.command).toMatchObject({ kind: "RECEIPT", data: { receiptClass: "CONTROL" } });
    expect(row.input).not.toHaveProperty("sourceDedup");
    expect(row.authority).toMatchObject({
      principal: { state: "UNRESOLVED" },
      binding: { state: "UNRESOLVED" },
      subjects: [],
      audience: { kind: "UNKNOWN" }
    });
    expect(JSON.stringify(row)).not.toMatch(/audioBase64|displayName|embedding|label/);
    const command = row.input.command as {
      kind: string;
      data?: { evidenceSelectors?: Array<{ modality: string }> };
    };
    expect(command.kind).toBe("RECEIPT");
    expect(command.data?.evidenceSelectors?.map(selector => selector.modality)).toEqual(["TEXT"]);
  }
  expect(captured[0]!.authority.payloads.some(payload => payload.modality === "AUDIO")).toBe(false);
  expect(captured[1]!.authority.payloads).toEqual(
    expect.arrayContaining([expect.objectContaining({ modality: "AUDIO", retention: "NOT_RETAINED", selectable: false })])
  );
  expect(captured[2]!.authority.payloads).toEqual(
    expect.arrayContaining([expect.objectContaining({ modality: "AUDIO", retention: "NOT_RETAINED", selectable: false })])
  );

  await expect(admission.admit({
    operation: "VOICE_SAMPLE_REVIEW_UNKNOWN",
    sampleId: "sample-target",
    audioBase64: "PRIVATE"
  } as never)).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });
  expect(captured).toHaveLength(3);
});
