import { MemoryService } from "./service.js";
import { InMemoryMemoryRepository } from "./repository.js";
import { assembleDreamFixtureEpisodes } from "./dream-test-fixture.js";
import { freezeDreamSources, dreamSourceDigest, groundedDreamStatements } from "./dream-source.js";
import { DerivedSourceSnapshotSchema } from "./lineage.js";
import { describe, it, expect, vi } from "vitest";
import {
  InMemoryEvidenceAdmissionStore,
  PostgresEvidenceAdmissionStore,
  prepareEvidenceAdmission,
  keyedMem0RecordId,
  memoryEffectDigest
} from "./evidence-admission.js";
import { reconstructEvidenceAdmissions } from "./evidence-admission-bootstrap.js";
import { InMemoryFinalizedIngestionRepository } from "./finalized-ingestion-ledger.js";
import { FinalizedIngestionService } from "./finalized-test-fixture.js";
import { executeFinalizedIngestionEvent } from "./finalized-ingestion-executor.js";
import { freezeDerivedDreamEvent } from "./dream-source.js";
import { stampDreamWriteEvent, deliverDreamEventsIdempotent, reconcileDreamEvent } from "./dream-delivery.js";
import { Mem0MemoryProvider, buildWriteMetadata } from "./providers/mem0-memory-provider.js";
import { Mem0ProfileMemorySourceReader } from "./profile-source-reader.js";
import type { MemoryBackend, MemoryRecord } from "./backend.js";
import type { MemoryWriteEventInput } from "./provider.js";
import { LocalProfileProvider } from "./profile-provider.js";
import { InMemoryProfileSnapshotStore } from "./profile-snapshot-store.js";
import { sameLegacyMemoryPartition } from "./scope.js";

const asOf = "2026-10-03T00:00:00.000Z";
const base = {
  finalizedTurnId: "finalized-turn:canonical",
  assistantMessageId: "assistant:canonical",
  sourceUserEventId: "user:canonical",
  conversationId: "conversation:canonical",
  traceId: "trace:canonical",
  personaId: "canonical",
  subjectUserId: "canonical",
  finalizedAt: asOf,
  ingestionRequested: true,
  userMessage: "Please remember that I prefer tea.",
  assistantMessage: "Understood."
};
async function fixture() {
  const workflow = new InMemoryFinalizedIngestionRepository();
  const admitted = await new FinalizedIngestionService(workflow).admit(base);
  const event = admitted.events[0]!;
  const input = event.eventPayload;
  const records = new Map<string, MemoryRecord>();
  const backend = {
    kind: "mem0",
    get: async ({ memoryId }: { memoryId: string }) =>
      structuredClone(records.get(memoryId) ?? null),
    list: async () => ({
      items: structuredClone([...records.values()]),
      snapshot: { mode: "bounded_snapshot", exhausted: true, rawBytesExceeded: false }
    }),
    submitIdempotent: vi.fn(
      async (value: {
        scope: string;
        content: string;
        metadata: Record<string, unknown>;
        idempotencyKey: string;
      }) => {
        const id = keyedMem0RecordId(value.idempotencyKey);
        const old = records.get(id);
        const record = old ?? {
          id,
          scope: value.scope,
          content: value.content,
          metadata: Object.fromEntries(
            Object.entries({ schemaVersion: 1, ...value.metadata }).filter(
              ([, entry]) => entry !== null
            )
          )
        };
        records.set(id, record);
        return {
          memoryId: id,
          operation: old ? "unchanged" : "created",
          record: structuredClone(record)
        };
      }
    ),
    reconcileIdempotency: async () => ({
      status: "applied",
      memoryId: keyedMem0RecordId(input.idempotencyKey!)
    })
  } as unknown as MemoryBackend;
  const store = new InMemoryEvidenceAdmissionStore();
  const provider = new Mem0MemoryProvider(backend, undefined, store);
  const reader = new Mem0ProfileMemorySourceReader(backend, store);
  const subject = { kind: "MEMORY_SCOPE" as const, scope: input.scope! };
  const read = () => reader.listEligibleSources({ subject, asOf });
  const deliver = () =>
    executeFinalizedIngestionEvent({
      repository: workflow,
      provider,
      event,
      leaseOwner: "canonical-test",
      leaseSeconds: 30
    });
  return {
    workflow,
    event,
    input,
    records,
    backend,
    store,
    provider,
    reader,
    subject,
    read,
    deliver
  };
}
function recordFor(
  input: MemoryWriteEventInput,
  id = keyedMem0RecordId(input.idempotencyKey!)
): MemoryRecord {
  return {
    id,
    scope: input.scope!,
    content: input.content.trim(),
    metadata: Object.fromEntries(
      Object.entries({ schemaVersion: 1, ...buildWriteMetadata(input) }).filter(
        ([, entry]) => entry !== null
      )
    )
  };
}
function dreamFor(input: MemoryWriteEventInput) {
  const lineage = input.lineage!;
  if (lineage.state !== "GROUNDED" || !("authority" in lineage))
    throw new Error("Direct source missing");
  return stampDreamWriteEvent(
    "canonical-dream",
    freezeDerivedDreamEvent(
      input,
      lineage.parents.map((parent) =>
        DerivedSourceSnapshotSchema.parse({
          ...parent,
          origin: lineage.origin,
          authority: lineage.authority,
          sourceTime: lineage.sourceTime
        })
      )
    )
  );
}

