import { describe, expect, it, vi } from "vitest";
import {
  JournalStoreError,
  type JournalAuthorityDraft,
  type JournalHostAppendInput,
  type JournalRepository
} from "@companion/journal";
import {
  HostProactiveTurnReceiptAdmission,
  toProactiveTurnAdmissionFailure
} from "./proactive-turn-receipt-admission.js";

describe("HostProactiveTurnReceiptAdmission", () => {
  it("builds a bounded CONTROL receipt with unresolved authority and no source dedup", async () => {
    const appendWithHostAuthority = vi.fn(
      async (_input: JournalHostAppendInput, _authority: JournalAuthorityDraft) => ({
        status: "APPENDED" as const,
        envelope: {} as never
      })
    );
    const journal = { appendWithHostAuthority } as unknown as JournalRepository;
    const admission = new HostProactiveTurnReceiptAdmission(journal, () => "opaque-payload-id");

    await admission.admit({
      sessionId: "session-correlation-only",
      readMemory: true,
      promptPreview: false
    });

    expect(appendWithHostAuthority).toHaveBeenCalledTimes(1);
    const [input, authority] = appendWithHostAuthority.mock.calls[0]!;
    expect(Object.keys(input).sort()).toEqual(["command", "retainedText"]);
    expect(input.command).toMatchObject({
      kind: "RECEIPT",
      data: { receiptClass: "CONTROL" }
    });
    expect(input.retainedText?.[0]?.text).toBe(
      '{"operation":"proactive-turn.request","readMemory":true,"promptPreview":false}'
    );
    expect(authority).toMatchObject({
      principal: { state: "UNRESOLVED" },
      subjects: [],
      binding: { state: "UNRESOLVED" },
      surface: { kind: "LOCAL", reference: "yuvi:http:/v1/proactive-turns/stream" },
      correlations: [{ kind: "CONVERSATION", sessionId: "session-correlation-only" }],
      audience: { kind: "UNKNOWN" },
      producer: { version: "0.1.3-a8.2f3" },
      sourceReferences: [{ kind: "UNRESOLVED_SOURCE" }],
      payloads: [
        {
          modality: "TEXT",
          retention: "RETAINED",
          selectable: true,
          characterCount: 78
        }
      ]
    });
    const durableDraft = JSON.stringify({ input, authority });
    expect(durableDraft).not.toContain("idempotency");
    expect(durableDraft).not.toContain("authorization");
  });

  it("rejects unbounded or caller-added facts and reports unavailable Journal without fallback", async () => {
    const unavailable = new HostProactiveTurnReceiptAdmission(null);
    await expect(
      unavailable.admit({ sessionId: "session", readMemory: false, promptPreview: false })
    ).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    await expect(
      unavailable.admit({
        sessionId: "s".repeat(513),
        readMemory: false,
        promptPreview: false
      })
    ).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });
    await expect(
      unavailable.admit({
        sessionId: "session",
        readMemory: false,
        promptPreview: false,
        idempotencyKey: "must-not-be-authority"
      } as never)
    ).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });
    expect(
      toProactiveTurnAdmissionFailure(
        new JournalStoreError("DATABASE_UNAVAILABLE", "private database detail")
      )
    ).toEqual({
      statusCode: 503,
      code: "JOURNAL_UNAVAILABLE",
      message: "Durable proactive-turn request admission is temporarily unavailable."
    });
  });
});
