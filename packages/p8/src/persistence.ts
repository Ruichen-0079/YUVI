import type { P8IdentityAddress } from "./index.js";
import {
  P8_CORRECTION_ACTIONS,
  canonicalizeP8ExplicitCorrection,
  type P8CorrectionAction,
  type P8CorrectionTarget,
  type P8ExplicitCorrection
} from "./correction.js";
import type { P8EvidenceScopeReference } from "./evidence.js";

/** Durable correction and reconstruction contract introduced by P8-1E. */
export const P8_1E_VERSION = "p8-1e.v1" as const;

export const P8_CORRECTION_STORE_ACCESS_STATUSES = [
  "SUCCESS_WITH_CORRECTIONS",
  "SUCCESS_WITH_NO_CORRECTIONS",
  "UNAVAILABLE",
  "ERROR"
] as const;
export type P8CorrectionStoreAccessStatus = (typeof P8_CORRECTION_STORE_ACCESS_STATUSES)[number];

export type P8CorrectionRecord = Readonly<{
  recordVersion: typeof P8_1E_VERSION;
  correctionReference: string;
  address: P8IdentityAddress;
  scopeReference: P8EvidenceScopeReference;
  target: P8CorrectionTarget;
  action: P8CorrectionAction;
  replacementMeaning?: string;
  provenance: P8PersistedCorrectionProvenance;
  supersededEvidenceReferences: readonly string[];
  supersedesCorrectionReference?: string;
}>;

export type P8PersistedCorrectionProvenance = Readonly<{
  source: "EXPLICIT_USER_CORRECTION";
  reference: string;
  suppliedAt?: string;
}>;

export type P8CorrectionLookup = Readonly<{
  address: P8IdentityAddress;
  scopeReference: P8EvidenceScopeReference;
}>;

export type P8CorrectionStoreLoadResult = Readonly<
  | {
      status: "SUCCESS_WITH_CORRECTIONS";
      corrections: readonly P8ExplicitCorrection[];
    }
  | {
      status: "SUCCESS_WITH_NO_CORRECTIONS";
      corrections: readonly P8ExplicitCorrection[];
    }
  | { status: "UNAVAILABLE" }
  | { status: "ERROR" }
>;

export type P8CorrectionReferenceLoadResult = Readonly<
  | { status: "SUCCESS_WITH_CORRECTION"; correction: P8ExplicitCorrection }
  | { status: "SUCCESS_WITH_NO_CORRECTION" }
  | { status: "UNAVAILABLE" }
  | { status: "ERROR" }
>;

export type P8CorrectionStoreWriteResult = Readonly<
  | { status: "STORED"; record: P8CorrectionRecord }
  | { status: "ALREADY_STORED"; record: P8CorrectionRecord }
  | { status: "CONFLICT" }
  | { status: "UNAVAILABLE" }
  | { status: "ERROR" }
>;

/** P8 persistence exposes append/load only; historical corrections are never deleted. */
export interface P8CorrectionStore {
  appendCorrection(correction: P8ExplicitCorrection): Promise<P8CorrectionStoreWriteResult>;
  loadCorrections(input: P8CorrectionLookup): Promise<P8CorrectionStoreLoadResult>;
  /** Read-only global lookup for the stable domain correction reference. */
  loadCorrectionByReference(correctionReference: string): Promise<P8CorrectionReferenceLoadResult>;
}

export function createP8CorrectionRecord(correction: P8ExplicitCorrection): P8CorrectionRecord {
  const canonical = canonicalizeP8ExplicitCorrection(correction);
  return Object.freeze({
    recordVersion: P8_1E_VERSION,
    correctionReference: canonical.correctionReference,
    address: canonical.address,
    scopeReference: canonical.scopeReference,
    target: canonical.target,
    action: canonical.action,
    ...(canonical.replacementMeaning === undefined
      ? {}
      : { replacementMeaning: canonical.replacementMeaning }),
    provenance: Object.freeze({
      source: "EXPLICIT_USER_CORRECTION" as const,
      reference: canonical.provenance.reference,
      ...(canonical.provenance.suppliedAt === undefined
        ? {}
        : { suppliedAt: canonical.provenance.suppliedAt })
    }),
    supersededEvidenceReferences: Object.freeze([
      ...(canonical.supersededEvidenceReferences ?? [])
    ]),
    ...(canonical.supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference: canonical.supersedesCorrectionReference })
  });
}

