import { FinalizedIngestionService } from "./finalized-test-fixture.js";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryFinalizedIngestionRepository,
  PostgresFinalizedIngestionRepository,
  type FinalizedIngestionEvent,
  type FinalizedIngestionEventOutcome
} from "./finalized-ingestion-ledger.js";
import { MemoryIngestionCoordinator } from "./memory-ingestion-coordinator.js";
import type { MemoryProvider, MemoryReconciliationResult } from "./provider.js";

const base = {
  assistantMessageId: "assistant:coordinator",
  sourceUserEventId: "user:coordinator",
  conversationId: "conversation:coordinator",
  traceId: "trace:coordinator",
  personaId: "alice",
  subjectUserId: "user-a",
  finalizedAt: "2026-08-12T00:00:00.000Z",
  ingestionRequested: true,
  userMessage: "I prefer concise replies.",
  assistantMessage: "Understood."
};

function createProvider(overrides: Partial<MemoryProvider> = {}): MemoryProvider & {
  writes: Array<Record<string, unknown>>;
  reconciles: Array<Record<string, unknown>>;
} {
  const writes: Array<Record<string, unknown>> = [];
  const reconciles: Array<Record<string, unknown>> = [];
  return {
    writes,
    reconciles,
    retrieveRelevant: vi.fn(async () => ({
      status: "empty" as const,
      events: [],
      source: "test",
      limited: false
    })),
    getEvent: vi.fn(async () => null),
    writeEvent: vi.fn(async () => ({ status: "rejected" as const })),
    writeEventIdempotent: vi.fn(async (input) => {
      writes.push(input);
      return { status: "written" as const, eventId: `memory:${writes.length}` };
    }),
    reconcileEvent: vi.fn(async (input) => {
      reconciles.push(input);
      return { status: "unknown" as const };
    }),
    ...overrides
  };
}

async function admitTurn(
  repository = new InMemoryFinalizedIngestionRepository(),
  finalizedTurnId = "finalized-turn:coordinator",
  policy?: ConstructorParameters<typeof FinalizedIngestionService>[1]
) {
  const service = new FinalizedIngestionService(repository, policy);
  const admitted = await service.admit({ ...base, finalizedTurnId });
  return { repository, service, admitted };
}

function coordinatorOf(
  repository: InMemoryFinalizedIngestionRepository | PostgresFinalizedIngestionRepository,
  provider: MemoryProvider,
  overrides: Omit<
    Partial<ConstructorParameters<typeof MemoryIngestionCoordinator>[0]>,
    "repository" | "provider"
  > = {}
) {
  return new MemoryIngestionCoordinator({
    repository,
    provider,
    ownerId: overrides.ownerId ?? "coordinator-a",
    pollIntervalMs: overrides.pollIntervalMs ?? 60_000,
    concurrency: overrides.concurrency ?? 2,
    leaseSeconds: overrides.leaseSeconds ?? 30,
    retryPolicy: overrides.retryPolicy ?? {
      initialDelayMs: 60_000,
      maxDelayMs: 60_000,
      multiplier: 1
    },
    ...overrides
  });
}

async function forceOutcome(
  repository: InMemoryFinalizedIngestionRepository,
  event: FinalizedIngestionEvent,
  outcome: FinalizedIngestionEventOutcome,
  leaseOwner = "fixture"
): Promise<FinalizedIngestionEvent> {
  const claimed = await repository.claimEvent({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner,
    leaseSeconds: 30,
    expectedVersion: event.version
  });
  if (!claimed) throw new Error(`Could not claim ${event.eventId}.`);
  const dispatching = await repository.markEventDispatchStarted({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner,
    expectedVersion: claimed.version
  });
  if (!dispatching) throw new Error(`Could not mark ${event.eventId}.`);
  return repository.recordEventOutcome({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner,
    expectedVersion: dispatching.version,
    outcome
  });
}

