import {
  createP8CorrectionRecord,
  correctionFromP8CorrectionRecord,
  normalizeP8CorrectionLookup,
  parseP8CorrectionRecord,
  serializeP8CorrectionRecord,
  validateP8CorrectionRecordLineage,
  type P8CorrectionLookup,
  type P8CorrectionReferenceLoadResult,
  type P8CorrectionRecord,
  type P8CorrectionStore,
  type P8CorrectionStoreLoadResult,
  type P8CorrectionStoreWriteResult,
  type P8ExplicitCorrection
} from "@companion/p8";

export type P8PostgresRow = Readonly<Record<string, unknown>>;

export type P8PostgresClient = Readonly<{
  query(text: string, values?: unknown[]): Promise<{ rows: readonly P8PostgresRow[] }>;
}>;

/** PostgreSQL storage adapter for the pure P8-1E correction-store contract. */
export class PostgresP8CorrectionStore implements P8CorrectionStore {
  constructor(private readonly client: P8PostgresClient) {}

  async appendCorrection(correction: P8ExplicitCorrection): Promise<P8CorrectionStoreWriteResult> {
    const record = createP8CorrectionRecord(correction);

    try {
      const inserted = await this.client.query(
        `with candidate_parent as materialized (
           select 1
             from p8_corrections as parent
            where parent.correction_reference = $16
              and parent.record_version = $1
              and parent.character_instance_id = $3
              and parent.persona_profile_id = $4
              and parent.subject_scope_id is not distinct from $5
              and parent.scope_reference = $6
              and parent.target_kind = $7
              and parent.interpretation_reference is not distinct from $8
              and parent.invariant_target is not distinct from $9
              and parent.invariant_key is not distinct from $10
              and parent.payload = jsonb_strip_nulls(jsonb_build_object(
                'recordVersion', parent.record_version,
                'correctionReference', parent.correction_reference,
                'address', jsonb_strip_nulls(jsonb_build_object(
                  'characterInstanceId', parent.character_instance_id,
                  'personaProfileId', parent.persona_profile_id,
                  'subjectScopeId', parent.subject_scope_id
                )),
                'scopeReference', jsonb_build_object('reference', parent.scope_reference),
                'target', jsonb_strip_nulls(jsonb_build_object(
                  'kind', parent.target_kind,
                  'interpretationReference', parent.interpretation_reference,
                  'invariantTarget', parent.invariant_target,
                  'invariantKey', parent.invariant_key
                )),
                'action', parent.action,
                'replacementMeaning', parent.replacement_meaning,
                'provenance', jsonb_strip_nulls(jsonb_build_object(
                  'source', parent.provenance_source,
                  'reference', parent.provenance_reference,
                  'suppliedAt', parent.supplied_at
                )),
                'supersededEvidenceReferences', to_jsonb(parent.superseded_evidence_references),
                'supersedesCorrectionReference', parent.supersedes_correction_reference
              ))
         )
         insert into p8_corrections (
           record_version, correction_reference,
           character_instance_id, persona_profile_id, subject_scope_id, scope_reference,
           target_kind, interpretation_reference, invariant_target, invariant_key,
           action, replacement_meaning,
           provenance_source, provenance_reference, supplied_at,
           supersedes_correction_reference, superseded_evidence_references, payload
         )
         select
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18::jsonb
          where $16::text is null or exists (select 1 from candidate_parent)
         on conflict (correction_reference) do nothing
         returning correction_reference`,
        recordValues(record)
      );
      if (inserted.rows.length > 0) {
        return Object.freeze({ status: "STORED" as const, record });
      }

      const existing = await this.client.query(
        `select payload
           from p8_corrections
          where correction_reference = $1`,
        [record.correctionReference]
      );
      const existingPayload = existing.rows[0]?.["payload"];
      if (existing.rows.length !== 1 || existingPayload === undefined) {
        return Object.freeze({ status: "ERROR" as const });
      }
      const existingRecord = parseP8CorrectionRecord(existingPayload);
      return Object.freeze(
        serializeP8CorrectionRecord(existingRecord) === serializeP8CorrectionRecord(record)
          ? { status: "ALREADY_STORED" as const, record: existingRecord }
          : { status: "CONFLICT" as const }
      );
    } catch (error) {
      return Object.freeze({ status: classifyPostgresFailure(error) });
    }
  }

