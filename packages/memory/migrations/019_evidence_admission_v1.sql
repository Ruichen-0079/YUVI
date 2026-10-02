-- Host authority only. Existing producer workflows reconstruct exact provable
-- admissions through the versioned host bootstrap, never backend metadata/prose.
create table if not exists memory_evidence_admissions (
  admission_id text primary key check(admission_id ~ '^ea1_[a-f0-9]{64}$'),
  scope text not null,
  logical_event_id text not null,
  admission jsonb not null,
  state text not null check(state in ('PREPARED','EFFECT_BOUND')),
  backend_record_id text null unique,
  prepared_at timestamptz not null default now(),
  bound_at timestamptz null,
  unique(scope,logical_event_id),
  check(admission->>'version' = 'evidence-admission.v1'),
  check(admission->>'admissionId' = admission_id),
  check(admission->>'scope' = scope),
  check(admission->>'logicalEventId' = logical_event_id),
  check(admission->>'backend' = 'mem0'),
  check(admission->>'state' = state),
  check((state='PREPARED' and backend_record_id is null and admission->'backendRecordId'='null'::jsonb and bound_at is null) or
        (state='EFFECT_BOUND' and backend_record_id is not null and admission->>'backendRecordId'=backend_record_id and bound_at is not null))
);
create index if not exists memory_evidence_admissions_effect_idx on memory_evidence_admissions(scope,backend_record_id) where state='EFFECT_BOUND';
create or replace function guard_memory_evidence_admission() returns trigger language plpgsql as $$
begin
  if (old.admission - 'state' - 'backendRecordId') is distinct from (new.admission - 'state' - 'backendRecordId') or
     old.admission_id <> new.admission_id or old.scope <> new.scope or old.logical_event_id <> new.logical_event_id or old.prepared_at <> new.prepared_at or
     (old.state='EFFECT_BOUND' and (new.state <> old.state or new.backend_record_id is distinct from old.backend_record_id or new.bound_at is distinct from old.bound_at)) then
    raise exception 'EVIDENCE_ADMISSION_IMMUTABLE';
  end if;
  return new;
end $$;
drop trigger if exists memory_evidence_admission_immutable on memory_evidence_admissions;
create trigger memory_evidence_admission_immutable before update on memory_evidence_admissions for each row execute function guard_memory_evidence_admission();
