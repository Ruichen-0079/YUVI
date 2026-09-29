import { describe, expect, it } from "vitest";
import {
  AssistantMessagePayloadSchema,
  EventTypeSchema,
  RuntimeEventSchema,
  TurnOriginSchema,
  UserMessagePayloadSchema,
  UserVoiceTranscriptPayloadSchema,
  createEvent
} from "./index.js";

describe("committed Journal ancestry Runtime carriers", () => {
  it("accepts a typed JournalEventRef on user and finalized-speech payloads", () => {
    const sourceJournalRef = {
      kind: "JOURNAL_EVENT" as const,
      namespace: "journal:local",
      eventId: "jev1_0123456789abcdef"
    };
    expect(
      UserMessagePayloadSchema.parse({
        sessionId: "session-1",
        content: "hello",
        sourceJournalRef
      }).sourceJournalRef
    ).toEqual(sourceJournalRef);
    expect(
      UserVoiceTranscriptPayloadSchema.parse({
        sessionId: "session-1",
        content: "hello",
        sourceJournalRef
      }).sourceJournalRef
    ).toEqual(sourceJournalRef);
    expect(
      UserMessagePayloadSchema.safeParse({
        sessionId: "session-1",
        content: "hello",
        sourceJournalRef: { ...sourceJournalRef, eventId: "runtime-event-id" }
      }).success
    ).toBe(false);
  });
});

describe("assistant-origin protocol metadata", () => {
  it("accepts the canonical assistant-initiated origin and idempotency metadata", () => {
    expect(TurnOriginSchema.parse("assistant-initiated")).toBe("assistant-initiated");
    expect(
      AssistantMessagePayloadSchema.parse({
        sessionId: "session-1",
        content: "hello",
        turnOrigin: "assistant-initiated",
        idempotencyKey: "decision-1",
        decisionId: "decision-uuid",
        activityRevision: 3
      })
    ).toMatchObject({
      turnOrigin: "assistant-initiated",
      idempotencyKey: "decision-1",
      decisionId: "decision-uuid",
      activityRevision: 3
    });
  });
});

describe("Phase 7P embodied effect Runtime event type", () => {
  it("admits the canonical Runtime-owned embodied effect event type", () => {
    expect(EventTypeSchema.parse("runtime.embodied.effect")).toBe("runtime.embodied.effect");

    const event = createEvent(
      "runtime.embodied.effect",
      { effectId: "runtime-effect:7g:1" },
      { traceId: "turn-1" }
    );

    expect(event.type).toBe("runtime.embodied.effect");
    expect(event.traceId).toBe("turn-1");
    expect(RuntimeEventSchema.parse(event)).toEqual(event);
  });

  it("does not broaden the event type to arbitrary embodied or Presentation-owned names", () => {
    expect(EventTypeSchema.safeParse("presentation.embodied.effect").success).toBe(false);
    expect(EventTypeSchema.safeParse("runtime.embodied.render").success).toBe(false);
  });
});
