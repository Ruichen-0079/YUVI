import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import type { ContextManifest, ContextExposure, ContextSourceUse } from "@companion/protocol";
import { readSqlMigrations } from "./index.js";
import { PostgresProfileSnapshotStore } from "./profile-snapshot-store.js";
import { materializeProfileSnapshot, rootsForLineage } from "./profile-materializer.js";
import { MemoryLineageV1Schema, type GroundedMemoryLineageV1 } from "./lineage.js";
import { ProfileEvidenceSourceV1Schema } from "./profile-types.js";
import { canonicalLineageJson, lineageDigest } from "./lineage-encoding.js";
import { buildMemoryScope } from "./scope.js";
import {
  PostgresContextUseRepository,
  contextUseDigest,
  contextManifestId,
  contextExposureId,
  ContextUseConflict
} from "./context-use-repository.js";
const url = process.env["YUVI_EFFECT_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const schema = `a103_${randomBytes(6).toString("hex")}`;
let admin: PostgresPool,
  pool: PostgresPool,
  repo: PostgresContextUseRepository,
  index = 0;
function source(owner: ContextSourceUse["owner"] = "MEMORY", revision = "old"): ContextSourceUse {
  return {
    owner,
    reference: `${owner}:source`,
    revision,
    digest: contextUseDigest(revision),
    availability: "AVAILABLE",
    revisionKind: "NATIVE",
    selection: "SELECTED",
    reason: "captured owner revision",
    roots: ["journal:retained-parent:selector-v1"]
  };
}
function manifest(sources = [source()]): ContextManifest {
  return {
    version: "context-use-manifest.v1",
    namespace: "isolated-installation",
    executionId: `execution-${++index}`,
    assemblyOrdinal: "1",
    scope: "private-test-scope",
    assemblyVersion: "canonical-context.v1",
    selectionVersion: "selection.v1",
    enumeration: "TOP_K",
    sources,
    blocks: [
      {
        key: "MEMORY_EVIDENCE",
        digest: contextUseDigest("selected-old"),
        characters: 12,
        sourceReferences: [sources[0]!.reference],
        stability: "VOLATILE"
      }
    ],
    stable: { version: "canonical-context-stability.v1", digest: contextUseDigest("stable-v1") },
    volatile: { version: "volatile.v1", digest: contextUseDigest("volatile-v1") }
  };
}
function exposure(m: ContextManifest): ContextExposure {
  return {
    version: "context-exposure.v1",
    boundary: "PREPARED_FOR_USE",
    manifestId: contextManifestId(m),
    consumerOperationSlot: "chat:initial",
    exposureOrdinal: "1",
    projectionVersion: "chat-projection.v1",
    inputDigest: contextUseDigest("actual bounded input"),
    fields: [
      {
        path: "input.messages.0.content",
        digest: contextUseDigest("actual bounded input"),
        characters: 20,
        availability: "NOT_RETAINED"
      }
    ],
    blocks: [
      {
        key: "MEMORY_EVIDENCE",
        state: "TRUNCATED",
        digest: contextUseDigest("selected"),
        characters: 8,
        field: "input.messages.0.content",
        offset: 0,
        sourceReferences: [m.sources[0]!.reference]
      }
    ]
  };
}
describe.skipIf(!url)("A10.3 immutable historical use PostgreSQL", () => {
  beforeAll(async () => {
    admin = createPostgresPool(url!);
    await admin.query(`create schema "${schema}"`);
    pool = createPostgresPool(url!, { options: `-c search_path=${schema},public` });
    for (const migration of await readSqlMigrations()) await pool.query(migration.sql);
    repo = new PostgresContextUseRepository(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop schema "${schema}" cascade`);
    await admin?.end();
  });
  it("migration replay preserves the historical store", async () => {
    const m = manifest();
    await repo.admit(m);
    const migration = (await readSqlMigrations()).find(
      (m) => m.name === "024_context_use_manifests_v1.sql"
    )!;
    await pool.query(migration.sql);
    expect((await repo.get(contextManifestId(m)))?.manifest).toEqual(m);
  });
  it("commits base and exact exposure together, without payload bytes", async () => {
    const m = manifest(),
      e = exposure(m);
    const ids = await repo.admit(m, e);
    const read = await repo.get(ids.manifestId);
    expect(read).toEqual({ manifest: m, exposures: [e] });
    expect(JSON.stringify(read)).not.toContain("actual bounded input");
  });
  it("concurrent duplicate admission yields one immutable base/exposure", async () => {
    const m = manifest(),
      e = exposure(m);
    const results = await Promise.all(Array.from({ length: 12 }, () => repo.admit(m, e)));
    expect(new Set(results.map((r) => r.manifestId)).size).toBe(1);
    expect((await repo.get(results[0]!.manifestId))?.exposures).toHaveLength(1);
  });
  it("lost COMMIT response preserves exact replay without authorizing downstream use", async () => {
    const m = manifest(),
      e = exposure(m);
    let loseAck = true;
    const interruptedPool = new Proxy(pool, {
      get(target, key) {
        if (key === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, method) {
                if (method === "query")
                  return async (...args: unknown[]) => {
                    const result = await (
                      connection.query as (...args: unknown[]) => Promise<unknown>
                    )(...args);
                    if (args[0] === "commit" && loseAck) {
                      loseAck = false;
                      throw Error("injected committed ACK loss");
                    }
                    return result;
                  };
                const value = Reflect.get(connection, method);
                return typeof value === "function" ? value.bind(connection) : value;
              }
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    await expect(new PostgresContextUseRepository(interruptedPool).admit(m, e)).rejects.toThrow(
      "committed ACK loss"
    );
    expect(await new PostgresContextUseRepository(pool).get(contextManifestId(m))).toEqual({
      manifest: m,
      exposures: [e]
    });
    expect(await repo.admit(m, e)).toEqual({
      manifestId: contextManifestId(m),
      exposureId: contextExposureId(e)
    });
  });
  it("conflicting owner revision reuse fails closed", async () => {
    const m = manifest();
    await repo.admit(m);
    await expect(repo.admit({ ...m, sources: [source("MEMORY", "new")] })).rejects.toBeInstanceOf(
      ContextUseConflict
    );
  });
  it("conflicting exposure input or selected refs cannot replace an earlier consumer", async () => {
    const m = manifest(),
      e = exposure(m);
    await repo.admit(m, e);
    await expect(
      repo.admit(m, { ...e, inputDigest: contextUseDigest("other input") })
    ).rejects.toBeInstanceOf(ContextUseConflict);
  });
  it("identical content in separate executions remains separate historical use", async () => {
    const m = manifest(),
      n = { ...m, executionId: "another-execution" };
    expect((await repo.admit(m)).manifestId).not.toBe((await repo.admit(n)).manifestId);
  });
  it("AVAILABLE candidates, SELECTED input and EXPOSED truncation are distinct", async () => {
    const m = manifest([
        source(),
        { ...source("MEMORY", "other"), reference: "unused", selection: "AVAILABLE" }
      ]),
      e = exposure(m);
    await repo.admit(m, e);
    const h = await repo.get(contextManifestId(m));
    expect(h?.manifest.sources[1]?.selection).toBe("AVAILABLE");
    expect(h?.exposures[0]?.blocks[0]?.characters).toBeLessThan(h!.manifest.blocks[0]!.characters);
    expect(h?.exposures[0]?.blocks[0]?.sourceReferences).not.toContain("unused");
  });
  it.each(["MEMORY", "PROFILE", "PERSON", "VOICE_BINDING", "P8"] as const)(
    "%s replacement never rewrites old revision or silently substitutes current",
    async (owner) => {
      const m = manifest([source(owner)]);
      await repo.admit(m, exposure(m));
      const current = source(owner, "replacement");
      const result = await repo.reconstruct(contextManifestId(m), async (consumed) => {
        expect(consumed.revision).toBe("old");
        return { availability: "AVAILABLE", revision: current.revision, digest: current.digest };
      });
      expect(result?.sources[0]).toMatchObject({
        exact: false,
        currentAvailability: "UNAVAILABLE",
        source: { revision: "old" }
      });
      expect((await repo.get(contextManifestId(m)))?.manifest).toEqual(m);
    }
  );
  it.each(["UNAVAILABLE", "REDACTED", "NOT_RETAINED", "DELETED"] as const)(
    "%s is an explicit reconstruction gap without fabricated payload",
    async (availability) => {
      const m = manifest([{ ...source(), availability }]);
      await repo.admit(m);
      let calls = 0;
      const result = await repo.reconstruct(contextManifestId(m), async () => {
        calls++;
        throw Error("Must not use latest");
      });
      expect(calls).toBe(0);
      expect(result?.sources[0]?.currentAvailability).toBe(availability);
      expect(result?.renderedContext).toBe("NOT_ARCHIVED");
    }
  );
  it("later payload redaction changes availability without changing use history", async () => {
    const m = manifest();
    await repo.admit(m);
    const result = await repo.reconstruct(contextManifestId(m), async () => ({
      availability: "REDACTED",
      revision: null,
      digest: null
    }));
    expect(result?.manifest.sources[0]?.availability).toBe("AVAILABLE");
    expect(result?.sources[0]?.currentAvailability).toBe("REDACTED");
  });
  it("exact historical resolver succeeds without claiming rendered/model replay", async () => {
    const m = manifest();
    await repo.admit(m);
    const result = await repo.reconstruct(contextManifestId(m), async (s) => ({
      availability: "AVAILABLE",
      revision: s.revision,
      digest: s.digest
    }));
    expect(result?.sources[0]?.exact).toBe(true);
    expect(result?.guarantee).toBe("IDENTITIES_AND_USE_RELATIONSHIPS");
  });
  it("real Profile regeneration reconstructs the consumed revision rather than the new current pointer", async () => {
    const subject = {
      kind: "MEMORY_SCOPE" as const,
      scope: buildMemoryScope("history-profile-user", "history-profile-persona")
    };
    const parent = {
      kind: "JOURNAL_EVENT" as const,
      namespace: "historical-profile-fixture",
      eventId: "jev1_0000000000000001"
    };
    const lineage = MemoryLineageV1Schema.parse({
      version: "memory-lineage.v1",
      state: "GROUNDED",
      parents: [
        {
          ref: parent,
          selector: {
            version: "source-selector.v1",
            modality: "TEXT",
            payload: { namespace: parent.namespace, payloadId: "retained-text", version: "v1" },
            range: { unit: "UNICODE_CODE_POINT", start: 0, end: 10 }
          }
        }
      ],
      sourceAvailability: { state: "RETAINED_SELECTABLE" },
      consumerKey: "historical-profile-fixture",
      derivation: {
        kind: "EXPLICIT_REMEMBER",
        producer: "test",
        producerVersion: "1",
        policyVersion: "test.v1"
      },
      origin: "USER_ASSERTION",
      authority: {
        principal: { state: "UNRESOLVED", reason: "fixture" },
        binding: { state: "UNRESOLVED", reason: "fixture" },
        audience: { kind: "UNKNOWN", reason: "fixture" }
      },
      sourceTime: { recordedAt: "2026-10-04T00:00:00Z", occurrenceTime: { state: "UNKNOWN" } }
    }) as GroundedMemoryLineageV1;
    const evidence = ProfileEvidenceSourceV1Schema.parse({
      version: "yuvi-profile-evidence-source.v1",
      memory: {
        memoryId: "legacy:00000000-0000-4000-8000-000000000001",
        backend: "legacy",
        sourceRecordId: "00000000-0000-4000-8000-000000000001"
      },
      scope: subject.scope,
      nativeScope: { kind: "user", scopeId: null },
      kind: "fact",
      subtype: null,
      content: "Historical preference evidence.",
      claimClass: null,
      lineage,
      lineageDigest: lineageDigest(canonicalLineageJson(lineage)),
      lifecycle: {
        state: "ACTIVE",
        coverage: "NATIVE",
        validFrom: "2025-01-01T00:00:00Z",
        validUntil: null,
        expiresAt: null
      },
      relationships: { coverage: "NATIVE", supersedes: [], supersededBy: null, contradicts: [] },
      roots: rootsForLineage(lineage)
    });
    const store = new PostgresProfileSnapshotStore(pool);
    const old = materializeProfileSnapshot({
      subject,
      backend: "legacy",
      sources: [evidence],
      generatedAt: "2026-10-04T00:00:00Z"
    });
    await store.putImmutable(old);
    const descriptor = {
      ...source("PROFILE", old.profileRevision),
      reference: JSON.stringify(subject),
      digest: contextUseDigest(old),
      semanticReferences: [
        JSON.stringify({
          profileRevision: old.profileRevision,
          sourceSetDigest: old.sourceSet.sourceSetDigest
        })
      ],
      roots: [JSON.stringify(parent)]
    };
    const m = manifest([descriptor]);
    await repo.admit(m, exposure(m));
    const replacement = materializeProfileSnapshot({
      subject,
      backend: "legacy",
      sources: [{ ...evidence, content: "Corrected preference evidence." }],
      generatedAt: "2026-10-05T00:00:00Z"
    });
    await store.putImmutable(replacement);
    expect((await store.getCurrent({ subject }))?.profileRevision).toBe(
      replacement.profileRevision
    );
    const historical = await repo.reconstruct(contextManifestId(m), async (consumed) => {
      const value = await new PostgresProfileSnapshotStore(pool).getRevision({
        subject: JSON.parse(consumed.reference),
        profileRevision: consumed.revision!
      });
      return {
        availability: value ? "AVAILABLE" : "UNAVAILABLE",
        revision: value?.profileRevision ?? null,
        digest: value ? contextUseDigest(value) : null
      };
    });
    expect(historical?.sources[0]?.exact).toBe(true);
    expect(historical?.manifest.sources[0]?.revision).toBe(old.profileRevision);
    expect(historical?.manifest.sources[0]?.semanticReferences).toEqual(
      descriptor.semanticReferences
    );
  });
  it("restart reconstructs from committed identity without any live cache", async () => {
    const m = manifest(),
      e = exposure(m);
    await repo.admit(m, e);
    expect(await new PostgresContextUseRepository(pool).get(contextManifestId(m))).toEqual({
      manifest: m,
      exposures: [e]
    });
  });
  it("stable and volatile replacement cannot change simultaneous historical readers", async () => {
    const m = manifest();
    await repo.admit(m);
    const newer = {
      ...m,
      assemblyOrdinal: "2",
      stable: { ...m.stable, digest: contextUseDigest("stable-v2") },
      volatile: { ...m.volatile, digest: contextUseDigest("volatile-v2") }
    };
    const readers = Array.from({ length: 8 }, () => repo.get(contextManifestId(m)));
    await repo.admit(newer);
    for (const h of await Promise.all(readers)) expect(h?.manifest.stable).toEqual(m.stable);
  });
  it("exposure failure rolls back new base admission", async () => {
    const m = manifest(),
      e = exposure(m);
    await pool.query(
      `create function reject_test_exposure() returns trigger language plpgsql as $$ begin raise exception 'injected exposure commit failure'; end $$`
    );
    await pool.query(
      "create trigger test_reject before insert on context_use_exposures for each row execute function reject_test_exposure()"
    );
    try {
      await expect(repo.admit(m, e)).rejects.toThrow("injected exposure commit failure");
      expect(await repo.get(contextManifestId(m))).toBeNull();
    } finally {
      await pool.query("drop trigger test_reject on context_use_exposures");
    }
  });
  it("SQL updates and deletes are rejected for both historical records", async () => {
    const m = manifest(),
      e = exposure(m);
    await repo.admit(m, e);
    await expect(
      pool.query("update context_use_manifests set body='{}'::jsonb where manifest_id=$1", [
        contextManifestId(m)
      ])
    ).rejects.toThrow("CONTEXT_USE_IMMUTABLE");
    await expect(
      pool.query("delete from context_use_exposures where exposure_id=$1", [contextExposureId(e)])
    ).rejects.toThrow("CONTEXT_USE_IMMUTABLE");
  });
});
