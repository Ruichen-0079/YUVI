import { describe, expect, it } from "vitest";
import {
  createDefaultP8IdentityAddress,
  createP8CorrectionRecord,
  parseP8CorrectionRecord,
  serializeP8CorrectionRecord,
  type P8CorrectionRecord,
  type P8CorrectionTarget,
  type P8CorrectionStore,
  type P8ExplicitCorrection,
  type P8IdentityAddress
} from "@companion/p8";
import {
  PostgresP8CorrectionStore,
  type P8PostgresClient,
  type P8PostgresRow
} from "./p8-correction-store.js";

const ADDRESS = createDefaultP8IdentityAddress("subject-a");
const SCOPE = { reference: "scope-a" } as const;

function correction(
  overrides: {
    correctionReference?: string;
    address?: P8IdentityAddress;
    scopeReference?: { reference: string };
    action?: "REVISE" | "RETRACT";
    replacementMeaning?: string;
    interpretationReference?: string;
    provenanceReference?: string;
    suppliedAt?: string;
    supersedesCorrectionReference?: string;
    supersededEvidenceReferences?: readonly string[];
    target?: P8CorrectionTarget;
  } = {}
): P8ExplicitCorrection {
  const action = overrides.action ?? "REVISE";
  return {
    correctionReference: overrides.correctionReference ?? "correction-a",
    address: overrides.address ?? ADDRESS,
    scopeReference: overrides.scopeReference ?? SCOPE,
    target:
      overrides.target ??
      ({
        kind: "INTERPRETATION",
        interpretationReference: overrides.interpretationReference ?? "interpretation-a"
      } as const),
    action,
    ...(action === "REVISE"
      ? { replacementMeaning: overrides.replacementMeaning ?? "Meaning two." }
      : {}),
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: overrides.provenanceReference ?? "user-correction-a",
      ...(overrides.suppliedAt === undefined ? {} : { suppliedAt: overrides.suppliedAt })
    },
    ...(overrides.supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference: overrides.supersedesCorrectionReference }),
    ...(overrides.supersededEvidenceReferences === undefined
      ? {}
      : { supersededEvidenceReferences: overrides.supersededEvidenceReferences })
  };
}

function rowForRecord(
  record: P8CorrectionRecord,
  overrides: Record<string, unknown> = {}
): P8PostgresRow {
  const target = record.target;
  return {
    record_version: record.recordVersion,
    correction_reference: record.correctionReference,
    character_instance_id: record.address.characterInstanceId,
    persona_profile_id: record.address.personaProfileId,
    subject_scope_id: record.address.subjectScopeId ?? null,
    scope_reference: record.scopeReference.reference,
    target_kind: target.kind,
    interpretation_reference:
      target.kind === "INTERPRETATION" ? target.interpretationReference : null,
    invariant_target: target.kind === "AUTHORED_INVARIANT" ? target.invariantTarget : null,
    invariant_key: target.kind === "AUTHORED_INVARIANT" ? target.invariantKey : null,
    action: record.action,
    replacement_meaning: record.replacementMeaning ?? null,
    provenance_source: record.provenance.source,
    provenance_reference: record.provenance.reference,
    supplied_at: record.provenance.suppliedAt ?? null,
    supersedes_correction_reference: record.supersedesCorrectionReference ?? null,
    superseded_evidence_references: [...record.supersededEvidenceReferences],
    payload: serializeP8CorrectionRecord(record),
    ...overrides
  };
}

function clientFor(
  queryHandler: (text: string, values: unknown[]) => Promise<{ rows: readonly P8PostgresRow[] }>
): P8PostgresClient {
  return { query: queryHandler };
}

