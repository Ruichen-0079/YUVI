create table if not exists memory_host_principals (
 journal_namespace text not null, instance_id text not null, persona_id text not null,
 person_id text not null, actor_id text not null,
 primary key(journal_namespace,instance_id,persona_id,person_id),
 unique(journal_namespace,actor_id)
);
-- Host-issued credentials bind a transport principal to an existing Person and Character.
-- Token plaintext is returned once; neither requests nor conversational DTOs create bindings.
create table if not exists memory_host_grants (
 grant_id text primary key,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 journal_namespace text not null,
 instance_id text not null,
 persona_id text not null,
 person_id text not null,
 person_revision text not null,
 actor_id text not null,
 granted_at timestamptz not null default now(),
 expires_at timestamptz not null,
 revoked_at timestamptz
);
create table if not exists memory_host_sessions (
 journal_namespace text not null,
 persona_id text not null,
 session_id text not null,
 actor_id text,
 person_id text,
 created_at timestamptz not null default now(),
 primary key(journal_namespace,session_id),
 check((actor_id is null) = (person_id is null))
);
create index if not exists memory_host_grants_owner_idx on memory_host_grants(journal_namespace,persona_id,granted_at desc,grant_id);

create unique index if not exists memory_host_session_global_idx on memory_host_sessions(session_id);
