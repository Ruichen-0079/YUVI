-- Historical use only. No source payload archive, context assembler or dispatch owner.
create table if not exists context_use_manifests (
 manifest_id text primary key check(manifest_id ~ '^cm1_[a-f0-9]{64}$'),
 namespace text not null, execution_id text not null, assembly_ordinal bigint not null check(assembly_ordinal > 0),
 body jsonb not null, body_digest text not null check(body_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 unique(namespace, execution_id, assembly_ordinal)
);
create table if not exists context_use_exposures (
 exposure_id text primary key check(exposure_id ~ '^ce1_[a-f0-9]{64}$'),
 manifest_id text not null references context_use_manifests(manifest_id),
 consumer_operation_slot text not null, exposure_ordinal bigint not null check(exposure_ordinal > 0),
 body jsonb not null, body_digest text not null check(body_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 unique(manifest_id, consumer_operation_slot, exposure_ordinal)
);
create or replace function reject_context_use_mutation_v1() returns trigger language plpgsql as $$
begin raise exception 'CONTEXT_USE_IMMUTABLE'; end $$;
drop trigger if exists context_manifest_immutable on context_use_manifests;
create trigger context_manifest_immutable before update or delete on context_use_manifests for each row execute function reject_context_use_mutation_v1();
drop trigger if exists context_exposure_immutable on context_use_exposures;
create trigger context_exposure_immutable before update or delete on context_use_exposures for each row execute function reject_context_use_mutation_v1();
