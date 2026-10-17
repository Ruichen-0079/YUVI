-- Retrieval-only derivatives, no authority/lineage changes or historic rewrite.
-- Existing runs remain explicitly without a semantic query-plan contract.
alter table memory_retrieval_runs add column query_plan jsonb null
 check(query_plan is null or (jsonb_typeof(query_plan)='object' and octet_length(query_plan::text)<=98304));
