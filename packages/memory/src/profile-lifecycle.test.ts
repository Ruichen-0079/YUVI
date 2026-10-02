import { describe, expect, it, vi } from "vitest";
import { MemoryLineageV1Schema, type GroundedMemoryLineageV1 } from "./lineage.js";
import { canonicalLineageJson, lineageDigest } from "./lineage-encoding.js";
import {
  canonicalizeGroundedLineage,
  materializeProfileSnapshot,
  rootsForLineage
} from "./profile-materializer.js";
import { InMemoryProfileSnapshotStore } from "./profile-snapshot-store.js";
import { LocalProfileProvider } from "./profile-provider.js";
import {
  ProfileEvidenceSourceV1Schema,
  type ProfileEvidenceSourceV1,
  type ProfileSourceReadOutcome,
  type ProfileSubjectV1
} from "./profile-types.js";
import {
  InMemoryProfileLifecycleStore,
  profileLifecycleStatus,
  type ProfileLifecycleClaim,
  type ProfileLifecycleStore
} from "./profile-lifecycle-store.js";
import {
  digestCompleteRead,
  ProfileLifecycleCoordinator,
  type CapturedProfileComposition
} from "./profile-lifecycle.js";
import { InMemoryMemoryRepository, type ProfileMutationNotifier } from "./repository.js";
import { buildMemoryScope } from "./scope.js";

const scope = buildMemoryScope("f2-test-user", "f2-test-persona");
const subject: ProfileSubjectV1 = { kind: "MEMORY_SCOPE", scope };
const recordedAt = "2026-10-02T00:00:00.000Z";
const authority = {
  principal: { state: "UNRESOLVED" as const, reason: "test scope has no principal authority" },
  binding: { state: "UNRESOLVED" as const, reason: "test scope has no Person binding" },
  audience: { kind: "UNKNOWN" as const, reason: "test scope has no audience authority" }
};

function lineage(index: number): GroundedMemoryLineageV1 {
  const ref = {
    kind: "JOURNAL_EVENT" as const,
    namespace: "profile-lifecycle-test",
    eventId: "jev1_" + index.toString(16).padStart(16, "0")
  };
  const parsed = MemoryLineageV1Schema.parse({
    version: "memory-lineage.v1",
    state: "GROUNDED",
    origin: "USER_ASSERTION",
    parents: [
      {
        ref,
        selector: {
          version: "source-selector.v1",
          modality: "TEXT",
          payload: { namespace: ref.namespace, payloadId: "payload-" + index, version: "v1" },
          range: { unit: "UNICODE_CODE_POINT", start: 0, end: 1 }
        }
      }
    ],
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey: "f2-consumer-" + index,
    derivation: {
      kind: "RULE_BASED_EXTRACTION",
      producer: "f2-test",
      producerVersion: "1",
      policyVersion: "test.v1"
    },
    authority,
    sourceTime: { recordedAt, occurrenceTime: { state: "UNKNOWN" } }
  });
  if (parsed.state !== "GROUNDED") throw new Error("Test lineage did not parse as grounded.");
  return parsed as GroundedMemoryLineageV1;
}

function source(
  index: number,
  content = "profile evidence " + index,
  validUntil: string | null = null
): ProfileEvidenceSourceV1 {
  const id = "00000000-0000-4000-8000-" + index.toString(16).padStart(12, "0");
  const normalized = canonicalizeGroundedLineage(lineage(index));
  return ProfileEvidenceSourceV1Schema.parse({
    version: "yuvi-profile-evidence-source.v1",
    memory: { memoryId: "legacy:" + id, backend: "legacy", sourceRecordId: id },
    scope,
    nativeScope: { kind: "user", scopeId: null },
    kind: "fact",
    subtype: null,
    content,
    claimClass: null,
    lineage: normalized,
    lineageDigest: lineageDigest(canonicalLineageJson(normalized)),
    lifecycle: {
      state: "ACTIVE",
      coverage: "NATIVE",
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil,
      expiresAt: null
    },
    relationships: { coverage: "NATIVE", supersedes: [], supersededBy: null, contradicts: [] },
    roots: rootsForLineage(normalized)
  });
}

