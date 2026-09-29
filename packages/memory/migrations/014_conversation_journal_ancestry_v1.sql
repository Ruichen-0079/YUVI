alter table conversation_messages
  add column if not exists source_journal_ref jsonb null;
