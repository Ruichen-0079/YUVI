-- Indexed linkage to A9 outcomes. Product evidence never scans all effect intents.
create index memory_context_snapshot_effect_idx on effect_intents((intent->'request'->'payload'->'inputSnapshot'->'manifest'->>'exposureId')) where intent->'request'->'payload'->'inputSnapshot'->'manifest'->>'exposureId' is not null;
create index memory_context_direct_effect_idx on effect_intents((intent->'request'->'payload'->'contextUse'->>'exposureId')) where intent->'request'->'payload'->'contextUse'->>'exposureId' is not null;
