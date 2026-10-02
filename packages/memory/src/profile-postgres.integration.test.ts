import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildMemoryScope } from "./scope.js";
import { MemoryLineageV1Schema } from "./lineage.js";
import { PostgresMemoryRepository } from "./repository.js";
import { LegacyProfileMemorySourceReader } from "./profile-source-reader.js";
import { materializeProfileSnapshot } from "./profile-materializer.js";
import { PostgresProfileSnapshotStore } from "./profile-snapshot-store.js";
import { canonicalLineageJson, lineageDigest } from "./lineage-encoding.js";
import type { ProfileSubjectV1 } from "./profile-types.js";

const databaseUrl = process.env["YUVI_PROFILE_TEST_DATABASE_URL"];

describe.skipIf(!databaseUrl)("A10.1f1 real PostgreSQL integration", () => {
  it("applies migration 017 twice and validates bounded read plus immutable store across reload", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const unique = crypto.randomUUID().replace(/-/gu, "");
    const subjectUserId = `profile-test-user-${unique}`;
    const personaId = `profile-test-persona-${unique}`;
    const scope = buildMemoryScope(subjectUserId, personaId);
    const subject: ProfileSubjectV1 = { kind: "MEMORY_SCOPE", scope };
    const subjectKey = `ps1_${lineageDigest(canonicalLineageJson(subject))}`;
    const repository = new PostgresMemoryRepository(pool);
    const store = new PostgresProfileSnapshotStore(pool);
    try {
      const migration = await readFile(new URL("../migrations/017_profile_snapshots_v1.sql", import.meta.url), "utf8");
      await pool.query(migration);
      await pool.query(migration);
      const parent = {
        kind: "JOURNAL_EVENT" as const,
        namespace: `profile-test-${unique}`,
        eventId: `jev1_${unique.slice(0, 16)}`
      };
      const text = "Please remember that I prefer concise explanations.";
      const parsedLineage = MemoryLineageV1Schema.parse({
        version: "memory-lineage.v1",
        state: "GROUNDED",
        parents: [{
          ref: parent,
          selector: {
            version: "source-selector.v1",
            modality: "TEXT",
            payload: { namespace: parent.namespace, payloadId: `payload-${unique}`, version: "v1" },
            range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(text).length }
          }
        }],
        sourceAvailability: { state: "RETAINED_SELECTABLE" },
        consumerKey: `profile-consumer-${unique}`,
        derivation: { kind: "EXPLICIT_REMEMBER", producer: "profile-postgres-test", producerVersion: "1", policyVersion: "test.v1" },
        origin: "USER_ASSERTION",
        authority: {
          principal: { state: "UNRESOLVED", reason: "integration fixture does not authenticate a principal" },
          binding: { state: "UNRESOLVED", reason: "integration fixture has no Person binding" },
          audience: { kind: "UNKNOWN", reason: "integration fixture has no audience snapshot" }
        },
        sourceTime: { recordedAt: "2026-09-30T08:00:00.000Z", occurrenceTime: { state: "UNKNOWN" } }
      });
      if (parsedLineage.state !== "GROUNDED") throw new Error("integration fixture lineage did not parse as grounded");
      const lineage = parsedLineage;
      await repository.createGroundedMemory!({
        memory: {
          type: "semantic",
          subtype: "preference",
          content: text,
          source: "profile-postgres-test",
          subjectUserId,
          personaId,
          observedAt: "2026-09-30T08:00:00.000Z",
          validFrom: "2025-01-01T00:00:00.000Z"
        },
        lineage,
        payloadDigest: "a".repeat(64)
      });
      const before = await pool.query("select last_accessed_at from memories where subject_user_id = $1 and persona_id = $2", [subjectUserId, personaId]);
      const read = await new LegacyProfileMemorySourceReader(repository).listEligibleSources({ subject, asOf: "2026-10-02T00:00:00.000Z" });
      const after = await pool.query("select last_accessed_at from memories where subject_user_id = $1 and persona_id = $2", [subjectUserId, personaId]);
      expect(read.state, JSON.stringify(read)).toBe("COMPLETE");
      expect(read.sources).toHaveLength(1);
      expect(after.rows[0]?.["last_accessed_at"]).toEqual(before.rows[0]?.["last_accessed_at"]);
      const snapshot = materializeProfileSnapshot({ subject, backend: "legacy", sources: read.sources, generatedAt: "2026-10-02T00:00:00.000Z" });
      const created = await store.putImmutable(snapshot);
      expect(created.disposition).toBe("CREATED");
      expect((await store.putImmutable({ ...snapshot, generatedAt: "2026-10-02T01:00:00.000Z" })).disposition).toBe("REPLAY");
      expect((await store.getRevision({ subject, profileRevision: snapshot.profileRevision }))?.profileRevision).toBe(snapshot.profileRevision);
      expect((await store.getCurrent({ subject }))?.profileRevision).toBe(snapshot.profileRevision);
      const reopened = new PostgresProfileSnapshotStore(pool);
      const reopenedCurrent = await reopened.getCurrent({ subject });
      expect(canonicalLineageJson(reopenedCurrent)).toBe(canonicalLineageJson(created.snapshot));

      const policyVariant = structuredClone(snapshot);
      policyVariant.producer.providerVersion = "descriptive-provider-version-2";
      await expect(store.putImmutable(policyVariant)).rejects.toMatchObject({ code: "PROFILE_REVISION_CONFLICT" });
      expect((await store.getCurrent({ subject }))?.profileRevision).toBe(snapshot.profileRevision);

      const variantLineage = structuredClone(read.sources[0]!.lineage);
      variantLineage.consumerKey = `profile-concurrent-${unique}`;
      const variantId = crypto.randomUUID();
      const variantSource = {
        ...structuredClone(read.sources[0]!),
        memory: { ...read.sources[0]!.memory, memoryId: `legacy:${variantId}`, sourceRecordId: variantId },
        content: "A second immutable, explicitly generated revision.",
        lineage: variantLineage,
        lineageDigest: lineageDigest(canonicalLineageJson(variantLineage))
      };
      const secondSnapshot = materializeProfileSnapshot({ subject, backend: "legacy", sources: [variantSource], generatedAt: "2026-10-02T01:00:00.000Z" });
      await Promise.all([store.putImmutable(snapshot), store.putImmutable(secondSnapshot)]);
      expect([snapshot.profileRevision, secondSnapshot.profileRevision]).toContain((await store.getCurrent({ subject }))?.profileRevision);
      await store.putImmutable(secondSnapshot);
      expect((await store.getCurrent({ subject }))?.profileRevision).toBe(secondSnapshot.profileRevision);
      expect((await store.getRevision({ subject, profileRevision: snapshot.profileRevision }))?.profileRevision).toBe(snapshot.profileRevision);

      await pool.query(
        "update profile_snapshots set payload = jsonb_set(payload, '{entries,0,content}', to_jsonb('corrupted isolated fixture'::text)) where subject_key = $1 and profile_revision = $2",
        [subjectKey, secondSnapshot.profileRevision]
      );
      await expect(new PostgresProfileSnapshotStore(pool).getCurrent({ subject }))
        .rejects.toMatchObject({ name: "ProfileSnapshotCorruptionError" });
      expect(subjectKey).toMatch(/^ps1_[a-f0-9]{64}$/u);
    } finally {
      await pool.query("delete from profile_current where subject_key = $1", [subjectKey]).catch(() => undefined);
      await pool.query("delete from profile_snapshots where subject_key = $1", [subjectKey]).catch(() => undefined);
      await pool.query("delete from memories where subject_user_id = $1 and persona_id = $2", [subjectUserId, personaId]).catch(() => undefined);
      await repository.close?.();
      await pool.end();
    }
  });
});
