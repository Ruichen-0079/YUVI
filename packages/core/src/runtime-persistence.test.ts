import { FinalizedIngestionService } from "../../memory/src/finalized-test-fixture.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  LocalControllerEvidenceProvider,
  InMemoryConversationRepository,
  InMemoryFinalizedIngestionRepository,
  type ConversationMessageInput,
  type MemoryConversationTurnWriteResult,
  type MemoryWriteEventInput
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  ProviderError,
  ProviderErrorCode,
  FallbackChatProvider,
  createMockAssistantContinuationProvider,
  type ChatStreamEvent,
  type ChatOutput,
  type ChatProvider,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockStreamingChatProvider as createRawMockStreamingChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider,
  type ChatInput,
  type ChatStreamOptions,
  type STTOutput,
  type MockStreamingChatProviderOptions
} from "@companion/providers";
import {
  createEvent,
  type JournalCommittedEnvelope,
  type JournalEventRef,
  type RuntimeEvent
} from "@companion/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeOrchestrator,
  createFileVoiceBindingReferences,
  type RuntimeMemoryPort,
  type RuntimeReplyStreamEvent
} from "./index.js";

const temporaryRoots: string[] = [];
afterEach(() => temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

let testSpeechReceiptSequence = 0;
function admitSpeechForTest(
  runtime: RuntimeOrchestrator,
  observation: STTOutput,
  options: { sessionId?: string; captureEpoch?: string } = {}
): STTOutput {
  return admitSpeechForTestWithJournalRef(runtime, observation, options).observation;
}

function admitSpeechForTestWithJournalRef(
  runtime: RuntimeOrchestrator,
  observation: STTOutput,
  options: { sessionId?: string; captureEpoch?: string } = {}
): { observation: STTOutput; journalRef: JournalEventRef } {
  const reservation = runtime.reserveFinalizedSpeechObservation(observation, options);
  const sequence = ++testSpeechReceiptSequence;
  const journalRef: JournalEventRef = {
    kind: "JOURNAL_EVENT",
    namespace: "test:speech",
    eventId: `jev1_${String(sequence).padStart(16, "0")}`
  };
  const receipt = {
    version: "life-event-envelope.v1",
    eventId: journalRef.eventId,
    journalNamespace: journalRef.namespace,
    commitSeq: sequence,
    recordedAt: "2026-09-25T00:00:00.000Z",
    command: {
      version: "life-event-command.v1",
      kind: "RECEIPT",
      occurrenceTime: { state: "UNKNOWN" },
      causalParents: [],
      data: { receiptClass: "DIRECT_OBSERVATION", evidenceSelectors: [] }
    },
    authority: {
      journalNamespace: "test:speech",
      principal: { state: "UNRESOLVED", reason: "test fixture" },
      subjects: [],
      binding: { state: "UNRESOLVED", reason: "test fixture" },
      surface: { kind: "LOCAL", reference: "test" },
      correlations: [
        { kind: "CONVERSATION", sessionId: reservation.sessionId },
        {
          kind: "VOICE_OBSERVATION",
          observationId: reservation.observation.observationId,
          captureEpoch: reservation.captureEpoch
        }
      ],
      audience: { kind: "UNKNOWN", reason: "test fixture" },
      disclosurePolicy: { state: "UNRESOLVED", reason: "test fixture" },
      policyVersion: "test.v1",
      producer: { name: "test", version: "1" },
      sourceReferences: [
        {
          kind: "VOICE_OBSERVATION",
          observationId: reservation.observation.observationId,
          captureEpoch: reservation.captureEpoch
        }
      ],
      payloads: []
    }
  } as JournalCommittedEnvelope;
  const finalized = runtime.finalizeSpeechReservation(reservation.token, receipt);
  if (finalized.status !== "ready")
    throw new Error(`Test speech did not become ready: ${finalized.status}`);
  return { observation: finalized.observation, journalRef };
}

async function collectRuntimeStream(
  stream: AsyncIterable<RuntimeReplyStreamEvent>,
  onEvent?: (event: RuntimeReplyStreamEvent) => void
): Promise<RuntimeReplyStreamEvent[]> {
  const events: RuntimeReplyStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value);
    },
    reject(reason?: unknown): void {
      rejectPromise?.(reason);
    }
  };
}

