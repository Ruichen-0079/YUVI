import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createP8CorrectionRecord,
  parseP8CorrectionRecord,
  correctionFromP8CorrectionRecord,
  normalizeP8CorrectionLookup,
  serializeP8CorrectionRecord,
  validateP8CorrectionRecordLineage,
  type P8CorrectionCommandResult,
  type P8CorrectionRecord,
  type P8CorrectionStore,
  type P8ExplicitCorrection,
  type P8NativeCorrectionCommand,
  type P8NativeCorrectionReceipt
} from "@companion/p8";

type StoredFence = { intentId: string; attemptId: string; fence: string; payloadDigest: string };
type NativeEnvelope = {
  version: 2;
  revision: string;
  scopeRevisionByLookup: Record<string, string>;
  commandReceipts: P8NativeCorrectionReceipt[];
  commandFences: Record<string, StoredFence>;
  records: P8CorrectionRecord[];
  sha256: string;
};
type Snapshot = { records: P8CorrectionRecord[]; native: NativeEnvelope | null };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Production file adapter for the existing P8 correction writer. */
export function createFileP8CorrectionStore(filePath: string): P8CorrectionStore {
  const lockPath = `${filePath}.owner-lock`;
  function lookupKey(input: { address: unknown; scopeReference: unknown }) {
    return JSON.stringify(
      normalizeP8CorrectionLookup(input as Parameters<typeof normalizeP8CorrectionLookup>[0])
    );
  }
  function read(): Snapshot {
    try {
      const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(value))
        return { records: value.map(parseP8CorrectionRecord), native: null };
      const parsed = parseNativeEnvelope(value);
      const { sha256, ...body } = parsed;
      if (digest(body) !== sha256) throw new Error("P8 correction owner checksum mismatch");
      const records = parsed.records.map(parseP8CorrectionRecord);
      return { records, native: { ...parsed, records } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], native: null };
      throw error;
    }
  }
  function acquire() {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    mkdirSync(lockPath, { mode: 0o700 });
    return lockPath;
  }
  function persist(
    snapshot: Snapshot,
    values: {
      records?: P8CorrectionRecord[];
      scopeRevisionByLookup?: Record<string, string>;
      commandReceipts?: P8NativeCorrectionReceipt[];
      commandFences?: Record<
        string,
        { intentId: string; attemptId: string; fence: string; payloadDigest: string }
      >;
      writeLegacyArray?: boolean;
    } = {}
  ) {
    const records = values.records ?? snapshot.records;
    if (values.writeLegacyArray && !snapshot.native) {
      writeAtomic(records);
      return;
    }
    const prior = snapshot.native;
    const body = {
      version: 2 as const,
      revision: `p8_owner_${randomUUID()}`,
      scopeRevisionByLookup: values.scopeRevisionByLookup ?? prior?.scopeRevisionByLookup ?? {},
      commandReceipts: values.commandReceipts ?? prior?.commandReceipts ?? [],
      commandFences: values.commandFences ?? prior?.commandFences ?? {},
      records
    };
    writeAtomic({ ...body, sha256: digest(body) });
  }
  function writeAtomic(value: unknown) {
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, filePath);
    const dir = openSync(dirname(filePath), constants.O_RDONLY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  function withOwnerLock<T>(fn: () => T): T {
    const lock = acquire();
    try {
      return fn();
    } finally {
      rmdirSync(lock);
    }
  }
  function exactReceipt(
    snapshot: Snapshot,
    correction: P8ExplicitCorrection,
    command: P8NativeCorrectionCommand
  ) {
    const receipt = snapshot.native?.commandReceipts.find(
      (row) => row.commandHandle === command.commandHandle
    );
    if (!receipt) return null;
    const exact =
      receipt.intentId === command.intentId &&
      receipt.attemptId === command.attemptId &&
      BigInt(receipt.fence) <= BigInt(command.fence) &&
      receipt.payloadDigest === command.payloadDigest &&
      receipt.correctionReference === correction.correctionReference;
    return exact ? receipt : false;
  }
  function withNative(snapshot: Snapshot): NativeEnvelope {
    if (snapshot.native) return snapshot.native;
    const body = {
      version: 2 as const,
      revision: `p8_owner_${randomUUID()}`,
      scopeRevisionByLookup: {},
      commandReceipts: [],
      commandFences: {},
      records: snapshot.records
    };
    return { ...body, sha256: digest(body) };
  }
  return {
    async loadCorrections(input) {
      try {
        const key = lookupKey(input);
        const snapshot = read();
        const records = snapshot.records.filter((record) => lookupKey(record) === key);
        validateP8CorrectionRecordLineage(records);
        return {
          status: records.length ? "SUCCESS_WITH_CORRECTIONS" : "SUCCESS_WITH_NO_CORRECTIONS",
          corrections: records.map(correctionFromP8CorrectionRecord),
          nativeRevision: snapshot.native?.scopeRevisionByLookup[key] ?? null
        };
      } catch {
        return { status: "ERROR" };
      }
    },
    async loadCorrectionByReference(correctionReference) {
      try {
        if (
          typeof correctionReference !== "string" ||
          !correctionReference ||
          correctionReference.length > 160
        )
          return { status: "ERROR" };
        const snapshot = read();
        const matches = snapshot.records.filter(
          (record) => record.correctionReference === correctionReference
        );
        if (matches.length === 0) return { status: "SUCCESS_WITH_NO_CORRECTION" };
        if (matches.length !== 1) return { status: "ERROR" };
        const record = matches[0]!;
        validateP8CorrectionRecordLineage(
          snapshot.records.filter((candidate) => lookupKey(candidate) === lookupKey(record))
        );
        return {
          status: "SUCCESS_WITH_CORRECTION",
          correction: correctionFromP8CorrectionRecord(record)
        };
      } catch {
        return { status: "ERROR" };
      }
    },
    async getNativeRevision(input) {
      try {
        const snapshot = read();
        return snapshot.native?.scopeRevisionByLookup[lookupKey(input)] ?? null;
      } catch {
        return null;
      }
    },
    async fenceCorrectionCommand(command) {
      try {
        return withOwnerLock(() => {
          const snapshot = read();
          const existing = snapshot.native?.commandReceipts.find(
            (row) => row.commandHandle === command.commandHandle
          );
          if (existing) {
            if (
              existing.intentId !== command.intentId ||
              existing.payloadDigest !== command.payloadDigest
            )
              return "CONFLICT" as const;
            return existing.attemptId === command.attemptId &&
              BigInt(existing.fence) <= BigInt(command.fence)
              ? ("APPLIED" as const)
              : ("UNKNOWN" as const);
          }
          const native = withNative(snapshot);
          const prior = native.commandFences[command.commandHandle];
          if (
            prior &&
            (prior.intentId !== command.intentId || prior.payloadDigest !== command.payloadDigest)
          )
            return "CONFLICT" as const;
          if (
            prior &&
            (BigInt(command.fence) < BigInt(prior.fence) ||
              (command.fence === prior.fence && command.attemptId !== prior.attemptId))
          )
            return "UNKNOWN" as const;
          const fences = {
            ...native.commandFences,
            [command.commandHandle]: {
              intentId: command.intentId,
              attemptId: command.attemptId,
              fence: command.fence,
              payloadDigest: command.payloadDigest
            }
          };
          persist(snapshot, { commandFences: fences });
          return "READY" as const;
        });
      } catch {
        return "UNKNOWN";
      }
    },
    async appendCorrectionCommand(correction, command): Promise<P8CorrectionCommandResult> {
      const record = createP8CorrectionRecord(correction);
      try {
        return withOwnerLock(() => {
          const snapshot = read();
          const existingReceipt = exactReceipt(snapshot, correction, command);
          if (existingReceipt === false) return { status: "UNKNOWN" };
          if (existingReceipt) {
            const prior = snapshot.records.find(
              (row) => row.correctionReference === correction.correctionReference
            );
            return prior
              ? { status: "ALREADY_STORED", record: prior, receipt: existingReceipt }
              : { status: "UNKNOWN" };
          }
          const native = withNative(snapshot);
          const fence = native.commandFences[command.commandHandle];
          if (
            !fence ||
            fence.intentId !== command.intentId ||
            fence.attemptId !== command.attemptId ||
            fence.fence !== command.fence ||
            fence.payloadDigest !== command.payloadDigest
          )
            return { status: "UNKNOWN" };
          const priorRecord = snapshot.records.find(
            (row) => row.correctionReference === record.correctionReference
          );
          if (priorRecord)
            return {
              status:
                serializeP8CorrectionRecord(priorRecord) === serializeP8CorrectionRecord(record)
                  ? "UNKNOWN"
                  : "CONFLICT"
            };
          const scopeKey = lookupKey(record);
          const priorRevision = native.scopeRevisionByLookup[scopeKey] ?? null;
          if (priorRevision !== command.expectedRevision) return { status: "CONFLICT" };
          const records = [...snapshot.records, record];
          validateP8CorrectionRecordLineage(
            records.filter((candidate) => lookupKey(candidate) === scopeKey)
          );
          const resultingRevision = `p8_revision_${randomUUID()}`;
          const receipt: P8NativeCorrectionReceipt = {
            version: "p8-correction-application.v1",
            commandHandle: command.commandHandle,
            intentId: command.intentId,
            attemptId: command.attemptId,
            fence: command.fence,
            payloadDigest: command.payloadDigest,
            causalRefs: command.causalRefs,
            correctionReference: correction.correctionReference,
            priorRevision,
            resultingRevision
          };
          persist(snapshot, {
            records,
            scopeRevisionByLookup: {
              ...native.scopeRevisionByLookup,
              [scopeKey]: resultingRevision
            },
            commandReceipts: [...native.commandReceipts, receipt],
            commandFences: native.commandFences
          });
          return { status: "STORED", record, receipt };
        });
      } catch {
        return { status: "ERROR" };
      }
    },
    async reconcileCorrectionCommand(correction, command): Promise<P8CorrectionCommandResult> {
      try {
        return withOwnerLock(() => {
          const snapshot = read();
          const existingReceipt = exactReceipt(snapshot, correction, command);
          if (existingReceipt === false) return { status: "UNKNOWN" };
          if (existingReceipt) {
            const record = snapshot.records.find(
              (row) => row.correctionReference === correction.correctionReference
            );
            return record
              ? { status: "ALREADY_STORED", record, receipt: existingReceipt }
              : { status: "UNKNOWN" };
          }
          const native = withNative(snapshot);
          const prior = native.commandFences[command.commandHandle];
          if (
            prior &&
            (prior.intentId !== command.intentId || prior.payloadDigest !== command.payloadDigest)
          )
            return { status: "CONFLICT" };
          if (prior && BigInt(command.fence) < BigInt(prior.fence)) return { status: "UNKNOWN" };
          const fences = {
            ...native.commandFences,
            [command.commandHandle]: {
              intentId: command.intentId,
              attemptId: command.attemptId,
              fence: command.fence,
              payloadDigest: command.payloadDigest
            }
          };
          persist(snapshot, { commandFences: fences });
          const after = read();
          const current =
            after.native?.scopeRevisionByLookup[lookupKey(recordLookup(recordFor(correction)))] ??
            null;
          if (
            after.records.some((row) => row.correctionReference === correction.correctionReference)
          )
            return { status: "UNKNOWN" };
          if (current === command.expectedRevision)
            return { status: "PROVEN_NOT_APPLIED", reason: "EXACT_PREDECESSOR_REMAINS" };
          return { status: "UNKNOWN" };
        });
      } catch {
        return { status: "ERROR" };
      }
    },
    async appendCorrection(correction) {
      const record = createP8CorrectionRecord(correction);
      try {
        return withOwnerLock(() => {
          const snapshot = read();
          if (snapshot.native) return { status: "ERROR" as const };
          const prior = snapshot.records.find(
            (item) => item.correctionReference === record.correctionReference
          );
          if (prior)
            return serializeP8CorrectionRecord(prior) === serializeP8CorrectionRecord(record)
              ? { status: "ALREADY_STORED" as const, record: prior }
              : { status: "CONFLICT" as const };
          const records = [...snapshot.records, record];
          validateP8CorrectionRecordLineage(
            records.filter((item) => lookupKey(item) === lookupKey(record))
          );
          persist(snapshot, { records, writeLegacyArray: true });
          return { status: "STORED" as const, record };
        });
      } catch {
        return { status: "ERROR" as const };
      }
    }
  };
}