export function correctionFromP8CorrectionRecord(record: P8CorrectionRecord): P8ExplicitCorrection {
  if (record.recordVersion !== P8_1E_VERSION) {
    throw new Error(`Unknown P8 correction record version: ${String(record.recordVersion)}.`);
  }
  return canonicalizeP8ExplicitCorrection({
    correctionReference: record.correctionReference,
    address: record.address,
    scopeReference: record.scopeReference,
    target: record.target,
    action: record.action,
    ...(record.replacementMeaning === undefined
      ? {}
      : { replacementMeaning: record.replacementMeaning }),
    provenance: record.provenance,
    supersededEvidenceReferences: record.supersededEvidenceReferences,
    ...(record.supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference: record.supersedesCorrectionReference })
  });
}

/**
 * Validates the durable correction lineage loaded for one exact address and
 * scope. Target existence in the current projection is checked later by
 * P8-1D, but durable lineage itself must never be incomplete or cyclic.
 */
export function validateP8CorrectionRecordLineage(records: readonly P8CorrectionRecord[]): void {
  const byReference = new Map<string, P8CorrectionRecord>();
  for (const record of records) {
    if (byReference.has(record.correctionReference)) {
      throw new Error(
        `P8 correction record reference is duplicated: ${record.correctionReference}.`
      );
    }
    byReference.set(record.correctionReference, record);
  }

  for (const record of records) {
    const supersededReference = record.supersedesCorrectionReference;
    if (supersededReference === undefined) {
      continue;
    }
    const superseded = byReference.get(supersededReference);
    if (superseded === undefined) {
      throw new Error(
        `P8 correction record lineage references unavailable correction: ${supersededReference}.`
      );
    }
    if (correctionRecordTargetKey(record) !== correctionRecordTargetKey(superseded)) {
      throw new Error("P8 correction record lineage must target the same semantic target.");
    }
  }

  for (const record of records) {
    const visited = new Set<string>();
    let current: P8CorrectionRecord | undefined = record;
    while (current?.supersedesCorrectionReference !== undefined) {
      if (visited.has(current.correctionReference)) {
        throw new Error("P8 correction record lineage cannot contain a cycle.");
      }
      visited.add(current.correctionReference);
      current = byReference.get(current.supersedesCorrectionReference);
    }
  }
}

/** Stable JSON used for idempotent write comparison; operational metadata is excluded. */
export function serializeP8CorrectionRecord(record: P8CorrectionRecord): string {
  return JSON.stringify(record);
}

export function parseP8CorrectionRecord(input: unknown): P8CorrectionRecord {
  const value = parseJsonValue(input);
  const record = requireRecord(value, "P8 correction record");
  assertAllowedKeys(
    record,
    [
      "recordVersion",
      "correctionReference",
      "address",
      "scopeReference",
      "target",
      "action",
      "replacementMeaning",
      "provenance",
      "supersededEvidenceReferences",
      "supersedesCorrectionReference"
    ],
    "P8 correction record"
  );

  if (record["recordVersion"] !== P8_1E_VERSION) {
    throw new Error(`Unknown P8 correction record version: ${String(record["recordVersion"])}.`);
  }

  const address = parseAddress(record["address"]);
  const scopeReference = parseScopeReference(record["scopeReference"]);
  const target = parseTarget(record["target"]);
  const provenance = parseProvenance(record["provenance"]);
  const action = requireString(
    record["action"],
    "P8 correction record action"
  ) as P8CorrectionAction;
  if (!P8_CORRECTION_ACTIONS.includes(action)) {
    throw new Error(`Unknown P8 correction record action: ${action}.`);
  }

  return createP8CorrectionRecord({
    correctionReference: requireString(
      record["correctionReference"],
      "P8 correction record correctionReference"
    ),
    address,
    scopeReference,
    target,
    action,
    ...(record["replacementMeaning"] === undefined
      ? {}
      : {
          replacementMeaning: requireString(record["replacementMeaning"], "P8 replacementMeaning")
        }),
    provenance,
    supersededEvidenceReferences: parseStringArray(
      record["supersededEvidenceReferences"],
      "P8 supersededEvidenceReferences"
    ),
    ...(record["supersedesCorrectionReference"] === undefined
      ? {}
      : {
          supersedesCorrectionReference: requireString(
            record["supersedesCorrectionReference"],
            "P8 supersedesCorrectionReference"
          )
        })
  });
}

