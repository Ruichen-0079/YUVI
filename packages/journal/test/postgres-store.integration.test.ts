import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "@companion/database";
import {
  PostgresJournalRepository,
  JournalStoreError,
  type JournalAppendInput,
  type JournalAuthorityDraft,
  type JournalEventCommand,
  type JournalPayloadDescriptor
} from "../src/index.js";
import { readSqlMigrations, runPostgresMigrations } from "../../memory/src/migrations.js";
import { createMemoryRepositoryFromEnv } from "../../memory/src/repository.js";
import { createConversationRepositoryFromEnv } from "../../memory/src/conversation-repository.js";
import { createFinalizedIngestionRepositoryFromEnv } from "../../memory/src/finalized-ingestion-ledger.js";
import { createRecentEpisodeStoreFromEnv } from "../../memory/src/recent-episode-store.js";
import { PostgresDreamJobStore } from "../../memory/src/dream-consolidation.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `journal_test_${randomBytes(5).toString("hex")}`;
const schemaSql = `"${schema}"`;
let adminPool: ReturnType<typeof createPostgresPool> | undefined;
let pool: ReturnType<typeof createPostgresPool> | undefined;

describe.skipIf(!databaseUrl)("PostgreSQL Journal store integration", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query(`create schema ${schemaSql}`);
    const migrations = await readSqlMigrations();
    const journalMigration = migrations.find((migration) => migration.name === "013_life_event_journal_v1.sql");
    expect(journalMigration).toBeDefined();
    await runPostgresMigrations({
      databaseUrl: databaseUrl!,
      migrations: [journalMigration!],
      settings: { search_path: schema }
    });
    pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists ${schemaSql} cascade`);
      await adminPool.end();
    }
  });

  it("creates the schema on a clean namespace and safely reapplies its migration", async () => {
    const migrations = await readSqlMigrations();
    const journalMigration = migrations.find((migration) => migration.name === "013_life_event_journal_v1.sql")!;
    await runPostgresMigrations({
      databaseUrl: databaseUrl!,
      migrations: [journalMigration],
      settings: { search_path: schema }
    });
    const tables = await pool!.query(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_name = any($2::text[])`,
      [schema, ["journal_namespaces", "journal_events", "journal_event_parents", "journal_payloads", "journal_source_dedup"]]
    );
    expect(new Set(tables.rows.map((row) => row["table_name"]))).toEqual(
      new Set(["journal_namespaces", "journal_events", "journal_event_parents", "journal_payloads", "journal_source_dedup"])
    );
  });

  it("assigns event identity, commit sequence and recording time, and reconstructs after reopen", async () => {
    const namespace = "reopen-contract";
    const first = repo(namespace, { now: () => new Date("2026-09-24T00:00:00.000Z") });
    const result = await first.append({ command: receiptCommand() });
    expect(result.status).toBe("APPENDED");
    expect(result.envelope.eventId).toMatch(/^jev1_[A-Za-z0-9_-]{16,}$/);
    expect(result.envelope.commitSeq).toBe(1);
    expect(result.envelope.recordedAt).toBe("2026-09-24T00:00:00.000Z");

    for (const authorityField of ["eventId", "commitSeq", "recordedAt", "principal", "audience", "policyVersion"]) {
      await expectStoreCode(
        first.append({ command: receiptCommand(), [authorityField]: "producer-value" } as unknown as JournalAppendInput),
        "INVALID_PROPOSAL"
      );
    }
    await expectStoreCode(
      first.append({ command: { ...receiptCommand(), eventId: "jev1_aaaaaaaaaaaaaaaa" } }),
      "INVALID_PROPOSAL"
    );
    await expectStoreCode(
      first.append({ command: { ...receiptCommand(), commitSeq: 800, recordedAt: "2020-01-01T00:00:00Z" } }),
      "INVALID_PROPOSAL"
    );
    await expectStoreCode(
      first.append({ command: { ...receiptCommand(), version: "life-event-command.v99" } }),
      "UNSUPPORTED_SCHEMA_VERSION"
    );

    const reopenedPool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
    try {
      const reopened = repo(namespace, {}, reopenedPool);
      expect(await reopened.get(eventRef(namespace, result.envelope.eventId))).toEqual(result.envelope);
      expect(await reopened.get(eventRef("different-journal", result.envelope.eventId))).toBeNull();
      const second = await reopened.append({ command: receiptCommand() });
      expect(second.envelope.eventId).not.toBe(result.envelope.eventId);
      expect(second.envelope.commitSeq).toBe(2);
    } finally {
      await reopenedPool.end();
    }
  });

  it("accepts per-request host authority separately and retains repository-owned commit fields", async () => {
    const hostOnly = new PostgresJournalRepository(pool!, {
      namespace: "host-authority-api",
      authorityBuilder() {
        throw new Error("Host-authority appends must not depend on the static builder.");
      }
    });
    const result = await hostOnly.appendWithHostAuthority(
      { command: receiptCommand() },
      {
        principal: { state: "UNRESOLVED", reason: "test transport has no principal" },
        subjects: [],
        binding: { state: "UNRESOLVED", reason: "test has no Person binding" },
        surface: { kind: "LOCAL", reference: "test:host-authority" },
        correlations: [],
        audience: { kind: "UNKNOWN", reason: "test has no audience snapshot" },
        disclosurePolicy: { state: "UNRESOLVED", reason: "test has no policy snapshot" },
        policyVersion: "host-policy.v1",
        producer: { name: "trusted-test-host", version: "1" },
        sourceReferences: [{ kind: "UNRESOLVED_SOURCE", reason: "no stable upstream ID" }],
        payloads: []
      }
    );
    expect(result.envelope).toMatchObject({
      journalNamespace: "host-authority-api",
      commitSeq: 1,
      authority: {
        principal: { state: "UNRESOLVED" },
        audience: { kind: "UNKNOWN" },
        producer: { name: "trusted-test-host" }
      }
    });
    expect(result.envelope.eventId).toMatch(/^jev1_[A-Za-z0-9_-]{16,}$/);

    await expectStoreCode(
      hostOnly.appendWithHostAuthority(
        { command: { ...receiptCommand(), principal: { state: "RESOLVED" } } },
        {
          principal: { state: "UNRESOLVED", reason: "test transport has no principal" },
          subjects: [],
          binding: { state: "UNRESOLVED", reason: "test has no Person binding" },
          surface: { kind: "LOCAL", reference: "test:host-authority" },
          correlations: [],
          audience: { kind: "UNKNOWN", reason: "test has no audience snapshot" },
          disclosurePolicy: { state: "UNRESOLVED", reason: "test has no policy snapshot" },
          policyVersion: "host-policy.v1",
          producer: { name: "trusted-test-host", version: "1" },
          sourceReferences: [{ kind: "UNRESOLVED_SOURCE", reason: "no stable upstream ID" }],
          payloads: []
        }
      ),
      "INVALID_PROPOSAL"
    );
  });

  it("validates all seven event kinds and persists only the validated committed envelopes", async () => {
    const namespace = "all-kinds-contract";
    const source = await repo(namespace).append({ command: receiptCommand() });
    const sourceRef = eventRef(namespace, source.envelope.eventId);
    const text: JournalPayloadDescriptor = {
      ...retainedTextDescriptor("payload:source", "source-text", 5),
      sourceEvent: sourceRef
    };
    const receipt = await repo(namespace).append({
      command: receiptCommand([textSelector(text)], [sourceRef]),
      payloads: [text],
      retainedText: [{ ref: text.ref, text: "hello" }]
    });
    const receiptRef = eventRef(namespace, receipt.envelope.eventId);
    const decision = await repo(namespace).append({
      command: {
        version: "life-event-command.v1",
        kind: "DECISION",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [receiptRef],
        data: { choice: "SELECT", inputRefs: [receiptRef], alternatives: [] }
      }
    });
    const decisionRef = eventRef(namespace, decision.envelope.eventId);
    const intent = await repo(namespace).append({
      command: {
        version: "life-event-command.v1",
        kind: "INTENT",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [decisionRef],
        data: { actionRef: "action:local", effectContractRef: "effect:local" }
      }
    });
    const intentRef = eventRef(namespace, intent.envelope.eventId);
    const attempt = await repo(namespace).append({
      command: {
        version: "life-event-command.v1",
        kind: "ATTEMPT",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [intentRef],
        data: { intent: intentRef, dispatchBoundary: "MAY_BEGIN" }
      }
    });
    const attemptRef = eventRef(namespace, attempt.envelope.eventId);
    const outcome = await repo(namespace).append({
      command: {
        version: "life-event-command.v1",
        kind: "OUTCOME",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [attemptRef],
        data: { attempt: attemptRef, certainty: "UNKNOWN", evidenceSelectors: [] }
      }
    });
    const derivation = await repo(namespace).append({
      command: {
        version: "life-event-command.v1",
        kind: "DERIVATION",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [sourceRef],
        data: {
          derivedRef: "annotation:one",
          derivationKind: "ANNOTATION",
          sourceSelectors: [textSelector(text)],
          sourceEvents: [sourceRef],
          derivationVersion: "fixture.v1"
        }
      },
      payloads: [text]
    });
    const amendment = await repo(namespace).append({
      command: {
        version: "life-event-command.v1",
        kind: "AMENDMENT",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [receiptRef],
        data: { target: receiptRef, relation: "RETRACTION", reasonRef: "reason:correction" }
      }
    });

    const envelopes = [receipt, decision, intent, attempt, outcome, derivation, amendment].map((item) => item.envelope);
    expect(envelopes.map((envelope) => envelope.command.kind)).toEqual([
      "RECEIPT", "DECISION", "INTENT", "ATTEMPT", "OUTCOME", "DERIVATION", "AMENDMENT"
    ]);
    expect(envelopes.map((envelope) => envelope.commitSeq)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    const parentOrder = await pool!.query(
      `select p.parent_event_id, parent.commit_seq as parent_seq, child.commit_seq as child_seq
       from journal_event_parents p
       join journal_events parent on parent.journal_namespace = p.journal_namespace and parent.event_id = p.parent_event_id
       join journal_events child on child.journal_namespace = p.journal_namespace and child.event_id = p.event_id
       where p.journal_namespace = $1`,
      [namespace]
    );
    expect(parentOrder.rows.length).toBeGreaterThan(0);
    expect(parentOrder.rows.every((row) => Number(row["parent_seq"]) < Number(row["child_seq"]))).toBe(true);
  });

  it("rejects unknown and cross-namespace parents without accepting an event", async () => {
    const namespace = "parent-validation";
    const unknown = eventRef(namespace, "jev1_aaaaaaaaaaaaaaaa");
    await expectStoreCode(
      repo(namespace).append({ command: receiptCommand([], [unknown]) }),
      "UNKNOWN_PARENT"
    );
    await expectStoreCode(
      repo(namespace).append({ command: receiptCommand([], [eventRef("other-journal", "jev1_bbbbbbbbbbbbbbbb")]) }),
      "CROSS_NAMESPACE_PARENT"
    );
    const state = await pool!.query(
      `select current_seq from journal_namespaces where journal_namespace = $1`,
      [namespace]
    );
    expect(Number(state.rows[0]?.["current_seq"] ?? 0)).toBe(0);
  });

  it("rolls back event, payload, dedup and sequence when an insertion fails", async () => {
    const namespace = "rollback-contract";
    await pool!.query(`
      create function journal_force_rollback() returns trigger language plpgsql as $$
      begin raise exception 'forced journal rollback'; end
      $$
    `);
    await pool!.query(`create trigger journal_force_rollback before insert on journal_events for each row execute function journal_force_rollback()`);
    try {
      await expectStoreCode(
        repo(namespace).append({
          command: receiptCommand(),
          sourceDedup: { namespace: "source:fixture", key: "receipt-1", normalizedPayload: "body" }
        }),
        "TRANSACTION_FAILED"
      );
    } finally {
      await pool!.query("drop trigger if exists journal_force_rollback on journal_events");
      await pool!.query("drop function if exists journal_force_rollback()");
    }
    const eventCount = await pool!.query(`select count(*)::int as count from journal_events where journal_namespace = $1`, [namespace]);
    const dedupCount = await pool!.query(`select count(*)::int as count from journal_source_dedup where journal_namespace = $1`, [namespace]);
    const sequence = await pool!.query(`select current_seq from journal_namespaces where journal_namespace = $1`, [namespace]);
    expect(Number(eventCount.rows[0]?.["count"])).toBe(0);
    expect(Number(dedupCount.rows[0]?.["count"])).toBe(0);
    expect(Number(sequence.rows[0]?.["current_seq"] ?? 0)).toBe(0);
  });

  it("deduplicates only a stable scoped source identity and conflicts on changed payload", async () => {
    const namespace = "dedup-contract";
    const first = await repo(namespace).append({
      command: receiptCommand(),
      sourceDedup: { namespace: "transport:local", key: "message-44", normalizedPayload: "same source bytes" }
    });
    const duplicate = await repo(namespace).append({
      command: receiptCommand(),
      sourceDedup: { namespace: "transport:local", key: "message-44", normalizedPayload: "same source bytes" }
    });
    expect(duplicate.status).toBe("DEDUPLICATED");
    expect(duplicate.envelope.eventId).toBe(first.envelope.eventId);
    await expectStoreCode(
      repo(namespace).append({
        command: receiptCommand(),
        sourceDedup: { namespace: "transport:local", key: "message-44", normalizedPayload: "changed bytes" }
      }),
      "SOURCE_DEDUP_CONFLICT"
    );

    const withoutSourceKeyA = await repo(namespace).append({ command: receiptCommand() });
    const withoutSourceKeyB = await repo(namespace).append({ command: receiptCommand() });
    expect(withoutSourceKeyA.envelope.eventId).not.toBe(withoutSourceKeyB.envelope.eventId);
    expect(withoutSourceKeyA.envelope.commitSeq + 1).toBe(withoutSourceKeyB.envelope.commitSeq);
  });

  it("reopens retained text with immutable bounds and keeps unavailable payload content absent", async () => {
    const namespace = "payload-retention";
    const retained = retainedTextDescriptor("payload:inbound", "text-v1", 5);
    const notRetained = textDescriptor("payload:inbound", "text-not-retained", "NOT_RETAINED", false);
    const unavailable = textDescriptor("payload:inbound", "text-unavailable", "UNAVAILABLE", false);
    const appended = await repo(namespace).append({
      command: receiptCommand([textSelector(retained)]),
      payloads: [retained, notRetained, unavailable],
      retainedText: [{ ref: retained.ref, text: "hello" }]
    });
    const reopenedPool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
    try {
      const reopened = repo(namespace, {}, reopenedPool);
      const envelope = await reopened.get(eventRef(namespace, appended.envelope.eventId));
      expect(envelope?.authority.payloads.map((payload) => payload.retention)).toEqual([
        "RETAINED", "NOT_RETAINED", "UNAVAILABLE"
      ]);
      expect(await reopened.resolveRetainedText(retained.ref)).toMatchObject({
        text: "hello",
        descriptor: { characterCount: 5, ref: retained.ref }
      });
      expect(await reopened.resolveRetainedText(notRetained.ref)).toBeNull();
      expect(await reopened.resolveRetainedText(unavailable.ref)).toBeNull();
      const absentRows = await reopenedPool.query(
        `select text_content, content_sha256 from journal_payloads
         where journal_namespace = $1 and payload_namespace = $2 and payload_id = any($3::text[])`,
        [namespace, "payload:inbound", [notRetained.ref.payloadId, unavailable.ref.payloadId]]
      );
      expect(absentRows.rows).toHaveLength(2);
      expect(absentRows.rows.every((row) => row["text_content"] === null && row["content_sha256"] === null)).toBe(true);
    } finally {
      await reopenedPool.end();
    }
  });

  it("does not archive retained raw media", async () => {
    const namespace = "raw-media-disabled";
    const image: JournalPayloadDescriptor = {
      ref: { namespace: "payload:camera", payloadId: "image-1", version: "v1" },
      modality: "IMAGE",
      retention: "RETAINED",
      origin: "USER_INPUT",
      selectable: true,
      width: 640,
      height: 480
    };
    await expectStoreCode(
      repo(namespace).append({ command: receiptCommand(), payloads: [image] }),
      "PAYLOAD_PERSISTENCE_FAILED"
    );
    const events = await pool!.query(`select count(*)::int as count from journal_events where journal_namespace = $1`, [namespace]);
    expect(Number(events.rows[0]?.["count"])).toBe(0);
  });

  it("keeps Journal durable with Mem0 selected and no PostgreSQL Memory repository", async () => {
    const namespace = "mem0-orthogonal";
    const memory = createMemoryRepositoryFromEnv(
      {
        DATABASE_URL: databaseUrl,
        MEMORY_REPOSITORY: "in-memory",
        MEMORY_BACKEND: "mem0"
      },
      pool!
    );
    expect(memory.kind).toBe("in-memory");
    const journal = repo(namespace);
    const appended = await journal.append({ command: receiptCommand() });
    await memory.close?.();
    expect((await journal.get(eventRef(namespace, appended.envelope.eventId)))?.eventId).toBe(
      appended.envelope.eventId
    );
  });

  it("lets AppContext-style repositories share one Pool without closing it twice", async () => {
    const namespace = "shared-pool-lifetime";
    const sharedPool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
    const env = { DATABASE_URL: databaseUrl, MEMORY_REPOSITORY: "postgres" };
    const memory = createMemoryRepositoryFromEnv(env, sharedPool);
    const conversation = createConversationRepositoryFromEnv(
      { ...env, CONVERSATION_REPOSITORY: "postgres" },
      sharedPool
    );
    const ledger = createFinalizedIngestionRepositoryFromEnv(
      { ...env, LEDGER_REPOSITORY: "postgres" },
      sharedPool
    );
    const episodes = createRecentEpisodeStoreFromEnv(env, sharedPool);
    const dreamJobs = new PostgresDreamJobStore(sharedPool);
    const journal = repo(namespace, {}, sharedPool);
    try {
      await Promise.all([
        memory.close?.(),
        conversation.close?.(),
        ledger.close?.(),
        episodes.close?.(),
        dreamJobs.close()
      ]);
      expect((await sharedPool.query("select 1 as ok")).rows[0]?.["ok"]).toBe(1);
      const appended = await journal.append({ command: receiptCommand() });
      expect((await journal.get(eventRef(namespace, appended.envelope.eventId)))?.eventId).toBe(
        appended.envelope.eventId
      );
    } finally {
      await sharedPool.end();
    }
  });

  it("reports an unavailable database as a typed append failure", async () => {
    const unreachablePool = createPostgresPool("postgresql://127.0.0.1:1/yuvi", {
      connectionTimeoutMillis: 100
    });
    try {
      await expectStoreCode(
        repo("database-unavailable", {}, unreachablePool).append({ command: receiptCommand() }),
        "DATABASE_UNAVAILABLE"
      );
    } finally {
      await unreachablePool.end();
    }
  });

  it("serializes overlapping appends through COMMIT rather than only allocating unique numbers", async () => {
    const namespace = "commit-order-serialization";
    await pool!.query(
      `insert into journal_namespaces (journal_namespace, current_seq) values ($1, 0) on conflict do nothing`,
      [namespace]
    );
    const lockKeyA = 21891;
    const lockKeyB = 37901;
    await pool!.query(`
      create function journal_block_first_append() returns trigger language plpgsql as $$
      begin
        if new.event_id = 'jev1_aaaaaaaaaaaaaaaa' then
          perform pg_advisory_xact_lock(${lockKeyA}, ${lockKeyB});
        end if;
        return new;
      end
      $$
    `);
    await pool!.query(`create trigger journal_block_first_append before insert on journal_events for each row execute function journal_block_first_append()`);
    const blockerPool = createPostgresPool(databaseUrl!, {
      max: 1,
      options: `-c search_path=${schema} -c application_name=journal_blocker`
    });
    const poolA = createPostgresPool(databaseUrl!, {
      max: 1,
      options: `-c search_path=${schema} -c application_name=journal_append_a`
    });
    const poolB = createPostgresPool(databaseUrl!, {
      max: 1,
      options: `-c search_path=${schema} -c application_name=journal_append_b`
    });
    const blocker = await blockerPool.connect();
    try {
      await blocker.query("select pg_advisory_lock($1, $2)", [lockKeyA, lockKeyB]);
      const repositoryA = repo(namespace, { createEventId: () => "jev1_aaaaaaaaaaaaaaaa" }, poolA);
      const repositoryB = repo(namespace, { createEventId: () => "jev1_bbbbbbbbbbbbbbbb" }, poolB);
      let aSettled = false;
      let bSettled = false;
      const appendA = repositoryA.append({ command: receiptCommand() }).finally(() => { aSettled = true; });
      await waitForActivity("journal_append_a", (row) => row["wait_event"] === "advisory");
      const appendB = repositoryB.append({ command: receiptCommand() }).finally(() => { bSettled = true; });
      await waitForActivity(
        "journal_append_b",
        (row) => row["wait_event_type"] === "Lock" && String(row["query"]).includes("current_seq")
      );
      expect(aSettled).toBe(false);
      expect(bSettled).toBe(false);
      const visible = await pool!.query(`select event_id, commit_seq from journal_events where journal_namespace = $1`, [namespace]);
      expect(visible.rows).toEqual([]);

      await blocker.query("select pg_advisory_unlock($1, $2)", [lockKeyA, lockKeyB]);
      const [resultA, resultB] = await Promise.all([appendA, appendB]);
      expect(resultA.envelope.commitSeq).toBe(1);
      expect(resultB.envelope.commitSeq).toBe(2);
      const durable = await pool!.query(
        `select event_id, commit_seq from journal_events where journal_namespace = $1 order by commit_seq`,
        [namespace]
      );
      expect(durable.rows.map((row) => [row["event_id"], Number(row["commit_seq"])] )).toEqual([
        ["jev1_aaaaaaaaaaaaaaaa", 1],
        ["jev1_bbbbbbbbbbbbbbbb", 2]
      ]);
    } finally {
      await blocker.query("select pg_advisory_unlock($1, $2)", [lockKeyA, lockKeyB]).catch(() => undefined);
      blocker.release();
      await Promise.all([poolA.end(), poolB.end(), blockerPool.end()]);
      await pool!.query("drop trigger if exists journal_block_first_append on journal_events");
      await pool!.query("drop function if exists journal_block_first_append()");
    }
  });
});

