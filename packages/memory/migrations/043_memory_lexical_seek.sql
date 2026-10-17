-- A single exact access key prevents a new/small scope's stale statistics from
-- choosing the per-record cleanup index and sorting all of that scope's postings.
create index memory_lexical_seek_idx on memory_lexical_postings
 ((scope || chr(31) || generation::text || chr(31) || term),version desc,id);
drop index memory_lexical_rank_idx;
