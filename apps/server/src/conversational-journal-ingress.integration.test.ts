import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { InMemoryEventBus } from "@companion/event-bus";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import {
  JournalStoreError,
  PostgresJournalRepository,
  type JournalAuthorityDraft,
  type JournalRepository
} from "@companion/journal";
import { createEvent } from "@companion/protocol";
import type { JournalPayloadDescriptor } from "@companion/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  readSqlMigrations,
  runPostgresMigrations
} from "../../../packages/memory/src/migrations.js";
import type { AppContext } from "./context.js";
import {
  HostConversationalReceiptAdmission,
  type ConversationalReceiptAdmission
} from "./conversational-receipt-admission.js";
import { registerMessageRoutes } from "./routes/message.js";
import { registerMessageStreamRoutes } from "./routes/message-stream.js";
import { registerWebSocketRoutes } from "./routes/websocket.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `conversation_ingress_${randomBytes(5).toString("hex")}`;
let adminPool: PostgresPool | undefined;
let pool: PostgresPool | undefined;
let repository: PostgresJournalRepository | undefined;
const namespace = "a8.2b-conversation-ingress-test";
const apps: Array<ReturnType<typeof Fastify>> = [];

describe.skipIf(!databaseUrl)("A8.2b conversational Journal ingress with PostgreSQL", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query(`create schema "${schema}"`);
    const migrations = await readSqlMigrations();
    const journalMigration = migrations.find(
      (entry) => entry.name === "013_life_event_journal_v1.sql"
    );
    expect(journalMigration).toBeDefined();
    await runPostgresMigrations({
      databaseUrl: databaseUrl!,
      migrations: [journalMigration!],
      settings: { search_path: schema }
    });
    pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
    repository = new PostgresJournalRepository(pool, {
      namespace,
      authorityBuilder() {
        throw new Error(
          "The production conversational gate must provide host authority separately."
        );
      }
    });
  });

  afterAll(async () => {
    for (const app of apps.splice(0)) await app.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists "${schema}" cascade`);
      await adminPool.end();
    }
  });

  it.each([
    ["/message", "HTTP_MESSAGE"],
    ["/v1/messages", "HTTP_V1_MESSAGES"]
  ] as const)("commits an HTTP receipt before Runtime for %s", async (url, surface) => {
    const order: string[] = [];
    const admission = new HostConversationalReceiptAdmission(repository!);
    const app = await buildRouteApp(admission, {
      async handleUserMessage(event) {
        const envelope = await expectCommittedReceipt(event.id, event.payload.sessionId);
        expect(envelope.authority.surface).toEqual({
          kind: "LOCAL",
          reference: surface === "HTTP_MESSAGE" ? "yuvi:http:/message" : "yuvi:http:/v1/messages"
        });
        order.push("runtime");
        return null;
      }
    });
    const response = await app.inject({
      method: "POST",
      url,
      payload: {
        sessionId: `http-${surface}`,
        content: "Alice says the meeting moved.",
        subjectUserId: "caller-selected-user",
        personaId: "caller-selected-persona"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(["runtime"]);
    const envelope = await expectCommittedReceipt(response.json().traceId, `http-${surface}`);
    expect(envelope.authority.principal).toEqual({
      state: "UNRESOLVED",
      reason: "conversational transport does not authenticate a principal"
    });
    expect(envelope.authority.binding).toEqual({
      state: "UNRESOLVED",
      reason: "no governed Person binding is established"
    });
    expect(envelope.authority.subjects).toEqual([]);
    expect(envelope.authority.audience.kind).toBe("UNKNOWN");
    expect(envelope.authority.sourceReferences).toEqual([
      {
        kind: "UNRESOLVED_SOURCE",
        reason: "no stable authenticated upstream message identity is available"
      }
    ]);
    expect(envelope.command.kind).toBe("RECEIPT");
    expect(envelope.command.data.receiptClass).toBe("ATTRIBUTED_ASSERTION");
    await app.close();
  });

  it("keeps equal text as distinct receipts when the transport supplies no stable source ID", async () => {
    const admission = new HostConversationalReceiptAdmission(repository!);
    const app = await buildRouteApp(admission, {
      async handleUserMessage() {
        return null;
      }
    });
    const first = await app.inject({
      method: "POST",
      url: "/message",
      payload: { sessionId: "same-text-no-source-id", content: "repeat" }
    });
    const second = await app.inject({
      method: "POST",
      url: "/message",
      payload: { sessionId: "same-text-no-source-id", content: "repeat" }
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstEnvelope = await expectCommittedReceipt(
      first.json().traceId,
      "same-text-no-source-id"
    );
    const secondEnvelope = await expectCommittedReceipt(
      second.json().traceId,
      "same-text-no-source-id"
    );
    expect(firstEnvelope.eventId).not.toBe(secondEnvelope.eventId);
    expect(firstEnvelope.commitSeq).not.toBe(secondEnvelope.commitSeq);
    const dedup = await pool!.query(
      "select count(*)::int as count from journal_source_dedup where journal_namespace = $1",
      [namespace]
    );
    expect(Number(dedup.rows[0]?.["count"])).toBe(0);
    await app.close();
  });

  it("retains text across repository reopen and records chat images as non-retained metadata only", async () => {
    let runtimeImage: unknown;
    const admission = new HostConversationalReceiptAdmission(repository!);
    const app = await buildRouteApp(admission, {
      async handleUserMessage(_event, options) {
        runtimeImage = options.imageAttachment;
        return null;
      }
    });
    const imageBase64 = "AQID";
    const response = await app.inject({
      method: "POST",
      url: "/message",
      payload: {
        sessionId: "image-retention",
        content: "Describe this image.",
        imageAttachment: { imageBase64, mimeType: "image/png" }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(runtimeImage).toEqual({ imageBase64, mimeType: "image/png" });
    const envelope = await expectCommittedReceipt(response.json().traceId, "image-retention");
    const descriptors = envelope.authority.payloads as readonly JournalPayloadDescriptor[];
    const textDescriptor = descriptors.find(
      (
        payload: JournalPayloadDescriptor
      ): payload is Extract<JournalPayloadDescriptor, { modality: "TEXT" }> =>
        payload.modality === "TEXT"
    );
    const imageDescriptor = descriptors.find(
      (payload: JournalPayloadDescriptor) => payload.modality === "IMAGE"
    );
    expect(textDescriptor).toMatchObject({ retention: "RETAINED", selectable: true });
    expect(imageDescriptor).toMatchObject({ retention: "NOT_RETAINED", selectable: false });
    expect(JSON.stringify(envelope)).not.toContain(imageBase64);

    const payloadRows = await pool!.query(
      `select modality, retention, text_content from journal_payloads
       where journal_namespace = $1 and event_id = $2 order by modality`,
      [namespace, envelope.eventId]
    );
    expect(payloadRows.rows.find((row) => row["modality"] === "IMAGE")).toMatchObject({
      retention: "NOT_RETAINED",
      text_content: null
    });
    const reopenedPool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
    try {
      const reopened = new PostgresJournalRepository(reopenedPool, {
        namespace,
        authorityBuilder() {
          throw new Error("Reconstruction does not need an authority builder.");
        }
      });
      const restored = await reopened.resolveRetainedText(textDescriptor!.ref);
      expect(restored?.text).toBe("Describe this image.");
      expect(
        restored && "characterCount" in restored.descriptor
          ? restored.descriptor.characterCount
          : undefined
      ).toBe([...(restored?.text ?? "")].length);
    } finally {
      await reopenedPool.end();
    }
    await app.close();
  });

  it("does not call Runtime when HTTP or SSE receipt admission fails", async () => {
    const failingAdmission = new HostConversationalReceiptAdmission(
      createFailingJournalRepository(
        new JournalStoreError("PAYLOAD_PERSISTENCE_FAILED", "secret database detail")
      )
    );
    const handleUserMessage = vi.fn(async (_event: unknown) => null);
    const streamStarted = vi.fn();
    const app = await buildRouteApp(failingAdmission, {
      handleUserMessage,
      async *streamUserMessage() {
        streamStarted();
        yield completedFrame();
      }
    });
    const ordinary = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: { sessionId: "failure-http", content: "must not run" }
    });
    const streaming = await app.inject({
      method: "POST",
      url: "/v1/messages/stream",
      payload: { sessionId: "failure-sse", content: "must not run" }
    });
    expect(ordinary.statusCode).toBe(503);
    expect(streaming.statusCode).toBe(503);
    expect(streaming.headers["content-type"]).not.toContain("text/event-stream");
    expect(ordinary.body + streaming.body).not.toContain("secret database detail");
    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(streamStarted).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not start SSE Runtime work while the real PostgreSQL append is blocked", async () => {
    let notifyAppendStarted!: () => void;
    let releaseAppend!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      notifyAppendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const blockedRepository: JournalRepository = {
      namespace,
      append: repository!.append.bind(repository),
      async appendWithHostAuthority(input, authority: JournalAuthorityDraft) {
        notifyAppendStarted();
        await appendGate;
        return repository!.appendWithHostAuthority(input, authority);
      },
      get: repository!.get.bind(repository),
      resolveRetainedText: repository!.resolveRetainedText.bind(repository)
    };
    let runtimeStarted = false;
    const app = await buildRouteApp(new HostConversationalReceiptAdmission(blockedRepository), {
      async *streamUserMessage() {
        runtimeStarted = true;
        yield completedFrame();
      }
    });
    const pendingResponse = app.inject({
      method: "POST",
      url: "/v1/messages/stream",
      payload: { sessionId: "blocked-sse", content: "wait for commit" }
    });
    await appendStarted;
    expect(runtimeStarted).toBe(false);
    releaseAppend();
    const response = await pendingResponse;
    expect(response.statusCode).toBe(200);
    expect(runtimeStarted).toBe(true);
    await app.close();
  });

  it("leaves speech-observation turns for A8.2c without a second conversational receipt", async () => {
    const admission = new HostConversationalReceiptAdmission(repository!);
    const commitSpeechTurn = vi.fn(() =>
      createEvent("user.voice.transcript", {
        sessionId: "speech-deferred",
        content: "spoken text",
        observationId: "observation-a8.2c"
      })
    );
    const handleUserMessage = vi.fn(async (_event: unknown) => null);
    const app = await buildRouteApp(admission, { commitSpeechTurn, handleUserMessage });
    const before = await countJournalEvents();
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      payload: {
        sessionId: "speech-deferred",
        text: "spoken text",
        speechObservationId: "observation-a8.2c"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(commitSpeechTurn).toHaveBeenCalledOnce();
    expect(handleUserMessage.mock.calls[0]?.[0]).toMatchObject({ type: "user.voice.transcript" });
    expect(await countJournalEvents()).toBe(before);
    await app.close();
  });

  it("commits WebSocket user.message before Runtime and treats client IDs as correlation only", async () => {
    const admission = new HostConversationalReceiptAdmission(repository!);
    const eventBus = new InMemoryEventBus();
    const handleUserMessage = vi.fn(async (event: any) => {
      const receipts = await findReceiptsByRuntimeEventId(event.id);
      expect(
        receipts.some((receipt) =>
          receipt.authority.correlations.some(
            (correlation: any) =>
              correlation.kind === "CONVERSATION" &&
              correlation.sessionId === event.payload.sessionId
          )
        )
      ).toBe(true);
      await eventBus.publish(
        createEvent(
          "agent.reply",
          { sessionId: event.payload.sessionId, content: "accepted" },
          { traceId: event.traceId, parentId: event.id }
        )
      );
      return null;
    });
    const app = await buildRouteApp(admission, { handleUserMessage }, eventBus);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openWebSocket(address.replace(/^http/u, "ws") + "/ws");
    try {
      const event = createEvent(
        "user.message",
        {
          sessionId: "ws-correlation",
          content: "websocket text",
          subjectUserId: "caller-user",
          personaId: "caller-persona"
        },
        { traceId: "caller-trace", parentId: "caller-parent" }
      );
      const firstReply = await sendAndReadWebSocket(socket, event);
      const secondReply = await sendAndReadWebSocket(socket, {
        ...event,
        traceId: "caller-trace-second"
      });
      expect(firstReply.type).toBe("agent.reply");
      expect(secondReply.type).toBe("agent.reply");
      expect(handleUserMessage).toHaveBeenCalledTimes(2);
      const envelopes = await findReceiptsByRuntimeEventId(event.id);
      expect(envelopes).toHaveLength(2);
      expect(envelopes[0]?.eventId).not.toBe(event.id);
      expect(envelopes[0]?.eventId).not.toBe(envelopes[1]?.eventId);
      expect(envelopes[0]?.authority.correlations).toContainEqual({
        kind: "RUNTIME_EVENT",
        runtimeEventId: event.id
      });
      expect(envelopes[0]?.authority.principal.state).toBe("UNRESOLVED");
      expect(envelopes[0]?.authority.binding.state).toBe("UNRESOLVED");
      const dedup = await pool!.query(
        "select count(*)::int as count from journal_source_dedup where journal_namespace = $1",
        [namespace]
      );
      expect(Number(dedup.rows[0]?.["count"])).toBe(0);

      const beforeUnsupported = await countJournalEvents();
      const unsupported = createEvent("agent.reply", {
        sessionId: "ws-correlation",
        content: "no"
      });
      const error = await sendAndReadWebSocket(socket, unsupported);
      expect(error.type).toBe("runtime.error");
      expect(await countJournalEvents()).toBe(beforeUnsupported);
    } finally {
      socket.close();
      await app.close();
    }
  });

  it("returns a bounded WebSocket error and does not run Runtime on Journal failure", async () => {
    const failureAdmission = new HostConversationalReceiptAdmission(
      createFailingJournalRepository(
        new JournalStoreError("DATABASE_UNAVAILABLE", "private connection detail")
      )
    );
    const handleUserMessage = vi.fn(async () => null);
    const app = await buildRouteApp(failureAdmission, { handleUserMessage });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openWebSocket(address.replace(/^http/u, "ws") + "/ws");
    try {
      const error = await sendAndReadWebSocket(
        socket,
        createEvent("user.message", { sessionId: "ws-failure", content: "not admitted" })
      );
      expect(error.type).toBe("runtime.error");
      expect(error.payload).toMatchObject({
        code: "JOURNAL_UNAVAILABLE",
        message: "Message was not admitted for processing."
      });
      expect(JSON.stringify(error)).not.toContain("private connection detail");
      expect(handleUserMessage).not.toHaveBeenCalled();
    } finally {
      socket.close();
      await app.close();
    }
  });
});

type TestRuntime = {
  handleUserMessage?: (event: any, options?: any) => Promise<unknown>;
  streamUserMessage?: (event: any, options?: any) => AsyncIterable<any>;
  commitSpeechTurn?: (...args: any[]) => any;
};

async function buildRouteApp(
  admission: ConversationalReceiptAdmission,
  runtimeHandlers: TestRuntime = {},
  eventBus = new InMemoryEventBus()
) {
  const runtime = {
    async handleUserMessage(event: any, options?: any) {
      return runtimeHandlers.handleUserMessage?.(event, options) ?? null;
    },
    async *streamUserMessage(event: any, options?: any) {
      const stream = runtimeHandlers.streamUserMessage?.(event, options);
      if (stream) yield* stream;
      else yield completedFrame(event.payload.sessionId, event.traceId);
    },
    commitSpeechTurn(...args: any[]) {
      return (
        runtimeHandlers.commitSpeechTurn?.(...args) ??
        createEvent("user.voice.transcript", {
          sessionId: args[1] ?? "speech",
          content: args[2] ?? "speech"
        })
      );
    },
    getLatestPromptPreview() {
      return undefined;
    }
  };
  const context = {
    runtime,
    eventBus,
    conversationalReceiptAdmission: admission
  } as unknown as AppContext;
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(websocket);
  await registerMessageRoutes(app, context);
  await registerMessageStreamRoutes(app, context);
  await registerWebSocketRoutes(app, context);
  return app;
}

function completedFrame(sessionId = "session", traceId = "trace") {
  return {
    type: "completed" as const,
    messageId: "assistant-message",
    sessionId,
    traceId,
    content: "completed",
    provider: "test"
  };
}

async function expectCommittedReceipt(runtimeEventId: string, sessionId: string): Promise<any> {
  const result = await pool!.query(
    `select envelope from journal_events
     where journal_namespace = $1
       and envelope->'authority'->'correlations' @> $2::jsonb`,
    [namespace, JSON.stringify([{ kind: "RUNTIME_EVENT", runtimeEventId }])]
  );
  expect(result.rows).toHaveLength(1);
  const envelope = result.rows[0]?.["envelope"] as any;
  expect(envelope.authority.correlations).toContainEqual({ kind: "CONVERSATION", sessionId });
  return envelope;
}

async function findReceiptsByRuntimeEventId(runtimeEventId: string): Promise<any[]> {
  const result = await pool!.query(
    `select envelope from journal_events
     where journal_namespace = $1
       and envelope->'authority'->'correlations' @> $2::jsonb
     order by commit_seq`,
    [namespace, JSON.stringify([{ kind: "RUNTIME_EVENT", runtimeEventId }])]
  );
  return result.rows.map((row) => row["envelope"] as any);
}

async function countJournalEvents(): Promise<number> {
  const result = await pool!.query(
    "select count(*)::int as count from journal_events where journal_namespace = $1",
    [namespace]
  );
  return Number(result.rows[0]?.["count"]);
}

function createFailingJournalRepository(error: JournalStoreError): JournalRepository {
  return {
    namespace,
    async append() {
      throw error;
    },
    async appendWithHostAuthority() {
      throw error;
    },
    async get() {
      return null;
    },
    async resolveRetainedText() {
      return null;
    }
  };
}

type WebSocketMessage = { data: unknown };
type MinimalWebSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(event: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(
    event: "message",
    listener: (event: WebSocketMessage) => void,
    options?: { once?: boolean }
  ): void;
  addEventListener(event: "error", listener: () => void, options?: { once?: boolean }): void;
};

async function openWebSocket(url: string): Promise<MinimalWebSocket> {
  const WebSocketCtor = (
    globalThis as unknown as { WebSocket: new (url: string) => MinimalWebSocket }
  ).WebSocket;
  const socket = new WebSocketCtor(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), {
      once: true
    });
  });
  return socket;
}

async function sendAndReadWebSocket(socket: MinimalWebSocket, event: unknown): Promise<any> {
  const message = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket event.")),
      3000
    );
    socket.addEventListener(
      "message",
      (incoming) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(incoming.data)));
      },
      { once: true }
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket receive failed."));
      },
      { once: true }
    );
  });
  socket.send(JSON.stringify(event));
  return message;
}
