import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSqlMigrations } from "../migrations.js";
import { finalizedTestResolver, finalizedTestParent } from "../finalized-test-fixture.js";
import { freezeFinalizedMemoryEvent } from "../finalized-memory-lineage.js";
import { canonicalLineageJson, lineageDigest } from "../lineage-encoding.js";
import type { GroundedMemorySource } from "../lineage.js";
import type { MemoryWriteEventInput } from "../provider.js";
import { PostgresMemoryAuthority } from "./store.js";
import { PostgresMemoryProvider } from "./provider.js";
import { verifyMemoryProjection, rebuildMemoryProjection } from "./maintenance.js";
import { importLegacyMemoryBatch } from "./migration.js";
import { MemoryVectorIndexer, embeddingModelTag, enqueueVectorIndexBatch } from "./vector.js";
import { MemoryAuthorityError } from "./types.js";
import {
  FinalizedIngestionService,
  PostgresFinalizedIngestionRepository
} from "../finalized-ingestion-ledger.js";
import { MemoryService } from "../service.js";
import { InMemoryMemoryRepository } from "../repository.js";
import { SemanticMemoryPolicy } from "./semantic-policy.js";

const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
describe.skipIf(!url)("R5 PostgreSQL authority invariants", () => {
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const authority = new PostgresMemoryAuthority(pool);
  const provider = new PostgresMemoryProvider(authority);
  const scope = `yuvi:v1:user:r5-${randomUUID()}:character:r5`;
  beforeAll(async () => {
    const migrations = await readSqlMigrations();
    await pool.query(migrations.find((m) => m.name === "026_memory_authority_v1.sql")!.sql);
  });
  afterAll(() => pool.end());
  async function event(
    content: string,
    seconds: number,
    changes: Partial<MemoryWriteEventInput> = {}
  ) {
    const original = await finalizedTestResolver.resolve({
      sourceJournalRef: finalizedTestParent,
      sourceText: content
    });
    const source: GroundedMemorySource = {
      ...original,
      recordedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seconds)).toISOString(),
      authority: {
        principal: { state: "RESOLVED", kind: "PRINCIPAL", namespace: "r5-test", actorId: "x" },
        binding: {
          state: "RESOLVED",
          kind: "PERSON_BINDING",
          personId: scope.split(":user:")[1]!.split(":character:")[0]!,
          bindingVersion: "1"
        },
        audience: { kind: "PRIVATE", channelRef: "session-" + seconds }
      }
    };
    const semantic = freezeFinalizedMemoryEvent(
      source,
      { scope, kind: "fact", content, ...changes },
      "r5-test"
    );
    return {
      ...semantic,
      idempotencyKey: randomUUID(),
      payloadDigest: lineageDigest(canonicalLineageJson(semantic))
    };
  }
  async function write(input: MemoryWriteEventInput) {
    await provider.prepareEvidence!("FINALIZED_INGESTION", input);
    return provider.writeEventIdempotent(input);
  }
  it("corrects exactly one proposition, preserves same-Journal independent fact and history", async () => {
    const a = await write(await event("Editor A", 1));
    const independent = await write(await event("Tea preference", 1));
    const b = await write(
      await event("Editor B", 2, { kind: "correction", supersedes: [a.eventId!] })
    );
    expect(b.status).toBe("written");
    await expect(
      pool.query("delete from memory_authority_records where scope=$1 and id=$2", [
        scope,
        a.eventId
      ])
    ).rejects.toThrow("MEMORY_AUTHORITY_APPEND_ONLY");
    expect((await provider.knowledge.detail(scope, a.eventId!))?.state).toBe("superseded");
    expect((await provider.knowledge.detail(scope, independent.eventId!))?.state).toBe("current");
    expect((await provider.knowledge.relations(scope, a.eventId!)).relations[0]?.fromId).toBe(
      b.eventId
    );
    expect(
      (await provider.knowledge.search(scope, "Editor", 20)).records.map((r) => r.id)
    ).toContain(b.eventId);
    expect(
      (await provider.knowledge.search(scope, "Editor", 20)).records.map((r) => r.id)
    ).not.toContain(a.eventId);
  });
  it("rejects unadmitted, altered payload and cross-scope targets", async () => {
    const input = await event("No permission", 3);
    expect((await provider.writeEventIdempotent(input)).errorCode).toBe(
      "MEMORY_HOST_ADMISSION_REQUIRED"
    );
    await provider.prepareEvidence!("FINALIZED_INGESTION", input);
    expect((await provider.writeEventIdempotent({ ...input, content: "altered" })).status).toBe(
      "rejected"
    );
    const a = await write(await event("Other scope target", 4));
    const cross = await event("Cross scope attempt", 5, {
      scope: scope + "-other",
      supersedes: [a.eventId!]
    });
    expect((await write(cross)).errorCode).toBe("MEMORY_TARGET_STALE_OR_INACCESSIBLE");
  });
  it("serializes concurrent corrections; rejects delayed stale corrections without harming current", async () => {
    const a = await write(await event("Concurrent A", 6));
    const bs = await Promise.all([
      event("Concurrent B", 7, { supersedes: [a.eventId!] }),
      event("Concurrent C", 8, { supersedes: [a.eventId!] })
    ]);
    const outcomes = await Promise.all(bs.map(write));
    expect(outcomes.filter((o) => o.status === "written")).toHaveLength(1);
    expect(
      outcomes.filter((o) => o.errorCode === "MEMORY_TARGET_STALE_OR_INACCESSIBLE")
    ).toHaveLength(1);
    expect((await write(await event("Late D", 6, { supersedes: [a.eventId!] }))).status).toBe(
      "rejected"
    );
  });
  it("keeps conflict sources and aggregates repeated evidence without duplicate current knowledge", async () => {
    const a = await write(await event("Claim A", 9));
    const b = await write(await event("Claim B", 10, { conflicts: [a.eventId!] }));
    expect((await provider.knowledge.detail(scope, a.eventId!))?.state).toBe("conflicted");
    expect((await provider.knowledge.detail(scope, b.eventId!))?.state).toBe("conflicted");
    const support = await write(await event("Claim A reinforced", 11, { supports: [a.eventId!] }));
    expect((await provider.knowledge.detail(scope, support.eventId!))?.state).toBe("supporting");
  });
  it("reconciles a lost COMMIT response and repeated event exactly once", async () => {
    const input = await event("Lost response", 12);
    await provider.prepareEvidence!("FINALIZED_INGESTION", input);
    let lost = false;
    const faultPool = {
      query: pool.query.bind(pool),
      async connect() {
        const c = await pool.connect();
        return {
          release: () => c.release(),
          async query(sql: string, args?: unknown[]) {
            const result = await c.query(sql, args);
            if (sql === "commit" && !lost) {
              lost = true;
              throw new Error("response lost");
            }
            return result;
          }
        };
      }
    };
    const fault = new PostgresMemoryProvider(new PostgresMemoryAuthority(faultPool));
    expect((await fault.writeEventIdempotent(input)).failureClass).toBe("ambiguous");
    expect(
      (
        await provider.reconcileEvent({
          scope,
          idempotencyKey: input.idempotencyKey,
          payloadDigest: input.payloadDigest
        })
      ).status
    ).toBe("applied");
    expect((await provider.writeEventIdempotent(input)).status).toBe("unchanged");
  });
  it("rolls back failed relation/projection writes; query failure never reports empty", async () => {
    const input = await event("Abort transaction", 13);
    await provider.prepareEvidence!("FINALIZED_INGESTION", input);
    const faultPool = {
      query: pool.query.bind(pool),
      async connect() {
        const c = await pool.connect();
        return {
          release: () => c.release(),
          async query(sql: string, args?: unknown[]) {
            if (sql.includes("insert into memory_authority_current"))
              throw new Error("projection unavailable");
            return c.query(sql, args);
          }
        };
      }
    };
    const fault = new PostgresMemoryProvider(new PostgresMemoryAuthority(faultPool));
    expect((await fault.writeEventIdempotent(input)).status).toBe("rejected");
    expect(
      (
        await provider.reconcileEvent({
          scope,
          idempotencyKey: input.idempotencyKey,
          payloadDigest: input.payloadDigest
        })
      ).status
    ).toBe("not_applied");
    const unavailable = new PostgresMemoryProvider(
      new PostgresMemoryAuthority({
        connect: pool.connect.bind(pool),
        async query() {
          throw new Error("offline");
        }
      })
    );
    expect(
      (
        await unavailable.retrieveRelevant({
          scope,
          text: "Editor",
          access: {
            principal: { namespace: "r5-test", actorId: "x" },
            personId: scope.split(":user:")[1]!.split(":character:")[0]!
          }
        })
      ).status
    ).toBe("error");
  });
  it("verifies/rebuilds a damaged projection and keeps acknowledged writes across a new pool", async () => {
    const page = await provider.knowledge.page({ scope, limit: 2 });
    expect(page.nextCursor).toBeTruthy();
    expect(
      (await provider.knowledge.page({ scope, limit: 2, cursor: page.nextCursor! })).records.every(
        (r) => !page.records.some((old) => old.id === r.id)
      )
    ).toBe(true);
    await pool.query("delete from memory_authority_current where scope=$1 and id=$2", [
      scope,
      page.records[0]!.id
    ]);
    expect((await verifyMemoryProjection(pool, scope)).mismatches).toHaveLength(1);
    await rebuildMemoryProjection(authority, scope);
    expect((await verifyMemoryProjection(pool, scope)).mismatches).toHaveLength(0);
    const fresh = new pg.Pool({ connectionString: url });
    try {
      expect(
        (
          await new PostgresMemoryProvider(new PostgresMemoryAuthority(fresh)).knowledge.detail(
            scope,
            page.records[0]!.id
          )
        )?.state
      ).toBe("current");
    } finally {
      await fresh.end();
    }
  });
  it("imports unverified legacy in checkpointed batches, replays safely and shows history explicitly", async () => {
    const input = await event("Legacy fact", 14);
    const old = await write(input);
    const legacyScope = scope + "-legacy";
    const batch = {
      migrationId: randomUUID(),
      scope: legacyScope,
      source: "synthetic-mem0-export",
      expectedCheckpoint: null,
      nextCheckpoint: "1",
      complete: true,
      records: [{ ...old.event!, scope: legacyScope }]
    };
    expect((await importLegacyMemoryBatch(authority, batch)).imported).toBe(1);
    expect((await importLegacyMemoryBatch(authority, batch)).status).toBe("REPLAYED");
    expect((await provider.knowledge.page({ scope: legacyScope })).records).toHaveLength(0);
    expect((await provider.knowledge.timeline({ scope: legacyScope })).records[0]?.state).toBe(
      "legacy_unverified"
    );
    expect((await provider.knowledge.overview(legacyScope)).compatibility).toBe(
      "LEGACY_UNVERIFIED_PRESENT"
    );
  });
  it("keeps failed migration checkpoint inspectable and rejects changed replay payload", async () => {
    const badScope = scope + "-failed-migration";
    const migrationId = randomUUID();
    const batch = {
      migrationId,
      scope: badScope,
      source: "synthetic-export",
      expectedCheckpoint: null,
      nextCheckpoint: "1",
      complete: false,
      records: [{ scope, sourceRecordId: "wrong-scope" } as any]
    };
    await expect(importLegacyMemoryBatch(authority, batch)).rejects.toThrow(
      "MEMORY_MIGRATION_SCOPE_MISMATCH"
    );
    const failed = (
      await pool.query(
        "select state,checkpoint,error_code from memory_authority_migrations where migration_id=$1",
        [migrationId]
      )
    ).rows[0];
    expect(failed).toMatchObject({
      state: "failed",
      checkpoint: null,
      error_code: "MEMORY_MIGRATION_SCOPE_MISMATCH"
    });
    const recovered = { ...batch, records: [] };
    expect((await importLegacyMemoryBatch(authority, recovered)).status).toBe("COMMITTED");
    await expect(
      importLegacyMemoryBatch(authority, { ...recovered, complete: true })
    ).rejects.toThrow("MEMORY_MIGRATION_BATCH_PAYLOAD_CONFLICT");
    expect(
      (
        await pool.query(
          "select checkpoint from memory_authority_migrations where migration_id=$1",
          [migrationId]
        )
      ).rows[0]?.checkpoint
    ).toBe("1");
  });
  it("reports unknown migration transaction outcomes as reconcile-required and resumes by receipt", async () => {
    const migrationId = randomUUID();
    const batch = {
      migrationId,
      scope: scope + "-unknown-migration",
      source: "synthetic-export",
      expectedCheckpoint: null,
      nextCheckpoint: "1",
      complete: false,
      records: []
    };
    const offline = new PostgresMemoryAuthority({
      query: pool.query.bind(pool),
      async connect() {
        throw new Error("connection lost before transaction");
      }
    });
    await expect(importLegacyMemoryBatch(offline, batch)).rejects.toThrow();
    expect(
      (
        await pool.query("select state from memory_authority_migrations where migration_id=$1", [
          migrationId
        ])
      ).rows[0]?.state
    ).toBe("reconcile_required");
    expect((await importLegacyMemoryBatch(authority, batch)).status).toBe("COMMITTED");
    expect((await importLegacyMemoryBatch(authority, batch)).status).toBe("REPLAYED");
  });
  it("persists semantic failure, never falls back to rules, and recovers a timed-out worker lease", async () => {
    const source = await finalizedTestResolver.resolve({
      sourceJournalRef: finalizedTestParent,
      sourceText: "请记住：引用“请改成B”，实际我偏好茶。"
    });
    let calls = 0;
    const policy = new SemanticMemoryPolicy(
      {
        async generateReasoning() {
          calls++;
          throw new Error("provider timeout");
        }
      },
      async () => [],
      { providerConfigured: true },
      pool
    );
    const input = {
      scope,
      userMessage: source.selectedText,
      groundedSource: source,
      idempotencyKey: randomUUID()
    };
    await expect(policy.build(input)).rejects.toThrow();
    const row = (
      await pool.query("select * from memory_semantic_jobs where scope=$1 and job_id=$2", [
        scope,
        input.idempotencyKey
      ])
    ).rows[0]!;
    expect(row["status"]).toBe("retryable_failed");
    expect(row["result"]).toBeNull();
    await expect(policy.build(input)).rejects.toThrow("MEMORY_SEMANTIC_JOB_NOT_DUE");
    expect(calls).toBe(1);
    await pool.query(
      "update memory_semantic_jobs set status='processing',lease_owner='dead',lease_until=now()-interval '1 minute' where scope=$1 and job_id=$2",
      [scope, input.idempotencyKey]
    );
    await expect(policy.build(input)).rejects.toThrow();
    expect(calls).toBe(2);
  });
  it("retains unbound source as unattributed and never grants reader authority from scope", async () => {
    const input = await event("Unattributed statement", 15);
    const semantic = {
      ...input,
      lineage: {
        ...input.lineage!,
        authority: {
          principal: { state: "UNRESOLVED" as const, reason: "not authenticated" },
          binding: { state: "UNRESOLVED" as const, reason: "not bound" },
          audience: { kind: "UNKNOWN" as const, reason: "unknown audience" }
        }
      }
    };
    const { idempotencyKey, payloadDigest: _digest, ...payload } = semantic;
    const stored = await write({
      ...payload,
      idempotencyKey,
      payloadDigest: lineageDigest(canonicalLineageJson(payload))
    });
    expect(stored.status).toBe("written");
    expect((await provider.knowledge.detail(scope, stored.eventId!))?.state).toBe("unattributed");
    expect((await provider.retrieveRelevant({ scope, text: "Unattributed" })).status).toBe(
      "unavailable"
    );
    expect((await provider.knowledge.overview(scope)).unattributed).toBe("1");
  });
  it("recovers persisted pre-extraction admission in a new service without publishing queue success", async () => {
    const repository = new PostgresFinalizedIngestionRepository(pool);
    const id = randomUUID();
    const sourceText = "No keyword stable project decision";
    const input = {
      finalizedTurnId: "r5-source-" + id,
      assistantMessageId: "r5-assistant-" + id,
      conversationId: "r5-session-" + id,
      traceId: id,
      personaId: "r5",
      subjectUserId: "r5-pending-" + id,
      finalizedAt: "2026-10-01T00:00:00Z",
      ingestionRequested: true,
      userMessage: sourceText,
      assistantMessage: "",
      sourceText,
      sourceJournalRef: finalizedTestParent
    };
    const failed = new FinalizedIngestionService(
      repository,
      {
        semanticOnly: true,
        async build() {
          throw new Error("provider unavailable");
        }
      },
      finalizedTestResolver
    );
    const pending = await failed.admit(input);
    expect(pending.turn.status).toBe("retryable_failed");
    expect(pending.events).toHaveLength(0);
    const recovered = new FinalizedIngestionService(
      repository,
      {
        semanticOnly: true,
        async build(i) {
          return {
            turnKind: "normal",
            events: [{ scope: i.scope, content: i.userMessage, kind: "fact" }]
          };
        }
      },
      finalizedTestResolver
    );
    const admitted = await recovered.admit(input);
    expect(admitted.turn.status).toBe("pending");
    expect(admitted.events).toHaveLength(1);
    const foreignWorker = new PostgresFinalizedIngestionRepository(pool, "foreign-" + id);
    expect(await foreignWorker.getTurn(input.finalizedTurnId)).toBeNull();
    expect(await foreignWorker.listEvents(input.finalizedTurnId)).toEqual([]);
    expect(await foreignWorker.listDueWork()).toEqual([]);
    expect(await foreignWorker.listNonTerminalTurns()).toEqual([]);
    expect((await foreignWorker.getWorkStats()).pendingCount).toBe(0);
    const child = admitted.events[0]!;
    await expect(
      foreignWorker.claimEvent({
        finalizedTurnId: child.finalizedTurnId,
        eventId: child.eventId,
        leaseOwner: "foreign",
        leaseSeconds: 40,
        expectedVersion: child.version
      })
    ).rejects.toThrow("MEMORY_INGESTION_OWNER_MISMATCH");
    expect((await repository.listEvents(input.finalizedTurnId))[0]?.status).toBe("pending");
    const replay = await recovered.admit(input);
    expect(replay.events[0]?.eventId).toBe(admitted.events[0]?.eventId);
  });
  it("keeps authoritative commit when vector indexing fails, repairs missing vectors and retires only target index", async () => {
    const embedding = {
      name: "deterministic-test",
      model: randomUUID(),
      dimensions: 512,
      async embedText() {
        return [1, ...Array(511).fill(0)];
      }
    };
    const indexScope = scope + "-index";
    let fail = true;
    const indexPool = {
      query: pool.query.bind(pool),
      async connect() {
        const c = await pool.connect();
        return {
          release: () => c.release(),
          async query(sql: string, args?: unknown[]) {
            if (fail && sql.includes("insert into memory_authority_vectors"))
              throw new Error("index update failed");
            return c.query(sql, args);
          }
        };
      }
    };
    const store = new PostgresMemoryAuthority(indexPool, embeddingModelTag(embedding));
    const indexing = new MemoryVectorIndexer(store, embedding);
    const indexed = new PostgresMemoryProvider(store, indexing);
    const a = await event("Indexed-A", 16, { scope: indexScope });
    await indexed.prepareEvidence!("FINALIZED_INGESTION", a);
    const ack = await indexed.writeEventIdempotent(a);
    expect(ack.status).toBe("written");
    await indexing.runOnce();
    expect(
      (await indexed.knowledge.processing(indexScope, ack.eventId!)).indexes[0]?.["state"]
    ).toBe("retryable_failed");
    expect((await indexed.knowledge.detail(indexScope, ack.eventId!))?.state).toBe("current");
    fail = false;
    await pool.query(
      "update memory_authority_index_jobs set next_attempt_at=now() where scope=$1",
      [indexScope]
    );
    await indexing.runOnce();
    expect(
      (await indexed.knowledge.processing(indexScope, ack.eventId!)).indexes[0]?.["projection"]
    ).toBe("CURRENT");
    await pool.query("delete from memory_authority_vectors where scope=$1", [indexScope]);
    expect(
      (await indexed.knowledge.processing(indexScope, ack.eventId!)).indexes[0]?.["projection"]
    ).toBe("MISSING");
    await enqueueVectorIndexBatch(store, indexScope, indexing.modelTag);
    await indexing.runOnce();
    expect(
      (await indexed.knowledge.processing(indexScope, ack.eventId!)).indexes[0]?.["projection"]
    ).toBe("CURRENT");
    const b = await event("Indexed-B", 17, { scope: indexScope, supersedes: [ack.eventId!] });
    await indexed.prepareEvidence!("FINALIZED_INGESTION", b);
    expect((await indexed.writeEventIdempotent(b)).status).toBe("written");
    expect(
      (
        await pool.query("select id from memory_authority_vectors where scope=$1 and id=$2", [
          indexScope,
          ack.eventId
        ])
      ).rows
    ).toHaveLength(0);
    expect(
      (await indexed.knowledge.processing(indexScope, ack.eventId!)).indexes[0]?.["projection"]
    ).toBe("RETIRED");
  });
  it("does not disclose prior records from another principal to the semantic model", async () => {
    const own = await event("My original preference", 25);
    const foreign = await event("Another principal's private fact", 26);
    const foreignLineage = foreign.lineage! as any;
    foreignLineage.authority.principal.actorId = "foreign-actor";
    let captured = "";
    const src = await finalizedTestResolver.resolve({
      sourceJournalRef: finalizedTestParent,
      sourceText: "A new preference"
    });
    const groundedSource = { ...src, authority: (own.lineage! as any).authority };
    const policy = new SemanticMemoryPolicy(
      {
        async generateReasoning(request) {
          captured = JSON.stringify(request);
          return { answer: '{"propositions":[]}', reasoning: "" };
        }
      },
      async () =>
        [
          { ...own, id: "own", timestamp: groundedSource.recordedAt, sourceRecordId: "own" },
          {
            ...foreign,
            id: "foreign",
            timestamp: groundedSource.recordedAt,
            sourceRecordId: "foreign"
          }
        ] as any,
      { providerConfigured: true }
    );
    await policy.build({ scope, userMessage: groundedSource.selectedText, groundedSource });
    expect(captured).toContain("My original preference");
    expect(captured).not.toContain("Another principal's private fact");
  });
  it("never defaults a PostgreSQL service to keyword extraction when the semantic policy is missing", async () => {
    const service = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      { kind: "postgres", postgres: provider }
    );
    expect(service.getExtractorStatus()).toMatchObject({
      active: "disabled",
      enabled: false,
      fallbackUsed: false
    });
    await expect(
      service.getIngestionPolicy().build({ scope, userMessage: "请记住：我偏好咖啡。" })
    ).rejects.toThrow("MEMORY_SEMANTIC_POLICY_NOT_CONFIGURED");
    expect(
      new SemanticMemoryPolicy(
        {
          async generateReasoning() {
            throw new Error("unavailable");
          }
        },
        async () => [],
        { providerConfigured: false },
        pool
      ).getStatus()
    ).toMatchObject({ active: "disabled", enabled: false, fallbackUsed: false });
  });
  it("finishes expired last-attempt semantic lease as terminal failure instead of pending forever", async () => {
    const source = await finalizedTestResolver.resolve({
      sourceJournalRef: finalizedTestParent,
      sourceText: "Stable source"
    });
    const input = {
      scope,
      userMessage: source.selectedText,
      groundedSource: source,
      idempotencyKey: randomUUID()
    };
    const policy = new SemanticMemoryPolicy(
      {
        async generateReasoning() {
          throw new Error("timeout");
        }
      },
      async () => [],
      { providerConfigured: true },
      pool
    );
    await expect(policy.build(input)).rejects.toThrow();
    await pool.query(
      "update memory_semantic_jobs set attempts=8,status='processing',lease_until=now()-interval '1 minute' where scope=$1 and job_id=$2",
      [scope, input.idempotencyKey]
    );
    await expect(policy.build(input)).rejects.toThrow("MEMORY_SEMANTIC_RETRY_EXHAUSTED");
    expect(
      (
        await pool.query("select status from memory_semantic_jobs where scope=$1 and job_id=$2", [
          scope,
          input.idempotencyKey
        ])
      ).rows[0]?.["status"]
    ).toBe("terminal_failed");
  });
});
