import { z } from "zod";
import { effectDigest, type EffectIntent } from "./model.js";

/** Host-authored transport traits. Neither execution errors nor plugin metadata can strengthen them. */
export const EFFECT_DELIVERY_CONTRACTS = Object.freeze({
  "yuvi.read-text.v1": Object.freeze({
    adapter: "yuvi.local-read-text.v1",
    reconciliation: "OPTIONAL_HOST_LOOKUP",
    retryAfterProvenNotApplied: true,
    evidenceLayer: "LOCAL_READ_RETURNED"
  }),
  "yuvi.embodied-presentation.v1": Object.freeze({
    adapter: "yuvi.presentation-bridge.v1",
    reconciliation: "UNSUPPORTED",
    retryAfterProvenNotApplied: false,
    evidenceLayer: "BRIDGE_ACCEPTANCE"
  })
} as const);
const integer = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
export const EffectAttemptV1Schema = z
  .object({
    version: z.literal("effect-attempt.v1"),
    attemptId: z.string().regex(/^ea1_[a-f0-9]{64}$/),
    intentId: z.string().regex(/^ei1_[a-f0-9]{64}$/),
    attemptOrdinal: integer,
    contractRef: z.enum(["yuvi.read-text.v1", "yuvi.embodied-presentation.v1"]),
    adapter: z.string().min(1).max(128),
    fence: integer,
    leaseOwner: z.string().min(1).max(128),
    leaseExpiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    dispatchStartedAt: z.string().datetime().nullable(),
    integrityConflict: z.boolean()
  })
  .strict();
export type EffectAttemptV1 = z.infer<typeof EffectAttemptV1Schema>;
export const EffectEvidenceSchema = z
  .object({
    certainty: z.enum(["APPLIED", "DEFINITIVE_REJECTION", "PROVEN_NOT_APPLIED", "UNKNOWN"]),
    layer: z.enum([
      "LOCAL_PROTOCOL",
      "LOCAL_READ_RETURNED",
      "BRIDGE_ACCEPTANCE",
      "ADAPTER_RECONCILIATION"
    ]),
    reason: z.enum([
      "RETURNED",
      "REJECTED",
      "CALL_UNCERTAIN",
      "LEASE_EXPIRED",
      "UNSTARTED_RECOVERY",
      "CANCELED_BEFORE_START",
      "EXPIRED_BEFORE_START",
      "AUTHORITY_REVOKED",
      "SHUTDOWN",
      "RECONCILED_APPLIED",
      "RECONCILED_NOT_APPLIED",
      "RECONCILIATION_UNSUPPORTED"
    ]),
    remoteEffectId: z.string().min(1).max(256).nullable()
  })
  .strict()
  .refine((e) => {
    if (e.certainty === "UNKNOWN")
      return (
        e.layer === "LOCAL_PROTOCOL" &&
        ["CALL_UNCERTAIN", "LEASE_EXPIRED", "SHUTDOWN", "RECONCILIATION_UNSUPPORTED"].includes(
          e.reason
        )
      );
    if (e.certainty === "APPLIED")
      return e.layer === "ADAPTER_RECONCILIATION"
        ? e.reason === "RECONCILED_APPLIED"
        : ["LOCAL_READ_RETURNED", "BRIDGE_ACCEPTANCE"].includes(e.layer) && e.reason === "RETURNED";
    if (e.certainty === "DEFINITIVE_REJECTION")
      return e.reason === "REJECTED" && e.layer !== "LOCAL_PROTOCOL";
    return e.layer === "ADAPTER_RECONCILIATION"
      ? e.reason === "RECONCILED_NOT_APPLIED"
      : e.layer === "LOCAL_PROTOCOL" &&
          [
            "UNSTARTED_RECOVERY",
            "CANCELED_BEFORE_START",
            "EXPIRED_BEFORE_START",
            "AUTHORITY_REVOKED",
            "SHUTDOWN"
          ].includes(e.reason);
  });
export type EffectEvidence = z.infer<typeof EffectEvidenceSchema>;
export const EffectObservationV1Schema = z
  .object({
    version: z.literal("effect-observation.v1"),
    observationId: integer,
    attemptId: EffectAttemptV1Schema.shape.attemptId,
    fence: integer,
    contractRef: EffectAttemptV1Schema.shape.contractRef,
    adapter: EffectAttemptV1Schema.shape.adapter,
    observedAt: z.string().datetime(),
    evidence: EffectEvidenceSchema,
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type EffectObservationV1 = z.infer<typeof EffectObservationV1Schema>;
export type EffectDiagnostic = {
  intentId: string;
  admission: EffectIntent["decision"];
  intentState: EffectIntent["state"];
  certainty: EffectEvidence["certainty"] | "NO_DISPATCH" | "INTEGRITY_CONFLICT";
  lastSafeReasonCode: string | null;
  workState: EffectIntent["workState"];
  preDispatchReason: string | null;
  currentAttempt: EffectAttemptV1 | null;
  evidence: EffectEvidence | null;
  reconciliationRequired: boolean;
};
export function effectAttemptId(intentId: string, ordinal: string) {
  integer.parse(ordinal);
  return `ea1_${effectDigest({ intentId, ordinal })}`;
}
export function protocolEvidence(
  reason: EffectEvidence["reason"],
  started: boolean
): EffectEvidence {
  return {
    certainty: started ? "UNKNOWN" : "PROVEN_NOT_APPLIED",
    layer: "LOCAL_PROTOCOL",
    reason,
    remoteEffectId: null
  };
}
export function retryPermitted(a: EffectAttemptV1, e: EffectEvidence | null): boolean {
  if (!e || a.integrityConflict || e.certainty !== "PROVEN_NOT_APPLIED") return false;
  if (
    ["CANCELED_BEFORE_START", "EXPIRED_BEFORE_START", "AUTHORITY_REVOKED", "SHUTDOWN"].includes(
      e.reason
    )
  )
    return false;
  return (
    a.dispatchStartedAt === null ||
    EFFECT_DELIVERY_CONTRACTS[a.contractRef].retryAfterProvenNotApplied
  );
}
