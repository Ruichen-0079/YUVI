import { z } from "zod";
import { effectDigest, type EffectIntent } from "./model.js";

/** Host-authored transport traits. Neither execution errors nor plugin metadata can strengthen them. */
export const EFFECT_DELIVERY_CONTRACTS = Object.freeze({
  "yuvi.provider.v1": Object.freeze({
    adapter: "yuvi.provider-leaf.v1",
    reconciliation: "UNSUPPORTED",
    retryAfterProvenNotApplied: true,
    evidenceLayers: ["PROVIDER_RESPONSE", "PROVIDER_PRE_TRANSPORT"]
  }),
  "yuvi.publication.v1": Object.freeze({
    adapter: "yuvi.target-publication.v1",
    reconciliation: "UNSUPPORTED",
    retryAfterProvenNotApplied: false,
    evidenceLayers: ["LOCAL_GATEWAY_WRITE_ACCEPTED"]
  }),
  "yuvi.playback.v1": Object.freeze({
    adapter: "yuvi.playback-permission.v1",
    reconciliation: "OPTIONAL_HOST_LOOKUP",
    retryAfterProvenNotApplied: false,
    evidenceLayers: ["DEVICE_REPORTED_PLAYING"]
  }),
  "yuvi.read-text.v1": Object.freeze({
    adapter: "yuvi.local-read-text.v1",
    reconciliation: "OPTIONAL_HOST_LOOKUP",
    retryAfterProvenNotApplied: true,
    evidenceLayers: ["LOCAL_READ_RETURNED"]
  }),
  "yuvi.embodied-presentation.v1": Object.freeze({
    adapter: "yuvi.presentation-bridge.v1",
    reconciliation: "UNSUPPORTED",
    retryAfterProvenNotApplied: false,
    evidenceLayers: ["BRIDGE_ACCEPTANCE"]
  }),
  "yuvi.native-control.v1": Object.freeze({
    adapter: "yuvi.native-control-owner.v1",
    reconciliation: "OPTIONAL_HOST_LOOKUP",
    retryAfterProvenNotApplied: true,
    evidenceLayers: ["NATIVE_OWNER_COMMIT", "NATIVE_OWNER_RECONCILIATION"]
  })
} as const);
const integer = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
export const NativeOwnerCommitV1Schema = z
  .object({
    version: z.literal("native-owner-commit.v1"),
    ownerFamily: z.enum(["PRODUCT_PERSON", "VOICE_BINDING", "ACOUSTIC_PROFILE", "P8_CORRECTION"]),
    targetReference: z.string().min(1).max(512),
    revisions: z
      .array(
        z
          .object({
            ownerReference: z.string().min(1).max(512),
            revision: z.string().min(1).max(512)
          })
          .strict()
      )
      .min(1)
      .max(8),
    eventIds: z.array(z.string().min(1).max(512)).max(16)
  })
  .strict();
