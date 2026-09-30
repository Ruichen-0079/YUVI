import { describe, expect, it, vi } from "vitest";
import { parent, receipt, readerFor, recordedAt } from "./journal-evidence.test-fixture.js";
import {
  FinalizedIngestionService,
  InMemoryFinalizedIngestionRepository,
  FINALIZED_INGESTION_POLICY_VERSION
} from "./finalized-ingestion-ledger.js";
import { JournalMemoryGroundingResolver, MemoryLineageV1Schema } from "./lineage.js";
import { executeFinalizedIngestionEvent } from "./finalized-ingestion-executor.js";
import { MemoryIngestionCoordinator } from "./memory-ingestion-coordinator.js";
import { canonicalLineageJson, lineageDigest } from "./lineage-encoding.js";
import type { MemoryProvider, MemoryWriteEventInput } from "./provider.js";

const text = "  I prefer tea 🍵.\n";
const base = {
  finalizedTurnId: "finalized:grounded",
  assistantMessageId: "assistant",
  sourceUserEventId: "user",
  conversationId: "conversation",
  traceId: "trace",
  personaId: "persona",
  subjectUserId: "compatibility-person",
  finalizedAt: "2026-10-01T08:00:00.000Z",
  ingestionRequested: true,
  userMessage: text,
  sourceText: text,
  sourceJournalRef: parent,
  assistantMessage: "Understood."
};
function setup(envelope = receipt({ text }), retained: string | null = text) {
  const repository = new InMemoryFinalizedIngestionRepository();
  const resolver = new JournalMemoryGroundingResolver(readerFor(envelope, retained));
  return {
    repository,
    resolver,
    service: new FinalizedIngestionService(repository, undefined, resolver)
  };
}
const provider = (
  write = vi.fn(async () => ({ status: "written" as const, eventId: "mem0:backend-only" }))
): MemoryProvider => ({
  retrieveRelevant: async () => ({ status: "empty", events: [], source: "test", limited: false }),
  getEvent: async () => null,
  writeEvent: write,
  writeEventIdempotent: write
});

