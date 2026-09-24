import { randomBytes } from "node:crypto";
import { InMemoryEventBus } from "@companion/event-bus";
import { RuntimeOrchestrator, type RuntimeMemoryPort } from "@companion/core";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import {
  PostgresJournalRepository,
  type JournalAuthorityDraft,
  type JournalRepository
} from "@companion/journal";
import { PromptBuilder } from "@companion/prompt-builder";
import type { STTOutput } from "@companion/providers";
import Fastify from "fastify";
import type { JournalPayloadDescriptor } from "@companion/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  readSqlMigrations,
  runPostgresMigrations
} from "../../../packages/memory/src/migrations.js";
import { HostSpeechReceiptAdmission, type SpeechReceiptInput } from "./speech-receipt-admission.js";
import type { AppContext } from "./context.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerMessageRoutes } from "./routes/message.js";
import { registerMessageStreamRoutes } from "./routes/message-stream.js";

const databaseUrl = process.env["YUVI_JOURNAL_TEST_DATABASE_URL"];
const schema = `speech_ingress_${randomBytes(5).toString("hex")}`;
const namespace = "a8.2c-speech-ingress-test";
let adminPool: PostgresPool | undefined;
let pool: PostgresPool | undefined;
let repository: PostgresJournalRepository | undefined;

function createRuntime(): RuntimeOrchestrator {
  return new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory: {} as RuntimeMemoryPort,
    promptBuilder: new PromptBuilder(),
    providers: {} as never
  });
}

function input(overrides: Partial<SpeechReceiptInput> = {}): SpeechReceiptInput {
  return {
    surface: "HTTP_AUDIO_TRANSCRIPTIONS",
    sessionId: "speech-test-session",
    observation: {
      observationId: "observation-test-1",
      captureEpoch: "capture-test-1",
      text: "Alice said hello.",
      model: "test-stt",
      segments: [
        { segmentId: "segment-test-1", text: "Alice said hello.", speakerClusterId: "cluster-a" },
        { segmentId: "segment-test-2", speakerClusterId: "cluster-b" }
      ]
    },
    audioReceived: true,
    ...overrides
  };
}