describe("RuntimeOrchestrator", () => {
  it("persists a host-carried Journal receipt ref separately from Runtime message identity", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async () => completeMemoryWrite()),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const sourceJournalRef: JournalEventRef = {
      kind: "JOURNAL_EVENT",
      namespace: "test:ordinary-conversation",
      eventId: "jev1_0123456789abcdef"
    };
    const event = createEvent(
      "user.message",
      { sessionId: "ancestry-user-turn", content: "hello", sourceJournalRef },
      { id: "runtime-user-event-distinct-from-journal" }
    );

    await runtime.handleUserMessage(event, { readMemory: false, writeMemory: false });

    const user = await conversation.getMessageById(event.id);
    const assistant = await conversation.getMessageById(`assistant:${event.id}`);
    expect(user).toMatchObject({
      id: event.id,
      role: "user",
      sourceJournalRef,
      sourceUserEventId: null
    });
    expect(user?.id).not.toBe(sourceJournalRef.eventId);
    expect(assistant).toMatchObject({
      role: "assistant",
      sourceUserEventId: event.id
    });
    expect(assistant?.sourceJournalRef).toBeNull();
  });

  it.each([false, true])(
    "passes exact host ancestry and source text into finalized admission (stream=%s)",
    async (stream) => {
      const ledger = new InMemoryFinalizedIngestionRepository();
      const service = new FinalizedIngestionService(ledger);
      const admit = vi.spyOn(service, "admit");
      const sourceJournalRef: JournalEventRef = {
        kind: "JOURNAL_EVENT",
        namespace: "host:opaque",
        eventId: "jev1_0123456789abcdef"
      };
      const input = {
        sessionId: "exact-source",
        content: "  I prefer tea 🍵.\n",
        sourceJournalRef,
        personaId: "alice",
        subjectUserId: "compat-only"
      };
      const runtime = createDeliveryRuntime({
        eventBus: new InMemoryEventBus({ development: false }),
        memory: createMem0RecordingMemory(async () => completeMemoryWrite()),
        finalizedIngestion: service,
        promptBuilder: new PromptBuilder(),
        providers: createMockProviders()
      });
      if (stream) await collectRuntimeStream(runtime.streamUserMessage(input));
      else await runtime.handleUserMessage(input);
      await runtime.sealAndDrainMemoryWrites();
      expect(admit).toHaveBeenCalledTimes(1);
      expect(admit.mock.calls[0]?.[0]).toMatchObject({
        sourceJournalRef,
        sourceText: input.content,
        userMessage: input.content
      });
      const events = await ledger.listEvents(admit.mock.calls[0]![0].finalizedTurnId);
      expect(events[0]?.eventPayload.lineage).toMatchObject({
        state: "GROUNDED",
        parents: [{ ref: sourceJournalRef }]
      });
    }
  );

  it("keeps unresolved committed speech out of non-streaming finalized ingestion even when writes are requested", async () => {
    const conversation = new InMemoryConversationRepository();
    const ledger = new InMemoryFinalizedIngestionRepository();
    const notifyAdmitted = vi.fn();
    const store = vi.fn(async () => completeMemoryWrite());
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(store),
      conversation,
      finalizedIngestion: new FinalizedIngestionService(ledger),
      memoryIngestionCoordinator: { notifyAdmitted, wake() {} },
      voicePersonaId: "alice",
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const observation = admitSpeechForTest(
      runtime,
      {
        text: "Remember my private preference.",
        voiceProfileMatch: { status: "NO_MATCH" }
      },
      { sessionId: "unresolved-write" }
    );
    const event = runtime.commitSpeechTurn(
      observation.observationId!,
      "unresolved-write",
      observation.text
    );
    await runtime.handleUserMessage(event, { readMemory: true, writeMemory: true });
    await runtime.sealAndDrainMemoryWrites();
    const assistant = await conversation.getMessageById(`assistant:${event.id}`);
    expect(assistant).toMatchObject({ subjectUserId: null, ingestionRequested: false });
    expect((await conversation.getMessageById(event.id))?.metadata).toMatchObject({
      memoryWriteDisabled: true
    });
    expect(notifyAdmitted).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("admits an explicit voice interaction through the durable user-turn and finalized-ingestion flow", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const ledger = new InMemoryFinalizedIngestionRepository();
    const admissions: string[] = [];
    const memory = createMem0RecordingMemory(async () => completeMemoryWrite());
    const ownerRoot = mkdtempSync(join(tmpdir(), "yuvi-runtime-persistence-binding-"));
    temporaryRoots.push(ownerRoot);
    const bindingOwner = new LocalControllerEvidenceProvider(ownerRoot);
    memory.getNativeVoiceBindingOwner = () => bindingOwner;
    const nativeBindingCommand = {
      commandHandle: "runtime-persistence-binding",
      intentId: "runtime-persistence-binding-intent",
      attemptId: "runtime-persistence-binding-attempt",
      fence: "1",
      payloadDigest: "b".repeat(64),
      causalRefs: [{ kind: "JOURNAL_EVENT" as const, namespace: "test:control", eventId: "control-binding" }],
      operation: "ASSIGN" as const,
      voiceProfileId: "voice-a",
      personaId: "alice",
      personId: "user-a",
      expectedBindingRevision: null
    };
    expect(await bindingOwner.fenceBindingCommand(nativeBindingCommand)).toBe("READY");
    expect((await bindingOwner.applyBindingCommand(nativeBindingCommand)).status).toBe("APPLIED");
    const runtime = createDeliveryRuntime({
      eventBus,
      memory,
      voicePersonaId: "alice",
      voiceBindingReferences: createFileVoiceBindingReferences(join(ownerRoot, "voice-binding-references.json")),
      conversation,
      finalizedIngestion: new FinalizedIngestionService(ledger),
      memoryIngestionCoordinator: {
        async notifyAdmitted(admission) {
          admissions.push(admission.turn.finalizedTurnId);
        },
        wake() {}
      },
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    // Runtime consumes the current native binding and the committed acoustic receipt through P8.
    expect(await runtime.bindVoiceProfileToPerson("voice-a", "user-a")).toMatchObject({
      status: "GOVERNED_COMMAND_REQUIRED"
    });
    const { observation, journalRef } = admitSpeechForTestWithJournalRef(
      runtime,
      {
        text: "I prefer concise replies.",
        language: "en",
        confidence: 1,
        voiceProfileMatch: { status: "MATCHED", voiceProfileId: "voice-a" }
      },
      { sessionId: "voice-durable-session" }
    );
    const transcriptEvent = runtime.commitSpeechTurn(
      observation.observationId!,
      "voice-durable-session",
      observation.text
    );
    const reply = await runtime.handleUserMessage(transcriptEvent);
    await runtime.drainMemoryWrites();

    const transcript = published.find((event) => event.type === "user.voice.transcript");
    const user = transcript ? await conversation.getMessageById(transcript.id) : null;
    const assistant = transcript
      ? await conversation.getMessageById(`assistant:${transcript.id}`)
      : null;
    const turn = assistant?.finalizedTurnId
      ? await ledger.getTurn(assistant.finalizedTurnId)
      : null;

    expect(reply!.payload.content).toBeTruthy();
    expect(transcript).toMatchObject({
      type: "user.voice.transcript",
      payload: {
        sessionId: "voice-durable-session",
        content: "I prefer concise replies.",
        sourceJournalRef: journalRef,
        language: "en",
        personaId: "alice",
        subjectUserId: "user-a"
      }
    });
    expect(user).toMatchObject({
      role: "user",
      status: "completed",
      content: "I prefer concise replies.",
      sourceJournalRef: journalRef,
      sourceUserEventId: null,
      personaId: "alice",
      subjectUserId: "user-a",
      metadata: {
        modality: "voice",
        language: "en",
        confidence: 1,
        createdByUserId: "user-a",
        speakerId: "user-a",
        voiceProfileId: "voice-a"
      }
    });
    expect(assistant).toMatchObject({
      role: "assistant",
      status: "completed",
      sourceUserEventId: transcript?.id,
      personaId: "alice",
      subjectUserId: "user-a",
      ingestionRequested: true
    });
    expect(assistant?.sourceJournalRef).toBeNull();
    expect(assistant?.finalizedTurnId).toBeTruthy();
    expect(turn?.status).toBe("pending");
    expect(
      (await ledger.listEvents(assistant!.finalizedTurnId!))[0]?.eventPayload.lineage
    ).toMatchObject({ state: "GROUNDED", parents: [{ ref: journalRef }] });
    expect(admissions).toEqual([assistant?.finalizedTurnId]);
    expect(published.some((event) => event.type === "agent.reply")).toBe(true);
    expect(published.some((event) => event.type === "assistant.message")).toBe(true);
  });

  it("returns speech observations without admitting a user turn", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const memoryWrites: unknown[] = [];
    const conversation = new RecordingConversationRepository();
    const runtime = createDeliveryRuntime({
      eventBus,
      memory: createMem0RecordingMemory(async (input) => {
        memoryWrites.push(input);
        return completeMemoryWrite();
      }),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const observation = await runtime.transcribeSpeechAudio({
      audioBase64: "AQID",
      language: "en",
      metadata: { mockTranscription: "I prefer concise replies." }
    });
    await runtime.drainMemoryWrites();

    expect(observation.text).toBe("I prefer concise replies.");
    expect(observation.language).toBe("en");
    // An observation is not an interaction: nothing is admitted, persisted,
    // replied to, or ingested into Memory.
    const admittedEventTypes = new Set([
      "user.message",
      "user.voice.transcript",
      "agent.reply",
      "assistant.message"
    ]);
    expect(published.filter((event) => admittedEventTypes.has(event.type))).toEqual([]);
    expect(conversation.appendedMessages).toEqual([]);
    expect(memoryWrites).toEqual([]);
  });

  it("evicts a rejected finalized-admission promise while retaining successful dedupe", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const ledger = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(ledger);
    const originalAdmit = service.admit.bind(service);
    const admit = vi.spyOn(service, "admit");
    admit
      .mockRejectedValueOnce(new Error("transient admission outage"))
      .mockImplementation((input) => originalAdmit(input));
    const runtime = createDeliveryRuntime({
      eventBus,
      memory: createMem0RecordingMemory(async () => completeMemoryWrite()),
      finalizedIngestion: service,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const admissionInput = finalizedStatusAdmission("retry-admission");
    const ensure = (
      runtime as unknown as {
        ensureFinalizedAdmission(
          input: ReturnType<typeof finalizedStatusAdmission>
        ): Promise<unknown>;
      }
    ).ensureFinalizedAdmission.bind(runtime);

    await expect(ensure(admissionInput)).rejects.toThrow("transient admission outage");
    await expect(ensure(admissionInput)).resolves.toBeTruthy();
    await expect(ensure(admissionInput)).resolves.toBeTruthy();
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it("evicts a rejected finalized-turn lookup while retaining the successful identity", async () => {
    const conversation = new InMemoryConversationRepository();
    const originalLookup = conversation.getMessageById.bind(conversation);
    let lookups = 0;
    conversation.getMessageById = async (messageId) => {
      lookups += 1;
      if (lookups === 1) {
        throw new Error("transient conversation lookup outage");
      }
      return originalLookup(messageId);
    };
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async () => completeMemoryWrite()),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const event = createEvent("user.message", {
      sessionId: "retry-finalized-id-session",
      content: "hello"
    });

    await expect(
      runtime.handleUserMessage(event, { readMemory: false, writeMemory: false })
    ).rejects.toThrow("transient conversation lookup outage");
    await expect(
      runtime.handleUserMessage(event, { readMemory: false, writeMemory: false })
    ).resolves.toBeTruthy();
    await expect(
      runtime.handleUserMessage(event, { readMemory: false, writeMemory: false })
    ).resolves.toBeTruthy();
    expect(lookups).toBe(2);
  });

  it("fails closed when finalized Mem0 has no durable admission port", async () => {
    const store = vi.fn(async () => completeMemoryWrite());
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(store),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await runtime.handleUserMessage({
      sessionId: "no-ledger",
      content: "I prefer concise replies."
    });
    await runtime.drainMemoryWrites();
    expect(store).not.toHaveBeenCalled();
    expect(runtime.getLatestPromptPreview()).toMatchObject({ memoryWriteStatus: "failed" });
  });

  it("bounds completed runtime cache entries and expires inactive session state", async () => {
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async () => completeMemoryWrite()),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    for (let index = 0; index < 300; index += 1) {
      await runtime.handleUserMessage(
        { sessionId: `bounded-session-${index}`, content: `turn-${index}` },
        { readMemory: false, writeMemory: false }
      );
    }

    expect(runtime.getRuntimeCacheStats()).toMatchObject({
      sessionTurns: 256,
      finalizedTurnIds: 256,
      finalizedMemoryWrites: 0,
      finalizedAdmissions: 256
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1);
      await runtime.handleUserMessage(
        { sessionId: "ttl-session", content: "ttl" },
        { readMemory: false, writeMemory: false }
      );
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      expect(runtime.getRuntimeCacheStats()).toMatchObject({
        sessionTurns: 0,
        finalizedTurnIds: 0
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks one finalized non-stream Mem0 write with canonical IDs", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const writes: Array<Record<string, unknown>> = [];
    const memory = createMem0RecordingMemory(async (input) => {
      writes.push(input);
      return completeMemoryWrite(
        typeof input["idempotencyKey"] === "string" ? input["idempotencyKey"] : undefined
      );
    });
    const runtime = createDeliveryRuntime({
      eventBus,
      memory,
      conversation: new InMemoryConversationRepository(),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "non-stream-finalized",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    const assistant = published.find((event) => event.type === "assistant.message");
    expect(assistant?.id).toBe(
      `assistant:${published.find((event) => event.type === "user.message")?.id}`
    );
    expect(published.find((event) => event.type === "agent.reply")?.id).toBe(
      `reply:${published.find((event) => event.type === "user.message")?.id}`
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      assistantMessageId: assistant?.id,
      idempotencyKey: expect.stringMatching(/^yuvi:finalized-turn:/),
      assistantMessage: reply!.payload.content
    });
    expect(runtime.getLatestPromptPreview()).toMatchObject({ memoryWriteStatus: "partial" });
  });

  it("admits finalized memory through the ledger before publishing the assistant event", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const providerWrites: MemoryWriteEventInput[] = [];
    const memory = createMem0RecordingMemory(async () => completeMemoryWrite());
    memory.getMemoryProvider = () => ({
      async retrieveRelevant() {
        return { status: "empty", events: [], source: "test", limited: false };
      },
      async getEvent() {
        return null;
      },
      async writeEvent(input) {
        providerWrites.push(input);
        return { status: "written", eventId: "memory:ledger-test" };
      },
      async writeEventIdempotent(input) {
        providerWrites.push(input);
        return { status: "written", eventId: "memory:ledger-test" };
      }
    });
    const conversation = new InMemoryConversationRepository();
    const ledger = new InMemoryFinalizedIngestionRepository();
    const runtime = createDeliveryRuntime({
      eventBus,
      memory,
      conversation,
      finalizedIngestion: new FinalizedIngestionService(ledger),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "ledger-runtime-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    const sourceUserEventId = reply!.parentId;
    const assistant = await conversation.getMessageById(`assistant:${sourceUserEventId}`);
    const turn = assistant?.finalizedTurnId
      ? await ledger.getTurn(assistant.finalizedTurnId)
      : null;
    expect(assistant?.finalizedTurnId).toBeTruthy();
    expect(turn?.status).toBe("complete");
    expect(providerWrites).toHaveLength(1);
    expect(
      providerWrites[0]?.idempotencyKey?.startsWith(
        `yuvi:finalized-turn:${assistant?.finalizedTurnId}:event:`
      )
    ).toBe(true);
    expect(published.findIndex((event) => event.type === "assistant.message")).toBeGreaterThan(
      published.findIndex((event) => event.type === "agent.reply")
    );
  });

  it("keeps assistant success independent when ledger materialization fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const ledger = new InMemoryFinalizedIngestionRepository();
    const runtime = createDeliveryRuntime({
      eventBus,
      memory: createMem0RecordingMemory(async () => completeMemoryWrite()),
      conversation: new InMemoryConversationRepository(),
      finalizedIngestion: new FinalizedIngestionService(ledger, {
        async build() {
          throw new Error("policy build failed");
        }
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await runtime.handleUserMessage({
      sessionId: "materialization-failure-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    expect(published.some((event) => event.type === "assistant.message")).toBe(true);
    expect(published.some((event) => event.type === "runtime.error")).toBe(true);
    expect(await ledger.listNonTerminalTurns()).toEqual([]);
  });

  it("submits every persisted child from a successful multi-event live turn", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const providerWrites: MemoryWriteEventInput[] = [];
    const memory = createMem0RecordingMemory(async () => completeMemoryWrite());
    memory.getMemoryProvider = () => ({
      async retrieveRelevant() {
        return { status: "empty", events: [], source: "test", limited: false };
      },
      async getEvent() {
        return null;
      },
      async writeEvent(input) {
        providerWrites.push(input);
        return { status: "written", eventId: `memory:${providerWrites.length}` };
      },
      async writeEventIdempotent(input) {
        providerWrites.push(input);
        return { status: "written", eventId: `memory:${providerWrites.length}` };
      }
    });
    const ledger = new InMemoryFinalizedIngestionRepository();
    const conversation = new InMemoryConversationRepository();
    const runtime = createDeliveryRuntime({
      eventBus,
      memory,
      conversation,
      finalizedIngestion: new FinalizedIngestionService(ledger, {
        async build() {
          return {
            turnKind: "normal" as const,
            events: [
              {
                kind: "fact" as const,
                content: "The user prefers concise replies.",
                scope: "user:user-a:persona:alice",
                metadata: {}
              },
              {
                kind: "fact" as const,
                content: "The user prefers written examples.",
                scope: "user:user-a:persona:alice",
                metadata: {}
              }
            ]
          };
        }
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "multi-event-live-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    const assistant = await conversation.getMessageById(`assistant:${reply!.parentId}`);
    expect(assistant?.role).toBe("assistant");
    const turns = await ledger.listNonTerminalTurns();
    expect(providerWrites).toHaveLength(2);
    expect(new Set(providerWrites.map((input) => input.idempotencyKey)).size).toBe(2);
    expect(turns).toEqual([]);
    expect(reply!.parentId).toBeTruthy();
  });

  it("keeps a durable reconcile_required child out of complete status on re-entry", async () => {
    const fixture = await createFinalizedStatusFixture("reconcile", 1);
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[0]!,
      {
        status: "ambiguous",
        errorCode: "MEMORY_WRITE_AMBIGUOUS"
      }
    );

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "partial", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
    expect((await fixture.repository.getTurn(fixture.turnId))?.status).toBe("reconcile_required");
  });

  it("keeps a durable processing child out of complete status on re-entry", async () => {
    const fixture = await createFinalizedStatusFixture("processing", 1);
    await fixture.repository.claimEvent({
      finalizedTurnId: fixture.turnId,
      eventId: fixture.admitted.events[0]!.eventId,
      leaseOwner: "live-owner",
      leaseSeconds: 300,
      expectedVersion: fixture.admitted.events[0]!.version
    });

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "partial", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
  });

  it("keeps a partial parent with one reconcile child out of complete status", async () => {
    const fixture = await createFinalizedStatusFixture("partial", 2);
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[0]!,
      {
        status: "written",
        eventId: "memory:complete-child"
      }
    );
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[1]!,
      {
        status: "ambiguous",
        errorCode: "MEMORY_WRITE_AMBIGUOUS"
      }
    );

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "partial", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
    expect((await fixture.repository.getTurn(fixture.turnId))?.status).toBe("reconcile_required");
  });

  it("keeps terminal_failed out of successful status", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const turnId = "finalized-turn:terminal";
    const admitted = await service.admit({
      ...finalizedStatusAdmission(turnId),
      personaId: null,
      ingestionRequested: true
    });
    const fixture = { repository, service, admitted, turnId };

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "failed", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
  });

  it("keeps a not-due retryable child out of complete status", async () => {
    const fixture = await createFinalizedStatusFixture("retryable", 1);
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[0]!,
      {
        status: "retryable_failed",
        errorCode: "MEMORY_WRITE_RETRYABLE_FAILED",
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString()
      }
    );

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "partial", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
  });

  it("keeps true durable complete status successful on re-entry", async () => {
    const fixture = await createFinalizedStatusFixture("complete", 1);
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[0]!,
      {
        status: "written",
        eventId: "memory:complete"
      }
    );

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "complete", ok: true });
  });

  it("deduplicates same finalized turn re-entry and drains delayed ingestion", async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Array<Record<string, unknown>> = [];
    const eventBus = new InMemoryEventBus({ development: false });
    const memory = createMem0RecordingMemory(async (input) => {
      calls.push(input);
      await delayed;
      return completeMemoryWrite(
        typeof input["idempotencyKey"] === "string" ? input["idempotencyKey"] : undefined
      );
    });
    const runtime = createDeliveryRuntime({
      eventBus,
      memory,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const userEvent = createEvent("user.message", {
      sessionId: "reentry-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });

    const first = runtime.handleUserMessage(userEvent);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = runtime.handleUserMessage(userEvent);
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);

    let drained = false;
    const drain = runtime.drainMemoryWrites().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await drain;
    expect(runtime.getLatestPromptPreview()).toMatchObject({ memoryWriteStatus: "partial" });
  });

  it("seals an in-flight runtime before reload and drains its late finalized write", async () => {
    let releaseReply!: () => void;
    const replyRelease = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    let replyPublished!: () => void;
    const replyEntered = new Promise<void>((resolve) => {
      replyPublished = resolve;
    });
    let releaseWrite!: () => void;
    const writeRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const writes: Array<Record<string, unknown>> = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("agent.reply", async () => {
      replyPublished();
      await replyRelease;
    });
    const runtime = createDeliveryRuntime({
      eventBus,
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        writeStarted();
        await writeRelease;
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const request = runtime.handleUserMessage({
      sessionId: "reload-race-session",
      content: "I prefer concise replies."
    });
    await replyEntered;
    const reload = runtime.sealAndDrainMemoryWrites();
    await Promise.resolve();
    expect(runtime.getLifecycleState()).toBe("sealing");
    expect(writes).toHaveLength(0);

    let reloaded = false;
    void reload.then(() => {
      reloaded = true;
    });
    releaseReply();
    await writeEntered;
    expect(writes).toHaveLength(1);
    expect(reloaded).toBe(false);
    releaseWrite();
    await expect(request).resolves.toMatchObject({ type: "agent.reply" });
    await reload;
    expect(reloaded).toBe(true);
    expect(runtime.getLifecycleState()).toBe("disposed");
    expect(writes).toHaveLength(1);
    await expect(runtime.drainMemoryWrites()).resolves.toEqual([]);
    await expect(
      runtime.handleUserMessage({
        sessionId: "replaced-runtime-session",
        content: "This runtime has been replaced."
      })
    ).rejects.toThrow("disposed");
  });

  it("lifecycle-guards direct maybeStoreMemory calls while active", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const { sourceEvent, reply } = createDirectMemoryTurn("direct-active-session");

    await expect(
      runtime.maybeStoreMemory(sourceEvent, reply, { readMemory: false, writeMemory: true })
    ).resolves.toMatchObject({ memoryWriteStatus: "complete" });
    expect(writes).toHaveLength(1);
    expect(runtime.getLifecycleState()).toBe("active");
  });

  it("waits for a direct maybeStoreMemory call that entered before sealing", async () => {
    let releaseWrite!: () => void;
    const writeRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const writes: Array<Record<string, unknown>> = [];
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        writeStarted();
        await writeRelease;
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const { sourceEvent, reply } = createDirectMemoryTurn("direct-seal-session");

    const directWrite = runtime.maybeStoreMemory(sourceEvent, reply);
    await writeEntered;
    const seal = runtime.sealAndDrainMemoryWrites();
    let sealed = false;
    void seal.then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(runtime.getLifecycleState()).toBe("sealing");
    expect(sealed).toBe(false);
    expect(writes).toHaveLength(1);

    releaseWrite();
    await expect(directWrite).resolves.toMatchObject({ memoryWriteStatus: "complete" });
    await seal;
    expect(sealed).toBe(true);
    expect(runtime.getLifecycleState()).toBe("disposed");
    expect(writes).toHaveLength(1);
    await expect(runtime.drainMemoryWrites()).resolves.toEqual([]);
  });

  it("rejects direct maybeStoreMemory calls after sealing begins", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const { sourceEvent, reply } = createDirectMemoryTurn("direct-sealing-session");

    const seal = runtime.sealAndDrainMemoryWrites();
    await expect(runtime.maybeStoreMemory(sourceEvent, reply)).rejects.toThrow("sealing");
    expect(writes).toHaveLength(0);
    await seal;
    expect(runtime.getLifecycleState()).toBe("disposed");
  });

  it("rejects direct maybeStoreMemory calls after disposal", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const { sourceEvent, reply } = createDirectMemoryTurn("direct-disposed-session");

    await runtime.sealAndDrainMemoryWrites();
    await expect(runtime.maybeStoreMemory(sourceEvent, reply)).rejects.toThrow("disposed");
    expect(writes).toHaveLength(0);
    await expect(runtime.drainMemoryWrites()).resolves.toEqual([]);
  });

  it("writes semantic memory once only after a successful stream finalizes", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        calls.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", { chunks: ["first", "second"] })
      }
    });
    const iterator = runtime
      .streamUserMessage(
        { sessionId: "stream-memory-session", content: "I prefer concise replies." },
        { readMemory: false, writeMemory: true }
      )
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text-delta", text: "first" }
    });
    expect(calls).toHaveLength(0);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text-delta", text: "second" }
    });
    const completed = await iterator.next();
    expect(completed.value).toMatchObject({ type: "completed", content: "firstsecond" });
    await runtime.drainMemoryWrites();
    expect(calls).toHaveLength(1);
    expect(runtime.getLatestPromptPreview()).toMatchObject({ memoryWriteStatus: "partial" });
  });

  it("performs one finalized ingestion after provider fallback before output", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const failing = createMockStreamingChatProvider("primary", {
      failBeforeFirst: new ProviderError({
        provider: "primary",
        capability: "chat",
        code: ProviderErrorCode.ProviderUnavailable,
        message: "primary unavailable"
      })
    });
    const runtime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        calls.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          new FallbackChatProvider([
            failing,
            createMockStreamingChatProvider("backup", { chunks: ["ok"] })
          ])
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "fallback-memory-session", content: "I prefer concise replies." },
        { readMemory: false, writeMemory: true }
      )
    );
    await runtime.drainMemoryWrites();
    expect(events.at(-1)).toMatchObject({ type: "completed", content: "ok" });
    expect(calls).toHaveLength(1);
  });

  it("does not ingest partial or cancelled streams", async () => {
    const partialCalls: Array<Record<string, unknown>> = [];
    const partialRuntime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        partialCalls.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("primary", {
            chunks: ["partial", "ignored"],
            failAfterChunks: 1,
            failAfter: new ProviderError({
              provider: "primary",
              capability: "chat",
              code: ProviderErrorCode.NetworkError,
              message: "stream interrupted"
            })
          })
      }
    });
    await expect(
      collectRuntimeStream(
        partialRuntime.streamUserMessage(
          { sessionId: "partial-memory-session", content: "I prefer concise replies." },
          { readMemory: false, writeMemory: true }
        )
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.NetworkError });
    expect(partialCalls).toHaveLength(0);

    const cancellationCalls: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const cancellationRuntime = createDeliveryRuntime({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        cancellationCalls.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", { chunks: ["first", "second"], delayMs: 5 })
      }
    });
    const iterator = cancellationRuntime
      .streamUserMessage(
        { sessionId: "cancelled-memory-session", content: "I prefer concise replies." },
        { signal: controller.signal, readMemory: false, writeMemory: true }
      )
      [Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(cancellationCalls).toHaveLength(0);
  });

  it("ingests once when cancellation arrives after assistant finalization", async () => {
    const controller = new AbortController();
    const writes: Array<Record<string, unknown>> = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("assistant.message", () => {
      controller.abort();
    });
    const runtime = createDeliveryRuntime({
      eventBus,
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["final"] })
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "late-cancel-session", content: "I prefer concise replies." },
        { signal: controller.signal, readMemory: false, writeMemory: true }
      )
    );
    await runtime.drainMemoryWrites();

    expect(events.at(-1)).toMatchObject({ type: "completed", content: "final" });
    expect(writes).toHaveLength(1);
  });

  it("keeps assistant success distinct from a finalized memory failure", async () => {
    const diagnostics: RuntimeEvent[] = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("runtime.error", (event) => {
      diagnostics.push(event);
    });
    const runtime = createDeliveryRuntime({
      eventBus,
      memory: createMem0RecordingMemory(async () => {
        throw new Error("Mem0 unavailable");
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "memory-failure-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    expect(reply!.type).toBe("agent.reply");
    expect(runtime.getLatestPromptPreview()).toMatchObject({ memoryWriteStatus: "partial" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.payload).toMatchObject({
      category: "memory",
      operation: "finalized_turn_ingestion"
    });
  });
});

function completeMemoryWrite(idempotencyKey?: string): MemoryConversationTurnWriteResult {
  return {
    status: "complete",
    ok: true,
    attemptedCount: 1,
    writtenCount: 1,
    rejectedCount: 0,
    deduplicatedCount: 0,
    skippedCount: 0,
    memoryId: "memory-id",
    operation: "created",
    idempotencyKey
  };
}

function createDirectMemoryTurn(sessionId: string) {
  const sourceEvent = createEvent("user.message", {
    sessionId,
    content: "I prefer concise replies.",
    personaId: "alice",
    subjectUserId: "user-a"
  });
  const reply = createEvent(
    "agent.reply",
    {
      sessionId,
      content: "Understood."
    },
    {
      traceId: sourceEvent.traceId,
      parentId: sourceEvent.id
    }
  );
  return { sourceEvent, reply };
}

type DirectMemoryTurn = ReturnType<typeof createDirectMemoryTurn>;

class RecordingConversationRepository extends InMemoryConversationRepository {
  readonly appendedMessages: ConversationMessageInput[] = [];

  override async appendMessage(message: ConversationMessageInput) {
    this.appendedMessages.push(message);
    return super.appendMessage(message);
  }
}

function createMem0RecordingMemory(
  store: (input: Record<string, unknown>) => Promise<MemoryConversationTurnWriteResult>
): RuntimeMemoryPort {
  return {
    async retrieveRelevantMemories() {
      return [];
    },
    scoreImportance() {
      return 0;
    },
    isMem0Backend() {
      return true;
    },
    getMemoryProvider() {
      return {
        async retrieveRelevant() {
          return { status: "empty", events: [], source: "test", limited: false };
        },
        async getEvent() {
          return null;
        },
        async writeEvent() {
          throw new Error("unkeyed test dispatch forbidden");
        },
        async writeEventIdempotent(input) {
          let result: MemoryConversationTurnWriteResult;
          try {
            result = await store({ ...input.metadata, ...input });
          } catch {
            return {
              status: "rejected",
              errorCode: "MEMORY_WRITE_FAILED",
              failureClass: "definitive_rejection"
            };
          }
          return result.ok
            ? { status: "written", eventId: "mem0:test" }
            : {
                status: "rejected",
                errorCode: "TEST_REJECTED",
                failureClass: "definitive_rejection"
              };
        }
      };
    },
    async storeConversationTurn(input) {
      return store(input as unknown as Record<string, unknown>);
    },
    async rememberInteraction() {
      return null;
    }
  };
}

/** Delivery fault fixture: production grounding is tested separately with committed Journal evidence. */
function createDeliveryRuntime(options: ConstructorParameters<typeof RuntimeOrchestrator>[0]) {
  const repository = new InMemoryFinalizedIngestionRepository();
  const fixture = new FinalizedIngestionService(repository, {
    async build(input) {
      return {
        turnKind: "normal",
        events: [
          {
            kind: "fact",
            content: input.userMessage,
            scope: input.scope,
            metadata: {
              assistantMessageId: input.assistantMessageId,
              assistantMessage: input.assistantMessage
            }
          }
        ]
      };
    }
  });
  const admit = fixture.admit.bind(fixture);
  fixture.admit = (input) =>
    admit({
      ...input,
      personaId: input.personaId ?? "alice",
      subjectUserId: input.subjectUserId ?? "user-a"
    });
  return new RuntimeOrchestrator({
    ...options,
    finalizedIngestion: options.finalizedIngestion ?? fixture
  });
}

function finalizedStatusAdmission(finalizedTurnId: string) {
  return {
    finalizedTurnId,
    assistantMessageId: `assistant:${finalizedTurnId}`,
    sourceUserEventId: `user:${finalizedTurnId}`,
    conversationId: `conversation:${finalizedTurnId}`,
    traceId: `trace:${finalizedTurnId}`,
    personaId: "alice",
    subjectUserId: "user-a",
    finalizedAt: "2026-08-13T00:00:00.000Z",
    ingestionRequested: true,
    userMessage: "I prefer concise replies.",
    assistantMessage: "Understood.",
    sessionId: `session:${finalizedTurnId}`
  };
}

async function createFinalizedStatusFixture(finalizedTurnId: string, eventCount: number) {
  const repository = new InMemoryFinalizedIngestionRepository();
  const service = new FinalizedIngestionService(repository, {
    async build() {
      return {
        turnKind: "normal" as const,
        events: Array.from({ length: eventCount }, (_, index) => ({
          kind: "fact" as const,
          content: `fact-${index + 1}`,
          scope: "user:user-a:persona:alice",
          metadata: {}
        }))
      };
    }
  });
  const admitted = await service.admit(finalizedStatusAdmission(finalizedTurnId));
  return { repository, service, admitted, turnId: finalizedTurnId };
}

async function recordFinalizedEventOutcome(
  service: FinalizedIngestionService,
  repository: InMemoryFinalizedIngestionRepository,
  event: Awaited<ReturnType<FinalizedIngestionService["admit"]>>["events"][number],
  outcome: Parameters<FinalizedIngestionService["recordEventOutcome"]>[0]["outcome"]
): Promise<void> {
  const claimed = await repository.claimEvent({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner: "status-test-owner",
    leaseSeconds: 300,
    expectedVersion: event.version
  });
  if (!claimed) throw new Error(`Could not claim ${event.eventId} for status test.`);
  const dispatching = await repository.markEventDispatchStarted({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner: "status-test-owner",
    expectedVersion: claimed.version
  });
  if (!dispatching) throw new Error(`Could not mark ${event.eventId} for status test.`);
  await service.recordEventOutcome({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner: "status-test-owner",
    expectedVersion: dispatching.version,
    outcome
  });
}

async function runFinalizedStatusSchedule(fixture: {
  repository: InMemoryFinalizedIngestionRepository;
  service: FinalizedIngestionService;
  admitted: Awaited<ReturnType<FinalizedIngestionService["admit"]>>;
  turnId: string;
}): Promise<MemoryConversationTurnWriteResult> {
  const memory = createMem0RecordingMemory(async () => completeMemoryWrite());
  memory.getMemoryProvider = () => ({
    async retrieveRelevant() {
      return { status: "empty", events: [], source: "test", limited: false };
    },
    async getEvent() {
      return null;
    },
    async writeEvent() {
      return { status: "written", eventId: "memory:status-test" };
    },
    async writeEventIdempotent() {
      return { status: "written", eventId: "memory:status-test" };
    }
  });
  const runtime = createDeliveryRuntime({
    eventBus: new InMemoryEventBus({ development: false }),
    memory,
    finalizedIngestion: fixture.service,
    promptBuilder: new PromptBuilder(),
    providers: createMockProviders()
  });
  const { sourceEvent, reply } = createDirectMemoryTurn(`status-${fixture.turnId}`);
  const source = finalizedStatusAdmission(fixture.turnId);
  sourceEvent.id = source.sourceUserEventId;
  sourceEvent.traceId = source.traceId;
  sourceEvent.payload.sessionId = source.conversationId;
  sourceEvent.payload.content = source.userMessage;
  sourceEvent.payload.personaId = source.personaId;
  sourceEvent.payload.subjectUserId = source.subjectUserId;
  reply.timestamp = source.finalizedAt;
  reply.payload.content = source.assistantMessage;
  const schedule = (
    runtime as unknown as {
      scheduleMem0TurnWrite: (
        sourceEvent: DirectMemoryTurn["sourceEvent"],
        reply: DirectMemoryTurn["reply"],
        assistantMessageId: string,
        finalizedTurnId: string
      ) => Promise<MemoryConversationTurnWriteResult>;
    }
  ).scheduleMem0TurnWrite.bind(runtime);
  return schedule(sourceEvent, reply, fixture.admitted.turn.assistantMessageId, fixture.turnId);
}

function createMockProviders() {
  return {
    getChatProvider: () => createAssistantAwareChatProvider(createMockChatProvider("mock-chat")),
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider("REQUEST_TEXT"),
    getAssistantContinuationProvider: () =>
      createMockAssistantContinuationProvider("Mock proactive continuation."),
    getReasoningProvider: () => createMockReasoningProvider("mock-reasoning"),
    getTTSProvider: () => ({
      name: "mock-tts",
      async healthCheck() {
        return {
          provider: "mock-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech() {
        return {
          audio: new Uint8Array(),
          audioBase64: "",
          mimeType: "audio/wav",
          durationMs: 0
        };
      }
    }),
    getSTTProvider: () => createMockSTTProvider("mock-stt"),
    getVisionProvider: () => createMockVisionProvider("mock-vision"),
    getEmbeddingProvider: () => ({
      name: "mock-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "mock-embedding",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async embedText() {
        return [0, 0, 0];
      },
      async embedBatch(texts: string[]) {
        return texts.map(() => [0, 0, 0]);
      }
    })
  };
}

function createMockStreamingChatProvider(
  name = "mock-stream-chat",
  options: MockStreamingChatProviderOptions = {}
): ChatProvider {
  return createAssistantAwareChatProvider(createRawMockStreamingChatProvider(name, options));
}

function createAssistantAwareChatProvider(provider: ChatProvider): ChatProvider {
  return {
    ...provider,
    async generateReply(input: ChatInput, options?: ChatStreamOptions): Promise<ChatOutput> {
      const output = await provider.generateReply(input, options);
      return isAssistantInitiatedInput(input) ? withProactiveControl(output) : output;
    },
    async *streamReply(
      input: ChatInput,
      options?: ChatStreamOptions
    ): AsyncIterable<ChatStreamEvent> {
      const proactive = isAssistantInitiatedInput(input);
      let controlEmitted = false;
      const stream = provider.streamReply
        ? provider.streamReply(input, options)
        : (async function* (): AsyncIterable<ChatStreamEvent> {
            const output = await provider.generateReply(input, options);
            if (output.message.content) {
              yield { type: "text-delta", text: output.message.content };
            }
            yield { type: "completed", output };
          })();
      for await (const event of stream) {
        if (!proactive) {
          yield event;
          continue;
        }
        if (event.type === "text-delta") {
          if (!controlEmitted) {
            controlEmitted = true;
            yield { type: "text-delta", text: "REQUEST_TEXT\n" };
          }
          yield event;
          continue;
        }
        if (!controlEmitted) {
          controlEmitted = true;
          yield { type: "text-delta", text: "REQUEST_TEXT\n" };
        }
        yield {
          ...event,
          output: withProactiveControl(event.output)
        };
      }
    }
  };
}

function isAssistantInitiatedInput(input: ChatInput): boolean {
  return input.metadata?.["turnOrigin"] === "assistant-initiated";
}

function withProactiveControl(output: ChatOutput): ChatOutput {
  return {
    ...output,
    message: {
      ...output.message,
      content: `REQUEST_TEXT\n${output.message.content}`
    }
  };
}
