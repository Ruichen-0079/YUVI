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
import { advanceLexicalIndex, rebuildLexicalIndex, verifyLexicalIndex } from "./lexical-index.js";
import { MemoryProjectionRebuild } from "./projection-rebuild.js";
import { assessEvidenceSupport } from "./evidence-support.js";
import { MemoryAuthorityError } from "./types.js";
import { MemoryVectorIndexer } from "./vector.js";
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
    it("separates a selected distractor from supported evidence, without hiding the selection audit", async () => {
      const query = "编辑器和航空座位",
        plan = async () => ({
          queries: [],
          model: "protocol-fixture",
          usage: null,
          needs: [
            { id: "n0", quote: "编辑器", queries: ["露川-4A87"] },
            { id: "n1", quote: "航空座位", queries: ["月桂-5967"] }
          ]
        });
      const p = new PostgresMemoryProvider(authority, undefined, plan, async (input) =>
        assessEvidenceSupport(
          {
            generateReasoning: async () => ({
              reasoning: JSON.stringify({
                needs: [
                  {
                    id: "n0",
                    verdict: "SUPPORTED",
                    citations: [{ id: ids.get("editor"), quote: "露川-4A87" }]
                  },
                  { id: "n1", verdict: "INSUFFICIENT", citations: [] }
                ]
              })
            })
          },
          input
        )
      );
      const r = await p.retrieveRelevant({ scope, access, text: query, limit: 5 });
      expect(r.coverage?.[1]?.preferredSelected).toBe(true);
      expect(r.evidenceSupport?.needs.map((n) => n.verdict)).toEqual(["SUPPORTED", "INSUFFICIENT"]);
      expect(r.events.map((e) => e.id)).toEqual([ids.get("editor")]);
      const audit = await p.retrievalEvidence.detail(scope, r.retrievalId!);
      expect(audit?.queryPlan?.evidenceSupport?.needs[1]?.verdict).toBe("INSUFFICIENT");
      expect(
        audit?.candidates.some(
          (c) => c.id === ids.get("tea") && c.reason === "EVIDENCE_NOT_ESTABLISHED" && !c.selected
        )
      ).toBe(true);
    });
    it("keeps assessment outage distinct from insufficiency and rejects real authority loss", async () => {
      for (const [error, expected] of [
        [Error("timeout"), "partial"],
        [new MemoryAuthorityError("MEMORY_READER_AUTHORITY_REVOKED"), "error"]
      ] as const) {
        const p = new PostgresMemoryProvider(authority, undefined, undefined, async () => {
          throw error;
        });
        const r = await p.retrieveRelevant({ scope, access, text: "露川-4A87", limit: 5 });
        expect(r.status).toBe(expected);
        expect(r.events).toEqual([]);
        if (expected === "partial")
          expect(r.evidenceSupport?.needs[0]?.verdict).toBe("UNAVAILABLE");
        else expect(r.errorCode).toBe("MEMORY_READER_AUTHORITY_REVOKED");
      }
      let calls = 0;
      const p = new PostgresMemoryProvider(authority, undefined, undefined, async () => {
        calls++;
        throw Error("must not assess anonymous");
      });
      expect((await p.retrieveRelevant({ scope, text: "露川-4A87" })).status).toBe("unavailable");
      expect(calls).toBe(0);
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
    it("does not invent an indexing backlog for a scope with no committed history", async () => {
      const r = await new PostgresMemoryProvider(authority).retrieveRelevant({
        scope: scope.replace("composition-persona", "empty-persona"),
        access,
        text: "tea"
      });
      expect(r.status).toBe("empty");
      expect(r.limited).toBe(false);
    });
    it("reports lexical query truncation instead of claiming a complete empty search", async () => {
      const p = new PostgresMemoryProvider(authority);
      const r = await p.retrieveRelevant({
        scope,
        access,
        text: Array.from({ length: 40 }, (_, i) => `unmatchedword${i}`).join(" ") + " 露川-4A87"
      });
      expect(r.status).toBe("partial");
      const audit = await p.retrievalEvidence.detail(scope, r.retrievalId!);
      expect(audit?.queryPlan?.channels[0]?.queryTermsLimited).toBe(true);
      const long = await p.retrieveRelevant({
        scope,
        access,
        text: "unmatched ".repeat(500) + "露川-4A87"
      });
      expect(long.status).toBe("partial");
      expect(long.limitReason).toBe("MEMORY_QUERY_INPUT_BOUND");
      expect(
        (await p.retrievalEvidence.detail(scope, long.retrievalId!))?.queryPlan
          ?.originalQueryTruncated
      ).toBe(true);
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
        "insert into memory_lexical_postings(scope,generation,term,id,version) values($1,$2,'corrupted-extra-term',$3,0)",
        [scope, g, ids.get("editor")]
      );
      const detected = await verifyLexicalIndex(authority, scope, "", 200, "test-operator");
      expect(detected.status).toBe("MISMATCH");
      expect(detected.mismatches).toContain(ids.get("editor"));
      expect((await rebuildLexicalIndex(authority, scope, "test-operator")).status).toBe(
        "BUILDING"
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
      expect(
        (await verifyLexicalIndex(authority, scope, "", 200, "test-operator")).mismatches
      ).toEqual([]);
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
    it("rejects a higher-scoring superseded vector and never mixes model spaces", async () => {
      const old = await write({ key: "ann-old", text: "路线的旧代号是RIDGE-11。" });
      const current = await write({
        key: "ann-current",
        text: "路线当前代号是RIDGE-22。",
        supersedes: "ann-old"
      });
      const q = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)),
        near = Array.from({ length: 512 }, (_, i) => (i < 2 ? 1 : 0));
      // Geometric protocol fixture: validates real SQL/state, not embedding semantics.
      const indexer = new MemoryVectorIndexer(authority, {
        name: "state-contract",
        model: "space-v1",
        dimensions: 512,
        mock: false,
        embedText: async () => q
      });
      for (const [id, vector] of [
        [old, q],
        [current, near]
      ] as const) {
        const version = (await new PostgresMemoryProvider(authority).knowledge.detail(scope, id))!
          .version;
        await pool.query(
          "insert into memory_authority_vectors(scope,id,model_tag,authority_version,embedding) values($1,$2,$3,$4,$5::vector)",
          [scope, id, indexer.modelTag, version, JSON.stringify(vector)]
        );
      }
      const found = await indexer.searchWithEvidence(scope, "route", 5);
      expect(found.candidateCount).toBe(2);
      expect(found.ids).toContain(current);
      expect(found.ids).not.toContain(old);
      const mismatch = new MemoryVectorIndexer(authority, {
        name: "state-contract",
        model: "space-v2",
        dimensions: 512,
        mock: false,
        embedText: async () => q
      });
      expect((await mismatch.searchWithEvidence(scope, "route", 5)).ids).toEqual([]);
      const p = new PostgresMemoryProvider(authority, mismatch),
        r = await p.retrieveRelevant({ scope, access, text: "RIDGE-22" });
      expect(r.status).toBe("partial");
      expect(r.limitReason).toBe("MEMORY_VECTOR_CANDIDATE_BOUND");
      expect(r.events.map((e) => e.id)).toContain(current);
      expect(r.events.map((e) => e.id)).not.toContain(old);
    });
  }
);
