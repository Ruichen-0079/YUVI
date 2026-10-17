import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { applySqlMigrations, readSqlMigrations } from "../migrations.js";
import { finalizedTestResolver, finalizedTestParent } from "../finalized-test-fixture.js";
import { freezeFinalizedMemoryEvent } from "../finalized-memory-lineage.js";
import { lineageDigest, canonicalLineageJson } from "../lineage-encoding.js";
import { PostgresMemoryAuthority } from "./store.js";
import { PostgresMemoryProvider } from "./provider.js";
import { advanceLexicalIndex } from "./lexical-index.js";
import { MemoryProjectionRebuild } from "./projection-rebuild.js";
const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"],
  schema = "composition_test_" + randomUUID().replaceAll("-", "");
const admin = new pg.Pool({ connectionString: url }),
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
const authority = new PostgresMemoryAuthority(pool),
  ids = new Map<string, string>();
const scope = "yuvi:v1:user:composition-person:character:composition-persona",
  access = {
    principal: { namespace: "composition-test", actorId: "actor" },
    personId: "composition-person"
  };
let data: any;
async function write(f: any) {
  const original = await finalizedTestResolver.resolve({
    sourceJournalRef: finalizedTestParent,
    sourceText: f.text
  });
  const source: any = {
    ...original,
    recordedAt: new Date().toISOString(),
    authority: {
      principal: { state: "RESOLVED", kind: "PRINCIPAL", ...access.principal },
      binding: {
        state: "RESOLVED",
        kind: "PERSON_BINDING",
        personId: access.personId,
        bindingVersion: "1"
      },
      audience: { kind: "PRIVATE", channelRef: "composition-private" }
    }
  };
  const event = freezeFinalizedMemoryEvent(
    source,
    {
      scope,
      kind: "fact",
      content: f.text,
      ...Object.fromEntries(
        ["supersedes", "conflicts", "supports"].filter((k) => f[k]).map((k) => [k, [ids.get(f[k])]])
      )
    },
    "composition-test"
  );
  const input = {
    ...event,
    idempotencyKey: randomUUID(),
    payloadDigest: lineageDigest(canonicalLineageJson(event))
  };
  await authority.prepare("FINALIZED_INGESTION", input);
  const result = await authority.commit(input);
  ids.set(f.key, result.event.id);
  return result.event.id;
}
describe.skipIf(!url)(
  "frozen compositional selection through the production PostgreSQL provider",
  () => {
    beforeAll(async () => {
      await admin.query(`create schema ${schema}`);
      await applySqlMigrations(pool, await readSqlMigrations());
      data = JSON.parse(
        await readFile(
          new URL(
            "../../../../docs/research/compositional-retrieval/experiments/ground-truth.json",
            import.meta.url
          ),
          "utf8"
        )
      );
      for (const f of data.facts) if (!f.person && !f.persona) await write(f);
      for (let n = 0; n < data.distractors.count; n++)
        await write({
          key: "noise" + n,
          text: data.distractors.template.replace("{n}", String(n))
        });
    }, 30000);
    afterAll(async () => {
      await pool.end();
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    });
    it("gives each grounded need a slot, including holdout combinations, without admitting historical/support duplicates", async () => {
      for (const c of data.cases) {
        const p = new PostgresMemoryProvider(authority, undefined, async () => ({
          queries: [],
          needs: c.needs.map((n: any, i: number) => ({
            id: "n" + i,
            quote: n.quote,
            queries: n.queries
          })),
          model: "protocol-fixture",
          usage: null
        }));
      const r = await p.retrieveRelevant({ scope, access, text: c.query, limit: 5 }),
          selected = r.events.map((e) => e.id);
        for (const n of c.needs)
          for (const k of n.keys) expect(selected, c.id + " " + k).toContain(ids.get(k));
        expect(selected).not.toContain(ids.get("editor-old"));
        expect(selected).not.toContain(ids.get("support-tea"));
        const audit = await p.retrievalEvidence.detail(scope, r.retrievalId!);
        expect(audit?.queryPlan?.coverage).toHaveLength(c.needs.length);
      }
    });
    it("invalid demand provenance cannot displace the original authorized query", async () => {
      const p = new PostgresMemoryProvider(authority, undefined, async () => ({
        queries: [],
        needs: [{ id: "invented", quote: "not in source", queries: ["private fact"] }],
        model: "fixture",
        usage: null
      }));
      const r = await p.retrieveRelevant({ scope, access, text: "露川-4A87 编辑器" });
      expect(r.status).toBe("partial");
      expect(r.limitReason).toBe("MEMORY_QUERY_PLAN_UNAVAILABLE");
      expect(r.events.map((e) => e.id)).toContain(ids.get("editor"));
      expect(r.coverage).toBeUndefined();
    });
    it("incomplete backfill is visible, restartable, idempotent and includes concurrent new writes", async () => {
      const g = (
        await pool.query(
          "select projection_generation from memory_authority_scopes where scope=$1",
          [scope]
        )
      ).rows[0]!.projection_generation;
      await pool.query("delete from memory_lexical_postings where scope=$1 and generation=$2", [
        scope,
        g
      ]);
      await pool.query(
        "update memory_lexical_generations set status='BUILDING',checkpoint='' where scope=$1 and generation=$2",
        [scope, g]
      );
      const p = new PostgresMemoryProvider(authority);
      const before = await p.retrieveRelevant({ scope, access, text: "编辑器" });
      expect(before.limitReason).toBe("MEMORY_LEXICAL_INDEX_PENDING");
      expect(before.events.map((e) => e.id)).toContain(ids.get("editor"));
      await advanceLexicalIndex(authority, scope, 10);
      const later = await write({ key: "late", text: "新到达的航班编号是FLIGHT-628。" });
      let s;
      do {
        s = await advanceLexicalIndex(authority, scope, 17);
      } while (s.status !== "READY");
      const after = await p.retrieveRelevant({ scope, access, text: "FLIGHT-628" });
      expect(after.events.map((e) => e.id)).toContain(later);
      const count = (
        await pool.query("select count(*) from memory_lexical_postings where scope=$1", [scope])
      ).rows[0]!.count;
      await advanceLexicalIndex(authority, scope, 17);
      expect(
        (await pool.query("select count(*) from memory_lexical_postings where scope=$1", [scope]))
          .rows[0]!.count
      ).toBe(count);
    });
    it("shadow generation rebuild and current correction update the same lexical index", async () => {
      const rebuild = new MemoryProjectionRebuild(authority);
      await rebuild.start(scope, "lexical-shadow", "test-operator");
      let s;
      do {
        s = await rebuild.advance(scope, "lexical-shadow", 30);
      } while (s.status !== "ACTIVE");
      const old = ids.get("tea")!;
      const next = await write({
        key: "tea-new",
        text: "茶叶偏好现在是白石-827。",
        supersedes: "tea"
      });
      const p = new PostgresMemoryProvider(authority);
      const r = await p.retrieveRelevant({ scope, access, text: "喜欢的茶" });
      expect(r.events.map((e) => e.id)).toContain(next);
      expect(r.events.map((e) => e.id)).not.toContain(old);
    });
  }
);
