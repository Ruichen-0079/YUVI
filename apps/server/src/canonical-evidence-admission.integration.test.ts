import { DerivedSourceSnapshotSchema } from "../../../packages/memory/src/lineage.js";
import { randomUUID } from "node:crypto";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PostgresJournalRepository } from "@companion/journal";
import {
  JOURNAL_COMMAND_VERSION,
  type JournalEventRef,
  type JournalPayloadDescriptor
} from "@companion/protocol";
import {
  FinalizedIngestionService,
  PostgresFinalizedIngestionRepository,
  executeFinalizedIngestionEvent,
  JournalMemoryGroundingResolver,
  Mem0MemoryBackend,
  Mem0MemoryProvider,
  PostgresEvidenceAdmissionStore,
  bootstrapPostgresEvidenceAdmissions,
  Mem0ProfileMemorySourceReader,
  LocalProfileProvider,
  PostgresProfileSnapshotStore,
  PostgresProfileLifecycleStore,
  ProfileLifecycleCoordinator,
  PostgresRecentEpisodeStore,
  PostgresDreamJobStore,
  DreamConsolidationEngine,
  assembleMemoryVNextContext,
  buildMemoryScope,
  keyedMem0RecordId,
  MemoryLineageV1Schema,
  type MemoryWriteEventInput,
  type ProfileSubjectV1,
  type ConversationMessage
} from "@companion/memory";
import { readSqlMigrations } from "../../../packages/memory/src/migrations.js";
import { stampDreamWriteEvent } from "../../../packages/memory/src/dream-delivery.js";
import { freezeDerivedDreamEvent } from "../../../packages/memory/src/dream-source.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const sidecarUrl = process.env["YUVI_MEM0_PROFILE_INTEGRATION_URL"];
const schema = `a10_1f3_r1_${randomUUID().replace(/-/gu, "")}`;
const text = "Please remember: I prefer tea 🍵.";
let admin: PostgresPool, pool: PostgresPool, journal: PostgresJournalRepository;
let backend: Mem0MemoryBackend,
  admissions: PostgresEvidenceAdmissionStore,
  provider: Mem0MemoryProvider;
const effects: { memoryId: string; scope: string }[] = [];
const scopes = new Set<string>();

