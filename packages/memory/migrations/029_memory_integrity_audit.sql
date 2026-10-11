create table if not exists memory_authority_audits (
 scope text not null,
 audit_id text not null,
 anchor bigint not null,
 checkpoint bigint not null default 0,
 checked bigint not null default 0,
 issues bigint not null default 0,
 incomplete bigint not null default 0,
 status text not null check(status in ('RUNNING','VERIFIED','INCOMPLETE','FAILED','STALE')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(scope,audit_id)
);
create index if not exists memory_authority_audit_scope_idx on memory_authority_audits(scope,created_at desc,audit_id);
create table if not exists memory_authority_audit_issues (
 scope text not null,
 audit_id text not null,
 record_id text not null,
 code text not null,
 primary key(scope,audit_id,record_id,code),
 foreign key(scope,audit_id) references memory_authority_audits(scope,audit_id)
);
