import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Mem0ProfileMemorySourceReader } from "./profile-source-reader.js";
import { currentCorrectedMemoryEvents } from "./correction.js";
import { MemoryBackendError } from "./backend.js";
import { MemoryService } from "./service.js";
import { InMemoryMemoryRepository } from "./repository.js";
import { LlmMemoryExtractor } from "./extractor.js";
import { MemoryIngestionPolicy } from "./ingestion.js";
import { finalizedTestResolver, finalizedTestParent } from "./finalized-test-fixture.js";
import { freezeFinalizedMemoryEvent } from "./finalized-memory-lineage.js";
import { canonicalLineageJson } from "./lineage-encoding.js";
import { InMemoryEvidenceAdmissionStore } from "./evidence-admission.js";
import { Mem0MemoryProvider, buildWriteMetadata } from "./providers/mem0-memory-provider.js";
import { buildMemoryScope } from "./scope.js";
import type { MemoryBackend, MemoryRecord, IdempotentMemoryWriteInput } from "./backend.js";
import type { MemoryWriteEventInput } from "./provider.js";
import type { GroundedMemorySource } from "./lineage.js";
import { InMemoryFinalizedIngestionRepository } from "./finalized-ingestion-ledger.js";
import { FinalizedIngestionService } from "./finalized-test-fixture.js";

const scope = buildMemoryScope("person-x", "persona-a");
async function source(text: string, minute = 0): Promise<GroundedMemorySource> {
  const value = await finalizedTestResolver.resolve({
    sourceJournalRef: {
      ...finalizedTestParent,
      eventId: "jev1_" + minute.toString().padStart(16, "a")
    },
    sourceText: text
  });
  return { ...value, recordedAt: new Date(Date.UTC(2026, 9, 10, 0, minute)).toISOString() };
}
function fixture() {
  const records = new Map<string, MemoryRecord>();
  const backend: MemoryBackend = {
    kind: "mem0",
    health: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    history: vi.fn(),
    get: vi.fn(async ({ memoryId, scope: requested }) => {
      const row = records.get(memoryId);
      return row && row.scope === requested ? row : null;
    }),
    list: vi.fn(async ({ scope: requested }) => ({
      items: [...records.values()].filter((r) => r.scope === requested),
      snapshot: { mode: "bounded_snapshot" as const, exhausted: true, rawBytesExceeded: false }
    })),
    search: vi.fn(async ({ scope: requested }) =>
      [...records.values()]
        .filter((r) => r.scope === requested)
        .slice(0, 1)
        .map((r) => ({ ...r, score: 0.99 }))
    ),
    submitIdempotent: vi.fn(async (input: IdempotentMemoryWriteInput) => {
      const row = {
        id: randomUUID(),
        content: input.content!,
        scope: input.scope,
        metadata: Object.fromEntries(
          Object.entries({ schemaVersion: 1, ...input.metadata }).filter(
            ([, value]) => value !== null
          )
        )
      };
      records.set(row.id, row);
      return { memoryId: row.id, operation: "created" as const, record: row };
    })
  };
  const admissions = new InMemoryEvidenceAdmissionStore();
  const provider = new Mem0MemoryProvider(backend, undefined, admissions, { enabled: true });
  async function write(text: string, minute: number, supersedes?: string[], targetScope = scope) {
    const frozen = freezeFinalizedMemoryEvent(
      await source(text, minute),
      {
        scope: targetScope,
        kind: supersedes ? "correction" : "fact",
        content: text,
        ...(supersedes ? { supersedes } : {})
      },
      "r4-test"
    );
    const event: MemoryWriteEventInput = {
      ...frozen,
      idempotencyKey: randomUUID(),
      payloadDigest: createHash("sha256").update(canonicalLineageJson(frozen)).digest("hex")
    };
    await provider.prepareEvidence("FINALIZED_INGESTION", event);
    const result = await provider.writeEventIdempotent(event);
    expect(result).toMatchObject({ status: "written" });
    return result.event!;
  }
  return { records, backend, admissions, provider, write };
}