function inMemoryClient(): {
  client: P8PostgresClient;
  records: Map<string, P8CorrectionRecord>;
  queries: string[];
} {
  const records = new Map<string, P8CorrectionRecord>();
  const queries: string[] = [];
  return {
    records,
    queries,
    client: clientFor(async (text, values) => {
      queries.push(text);
      if (text.includes("insert into p8_corrections")) {
        const record = parseP8CorrectionRecord(values[17]);
        if (records.has(record.correctionReference)) {
          return { rows: [] };
        }
        if (record.supersedesCorrectionReference !== undefined) {
          const parent = records.get(record.supersedesCorrectionReference);
          if (
            parent === undefined ||
            parent.address.characterInstanceId !== record.address.characterInstanceId ||
            parent.address.personaProfileId !== record.address.personaProfileId ||
            parent.address.subjectScopeId !== record.address.subjectScopeId ||
            parent.scopeReference.reference !== record.scopeReference.reference ||
            JSON.stringify(parent.target) !== JSON.stringify(record.target)
          ) {
            return { rows: [] };
          }
        }
        records.set(record.correctionReference, record);
        return { rows: [{ correction_reference: record.correctionReference }] };
      }
      if (text.includes("select payload")) {
        const record = records.get(String(values[0]));
        return record === undefined ? { rows: [] } : { rows: [{ payload: record }] };
      }
      if (text.includes("from p8_corrections")) {
        const rows = [...records.values()]
          .filter(
            (record) =>
              record.address.characterInstanceId === values[0] &&
              record.address.personaProfileId === values[1] &&
              record.address.subjectScopeId === (values[2] === null ? undefined : values[2]) &&
              record.scopeReference.reference === values[3]
          )
          .map((record) => rowForRecord(record));
        return { rows };
      }
      throw new Error(`Unexpected P8 store query: ${text}`);
    })
  };
}

