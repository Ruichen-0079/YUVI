-- A9.3 persists each Runtime-projected nonempty text delta before it can be
-- yielded. conversation_messages remains the read projection of components.
create table if not exists conversation_reply_components (
  component_id text primary key check(component_id ~ '^rc1_[a-f0-9]{64}$'),
  reply_id text not null check(length(reply_id) between 1 and 512),
  message_id text not null references conversation_messages(id),
  sequence bigint not null check(sequence > 0),
  text_content text not null check(length(text_content) > 0),
  text_digest text not null check(text_digest ~ '^[a-f0-9]{64}$'),
  projection_version text not null check(length(projection_version) between 1 and 128),
  created_at timestamptz not null default clock_timestamp(),
  unique(reply_id, sequence),
  unique(message_id, sequence)
);

create index if not exists conversation_reply_components_message_idx
  on conversation_reply_components(message_id, sequence);

create or replace function reject_conversation_reply_component_mutation_v1()
returns trigger language plpgsql as $$
begin
  raise exception 'CONVERSATION_REPLY_COMPONENT_IMMUTABLE';
end $$;

drop trigger if exists conversation_reply_component_v1_immutable
  on conversation_reply_components;
create trigger conversation_reply_component_v1_immutable
  before update or delete on conversation_reply_components
  for each row execute function reject_conversation_reply_component_mutation_v1();

-- Canonical A9 contracts. Domain descriptors never constitute another dispatch ledger.
alter table effect_intents drop constraint if exists effect_intents_contract_ref_check;
alter table effect_intents add constraint effect_intents_contract_ref_check check(contract_ref in (
 'yuvi.embodied-presentation.v1','yuvi.read-text.v1','yuvi.native-control.v1',
 'yuvi.provider.v1','yuvi.publication.v1','yuvi.playback.v1'));
alter table effect_observations add column if not exists category text not null default 'TERMINAL';
alter table effect_observations add column if not exists fact_key text null;
-- Replace the original terminal-only certainty check, leaving digest/identity checks intact.
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='effect_observations'::regclass
 and contype='c' and pg_get_constraintdef(oid) like '%certainty%' loop
 execute format('alter table effect_observations drop constraint %I',c.conname); end loop;
end $$;
alter table effect_observations drop constraint if exists effect_observation_category_v2;
alter table effect_observations add constraint effect_observation_category_v2 check(
 (category='TERMINAL' and fact_key is null and evidence->>'certainty' in ('APPLIED','DEFINITIVE_REJECTION','PROVEN_NOT_APPLIED','UNKNOWN')) or
 (category='PROGRESS' and observation_version='effect-observation.v2' and length(fact_key) between 1 and 512 and
 not(evidence ? 'certainty') and evidence->>'factKey'=fact_key));
create unique index if not exists effect_progress_fact_key_v2 on effect_observations(attempt_id,fact_key) where category='PROGRESS';
create or replace function guard_effect_observation_version_v2() returns trigger language plpgsql as $$
begin
 if new.category='PROGRESS' and new.observation_version<>'effect-observation.v2' then
 raise exception 'EFFECT_PROGRESS_REQUIRES_V2'; end if;
 return new;
end $$;
-- Existing projection guard must select terminal certainty, never a later progress fact.
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
   where a.intent_id=old.intent_id and o.category='TERMINAL' order by a.ordinal desc,o.observation_id desc limit 1)='PROVEN_NOT_APPLIED'))) then
 raise exception 'EFFECT_DISPOSITION_IMMUTABLE'; end if;
 return new;
end $$;

-- Bounded media projections: immutable decisions and result descriptors only.
-- No lifecycle/status/dispatch authority is stored outside canonical A9.
create table if not exists reply_speech_plans (
 reply_id text primary key, request_id text null, plan text not null check(plan in ('NONE','CLIENT_SEGMENTED','SERVER_WHOLE')),
 created_at timestamptz not null default clock_timestamp()
);
alter table reply_speech_plans add column if not exists request_id text;

