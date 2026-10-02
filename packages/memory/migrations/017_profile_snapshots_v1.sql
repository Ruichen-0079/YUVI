create table if not exists profile_snapshots (
  subject_key text not null check (subject_key ~ '^ps1_[a-f0-9]{64}$'),
  profile_revision text not null check (profile_revision ~ '^pf1_[a-f0-9]{64}$'),
  subject jsonb not null check (jsonb_typeof(subject) = 'object'),
  schema_version text not null check (schema_version = 'yuvi-profile.v1'),
  materializer_version text not null,
  source_set_digest text not null check (source_set_digest ~ '^[a-f0-9]{64}$'),
  logical_payload_digest text not null check (logical_payload_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  generated_at timestamptz not null,
  stored_at timestamptz not null default now(),
  primary key (subject_key, profile_revision),
  check (payload->>'version' = schema_version),
  check (payload->'subject' = subject),
  check (payload->>'profileRevision' = profile_revision),
  check (payload->'sourceSet'->>'sourceSetDigest' = source_set_digest),
  check (payload->'producer'->>'materializerVersion' = materializer_version),
  check ((payload->>'generatedAt')::timestamptz = generated_at)
);

create table if not exists profile_current (
  subject_key text primary key check (subject_key ~ '^ps1_[a-f0-9]{64}$'),
  profile_revision text not null,
  selected_at timestamptz not null default now(),
  foreign key (subject_key, profile_revision)
    references profile_snapshots(subject_key, profile_revision)
);
