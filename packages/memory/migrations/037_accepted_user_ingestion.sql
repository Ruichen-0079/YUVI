-- An ingestion source no longer implies that an assistant reply exists.
-- Old finalized assistant decisions remain unchanged; no historical user opt-in is inferred.
alter table finalized_ingestion_turns alter column assistant_message_id drop not null;
create index conversation_messages_accepted_ingestion_discovery_idx
  on conversation_messages (persona_id, completed_at, finalized_turn_id)
  where role='user' and status='completed' and ingestion_requested=true;

-- Freeze semantic interpretation material before the remote call; retries use the same snapshot.
alter table memory_semantic_jobs add column input_context jsonb not null default '[]'::jsonb;
alter table finalized_ingestion_turns add column rejected_propositions jsonb not null default '[]'::jsonb
  check (jsonb_typeof(rejected_propositions)='array' and jsonb_array_length(rejected_propositions)<=12);
