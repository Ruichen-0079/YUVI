import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import type { JournalCommittedEnvelope } from "@companion/protocol";
import type { ProviderCallOptions, TTSInput, TTSOutput } from "@companion/providers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  readSqlMigrations,
  runPostgresMigrations
} from "../../../packages/memory/src/migrations.js";
import type { AppContext } from "./context.js";
import type { TtsReceiptInput } from "./tts-receipt-admission.js";
import { HostTtsReceiptAdmission } from "./tts-receipt-admission.js";
import type { TtsReceiptAdmission } from "./tts-receipt-admission.js";
import { registerMediaRoutes } from "./routes/media.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `tts_ingress_${randomBytes(5).toString("hex")}`;
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
  return `a8.2f4-${label}-${namespaceSequence}`;
}

function createRepository(namespace: string, usingPool = pool!): PostgresJournalRepository {
  return new PostgresJournalRepository(usingPool, {
    namespace,
    authorityBuilder() {
      throw new Error("Standalone TTS receipts require host authority.");
    }
  });
}

function createApp(
  admission: TtsReceiptAdmission,
  getTTSProvider: () => {
    name: string;
    synthesizeSpeech(input: TTSInput, options?: ProviderCallOptions): Promise<TTSOutput>;
  },
  hooks: { onDisconnect?: () => void; onResponse?: () => void } = {}
) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request, reply) => {
    if (request.raw.url === "/v1/tts") {
      reply.raw.once("close", () => hooks.onDisconnect?.());
    }
  });
  if (hooks.onResponse) {
    app.addHook("onResponse", async (request) => {
      if (request.raw.url === "/v1/tts") hooks.onResponse?.();
    });
  }
  const context = {
    ttsReceiptAdmission: admission,
    providers: { getTTSProvider },
    runtime: new Proxy(
      {},
      {
        get() {
          throw new Error("Standalone TTS must not route through Runtime.");
        }
      }
    )
  } as unknown as AppContext;
  apps.push(app);
  return registerMediaRoutes(app, context).then(() => app);
}

const requestBody = {
  sessionId: "tts-correlation-session",
  text: "PRIVATE_RAW_TTS_TEXT 🐈",
  voice: "PRIVATE_VOICE_IDENTIFIER",
  language: "private-language-value",
  format: "wav"
};

