import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  createDefaultP8IdentityAddress,
  createP8CorrectionRecord,
  type P8CorrectionTarget,
  type P8ExplicitCorrection,
  type P8IdentityAddress
} from "@companion/p8";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  reconstructP8Projection,
  type P8ReferencedInterpretationCandidate
} from "@companion/p8";
import { normalizePostgresConnectionString, runPostgresMigrations } from "@companion/memory";
import { PostgresP8CorrectionStore, type P8PostgresRow } from "./p8-correction-store.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const ADDRESS = createDefaultP8IdentityAddress("subject-p8-1e");
const SCOPE = { reference: "p8-1e-integration-scope" } as const;

function memoryEvent(): MemoryEvent {
  return {
    id: "p8-1e-memory-a",
    kind: "fact",
    content: "The original persisted meaning evidence.",
    source: "p8-1e-integration",
    sourceRecordId: "opaque-source-record",
    scope: SCOPE.reference,
    recordedAt: "2026-08-30T00:00:00.000Z",
    metadata: {},
    assertion: { source: "user", verification: "verified" }
  };
}

function retrieval(): MemoryRetrievalOutcome {
  return {
    status: "ok",
    events: [memoryEvent()],
    source: "p8-1e-integration",
    limited: false
  };
}

function referencedCandidate(): P8ReferencedInterpretationCandidate {
  return {
    interpretationReference: "p8-1e-interpretation-a",
    candidate: {
      domain: "BACKGROUND",
      meaning: "The original persisted meaning evidence.",
      evidenceLinks: [
        {
          evidenceReference: "p8-1e-memory-a",
          relation: "SUPPORTS",
          support: "DIRECT"
        }
      ]
    }
  };
}

function correction(
  overrides: {
    correctionReference?: string;
    address?: P8IdentityAddress;
    scopeReference?: { reference: string };
    action?: "REVISE" | "RETRACT";
    replacementMeaning?: string;
    supersedesCorrectionReference?: string;
    target?: P8CorrectionTarget;
  } = {}
): P8ExplicitCorrection {
  const action = overrides.action ?? "REVISE";
  return {
    correctionReference: overrides.correctionReference ?? "p8-1e-correction-a",
    address: overrides.address ?? ADDRESS,
    scopeReference: overrides.scopeReference ?? SCOPE,
    target:
      overrides.target ??
      ({
        kind: "INTERPRETATION",
        interpretationReference: "p8-1e-interpretation-a"
      } as const),
    action,
    ...(action === "REVISE"
      ? { replacementMeaning: overrides.replacementMeaning ?? "Persisted meaning two." }
      : {}),
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: "p8-1e-user-correction"
    },
    supersededEvidenceReferences: ["p8-1e-memory-a"],
    ...(overrides.supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference: overrides.supersedesCorrectionReference })
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function createPool(): Pool {
  return new Pool({
    connectionString: normalizePostgresConnectionString(DATABASE_URL!),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000
  });
}

