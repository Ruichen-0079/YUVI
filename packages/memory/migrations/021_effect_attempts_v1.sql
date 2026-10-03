-- Shared private DB catalog. Admission JSON remains immutable; attempts own invocation accounting.
alter table effect_intents add column if not exists pre_dispatch_reason text null;
alter table effect_intents drop constraint if exists effect_intents_pre_dispatch_reason_check;
alter table effect_intents add constraint effect_intents_pre_dispatch_reason_check
  check(pre_dispatch_reason in ('AUTHORITY_REVOKED','SHUTDOWN','EXPIRED'));
-- Replace the unnamed admission projection check by definition, retaining all other checks.
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='effect_intents'::regclass and contype='c'
    and pg_get_constraintdef(oid) like '%decision%' loop
    execute format('alter table effect_intents drop constraint %I',c.conname);
  end loop;
end $$;
alter table effect_intents add constraint effect_intent_decision_projection_v2 check((
 (intent->>'decision'='DENIED' and intent->>'state'='DENIED' and state='DENIED' and
  intent->'workState'='null'::jsonb and work_state is null and not(intent->'request' ? 'payload') and intent->>'reasonCode' is not null) or
 (intent->>'decision'='ADMITTED' and intent->>'state'='ADMITTED' and intent->>'workState'='PENDING' and
  intent->'request' ? 'payload' and intent->'reasonCode'='null'::jsonb and
  ((state='ADMITTED' and work_state in ('PENDING','CLAIMED','WITHHELD')) or
   (state in ('CANCELED','EXPIRED') and work_state='WITHHELD')))
) is true);
create table if not exists effect_attempts (
 attempt_id text primary key check(attempt_id ~ '^ea1_[a-f0-9]{64}$'),
 intent_id text not null references effect_intents(intent_id),
 ordinal bigint not null check(ordinal>0),
 contract_ref text not null,
 adapter text not null,
 fence bigint not null check(fence>0),
 lease_owner text not null check(length(lease_owner) between 1 and 128),
 lease_expires_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),
 dispatch_started_at timestamptz null,
 integrity_conflict boolean not null default false,
 unique(intent_id,ordinal)
);
create table if not exists effect_observations (
 observation_id bigint generated always as identity primary key,
 attempt_id text not null references effect_attempts(attempt_id),
 fence bigint not null check(fence>0),
 evidence jsonb not null,
 evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),
 observed_at timestamptz not null default clock_timestamp(),
 unique(attempt_id,fence,evidence_digest),
 check(evidence->>'certainty' in ('APPLIED','DEFINITIVE_REJECTION','PROVEN_NOT_APPLIED','UNKNOWN'))
);
create index if not exists effect_attempts_recovery_idx on effect_attempts(lease_expires_at,intent_id);
create or replace function guard_effect_intent_v1() returns trigger language plpgsql as $$
begin
 if old.intent_id<>new.intent_id or old.logical_key<>new.logical_key or old.contract_ref<>new.contract_ref or
 old.payload_digest<>new.payload_digest or old.intent is distinct from new.intent or old.expires_at<>new.expires_at or old.created_at<>new.created_at then
 raise exception 'EFFECT_INTENT_IMMUTABLE'; end if;
 if (old.state<>new.state or old.work_state is distinct from new.work_state) and not (
 old.state='ADMITTED' and old.work_state='PENDING' and
 ((new.state in ('CANCELED','EXPIRED') and new.work_state='WITHHELD') or
 (new.state='ADMITTED' and new.work_state='WITHHELD' and new.pre_dispatch_reason is not null) or
 (new.state='ADMITTED' and new.work_state='CLAIMED' and old.expires_at>clock_timestamp()))) then
 raise exception 'EFFECT_INTENT_FENCE_REJECTED'; end if;
 if old.pre_dispatch_reason is distinct from new.pre_dispatch_reason and not (
 new.pre_dispatch_reason is not null and old.pre_dispatch_reason is null and (
 (old.work_state='PENDING' and new.work_state='WITHHELD') or
 (old.work_state='CLAIMED' and new.work_state='CLAIMED' and
  (select o.evidence->>'certainty' from effect_observations o join effect_attempts a using(attempt_id)
   where a.intent_id=old.intent_id order by a.ordinal desc,o.observation_id desc limit 1)='PROVEN_NOT_APPLIED'))) then
 raise exception 'EFFECT_DISPOSITION_IMMUTABLE'; end if;
 return new;
end $$;
-- Deferred checks enforce atomic linkage even for direct SQL/rollback, in both directions.
create or replace function check_effect_attempt_link_v1() returns trigger language plpgsql as $$
declare id text; i effect_intents; begin
 id:=coalesce(new.intent_id,old.intent_id);
 select * into i from effect_intents where intent_id=id;
 if coalesce(i.work_state='CLAIMED',false) is distinct from exists(select 1 from effect_attempts where intent_id=id) then
 raise exception 'EFFECT_ATTEMPT_LINK_REQUIRED'; end if;
 if exists(select 1 from effect_attempts a where a.intent_id=id and (i.state<>'ADMITTED' or a.contract_ref<>i.contract_ref)) then
 raise exception 'EFFECT_ATTEMPT_OWNER_MISMATCH'; end if;
 return null;
end $$;
drop trigger if exists effect_intent_attempt_link on effect_intents;
create constraint trigger effect_intent_attempt_link after insert or update on effect_intents deferrable initially deferred
 for each row execute function check_effect_attempt_link_v1();
drop trigger if exists effect_attempt_intent_link on effect_attempts;
create constraint trigger effect_attempt_intent_link after insert or update or delete on effect_attempts deferrable initially deferred
 for each row execute function check_effect_attempt_link_v1();
create or replace function guard_effect_attempt_v1() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'EFFECT_ATTEMPT_IMMUTABLE'; end if;
 if old.attempt_id<>new.attempt_id or old.intent_id<>new.intent_id or old.ordinal<>new.ordinal or old.contract_ref<>new.contract_ref or
 old.adapter<>new.adapter or old.created_at<>new.created_at or
 (old.dispatch_started_at is not null and old.dispatch_started_at is distinct from new.dispatch_started_at) or
 new.fence<old.fence or new.fence>old.fence+1 or (old.integrity_conflict and not new.integrity_conflict) then
 raise exception 'EFFECT_ATTEMPT_IMMUTABLE'; end if;
 return new;
end $$;
drop trigger if exists effect_attempt_immutable on effect_attempts;
create trigger effect_attempt_immutable before update or delete on effect_attempts for each row execute function guard_effect_attempt_v1();
create or replace function guard_effect_observation_v1() returns trigger language plpgsql as $$
begin raise exception 'EFFECT_OBSERVATION_IMMUTABLE'; end $$;
drop trigger if exists effect_observation_immutable on effect_observations;
create trigger effect_observation_immutable before update or delete on effect_observations for each row execute function guard_effect_observation_v1();
-- Fail closed on inconsistent reserved historical CLAIMED rows; never invent their attempts.
do $$ begin
 if exists(select 1 from effect_intents i where coalesce(i.work_state='CLAIMED',false) is distinct from
   exists(select 1 from effect_attempts a where a.intent_id=i.intent_id)) then
 raise exception 'EFFECT_ATTEMPT_LINK_REQUIRED'; end if;
end $$;
