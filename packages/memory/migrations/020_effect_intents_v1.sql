-- One row is both the immutable admission decision and its durable work projection.
-- No ATTEMPT/OUTCOME or dispatcher is introduced here.
create table if not exists effect_intents (
  intent_id text primary key check(intent_id ~ '^ei1_[a-f0-9]{64}$'),
  logical_key text not null check(length(logical_key) between 1 and 512),
  contract_ref text not null check(contract_ref in ('yuvi.embodied-presentation.v1','yuvi.read-text.v1')),
  payload_digest text not null check(payload_digest ~ '^[a-f0-9]{64}$'),
  intent jsonb not null,
  state text not null check(state in ('ADMITTED','DENIED','CANCELED','EXPIRED')),
  work_state text null check(work_state in ('PENDING','CLAIMED','WITHHELD')),
  expires_at timestamptz not null,
  created_at timestamptz not null,
  unique(contract_ref,logical_key),
  check((intent->>'version'='effect-intent.v1' and intent->>'intentId'=intent_id and
    intent->>'logicalKey'=logical_key and intent->>'contractRef'=contract_ref and
    intent->>'payloadDigest'=payload_digest and
    (intent->'request'->>'expiresAt')::timestamptz=expires_at and
    (intent->>'createdAt')::timestamptz=created_at) is true),
  check((
    (intent->>'decision'='DENIED' and intent->>'state'='DENIED' and state='DENIED' and
      intent->'workState'='null'::jsonb and work_state is null and not (intent->'request' ? 'payload') and
      intent->>'reasonCode' is not null) or
    (intent->>'decision'='ADMITTED' and intent->>'state'='ADMITTED' and intent->>'workState'='PENDING' and
      intent->'request' ? 'payload' and intent->'reasonCode'='null'::jsonb and
      ((state='ADMITTED' and work_state in ('PENDING','CLAIMED')) or
       (state in ('CANCELED','EXPIRED') and work_state='WITHHELD')))
  ) is true)
);
create index if not exists effect_intents_pending_idx on effect_intents(created_at,intent_id)
  where state='ADMITTED' and work_state='PENDING';
create or replace function guard_effect_intent_v1() returns trigger language plpgsql as $$
begin
  if old.intent_id <> new.intent_id or old.logical_key <> new.logical_key or
    old.contract_ref <> new.contract_ref or old.payload_digest <> new.payload_digest or
    old.intent is distinct from new.intent or old.expires_at <> new.expires_at or old.created_at <> new.created_at then
    raise exception 'EFFECT_INTENT_IMMUTABLE';
  end if;
  if (old.state <> new.state or old.work_state is distinct from new.work_state) and not (
    old.state='ADMITTED' and old.work_state='PENDING' and
    ((new.state in ('CANCELED','EXPIRED') and new.work_state='WITHHELD') or
     (new.state='ADMITTED' and new.work_state='CLAIMED' and old.expires_at > clock_timestamp()))
  ) then raise exception 'EFFECT_INTENT_FENCE_REJECTED'; end if;
  return new;
end $$;
drop trigger if exists effect_intent_v1_immutable on effect_intents;
create trigger effect_intent_v1_immutable before update on effect_intents for each row execute function guard_effect_intent_v1();
-- A9.2 must create its first ATTEMPT and claim this same PENDING row in one transaction.
-- CLAIMED here is a reserved fence, not an ATTEMPT or evidence of any invocation.
