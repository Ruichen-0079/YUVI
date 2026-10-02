create table if not exists profile_lifecycle (
  subject_key text primary key check (subject_key ~ '^ps1_[a-f0-9]{64}$'),
  subject jsonb not null check (
    jsonb_typeof(subject) = 'object'
    and subject->>'kind' = 'MEMORY_SCOPE'
    and subject->>'scope' is not null
    and (subject - 'kind' - 'scope' - 'subjectReference') = '{}'::jsonb
    and (not (subject ? 'subjectReference') or jsonb_typeof(subject->'subjectReference') = 'string')
  ),
  scope text not null check (length(scope) between 1 and 2048),
  control_version bigint not null default 0 check (control_version >= 0),
  regeneration_needed boolean not null default true,
  observed_backend text null check (observed_backend is null or observed_backend in ('legacy', 'mem0')),
  observed_digest text null check (observed_digest is null or observed_digest ~ '^[a-f0-9]{64}$'),
  source_read_state text not null default 'NONE'
    check (source_read_state in ('NONE', 'COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'ERROR')),
  candidate_revision text null check (candidate_revision is null or candidate_revision ~ '^pf1_[a-f0-9]{64}$'),
  candidate_digest text null check (candidate_digest is null or candidate_digest ~ '^[a-f0-9]{64}$'),
  candidate_backend text null check (candidate_backend is null or candidate_backend in ('legacy', 'mem0')),
  candidate_version bigint null check (candidate_version is null or candidate_version >= 0),
  candidate_verified_as_of timestamptz null,
  attempt_version bigint not null default 0 check (attempt_version >= 0),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 3),
  next_attempt_at timestamptz null,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  lease_owner uuid null,
  lease_until timestamptz null,
  lease_version bigint null check (lease_version is null or lease_version >= 0),
  last_reason text null check (last_reason is null or last_reason in (
    'MEMORY_ADMITTED', 'MEMORY_CHANGED', 'MEMORY_WITHDRAWN', 'DELIVERY_DISPATCHED',
    'DELIVERY_OBSERVED', 'SOURCE_SET_CHANGED', 'SOURCE_RECOVERED',
    'SOURCE_SELECTION_CHANGED', 'STARTUP_RECHECK', 'EXPLICIT_REQUEST'
  )),
  last_error text null check (last_error is null or last_error in (
    'MEMORY_DISABLED', 'NO_CANDIDATE', 'REGENERATION_REQUIRED', 'SOURCE_CHANGED',
    'SOURCE_PARTIAL', 'SOURCE_UNAVAILABLE', 'SOURCE_ERROR', 'SOURCE_AUTHORITY_UNSUPPORTED',
    'COMPOSITION_CHANGED', 'FENCE_LOST', 'CANCELLED', 'STORE_UNAVAILABLE', 'STORE_ERROR',
    'PROFILE_REVISION_CONFLICT', 'PROFILE_POLICY_UNSUPPORTED', 'SNAPSHOT_BOUND',
    'RETRY_EXHAUSTED', 'BINDING_AUTHORITY_UNAVAILABLE'
  )),
  updated_at timestamptz not null default now(),
  check (scope = subject->>'scope'),
  check ((observed_backend is null) = (observed_digest is null)),
  check (
    (candidate_revision is null and candidate_digest is null and candidate_backend is null
      and candidate_version is null and candidate_verified_as_of is null)
    or
    (candidate_revision is not null and candidate_digest is not null and candidate_backend is not null
      and candidate_version is not null and candidate_verified_as_of is not null)
  ),
  check (candidate_version is null or candidate_version <= control_version),
  check (attempt_version <= control_version),
  check (
    (lease_owner is null and lease_until is null and lease_version is null)
    or (lease_owner is not null and lease_until is not null and lease_version is not null)
  ),
  check (lease_version is null or lease_version <= control_version),
  check (
    regeneration_needed
    or (candidate_revision is not null and candidate_version = control_version
      and source_read_state = 'COMPLETE'
      and observed_backend = candidate_backend and observed_digest = candidate_digest
      and lease_owner is null and last_error is null and next_attempt_at is null)
  ),
  foreign key (subject_key, candidate_revision)
    references profile_snapshots(subject_key, profile_revision)
);

create index if not exists profile_lifecycle_scope_idx on profile_lifecycle(scope);
create index if not exists profile_lifecycle_due_idx on profile_lifecycle(next_attempt_at, subject_key)
  where regeneration_needed;
