import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "./conversation-repository.js";
import { receipt, parent, readerFor } from "./journal-evidence.test-fixture.js";
import { JournalMemoryGroundingResolver, MemoryLineageV1Schema } from "./lineage.js";
import {
  captureEpisodeSources,
  episodeEvidenceDigest,
  withEpisodeEvidence
} from "./episode-source-evidence.js";
import { assembleRecentEpisodes } from "./recent-episode.js";
import { InMemoryRecentEpisodeStore } from "./recent-episode-store.js";
import {
  DreamConsolidationEngine,
  InMemoryDreamJobStore,
  type DreamJob
} from "./dream-consolidation.js";
import { freezeDreamSources, dreamSourceDigest, freezeDerivedDreamEvent } from "./dream-source.js";
import { stampDreamWriteEvent } from "./dream-delivery.js";
import {
  canonicalLineageJson,
  encodeMemoryLineage,
  decodeMemoryLineage,
  lineageDigest
} from "./lineage-encoding.js";
import {
  buildWriteMetadata,
  sanitizeSemanticMetadata,
  mapMem0RecordToMemoryEvent,
  Mem0MemoryProvider
} from "./providers/mem0-memory-provider.js";
import type { MemoryBackend } from "./backend.js";
import { assembleMemoryVNextContext } from "./memory-vnext.js";

const now = new Date("2026-09-30T08:01:00Z");
export function sourceMessage(
  id = "u1",
  text = "Please remember: I prefer tea 🍵.",
  ref = parent
): ConversationMessage {
  return {
    id,
    sessionId: `s-${id}`,
    role: "user",
    traceId: `trace-${id}`,
    parentMessageId: null,
    status: "completed",
    content: text,
    sourceJournalRef: ref,
    createdAt: now.toISOString(),
    completedAt: now.toISOString(),
    metadata: {},
    sequence: 1
  };
}
async function groundedEpisode(
  id = "u1",
  text = "Please remember: I prefer tea 🍵.",
  options: Parameters<typeof receipt>[0] = { text }
) {
  const envelope = receipt({ ...options, text });
  const resolver = new JournalMemoryGroundingResolver(readerFor(envelope, text));
  const messages = [sourceMessage(id, text)];
  const capturedSources = await captureEpisodeSources(messages, resolver);
  return assembleRecentEpisodes({ messages, capturedSources, now })[0]!;
}
function derived(event: ReturnType<typeof freezeDerivedDreamEvent>) {
  const lineage = MemoryLineageV1Schema.parse(event.lineage);
  if (lineage.state !== "GROUNDED" || lineage.origin !== "DERIVED" || !("sources" in lineage))
    throw new Error("expected derived");
  return lineage;
}
async function setup(
  episodes: Awaited<ReturnType<typeof groundedEpisode>>[],
  provider?: ConstructorParameters<typeof DreamConsolidationEngine>[2]
) {
  const store = new InMemoryRecentEpisodeStore();
  const jobs = new InMemoryDreamJobStore();
  for (const episode of episodes) await store.upsert(episode);
  const engine = new DreamConsolidationEngine(
    jobs,
    store,
    provider ?? { writer: async (events) => events.map(() => ({ status: "written" })) }
  );
  const considered = await engine.consider({
    episode: episodes[0]!,
    existing: episodes,
    now,
    explicitImportance: true
  });
  return { store, jobs, engine, job: considered.job! };
}

