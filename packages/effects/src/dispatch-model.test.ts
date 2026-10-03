import { describe, it, expect } from "vitest";
import {
  effectAttemptId,
  EffectAttemptV1Schema,
  EffectEvidenceSchema,
  protocolEvidence,
  retryPermitted
} from "./dispatch-model.js";
const id = `ei1_${"a".repeat(64)}`;
const a = EffectAttemptV1Schema.parse({
  version: "effect-attempt.v1",
  attemptId: effectAttemptId(id, "1"),
  intentId: id,
  attemptOrdinal: "1",
  contractRef: "yuvi.read-text.v1",
  adapter: "yuvi.local-read-text.v1",
  fence: "1",
  leaseOwner: "w1",
  leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  dispatchStartedAt: null,
  integrityConflict: false
});
describe("A9.2 concrete identity/evidence rules", () => {
  it("deterministic concrete identity, independent of worker/provider", () =>
    expect(effectAttemptId(id, "1")).toBe(a.attemptId));
  it("new ordinal gets new identity", () => expect(effectAttemptId(id, "2")).not.toBe(a.attemptId));
  it("intent and attempt differ", () => expect(a.attemptId).not.toBe(id));
  it("bigint ordinals are exact beyond JS integer precision", () =>
    expect(effectAttemptId(id, "9007199254740993")).not.toBe(
      effectAttemptId(id, "9007199254740992")
    ));
  it.each(["0", "-1", "1.5", "9223372036854775808"])("invalid ordinal %s fails", (v) =>
    expect(() => effectAttemptId(id, v)).toThrow()
  );
  it("UNKNOWN after start is never replay proof", () =>
    expect(
      retryPermitted(
        { ...a, dispatchStartedAt: a.createdAt },
        protocolEvidence("LEASE_EXPIRED", true)
      )
    ).toBe(false));
  it("absence of evidence never permits retry", () => expect(retryPermitted(a, null)).toBe(false));
  it("unstarted recovered attempt permits retry", () =>
    expect(retryPermitted(a, protocolEvidence("UNSTARTED_RECOVERY", false))).toBe(true));
  it.each([
    "CANCELED_BEFORE_START",
    "EXPIRED_BEFORE_START",
    "AUTHORITY_REVOKED",
    "SHUTDOWN"
  ] as const)("%s permanently withholds local retry", (reason) =>
    expect(retryPermitted(a, protocolEvidence(reason, false))).toBe(false)
  );
  it("contract proof permits a new read attempt", () =>
    expect(
      retryPermitted(
        { ...a, dispatchStartedAt: a.createdAt },
        {
          certainty: "PROVEN_NOT_APPLIED",
          layer: "ADAPTER_RECONCILIATION",
          reason: "RECONCILED_NOT_APPLIED",
          remoteEffectId: null
        }
      )
    ).toBe(true));
  it("integrity conflict blocks retry", () =>
    expect(
      retryPermitted(
        { ...a, integrityConflict: true },
        protocolEvidence("UNSTARTED_RECOVERY", false)
      )
    ).toBe(false));
  it("evidence rejects raw private content", () =>
    expect(() =>
      EffectEvidenceSchema.parse({
        ...protocolEvidence("CALL_UNCERTAIN", true),
        fileContents: "private"
      })
    ).toThrow());
});
