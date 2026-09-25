import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
