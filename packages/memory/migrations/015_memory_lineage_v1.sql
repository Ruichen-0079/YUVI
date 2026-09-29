alter table memories
  add column if not exists memory_lineage jsonb null,
  add column if not exists lineage_consumer_key text null,
  add column if not exists lineage_payload_digest text null,
  add column if not exists evidence_classification text null;

alter table memories
  drop constraint if exists memories_evidence_classification_check;

alter table memories
  add constraint memories_evidence_classification_check
  check (evidence_classification is null or evidence_classification = 'NON_EVIDENCE');

alter table memories
  drop constraint if exists memories_lineage_storage_contract_check;

alter table memories
  add constraint memories_lineage_storage_contract_check
  check (
    (
      memory_lineage is null
      and lineage_consumer_key is null
      and lineage_payload_digest is null
    )
    or (
      jsonb_typeof(memory_lineage) = 'object'
      and memory_lineage->>'version' = 'memory-lineage.v1'
      and memory_lineage->>'state' = 'GROUNDED'
      and memory_lineage->>'consumerKey' = lineage_consumer_key
      and lineage_consumer_key is not null
      and lineage_payload_digest is not null
      and lineage_payload_digest ~ '^[a-f0-9]{64}$'
      and evidence_classification is null
    )
  );

create unique index if not exists memories_lineage_consumer_key_unique_idx
  on memories (lineage_consumer_key)
  where lineage_consumer_key is not null;
