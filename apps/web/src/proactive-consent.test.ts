import { describe, expect, it } from "vitest";
import {
  createInitialProactiveConsentState,
  reduceProactiveConsent,
  type ProactiveConsentState
} from "./proactive-consent.js";

function read(
  state: ProactiveConsentState,
  revision: number,
  enabled: boolean
): ProactiveConsentState {
  return reduceProactiveConsent(state, { type: "settings-view", revision, enabled });
}

function changed(
  state: ProactiveConsentState,
  revision: number,
  changedSections: readonly string[]
): ProactiveConsentState {
  return reduceProactiveConsent(state, { type: "settings-changed", revision, changedSections });
}

describe("proactive consent projection", () => {
  it("starts denied until an authoritative settings view succeeds", () => {
    expect(createInitialProactiveConsentState()).toEqual({
      enabled: false,
      status: "unknown-denied",
      revisionFloor: 0,
      projectedRevision: null
    });
  });

  it("projects the persisted boolean at the view revision", () => {
    const initial = createInitialProactiveConsentState();
    expect(read(initial, 1, false)).toMatchObject({
      enabled: false,
      status: "ready",
      revisionFloor: 1,
      projectedRevision: 1
    });
    expect(read(initial, 1, true)).toMatchObject({
      enabled: true,
      status: "ready",
      revisionFloor: 1,
      projectedRevision: 1
    });
  });

  it("invalidates immediately for a newer proactive settings event", () => {
    const ready = read(createInitialProactiveConsentState(), 2, true);
    const invalidated = changed(ready, 3, ["proactive"]);

    expect(invalidated).toEqual({
      enabled: false,
      status: "unknown-denied",
      revisionFloor: 3,
      projectedRevision: null
    });
  });

  it("ignores non-proactive and non-newer settings events", () => {
    const ready = read(createInitialProactiveConsentState(), 4, true);

    expect(changed(ready, 5, ["tts"])).toBe(ready);
    expect(changed(ready, 4, ["proactive"])).toBe(ready);
    expect(changed(ready, 3, ["proactive"])).toBe(ready);
  });

  it("rejects non-integer and unsafe projection revisions", () => {
    const initial = createInitialProactiveConsentState();
    expect(read(initial, 1.5, true)).toBe(initial);
    expect(read(initial, Number.MAX_SAFE_INTEGER + 1, true)).toBe(initial);
    expect(changed(initial, 1.5, ["proactive"])).toBe(initial);
    expect(changed(initial, Number.MAX_SAFE_INTEGER + 1, ["proactive"])).toBe(initial);
  });

  it("rejects a stale view after a newer event without reviving consent", () => {
    const invalidated = changed(read(createInitialProactiveConsentState(), 2, true), 5, [
      "proactive"
    ]);
    const stale = read(invalidated, 4, true);

    expect(stale).toBe(invalidated);
    expect(stale.enabled).toBe(false);
    expect(stale.revisionFloor).toBe(5);
  });

  it("keeps failed refetches denied and ignores older late responses", () => {
    const invalidated = changed(read(createInitialProactiveConsentState(), 2, true), 3, [
      "proactive"
    ]);
    const failed = reduceProactiveConsent(invalidated, {
      type: "settings-read-failed",
      requestRevision: 3
    });
    const late = read(failed, 2, true);

    expect(failed.enabled).toBe(false);
    expect(failed.status).toBe("unknown-denied");
    expect(failed.revisionFloor).toBe(3);
    expect(late).toBe(failed);
  });

  it("keeps an initial read failure fenced against an older late view", () => {
    const initial = createInitialProactiveConsentState();
    const failed = reduceProactiveConsent(initial, {
      type: "settings-read-failed",
      requestRevision: 4
    });
    const late = read(failed, 3, true);

    expect(failed).toMatchObject({
      enabled: false,
      status: "unknown-denied",
      revisionFloor: 4,
      projectedRevision: null
    });
    expect(late).toBe(failed);
  });

  it("restores the exact persisted boolean only at the current floor or newer", () => {
    const invalidated = changed(read(createInitialProactiveConsentState(), 2, true), 3, [
      "proactive"
    ]);
    const currentFalse = read(invalidated, 3, false);
    const newerTrue = read(currentFalse, 4, true);

    expect(currentFalse).toMatchObject({
      enabled: false,
      status: "ready",
      revisionFloor: 3,
      projectedRevision: 3
    });
    expect(newerTrue).toMatchObject({
      enabled: true,
      status: "ready",
      revisionFloor: 4,
      projectedRevision: 4
    });
  });

  it("does not let an older failure overwrite a newer revision floor", () => {
    const invalidated = changed(read(createInitialProactiveConsentState(), 2, true), 6, [
      "proactive"
    ]);
    const olderFailure = reduceProactiveConsent(invalidated, {
      type: "settings-read-failed",
      requestRevision: 5
    });

    expect(olderFailure).toBe(invalidated);
    expect(olderFailure.enabled).toBe(false);
    expect(olderFailure.revisionFloor).toBe(6);
  });
});
