-- A8.2a: durable Journal store schema. This stores committed envelopes and only
-- explicitly retained TEXT payloads; it does not wire ingress or dispatch effects.

create table if not exists journal_namespaces (
  journal_namespace text primary key check (length(journal_namespace) between 1 and 512),
  current_seq bigint not null default 0 check (current_seq >= 0)
);

create table if not exists journal_events (
  journal_namespace text not null references journal_namespaces(journal_namespace),
  event_id text not null check (event_id ~ '^jev1_[A-Za-z0-9_-]{16,}$'),
  commit_seq bigint not null check (commit_seq > 0),
  recorded_at timestamptz not null,
  envelope jsonb not null check (
    jsonb_typeof(envelope) = 'object'
    and envelope ?& array['journalNamespace', 'eventId', 'commitSeq']
    and (envelope->>'journalNamespace') is not distinct from journal_namespace
    and (envelope->>'eventId') is not distinct from event_id
    and (envelope->>'commitSeq')::bigint is not distinct from commit_seq
  ),
  primary key (journal_namespace, event_id),
  unique (journal_namespace, commit_seq)
);

create table if not exists journal_event_parents (
  journal_namespace text not null,
  event_id text not null,
  parent_event_id text not null,
  primary key (journal_namespace, event_id, parent_event_id),
  check (event_id <> parent_event_id),
  foreign key (journal_namespace, event_id)
    references journal_events(journal_namespace, event_id),
  foreign key (journal_namespace, parent_event_id)
    references journal_events(journal_namespace, event_id)
);

create index if not exists journal_event_parents_parent_idx
  on journal_event_parents (journal_namespace, parent_event_id);

create table if not exists journal_payloads (
  journal_namespace text not null,
  payload_namespace text not null check (length(payload_namespace) between 1 and 512),
  payload_id text not null check (length(payload_id) between 1 and 512),
  payload_version text not null check (length(payload_version) between 1 and 512),
  modality text not null check (modality in ('TEXT', 'AUDIO', 'IMAGE', 'JSON', 'TOOL_RESULT')),
  retention text not null check (retention in ('RETAINED', 'REDACTED', 'NOT_RETAINED', 'UNAVAILABLE')),
  descriptor jsonb not null check (jsonb_typeof(descriptor) = 'object'),
  text_content text null,
  content_sha256 text null check (content_sha256 is null or content_sha256 ~ '^[a-f0-9]{64}$'),
  event_id text not null,
  primary key (journal_namespace, payload_namespace, payload_id, payload_version),
  foreign key (journal_namespace, event_id)
    references journal_events(journal_namespace, event_id),
  check (
    (text_content is null and content_sha256 is null)
    or (modality = 'TEXT' and retention = 'RETAINED' and text_content is not null and content_sha256 is not null)
  ),
  check (
    descriptor->'ref'->>'namespace' is not distinct from payload_namespace
    and descriptor->'ref'->>'payloadId' is not distinct from payload_id
    and descriptor->'ref'->>'version' is not distinct from payload_version
    and descriptor->>'modality' is not distinct from modality
    and descriptor->>'retention' is not distinct from retention
  )
);

create table if not exists journal_source_dedup (
  journal_namespace text not null,
  source_namespace text not null check (length(source_namespace) between 1 and 512),
  source_key text not null check (length(source_key) between 1 and 512),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  event_id text not null,
  primary key (journal_namespace, source_namespace, source_key),
  foreign key (journal_namespace, event_id)
    references journal_events(journal_namespace, event_id)
);
