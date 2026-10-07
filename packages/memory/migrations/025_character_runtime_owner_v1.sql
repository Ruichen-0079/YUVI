-- A private repository view has one durable Character owner. No Memory is shared.
-- Legacy primary installations adopt their existing bytes without changing scopes.
create table if not exists character_runtime_owner (
  singleton boolean primary key default true check (singleton),
  owner jsonb not null check (
    owner->>'version' = '1' and
    length(owner->>'instanceId') > 0 and
    length(owner->>'definitionId') > 0
  ),
  created_at timestamptz not null default now()
);
