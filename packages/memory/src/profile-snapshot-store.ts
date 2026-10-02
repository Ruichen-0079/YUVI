import type { Pool, PoolClient } from "pg";
import { canonicalLineageJson, lineageDigest } from "./lineage-encoding.js";
import {
  ProfileSnapshotConflictError,
  ProfileSnapshotCorruptionError,
  ProfileSnapshotV1Schema,
  profileSubjectKey,
  validateProfileSnapshot,
  type ProfileSnapshotV1,
  type ProfileSubjectV1
} from "./profile-types.js";

export interface ProfileSnapshotStore {
  putImmutable(snapshot: ProfileSnapshotV1): Promise<{ disposition: "CREATED" | "REPLAY"; snapshot: ProfileSnapshotV1 }>;
  getRevision(input: { subject: ProfileSubjectV1; profileRevision: string }): Promise<ProfileSnapshotV1 | null>;
  getCurrent(input: { subject: ProfileSubjectV1 }): Promise<ProfileSnapshotV1 | null>;
}

export class ProfileSnapshotStoreUnavailableError extends Error {
  readonly code = "PROFILE_STORE_UNAVAILABLE";
  constructor() { super("Profile snapshot storage is unavailable."); this.name = "ProfileSnapshotStoreUnavailableError"; }
}

export class InMemoryProfileSnapshotStore implements ProfileSnapshotStore {
  private readonly snapshots = new Map<string, { payload: ProfileSnapshotV1; digest: string }>();
  private readonly current = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();

  async putImmutable(input: ProfileSnapshotV1): Promise<{ disposition: "CREATED" | "REPLAY"; snapshot: ProfileSnapshotV1 }> {
    const snapshot = validateProfileSnapshot(input);
    const subjectKey = profileSubjectKey(snapshot.subject);
    const key = `${subjectKey}\u0000${snapshot.profileRevision}`;
    return this.withSubjectLock(subjectKey, async () => {
      const logical = logicalPayload(snapshot);
      const digest = lineageDigest(canonicalLineageJson(logical));
      const existing = this.snapshots.get(key);
      let stored: ProfileSnapshotV1;
      let disposition: "CREATED" | "REPLAY";
      if (existing) {
        if (existing.digest !== digest || canonicalLineageJson(logicalPayload(existing.payload)) !== canonicalLineageJson(logical)) {
          throw new ProfileSnapshotConflictError();
        }
        stored = cloneSnapshot(existing.payload);
        disposition = "REPLAY";
      } else {
        stored = cloneSnapshot(snapshot);
        this.snapshots.set(key, { payload: stored, digest });
        disposition = "CREATED";
      }
      this.current.set(subjectKey, snapshot.profileRevision);
      return { disposition, snapshot: cloneSnapshot(stored) };
    });
  }

  async getRevision(input: { subject: ProfileSubjectV1; profileRevision: string }): Promise<ProfileSnapshotV1 | null> {
    const key = `${profileSubjectKey(input.subject)}\u0000${input.profileRevision}`;
    const stored = this.snapshots.get(key);
    if (!stored) return null;
    const snapshot = validateProfileSnapshot(cloneSnapshot(stored.payload));
    if (lineageDigest(canonicalLineageJson(logicalPayload(snapshot))) !== stored.digest) throw new ProfileSnapshotCorruptionError();
    return cloneSnapshot(snapshot);
  }

  async getCurrent(input: { subject: ProfileSubjectV1 }): Promise<ProfileSnapshotV1 | null> {
    const revision = this.current.get(profileSubjectKey(input.subject));
    return revision ? this.getRevision({ subject: input.subject, profileRevision: revision }) : null;
  }

  private async withSubjectLock<T>(subjectKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(subjectKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.locks.set(subjectKey, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.locks.get(subjectKey) === tail) this.locks.delete(subjectKey);
    }
  }
}

export class PostgresProfileSnapshotStore implements ProfileSnapshotStore {
  constructor(private readonly pool: Pool) {}

