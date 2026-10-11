create table if not exists memory_retrieval_runs (
 scope text not null,
 retrieval_id text not null,
 trace_id text not null,
 session_id text,
 source_ref jsonb,
 reader jsonb not null,
 query text not null,
 status text not null,
 error_code text,
 limited boolean not null,
 watermark bigint not null,
 model_tag text,
 candidates jsonb not null,
 created_at timestamptz not null default now(),
 primary key(scope,retrieval_id)
);
create index if not exists memory_retrieval_trace_idx on memory_retrieval_runs(scope,trace_id,created_at desc,retrieval_id);
create index if not exists memory_retrieval_page_idx on memory_retrieval_runs(scope,created_at desc,retrieval_id);
create table if not exists memory_retrieval_contexts (
 scope text not null,
 retrieval_id text not null,
 manifest_id text not null references context_use_manifests(manifest_id),
 exposure_id text not null references context_use_exposures(exposure_id),
 consumer_operation text not null,
 memory_blocks jsonb not null,
 exposure jsonb not null,
 created_at timestamptz not null default now(),
 primary key(scope,retrieval_id,exposure_id),
 foreign key(scope,retrieval_id) references memory_retrieval_runs(scope,retrieval_id)
);