describe("PostgresP8CorrectionStore", () => {
  it("appends once, makes an identical retry idempotent, and rejects a payload conflict", async () => {
    const original = createP8CorrectionRecord(correction());
    let storedPayload: string | undefined;
    const client = clientFor(async (text, values) => {
      if (text.includes("insert into p8_corrections")) {
        if (storedPayload === undefined) {
          storedPayload = String(values[17]);
          return { rows: [{ correction_reference: original.correctionReference }] };
        }
        return { rows: [] };
      }
      if (text.includes("select payload")) {
        return { rows: [{ payload: storedPayload }] };
      }
      throw new Error(`Unexpected P8 store query: ${text}`);
    });
    const store = new PostgresP8CorrectionStore(client);

    await expect(store.appendCorrection(correction())).resolves.toMatchObject({ status: "STORED" });
    await expect(store.appendCorrection(correction())).resolves.toMatchObject({
      status: "ALREADY_STORED"
    });
    await expect(
      store.appendCorrection(correction({ replacementMeaning: "A different meaning." }))
    ).resolves.toEqual({ status: "CONFLICT" });
    expect(storedPayload).toBe(serializeP8CorrectionRecord(original));
  });

  it("validates append-only lineage atomically before storing a child", async () => {
    const state = inMemoryClient();
    const store = new PostgresP8CorrectionStore(state.client);

    await expect(
      store.appendCorrection(
        correction({
          correctionReference: "missing-child",
          supersedesCorrectionReference: "missing-parent"
        })
      )
    ).resolves.toEqual({ status: "ERROR" });
    expect(state.records.has("missing-child")).toBe(false);

    const parent = correction({ correctionReference: "lineage-parent" });
    await expect(store.appendCorrection(parent)).resolves.toMatchObject({ status: "STORED" });
    await expect(
      store.appendCorrection(
        correction({
          correctionReference: "lineage-child",
          supersedesCorrectionReference: parent.correctionReference
        })
      )
    ).resolves.toMatchObject({ status: "STORED" });

    const mismatchCases: Array<{
      name: string;
      parent: P8ExplicitCorrection;
      child: P8ExplicitCorrection;
    }> = [
      {
        name: "scope",
        parent: correction({
          correctionReference: "parent-other-scope",
          scopeReference: { reference: "scope-other" }
        }),
        child: correction({
          correctionReference: "child-other-scope",
          supersedesCorrectionReference: "parent-other-scope"
        })
      },
      {
        name: "character",
        parent: correction({
          correctionReference: "parent-other-character",
          address: { ...ADDRESS, characterInstanceId: "character-other" }
        }),
        child: correction({
          correctionReference: "child-other-character",
          supersedesCorrectionReference: "parent-other-character"
        })
      },
      {
        name: "persona",
        parent: correction({
          correctionReference: "parent-other-persona",
          address: { ...ADDRESS, personaProfileId: "persona-other" }
        }),
        child: correction({
          correctionReference: "child-other-persona",
          supersedesCorrectionReference: "parent-other-persona"
        })
      },
      {
        name: "interpretation target",
        parent: correction({
          correctionReference: "parent-other-interpretation",
          target: { kind: "INTERPRETATION", interpretationReference: "interpretation-other" }
        }),
        child: correction({
          correctionReference: "child-other-interpretation",
          supersedesCorrectionReference: "parent-other-interpretation"
        })
      },
      {
        name: "authored invariant target",
        parent: correction({
          correctionReference: "parent-invariant-a",
          target: { kind: "AUTHORED_INVARIANT", invariantTarget: "identity", invariantKey: "a" }
        }),
        child: correction({
          correctionReference: "child-invariant-b",
          target: { kind: "AUTHORED_INVARIANT", invariantTarget: "identity", invariantKey: "b" },
          supersedesCorrectionReference: "parent-invariant-a"
        })
      }
    ];

    for (const mismatch of mismatchCases) {
      await expect(store.appendCorrection(mismatch.parent)).resolves.toMatchObject({
        status: "STORED"
      });
      await expect(store.appendCorrection(mismatch.child)).resolves.toEqual({ status: "ERROR" });
      expect(state.records.has(mismatch.child.correctionReference)).toBe(false);
    }

    await expect(store.appendCorrection(parent)).resolves.toMatchObject({
      status: "ALREADY_STORED"
    });
    await expect(
      store.loadCorrections({ address: ADDRESS, scopeReference: SCOPE })
    ).resolves.toMatchObject({ status: "SUCCESS_WITH_CORRECTIONS" });
    expect(state.queries[0]).toContain("with candidate_parent as materialized");
    expect(state.queries[0]).toContain("where $16::text is null or exists");
  });

  it("loads only the exact address and scope and returns deterministic reference order", async () => {
    const first = createP8CorrectionRecord(
      correction({ correctionReference: "correction-a", suppliedAt: "2026-08-30T00:00:02Z" })
    );
    const second = createP8CorrectionRecord(
      correction({ correctionReference: "correction-b", suppliedAt: "2026-08-30T00:00:01Z" })
    );
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = clientFor(async (text, values) => {
      queries.push({ text, values });
      if (!text.includes("from p8_corrections")) {
        throw new Error(`Unexpected P8 store query: ${text}`);
      }
      const matchesExactAddress =
        values[0] === ADDRESS.characterInstanceId &&
        values[1] === ADDRESS.personaProfileId &&
        values[2] === ADDRESS.subjectScopeId &&
        values[3] === SCOPE.reference;
      return { rows: matchesExactAddress ? [rowForRecord(second), rowForRecord(first)] : [] };
    });
    const store = new PostgresP8CorrectionStore(client);

    const loaded = await store.loadCorrections({ address: ADDRESS, scopeReference: SCOPE });
    expect(loaded).toMatchObject({
      status: "SUCCESS_WITH_CORRECTIONS",
      corrections: [
        { correctionReference: "correction-a" },
        { correctionReference: "correction-b" }
      ]
    });
    expect(queries[0]?.text).toContain("subject_scope_id is not distinct from $3");
    expect(queries[0]?.text).toContain("order by correction_reference asc");
    expect(queries[0]?.values).toEqual([
      ADDRESS.characterInstanceId,
      ADDRESS.personaProfileId,
      ADDRESS.subjectScopeId,
      SCOPE.reference
    ]);

    const wrongScope = await store.loadCorrections({
      address: ADDRESS,
      scopeReference: { reference: "scope-other" }
    });
    const wrongCharacter = await store.loadCorrections({
      address: { ...ADDRESS, characterInstanceId: "character-other" },
      scopeReference: SCOPE
    });
    const wrongPersona = await store.loadCorrections({
      address: { ...ADDRESS, personaProfileId: "profile-other" },
      scopeReference: SCOPE
    });
    expect(wrongScope).toEqual({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] });
    expect(wrongCharacter).toEqual({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] });
    expect(wrongPersona).toEqual({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] });
  });

  it("round-trips RETRACT and preserves suppliedAt as provenance only", async () => {
    const record = createP8CorrectionRecord(
      correction({
        action: "RETRACT",
        suppliedAt: "2026-08-30T00:00:00Z",
        supersededEvidenceReferences: ["memory-a"]
      })
    );
    const client = clientFor(async () => ({ rows: [rowForRecord(record)] }));
    const store = new PostgresP8CorrectionStore(client);

    const loaded = await store.loadCorrections({ address: ADDRESS, scopeReference: SCOPE });
    expect(loaded).toEqual({
      status: "SUCCESS_WITH_CORRECTIONS",
      corrections: [
        expect.objectContaining({
          action: "RETRACT",
          provenance: expect.objectContaining({ suppliedAt: "2026-08-30T00:00:00Z" })
        })
      ]
    });
    expect(loaded).not.toHaveProperty("storedAt");
  });

  it("returns no-corrections, unavailable, and error states distinctly", async () => {
    const empty = new PostgresP8CorrectionStore(clientFor(async () => ({ rows: [] })));
    await expect(
      empty.loadCorrections({ address: ADDRESS, scopeReference: SCOPE })
    ).resolves.toEqual({
      status: "SUCCESS_WITH_NO_CORRECTIONS",
      corrections: []
    });

    const unavailable = new PostgresP8CorrectionStore(
      clientFor(async () => {
        throw Object.assign(new Error("database unavailable"), { code: "ECONNREFUSED" });
      })
    );
    await expect(
      unavailable.loadCorrections({ address: ADDRESS, scopeReference: SCOPE })
    ).resolves.toEqual({ status: "UNAVAILABLE" });

    const error = new PostgresP8CorrectionStore(
      clientFor(async () => {
        throw new Error("query failed");
      })
    );
    await expect(
      error.loadCorrections({ address: ADDRESS, scopeReference: SCOPE })
    ).resolves.toEqual({
      status: "ERROR"
    });
  });

  it("looks up a correction reference globally and validates the stored row", async () => {
    const record = createP8CorrectionRecord(
      correction({
        correctionReference: "global-reference",
        address: createDefaultP8IdentityAddress("other-person")
      })
    );
    const store = new PostgresP8CorrectionStore(
      clientFor(async (text) => {
        if (text.includes("where correction_reference = $1")) {
          return { rows: [rowForRecord(record)] };
        }
        if (text.includes("from p8_corrections")) return { rows: [rowForRecord(record)] };
        throw new Error(`Unexpected P8 store query: ${text}`);
      })
    );

    await expect(store.loadCorrectionByReference("global-reference")).resolves.toMatchObject({
      status: "SUCCESS_WITH_CORRECTION",
      correction: { correctionReference: "global-reference" }
    });
  });

  it("fails closed for unknown versions and malformed authoritative columns", async () => {
    const record = createP8CorrectionRecord(correction());
    const unknown = rowForRecord(record, {
      record_version: "p8-1e.v2",
      payload: JSON.stringify({ ...record, recordVersion: "p8-1e.v2" })
    });
    const malformedArray = rowForRecord(record, {
      superseded_evidence_references: ["different-memory-reference"]
    });
    const unknownResult = await new PostgresP8CorrectionStore(
      clientFor(async () => ({ rows: [unknown] }))
    ).loadCorrections({ address: ADDRESS, scopeReference: SCOPE });
    const malformedResult = await new PostgresP8CorrectionStore(
      clientFor(async () => ({ rows: [malformedArray] }))
    ).loadCorrections({ address: ADDRESS, scopeReference: SCOPE });

    expect(unknownResult).toEqual({ status: "ERROR" });
    expect(malformedResult).toEqual({ status: "ERROR" });
  });

  it("fails closed for incomplete, self, and cross-target durable lineage", async () => {
    const first = createP8CorrectionRecord(correction({ correctionReference: "correction-a" }));
    const missingTarget = createP8CorrectionRecord(
      correction({
        correctionReference: "correction-b",
        supersedesCorrectionReference: "missing-correction"
      })
    );
    const self = createP8CorrectionRecord(
      correction({
        correctionReference: "correction-self",
        supersedesCorrectionReference: "correction-self"
      })
    );
    const crossTarget = createP8CorrectionRecord(
      correction({
        correctionReference: "correction-cross",
        supersedesCorrectionReference: first.correctionReference,
        target: { kind: "INTERPRETATION", interpretationReference: "other-interpretation" }
      })
    );

    const load = async (records: readonly P8CorrectionRecord[]) =>
      new PostgresP8CorrectionStore(
        clientFor(async () => ({ rows: records.map((record) => rowForRecord(record)) }))
      ).loadCorrections({ address: ADDRESS, scopeReference: SCOPE });

    await expect(load([missingTarget])).resolves.toEqual({ status: "ERROR" });
    await expect(load([self])).resolves.toEqual({ status: "ERROR" });
    await expect(load([first, crossTarget])).resolves.toEqual({ status: "ERROR" });
  });

  it("exposes append/load only and never a semantic delete or update", () => {
    const store: P8CorrectionStore = new PostgresP8CorrectionStore(
      clientFor(async () => ({ rows: [] }))
    );
    expect("deleteCorrection" in store).toBe(false);
    expect("updateCorrection" in store).toBe(false);
  });
});