create table if not exists speech_segment_descriptors (
 segment_id text primary key, reply_id text not null references reply_speech_plans(reply_id),
 sequence bigint not null check(sequence>0), descriptor jsonb not null,
 descriptor_digest text not null, spoken_digest text not null,
 cause jsonb not null, created_at timestamptz not null default clock_timestamp(),
 unique(reply_id,sequence)
);
create table if not exists speech_audio_results (
 segment_id text primary key references speech_segment_descriptors(segment_id),
 provider_attempt_id text references effect_attempts(attempt_id),
 audio_digest text not null, mime_type text not null, byte_count bigint not null,
 availability_reference text not null, created_at timestamptz not null default clock_timestamp()
);
create or replace function reject_media_descriptor_mutation_v1() returns trigger language plpgsql as $$
begin raise exception 'MEDIA_DESCRIPTOR_IMMUTABLE'; end $$;
drop trigger if exists reply_speech_plan_immutable on reply_speech_plans;
create trigger reply_speech_plan_immutable before update or delete on reply_speech_plans
 for each row execute function reject_media_descriptor_mutation_v1();
drop trigger if exists speech_segment_descriptor_immutable on speech_segment_descriptors;
create trigger speech_segment_descriptor_immutable before update or delete on speech_segment_descriptors
 for each row execute function reject_media_descriptor_mutation_v1();
drop trigger if exists speech_audio_result_immutable on speech_audio_results;
create trigger speech_audio_result_immutable before update or delete on speech_audio_results
 for each row execute function reject_media_descriptor_mutation_v1();
alter table conversation_reply_components add column if not exists source_attempt_id text references effect_attempts(attempt_id);

-- Existing presentation v1 payloads stay immutable; this is an exposure descriptor only.
create table if not exists effect_input_exposures (
 intent_id text primary key references effect_intents(intent_id), descriptor jsonb not null
);
drop trigger if exists effect_input_exposures_immutable on effect_input_exposures;
create trigger effect_input_exposures_immutable before update or delete on effect_input_exposures
 for each row execute function reject_media_descriptor_mutation_v1();

-- Final seals bind the retained component prefix. They are conversation evidence,
-- not another effect outcome or delivery state machine.
create table if not exists conversation_reply_seals (
 reply_id text primary key, message_id text not null references conversation_messages(id),
 last_sequence bigint not null, prefix_digest text not null, content_digest text not null,
 outcome text not null check(outcome in ('completed','failed','cancelled')),
 created_at timestamptz not null default clock_timestamp()
);
drop trigger if exists conversation_reply_seal_immutable on conversation_reply_seals;
create trigger conversation_reply_seal_immutable before update or delete on conversation_reply_seals
 for each row execute function reject_media_descriptor_mutation_v1();
create or replace function seal_conversation_component_prefix_v1() returns trigger language plpgsql as $$
declare rid text; body text; last_seq bigint; prefix jsonb;
begin
 select min(reply_id),string_agg(text_content,'' order by sequence),max(sequence),
 jsonb_agg(jsonb_build_array(component_id,sequence::text,text_digest) order by sequence)
 into rid,body,last_seq,prefix from conversation_reply_components where message_id=new.id;
 if rid is null then return new; end if;
 if body<>new.content then raise exception 'CONVERSATION_COMPONENT_PROJECTION_CONFLICT'; end if;
 if new.status in ('completed','failed','cancelled') and old.status='streaming' then
  insert into conversation_reply_seals(reply_id,message_id,last_sequence,prefix_digest,content_digest,outcome)
  values(rid,new.id,last_seq,encode(sha256(convert_to(prefix::text,'UTF8')),'hex'),
   encode(sha256(convert_to(new.content,'UTF8')),'hex'),new.status);
 end if;
 return new;
end $$;
drop trigger if exists conversation_component_prefix_guard on conversation_messages;
create trigger conversation_component_prefix_guard after update of content,status on conversation_messages
 for each row execute function seal_conversation_component_prefix_v1();
