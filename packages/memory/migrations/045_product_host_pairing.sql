-- Product pairing is an explicit local-controller ceremony, never inferred from HTTP/session IDs.
create table if not exists memory_product_pairings (
  code_hash text primary key,
  journal_namespace text not null,
  instance_id text not null,
  persona_id text not null,
  person_id text not null,
  person_revision text not null,
  web_origin text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists memory_product_hosts (
  grant_id text primary key references memory_host_grants(grant_id),
  web_origin text not null,
  renew_until timestamptz not null,
  memory_enabled boolean not null default true,
  created_at timestamptz not null default now()
);
-- Own-principal product pagination is filtered before LIMIT, including historical rows.
create index if not exists memory_authority_product_principal_idx
 on memory_authority_records(scope,(event->'lineage'->'authority'->'principal'->>'actorId'),version desc)
 where classification='GROUNDED';