describe("P8-1E PostgreSQL correction persistence", () => {
  it.skipIf(!DATABASE_URL)(
    "applies and reruns the migration, round-trips authority, isolates scope, and fails closed on malformed rows",
    async () => {
      const schema = `p8_1e_${randomUUID().replaceAll("-", "")}`;
      const migrationSql = await readFile(
        new URL("../../memory/migrations/011_p8_corrections_v1.sql", import.meta.url),
        "utf8"
      );
      const migration = { name: "011_p8_corrections_v1.sql", sql: migrationSql };
      const setupPool = createPool();
      try {
        await setupPool.query(`create schema ${quoteIdentifier(schema)}`);
        await expect(
          runPostgresMigrations({
            databaseUrl: DATABASE_URL!,
            migrations: [migration],
            settings: { search_path: `${quoteIdentifier(schema)}, public` }
          })
        ).resolves.toEqual([migration.name]);
        await expect(
          runPostgresMigrations({
            databaseUrl: DATABASE_URL!,
            migrations: [migration],
            settings: { search_path: `${quoteIdentifier(schema)}, public` }
          })
        ).resolves.toEqual([]); // Durable receipt prevents SQL from being reapplied.

        const client = await setupPool.connect();
        try {
          await client.query(`set search_path to ${quoteIdentifier(schema)}, public`);
          const store = new PostgresP8CorrectionStore({
            query: async (text, values) => {
              const result = await client.query(text, values);
              return { rows: result.rows as readonly P8PostgresRow[] };
            }
          });
          const first = correction();
          const second = correction({
            correctionReference: "p8-1e-correction-b",
            action: "RETRACT",
            supersedesCorrectionReference: first.correctionReference
          });

          await expect(store.appendCorrection(first)).resolves.toMatchObject({ status: "STORED" });
          await expect(store.appendCorrection(first)).resolves.toMatchObject({
            status: "ALREADY_STORED"
          });
          await expect(
            store.appendCorrection({ ...first, replacementMeaning: "Conflicting retry payload." })
          ).resolves.toEqual({ status: "CONFLICT" });
          const firstLoaded = await store.loadCorrections({
            address: ADDRESS,
            scopeReference: SCOPE
          });

          const processA = reconstructP8Projection({
            address: ADDRESS,
            authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
            expectedScopeReference: SCOPE,
            longTerm: retrieval(),
            referencedInterpretationCandidates: [referencedCandidate()],
            correctionStore: firstLoaded
          });
          const processBLoaded = await store.loadCorrections({
            address: ADDRESS,
            scopeReference: SCOPE
          });
          const processB = reconstructP8Projection({
            address: ADDRESS,
            authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
            expectedScopeReference: SCOPE,
            longTerm: retrieval(),
            referencedInterpretationCandidates: [referencedCandidate()],
            correctionStore: processBLoaded
          });
          expect(processA.status).toBe("RECONSTRUCTED");
          expect(processA).toEqual(processB);
          expect(processBLoaded).not.toBe(firstLoaded);
          if (processA.status !== "RECONSTRUCTED" || processB.status !== "RECONSTRUCTED") {
            throw new Error("P8 restart reconstruction did not produce a projection.");
          }
          expect(processA.projection.interpretations[0]).toMatchObject({
            meaning: "Persisted meaning two.",
            status: "KNOWN"
          });
          expect(processA.projection.targetableInterpretations?.[0]?.interpretation).not.toBe(
            processB.projection.targetableInterpretations?.[0]?.interpretation
          );

          await expect(store.appendCorrection(second)).resolves.toMatchObject({ status: "STORED" });
          const loaded = await store.loadCorrections({ address: ADDRESS, scopeReference: SCOPE });
          expect(loaded).toMatchObject({
            status: "SUCCESS_WITH_CORRECTIONS",
            corrections: [
              expect.objectContaining({ correctionReference: first.correctionReference }),
              expect.objectContaining({
                correctionReference: second.correctionReference,
                action: "RETRACT"
              })
            ]
          });
          expect(loaded).not.toHaveProperty("storedAt");

          const processAfterRetract = reconstructP8Projection({
            address: ADDRESS,
            authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
            expectedScopeReference: SCOPE,
            longTerm: retrieval(),
            referencedInterpretationCandidates: [referencedCandidate()],
            correctionStore: loaded
          });
          expect(processAfterRetract.status).toBe("RECONSTRUCTED");
          if (processAfterRetract.status !== "RECONSTRUCTED") {
            throw new Error("P8 lineage reconstruction did not produce a projection.");
          }
          expect(processAfterRetract.projection.interpretations[0]).toMatchObject({
            status: "UNKNOWN"
          });
          expect(processAfterRetract.projection.interpretations[0]).not.toHaveProperty("meaning");

          await expect(
            store.loadCorrections({
              address: ADDRESS,
              scopeReference: { reference: "other-scope" }
            })
          ).resolves.toEqual({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] });
          await expect(
            store.loadCorrections({
              address: { ...ADDRESS, characterInstanceId: "other-character" },
              scopeReference: SCOPE
            })
          ).resolves.toEqual({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] });
          await expect(
            store.loadCorrections({
              address: { ...ADDRESS, personaProfileId: "other-profile" },
              scopeReference: SCOPE
            })
          ).resolves.toEqual({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] });

          const malformed = createP8CorrectionRecord(
            correction({ correctionReference: "p8-1e-malformed-version" })
          );
          await client.query(
            `insert into p8_corrections (
               record_version, correction_reference,
               character_instance_id, persona_profile_id, subject_scope_id, scope_reference,
               target_kind, interpretation_reference, action,
               replacement_meaning, provenance_source, provenance_reference,
               superseded_evidence_references, payload
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
            [
              "p8-1e.v99",
              malformed.correctionReference,
              malformed.address.characterInstanceId,
              malformed.address.personaProfileId,
              malformed.address.subjectScopeId,
              malformed.scopeReference.reference,
              "INTERPRETATION",
              malformed.target.kind === "INTERPRETATION"
                ? malformed.target.interpretationReference
                : null,
              malformed.action,
              malformed.replacementMeaning,
              malformed.provenance.source,
              malformed.provenance.reference,
              malformed.supersededEvidenceReferences,
              JSON.stringify({ ...malformed, recordVersion: "p8-1e.v99" })
            ]
          );
          await expect(
            store.loadCorrections({ address: ADDRESS, scopeReference: SCOPE })
          ).resolves.toEqual({
            status: "ERROR"
          });

          const table = await client.query(
            `select table_schema, table_name
               from information_schema.tables
              where table_schema = $1
                and table_name = $2`,
            [schema, "p8_corrections"]
          );
          expect(table.rows).toEqual([{ table_schema: schema, table_name: "p8_corrections" }]);
          const index = await client.query(
            `select indexname from pg_indexes where schemaname = $1 and indexname = $2`,
            [schema, "p8_corrections_address_scope_idx"]
          );
          expect(index.rows).toHaveLength(1);
        } finally {
          client.release();
        }
      } finally {
        await setupPool.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
        await setupPool.end();
      }
    }
  );

  it.skipIf(!DATABASE_URL)(
    "rejects missing and mismatched lineage before insert without poisoning valid history",
    async () => {
      const schema = `p8_1e_lineage_${randomUUID().replaceAll("-", "")}`;
      const migrationSql = await readFile(
        new URL("../../memory/migrations/011_p8_corrections_v1.sql", import.meta.url),
        "utf8"
      );
      const setupPool = createPool();
      try {
        await setupPool.query(`create schema ${quoteIdentifier(schema)}`);
        await runPostgresMigrations({
          databaseUrl: DATABASE_URL!,
          migrations: [{ name: "011_p8_corrections_v1.sql", sql: migrationSql }],
          settings: { search_path: `${quoteIdentifier(schema)}, public` }
        });

        const client = await setupPool.connect();
        try {
          await client.query(`set search_path to ${quoteIdentifier(schema)}, public`);
          const store = new PostgresP8CorrectionStore({
            query: async (text, values) => {
              const result = await client.query(text, values);
              return { rows: result.rows as readonly P8PostgresRow[] };
            }
          });
          const rowCount = async (correctionReference: string) => {
            const result = await client.query(
              `select correction_reference
                 from p8_corrections
                where correction_reference = $1`,
              [correctionReference]
            );
            return result.rows.length;
          };

          const missingChild = correction({
            correctionReference: "p8-1e-missing-child",
            supersedesCorrectionReference: "p8-1e-missing-parent"
          });
          await expect(store.appendCorrection(missingChild)).resolves.toEqual({ status: "ERROR" });
          expect(await rowCount(missingChild.correctionReference)).toBe(0);

          const parent = correction({ correctionReference: "p8-1e-lineage-parent" });
          const child = correction({
            correctionReference: "p8-1e-lineage-child",
            supersedesCorrectionReference: parent.correctionReference
          });
          await expect(store.appendCorrection(parent)).resolves.toMatchObject({ status: "STORED" });
          await expect(store.appendCorrection(child)).resolves.toMatchObject({ status: "STORED" });

          const mismatchCases: Array<{
            parent: P8ExplicitCorrection;
            child: P8ExplicitCorrection;
          }> = [
            {
              parent: correction({
                correctionReference: "p8-1e-parent-other-scope",
                scopeReference: { reference: "p8-1e-other-scope" }
              }),
              child: correction({
                correctionReference: "p8-1e-child-other-scope",
                supersedesCorrectionReference: "p8-1e-parent-other-scope"
              })
            },
            {
              parent: correction({
                correctionReference: "p8-1e-parent-other-character",
                address: { ...ADDRESS, characterInstanceId: "p8-1e-other-character" }
              }),
              child: correction({
                correctionReference: "p8-1e-child-other-character",
                supersedesCorrectionReference: "p8-1e-parent-other-character"
              })
            },
            {
              parent: correction({
                correctionReference: "p8-1e-parent-other-persona",
                address: { ...ADDRESS, personaProfileId: "p8-1e-other-persona" }
              }),
              child: correction({
                correctionReference: "p8-1e-child-other-persona",
                supersedesCorrectionReference: "p8-1e-parent-other-persona"
              })
            },
            {
              parent: correction({
                correctionReference: "p8-1e-parent-other-target",
                target: { kind: "INTERPRETATION", interpretationReference: "p8-1e-other-target" }
              }),
              child: correction({
                correctionReference: "p8-1e-child-other-target",
                supersedesCorrectionReference: "p8-1e-parent-other-target"
              })
            },
            {
              parent: correction({
                correctionReference: "p8-1e-parent-invariant-a",
                target: {
                  kind: "AUTHORED_INVARIANT",
                  invariantTarget: "identity",
                  invariantKey: "invariant-a"
                }
              }),
              child: correction({
                correctionReference: "p8-1e-child-invariant-b",
                target: {
                  kind: "AUTHORED_INVARIANT",
                  invariantTarget: "identity",
                  invariantKey: "invariant-b"
                },
                supersedesCorrectionReference: "p8-1e-parent-invariant-a"
              })
            }
          ];

          for (const mismatch of mismatchCases) {
            await expect(store.appendCorrection(mismatch.parent)).resolves.toMatchObject({
              status: "STORED"
            });
            await expect(store.appendCorrection(mismatch.child)).resolves.toEqual({
              status: "ERROR"
            });
            expect(await rowCount(mismatch.child.correctionReference)).toBe(0);
          }

          await expect(
            store.loadCorrections({ address: ADDRESS, scopeReference: SCOPE })
          ).resolves.toMatchObject({
            status: "SUCCESS_WITH_CORRECTIONS",
            corrections: expect.arrayContaining([
              expect.objectContaining({ correctionReference: parent.correctionReference }),
              expect.objectContaining({ correctionReference: child.correctionReference })
            ])
          });
        } finally {
          client.release();
        }
      } finally {
        await setupPool.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
        await setupPool.end();
      }
    }
  );
});
