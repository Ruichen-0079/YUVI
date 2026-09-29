import { randomBytes } from "node:crypto";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import {
  JOURNAL_COMMAND_VERSION,
  type JournalEventRef,
  type JournalPayloadDescriptor
} from "@companion/protocol";
import { PostgresJournalRepository } from "@companion/journal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InMemoryMemoryRepository,
  MemoryLineageConflictError,
  MemoryService,
  PostgresMemoryRepository,
  RuleBasedMemoryExtractor,
  getMemoryLineageState
} from "@companion/memory";
import { readSqlMigrations } from "../../../packages/memory/src/migrations.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = "grounded_memory_" + randomBytes(6).toString("hex");
const journalNamespace = "a10.1c-grounding-" + randomBytes(6).toString("hex");
const recordedAt = "2026-09-29T23:30:00.000Z";
let adminPool: PostgresPool | undefined;
let pool: PostgresPool | undefined;
let journal: PostgresJournalRepository | undefined;
let memoryRepository: PostgresMemoryRepository | undefined;

describe.skipIf(!databaseUrl)("A10.1c grounded legacy Memory with real PostgreSQL", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query('create schema "' + schema + '"');
    pool = createPostgresPool(databaseUrl!, { options: "-c search_path=" + schema + ",public" });
    const migrations = await readSqlMigrations();
    for (const migration of migrations.filter((entry) => entry.name !== "015_memory_lineage_v1.sql")) {
      await pool.query(migration.sql);
      if (migration.name === "001_init_memory.sql") {
        await pool.query(
          "insert into memories (type, content, source) values ('semantic', 'pre-lineage historical row', 'legacy')"
        );
      }
    }
    const lineageMigration = migrations.find((entry) => entry.name === "015_memory_lineage_v1.sql");
    expect(lineageMigration, "missing migration 015_memory_lineage_v1.sql").toBeDefined();
    await pool.query(lineageMigration!.sql);
    await pool.query(lineageMigration!.sql);
    journal = new PostgresJournalRepository(pool, {
      namespace: journalNamespace,
      now: () => new Date(recordedAt),
      authorityBuilder() {
        throw new Error("A10.1c integration uses an explicit host authority snapshot.");
      }
    });
    memoryRepository = new PostgresMemoryRepository(pool);
  });

  afterAll(async () => {
    await memoryRepository?.close?.();
    await pool?.end();
    if (adminPool) {
      await adminPool.query('drop schema if exists "' + schema + '" cascade');
      await adminPool.end();
    }
  });

  it("upgrades legacy rows and persists/reopens exact Journal ancestry idempotently", async () => {
    const legacy = await memoryRepository!.listRecentMemories(20);
    const oldRow = legacy.find((memory) => memory.content === "pre-lineage historical row");
    expect(oldRow?.lineage).toBeNull();
    expect(getMemoryLineageState(oldRow?.lineage)).toBe("LEGACY_INCOMPLETE");

    const sourceText = "Remember that I prefer concise technical answers.";
    const parent = await appendReceipt(sourceText, "typed-text");
    const service = createService(memoryRepository!, journal!);
    const candidates = await service.extractCandidates({
      userMessage: sourceText,
      sourceTraceId: "runtime-trace-descriptive-only",
      timestamp: "2001-01-01T00:00:00.000Z"
    });
    expect(candidates).toHaveLength(1);
    const candidate = {
      ...candidates[0]!,
      observedAt: "2001-01-01T00:00:00.000Z",
      sourceTraceId: "forged-trace-does-not-parent"
    };
    const context = { sourceJournalRef: parent, sourceText };
    const first = await service.processCandidateForStorage(candidate, { source: "runtime" }, context);
    expect(first.decision).toBe("stored");
    expect(first.memory?.lineage).toMatchObject({
      version: "memory-lineage.v1",
      state: "GROUNDED",
      parents: [{ ref: parent, selector: { modality: "TEXT" } }],
      origin: "USER_ASSERTION",
      authority: {
        principal: { state: "UNRESOLVED" },
        binding: { state: "UNRESOLVED" },
        audience: { kind: "UNKNOWN" }
      },
      sourceTime: { recordedAt, occurrenceTime: { state: "UNKNOWN" } }
    });
    expect(first.memory?.observedAt.toISOString()).toBe(recordedAt);
    expect(first.memory?.sourceTraceId).toBe("forged-trace-does-not-parent");
    expect(first.memory?.lineageConsumerKey).toBe(
      (first.memory?.lineage as { consumerKey: string }).consumerKey
    );

    const mismatch = await service.processCandidateForStorage(candidate, { source: "runtime" }, {
      sourceJournalRef: parent,
      sourceText: "An unrelated utterance."
    });
    expect(mismatch).toMatchObject({ decision: "rejected", rejectedReason: "source-text-mismatch" });

    const key = first.memory!.lineageConsumerKey!;
    const existing = await memoryRepository!.getGroundedMemoryByConsumerKey(key);
    expect(existing?.memory.id).toBe(first.memory?.id);
    expect(existing?.memory.lineage?.state).toBe("GROUNDED");
    if (first.memory?.lineage?.state !== "GROUNDED") {
      throw new Error("Expected the committed source row to have grounded lineage.");
    }
    await expect(
      memoryRepository!.createGroundedMemory!({
        lineage: first.memory.lineage,
        payloadDigest: "e".repeat(64),
        memory: {
          type: "semantic",
          subtype: "preference",
          content: "conflicting payload",
          source: "runtime"
        }
      })
    ).rejects.toBeInstanceOf(MemoryLineageConflictError);

    const reopenedPool = createPostgresPool(databaseUrl!, {
      options: "-c search_path=" + schema + ",public"
    });
    try {
      const reopenedJournal = new PostgresJournalRepository(reopenedPool, {
        namespace: journalNamespace,
        authorityBuilder() {
          throw new Error("Read-only reconstruction does not need append authority.");
        }
      });
      const reopenedMemory = new PostgresMemoryRepository(reopenedPool);
      const reopenedService = createService(reopenedMemory, reopenedJournal);
      const replay = await reopenedService.processCandidateForStorage(
        candidate,
        { source: "runtime" },
        context
      );
      expect(replay.decision).toBe("stored");
      expect(replay.memory?.id).toBe(first.memory?.id);
      expect(replay.storageReason).toBe("grounded-idempotent-replay");
      const count = await reopenedPool.query(
        "select count(*)::int as count from memories where lineage_consumer_key = $1",
        [key]
      );
      expect(count.rows[0]?.["count"]).toBe(1);
      await reopenedMemory.close?.();
    } finally {
      await reopenedPool.end();
    }
  });
});

