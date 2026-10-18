import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import {
  applySqlMigrations,
  readSqlMigrations,
  buildMemoryScope,
  MemoryService,
  InMemoryMemoryRepository,
  PostgresMemoryAuthority,
  PostgresMemoryProvider,
  SemanticMemoryPolicy,
  FinalizedIngestionService,
  PostgresFinalizedIngestionRepository,
  JournalMemoryGroundingResolver
} from "@companion/memory";
import { executeFinalizedIngestionEvent } from "../../../packages/memory/src/finalized-ingestion-executor.js";
import { ConversationHostIdentity } from "./conversation-host-identity.js";
import {
  HostConversationalReceiptAdmission,
  toConversationalJournalRef
} from "./conversational-receipt-admission.js";
import { ProductHost } from "./product-host.js";
import { registerProductHostRoutes } from "./routes/product-host.js";
import { registerMemoryKnowledgeRoutes } from "./routes/memory-knowledge.js";
import { loadServerConfig } from "./config.js";
import type { AppContext } from "./context.js";
const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
describe.skipIf(!url)("Product Host real PostgreSQL lifecycle and own-principal Authority", () => {
  const schema = "product_" + randomUUID().replaceAll("-", "");
  const admin = createPostgresPool(url!);
  const pool = createPostgresPool(url!, { options: `-c search_path=${schema},public`, max: 8 });
  const personaId = "character-instance:" + schema;
  const namespace = "product:" + randomUUID();
  const origin = "http://127.0.0.1:31911";
  const controller = "ydc_" + "b".repeat(64);
  let revision = "generation-1";
  const journal = new PostgresJournalRepository(pool, {
    namespace,
    authorityBuilder() {
      throw Error("Host required");
    }
  });
  const host = new ConversationHostIdentity(
    pool,
    journal,
    { instanceId: schema, personaId },
    (id) => (["x", "y"].includes(id) ? revision : null)
  );
  const product = new ProductHost(pool, host, controller);
  const ingress = new HostConversationalReceiptAdmission(journal, undefined, host);
  const authority = new PostgresMemoryAuthority(pool, "fixture-index");
  const provider = new PostgresMemoryProvider(authority);
  const memory = new MemoryService(
    new InMemoryMemoryRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    { kind: "postgres", postgres: provider }
  );
  memory.bindCharacterOwner({ instanceId: schema, personaId });
  const repo = new PostgresFinalizedIngestionRepository(pool);
  const app = Fastify();
  beforeAll(async () => {
    await admin.query(`create schema "${schema}"`);
    await applySqlMigrations(pool, await readSqlMigrations());
    authority.authorizeSource = async (input, tx) =>
      input.lineage?.state === "GROUNDED" &&
      Boolean(await host.readAuthority(input.lineage.parents[0]!.ref, input.scope, tx));
    const context = {
      memory,
      conversationHost: host,
      productHost: product,
      finalizedIngestion: { getTurn: repo.getTurn.bind(repo) }
    } as unknown as AppContext;
    await registerProductHostRoutes(app, context);
    await registerMemoryKnowledgeRoutes(
      app,
      context,
      loadServerConfig({ RUNTIME_MODE: "development", DASHBOARD_DEV_TOKEN: "operator-test-only" })
    );
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  const browser = (cookie?: string, at = origin) => ({
    headers: { origin: at, ...(cookie ? { cookie } : {}) }
  });
  async function pair(person = "x") {
    const code = await product.createPairing(person, origin);
    const result = await app.inject({
      method: "POST",
      url: "/host/v1/product/pair",
      headers: { origin },
      payload: { code: code.code }
    });
    expect(result.statusCode).toBe(200);
    const cookie = String(result.headers["set-cookie"]).split(";")[0]!;
    return { cookie, body: result.json() };
  }
  async function form(cookie: string, content: string) {
    const sessionId = randomUUID();
    const identity = (await host.authorize(browser(cookie), { sessionId }))!;
    const receipt = await ingress.admit({
      surface: "HTTP_MESSAGE",
      sessionId,
      runtimeEventId: randomUUID(),
      content,
      hostIdentity: identity
    });
    const ref = toConversationalJournalRef(receipt.envelope);
    const scope = buildMemoryScope(identity.personId, personaId);
    const policy = new SemanticMemoryPolicy(
      {
        name: "protocol-fixture",
        async generateReasoning() {
          return {
            reasoning: "",
            answer: JSON.stringify({
              propositions: [{ content, evidenceText: content, relation: "new", targetIds: [] }]
            })
          };
        }
      },
      async () => [],
      { providerConfigured: true },
      pool
    );
    const service = new FinalizedIngestionService(
      repo,
      policy,
      new JournalMemoryGroundingResolver(journal)
    );
    const admission = await service.admit({
      finalizedTurnId: "accepted-user:" + ref.eventId,
      assistantMessageId: null,
      sourceUserEventId: ref.eventId,
      conversationId: sessionId,
      traceId: randomUUID(),
      personaId,
      subjectUserId: identity.personId,
      finalizedAt: receipt.envelope.recordedAt,
      ingestionRequested: true,
      userMessage: content,
      sourceText: content,
      sourceJournalRef: ref,
      assistantMessage: ""
    });
    for (const event of admission.events)
      await executeFinalizedIngestionEvent({
        repository: repo,
        provider,
        event,
        leaseOwner: randomUUID(),
        leaseSeconds: 30
      });
    return {
      scope,
      id: (await repo.listEvents(admission.turn.finalizedTurnId))[0]!.backendMemoryId!,
      ref,
      identity
    };
  }
  it("requires native-controller proof, validates Person/origin and stores no plaintext pairing code", async () => {
    for (const headers of [
      {},
      { authorization: "Bearer " + controller, origin },
      { authorization: "Bearer wrong" }
    ]) {
      const r = await app.inject({
        method: "POST",
        url: "/host/v1/product/pairings",
        headers,
        payload: { personId: "x", origin }
      });
      expect(r.statusCode).toBe(401);
    }
    expect(
      product.isController({ ip: "192.0.2.1", headers: { authorization: "Bearer " + controller } })
    ).toBe(false);
    const r = await app.inject({
      method: "POST",
      url: "/host/v1/product/pairings",
      headers: { authorization: "Bearer " + controller },
      payload: { personId: "x", origin }
    });
    expect(r.statusCode).toBe(200);
    expect(
      JSON.stringify((await pool.query("select * from memory_product_pairings")).rows)
    ).not.toContain(r.json().code);
    await expect(product.createPairing("missing", origin)).rejects.toThrow();
    for (const at of [
      "null",
      "https://evil.example",
      origin + "/",
      "not-url",
      "http://127.0.0.1:80/path"
    ])
      await expect(product.createPairing("x", at)).rejects.toThrow();
  });
  it("binds Origin, expires and consumes codes atomically once under concurrent requests", async () => {
    const issued = await product.createPairing("x", origin);
    await expect(
      product.pair(browser(undefined, "http://127.0.0.1:31912"), issued.code)
    ).rejects.toThrow();
    const attempts = await Promise.allSettled([
      product.pair(browser(), issued.code),
      product.pair(browser(), issued.code)
    ]);
    expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const expired = await product.createPairing("x", origin);
    await pool.query(
      "update memory_product_pairings set expires_at=now()-interval '1 second' where consumed_at is null"
    );
    await expect(product.pair(browser(), expired.code)).rejects.toThrow();
    const changed = await product.createPairing("x", origin);
    revision = "generation-2";
    await expect(product.pair(browser(), changed.code)).rejects.toThrow();
    revision = "generation-1";
  });
  it("sets HttpOnly/SameSite and Secure for HTTPS, rejects CSRF and bearer conversion", async () => {
    const issued = await product.createPairing("x", "https://localhost:31911");
    const secured = await product.pair(browser(undefined, issued.origin), issued.code);
    expect(secured.cookie).toContain("; Secure");
    expect(secured.cookie).toContain("HttpOnly; SameSite=Strict");
    const { cookie } = await pair();
    for (const headers of [
      { cookie },
      { cookie, origin: "null" },
      { cookie, origin: "http://127.0.0.1:31912" },
      { cookie: cookie + "; " + cookie, origin }
    ]) {
      const r = await app.inject({
        method: "POST",
        url: "/host/v1/product/renew",
        headers,
        payload: {}
      });
      expect(r.statusCode).toBe(401);
    }
    await expect(
      host.authenticate({ headers: { authorization: "Bearer " + cookie.split("=")[1] } })
    ).rejects.toThrow("HOST_CREDENTIAL_INVALID");
    await expect(host.authenticate(browser(cookie), { subjectUserId: "y" })).rejects.toThrow(
      "HOST_IDENTITY_OVERRIDE_FORBIDDEN"
    );
  });
  it("recovers after Host recreation, renews an expired grant by rotating token, and cannot renew revocation or hard expiry", async () => {
    let { cookie } = await pair();
    const current = (await host.authenticate(browser(cookie)))!;
    const restarted = new ProductHost(pool, host, controller);
    expect((await restarted.state(browser(cookie))).status).toBe("ACTIVE");
    await pool.query(
      "update memory_host_grants set expires_at=now()-interval '1 second' where grant_id=$1",
      [current.grantId]
    );
    await expect(host.authenticate(browser(cookie))).rejects.toThrow();
    expect((await restarted.state(browser(cookie))).status).toBe("EXPIRED");
    const renewed = await app.inject({
      method: "POST",
      url: "/host/v1/product/renew",
      headers: browser(cookie).headers,
      payload: {}
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).not.toHaveProperty("cookie");
    await expect(host.authenticate(browser(cookie))).rejects.toThrow();
    cookie = String(renewed.headers["set-cookie"]).split(";")[0]!;
    expect((await host.authenticate(browser(cookie)))!.principal).toEqual(current.principal);
    await restarted.state(browser(cookie), "revoke");
    await expect(restarted.state(browser(cookie), "renew")).rejects.toThrow();
    const hard = await pair();
    const id = (await host.authenticate(browser(hard.cookie)))!.grantId;
    await pool.query(
      "update memory_product_hosts set renew_until=now()-interval '1 second' where grant_id=$1",
      [id]
    );
    await expect(restarted.state(browser(hard.cookie), "renew")).rejects.toThrow();
  });
  it("filters retrieval audit by exact reader before pagination, not scope alone", async () => {
    const x = await pair();
    const identity = (await host.authenticate(browser(x.cookie)))!;
    const scope = buildMemoryScope("x", personaId);
    const access = { principal: { namespace, actorId: identity.principal.actorId }, personId: "x" };
    const evidence = memory.getRetrievalEvidence(scope)!;
    const outcome = { status: "empty" as const, events: [], source: "postgres", limited: false };
    const own = await evidence.record({ scope, text: "Own audit", access }, outcome, {
      watermark: "0",
      candidates: []
    });
    const foreign = await evidence.record(
      {
        scope,
        text: "Other principal audit secret",
        access: { ...access, principal: { namespace, actorId: "other-principal" } }
      },
      outcome,
      { watermark: "0", candidates: [] }
    );
    const page = await app.inject({
      method: "GET",
      url: `/memory/v1/retrievals?${new URLSearchParams({ scope, limit: "1" })}`,
      headers: browser(x.cookie).headers
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().items.map((item: { id: string }) => item.id)).toEqual([own]);
    const detail = await app.inject({
      method: "GET",
      url: `/memory/v1/retrieval?${new URLSearchParams({ scope, id: foreign })}`,
      headers: browser(x.cookie).headers
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.body).not.toContain("Other principal audit secret");
  });
  it("discloses only own grounded current/history/source/relations, isolates sessions and honors memory disable/revocation", async () => {
    const x = await pair("x"),
      y = await pair("y");
    const record = await form(x.cookie, "My synthetic product fact is lake-blue.");
    await form(y.cookie, "Other Person secret is red.");
    await provider.authority.importLegacy({
      scope: record.scope,
      source: "fixture",
      sourceId: randomUUID(),
      event: {
        id: randomUUID(),
        scope: record.scope,
        kind: "fact",
        content: "Legacy secret must remain hidden",
        source: "legacy",
        sourceRecordId: randomUUID(),
        recordedAt: "2026-10-01T00:00:00Z",
        metadata: {}
      }
    });
    const get = (op: string, cookie: string, scope = record.scope, id?: string) =>
      app.inject({
        method: "GET",
        url: `/memory/v1/${op}?${new URLSearchParams({ scope, ...(id ? { id } : {}) })}`,
        headers: browser(cookie).headers
      });
    for (const op of ["current", "timeline"]) {
      const r = await get(op, x.cookie);
      expect(r.statusCode).toBe(200);
      expect(r.json().records.map((r: { id: string }) => r.id)).toEqual([record.id]);
      expect((await get(op, y.cookie)).statusCode).toBe(403);
    }
    expect((await get("detail", x.cookie, record.scope, record.id)).json().event.content).toContain(
      "lake-blue"
    );
    expect((await get("relations", x.cookie, record.scope, record.id)).statusCode).toBe(200);
    for (const op of ["overview", "migration"])
      expect((await get(op, x.cookie)).statusCode).toBe(403);
    const sessionId = randomUUID();
    await host.authorize(browser(x.cookie), { sessionId });
    await expect(host.authorize(browser(y.cookie), { sessionId })).rejects.toThrow(
      "HOST_SESSION_OWNER_CONFLICT"
    );
    await product.state(browser(x.cookie), "memory", false);
    expect((await host.authenticate(browser(x.cookie)))!.memoryAllowed).toBe(false);
    expect((await get("current", x.cookie)).statusCode).toBe(403);
    expect(await host.readAuthority(record.ref, record.scope)).toBeUndefined();
    expect(await host.allowsConversationSource(record.ref, record.scope)).toBe(true);
    const tx = await pool.connect();
    try {
      await tx.query("begin");
      expect(await host.lockCurrentGrant(record.identity, tx, true)).toBe(false);
      await tx.query("rollback");
    } finally {
      tx.release();
    }
    await product.state(browser(x.cookie), "memory", true);
    expect(await host.readAuthority(record.ref, record.scope)).toBeDefined();
    const nextCode = await product.createPairing("y", origin);
    const switched = await product.pair(browser(x.cookie), nextCode.code);
    await expect(host.authenticate(browser(x.cookie))).rejects.toThrow();
    const newCookie = switched.cookie.split(";")[0]!;
    expect((await get("current", newCookie)).statusCode).toBe(403);
    await product.state(browser(newCookie), "revoke");
    expect((await get("current", newCookie, buildMemoryScope("y", personaId))).statusCode).toBe(
      401
    );
    await expect(host.authorize(browser(newCookie), { sessionId: randomUUID() })).rejects.toThrow();
  });
});
