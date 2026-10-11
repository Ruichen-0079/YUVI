create table if not exists memory_decision_reassessments (
 scope text not null,
 logical_key text not null,
 original_digest text not null,
 generation int not null default 0 check(generation between 0 and 3),
 status text not null check(status in ('pending','processing','complete','retryable_failed','terminal_failed')),
 lease_owner text,
 lease_until timestamptz,
 resolved_key text,
 resolved_digest text,
 resolved_event_id text,
 error_code text,
 updated_at timestamptz not null default now(),
 primary key(scope,logical_key)
);
