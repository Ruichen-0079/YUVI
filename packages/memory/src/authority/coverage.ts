/** Selection is deterministic. A channel hit is candidate availability, never a
 * claim that its content entails an information need. Model grounding is scored separately. */
export function coverageSelection(
  ranked: string[],
  needs: Array<{ id: string; ranking: string[] }>,
  limit: number
) {
  const selected: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !selected.includes(id) && selected.length < limit) selected.push(id);
  };
  // One opportunity per need before any need gets a second slot. Shared evidence
  // can satisfy several candidate sets without occupying repeated context space.
  for (const need of needs) {
    if (!need.ranking.some((id) => selected.includes(id))) add(need.ranking[0]);
  }
  for (const need of needs) add(need.ranking.find((id) => !selected.includes(id)));
  for (const id of ranked) add(id);
  return selected;
}
