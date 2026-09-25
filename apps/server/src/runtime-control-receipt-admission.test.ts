import { describe, expect, it } from "vitest";
import type {
  JournalAuthorityDraft,
  JournalHostAppendInput,
  JournalRepository
} from "@companion/journal";
import { JournalStoreError } from "@companion/journal";
import {
  HostRuntimeControlReceiptAdmission,
  type RuntimeControlReceiptInput
} from "./runtime-control-receipt-admission.js";

function repository(
  calls: Array<{ input: JournalHostAppendInput; authority: JournalAuthorityDraft }>
): JournalRepository {
  return {
    namespace: "test",
    async append() {
      throw new Error("generic append is not expected");
    },
    async appendWithHostAuthority(input, authority) {
      calls.push({ input, authority });
      return { status: "APPENDED", envelope: {} as never };
    },
    async get() {
      return null;
    },
    async resolveRetainedText() {
      return null;
    }
  };
}

describe("HostRuntimeControlReceiptAdmission", () => {
  it("retains only fixed P8 control facts and unresolved local authority", async () => {
    const calls: Array<{ input: JournalHostAppendInput; authority: JournalAuthorityDraft }> = [];
    const admission = new HostRuntimeControlReceiptAdmission(repository(calls), () => "opaque-id");
    const p8: RuntimeControlReceiptInput = {
      operation: "P8_CORRECTION",
      action: "REVISE",
      targetKind: "INTERPRETATION"
    };
    await admission.admit(p8);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).not.toHaveProperty("sourceDedup");
    expect(calls[0]!.input.command).toMatchObject({
      kind: "RECEIPT",
      data: { receiptClass: "CONTROL", evidenceSelectors: [expect.any(Object)] }
    });
    expect(calls[0]!.authority).toMatchObject({
      principal: { state: "UNRESOLVED" },
      binding: { state: "UNRESOLVED" },
      subjects: [],
      audience: { kind: "UNKNOWN" },
      surface: { kind: "LOCAL", reference: "yuvi:http:/p8/corrections" }
    });
    const retained = calls[0]!.input.retainedText?.[0]?.text;
    expect(retained).toBe(
      JSON.stringify({ operation: "p8.correction", action: "REVISE", targetKind: "INTERPRETATION" })
    );
    expect(JSON.stringify(calls[0])).not.toContain("replacementMeaning");
    expect(JSON.stringify(calls[0])).not.toContain("correctionReference");
    expect(JSON.stringify(calls[0])).not.toContain("interpretationReference");
    expect(JSON.stringify(calls[0])).not.toContain("provenance");
  });

  it("does not accept paths, session IDs, arbitrary targets, or unknown fields", async () => {
    const calls: Array<{ input: JournalHostAppendInput; authority: JournalAuthorityDraft }> = [];
    const admission = new HostRuntimeControlReceiptAdmission(repository(calls));
    for (const input of [
      { operation: "READ_TEXT_AUTHORIZE", path: "/private/marker" },
      { operation: "READ_TEXT_AUTHORIZE", sessionId: "private-session" },
      {
        operation: "P8_CORRECTION",
        action: "REVISE",
        targetKind: "INTERPRETATION",
        interpretationReference: "private-target"
      },
      {
        operation: "P8_CORRECTION",
        action: "REVISE",
        targetKind: "AUTHORED_INVARIANT",
        invariantTarget: "persona",
        invariantKey: "private-key"
      }
    ]) {
      await expect(admission.admit(input as never)).rejects.toMatchObject({
        code: "INVALID_PROPOSAL"
      } satisfies Partial<JournalStoreError>);
    }
    await admission.admit({ operation: "READ_TEXT_AUTHORIZE" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.retainedText?.[0]?.text).toBe(
      JSON.stringify({ operation: "capability.read-text.authorize" })
    );
  });

  it("fails unavailable Journal admission without a fallback", async () => {
    const admission = new HostRuntimeControlReceiptAdmission(null);
    await expect(admission.admit({ operation: "READ_TEXT_AUTHORIZE" })).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE"
    });
  });
});
