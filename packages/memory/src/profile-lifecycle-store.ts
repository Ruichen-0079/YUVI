import type { Pool, PoolClient } from "pg";
import {
  ProfileSubjectV1Schema,
  profileSubjectKey,
  type ProfileSubjectV1
} from "./profile-types.js";

export const PROFILE_INVALIDATION_REASONS = [
  "MEMORY_ADMITTED",
  "MEMORY_CHANGED",
  "MEMORY_WITHDRAWN",
  "DELIVERY_DISPATCHED",
  "DELIVERY_OBSERVED",
  "SOURCE_SET_CHANGED",
  "SOURCE_RECOVERED",
  "SOURCE_SELECTION_CHANGED",
  "STARTUP_RECHECK",
  "EXPLICIT_REQUEST"
] as const;
export type ProfileInvalidationReason = (typeof PROFILE_INVALIDATION_REASONS)[number];
export const PROFILE_LIFECYCLE_ERRORS = [
  "MEMORY_DISABLED",
  "NO_CANDIDATE",
  "REGENERATION_REQUIRED",
  "SOURCE_CHANGED",
  "SOURCE_PARTIAL",
  "SOURCE_UNAVAILABLE",
  "SOURCE_ERROR",
  "SOURCE_AUTHORITY_UNSUPPORTED",
  "COMPOSITION_CHANGED",
  "FENCE_LOST",
  "CANCELLED",
  "STORE_UNAVAILABLE",
  "STORE_ERROR",
  "PROFILE_REVISION_CONFLICT",
  "PROFILE_POLICY_UNSUPPORTED",
  "SNAPSHOT_BOUND",
  "RETRY_EXHAUSTED",
  "BINDING_AUTHORITY_UNAVAILABLE"
] as const;
export type ProfileLifecycleError = (typeof PROFILE_LIFECYCLE_ERRORS)[number];
export type ProfileSourceReadState = "NONE" | "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "ERROR";
export type ProfileBackend = "legacy" | "mem0";

export type ProfileLifecycleRow = {
  subjectKey: string;
  subject: ProfileSubjectV1;
  scope: string;
  controlVersion: string;
  regenerationNeeded: boolean;
  observedBackend: ProfileBackend | null;
  observedDigest: string | null;
  sourceReadState: ProfileSourceReadState;
  candidateRevision: string | null;
  candidateDigest: string | null;
  candidateBackend: ProfileBackend | null;
  candidateVersion: string | null;
  candidateVerifiedAsOf: string | null;
  attemptVersion: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  leaseFence: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  leaseVersion: string | null;
  lastReason: ProfileInvalidationReason | null;
  lastError: ProfileLifecycleError | null;
  updatedAt: string;
};
export type ScopeProfileStatus = {
  subject: ProfileSubjectV1;
  controlVersion: string;
  candidateRevision: string | null;
  evidenceState: "NO_PROFILE" | "UNCHECKED" | "STALE" | "VERIFIED";
  regenerationRequired: boolean;
  workState: "IDLE" | "WAITING" | "RUNNING" | "BLOCKED";
  lastError: ProfileLifecycleError | null;
};
export type ProfileLifecycleClaim = {
  row: ProfileLifecycleRow;
  owner: string;
  fence: string;
  version: string;
};

export interface ProfileLifecycleStore {
  readonly kind: "postgres" | "in-memory";
  enroll(subject: ProfileSubjectV1): Promise<ProfileLifecycleRow>;
  get(subject: ProfileSubjectV1): Promise<ProfileLifecycleRow | null>;
  getByKey(subjectKey: string): Promise<ProfileLifecycleRow | null>;
  requestGeneration(
    subject: ProfileSubjectV1,
    reason?: ProfileInvalidationReason
  ): Promise<ProfileLifecycleRow>;
  invalidateScope(scope: string, reason: ProfileInvalidationReason): Promise<number>;
  observeComplete(
    subjectKey: string,
    backend: ProfileBackend,
    digest: string
  ): Promise<ProfileLifecycleRow | null>;
  observeFailure(
    subjectKey: string,
    state: "PARTIAL" | "UNAVAILABLE" | "ERROR",
    error: ProfileLifecycleError
  ): Promise<ProfileLifecycleRow | null>;
  claimDue(): Promise<ProfileLifecycleClaim | null>;
  renew(claim: ProfileLifecycleClaim): Promise<boolean>;
  selectCandidate(
    claim: ProfileLifecycleClaim,
    candidate: { revision: string; digest: string; backend: ProfileBackend; asOf: string }
  ): Promise<boolean>;
  failAttempt(
    claim: ProfileLifecycleClaim,
    error: ProfileLifecycleError,
    sourceState?: ProfileSourceReadState
  ): Promise<void>;
  release(claim: ProfileLifecycleClaim): Promise<void>;
  listAuditPage(afterSubjectKey: string | null, limit?: number): Promise<ProfileLifecycleRow[]>;
  startupRecheckBatch(
    afterSubjectKey: string | null,
    limit?: number
  ): Promise<{ count: number; lastSubjectKey: string | null }>;
}

