import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FaultPlan,
  faultPort,
  faultPool,
  ControlledTarget,
  SyntheticSurface,
  surfaceInput,
  FAULT_POINTS
} from "./fault-surface.mjs";

test("all twelve owner boundaries support before/after deterministic faults", async () => {
  for (const point of FAULT_POINTS) {
    const f = new FaultPlan();
    let calls = 0;
    f.arm(`${point}.before`);
    await assert.rejects(f.around(point, async () => ++calls));
    assert.equal(calls, 0);
    f.arm(`${point}.after`);
    await assert.rejects(f.around(point, async () => ++calls));
    assert.equal(calls, 1);
    assert.equal(await f.around(point, async () => ++calls), 2);
  }
});
test("barriers release explicitly without sleeps", async () => {
  const f = new FaultPlan(),
    gate = f.arm("callback.before", "PAUSE");
  let reached = false;
  const operation = f.around("callback", async () => {
    reached = true;
  });
  await gate.ready;
  assert.equal(reached, false);
  gate.release();
  await operation;
  assert.equal(reached, true);
});
test("port preserves owner receiver, values and errors", async () => {
  const owner = {
    value: 17,
    async get() {
      return this.value;
    },
    async fail() {
      throw Error("owner");
    }
  };
  const p = faultPort(owner, { get: "manifest" }, new FaultPlan());
  assert.equal(await p.get(), 17);
  await assert.rejects(p.fail(), /owner/);
});
test("transaction ACK loss occurs after actual forward, release remains owned", async () => {
  const f = new FaultPlan(),
    log = [];
  const client = {
    async query(sql) {
      log.push(sql);
      return { rows: [] };
    },
    release() {
      log.push("release");
    }
  };
  const p = faultPool(
    {
      async connect() {
        return client;
      }
    },
    f,
    (sql) => (sql === "commit" ? "observation" : null)
  );
  const c = await p.connect();
  f.arm("observation.after");
  await assert.rejects(c.query("COMMIT"));
  c.release();
  assert.deepEqual(log, ["COMMIT", "release"]);
});
test("private and group input stays bounded metadata passed to existing ingress", async () => {
  for (const kind of ["PRIVATE", "GROUP"]) {
    const surface = new SyntheticSurface(async (input) => ({ hostResult: true, input }));
    assert.equal(
      (await surface.receive({ kind, text: "hello", members: ["hint"] })).input.kind,
      kind
    );
  }
});
test("surface cannot inject conversation, Memory, Person, retry, or context authority", () => {
  for (const key of [
    "conversation",
    "memory",
    "person",
    "retry",
    "context",
    "authority",
    "binding",
    "disclosurePolicy"
  ])
    assert.throws(() => surfaceInput({ kind: "GROUP", text: "hello", [key]: {} }), /authority/);
  assert.throws(() => surfaceInput({ kind: "PRIVATE", text: "x".repeat(4097) }));
  assert.throws(() => surfaceInput({ kind: "GROUP", text: "x", members: Array(33).fill("m") }));
});
test("target reports explicit evidence, never upgrades unknown without supported lookup", async () => {
  const peer = new ControlledTarget();
  for (const response of ["PROVEN_NOT_APPLIED", "APPLIED", "UNKNOWN", "CONFLICT"])
    assert.equal(await peer.write(response, "bounded test bytes", response), response);
  await assert.rejects(peer.write("lost", "bytes", "LOST_RESPONSE"));
  assert.equal(peer.lookup("lost"), "UNKNOWN");
  assert.equal(peer.calls.length, 5);
});
test("target reconciliation and payload conflict are explicit capabilities", async () => {
  const peer = new ControlledTarget({ idempotent: true, lookup: true });
  await assert.rejects(peer.write("id", "old", "LOST_RESPONSE"));
  assert.equal(peer.lookup("id"), "APPLIED");
  assert.equal(await peer.write("id", "new"), "CONFLICT");
  assert.equal(peer.lookup("missing"), "PROVEN_NOT_APPLIED");
});
