import { createHash } from "node:crypto";
import { z } from "zod";
import {
  JournalAuthoritySnapshotSchema,
  JournalEventRefSchema,
  CorrelatedEmbodiedBehaviorSchema
} from "@companion/protocol";

/** Static host contracts, not model/plugin-supplied delivery guarantees. */
export const EFFECT_CONTRACTS = Object.freeze({
  "yuvi.provider.v1": Object.freeze({
    owner: "PROVIDER_TASK",
    version: "v1",
    permission: "HOST_PROVIDER_INVOCATION",
    workOwner: "A9_OUTBOX",
    cancelBeforeClaim: true,
    expiry: "OWNER_REQUIRED",
    logicalKeyPolicy: "OWNER_STABLE_KEY",
    semanticPayloadPolicy: "PROVIDER_DESCRIPTOR_V1"
  }),
  "yuvi.publication.v1": Object.freeze({
    owner: "TARGET_PUBLICATION",
    version: "v1",
    permission: "HOST_TARGET_PUBLICATION",
    workOwner: "A9_OUTBOX",
    cancelBeforeClaim: true,
    expiry: "OWNER_REQUIRED",
    logicalKeyPolicy: "OWNER_STABLE_KEY",
    semanticPayloadPolicy: "PUBLICATION_DESCRIPTOR_V1"
  }),
  "yuvi.playback.v1": Object.freeze({
    owner: "CLIENT_PLAYBACK",
    version: "v1",
    permission: "HOST_PLAYBACK_PERMISSION",
    workOwner: "A9_OUTBOX",
    cancelBeforeClaim: true,
    expiry: "OWNER_REQUIRED",
    logicalKeyPolicy: "OWNER_STABLE_KEY",
    semanticPayloadPolicy: "PLAYBACK_DESCRIPTOR_V1"
  }),
  "yuvi.embodied-presentation.v1": Object.freeze({
    owner: "RUNTIME_PRESENTATION",
    version: "v1",
    permission: "RUNTIME_EMBODIED_PRESENTATION",
    workOwner: "A9_OUTBOX",
    cancelBeforeClaim: true,
    expiry: "OWNER_REQUIRED",
    logicalKeyPolicy: "OWNER_STABLE_KEY",
    semanticPayloadPolicy: "CORRELATED_EMBODIED_BEHAVIOR_V1"
  }),
  "yuvi.read-text.v1": Object.freeze({
    owner: "RUNTIME_CAPABILITY",
    version: "v1",
    permission: "RUNTIME_AUTHORIZED_PATH_READ",
    workOwner: "A9_OUTBOX",
    cancelBeforeClaim: true,
    expiry: "OWNER_REQUIRED",
    logicalKeyPolicy: "OWNER_STABLE_KEY",
    semanticPayloadPolicy: "AUTHORIZED_READ_PATH_V1"
  }),
  "yuvi.native-control.v1": Object.freeze({
    owner: "NATIVE_CONTROL",
    version: "v1",
    permission: "NATIVE_CONTROL_COMMAND",
    workOwner: "A9_OUTBOX",
    cancelBeforeClaim: true,
    expiry: "OWNER_REQUIRED",
    logicalKeyPolicy: "OWNER_STABLE_KEY",
    semanticPayloadPolicy: "NATIVE_CONTROL_COMMAND_V1"
  }),
  "yuvi.finalized-memory.v1": Object.freeze({
    owner: "FINALIZED_MEMORY",
    version: "v1",
    permission: "GROUNDED_FINALIZED_EVENT",
    workOwner: "FINALIZED_INGESTION",
    cancelBeforeClaim: false,
    expiry: "NONE",
    logicalKeyPolicy: "FINALIZED_BACKEND_KEY",
    semanticPayloadPolicy: "FROZEN_MEMORY_EVENT"
  }),
  "yuvi.dream-memory.v1": Object.freeze({
    owner: "DREAM_MEMORY",
    version: "v1",
    permission: "FROZEN_GROUNDED_DREAM_RESULT",
    workOwner: "DREAM_JOB",
    cancelBeforeClaim: false,
    expiry: "NONE",
    logicalKeyPolicy: "DREAM_CHILD_KEY",
    semanticPayloadPolicy: "FROZEN_MEMORY_EVENT"
  })
} as const);
export type EffectContractRef = keyof typeof EFFECT_CONTRACTS;
const token = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => s.trim() === s);
export const EffectIdentitySnapshotSchema = JournalAuthoritySnapshotSchema.pick({
  principal: true,
  subjects: true,
  binding: true,
  audience: true,
  disclosurePolicy: true
});
export type EffectIdentitySnapshot = z.infer<typeof EffectIdentitySnapshotSchema>;
const audience = JournalAuthoritySnapshotSchema.shape.audience;
export const EffectIntentRequestSchema = z
  .object({
    contractRef: z.enum([
      "yuvi.embodied-presentation.v1",
      "yuvi.read-text.v1",
      "yuvi.native-control.v1",
      "yuvi.provider.v1",
      "yuvi.publication.v1",
      "yuvi.playback.v1"
    ]),
    logicalKey: token,
    scope: token,
    audience,
    payload: z.unknown(),
    causalRefs: z.array(JournalEventRefSchema).min(1).max(64),
    /** Correlation only: changing an execution does not mint a new logical effect. */
    executionId: token.nullable(),
    expiresAt: z.string().datetime()
  })
  .strict();