describe("source-selected semantic memory", () => {
  it("calls the real reasoner interface only after grounding and confines a natural correction to prior source evidence", async () => {
    const f = fixture();
    const old = await f.write("我的编辑器代号是柳岸-137", 0);
    const text = "前面我说错了：我用的是潮生-862，柳岸-137那个名字已经不用了。";
    const generateReasoning = vi.fn(async () => ({
      reasoning: "",
      answer: JSON.stringify({
        candidates: [
          {
            content: text,
            evidenceText: "我用的是潮生-862",
            intent: "correct",
            supersedes: [{ id: old.id, evidenceText: "柳岸-137" }]
          }
        ]
      })
    }));
    const extractor = new LlmMemoryExtractor({ generateReasoning }, undefined, {
      enabled: true,
      providerConfigured: true
    });
    const policy = new MemoryIngestionPolicy(extractor, (s) =>
      f.provider.readCorrectionEvidence(s)
    );
    const extracted = await policy.build({
      userMessage: text,
      assistantMessage: "我理解了。",
      scope,
      groundedSource: await source(text, 1)
    });
    expect(generateReasoning).toHaveBeenCalledOnce();
    expect(extracted.events[0]).toMatchObject({
      kind: "correction",
      content: text,
      supersedes: [old.id],
      assertion: { source: "user", verification: "unverified" }
    });
    expect(extractor.getStatus()).toMatchObject({ active: "llm", fallbackUsed: false });
    expect(JSON.stringify(generateReasoning.mock.calls[0])).not.toContain("我理解了");
  });

  it.each([
    "我在引用这句话：请把柳岸-137改成潮生-862。",
    "假设我的代号是潮生-862，该如何纠正柳岸-137？",
    "他用的是潮生-862，柳岸-137是他以前的代号。"
  ])("does not admit quoted, hypothetical or other-person corrections: %s", async (text) => {
    const invoke = vi.fn();
    const extractor = new LlmMemoryExtractor({ generateReasoning: invoke }, undefined, {
      enabled: true,
      providerConfigured: true
    });
    expect(
      await extractor.extractCandidates({ userMessage: text, groundedSource: await source(text) })
    ).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["invented-proposition", "invented-target", "foreign-scope", "truncated", "network"])(
    "preserves existing evidence on %s",
    async (mode) => {
      const f = fixture();
      const old = await f.write("我的代号是柳岸-137", 0);
      const text = "我说错了，我的代号是潮生-862，柳岸-137作废。";
      const prior =
        mode === "foreign-scope"
          ? [{ ...old, scope: buildMemoryScope("person-y", "persona-a") }]
          : [old];
      const invoke = vi.fn(async () => {
        if (mode === "network") throw new Error("private error must not leak");
        return {
          reasoning: "",
          finishReason: mode === "truncated" ? "length" : "stop",
          answer: JSON.stringify({
            candidates: [
              {
                content: mode === "invented-proposition" ? "我是外科医生" : text,
                evidenceText: text,
                intent: "correct",
                supersedes: [
                  {
                    id: mode === "invented-target" ? "mem0:forged" : old.id,
                    evidenceText: "柳岸-137"
                  }
                ]
              }
            ]
          })
        };
      });
      const extractor = new LlmMemoryExtractor({ generateReasoning: invoke }, undefined, {
        enabled: true,
        providerConfigured: true
      });
      expect(
        await extractor.extractCandidates({
          userMessage: text,
          groundedSource: await source(text, 1),
          priorEvents: prior,
          memoryScope: scope
        })
      ).toEqual([]);
      expect(
        (await f.provider.retrieveRelevant({ scope, text: "代号" })).events.map((e) => e.id)
      ).toEqual([old.id]);
    }
  );

  it("records extraction failure separately from no factual memory in the finalized ledger", async () => {
    const extractor = new LlmMemoryExtractor(
      {
        generateReasoning: async () => {
          throw new Error("offline");
        }
      },
      undefined,
      { enabled: true, providerConfigured: true }
    );
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository, new MemoryIngestionPolicy(extractor));
    const result = await service.admit({
      finalizedTurnId: "failed",
      assistantMessageId: "assistant",
      conversationId: "chat",
      traceId: "trace",
      subjectUserId: "person-x",
      personaId: "persona-a",
      finalizedAt: new Date().toISOString(),
      ingestionRequested: true,
      userMessage: "请记住：我的代号是潮生-862。",
      assistantMessage: "我理解了。"
    });
    expect(result.turn).toMatchObject({
      status: "terminal_failed",
      lastErrorCode: "MEMORY_SEMANTIC_EXTRACTION_FAILED"
    });
    expect(result.events).toEqual([]);
  });
});

