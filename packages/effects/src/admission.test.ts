import { describe, it, expect, vi } from "vitest";
import { HostEffectIntentAdmission } from "./admission.js";
import { InMemoryEffectIntentStore } from "./store.js";
import { canonicalEffectJson, effectIntentId, requestEffectDigest } from "./model.js";
import { effectRequest, effectAuthority, fixtureJournal, fixtureCause } from "./test-fixture.js";

function setup(now = () => new Date("2026-10-03T00:00:00Z")) {
  const store = new InMemoryEffectIntentStore(now);
  const port = new HostEffectIntentAdmission(store, fixtureJournal, now);
  return { store, port };
}
describe("A9.1 host admission, process-local parity", () => {
  it("replays the same logical effect, freezes exact causal/identity/permission versions", async () => {
    const { port } = setup();
    const request = effectRequest();
    const authority = effectAuthority();
    const a = await port.admit(request, authority);
    authority.snapshot.authorityVersion = "new-version";
    const b = await port.admit({ ...request, executionId: "new-execution" }, authority);
    expect(b).toEqual(a);
    expect(a.request.causalRefs).toEqual(request.causalRefs);
    expect(a.authorization.identity.principal.state).toBe("UNRESOLVED");
    expect(a.authorization.identity.binding.state).toBe("UNRESOLVED");
    expect(a.authorization.authorityVersion).toBe("activity:42");
    expect(a.authorization.permissions).toEqual(["RUNTIME_EMBODIED_PRESENTATION"]);
    expect(await port.listPending()).toHaveLength(1);
  });
  it("different keys are distinct; changed payload with one key conflicts", async () => {
    const { port } = setup();
    const r = effectRequest();
    await port.admit(r, effectAuthority());
    expect(
      (await port.admit(effectRequest("another-effect"), effectAuthority())).intentId
    ).not.toBe(effectIntentId(r.contractRef, r.logicalKey));
    await expect(
      port.admit({ ...r, expiresAt: "2098-01-01T00:00:00.000Z" }, effectAuthority())
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("concurrent identical requests create one work item", async () => {
    const { port } = setup();
    const all = await Promise.all(
      Array.from({ length: 20 }, () => port.admit(effectRequest(), effectAuthority()))
    );
    expect(new Set(all.map((v) => v.intentId)).size).toBe(1);
    expect(await port.listPending()).toHaveLength(1);
  });
  it("concurrent differing semantics have one winner", async () => {
    const { port } = setup();
    const all = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        port.admit(
          {
            ...effectRequest(),
            expiresAt: `2099-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`
          },
          effectAuthority()
        )
      )
    );
    expect(all.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(all.filter((v) => v.status === "rejected")).toHaveLength(11);
    expect(await port.listPending()).toHaveLength(1);
  });
  it.each(["permission", "scope", "audience", "stale", "identity"])(
    "durable %s denial has no rejected payload or work and replay cannot grant it",
    async (kind) => {
      const { port } = setup();
      const a = effectAuthority();
      if (kind === "permission") a.snapshot.allowed = false;
      if (kind === "scope") a.snapshot.scope = "foreign";
      if (kind === "audience")
        a.snapshot.identity.audience = { kind: "PRIVATE", channelRef: "foreign" };
      if (kind === "stale") a.isCurrent = () => false;
      if (kind === "identity")
        a.snapshot.identity.binding = {
          state: "RESOLVED",
          kind: "PERSON_BINDING",
          personId: "invented",
          bindingVersion: "1"
        };
      const denied = await port.admit(effectRequest(), a);
      expect(denied.state).toBe("DENIED");
      expect(denied.request).not.toHaveProperty("payload");
      expect(denied.workState).toBeNull();
      expect(await port.listPending()).toEqual([]);
      expect(await port.admit(effectRequest(), effectAuthority())).toEqual(denied);
    }
  );
  it("unknown cause and unavailable authority are failures without decisions", async () => {
    const store = new InMemoryEffectIntentStore();
    await expect(
      new HostEffectIntentAdmission(store, {
        async get() {
          return null;
        }
      }).admit(effectRequest(), effectAuthority())
    ).rejects.toMatchObject({ code: "UNKNOWN_CAUSE" });
    await expect(
      new HostEffectIntentAdmission(store, {
        async get() {
          throw Error("outage");
        }
      }).admit(effectRequest(), effectAuthority())
    ).rejects.toMatchObject({ code: "AUTHORITY_UNAVAILABLE" });
    expect(await store.listPending(100)).toEqual([]);
  });
  it("receipt-looking and non-receipt causes cannot authorize admission", async () => {
    const { store } = setup();
    for (const cause of [
      { ...fixtureCause, eventId: "jev1_bbbbbbbbbbbbbbbb" },
      { ...fixtureCause, command: { kind: "INTENT" } }
    ]) {
      await expect(
        new HostEffectIntentAdmission(store, {
          async get() {
            return cause as typeof fixtureCause;
          }
        }).admit(effectRequest(), effectAuthority())
      ).rejects.toMatchObject({ code: "UNKNOWN_CAUSE" });
    }
  });
  it("late revocation rolls back admission before commit", async () => {
    const { port } = setup();
    const a = effectAuthority();
    let checks = 0;
    a.isCurrent = () => ++checks === 1;
    await expect(port.admit(effectRequest(), a)).rejects.toMatchObject({
      code: "AUTHORITY_CHANGED"
    });
    expect(await port.listPending()).toEqual([]);
  });
  it("cancel survives replay and facade reopen; admission/cancel linearize", async () => {
    const { store, port } = setup();
    const intent = await port.admit(effectRequest(), effectAuthority());
    await Promise.all([
      port.cancel(intent.intentId),
      port.admit(effectRequest(), effectAuthority())
    ]);
    const reopened = new HostEffectIntentAdmission(store, fixtureJournal);
    expect((await reopened.get(intent.intentId))?.state).toBe("CANCELED");
    expect((await reopened.admit(effectRequest(), effectAuthority())).state).toBe("CANCELED");
    expect(await reopened.listPending()).toEqual([]);
  });
  it("expiry is immediately non-dispatchable without a sweep and remains terminal", async () => {
    let time = new Date("2026-10-03T00:00:00Z");
    const { port } = setup(() => time);
    const r = { ...effectRequest(), expiresAt: "2026-10-03T00:00:01.000Z" };
    const v = await port.admit(r, effectAuthority());
    time = new Date("2026-10-03T00:00:02Z");
    expect(await port.listPending()).toEqual([]);
    expect(await port.expire()).toBe(1);
    expect((await port.get(v.intentId))?.state).toBe("EXPIRED");
    expect((await port.admit(r, effectAuthority())).state).toBe("EXPIRED");
  });
  it("already expired requests are denied; no arbitrary universal TTL", async () => {
    const { port } = setup();
    expect(
      (
        await port.admit(
          { ...effectRequest(), expiresAt: "2020-01-01T00:00:00.000Z" },
          effectAuthority()
        )
      ).reasonCode
    ).toBe("EXPIRED_AT_ADMISSION");
  });
  it("canonical payload ignores execution and source allocation time, preserves actual effect", () => {
    const a = effectRequest();
    const b = structuredClone(a);
    b.executionId = "other";
    (b.payload as { sourceInstance: { createdAtMs: number } }).sourceInstance.createdAtMs = 9999;
    expect(requestEffectDigest(a)).toBe(requestEffectDigest(b));
    expect(canonicalEffectJson({ b: 2, a: [1, false] })).toBe(
      canonicalEffectJson({ a: [1, false], b: 2 })
    );
    expect(requestEffectDigest({ ...a, scope: "foreign" })).not.toBe(requestEffectDigest(a));
  });
  it.each([undefined, NaN, Infinity, new Date(), () => 1])(
    "invalid JSON payload %s cannot produce a decision",
    async (payload) => {
      const { port } = setup();
      await expect(
        port.admit({ ...effectRequest(), payload }, effectAuthority())
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(await port.listPending()).toEqual([]);
    }
  );
  it("transport extras, model permissions, getters and Memory contracts are not admission input", async () => {
    const { port } = setup();
    for (const extra of [
      { workerId: "worker" },
      { retryCount: 3 },
      { contractRef: "yuvi.finalized-memory.v1" },
      { confidence: 1 }
    ])
      await expect(
        port.admit({ ...effectRequest(), ...extra } as never, effectAuthority())
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const getter = vi.fn(() => "secret");
    await expect(
      port.admit(
        {
          ...effectRequest(),
          payload: {
            get apiKey() {
              return getter();
            }
          }
        },
        effectAuthority()
      )
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(getter).not.toHaveBeenCalled();
  });
  it("caller mutation cannot alter frozen durable semantics", async () => {
    const { port } = setup();
    const r = effectRequest();
    const v = await port.admit(r, effectAuthority());
    r.scope = "changed";
    v.request.scope = "changed";
    expect((await port.get(v.intentId))?.request.scope).toBe("session:42");
  });
  it("the admission ABI has no dispatch method across replay/reopen/cancel/expiry", async () => {
    const { store, port } = setup();
    const v = await port.admit(effectRequest(), effectAuthority());
    await port.admit(effectRequest(), effectAuthority());
    await new HostEffectIntentAdmission(store, fixtureJournal).listPending();
    await port.cancel(v.intentId);
    await port.expire();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(port))).not.toContain("dispatch");
  });
  it("missing durable authority does not fall back to memory", async () => {
    await expect(
      new HostEffectIntentAdmission(null, fixtureJournal).admit(effectRequest(), effectAuthority())
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("checks audience independently of causal identity and exact contract permissions", async () => {
    const { port } = setup();
    const foreign = {
      ...effectRequest("audience"),
      audience: { kind: "PRIVATE" as const, channelRef: "other" }
    };
    expect((await port.admit(foreign, effectAuthority())).reasonCode).toBe("AUDIENCE_DENIED");
    const authority = effectAuthority();
    authority.snapshot.permissions = ["UNRELATED_PERMISSION"];
    expect((await port.admit(effectRequest("wrong-permission"), authority)).reasonCode).toBe(
      "PERMISSION_DENIED"
    );
  });
  it("canonical read-text policy freezes only the intended path and performs no read", async () => {
    const { port } = setup();
    const authority = effectAuthority();
    authority.snapshot.permissions = ["RUNTIME_AUTHORIZED_PATH_READ"];
    const request = {
      ...effectRequest("read"),
      contractRef: "yuvi.read-text.v1" as const,
      payload: { path: "/nonexistent/a91-admission-only.txt" }
    };
    const admitted = await port.admit(request, authority);
    expect(admitted.request.payload).toEqual(request.payload);
    expect(admitted.authorization.policyVersion).toBe(authority.snapshot.policyVersion);
    expect(admitted.request.audience).toEqual(request.audience);
    expect(admitted.request.executionId).not.toBe(admitted.intentId);
    expect(admitted).not.toHaveProperty("attemptId");
    expect(requestEffectDigest({ ...request, payload: { path: "/different.txt" } })).not.toBe(
      admitted.payloadDigest
    );
    await expect(
      port.admit({ ...request, payload: { path: "/different.txt" } }, authority)
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("admits only the fixed native-control payload descriptor", async () => {
    const { port } = setup();
    const authority = effectAuthority();
    authority.snapshot.permissions = ["NATIVE_CONTROL_COMMAND"];
    const request = {
      ...effectRequest("native-control.v1|test|person|command-a"),
      contractRef: "yuvi.native-control.v1" as const,
      payload: {
        version: "native-control-command.v1" as const,
        family: "PRODUCT_PERSON" as const,
        commandHandle: "command-a",
        payloadRef: "payload-a",
        payloadDigest: "a".repeat(64),
        semanticDigest: "b".repeat(64),
        targetReference: "person-a"
      }
    };
    const admitted = await port.admit(request, authority);
    expect(admitted.request.payload).toEqual(request.payload);
    await expect(
      port.admit({ ...request, payload: { ...request.payload, family: "OTHER" } as never }, authority)
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("malformed authority/requests, duplicate causes, cyclic and deep values are input failures without decisions", async () => {
    const { port } = setup();
    const request = effectRequest();
    await expect(
      port.admit(
        { ...request, causalRefs: [...request.causalRefs, ...request.causalRefs] },
        effectAuthority()
      )
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      port.admit({ ...request, logicalKey: " " }, effectAuthority())
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const authority = effectAuthority();
    authority.snapshot.authorityVersion = "";
    await expect(port.admit(request, authority)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const cycle: { child?: unknown } = {};
    cycle.child = cycle;
    await expect(
      port.admit({ ...request, payload: cycle }, effectAuthority())
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    let deep: unknown = "end";
    for (let n = 0; n < 70; n++) deep = { child: deep };
    await expect(
      port.admit({ ...request, payload: deep }, effectAuthority())
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await port.listPending()).toEqual([]);
  });
  it("a deadline reached inside the admission boundary rolls back rather than returning a denied/outcome decision", async () => {
    let now = new Date("2026-10-03T00:00:00Z");
    const { port } = setup(() => now);
    const authority = effectAuthority();
    let checks = 0;
    authority.isCurrent = () => {
      if (++checks === 2) now = new Date("2026-10-03T00:00:02Z");
      return true;
    };
    await expect(
      port.admit({ ...effectRequest(), expiresAt: "2026-10-03T00:00:01.000Z" }, authority)
    ).rejects.toMatchObject({ code: "AUTHORITY_CHANGED" });
    expect(await port.listPending()).toEqual([]);
  });
});