function parseNativeEnvelope(value: unknown): NativeEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid P8 correction envelope");
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "revision",
    "scopeRevisionByLookup",
    "commandReceipts",
    "commandFences",
    "records",
    "sha256"
  ]);
  if (
    Object.keys(raw).some((key) => !allowed.has(key)) ||
    raw["version"] !== 2 ||
    typeof raw["revision"] !== "string" ||
    !raw["revision"] ||
    !raw["scopeRevisionByLookup"] ||
    typeof raw["scopeRevisionByLookup"] !== "object" ||
    Array.isArray(raw["scopeRevisionByLookup"]) ||
    !Array.isArray(raw["commandReceipts"]) ||
    !raw["commandFences"] ||
    typeof raw["commandFences"] !== "object" ||
    Array.isArray(raw["commandFences"]) ||
    !Array.isArray(raw["records"]) ||
    typeof raw["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw["sha256"])
  )
    throw new Error("Invalid P8 correction envelope");
  const body = {
    version: 2 as const,
    revision: raw["revision"],
    scopeRevisionByLookup: raw["scopeRevisionByLookup"],
    commandReceipts: raw["commandReceipts"],
    commandFences: raw["commandFences"],
    records: raw["records"]
  };
  if (digest(body) !== raw["sha256"]) throw new Error("P8 correction owner checksum mismatch");
  const scopeRevisionByLookup = body.scopeRevisionByLookup as Record<string, unknown>;
  if (Object.values(scopeRevisionByLookup).some((item) => typeof item !== "string" || !item))
    throw new Error("Invalid P8 correction revision index");
  const commandFences = body.commandFences as Record<string, unknown>;
  const parsedFences: Record<string, StoredFence> = {};
  for (const [key, item] of Object.entries(commandFences)) {
    if (!key || !item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid P8 command fence");
    const row = item as Record<string, unknown>;
    if (
      typeof row["intentId"] !== "string" ||
      typeof row["attemptId"] !== "string" ||
      typeof row["fence"] !== "string" ||
      !/^[1-9][0-9]*$/.test(row["fence"]) ||
      typeof row["payloadDigest"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(row["payloadDigest"])
    )
      throw new Error("Invalid P8 command fence");
    parsedFences[key] = {
      intentId: row["intentId"],
      attemptId: row["attemptId"],
      fence: row["fence"],
      payloadDigest: row["payloadDigest"]
    };
  }
  const commandReceipts = body.commandReceipts.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid P8 command receipt");
    const row = item as Record<string, unknown>;
    const causalRefs = row["causalRefs"];
    if (
      row["version"] !== "p8-correction-application.v1" ||
      typeof row["commandHandle"] !== "string" ||
      typeof row["intentId"] !== "string" ||
      typeof row["attemptId"] !== "string" ||
      typeof row["fence"] !== "string" ||
      !/^[1-9][0-9]*$/.test(row["fence"]) ||
      typeof row["payloadDigest"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(row["payloadDigest"]) ||
      typeof row["correctionReference"] !== "string" ||
      (row["priorRevision"] !== null && typeof row["priorRevision"] !== "string") ||
      typeof row["resultingRevision"] !== "string" ||
      !Array.isArray(causalRefs) ||
      !causalRefs.length ||
      causalRefs.length > 8 ||
      causalRefs.some(
        (ref) =>
          !ref ||
          typeof ref !== "object" ||
          Array.isArray(ref) ||
          (ref as Record<string, unknown>)["kind"] !== "JOURNAL_EVENT" ||
          typeof (ref as Record<string, unknown>)["namespace"] !== "string" ||
          typeof (ref as Record<string, unknown>)["eventId"] !== "string"
      )
    )
      throw new Error("Invalid P8 command receipt");
    return row as unknown as P8NativeCorrectionReceipt;
  });
  const records = body.records.map(parseP8CorrectionRecord);
  return {
    version: 2,
    revision: body.revision as string,
    scopeRevisionByLookup: scopeRevisionByLookup as Record<string, string>,
    commandReceipts,
    commandFences: parsedFences,
    records,
    sha256: raw["sha256"]
  };
}

function recordFor(correction: P8ExplicitCorrection) {
  return createP8CorrectionRecord(correction);
}
function recordLookup(record: P8CorrectionRecord) {
  return { address: record.address, scopeReference: record.scopeReference };
}