export type EffectIntentRequest = z.infer<typeof EffectIntentRequestSchema>;
export const EffectAuthorizationSchema = z
  .object({
    policyVersion: token,
    authorityVersion: token,
    scope: token,
    identity: EffectIdentitySnapshotSchema,
    permissions: z.array(token).max(32),
    allowed: z.boolean()
  })
  .strict();
export type EffectAuthorization = z.infer<typeof EffectAuthorizationSchema>;
/** Strict validation at durable reads; mutable work fields never replace the admission decision. */
export const EffectIntentSchema = z
  .object({
    version: z.literal("effect-intent.v1"),
    intentId: z.string().regex(/^ei1_[a-f0-9]{64}$/),
    logicalKey: token,
    contractRef: EffectIntentRequestSchema.shape.contractRef,
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    request: EffectIntentRequestSchema.partial({ payload: true }),
    authorization: EffectAuthorizationSchema,
    decision: z.enum(["ADMITTED", "DENIED"]),
    reasonCode: token.nullable(),
    state: z.enum(["ADMITTED", "DENIED", "CANCELED", "EXPIRED"]),
    /** A9.2 claims this projection atomically with an attempt; admission JSON stays immutable. */
    workState: z.enum(["PENDING", "CLAIMED", "WITHHELD"]).nullable(),
    createdAt: z.string().datetime()
  })
  .strict()
  .refine(
    (v) =>
      v.logicalKey === v.request.logicalKey &&
      v.contractRef === v.request.contractRef &&
      (v.decision === "DENIED"
        ? v.state === "DENIED" &&
          v.workState === null &&
          v.reasonCode !== null &&
          !Object.hasOwn(v.request, "payload")
        : v.reasonCode === null &&
          Object.hasOwn(v.request, "payload") &&
          (v.state === "ADMITTED"
            ? v.workState === "PENDING" || v.workState === "CLAIMED" || v.workState === "WITHHELD"
            : (v.state === "CANCELED" || v.state === "EXPIRED") && v.workState === "WITHHELD"))
  );
export type EffectIntent = z.infer<typeof EffectIntentSchema>;

export class EffectIntentError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "CONFLICT"
      | "AUTHORITY_UNAVAILABLE"
      | "UNKNOWN_CAUSE"
      | "AUTHORITY_CHANGED"
      | "PERSISTENCE_FAILED"
      | "UNAVAILABLE"
      | "INTEGRITY_FAILURE",
    message: string,
    readonly causeValue?: unknown
  ) {
    super(message);
    this.name = "EffectIntentError";
  }
}