describe("episode pre-compression grounding", () => {
  it("resolves full Unicode text before compaction; assistant context has no source entry", async () => {
    const text = `Please remember: I prefer tea 🍵. ${"原文😀 ".repeat(250)}`;
    const messages = [
      sourceMessage("long", text),
      { ...sourceMessage("assistant", "Invented preference"), role: "assistant" as const }
    ];
    const resolver = new JournalMemoryGroundingResolver(readerFor(receipt({ text }), text));
    const spy = vi.spyOn(resolver, "resolve");
    const sources = await captureEpisodeSources(messages, resolver);
    const episode = assembleRecentEpisodes({ messages, capturedSources: sources, now })[0]!;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ sourceJournalRef: parent, sourceText: text });
    expect(episode.sourceEvidence?.statements).toHaveLength(1);
    expect(episode.sourceEvidence?.statements[0]?.source?.selector).toEqual({
      version: "source-selector.v1",
      modality: "TEXT",
      payload: receipt({ text }).authority.payloads[0]!.ref,
      range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(text).length }
    });
    expect(episode.userStatements[0]!.length).toBeLessThan(text.length);
    expect(episode.sourceEvidence?.statements[0]?.sourceContentDigest).toBe(lineageDigest(text));
    expect(episode.sourceCoverage).toBe("GROUNDED");
  });
  it.each(["missing", "unknown", "wrong-parent", "mismatch", "unavailable", "nonselectable"])(
    "keeps %s ancestry unavailable",
    async (mode) => {
      const text = "Please remember: I prefer tea";
      const envelope = receipt({
        text,
        ...(mode === "wrong-parent" ? { receiptClass: "CONTROL" as const } : {}),
        ...(mode === "unavailable" ? { retention: "NOT_RETAINED" as const } : {}),
        ...(mode === "nonselectable" ? { selectable: false } : {})
      });
      const message = sourceMessage("bad", mode === "mismatch" ? "Different content" : text);
      if (mode === "missing") message.sourceJournalRef = null;
      const sources = await captureEpisodeSources(
        [message],
        new JournalMemoryGroundingResolver(readerFor(mode === "unknown" ? null : envelope, text))
      );
      expect(sources.get("bad")?.source).toBeNull();
      const episode = assembleRecentEpisodes({
        messages: [message],
        capturedSources: sources,
        now
      })[0]!;
      expect(episode.sourceCoverage).toBe("LEGACY_INCOMPLETE");
      const { engine } = await setup([episode]);
      expect(await engine.runDue(now, "worker")).toEqual([]);
    }
  );
  it("fences old portions on stable upsert; only grounded new statements may derive", async () => {
    const grounded = await groundedEpisode();
    const store = new InMemoryRecentEpisodeStore();
    await store.upsert(withEpisodeEvidence(grounded, null));
    const reconstructed = await store.upsert(grounded);
    expect(reconstructed.sourceCoverage).toBe("LEGACY_INCOMPLETE");
    expect(reconstructed.sourceEvidence?.statements).toEqual([]);
    const newer = await groundedEpisode("u2", "Please remember: I prefer coffee.");
    const extended = withEpisodeEvidence(
      {
        ...grounded,
        sourceTurnIds: [...grounded.sourceTurnIds, ...newer.sourceTurnIds],
        userStatements: [...grounded.userStatements, ...newer.userStatements]
      },
      {
        ...grounded.sourceEvidence!,
        statements: [...grounded.sourceEvidence!.statements, ...newer.sourceEvidence!.statements]
      }
    );
    const stored = await store.upsert(extended);
    expect(stored.sourceCoverage).toBe("PARTIAL");
    expect(stored.sourceEvidence!.statements.map((entry) => entry.sourceMessageId)).toEqual(["u2"]);
    const { engine, job } = await setup([stored]);
    const complete = await engine.runJob(job, now, "worker");
    expect(complete.resultEventPayloads?.map((event) => event.content).join()).toContain("coffee");
    expect(complete.resultEventPayloads?.map((event) => event.content).join()).not.toContain("tea");
  });
  it("returns the fenced persisted map rather than reconstructed ancestry in Runtime assembly", async () => {
    const episode = await groundedEpisode();
    const store = new InMemoryRecentEpisodeStore();
    await store.upsert(withEpisodeEvidence(episode, null));
    const text = sourceMessage().content;
    const assembly = await assembleMemoryVNextContext({
      messages: [sourceMessage()],
      now,
      queryText: "",
      directContextText: "",
      persistEpisodes: true,
      episodeStore: store,
      groundingResolver: new JournalMemoryGroundingResolver(readerFor(receipt({ text }), text))
    });
    expect(assembly.episodes[0]?.sourceCoverage).toBe("LEGACY_INCOMPLETE");
  });
});

