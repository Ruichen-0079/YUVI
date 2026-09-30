import { FinalizedIngestionService } from "./finalized-test-fixture.js";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  FINALIZED_INGESTION_POLICY_VERSION,
  InMemoryFinalizedIngestionRepository,
  PostgresFinalizedIngestionRepository
} from "./finalized-ingestion-ledger.js";

const base = {
  assistantMessageId: "assistant:one",
  sourceUserEventId: "event:one",
  conversationId: "session:one",
  traceId: "trace:one",
  personaId: "alice",
  subjectUserId: "user-a",
  finalizedAt: "2026-08-12T00:00:00.000Z",
  userMessage: "I prefer concise replies.",
  assistantMessage: "Understood."
};

describe("Finalized ingestion ledger foundation", () => {
  it("materializes stable events and remains idempotent for duplicate admission", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const first = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:one",
      ingestionRequested: true
    });
    const reloaded = new FinalizedIngestionService(repository, {
      async build() {
        throw new Error("policy failure after restart");
      }
    });
    const second = await reloaded.admit({
      ...base,
      finalizedTurnId: "finalized-turn:one",
      ingestionRequested: true
    });

    expect(first.turn.policyVersion).toBe(FINALIZED_INGESTION_POLICY_VERSION);
    expect(first.turn.status).toBe("pending");
    expect(first.events).toHaveLength(1);
    expect(second.events).toEqual(first.events);
    expect(second.turn.finalizedTurnId).toBe(first.turn.finalizedTurnId);
    expect(second.events[0]?.backendIdempotencyKey).toMatch(
      /^yuvi:finalized-turn:finalized-turn:one:event:/
    );
  });

  it("persists intentional memory-disabled skips without child work", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const result = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:skip",
      ingestionRequested: false
    });

    expect(result.turn.status).toBe("skipped");
    expect(result.turn.ingestionSkipReason).toBe("memory-disabled");
    expect(result.events).toEqual([]);
    expect(await repository.listNonTerminalTurns()).toEqual([]);
  });

  it("retains an admitted turn across a fresh service instance", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const first = new FinalizedIngestionService(repository);
    const admitted = await first.admit({
      ...base,
      finalizedTurnId: "finalized-turn:reload",
      ingestionRequested: true
    });

    const reloaded = new FinalizedIngestionService(repository);
    const reread = await reloaded.admit({
      ...base,
      finalizedTurnId: admitted.turn.finalizedTurnId,
      ingestionRequested: true
    });

    expect(reread.turn).toEqual(admitted.turn);
    expect(reread.events).toEqual(admitted.events);
  });

  it("keeps missing identity as a terminal failure rather than an intentional skip", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const result = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:missing-scope",
      personaId: null,
      ingestionRequested: true
    });

    expect(result.turn.status).toBe("terminal_failed");
    expect(result.turn.ingestionSkipReason).toBeNull();
    expect(result.turn.lastErrorCode).toBe("MEMORY_SCOPE_MISSING");
  });

  it("does not mark a turn complete when one child fails", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository, {
      async build() {
        return {
          turnKind: "normal" as const,
          events: [
            {
              kind: "fact" as const,
              content: "first",
              scope: "user:user-a:persona:alice",
              metadata: {}
            },
            {
              kind: "fact" as const,
              content: "second",
              scope: "user:user-a:persona:alice",
              metadata: {}
            }
          ]
        };
      }
    });
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:partial",
      ingestionRequested: true
    });

    const firstClaim = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[0]!.eventId,
      leaseOwner: "test-worker",
      leaseSeconds: 30,
      expectedVersion: admitted.events[0]!.version
    });
    const firstDispatch = await repository.markEventDispatchStarted({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[0]!.eventId,
      leaseOwner: "test-worker",
      expectedVersion: firstClaim!.version
    });
    await service.recordEventOutcome({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[0]!.eventId,
      leaseOwner: "test-worker",
      expectedVersion: firstDispatch!.version,
      outcome: { status: "written", eventId: "memory:one" }
    });
    const secondClaim = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[1]!.eventId,
      leaseOwner: "test-worker",
      leaseSeconds: 30,
      expectedVersion: admitted.events[1]!.version
    });
    const secondDispatch = await repository.markEventDispatchStarted({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[1]!.eventId,
      leaseOwner: "test-worker",
      expectedVersion: secondClaim!.version
    });
    await service.recordEventOutcome({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: admitted.events[1]!.eventId,
      leaseOwner: "test-worker",
      expectedVersion: secondDispatch!.version,
      outcome: { status: "rejected", errorCode: "MEMORY_WRITE_REJECTED" }
    });

    const turn = await repository.getTurn(admitted.turn.finalizedTurnId);
    expect(turn?.status).toBe("partial");
    expect(turn?.completeEventCount).toBe(1);
    expect(turn?.failedEventCount).toBe(1);
  });

  it("claims a pending child once with a compare-and-set version", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:claim",
      ingestionRequested: true
    });
    const event = admitted.events[0]!;
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-a",
      leaseSeconds: 30,
      expectedVersion: event.version
    });
    const secondClaim = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-b",
      leaseSeconds: 30,
      expectedVersion: event.version
    });

    expect(claimed).toMatchObject({ status: "processing", leaseOwner: "worker-a" });
    expect(secondClaim).toBeNull();
  });

  it("does not count a claim as delivery and reclaims a pre-dispatch expiry", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:reclaim-before-dispatch",
      ingestionRequested: true
    });
    const event = admitted.events[0]!;
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-a",
      leaseSeconds: 1,
      expectedVersion: event.version
    });
    expect(claimed?.attemptCount).toBe(0);
    const reclaimed = await repository.reclaimExpiredEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      expectedVersion: claimed!.version,
      now: new Date(Date.now() + 2_000).toISOString()
    });
    expect(reclaimed).toMatchObject({ status: "pending", attemptCount: 0 });
  });

  it("moves an expired dispatched child to reconciliation and fences the old owner", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:reclaim-after-dispatch",
      ingestionRequested: true
    });
    const event = admitted.events[0]!;
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-a",
      leaseSeconds: 1,
      expectedVersion: event.version
    });
    const dispatching = await repository.markEventDispatchStarted({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-a",
      expectedVersion: claimed!.version
    });
    const reclaimed = await repository.reclaimExpiredEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      expectedVersion: dispatching!.version,
      now: new Date(Date.now() + 2_000).toISOString()
    });
    expect(reclaimed).toMatchObject({ status: "reconcile_required", resultKind: "ambiguous" });
    await expect(
      repository.recordEventOutcome({
        finalizedTurnId: admitted.turn.finalizedTurnId,
        eventId: event.eventId,
        leaseOwner: "worker-a",
        expectedVersion: dispatching!.version,
        outcome: { status: "written", eventId: "memory:stale" }
      })
    ).rejects.toThrow(/changed before outcome recording/);
  });

  it("rejects stale or early outcome recording without owner and version", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:strict-outcome",
      ingestionRequested: true
    });
    await expect(
      repository.recordEventOutcome({
        finalizedTurnId: admitted.turn.finalizedTurnId,
        eventId: admitted.events[0]!.eventId,
        leaseOwner: "worker-a",
        expectedVersion: admitted.events[0]!.version,
        outcome: { status: "written", eventId: "memory:early" }
      })
    ).rejects.toThrow(/changed before outcome recording/);
  });

  it("requires dispatch marker and attempt count for delivery outcomes", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:dispatch-marker-required",
      ingestionRequested: true
    });
    const event = admitted.events[0]!;
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-marker",
      leaseSeconds: 30,
      expectedVersion: event.version
    });

    await expect(
      repository.recordEventOutcome({
        finalizedTurnId: admitted.turn.finalizedTurnId,
        eventId: event.eventId,
        leaseOwner: "worker-marker",
        expectedVersion: claimed!.version,
        outcome: { status: "written", eventId: "memory:early" }
      })
    ).rejects.toThrow(/dispatch marker is missing/);

    const dispatching = await repository.markEventDispatchStarted({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-marker",
      expectedVersion: claimed!.version
    });
    expect(dispatching).toMatchObject({ attemptCount: 1 });
    const recorded = await repository.recordEventOutcome({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-marker",
      expectedVersion: dispatching!.version,
      outcome: { status: "written", eventId: "memory:accepted" }
    });
    expect(recorded).toMatchObject({ status: "complete", attemptCount: 1 });
  });

  it("retains retryable child failure as durable retryable work", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:retryable",
      ingestionRequested: true
    });
    const event = admitted.events[0]!;
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-retry",
      leaseSeconds: 30,
      expectedVersion: event.version
    });
    const dispatching = await repository.markEventDispatchStarted({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-retry",
      expectedVersion: claimed!.version
    });

    await service.recordEventOutcome({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-retry",
      expectedVersion: dispatching!.version,
      outcome: {
        status: "retryable_failed",
        errorCode: "MEMORY_BACKEND_UNAVAILABLE",
        nextAttemptAt: "2026-08-12T00:05:00.000Z"
      }
    });

    const retryable = await repository.getTurn(admitted.turn.finalizedTurnId);
    const retryableEvent = (await repository.listEvents(admitted.turn.finalizedTurnId))[0];
    expect(retryable?.status).toBe("retryable_failed");
    expect(retryableEvent).toMatchObject({
      status: "retryable_failed",
      nextAttemptAt: "2026-08-12T00:05:00.000Z",
      errorCode: "MEMORY_BACKEND_UNAVAILABLE"
    });
  });

  it("durably records materialization failure without fabricating child events", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository, {
      async build() {
        throw new Error("policy failure");
      }
    });

    const first = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:materialization-failed",
      ingestionRequested: true
    });
    const second = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:materialization-failed",
      ingestionRequested: true
    });

    expect(first.turn).toMatchObject({
      status: "terminal_failed",
      ingestionRequested: true,
      failureStage: "materialization",
      lastErrorCode: "MEMORY_MATERIALIZATION_FAILED"
    });
    expect(first.events).toEqual([]);
    expect(second).toEqual(first);
    expect(await repository.listNonTerminalTurns()).toEqual([]);
  });

  it("keeps ambiguous outcomes visible after repository reload", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:ambiguous",
      ingestionRequested: true
    });
    const event = admitted.events[0]!;
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-ambiguous",
      leaseSeconds: 30,
      expectedVersion: event.version
    });
    const dispatching = await repository.markEventDispatchStarted({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-ambiguous",
      expectedVersion: claimed!.version
    });

    await service.recordEventOutcome({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-ambiguous",
      expectedVersion: dispatching!.version,
      outcome: {
        status: "rejected",
        errorCode: "OPERATION_TIMEOUT",
        failureClass: "ambiguous"
      }
    });

    const reloaded = new FinalizedIngestionService(repository);
    const turn = await repository.getTurn(admitted.turn.finalizedTurnId);
    const events = await repository.listEvents(admitted.turn.finalizedTurnId);
    expect(turn?.status).toBe("reconcile_required");
    expect(events[0]).toMatchObject({ status: "reconcile_required", resultKind: "ambiguous" });
    expect(
      await reloaded.admit({
        ...base,
        finalizedTurnId: admitted.turn.finalizedTurnId,
        ingestionRequested: true
      })
    ).toEqual({ turn, events });
  });

  it("excludes terminal failed turns from ordinary recovery listing", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository, {
      async build() {
        throw new Error("policy failure");
      }
    });
    await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:terminal-listing",
      ingestionRequested: true
    });

    expect(await repository.listNonTerminalTurns()).toEqual([]);
  });

  it("maps definitive rejection to terminal failure", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:definitive-rejection",
      ingestionRequested: true
    });
    const event = admitted.events[0]!;
    const claimed = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-definitive",
      leaseSeconds: 30,
      expectedVersion: event.version
    });

    await service.recordEventOutcome({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "worker-definitive",
      expectedVersion: claimed!.version,
      outcome: {
        status: "rejected",
        errorCode: "VALIDATION_ERROR",
        failureClass: "definitive_rejection"
      }
    });

    const turn = await repository.getTurn(admitted.turn.finalizedTurnId);
    const persistedEvent = (await repository.listEvents(admitted.turn.finalizedTurnId))[0];
    expect(turn?.status).toBe("terminal_failed");
    expect(persistedEvent).toMatchObject({
      status: "terminal_failed",
      resultKind: "rejected",
      errorCode: "VALIDATION_ERROR"
    });
  });

  it.skipIf(!process.env["DATABASE_URL"])(
    "persists admission, child identity, and outcome across PostgreSQL repository reload",
    async () => {
      const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
      const prefix = "test:ledger:postgres:";
      await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
        `${prefix}%`
      ]);
      try {
        const repositoryA = new PostgresFinalizedIngestionRepository(pool);
        const serviceA = new FinalizedIngestionService(repositoryA);
        const admitted = await serviceA.admit({
          ...base,
          finalizedTurnId: `${prefix}one`,
          ingestionRequested: true
        });
        const duplicate = await serviceA.admit({
          ...base,
          finalizedTurnId: `${prefix}one`,
          ingestionRequested: true
        });
        expect(duplicate.events).toEqual(admitted.events);

        const repositoryB = new PostgresFinalizedIngestionRepository(pool);
        const reloadedEvents = await repositoryB.listEvents(`${prefix}one`);
        expect(reloadedEvents).toEqual(admitted.events);
        const claimed = await repositoryB.claimEvent({
          finalizedTurnId: `${prefix}one`,
          eventId: reloadedEvents[0]!.eventId,
          leaseOwner: "test-worker",
          leaseSeconds: 30,
          expectedVersion: reloadedEvents[0]!.version
        });
        expect(claimed?.status).toBe("processing");
        await expect(
          repositoryB.recordEventOutcome({
            finalizedTurnId: `${prefix}one`,
            eventId: reloadedEvents[0]!.eventId,
            leaseOwner: "test-worker",
            expectedVersion: claimed!.version,
            outcome: { status: "written", eventId: "memory:early" }
          })
        ).rejects.toThrow(/not found or changed/);
        const dispatching = await repositoryB.markEventDispatchStarted({
          finalizedTurnId: `${prefix}one`,
          eventId: reloadedEvents[0]!.eventId,
          leaseOwner: "test-worker",
          expectedVersion: claimed!.version
        });
        expect(dispatching?.dispatchStartedAt).toBeTruthy();
        await repositoryB.recordEventOutcome({
          finalizedTurnId: `${prefix}one`,
          eventId: reloadedEvents[0]!.eventId,
          leaseOwner: "test-worker",
          expectedVersion: dispatching!.version,
          outcome: { status: "written", eventId: "memory:postgres-test" }
        });
        const finalTurn = await repositoryB.getTurn(`${prefix}one`);
        expect(finalTurn?.status).toBe("complete");
        expect(finalTurn?.completeEventCount).toBe(1);
      } finally {
        await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
          `${prefix}%`
        ]);
        await pool.end();
      }
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "discovers only completed assistant rows that still need admission",
    async () => {
      const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
      const prefix = "test:ledger:discovery:";
      const conversationId = `${prefix}conversation`;
      await pool.query("delete from conversation_sessions where id = $1", [conversationId]);
      try {
        await pool.query("insert into conversation_sessions (id) values ($1)", [conversationId]);
        const insertMessage = async (
          suffix: string,
          status: "completed" | "failed" | "cancelled" | "streaming",
          ingestionRequested: boolean | null,
          recoverableScope = true
        ) => {
          await pool.query(
            `insert into conversation_messages (
               id, session_id, trace_id, role, content, status, created_at, completed_at,
               metadata, source_user_event_id, finalized_turn_id, persona_id, subject_user_id,
               ingestion_requested
             ) values ($1, $2, $3, 'assistant', $4, $5, now(), now(), '{}'::jsonb, $6, $7, $8, $9, $10)`,
            [
              `${prefix}${suffix}:message`,
              conversationId,
              `${prefix}${suffix}:trace`,
              suffix,
              status,
              `${prefix}${suffix}:source`,
              `${prefix}${suffix}:turn`,
              recoverableScope ? "alice" : null,
              recoverableScope ? "user-a" : null,
              ingestionRequested
            ]
          );
        };

        await insertMessage("eligible", "completed", true);
        await insertMessage("existing-parent", "completed", true);
        await insertMessage("disabled", "completed", false);
        await insertMessage("unknown", "completed", null);
        await insertMessage("missing-scope", "completed", true, false);
        await insertMessage("failed", "failed", true);
        await insertMessage("cancelled", "cancelled", true);
        await insertMessage("streaming", "streaming", true);

        const repository = new PostgresFinalizedIngestionRepository(pool);
        const service = new FinalizedIngestionService(repository);
        await service.admit({
          ...base,
          finalizedTurnId: `${prefix}existing-parent:turn`,
          assistantMessageId: `${prefix}existing-parent:message`,
          sourceUserEventId: `${prefix}existing-parent:source`,
          conversationId,
          traceId: `${prefix}existing-parent:trace`,
          finalizedAt: new Date().toISOString(),
          ingestionRequested: true
        });
        const missing = await repository.listMissingAdmissions(1000);
        const scopedMissing = missing.filter((row) => row.finalizedTurnId.startsWith(prefix));
        expect(scopedMissing).toHaveLength(1);
        expect(scopedMissing[0]).toMatchObject({
          assistantMessageId: `${prefix}eligible:message`,
          finalizedTurnId: `${prefix}eligible:turn`,
          conversationId,
          ingestionRequested: true
        });
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
    "persists ambiguous outcome across PostgreSQL repository reload",
    async () => {
      const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
      const prefix = "test:ledger:ambiguous-reload:";
      await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
        `${prefix}%`
      ]);
      try {
        const repositoryA = new PostgresFinalizedIngestionRepository(pool);
        const serviceA = new FinalizedIngestionService(repositoryA);
        const admitted = await serviceA.admit({
          ...base,
          finalizedTurnId: `${prefix}turn`,
          ingestionRequested: true
        });
        const event = admitted.events[0]!;
        const claimed = await repositoryA.claimEvent({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: event.eventId,
          leaseOwner: "ambiguous-worker",
          leaseSeconds: 30,
          expectedVersion: event.version
        });
        const dispatching = await repositoryA.markEventDispatchStarted({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: event.eventId,
          leaseOwner: "ambiguous-worker",
          expectedVersion: claimed!.version
        });
        await repositoryA.recordEventOutcome({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: event.eventId,
          leaseOwner: "ambiguous-worker",
          expectedVersion: dispatching!.version,
          outcome: {
            status: "rejected",
            errorCode: "OPERATION_TIMEOUT",
            failureClass: "ambiguous"
          }
        });

        const repositoryB = new PostgresFinalizedIngestionRepository(pool);
        const reloadedTurn = await repositoryB.getTurn(admitted.turn.finalizedTurnId);
        const reloadedEvents = await repositoryB.listEvents(admitted.turn.finalizedTurnId);
        expect(reloadedTurn?.status).toBe("reconcile_required");
        expect(reloadedEvents[0]).toMatchObject({
          status: "reconcile_required",
          resultKind: "ambiguous",
          errorCode: "OPERATION_TIMEOUT"
        });
      } finally {
        await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
          `${prefix}%`
        ]);
        await pool.end();
      }
    }
  );

  it.skipIf(!process.env["DATABASE_URL"])(
    "serializes concurrent child outcomes before refreshing the parent aggregate",
    async () => {
      const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });
      const prefix = "test:ledger:concurrency:";
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
                  content: "first concurrent fact",
                  scope: "user:user-a:persona:alice",
                  metadata: {}
                },
                {
                  kind: "fact" as const,
                  content: "second concurrent fact",
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
          ingestionRequested: true
        });
        const first = admitted.events[0]!;
        const second = admitted.events[1]!;
        const [firstClaim, secondClaim] = await Promise.all([
          repository.claimEvent({
            finalizedTurnId: admitted.turn.finalizedTurnId,
            eventId: first.eventId,
            leaseOwner: "worker-a",
            leaseSeconds: 30,
            expectedVersion: first.version
          }),
          repository.claimEvent({
            finalizedTurnId: admitted.turn.finalizedTurnId,
            eventId: second.eventId,
            leaseOwner: "worker-b",
            leaseSeconds: 30,
            expectedVersion: second.version
          })
        ]);
        expect(firstClaim).not.toBeNull();
        expect(secondClaim).not.toBeNull();
        const firstDispatch = await repository.markEventDispatchStarted({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: first.eventId,
          leaseOwner: "worker-a",
          expectedVersion: firstClaim!.version
        });
        const secondDispatch = await repository.markEventDispatchStarted({
          finalizedTurnId: admitted.turn.finalizedTurnId,
          eventId: second.eventId,
          leaseOwner: "worker-b",
          expectedVersion: secondClaim!.version
        });
        expect(firstDispatch).not.toBeNull();
        expect(secondDispatch).not.toBeNull();

        await Promise.all([
          repository.recordEventOutcome({
            finalizedTurnId: admitted.turn.finalizedTurnId,
            eventId: first.eventId,
            leaseOwner: "worker-a",
            expectedVersion: firstDispatch!.version,
            outcome: { status: "written", eventId: "memory:first" }
          }),
          repository.recordEventOutcome({
            finalizedTurnId: admitted.turn.finalizedTurnId,
            eventId: second.eventId,
            leaseOwner: "worker-b",
            expectedVersion: secondDispatch!.version,
            outcome: { status: "written", eventId: "memory:second" }
          })
        ]);

        const finalTurn = await repository.getTurn(admitted.turn.finalizedTurnId);
        const finalEvents = await repository.listEvents(admitted.turn.finalizedTurnId);
        expect(finalTurn).toMatchObject({
          status: "complete",
          eligibleEventCount: 2,
          completeEventCount: 2,
          failedEventCount: 0,
          ambiguousEventCount: 0
        });
        expect(finalEvents.every((event) => event.status === "complete")).toBe(true);
      } finally {
        await pool.query("delete from finalized_ingestion_turns where finalized_turn_id like $1", [
          `${prefix}%`
        ]);
        await pool.end();
      }
    }
  );
});

