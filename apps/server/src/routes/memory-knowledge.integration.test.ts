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
  importLegacyMemoryBatch
} from "@companion/memory";
import { loadServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
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
});
