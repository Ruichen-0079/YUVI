-- Run once under the durable migration ledger. Existing rows become generation 1.
alter table memory_authority_scopes add column projection_generation bigint not null default 1;
alter table memory_authority_scopes add column next_projection_generation bigint not null default 2;
alter table memory_authority_current rename to memory_authority_projection_rows;
alter table memory_authority_projection_rows add column generation bigint not null default 1;
alter table memory_authority_projection_rows drop constraint memory_authority_current_pkey;
alter table memory_authority_projection_rows add primary key(scope,generation,id);
drop index memory_authority_current_page_idx;
drop index memory_authority_valid_page_idx;
create index memory_projection_page_idx on memory_authority_projection_rows(scope,generation,state,version desc,id);
create index memory_projection_valid_idx on memory_authority_projection_rows(scope,generation,version desc) where state in ('current','conflicted');
create view memory_authority_current as
 select c.scope,c.id,c.version,c.state,c.search from memory_authority_projection_rows c
 join memory_authority_scopes s on s.scope=c.scope and s.projection_generation=c.generation;
create function write_memory_active_projection() returns trigger language plpgsql as $$
declare g bigint; target_scope text;
begin
 target_scope := case when TG_OP='DELETE' then OLD.scope else NEW.scope end;
 if TG_OP='UPDATE' and (OLD.scope<>NEW.scope or OLD.id<>NEW.id) then raise exception 'MEMORY_PROJECTION_ID_IMMUTABLE'; end if;
 select projection_generation into g from memory_authority_scopes where scope=target_scope for update;
 if g is null then raise exception 'MEMORY_PROJECTION_SCOPE_MISSING'; end if;
 if TG_OP='INSERT' then
  insert into memory_authority_projection_rows(scope,generation,id,version,state,search) values(NEW.scope,g,NEW.id,NEW.version,NEW.state,NEW.search);
 elsif TG_OP='UPDATE' then
  update memory_authority_projection_rows set version=NEW.version,state=NEW.state,search=NEW.search where scope=OLD.scope and generation=g and id=OLD.id;
 else
  delete from memory_authority_projection_rows where scope=OLD.scope and generation=g and id=OLD.id;
  return OLD;
 end if;
 return NEW;
end $$;
create trigger memory_active_projection_write instead of insert or update or delete on memory_authority_current for each row execute function write_memory_active_projection();
create table memory_projection_rebuilds (
 scope text not null references memory_authority_scopes(scope), build_id text not null,
 generation bigint not null, anchor bigint not null, checkpoint bigint not null default 0,
 delta_version bigint not null default 0, delta_id text not null default '',
 status text not null check(status in ('SCANNING','CATCHING_UP','ACTIVE','PAUSED','FAILED','RETIRED')),
 phase text not null default 'SCANNING' check(phase in ('SCANNING','CATCHING_UP')),
 record_count bigint not null default 0,current_count bigint not null default 0,
 legacy_count bigint not null default 0,unattributed_count bigint not null default 0,
 error_code text,actor text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(scope,build_id), unique(scope,generation)
);
insert into memory_projection_rebuilds(scope,build_id,generation,anchor,checkpoint,status,phase,record_count,current_count,legacy_count,unattributed_count,actor)
 select scope,'adopted-generation-1',1,version,version,'ACTIVE','CATCHING_UP',record_count,current_count,legacy_count,unattributed_count,'schema-migration-033' from memory_authority_scopes;
create unique index memory_one_projection_rebuild_idx on memory_projection_rebuilds(scope) where status in ('SCANNING','CATCHING_UP','PAUSED');
create table memory_projection_deltas (
 scope text not null,build_id text not null,version bigint not null,id text not null,
 primary key(scope,build_id,version,id),
 foreign key(scope,build_id) references memory_projection_rebuilds(scope,build_id)
);
create function capture_memory_projection_deltas() returns trigger language plpgsql as $$
begin
 insert into memory_projection_deltas(scope,build_id,version,id)
 select distinct c.scope,b.build_id,s.version,c.id from changed_memory_rows c
 join memory_authority_scopes s on s.scope=c.scope and s.projection_generation=c.generation
 join memory_projection_rebuilds b on b.scope=c.scope and b.status in ('SCANNING','CATCHING_UP','PAUSED')
 on conflict do nothing;
 return null;
end $$;
create trigger memory_projection_delta_insert after insert on memory_authority_projection_rows referencing new table as changed_memory_rows for each statement execute function capture_memory_projection_deltas();
create trigger memory_projection_delta_update after update on memory_authority_projection_rows referencing new table as changed_memory_rows for each statement execute function capture_memory_projection_deltas();
create trigger memory_projection_delta_delete after delete on memory_authority_projection_rows referencing old table as changed_memory_rows for each statement execute function capture_memory_projection_deltas();
-- TRUNCATE must not bypass immutable historical rows or index invalidation.
create trigger memory_authority_records_no_truncate before truncate on memory_authority_records for each statement execute function guard_memory_authority_append_only();
create trigger memory_authority_relations_no_truncate before truncate on memory_authority_relations for each statement execute function guard_memory_authority_append_only();
create trigger memory_authority_admissions_no_truncate before truncate on memory_authority_admissions for each statement execute function guard_memory_authority_append_only();
create function invalidate_memory_audit_truncate() returns trigger language plpgsql as $$
begin update memory_authority_audits set status='STALE',updated_at=now() where status in ('VERIFIED','RUNNING'); return null; end $$;
create trigger memory_projection_audit_truncate after truncate on memory_authority_projection_rows for each statement execute function invalidate_memory_audit_truncate();
create trigger memory_vector_audit_truncate after truncate on memory_authority_vectors for each statement execute function invalidate_memory_audit_truncate();
create trigger memory_index_audit_truncate after truncate on memory_authority_index_jobs for each statement execute function invalidate_memory_audit_truncate();
