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
    const replyComponentsMigration = migrations.find(
      (candidate) => candidate.name === "023_reply_components_v1.sql"
    );
    expect(replyComponentsMigration).toBeDefined();
    for (const name of [
      "013_life_event_journal_v1.sql",
      "020_effect_intents_v1.sql",
      "021_effect_attempts_v1.sql",
      "022_native_control_effects_v1.sql"
    ]) {
      await pool.query(migrations.find((m) => m.name === name)!.sql);
    }
    await pool.query(replyComponentsMigration!.sql);
    repository = new PostgresConversationRepository(pool);
    repository.setPublicationAdmission(async (_input, client) => {
      if (!client) throw Error("Missing shared transaction");
      await client.query("select 1");
    });
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

  it("commits reply components with the conversation projection and withholds duplicate replay", async () => {
    const assistant = await repository!.appendMessage({
      id: "reply-component-message",
      sessionId: "reply-component-session",
      traceId: "reply-component-trace",
      parentMessageId: null,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: "2026-09-29T00:00:02.000Z",
      completedAt: null,
      metadata: {}
    });
    expect(assistant.content).toBe("");

    const first = await repository!.appendReplyComponent!({
      replyId: "reply-component-reply",
      messageId: assistant.id,
      sequence: "1",
      text: "first",
      projectionVersion: "runtime-text.v1",
      publicationTargets: [
        {
          surface: "HTTP_SSE",
          targetId: "HTTP_SSE:trace-a",
          targetGeneration: "connection-a"
        }
      ]
    });
    expect(first).toMatchObject({ inserted: true, message: { content: "first" } });

    const replay = await repository!.appendReplyComponent!({
      replyId: "reply-component-reply",
      messageId: assistant.id,
      sequence: "1",
      text: "first",
      projectionVersion: "runtime-text.v1"
    });
    expect(replay).toMatchObject({ inserted: false, componentId: first.componentId });
    expect(replay.message.content).toBe("first");

    await expect(
      repository!.appendReplyComponent!({
        replyId: "reply-component-reply",
        messageId: assistant.id,
        sequence: "1",
        text: "conflicting",
        projectionVersion: "runtime-text.v1"
      })
    ).rejects.toThrow(/conflicts with durable content/);
    await expect(
      repository!.appendReplyComponent!({
        replyId: "reply-component-reply",
        messageId: assistant.id,
        sequence: "3",
        text: "out of order",
        projectionVersion: "runtime-text.v1"
      })
    ).rejects.toThrow(/next monotonic sequence/);

    const second = await repository!.appendReplyComponent!({
      replyId: "reply-component-reply",
      messageId: assistant.id,
      sequence: "2",
      text: " second",
      projectionVersion: "runtime-text.v1"
    });
    expect(second).toMatchObject({ inserted: true, message: { content: "first second" } });
    const components = await pool!.query(
      `select sequence, text_digest from conversation_reply_components
       where reply_id=$1 order by sequence`,
      ["reply-component-reply"]
    );
    expect(components.rows.map((row) => String(row["sequence"]))).toEqual(["1", "2"]);
  });

  it("rolls back the component, conversation projection, and target work together", async () => {
    const assistant = await repository!.appendMessage({
      id: "reply-publication-rollback-message",
      sessionId: "reply-publication-rollback-session",
      traceId: "reply-publication-rollback-trace",
      parentMessageId: null,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: "2026-09-29T00:00:04.000Z",
      completedAt: null,
      metadata: {}
    });
    await pool!
      .query(`create function reject_reply_projection_v1() returns trigger language plpgsql as $$
      begin raise exception 'TEST_REPLY_PROJECTION_FAILURE'; end $$`);
    await pool!
      .query(`create trigger reject_reply_projection_v1 before update on conversation_messages
      for each row when (new.id='reply-publication-rollback-message')
      execute function reject_reply_projection_v1()`);
    try {
      await expect(
        repository!.appendReplyComponent!({
          replyId: "reply-publication-rollback-reply",
          messageId: assistant.id,
          sequence: "1",
          text: "must rollback",
          projectionVersion: "runtime-text.v1",
          publicationTargets: [
            {
              surface: "HTTP_SSE",
              targetId: "HTTP_SSE:trace-rollback",
              targetGeneration: "connection-rollback"
            }
          ]
        })
      ).rejects.toThrow(/TEST_REPLY_PROJECTION_FAILURE/);
    } finally {
      await pool!.query("drop trigger reject_reply_projection_v1 on conversation_messages");
      await pool!.query("drop function reject_reply_projection_v1()");
    }
    const rows = await pool!.query(
      `select (select count(*) from conversation_reply_components where reply_id=$1) as components,
              (select count(*) from effect_intents where intent->'request'->'payload'->>'relatedReply'=$1) as publications,
              (select content from conversation_messages where id=$2) as projection`,
      ["reply-publication-rollback-reply", assistant.id]
    );
    expect(rows.rows[0]).toMatchObject({ components: "0", publications: "0", projection: "" });
  });
});