  async loadCorrections(input: P8CorrectionLookup): Promise<P8CorrectionStoreLoadResult> {
    const lookup = normalizeP8CorrectionLookup(input);

    try {
      const result = await this.client.query(
        `select
           record_version, correction_reference,
           character_instance_id, persona_profile_id, subject_scope_id, scope_reference,
           target_kind, interpretation_reference, invariant_target, invariant_key,
           action, replacement_meaning,
           provenance_source, provenance_reference, supplied_at,
           supersedes_correction_reference, superseded_evidence_references, payload
         from p8_corrections
         where character_instance_id = $1
           and persona_profile_id = $2
           and subject_scope_id is not distinct from $3
           and scope_reference = $4
         order by correction_reference asc`,
        [
          lookup.address.characterInstanceId,
          lookup.address.personaProfileId,
          lookup.address.subjectScopeId ?? null,
          lookup.scopeReference.reference
        ]
      );
      const records = result.rows.map((row) => parseStoredRow(row, lookup));
      validateP8CorrectionRecordLineage(records);
      const corrections = records
        .sort((left, right) => compareText(left.correctionReference, right.correctionReference))
        .map(correctionFromP8CorrectionRecord);
      return Object.freeze({
        status: corrections.length > 0 ? "SUCCESS_WITH_CORRECTIONS" : "SUCCESS_WITH_NO_CORRECTIONS",
        corrections: Object.freeze(corrections)
      });
    } catch (error) {
      return Object.freeze({ status: classifyPostgresFailure(error) });
    }
  }

  async loadCorrectionByReference(
    correctionReference: string
  ): Promise<P8CorrectionReferenceLoadResult> {
    if (
      typeof correctionReference !== "string" ||
      correctionReference.length === 0 ||
      correctionReference.length > 160
    )
      return { status: "ERROR" };
    try {
      const result = await this.client.query(
        `select
           record_version, correction_reference,
           character_instance_id, persona_profile_id, subject_scope_id, scope_reference,
           target_kind, interpretation_reference, invariant_target, invariant_key,
           action, replacement_meaning,
           provenance_source, provenance_reference, supplied_at,
           supersedes_correction_reference, superseded_evidence_references, payload
         from p8_corrections
         where correction_reference = $1`,
        [correctionReference]
      );
      if (result.rows.length === 0) return { status: "SUCCESS_WITH_NO_CORRECTION" };
      if (result.rows.length !== 1) return { status: "ERROR" };
      const row = result.rows[0]!;
      const payload = parseP8CorrectionRecord(row["payload"]);
      const lookup: P8CorrectionLookup = {
        address: payload.address,
        scopeReference: payload.scopeReference
      };
      const record = parseStoredRow(row, lookup);
      const scopeRows = await this.client.query(
        `select
           record_version, correction_reference,
           character_instance_id, persona_profile_id, subject_scope_id, scope_reference,
           target_kind, interpretation_reference, invariant_target, invariant_key,
           action, replacement_meaning,
           provenance_source, provenance_reference, supplied_at,
           supersedes_correction_reference, superseded_evidence_references, payload
         from p8_corrections
         where character_instance_id = $1
           and persona_profile_id = $2
           and subject_scope_id is not distinct from $3
           and scope_reference = $4
         order by correction_reference asc`,
        [
          lookup.address.characterInstanceId,
          lookup.address.personaProfileId,
          lookup.address.subjectScopeId ?? null,
          lookup.scopeReference.reference
        ]
      );
      const scopeRecords = scopeRows.rows.map((scopeRow) => parseStoredRow(scopeRow, lookup));
      validateP8CorrectionRecordLineage(scopeRecords);
      return {
        status: "SUCCESS_WITH_CORRECTION",
        correction: correctionFromP8CorrectionRecord(record)
      };
    } catch (error) {
      return { status: classifyPostgresFailure(error) };
    }
  }
}