describe("Finalized ingestion child work discovery", () => {
  it("selects pending, due retryable, expired processing, and unleased reconcile children", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository, {
      async build() {
        return {
          turnKind: "normal" as const,
          events: ["pending", "due", "later", "leased", "expired", "reconcile", "done"].map(
            (label) => ({
              kind: "fact" as const,
              content: `fact ${label}`,
              scope: "user:user-a:persona:alice",
              metadata: {}
            })
          )
        };
      }
    });
    const admitted = await service.admit({
      ...base,
      finalizedTurnId: "finalized-turn:discovery",
      ingestionRequested: true
    });
    const byLabel = Object.fromEntries(
      admitted.events.map((event) => [String(event.eventPayload.content).slice(5), event])
    );
    await recordOutcome(repository, byLabel["due"]!, {
      status: "retryable_failed",
      nextAttemptAt: "2026-08-12T00:00:00.000Z"
    });
    await recordOutcome(repository, byLabel["later"]!, {
      status: "retryable_failed",
      nextAttemptAt: "2099-01-01T00:00:00.000Z"
    });
    await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: byLabel["leased"]!.eventId,
      leaseOwner: "owner-live",
      leaseSeconds: 300,
      expectedVersion: byLabel["leased"]!.version
    });
    const expiredClaim = await repository.claimEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: byLabel["expired"]!.eventId,
      leaseOwner: "owner-stale",
      leaseSeconds: 1,
      expectedVersion: byLabel["expired"]!.version
    });
    expect(expiredClaim).not.toBeNull();
    await recordOutcome(repository, byLabel["reconcile"]!, {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS"
    });
    await recordOutcome(repository, byLabel["done"]!, {
      status: "written",
      eventId: "memory:done"
    });

    const due = await repository.listDueWork({
      now: new Date(Date.now() + 5_000).toISOString(),
      limit: 20
    });
    const dueIds = new Set(due.map((event) => event.eventId));
    expect(dueIds.has(byLabel["pending"]!.eventId)).toBe(true);
    expect(dueIds.has(byLabel["due"]!.eventId)).toBe(true);
    expect(dueIds.has(byLabel["later"]!.eventId)).toBe(false);
    expect(dueIds.has(byLabel["leased"]!.eventId)).toBe(false);
    expect(dueIds.has(byLabel["expired"]!.eventId)).toBe(true);
    expect(dueIds.has(byLabel["reconcile"]!.eventId)).toBe(true);
    expect(dueIds.has(byLabel["done"]!.eventId)).toBe(false);
  });

  it("records exact reconcile outcomes without incrementing delivery attempts", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository).admit({
      ...base,
      finalizedTurnId: "finalized-turn:reconcile-record",
      ingestionRequested: true
    });
    const event = admitted.events[0]!;
    await recordOutcome(repository, event, {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS"
    });
    const ambiguous = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    expect(ambiguous.attemptCount).toBe(1);
    const claimed = await repository.claimReconcileEvent({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "reconciler-a",
      leaseSeconds: 30,
      expectedVersion: ambiguous.version
    });
    expect(claimed?.attemptCount).toBe(1);
    const recorded = await repository.recordReconcileOutcome({
      finalizedTurnId: admitted.turn.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: "reconciler-a",
      expectedVersion: claimed!.version,
      result: { status: "applied", eventId: "memory:applied", operation: "created" }
    });
    expect(recorded).toMatchObject({
      status: "complete",
      resultKind: "written",
      attemptCount: 1,
      leaseOwner: null
    });
  });
});

async function recordOutcome(
  repository: InMemoryFinalizedIngestionRepository,
  event: { finalizedTurnId: string; eventId: string; version: number },
  outcome: Parameters<InMemoryFinalizedIngestionRepository["recordEventOutcome"]>[0]["outcome"]
): Promise<void> {
  const claimed = await repository.claimEvent({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner: "fixture",
    leaseSeconds: 30,
    expectedVersion: event.version
  });
  if (!claimed) throw new Error(`Could not claim ${event.eventId}.`);
  const dispatching = await repository.markEventDispatchStarted({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner: "fixture",
    expectedVersion: claimed.version
  });
  if (!dispatching) throw new Error(`Could not mark ${event.eventId}.`);
  await repository.recordEventOutcome({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner: "fixture",
    expectedVersion: dispatching.version,
    outcome
  });
}
