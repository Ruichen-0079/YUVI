import Fastify from "fastify";
import { createPostgresPool } from "@companion/database";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  InMemoryMemoryRepository,
  MemoryService,
  PostgresMemoryProvider,
  PostgresMemoryAuthority,
  buildMemoryScope,
  MemoryIntegrityAudit,
  importLegacyMemoryBatch,
  applySqlMigrations,
  readSqlMigrations
} from "@companion/memory";
import { loadServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { PostgresJournalRepository } from "@companion/journal";
import { registerMemoryOperationRoutes } from "./memory-operations.js";
import { registerMemoryKnowledgeRoutes } from "./memory-knowledge.js";
const db = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
describe.skipIf(!db)("R5 product API actual PostgreSQL routes", () => {
  const pool = createPostgresPool(db!);
  const provider = new PostgresMemoryProvider(new PostgresMemoryAuthority(pool));
  const person = "r5-api-" + randomUUID();
  const scope = buildMemoryScope(person, "character-instance:r5-api");
  const memory = new MemoryService(
    new InMemoryMemoryRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    { kind: "postgres", postgres: provider }
  );
  memory.bindCharacterOwner({ instanceId: "r5-api", personaId: "character-instance:r5-api" });
  const app = Fastify();
  const token = "r5-synthetic-api-token";
  let recordId: string;
  beforeAll(async () => {
    await applySqlMigrations(pool, await readSqlMigrations());
    await importLegacyMemoryBatch(provider.authority, {
      migrationId: randomUUID(),
      scope,
      source: "synthetic-export",
      expectedCheckpoint: null,
      nextCheckpoint: "1",
      complete: true,
      records: [
        JSON.parse(
          JSON.stringify({
            id: "old",
            kind: "fact",
            content: "Synthetic preserved history",
            source: "mem0",
            sourceRecordId: "old",
            scope,
            recordedAt: "2026-10-01T00:00:00Z",
            metadata: {
              secretRawSource: "must not disclose",
              evidenceSelection: {
                unit: "UNICODE_CODE_POINT",
                start: 0,
                end: 1,
                rawSourceBody: "must not disclose"
              }
            },
            rawSourceBody: "must not disclose",
            observedAt: "Wed Oct 01 2026 00:00:00 GMT+0000 (must not disclose)",
            lineage: { rawJournalBody: "must not disclose" }
          })
        )
      ]
    });
    await registerMemoryOperationRoutes(
      app,
      {
        memory,
        memoryIntegrity: new MemoryIntegrityAudit(
          provider.authority,
          new PostgresJournalRepository(pool, {
            namespace: "r5-api",
            authorityBuilder() {
              throw Error("Host required");
            }
          })
        )
      } as unknown as AppContext,
      loadServerConfig({ RUNTIME_MODE: "development", DASHBOARD_DEV_TOKEN: token })
    );
    recordId = (await provider.knowledge.timeline({ scope })).records[0]!.id;
    await registerMemoryKnowledgeRoutes(
      app,
      { memory, finalizedIngestion: { getTurn: async () => null } } as unknown as AppContext,
      loadServerConfig({ RUNTIME_MODE: "development", DASHBOARD_DEV_TOKEN: token })
    );
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });
  const query = (op: string, s = scope, extra = "") =>
    `/memory/v1/${op}?scope=${encodeURIComponent(s)}${extra}`;
  const get = (
    url: string,
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
    remoteAddress = "127.0.0.1"
  ) => app.inject({ url, headers, remoteAddress });
  it("exposes verified schema/counts, empty current and explicit legacy history without raw metadata", async () => {
    const overview = await get(query("overview"));
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      schema: "memory.overview.v1",
      records: "1",
      current: "0",
      legacy: "1"
    });
    expect((await get(query("current"))).json().records).toHaveLength(0);
    const timeline = (await get(query("timeline"))).json();
    expect(timeline.records[0].state).toBe("legacy_unverified");
    expect(JSON.stringify(timeline)).not.toContain("must not disclose");
    expect((await get(query("detail", scope, "&id=" + recordId))).json().id).toBe(recordId);
    expect((await get(query("relations", scope, "&id=" + recordId))).json().relations).toEqual([]);
    expect((await get(query("processing", scope, "&id=" + recordId))).json().schema).toBe(
      "memory.processing.v1"
    );
  });
  it("operates through the actual admitted service facade, not instanceof the Runtime wrapper", async () => {
    expect(memory.getMemoryProvider()).not.toBe(provider);
    expect(memory.getAuthorityInfrastructure()).toBe(provider);
    const response = await app.inject({
      method: "POST",
      url: "/memory/v1/operations",
      remoteAddress: "127.0.0.1",
      headers: { authorization: `Bearer ${token}` },
      payload: { scope, operation: "PROJECTION_VERIFY" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ schema: "memory.verify.v1", mismatches: [] });
    const lexical = await app.inject({
      method: "POST",
      url: "/memory/v1/operations",
      remoteAddress: "127.0.0.1",
      headers: { authorization: `Bearer ${token}` },
      payload: { scope, operation: "LEXICAL_ADVANCE", limit: 10 }
    });
    expect(lexical.statusCode).toBe(200);
    expect(lexical.json()).toMatchObject({ schema: "memory.lexical-index.v1", status: "READY" });
    const unauthorized = await app.inject({
      method: "POST",
      url: "/memory/v1/operations",
      remoteAddress: "127.0.0.1",
      payload: { scope, operation: "PROJECTION_VERIFY" }
    });
    expect(unauthorized.statusCode).toBe(401);
  });
  it("rejects remote, foreign Origin, missing token, foreign Persona and invalid cursor", async () => {
    expect((await get(query("overview"), {}, "127.0.0.1")).statusCode).toBe(401);
    expect(
      (await get(query("overview"), { authorization: `Bearer ${token}` }, "192.0.2.4")).statusCode
    ).toBe(403);
    expect(
      (
        await get(query("overview"), {
          authorization: `Bearer ${token}`,
          origin: "https://foreign.example"
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await get(query("overview", buildMemoryScope(person, "other-persona")))).statusCode
    ).toBe(403);
    const invalidCursor = await get(query("timeline", scope, "&cursor=invalid"));
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json().status).toBe("FAILED");
  });
  it("does not disclose other scope IDs, reports unknown ingestion and validates limits", async () => {
    expect(
      (
        await get(
          query(
            "detail",
            buildMemoryScope(person + "-other", "character-instance:r5-api"),
            "&id=" + recordId
          )
        )
      ).statusCode
    ).toBe(404);
    expect((await get(query("ingestion", scope, "&id=nonexistent"))).json().status).toBe("UNKNOWN");
    expect((await get(query("current", scope, "&limit=1000"))).statusCode).toBe(400);
  });
  it("runs authenticated checkpoint migration operations and exposes a bounded source-free status", async () => {
    const id = randomUUID(),
      legacyPerson = "legacy-api-" + randomUUID(),
      legacyPersona = "legacy-fixture";
    await pool.query(
      "insert into memories(type,source,content,subject_user_id,persona_id,metadata) values('semantic','fixture','Legacy retained API example',$1,$2,'{\"privateRawSource\":\"never disclose\"}'::jsonb)",
      [legacyPerson, legacyPersona]
    );
    const op = (operation: string, body: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: "/memory/v1/operations",
        headers: { authorization: `Bearer ${token}` },
        payload: { operation, scope, id, ...body }
      });
    const denied = await app.inject({
      method: "POST",
      url: "/memory/v1/operations",
      payload: { operation: "MIGRATION_PREPARE", scope, id, legacyPerson, legacyPersona }
    });
    expect(denied.statusCode).toBe(401);
    const first = await op("MIGRATION_PREPARE", { legacyPerson, legacyPersona });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("SNAPSHOTTING");
    expect((await op("MIGRATION_PAUSE")).json().status).toBe("PAUSED");
    expect((await op("MIGRATION_ADVANCE")).json().status).toBe("PAUSED");
    await op("MIGRATION_RESUME");
    for (let i = 0; i < 3; i++) expect((await op("MIGRATION_ADVANCE")).statusCode).toBe(200);
    const status = await get(query("migration", scope, "&id=" + id));
    expect(status.json()).toMatchObject({
      status: "IMPORT_VERIFIED",
      expected: "1",
      imported: "1",
      verified: "1",
      activation: "BLOCKED_SOURCE_REVIEW_REQUIRED"
    });
    expect(JSON.stringify(status.json())).not.toContain("privateRawSource");
    expect(JSON.stringify(status.json())).not.toContain("never disclose");
    expect(
      (
        await get(
          query("migration", buildMemoryScope(person, "character-instance:another"), "&id=" + id)
        )
      ).statusCode
    ).toBe(403);
  });
  it("requires operator disclosure in production; localhost and conversational credentials cannot read another Person", async () => {
    const prod = Fastify();
    await registerMemoryKnowledgeRoutes(
      prod,
      { memory } as unknown as AppContext,
      loadServerConfig({ RUNTIME_MODE: "production", DASHBOARD_DEV_TOKEN: token })
    );
    try {
      for (const headers of [{}, { authorization: "Bearer yuh_conversation-is-not-operator" }])
        expect((await prod.inject({ url: query("overview"), headers })).statusCode).toBe(401);
      expect(
        (
          await prod.inject({
            url: query("overview"),
            headers: { authorization: `Bearer ${token}` }
          })
        ).statusCode
      ).toBe(200);
      expect(
        (
          await prod.inject({
            url: query("overview"),
            remoteAddress: "192.0.2.1",
            headers: { authorization: `Bearer ${token}` }
          })
        ).statusCode
      ).toBe(403);
    } finally {
      await prod.close();
    }
    const unconfigured = Fastify();
    await registerMemoryKnowledgeRoutes(
      unconfigured,
      { memory } as unknown as AppContext,
      loadServerConfig({ RUNTIME_MODE: "production" })
    );
    try {
      expect((await unconfigured.inject({ url: query("overview") })).statusCode).toBe(401);
    } finally {
      await unconfigured.close();
    }
  });
});
