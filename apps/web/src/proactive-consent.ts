/**
 * Fail-closed projection of the persisted proactive-text consent.
 *
 * This module contains no transport or execution behavior. A settings.changed
 * event advances the revision floor and invalidates the projection; only a
 * settings view at that floor or newer can make consent true again.
 */

export type ProactiveConsentStatus = "unknown-denied" | "ready";

export type ProactiveConsentState = {
  enabled: boolean;
  status: ProactiveConsentStatus;
  revisionFloor: number;
  projectedRevision: number | null;
};

export type ProactiveConsentAction =
  | { type: "settings-view"; revision: number; enabled: boolean }
  | { type: "settings-read-failed"; requestRevision: number }
  | {
      type: "settings-changed";
      revision: number;
      changedSections: readonly string[];
    };

export function createInitialProactiveConsentState(): ProactiveConsentState {
  return {
    enabled: false,
    status: "unknown-denied",
    revisionFloor: 0,
    projectedRevision: null
  };
}

export function reduceProactiveConsent(
  state: ProactiveConsentState,
  action: ProactiveConsentAction
): ProactiveConsentState {
  switch (action.type) {
    case "settings-view": {
      if (!isRevision(action.revision) || action.revision < state.revisionFloor) return state;
      const next: ProactiveConsentState = {
        enabled: action.enabled,
        status: "ready",
        revisionFloor: action.revision,
        projectedRevision: action.revision
      };
      return sameConsentState(state, next) ? state : next;
    }
    case "settings-read-failed": {
      if (!isRevision(action.requestRevision) || action.requestRevision < state.revisionFloor) {
        return state;
      }
      const next: ProactiveConsentState = {
        enabled: false,
        status: "unknown-denied",
        revisionFloor: Math.max(state.revisionFloor, action.requestRevision),
        projectedRevision: null
      };
      return sameConsentState(state, next) ? state : next;
    }
    case "settings-changed": {
      if (
        !isRevision(action.revision) ||
        action.revision <= state.revisionFloor ||
        !action.changedSections.includes("proactive")
      ) {
        return state;
      }
      return {
        enabled: false,
        status: "unknown-denied",
        revisionFloor: action.revision,
        projectedRevision: null
      };
    }
  }
}

function isRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameConsentState(left: ProactiveConsentState, right: ProactiveConsentState): boolean {
  return (
    left.enabled === right.enabled &&
    left.status === right.status &&
    left.revisionFloor === right.revisionFloor &&
    left.projectedRevision === right.projectedRevision
  );
}
