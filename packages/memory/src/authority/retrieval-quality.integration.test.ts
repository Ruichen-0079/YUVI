import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { applySqlMigrations, readSqlMigrations } from "../migrations.js";
import { finalizedTestResolver, finalizedTestParent } from "../finalized-test-fixture.js";
import { freezeFinalizedMemoryEvent } from "../finalized-memory-lineage.js";
import { canonicalLineageJson, lineageDigest } from "../lineage-encoding.js";
import type { GroundedMemorySource } from "../lineage.js";
import { PostgresMemoryAuthority } from "./store.js";
import { PostgresMemoryProvider } from "./provider.js";
import { MemoryAuthorityError } from "./types.js";
import { MemoryKnowledgeReader } from "./read.js";
import type { MemoryVectorIndexer } from "./vector.js";
import type { MemoryWriteEventInput } from "../provider.js";
const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
const schema = "retrieval_" + randomUUID().replaceAll("-", "");
const admin = new pg.Pool({ connectionString: url });
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
const authority = new PostgresMemoryAuthority(pool),
  provider = new PostgresMemoryProvider(authority),
  reader = new MemoryKnowledgeReader(pool);
const scope = "yuvi:v1:user:retrieval-person:character:retrieval-persona";
const access = {
  principal: { namespace: "retrieval-test", actorId: "x" },
  personId: "retrieval-person"
};
async function write(content: string, changes: Partial<MemoryWriteEventInput> = {}) {
  const original = await finalizedTestResolver.resolve({
    sourceJournalRef: finalizedTestParent,
    sourceText: content
  });
  const source: GroundedMemorySource = {
    ...original,
    recordedAt: new Date().toISOString(),
    authority: {
      principal: {
        state: "RESOLVED",
        kind: "PRINCIPAL",
        namespace: "retrieval-test",
        actorId: "x"
      },
      binding: {
        state: "RESOLVED",
        kind: "PERSON_BINDING",
        personId: "retrieval-person",
        bindingVersion: "1"
      },
      audience: { kind: "PRIVATE", channelRef: "private-retrieval" }
    }
  };
  const value = freezeFinalizedMemoryEvent(
    source,
    { scope, kind: "fact", content, ...changes },
    "retrieval-test"
  );
  const input = {
    ...value,
    idempotencyKey: randomUUID(),
    payloadDigest: lineageDigest(canonicalLineageJson(value))
  };
  await provider.prepareEvidence!("FINALIZED_INGESTION", input);
  const result = await provider.writeEventIdempotent(input);
  if (result.status !== "written") throw Error(JSON.stringify(result));
  return result.eventId!;
}
describe.skipIf(!url)("real PostgreSQL retrieval relevance and channel truth", () => {
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    await applySqlMigrations(pool, await readSqlMigrations());
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  it("ranks identifiers before limiting amid >513 common-word records, with deterministic ties", async () => {
    const expected = new Map<number, string>();
    for (let i = 0; i < 1100; i++) {
      const id = await write(`常用编辑器 Shared editor 项目 CODE_${String(i).padStart(5, "0")}`);
      if ([50, 800, 1050].includes(i)) expected.set(i, id);
    }
    for (const [ordinal, id] of expected) {
      const result = await reader.search(
        scope,
        `常用编辑器 Shared editor CODE_${String(ordinal).padStart(5, "0")}`,
        5
      );
      expect(result.records[0]?.id).toBe(id);
      expect(result.candidateLimited).toBe(true);
      expect(
        (await reader.search(scope, `CODE_${String(ordinal).padStart(5, "0")}`, 5)).records[0]?.id
      ).toBe(id);
    }
  }, 60000);
  it("current projection resolves supersession, conflict, support and identity isolation before exposure", async () => {
    const old = await write("Durable editor code OLD_ID");
    const current = await write("Durable editor code NEW_ID", { supersedes: [old] });
    await write("Durable editor code NEW_ID", { supports: [current] });
    const conflicting = await write("Durable editor code MAYBE_ID", { conflicts: [current] });
    const result = await provider.retrieveRelevant({
      scope,
      access,
      text: "Durable NEW_ID OLD_ID MAYBE_ID",
      limit: 8
    });
    expect(result.events.map((e) => e.id)).toContain(current);
    expect(result.events.map((e) => e.id)).toContain(conflicting);
    expect(result.events.map((e) => e.id)).not.toContain(old);
    expect(result.events.filter((e) => e.content.includes("NEW_ID"))).toHaveLength(1);
    const detail = await provider.retrievalEvidence.detail(scope, result.retrievalId!);
    expect(detail?.queryPlan?.status).toBe("DISABLED");
    expect(
      (
        await provider.retrieveRelevant({
          scope,
          access: { ...access, personId: "other" },
          text: "NEW_ID"
        })
      ).events
    ).toHaveLength(0);
    expect(
      (
        await provider.retrieveRelevant({
          scope: scope.replace("retrieval-persona", "other-persona"),
          access,
          text: "NEW_ID"
        })
      ).events
    ).toHaveLength(0);
  });
  it("text SQL failure still uses an independently available vector channel and reports PARTIAL", async () => {
    const target = (await reader.search(scope, "NEW_ID", 1)).records[0]!;
    const original = provider.knowledge.search.bind(provider.knowledge);
    provider.knowledge.search = async () => {
      await pool.query("select 1/0");
      throw Error("unreachable");
    };
    const vectors = {
      modelTag: "fixture-vector-contract",
      hasPending: async () => false,
      searchWithEvidence: async () => ({ ids: [target.id], limited: false })
    } as unknown as MemoryVectorIndexer;
    const fallback = new PostgresMemoryProvider(authority, vectors);
    fallback.knowledge.search = provider.knowledge.search;
    try {
      const result = await fallback.retrieveRelevant({ scope, access, text: "NEW_ID" });
      expect(result.status).toBe("partial");
      expect(result.limitReason).toBe("MEMORY_TEXT_UNAVAILABLE");
      expect(result.events.map((e) => e.id)).toContain(target.id);
    } finally {
      provider.knowledge.search = original;
    }
  });
  it("single-Han queries recall existing bigram-indexed records without corpus rewriting", async () => {
    const tea = await write("长期茶叶偏好是月桂947");
    expect((await reader.search(scope, "茶", 5)).records.map((r) => r.id)).toContain(tea);
    expect((await reader.search(scope, "长期茶叶偏好", 5)).records.map((r) => r.id)).toContain(tea);
  });
  it("bounded bilingual plan replay selects an actual English record, without placing its value in the query", async () => {
    const english = await write("My stable unit test framework preference is ENGLISH-947.");
    const planned = new PostgresMemoryProvider(authority, undefined, async () => ({
      queries: ["unit test framework preference", "单元测试框架 偏好"],
      model: "protocol-fixture-not-quality",
      usage: null
    }));
    const result = await planned.retrieveRelevant({
      scope,
      access,
      text: "我偏好的单元测试框架是什么？",
      limit: 5
    });
    expect(result.events.map((e) => e.id)).toContain(english);
    const evidence = await planned.retrievalEvidence.detail(scope, result.retrievalId!);
    expect(JSON.stringify(evidence?.queryPlan?.queries)).not.toContain("ENGLISH-947");
    expect(evidence?.queryPlan?.channels.some((c) => c.ids.includes(english))).toBe(true);
    const decision = await write(
      "For project MAPLE we chose to take a verified snapshot before the migration."
    );
    expect((await reader.search(scope, "MAPLE snapshot migration", 5)).records[0]?.id).toBe(
      decision
    );
  });
  it("authority loss during semantic expansion is fatal before any subsequent Memory read", async () => {
    const revoked = new PostgresMemoryProvider(authority, undefined, async () => {
      throw new MemoryAuthorityError("MEMORY_READER_AUTHORITY_REVOKED");
    });
    let reads = 0;
    revoked.knowledge.search = async () => {
      reads++;
      throw Error("must not run");
    };
    const result = await revoked.retrieveRelevant({ scope, access, text: "editor" });
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("MEMORY_READER_AUTHORITY_REVOKED");
    expect(reads).toBe(0);
    expect(result.events).toHaveLength(0);
  });
  it("vector failure retains lexical evidence; failed expansion is explicit and never invents a fact", async () => {
    const vectors = {
      modelTag: "fixture-vector-contract",
      hasPending: async () => false,
      searchWithEvidence: async () => {
        throw Error("fixture unavailable");
      }
    } as unknown as MemoryVectorIndexer;
    const fallback = new PostgresMemoryProvider(authority, vectors);
    const result = await fallback.retrieveRelevant({ scope, access, text: "NEW_ID" });
    expect(result.status).toBe("partial");
    expect(result.limitReason).toBe("MEMORY_VECTOR_UNAVAILABLE");
    expect(result.events.length).toBeGreaterThan(0);
    const failed = new PostgresMemoryProvider(authority, undefined, async () => {
      throw Error("invalid provider output");
    });
    const partial = await failed.retrieveRelevant({ scope, access, text: "NEW_ID" });
    expect(partial.status).toBe("partial");
    expect(partial.limitReason).toBe("MEMORY_QUERY_PLAN_UNAVAILABLE");
    const evidence = await failed.retrievalEvidence.detail(scope, partial.retrievalId!);
    expect(evidence?.queryPlan?.status).toBe("UNAVAILABLE");
    expect(
      (await reader.search(scope, "OLD_ID", 8)).records.some((r) => r.state === "superseded")
    ).toBe(false);
  });
});