describe("truthful derived Dream lineage", () => {
  it.each([
    ["typed", "ATTRIBUTED_ASSERTION", "USER_INPUT", "USER_ASSERTION"],
    ["real speech", "DIRECT_OBSERVATION", "EXTERNAL_RESULT", "EXTERNAL_OBSERVATION"],
    ["mock speech", "ATTRIBUTED_ASSERTION", "USER_INPUT", "USER_ASSERTION"]
  ] as const)(
    "preserves %s source origin and unresolved authority",
    async (_, receiptClass, origin, expected) => {
      const text = "Please remember: I prefer tea.";
      const episode = await groundedEpisode("u", text, { text, receiptClass, origin });
      episode.subjectUserId = "compatibility-person";
      const { engine, job } = await setup([episode]);
      const complete = await engine.runJob(job, now, "worker");
      const event = complete.resultEventPayloads![0]!;
      const lineage = derived(event);
      expect(lineage.derivation.kind).toBe("DREAM_DERIVATION");
      expect(lineage.sources[0]?.origin).toBe(expected);
      expect(lineage.sources[0]?.authority.principal.state).toBe("UNRESOLVED");
      expect(lineage.sources[0]?.authority.binding.state).toBe("UNRESOLVED");
      expect(lineage.sources[0]?.authority.audience.kind).toBe("UNKNOWN");
      expect(event.assertion).toEqual({ source: "system", verification: "unverified" });
      expect(event.claim).toBeUndefined();
      expect(event.participants).toBeUndefined();
      expect(event.observedAt).toBeUndefined();
      expect(event.occurredAt).toBeUndefined();
    }
  );
  it("merges recurrence ancestry with heterogeneous authority/time, canonical source order and distinct parent identity", async () => {
    const first = await groundedEpisode("a"),
      second = await groundedEpisode("b");
    const source = second.sourceEvidence!.statements[0]!.source!;
    source.ref.eventId = "jev1_bbbbbbbbbbbbbbbb";
    source.authority.principal = {
      state: "RESOLVED",
      kind: "PRINCIPAL",
      namespace: "test",
      actorId: "actor-b"
    };
    source.authority.binding = {
      state: "RESOLVED",
      kind: "PERSON_BINDING",
      personId: "person-b",
      bindingVersion: "v2"
    };
    source.sourceTime.occurrenceTime = {
      state: "INTERVAL",
      start: "2026-09-29T08:00:00Z",
      end: "2026-09-29T09:00:00Z",
      clockSource: "clock-b",
      uncertaintyMs: 5
    };
    second.sourceEvidenceDigest = episodeEvidenceDigest(second.sourceEvidence!);
    const evidenceSet = {
      ...first.sourceEvidence!,
      statements: [...first.sourceEvidence!.statements, ...second.sourceEvidence!.statements]
    };
    expect(episodeEvidenceDigest(evidenceSet)).toBe(
      episodeEvidenceDigest({ ...evidenceSet, statements: [...evidenceSet.statements].reverse() })
    );
    const { engine, job } = await setup([first, second]);
    const result = await engine.runJob(job, now, "worker");
    expect(result.resultEventPayloads).toHaveLength(1);
    const event = result.resultEventPayloads![0]!,
      lineage = derived(event);
    expect(lineage.sources).toHaveLength(2);
    expect(lineage.sources).toContainEqual(source);
    expect(lineage.sources).toContainEqual(first.sourceEvidence!.statements[0]!.source);
    const reverse = freezeDerivedDreamEvent(event, [...lineage.sources].reverse());
    expect(reverse.lineage).toEqual(event.lineage);
    expect(stampDreamWriteEvent(job.jobId, reverse)).toEqual(event);
    expect(freezeDerivedDreamEvent(event, [source]).lineage?.state).toBe("GROUNDED");
    expect(derived(freezeDerivedDreamEvent(event, [source])).consumerKey).not.toBe(
      lineage.consumerKey
    );
    expect(dreamSourceDigest(freezeDreamSources([second, first]), null)).toBe(
      dreamSourceDigest(freezeDreamSources([first, second]), null)
    );
    expect(dreamSourceDigest(freezeDreamSources([second]), null)).not.toBe(
      dreamSourceDigest(freezeDreamSources([first]), null)
    );
    expect(decodeMemoryLineage(sanitizeSemanticMetadata(buildWriteMetadata(event)))).toEqual(
      MemoryLineageV1Schema.parse(lineage)
    );
  });
  it("keeps hearsay a derivation of the report and never verifies the proposition", async () => {
    const { engine, job } = await setup([
      await groundedEpisode("report", "Please remember: My friend says the restaurant is closed.")
    ]);
    const result = await engine.runJob(job, now, "worker");
    const event = result.resultEventPayloads![0]!;
    expect(event.content).toContain("friend says");
    expect(event.assertion?.verification).toBe("unverified");
    expect(derived(event).origin).toBe("DERIVED");
    expect(event.claim).toBeUndefined();
  });
  it("fences episode mutation during backend delivery", async () => {
    const episode = await groundedEpisode(),
      store = new InMemoryRecentEpisodeStore(),
      jobs = new InMemoryDreamJobStore();
    await store.upsert(episode);
    const added = await groundedEpisode("added", "Please remember: I prefer coffee.");
    const engine = new DreamConsolidationEngine(jobs, store, {
      writer: async (events) => {
        await store.upsert(
          withEpisodeEvidence(
            { ...episode, sourceTurnIds: [...episode.sourceTurnIds, ...added.sourceTurnIds] },
            {
              ...episode.sourceEvidence!,
              statements: [
                ...episode.sourceEvidence!.statements,
                ...added.sourceEvidence!.statements
              ]
            }
          )
        );
        return events.map(() => ({ status: "written" }));
      }
    });
    const admitted = await engine.consider({
      episode,
      existing: [episode],
      now,
      explicitImportance: true
    });
    const result = await engine.runJob(admitted.job!, now, "worker");
    expect(result.status).toBe("complete");
    expect((await store.getById(episode.id))?.status).toBe("active");
    expect(result.resultEventPayloads!.map((event) => event.content).join()).not.toContain(
      "coffee"
    );
  });
  it("freezes source revision before execution and does not consolidate a later-mutated episode", async () => {
    const episode = await groundedEpisode();
    const { store, engine, job } = await setup([episode]);
    const changed = await groundedEpisode("new", "Please remember: I prefer coffee.");
    await store.upsert(
      withEpisodeEvidence(
        { ...episode, sourceTurnIds: [...episode.sourceTurnIds, ...changed.sourceTurnIds] },
        {
          ...episode.sourceEvidence!,
          statements: [...episode.sourceEvidence!.statements, ...changed.sourceEvidence!.statements]
        }
      )
    );
    const result = await engine.runJob(job, now, "worker");
    expect(result.resultEventPayloads!.map((event) => event.content).join()).not.toContain(
      "coffee"
    );
    expect((await store.getById(episode.id))?.status).toBe("active");
  });
});

