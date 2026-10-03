import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type VoiceBindingIndexSnapshot = Readonly<{
  complete: boolean;
  ownerRevision: string | null;
  byScope: Readonly<Record<string, readonly string[]>>;
}>;

/** Lookup index only. The controller owner remains decisive for binding validity. */
export interface VoiceBindingReferences {
  load(scope: string): readonly string[];
  append(scope: string, eventId: string): void;
  isCurrent?(ownerRevision: string | null): boolean;
  rebuild?(snapshot: VoiceBindingIndexSnapshot): void;
}

const checksum = (value: unknown) => {
  // The index is disposable and verified against its exact owner watermark before use.
  return JSON.stringify(value);
};

export function createFileVoiceBindingReferences(filePath: string): VoiceBindingReferences {
  function read(): VoiceBindingIndexSnapshot {
    try {
      const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid voice binding references");
      const raw = value as Record<string, unknown>;
      if (raw["version"] === 1) {
        const entries = raw["byScope"];
        if (!entries || typeof entries !== "object" || Array.isArray(entries) ||
            Object.values(entries).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id)) ||
            typeof raw["complete"] !== "boolean" ||
            (raw["ownerRevision"] !== null && typeof raw["ownerRevision"] !== "string") ||
            typeof raw["checksum"] !== "string")
          throw new Error("Invalid voice binding references");
        const body = { version: 1, complete: raw["complete"], ownerRevision: raw["ownerRevision"], byScope: entries };
        if (checksum(body) !== raw["checksum"]) throw new Error("Voice binding index checksum mismatch");
        return body as VoiceBindingIndexSnapshot;
      }
      // Pre-A10.2 indexes are hints only and have no completeness watermark.
      if (Object.values(raw).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id)))
        throw new Error("Invalid voice binding references");
      return { complete: false, ownerRevision: null, byScope: raw as Record<string, string[]> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { complete: false, ownerRevision: null, byScope: {} };
      throw error;
    }
  }
  function write(snapshot: VoiceBindingIndexSnapshot) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const body = { version: 1, complete: snapshot.complete, ownerRevision: snapshot.ownerRevision, byScope: snapshot.byScope };
    const temp = `${filePath}.${process.pid}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...body, checksum: checksum(body) })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, filePath);
    const directory = openSync(dirname(filePath), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  return {
    load: scope => read().byScope[scope] ?? [],
    append(scope, eventId) {
      const snapshot = read();
      write({ complete: false, ownerRevision: snapshot.ownerRevision,
        byScope: { ...snapshot.byScope, [scope]: [...new Set([...(snapshot.byScope[scope] ?? []), eventId])] } });
    },
    isCurrent(ownerRevision) {
      const snapshot = read();
      return snapshot.complete && snapshot.ownerRevision === ownerRevision;
    },
    rebuild(snapshot) {
      if (!snapshot.complete) throw new Error("Only complete native enumeration may rebuild voice references.");
      write(snapshot);
    }
  };
}
