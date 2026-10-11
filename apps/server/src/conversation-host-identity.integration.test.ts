import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import { buildMemoryScope, readSqlMigrations } from "@companion/memory";
import { ConversationHostIdentity } from "./conversation-host-identity.js";
import {
  HostConversationalReceiptAdmission,
  toConversationalJournalRef
} from "./conversational-receipt-admission.js";

const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
describe.skipIf(!url)("Host identity and session ownership with actual PostgreSQL", () => {
  const pool = createPostgresPool(url!);
  const namespace = "r5p2-host-" + randomUUID();
  const personaId = "character-instance:" + randomUUID();
  const journal = new PostgresJournalRepository(pool, {
    namespace,
    authorityBuilder() {
      throw new Error("Host admission required");
    }
  });
  const host = new ConversationHostIdentity(
    pool,
    journal,
    { instanceId: "r5p2-host", personaId },
    (id) => (["x", "y"].includes(id) ? `person-${id}-1` : null)
  );
  const ingress = new HostConversationalReceiptAdmission(journal, undefined, host);
  beforeAll(async () => {
    const m = (await readSqlMigrations()).find((m) => m.name === "027_memory_runtime_host.sql")!;
    await pool.query(m.sql);
  });
  afterAll(() => pool.end());
  const request = (token?: string) => ({
    headers: token ? { authorization: "Bearer " + token } : {}
  });
  it("binds only explicit Host-issued credentials; rotation retains principal, Journal and scoped read authority", async () => {
    const a = await host.issue("x");
    const b = await host.issue("x");
    const sessionId = randomUUID();
    const identity = await host.authorize(request(a.token), { sessionId });
    const rotated = await host.authorize(request(b.token), { sessionId });
    expect(identity?.principal).toEqual(rotated?.principal);
    const receipt = await ingress.admit({
      surface: "HTTP_MESSAGE",
      sessionId,
      runtimeEventId: randomUUID(),
      content: "My editor is synthetic A.",
      hostIdentity: identity!
    });
    const ref = toConversationalJournalRef(receipt.envelope);
    expect(receipt.envelope.authority.binding).toMatchObject({ state: "RESOLVED", personId: "x" });
    expect(await host.readAuthority(ref, buildMemoryScope("x", personaId))).toEqual({
      principal: { namespace, actorId: identity!.principal.actorId },
      personId: "x"
    });
    expect(await host.readAuthority(ref, buildMemoryScope("y", personaId))).toBeUndefined();
    await host.revoke(a.grantId);
    expect(await host.readAuthority(ref, buildMemoryScope("x", personaId))).toBeUndefined();
    await expect(host.authorize(request(a.token), { sessionId: randomUUID() })).rejects.toThrow(
      "HOST_CREDENTIAL_INVALID"
    );
    expect(
      JSON.stringify(
        (await pool.query("select * from memory_host_grants where grant_id=$1", [b.grantId])).rows
      )
    ).not.toContain(b.token);
  });
  it("rejects DTO identity overrides, fabricated in-process proof, foreign origin and missing Person", async () => {
    const a = await host.issue("x");
    await expect(host.issue("missing")).rejects.toThrow("HOST_PERSON_NOT_VERSIONED");
    await expect(
      host.authorize(request(a.token), { sessionId: randomUUID(), subjectUserId: "y" })
    ).rejects.toThrow("HOST_IDENTITY_OVERRIDE_FORBIDDEN");
    await expect(
      host.authorize(
        { headers: { authorization: "Bearer " + a.token, origin: "https://foreign.example" } },
        { sessionId: randomUUID() }
      )
    ).rejects.toThrow("HOST_ORIGIN_FORBIDDEN");
    await expect(
      ingress.admit({
        surface: "HTTP_MESSAGE",
        sessionId: randomUUID(),
        runtimeEventId: randomUUID(),
        content: "Fake",
        hostIdentity: JSON.parse(
          JSON.stringify(await host.authorize(request(a.token), { sessionId: randomUUID() }))
        )
      })
    ).rejects.toThrow("HOST_IDENTITY_NOT_ADMITTED");
  });
  it("fences concurrent ownership and prevents anonymous access or later takeover of a trusted session", async () => {
    const a = await host.issue("x"),
      b = await host.issue("y"),
      sessionId = randomUUID();
    const both = await Promise.allSettled([
      host.authorize(request(a.token), { sessionId }),
      host.authorize(request(b.token), { sessionId })
    ]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    await expect(host.authorize(request(), { sessionId })).rejects.toThrow(
      "HOST_SESSION_OWNER_CONFLICT"
    );
    const anonymous = randomUUID();
    await host.authorize(request(), { sessionId: anonymous, subjectUserId: "x" });
    await expect(host.authorize(request(a.token), { sessionId: anonymous })).rejects.toThrow(
      "HOST_SESSION_OWNER_CONFLICT"
    );
  });
  it("keeps unauthenticated Journal receipts UNKNOWN and rejects credential reuse by another Character", async () => {
    const receipt = await ingress.admit({
      surface: "HTTP_MESSAGE",
      sessionId: randomUUID(),
      runtimeEventId: randomUUID(),
      content: "Anonymous fact"
    });
    expect(receipt.envelope.authority.principal.state).toBe("UNRESOLVED");
    const other = new ConversationHostIdentity(
      pool,
      journal,
      { instanceId: "other", personaId: "character-instance:other" },
      () => "1"
    );
    const grant = await host.issue("x");
    await expect(
      other.authorize(request(grant.token), { sessionId: randomUUID() })
    ).rejects.toThrow("HOST_CREDENTIAL_INVALID");
  });
  it("requires renewed Host binding when the Person revision changes without deleting prior Journal evidence", async () => {
    let revision = "person-current-1";
    const changing = new ConversationHostIdentity(
      pool,
      journal,
      { instanceId: "r5p2-host", personaId },
      (id) => (id === "x" ? revision : null)
    );
    const admission = new HostConversationalReceiptAdmission(journal, undefined, changing);
    const before = await changing.issue("x"),
      sessionId = randomUUID();
    const proof = await changing.authorize(request(before.token), { sessionId });
    const receipt = await admission.admit({
      surface: "HTTP_MESSAGE",
      sessionId,
      runtimeEventId: randomUUID(),
      content: "Retained prior authorized statement",
      hostIdentity: proof!
    });
    const ref = toConversationalJournalRef(receipt.envelope),
      scope = buildMemoryScope("x", personaId);
    expect(await changing.readAuthority(ref, scope)).toBeDefined();
    revision = "person-current-2";
    await expect(changing.authorize(request(before.token), { sessionId })).rejects.toThrow(
      "HOST_CREDENTIAL_INVALID"
    );
    expect(await changing.readAuthority(ref, scope)).toBeUndefined();
    const after = await changing.issue("x"),
      renewed = await changing.authorize(request(after.token), { sessionId });
    expect(renewed?.principal).toEqual(proof?.principal);
    const next = await admission.admit({
      surface: "HTTP_MESSAGE",
      sessionId,
      runtimeEventId: randomUUID(),
      content: "Current authorized statement",
      hostIdentity: renewed!
    });
    expect(
      await changing.readAuthority(toConversationalJournalRef(next.envelope), scope)
    ).toBeDefined();
    expect(await journal.get(ref)).toBeDefined();
  });
});
