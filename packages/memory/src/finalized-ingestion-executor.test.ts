import { FinalizedIngestionService } from "./finalized-test-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { InMemoryFinalizedIngestionRepository } from "./finalized-ingestion-ledger.js";
import { executeFinalizedIngestionEvent } from "./finalized-ingestion-executor.js";
import type { MemoryBackend } from "./backend.js";
import type { MemoryProvider } from "./provider.js";
import { Mem0MemoryProvider } from "./providers/mem0-memory-provider.js";

const base = {
  finalizedTurnId: "finalized-turn:executor",
  assistantMessageId: "assistant:executor",
  sourceUserEventId: "user:executor",
  conversationId: "conversation:executor",
  traceId: "trace:executor",
  personaId: "alice",
  subjectUserId: "user-a",
  finalizedAt: "2026-08-12T00:00:00.000Z",
  ingestionRequested: true,
  userMessage: "I prefer concise replies.",
  assistantMessage: "Understood."
};

function provider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    retrieveRelevant: vi.fn(async () => ({
      status: "empty" as const,
      events: [],
      source: "test",
      limited: false
    })),
    getEvent: vi.fn(async () => null),
    writeEvent: vi.fn(async () => ({ status: "rejected" as const })),
    writeEventIdempotent: vi.fn(async () => ({ status: "written" as const, eventId: "mem0:one" })),
    ...overrides
  };
}

describe("shared finalized ingestion executor", () => {
  it("marks dispatch before one idempotent provider call and records the fenced outcome", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository).admit(base);
    const write = vi.fn(
      async (_input: Parameters<NonNullable<MemoryProvider["writeEventIdempotent"]>>[0]) => ({
        status: "written" as const,
        eventId: "mem0:one"
      })
    );
    const result = await executeFinalizedIngestionEvent({
      repository,
      provider: provider({ writeEventIdempotent: write }),
      event: admitted.events[0]!,
      leaseOwner: "worker-a",
      leaseSeconds: 30
    });
    expect(result).toMatchObject({
      claimed: true,
      dispatched: true,
      event: { status: "complete" }
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: admitted.events[0]!.backendIdempotencyKey,
      payloadDigest: admitted.events[0]!.eventPayload.payloadDigest
    });
  });

  it("keeps post-success mapping failure ambiguous and exactly reconcilable", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository).admit(base);
    const effects = new Map<string, string>();
    const submitIdempotent = vi.fn(
      async (input: { idempotencyKey: string; payloadDigest: string }) => {
        effects.set(input.idempotencyKey, input.payloadDigest);
        return {
          memoryId: "stable-memory",
          operation: "created" as const,
          record: {
            id: "stable-memory",
            content: "Understood.",
            scope: "unexpected-scope",
            metadata: {}
          }
        };
      }
    );
    const reconcileIdempotency = vi.fn(
      async (input: { idempotencyKey: string; payloadDigest: string }) =>
        effects.get(input.idempotencyKey) === input.payloadDigest
          ? { status: "applied" as const, memoryId: "stable-memory", operation: "created" }
          : { status: "not_applied" as const }
    );
    const backend = {
      kind: "mem0" as const,
      health: vi.fn(),
      add: vi.fn(),
      search: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      history: vi.fn(),
      submitIdempotent,
      reconcileIdempotency
    } as unknown as MemoryBackend;
    const memoryProvider = new Mem0MemoryProvider(backend);
    const event = admitted.events[0]!;

    const result = await executeFinalizedIngestionEvent({
      repository,
      provider: memoryProvider,
      event,
      leaseOwner: "worker-ambiguous",
      leaseSeconds: 30
    });
    const turn = await repository.getTurn(admitted.turn.finalizedTurnId);
    const persisted = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;

    expect(result.outcome).toMatchObject({
      status: "rejected",
      failureClass: "ambiguous"
    });
    expect(persisted).toMatchObject({
      status: "reconcile_required",
      resultKind: "ambiguous"
    });
    expect(turn?.status).toBe("reconcile_required");
    expect(effects.get(event.backendIdempotencyKey)).toBe(event.eventPayload.payloadDigest);
    await expect(
      memoryProvider.reconcileEvent!({
        idempotencyKey: event.backendIdempotencyKey,
        payloadDigest: event.eventPayload.payloadDigest!
      })
    ).resolves.toMatchObject({ status: "applied", eventId: "mem0:stable-memory" });
    expect(submitIdempotent).toHaveBeenCalledOnce();
  });

  it("fails closed when materialization has no exact payload digest", async () => {
    const sourceRepository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(sourceRepository).admit(base);
    const event = admitted.events[0]!;
    const payload = { ...event.eventPayload };
    delete payload.payloadDigest;
    const repository = new InMemoryFinalizedIngestionRepository();
    await repository.admit({
      turn: admitted.turn,
      events: [
        {
          eventId: event.eventId,
          eventKey: event.eventKey,
          backendIdempotencyKey: event.backendIdempotencyKey,
          eventPayload: payload
        }
      ]
    });
    const persistedEvent = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    const write = vi.fn();
    const result = await executeFinalizedIngestionEvent({
      repository,
      provider: provider({ writeEventIdempotent: write }),
      event: persistedEvent,
      leaseOwner: "worker-a",
      leaseSeconds: 30
    });
    expect(write).not.toHaveBeenCalled();
    expect(result.event).toMatchObject({
      status: "terminal_failed",
      errorCode: "MEMORY_PAYLOAD_DIGEST_MISSING"
    });
  });

  it("fails closed when keyed backend submission is unavailable", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository).admit(base);
    const unsupported = provider();
    delete unsupported.writeEventIdempotent;
    const result = await executeFinalizedIngestionEvent({
      repository,
      provider: unsupported,
      event: admitted.events[0]!,
      leaseOwner: "worker-a",
      leaseSeconds: 30
    });
    expect(result.event).toMatchObject({
      status: "terminal_failed",
      errorCode: "MEMORY_IDEMPOTENCY_UNSUPPORTED"
    });
  });

  it("refuses another dispatch when the durable delivery budget is already consumed", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository).admit({
      ...base,
      finalizedTurnId: "finalized-turn:budget"
    });
    const first = await executeFinalizedIngestionEvent({
      repository,
      provider: provider({
        writeEventIdempotent: vi.fn(async () => ({
          status: "rejected" as const,
          failureClass: "retryable_no_effect" as const,
          errorCode: "MEMORY_BACKEND_UNAVAILABLE"
        }))
      }),
      event: admitted.events[0]!,
      leaseOwner: "worker-a",
      leaseSeconds: 30,
      maxDeliveryAttempts: 1
    });
    expect(first.dispatched).toBe(true);
    expect(first.event?.attemptCount).toBe(1);
    const retry = await executeFinalizedIngestionEvent({
      repository,
      provider: provider(),
      event: (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!,
      leaseOwner: "worker-b",
      leaseSeconds: 30,
      maxDeliveryAttempts: 1
    });
    expect(retry.dispatched).toBe(false);
    expect(retry.event).toMatchObject({
      status: "terminal_failed",
      errorCode: "MEMORY_WRITE_RETRY_EXHAUSTED",
      attemptCount: 1
    });
  });
});