function readOutcome(
  sources: ProfileEvidenceSourceV1[],
  asOf: string,
  state: ProfileSourceReadOutcome["state"] = "COMPLETE"
): ProfileSourceReadOutcome {
  const excludedCounts = {
    LEGACY_INCOMPLETE: 0,
    NON_EVIDENCE: 0,
    PAYLOAD_UNAVAILABLE: 0,
    UNSUPPORTED_ORIGIN: 0,
    UNSUPPORTED_DERIVATION: 0,
    UNSUPPORTED_SELECTOR: 0,
    INACTIVE: 0,
    SUPERSEDED: 0,
    NOT_YET_VALID: 0,
    EXPIRED: 0,
    ROOT_RETIRED: 0
  };
  return {
    state,
    backend: "legacy",
    sources: structuredClone(sources),
    reasons:
      state === "COMPLETE"
        ? []
        : state === "PARTIAL"
          ? ["ROW_BOUND"]
          : state === "UNAVAILABLE"
            ? ["BACKEND_UNAVAILABLE"]
            : ["BACKEND_ERROR"],
    diagnostics: {
      asOf,
      scannedCount: sources.length,
      eligibleCount: sources.length,
      excludedCounts,
      exhausted: state === "COMPLETE"
    }
  };
}

type Harness = {
  now: { value: Date };
  lifecycle: InMemoryProfileLifecycleStore;
  snapshots: InMemoryProfileSnapshotStore;
  provider: LocalProfileProvider;
  reader: {
    listEligibleSources(input: {
      subject: ProfileSubjectV1;
      asOf: string;
      signal?: AbortSignal;
    }): Promise<ProfileSourceReadOutcome>;
  };
  coordinator: ProfileLifecycleCoordinator;
  read: (input: {
    subject: ProfileSubjectV1;
    asOf: string;
    signal?: AbortSignal;
  }) => Promise<ProfileSourceReadOutcome>;
  setRead(fn: Harness["read"]): void;
};

function harness(initialSources: ProfileEvidenceSourceV1[] = [source(1)]): Harness {
  const now = { value: new Date(1_000) };
  const lifecycle = new InMemoryProfileLifecycleStore(() => new Date(now.value));
  const snapshots = new InMemoryProfileSnapshotStore();
  let read: Harness["read"] = async ({ asOf }) => readOutcome(initialSources, asOf);
  const reader = {
    listEligibleSources: (input: {
      subject: ProfileSubjectV1;
      asOf: string;
      signal?: AbortSignal;
    }) => read(input)
  };
  const provider = new LocalProfileProvider({
    resolveSourceReader: () => reader,
    store: snapshots,
    now: () => new Date(now.value)
  });
  const composition: CapturedProfileComposition = {
    reader,
    provider,
    backend: "legacy",
    compositionToken: {}
  };
  const coordinator = new ProfileLifecycleCoordinator(
    lifecycle,
    undefined,
    composition,
    () => new Date(now.value)
  );
  return {
    now,
    lifecycle,
    snapshots,
    provider,
    reader,
    coordinator,
    read: (input) => read(input),
    setRead(fn) {
      read = fn;
    }
  };
}

async function runCycle(h: Harness): Promise<void> {
  const row = (await h.lifecycle.get(subject)) ?? (await h.lifecycle.enroll(subject));
  if (row.nextAttemptAt && Date.parse(row.nextAttemptAt) > h.now.value.getTime())
    h.now.value = new Date(row.nextAttemptAt);
  await (h.coordinator as unknown as { runTick(): Promise<void> }).runTick();
}