describe("MemoryIngestionCoordinator", () => {
  it("finds pending work, executes once through the shared engine, and completes", async () => {
    const { repository, admitted } = await admitTurn();
    const provider = createProvider();
    const coordinator = coordinatorOf(repository, provider);
    await coordinator.notifyAdmitted(admitted);
    expect(provider.writes).toHaveLength(0);
    await coordinator.drain(1_000);
    const event = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(event.status).toBe("complete");
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]).toMatchObject({
      idempotencyKey: event.backendIdempotencyKey,
      payloadDigest: event.eventPayload.payloadDigest
    });
    expect(event.attemptCount).toBe(1);
  });

  it("wakes immediately instead of waiting for the next poll", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const provider = createProvider();
    const coordinator = coordinatorOf(repository, provider, {
      pollIntervalMs: 60_000
    });
    coordinator.start();
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:wake",
      assistantMessageId: "assistant:wake"
    });
    const pending = await Promise.race([
      coordinator.notifyAdmitted(admitted).then(() => "notified"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50))
    ]);
    expect(pending).toBe("notified");
    await coordinator.drain(1_000);
    expect(provider.writes).toHaveLength(1);
    await coordinator.shutdown();
  });

  it("recovers persisted pending work on a startup scan after restart", async () => {
    const { repository, admitted } = await admitTurn();
    expect(admitted.events[0]?.status).toBe("pending");
    const provider = createProvider();
    const restarted = coordinatorOf(repository, provider, { ownerId: "coordinator-restart" });
    restarted.start();
    await restarted.drain(1_000);
    expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.status).toBe(
      "complete"
    );
    expect(provider.writes).toHaveLength(1);
    await restarted.shutdown();
  });

  it("skips retryable work that is not due and executes it when due", async () => {
    const { repository, admitted } = await admitTurn();
    await forceOutcome(repository, admitted.events[0]!, {
      status: "retryable_failed",
      errorCode: "MEMORY_WRITE_RETRYABLE_FAILED",
      nextAttemptAt: "2099-01-01T00:00:00.000Z"
    });
    const provider = createProvider();
    const coordinator = coordinatorOf(repository, provider);
    await coordinator.notifyAdmitted({
      turn: (await repository.getTurn(admitted.turn.finalizedTurnId))!,
      events: await repository.listEvents(admitted.turn.finalizedTurnId)
    });
    await coordinator.drain(1_000);
    expect(provider.writes).toHaveLength(0);
    expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.status).toBe(
      "retryable_failed"
    );

    const dueRepo = new InMemoryFinalizedIngestionRepository();
    const dueAdmitted = await new FinalizedIngestionService(dueRepo).admit({
      ...base,
      finalizedTurnId: "finalized-turn:due-retry"
    });
    await forceOutcome(dueRepo, dueAdmitted.events[0]!, {
      status: "retryable_failed",
      errorCode: "MEMORY_WRITE_RETRYABLE_FAILED",
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString()
    });
    const due = coordinatorOf(dueRepo, provider, { ownerId: "coordinator-due" });
    await due.drain(1_000);
    expect(provider.writes).toHaveLength(1);
    expect((await dueRepo.listEvents(dueAdmitted.turn.finalizedTurnId))[0]?.status).toBe(
      "complete"
    );
  });

  it("leaves a child with a valid lease untouched by a second coordinator", async () => {
    const { repository, admitted } = await admitTurn();
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[0]!.eventId,
      leaseOwner: "owner-live",
      leaseSeconds: 300,
      expectedVersion: admitted.events[0]!.version
    });
    expect(claimed?.status).toBe("processing");
    const provider = createProvider();
    const other = coordinatorOf(repository, provider, { ownerId: "coordinator-b" });
    await other.notifyAdmitted({
      turn: (await repository.getTurn(admitted.turn.finalizedTurnId))!,
      events: await repository.listEvents(admitted.turn.finalizedTurnId)
    });
    await other.drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted).toMatchObject({
      status: "processing",
      leaseOwner: "owner-live",
      version: claimed!.version
    });
    expect(provider.writes).toHaveLength(0);
  });

  it("reclaims expired pre-dispatch work and then delivers it", async () => {
    const { repository, admitted } = await admitTurn();
    await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[0]!.eventId,
      leaseOwner: "owner-stale",
      leaseSeconds: 1,
      expectedVersion: admitted.events[0]!.version
    });
    const provider = createProvider();
    const coordinator = coordinatorOf(repository, provider, {
      clock: () => new Date(Date.now() + 5_000)
    });
    await coordinator.drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted.status).toBe("complete");
    expect(provider.writes).toHaveLength(1);
  });

  it("moves expired post-dispatch work to reconcile_required without dispatching", async () => {
    const { repository, admitted } = await admitTurn();
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[0]!.eventId,
      leaseOwner: "owner-stale",
      leaseSeconds: 1,
      expectedVersion: admitted.events[0]!.version
    });
    await repository.markEventDispatchStarted({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[0]!.eventId,
      leaseOwner: "owner-stale",
      expectedVersion: claimed!.version
    });
    const provider = createProvider();
    const coordinator = coordinatorOf(repository, provider, {
      clock: () => new Date(Date.now() + 5_000)
    });
    await coordinator.drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted.status).toBe("reconcile_required");
    expect(provider.writes).toHaveLength(0);
  });

  it("completes applied reconciliation without a backend submit", async () => {
    const { repository, admitted } = await admitTurn();
    await forceOutcome(repository, admitted.events[0]!, {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS"
    });
    const provider = createProvider({
      reconcileEvent: vi.fn(async () => ({
        status: "applied" as const,
        eventId: "memory:applied",
        operation: "created"
      })),
      writeEventIdempotent: vi.fn(async () => ({
        status: "written" as const,
        eventId: "memory:should-not-write"
      }))
    });
    const coordinator = coordinatorOf(repository, provider);
    await coordinator.drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted).toMatchObject({
      status: "complete",
      resultKind: "written",
      attemptCount: 1
    });
    expect(provider.writeEventIdempotent).not.toHaveBeenCalled();
  });

  it("makes not_applied reconciliation safely deliverable and dispatches once", async () => {
    const { repository, admitted } = await admitTurn();
    await forceOutcome(repository, admitted.events[0]!, {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS"
    });
    const provider = createProvider({
      reconcileEvent: vi.fn(async () => ({ status: "not_applied" as const }))
    });
    const coordinator = coordinatorOf(repository, provider);
    await coordinator.drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted.status).toBe("complete");
    expect(provider.writes).toHaveLength(1);
    expect(persisted.attemptCount).toBe(2);
  });

  it("leaves in_flight and unknown reconciliation unresolved without dispatch", async () => {
    for (const status of ["in_flight", "unknown"] as const) {
      const { repository, admitted } = await admitTurn(
        new InMemoryFinalizedIngestionRepository(),
        `finalized-turn:${status}`
      );
      await forceOutcome(repository, admitted.events[0]!, {
        status: "ambiguous",
        errorCode: "MEMORY_WRITE_AMBIGUOUS"
      });
      const provider = createProvider({
        reconcileEvent: vi.fn(async () => ({ status }))
      });
      await coordinatorOf(repository, provider).drain(1_000);
      const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
      expect(persisted.status).toBe("reconcile_required");
      expect(provider.writes).toHaveLength(0);
    }
  });

  it("marks payload conflicts terminal without dispatch", async () => {
    const { repository, admitted } = await admitTurn();
    await forceOutcome(repository, admitted.events[0]!, {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS"
    });
    const provider = createProvider({
      reconcileEvent: vi.fn(async () => ({
        status: "payload_conflict" as const,
        errorCode: "DIGEST_MISMATCH"
      }))
    });
    await coordinatorOf(repository, provider).drain(1_000);
    expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]).toMatchObject({
      status: "terminal_failed",
      errorCode: "DIGEST_MISMATCH"
    });
    expect(provider.writes).toHaveLength(0);
  });

  it("executes only the eligible child of a mixed parent", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository, {
      async build() {
        return {
          turnKind: "normal" as const,
          events: [
            {
              kind: "fact" as const,
              content: "complete fact",
              scope: "user:user-a:persona:alice",
              metadata: {}
            },
            {
              kind: "fact" as const,
              content: "pending fact",
              scope: "user:user-a:persona:alice",
              metadata: {}
            },
            {
              kind: "fact" as const,
              content: "later fact",
              scope: "user:user-a:persona:alice",
              metadata: {}
            },
            {
              kind: "fact" as const,
              content: "reconcile fact",
              scope: "user:user-a:persona:alice",
              metadata: {}
            },
            {
              kind: "fact" as const,
              content: "terminal fact",
              scope: "user:user-a:persona:alice",
              metadata: {}
            }
          ]
        };
      }
    }).admit({ ...base, finalizedTurnId: "finalized-turn:mixed" });
    const byAdmittedContent = Object.fromEntries(
      admitted.events.map((event) => [String(event.eventPayload.content), event])
    );
    await forceOutcome(repository, byAdmittedContent["complete fact"]!, {
      status: "written",
      eventId: "memory:complete"
    });
    await forceOutcome(repository, byAdmittedContent["later fact"]!, {
      status: "retryable_failed",
      nextAttemptAt: "2099-01-01T00:00:00.000Z"
    });
    await forceOutcome(repository, byAdmittedContent["reconcile fact"]!, {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS"
    });
    await forceOutcome(repository, byAdmittedContent["terminal fact"]!, {
      status: "rejected",
      failureClass: "definitive_rejection",
      errorCode: "VALIDATION_ERROR"
    });
    const provider = createProvider({
      reconcileEvent: vi.fn(async () => ({ status: "in_flight" as const }))
    });
    await coordinatorOf(repository, provider, {
      clock: () => new Date("2026-08-12T00:00:00.000Z")
    }).drain(1_000);
    const events = await repository.listEvents(admitted.turn.finalizedTurnId);
    const byContent = Object.fromEntries(
      events.map((event) => [String(event.eventPayload.content), event])
    );
    expect(byContent["complete fact"]?.status).toBe("complete");
    expect(byContent["pending fact"]?.status).toBe("complete");
    expect(byContent["later fact"]?.status).toBe("retryable_failed");
    expect(byContent["reconcile fact"]?.status).toBe("reconcile_required");
    expect(byContent["terminal fact"]?.status).toBe("terminal_failed");
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]?.["content"]).toBe("pending fact");
  });

  it("never dispatches complete, skipped, or terminal children", async () => {
    const { repository, admitted } = await admitTurn();
    await forceOutcome(repository, admitted.events[0]!, {
      status: "rejected",
      failureClass: "definitive_rejection",
      errorCode: "VALIDATION_ERROR"
    });
    const skipped = await new FinalizedIngestionService(repository).admit({
      ...base,
      finalizedTurnId: "finalized-turn:skipped",
      ingestionRequested: false
    });
    const provider = createProvider();
    await coordinatorOf(repository, provider).drain(1_000);
    expect(provider.writes).toHaveLength(0);
    expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.status).toBe(
      "terminal_failed"
    );
    expect(skipped.turn.status).toBe("skipped");
  });

  it("does not start the coordinator until after construction, so readiness is not blocked", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository, {
      async build() {
        return {
          turnKind: "normal" as const,
          events: Array.from({ length: 8 }, (_, index) => ({
            kind: "fact" as const,
            content: `backlog ${index}`,
            scope: "user:user-a:persona:alice",
            metadata: {}
          }))
        };
      }
    });
    await service.admit({ ...base, finalizedTurnId: "finalized-turn:backlog" });
    await forceOutcome(repository, (await repository.listEvents("finalized-turn:backlog"))[0]!, {
      status: "retryable_failed",
      nextAttemptAt: "2099-01-01T00:00:00.000Z"
    });
    const stale = (await repository.listEvents("finalized-turn:backlog"))[1]!;
    await repository.claimEvent({
      finalizedTurnId: stale.finalizedTurnId,
      eventId: stale.eventId,
      leaseOwner: "stale-pre",
      leaseSeconds: 1,
      expectedVersion: stale.version
    });
    const post = (await repository.listEvents("finalized-turn:backlog"))[2]!;
    const postClaim = await repository.claimEvent({
      finalizedTurnId: post.finalizedTurnId,
      eventId: post.eventId,
      leaseOwner: "stale-post",
      leaseSeconds: 1,
      expectedVersion: post.version
    });
    await repository.markEventDispatchStarted({
      finalizedTurnId: post.finalizedTurnId,
      eventId: post.eventId,
      leaseOwner: "stale-post",
      expectedVersion: postClaim!.version
    });
    await forceOutcome(repository, (await repository.listEvents("finalized-turn:backlog"))[3]!, {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS"
    });
    await forceOutcome(repository, (await repository.listEvents("finalized-turn:backlog"))[4]!, {
      status: "rejected",
      failureClass: "definitive_rejection",
      errorCode: "VALIDATION_ERROR"
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = createProvider({
      writeEventIdempotent: vi.fn(async () => {
        await held;
        return { status: "written" as const, eventId: "memory:slow" };
      }),
      reconcileEvent: vi.fn(async () => ({ status: "in_flight" as const }))
    });
    const coordinator = coordinatorOf(repository, provider, {
      clock: () => new Date(Date.now() + 5_000),
      concurrency: 2
    });
    const startedAt = Date.now();
    coordinator.start();
    expect(Date.now() - startedAt).toBeLessThan(50);
    const diagnostics = await coordinator.getDiagnostics();
    expect(diagnostics.diagnosticsAvailability).toBe("ok");
    expect((diagnostics.pendingCount ?? 0) + (diagnostics.processingCount ?? 0)).toBeGreaterThan(0);
    expect(diagnostics.status).toBe("running");
    release();
    await coordinator.drain(2_000);
    await coordinator.shutdown();
  });

  it("stops new claims on shutdown and leaves in-flight work recoverable", async () => {
    const { repository, admitted } = await admitTurn();
    let releaseClaim!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const provider = createProvider();
    const coordinator = coordinatorOf(repository, provider, {
      hooks: {
        afterClaim: async () => {
          await held;
        }
      }
    });
    coordinator.start();
    await coordinator.notifyAdmitted(admitted);
    await vi.waitFor(async () => {
      const event = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
      expect(event.status).toBe("processing");
    });
    await coordinator.shutdown({ graceMs: 20 });
    releaseClaim();
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(["processing", "complete", "pending", "reconcile_required"]).toContain(persisted.status);
    expect(persisted.status).not.toBe("terminal_failed");
  });

  it("isolates one event failure without stopping unrelated work", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository, {
      async build() {
        return {
          turnKind: "normal" as const,
          events: [
            {
              kind: "fact" as const,
              content: "boom",
              scope: "user:user-a:persona:alice",
              metadata: {}
            },
            {
              kind: "fact" as const,
              content: "ok",
              scope: "user:user-a:persona:alice",
              metadata: {}
            }
          ]
        };
      }
    }).admit({ ...base, finalizedTurnId: "finalized-turn:isolate" });
    const provider = createProvider({
      writeEventIdempotent: vi.fn(async (input) => {
        if (input.content === "boom") throw new Error("backend down");
        return { status: "written" as const, eventId: "memory:ok" };
      })
    });
    await coordinatorOf(repository, provider).drain(1_000);
    const events = await repository.listEvents(admitted.turn.finalizedTurnId);
    const byContent = Object.fromEntries(
      events.map((event) => [String(event.eventPayload.content), event])
    );
    expect(byContent["boom"]?.status).toBe("reconcile_required");
    expect(byContent["ok"]?.status).toBe("complete");
  });

  it("exposes coordinator diagnostics without scanning terminal work as due", async () => {
    const { repository, admitted } = await admitTurn();
    await forceOutcome(repository, admitted.events[0]!, {
      status: "rejected",
      failureClass: "definitive_rejection",
      errorCode: "VALIDATION_ERROR"
    });
    const coordinator = coordinatorOf(repository, createProvider());
    const diagnostics = await coordinator.getDiagnostics();
    expect(diagnostics.diagnosticsAvailability).toBe("ok");
    expect(diagnostics.terminalFailedCount).toBe(1);
    expect(diagnostics.pendingCount).toBe(0);
    expect(await repository.listDueWork()).toEqual([]);
  });

  it("does not fabricate zero work stats when diagnostics queries fail", async () => {
    const { repository } = await admitTurn();
    repository.getWorkStats = async () => {
      throw new Error("DATABASE_URL=postgres://secret stats exploded");
    };
    const coordinator = coordinatorOf(repository, createProvider());
    coordinator.start();
    const diagnostics = await coordinator.getDiagnostics();
    expect(diagnostics).toMatchObject({
      status: "running",
      diagnosticsAvailability: "error",
      diagnosticsErrorCode: "MEMORY_INGESTION_DIAGNOSTICS_UNAVAILABLE",
      pendingCount: null,
      processingCount: null,
      retryableFailedCount: null,
      dueRetryCount: null,
      reconcileRequiredCount: null,
      completeCount: null,
      unchangedCount: null,
      skippedCount: null,
      terminalFailedCount: null,
      partialParentCount: null,
      staleLeaseCount: null,
      historicalUnknownCount: null
    });
    expect(diagnostics.diagnosticsError).toContain("stats exploded");
    expect(diagnostics.diagnosticsError).not.toContain("postgres://secret");
    expect(diagnostics.activeWorkerCount).toBe(0);
    await coordinator.shutdown();
  });

  it("lets only one C1 claim win when notifyAdmitted races a poll scan", async () => {
    const { repository, admitted } = await admitTurn(
      new InMemoryFinalizedIngestionRepository(),
      "finalized-turn:wake-poll-race"
    );
    const provider = createProvider({
      writeEventIdempotent: vi.fn(async (input) => {
        provider.writes.push(input);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: "written" as const, eventId: `memory:${provider.writes.length}` };
      })
    });
    const coordinator = coordinatorOf(repository, provider, { pollIntervalMs: 5 });
    coordinator.start();
    await Promise.all([coordinator.notifyAdmitted(admitted), coordinator.drain(1_000)]);
    expect(provider.writes).toHaveLength(1);
    expect(provider.writeEventIdempotent).toHaveBeenCalledTimes(1);
    expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.status).toBe(
      "complete"
    );
    await coordinator.shutdown();
  });

  it("coalesces concurrent drain callers into one scheduling domain", async () => {
    const { repository } = await admitTurn();
    const provider = createProvider();
    let activeListCalls = 0;
    let peakListCalls = 0;
    let listCalls = 0;
    const listDueWork = repository.listDueWork.bind(repository);
    vi.spyOn(repository, "listDueWork").mockImplementation(async (input) => {
      activeListCalls += 1;
      peakListCalls = Math.max(peakListCalls, activeListCalls);
      listCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await listDueWork(input);
      } finally {
        activeListCalls -= 1;
      }
    });
    const coordinator = coordinatorOf(repository, provider);

    await Promise.all([coordinator.drain(1_000), coordinator.drain(1_000)]);

    expect(provider.writes).toHaveLength(1);
    expect(peakListCalls).toBe(1);
    expect(listCalls).toBe(2);
  });

  it("consumes work admitted while a drain is actively delivering", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let holdFirst = true;
    const provider = createProvider({
      writeEventIdempotent: vi.fn(async (input) => {
        provider.writes.push(input);
        if (holdFirst) {
          holdFirst = false;
          await firstHeld;
        }
        return { status: "written" as const, eventId: `memory:${provider.writes.length}` };
      })
    });
    const coordinator = coordinatorOf(repository, provider);
    const first = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:drain-wake-first",
      assistantMessageId: "assistant:drain-wake-first"
    });
    const draining = coordinator.drain(2_000);
    await vi.waitFor(() => expect(provider.writes).toHaveLength(1));

    const second = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:drain-wake-second",
      assistantMessageId: "assistant:drain-wake-second"
    });
    await coordinator.notifyAdmitted(second);
    releaseFirst();
    await draining;

    expect(provider.writes).toHaveLength(2);
    expect((await repository.listEvents(first.turn.finalizedTurnId))[0]?.status).toBe("complete");
    expect((await repository.listEvents(second.turn.finalizedTurnId))[0]?.status).toBe("complete");
  });

  it("releases the coordinator slot after a provider failure", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository, {
      async build() {
        return {
          turnKind: "normal" as const,
          events: [
            {
              kind: "fact" as const,
              content: "boom",
              scope: "user:user-a:persona:alice",
              metadata: {}
            },
            {
              kind: "fact" as const,
              content: "after-boom",
              scope: "user:user-a:persona:alice",
              metadata: {}
            }
          ]
        };
      }
    }).admit({ ...base, finalizedTurnId: "finalized-turn:slot-release" });
    const provider = createProvider({
      writeEventIdempotent: vi.fn(async (input) => {
        if (input.content === "boom") {
          throw new Error("provider failure");
        }
        provider.writes.push(input);
        return { status: "written" as const, eventId: "memory:after-boom" };
      })
    });
    const coordinator = coordinatorOf(repository, provider, { concurrency: 1 });

    await coordinator.drain(1_000);

    const events = await repository.listEvents(admitted.turn.finalizedTurnId);
    const byContent = Object.fromEntries(
      events.map((event) => [String(event.eventPayload.content), event])
    );
    expect(byContent["boom"]?.status).toBe("reconcile_required");
    expect(byContent["after-boom"]?.status).toBe("complete");
    expect((await coordinator.getDiagnostics()).activeWorkerCount).toBe(0);
    expect(provider.writes).toHaveLength(1);
  });

  it("makes repeated shutdown safe and ignores wakes after stop", async () => {
    const { repository, admitted } = await admitTurn();
    const provider = createProvider();
    const coordinator = coordinatorOf(repository, provider);
    coordinator.start();
    await coordinator.shutdown({ graceMs: 0 });
    await coordinator.shutdown({ graceMs: 0 });
    await coordinator.notifyAdmitted(admitted);

    expect(coordinator.getStatus()).toBe("stopped");
    expect(provider.writes).toHaveLength(0);
  });

  it("applies the configured retry policy instead of burying delay constants", async () => {
    const { repository, admitted } = await admitTurn();
    const provider = createProvider({
      writeEventIdempotent: vi.fn(async () => ({
        status: "rejected" as const,
        failureClass: "retryable_no_effect" as const,
        errorCode: "MEMORY_BACKEND_UNAVAILABLE"
      }))
    });
    const now = Date.parse("2026-08-12T00:00:00.000Z");
    const coordinator = coordinatorOf(repository, provider, {
      clock: () => new Date(now),
      retryPolicy: { initialDelayMs: 12_000, maxDelayMs: 12_000, multiplier: 1 }
    });
    await coordinator.notifyAdmitted(admitted);
    await coordinator.drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted.status).toBe("retryable_failed");
    expect(persisted.nextAttemptAt).toBe(new Date(now + 12_000).toISOString());
  });

  it("uses fault points around C1 primitives without inventing a second engine", async () => {
    const cases: Array<{
      name: string;
      hook: ConstructorParameters<typeof MemoryIngestionCoordinator>[0]["hooks"];
      expected: string;
      writes: number;
    }> = [
      {
        name: "after claim",
        hook: {
          afterClaim: async () => {
            throw new Error("fault after claim");
          }
        },
        expected: "processing",
        writes: 0
      },
      {
        name: "before dispatch marker",
        hook: {
          beforeDispatchMarker: async () => {
            throw new Error("fault before marker");
          }
        },
        expected: "processing",
        writes: 0
      },
      {
        name: "after dispatch marker",
        hook: {
          afterDispatchMarker: async () => {
            throw new Error("fault after marker");
          }
        },
        expected: "processing",
        writes: 0
      },
      {
        name: "before ledger outcome",
        hook: {
          beforeLedgerOutcome: async () => {
            throw new Error("fault before outcome");
          }
        },
        expected: "processing",
        writes: 1
      }
    ];

    for (const testCase of cases) {
      const { repository, admitted } = await admitTurn(
        new InMemoryFinalizedIngestionRepository(),
        `finalized-turn:fault:${testCase.name}`
      );
      const provider = createProvider();
      const coordinator = coordinatorOf(repository, provider, {
        ...(testCase.hook ? { hooks: testCase.hook } : {})
      });
      await coordinator.notifyAdmitted(admitted);
      await coordinator.drain(1_000);
      const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
      expect(persisted.status, testCase.name).toBe(testCase.expected);
      expect(provider.writes, testCase.name).toHaveLength(testCase.writes);
      if (testCase.name === "after dispatch marker" || testCase.name === "before ledger outcome") {
        expect(persisted.dispatchStartedAt, testCase.name).toBeTruthy();
      } else {
        expect(persisted.dispatchStartedAt, testCase.name).toBeNull();
      }
    }
  });

  it("keeps two coordinators fenced to one logical owner and effect", async () => {
    const { repository, admitted } = await admitTurn();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstWrites: unknown[] = [];
    const first = coordinatorOf(
      repository,
      createProvider({
        writeEventIdempotent: vi.fn(async (input) => {
          firstWrites.push(input);
          await held;
          return { status: "written" as const, eventId: "memory:first" };
        })
      }),
      { ownerId: "coord-1" }
    );
    const secondWrites: unknown[] = [];
    const second = coordinatorOf(
      repository,
      createProvider({
        writeEventIdempotent: vi.fn(async (input) => {
          secondWrites.push(input);
          return { status: "written" as const, eventId: "memory:second" };
        })
      }),
      { ownerId: "coord-2" }
    );
    first.start();
    second.start();
    await first.notifyAdmitted(admitted);
    await vi.waitFor(async () => {
      expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.leaseOwner).toBe(
        "coord-1"
      );
    });
    await second.notifyAdmitted({
      turn: (await repository.getTurn(admitted.turn.finalizedTurnId))!,
      events: await repository.listEvents(admitted.turn.finalizedTurnId)
    });
    await second.drain(200);
    expect(secondWrites).toHaveLength(0);
    release();
    await first.drain(1_000);
    expect(firstWrites).toHaveLength(1);
    expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.status).toBe(
      "complete"
    );
    await first.shutdown();
    await second.shutdown();
  });

  it("does not execute a separate batch from notifyAdmitted", async () => {
    const { repository, admitted } = await admitTurn(
      new InMemoryFinalizedIngestionRepository(),
      "finalized-turn:wake-only"
    );
    const provider = createProvider();
    const coordinator = coordinatorOf(repository, provider);
    await coordinator.notifyAdmitted(admitted);
    expect(provider.writes).toHaveLength(0);
    expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.status).toBe("pending");
    await coordinator.drain(1_000);
    expect(provider.writes).toHaveLength(1);
  });

  it("caps active work at configured concurrency under a wake storm", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    let peak = 0;
    const provider = createProvider({
      writeEventIdempotent: vi.fn(async (input) => {
        provider.writes.push(input);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: "written" as const, eventId: `memory:${provider.writes.length}` };
      })
    });
    const coordinator = coordinatorOf(repository, provider, { concurrency: 2, pollIntervalMs: 5 });
    const original = coordinator.getActiveWorkerCount.bind(coordinator);
    vi.spyOn(coordinator, "getActiveWorkerCount").mockImplementation(() => {
      const current = original();
      peak = Math.max(peak, current);
      return current;
    });
    coordinator.start();
    const admissions = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        new FinalizedIngestionService(repository).admit({
          ...base,
          finalizedTurnId: `finalized-turn:storm:${index}`,
          assistantMessageId: `assistant:storm:${index}`
        })
      )
    );
    const monitor = setInterval(() => {
      peak = Math.max(peak, coordinator.getActiveWorkerCount());
    }, 1);
    await Promise.all(admissions.map((admission) => coordinator.notifyAdmitted(admission)));
    await coordinator.drain(3_000);
    clearInterval(monitor);
    peak = Math.max(peak, coordinator.getActiveWorkerCount());
    expect(peak).toBeLessThanOrEqual(2);
    expect(coordinator.getConfiguredConcurrency()).toBe(2);
    expect(provider.writes).toHaveLength(12);
    await coordinator.shutdown();
  });

  it("recovers durable work when the wake is never consumed", async () => {
    const { repository, admitted } = await admitTurn(
      new InMemoryFinalizedIngestionRepository(),
      "finalized-turn:lost-wake"
    );
    const provider = createProvider();
    const crashed = coordinatorOf(repository, provider, { ownerId: "crashed" });
    await crashed.notifyAdmitted(admitted);
    await crashed.shutdown();
    expect(provider.writes).toHaveLength(0);
    const restarted = coordinatorOf(repository, createProvider(), { ownerId: "restart" });
    restarted.start();
    await restarted.drain(1_000);
    expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.status).toBe(
      "complete"
    );
    await restarted.shutdown();
  });

  it("does not dispatch when the delivery attempt budget is exhausted", async () => {
    const { repository, admitted } = await admitTurn(
      new InMemoryFinalizedIngestionRepository(),
      "finalized-turn:budget-exhausted"
    );
    await forceOutcome(repository, admitted.events[0]!, {
      status: "retryable_failed",
      nextAttemptAt: new Date(Date.now() - 1_000).toISOString()
    });
    expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.attemptCount).toBe(1);
    const provider = createProvider();
    await coordinatorOf(repository, provider, { maxDeliveryAttempts: 1 }).drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted).toMatchObject({
      status: "terminal_failed",
      errorCode: "MEMORY_WRITE_RETRY_EXHAUSTED",
      attemptCount: 1
    });
    expect(provider.writes).toHaveLength(0);
  });

  it("does not consume the delivery budget on a pre-dispatch claim fault", async () => {
    const { repository, admitted } = await admitTurn(
      new InMemoryFinalizedIngestionRepository(),
      "finalized-turn:claim-not-attempt"
    );
    const provider = createProvider();
    await coordinatorOf(repository, provider, {
      hooks: {
        afterClaim: async () => {
          throw new Error("preflight");
        }
      }
    }).drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted.status).toBe("processing");
    expect(persisted.attemptCount).toBe(0);
    expect(persisted.dispatchStartedAt).toBeNull();
    expect(provider.writes).toHaveLength(0);
  });

  it("allows a not_applied child to dispatch once when budget remains", async () => {
    const { repository, admitted } = await admitTurn(
      new InMemoryFinalizedIngestionRepository(),
      "finalized-turn:not-applied-budget"
    );
    await forceOutcome(repository, admitted.events[0]!, {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS"
    });
    const provider = createProvider({
      reconcileEvent: vi.fn(async () => ({ status: "not_applied" as const }))
    });
    await coordinatorOf(repository, provider, { maxDeliveryAttempts: 2 }).drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted.status).toBe("complete");
    expect(provider.writes).toHaveLength(1);
    expect(persisted.attemptCount).toBe(2);
  });

  it("terminalizes not_applied without dispatch when the delivery budget is exhausted", async () => {
    const { repository, admitted } = await admitTurn(
      new InMemoryFinalizedIngestionRepository(),
      "finalized-turn:not-applied-exhausted"
    );
    await forceOutcome(repository, admitted.events[0]!, {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS"
    });
    const provider = createProvider({
      reconcileEvent: vi.fn(async () => ({ status: "not_applied" as const }))
    });
    await coordinatorOf(repository, provider, { maxDeliveryAttempts: 1 }).drain(1_000);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(persisted).toMatchObject({
      status: "terminal_failed",
      errorCode: "MEMORY_WRITE_RETRY_EXHAUSTED"
    });
    expect(provider.writes).toHaveLength(0);
    expect(persisted.attemptCount).toBe(1);
  });

  it("does not let the retry budget terminalize in_flight or unknown reconciliation", async () => {
    for (const status of ["in_flight", "unknown"] as const) {
      const { repository, admitted } = await admitTurn(
        new InMemoryFinalizedIngestionRepository(),
        `finalized-turn:budget-${status}`
      );
      await forceOutcome(repository, admitted.events[0]!, {
        status: "ambiguous",
        errorCode: "MEMORY_WRITE_AMBIGUOUS"
      });
      const provider = createProvider({
        reconcileEvent: vi.fn(async () => ({ status }))
      });
      await coordinatorOf(repository, provider, { maxDeliveryAttempts: 1 }).drain(1_000);
      expect((await repository.listEvents(admitted.turn.finalizedTurnId))[0]?.status).toBe(
        "reconcile_required"
      );
      expect(provider.writes).toHaveLength(0);
    }
  });
});

