import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import { AssistantTurnConflictError, type RuntimeReplyStreamEvent } from "@companion/core";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import type { JournalCommittedEnvelope } from "@companion/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  readSqlMigrations,
  runPostgresMigrations
} from "../../../packages/memory/src/migrations.js";
import type { AppContext } from "./context.js";
import type { ServerConfig } from "./config.js";
import { registerProactiveTurnStreamRoutes } from "./routes/proactive-turn-stream.js";
import { HostProactiveTurnReceiptAdmission } from "./proactive-turn-receipt-admission.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `proactive_turn_${randomBytes(5).toString("hex")}`;
const schemaSql = `"${schema}"`;
let adminPool: PostgresPool | undefined;
let pool: PostgresPool | undefined;
let namespaceSequence = 0;
const apps: Array<ReturnType<typeof Fastify>> = [];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function holdNamespaceStateLock(
  sourcePool: PostgresPool,
  onLocked: () => Promise<void>
): PostgresPool {
  return new Proxy(sourcePool, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(pgClient, clientProperty) {
              if (clientProperty === "query") {
                return async (...args: any[]) => {
                  const result = await Reflect.apply(pgClient.query, pgClient, args);
                  const first = args[0];
                  const sql =
                    typeof first === "string"
                      ? first
                      : typeof first?.text === "string"
                        ? first.text
                        : "";
                  if (/select\s+current_seq[\s\S]*for\s+update/i.test(sql)) await onLocked();
                  return result;
                };
              }
              return Reflect.get(pgClient, clientProperty, pgClient);
            }
          });
        };
      }
      return Reflect.get(target, property, target);
    }
  });
}

function nextNamespace(label: string): string {
  namespaceSequence += 1;
  return `a8.2f3-${label}-${namespaceSequence}`;
}

function createRepository(namespace: string, usingPool = pool!): PostgresJournalRepository {
  return new PostgresJournalRepository(usingPool, {
    namespace,
    authorityBuilder() {
      throw new Error("External proactive request receipts require host authority.");
    }
  });
}

const requestBody = {
  sessionId: "session-proactive-correlation",
  idempotencyKey: "runtime-volatile-claim-only",
  modality: "text",
  options: { readMemory: true, promptPreview: false }
};

function createApp(
  admission: HostProactiveTurnReceiptAdmission,
  streamAssistantInitiatedTurn: (...args: any[]) => AsyncIterable<RuntimeReplyStreamEvent>,
  options: { onDisconnect?: () => void; onResponse?: () => void } = {}
) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request, reply) => {
    if (request.raw.url === "/v1/proactive-turns/stream") {
      reply.raw.once("close", () => options.onDisconnect?.());
    }
  });
  if (options.onResponse) {
    app.addHook("onResponse", async (request) => {
      if (request.raw.url === "/v1/proactive-turns/stream") options.onResponse?.();
    });
  }
  const context = {
    proactiveTurnReceiptAdmission: admission,
    runtime: { streamAssistantInitiatedTurn }
  } as unknown as AppContext;
  const config = { runtimeMode: "test", dashboardDevToken: undefined } as unknown as ServerConfig;
  apps.push(app);
  return registerProactiveTurnStreamRoutes(app, context, config).then(() => app);
}

async function readEvents(namespace: string) {
  const result = await pool!.query(
    `select event_id, commit_seq, envelope from journal_events
     where journal_namespace = $1 order by commit_seq`,
    [namespace]
  );
  return result.rows as Array<{
    event_id: string;
    commit_seq: string | number;
    envelope: JournalCommittedEnvelope;
  }>;
}

async function readDedupCount(namespace: string): Promise<number> {
  const result = await pool!.query(
    "select count(*)::int as count from journal_source_dedup where journal_namespace = $1",
    [namespace]
  );
  return Number(result.rows[0]?.["count"] ?? 0);
}