function recordValues(record: P8CorrectionRecord): unknown[] {
  const target = record.target;
  return [
    record.recordVersion,
    record.correctionReference,
    record.address.characterInstanceId,
    record.address.personaProfileId,
    record.address.subjectScopeId ?? null,
    record.scopeReference.reference,
    target.kind,
    target.kind === "INTERPRETATION" ? target.interpretationReference : null,
    target.kind === "AUTHORED_INVARIANT" ? target.invariantTarget : null,
    target.kind === "AUTHORED_INVARIANT" ? target.invariantKey : null,
    record.action,
    record.replacementMeaning ?? null,
    record.provenance.source,
    record.provenance.reference,
    record.provenance.suppliedAt ?? null,
    record.supersedesCorrectionReference ?? null,
    record.supersededEvidenceReferences,
    serializeP8CorrectionRecord(record)
  ];
}

function parseStoredRow(row: P8PostgresRow, lookup: P8CorrectionLookup): P8CorrectionRecord {
  const record = parseP8CorrectionRecord(row["payload"]);
  if (
    row["record_version"] !== record.recordVersion ||
    row["correction_reference"] !== record.correctionReference ||
    row["character_instance_id"] !== record.address.characterInstanceId ||
    row["persona_profile_id"] !== record.address.personaProfileId ||
    nullableString(row["subject_scope_id"], "subject_scope_id") !== record.address.subjectScopeId ||
    row["scope_reference"] !== record.scopeReference.reference ||
    row["target_kind"] !== record.target.kind ||
    row["action"] !== record.action ||
    nullableString(row["replacement_meaning"], "replacement_meaning") !==
      (record.replacementMeaning ?? undefined) ||
    row["provenance_source"] !== record.provenance.source ||
    row["provenance_reference"] !== record.provenance.reference ||
    nullableString(row["supplied_at"], "supplied_at") !==
      (record.provenance.suppliedAt ?? undefined) ||
    nullableString(row["supersedes_correction_reference"], "supersedes_correction_reference") !==
      (record.supersedesCorrectionReference ?? undefined)
  ) {
    throw new Error("P8 stored correction columns do not match their canonical payload.");
  }
  assertReferenceArray(row["superseded_evidence_references"], record.supersededEvidenceReferences);

  if (
    record.address.characterInstanceId !== lookup.address.characterInstanceId ||
    record.address.personaProfileId !== lookup.address.personaProfileId ||
    record.address.subjectScopeId !== lookup.address.subjectScopeId ||
    record.scopeReference.reference !== lookup.scopeReference.reference
  ) {
    throw new Error("P8 stored correction escaped its exact address or scope.");
  }

  const target = record.target;
  if (target.kind === "INTERPRETATION") {
    if (
      row["interpretation_reference"] !== target.interpretationReference ||
      row["invariant_target"] !== null ||
      row["invariant_key"] !== null
    ) {
      throw new Error("P8 stored interpretation target columns are malformed.");
    }
  } else if (
    row["interpretation_reference"] !== null ||
    row["invariant_target"] !== target.invariantTarget ||
    row["invariant_key"] !== target.invariantKey
  ) {
    throw new Error("P8 stored authored-invariant target columns are malformed.");
  }

  return record;
}

function assertReferenceArray(value: unknown, expected: readonly string[]): void {
  if (!Array.isArray(value)) {
    throw new Error("P8 stored superseded evidence references must be a text array.");
  }
  if (value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new Error(
      "P8 stored superseded evidence references do not match their canonical payload."
    );
  }
}

function nullableString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`P8 stored ${field} must be text or null.`);
  }
  return value;
}

function classifyPostgresFailure(error: unknown): "UNAVAILABLE" | "ERROR" {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (
    typeof code === "string" &&
    new Set([
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "08000",
      "08001",
      "08003",
      "08004",
      "08006",
      "08007",
      "57P01",
      "57P02",
      "57P03",
      "53300"
    ]).has(code)
  ) {
    return "UNAVAILABLE";
  }
  return "ERROR";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
