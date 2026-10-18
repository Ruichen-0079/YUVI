-- Derived, generation-scoped retrieval index. No authority/history changes.
create table memory_lexical_generations (
 scope text not null, generation bigint not null, checkpoint text not null default '',
 status text not null check(status in ('BUILDING','READY')),
 processed bigint not null default 0, actor text not null default 'projection-trigger', updated_at timestamptz not null default now(),
 primary key(scope,generation)
);
-- Existing generations are explicitly incomplete until bounded backfill finishes.
insert into memory_lexical_generations(scope,generation,status)
 select distinct scope,generation,'BUILDING' from memory_authority_projection_rows;
create table memory_lexical_postings (
 scope text not null,generation bigint not null,term text not null,id text not null,version bigint not null,
 primary key(scope,generation,term,id),
 foreign key(scope,generation,id) references memory_authority_projection_rows(scope,generation,id) on delete cascade
);
create index memory_lexical_rank_idx on memory_lexical_postings(scope,generation,term,version desc,id);
create index memory_lexical_record_idx on memory_lexical_postings(scope,generation,id);
-- Lexical fallback, not semantic admission. Keep original bigrams/identifiers;
-- additionally index Han characters so short paraphrases can share a token.
create function memory_lexical_terms_v1(document tsvector) returns text[] language sql immutable strict as $$
 with segments as (
  select (regexp_matches(word,'[㐀-䶿一-鿿]+|[^㐀-䶿一-鿿]+','g'))[1] word
  from unnest(tsvector_to_array(document)) word
 ) select coalesce(array_agg(distinct term),'{}'::text[]) from (
  select unnest(tsvector_to_array(document)) as term
  union all
  select word from segments
  union all
  select substr(word,n,1) from segments
   cross join lateral generate_series(1,char_length(word)) n
   where word ~ '^[㐀-䶿一-鿿]+$'
  union all
  select substr(word,n,2) from segments
   cross join lateral generate_series(1,char_length(word)-1) n
   where word ~ '^[㐀-䶿一-鿿]+$'
 ) tokens
$$;
create function maintain_memory_lexical_postings_v1() returns trigger language plpgsql as $$
begin
 if TG_OP='UPDATE' then
  delete from memory_lexical_postings where scope=old.scope and generation=old.generation and id=old.id;
 end if;
 insert into memory_lexical_generations(scope,generation,status) values(new.scope,new.generation,'READY') on conflict do nothing;
 if new.state in ('current','conflicted') then
  insert into memory_lexical_postings(scope,generation,term,id,version)
   select new.scope,new.generation,t,new.id,new.version from (
    select distinct unnest(memory_lexical_terms_v1(new.search) || string_to_array(
     (select search_terms from memory_authority_records where scope=new.scope and id=new.id),' ')) t
   ) tokens where t<>'';
 end if;
 return new;
end $$;
create trigger memory_lexical_projection_write after insert or update on memory_authority_projection_rows
 for each row execute function maintain_memory_lexical_postings_v1();
