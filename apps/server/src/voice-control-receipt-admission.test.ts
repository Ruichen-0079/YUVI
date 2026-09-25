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
