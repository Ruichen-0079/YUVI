-- Bounded candidate resolution must remain a point lookup even for newly copied
-- scopes whose statistics lag. Cover state at the exact scope/generation/id key.
create index memory_projection_candidate_idx on memory_authority_projection_rows(scope,generation,id) include(state);