function createService(
  repository: PostgresMemoryRepository | InMemoryMemoryRepository,
  evidenceReader: PostgresJournalRepository
): MemoryService {
  return new MemoryService(
    repository,
    undefined,
    undefined,
    new RuleBasedMemoryExtractor(),
    undefined,
    { kind: "legacy", journalEvidenceReader: evidenceReader }
  );
}

async function appendReceipt(sourceText: string, correlation: string): Promise<JournalEventRef> {
  const textRef = {
    namespace: "yuvi:conversation-input",
    payloadId: "text_" + randomBytes(12).toString("base64url"),
    version: "v1"
  };
  const payload: JournalPayloadDescriptor = {
    ref: textRef,
    modality: "TEXT",
    retention: "RETAINED",
    origin: "USER_INPUT",
    selectable: true,
    characterCount: Array.from(sourceText).length
  };
  const appended = await journal!.appendWithHostAuthority(
    {
      command: {
        version: JOURNAL_COMMAND_VERSION,
        kind: "RECEIPT",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [],
        data: {
          receiptClass: "ATTRIBUTED_ASSERTION",
          evidenceSelectors: [
            {
              version: "source-selector.v1",
              modality: "TEXT",
              payload: textRef,
              range: {
                unit: "UNICODE_CODE_POINT",
                start: 0,
                end: Array.from(sourceText).length
              }
            }
          ]
        }
      },
      retainedText: [{ ref: textRef, text: sourceText }]
    },
    {
      principal: {
        state: "UNRESOLVED",
        reason: "test conversational ingress does not authenticate a principal"
      },
      subjects: [],
      binding: { state: "UNRESOLVED", reason: "test has no governed Person binding" },
      surface: { kind: "LOCAL", reference: "yuvi:http:/message" },
      correlations: [{ kind: "MESSAGE", sessionId: correlation, messageId: correlation }],
      audience: { kind: "UNKNOWN", reason: "test has no audience snapshot" },
      disclosurePolicy: { state: "UNRESOLVED", reason: "test has no policy snapshot" },
      policyVersion: "test-a10.1c.v1",
      producer: { name: "test-conversation-ingress", version: "1" },
      sourceReferences: [
        { kind: "UNRESOLVED_SOURCE", reason: "no authenticated upstream source identity" }
      ],
      payloads: [payload]
    }
  );
  return {
    kind: "JOURNAL_EVENT",
    namespace: appended.envelope.journalNamespace,
    eventId: appended.envelope.eventId
  };
}
