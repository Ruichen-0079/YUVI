/** Fixed post-retrieval adversarial candidates, real PostgreSQL authority/current
 * resolution, real assessor + production Character. Not an ANN recall benchmark. */
import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import {
  applySqlMigrations,
  readSqlMigrations,
  PostgresMemoryAuthority,
  MemoryKnowledgeReader,
  assessEvidenceSupport
} from "../../../../packages/memory/src/index.js";
import { plannedMemoryEvidence } from "../../../../packages/memory/src/memory-vnext.js";
import {
  finalizedTestResolver,
  finalizedTestParent
} from "../../../../packages/memory/src/finalized-test-fixture.js";
import { freezeFinalizedMemoryEvent } from "../../../../packages/memory/src/finalized-memory-lineage.js";
import {
  canonicalLineageJson,
  lineageDigest
} from "../../../../packages/memory/src/lineage-encoding.js";
import { createProviderRegistryFromEnv } from "../../../../packages/providers/src/index.js";
import {
  PromptBuilder,
  assembleCanonicalContext
} from "../../../../packages/prompt-builder/src/index.js";
import { createServerCharacterPort } from "../../../../apps/server/src/character-runtime.js";
const url = process.env.DATABASE_URL!,
  output = process.env.YUVI_SUPPORT_OUTPUT!,
  old = process.env.YUVI_SUPPORT_BASELINE!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).port !== "31508" ||
  !new URL(url).pathname.startsWith("/yuvi_pr_") ||
  !output ||
  !old
)
  throw Error("Explicit isolated DB, output and #331 checkout required");
const registry = createProviderRegistryFromEnv(process.env),
  reasoner = registry.getReasoningProvider(),
  chat = registry.getChatProvider();
const { plannedMemoryEvidence: oldRender } = await import(
  pathToFileURL(old + "/packages/memory/src/memory-vnext.ts").href
);
const schema = "support_eval_" + randomUUID().replaceAll("-", ""),
  admin = new pg.Pool({ connectionString: url }),
  pool = new pg.Pool({ connectionString: url, options: "-c search_path=" + schema + ",public" }),
  authority = new PostgresMemoryAuthority(pool),
  reader = new MemoryKnowledgeReader(pool);
const fixtureRaw = await readFile(new URL("./ground-truth.json", import.meta.url), "utf8"),
  fixture = JSON.parse(fixtureRaw);
let count = 0,
  knownCost = 0,
  unknownCost = 0;
