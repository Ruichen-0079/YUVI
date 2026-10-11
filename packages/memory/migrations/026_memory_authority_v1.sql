-- Opt-in R5 authority. Journal remains the source of raw experience.
-- Idempotent because the repository migration runner replays SQL on every boot.
create table if not exists memory_authority_scopes (
  scope text primary key,
  version bigint not null default 0,
  projection_version bigint not null default 0,
  record_count bigint not null default 0,
  current_count bigint not null default 0,
  legacy_count bigint not null default 0,
  check(version >= projection_version)
);
create table if not exists memory_authority_admissions (
  scope text not null,
  logical_key text not null,
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  producer text not null check(producer in ('FINALIZED_INGESTION','DREAM_DERIVATION')),
  prepared_at timestamptz not null default now(),
  primary key(scope,logical_key)
);
create table if not exists memory_authority_records (
  scope text not null references memory_authority_scopes(scope),
  id text not null,
  logical_key text not null,
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  version bigint not null,
  source_at timestamptz not null,
  committed_at timestamptz not null default now(),
  classification text not null check(classification in ('GROUNDED','LEGACY_UNVERIFIED')),
  event jsonb not null,
  search_terms text not null,
  primary key(scope,id),
  unique(scope,logical_key),
  unique(scope,version)
);
create index if not exists memory_authority_history_idx on memory_authority_records(scope,version desc,id);
create table if not exists memory_authority_relations (
  scope text not null,
  from_id text not null,
  to_id text not null,
  kind text not null check(kind in ('supersedes','conflicts','supports')),
  version bigint not null,
  primary key(scope,from_id,to_id,kind),
  foreign key(scope,from_id) references memory_authority_records(scope,id),
  foreign key(scope,to_id) references memory_authority_records(scope,id),
  check(from_id <> to_id)
);
create index if not exists memory_authority_relation_target_idx on memory_authority_relations(scope,to_id,version);
create table if not exists memory_authority_current (
  scope text not null,
  id text not null,
  version bigint not null,
  state text not null check(state in ('current','superseded','conflicted','supporting','legacy_unverified','unattributed')),
  search tsvector not null,
  primary key(scope,id),
  foreign key(scope,id) references memory_authority_records(scope,id)
);
create index if not exists memory_authority_current_page_idx on memory_authority_current(scope,state,version desc,id);
create index if not exists memory_authority_search_idx on memory_authority_current using gin(search) where state in ('current','conflicted');
create table if not exists memory_authority_migrations (
  migration_id text primary key,
  scope text not null,
  source text not null,
  checkpoint text,
  imported_count bigint not null default 0,
  state text not null check(state in ('running','complete','failed')),
  updated_at timestamptz not null default now()
);
create or replace function guard_memory_authority_append_only() returns trigger language plpgsql as $$
begin raise exception 'MEMORY_AUTHORITY_APPEND_ONLY'; end $$;
drop trigger if exists memory_authority_records_immutable on memory_authority_records;
create trigger memory_authority_records_immutable before update or delete on memory_authority_records for each row execute function guard_memory_authority_append_only();
drop trigger if exists memory_authority_relations_immutable on memory_authority_relations;
create trigger memory_authority_relations_immutable before update or delete on memory_authority_relations for each row execute function guard_memory_authority_append_only();
drop trigger if exists memory_authority_admissions_immutable on memory_authority_admissions;
create trigger memory_authority_admissions_immutable before update or delete on memory_authority_admissions for each row execute function guard_memory_authority_append_only();
create table if not exists memory_semantic_jobs (
  scope text not null,
  job_id text not null,
  source_digest text not null,
  source_ref jsonb not null,
  status text not null check(status in ('pending','processing','complete','retryable_failed','terminal_failed')),
  attempts int not null default 0,
  lease_owner text,
  lease_until timestamptz,
  next_attempt_at timestamptz,
  result jsonb,
  error_code text,
  provider_model text,
  token_usage jsonb,
  duration_ms int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(scope,job_id)
);
create index if not exists memory_semantic_jobs_due_idx on memory_semantic_jobs(status,next_attempt_at,created_at) where status in ('pending','processing','retryable_failed');

alter table memory_authority_current drop constraint if exists memory_authority_current_state_check;
alter table memory_authority_current add constraint memory_authority_current_state_check check(state in ('current','superseded','conflicted','supporting','legacy_unverified','unattributed'));
create table if not exists memory_authority_index_jobs (
 scope text not null,
 id text not null,
 model_tag text not null,
 status text not null default 'pending' check(status in ('pending','processing','complete','retryable_failed','terminal_failed')),
 attempts int not null default 0,
 lease_owner text,
 lease_until timestamptz,
 next_attempt_at timestamptz,
 error_code text,
 completed_at timestamptz,
 primary key(scope,id,model_tag),
 foreign key(scope,id) references memory_authority_records(scope,id)
);
create index if not exists memory_authority_index_jobs_due_idx on memory_authority_index_jobs(status,next_attempt_at,lease_until) where status in ('pending','processing','retryable_failed');
create table if not exists memory_authority_vectors (
 scope text not null,
 id text not null,
 model_tag text not null,
 authority_version bigint not null,
 embedding vector(512) not null,
 primary key(scope,id,model_tag),
 foreign key(scope,id) references memory_authority_records(scope,id)
);
create index if not exists memory_authority_vectors_hnsw_idx on memory_authority_vectors using hnsw(embedding vector_cosine_ops);
-- Frozen semantic payload is independent of the UI event DTO and remains auditable.
alter table memory_authority_records add column if not exists semantic_payload jsonb;
alter table memory_authority_scopes add column if not exists unattributed_count bigint not null default 0;
create index if not exists memory_authority_valid_page_idx on memory_authority_current(scope,version desc) where state in ('current','conflicted');
create index if not exists memory_authority_index_owner_due_idx on memory_authority_index_jobs((split_part(scope,':character:',2)),model_tag,status,next_attempt_at) where status in ('pending','processing','retryable_failed');
alter table memory_authority_migrations add column if not exists error_code text;
create index if not exists memory_authority_migration_scope_idx on memory_authority_migrations(scope,updated_at desc,migration_id);
create table if not exists memory_authority_migration_batches (
 migration_id text not null references memory_authority_migrations(migration_id),
 batch_key text not null,
 input_digest text not null,
 imported_count int not null,
 committed_at timestamptz not null default now(),
 primary key(migration_id,batch_key)
);
alter table memory_authority_migrations drop constraint if exists memory_authority_migrations_state_check;
alter table memory_authority_migrations add constraint memory_authority_migrations_state_check check(state in ('running','complete','failed','reconcile_required'));

create index if not exists memory_authority_index_pending_scope_idx on memory_authority_index_jobs(scope,model_tag,id) where status!='complete';
