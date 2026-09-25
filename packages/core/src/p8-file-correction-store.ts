import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createP8CorrectionRecord,
  parseP8CorrectionRecord,
  correctionFromP8CorrectionRecord,
  normalizeP8CorrectionLookup,
  serializeP8CorrectionRecord,
  validateP8CorrectionRecordLineage,
  type P8CorrectionRecord,
  type P8CorrectionReferenceLoadResult,
  type P8CorrectionStore
} from "@companion/p8";

/** Local production adapter for the existing append-only P8 correction contract. */
export function createFileP8CorrectionStore(filePath: string): P8CorrectionStore {
  function read(): P8CorrectionRecord[] {
    try {
      const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!Array.isArray(value)) throw new Error("Invalid correction store");
      return value.map(parseP8CorrectionRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  function key(record: { address: unknown; scopeReference: unknown }): string {
    return JSON.stringify(
      normalizeP8CorrectionLookup(record as Parameters<typeof normalizeP8CorrectionLookup>[0])
    );
  }
  return {
    async loadCorrections(input) {
      try {
        const records = read().filter((record) => key(record) === key(input));
        validateP8CorrectionRecordLineage(records);
        return {
          status: records.length ? "SUCCESS_WITH_CORRECTIONS" : "SUCCESS_WITH_NO_CORRECTIONS",
          corrections: records.map(correctionFromP8CorrectionRecord)
        };
      } catch {
        return { status: "ERROR" };
      }
    },
    async loadCorrectionByReference(correctionReference): Promise<P8CorrectionReferenceLoadResult> {
      try {
        if (
          typeof correctionReference !== "string" ||
          correctionReference.length === 0 ||
          correctionReference.length > 160
        )
          return { status: "ERROR" };
        const records = read();
        const matches = records.filter(
          (record) => record.correctionReference === correctionReference
        );
        if (matches.length === 0) return { status: "SUCCESS_WITH_NO_CORRECTION" };
        if (matches.length !== 1) return { status: "ERROR" };
        const record = matches[0]!;
        validateP8CorrectionRecordLineage(
          records.filter((candidate) => key(candidate) === key(record))
        );
        return {
          status: "SUCCESS_WITH_CORRECTION",
          correction: correctionFromP8CorrectionRecord(record)
        };
      } catch {
        return { status: "ERROR" };
      }
    },
    async appendCorrection(correction) {
      const record = createP8CorrectionRecord(correction);
      try {
        // Synchronous read/validate/rename prevents lost updates within the single server owner.
        const records = read();
        const prior = records.find(
          (item) => item.correctionReference === record.correctionReference
        );
        if (prior)
          return serializeP8CorrectionRecord(prior) === serializeP8CorrectionRecord(record)
            ? { status: "ALREADY_STORED", record: prior }
            : { status: "CONFLICT" };
        records.push(record);
        validateP8CorrectionRecordLineage(records.filter((item) => key(item) === key(record)));
        mkdirSync(dirname(filePath), { recursive: true });
        const temp = `${filePath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(records), { mode: 0o600 });
        renameSync(temp, filePath);
        return { status: "STORED", record };
      } catch {
        return { status: "ERROR" };
      }
    }
  };
}