/** JSON only, finite numbers, plain data, no undefined/functions/getters/cycles. */
export function canonicalEffectJson(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function encode(v: unknown, depth = 0): string {
    if (++nodes > 32_000 || depth > 64)
      throw new EffectIntentError("INVALID_REQUEST", "Effect JSON exceeds structural bounds.");
    if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object" || !v || ancestors.has(v))
      throw new EffectIntentError(
        "INVALID_REQUEST",
        "Effect payload must be finite acyclic JSON data."
      );
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw new EffectIntentError("INVALID_REQUEST", "Effect payload must contain plain data.");
    if (Object.values(Object.getOwnPropertyDescriptors(v)).some((d) => !("value" in d)))
      throw new EffectIntentError("INVALID_REQUEST", "Effect payload must not contain accessors.");
    ancestors.add(v);
    const result = Array.isArray(v)
      ? `[${Array.from(v, (x) => encode(x, depth + 1)).join(",")}]`
      : `{${Object.keys(v)
          .sort()
          .map(
            (k) => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k], depth + 1)}`
          )
          .join(",")}}`;
    ancestors.delete(v);
    return result;
  }
  return encode(value);
}
export function effectDigest(value: unknown): string {
  return createHash("sha256").update(canonicalEffectJson(value)).digest("hex");
}
export function effectIntentId(contractRef: EffectContractRef, logicalKey: string): string {
  return `ei1_${effectDigest({ owner: EFFECT_CONTRACTS[contractRef].owner, logicalKey })}`;
}
export function freezeEffectRequest(raw: unknown): EffectIntentRequest {
  // Canonicalize first so schema access cannot invoke getters or silently strip undefined.
  const json = canonicalEffectJson(raw);
  if (Buffer.byteLength(json) > 256_000)
    throw new EffectIntentError("INVALID_REQUEST", "Effect request exceeds the retention bound.");
  const parsed = EffectIntentRequestSchema.safeParse(JSON.parse(json));
  if (!parsed.success)
    throw new EffectIntentError(
      "INVALID_REQUEST",
      "Invalid effect admission request.",
      parsed.error
    );
  if (!Object.hasOwn(parsed.data, "payload"))
    throw new EffectIntentError("INVALID_REQUEST", "Effect payload is required.");
  const descriptor = z
    .object({
      version: z.literal("outward-work-descriptor.v1"),
      operation: token,
      inputSnapshot: z
        .object({
          version: z.literal("a9-input-snapshot.v1"),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          availability: z.enum(["TRANSIENT", "RETAINED_REFERENCE"]),
          reference: token.nullable(),
          manifest: z.union([
            z.literal("A10_3_NOT_IMPLEMENTED"),
            z
              .object({
                manifestId: z.string().regex(/^cm1_[a-f0-9]{64}$/),
                exposureId: z.string().regex(/^ce1_[a-f0-9]{64}$/)
              })
              .strict()
          ])
        })
        .strict(),
      configurationRef: token,
      relatedReply: token.nullable(),
      target: z.object({ surface: token, recipient: token, generation: token }).strict().nullable(),
      routingPlan: z.array(z.object({ provider: token, model: token.nullable() }).strict()).max(32)
    })
    .strict();
  const payload = ["yuvi.provider.v1", "yuvi.publication.v1", "yuvi.playback.v1"].includes(
    parsed.data.contractRef
  )
    ? descriptor.safeParse(parsed.data.payload)
    : parsed.data.contractRef === "yuvi.embodied-presentation.v1"
      ? CorrelatedEmbodiedBehaviorSchema.safeParse(parsed.data.payload)
      : parsed.data.contractRef === "yuvi.native-control.v1"
        ? z
            .object({
              version: z.literal("native-control-command.v1"),
              family: z.enum([
                "PRODUCT_PERSON",
                "VOICE_BINDING",
                "ACOUSTIC_PROFILE",
                "P8_CORRECTION"
              ]),
              commandHandle: token,
              payloadRef: token,
              payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
              semanticDigest: z.string().regex(/^[a-f0-9]{64}$/),
              targetReference: token
            })
            .strict()
            .safeParse(parsed.data.payload)
        : z
            .object({
              path: z.string().min(1).max(4096),
              contextUse: z
                .object({
                  manifestId: z.string().regex(/^cm1_[a-f0-9]{64}$/),
                  exposureId: z.string().regex(/^ce1_[a-f0-9]{64}$/)
                })
                .strict()
                .optional()
            })
            .strict()
            .safeParse(parsed.data.payload);
  if (!payload.success)
    throw new EffectIntentError(
      "INVALID_REQUEST",
      "Invalid effect contract payload.",
      payload.error
    );
  parsed.data.payload = payload.data;
  const refs = parsed.data.causalRefs.map((ref) => canonicalEffectJson(ref));
  if (new Set(refs).size !== refs.length)
    throw new EffectIntentError("INVALID_REQUEST", "Duplicate causal references.");
  return parsed.data;
}
export function requestEffectDigest(request: EffectIntentRequest): string {
  const { executionId: _execution, logicalKey: _key, ...semantic } = request;
  if (request.contractRef === "yuvi.embodied-presentation.v1") {
    const payload = CorrelatedEmbodiedBehaviorSchema.parse(request.payload);
    const { createdAtMs: _bookkeeping, ...sourceInstance } = payload.sourceInstance;
    return effectDigest({ ...semantic, payload: { ...payload, sourceInstance } });
  }
  return effectDigest(semantic);
}

/** Read-only compatibility identity. Its work remains exclusively in the named owner. */
export type ExistingEffectIntent = {
  version: "effect-intent-compatibility.v1";
  intentId: string;
  logicalKey: string;
  contractRef: "yuvi.finalized-memory.v1" | "yuvi.dream-memory.v1";
  payloadDigest: string;
  scope: string;
  work: { owner: "FINALIZED_INGESTION" | "DREAM_JOB"; reference: string };
};