export type NativeOwnerCommitV1 = z.infer<typeof NativeOwnerCommitV1Schema>;
export const EffectAttemptV1Schema = z
  .object({
    version: z.literal("effect-attempt.v1"),
    attemptId: z.string().regex(/^ea1_[a-f0-9]{64}$/),
    intentId: z.string().regex(/^ei1_[a-f0-9]{64}$/),
    attemptOrdinal: integer,
    contractRef: z.enum([
      "yuvi.read-text.v1",
      "yuvi.embodied-presentation.v1",
      "yuvi.native-control.v1",
      "yuvi.provider.v1",
      "yuvi.publication.v1",
      "yuvi.playback.v1"
    ]),
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
      "PROVIDER_RESPONSE",
      "PROVIDER_PRE_TRANSPORT",
      "LOCAL_GATEWAY_WRITE_ACCEPTED",
      "DEVICE_REPORTED_PLAYING",
      "BRIDGE_ACCEPTANCE",
      "ADAPTER_RECONCILIATION",
      "NATIVE_OWNER_COMMIT",
      "NATIVE_OWNER_RECONCILIATION"
    ]),
    reason: z.enum([
      "RETURNED",
      "HOST_CERTIFIED_NOT_STARTED",
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
      "RECONCILIATION_UNSUPPORTED",
      "OWNER_COMMITTED",
      "OWNER_COMMITTED_CLEANUP_PENDING",
      "OWNER_REJECTED",
      "OWNER_RECONCILED_APPLIED",
      "OWNER_RECONCILED_APPLIED_CLEANUP_PENDING",
      "OWNER_RECONCILED_NOT_APPLIED"
    ]),
    remoteEffectId: z.string().min(1).max(256).nullable(),
    nativeOwnerCommit: NativeOwnerCommitV1Schema.optional()
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
        : e.layer === "NATIVE_OWNER_COMMIT"
          ? e.reason === "OWNER_COMMITTED" || e.reason === "OWNER_COMMITTED_CLEANUP_PENDING"
          : e.layer === "NATIVE_OWNER_RECONCILIATION"
            ? e.reason === "OWNER_RECONCILED_APPLIED" ||
              e.reason === "OWNER_RECONCILED_APPLIED_CLEANUP_PENDING"
            : [
                "LOCAL_READ_RETURNED",
                "BRIDGE_ACCEPTANCE",
                "PROVIDER_RESPONSE",
                "LOCAL_GATEWAY_WRITE_ACCEPTED",
                "DEVICE_REPORTED_PLAYING"
              ].includes(e.layer) && e.reason === "RETURNED";
    if (e.certainty === "DEFINITIVE_REJECTION")
      return ["REJECTED", "OWNER_REJECTED"].includes(e.reason) && e.layer !== "LOCAL_PROTOCOL";
    return e.layer === "PROVIDER_PRE_TRANSPORT"
      ? e.reason === "HOST_CERTIFIED_NOT_STARTED"
      : e.layer === "ADAPTER_RECONCILIATION"
        ? e.reason === "RECONCILED_NOT_APPLIED"
        : e.layer === "NATIVE_OWNER_RECONCILIATION"
          ? e.reason === "OWNER_RECONCILED_NOT_APPLIED"
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
export const EffectObservationV2Schema = z
  .object({
    version: z.literal("effect-observation.v2"),
    observationId: integer,
    attemptId: EffectAttemptV1Schema.shape.attemptId,
    fence: integer,
    contractRef: EffectAttemptV1Schema.shape.contractRef,
    adapter: EffectAttemptV1Schema.shape.adapter,
    observedAt: z.string().datetime(),
    evidence: EffectEvidenceSchema,
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      observation.evidence.certainty === "APPLIED" &&
      observation.evidence.layer.startsWith("NATIVE_OWNER_") &&
      !observation.evidence.nativeOwnerCommit
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "nativeOwnerCommit"],
        message: "Applied native-owner evidence requires its exact owner revision."
      });
    if (observation.evidenceDigest !== effectDigest(observation.evidence))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceDigest"],
        message: "Invalid native-owner evidence digest."
      });
  });
export type EffectObservationV2 = z.infer<typeof EffectObservationV2Schema>;
export type EffectObservation = EffectObservationV1 | EffectObservationV2;
export type EffectDiagnostic = {
  contractRef?: EffectIntent["contractRef"];
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

/** Facts supplement terminal evidence; they never reopen work or permit another attempt. */
export const EffectProgressFactSchema = z
  .object({
    factKey: z.string().min(1).max(512),
    kind: z.enum([
      "PROVIDER_LEAF",
      "TEXT_COMPONENT",
      "AUDIO_RESULT",
      "PERMISSION_ISSUED",
      "SUBTITLE_ACCEPTED",
      "DEVICE_ATTACHED",
      "DEVICE_PLAYING",
      "DEVICE_COMPLETED",
      "DEVICE_INTERRUPTED",
      "DEVICE_ERROR",
      "PRESENTATION_STARTED",
      "PRESENTATION_COMPLETED",
      "PRESENTATION_INTERRUPTED",
      "PRESENTATION_REJECTED",
      "PRESENTATION_ERROR",
      "PRESENTATION_PERMISSION_ACCEPTED"
    ]),
    reference: z.string().min(1).max(512),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.string().min(1).max(512).nullable()
  })
  .strict();
export type EffectProgressFact = z.infer<typeof EffectProgressFactSchema>;
