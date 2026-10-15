-- The retention projection may only move from retained payload to an erased tombstone.
-- Source/action/owner/digest/expiry cannot be rewritten by an accidental UPDATE.
create function guard_retained_observation_update_v1() returns trigger language plpgsql as $$
begin
  if (to_jsonb(old) - array['evidence','image_bytes','erased_at','erased_by_source']) is distinct from
     (to_jsonb(new) - array['evidence','image_bytes','erased_at','erased_by_source']) then
    raise exception 'OBSERVATION_PROVENANCE_IMMUTABLE';
  end if;
  if old.erased_at is not null and to_jsonb(old) is distinct from to_jsonb(new) then
    raise exception 'OBSERVATION_ERASURE_IMMUTABLE';
  end if;
  if (new.evidence is distinct from old.evidence or new.image_bytes is distinct from old.image_bytes or
      new.erased_at is distinct from old.erased_at or new.erased_by_source is distinct from old.erased_by_source) and
      (new.erased_at is null or new.evidence is not null or new.image_bytes is not null) then
    raise exception 'OBSERVATION_ERASURE_REQUIRED';
  end if;
  return new;
end $$;
create trigger retained_observation_update_guard before update on retained_observations
  for each row execute function guard_retained_observation_update_v1();
