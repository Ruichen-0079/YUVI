-- No backfill: historical episodes/jobs keep explicit gaps. Original Journal
-- receipts/selectors are resolved by the host before compression, never SQL guesses.
alter table recent_episodes add column if not exists source_evidence jsonb null;
alter table recent_episodes add column if not exists source_evidence_version text null;
alter table recent_episodes add column if not exists source_evidence_digest text null;
alter table recent_episodes add column if not exists source_coverage_state text null;
alter table dream_jobs add column if not exists source_snapshot jsonb null;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'recent_episodes'::regclass and conname = 'recent_episodes_source_evidence_v1') then
    alter table recent_episodes add constraint recent_episodes_source_evidence_v1 check (
      (source_evidence is null and source_evidence_version is null and source_evidence_digest is null and (source_coverage_state is null or source_coverage_state = 'LEGACY_INCOMPLETE')) or
      (source_evidence is not null and source_evidence_version is not null and source_evidence_digest is not null and source_coverage_state is not null and source_evidence_version = 'episode-source-evidence.v1' and source_evidence->>'version' = source_evidence_version and jsonb_typeof(source_evidence->'statements') = 'array' and source_evidence_digest ~ '^[a-f0-9]{64}$' and source_coverage_state in ('GROUNDED','PARTIAL','LEGACY_INCOMPLETE'))
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'dream_jobs'::regclass and conname = 'dream_jobs_source_snapshot_v1') then
    alter table dream_jobs add constraint dream_jobs_source_snapshot_v1 check (
      source_snapshot is null or (source_snapshot->>'version' is not null and source_snapshot->>'version' = 'dream-source-snapshot.v1' and source_snapshot->>'policyVersion' is not null and source_snapshot->>'policyVersion' = 'a10.1e-deterministic-dream.v1' and source_snapshot->'episodes' is not null and jsonb_typeof(source_snapshot->'episodes') = 'array')
    );
  end if;
end $$;
