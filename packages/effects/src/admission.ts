import {
  EFFECT_CONTRACTS,
  EffectAuthorizationSchema,
  EffectIntentError,
  canonicalEffectJson,
  effectIntentId,
  freezeEffectRequest,
  requestEffectDigest,
  type EffectAuthorization,
  type EffectIntent,
  type EffectIntentRequest
} from "./model.js";
import type { EffectIntentStore } from "./store.js";
import type { JournalEventRef, JournalCommittedEnvelope, DeepReadonly } from "@companion/protocol";
import type { PoolClient } from "pg";

export type EffectAuthority = {
  snapshot: EffectAuthorization;
  /** Host Runtime fence, never serialized or supplied through model/transport input. */
  isCurrent(): boolean;
};
export interface EffectIntentAdmissionPort {
  admit(request: EffectIntentRequest, authority: EffectAuthority): Promise<EffectIntent>;
  cancel(intentId: string): Promise<EffectIntent | null>;
  get(intentId: string): Promise<EffectIntent | null>;
  listPending(limit?: number): Promise<EffectIntent[]>;
  expire(): Promise<number>;
}
export type EffectCausalReader = {
  get(ref: JournalEventRef): Promise<DeepReadonly<JournalCommittedEnvelope> | null>;
};

/** Host-only facade: validates committed causality and current Runtime authority, then stops. */
export class HostEffectIntentAdmission implements EffectIntentAdmissionPort {
  constructor(
    private readonly store: EffectIntentStore | null,
    private readonly journal: EffectCausalReader | null,
    private readonly now: () => Date = () => new Date()
  ) {}