it("single-flights live and recovery materialization while rejecting source conflicts", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const build = vi.fn(async () => {
    await blocked;
    return { turnKind: "normal" as const, events: [] };
  });
  const service = new FinalizedIngestionService(new InMemoryFinalizedIngestionRepository(), {
    build
  });
  const input = {
    finalizedTurnId: "single",
    assistantMessageId: "a",
    conversationId: "c",
    traceId: "t",
    subjectUserId: "person-x",
    personaId: "persona-a",
    finalizedAt: new Date().toISOString(),
    ingestionRequested: true,
    userMessage: "我的代号是柳岸-137",
    assistantMessage: "我理解了。"
  };
  const first = service.admit(input),
    second = service.admit(input);
  await expect(service.admit({ ...input, userMessage: "different" })).rejects.toThrow(
    "SOURCE_CONFLICT"
  );
  release();
  expect(await first).toEqual(await second);
  expect(build).toHaveBeenCalledOnce();
});

describe("append-only grounded correction retrieval", () => {
  it("follows A → B → C outside vector top-k and keeps all historical sources after reopen", async () => {
    const f = fixture();
    const a = await f.write("我的编辑器代号是柳岸-137", 0);
    const b = await f.write("我的编辑器是潮生-862，柳岸-137作废", 1, [a.id]);
    const c = await f.write("现在是云桥-594，潮生-862也已作废", 2, [b.id]);
    const reopened = new Mem0MemoryProvider(f.backend, undefined, f.admissions, { enabled: true });
    const result = await reopened.retrieveRelevant({ scope, text: "柳岸-137", limit: 1 });
    expect(result.events.map((event) => event.id)).toEqual([c.id]);
    expect(await reopened.getEvent({ scope, id: a.id })).toMatchObject({ content: a.content });
    expect(f.records.size).toBe(3);
    expect(f.backend.update).not.toHaveBeenCalled();
    expect(f.backend.delete).not.toHaveBeenCalled();
  });

  it("does not retire A until a correction is durably bound, including write rejection", async () => {
    const f = fixture();
    const a = await f.write("我的编辑器代号是柳岸-137", 0);
    const frozen = freezeFinalizedMemoryEvent(
      await source("现在是潮生-862，柳岸-137作废", 1),
      {
        scope,
        kind: "correction",
        content: "现在是潮生-862，柳岸-137作废",
        supersedes: [a.id]
      },
      "r4-test"
    );
    const input = {
      ...frozen,
      idempotencyKey: randomUUID(),
      payloadDigest: createHash("sha256").update(canonicalLineageJson(frozen)).digest("hex")
    };
    await f.provider.prepareEvidence("FINALIZED_INGESTION", input);
    f.backend.submitIdempotent = vi.fn(async () => {
      throw new MemoryBackendError("SYNTHETIC_REJECTION", "rejected", { retryable: false });
    });
    expect(await f.provider.writeEventIdempotent(input)).toMatchObject({ status: "rejected" });
    expect(
      (await f.provider.retrieveRelevant({ scope, text: "编辑器" })).events.map((e) => e.id)
    ).toEqual([a.id]);
    expect(f.records.size).toBe(1);
  });

  it("invalidates derived evidence rooted in the corrected Journal without removing its history", async () => {
    const f = fixture();
    const a = await f.write("我的编辑器代号是柳岸-137", 0);
    const b = await f.write("现在是潮生-862，柳岸-137作废", 1, [a.id]);
    if (a.lineage?.state !== "GROUNDED") throw new Error("fixture must be grounded");
    const derived = {
      ...a,
      id: "derived-old",
      lineage: { ...a.lineage, origin: "DERIVED" as const }
    };
    expect(currentCorrectedMemoryEvents([a, derived, b]).map((e) => e.id)).toEqual([b.id]);
    expect(await f.provider.getEvent({ scope, id: a.id })).not.toBeNull();
  });

  it("uses the same current correction in MemoryService and the existing Profile evidence reader", async () => {
    const f = fixture();
    const a = await f.write("我的编辑器代号是柳岸-137", 0);
    const b = await f.write("我的编辑器是潮生-862，柳岸-137作废", 1, [a.id]);
    const service = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      { enabled: false },
      { kind: "mem0", mem0: f.backend, evidenceAdmissions: f.admissions }
    );
    const recalled = await service.retrieveRelevantMemoriesWithMetadata({
      text: "编辑器",
      subjectUserId: "person-x",
      personaId: "persona-a"
    });
    expect(recalled.selectedMemories.map((memory) => memory.content)).toEqual([b.content]);
    const profile = await new Mem0ProfileMemorySourceReader(
      f.backend,
      f.admissions
    ).listEligibleSources({
      subject: { kind: "MEMORY_SCOPE", scope },
      asOf: "2026-10-10T01:00:00.000Z"
    });
    expect(profile.sources.map((event) => event.content)).toEqual([b.content]);
    expect(profile.diagnostics.excludedCounts.SUPERSEDED).toBe(1);
  });

  it("preserves contradictory self reports without inventing supersession", async () => {
    const f = fixture();
    const a = await f.write("我的编辑器代号是柳岸-137", 0);
    const b = await f.write("我的编辑器代号是潮生-862", 1);
    f.backend.search = vi.fn(async () => [...f.records.values()].map((r) => ({ ...r, score: 1 })));
    expect(
      (await f.provider.retrieveRelevant({ scope, text: "编辑器" })).events.map((e) => e.id)
    ).toEqual([a.id, b.id]);
  });

  it("does not let unadmitted correction metadata retire a grounded fact", async () => {
    const f = fixture();
    const a = await f.write("我的编辑器代号是柳岸-137", 0);
    f.records.set("forged", {
      id: "forged",
      scope,
      content: "injected correction",
      metadata: { yuviEventKind: "correction", yuviClaimSupersedes: [a.id] }
    });
    expect(
      (await f.provider.retrieveRelevant({ scope, text: "编辑器" })).events.map((e) => e.id)
    ).toEqual([a.id]);
  });

  it.each(["backend", "incomplete", "foreign", "tampered"])(
    "fails closed rather than returning an obsolete fact when coverage is %s",
    async (mode) => {
      const f = fixture();
      const a = await f.write("我的编辑器代号是柳岸-137", 0);
      if (mode === "tampered") f.records.get(a.sourceRecordId)!.content = "mutated";
      else
        f.backend.list = vi.fn(async () => {
          if (mode === "backend") throw new Error("offline");
          return {
            items:
              mode === "foreign"
                ? [
                    {
                      ...f.records.get(a.sourceRecordId)!,
                      scope: buildMemoryScope("person-y", "persona-a")
                    }
                  ]
                : [],
            snapshot: {
              mode: "bounded_snapshot" as const,
              exhausted: mode !== "incomplete",
              rawBytesExceeded: false
            }
          };
        });
      expect(await f.provider.retrieveRelevant({ scope, text: "编辑器" })).toMatchObject({
        status: "error",
        events: []
      });
    }
  );

  it("keeps subject and persona corrections isolated", async () => {
    const f = fixture();
    const a = await f.write("我的编辑器代号是柳岸-137", 0);
    const foreignScope = buildMemoryScope("person-y", "persona-a");
    await f.write("我的编辑器是潮生-862，柳岸-137作废", 1, undefined, foreignScope);
    expect(
      (await f.provider.retrieveRelevant({ scope, text: "编辑器" })).events.map((e) => e.id)
    ).toEqual([a.id]);
    expect(
      (
        await f.provider.retrieveRelevant({
          scope: buildMemoryScope("person-x", "persona-b"),
          text: "编辑器"
        })
      ).events
    ).toEqual([]);
  });
});
