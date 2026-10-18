import { PostgresMemoryAuthority } from "./store.js";
import { canonicalScope, MemoryAuthorityError } from "./types.js";

/** One transactional keyset batch, not another worker/queue. New writes and shadow
 * projections use the same SQL trigger; incomplete legacy indexes never hide data. */
export async function advanceLexicalIndex(
  authority: PostgresMemoryAuthority,
  scope: string,
  limit = 500,
  actor = "explicit-maintenance-caller"
) {
  canonicalScope(scope);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new MemoryAuthorityError("MEMORY_LEXICAL_BATCH_BOUND");
  return authority.transaction(async (tx) => {
    const owner = (
      await tx.query(
        "select projection_generation from memory_authority_scopes where scope=$1 for update",
        [scope]
      )
    ).rows[0];
    if (!owner) throw new MemoryAuthorityError("MEMORY_SCOPE_MISSING");
    const generation = owner["projection_generation"];
    const state = (
      await tx.query(
        "select * from memory_lexical_generations where scope=$1 and generation=$2 for update",
        [scope, generation]
      )
    ).rows[0];
    if (state?.["status"] === "READY") return progress(state);
    if (!state) throw new MemoryAuthorityError("MEMORY_LEXICAL_INDEX_MISSING");
    const rows = (
      await tx.query(
        `select id from memory_authority_projection_rows where scope=$1 and generation=$2 and id>$3 order by id limit $4`,
        [scope, generation, state["checkpoint"], limit]
      )
    ).rows;
    const ids = rows.map((r) => r["id"]);
    if (ids.length) {
      await tx.query(
        "delete from memory_lexical_postings where scope=$1 and generation=$2 and id=any($3::text[])",
        [scope, generation, ids]
      );
      await tx.query(
        `insert into memory_lexical_postings(scope,generation,term,id,version)
       select c.scope,c.generation,t,c.id,c.version from memory_authority_projection_rows c
       join memory_authority_records r on r.scope=c.scope and r.id=c.id
       cross join lateral (select distinct unnest(memory_lexical_terms_v1(c.search) || string_to_array(r.search_terms,' ')) t) tokens
       where c.scope=$1 and c.generation=$2 and c.id=any($3::text[]) and c.state in ('current','conflicted') and t<>''
       on conflict(scope,generation,term,id) do update set version=excluded.version`,
        [scope, generation, ids]
      );
    }
    return progress(
      (
        await tx.query(
          `update memory_lexical_generations set checkpoint=$3,processed=processed+$4,status=$5,actor=$6,updated_at=now()
       where scope=$1 and generation=$2 returning *`,
          [
            scope,
            generation,
            ids.at(-1) ?? state["checkpoint"],
            ids.length,
            ids.length < limit ? "READY" : "BUILDING",
            actor
          ]
        )
      ).rows[0]!
    );
  });
}

/** Explicit operator recovery. Repeated starts during BUILDING preserve the
 * checkpoint. History and current knowledge are not changed. */
export async function rebuildLexicalIndex(
  authority: PostgresMemoryAuthority,
  scope: string,
  actor: string
) {
  canonicalScope(scope);
  return authority.transaction(async (tx) => {
    const owner = (
      await tx.query(
        "select projection_generation from memory_authority_scopes where scope=$1 for update",
        [scope]
      )
    ).rows[0];
    if (!owner) throw new MemoryAuthorityError("MEMORY_SCOPE_MISSING");
    const state =
      (
        await tx.query(
          "update memory_lexical_generations set status='BUILDING',checkpoint='',processed=0,actor=$3,updated_at=now() where scope=$1 and generation=$2 and status='READY' returning *",
          [scope, owner["projection_generation"], actor]
        )
      ).rows[0] ??
      (
        await tx.query(
          "select * from memory_lexical_generations where scope=$1 and generation=$2",
          [scope, owner["projection_generation"]]
        )
      ).rows[0];
    if (!state) throw new MemoryAuthorityError("MEMORY_LEXICAL_INDEX_MISSING");
    return progress(state);
  });
}

/** Bounded comparison with the current projection, not a full-scope certificate.
 * Detected drift disables the index until formal backfill repairs every record. */
export async function verifyLexicalIndex(
  authority: PostgresMemoryAuthority,
  scope: string,
  after = "",
  limit = 100,
  actor = "explicit-maintenance-caller"
) {
  canonicalScope(scope);
  if (after.length > 1024 || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new MemoryAuthorityError("MEMORY_LEXICAL_BATCH_BOUND");
  return authority.transaction(async (tx) => {
    const owner = (
      await tx.query(
        "select projection_generation,version from memory_authority_scopes where scope=$1 for update",
        [scope]
      )
    ).rows[0];
    if (!owner) throw new MemoryAuthorityError("MEMORY_SCOPE_MISSING");
    const rows = (
      await tx.query(
        `with batch as materialized (
   select c.* from memory_authority_projection_rows c where scope=$1 and generation=$2 and id>$3 order by id limit $4::int+1
  ) select b.id,b.version,
   case when b.state in ('current','conflicted') then array(select distinct t from unnest(memory_lexical_terms_v1(b.search)||string_to_array(r.search_terms,' ')) t where t<>'' order by t) else '{}'::text[] end expected,
   array(select term from memory_lexical_postings p where p.scope=$1 and p.generation=$2 and p.id=b.id order by term) actual,
   exists(select 1 from memory_lexical_postings p where p.scope=$1 and p.generation=$2 and p.id=b.id and p.version<>b.version) stale
   from batch b join memory_authority_records r on r.scope=$1 and r.id=b.id order by b.id`,
        [scope, owner["projection_generation"], after, limit]
      )
    ).rows;
    const checked = rows.slice(0, limit),
      mismatches = checked
        .filter((r) => r["stale"] || JSON.stringify(r["expected"]) !== JSON.stringify(r["actual"]))
        .map((r) => String(r["id"]));
    if (mismatches.length)
      await tx.query(
        "update memory_lexical_generations set status='BUILDING',checkpoint='',processed=0,actor=$3,updated_at=now() where scope=$1 and generation=$2",
        [scope, owner["projection_generation"], actor]
      );
    return {
      schema: "memory.lexical-verification.v1" as const,
      status: mismatches.length ? ("MISMATCH" as const) : ("VERIFIED_BATCH" as const),
      version: String(owner["version"]),
      generation: String(owner["projection_generation"]),
      checked: checked.length,
      mismatches,
      nextCursor: rows.length > limit ? String(checked.at(-1)!["id"]) : null
    };
  });
}
function progress(row: Record<string, unknown>) {
  return {
    status: String(row["status"]),
    generation: String(row["generation"]),
    checkpoint: String(row["checkpoint"]),
    processed: String(row["processed"]),
    actor: String(row["actor"]),
    updatedAt: new Date(String(row["updated_at"])).toISOString()
  };
}

/** Same normalization as existing bigrams, plus bounded Han unigrams. */
export function lexicalQueryTerms(
  terms: string[],
  limit = 32
): Array<{ term: string; weight: number }> {
  const values = new Map<string, number>();
  for (const term of terms)
    values.set(term, /^\p{Script=Han}$/u.test(term) ? 0.2 : /[\p{N}_-]/u.test(term) ? 4 : 1);
  for (const term of terms)
    if (/^\p{Script=Han}+$/u.test(term))
      for (const char of term) if (!values.has(char)) values.set(char, 0.2);
  return [...values].slice(0, limit).map(([term, weight]) => ({ term, weight }));
}
