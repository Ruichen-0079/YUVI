/** Deterministic admission/selection evaluation. Hand-authored plans are protocol
 * fixtures, NOT semantic model quality. Only an explicitly isolated PostgreSQL. */
import pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  applySqlMigrations,
  readSqlMigrations
} from "../../../../packages/memory/src/migrations.js";
import {
  finalizedTestResolver,
  finalizedTestParent
} from "../../../../packages/memory/src/finalized-test-fixture.js";
import { freezeFinalizedMemoryEvent } from "../../../../packages/memory/src/finalized-memory-lineage.js";
import {
  canonicalLineageJson,
  lineageDigest
} from "../../../../packages/memory/src/lineage-encoding.js";
import { PostgresMemoryAuthority } from "../../../../packages/memory/src/authority/store.js";
import { PostgresMemoryProvider } from "../../../../packages/memory/src/authority/provider.js";
import {
  MemoryVectorIndexer,
  enqueueVectorIndexBatch
} from "../../../../packages/memory/src/authority/vector.js";
import { createProviderRegistryFromEnv } from "../../../../packages/providers/src/index.js";
const url = process.env.DATABASE_URL!,
  destination = process.env.YUVI_EVAL_OUTPUT!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).port !== "31508" ||
  !new URL(url).pathname.startsWith("/yuvi_pr_") ||
  !destination
)
  throw Error("Isolated database/output required");
const raw = await readFile(
    process.env.YUVI_EVAL_FIXTURE ?? new URL("./ground-truth.json", import.meta.url),
    "utf8"
  ),
  data = JSON.parse(raw);
const schema = "composition_" + randomUUID().replaceAll("-", "");
const admin = new pg.Pool({ connectionString: url }),
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
const authority = new PostgresMemoryAuthority(pool),
  ids = new Map<string, string>();
