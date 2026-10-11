-- NULL means older evidence cannot prove whether its bounded candidate snapshot was complete.
alter table memory_retrieval_runs add column if not exists candidate_count integer check(candidate_count>=0);
alter table memory_retrieval_runs add column if not exists candidate_evidence_limited boolean;
