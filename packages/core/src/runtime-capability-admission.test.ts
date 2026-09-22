import { describe, expect, it } from "vitest";
import {
  RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
  admitRuntimeCapabilityRound
} from "./runtime-capability-admission.js";

describe("Runtime 6J capability admission", () => {
  it("admits exactly the first policy-allowed capability round", () => {
    const decision = admitRuntimeCapabilityRound({
      version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
      capabilityRoundsUsed: 0,
      policyAllowsCapability: true
    });

    expect(decision).toEqual({
      version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
      status: "ADMITTED"
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("rejects when Runtime policy vetoes capability execution", () => {
    expect(
      admitRuntimeCapabilityRound({
        version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
        capabilityRoundsUsed: 0,
        policyAllowsCapability: false
      })
    ).toEqual({
      version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
      status: "REJECTED",
      reason: "POLICY_DENIED"
    });
  });

  it("rejects every capability request after one round is already used", () => {
    for (const capabilityRoundsUsed of [1, 2, 99]) {
      expect(
        admitRuntimeCapabilityRound({
          version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
          capabilityRoundsUsed,
          policyAllowsCapability: true
        })
      ).toEqual({
        version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
        status: "REJECTED",
        reason: "ROUND_BUDGET_EXHAUSTED"
      });
    }
  });

  it("keeps policy denial authoritative even when the round budget is exhausted", () => {
    expect(
      admitRuntimeCapabilityRound({
        version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
        capabilityRoundsUsed: 1,
        policyAllowsCapability: false
      })
    ).toEqual({
      version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
      status: "REJECTED",
      reason: "POLICY_DENIED"
    });
  });

  it("rejects malformed counters and policy facts", () => {
    for (const invalid of [
      null,
      [],
      {
        version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
        capabilityRoundsUsed: -1,
        policyAllowsCapability: true
      },
      {
        version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
        capabilityRoundsUsed: 0.5,
        policyAllowsCapability: true
      },
      {
        version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
        capabilityRoundsUsed: 0,
        policyAllowsCapability: "yes"
      },
      {
        version: "runtime-capability-admission-unknown",
        capabilityRoundsUsed: 0,
        policyAllowsCapability: true
      }
    ]) {
      expect(() => admitRuntimeCapabilityRound(invalid)).toThrow();
    }
  });

  it("does not admit capability identity, MCP routing, schemas, or arguments into Core", () => {
    for (const extra of [
      { capabilityRef: "capability://opaque/read" },
      { toolName: "read_file" },
      { serverName: "filesystem" },
      { protocol: "mcp" },
      { method: "tools/call" },
      { inputSchema: { type: "object" } },
      { arguments: { path: "README.md" } }
    ]) {
      expect(() =>
        admitRuntimeCapabilityRound({
          version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
          capabilityRoundsUsed: 0,
          policyAllowsCapability: true,
          ...extra
        })
      ).toThrow(/unknown field/);
    }
  });
});

describe("explicit bounded capability admission", () => {
  it("retains policy authority and enforces the Runtime-selected limit", () => {
    const facts = {
      version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
      capabilityRoundsUsed: 1,
      policyAllowsCapability: true,
      maxCapabilityCalls: 2
    };
    expect(admitRuntimeCapabilityRound(facts)).toMatchObject({ status: "ADMITTED" });
    expect(admitRuntimeCapabilityRound({ ...facts, capabilityRoundsUsed: 2 })).toMatchObject({
      status: "REJECTED",
      reason: "ROUND_BUDGET_EXHAUSTED"
    });
    expect(admitRuntimeCapabilityRound({ ...facts, policyAllowsCapability: false })).toMatchObject({
      status: "REJECTED",
      reason: "POLICY_DENIED"
    });
    expect(
      admitRuntimeCapabilityRound({ ...facts, capabilityRoundsUsed: 0, maxCapabilityCalls: 0 })
    ).toMatchObject({ status: "REJECTED", reason: "ROUND_BUDGET_EXHAUSTED" });
  });

  it.each([null, -1, 1.5, 5, Infinity, "2"])(
    "rejects malformed or excessive maximum %s",
    (maxCapabilityCalls) => {
      expect(() =>
        admitRuntimeCapabilityRound({
          version: RUNTIME_CAPABILITY_ADMISSION_6J_VERSION,
          capabilityRoundsUsed: 0,
          policyAllowsCapability: true,
          maxCapabilityCalls
        })
      ).toThrow();
    }
  );
});