describe("MemoryIngestionCoordinator PostgreSQL acceptance", () => {
  it.skipIf(!process.env["DATABASE_URL"])(
    "recovers after repository reconstruction and fences two coordinators",
    async () => {
      const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
      const prefix = "test:coordinator:postgres:";
      await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
        `${prefix}%`
      ]);
      try {
        const repositoryA = new PostgresFinalizedIngestionRepository(pool);
        const admitted = await new FinalizedIngestionService(repositoryA).admit({
          ...base,
          finalizedTurnId: `${prefix}turn`,
          assistantMessageId: `${prefix}assistant`
        });
        const writes: string[] = [];
        const provider: MemoryProvider = {
          retrieveRelevant: async () => ({
            status: "empty",
            events: [],
            source: "test",
            limited: false
          }),
          getEvent: async () => null,
          writeEvent: async () => ({ status: "rejected" }),
          writeEventIdempotent: async (input) => {
            writes.push(String(input.idempotencyKey));
            return { status: "written", eventId: "memory:pg" };
          }
        };
        const repositoryB = new PostgresFinalizedIngestionRepository(pool);
        const first = new MemoryIngestionCoordinator({
          repository: repositoryB,
          provider,
          ownerId: "pg-coord-1",
          pollIntervalMs: 60_000
        });
        const second = new MemoryIngestionCoordinator({
          repository: new PostgresFinalizedIngestionRepository(pool),
          provider,
          ownerId: "pg-coord-2",
          pollIntervalMs: 60_000
        });
        first.start();
        second.start();
        await first.drain(2_000);
        await second.drain(2_000);
        const reloaded = await new PostgresFinalizedIngestionRepository(pool).listEvents(
          admitted.turn.finalizedTurnId
        );
        expect(reloaded[0]?.status).toBe("complete");
        expect(new Set(writes).size).toBe(1);
        await first.shutdown();
        await second.shutdown();
      } finally {
        await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
          `${prefix}%`
        ]);
        await pool.end();
      }
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "does not automatically admit historical NULL ingestion decisions",
    async () => {
      const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
      const prefix = "test:coordinator:historical:";
      const conversationId = `${prefix}conversation`;
      await pool.query("delete from conversation_sessions where id = $1", [conversationId]);
      try {
        await pool.query("insert into conversation_sessions (id) values ($1)", [conversationId]);
        await pool.query(
          `insert into conversation_messages (
             id, session_id, trace_id, role, content, status, created_at, completed_at,
             metadata, source_user_event_id, finalized_turn_id, persona_id, subject_user_id,
             ingestion_requested
           ) values ($1, $2, $3, 'assistant', 'old', 'completed', now(), now(), '{}'::jsonb,
             $4, $5, 'alice', 'user-a', null)`,
          [`${prefix}message`, conversationId, `${prefix}trace`, `${prefix}user`, `${prefix}turn`]
        );
        const repository = new PostgresFinalizedIngestionRepository(pool);
        const writes: unknown[] = [];
        const coordinator = new MemoryIngestionCoordinator({
          repository,
          provider: createProvider({
            writeEventIdempotent: async (input) => {
              writes.push(input);
              return { status: "written", eventId: "memory:historical" };
            }
          }),
          admit: (input) => new FinalizedIngestionService(repository).admit(input),
          missingAdmissionEnabled: true,
          pollIntervalMs: 60_000
        });
        await coordinator.drain(1_000);
        expect(await repository.getTurn(`${prefix}turn`)).toBeNull();
        expect(writes).toHaveLength(0);
        const unknown = await repository.listHistoricalUnknownAdmissions?.(1000);
        expect(unknown?.some((row) => row.finalizedTurnId === `${prefix}turn`)).toBe(true);
        await coordinator.shutdown();
      } finally {
        await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
          `${prefix}%`
        ]);
        await pool.query("delete from conversation_sessions where id = $1", [conversationId]);
        await pool.end();
      }
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "transitions due retry, expired leases, and exact reconciliation across restart",
    async () => {
      const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
      const prefix = "test:coordinator:states:";
      await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
        `${prefix}%`
      ]);
      try {
        const repository = new PostgresFinalizedIngestionRepository(pool);
        const service = new FinalizedIngestionService(repository, {
          async build() {
            return {
              turnKind: "normal" as const,
              events: [
                {
                  kind: "fact" as const,
                  content: "due retry",
                  scope: "user:user-a:persona:alice",
                  metadata: {}
                },
                {
                  kind: "fact" as const,
                  content: "expired pre",
                  scope: "user:user-a:persona:alice",
                  metadata: {}
                },
                {
                  kind: "fact" as const,
                  content: "expired post",
                  scope: "user:user-a:persona:alice",
                  metadata: {}
                },
                {
                  kind: "fact" as const,
                  content: "applied reconcile",
                  scope: "user:user-a:persona:alice",
                  metadata: {}
                }
              ]
            };
          }
        });
        const admitted = await service.admit({
          ...base,
          finalizedTurnId: `${prefix}turn`,
          assistantMessageId: `${prefix}assistant`
        });
        const bySeed = Object.fromEntries(
          admitted.events.map((event) => [String(event.eventPayload.content), event])
        );
        const due = bySeed["due retry"]!;
        const pre = bySeed["expired pre"]!;
        const post = bySeed["expired post"]!;
        const reconcile = bySeed["applied reconcile"]!;
        const dueClaim = await repository.claimEvent({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: due.eventId,
          leaseOwner: "seed",
          leaseSeconds: 30,
          expectedVersion: due.version
        });
        const dueDispatch = await repository.markEventDispatchStarted({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: due.eventId,
          leaseOwner: "seed",
          expectedVersion: dueClaim!.version
        });
        await repository.recordEventOutcome({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: due.eventId,
          leaseOwner: "seed",
          expectedVersion: dueDispatch!.version,
          outcome: {
            status: "retryable_failed",
            nextAttemptAt: new Date(Date.now() - 1_000).toISOString()
          }
        });
        await repository.claimEvent({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: pre.eventId,
          leaseOwner: "stale-pre",
          leaseSeconds: 1,
          expectedVersion: pre.version
        });
        const postClaim = await repository.claimEvent({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: post.eventId,
          leaseOwner: "stale-post",
          leaseSeconds: 1,
          expectedVersion: post.version
        });
        await repository.markEventDispatchStarted({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: post.eventId,
          leaseOwner: "stale-post",
          expectedVersion: postClaim!.version
        });
        const reconcileClaim = await repository.claimEvent({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: reconcile.eventId,
          leaseOwner: "seed",
          leaseSeconds: 30,
          expectedVersion: reconcile.version
        });
        const reconcileDispatch = await repository.markEventDispatchStarted({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: reconcile.eventId,
          leaseOwner: "seed",
          expectedVersion: reconcileClaim!.version
        });
        await repository.recordEventOutcome({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: reconcile.eventId,
          leaseOwner: "seed",
          expectedVersion: reconcileDispatch!.version,
          outcome: { status: "ambiguous", errorCode: "MEMORY_WRITE_AMBIGUOUS" }
        });

        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const restarted = new PostgresFinalizedIngestionRepository(pool);
        const writes: string[] = [];
        const reconciles: MemoryReconciliationResult[] = [];
        const coordinator = new MemoryIngestionCoordinator({
          repository: restarted,
          provider: {
            retrieveRelevant: async () => ({
              status: "empty",
              events: [],
              source: "test",
              limited: false
            }),
            getEvent: async () => null,
            writeEvent: async () => ({ status: "rejected" }),
            writeEventIdempotent: async (input) => {
              writes.push(String(input.content));
              return { status: "written", eventId: `memory:${writes.length}` };
            },
            reconcileEvent: async () => {
              reconciles.push({ status: "applied", eventId: "memory:applied", operation: "NONE" });
              return { status: "applied", eventId: "memory:applied", operation: "NONE" };
            }
          },
          ownerId: "pg-restart",
          pollIntervalMs: 60_000
        });
        coordinator.start();
        await coordinator.drain(3_000);
        const events = await restarted.listEvents(admitted.turn.finalizedTurnId);
        const byContent = Object.fromEntries(
          events.map((event) => [String(event.eventPayload.content), event])
        );
        expect(byContent["due retry"]?.status).toBe("complete");
        expect(byContent["expired pre"]?.status).toBe("complete");
        // Expired post-dispatch is reclaimed to reconcile_required, then exact
        // applied/NONE resolves to unchanged with no backend redispatch.
        expect(byContent["expired post"]?.status).toBe("unchanged");
        expect(byContent["applied reconcile"]?.status).toBe("unchanged");
        expect(writes.sort()).toEqual(["due retry", "expired pre"]);
        expect(reconciles).toHaveLength(2);
        expect((await restarted.getTurn(admitted.turn.finalizedTurnId))?.status).toBe("complete");
        await coordinator.shutdown();
      } finally {
        await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
          `${prefix}%`
        ]);
        await pool.end();
      }
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "A: expired post-dispatch + applied resolves complete without redispatch",
    async () => {
      await withExpiredPostDispatch("applied", async ({ event, writes, turn }) => {
        expect(event.status).toBe("complete");
        expect(event.resultKind).toBe("written");
        expect(writes).toHaveLength(0);
        expect(turn?.status).toBe("complete");
      });
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "B: expired post-dispatch + in_flight stays reconcile_required with cooldown",
    async () => {
      await withExpiredPostDispatch("in_flight", async ({ event, writes, turn }) => {
        expect(event.status).toBe("reconcile_required");
        expect(event.nextAttemptAt).toBeTruthy();
        expect(new Date(event.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now());
        expect(writes).toHaveLength(0);
        expect(turn?.status).toBe("reconcile_required");
      });
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "C: expired post-dispatch + unknown stays reconcile_required with cooldown",
    async () => {
      await withExpiredPostDispatch("unknown", async ({ event, writes, turn }) => {
        expect(event.status).toBe("reconcile_required");
        expect(event.nextAttemptAt).toBeTruthy();
        expect(new Date(event.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now());
        expect(writes).toHaveLength(0);
        expect(turn?.status).toBe("reconcile_required");
      });
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "D: expired post-dispatch + not_applied redispatches once through a fresh C1 claim",
    async () => {
      await withExpiredPostDispatch(
        "not_applied",
        async ({ event, writes, turn, seedAttemptCount }) => {
          expect(event.status).toBe("complete");
          expect(writes).toHaveLength(1);
          expect(event.attemptCount).toBe(seedAttemptCount + 1);
          expect(event.leaseOwner).toBeNull();
          expect(turn?.status).toBe("complete");
        }
      );
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "E: expired post-dispatch + payload_conflict is terminal without redispatch",
    async () => {
      await withExpiredPostDispatch("payload_conflict", async ({ event, writes, turn }) => {
        expect(event.status).toBe("terminal_failed");
        expect(event.errorCode).toBe("DIGEST_MISMATCH");
        expect(writes).toHaveLength(0);
        expect(turn?.status).toBe("terminal_failed");
      });
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "persists delivery attempt count and exhausts the budget after restart",
    async () => {
      const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
      const prefix = "test:coordinator:budget-restart:";
      await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
        `${prefix}%`
      ]);
      try {
        const repository = new PostgresFinalizedIngestionRepository(pool);
        const admitted = await new FinalizedIngestionService(repository).admit({
          ...base,
          finalizedTurnId: `${prefix}turn`,
          assistantMessageId: `${prefix}assistant`
        });
        const event = admitted.events[0]!;
        const claimed = await repository.claimEvent({
          finalizedTurnId: event.finalizedTurnId,
          eventId: event.eventId,
          leaseOwner: "seed",
          leaseSeconds: 30,
          expectedVersion: event.version
        });
        const dispatched = await repository.markEventDispatchStarted({
          finalizedTurnId: event.finalizedTurnId,
          eventId: event.eventId,
          leaseOwner: "seed",
          expectedVersion: claimed!.version
        });
        await repository.recordEventOutcome({
          finalizedTurnId: event.finalizedTurnId,
          eventId: event.eventId,
          leaseOwner: "seed",
          expectedVersion: dispatched!.version,
          outcome: {
            status: "retryable_failed",
            nextAttemptAt: new Date(Date.now() - 1_000).toISOString()
          }
        });
        const writes: string[] = [];
        const coordinator = new MemoryIngestionCoordinator({
          repository: new PostgresFinalizedIngestionRepository(pool),
          provider: createProvider({
            writeEventIdempotent: async (input) => {
              writes.push(String(input.content));
              return { status: "written", eventId: "memory:budget" };
            }
          }),
          ownerId: "pg-budget",
          maxDeliveryAttempts: 1,
          pollIntervalMs: 60_000
        });
        coordinator.start();
        await coordinator.drain(3_000);
        const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
        expect(persisted).toMatchObject({
          status: "terminal_failed",
          errorCode: "MEMORY_WRITE_RETRY_EXHAUSTED",
          attemptCount: 1
        });
        expect(writes).toHaveLength(0);
        await coordinator.shutdown();
      } finally {
        await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
          `${prefix}%`
        ]);
        await pool.end();
      }
    }
  );
});

