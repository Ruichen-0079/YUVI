import { describe, it, expect } from "vitest";
import {
  effectAttemptId,
  EffectAttemptV1Schema,
  EffectEvidenceSchema,
  EffectObservationV1Schema,
  EffectObservationV2Schema,
  protocolEvidence,
  retryPermitted
} from "./dispatch-model.js";
import { effectDigest } from "./model.js";
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
  it("uses exact native-owner reconciliation as the only post-start retry proof", () => {
    const nativeAttempt = EffectAttemptV1Schema.parse({
      ...a,
      contractRef: "yuvi.native-control.v1",
      adapter: "yuvi.native-control-owner.v1",
      dispatchStartedAt: a.createdAt
    });
    const applied = EffectEvidenceSchema.parse({
      certainty: "APPLIED",
      layer: "NATIVE_OWNER_COMMIT",
      reason: "OWNER_COMMITTED",
      remoteEffectId: null,
      nativeOwnerCommit: {
        version: "native-owner-commit.v1",
        ownerFamily: "PRODUCT_PERSON",
        targetReference: "person-a",
        revisions: [{ ownerReference: "person:person-a", revision: "person-revision-1" }],
        eventIds: []
      }
    });
    expect(retryPermitted(nativeAttempt, applied)).toBe(false);
    const provenAbsent = EffectEvidenceSchema.parse({
      certainty: "PROVEN_NOT_APPLIED",
      layer: "NATIVE_OWNER_RECONCILIATION",
      reason: "OWNER_RECONCILED_NOT_APPLIED",
      remoteEffectId: null
    });
    expect(retryPermitted(nativeAttempt, provenAbsent)).toBe(true);
  });
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
  it("decodes historical v1 observations and requires exact revisions in native-owner v2", () => {
    const historical = EffectObservationV1Schema.parse({
      version: "effect-observation.v1",
      observationId: "1",
      attemptId: a.attemptId,
      fence: "1",
      contractRef: a.contractRef,
      adapter: a.adapter,
      observedAt: "2026-01-01T00:00:00.000Z",
      evidence: { certainty: "APPLIED", layer: "LOCAL_READ_RETURNED", reason: "RETURNED", remoteEffectId: null },
      evidenceDigest: "a".repeat(64)
    });
    expect(historical.version).toBe("effect-observation.v1");

    const nativeAttempt = EffectAttemptV1Schema.parse({
      ...a,
      contractRef: "yuvi.native-control.v1",
      adapter: "yuvi.native-control-owner.v1"
    });
    const nativeCommit = {
      certainty: "APPLIED" as const,
      layer: "NATIVE_OWNER_COMMIT" as const,
      reason: "OWNER_COMMITTED" as const,
      remoteEffectId: null,
      nativeOwnerCommit: {
        version: "native-owner-commit.v1" as const,
        ownerFamily: "PRODUCT_PERSON" as const,
        targetReference: "person-a",
        revisions: [{ ownerReference: "person:person-a", revision: "person-revision-1" }],
        eventIds: []
      }
    };
    const nativeWithoutCommit = {
      certainty: "APPLIED" as const,
      layer: "NATIVE_OWNER_COMMIT" as const,
      reason: "OWNER_COMMITTED" as const,
      remoteEffectId: null
    };
    expect(() => EffectObservationV2Schema.parse({
      version: "effect-observation.v2",
      observationId: "2",
      attemptId: nativeAttempt.attemptId,
      fence: "1",
      contractRef: nativeAttempt.contractRef,
      adapter: nativeAttempt.adapter,
      observedAt: "2026-01-01T00:00:00.000Z",
      evidence: nativeWithoutCommit,
      evidenceDigest: effectDigest(nativeWithoutCommit)
    })).toThrow();
    expect(EffectObservationV2Schema.parse({
      version: "effect-observation.v2",
      observationId: "3",
      attemptId: nativeAttempt.attemptId,
      fence: "1",
      contractRef: nativeAttempt.contractRef,
      adapter: nativeAttempt.adapter,
      observedAt: "2026-01-01T00:00:00.000Z",
      evidence: nativeCommit,
      evidenceDigest: effectDigest(nativeCommit)
    }).evidence.nativeOwnerCommit).toEqual(nativeCommit.nativeOwnerCommit);
  });
});
