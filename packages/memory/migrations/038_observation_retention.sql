-- A bounded retention projection of actual A9 execution evidence, not a second action ledger.
-- Purging payloads leaves provenance and the original immutable Effect receipt untouched.
create table retained_observations (
  observation_id text primary key,
  attempt_id text not null unique references effect_attempts(attempt_id),
  namespace text not null,
  persona_id text not null,
  person_id text not null,
  principal_namespace text not null,
  actor_id text not null,
  audience_ref text not null,
  source_ref jsonb not null,
  session_id text not null,
  kind text not null check(kind in ('VISION','READ_TEXT')),
  provider text null,
  model text null,
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  evidence jsonb null,
  evidence_digest text not null,
  image_bytes bytea null,
  image_mime text null,
  image_digest text null,
  erased_at timestamptz null,
  erased_by_source jsonb null,
  check (expires_at>observed_at),
  check ((erased_at is null) or (evidence is null and image_bytes is null)),
  check (evidence is null or octet_length(evidence::text)<=80000),
  check (image_bytes is null or octet_length(image_bytes)<=20971520)
);
create index retained_observations_owner_recent_idx on retained_observations
  (namespace,persona_id,person_id,principal_namespace,actor_id,audience_ref,observed_at desc,observation_id desc);
create index retained_observations_expiry_idx on retained_observations(expires_at,observation_id) where erased_at is null;