function repo(
  namespace: string,
  overrides: { now?: () => Date; createEventId?: () => string } = {},
  connectedPool = pool!
): PostgresJournalRepository {
  return new PostgresJournalRepository(connectedPool, {
    namespace,
    authorityBuilder: ({ command, payloads }): JournalAuthorityDraft => {
      const intentAuthorization = command.kind === "INTENT"
        ? {
            kind: "AUTHORIZED_INTENT" as const,
            decision: command.causalParents[0]!,
            actionRef: command.data.actionRef,
            effectContractRef: command.data.effectContractRef,
            policyVersion: "policy.test.v1"
          }
        : undefined;
      return {
        principal: { state: "UNRESOLVED", reason: "transport identity not assigned in storage test" },
        subjects: [],
        binding: { state: "UNRESOLVED", reason: "no person binding in storage fixture" },
        surface: { kind: "LOCAL" },
        correlations: [],
        audience: { kind: "UNKNOWN", reason: "no audience snapshot in storage fixture" },
        disclosurePolicy: { state: "UNRESOLVED", reason: "no disclosure policy in storage fixture" },
        policyVersion: "policy.test.v1",
        producer: { name: "journal-test-host", version: "1" },
        sourceReferences: command.kind === "RECEIPT"
          ? [{ kind: "CONVERSATION_MESSAGE", sessionId: "session:test", messageId: "message:test" }]
          : [],
        payloads: [...payloads],
        ...(intentAuthorization ? { intentAuthorization } : {})
      };
    },
    ...overrides
  });
}

