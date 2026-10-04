-- A10.2 adds one static native-owner command contract to the existing A9 ledger.
-- The command body stays in this private payload table; effect intent JSON carries
-- only the immutable reference and digest required to bind the native invocation.
-- Packaged startup replays all migrations. A previously installed 023 schema
-- already owns the wider canonical contract check; never narrow it on replay.
do $$ begin
  if not exists (
    select 1 from pg_class c join pg_class i on i.relnamespace=c.relnamespace
    where c.oid=to_regclass('conversation_reply_components')
      and i.oid='effect_intents'::regclass
  ) then
    alter table effect_intents drop constraint if exists effect_intents_contract_ref_check;
    alter table effect_intents add constraint effect_intents_contract_ref_check
      check(contract_ref in ('yuvi.embodied-presentation.v1','yuvi.read-text.v1','yuvi.native-control.v1'));
  end if;
end $$;

create table if not exists effect_command_payloads (
  payload_ref text primary key check(length(payload_ref) between 1 and 512),
  contract_ref text not null check(contract_ref='yuvi.native-control.v1'),
  intent_id text unique references effect_intents(intent_id),
  installation_namespace text not null check(length(installation_namespace) between 1 and 512),
  command_handle text not null check(length(command_handle) between 1 and 256),
  target_reference text not null check(length(target_reference) between 1 and 512),
  payload_digest text not null check(payload_digest ~ '^[a-f0-9]{64}$'),
  semantic_digest text not null check(semantic_digest ~ '^[a-f0-9]{64}$'),
  payload_state text not null default 'AVAILABLE' check(payload_state in ('AVAILABLE','REDACTED')),
  payload jsonb null,
  created_at timestamptz not null default clock_timestamp(),
  unique(contract_ref, installation_namespace, command_handle),
  check((payload_state='AVAILABLE' and jsonb_typeof(payload)='object') or
        (payload_state='REDACTED' and payload is null))
);
create index if not exists effect_command_payloads_created_idx
  on effect_command_payloads(created_at, payload_ref);

create or replace function guard_effect_command_payload_v1() returns trigger language plpgsql as $$
begin
  if old.payload_ref<>new.payload_ref or old.contract_ref<>new.contract_ref or
    old.installation_namespace<>new.installation_namespace or
    old.command_handle<>new.command_handle or old.target_reference<>new.target_reference or
    old.payload_digest<>new.payload_digest or
    old.semantic_digest<>new.semantic_digest or
    old.created_at<>new.created_at then
    raise exception 'EFFECT_COMMAND_PAYLOAD_IMMUTABLE';
  end if;
  if old.intent_id is not null and old.intent_id is distinct from new.intent_id then
    raise exception 'EFFECT_COMMAND_INTENT_LINK_IMMUTABLE';
  end if;
  if not (old.payload_state='AVAILABLE' and new.payload_state='REDACTED' and new.payload is null) and
    (old.payload_state<>new.payload_state or old.payload is distinct from new.payload) then
    raise exception 'EFFECT_COMMAND_PAYLOAD_IMMUTABLE';
  end if;
  return new;
end $$;
drop trigger if exists effect_command_payload_v1_immutable on effect_command_payloads;
create trigger effect_command_payload_v1_immutable before update on effect_command_payloads
  for each row execute function guard_effect_command_payload_v1();
create or replace function reject_effect_command_payload_delete_v1() returns trigger language plpgsql as $$
begin raise exception 'EFFECT_COMMAND_PAYLOAD_IMMUTABLE'; end $$;
drop trigger if exists effect_command_payload_v1_no_delete on effect_command_payloads;
create trigger effect_command_payload_v1_no_delete before delete on effect_command_payloads
  for each row execute function reject_effect_command_payload_delete_v1();

-- Replacement sequencing is durable correlation metadata, not another command queue.
-- Each step still owns its ordinary A9 intent/attempt and native owner receipt.
create table if not exists native_control_workflows (
  installation_namespace text not null check(length(installation_namespace) between 1 and 512),
  workflow_id text not null check(length(workflow_id) between 1 and 256),
  workflow_kind text not null check(workflow_kind='ACOUSTIC_PROFILE_REPLACEMENT'),
  plan_digest text not null check(plan_digest ~ '^[a-f0-9]{64}$'),
  plan jsonb not null check(jsonb_typeof(plan)='object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(installation_namespace, workflow_id)
);
create table if not exists native_control_workflow_children (
  installation_namespace text not null,
  workflow_id text not null,
  step_key text not null check(length(step_key) between 1 and 80),
  ordinal integer not null check(ordinal>=0),
  command_handle text not null check(length(command_handle) between 1 and 256),
  intent_id text not null unique references effect_intents(intent_id),
  payload_ref text not null unique references effect_command_payloads(payload_ref),
  linked_at timestamptz not null default clock_timestamp(),
  primary key(installation_namespace, workflow_id, step_key),
  unique(installation_namespace, workflow_id, ordinal),
  unique(installation_namespace, command_handle),
  foreign key(installation_namespace, workflow_id)
    references native_control_workflows(installation_namespace, workflow_id)
);
create index if not exists native_control_workflow_children_order_idx
  on native_control_workflow_children(installation_namespace, workflow_id, ordinal);
create or replace function reject_native_control_workflow_mutation_v1() returns trigger language plpgsql as $$
begin raise exception 'NATIVE_CONTROL_WORKFLOW_IMMUTABLE'; end $$;
drop trigger if exists native_control_workflow_v1_immutable on native_control_workflows;
create trigger native_control_workflow_v1_immutable before update or delete on native_control_workflows
  for each row execute function reject_native_control_workflow_mutation_v1();
drop trigger if exists native_control_workflow_child_v1_immutable on native_control_workflow_children;
create trigger native_control_workflow_child_v1_immutable before update or delete on native_control_workflow_children
  for each row execute function reject_native_control_workflow_mutation_v1();

-- Keep pre-A10.2 observations byte-for-byte as v1; new native-control terminal facts use v2.
alter table effect_observations add column if not exists observation_version text not null default 'effect-observation.v1';
alter table effect_observations drop constraint if exists effect_observation_version_check;
alter table effect_observations add constraint effect_observation_version_check
  check(observation_version in ('effect-observation.v1','effect-observation.v2'));
alter table effect_observations drop constraint if exists effect_observation_v2_owner_commit_check;
alter table effect_observations add constraint effect_observation_v2_owner_commit_check
  check(observation_version<>'effect-observation.v2' or
    evidence->>'certainty'<>'APPLIED' or evidence->>'layer' not like 'NATIVE_OWNER_%' or
    jsonb_typeof(evidence->'nativeOwnerCommit')='object');
create or replace function guard_effect_observation_version_v2() returns trigger language plpgsql as $$
declare contract text;
begin
  if new.observation_version='effect-observation.v2' then
    select contract_ref into contract from effect_attempts where attempt_id=new.attempt_id;
    if contract is distinct from 'yuvi.native-control.v1' then
      raise exception 'EFFECT_OBSERVATION_V2_REQUIRES_NATIVE_CONTROL';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists effect_observation_version_v2_owner on effect_observations;
create trigger effect_observation_version_v2_owner before insert on effect_observations
  for each row execute function guard_effect_observation_version_v2();
