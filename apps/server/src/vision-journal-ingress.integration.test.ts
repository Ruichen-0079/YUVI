import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import type { VisionInput, VisionOutput } from "@companion/providers";
import type { JournalCommittedEnvelope, JournalEventRef } from "@companion/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readSqlMigrations,
  runPostgresMigrations
} from "../../../packages/memory/src/migrations.js";
import type { AppContext } from "./context.js";
import {
  HostVisionReceiptAdmission,
  type VisionReceiptAdmission,
  type VisionReceiptInput
} from "./vision-receipt-admission.js";
import { registerMediaRoutes } from "./routes/media.js";
import type { IncomingMessage } from "node:http";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `vision_ingress_${randomBytes(5).toString("hex")}`;
const schemaSql = `"${schema}"`;
let adminPool: PostgresPool | undefined;
let pool: PostgresPool | undefined;
let namespaceSequence = 0;
const apps: Array<ReturnType<typeof Fastify>> = [];

function createRepository(namespace: string, usingPool = pool!): PostgresJournalRepository {
  return new PostgresJournalRepository(usingPool, {
    namespace,
    authorityBuilder() {
      throw new Error("Vision receipts require host authority.");
    }
  });
}

function nextNamespace(label: string): string {
  namespaceSequence += 1;
  return `a8.2d-${label}-${namespaceSequence}`;
}