function output(): TTSOutput {
  return {
    audio: new Uint8Array([65, 85, 68, 73, 79]),
    audioBase64: "PRIVATE_GENERATED_AUDIO_BASE64",
    mimeType: "audio/wav",
    durationMs: 123,
    model: "PRIVATE_PROVIDER_MODEL",
    finalProvider: "PRIVATE_PROVIDER_NAME"
  };
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

async function readPayloads(namespace: string) {
  const result = await pool!.query(
    `select modality, retention, descriptor, text_content, content_sha256
     from journal_payloads where journal_namespace = $1`,
    [namespace]
  );
  return result.rows as Array<{
    modality: string;
    retention: string;
    descriptor: Record<string, unknown>;
    text_content: string | null;
    content_sha256: string | null;
  }>;
}

async function readDedupCount(namespace: string): Promise<number> {
  const result = await pool!.query(
    "select count(*)::int as count from journal_source_dedup where journal_namespace = $1",
    [namespace]
  );
  return Number(result.rows[0]?.["count"] ?? 0);
}

describe.skipIf(!databaseUrl)("A8.2f4 standalone TTS Journal ingress with PostgreSQL", () => {
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

  it("reopens the safe receipt while synthesis text stays unavailable", async () => {
    const namespace = nextNamespace("privacy-reopen");
    const repository = createRepository(namespace);
    let providerSawCommittedReceipt = false;
    const synthesizeSpeech = vi.fn(async () => {
      providerSawCommittedReceipt = (await readEvents(namespace)).length === 1;
      return output();
    });
    const getTTSProvider = vi.fn(() => ({ name: "private-test-provider", synthesizeSpeech }));
    const app = await createApp(new HostTtsReceiptAdmission(repository), getTTSProvider);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tts",
      headers: { authorization: "Bearer PRIVATE_AUTH_TOKEN" },
      payload: requestBody
    });

    expect(response.statusCode).toBe(200);
    expect(providerSawCommittedReceipt).toBe(true);
    expect(response.json()).toMatchObject({ audioBase64: "PRIVATE_GENERATED_AUDIO_BASE64" });
    const rows = await readEvents(namespace);
    expect(rows).toHaveLength(1);
    const eventRow = rows[0]!;
    const event = eventRow.envelope;
    expect(event.command.kind).toBe("RECEIPT");
    if (event.command.kind !== "RECEIPT") throw new Error("Expected a TTS receipt.");
    expect(event.command.data.receiptClass).toBe("CONTROL");
    expect(event.command.data.evidenceSelectors).toHaveLength(1);
    expect(event.authority).toMatchObject({
      principal: { state: "UNRESOLVED" },
      subjects: [],
      binding: { state: "UNRESOLVED" },
      surface: { kind: "LOCAL", reference: "yuvi:http:/v1/tts" },
      correlations: [{ kind: "CONVERSATION", sessionId: requestBody.sessionId }],
      audience: { kind: "UNKNOWN" },
      sourceReferences: [{ kind: "UNRESOLVED_SOURCE" }],
      producer: { version: "0.1.3-a8.2f4" }
    });
    const synthesisText = event.authority.payloads.find(
      (payload) => payload.modality === "TEXT" && payload.retention === "NOT_RETAINED"
    );
    const summaryPayload = event.authority.payloads.find(
      (payload) => payload.modality === "TEXT" && payload.retention === "RETAINED"
    );
    expect(synthesisText).toMatchObject({
      origin: "USER_INPUT",
      selectable: false,
      characterCount: [...requestBody.text].length
    });
    expect(summaryPayload).toMatchObject({ origin: "USER_INPUT", selectable: true });
    const summary = await repository.resolveRetainedText(summaryPayload!.ref);
    expect(summary?.text).toBe(
      `{"operation":"tts.synthesize","textCharacterCount":${[...requestBody.text].length},"voiceSupplied":true,"languageSupplied":true,"format":"wav"}`
    );
    expect(await repository.resolveRetainedText(synthesisText!.ref)).toBeNull();

    const reopened = createRepository(namespace);
    expect(
      await reopened.get({ kind: "JOURNAL_EVENT", namespace, eventId: eventRow.event_id })
    ).toEqual(event);
    expect(await reopened.resolveRetainedText(summaryPayload!.ref)).toEqual(summary);
    expect(await reopened.resolveRetainedText(synthesisText!.ref)).toBeNull();

    const payloadRows = await readPayloads(namespace);
    expect(payloadRows).toHaveLength(2);
    expect(
      payloadRows.find((payload) => payload.retention === "NOT_RETAINED")
    ).toMatchObject({ modality: "TEXT", text_content: null, content_sha256: null });
    expect(
      payloadRows.find((payload) => payload.retention === "RETAINED")?.text_content
    ).toBe(summary?.text);
    const persisted = JSON.stringify({ event, payloadRows });
    for (const secret of [
      requestBody.text,
      requestBody.voice,
      requestBody.language,
      "PRIVATE_AUTH_TOKEN",
      "PRIVATE_GENERATED_AUDIO_BASE64",
      "PRIVATE_PROVIDER_MODEL",
      "PRIVATE_PROVIDER_NAME"
    ]) {
      expect(persisted).not.toContain(secret);
    }
    expect(await readDedupCount(namespace)).toBe(0);
    await app.close();
  });

  it("does not resolve a provider while a real PostgreSQL append is held", async () => {
    const namespace = nextNamespace("held-append");
    const locked = deferred<void>();
    const release = deferred<void>();
    const lockedPool = holdNamespaceStateLock(pool!, async () => {
      locked.resolve();
      await release.promise;
    });
    let providerResolutions = 0;
    let syntheses = 0;
    const getTTSProvider = vi.fn(() => {
      providerResolutions += 1;
      return {
        name: "test-tts",
        async synthesizeSpeech() {
          syntheses += 1;
          return output();
        }
      };
    });
    const app = await createApp(
      new HostTtsReceiptAdmission(createRepository(namespace, lockedPool)),
      getTTSProvider
    );
    let responseSettled = false;
    const pending = app.inject({ method: "POST", url: "/v1/tts", payload: requestBody });
    void pending.then(
      () => {
        responseSettled = true;
      },
      () => {
        responseSettled = true;
      }
    );

    try {
      await locked.promise;
      await Promise.resolve();
      expect(providerResolutions).toBe(0);
      expect(syntheses).toBe(0);
      expect(responseSettled).toBe(false);
      expect(await readEvents(namespace)).toHaveLength(0);

      release.resolve();
      const response = await pending;
      expect(response.statusCode).toBe(200);
      expect(providerResolutions).toBe(1);
      expect(syntheses).toBe(1);
      expect(await readEvents(namespace)).toHaveLength(1);
    } finally {
      release.resolve();
      await app.close();
    }
  });

  it("retains a receipt but skips provider resolution after disconnect during append", async () => {
    const namespace = nextNamespace("disconnect-held-append");
    const locked = deferred<void>();
    const release = deferred<void>();
    const appendCommitted = deferred<void>();
    const disconnectObserved = deferred<void>();
    const lockedPool = holdNamespaceStateLock(pool!, async () => {
      locked.resolve();
      await release.promise;
    });
    const baseAdmission = new HostTtsReceiptAdmission(createRepository(namespace, lockedPool));
    const admission: TtsReceiptAdmission = {
      async admit(input: TtsReceiptInput) {
        await baseAdmission.admit(input);
        appendCommitted.resolve();
      }
    };
    let providerResolutions = 0;
    let syntheses = 0;
    const getTTSProvider = vi.fn(() => {
      providerResolutions += 1;
      return {
        name: "test-tts",
        async synthesizeSpeech() {
          syntheses += 1;
          return output();
        }
      };
    });
    const app = await createApp(admission, getTTSProvider, {
      onDisconnect: () => disconnectObserved.resolve()
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const server = new URL(address);
    const client = httpRequest({
      hostname: server.hostname,
      port: Number(server.port),
      method: "POST",
      path: "/v1/tts",
      headers: { "content-type": "application/json" }
    });
    client.on("error", () => undefined);
    client.end(JSON.stringify(requestBody));

    try {
      await locked.promise;
      expect(providerResolutions).toBe(0);
      expect(syntheses).toBe(0);
      expect(await readEvents(namespace)).toHaveLength(0);

      client.destroy();
      await disconnectObserved.promise;
      release.resolve();
      await appendCommitted.promise;
      await app.close();

      expect(await readEvents(namespace)).toHaveLength(1);
      expect(providerResolutions).toBe(0);
      expect(syntheses).toBe(0);
    } finally {
      release.resolve();
      client.destroy();
      await app.close();
    }
  });

  it("creates distinct receipts for identical requests without source dedup", async () => {
    const namespace = nextNamespace("no-dedup");
    let syntheses = 0;
    const getTTSProvider = vi.fn(() => ({
      name: "test-tts",
      async synthesizeSpeech() {
        syntheses += 1;
        return output();
      }
    }));
    const app = await createApp(
      new HostTtsReceiptAdmission(createRepository(namespace)),
      getTTSProvider
    );

    try {
      const first = await app.inject({ method: "POST", url: "/v1/tts", payload: requestBody });
      const second = await app.inject({ method: "POST", url: "/v1/tts", payload: requestBody });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(syntheses).toBe(2);
      const rows = await readEvents(namespace);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.event_id).not.toBe(rows[1]!.event_id);
      expect(rows.map((row) => Number(row.commit_seq))).toEqual([1, 2]);
      expect(await readDedupCount(namespace)).toBe(0);
    } finally {
      await app.close();
    }
  });
});