const FIRST_DUE_MS = 250;
const LEASE_MS = 90_000;
const MAX_I64 = 9_223_372_036_854_775_807n;
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION = /^pf1_[a-f0-9]{64}$/u;
const clone = <T>(value: T): T => structuredClone(value);
const canonicalSubject = (value: ProfileSubjectV1): ProfileSubjectV1 =>
  ProfileSubjectV1Schema.parse(value);
const iso = (date: Date): string => date.toISOString();
const plus = (date: Date, ms: number): string => iso(new Date(date.getTime() + ms));
function decimal(value: unknown): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(text) || BigInt(text) > MAX_I64)
    throw new TypeError("Lifecycle BIGINT is not an unsigned decimal string.");
  return text;
}
function increment(value: string): string {
  const n = BigInt(decimal(value));
  if (n >= MAX_I64) throw new RangeError("Profile lifecycle counter exhausted.");
  return String(n + 1n);
}
function newRow(subjectValue: ProfileSubjectV1, now: Date): ProfileLifecycleRow {
  const subject = canonicalSubject(subjectValue);
  return {
    subjectKey: profileSubjectKey(subject),
    subject,
    scope: subject.scope,
    controlVersion: "0",
    regenerationNeeded: true,
    observedBackend: null,
    observedDigest: null,
    sourceReadState: "NONE",
    candidateRevision: null,
    candidateDigest: null,
    candidateBackend: null,
    candidateVersion: null,
    candidateVerifiedAsOf: null,
    attemptVersion: "0",
    attemptCount: 0,
    nextAttemptAt: plus(now, FIRST_DUE_MS),
    leaseFence: "0",
    leaseOwner: null,
    leaseUntil: null,
    leaseVersion: null,
    lastReason: null,
    lastError: null,
    updatedAt: iso(now)
  };
}
function invalidate(
  row: ProfileLifecycleRow,
  reason: ProfileInvalidationReason,
  now: Date
): ProfileLifecycleRow {
  const next = clone(row);
  next.controlVersion = increment(row.controlVersion);
  next.regenerationNeeded = true;
  next.attemptVersion = next.controlVersion;
  next.attemptCount = 0;
  next.nextAttemptAt =
    row.regenerationNeeded && row.nextAttemptAt !== null
      ? iso(new Date(Math.min(Date.parse(row.nextAttemptAt), now.getTime() + FIRST_DUE_MS)))
      : plus(now, FIRST_DUE_MS);
  next.lastReason = reason;
  next.lastError = null;
  next.updatedAt = iso(now);
  return next;
}
function owns(row: ProfileLifecycleRow | undefined, claim: ProfileLifecycleClaim): boolean {
  return Boolean(
    row &&
    row.leaseFence === claim.fence &&
    row.leaseOwner === claim.owner &&
    row.leaseVersion === claim.version
  );
}
function liveLease(
  row: ProfileLifecycleRow | undefined,
  claim: ProfileLifecycleClaim,
  now: Date
): boolean {
  return Boolean(
    owns(row, claim) &&
    row!.controlVersion === claim.version &&
    row!.regenerationNeeded &&
    row!.leaseUntil &&
    Date.parse(row!.leaseUntil) > now.getTime()
  );
}
function clearLease(row: ProfileLifecycleRow): void {
  row.leaseOwner = null;
  row.leaseUntil = null;
  row.leaseVersion = null;
}
function immediate(error: ProfileLifecycleError): boolean {
  return [
    "MEMORY_DISABLED",
    "SOURCE_PARTIAL",
    "SOURCE_AUTHORITY_UNSUPPORTED",
    "PROFILE_REVISION_CONFLICT",
    "PROFILE_POLICY_UNSUPPORTED",
    "SNAPSHOT_BOUND"
  ].includes(error);
}

export function profileLifecycleStatus(
  row: ProfileLifecycleRow,
  now = new Date(),
  verified = false
): ScopeProfileStatus {
  const leased =
    row.regenerationNeeded &&
    row.leaseVersion === row.controlVersion &&
    row.leaseUntil !== null &&
    Date.parse(row.leaseUntil) > now.getTime();
  const blocked =
    row.regenerationNeeded &&
    (immediate(row.lastError ?? "SOURCE_ERROR") ||
      row.lastError === "RETRY_EXHAUSTED" ||
      (row.attemptVersion === row.controlVersion && row.attemptCount >= 3) ||
      (row.sourceReadState === "UNAVAILABLE" && row.nextAttemptAt === null));
  return {
    subject: clone(row.subject),
    controlVersion: row.controlVersion,
    candidateRevision: row.candidateRevision,
    evidenceState: verified
      ? "VERIFIED"
      : row.candidateRevision === null
        ? "NO_PROFILE"
        : row.regenerationNeeded
          ? "STALE"
          : "UNCHECKED",
    regenerationRequired: row.regenerationNeeded,
    workState: leased
      ? "RUNNING"
      : blocked
        ? "BLOCKED"
        : row.regenerationNeeded
          ? "WAITING"
          : "IDLE",
    lastError: row.lastError
  };
}

