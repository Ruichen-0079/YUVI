-- Protected offline-copy migration workflow. Does not migrate any data automatically.
create table if not exists memory_legacy_workflows (
 migration_id text primary key,
 scope text not null,
 source_kind text not null check(source_kind='POSTGRES_LEGACY_COPY'),
 legacy_person text not null, legacy_persona text not null,
 actor text not null,
 status text not null check(status in ('SNAPSHOTTING','IMPORTING','VERIFYING','IMPORT_VERIFIED','PAUSED','SOURCE_CHANGED','FAILED')),
 resume_status text,
 anchor timestamptz not null,
 expected_count bigint not null,
 snapshot_count bigint not null default 0,
 imported_count bigint not null default 0,
 verified_count bigint not null default 0,
 checkpoint uuid,
 snapshot_digest text not null,
 verify_digest text not null,
 error_code text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index if not exists memory_legacy_workflow_scope_idx on memory_legacy_workflows(scope,created_at desc,migration_id);
create table if not exists memory_legacy_workflow_items (
 migration_id text not null references memory_legacy_workflows(migration_id),
 source_id uuid not null,
 source_digest text not null,
 source_payload jsonb not null,
 target_id text,
 imported_at timestamptz,
 verified_at timestamptz,
 primary key(migration_id,source_id)
);
create index if not exists memory_legacy_source_export_idx on memories(subject_user_id,persona_id,id);
create table if not exists memory_legacy_workflow_actions (
 migration_id text not null references memory_legacy_workflows(migration_id),
 action_seq bigint generated always as identity primary key,
 actor text not null, action text not null, prior_status text, final_status text not null,
 checkpoint uuid, acted_at timestamptz not null default now()
);
