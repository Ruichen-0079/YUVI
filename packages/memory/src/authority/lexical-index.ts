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
    if (ids.length)
      await tx.query(
        `insert into memory_lexical_postings(scope,generation,term,id,version)
       select c.scope,c.generation,t,c.id,c.version from memory_authority_projection_rows c
       join memory_authority_records r on r.scope=c.scope and r.id=c.id
       cross join lateral (select distinct unnest(memory_lexical_terms_v1(c.search) || string_to_array(r.search_terms,' ')) t) tokens
       where c.scope=$1 and c.generation=$2 and c.id=any($3::text[]) and c.state in ('current','conflicted') and t<>''
       on conflict(scope,generation,term,id) do update set version=excluded.version`,
        [scope, generation, ids]
      );
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
export function lexicalQueryTerms(terms: string[]): Array<{ term: string; weight: number }> {
  const values = new Map<string, number>();
  for (const term of terms)
    values.set(term, /^\p{Script=Han}$/u.test(term) ? 0.2 : /[\p{N}_-]/u.test(term) ? 4 : 1);
  for (const term of terms)
    if (/^\p{Script=Han}+$/u.test(term))
      for (const char of term) if (!values.has(char)) values.set(char, 0.2);
  return [...values].slice(0, 32).map(([term, weight]) => ({ term, weight }));
}