export class InMemoryProfileLifecycleStore implements ProfileLifecycleStore {
  readonly kind = "in-memory" as const;
  private readonly rows = new Map<string, ProfileLifecycleRow>();
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  async enroll(value: ProfileSubjectV1): Promise<ProfileLifecycleRow> {
    const subject = canonicalSubject(value),
      key = profileSubjectKey(subject);
    return this.lock(key, () => {
      let row = this.rows.get(key);
      if (!row) {
        row = newRow(subject, this.now());
        this.rows.set(key, row);
      }
      return clone(row);
    });
  }
  async get(value: ProfileSubjectV1): Promise<ProfileLifecycleRow | null> {
    return this.getByKey(profileSubjectKey(canonicalSubject(value)));
  }
  async getByKey(key: string): Promise<ProfileLifecycleRow | null> {
    const row = this.rows.get(key);
    return row ? clone(row) : null;
  }
  async requestGeneration(
    value: ProfileSubjectV1,
    reason: ProfileInvalidationReason = "EXPLICIT_REQUEST"
  ): Promise<ProfileLifecycleRow> {
    const row = await this.enroll(value);
    return this.lock(row.subjectKey, () => {
      const next = invalidate(this.rows.get(row.subjectKey)!, reason, this.now());
      this.rows.set(row.subjectKey, next);
      return clone(next);
    });
  }
  async invalidateScope(scope: string, reason: ProfileInvalidationReason): Promise<number> {
    const keys = [...this.rows.values()]
      .filter((row) => row.scope === scope)
      .map((row) => row.subjectKey)
      .sort();
    for (const key of keys)
      await this.lock(key, () =>
        this.rows.set(key, invalidate(this.rows.get(key)!, reason, this.now()))
      );
    return keys.length;
  }
  async observeComplete(
    key: string,
    backend: ProfileBackend,
    digest: string
  ): Promise<ProfileLifecycleRow | null> {
    if (!DIGEST.test(digest)) throw new TypeError("Invalid source digest.");
    return this.lock(key, () => {
      const row = this.rows.get(key);
      if (!row) return null;
      const now = this.now(),
        recovered = row.sourceReadState !== "NONE" && row.sourceReadState !== "COMPLETE";
      const changed =
        row.observedDigest !== null &&
        (row.observedDigest !== digest || row.observedBackend !== backend);
      const next =
        recovered || changed
          ? invalidate(row, recovered ? "SOURCE_RECOVERED" : "SOURCE_SET_CHANGED", now)
          : clone(row);
      next.sourceReadState = "COMPLETE";
      next.observedBackend = backend;
      next.observedDigest = digest;
      next.updatedAt = iso(now);
      this.rows.set(key, next);
      return clone(next);
    });
  }
  async observeFailure(
    key: string,
    state: "PARTIAL" | "UNAVAILABLE" | "ERROR",
    error: ProfileLifecycleError
  ): Promise<ProfileLifecycleRow | null> {
    return this.lock(key, () => {
      const row = this.rows.get(key);
      if (!row) return null;
      const now = this.now(),
        next =
          row.leaseOwner !== null || (row.sourceReadState === "COMPLETE" && !row.regenerationNeeded)
            ? invalidate(row, "SOURCE_SET_CHANGED", now)
            : clone(row);
      next.regenerationNeeded = true;
      next.sourceReadState = state;
      next.lastError = error;
      next.nextAttemptAt = null;
      next.updatedAt = iso(now);
      this.rows.set(key, next);
      return clone(next);
    });
  }
  async claimDue(): Promise<ProfileLifecycleClaim | null> {
    const now = this.now();
    const keys = [...this.rows.values()]
      .filter(
        (r) =>
          r.regenerationNeeded &&
          ((r.leaseUntil !== null && Date.parse(r.leaseUntil) <= now.getTime()) ||
            (r.leaseUntil === null &&
              r.nextAttemptAt !== null &&
              Date.parse(r.nextAttemptAt) <= now.getTime())) &&
          !(r.attemptVersion === r.controlVersion && r.attemptCount >= 3)
      )
      .sort((a, b) => a.subjectKey.localeCompare(b.subjectKey))
      .map((r) => r.subjectKey);
    for (const key of keys) {
      const claim = await this.lock(key, () => {
        const row = this.rows.get(key)!,
          at = this.now();
        const leaseExpired = row.leaseUntil !== null && Date.parse(row.leaseUntil) <= at.getTime();
        const due =
          row.leaseUntil === null &&
          row.nextAttemptAt !== null &&
          Date.parse(row.nextAttemptAt) <= at.getTime();
        if (
          !row.regenerationNeeded ||
          (!leaseExpired && !due) ||
          (row.leaseUntil && Date.parse(row.leaseUntil) > at.getTime())
        )
          return null;
        const version = row.controlVersion,
          count = row.attemptVersion === version ? row.attemptCount + 1 : 1;
        if (count > 3) return null;
        const next = clone(row),
          owner = crypto.randomUUID();
        next.leaseFence = increment(row.leaseFence);
        next.leaseOwner = owner;
        next.leaseUntil = plus(at, LEASE_MS);
        next.leaseVersion = version;
        next.attemptVersion = version;
        next.attemptCount = count;
        next.nextAttemptAt = null;
        next.lastError = null;
        next.updatedAt = iso(at);
        this.rows.set(key, next);
        return { row: clone(next), owner, fence: next.leaseFence, version };
      });
      if (claim) return claim;
    }
    return null;
  }
  async renew(claim: ProfileLifecycleClaim): Promise<boolean> {
    return this.lock(claim.row.subjectKey, () => {
      const row = this.rows.get(claim.row.subjectKey),
        now = this.now();
      if (!liveLease(row, claim, now)) return false;
      row!.leaseUntil = plus(now, LEASE_MS);
      row!.updatedAt = iso(now);
      return true;
    });
  }
  async selectCandidate(
    claim: ProfileLifecycleClaim,
    c: { revision: string; digest: string; backend: ProfileBackend; asOf: string }
  ): Promise<boolean> {
    if (
      !REVISION.test(c.revision) ||
      !DIGEST.test(c.digest) ||
      !Number.isFinite(Date.parse(c.asOf))
    )
      return false;
    return this.lock(claim.row.subjectKey, () => {
      const row = this.rows.get(claim.row.subjectKey);
      if (!liveLease(row, claim, this.now())) return false;
      const next = clone(row!);
      next.observedBackend = c.backend;
      next.observedDigest = c.digest;
      next.sourceReadState = "COMPLETE";
      next.candidateRevision = c.revision;
      next.candidateDigest = c.digest;
      next.candidateBackend = c.backend;
      next.candidateVersion = claim.version;
      next.candidateVerifiedAsOf = new Date(c.asOf).toISOString();
      next.regenerationNeeded = false;
      next.lastError = null;
      next.nextAttemptAt = null;
      clearLease(next);
      next.updatedAt = iso(this.now());
      this.rows.set(claim.row.subjectKey, next);
      return true;
    });
  }
  async failAttempt(
    claim: ProfileLifecycleClaim,
    error: ProfileLifecycleError,
    state?: ProfileSourceReadState
  ): Promise<void> {
    await this.lock(claim.row.subjectKey, () => {
      const row = this.rows.get(claim.row.subjectKey);
      if (!row || !owns(row, claim)) return;
      const now = this.now(),
        same = row.controlVersion === claim.version;
      if (state && same) row.sourceReadState = state;
      clearLease(row);
      if (same) {
        row.regenerationNeeded = true;
        row.lastError = row.attemptCount >= 3 && !immediate(error) ? "RETRY_EXHAUSTED" : error;
        row.nextAttemptAt =
          immediate(error) || row.attemptCount >= 3
            ? null
            : plus(now, row.attemptCount === 1 ? 1_000 : 5_000);
      }
      row.updatedAt = iso(now);
    });
  }
  async release(claim: ProfileLifecycleClaim): Promise<void> {
    await this.lock(claim.row.subjectKey, () => {
      const row = this.rows.get(claim.row.subjectKey);
      if (!row || !owns(row, claim)) return;
      const now = this.now();
      clearLease(row);
      row.regenerationNeeded = true;
      if (row.controlVersion === claim.version && !row.nextAttemptAt)
        row.nextAttemptAt = plus(now, FIRST_DUE_MS);
      row.updatedAt = iso(now);
    });
  }
  async listAuditPage(after: string | null, limit = 100): Promise<ProfileLifecycleRow[]> {
    return [...this.rows.values()]
      .filter((r) => after === null || r.subjectKey > after)
      .sort((a, b) => a.subjectKey.localeCompare(b.subjectKey))
      .slice(0, Math.min(100, Math.max(1, limit)))
      .map(clone);
  }
  async startupRecheckBatch(
    after: string | null,
    limit = 100
  ): Promise<{ count: number; lastSubjectKey: string | null }> {
    const rows = await this.listAuditPage(after, limit);
    for (const selected of rows)
      await this.lock(selected.subjectKey, () => {
        const r = this.rows.get(selected.subjectKey)!,
          now = this.now();
        r.controlVersion = increment(r.controlVersion);
        r.attemptVersion = r.controlVersion;
        r.attemptCount = 0;
        r.regenerationNeeded = true;
        r.nextAttemptAt = plus(now, FIRST_DUE_MS);
        r.lastReason = "STARTUP_RECHECK";
        r.lastError = null;
        if (!r.leaseUntil || Date.parse(r.leaseUntil) <= now.getTime()) clearLease(r);
        r.updatedAt = iso(now);
      });
    return { count: rows.length, lastSubjectKey: rows.at(-1)?.subjectKey ?? null };
  }
  private async lock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = prior.then(() => gate);
    this.locks.set(key, tail);
    await prior;
    try {
      return await fn();
    } finally {
      unlock();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

export class PostgresProfileLifecycleStore implements ProfileLifecycleStore {
  readonly kind = "postgres" as const;
  constructor(private readonly pool: Pool) {}
  async enroll(value: ProfileSubjectV1): Promise<ProfileLifecycleRow> {
    const subject = canonicalSubject(value),
      key = profileSubjectKey(subject);
    try {
      await this.pool.query(
        "insert into profile_lifecycle(subject_key,subject,scope,next_attempt_at) values($1,$2::jsonb,$3,clock_timestamp()+interval '250 milliseconds') on conflict(subject_key) do nothing",
        [key, JSON.stringify(subject), subject.scope]
      );
      const row = await this.getByKey(key);
      if (!row) throw new Error("Lifecycle enrollment did not return its row.");
      if (JSON.stringify(row.subject) !== JSON.stringify(subject))
        throw new TypeError("Lifecycle subject key collision.");
      return row;
    } catch (e) {
      throw storeError(e);
    }
  }
  async get(value: ProfileSubjectV1): Promise<ProfileLifecycleRow | null> {
    return this.getByKey(profileSubjectKey(canonicalSubject(value)));
  }
  async getByKey(key: string): Promise<ProfileLifecycleRow | null> {
    try {
      const r = await this.pool.query("select * from profile_lifecycle where subject_key=$1", [
        key
      ]);
      return r.rows[0] ? mapRow(r.rows[0] as Record<string, unknown>) : null;
    } catch (e) {
      throw storeError(e);
    }
  }
  async requestGeneration(
    value: ProfileSubjectV1,
    reason: ProfileInvalidationReason = "EXPLICIT_REQUEST"
  ): Promise<ProfileLifecycleRow> {
    const row = await this.enroll(value);
    const r = await this.pool.query(
      "update profile_lifecycle set control_version=control_version+1,regeneration_needed=true,attempt_version=control_version+1,attempt_count=0,next_attempt_at=case when regeneration_needed and next_attempt_at is not null then least(next_attempt_at,clock_timestamp()+interval '250 milliseconds') else clock_timestamp()+interval '250 milliseconds' end,last_reason=$2,last_error=null,updated_at=clock_timestamp() where subject_key=$1 returning *",
      [row.subjectKey, reason]
    );
    if (!r.rows[0]) throw new Error("Lifecycle row disappeared.");
    return mapRow(r.rows[0] as Record<string, unknown>);
  }
  async invalidateScope(scope: string, reason: ProfileInvalidationReason): Promise<number> {
    try {
      const r = await this.pool.query(
        "update profile_lifecycle set control_version=control_version+1,regeneration_needed=true,attempt_version=control_version+1,attempt_count=0,next_attempt_at=case when regeneration_needed and next_attempt_at is not null then least(next_attempt_at,clock_timestamp()+interval '250 milliseconds') else clock_timestamp()+interval '250 milliseconds' end,last_reason=$2,last_error=null,updated_at=clock_timestamp() where scope=$1",
        [scope, reason]
      );
      return r.rowCount ?? 0;
    } catch (e) {
      throw storeError(e);
    }
  }
  async observeComplete(
    key: string,
    backend: ProfileBackend,
    digest: string
  ): Promise<ProfileLifecycleRow | null> {
    if (!DIGEST.test(digest)) throw new TypeError("Invalid source digest.");
    return this.tx(async (c) => {
      const r = await c.query("select * from profile_lifecycle where subject_key=$1 for update", [
        key
      ]);
      if (!r.rows[0]) return null;
      const row = mapRow(r.rows[0] as Record<string, unknown>),
        recovered = row.sourceReadState !== "NONE" && row.sourceReadState !== "COMPLETE";
      const changed =
          row.observedDigest !== null &&
          (row.observedDigest !== digest || row.observedBackend !== backend),
        inv = recovered || changed;
      const reason = recovered ? "SOURCE_RECOVERED" : "SOURCE_SET_CHANGED";
      const result = await c.query(
        "update profile_lifecycle set control_version=control_version+case when $2 then 1 else 0 end,regeneration_needed=regeneration_needed or $2,attempt_version=case when $2 then control_version+1 else attempt_version end,attempt_count=case when $2 then 0 else attempt_count end,next_attempt_at=case when $2 then case when regeneration_needed and next_attempt_at is not null then least(next_attempt_at,clock_timestamp()+interval '250 milliseconds') else clock_timestamp()+interval '250 milliseconds' end else next_attempt_at end,observed_backend=$3,observed_digest=$4,source_read_state='COMPLETE',last_reason=case when $2 then $5 else last_reason end,last_error=case when $2 then null else last_error end,updated_at=clock_timestamp() where subject_key=$1 returning *",
        [key, inv, backend, digest, reason]
      );
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }
  async observeFailure(
    key: string,
    state: "PARTIAL" | "UNAVAILABLE" | "ERROR",
    error: ProfileLifecycleError
  ): Promise<ProfileLifecycleRow | null> {
    return this.tx(async (c) => {
      const r = await c.query("select * from profile_lifecycle where subject_key=$1 for update", [
        key
      ]);
      if (!r.rows[0]) return null;
      const row = mapRow(r.rows[0] as Record<string, unknown>),
        inv =
          row.leaseOwner !== null ||
          (row.sourceReadState === "COMPLETE" && !row.regenerationNeeded);
      const x = await c.query(
        "update profile_lifecycle set control_version=control_version+case when $2 then 1 else 0 end,attempt_version=case when $2 then control_version+1 else attempt_version end,attempt_count=case when $2 then 0 else attempt_count end,regeneration_needed=true,next_attempt_at=null,source_read_state=$3,last_error=$4,last_reason=case when $2 then 'SOURCE_SET_CHANGED' else last_reason end,updated_at=clock_timestamp() where subject_key=$1 returning *",
        [key, inv, state, error]
      );
      return mapRow(x.rows[0] as Record<string, unknown>);
    });
  }
  async claimDue(): Promise<ProfileLifecycleClaim | null> {
    return this.tx(async (c) => {
      const r = await c.query(
        "with due as (select subject_key from profile_lifecycle where regeneration_needed and ((lease_until is not null and lease_until<=clock_timestamp()) or (lease_until is null and next_attempt_at<=clock_timestamp())) and not(attempt_version=control_version and attempt_count>=3) order by coalesce(next_attempt_at,lease_until),subject_key limit 1 for update skip locked) update profile_lifecycle p set lease_fence=p.lease_fence+1,lease_owner=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',lease_version=p.control_version,attempt_version=p.control_version,attempt_count=case when p.attempt_version=p.control_version then p.attempt_count+1 else 1 end,next_attempt_at=null,last_error=null,updated_at=clock_timestamp() from due where p.subject_key=due.subject_key returning p.*"
      );
      if (!r.rows[0]) return null;
      const row = mapRow(r.rows[0] as Record<string, unknown>);
      if (!row.leaseOwner || !row.leaseVersion) return null;
      return { row, owner: row.leaseOwner, fence: row.leaseFence, version: row.leaseVersion };
    });
  }
  async renew(claim: ProfileLifecycleClaim): Promise<boolean> {
    try {
      const r = await this.pool.query(
        "update profile_lifecycle set lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() where subject_key=$1 and control_version=$2 and lease_version=$2 and lease_fence=$3 and lease_owner=$4 and regeneration_needed and lease_until>clock_timestamp()",
        [claim.row.subjectKey, claim.version, claim.fence, claim.owner]
      );
      return (r.rowCount ?? 0) === 1;
    } catch (e) {
      throw storeError(e);
    }
  }
  async selectCandidate(
    claim: ProfileLifecycleClaim,
    cnd: { revision: string; digest: string; backend: ProfileBackend; asOf: string }
  ): Promise<boolean> {
    if (
      !REVISION.test(cnd.revision) ||
      !DIGEST.test(cnd.digest) ||
      !Number.isFinite(Date.parse(cnd.asOf))
    )
      return false;
    try {
      const r = await this.pool.query(
        "update profile_lifecycle set observed_backend=$5,observed_digest=$6,source_read_state='COMPLETE',candidate_revision=$7,candidate_digest=$6,candidate_backend=$5,candidate_version=$2,candidate_verified_as_of=$8::timestamptz,regeneration_needed=false,last_error=null,next_attempt_at=null,lease_owner=null,lease_until=null,lease_version=null,updated_at=clock_timestamp() where subject_key=$1 and control_version=$2 and lease_version=$2 and lease_fence=$3 and lease_owner=$4 and regeneration_needed and lease_until>clock_timestamp()",
        [
          claim.row.subjectKey,
          claim.version,
          claim.fence,
          claim.owner,
          cnd.backend,
          cnd.digest,
          cnd.revision,
          cnd.asOf
        ]
      );
      return (r.rowCount ?? 0) === 1;
    } catch (e) {
      throw storeError(e);
    }
  }
  async failAttempt(
    claim: ProfileLifecycleClaim,
    error: ProfileLifecycleError,
    state?: ProfileSourceReadState
  ): Promise<void> {
    await this.tx(async (c) => {
      const r = await c.query("select * from profile_lifecycle where subject_key=$1 for update", [
        claim.row.subjectKey
      ]);
      if (!r.rows[0]) return;
      const row = mapRow(r.rows[0] as Record<string, unknown>);
      if (!owns(row, claim)) return;
      const same = row.controlVersion === claim.version,
        blocked = immediate(error) || (same && row.attemptCount >= 3),
        storedError =
          same && row.attemptCount >= 3 && !immediate(error) ? "RETRY_EXHAUSTED" : error,
        delay = row.attemptCount === 1 ? 1000 : 5000;
      await c.query(
        "update profile_lifecycle set lease_owner=null,lease_until=null,lease_version=null,source_read_state=case when $5::boolean and $2 then $6 else source_read_state end,regeneration_needed=case when $2 then true else regeneration_needed end,last_error=case when $2 then $7 else last_error end,next_attempt_at=case when $2 then case when $8 then null else clock_timestamp()+($9::text||' milliseconds')::interval end else next_attempt_at end,updated_at=clock_timestamp() where subject_key=$1 and lease_fence=$3 and lease_owner=$4",
        [
          claim.row.subjectKey,
          same,
          claim.fence,
          claim.owner,
          state !== undefined,
          state ?? "NONE",
          storedError,
          blocked,
          delay
        ]
      );
    });
  }
  async release(claim: ProfileLifecycleClaim): Promise<void> {
    try {
      await this.pool.query(
        "update profile_lifecycle set lease_owner=null,lease_until=null,lease_version=null,regeneration_needed=true,next_attempt_at=case when control_version=$2 and next_attempt_at is null then clock_timestamp()+interval '250 milliseconds' else next_attempt_at end,updated_at=clock_timestamp() where subject_key=$1 and lease_fence=$3 and lease_owner=$4",
        [claim.row.subjectKey, claim.version, claim.fence, claim.owner]
      );
    } catch (e) {
      throw storeError(e);
    }
  }
  async listAuditPage(after: string | null, limit = 100): Promise<ProfileLifecycleRow[]> {
    try {
      const r = await this.pool.query(
        "select * from profile_lifecycle where ($1::text is null or subject_key>$1) order by subject_key limit $2",
        [after, Math.min(100, Math.max(1, limit))]
      );
      return r.rows.map((x) => mapRow(x as Record<string, unknown>));
    } catch (e) {
      throw storeError(e);
    }
  }
  async startupRecheckBatch(
    after: string | null,
    limit = 100
  ): Promise<{ count: number; lastSubjectKey: string | null }> {
    return this.tx(async (c) => {
      const r = await c.query(
        "select subject_key from profile_lifecycle where ($1::text is null or subject_key>$1) order by subject_key limit $2 for update",
        [after, Math.min(100, Math.max(1, limit))]
      );
      const keys = r.rows.map((x) => String((x as Record<string, unknown>)["subject_key"]));
      if (keys.length)
        await c.query(
          "update profile_lifecycle set control_version=control_version+1,attempt_version=control_version+1,attempt_count=0,regeneration_needed=true,next_attempt_at=clock_timestamp()+interval '250 milliseconds',last_reason='STARTUP_RECHECK',last_error=null,lease_owner=case when lease_until<=clock_timestamp() then null else lease_owner end,lease_until=case when lease_until<=clock_timestamp() then null else lease_until end,lease_version=case when lease_until<=clock_timestamp() then null else lease_version end,updated_at=clock_timestamp() where subject_key=any($1::text[])",
          [keys]
        );
      return { count: keys.length, lastSubjectKey: keys.at(-1) ?? null };
    });
  }
  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    let c: PoolClient;
    try {
      c = await this.pool.connect();
    } catch (e) {
      throw storeError(e);
    }
    try {
      await c.query("begin");
      const v = await fn(c);
      await c.query("commit");
      return v;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw storeError(e);
    } finally {
      c.release();
    }
  }
}

function mapRow(v: Record<string, unknown>): ProfileLifecycleRow {
  const raw = v["subject"],
    subject = ProfileSubjectV1Schema.parse(
      typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
    );
  const nullable = (x: unknown): string | null =>
    x === null || x === undefined ? null : String(x);
  const timestamp = (x: unknown): string | null => {
    if (x === null || x === undefined) return null;
    const d = x instanceof Date ? x : new Date(String(x));
    if (!Number.isFinite(d.getTime())) throw new TypeError("Invalid lifecycle timestamp.");
    return d.toISOString();
  };
  const row: ProfileLifecycleRow = {
    subjectKey: String(v["subject_key"]),
    subject,
    scope: String(v["scope"]),
    controlVersion: decimal(v["control_version"]),
    regenerationNeeded: Boolean(v["regeneration_needed"]),
    observedBackend: enumNullable(v["observed_backend"], ["legacy", "mem0"] as const),
    observedDigest: nullable(v["observed_digest"]),
    sourceReadState: parseEnum(v["source_read_state"], [
      "NONE",
      "COMPLETE",
      "PARTIAL",
      "UNAVAILABLE",
      "ERROR"
    ] as const),
    candidateRevision: nullable(v["candidate_revision"]),
    candidateDigest: nullable(v["candidate_digest"]),
    candidateBackend: enumNullable(v["candidate_backend"], ["legacy", "mem0"] as const),
    candidateVersion:
      v["candidate_version"] === null || v["candidate_version"] === undefined
        ? null
        : decimal(v["candidate_version"]),
    candidateVerifiedAsOf: timestamp(v["candidate_verified_as_of"]),
    attemptVersion: decimal(v["attempt_version"]),
    attemptCount: Number(v["attempt_count"]),
    nextAttemptAt: timestamp(v["next_attempt_at"]),
    leaseFence: decimal(v["lease_fence"]),
    leaseOwner: nullable(v["lease_owner"]),
    leaseUntil: timestamp(v["lease_until"]),
    leaseVersion:
      v["lease_version"] === null || v["lease_version"] === undefined
        ? null
        : decimal(v["lease_version"]),
    lastReason: enumNullable(v["last_reason"], PROFILE_INVALIDATION_REASONS),
    lastError: enumNullable(v["last_error"], PROFILE_LIFECYCLE_ERRORS),
    updatedAt: timestamp(v["updated_at"])!
  };
  if (
    row.subjectKey !== profileSubjectKey(subject) ||
    row.scope !== subject.scope ||
    BigInt(row.attemptVersion) > BigInt(row.controlVersion) ||
    row.attemptCount < 0 ||
    row.attemptCount > 3 ||
    !Number.isInteger(row.attemptCount)
  )
    throw new TypeError("Lifecycle row failed strict validation.");
  if (
    (row.observedBackend === null) !== (row.observedDigest === null) ||
    (row.observedDigest !== null && !DIGEST.test(row.observedDigest))
  )
    throw new TypeError("Lifecycle observation tuple is invalid.");
  const candidateCount = [
    row.candidateRevision,
    row.candidateDigest,
    row.candidateBackend,
    row.candidateVersion,
    row.candidateVerifiedAsOf
  ].filter((x) => x !== null).length;
  if (
    (candidateCount !== 0 && candidateCount !== 5) ||
    (row.candidateRevision !== null &&
      (!REVISION.test(row.candidateRevision) ||
        !DIGEST.test(row.candidateDigest!) ||
        BigInt(row.candidateVersion!) > BigInt(row.controlVersion)))
  )
    throw new TypeError("Lifecycle candidate tuple is invalid.");
  const leaseCount = [row.leaseOwner, row.leaseUntil, row.leaseVersion].filter(
    (x) => x !== null
  ).length;
  if (
    (leaseCount !== 0 && leaseCount !== 3) ||
    (row.leaseVersion !== null && BigInt(row.leaseVersion) > BigInt(row.controlVersion))
  )
    throw new TypeError("Lifecycle lease tuple is invalid.");
  if (
    !row.regenerationNeeded &&
    (row.candidateRevision === null ||
      row.candidateVersion !== row.controlVersion ||
      row.sourceReadState !== "COMPLETE" ||
      row.observedBackend !== row.candidateBackend ||
      row.observedDigest !== row.candidateDigest ||
      row.leaseOwner !== null ||
      row.lastError !== null ||
      row.nextAttemptAt !== null)
  )
    throw new TypeError("Clean lifecycle row invariant is invalid.");
  return row;
}
function parseEnum<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new TypeError("Lifecycle row enum is invalid.");
  return value as T;
}
function enumNullable<T extends string>(value: unknown, values: readonly T[]): T | null {
  return value === null || value === undefined ? null : parseEnum(value, values);
}
function storeError(value: unknown): Error {
  if (
    value instanceof Error &&
    "code" in value &&
    typeof (value as { code?: unknown }).code === "string" &&
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "57P03"].includes(
      (value as { code: string }).code
    )
  ) {
    const e = new Error("Profile lifecycle store is unavailable.");
    e.name = "ProfileLifecycleStoreUnavailableError";
    return e;
  }
  return value instanceof Error ? value : new Error("Profile lifecycle store failed.");
}