  async putImmutable(input: ProfileSnapshotV1): Promise<{ disposition: "CREATED" | "REPLAY"; snapshot: ProfileSnapshotV1 }> {
    const snapshot = validateProfileSnapshot(input);
    const subjectKey = profileSubjectKey(snapshot.subject);
    const logical = logicalPayload(snapshot);
    const logicalDigest = lineageDigest(canonicalLineageJson(logical));
    let client: PoolClient;
    try { client = await this.pool.connect(); }
    catch (error) { if (isDatabaseUnavailable(error)) throw new ProfileSnapshotStoreUnavailableError(); throw error; }
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [subjectKey]);
      const prior = await client.query(
        "select payload, logical_payload_digest from profile_snapshots where subject_key = $1 and profile_revision = $2 for update",
        [subjectKey, snapshot.profileRevision]
      );
      let stored: ProfileSnapshotV1;
      let disposition: "CREATED" | "REPLAY";
      if (prior.rows.length > 0) {
        stored = readStoredSnapshot(prior.rows[0]?.["payload"]);
        const recordedDigest = prior.rows[0]?.["logical_payload_digest"];
        if (recordedDigest !== logicalDigest ||
            canonicalLineageJson(logicalPayload(stored)) !== canonicalLineageJson(logical)) {
          throw new ProfileSnapshotConflictError();
        }
        disposition = "REPLAY";
      } else {
        const result = await client.query(
          `insert into profile_snapshots (
             subject_key, profile_revision, subject, schema_version, materializer_version,
             source_set_digest, logical_payload_digest, payload, generated_at
           ) values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
           returning payload`,
          [subjectKey, snapshot.profileRevision, JSON.stringify(snapshot.subject), snapshot.version,
            snapshot.producer.materializerVersion, snapshot.sourceSet.sourceSetDigest, logicalDigest,
            JSON.stringify(snapshot), snapshot.generatedAt]
        );
        stored = readStoredSnapshot(result.rows[0]?.["payload"]);
        disposition = "CREATED";
      }
      await client.query(
        `insert into profile_current(subject_key, profile_revision) values ($1, $2)
         on conflict(subject_key) do update set profile_revision = excluded.profile_revision, selected_at = now()`,
        [subjectKey, snapshot.profileRevision]
      );
      await client.query("commit");
      return { disposition, snapshot: cloneSnapshot(stored) };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof ProfileSnapshotConflictError || error instanceof ProfileSnapshotCorruptionError) throw error;
      if (isDatabaseUnavailable(error)) throw new ProfileSnapshotStoreUnavailableError();
      throw error;
    } finally {
      client.release();
    }
  }

  async getRevision(input: { subject: ProfileSubjectV1; profileRevision: string }): Promise<ProfileSnapshotV1 | null> {
    const subjectKey = profileSubjectKey(input.subject);
    const result = await this.query("select payload, logical_payload_digest from profile_snapshots where subject_key = $1 and profile_revision = $2", [subjectKey, input.profileRevision]);
    if (!result) return null;
    const snapshot = readStoredSnapshot(result["payload"]);
    const digest = lineageDigest(canonicalLineageJson(logicalPayload(snapshot)));
    if (digest !== result["logical_payload_digest"]) throw new ProfileSnapshotCorruptionError();
    return cloneSnapshot(snapshot);
  }

  async getCurrent(input: { subject: ProfileSubjectV1 }): Promise<ProfileSnapshotV1 | null> {
    const subjectKey = profileSubjectKey(input.subject);
    const result = await this.query(
      `select s.payload, s.logical_payload_digest from profile_current c
       join profile_snapshots s using(subject_key, profile_revision) where c.subject_key = $1`,
      [subjectKey]
    );
    if (!result) return null;
    const snapshot = readStoredSnapshot(result["payload"]);
    if (lineageDigest(canonicalLineageJson(logicalPayload(snapshot))) !== result["logical_payload_digest"]) throw new ProfileSnapshotCorruptionError();
    return cloneSnapshot(snapshot);
  }

  private async query(sql: string, values: unknown[]): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.pool.query(sql, values);
      return result.rows[0] as Record<string, unknown> | undefined ?? null;
    } catch (error) {
      if (isDatabaseUnavailable(error)) throw new ProfileSnapshotStoreUnavailableError();
      throw error;
    }
  }
}

function logicalPayload(snapshot: ProfileSnapshotV1): unknown {
  const copy = structuredClone(snapshot) as ProfileSnapshotV1;
  delete (copy as { generatedAt?: string }).generatedAt;
  if (copy.sourceSet.sources.length === 0) delete (copy.sourceSet as { backend?: string }).backend;
  return copy;
}

function cloneSnapshot(snapshot: ProfileSnapshotV1): ProfileSnapshotV1 {
  return ProfileSnapshotV1Schema.parse(structuredClone(snapshot));
}

function readStoredSnapshot(value: unknown): ProfileSnapshotV1 {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return validateProfileSnapshot(parsed);
  } catch {
    throw new ProfileSnapshotCorruptionError();
  }
}

function isDatabaseUnavailable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "57P03"].includes((error as { code: string }).code));
}