  async admit(raw: EffectIntentRequest, authority: EffectAuthority): Promise<EffectIntent> {
    const request = freezeEffectRequest(raw);
    const parsed = EffectAuthorizationSchema.safeParse(
      JSON.parse(canonicalEffectJson(authority.snapshot))
    );
    if (!parsed.success || typeof authority.isCurrent !== "function")
      throw new EffectIntentError("INVALID_REQUEST", "Invalid host authorization snapshot.");
    if (!this.store || !this.journal)
      throw new EffectIntentError("UNAVAILABLE", "Durable effect admission is not configured.");
    const snapshot = parsed.data;
    // Never infer causal authority from a receipt-looking reference or model metadata.
    let causalIdentityMatches = true;
    for (const ref of request.causalRefs) {
      let cause: DeepReadonly<JournalCommittedEnvelope> | null;
      try {
        cause = await this.journal.get(ref);
      } catch (e) {
        throw new EffectIntentError(
          "AUTHORITY_UNAVAILABLE",
          "Committed causal authority is unavailable.",
          e
        );
      }
      if (
        !cause ||
        cause.eventId !== ref.eventId ||
        cause.journalNamespace !== ref.namespace ||
        cause.command.kind !== "RECEIPT"
      )
        throw new EffectIntentError(
          "UNKNOWN_CAUSE",
          "Effect cause must be an exact committed receipt."
        );
      const { principal, subjects, binding, audience, disclosurePolicy } = cause.authority;
      causalIdentityMatches &&=
        canonicalEffectJson(snapshot.identity) ===
        canonicalEffectJson({ principal, subjects, binding, audience, disclosurePolicy });
    }
    let reason: string | null = null;
    if (!causalIdentityMatches) reason = "CAUSAL_IDENTITY_MISMATCH";
    else if (snapshot.scope !== request.scope) reason = "SCOPE_DENIED";
    else if (
      canonicalEffectJson(snapshot.identity.audience) !== canonicalEffectJson(request.audience)
    )
      reason = "AUDIENCE_DENIED";
    else if (
      !snapshot.allowed ||
      !snapshot.permissions.includes(EFFECT_CONTRACTS[request.contractRef].permission)
    )
      reason = "PERMISSION_DENIED";
    else if (authority.isCurrent() !== true) reason = "STALE_AUTHORITY";
    else if (Date.parse(request.expiresAt) <= this.now().getTime()) reason = "EXPIRED_AT_ADMISSION";
    const { payload, ...safeRequest } = request;
    const value: EffectIntent = {
      version: "effect-intent.v1",
      intentId: effectIntentId(request.contractRef, request.logicalKey),
      logicalKey: request.logicalKey,
      contractRef: request.contractRef,
      payloadDigest: requestEffectDigest(request),
      request: reason ? safeRequest : { ...safeRequest, payload },
      authorization: snapshot,
      decision: reason ? "DENIED" : "ADMITTED",
      reasonCode: reason,
      state: reason ? "DENIED" : "ADMITTED",
      workState: reason ? null : "PENDING",
      createdAt: this.now().toISOString()
    };
    // Rechecked inside the transaction immediately before COMMIT submission.
    // This is admission-boundary authority, never future dispatch-time authorization.
    return this.store.decide(
      value,
      reason
        ? undefined
        : () => {
            if (authority.isCurrent() !== true)
              throw new EffectIntentError(
                "AUTHORITY_CHANGED",
                "Runtime authority changed before commit."
              );
            if (Date.parse(request.expiresAt) <= this.now().getTime())
              throw new EffectIntentError("AUTHORITY_CHANGED", "Intent expired before commit.");
          }
    );
  }
  /** Admit a command whose exact CONTROL receipt is staged on the same owner transaction. */
  async admitWithExactReceiptInTransaction(
    raw: EffectIntentRequest,
    authority: EffectAuthority,
    receipt: DeepReadonly<JournalCommittedEnvelope>,
    client: PoolClient
  ): Promise<EffectIntent> {
    const request = freezeEffectRequest(raw);
    const parsed = EffectAuthorizationSchema.safeParse(
      JSON.parse(canonicalEffectJson(authority.snapshot))
    );
    if (!parsed.success || typeof authority.isCurrent !== "function")
      throw new EffectIntentError("INVALID_REQUEST", "Invalid host authorization snapshot.");
    if (!this.store?.decideInTransaction)
      throw new EffectIntentError("UNAVAILABLE", "Transactional effect admission is unavailable.");
    if (
      request.causalRefs.length !== 1 ||
      request.causalRefs[0]!.eventId !== receipt.eventId ||
      request.causalRefs[0]!.namespace !== receipt.journalNamespace ||
      request.causalRefs[0]!.kind !== "JOURNAL_EVENT" ||
      receipt.command.kind !== "RECEIPT"
    )
      throw new EffectIntentError("UNKNOWN_CAUSE", "The staged CONTROL receipt does not match the effect cause.");
    const { principal, subjects, binding, audience, disclosurePolicy } = receipt.authority;
    const identityMatches = canonicalEffectJson(parsed.data.identity) === canonicalEffectJson({
      principal,
      subjects,
      binding,
      audience,
      disclosurePolicy
    });
    const reason = !identityMatches
      ? "CAUSAL_IDENTITY_MISMATCH"
      : parsed.data.scope !== request.scope
        ? "SCOPE_DENIED"
        : canonicalEffectJson(parsed.data.identity.audience) !== canonicalEffectJson(request.audience)
          ? "AUDIENCE_DENIED"
          : !parsed.data.allowed || !parsed.data.permissions.includes(EFFECT_CONTRACTS[request.contractRef].permission)
            ? "PERMISSION_DENIED"
            : authority.isCurrent() !== true
              ? "STALE_AUTHORITY"
              : Date.parse(request.expiresAt) <= this.now().getTime()
                ? "EXPIRED_AT_ADMISSION"
                : null;
    const { payload, ...safeRequest } = request;
    const value: EffectIntent = {
      version: "effect-intent.v1",
      intentId: effectIntentId(request.contractRef, request.logicalKey),
      logicalKey: request.logicalKey,
      contractRef: request.contractRef,
      payloadDigest: requestEffectDigest(request),
      request: reason ? safeRequest : { ...safeRequest, payload },
      authorization: parsed.data,
      decision: reason ? "DENIED" : "ADMITTED",
      reasonCode: reason,
      state: reason ? "DENIED" : "ADMITTED",
      workState: reason ? null : "PENDING",
      createdAt: this.now().toISOString()
    };
    return this.store.decideInTransaction(
      client,
      value,
      reason
        ? undefined
        : () => {
            if (authority.isCurrent() !== true)
              throw new EffectIntentError("AUTHORITY_CHANGED", "Runtime authority changed before COMMIT.");
            if (Date.parse(request.expiresAt) <= this.now().getTime())
              throw new EffectIntentError("AUTHORITY_CHANGED", "Intent expired before COMMIT.");
          }
    );
  }
  cancel(id: string) {
    return this.requireStore().cancel(id);
  }
  get(id: string) {
    return this.requireStore().get(id);
  }
  listPending(limit = 100) {
    return this.requireStore().listPending(limit);
  }
  expire() {
    return this.requireStore().expire();
  }
  private requireStore() {
    if (!this.store)
      throw new EffectIntentError("UNAVAILABLE", "Durable effect admission is not configured.");
    return this.store;
  }
}