async function withExpiredPostDispatch(
  reconcileStatus: MemoryReconciliationResult["status"],
  assert: (input: {
    event: FinalizedIngestionEvent;
    writes: string[];
    turn: Awaited<ReturnType<PostgresFinalizedIngestionRepository["getTurn"]>>;
    seedAttemptCount: number;
  }) => Promise<void>
): Promise<void> {
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
  const prefix = `test:coordinator:expired-post:${reconcileStatus}:`;
  await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
    `${prefix}%`
  ]);
  try {
    const repository = new PostgresFinalizedIngestionRepository(pool);
    const admitted = await new FinalizedIngestionService(repository, {
      async build() {
        return {
          turnKind: "normal" as const,
          events: [
            {
              kind: "fact" as const,
              content: `expired post ${reconcileStatus}`,
              scope: "user:user-a:persona:alice",
              metadata: {}
            }
          ]
        };
      }
    }).admit({
      ...base,
      finalizedTurnId: `${prefix}turn`,
      assistantMessageId: `${prefix}assistant`
    });
    const seeded = admitted.events[0]!;
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: seeded.eventId,
      leaseOwner: "stale-post",
      leaseSeconds: 1,
      expectedVersion: seeded.version
    });
    const dispatched = await repository.markEventDispatchStarted({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: seeded.eventId,
      leaseOwner: "stale-post",
      expectedVersion: claimed!.version
    });
    expect(dispatched?.dispatchStartedAt).toBeTruthy();
    const seedAttemptCount = dispatched!.attemptCount;
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const writes: string[] = [];
    const coordinator = new MemoryIngestionCoordinator({
      repository: new PostgresFinalizedIngestionRepository(pool),
      provider: {
        retrieveRelevant: async () => ({
          status: "empty",
          events: [],
          source: "test",
          limited: false
        }),
        getEvent: async () => null,
        writeEvent: async () => ({ status: "rejected" }),
        writeEventIdempotent: async (input) => {
          writes.push(String(input.content));
          return { status: "written", eventId: `memory:${writes.length}` };
        },
        reconcileEvent: async () =>
          reconcileStatus === "applied"
            ? { status: "applied", eventId: "memory:applied", operation: "created" }
            : reconcileStatus === "payload_conflict"
              ? { status: "payload_conflict", errorCode: "DIGEST_MISMATCH" }
              : { status: reconcileStatus }
      },
      ownerId: `pg-expired-post-${reconcileStatus}`,
      pollIntervalMs: 60_000,
      retryPolicy: { initialDelayMs: 60_000, maxDelayMs: 60_000, multiplier: 1 }
    });
    coordinator.start();
    await coordinator.drain(3_000);
    const event = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    const turn = await repository.getTurn(admitted.turn.finalizedTurnId);
    await assert({ event, writes, turn, seedAttemptCount });
    await coordinator.shutdown();
  } finally {
    await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
      `${prefix}%`
    ]);
    await pool.end();
  }
}
