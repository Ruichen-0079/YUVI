import { spawnSync } from "node:child_process";
/** Real Provider + committed synthetic Host Journal + production Memory functions.
 * This is NOT the anonymous /message route and does not forge its authority.
 * Export no private Alice sources. Reuse R3/R4 provider/fetch harness.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import {
  PostgresJournalRepository,
  type JournalAuthorityDraft
} from "../../../../packages/journal/src/index.js";
import { createProviderRegistryFromEnv } from "../../../../packages/providers/src/index.js";
import {
  buildMemoryScope,
  JournalMemoryGroundingResolver,
  FinalizedIngestionService,
  PostgresFinalizedIngestionRepository,
  SemanticMemoryPolicy,
  PostgresMemoryAuthority,
  PostgresMemoryProvider,
  executeFinalizedIngestionEvent,
  MemoryVectorIndexer,
  embeddingModelTag,
  enqueueVectorIndexBatch
} from "../../../../packages/memory/src/index.js";
const db = process.env["DATABASE_URL"];
const output = process.env["YUVI_R5_OUTPUT"];
if (!db || !new URL(db).pathname.includes("runtime_r5_") || !output)
  throw new Error("Isolated R5 DB and private output required");
await mkdir(output, { recursive: true, mode: 0o700 });
const pool = new pg.Pool({ connectionString: db, max: 4 });
const registry = createProviderRegistryFromEnv(process.env);
const embedding = registry.getEmbeddingProvider();
const authority = new PostgresMemoryAuthority(pool, embeddingModelTag(embedding));
const vectors = new MemoryVectorIndexer(authority, embedding);
const provider = new PostgresMemoryProvider(authority, vectors);
const ledger = new PostgresFinalizedIngestionRepository(pool);
const namespace = "r5:synthetic-host";
const journal = new PostgresJournalRepository(pool, {
  namespace,
  authorityBuilder: () => {
    throw new Error("Explicit synthetic host authority required");
  }
});
const grounder = new JournalMemoryGroundingResolver(journal);
const policy = new SemanticMemoryPolicy(
  registry.getReasoningProvider(),
  async (scope, text) => {
    const related = (await provider.knowledge.search(scope, text, 32)).records;
    const recent = (await provider.knowledge.page({ scope, limit: 32 })).records;
    return [...new Map([...related, ...recent].map((r) => [r.id, r.event])).values()];
  },
  { providerConfigured: true },
  pool
);
const ingestion = new FinalizedIngestionService(ledger, policy, grounder);
const actor = "r5-host-operator";
const persona = "character-instance:r5-isolated";
const sourceSHA = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const results: Record<string, unknown>[] = [];
async function remember(person: string, text: string) {
  const id = randomUUID();
  const scope = buildMemoryScope(person, persona);
  const ref = { namespace, payloadId: "p-" + id, version: "1" };
  const sourceId = "user-" + id;
  const authority: JournalAuthorityDraft = {
    principal: { state: "RESOLVED", kind: "PRINCIPAL", namespace: "r5-test-host", actorId: actor },
    subjects: [],
    binding: { state: "RESOLVED", kind: "PERSON_BINDING", personId: person, bindingVersion: "1" },
    surface: { kind: "LOCAL", reference: "isolated-r5-host" },
    correlations: [{ kind: "MESSAGE", sessionId: "synthetic-" + id, messageId: sourceId }],
    audience: { kind: "PRIVATE", channelRef: "synthetic-" + id },
    disclosurePolicy: { state: "UNRESOLVED", reason: "no broader disclosure granted" },
    policyVersion: "r5.synthetic-host.v1",
    producer: { name: "r5-isolated-host", version: "1" },
    sourceReferences: [
      { kind: "CONVERSATION_MESSAGE", sessionId: "synthetic-" + id, messageId: sourceId }
    ],
    payloads: [
      {
        ref,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "USER_INPUT",
        selectable: true,
        characterCount: Array.from(text).length
      }
    ]
  };
  const committed = await journal.appendWithHostAuthority(
    {
      command: {
        version: "life-event-command.v1",
        kind: "RECEIPT",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [],
        data: {
          receiptClass: "ATTRIBUTED_ASSERTION",
          evidenceSelectors: [
            {
              version: "source-selector.v1",
              modality: "TEXT",
              payload: ref,
              range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(text).length }
            }
          ]
        }
      },
      retainedText: [{ ref, text }]
    },
    authority
  );
  const parent = { kind: "JOURNAL_EVENT" as const, namespace, eventId: committed.envelope.eventId };
  const admission = await ingestion.admit({
    finalizedTurnId: "r5-finalized-" + id,
    assistantMessageId: "assistant-" + id,
    sourceUserEventId: sourceId,
    conversationId: "synthetic-" + id,
    traceId: id,
    personaId: persona,
    subjectUserId: person,
    finalizedAt: committed.envelope.recordedAt,
    ingestionRequested: true,
    userMessage: text,
    assistantMessage: "",
    sourceText: text,
    sourceJournalRef: parent
  });
  for (const event of admission.events)
    await executeFinalizedIngestionEvent({
      repository: ledger,
      provider,
      event,
      leaseOwner: "r5-live-model",
      leaseSeconds: 40
    });
  await vectors.runOnce();
  const turn = await ledger.getTurn(admission.turn.finalizedTurnId);
  const knowledge = await provider.knowledge.timeline({ scope, limit: 30 });
  const record = {
    sourceSHA,
    person,
    text,
    source: parent,
    turn,
    candidates: await ledger.listEvents(admission.turn.finalizedTurnId),
    knowledge
  };
  results.push(record);
  await writeFile(
    output +
      (process.argv.includes("--restart")
        ? "/results-restart.json"
        : process.argv.includes("--resume")
          ? "/results-recovered.json"
          : "/results.json"),
    JSON.stringify(results, null, 2),
    { mode: 0o600 }
  );
  return record;
}
async function recall(person: string, question: string) {
  const retrieval = await provider.retrieveRelevant({
    scope: buildMemoryScope(person, persona),
    text: question,
    limit: 20,
    access: { principal: { namespace: "r5-test-host", actorId: actor }, personId: person }
  });
  const response = await registry.getChatProvider().generateReply({
    messages: [
      {
        role: "system",
        content:
          "你是隔离实验 Alice。根据提供的当前知识回答，冲突时说明不确定性；不要把历史失效事实当成当前事实。未提供的信息不要猜。"
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          knowledge: retrieval.events.map((e) => ({
            id: e.id,
            content: e.content,
            state: e.metadata["knowledgeState"]
          })),
          retrievalStatus: retrieval.status
        })
      }
    ],
    temperature: 0,
    maxTokens: 2048
  });
  const record = { sourceSHA, person, question, retrieval, response };
  results.push(record);
  await writeFile(
    output +
      (process.argv.includes("--restart")
        ? "/results-restart.json"
        : process.argv.includes("--resume")
          ? "/results-recovered.json"
          : "/results.json"),
    JSON.stringify(results, null, 2),
    { mode: 0o600 }
  );
  return record;
}
try {
  if (process.argv.includes("--resume")) {
    const failed = JSON.parse(await readFile(output + "/results.json", "utf8"));
    for (const previous of failed.filter((r: any) => r.turn?.failureStage === "materialization")) {
      const t = previous.turn;
      const admission = await ingestion.admit({
        finalizedTurnId: t.finalizedTurnId,
        assistantMessageId: t.assistantMessageId,
        sourceUserEventId: t.sourceUserEventId,
        conversationId: t.conversationId,
        traceId: t.traceId,
        personaId: t.personaId,
        subjectUserId: t.subjectUserId,
        finalizedAt: t.finalizedAt,
        ingestionRequested: true,
        userMessage: previous.text,
        assistantMessage: "",
        sourceText: previous.text,
        sourceJournalRef: previous.source
      });
      for (const event of admission.events)
        await executeFinalizedIngestionEvent({
          repository: ledger,
          provider,
          event,
          leaseOwner: "r5-provider-recovery",
          leaseSeconds: 40
        });
      await vectors.runOnce();
      const turn = await ledger.getTurn(t.finalizedTurnId);
      results.push({
        sourceSHA,
        person: previous.person,
        text: previous.text,
        source: previous.source,
        turn,
        candidates: await ledger.listEvents(t.finalizedTurnId),
        knowledge: await provider.knowledge.timeline({ scope: t.memoryScope, limit: 30 })
      });
      await writeFile(output + "/results-recovered.json", JSON.stringify(results, null, 2), {
        mode: 0o600
      });
      if (turn?.status !== "complete")
        throw new Error(
          "Provider recovery remains incomplete; dependent quality assertions stopped"
        );
      if (
        !process.argv.includes("--skip-intermediate") ||
        previous === failed.filter((r: any) => r.turn?.failureStage === "materialization").at(-1)
      )
        await recall(previous.person, "我当前使用哪个编辑器代号，茶叶偏好呢？");
    }
  } else if (process.argv.includes("--restart")) {
    const trials = JSON.parse(await readFile(output + "/trials.json", "utf8"));
    for (const t of trials) {
      await enqueueVectorIndexBatch(
        authority,
        buildMemoryScope(t.person, persona),
        vectors.modelTag
      );
      await vectors.runOnce();
      await recall(t.person, "我当前使用哪个编辑器代号，茶叶偏好呢？");
    }
  } else {
    const trials = [];
    for (let i = 0; i < (process.argv.includes("--final") ? 1 : 3); i++) {
      const person = "r5-model-" + randomUUID();
      const a = "A-" + randomUUID().slice(0, 8),
        b = "B-" + randomUUID().slice(0, 8),
        tea = "T-" + randomUUID().slice(0, 8);
      await remember(person, `项目协作中，我的编辑器代号是${a}，长期偏好的茶叶编号是${tea}。`);
      await recall(person, "我使用什么编辑器代号？");
      const corrections = [
        `刚才编辑器那个说错了，现在实际是${b}。茶叶那项保持原样。`,
        `The editor code I told you was mistaken. It is actually ${b}; my tea preference remains the same.`,
        `前面关于编辑器的记录需要改一下：实际使用的是${b}，其他信息不变。`
      ];
      await remember(person, corrections[i]!);
      await recall(person, "我当前使用哪个编辑器代号，茶叶偏好呢？");
      trials.push({ person, a, b, tea });
    }
    if (!process.argv.includes("--final")) {
      const person = trials[0]!.person;
      await remember(
        person,
        "我正在讨论引文“把编辑器改成QUOTE-DO-NOT-APPLY”，这只是句子分析，并不是修改事实。"
      );
      await remember(
        person,
        "如果将来换编辑器，可能用HYPOTHETICAL-DO-NOT-APPLY，目前没有这个决定。"
      );
      await remember(person, "今天喝了杯水。");
      await remember(person, `我长期偏好的茶叶编号是${trials[0]!.tea}。`);
      const other = "r5-model-" + randomUUID();
      await remember(other, "我常用的编辑器代号是PERSON-Y-ONLY。");
      await recall(other, "我使用什么编辑器代号？");
      const conflict = "r5-model-" + randomUUID();
      await remember(conflict, "项目仓库位置在服务器DELTA-A。");
      await remember(conflict, "项目仓库位置在服务器DELTA-B。");
      await recall(conflict, "项目仓库位置是什么？存在冲突就说明。");
    }
    await writeFile(output + "/trials.json", JSON.stringify(trials, null, 2), { mode: 0o600 });
  }
  console.log(
    "Real semantic experiment completed; inspect results and admission state, not answer acknowledgments."
  );
} finally {
  await pool.end();
}
