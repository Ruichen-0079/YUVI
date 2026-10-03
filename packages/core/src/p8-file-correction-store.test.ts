import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDefaultP8IdentityAddress, type P8ExplicitCorrection } from "@companion/p8";
import { createFileP8CorrectionStore } from "./p8-file-correction-store.js";

it("keeps append-only correction lineage, idempotency, scope isolation and corrupt-store failure across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-store-"));
  const file = join(dir, "corrections.json");
  const correction: P8ExplicitCorrection = {
    correctionReference: "first",
    address: createDefaultP8IdentityAddress("person"),
    scopeReference: { reference: "scope" },
    target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
    action: "REVISE",
    replacementMeaning: "Formal relationship",
    provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "controller" }
  };
  try {
    const store = createFileP8CorrectionStore(file);
    expect((await store.appendCorrection(correction)).status).toBe("STORED");
    expect((await store.appendCorrection(correction)).status).toBe("ALREADY_STORED");
    expect(
      (await store.appendCorrection({ ...correction, replacementMeaning: "different" })).status
    ).toBe("CONFLICT");
    expect(
      (
        await store.appendCorrection({
          ...correction,
          correctionReference: "child",
          supersedesCorrectionReference: "missing"
        })
      ).status
    ).toBe("ERROR");
    expect((await createFileP8CorrectionStore(file).loadCorrections(correction)).status).toBe(
      "SUCCESS_WITH_CORRECTIONS"
    );
    expect(await createFileP8CorrectionStore(file).loadCorrectionByReference("first")).toEqual({
      status: "SUCCESS_WITH_CORRECTION",
      correction: expect.objectContaining({ correctionReference: "first" })
    });
    expect(
      (
        await store.loadCorrections({
          ...correction,
          address: createDefaultP8IdentityAddress("other")
        })
      ).status
    ).toBe("SUCCESS_WITH_NO_CORRECTIONS");
    writeFileSync(file, "corrupted");
    expect(await store.loadCorrections(correction)).toEqual({ status: "ERROR" });
    expect(await store.loadCorrectionByReference("first")).toEqual({ status: "ERROR" });
    expect(
      (await store.appendCorrection({ ...correction, correctionReference: "another" })).status
    ).toBe("ERROR");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("commits governed correction, causal receipt and address revision as one native generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-native-owner-"));
  const file = join(dir, "corrections.json");
  const correction: P8ExplicitCorrection = {
    correctionReference: "governed-first",
    address: createDefaultP8IdentityAddress("person"),
    scopeReference: { reference: "scope" },
    target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
    action: "REVISE",
    replacementMeaning: "Corrected relationship",
    provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "controller" }
  };
  const command = {
    commandHandle: correction.correctionReference,
    intentId: "intent-p8-1",
    attemptId: "attempt-p8-1",
    fence: "1",
    payloadDigest: "b".repeat(64),
    expectedRevision: null,
    causalRefs: [{ kind: "JOURNAL_EVENT" as const, namespace: "yuvi:default", eventId: "control-p8-1" }]
  };
  try {
    let store = createFileP8CorrectionStore(file);
    expect(await store.getNativeRevision!(correction)).toBeNull();
    expect(await store.fenceCorrectionCommand!(command)).toBe("READY");
    const result = await store.appendCorrectionCommand!(correction, command);
    expect(result).toMatchObject({ status: "STORED", receipt: {
      commandHandle: correction.correctionReference,
      intentId: command.intentId,
      attemptId: command.attemptId,
      fence: command.fence,
      payloadDigest: command.payloadDigest,
      causalRefs: command.causalRefs,
      priorRevision: null
    } });
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed).toMatchObject({ version: 2, commandReceipts: [expect.objectContaining({ commandHandle: "governed-first" })], records: [expect.objectContaining({ correctionReference: "governed-first" })] });
    store = createFileP8CorrectionStore(file);
    const revision = await store.getNativeRevision!(correction);
    expect(typeof revision).toBe("string");
    expect((await store.appendCorrectionCommand!(correction, command)).status).toBe("ALREADY_STORED");
    expect((await store.reconcileCorrectionCommand!(correction, { ...command, fence: "2" })).status).toBe("ALREADY_STORED");
    expect((await store.appendCorrection({ ...correction, correctionReference: "ungoverned" })).status).toBe("ERROR");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("fences the prior attempt and proves absence only while the exact P8 predecessor remains", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-native-reconcile-"));
  const store = createFileP8CorrectionStore(join(dir, "corrections.json"));
  const correction: P8ExplicitCorrection = {
    correctionReference: "not-applied",
    address: createDefaultP8IdentityAddress("person"),
    scopeReference: { reference: "scope" },
    target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
    action: "RETRACT",
    provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "controller" }
  };
  const command = {
    commandHandle: correction.correctionReference,
    intentId: "intent-p8-2",
    attemptId: "attempt-p8-2",
    fence: "1",
    payloadDigest: "c".repeat(64),
    expectedRevision: null,
    causalRefs: [{ kind: "JOURNAL_EVENT" as const, namespace: "yuvi:default", eventId: "control-p8-2" }]
  };
  try {
    expect(await store.fenceCorrectionCommand!(command)).toBe("READY");
    expect(await store.reconcileCorrectionCommand!(correction, { ...command, fence: "2" })).toMatchObject({ status: "PROVEN_NOT_APPLIED" });
    expect((await store.appendCorrectionCommand!(correction, command)).status).toBe("UNKNOWN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
