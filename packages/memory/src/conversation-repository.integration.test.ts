import { randomBytes } from "node:crypto";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSqlMigrations } from "./migrations.js";
import { PostgresConversationRepository } from "./conversation-repository.js";

const databaseUrl = process.env["DATABASE_URL"];
const schema = `conversation_ancestry_${randomBytes(5).toString("hex")}`;
let adminPool: PostgresPool | undefined;
let pool: PostgresPool | undefined;
let repository: PostgresConversationRepository | undefined;

describe.skipIf(!databaseUrl)("PostgreSQL conversation Journal ancestry", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query(`create schema "${schema}"`);
    pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });

    const migrations = await readSqlMigrations();
    for (const name of [
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "008_finalized_ingestion_ledger_v1.sql"
    ]) {
      const migration = migrations.find((candidate) => candidate.name === name);
      expect(migration, `missing migration ${name}`).toBeDefined();
      await pool.query(migration!.sql);
    }

    await pool.query("insert into conversation_sessions (id) values ($1)", ["legacy-session"]);
    await pool.query(
      `insert into conversation_messages (
        id, session_id, trace_id, parent_message_id, role, content, status,
        created_at, completed_at, metadata
      ) values ($1, $2, $3, null, 'user', $4, 'completed', now(), now(), '{}'::jsonb)`,
      ["legacy-message", "legacy-session", "legacy-trace", "old row without receipt ancestry"]
    );

    const ancestryMigration = migrations.find(
      (candidate) => candidate.name === "014_conversation_journal_ancestry_v1.sql"
    );
    expect(ancestryMigration).toBeDefined();
    await pool.query(ancestryMigration!.sql);
    await pool.query(ancestryMigration!.sql);
    repository = new PostgresConversationRepository(pool);
  });

  afterAll(async () => {
    await repository?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists "${schema}" cascade`);
      await adminPool.end();
    }
  });

  it("upgrades existing rows as null and round trips exact ancestry through reads and recovery", async () => {
    const legacy = await repository!.getMessageById("legacy-message");
    expect(legacy).toMatchObject({ id: "legacy-message", sourceJournalRef: null });

    const sourceJournalRef = {
      kind: "JOURNAL_EVENT" as const,
      namespace: "n".repeat(512),
      eventId: "jev1_0123456789abcdef0123456789abcdef"
    };
    const user = await repository!.appendMessage({
      id: "ancestry-user",
      sessionId: "ancestry-session",
      traceId: "runtime-trace-distinct-from-journal",
      parentMessageId: null,
      sourceUserEventId: "runtime-user-event-distinct-from-journal",
      sourceJournalRef,
      role: "user",
      content: "retained input",
      status: "streaming",
      createdAt: "2026-09-29T00:00:00.000Z",
      completedAt: null,
      metadata: {}
    });
    expect(user.sourceJournalRef).toEqual(sourceJournalRef);
    expect((await repository!.getMessageById("ancestry-user"))?.sourceJournalRef).toEqual(
      sourceJournalRef
    );
    expect((await repository!.listRecentMessages("ancestry-session"))[0]?.sourceJournalRef).toEqual(
      sourceJournalRef
    );

    const completed = await repository!.completeMessage("ancestry-user", { saved: true });
    expect(completed.sourceJournalRef).toEqual(sourceJournalRef);

    await repository!.appendMessage({
      id: "ancestry-recovery",
      sessionId: "ancestry-session",
      traceId: "runtime-trace-recovery",
      parentMessageId: null,
      sourceJournalRef,
      role: "user",
      content: "stale streaming input",
      status: "streaming",
      createdAt: "2026-09-01T00:00:00.000Z",
      completedAt: null,
      metadata: {}
    });
    const recovered = await repository!.recoverStaleStreamingMessages?.({
      olderThan: "2026-09-15T00:00:00.000Z",
      recoveredAt: "2026-09-29T00:00:00.000Z"
    });
    expect(recovered).toMatchObject([{ id: "ancestry-recovery", sourceJournalRef }]);
    expect((await repository!.getMessageById("ancestry-recovery"))?.sourceJournalRef).toEqual(
      sourceJournalRef
    );

    const assistant = await repository!.appendMessage({
      id: "ancestry-assistant",
      sessionId: "ancestry-session",
      traceId: "assistant-trace",
      parentMessageId: "ancestry-user",
      sourceUserEventId: "ancestry-user",
      role: "assistant",
      content: "generated reply",
      status: "completed",
      createdAt: "2026-09-29T00:00:01.000Z",
      completedAt: "2026-09-29T00:00:01.000Z",
      metadata: {}
    });
    expect(assistant.sourceJournalRef).toBeNull();
  });
});