function receiptCommand(
  evidenceSelectors: unknown[] = [],
  causalParents: ReturnType<typeof eventRef>[] = []
): JournalEventCommand {
  return {
    version: "life-event-command.v1",
    kind: "RECEIPT",
    occurrenceTime: { state: "UNKNOWN" },
    causalParents,
    data: { receiptClass: "DIRECT_OBSERVATION", evidenceSelectors }
  } as JournalEventCommand;
}

function retainedTextDescriptor(
  payloadNamespace: string,
  payloadId: string,
  characterCount: number
): JournalPayloadDescriptor {
  return textDescriptor(payloadNamespace, payloadId, "RETAINED", true, characterCount);
}

function textDescriptor(
  payloadNamespace: string,
  payloadId: string,
  retention: "RETAINED" | "REDACTED" | "NOT_RETAINED" | "UNAVAILABLE",
  selectable: boolean,
  characterCount?: number
): JournalPayloadDescriptor {
  return {
    ref: { namespace: payloadNamespace, payloadId, version: "v1" },
    modality: "TEXT",
    retention,
    origin: "USER_INPUT",
    selectable,
    ...(characterCount !== undefined ? { characterCount } : {})
  };
}

function textSelector(payload: JournalPayloadDescriptor) {
  return {
    version: "source-selector.v1" as const,
    modality: "TEXT" as const,
    payload: payload.ref,
    range: { unit: "UNICODE_CODE_POINT" as const, start: 0, end: 5 }
  };
}

function eventRef(namespace: string, eventId: string) {
  return { kind: "JOURNAL_EVENT" as const, namespace, eventId };
}

async function expectStoreCode(promise: Promise<unknown>, code: JournalStoreError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected JournalStoreError ${code}.`);
}

async function waitForActivity(
  applicationName: string,
  predicate: (row: Record<string, unknown>) => boolean
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await adminPool!.query(
      `select wait_event_type, wait_event, query from pg_stat_activity where application_name = $1`,
      [applicationName]
    );
    const row = result.rows.find((candidate) => predicate(candidate));
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL session ${applicationName} did not reach the expected lock state.`);
}