describe.skipIf(!databaseUrl)("A8.2f3 external proactive request with real PostgreSQL", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query(`create schema ${schemaSql}`);
    const migration = (await readSqlMigrations()).find(
      (entry) => entry.name === "013_life_event_journal_v1.sql"
    );
    expect(migration).toBeDefined();
    await runPostgresMigrations({
      databaseUrl: databaseUrl!,
      migrations: [migration!],
      settings: { search_path: schema }
    });
    pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    for (const app of apps.splice(0).reverse()) await app.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists ${schemaSql} cascade`);
      await adminPool.end();
    }
  });

  it("commits before Runtime advancement and reconstructs only the bounded control receipt", async () => {
    const namespace = nextNamespace("commit-order");
    const repository = createRepository(namespace);
    let eventCountAtFirstAdvance = 0;
    const runtimeMethod = vi.fn(() =>
      (async function* () {
        const rows = await pool!.query(
          "select count(*)::int as count from journal_events where journal_namespace = $1",
          [namespace]
        );
        eventCountAtFirstAdvance = Number(rows.rows[0]?.["count"] ?? 0);
        yield {
          type: "proactive-decision" as const,
          decision: "REQUEST_TEXT" as const,
          sessionId: requestBody.sessionId,
          traceId: "runtime-trace"
        };
        yield {
          type: "text-delta" as const,
          text: "MODEL_OUTPUT_SECRET",
          messageId: "assistant-message",
          sessionId: requestBody.sessionId,
          traceId: "runtime-trace"
        };
        yield {
          type: "completed" as const,
          messageId: "assistant-message",
          sessionId: requestBody.sessionId,
          traceId: "runtime-trace",
          content: "MODEL_OUTPUT_SECRET",
          provider: "PRIVATE_PROVIDER_NAME"
        };
      })()
    );
    const app = await createApp(new HostProactiveTurnReceiptAdmission(repository), runtimeMethod);
    const response = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      headers: { authorization: "Bearer PRIVATE_AUTH_TOKEN" },
      payload: requestBody
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("MODEL_OUTPUT_SECRET");
    expect(runtimeMethod).toHaveBeenCalledTimes(1);
    expect(eventCountAtFirstAdvance).toBe(1);
    const rows = await readEvents(namespace);
    expect(rows).toHaveLength(1);
    const event = rows[0]!.envelope;
    expect(event.command.kind).toBe("RECEIPT");
    expect(event.command.data).toMatchObject({ receiptClass: "CONTROL" });
    expect(event.authority).toMatchObject({
      principal: { state: "UNRESOLVED" },
      subjects: [],
      binding: { state: "UNRESOLVED" },
      surface: { kind: "LOCAL", reference: "yuvi:http:/v1/proactive-turns/stream" },
      correlations: [{ kind: "CONVERSATION", sessionId: requestBody.sessionId }],
      audience: { kind: "UNKNOWN" },
      producer: { version: "0.1.3-a8.2f3" },
      sourceReferences: [{ kind: "UNRESOLVED_SOURCE" }]
    });
    expect(JSON.stringify(event)).not.toContain(requestBody.idempotencyKey);
    expect(await readDedupCount(namespace)).toBe(0);

    const textDescriptor = event.authority.payloads.find((payload) => payload.modality === "TEXT");
    expect(textDescriptor).toMatchObject({
      retention: "RETAINED",
      selectable: true,
      characterCount: 78
    });
    const reopenedRepository = createRepository(namespace);
    const reopened = reopenedRepository.get.bind(reopenedRepository);
    const reconstructed = await reopened({
      kind: "JOURNAL_EVENT",
      namespace,
      eventId: rows[0]!.event_id
    });
    expect(reconstructed).toEqual(event);
    const retained = await reopenedRepository.resolveRetainedText(textDescriptor!.ref);
    expect(retained?.text).toBe(
      '{"operation":"proactive-turn.request","readMemory":true,"promptPreview":false}'
    );
    expect(retained?.descriptor).toMatchObject({ characterCount: [...retained!.text].length });
    expect(retained?.text).not.toContain(requestBody.sessionId);
    expect(retained?.text).not.toContain("PRIVATE_AUTH_TOKEN");
    expect(retained?.text).not.toContain("MODEL_OUTPUT_SECRET");
    expect(retained?.text).not.toContain("PRIVATE_PROVIDER_NAME");
    expect(JSON.stringify(event)).not.toContain("PRIVATE_AUTH_TOKEN");
    expect(JSON.stringify(event)).not.toContain("MODEL_OUTPUT_SECRET");
    expect(JSON.stringify(event)).not.toContain("PRIVATE_PROVIDER_NAME");
    await app.close();
  });

  it("holds Runtime and SSE until the real PostgreSQL append transaction commits", async () => {
    const namespace = nextNamespace("held-append");
    const locked = deferred<void>();
    const release = deferred<void>();
    const lockedPool = holdNamespaceStateLock(pool!, async () => {
      locked.resolve();
      await release.promise;
    });
    let runtimeCalls = 0;
    const runtimeMethod = vi.fn(() => {
      runtimeCalls += 1;
      return (async function* () {
        yield {
          type: "proactive-decision" as const,
          decision: "NO_OP" as const,
          sessionId: requestBody.sessionId,
          traceId: "held-trace"
        };
      })();
    });
    const app = await createApp(
      new HostProactiveTurnReceiptAdmission(createRepository(namespace, lockedPool)),
      runtimeMethod
    );
    const pending = app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: requestBody
    });
    await locked.promise;
    expect(runtimeCalls).toBe(0);
    expect((await readEvents(namespace)).length).toBe(0);
    release.resolve();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(runtimeCalls).toBe(1);
    expect((await readEvents(namespace)).length).toBe(1);
    await app.close();
  });

  it("retains each identical external request even when Runtime rejects a repeated claim", async () => {
    const namespace = nextNamespace("no-dedup");
    const repository = createRepository(namespace);
    let calls = 0;
    const runtimeMethod = vi.fn(() => {
      calls += 1;
      if (calls === 2) {
        return (async function* () {
          throw new AssistantTurnConflictError(requestBody.idempotencyKey);
        })();
      }
      return (async function* () {
        yield {
          type: "proactive-decision" as const,
          decision: "NO_OP" as const,
          sessionId: requestBody.sessionId,
          traceId: "dedup-trace"
        };
      })();
    });
    const app = await createApp(new HostProactiveTurnReceiptAdmission(repository), runtimeMethod);
    const first = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: requestBody
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/proactive-turns/stream",
      payload: requestBody
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.headers["content-type"]).not.toContain("text/event-stream");
    const events = await readEvents(namespace);
    expect(events).toHaveLength(2);
    expect(events[0]!.event_id).not.toBe(events[1]!.event_id);
    expect(await readDedupCount(namespace)).toBe(0);
    await app.close();
  });

  it("keeps a receipt committed on client disconnect during append and never starts Runtime", async () => {
    const namespace = nextNamespace("disconnect");
    const locked = deferred<void>();
    const release = deferred<void>();
    const appendCommitted = deferred<void>();
    const disconnectObserved = deferred<void>();
    const lockedPool = holdNamespaceStateLock(pool!, async () => {
      locked.resolve();
      await release.promise;
    });
    const baseAdmission = new HostProactiveTurnReceiptAdmission(
      createRepository(namespace, lockedPool)
    );
    const admission = {
      async admit(input: Parameters<typeof baseAdmission.admit>[0]) {
        await baseAdmission.admit(input);
        appendCommitted.resolve();
      }
    } as HostProactiveTurnReceiptAdmission;
    let runtimeCalls = 0;
    const app = await createApp(
      admission,
      vi.fn(() => {
        runtimeCalls += 1;
        return (async function* () {
          yield {
            type: "proactive-decision" as const,
            decision: "NO_OP" as const,
            sessionId: requestBody.sessionId,
            traceId: "disconnected-trace"
          };
        })();
      }),
      { onDisconnect: () => disconnectObserved.resolve() }
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const server = new URL(address);
    const client = httpRequest({
      hostname: server.hostname,
      port: Number(server.port),
      method: "POST",
      path: "/v1/proactive-turns/stream",
      headers: { "content-type": "application/json" }
    });
    client.on("error", () => undefined);
    client.end(JSON.stringify(requestBody));
    await locked.promise;
    expect(runtimeCalls).toBe(0);
    expect((await readEvents(namespace)).length).toBe(0);

    client.destroy();
    await disconnectObserved.promise;
    release.resolve();
    await appendCommitted.promise;
    await app.close();

    expect((await readEvents(namespace)).length).toBe(1);
    expect(runtimeCalls).toBe(0);
  });
});