describe("frozen Dream delivery and legacy recovery", () => {
  it("reclaims a pre-dispatch job safely and never re-derives frozen children after dispatch", async () => {
    const { store, jobs, engine, job } = await setup([await groundedEpisode()]);
    await jobs.save({
      ...job,
      status: "processing",
      leaseOwner: "dead",
      leaseExpiresAt: new Date(now.getTime() - 1).toISOString()
    });
    const [first] = await engine.runDue(now, "restart");
    expect(first?.status).toBe("complete");
    await jobs.save({
      ...first!,
      status: "processing",
      leaseOwner: "dead",
      leaseExpiresAt: new Date(now.getTime() - 1).toISOString()
    });
    vi.spyOn(store, "getById").mockRejectedValue(new Error("must not load mutable episodes"));
    const [reclaimed] = await engine.runDue(now, "restart-2");
    expect(reclaimed?.status).toBe("reconcile_required");
    expect(reclaimed?.resultEventPayloads).toEqual(first?.resultEventPayloads);
    await expect(
      jobs.save({
        ...reclaimed!,
        resultEventPayloads: [{ ...reclaimed!.resultEventPayloads![0]!, content: "conflict" }]
      })
    ).rejects.toThrow("DREAM_FROZEN_PAYLOAD_CONFLICT");
  });
  it.each(["applied", "not_applied", "in_flight", "unknown"] as const)(
    "handles grounded %s without mutable derivation",
    async (status) => {
      const write = vi
        .fn()
        .mockResolvedValueOnce({ status: "rejected", failureClass: "ambiguous" })
        .mockResolvedValue({ status: "written" });
      const { engine, job } = await setup([await groundedEpisode()], {
        provider: { writeEventIdempotent: write, reconcileEvent: async () => ({ status }) }
      });
      const first = await engine.runJob(job, now, "worker");
      const result = await engine.reconcileJob(first, now, "reconciler");
      expect(result.status).toBe(
        status === "applied" || status === "not_applied" ? "complete" : "reconcile_required"
      );
      expect(write).toHaveBeenCalledTimes(status === "not_applied" ? 2 : 1);
      if (status === "not_applied") expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
    }
  );
  it.each(["pending", "processing"] as const)(
    "fails closed on historical %s work",
    async (status) => {
      const { jobs, store, job } = await setup([await groundedEpisode()]);
      const oldJobs = new InMemoryDreamJobStore();
      const old: DreamJob = {
        ...job,
        jobId: `old-${status}`,
        sourceDigest: lineageDigest(status),
        sourceSnapshot: null,
        status,
        leaseExpiresAt: new Date(now.getTime() - 1).toISOString()
      };
      await oldJobs.save(old);
      const writer = vi.fn();
      const engine = new DreamConsolidationEngine(oldJobs, store, { writer });
      const result = await engine.runJob(old, now, "restart");
      expect(result.lastErrorCode).toBe("DREAM_LEGACY_LINEAGE_MISSING");
      expect(writer).not.toHaveBeenCalled();
      expect(await jobs.getById(job.jobId)).not.toBeNull();
    }
  );
  it.each(["applied", "not_applied", "in_flight", "unknown"] as const)(
    "preserves historical frozen %s effects without grounding fabrication",
    async (status) => {
      const { store, job } = await setup([await groundedEpisode()]);
      const jobs = new InMemoryDreamJobStore();
      const write = vi.fn();
      const old = {
        ...job,
        sourceSnapshot: null,
        status: "reconcile_required" as const,
        resultEventPayloads: [
          stampDreamWriteEvent(job.jobId, {
            kind: "fact" as const,
            content: "historical",
            scope: "user"
          })
        ]
      };
      await jobs.save(old);
      const engine = new DreamConsolidationEngine(jobs, store, {
        provider: { writeEventIdempotent: write, reconcileEvent: async () => ({ status }) }
      });
      const result = await engine.reconcileJob(old, now, "reconcile");
      expect(write).not.toHaveBeenCalled();
      expect(result.status).toBe(
        status === "applied"
          ? "complete"
          : status === "not_applied"
            ? "terminal_failed"
            : "reconcile_required"
      );
      expect(result.resultEventPayloads![0]!.lineage).toBeUndefined();
    }
  );
});