function observeNamespaceStateLock(
  sourcePool: PostgresPool,
  onAttempt: () => void
): PostgresPool {
  return new Proxy(sourcePool, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(pgClient, clientProperty) {
              if (clientProperty === "query") {
                return (...args: any[]) => {
                  const first = args[0];
                  const sql =
                    typeof first === "string"
                      ? first
                      : typeof first?.text === "string"
                        ? first.text
                        : "";
                  if (/select\s+current_seq[\s\S]*for\s+update/i.test(sql)) onAttempt();
                  return Reflect.apply(pgClient.query, pgClient, args);
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

function visionOutput(): VisionOutput {
  return {
    text: "provider-only scene result",
    sceneSummary: "provider-only scene result",
    model: "test-vision-model",
    finalProvider: "test-vision-provider"
  };
}

function createApp(
  admission: VisionReceiptAdmission,
  analyzeImage: (input: VisionInput) => Promise<VisionOutput>,
  onRequest?: (request: IncomingMessage) => void
) {
  const app = Fastify({ logger: false });
  const context = {
    visionReceiptAdmission: admission,
    providers: {
      getVisionProvider: () => ({ name: "test-vision-provider", analyzeImage })
    },
    runtime: new Proxy(
      {},
      {
        get() {
          throw new Error("Standalone vision must not route through Runtime.");
        }
      }
    )
  } as unknown as AppContext;
  app.addHook("onRequest", async (request) => {
    onRequest?.(request.raw);
  });
  apps.push(app);
  return registerMediaRoutes(app, context).then(() => app);
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

async function readPayloadRows(namespace: string) {
  const result = await pool!.query(
    `select modality, retention, descriptor, text_content, content_sha256
     from journal_payloads where journal_namespace = $1`,
    [namespace]
  );
  return result.rows as Array<{
    modality: string;
    retention: string;
    descriptor: Record<string, any>;
    text_content: string | null;
    content_sha256: string | null;
  }>;
}

function inlinePayload(prompt?: string) {
  return {
    imageBase64: "data:image/png;base64,AQID",
    ...(prompt === undefined ? {} : { prompt })
  };
}

describe.skipIf(!databaseUrl)("A8.2d standalone vision Journal ingress with PostgreSQL", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query(`create schema ${schemaSql}`);
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
  });

  afterAll(async () => {
    for (const app of apps.splice(0)) await app.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists ${schemaSql} cascade`);
      await adminPool.end();
    }
  });

  it("commits an inline-image receipt before provider work and reopens only the prompt", async () => {
    const namespace = nextNamespace("inline");
    const repository = createRepository(namespace);
    const prompt = "Describe the window 🪟 precisely.";
    let providerCalls = 0;
    const app = await createApp(
      new HostVisionReceiptAdmission(repository),
      async () => {
        providerCalls += 1;
        const rows = await readEvents(namespace);
        expect(rows).toHaveLength(1);
        const command = rows[0]?.envelope.command;
        expect(command?.kind).toBe("RECEIPT");
        if (command?.kind !== "RECEIPT") throw new Error("Expected committed vision receipt.");
        expect(command.data.receiptClass).toBe("DIRECT_OBSERVATION");
        return visionOutput();
      }
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/vision/analyze",
      payload: {
        ...inlinePayload(prompt),
        mimeType: "image/png",
        subjectUserId: "caller-person",
        createdByUserId: "caller-creator",
        personaId: "caller-persona",
        speakerId: "caller-speaker",
        voiceProfileId: "caller-profile"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(providerCalls).toBe(1);

    const rows = await readEvents(namespace);
    expect(rows).toHaveLength(1);
    const envelope = rows[0]!.envelope;
    expect(envelope.command.kind).toBe("RECEIPT");
    if (envelope.command.kind !== "RECEIPT") throw new Error("Expected committed vision receipt.");
    expect(envelope.command.data.receiptClass).toBe("DIRECT_OBSERVATION");
    expect(envelope.authority.principal.state).toBe("UNRESOLVED");
    expect(envelope.authority.binding.state).toBe("UNRESOLVED");
    expect(envelope.authority.subjects).toEqual([]);
    expect(envelope.authority.audience.kind).toBe("UNKNOWN");
    expect(envelope.authority.correlations).toEqual([]);
    expect(envelope.authority.sourceReferences).toEqual([
      {
        kind: "UNRESOLVED_SOURCE",
        reason: "vision transport supplies no stable authenticated upstream request identity"
      }
    ]);
    expect(envelope.command.data.evidenceSelectors).toHaveLength(1);
    expect(envelope.command.data.evidenceSelectors[0]?.modality).toBe("TEXT");
    expect(envelope.authority.payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modality: "IMAGE",
          retention: "NOT_RETAINED",
          selectable: false
        }),
        expect.objectContaining({
          modality: "TEXT",
          retention: "RETAINED",
          selectable: true,
          characterCount: [...prompt].length
        })
      ])
    );
    expect(JSON.stringify(envelope)).not.toContain("AQID");
    expect(JSON.stringify(envelope)).not.toContain("provider-only scene result");

    const payloadRows = await readPayloadRows(namespace);
    const imageRow = payloadRows.find((row) => row.modality === "IMAGE");
    const promptRow = payloadRows.find((row) => row.modality === "TEXT");
    expect(imageRow).toMatchObject({ retention: "NOT_RETAINED", text_content: null });
    expect(JSON.stringify(imageRow)).not.toContain("AQID");
    expect(promptRow?.text_content).toBe(prompt);
    expect(payloadRows).toHaveLength(2);

    const reopenPool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
    try {
      const reopened = createRepository(namespace, reopenPool);
      const reference: JournalEventRef = {
        kind: "JOURNAL_EVENT",
        namespace,
        eventId: rows[0]!.event_id
      };
      const reconstructed = await reopened.get(reference);
      expect(reconstructed).toEqual(envelope);
      const imageDescriptor = reconstructed!.authority.payloads.find(
        (descriptor) => descriptor.modality === "IMAGE"
      )!;
      const textDescriptor = reconstructed!.authority.payloads.find(
        (descriptor) => descriptor.modality === "TEXT"
      )!;
      expect(await reopened.resolveRetainedText(imageDescriptor.ref)).toBeNull();
      expect(await reopened.resolveRetainedText(textDescriptor.ref)).toMatchObject({ text: prompt });
    } finally {
      await reopenPool.end();
    }
  });

  it("records a URL as an attributed reference and never persists its signed query", async () => {
    const namespace = nextNamespace("url-private");
    const repository = createRepository(namespace);
    const privateImageUrl = "https://example.invalid/private/image.png?token=SUPER_SECRET";
    const app = await createApp(
      new HostVisionReceiptAdmission(repository),
      async (input) => {
        expect(input.imageUrl).toBe(privateImageUrl);
        const rows = await readEvents(namespace);
        expect(rows).toHaveLength(1);
        const command = rows[0]?.envelope.command;
        expect(command?.kind).toBe("RECEIPT");
        if (command?.kind !== "RECEIPT") throw new Error("Expected committed vision receipt.");
        expect(command.data.receiptClass).toBe("ATTRIBUTED_ASSERTION");
        return visionOutput();
      }
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/vision/analyze",
      payload: { imageUrl: privateImageUrl }
    });
    expect(response.statusCode).toBe(200);
    const events = await readEvents(namespace);
    const payloadRows = await readPayloadRows(namespace);
    const durable = JSON.stringify({ events, payloadRows });
    expect(durable).not.toContain("SUPER_SECRET");
    expect(durable).not.toContain(privateImageUrl);
    expect(durable).not.toContain("provider-only scene result");
    expect(events).toHaveLength(1);
    expect(payloadRows).toHaveLength(1);
    expect(payloadRows[0]).toMatchObject({
      modality: "IMAGE",
      retention: "NOT_RETAINED",
      text_content: null
    });
  });

  it("creates no fabricated text payload when prompt is absent", async () => {
    const namespace = nextNamespace("no-prompt");
    const repository = createRepository(namespace);
    const admission = new HostVisionReceiptAdmission(repository);
    await admission.admit({ imageSource: "INLINE_BYTES" });

    const event = (await readEvents(namespace))[0]!.envelope;
    if (event.command.kind !== "RECEIPT") throw new Error("Expected committed vision receipt.");
    expect(event.authority.payloads).toHaveLength(1);
    expect(event.authority.payloads[0]).toMatchObject({
      modality: "IMAGE",
      retention: "NOT_RETAINED",
      selectable: false
    });
    expect(event.command.data.evidenceSelectors).toEqual([]);
    expect(await readPayloadRows(namespace)).toHaveLength(1);
  });

  it.each([
    ["identical inline image requests", { imageBase64: "AQID", mimeType: "image/png" }],
    ["identical URL requests", { imageUrl: "https://example.invalid/image.png" }]
  ] as const)("does not deduplicate %s", async (_label, payload) => {
    const namespace = nextNamespace("no-dedup");
    const repository = createRepository(namespace);
    const app = await createApp(
      new HostVisionReceiptAdmission(repository),
      async () => visionOutput()
    );

    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload
      });
      expect(response.statusCode).toBe(200);
    }

    const events = await readEvents(namespace);
    expect(events).toHaveLength(2);
    expect(events[0]!.event_id).not.toBe(events[1]!.event_id);
    const dedup = await pool!.query(
      "select count(*)::int as count from journal_source_dedup where journal_namespace = $1",
      [namespace]
    );
    expect(dedup.rows[0]?.["count"]).toBe(0);
  });

  it("does not start the provider while PostgreSQL append waits on its namespace lock", async () => {
    const namespace = nextNamespace("blocked-append");
    const seedRepository = createRepository(namespace);
    await new HostVisionReceiptAdmission(seedRepository).admit({ imageSource: "INLINE_BYTES" });
    const lockAttempted = deferred<void>();
    const lockedRepository = createRepository(
      namespace,
      observeNamespaceStateLock(pool!, () => lockAttempted.resolve())
    );
    const blocker = await pool!.connect();
    await blocker.query("begin");
    await blocker.query(
      "select current_seq from journal_namespaces where journal_namespace = $1 for update",
      [namespace]
    );
    let request: IncomingMessage | undefined;
    let providerCalls = 0;
    const app = await createApp(new HostVisionReceiptAdmission(lockedRepository), async () => {
      providerCalls += 1;
      return visionOutput();
    }, (incoming) => {
      request = incoming;
    });

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageBase64: "AQID", mimeType: "image/png" }
      });
      await lockAttempted.promise;
      expect(await readEvents(namespace)).toHaveLength(1);
      expect(providerCalls).toBe(0);
      request!.emit("aborted");
      await blocker.query("commit");
      const response = await responsePromise;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ capability: "vision", code: "CANCELLED" });
      expect(providerCalls).toBe(0);
      expect(await readEvents(namespace)).toHaveLength(2);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
      await app.close();
    }
  }, 10_000);

  it("keeps a committed receipt when disconnect arrives before provider start", async () => {
    const namespace = nextNamespace("disconnect-after-commit");
    const repository = createRepository(namespace);
    const committed = deferred<void>();
    const release = deferred<void>();
    let request: IncomingMessage | undefined;
    let providerCalls = 0;
    const hostAdmission = new HostVisionReceiptAdmission(repository);
    const admission: VisionReceiptAdmission = {
      async admit(input: VisionReceiptInput) {
        await hostAdmission.admit(input);
        committed.resolve();
        await release.promise;
      }
    };
    const app = await createApp(
      admission,
      async () => {
        providerCalls += 1;
        return visionOutput();
      },
      (incoming) => {
        request = incoming;
      }
    );

    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/vision/analyze",
        payload: { imageBase64: "AQID", mimeType: "image/png" }
      });
      await committed.promise;
      expect(await readEvents(namespace)).toHaveLength(1);
      request!.emit("aborted");
      release.resolve();

      const response = await responsePromise;
      expect(response.statusCode).toBe(503);
      expect(providerCalls).toBe(0);
      expect(await readEvents(namespace)).toHaveLength(1);
    } finally {
      release.resolve();
      await app.close();
    }
  });

  it("has no in-memory fallback when Journal PostgreSQL is absent", async () => {
    let providerCalls = 0;
    const app = await createApp(new HostVisionReceiptAdmission(null), async (input) => {
      providerCalls += 1;
      void input;
      return visionOutput();
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/vision/analyze",
      payload: { imageBase64: "AQID", mimeType: "image/png" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "JOURNAL_UNAVAILABLE" });
    expect(providerCalls).toBe(0);
  });
});

function deferred<T = void>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value?: T) {
      resolvePromise(value as T);
    }
  };
}