const excludedKeys = [
  ...data.facts.filter((f: any) => f.person || f.persona || f.supports).map((f: any) => f.key),
  ...data.facts.filter((f: any) => f.supersedes).map((f: any) => f.supersedes)
];
const scope = "yuvi:v1:user:composition-person:character:composition-persona";
const access = {
  principal: { namespace: "composition-test", actorId: "actor" },
  personId: "composition-person"
};
async function commit(fact: any) {
  const person = fact.person ? "composition-other" : access.personId;
  const original = await finalizedTestResolver.resolve({
    sourceJournalRef: finalizedTestParent,
    sourceText: fact.text
  });
  const source: any = {
    ...original,
    recordedAt: new Date().toISOString(),
    authority: {
      principal: { state: "RESOLVED", kind: "PRINCIPAL", ...access.principal },
      binding: { state: "RESOLVED", kind: "PERSON_BINDING", personId: person, bindingVersion: "1" },
      audience: { kind: "PRIVATE", channelRef: "composition-private" }
    }
  };
  const targetScope = fact.persona
    ? scope.replace("composition-persona", "other-persona")
    : fact.person
      ? scope.replace("composition-person:", "composition-other:")
      : scope;
  const event = freezeFinalizedMemoryEvent(
    source,
    {
      scope: targetScope,
      kind: "fact",
      content: fact.text,
      ...Object.fromEntries(
        ["supersedes", "conflicts", "supports"]
          .filter((k) => fact[k])
          .map((k) => [k, [ids.get(fact[k])]])
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
  const r = await authority.commit(input);
  ids.set(fact.key, r.event.id);
}
const report: any = {
  schema: "memory.composition-eval.v1",
  kind: "actual-postgresql-production-provider-protocol-plans",
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  fixtureDigest: createHash("sha256").update(raw).digest("hex"),
  fixtureFreeze: process.env.YUVI_EVAL_FIXTURE_COMMIT ?? "080c9a3",
  schemaName: schema,
  cases: []
};
const withVectors = process.env.YUVI_EVAL_REAL_VECTORS === "true";
let vectors: MemoryVectorIndexer | undefined;
const embeddingCalls: any[] = [];
try {
  await admin.query(`create schema ${schema}`);
  await applySqlMigrations(pool, await readSqlMigrations());
  for (const f of data.facts) await commit(f);
  for (let n = 0; n < data.distractors.count; n++)
    await commit({ key: "noise" + n, text: data.distractors.template.replace("{n}", String(n)) });
  if (withVectors) {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith("/embeddings")) return original(url, init);
      if (embeddingCalls.length >= 250) throw Error("Embedding call cap reached");
      const ordinal = embeddingCalls.length,
        start = performance.now();
      embeddingCalls.push({ ordinal });
      const response = await original(url, init);
      const body = (await response.clone().json()) as any;
      embeddingCalls[ordinal] = {
        ordinal,
        httpStatus: response.status,
        latencyMs: performance.now() - start,
        model: body.model,
        usage: body.usage,
        dimensions: body.data?.[0]?.embedding?.length
      };
      return response;
    };
    const native = createProviderRegistryFromEnv(process.env).getEmbeddingProvider();
    const probe = await native.embedText("isolated synthetic dimensionality probe");
    if (probe.length !== 512) throw Error("Actual embedding dimension is not 512");
    const cache = new Map<string, Promise<number[]>>();
    const cacheFile = process.env.YUVI_EVAL_VECTOR_CACHE;
    const cacheValues: Record<string, number[]> = {};
    let cacheWrite = Promise.resolve();
    if (cacheFile) {
      try {
        const saved = JSON.parse(await readFile(cacheFile, "utf8"));
        if (saved.model !== native.model) throw Error("Embedding model mismatch");
        Object.assign(cacheValues, saved.vectors);
        for (const [text, v] of Object.entries(cacheValues)) cache.set(text, Promise.resolve(v));
      } catch (e) {
        if ((e as any).code !== "ENOENT") throw e;
      }
    }

    const embedded = {
      name: native.name,
      model: native.model,
      dimensions: 512,
      mock: false,
      async embedText(text: string) {
        if (!cache.has(text))
          cache.set(
            text,
            native.embedText(text).then(async (v) => {
              cacheValues[text] = v;
              if (cacheFile)
                await (cacheWrite = cacheWrite.then(() =>
                  writeFile(
                    cacheFile,
                    JSON.stringify({
                      model: native.model,
                      createdAt: new Date().toISOString(),
                      vectors: cacheValues
                    })
                  )
                ));
              return v;
            })
          );
        return cache.get(text)!;
      }
    };
    vectors = new MemoryVectorIndexer(authority, embedded);
    let after = "0",
      batch;
    do {
      batch = await enqueueVectorIndexBatch(authority, scope, vectors.modelTag, after, 200);
      after = batch.checkpoint;
    } while (!batch.exhausted);
    for (let i = 0; i < 20 && (await vectors.hasPending(scope)); i++) await vectors.runOnce();
    report.vector = {
      modelTag: vectors.modelTag,
      pending: await vectors.hasPending(scope),
      queryCache:
        "same real model/text vectors reused across modes; cold remote latency is recorded separately"
    };
  }
  for (const c of data.cases)
    for (const mode of withVectors
      ? ["vector", "hybrid", "expanded-hybrid", "composition-hybrid"]
      : ["text", "expanded-global", "composition"]) {
      const plan = ["text", "vector", "hybrid"].includes(mode)
        ? undefined
        : async () => ({
            queries: [0, 1].map((lang) =>
              c.needs
                .map((n: any) => n.queries[lang])
                .join(" ")
                .slice(0, 256)
            ),
            ...(mode.startsWith("composition")
              ? {
                  needs: c.needs.map((n: any, i: number) => ({
                    id: "n" + i,
                    quote: n.quote,
                    queries: n.queries
                  }))
                }
              : {}),
            model: "hand-authored-protocol-fixture",
            usage: null
          });
      const provider = new PostgresMemoryProvider(authority, vectors, plan);
      if (mode === "vector")
        provider.knowledge.search = async () => ({
          records: [],
          watermark: (await provider.knowledge.overview(scope)).version,
          candidateLimited: false
        });
      const start = performance.now(),
        out = await provider.retrieveRelevant({
          scope,
          access,
          text: c.query,
          limit: Number(process.env.YUVI_EVAL_LIMIT ?? 8)
        }),
        elapsedMs = performance.now() - start;
      const detail = out.retrievalId
        ? await provider.retrievalEvidence.detail(scope, out.retrievalId)
        : null;
      const selected = out.events.map((e) => e.id),
        expected = [
          ...new Set<string>(c.needs.flatMap((n: any) => n.keys.map((k: string) => ids.get(k))))
        ];
      const needs = c.needs.map((n: any) => ({
        quote: n.quote,
        expected: n.keys,
        covered: n.keys.every((k: string) => selected.includes(ids.get(k)!)),
        unknown: n.keys.length === 0
      }));
      report.cases.push({
        id: c.id,
        split: c.split,
        mode,
        query: c.query,
        status: out.status,
        elapsedMs,
        needs,
        evidenceRecall: expected.length
          ? expected.filter((id) => selected.includes(id)).length / expected.length
          : null,
        completeCoverage: needs.every((n: any) => n.covered),
        selected: out.events.map((e) => ({
          key: [...ids].find(([, id]) => id === e.id)?.[0],
          id: e.id,
          content: e.content
        })),
        precision: selected.length
          ? selected.filter((id) => expected.includes(id)).length / selected.length
          : null,
        invalidLeaks: selected.filter((id) => excludedKeys.some((k: string) => ids.get(k) === id)),
        evidence: detail
      });
    }
  report.embeddingCalls = embeddingCalls;
  report.resultLimit = Number(process.env.YUVI_EVAL_LIMIT ?? 8);
  await writeFile(destination, JSON.stringify(report, null, 2));
} catch (e) {
  report.error = String(e);
  report.embeddingCalls = embeddingCalls;
  await writeFile(destination, JSON.stringify(report, null, 2));
  throw e;
} finally {
  await pool.end();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
}
