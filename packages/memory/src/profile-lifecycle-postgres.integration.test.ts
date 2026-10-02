import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildMemoryScope } from "./scope.js";
import { profileSubjectKey, type ProfileSubjectV1 } from "./profile-types.js";
import { materializeProfileSnapshot } from "./profile-materializer.js";
import { PostgresProfileSnapshotStore } from "./profile-snapshot-store.js";
import { PostgresProfileLifecycleStore } from "./profile-lifecycle-store.js";

const databaseUrl = process.env["YUVI_PROFILE_TEST_DATABASE_URL"];

describe.skipIf(!databaseUrl)("A10.1f2 real PostgreSQL lifecycle integration", () => {
  it("applies migrations twice, enforces snapshot fences, arbitrates claims and survives reopen", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const identity = crypto.randomUUID().replace(/-/gu, "");
    const subject: ProfileSubjectV1 = {
      kind: "MEMORY_SCOPE",
      scope: buildMemoryScope(`profile-lifecycle-${identity}`, "local-profile-test")
    };
    const key = profileSubjectKey(subject);
    const snapshots = new PostgresProfileSnapshotStore(pool);
    const lifecycle = new PostgresProfileLifecycleStore(pool);
    try {
      for (const name of ["017_profile_snapshots_v1.sql", "018_profile_lifecycle_v1.sql"]) {
        const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
        await pool.query(sql);
        await pool.query(sql);
      }

      const enrolled = await lifecycle.enroll(subject);
      expect(enrolled.subjectKey).toBe(key);
      expect(enrolled.controlVersion).toBe("0");

      const snapshot = materializeProfileSnapshot({
        subject,
        backend: "legacy",
        sources: [],
        generatedAt: "2026-10-02T00:00:00.000Z"
      });
      await snapshots.putImmutable(snapshot);
      await pool.query(
        "update profile_lifecycle set next_attempt_at=clock_timestamp()-interval '1 second' where subject_key=$1",
        [key]
      );

      const claims = await Promise.all([
        lifecycle.claimDue(),
        new PostgresProfileLifecycleStore(pool).claimDue()
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const first = claims.find((claim) => claim !== null);
      if (!first) throw new Error("Concurrent lifecycle claim did not produce an owner.");

      expect(
        await lifecycle.selectCandidate(first, {
          revision: snapshot.profileRevision,
          digest: snapshot.sourceSet.sourceSetDigest,
          backend: "legacy",
          asOf: "2026-10-02T00:00:00.000Z"
        })
      ).toBe(true);
      expect((await new PostgresProfileLifecycleStore(pool).get(subject))?.candidateRevision).toBe(
        snapshot.profileRevision
      );
      expect(
        await snapshots.getRevision({ subject, profileRevision: snapshot.profileRevision })
      ).toMatchObject({ profileRevision: snapshot.profileRevision });

      await expect(
        pool.query(
          "update profile_lifecycle set candidate_revision=$2,candidate_digest=$3,candidate_backend='legacy',candidate_version=control_version,candidate_verified_as_of=clock_timestamp() where subject_key=$1",
          [key, `pf1_${"f".repeat(64)}`, snapshot.sourceSet.sourceSetDigest]
        )
      ).rejects.toMatchObject({ code: "23503" });

      await lifecycle.requestGeneration(subject, "MEMORY_CHANGED");
      await pool.query(
        "update profile_lifecycle set next_attempt_at=clock_timestamp()-interval '1 second' where subject_key=$1",
        [key]
      );
      const expiredOwner = await lifecycle.claimDue();
      if (!expiredOwner) throw new Error("Lifecycle retry claim failed.");
      await pool.query(
        "update profile_lifecycle set lease_until=clock_timestamp()-interval '1 second' where subject_key=$1",
        [key]
      );
      const replacementOwner = await new PostgresProfileLifecycleStore(pool).claimDue();
      if (!replacementOwner) throw new Error("Expired lifecycle lease was not reclaimed.");
      expect(replacementOwner.fence).not.toBe(expiredOwner.fence);
      expect(
        await lifecycle.selectCandidate(expiredOwner, {
          revision: snapshot.profileRevision,
          digest: snapshot.sourceSet.sourceSetDigest,
          backend: "legacy",
          asOf: "2026-10-02T00:00:00.000Z"
        })
      ).toBe(false);

      const reopened = new PostgresProfileLifecycleStore(pool);
      const afterRestart = await reopened.get(subject);
      expect(afterRestart).toMatchObject({
        controlVersion: "1",
        candidateRevision: snapshot.profileRevision,
        regenerationNeeded: true,
        leaseOwner: replacementOwner.owner
      });
      expect(
        (
          await new PostgresProfileSnapshotStore(pool).getRevision({
            subject,
            profileRevision: snapshot.profileRevision
          })
        )?.profileRevision
      ).toBe(snapshot.profileRevision);
    } finally {
      await pool
        .query("delete from profile_lifecycle where subject_key=$1", [key])
        .catch(() => undefined);
      await pool
        .query("delete from profile_current where subject_key=$1", [key])
        .catch(() => undefined);
      await pool
        .query("delete from profile_snapshots where subject_key=$1", [key])
        .catch(() => undefined);
      await pool.end();
    }
  });
});
