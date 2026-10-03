/** Test-only host authority, not exported by the package. */
import type { JournalCommittedEnvelope } from "@companion/protocol";
import type { EffectAuthority } from "./admission.js";
import type { EffectIntentRequest, EffectIdentitySnapshot } from "./model.js";
export const fixtureIdentity: EffectIdentitySnapshot = {
  principal: { state: "UNRESOLVED", reason: "host control is not human authentication" },
  subjects: [],
  binding: { state: "UNRESOLVED", reason: "no governed Person binding" },
  audience: { kind: "UNKNOWN", reason: "no membership authority" },
  disclosurePolicy: { state: "UNRESOLVED", reason: "no disclosure-policy projection" }
};
export function effectRequest(key = "turn:42:presentation:soft-smile"): EffectIntentRequest {
  return {
    contractRef: "yuvi.embodied-presentation.v1",
    logicalKey: key,
    scope: "session:42",
    audience: fixtureIdentity.audience,
    executionId: "execution:42",
    causalRefs: [
      { kind: "JOURNAL_EVENT", namespace: "test:effects", eventId: "jev1_aaaaaaaaaaaaaaaa" }
    ],
    expiresAt: "2099-01-01T00:00:00.000Z",
    payload: {
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "EXPRESSION",
        cause: { kind: "character", reference: "character:42" },
        intent: "soft-smile"
      },
      sourceInstance: { reference: "proposal:42", createdAtMs: 1250 },
      correlation: { kind: "turn", reference: "turn:42" }
    }
  };
}
export function effectAuthority(): EffectAuthority {
  return {
    snapshot: {
      policyVersion: "runtime-effect-policy.v1",
      authorityVersion: "activity:42",
      scope: "session:42",
      identity: structuredClone(fixtureIdentity),
      permissions: ["RUNTIME_EMBODIED_PRESENTATION"],
      allowed: true
    },
    isCurrent: () => true
  };
}
export const fixtureCause = {
  journalNamespace: "test:effects",
  eventId: "jev1_aaaaaaaaaaaaaaaa",
  command: { kind: "RECEIPT" },
  authority: fixtureIdentity
} as JournalCommittedEnvelope;
export const fixtureJournal = {
  async get() {
    return fixtureCause;
  }
};