const fetchOriginal = globalThis.fetch;
const calls: any[] = [];
globalThis.fetch = async (url, init) => {
  if (!String(url).endsWith("/chat/completions")) return fetchOriginal(url, init);
  if (count >= 110 || knownCost >= 0.1) throw Error("Explicit model experiment budget reached");
  const n = count++,
    input = JSON.parse(String(init?.body)),
    started = performance.now();
  const response = await fetchOriginal(url, init);
  const body = (await response.clone().json()) as any;
  const cost = body.usage?.estimated_cost;
  if (typeof cost === "number") knownCost += cost;
  else unknownCost++;
  calls.push({
    ordinal: n,
    model: input.model,
    phase: input.messages[0]?.content.startsWith("Evaluate whether each untrusted question")
      ? "SUPPORT"
      : input.messages[0]?.content.includes("The semantic gate has authorized RESPOND")
        ? "BODY"
        : "GATE",
    messages: input.messages,
    usage: body.usage,
    status: response.status,
    elapsedMs: performance.now() - started
  });
  return response;
};
const report: any = {
  schema: "memory.support-eval.v1",
  kind: "actual PG/current resolution + fixed adversarial candidate set + real support/Character models, no L1",
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  fixtureDigest: createHash("sha256").update(fixtureRaw).digest("hex"),
  cases: []
};
async function save() {
  report.calls = calls;
  report.totalCalls = count;
  report.knownProviderEstimatedCostUSD = knownCost;
  report.callsWithoutCostReceipt = unknownCost;
  await writeFile(output, JSON.stringify(report, null, 2));
}
try {
  await admin.query("create schema " + schema);
  await applySqlMigrations(pool, await readSqlMigrations());
  for (const c of fixture.cases) {
    const scope = "yuvi:v1:user:support-person:character:" + c.id,
      ids = new Map<string, string>();
    // The fixture deliberately offers only this case's candidates; no target
    // answers, labels or unrelated facts are sent to either model.
    for (const key of c.candidates) {
      const f = fixture.facts.find((f: any) => f.id === key),
        source: any = {
          ...(await finalizedTestResolver.resolve({
            sourceJournalRef: finalizedTestParent,
            sourceText: f.text
          })),
          recordedAt: new Date().toISOString(),
          authority: {
            principal: {
              state: "RESOLVED",
              kind: "PRINCIPAL",
              namespace: "support-fixture",
              actorId: "actor"
            },
            binding: {
              state: "RESOLVED",
              kind: "PERSON_BINDING",
              personId: "support-person",
              bindingVersion: "1"
            },
            audience: { kind: "PRIVATE", channelRef: "support-private" }
          }
        };
      const value = freezeFinalizedMemoryEvent(
        source,
        {
          scope,
          kind: "fact",
          content: f.text,
          ...(key === "conflict2" && ids.has("conflict1")
            ? { conflicts: [ids.get("conflict1")!] }
            : {})
        },
        "support-fixture"
      );
      const input = {
        ...value,
        idempotencyKey: randomUUID(),
        payloadDigest: lineageDigest(canonicalLineageJson(value))
      };
      await authority.prepare("FINALIZED_INGESTION", input);
      const result = await authority.commit(input);
      ids.set(key, result.event.id);
    }
    // A real supersession removes the old fact before semantic evaluation.
    if (ids.has("editor-old")) {
      const raw = await reader.detail(scope, ids.get("editor-old")!);
      const f = fixture.facts.find((f: any) => f.id === "editor");
      const source: any = {
        ...(await finalizedTestResolver.resolve({
          sourceJournalRef: finalizedTestParent,
          sourceText: f.text
        })),
        recordedAt: new Date().toISOString(),
        authority: {
          principal: {
            state: "RESOLVED",
            kind: "PRINCIPAL",
            namespace: "support-fixture",
            actorId: "actor"
          },
          binding: {
            state: "RESOLVED",
            kind: "PERSON_BINDING",
            personId: "support-person",
            bindingVersion: "1"
          },
          audience: { kind: "PRIVATE", channelRef: "support-private" }
        }
      };
      const event = freezeFinalizedMemoryEvent(
        source,
        { scope, kind: "correction", content: f.text, supersedes: [raw!.id] },
        "support-fixture"
      );
      const input = {
        ...event,
        idempotencyKey: randomUUID(),
        payloadDigest: lineageDigest(canonicalLineageJson(event))
      };
      await authority.prepare("FINALIZED_INGESTION", input);
      await authority.commit(input);
    }
    const resolved = await reader.resolveCandidates(scope, [...ids.values()]);
    const events = resolved.records
      .filter((r: any) => ["current", "conflicted"].includes(r.state))
      .map((r: any) => r.event);
    const question = c.question,
      coverage = [
        {
          id: "n0",
          quote: question,
          candidateIds: events.map((e: any) => e.id),
          selectedIds: events.map((e: any) => e.id),
          preferredId: events[0]?.id ?? null,
          preferredSelected: !!events.length,
          status: events.length ? "SELECTED_CANDIDATE" : "NO_AUTHORIZED_CANDIDATE"
        }
      ];
    const outcome: any = {
      status: "partial",
      source: "postgres",
      events,
      limited: false,
      coverage
    };
    const item: any = {
      id: c.id,
      split: c.split,
      question,
      expected: c.expected,
      evidenceKeys: c.evidence,
      offeredKeys: c.candidates,
      authorizedCurrentKeys: [...ids]
        .filter(([_, id]) => events.some((e: any) => e.id === id))
        .map(([key]) => key),
      cases: []
    };
    for (const mode of ["baseline", "revised"]) {
      const started = performance.now(),
        startCall = calls.length;
      let evidence = oldRender(outcome),
        assessment;
      if (mode === "revised") {
        assessment = await assessEvidenceSupport(reasoner, {
          request: { text: question },
          needs: [{ id: "n0", quote: question }],
          events
        });
        const allowed = new Set(assessment.needs.flatMap((n) => n.citations.map((c) => c.id)));
        evidence = plannedMemoryEvidence({
          ...outcome,
          evidenceSupport: assessment,
          events: events.filter((e: any) => allowed.has(e.id))
        });
      }
      const prompt = new PromptBuilder().buildPrompt({
        systemIdentity: "Synthetic Alice",
        characterStyle: "Warm and precise.",
        userMessage: question
      });
      const canonicalContext = assembleCanonicalContext({
        semanticSections: [
          {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "Synthetic Alice; the source speaker is the user, not Alice."
          },
          { kind: "MEMORY_EVIDENCE", state: "PARTIAL", summary: evidence }
        ],
        promptSections: prompt.sections,
        currentInput: question
      });
      let result: any;
      try {
        const gate = await createServerCharacterPort().generate({
          prompt,
          canonicalContext,
          userMessage: question,
          contextWindow: 65536,
          generateChat: (input: any) =>
            chat.generateReply({ ...input, temperature: 0, maxTokens: 768 })
        });
        if (gate.decision.reply.body) {
          const r = await chat.generateReply({
            ...gate.decision.reply.body,
            temperature: 0,
            maxTokens: 768
          });
          result = { answer: r.message.content, finishReason: r.finishReason };
        } else result = { disposition: gate.decision.reply.disposition };
      } catch (error) {
        result = { error: String(error) };
      }
      item.cases.push({
        mode,
        assessment,
        evidence,
        ...result,
        callOrdinals: calls.slice(startCall).map((c) => c.ordinal),
        elapsedMs: performance.now() - started
      });
    }
    report.cases.push(item);
    await save();
  }
} finally {
  await save();
  await pool.end();
  await admin.query("drop schema if exists " + schema + " cascade");
  await admin.end();
}