describe("canonical host evidence admission", () => {
  it("admission preparation failure cannot dispatch a finalized or Dream effect", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "prepare").mockRejectedValue(new Error("host store unavailable"));
    await expect(f.deliver()).rejects.toThrow("host store unavailable");
    expect(f.backend.submitIdempotent).not.toHaveBeenCalled();
    const outcomes = await deliverDreamEventsIdempotent(f.provider, [dreamFor(f.input)]);
    expect(outcomes[0]?.failureClass).toBe("ambiguous");
    expect(f.backend.submitIdempotent).not.toHaveBeenCalled();
    expect((await f.read()).sources).toEqual([]);
  });

  it.each(["finalized", "dream"] as const)("%s effect success followed by bind failure stays unsupported until exact reconciliation", async (kind) => {
    const f = await fixture();
    const event = kind === "dream" ? dreamFor(f.input) : f.input;
    const binding = vi.spyOn(f.store, "bind").mockRejectedValueOnce(new Error("bind acknowledgement lost"));
    const outcome = kind === "dream" ? (await deliverDreamEventsIdempotent(f.provider, [event]))[0] : (await f.deliver()).outcome;
    expect(outcome?.status === "ambiguous" || (outcome && "failureClass" in outcome && outcome.failureClass === "ambiguous")).toBe(true);
    expect(f.records.size).toBe(1);
    expect((await f.read()).sources).toEqual([]);
    expect((await f.store.get(event.scope!, event.idempotencyKey!))?.state).toBe("PREPARED");
    const writes = vi.mocked(f.backend.submitIdempotent!).mock.calls.length;
    // The backend probes its frozen key, never retries the effect on applied.
    f.backend.reconcileIdempotency = async () => ({ status: "applied", memoryId: keyedMem0RecordId(event.idempotencyKey!) });
    const reconciled = kind === "dream" ? await reconcileDreamEvent(f.provider, event) : await f.provider.reconcileEvent({ scope: event.scope, idempotencyKey: event.idempotencyKey!, payloadDigest: event.payloadDigest! });
    expect(reconciled.status).toBe("applied");
    expect(binding).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.backend.submitIdempotent!).mock.calls.length).toBe(writes);
    expect((await f.read()).sources).toHaveLength(1);
  });

  it("concurrent process-local effect binding cannot transfer a prepared admission", async () => {
    const f = await fixture();
    await f.provider.prepareEvidence("FINALIZED_INGESTION", f.input);
    const results = await Promise.allSettled([
      f.store.bind(
        f.subject.scope,
        f.input.idempotencyKey!,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      ),
      f.store.bind(f.subject.scope, f.input.idempotencyKey!, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await f.store.get(f.subject.scope, f.input.idempotencyKey!))?.backendRecordId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
  });

  it("a shared process-local authority survives active MemoryService composition replacement", async () => {
    const f = await fixture();
    await f.deliver();
    const replacement = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      { kind: "mem0", mem0: f.backend, evidenceAdmissions: f.store }
    );
    expect(
      await replacement
        .getProfileMemorySourceReader()
        .listEligibleSources({ subject: f.subject, asOf })
    ).toMatchObject({ state: "COMPLETE", diagnostics: { eligibleCount: 1 } });
  });

  it("reconstructs frozen completed Dream history and never promotes missing or changed source/result history", async () => {
    const f = await fixture();
    const episode = assembleDreamFixtureEpisodes({
      now: new Date(asOf),
      messages: [
        {
          id: "history-source",
          sessionId: "history",
          role: "user",
          status: "completed",
          content: base.userMessage,
          traceId: "history",
          parentMessageId: null,
          createdAt: asOf,
          completedAt: asOf,
          metadata: {},
          sequence: 1
        }
      ],
      memoryScope: f.subject.scope
    })[0]!;
    const snapshot = freezeDreamSources([episode]);
    const event = stampDreamWriteEvent(
      "historical-dream",
      freezeDerivedDreamEvent(
        f.input,
        groundedDreamStatements(snapshot).map((entry) => entry.source!)
      )
    );
    const job = {
      jobId: "historical-dream",
      sourceSnapshot: snapshot,
      sourceDigest: dreamSourceDigest(snapshot, f.subject.scope),
      memoryScope: f.subject.scope,
      resultEventPayloads: [event],
      status: "complete" as const
    };
    const restarted = new InMemoryEvidenceAdmissionStore();
    expect(
      await reconstructEvidenceAdmissions(restarted, {
        dreams: [
          job,
          { ...job, sourceSnapshot: null },
          { ...job, resultEventPayloads: [{ ...event, content: "invented rewrite" }] }
        ]
      })
    ).toEqual({ prepared: 1, bound: 1, unsupported: 2 });
    expect((await restarted.get(f.subject.scope, event.idempotencyKey!))?.backendRecordId).toBe(
      keyedMem0RecordId(event.idempotencyKey!)
    );
    const pending = new InMemoryEvidenceAdmissionStore();
    expect(
      await reconstructEvidenceAdmissions(pending, {
        dreams: [{ ...job, status: "reconcile_required" }]
      })
    ).toEqual({ prepared: 1, bound: 0, unsupported: 0 });
    expect(
      await pending.listBound(f.subject.scope, [keyedMem0RecordId(event.idempotencyKey!)])
    ).toEqual([]);
  });
  it("internally contradictory canonical state is an integrity failure rather than definitive absence", async () => {
    const f = await fixture();
    await f.deliver();
    const corrupted = new PostgresEvidenceAdmissionStore({
      query: async () => ({ rows: [{ admission: { version: "evidence-admission.v1" } }] })
    });
    expect(
      await new Mem0ProfileMemorySourceReader(f.backend, corrupted).listEligibleSources({
        subject: f.subject,
        asOf
      })
    ).toMatchObject({ state: "ERROR", sources: [], reasons: ["ADMISSION_INVALID"] });
  });
  it.each(["yuviObservedAt", "yuviAssertionSource", "yuviVerification"])(
    "changed %s cannot preserve canonical eligibility",
    async (field) => {
      const f = await fixture();
      await f.deliver();
      const original = [...f.records.values()][0]!;
      f.records.set(original.id, {
        ...original,
        metadata: {
          ...original.metadata,
          [field]:
            field === "yuviObservedAt"
              ? "2001-01-01T00:00:00.000Z"
              : field === "yuviAssertionSource"
                ? "system"
                : "verified"
        }
      });
      expect(await f.read()).toMatchObject({
        state: "COMPLETE",
        sources: [],
        diagnostics: { excludedCounts: { NON_EVIDENCE: 1 } }
      });
    }
  );

  it.each(["finalized", "dream", "keyed"] as const)(
    "excludes structurally valid unadmitted %s transport and keeps COMPLETE",
    async (kind) => {
      const f = await fixture();
      const input = kind === "dream" ? dreamFor(f.input) : f.input;
      const stored = kind === "keyed" ? await f.provider.writeEventIdempotent(input) : null;
      if (stored) expect(stored.status).toBe("written");
      else f.records.set(keyedMem0RecordId(input.idempotencyKey!), recordFor(input));
      expect(await f.read()).toMatchObject({
        state: "COMPLETE",
        sources: [],
        diagnostics: { excludedCounts: { NON_EVIDENCE: 1 } }
      });
      const profile = new LocalProfileProvider({
        resolveSourceReader: () => f.reader,
        store: new InMemoryProfileSnapshotStore(),
        now: () => asOf
      });
      const generated = await profile.generate({ subject: f.subject });
      expect(generated.snapshot?.sourceSet.sources).toEqual([]);
      expect(await f.store.listBound(f.subject.scope, [...f.records.keys()])).toEqual([]);
    }
  );
  it("admits legitimate finalized delivery and exact replay converges on one admission/effect", async () => {
    const f = await fixture();
    expect((await f.deliver()).outcome?.status).toBe("written");
    const first = await f.store.get(f.subject.scope, f.input.idempotencyKey!);
    expect(first?.state).toBe("EFFECT_BOUND");
    expect((await f.read()).sources).toHaveLength(1);
    await f.provider.prepareEvidence("FINALIZED_INGESTION", f.input);
    expect((await f.provider.writeEventIdempotent(f.input)).status).toBe("unchanged");
    expect(await f.store.get(f.subject.scope, f.input.idempotencyKey!)).toEqual(first);
    expect(f.records.size).toBe(1);
  });
  it("copies cannot borrow an admission, even with byte-identical metadata", async () => {
    const f = await fixture();
    await f.deliver();
    const original = [...f.records.values()][0]!;
    f.records.set("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      ...original,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    });
    expect((await f.read()).sources.map((source) => source.memory.sourceRecordId)).toEqual([
      original.id
    ]);
  });
  it("scope and payload/effect mismatches cannot borrow admission", async () => {
    const f = await fixture();
    await f.deliver();
    const original = [...f.records.values()][0]!;
    expect(await f.store.listBound("different-scope", [original.id])).toEqual([]);
    f.records.set(original.id, { ...original, scope: "different-scope" });
    expect(await f.read()).toMatchObject({
      state: "ERROR",
      sources: [],
      reasons: ["SCOPE_MISMATCH"]
    });
    f.records.set(original.id, { ...original, content: original.content + " modified" });
    expect(await f.read()).toMatchObject({ state: "COMPLETE", sources: [] });
    f.records.set(original.id, {
      ...original,
      metadata: { ...original.metadata, yuviPayloadDigest: "b".repeat(64) }
    });
    expect(await f.read()).toMatchObject({ state: "COMPLETE", sources: [] });
    f.records.set(original.id, {
      ...original,
      metadata: { ...original.metadata, createdBy: "rewritten" }
    });
    expect(await f.read()).toMatchObject({ state: "COMPLETE", sources: [] });
  });
  it("preparation is inactive; deletion removes present eligibility while preserving history", async () => {
    const f = await fixture();
    await f.provider.prepareEvidence("FINALIZED_INGESTION", f.input);
    f.records.set(keyedMem0RecordId(f.input.idempotencyKey!), recordFor(f.input));
    expect((await f.read()).sources).toHaveLength(0);
    await f.deliver();
    expect((await f.read()).sources).toHaveLength(1);
    f.records.clear();
    expect(await f.read()).toMatchObject({ state: "COMPLETE", sources: [] });
    expect((await f.store.get(f.subject.scope, f.input.idempotencyKey!))?.state).toBe(
      "EFFECT_BOUND"
    );
  });
  it("legitimate Dream converges on the same authority and preserves the direct root", async () => {
    const f = await fixture();
    await f.deliver();
    const dream = dreamFor(f.input);
    expect(await deliverDreamEventsIdempotent(f.provider, [dream])).toMatchObject([
      { status: "written" }
    ]);
    const read = await f.read();
    expect(read.state).toBe("COMPLETE");
    expect(read.sources).toHaveLength(2);
    expect(read.sources[0]!.roots.map((root) => root.rootKey)).toEqual(
      read.sources[1]!.roots.map((root) => root.rootKey)
    );
    expect(read.sources.map((source) => source.lineage.origin).sort()).toEqual([
      "DERIVED",
      "USER_ASSERTION"
    ]);
  });
  it("authority absence and unavailability fail closed, including an empty backend", async () => {
    const f = await fixture();
    const broken = {
      ...f.store,
      listBound: async () => {
        throw new Error("connection unavailable");
      }
    } as unknown as InMemoryEvidenceAdmissionStore;
    expect(
      await new Mem0ProfileMemorySourceReader(f.backend, broken).listEligibleSources({
        subject: f.subject,
        asOf
      })
    ).toMatchObject({ state: "UNAVAILABLE", sources: [], reasons: ["ADMISSION_UNAVAILABLE"] });
    expect(
      await new Mem0ProfileMemorySourceReader(f.backend).listEligibleSources({
        subject: f.subject,
        asOf
      })
    ).toMatchObject({ state: "UNAVAILABLE", reasons: ["ADMISSION_UNAVAILABLE"] });
  });
  it("fences semantic/effect rebinding and rejects a delivery identity with altered payload", async () => {
    const f = await fixture();
    await f.deliver();
    expect(() =>
      prepareEvidenceAdmission("FINALIZED_INGESTION", { ...f.input, content: "borrowed key" })
    ).toThrow("EVIDENCE_DELIVERY_IDENTITY_INVALID");
    await expect(
      f.store.bind(f.subject.scope, f.input.idempotencyKey!, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    ).rejects.toThrow("EVIDENCE_EFFECT_CONFLICT");
    const frozen = prepareEvidenceAdmission("FINALIZED_INGESTION", f.input);
    await expect(f.store.prepare({ ...frozen, effectDigest: "b".repeat(64) })).rejects.toThrow(
      "EVIDENCE_ADMISSION_CONFLICT"
    );
  });
  it("reconstructs only exact frozen applied finalized history without metadata or invented receipts", async () => {
    const f = await fixture();
    await f.deliver();
    const applied = (await f.workflow.listEvents(f.event.finalizedTurnId))[0]!;
    const restarted = new InMemoryEvidenceAdmissionStore();
    expect(
      await reconstructEvidenceAdmissions(restarted, {
        finalized: [
          applied,
          { ...applied, eventPayload: { ...applied.eventPayload, content: "unproven rewrite" } }
        ]
      })
    ).toEqual({ prepared: 1, bound: 1, unsupported: 1 });
    expect(await restarted.get(f.subject.scope, f.input.idempotencyKey!)).toEqual(
      await f.store.get(f.subject.scope, f.input.idempotencyKey!)
    );
  });
  it("effect digest ignores storage clocks but binds every evidence-bearing metadata field", async () => {
    const f = await fixture();
    const record = recordFor(f.input);
    expect(
      memoryEffectDigest({ ...record, metadata: { ...record.metadata, updated_at: asOf } })
    ).toBe(memoryEffectDigest(record));
    expect(
      memoryEffectDigest({ ...record, metadata: { ...record.metadata, confidence: 0.99 } })
    ).not.toBe(memoryEffectDigest(record));
  });
  it("legacy partition identity includes both subject and persona", () => {
    expect(
      sameLegacyMemoryPartition(
        { subjectUserId: "u", personaId: "a" },
        { subjectUserId: "u", personaId: "b" }
      )
    ).toBe(false);
    expect(
      sameLegacyMemoryPartition(
        { subjectUserId: "u", personaId: "a" },
        { subjectUserId: "v", personaId: "a" }
      )
    ).toBe(false);
    expect(
      sameLegacyMemoryPartition({}, { subjectUserId: "default-user", personaId: "default-persona" })
    ).toBe(true);
  });
});
