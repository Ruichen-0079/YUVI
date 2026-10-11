-- A certificate cannot survive mutation of a materialized projection or index.
-- Transition tables keep invalidation proportional to affected scopes, not row count.
create or replace function invalidate_memory_audit_changed_scopes() returns trigger language plpgsql as $$
begin
 update memory_authority_audits set status='STALE',updated_at=now()
 where status in ('VERIFIED','RUNNING') and scope in (select distinct scope from changed_memory_rows);
 return null;
end $$;
do $$
declare t text;
begin
 foreach t in array array['memory_authority_current','memory_authority_vectors','memory_authority_index_jobs'] loop
  execute format('drop trigger if exists memory_audit_insert on %I',t);
  execute format('drop trigger if exists memory_audit_update on %I',t);
  execute format('drop trigger if exists memory_audit_delete on %I',t);
  execute format('create trigger memory_audit_insert after insert on %I referencing new table as changed_memory_rows for each statement execute function invalidate_memory_audit_changed_scopes()',t);
  execute format('create trigger memory_audit_update after update on %I referencing new table as changed_memory_rows for each statement execute function invalidate_memory_audit_changed_scopes()',t);
  execute format('create trigger memory_audit_delete after delete on %I referencing old table as changed_memory_rows for each statement execute function invalidate_memory_audit_changed_scopes()',t);
 end loop;
end $$;
