import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { InMemoryEventBus } from "@companion/event-bus";
import { createFileP8CorrectionStore, RuntimeOrchestrator } from "./index.js";

const correction = (overrides: Record<string, unknown> = {}) =>
  ({
    correctionReference: "runtime-correction-a",
    address: {
      characterInstanceId: "yuvi-default-character-instance",
      personaProfileId: "persona-a",
      subjectScopeId: "person-a"
    },
    scopeReference: { reference: "scope-a" },
    target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
    action: "REVISE",
    replacementMeaning: "A private meaning marker.",
    provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "private provenance marker" },
    supersededEvidenceReferences: [],
    ...overrides
  }) as never;

function runtime(store?: ReturnType<typeof createFileP8CorrectionStore>) {
  return new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory: {} as never,
    promptBuilder: {} as never,
    providers: {} as never,
    ...(store ? { p8CorrectionStore: store } : {})
  });
}

it("preflights valid P8 commands without mutation and revalidates domain duplicates on append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yuvi-runtime-p8-preflight-"));
  const file = join(directory, "corrections.json");
  const store = createFileP8CorrectionStore(file);
  const instance = runtime(store);
  try {
    expect(await instance.preflightP8Correction(correction())).toBe("READY");
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(instance.appendP8Correction(correction())).resolves.toMatchObject({
      status: "STORED"
    });
    expect(await instance.preflightP8Correction(correction())).toBe("READY");
    await expect(instance.appendP8Correction(correction())).resolves.toMatchObject({
      status: "ALREADY_STORED"
    });
    await expect(
      instance.preflightP8Correction(
        correction({ replacementMeaning: "Changed private meaning marker." })
      )
    ).resolves.toBe("CONFLICT");
    await expect(
      instance.appendP8Correction(
        correction({ replacementMeaning: "Changed private meaning marker." })
      )
    ).resolves.toEqual({ status: "CONFLICT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects known invalid targets and lineage before admission and fails closed on unreadable state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yuvi-runtime-p8-invalid-"));
  const file = join(directory, "corrections.json");
  const store = createFileP8CorrectionStore(file);
  const instance = runtime(store);
  try {
    expect(
      await instance.preflightP8Correction(
        correction({ target: { kind: "INTERPRETATION", interpretationReference: "unknown" } })
      )
    ).toBe("INVALID");
    expect(
      await instance.preflightP8Correction(
        correction({ supersedesCorrectionReference: "missing-parent" })
      )
    ).toBe("INVALID");

    await writeFile(file, "corrupted");
    expect(await instance.preflightP8Correction(correction())).toBe("ERROR");
    expect(await runtime().preflightP8Correction(correction())).toBe("UNAVAILABLE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