describe.skipIf(!databaseUrl)("A8.2c speech Journal ingress with PostgreSQL", () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(databaseUrl!);
    await adminPool.query(`create schema "${schema}"`);
    const migrations = await readSqlMigrations();
    const journalMigration = migrations.find(
      (entry) => entry.name === "013_life_event_journal_v1.sql"
    );
    expect(journalMigration).toBeDefined();
    await runPostgresMigrations({
      databaseUrl: databaseUrl!,
      migrations: [journalMigration!],
      settings: { search_path: schema }
    });
    pool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
    repository = new PostgresJournalRepository(pool, {
      namespace,
      authorityBuilder() {
        throw new Error("Speech receipts require host authority.");
      }
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`drop schema if exists "${schema}" cascade`);
      await adminPool.end();
    }
  });

  it("persists one receipt, retains transcript text after reopen, and never stores raw audio", async () => {
    const admission = new HostSpeechReceiptAdmission(repository!);
    const envelope = await admission.admit(input());
    expect(envelope.command).toMatchObject({
      kind: "RECEIPT",
      data: { receiptClass: "DIRECT_OBSERVATION" }
    });
    expect(envelope.authority.principal.state).toBe("UNRESOLVED");
    expect(envelope.authority.binding.state).toBe("UNRESOLVED");
    expect(envelope.authority.subjects).toEqual([]);
    expect(envelope.authority.audience.kind).toBe("UNKNOWN");
    expect(
      envelope.authority.correlations.filter((item) => item.kind === "VOICE_OBSERVATION")
    ).toEqual([
      {
        kind: "VOICE_OBSERVATION",
        observationId: "observation-test-1",
        captureEpoch: "capture-test-1"
      },
      {
        kind: "VOICE_OBSERVATION",
        observationId: "observation-test-1",
        captureEpoch: "capture-test-1",
        segmentId: "segment-test-1"
      },
      {
        kind: "VOICE_OBSERVATION",
        observationId: "observation-test-1",
        captureEpoch: "capture-test-1",
        segmentId: "segment-test-2"
      }
    ]);
    expect(envelope.authority.correlations).toContainEqual({
      kind: "VOICE_OBSERVATION",
      observationId: "observation-test-1",
      captureEpoch: "capture-test-1"
    });

    const descriptors = envelope.authority.payloads as readonly JournalPayloadDescriptor[];
    const text = descriptors.find((item) => item.modality === "TEXT");
    const audio = descriptors.find((item) => item.modality === "AUDIO");
    expect(text).toMatchObject({ retention: "RETAINED", selectable: true, characterCount: 17 });
    expect(audio).toMatchObject({ retention: "NOT_RETAINED", selectable: false });
    const audioRows = await pool!.query(
      `select text_content from journal_payloads
       where journal_namespace = $1 and event_id = $2 and modality = 'AUDIO'`,
      [namespace, envelope.eventId]
    );
    expect(audioRows.rows).toEqual([{ text_content: null }]);

    const reopenedPool = createPostgresPool(databaseUrl!, { options: `-c search_path=${schema}` });
    try {
      const reopened = new PostgresJournalRepository(reopenedPool, {
        namespace,
        authorityBuilder() {
          throw new Error("Reconstruction does not need an authority builder.");
        }
      });
      const restored = await reopened.get({
        kind: "JOURNAL_EVENT",
        namespace,
        eventId: envelope.eventId
      });
      expect(restored?.eventId).toBe(envelope.eventId);
      const payload = await reopened.resolveRetainedText(text!.ref);
      expect(payload?.text).toBe("Alice said hello.");
      expect(payload?.descriptor).toMatchObject({ characterCount: 17, retention: "RETAINED" });
    } finally {
      await reopenedPool.end();
    }

    const dedup = await pool!.query(
      "select count(*)::int as count from journal_source_dedup where journal_namespace = $1",
      [namespace]
    );
    expect(Number(dedup.rows[0]?.["count"])).toBe(0);
  });

  it("does not invent audio evidence for mockText-only input", async () => {
    const envelope = await new HostSpeechReceiptAdmission(repository!).admit(
      input({
        observation: {
          observationId: "mock-observation",
          captureEpoch: "mock-capture",
          text: "caller-provided mock text"
        },
        audioReceived: false,
        mockTextSupplied: true
      })
    );
    expect(envelope.command).toMatchObject({
      kind: "RECEIPT",
      data: { receiptClass: "ATTRIBUTED_ASSERTION" }
    });
    expect(envelope.authority.payloads.map((item) => item.modality)).toEqual(["TEXT"]);
    expect(envelope.authority.payloads.some((item) => item.modality === "AUDIO")).toBe(false);
  });

  it("classifies actual audio as an STT observation even when mockText metadata is present", async () => {
    const envelope = await new HostSpeechReceiptAdmission(repository!).admit(
      input({
        observation: {
          observationId: "audio-with-mock-metadata",
          captureEpoch: "audio-capture",
          text: "transcribed from supplied audio"
        },
        audioReceived: true,
        mockTextSupplied: true
      })
    );
    expect(envelope.command).toMatchObject({
      kind: "RECEIPT",
      data: { receiptClass: "DIRECT_OBSERVATION" }
    });
    expect(envelope.authority.payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modality: "TEXT", origin: "EXTERNAL_RESULT" }),
        expect.objectContaining({ modality: "AUDIO", retention: "NOT_RETAINED", selectable: false })
      ])
    );
  });

  it("routes finalized transcription through one durable receipt for both message handoffs and voice/message", async () => {
    const runtime = createRuntime();
    const handleUserMessage = vi.spyOn(runtime, "handleUserMessage").mockResolvedValue(null);
    const streamUserMessage = vi
      .spyOn(runtime, "streamUserMessage")
      .mockImplementation(async function* () {
        yield {
          type: "completed",
          messageId: "assistant-stream-test",
          sessionId: "stream-session",
          traceId: "stream-trace",
          content: "done",
          provider: "test"
        };
      } as typeof runtime.streamUserMessage);
    let observationIndex = 0;
    const transcribeAudio = vi.fn(async (): Promise<STTOutput> => {
      const index = ++observationIndex;
      return {
        observationId: `route-observation-${index}`,
        captureEpoch: `route-epoch-${index}`,
        text: `spoken ${index}`,
        model: "test-stt",
        segments: [{ segmentId: `route-segment-${index}`, text: `spoken ${index}` }]
      };
    });
    const conversationalReceiptAdmission = { admit: vi.fn() };
    const app = Fastify({ logger: false });
    const context = {
      providers: { getSTTProvider: () => ({ name: "test-stt", transcribeAudio }) },
      runtime,
      speechReceiptAdmission: new HostSpeechReceiptAdmission(repository!),
      conversationalReceiptAdmission
    } as unknown as AppContext;
    await registerMediaRoutes(app, context);
    await registerMessageRoutes(app, context);
    await registerMessageStreamRoutes(app, context);
    try {
      const baseline = await pool!.query(
        "select count(*)::int as count from journal_events where journal_namespace = $1",
        [namespace]
      );
      const baselineCount = Number(baseline.rows[0]?.["count"]);
      const transcription = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        payload: { audioBase64: "AQID", sessionId: "handoff-http" }
      });
      expect(transcription.statusCode).toBe(200);
      expect(transcription.json().observationId).toBe("route-observation-1");
      const countAfterTranscription = await pool!.query(
        "select count(*)::int as count from journal_events where journal_namespace = $1",
        [namespace]
      );
      expect(Number(countAfterTranscription.rows[0]?.["count"])).toBe(baselineCount + 1);
      const restartedRuntime = createRuntime();
      expect(() =>
        restartedRuntime.commitSpeechTurn("route-observation-1", "handoff-http", "spoken 1")
      ).toThrow();

      const handoff = await app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: {
          sessionId: "handoff-http",
          text: "spoken 1",
          speechObservationId: "route-observation-1"
        }
      });
      expect(handoff.statusCode).toBe(200);
      expect(handleUserMessage).toHaveBeenCalledOnce();
      expect(conversationalReceiptAdmission.admit).not.toHaveBeenCalled();
      const duplicateHandoff = await app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: {
          sessionId: "handoff-http",
          text: "spoken 1",
          speechObservationId: "route-observation-1"
        }
      });
      expect(duplicateHandoff.statusCode).toBe(409);

      const secondTranscription = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        payload: { audioBase64: "AQID", sessionId: "stream-session" }
      });
      expect(secondTranscription.statusCode).toBe(200);
      const streamHandoff = await app.inject({
        method: "POST",
        url: "/v1/messages/stream",
        payload: {
          sessionId: "stream-session",
          text: "spoken 2",
          speechObservationId: "route-observation-2"
        }
      });
      expect(streamHandoff.statusCode).toBe(200);
      expect(streamUserMessage).toHaveBeenCalledOnce();
      expect(conversationalReceiptAdmission.admit).not.toHaveBeenCalled();

      const voiceMessage = await app.inject({
        method: "POST",
        url: "/v1/voice/message",
        payload: {
          audioBase64: "AQID",
          sessionId: "voice-immediate",
          speakerId: "caller-person-assertion",
          voiceProfileId: "caller-profile-assertion"
        }
      });
      expect(voiceMessage.statusCode).toBe(200);
      expect(handleUserMessage).toHaveBeenCalledTimes(2);
      expect(conversationalReceiptAdmission.admit).not.toHaveBeenCalled();

      const total = await pool!.query(
        "select count(*)::int as count from journal_events where journal_namespace = $1",
        [namespace]
      );
      expect(Number(total.rows[0]?.["count"])).toBe(baselineCount + 3);
      const lastEventRow = await pool!.query(
        "select event_id from journal_events where journal_namespace = $1 order by commit_seq desc limit 1",
        [namespace]
      );
      const lastEventId = String(lastEventRow.rows[0]?.["event_id"]);
      const lastEvent = await repository!.get({
        kind: "JOURNAL_EVENT",
        namespace,
        eventId: lastEventId
      });
      expect(lastEvent?.authority.principal.state).toBe("UNRESOLVED");
      expect(lastEvent?.authority.binding.state).toBe("UNRESOLVED");
      expect(lastEvent?.authority.subjects).toEqual([]);
      expect(JSON.stringify(lastEvent)).not.toContain("caller-person-assertion");
      expect(JSON.stringify(lastEvent)).not.toContain("caller-profile-assertion");
    } finally {
      await app.close();
    }
  });

  it("keeps the VAD epoch live while a real PostgreSQL append is held, then finalizes stale", async () => {
    let notifyAppendStarted!: () => void;
    let releaseAppend!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      notifyAppendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const blockedRepository: JournalRepository = {
      namespace,
      append: repository!.append.bind(repository),
      async appendWithHostAuthority(appendInput, authority: JournalAuthorityDraft) {
        notifyAppendStarted();
        await appendGate;
        return repository!.appendWithHostAuthority(appendInput, authority);
      },
      get: repository!.get.bind(repository),
      resolveRetainedText: repository!.resolveRetainedText.bind(repository)
    };
    const admission = new HostSpeechReceiptAdmission(blockedRepository);
    const runtime = createRuntime();
    runtime.observeSpeechActivity({
      sessionId: "race-session",
      captureEpoch: "epoch-old",
      active: true
    });
    const reservation = runtime.reserveFinalizedSpeechObservation(
      {
        observationId: "race-observation",
        captureEpoch: "epoch-old",
        text: "old speech",
        segments: [{ segmentId: "race-segment", text: "old speech" }]
      },
      { sessionId: "race-session", captureEpoch: "epoch-old" }
    );
    const pendingAppend = admission.admit({
      ...input(),
      sessionId: reservation.sessionId,
      observation: reservation.observation,
      surface: "HTTP_AUDIO_TRANSCRIPTIONS",
      audioReceived: true
    });
    await appendStarted;

    const newerEpoch = runtime.observeSpeechActivity({
      sessionId: "race-session",
      captureEpoch: "epoch-new",
      active: true
    });
    expect(newerEpoch.captureEpoch).toBe("epoch-new");
    releaseAppend();

    const receipt = await pendingAppend;
    const finalized = runtime.finalizeSpeechReservation(reservation.token, receipt);
    expect(finalized.status).toBe("stale");
    expect(runtime.getSpeechActivitySnapshot().captureEpoch).toBe("epoch-new");
    expect(
      await repository!.get({
        kind: "JOURNAL_EVENT",
        namespace,
        eventId: receipt.eventId
      })
    ).not.toBeNull();
    expect(() =>
      runtime.commitSpeechTurn("race-observation", "race-session", "old speech")
    ).toThrow();
  });
});
