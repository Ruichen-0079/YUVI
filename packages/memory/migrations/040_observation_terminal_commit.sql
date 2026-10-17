-- Legacy rows retain their provenance and remain readable as legacy reports.
-- New rows must share COMMIT with an A9 APPLIED + exact report disposition.
alter table retained_observations add column commit_digest text null
  check(commit_digest is null or commit_digest ~ '^[a-f0-9]{64}$');
create function require_atomic_observation_insert_v1() returns trigger language plpgsql as $$
begin
  if new.commit_digest is null then raise exception 'OBSERVATION_ATOMIC_COMMIT_REQUIRED'; end if;
  return new;
end $$;
create trigger retained_observation_atomic_insert before insert on retained_observations
  for each row execute function require_atomic_observation_insert_v1();

create function verify_observation_terminal_commit_v1() returns trigger language plpgsql as $$
declare terminal jsonb; report retained_observations; expected text;
begin
  if tg_table_name='retained_observations' then
    if new.commit_digest is null then return null; end if; -- pre-upgrade erasure
    select evidence into terminal from effect_observations
      where attempt_id=new.attempt_id and category='TERMINAL' and evidence->>'certainty'='APPLIED'
      and evidence->'reportRetention'->>'state'='STORED' order by observation_id desc limit 1;
    if terminal is null or terminal->'reportRetention'->>'reportId' is distinct from new.observation_id or
       terminal->'reportRetention'->>'digest' is distinct from new.commit_digest then
      raise exception 'OBSERVATION_TERMINAL_REFERENCE_REQUIRED';
    end if;
  elsif new.category='TERMINAL' and new.evidence->'reportRetention'->>'state'='STORED' then
    terminal:=new.evidence;
    select * into report from retained_observations where attempt_id=new.attempt_id;
    if report.observation_id is null or terminal->>'certainty' is distinct from 'APPLIED' or
       terminal->'reportRetention'->>'reportId' is distinct from report.observation_id or
       terminal->'reportRetention'->>'digest' is distinct from report.commit_digest then
      raise exception 'OBSERVATION_REPORT_REFERENCE_REQUIRED';
    end if;
  end if;
  return null;
end $$;
create constraint trigger retained_observation_terminal_commit after insert or update on retained_observations
  deferrable initially deferred for each row execute function verify_observation_terminal_commit_v1();
create constraint trigger effect_terminal_observation_commit after insert on effect_observations
  deferrable initially deferred for each row execute function verify_observation_terminal_commit_v1();
