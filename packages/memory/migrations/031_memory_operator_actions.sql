create table if not exists memory_operator_actions (
 scope text not null,
 action_id text not null,
 operation text not null,
 actor text not null,
 request_digest text not null,
 result jsonb not null,
 committed_at timestamptz not null default now(),
 primary key(scope,action_id)
);
