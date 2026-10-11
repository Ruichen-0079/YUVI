-- Separate operator action; NOT automatically run by application migrations.
-- psql -v app_role=yuvi_memory_app -v schema_name=public -f this-file
-- Run with the migration/schema owner after backup and deployment authorization.
-- Login credentials and role membership are provisioned outside this file.
\set ON_ERROR_STOP on
begin;
select format('create role %I nologin nosuperuser nocreatedb nocreaterole noinherit', :'app_role')
 where not exists(select 1 from pg_roles where rolname=:'app_role') \gexec
select format('grant usage on schema %I to %I', :'schema_name', :'app_role') \gexec
select format('grant select,insert,update,delete on all tables in schema %I to %I', :'schema_name', :'app_role') \gexec
select format('grant usage,select on all sequences in schema %I to %I', :'schema_name', :'app_role') \gexec
select format('revoke truncate on all tables in schema %I from %I', :'schema_name', :'app_role') \gexec
select format('revoke create on schema %I from %I', :'schema_name', :'app_role') \gexec
select format('revoke update,delete on %I.%I from %I', :'schema_name', t, :'app_role')
 from unnest(array['memory_authority_records','memory_authority_relations','memory_authority_admissions','context_use_manifests','context_use_exposures','journal_events','journal_event_parents']) t \gexec
-- An app credential cannot edit the schema receipts to bypass the startup gate.
select format('revoke insert,update,delete on %I.yuvi_schema_migrations from %I', :'schema_name', :'app_role') \gexec
commit;
-- If PUBLIC has CREATE, or this role inherits the owner/superuser, startup still rejects it.
-- Repeat grants after additive migrations with the schema owner; never give the app DDL.