describe("generic derived lineage provider round-trip", () => {
  it.each(["UNKNOWN", "INSTANT", "INTERVAL"] as const)(
    "preserves %s parent time through get/search and rejects conflicting metadata",
    async (state) => {
      const episode = await groundedEpisode();
      const source = episode.sourceEvidence!.statements[0]!.source!;
      source.sourceTime.occurrenceTime =
        state === "UNKNOWN"
          ? { state }
          : state === "INSTANT"
            ? { state, at: now.toISOString(), clockSource: "test", uncertaintyMs: 0 }
            : {
                state,
                start: now.toISOString(),
                end: now.toISOString(),
                clockSource: "test",
                uncertaintyMs: 0
              };
      const event = freezeDerivedDreamEvent(
        { kind: "fact", content: "User prefers tea", scope: "user" },
        [source]
      );
      event.metadata = {
        yuviLineageJson: "forged",
        yuviVerification: "verified",
        principal: "forged"
      };
      const metadata = buildWriteMetadata(event);
      expect(decodeMemoryLineage(metadata)).toEqual(event.lineage);
      const record = { id: "backend-uuid", content: event.content, scope: "user", metadata };
      const provider = new Mem0MemoryProvider({
        kind: "mem0",
        get: async () => record,
        search: async () => [record]
      } as unknown as MemoryBackend);
      expect(
        (await provider.getEvent({ id: "mem0:backend-uuid", scope: "user" }))?.lineage
      ).toEqual(event.lineage);
      const result = await provider.retrieveRelevant({ text: "tea", scope: "user" });
      expect(result.events[0]?.lineage).toEqual(event.lineage);
      expect(mapMem0RecordToMemoryEvent(record, "user").lineage).toEqual(
        MemoryLineageV1Schema.parse(event.lineage)
      );
      expect(() =>
        mapMem0RecordToMemoryEvent(
          { ...record, metadata: { ...metadata, yuviAssertionSource: "user" } },
          "user"
        )
      ).toThrow();
      const malformed = structuredClone(derived(event));
      malformed.sources[0]!.ref.eventId = "jev1_bbbbbbbbbbbbbbbb";
      expect(() => encodeMemoryLineage(malformed)).toThrow();
      expect(canonicalLineageJson(event.lineage)).not.toContain('"authority":null');
    }
  );
});