async function seedCandidate(
  h: Harness,
  selectedSource = source(1)
): Promise<{ revision: string; digest: string }> {
  await h.lifecycle.enroll(subject);
  h.setRead(async ({ asOf }) => readOutcome([selectedSource], asOf));
  const generated = await h.provider.generate({ subject });
  if (!generated.snapshot || !generated.sourceRead || generated.sourceRead.state !== "COMPLETE")
    throw new Error("Candidate fixture generation failed.");
  const row = await h.lifecycle.get(subject);
  if (!row?.nextAttemptAt) throw new Error("Candidate fixture was not due.");
  h.now.value = new Date(row.nextAttemptAt);
  const claim = await h.lifecycle.claimDue();
  if (!claim) throw new Error("Candidate fixture claim failed.");
  const digest = digestCompleteRead(generated.sourceRead);
  if (
    !(await h.lifecycle.selectCandidate(claim, {
      revision: generated.snapshot.profileRevision,
      digest,
      backend: "legacy",
      asOf: generated.sourceRead.diagnostics.asOf
    }))
  )
    throw new Error("Candidate fixture selection failed.");
  return { revision: generated.snapshot.profileRevision, digest };
}

function wrapStore(
  base: ProfileLifecycleStore,
  override: Partial<ProfileLifecycleStore>
): ProfileLifecycleStore {
  return new Proxy(base, {
    get(target, property) {
      const overridden = (override as Record<PropertyKey, unknown>)[property];
      if (overridden !== undefined) return overridden;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as ProfileLifecycleStore;
}

describe("A10.1f2 fenced Profile lifecycle", () => {
  it("rejects S1 pre-read, S2 generation read, S2 post-read", async () => {
    const h = harness();
    const a = source(1),
      b = source(2);
    let count = 0;
    h.setRead(async ({ asOf }) => readOutcome(count++ === 0 ? [a] : [b], asOf));
    await h.lifecycle.enroll(subject);
    await runCycle(h);
    const row = await h.lifecycle.get(subject);
    expect(row?.candidateRevision).toBeNull();
    expect(row?.regenerationNeeded).toBe(true);
  });

  it("rejects S2 invalidation after post-read and before exact candidate CAS", async () => {
    const h = harness();
    const intercepted = wrapStore(h.lifecycle, {
      selectCandidate: async (
        claim: ProfileLifecycleClaim,
        candidate: Parameters<ProfileLifecycleStore["selectCandidate"]>[1]
      ) => {
        await h.lifecycle.requestGeneration(subject, "MEMORY_CHANGED");
        return h.lifecycle.selectCandidate(claim, candidate);
      }
    });
    const composition: CapturedProfileComposition = {
      reader: h.reader,
      provider: h.provider,
      backend: "legacy",
      compositionToken: {}
    };
    const coordinator = new ProfileLifecycleCoordinator(
      intercepted,
      undefined,
      composition,
      () => new Date(h.now.value)
    );
    await h.lifecycle.enroll(subject);
    h.coordinator = coordinator;
    await runCycle(h);
    const row = await h.lifecycle.get(subject);
    expect(row?.controlVersion).toBe("1");
    expect(row?.candidateRevision).toBeNull();
    expect(row?.regenerationNeeded).toBe(true);
  });

  it("withholds an unnotified source change after candidate selection", async () => {
    const h = harness();
    const candidate = await seedCandidate(h, source(1));
    h.setRead(async ({ asOf }) => readOutcome([source(2)], asOf));
    const outcome = await h.coordinator.readScopeModel({ subject, readMemory: true });
    expect(outcome.state).toBe("WITHHELD");
    expect(outcome.model).toBeNull();
    expect((await h.lifecycle.get(subject))?.candidateRevision).toBe(candidate.revision);
  });

  it("withholds a live read when a mutation lands before the final control reread", async () => {
    const h = harness();
    await seedCandidate(h, source(1));
    let changed = false;
    h.setRead(async ({ asOf }) => {
      if (!changed) {
        changed = true;
        await h.lifecycle.invalidateScope(scope, "MEMORY_CHANGED");
      }
      return readOutcome([source(1)], asOf);
    });
    const outcome = await h.coordinator.readScopeModel({ subject, readMemory: true });
    expect(outcome.state).toBe("WITHHELD");
    expect(outcome.model).toBeNull();
  });

  it("coalesces two invalidations during RUNNING without losing the newest version", async () => {
    const h = harness();
    const a = source(1);
    let count = 0;
    h.setRead(async ({ asOf }) => {
      if (count++ === 1) {
        await h.lifecycle.invalidateScope(scope, "MEMORY_CHANGED");
        await h.lifecycle.invalidateScope(scope, "MEMORY_WITHDRAWN");
        const obsolete = await h.lifecycle.get(subject);
        if (obsolete)
          expect(profileLifecycleStatus(obsolete, h.now.value).workState).toBe("WAITING");
      }
      return readOutcome([a], asOf);
    });
    await h.lifecycle.enroll(subject);
    await runCycle(h);
    const row = await h.lifecycle.get(subject);
    expect(row?.controlVersion).toBe("2");
    expect(row?.regenerationNeeded).toBe(true);
    expect(row?.candidateRevision).toBeNull();
    expect(row?.leaseOwner).toBeNull();
  });

  it("reclaims an expired lease with a new fence and ignores its late owner", async () => {
    const h = harness();
    const selected = await h.provider.generate({ subject });
    if (!selected.snapshot || !selected.sourceRead) throw new Error("Fixture generation failed.");
    await h.lifecycle.enroll(subject);
    const row = (await h.lifecycle.get(subject))!;
    h.now.value = new Date(row.nextAttemptAt!);
    const first = await h.lifecycle.claimDue();
    if (!first) throw new Error("First claim failed.");
    h.now.value = new Date(h.now.value.getTime() + 90_001);
    const second = await h.lifecycle.claimDue();
    if (!second) throw new Error("Expired lease was not reclaimed.");
    expect(second.fence).not.toBe(first.fence);
    const digest = digestCompleteRead(selected.sourceRead);
    expect(await h.lifecycle.renew(first)).toBe(false);
    expect(
      await h.lifecycle.selectCandidate(first, {
        revision: selected.snapshot.profileRevision,
        digest,
        backend: "legacy",
        asOf: selected.sourceRead.diagnostics.asOf
      })
    ).toBe(false);
    expect(
      await h.lifecycle.selectCandidate(second, {
        revision: selected.snapshot.profileRevision,
        digest,
        backend: "legacy",
        asOf: selected.sourceRead.diagnostics.asOf
      })
    ).toBe(true);
  });

  it("stops publication after a lost heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let releaseRead!: () => void;
      let entered!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      h.setRead(
        ({ signal }) =>
          new Promise<ProfileSourceReadOutcome>((_resolve, reject) => {
            releaseRead = () => reject(new Error("cancelled read"));
            signal?.addEventListener("abort", releaseRead, { once: true });
            entered();
          })
      );
      const store = wrapStore(h.lifecycle, { renew: async () => false });
      const coordinator = new ProfileLifecycleCoordinator(
        store,
        undefined,
        { reader: h.reader, provider: h.provider, backend: "legacy", compositionToken: {} },
        () => new Date(h.now.value)
      );
      const enrolled = await h.lifecycle.enroll(subject);
      h.now.value = new Date(enrolled.nextAttemptAt!);
      const task = (coordinator as unknown as { runTick(): Promise<void> }).runTick();
      await reading;
      await vi.advanceTimersByTimeAsync(15_000);
      await task;
      const row = await h.lifecycle.get(subject);
      expect(row?.candidateRevision).toBeNull();
      expect(row?.leaseOwner).toBeNull();
      expect(row?.lastError).toBe("FENCE_LOST");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an immutable f1 put as history when lifecycle selection fails", async () => {
    const h = harness();
    const store = wrapStore(h.lifecycle, {
      selectCandidate: async () => {
        throw new Error("simulated lifecycle database failure");
      }
    });
    const coordinator = new ProfileLifecycleCoordinator(
      store,
      undefined,
      { reader: h.reader, provider: h.provider, backend: "legacy", compositionToken: {} },
      () => new Date(h.now.value)
    );
    const enrolled = await h.lifecycle.enroll(subject);
    h.now.value = new Date(enrolled.nextAttemptAt!);
    h.coordinator = coordinator;
    await runCycle(h);
    expect((await h.snapshots.getCurrent({ subject }))?.profileRevision).toMatch(/^pf1_/u);
    const row = await h.lifecycle.get(subject);
    expect(row?.candidateRevision).toBeNull();
    expect(row?.regenerationNeeded).toBe(true);
  });

  it("replays A after A to B to A under the newest lifecycle version", async () => {
    const h = harness();
    let current = [source(1)];
    h.setRead(async ({ asOf }) => readOutcome(current, asOf));
    await h.lifecycle.enroll(subject);
    await runCycle(h);
    const revisionA = (await h.lifecycle.get(subject))?.candidateRevision;
    await h.lifecycle.invalidateScope(scope, "MEMORY_CHANGED");
    current = [source(2)];
    await runCycle(h);
    const revisionB = (await h.lifecycle.get(subject))?.candidateRevision;
    expect(revisionB).not.toBe(revisionA);
    await h.lifecycle.invalidateScope(scope, "MEMORY_CHANGED");
    current = [source(1)];
    await runCycle(h);
    const row = await h.lifecycle.get(subject);
    expect(row?.candidateRevision).toBe(revisionA);
    expect(row?.candidateVersion).toBe("2");
    expect(row?.controlVersion).toBe("2");
  });

  it("does not treat a racing low-level f1 current pointer as the f2 candidate", async () => {
    const h = harness();
    const candidate = await seedCandidate(h, source(1));
    h.setRead(async ({ asOf }) => readOutcome([source(2)], asOf));
    const raced = await h.provider.generate({ subject });
    expect(raced.snapshot?.profileRevision).not.toBe(candidate.revision);
    const outcome = await h.coordinator.readScopeModel({ subject, readMemory: true });
    expect(outcome.model).toBeNull();
    expect(outcome.state).toBe("WITHHELD");
    expect((await h.snapshots.getCurrent({ subject }))?.profileRevision).toBe(
      raced.snapshot?.profileRevision
    );
  });

  it.each(["PARTIAL", "UNAVAILABLE", "ERROR"] as const)(
    "never exposes the prior candidate after source %s",
    async (state) => {
      const h = harness();
      await seedCandidate(h, source(1));
      h.setRead(async ({ asOf }) => readOutcome([source(1)], asOf, state));
      const outcome = await h.coordinator.readScopeModel({ subject, readMemory: true });
      expect(outcome.model).toBeNull();
      expect(["PARTIAL", "UNAVAILABLE", "FAILED"]).toContain(outcome.state);
    }
  );

  it("blocks immediately when the source backend cannot prove complete enumeration", async () => {
    const h = harness();
    h.setRead(async ({ asOf }) => ({
      ...readOutcome([], asOf, "UNAVAILABLE"),
      reasons: ["ENUMERATION_UNSUPPORTED"]
    }));
    await h.lifecycle.enroll(subject);
    await runCycle(h);
    expect(await h.lifecycle.get(subject)).toMatchObject({
      lastError: "SOURCE_AUTHORITY_UNSUPPORTED",
      nextAttemptAt: null,
      regenerationNeeded: true
    });
  });

  it("withholds when an eligible source expires before response assembly", async () => {
    const expiry = "2026-10-02T00:00:00.500Z";
    const item = source(3, "short-lived evidence", expiry);
    const h = harness([item]);
    h.now.value = new Date("2026-10-02T00:00:00.000Z");
    const candidate = await seedCandidate(h, item);
    h.setRead(async ({ asOf }) => {
      h.now.value = new Date("2026-10-02T00:00:00.600Z");
      return readOutcome([item], asOf);
    });
    const outcome = await h.coordinator.readScopeModel({ subject, readMemory: true });
    expect(candidate.revision).toMatch(/^pf1_/u);
    expect(outcome.state).toBe("WITHHELD");
    expect(outcome.model).toBeNull();
  });

  it("preserves a grounded Memory admission when lifecycle notification fails", async () => {
    const repository = new InMemoryMemoryRepository();
    repository.setProfileMutationNotifier(async () => {
      throw new Error("offline lifecycle store");
    });
    const result = await repository.createGroundedMemory!({
      memory: {
        type: "semantic",
        content: "persisted grounded evidence",
        source: "f2-test",
        subjectUserId: "f2-test-user",
        personaId: "f2-test-persona"
      },
      lineage: lineage(45),
      payloadDigest: "a".repeat(64)
    });
    expect(result.inserted).toBe(true);
    expect(await repository.getMemoryById(result.memory.id)).not.toBeNull();
    expect(repository.getProfileMutationDiagnostics?.().notificationFailureCount).toBe(1);
  });

  it("invalidates both partitions for moves and tracks restore, archive, and physical delete", async () => {
    const repository = new InMemoryMemoryRepository();
    const notices: Array<{ scope: string; reason: string }> = [];
    repository.setProfileMutationNotifier(async (notice) => {
      notices.push(notice);
    });
    const admitted = await repository.createGroundedMemory!({
      memory: {
        type: "semantic",
        content: "move and lifecycle hook",
        source: "f2-test",
        subjectUserId: "f2-test-user",
        personaId: "f2-test-persona"
      },
      lineage: lineage(46),
      payloadDigest: "b".repeat(64)
    });
    await repository.updateMemory(admitted.memory.id, { subjectUserId: "f2-moved-user" });
    await repository.updateMemory(admitted.memory.id, { status: "archived" });
    await repository.updateMemory(admitted.memory.id, { status: "active" });
    await repository.deleteMemory(admitted.memory.id);
    expect(notices).toEqual([
      { scope, reason: "MEMORY_ADMITTED" },
      { scope, reason: "MEMORY_WITHDRAWN" },
      { scope: buildMemoryScope("f2-moved-user", "f2-test-persona"), reason: "MEMORY_WITHDRAWN" },
      { scope: buildMemoryScope("f2-moved-user", "f2-test-persona"), reason: "MEMORY_WITHDRAWN" },
      { scope: buildMemoryScope("f2-moved-user", "f2-test-persona"), reason: "MEMORY_CHANGED" },
      { scope: buildMemoryScope("f2-moved-user", "f2-test-persona"), reason: "MEMORY_WITHDRAWN" }
    ]);
  });

  it("never restores a VERIFIED status after startup recheck", async () => {
    const h = harness();
    await seedCandidate(h, source(1));
    const before = await h.coordinator.readScopeModel({ subject, readMemory: true });
    expect(before.state).toBe("AVAILABLE");
    if (before.state !== "AVAILABLE") throw new Error("Expected live verified model.");
    expect(before.status.evidenceState).toBe("VERIFIED");
    await h.lifecycle.startupRecheckBatch(null, 100);
    const after = await h.lifecycle.get(subject);
    expect(after?.controlVersion).toBe("1");
    expect(after?.regenerationNeeded).toBe(true);
  });

  it("fences an old captured reader and provider after composition replacement", async () => {
    const h = harness();
    let rejectRead!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.setRead(
      ({ signal }) =>
        new Promise<ProfileSourceReadOutcome>((_resolve, reject) => {
          rejectRead = () => reject(new Error("old read cancelled"));
          signal?.addEventListener("abort", rejectRead, { once: true });
          entered();
        })
    );
    const row = await h.lifecycle.enroll(subject);
    h.now.value = new Date(row.nextAttemptAt!);
    const task = (h.coordinator as unknown as { runTick(): Promise<void> }).runTick();
    await reading;
    const replacement: CapturedProfileComposition = {
      reader: h.reader,
      provider: h.provider,
      backend: "legacy",
      compositionToken: {}
    };
    await h.coordinator.replaceComposition(replacement);
    await task;
    expect((await h.lifecycle.get(subject))?.candidateRevision).toBeNull();
  });

  it("fails closed for a Person-only model request without inferring a scope", () => {
    const h = harness();
    expect(h.coordinator.readPersonModel()).toEqual({
      state: "UNAVAILABLE",
      model: null,
      code: "BINDING_AUTHORITY_UNAVAILABLE"
    });
  });

  it("skips source reads entirely when readMemory is false", async () => {
    const h = harness();
    let calls = 0;
    h.setRead(async ({ asOf }) => {
      calls += 1;
      return readOutcome([source(1)], asOf);
    });
    const outcome = await h.coordinator.readScopeModel({ subject, readMemory: false });
    expect(outcome.state).toBe("UNAVAILABLE");
    if (outcome.state !== "UNAVAILABLE") throw new Error("Expected unavailable scope model.");
    expect(outcome.code).toBe("MEMORY_DISABLED");
    expect(calls).toBe(0);
  });
});