async function receipt(): Promise<JournalEventRef> {
  const ref = { namespace: schema, payloadId: randomUUID(), version: "v1" };
  const payload: JournalPayloadDescriptor = {
    ref,
    modality: "TEXT",
    retention: "RETAINED",
    origin: "USER_INPUT",
    selectable: true,
    characterCount: Array.from(text).length
  };
  const result = await journal.appendWithHostAuthority(
    {
      command: {
        version: JOURNAL_COMMAND_VERSION,
        kind: "RECEIPT",
        causalParents: [],
        occurrenceTime: { state: "UNKNOWN" },
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
    {
      principal: { state: "UNRESOLVED", reason: "synthetic validation identity" },
      subjects: [],
      binding: { state: "UNRESOLVED", reason: "no Person binding" },
      audience: { kind: "UNKNOWN", reason: "synthetic local scope" },
      surface: { kind: "LOCAL", reference: "r1-local-test" },
      correlations: [],
      disclosurePolicy: { state: "UNRESOLVED", reason: "synthetic fixture" },
      policyVersion: "r1-test.v1",
      producer: { name: "r1-host-validation", version: "1" },
      sourceReferences: [{ kind: "UNRESOLVED_SOURCE", reason: "synthetic input" }],
      payloads: [payload]
    }
  );
  return {
    kind: "JOURNAL_EVENT",
    namespace: result.envelope.journalNamespace,
    eventId: result.envelope.eventId
  };
}
async function finalized(label: string) {
  const identity = `r1-${label}-${randomUUID()}`;
  const ref = await receipt();
  const workflow = new PostgresFinalizedIngestionRepository(pool);
  const service = new FinalizedIngestionService(
    workflow,
    undefined,
    new JournalMemoryGroundingResolver(journal)
  );
  const input = {
    finalizedTurnId: identity,
    assistantMessageId: `${identity}:assistant`,
    sourceUserEventId: `${identity}:user`,
    conversationId: identity,
    traceId: identity,
    personaId: "r1-validation",
    subjectUserId: identity,
    finalizedAt: new Date().toISOString(),
    ingestionRequested: true,
    userMessage: text,
    assistantMessage: "Understood.",
    sourceJournalRef: ref,
    sourceText: text
  };
  const admitted = await service.admit(input);
  expect(admitted.events).toHaveLength(1);
  const event = admitted.events[0]!;
  const scope = event.eventPayload.scope!;
  scopes.add(scope);
  const subject: ProfileSubjectV1 = { kind: "MEMORY_SCOPE", scope };
  const reader = new Mem0ProfileMemorySourceReader(backend, admissions);
  const read = () => reader.listEligibleSources({ subject, asOf: new Date().toISOString() });
  const deliver = async () => {
    effects.push({ scope, memoryId: keyedMem0RecordId(event.backendIdempotencyKey) });
    return executeFinalizedIngestionEvent({
      repository: workflow,
      provider,
      event,
      leaseOwner: identity,
      leaseSeconds: 30
    });
  };
  return { ref, identity, input, service, workflow, event, scope, subject, reader, read, deliver };
}
async function model(reader: Mem0ProfileMemorySourceReader, subject: ProfileSubjectV1) {
  const profiles = new LocalProfileProvider({
    resolveSourceReader: () => reader,
    store: new PostgresProfileSnapshotStore(pool)
  });
  const lifecycle = new PostgresProfileLifecycleStore(pool);
  const coordinator = new ProfileLifecycleCoordinator(lifecycle, undefined, {
    reader,
    provider: profiles,
    backend: "mem0",
    compositionToken: {}
  });
  await lifecycle.enroll(subject);
  for (let n = 0; n < 8; n++) {
    const row = await lifecycle.get(subject);
    if (
      row?.candidateRevision &&
      !row.regenerationNeeded &&
      row.candidateVersion === row.controlVersion
    )
      break;
    const waitMs = Math.min(
      1_000,
      Math.max(0, Date.parse(row?.nextAttemptAt ?? "") - Date.now()) || 250
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs + 20));
    await (coordinator as unknown as { runTick(): Promise<void> }).runTick();
  }
  return {
    coordinator,
    profiles,
    read: () => coordinator.readScopeModel({ subject, readMemory: true })
  };
}
async function groundedDream(f: Awaited<ReturnType<typeof finalized>>) {
  const episodes = new PostgresRecentEpisodeStore(pool);
  const jobs = new PostgresDreamJobStore(pool);
  const message: ConversationMessage = {
    id: `${f.identity}:source`,
    sessionId: f.identity,
    role: "user",
    status: "completed",
    content: text,
    personaId: "r1-validation",
    subjectUserId: f.identity,
    sourceJournalRef: f.ref,
    traceId: f.identity,
    parentMessageId: null,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    metadata: {},
    sequence: 1
  };
  await assembleMemoryVNextContext({
    now: new Date(),
    queryText: "",
    directContextText: "",
    messages: [message],
    sessionId: f.identity,
    memoryScope: f.scope,
    subjectUserId: f.identity,
    personaId: "r1-validation",
    episodeStore: episodes,
    persistEpisodes: true,
    groundingResolver: new JournalMemoryGroundingResolver(journal)
  });
  const sources = await episodes.listActive({
    now: new Date(),
    subjectUserId: f.identity,
    personaId: "r1-validation",
    limit: 10
  });
  expect(sources).toHaveLength(1);
  expect(sources[0]!.sourceCoverage).toBe("GROUNDED");
  const engine = new DreamConsolidationEngine(jobs, episodes, { provider });
  const considered = await engine.consider({
    episode: sources[0]!,
    existing: sources,
    now: new Date(),
    explicitImportance: true
  });
  const complete = await engine.runJob(considered.job!, new Date(), f.identity);
  expect(complete.status, JSON.stringify(complete)).toBe("complete");
  const dream = complete.resultEventPayloads![0]!;
  effects.push({ scope: f.scope, memoryId: keyedMem0RecordId(dream.idempotencyKey!) });
  return { dream, complete };
}

function dreamClaim(input: MemoryWriteEventInput) {
  const lineage = input.lineage!;
  if (lineage.state !== "GROUNDED" || !("authority" in lineage))
    throw new Error("Expected direct source");
  return stampDreamWriteEvent(
    randomUUID(),
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

describe.skipIf(!databaseUrl || !sidecarUrl)(
  "A10.1f3-r1 real PostgreSQL + managed Mem0 canonical admission",
  () => {
    beforeAll(async () => {
      admin = createPostgresPool(databaseUrl!);
      await admin.query(`create schema ${schema}`);
      pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema},public` });
      const migrations = await readSqlMigrations();
      for (const migration of migrations) await pool.query(migration.sql);
      await pool.query(migrations.find((entry) => entry.name.startsWith("019"))!.sql);
      journal = new PostgresJournalRepository(pool, {
        namespace: schema,
        authorityBuilder() {
          throw new Error("Host authority required.");
        }
      });
      backend = new Mem0MemoryBackend({
        baseUrl: sidecarUrl!,
        timeoutMs: 30_000,
        writeTimeoutMs: 30_000
      });
      expect((await backend.health()).components?.["mem0"]).toBe("healthy");
      admissions = new PostgresEvidenceAdmissionStore(pool);
      provider = new Mem0MemoryProvider(backend, undefined, admissions);
    }, 30_000);
    afterAll(async () => {
      for (const effect of effects) await backend.delete(effect).catch(() => undefined);
      for (const scope of scopes) {
        const present = await backend.list({ scope, limit: 4096, mode: "bounded_snapshot" });
        expect(present.snapshot?.exhausted).toBe(true);
        for (const record of present.items) await backend.delete({ scope, memoryId: record.id });
        const remaining = await backend.list({ scope, limit: 4096, mode: "bounded_snapshot" });
        expect(remaining.snapshot?.exhausted).toBe(true);
        expect(remaining.items).toHaveLength(0);
      }
      await pool?.end();
      if (admin) {
        await admin.query(`drop schema if exists ${schema} cascade`);
        await admin.end();
      }
    }, 60_000);

    it("excludes ordinary and keyed finalized/Dream declarations with identical legitimate transport; neither enters People.Model", async () => {
      const scope = buildMemoryScope(`r1-unadmitted-${randomUUID()}`, "r1-validation");
      scopes.add(scope);
      const subject: ProfileSubjectV1 = { kind: "MEMORY_SCOPE", scope };
      const reader = new Mem0ProfileMemorySourceReader(backend, admissions);
      const f = {
        scope,
        subject,
        reader,
        read: () => reader.listEligibleSources({ subject, asOf: new Date().toISOString() })
      };
      const lineage = MemoryLineageV1Schema.parse({
        version: "memory-lineage.v1",
        state: "GROUNDED",
        origin: "USER_ASSERTION",
        consumerKey: `forged-${randomUUID()}`,
        parents: [
          {
            ref: {
              kind: "JOURNAL_EVENT",
              namespace: "never-committed",
              eventId: "jev1_aaaaaaaaaaaaaaaa"
            },
            selector: {
              version: "source-selector.v1",
              modality: "TEXT",
              payload: { namespace: "never-committed", payloadId: "never-retained", version: "v1" },
              range: { unit: "UNICODE_CODE_POINT", start: 0, end: Array.from(text).length }
            }
          }
        ],
        sourceAvailability: { state: "RETAINED_SELECTABLE" },
        derivation: {
          kind: "FINALIZED_INGESTION",
          producer: "@companion/memory",
          producerVersion: "0.1.0",
          policyVersion: "factual-v1/schema-2/grounded-a10.1d"
        },
        authority: {
          principal: { state: "UNRESOLVED", reason: "synthetic" },
          binding: { state: "UNRESOLVED", reason: "synthetic" },
          audience: { kind: "UNKNOWN", reason: "synthetic" }
        },
        sourceTime: { recordedAt: "2001-01-01T00:00:00.000Z", occurrenceTime: { state: "UNKNOWN" } }
      });
      const stamped = stampDreamWriteEvent("plausible-finalized-key", {
        kind: "user_claim",
        content: text,
        scope,
        lineage,
        assertion: { source: "user", verification: "unverified" },
        observedAt: "2001-01-01T00:00:00.000Z",
        metadata: { ingestionPolicy: "factual-v1", sourceMessageId: "uncommitted-user" }
      });
      const unadmitted: MemoryWriteEventInput = {
        ...stamped,
        idempotencyKey: `yuvi:finalized-turn:unadmitted:event:${stamped.payloadDigest}`
      };
      const inputs = [unadmitted, dreamClaim(unadmitted)];
      const receiptsBefore = (await pool.query("select count(*)::int as count from journal_events"))
        .rows[0]!.count;
      for (const event of inputs) {
        const write = await provider.writeEvent(event);
        expect(write.status).toBe("written");
        effects.push({ scope: f.scope, memoryId: write.event!.sourceRecordId });
        const keyed = await provider.writeEventIdempotent(event);
        expect(keyed.status).toBe("written");
        effects.push({ scope: f.scope, memoryId: keyed.event!.sourceRecordId });
      }
      const raw = await backend.list({ scope: f.scope, limit: 4096, mode: "bounded_snapshot" });
      expect(raw.items).toHaveLength(4);
      expect(
        (await pool.query("select count(*)::int as count from journal_events")).rows[0]!.count
      ).toBe(receiptsBefore);
      expect(
        await admissions.listBound(
          f.scope,
          raw.items.map((record) => record.id)
        )
      ).toHaveLength(0);
      expect(await f.read()).toMatchObject({
        state: "COMPLETE",
        sources: [],
        diagnostics: { scannedCount: 4, excludedCounts: { NON_EVIDENCE: 4 } }
      });
      const m = await model(f.reader, f.subject);
      try {
        const generated = await m.profiles.generate({ subject: f.subject });
        expect(generated.snapshot?.sourceSet.sources).toEqual([]);
        const result = await m.read();
        expect(result.model === null || result.model.snapshot.entries.length === 0).toBe(true);
      } finally {
        await m.coordinator.shutdown({ graceMs: 2_000 });
      }
    }, 60_000);

    it("real Journal → finalized → exact admission/effect → f1 replay → VERIFIED People.Model; copied lineage stays excluded", async () => {
      const f = await finalized("positive");
      const delivered = await f.deliver();
      expect(delivered.outcome?.status, JSON.stringify(delivered.outcome)).toBe("written");
      const first = await admissions.get(f.scope, f.event.backendIdempotencyKey);
      expect(first?.state).toBe("EFFECT_BOUND");
      expect(first?.backendRecordId).toBe(delivered.event?.backendMemoryId?.slice(5));
      const replay = await f.service.admit(f.input);
      expect(replay.events[0]!.eventId).toBe(f.event.eventId);
      await provider.prepareEvidence("FINALIZED_INGESTION", replay.events[0]!.eventPayload);
      expect((await provider.writeEventIdempotent(replay.events[0]!.eventPayload)).status).toBe(
        "unchanged"
      );
      expect(await admissions.get(f.scope, f.event.backendIdempotencyKey)).toEqual(first);
      const copied = await provider.writeEvent(f.event.eventPayload);
      effects.push({ scope: f.scope, memoryId: copied.event!.sourceRecordId });
      expect((await f.read()).sources).toHaveLength(1);
      const m = await model(f.reader, f.subject);
      try {
        const generated = await m.profiles.generate({ subject: f.subject });
        const replayProfile = await m.profiles.generate({ subject: f.subject });
        expect(generated.state).toBe("COMPLETE");
        expect(replayProfile).toMatchObject({ persistence: "REPLAY" });
        const result = await m.read();
        expect(result.state).toBe("AVAILABLE");
        if (result.state !== "AVAILABLE") throw new Error(JSON.stringify(result));
        expect(result.model.freshness.state).toBe("VERIFIED_AT_SOURCE_READ");
        expect(result.model.snapshot.entries).toHaveLength(1);
        expect(result.model.personBinding.state).toBe("UNBOUND_SCOPE");
      } finally {
        await m.coordinator.shutdown({ graceMs: 2_000 });
      }
    }, 60_000);

    it("real grounded episode → frozen Dream → canonical admission/effect → DERIVED Profile; direct A and Dream(A) share one root and VERIFIED model", async () => {
      const f = await finalized("dream");
      await f.deliver();
      const { dream } = await groundedDream(f);
      expect((await admissions.get(f.scope, dream.idempotencyKey!))?.state).toBe("EFFECT_BOUND");
      const read = await f.read();
      expect(read.sources).toHaveLength(2);
      expect(read.sources.map((source) => source.lineage.origin).sort()).toEqual([
        "DERIVED",
        "USER_ASSERTION"
      ]);
      expect(read.sources[0]!.roots.map((root) => root.rootKey)).toEqual(
        read.sources[1]!.roots.map((root) => root.rootKey)
      );
      const m = await model(f.reader, f.subject);
      try {
        const result = await m.read();
        expect(result.state).toBe("AVAILABLE");
        if (result.state !== "AVAILABLE") throw new Error(JSON.stringify(result));
        expect(result.model.freshness.state).toBe("VERIFIED_AT_SOURCE_READ");
        expect(
          new Set(read.sources.flatMap((source) => source.roots.map((root) => root.rootKey))).size
        ).toBe(1);
      } finally {
        await m.coordinator.shutdown({ graceMs: 2_000 });
      }
    }, 60_000);

    it("reopens PostgreSQL and reconstructs provable finalized and Dream effects only; unsupported effects stay unsupported", async () => {
      const f = await finalized("bootstrap");
      await f.deliver();
      await groundedDream(f);
      const original = await pool.query(
        "select admission from memory_evidence_admissions where scope=$1 and state='EFFECT_BOUND' order by admission_id",
        [f.scope]
      );
      expect(original.rows).toHaveLength(2);
      const totalBound = (
        await pool.query(
          "select count(*)::int as count from memory_evidence_admissions where state='EFFECT_BOUND'"
        )
      ).rows[0]!.count;
      await pool.query("delete from memory_evidence_admissions where scope=$1", [f.scope]); // Task schema only: simulate pre-r1 durable host state.
      const reopened = createPostgresPool(databaseUrl!, {
        options: `-c search_path=${schema},public`
      });
      try {
        const restarted = new PostgresEvidenceAdmissionStore(reopened);
        const counts = await bootstrapPostgresEvidenceAdmissions(reopened, restarted);
        expect(counts.bound).toBe(totalBound);
        const reconstructed = await reopened.query(
          "select admission from memory_evidence_admissions where scope=$1 and state='EFFECT_BOUND' order by admission_id",
          [f.scope]
        );
        expect(reconstructed.rows).toEqual(original.rows);
        expect((await bootstrapPostgresEvidenceAdmissions(reopened, restarted)).bound).toBe(
          totalBound
        );
        for (const scope of scopes) {
          const read = await new Mem0ProfileMemorySourceReader(
            backend,
            restarted
          ).listEligibleSources({
            subject: { kind: "MEMORY_SCOPE", scope },
            asOf: new Date().toISOString()
          });
          expect(read.state).toBe("COMPLETE");
          if (scope.includes("r1-unadmitted")) expect(read.sources).toHaveLength(0);
        }
        await expect(
          reopened.query(
            "update memory_evidence_admissions set admission=jsonb_set(admission,'{effectDigest}',to_jsonb($1::text)) where state='EFFECT_BOUND'",
            ["b".repeat(64)]
          )
        ).rejects.toThrow("EVIDENCE_ADMISSION_IMMUTABLE");
      } finally {
        await reopened.end();
      }
    }, 60_000);

    it("prohibits generic mutation and deletion removes eligibility and withholds a previously verified model", async () => {
      const f = await finalized("delete");
      await f.deliver();
      const memoryId = keyedMem0RecordId(f.event.backendIdempotencyKey);
      await expect(
        backend.update({ memoryId, scope: f.scope, content: "generic mutation" })
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect((await f.read()).sources).toHaveLength(1);
      const m = await model(f.reader, f.subject);
      try {
        expect((await m.read()).state).toBe("AVAILABLE");
        await backend.delete({ memoryId, scope: f.scope });
        expect(await backend.get({ memoryId, scope: f.scope })).toBeNull();
        expect(await f.read()).toMatchObject({ state: "COMPLETE", sources: [] });
        expect((await m.read()).state).toBe("WITHHELD");
        expect((await admissions.get(f.scope, f.event.backendIdempotencyKey))?.state).toBe(
          "EFFECT_BOUND"
        );
      } finally {
        await m.coordinator.shutdown({ graceMs: 2_000 });
      }
    }, 60_000);

    it("canonical authority unavailable with real stored effects fails closed", async () => {
      const f = await finalized("unavailable");
      await f.deliver();
      const offlinePool = createPostgresPool(databaseUrl!, {
        options: `-c search_path=${schema},public`
      });
      const offline = new PostgresEvidenceAdmissionStore(offlinePool);
      await offlinePool.end();
      const reader = new Mem0ProfileMemorySourceReader(backend, offline);
      expect(
        await reader.listEligibleSources({ subject: f.subject, asOf: new Date().toISOString() })
      ).toMatchObject({ state: "UNAVAILABLE", sources: [], reasons: ["ADMISSION_UNAVAILABLE"] });
      const m = await model(reader, f.subject);
      try {
        expect((await m.read()).model).toBeNull();
      } finally {
        await m.coordinator.shutdown({ graceMs: 2_000 });
      }
    }, 60_000);
    it("PostgreSQL concurrent binding and replay preserve one immutable effect identity", async () => {
      const f = await finalized("fencing");
      await provider.prepareEvidence("FINALIZED_INGESTION", f.event.eventPayload);
      const firstId = randomUUID(),
        secondId = randomUUID();
      const outcomes = await Promise.allSettled([
        admissions.bind(f.scope, f.event.backendIdempotencyKey, firstId),
        admissions.bind(f.scope, f.event.backendIdempotencyKey, secondId)
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const frozen = await admissions.get(f.scope, f.event.backendIdempotencyKey);
      await provider.prepareEvidence("FINALIZED_INGESTION", f.event.eventPayload);
      expect(await admissions.get(f.scope, f.event.backendIdempotencyKey)).toEqual(frozen);
      expect((await f.read()).sources).toEqual([]); // Store fencing alone never invents a present effect.
    });
  }
);