describe("A10.1d finalized grounding", () => {
  it.each([
    ["typed HTTP", "ATTRIBUTED_ASSERTION", "USER_INPUT", "USER_ASSERTION"],
    ["real finalized speech", "DIRECT_OBSERVATION", "EXTERNAL_RESULT", "EXTERNAL_OBSERVATION"],
    ["mock speech", "ATTRIBUTED_ASSERTION", "USER_INPUT", "USER_ASSERTION"]
  ] as const)(
    "freezes %s authority and source time before admission",
    async (_label, receiptClass, origin, expectedOrigin) => {
      const { service, repository } = setup(receipt({ text, receiptClass, origin }));
      const admission = await service.admit(base);
      expect(admission.events.length).toBeGreaterThan(0);
      for (const child of admission.events) {
        const lineage = MemoryLineageV1Schema.parse(child.eventPayload.lineage);
        expect(lineage).toMatchObject({
          state: "GROUNDED",
          origin: expectedOrigin,
          parents: [{ ref: parent }],
          authority: {
            principal: { state: "UNRESOLVED" },
            binding: { state: "UNRESOLVED" },
            audience: { kind: "UNKNOWN" }
          },
          sourceTime: { recordedAt, occurrenceTime: { state: "UNKNOWN" } },
          derivation: { kind: "FINALIZED_INGESTION" }
        });
        expect(child.eventPayload.claim).toBeUndefined();
        expect(child.eventPayload.occurredAt).toBeUndefined();
        expect(child.eventPayload.observedAt).toBe(recordedAt);
        expect(
          (await repository.listEvents(base.finalizedTurnId))[0]?.eventPayload.lineage
        ).toEqual(lineage);
      }
    }
  );

  it.each([
    ["missing source", "MEMORY_GROUNDING_MISSING_COMMITTED_SOURCE"],
    ["unknown parent", "MEMORY_GROUNDING_UNKNOWN_JOURNAL_PARENT"],
    ["wrong namespace", "MEMORY_GROUNDING_UNKNOWN_JOURNAL_PARENT"],
    ["malformed ref", "MEMORY_GROUNDING_LINEAGE_VALIDATION_FAILED"],
    ["mismatched text", "MEMORY_GROUNDING_SOURCE_TEXT_MISMATCH"],
    ["not retained", "MEMORY_GROUNDING_SOURCE_PAYLOAD_UNAVAILABLE"],
    ["nonselectable", "MEMORY_GROUNDING_SOURCE_PAYLOAD_UNAVAILABLE"],
    ["missing selector", "MEMORY_GROUNDING_SOURCE_SELECTOR_UNAVAILABLE"],
    ["payload unavailable", "MEMORY_GROUNDING_SOURCE_SELECTOR_UNAVAILABLE"],
    ["control receipt", "MEMORY_GROUNDING_INELIGIBLE_JOURNAL_PARENT"],
    ["wrong parent kind", "MEMORY_GROUNDING_INELIGIBLE_JOURNAL_PARENT"]
  ])("rejects %s before creating any backend child", async (label, code) => {
    const envelope = receipt({ text });
    if (label === "not retained") envelope.authority.payloads[0]!.retention = "NOT_RETAINED";
    if (label === "nonselectable") envelope.authority.payloads[0]!.selectable = false;
    if (label === "missing selector" && envelope.command.kind === "RECEIPT")
      envelope.command.data.evidenceSelectors = [];
    if (label === "control receipt" && envelope.command.kind === "RECEIPT")
      envelope.command.data.receiptClass = "CONTROL";
    if (label === "wrong parent kind")
      (envelope.command as unknown as { kind: string }).kind = "DERIVATION";
    const { service } = setup(envelope, label === "payload unavailable" ? null : text);
    const input = { ...base };
    if (label === "missing source") input.sourceJournalRef = undefined as never;
    if (label === "unknown parent")
      input.sourceJournalRef = { ...parent, eventId: "jev1_bbbbbbbbbbbbbbbb" };
    if (label === "wrong namespace") input.sourceJournalRef = { ...parent, namespace: "other" };
    if (label === "malformed ref") input.sourceJournalRef = { eventId: "not a ref" } as never;
    if (label === "mismatched text") input.sourceText = input.userMessage = "I like astronomy.";
    const result = await service.admit(input);
    expect(result.turn).toMatchObject({
      status: "terminal_failed",
      failureStage: "materialization",
      lastErrorCode: code
    });
    expect(result.events).toEqual([]);
  });

  it("binds the child digest to lineage and delivers frozen payload without reading Journal again", async () => {
    const { service, resolver, repository } = setup();
    const resolve = vi.spyOn(resolver, "resolve");
    const first = await service.admit(base);
    const event = first.events[0]!;
    const { payloadDigest, idempotencyKey: _key, ...payload } = event.eventPayload;
    expect(payloadDigest).toBe(lineageDigest(canonicalLineageJson(payload)));
    expect(event.eventKey).toBe(`event:${payloadDigest}`);
    resolve.mockRejectedValue(new Error("Journal changed/offline"));
    expect(await service.admit(base)).toEqual(first);
    const write = vi.fn(async (_input: MemoryWriteEventInput) => ({
      status: "written" as const,
      eventId: "backend"
    }));
    await executeFinalizedIngestionEvent({
      repository,
      provider: provider(write),
      event,
      leaseOwner: "worker",
      leaseSeconds: 10
    });
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      lineage: event.eventPayload.lineage,
      payloadDigest
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    await expect(
      service.admit({ ...base, sourceJournalRef: { ...parent, eventId: "jev1_bbbbbbbbbbbbbbbb" } })
    ).rejects.toThrow("SOURCE_CONFLICT");
    const other = setup();
    const changedEnvelope = receipt({ text });
    changedEnvelope.authority.binding = { state: "UNRESOLVED", reason: "changed authority" };
    const changed = await setup(changedEnvelope).service.admit(base);
    expect(changed.events[0]!.eventPayload.payloadDigest).not.toBe(payloadDigest);
    expect(
      changed.events[0]!.eventPayload.lineage?.state === "GROUNDED" &&
        changed.events[0]!.eventPayload.lineage.consumerKey
    ).toBe(
      event.eventPayload.lineage?.state === "GROUNDED" && event.eventPayload.lineage.consumerKey
    );
    expect((await other.service.admit(base)).turn.policyVersion).toBe(
      FINALIZED_INGESTION_POLICY_VERSION
    );
  });

  it("terminalizes old pending children without dispatch or ancestry fabrication", async () => {
    const { service, repository } = setup();
    const admission = await service.admit(base);
    const event = admission.events[0]!;
    // Simulate a durable pre-upgrade payload using repository admission, never the grounded service.
    const oldRepo = new InMemoryFinalizedIngestionRepository();
    const oldPayload = { ...event.eventPayload };
    delete oldPayload.lineage;
    const old = await oldRepo.admit({
      turn: { ...admission.turn, policyVersion: "factual-v1/schema-1" },
      events: [{ ...event, eventPayload: oldPayload }]
    });
    const write = vi.fn(async () => ({ status: "written" as const }));
    const result = await executeFinalizedIngestionEvent({
      repository: oldRepo,
      provider: provider(write),
      event: old.events[0]!,
      leaseOwner: "worker",
      leaseSeconds: 10
    });
    expect(result.event).toMatchObject({
      status: "terminal_failed",
      errorCode: "MEMORY_FINALIZED_LINEAGE_MISSING",
      attemptCount: 0
    });
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["grounded", "legacy", "malformed"])(
    "recovers exact persisted user content and %s ancestry",
    async (mode) => {
      const { service, repository } = setup();
      const write = vi.fn(async (_input: MemoryWriteEventInput) => ({
        status: "written" as const,
        eventId: "backend"
      }));
      repository.listMissingAdmissions = async () =>
        (await repository.getTurn(base.finalizedTurnId))
          ? []
          : [
              {
                ...base,
                sourceUserEventId: "user",
                content: base.assistantMessage,
                status: "completed" as const
              }
            ];
      const admit = vi.fn((input) => service.admit(input));
      const coordinator = new MemoryIngestionCoordinator({
        repository,
        provider: provider(write),
        admit,
        conversation: {
          getMessageById: async (id) =>
            id === "user"
              ? {
                  role: "user",
                  content: text,
                  sourceJournalRef:
                    mode === "grounded"
                      ? parent
                      : mode === "legacy"
                        ? null
                        : ({ eventId: "bad" } as never)
                }
              : null
        }
      });
      await coordinator.drain();
      expect(admit.mock.calls[0]?.[0]).toMatchObject({ userMessage: text, sourceText: text });
      expect(write).toHaveBeenCalledTimes(mode === "grounded" ? 1 : 0);
      expect((await repository.getTurn(base.finalizedTurnId))?.status).toBe(
        mode === "grounded" ? "complete" : "terminal_failed"
      );
      if (mode === "grounded") {
        const live = await setup().service.admit(base);
        expect((await repository.listEvents(base.finalizedTurnId))[0]?.eventPayload).toEqual(
          live.events[0]?.eventPayload
        );
      }
    }
  );
});