export function normalizeP8CorrectionLookup(input: P8CorrectionLookup): P8CorrectionLookup {
  const address = parseAddress(input.address);
  const scopeReference = parseScopeReference(input.scopeReference);
  return Object.freeze({ address, scopeReference });
}

function parseJsonValue(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error("P8 correction record payload is not valid JSON.");
  }
}

function parseAddress(input: unknown): P8IdentityAddress {
  const address = requireRecord(input, "P8 correction address");
  assertAllowedKeys(
    address,
    ["characterInstanceId", "personaProfileId", "subjectScopeId"],
    "P8 address"
  );
  const subjectScopeId = optionalString(address["subjectScopeId"], "P8 address subjectScopeId");
  return Object.freeze({
    characterInstanceId: requireBoundedString(
      address["characterInstanceId"],
      "P8 address characterInstanceId",
      160
    ),
    personaProfileId: requireBoundedString(
      address["personaProfileId"],
      "P8 address personaProfileId",
      160
    ),
    ...(subjectScopeId === undefined ? {} : { subjectScopeId })
  });
}

function parseScopeReference(input: unknown): P8EvidenceScopeReference {
  const scope = requireRecord(input, "P8 correction scope reference");
  assertAllowedKeys(scope, ["reference"], "P8 scope reference");
  return Object.freeze({
    reference: requireBoundedString(scope["reference"], "P8 scope reference", 160)
  });
}

function parseTarget(input: unknown): P8CorrectionTarget {
  const target = requireRecord(input, "P8 correction target");
  if (target["kind"] === "INTERPRETATION") {
    assertAllowedKeys(target, ["kind", "interpretationReference"], "P8 interpretation target");
    return {
      kind: "INTERPRETATION",
      interpretationReference: requireBoundedString(
        target["interpretationReference"],
        "P8 interpretationReference",
        160
      )
    };
  }
  if (target["kind"] !== "AUTHORED_INVARIANT") {
    throw new Error("Unknown P8 correction target kind.");
  }
  assertAllowedKeys(target, ["kind", "invariantTarget", "invariantKey"], "P8 invariant target");
  if (target["invariantTarget"] !== "identity" && target["invariantTarget"] !== "persona") {
    throw new Error("Unknown P8 authored invariant target.");
  }
  return {
    kind: "AUTHORED_INVARIANT",
    invariantTarget: target["invariantTarget"],
    invariantKey: requireBoundedString(target["invariantKey"], "P8 invariantKey", 160)
  };
}

function parseProvenance(input: unknown): P8PersistedCorrectionProvenance {
  const provenance = requireRecord(input, "P8 correction provenance");
  assertAllowedKeys(provenance, ["source", "reference", "suppliedAt"], "P8 provenance");
  if (provenance["source"] !== "EXPLICIT_USER_CORRECTION") {
    throw new Error("P8 persisted correction does not have explicit user authority.");
  }
  const suppliedAt = optionalString(provenance["suppliedAt"], "P8 provenance suppliedAt");
  return {
    source: "EXPLICIT_USER_CORRECTION",
    reference: requireBoundedString(provenance["reference"], "P8 provenance reference", 160),
    ...(suppliedAt === undefined ? {} : { suppliedAt })
  };
}

function parseStringArray(input: unknown, field: string): readonly string[] {
  if (!Array.isArray(input)) {
    throw new Error(`${field} must be an array.`);
  }
  return input.map((value) => requireBoundedString(value, field, 160));
}

function requireRecord(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function requireString(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return input;
}

function requireBoundedString(input: unknown, field: string, maximum: number): string {
  const value = requireString(input, field);
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function optionalString(input: unknown, field: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  return requireString(input, field);
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${field} contains an unknown field: ${key}.`);
    }
  }
}

function correctionRecordTargetKey(record: P8CorrectionRecord): string {
  return record.target.kind === "INTERPRETATION"
    ? [record.target.kind, record.target.interpretationReference].join("\u0000")
    : [record.target.kind, record.target.invariantTarget, record.target.invariantKey].join(
        "\u0000"
      );
}
