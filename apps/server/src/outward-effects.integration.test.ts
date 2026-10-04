import { PostgresContextUseRepository } from "@companion/memory";
import { createServer, type Server } from "node:http";
import { createEvent, type AccountedPresentationRequest } from "@companion/protocol";
import { createProviderRegistryFromEnv } from "@companion/providers";
import { HostMediaEffects } from "./media-effects.js";
import { HostPresentationEffects } from "./presentation-effects.js";
import { composeServerCharacterSoftSmileEmbodiedEffect } from "./character-embodied-soft-smile-composition.js";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createPostgresPool, type PostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import {
  HostEffectIntentAdmission,
  PostgresEffectIntentStore,
  PostgresEffectDispatchStore,
  EffectDispatcher,
  effectDigest,
  effectIntentId,
  type EffectDispatchStore
} from "@companion/effects";
import { PostgresConversationRepository } from "@companion/memory";
import {
  ProviderError,
  ProviderErrorCode,
  certifyProviderNotStarted,
  withProviderWorkContext,
  type ProviderTaskDescriptor
} from "@companion/providers";
import { HostOutwardEffects } from "./outward-effects.js";
const url = process.env["YUVI_EFFECT_TEST_DATABASE_URL"];
const schema = `a93_outward_${randomBytes(6).toString("hex")}`;
let admin: PostgresPool,
  pool: PostgresPool,
  journal: PostgresJournalRepository,
  admission: HostEffectIntentAdmission,
  store: PostgresEffectDispatchStore,
  dispatcher: EffectDispatcher,
  host: HostOutwardEffects,
  conversation: PostgresConversationRepository;
let index = 0;
let adapter: Server,
  adapterUrl: string,
  adapterCalls = 0,
  adapterSawStart = false,
  adapterMode: "success" | "lost" = "success";
const leaf = { provider: "controlled-local", model: "fixture", method: "generateReply" };
function task(): ProviderTaskDescriptor {
  return {
    operationId: `task-${++index}`,
    operation: "generateReply",
    inputDigest: effectDigest({ input: "not retained" }),
    configurationRef: "fixture-config-v1",
    routingPlan: [{ provider: leaf.provider, model: leaf.model }],
    contextUse: undefined,
    assemblyOrdinal: "1",
    exposure: {
      projectionVersion: "fixture-input.v1",
      inputDigest: effectDigest({ input: "not retained" }),
      fields: [],
      blocks: []
    },
    context: undefined
  };
}
function taskId(t: ProviderTaskDescriptor) {
  return effectIntentId("yuvi.provider.v1", `yuvi.provider.v1:test:a93:${t.operationId}`);
}
function makeHost(override: EffectDispatchStore = store) {
  const d = new EffectDispatcher(override, [], 30000, 4, true);
  const host = new HostOutwardEffects(admission, override, d, journal, "test:a93");
  host.setContextUseRepository(new PostgresContextUseRepository(pool));
  return { dispatcher: d, host };
}
describe.skipIf(!url)("A9.3 canonical provider/publication PostgreSQL boundaries", () => {
  beforeAll(async () => {
    admin = createPostgresPool(url!);
    await admin.query(`create schema "${schema}"`);
    pool = createPostgresPool(url!, { options: `-c search_path=${schema},public` });
    for (const name of [
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "008_finalized_ingestion_ledger_v1.sql",
      "013_life_event_journal_v1.sql",
      "014_conversation_journal_ancestry_v1.sql",
      "020_effect_intents_v1.sql",
      "021_effect_attempts_v1.sql",
      "022_native_control_effects_v1.sql",
      "023_reply_components_v1.sql",
      "024_context_use_manifests_v1.sql"
    ])
      await pool.query(
        await readFile(
          new URL(`../../../packages/memory/migrations/${name}`, import.meta.url),
          "utf8"
        )
      );
    journal = new PostgresJournalRepository(pool, {
      namespace: "test:a93",
      authorityBuilder() {
        throw Error("Host only");
      }
    });
    admission = new HostEffectIntentAdmission(new PostgresEffectIntentStore(pool), journal);
    store = new PostgresEffectDispatchStore(pool);
    ({ dispatcher, host } = makeHost());
    adapter = createServer(async (req, res) => {
      adapterCalls++;
      for await (const _chunk of req) {
        /* discard raw fixture input */
      }
      const started = await pool.query(
        "select count(*) as n from effect_attempts where contract_ref='yuvi.provider.v1' and dispatch_started_at is not null"
      );
      adapterSawStart = Number(started.rows[0]?.["n"]) > 0;
      if (adapterMode === "lost") {
        res.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "audio/wav" });
      const wav = Buffer.alloc(48);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(40, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(4, 40);
      res.end(wav);
    });
    await new Promise<void>((resolve) => adapter.listen(0, "127.0.0.1", resolve));
    adapterUrl = `http://127.0.0.1:${(adapter.address() as { port: number }).port}`;
    conversation = new PostgresConversationRepository(pool);
    conversation.setPublicationAdmission(host.admitReplyPublications);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => adapter?.close(() => resolve()));
    await dispatcher?.shutdown();
    await pool?.end();
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });
  it("commits canonical intent, attempt and start before the provider leaf, retaining only descriptors", async () => {
    const t = task();
    let calls = 0;
    const result = await host.invoke(t, leaf, async () => {
      calls++;
      const d = await store.diagnostic(taskId(t));
      expect(d?.currentAttempt?.dispatchStartedAt).toBeTruthy();
      expect(d?.evidence).toBeNull();
      return { content: "safe result" };
    });
    expect(result).toMatchObject({
      content: "safe result",
      sourceAttemptId: expect.stringMatching(/^ea1_/)
    });
    expect(calls).toBe(1);
    expect((await store.diagnostic(taskId(t)))?.evidence).toMatchObject({
      certainty: "APPLIED",
      layer: "PROVIDER_RESPONSE"
    });
    const intents = await pool.query("select intent from effect_intents where intent_id=$1", [
      taskId(t)
    ]);
    expect(JSON.stringify(intents.rows)).not.toContain("not retained");
    expect(JSON.stringify(intents.rows)).not.toContain("safe result");
  });
  it.each(["lost response", "unclassified error", "timeout", "false not-started flag"])(
    "keeps %s UNKNOWN and never reinvokes",
    async (kind) => {
      const t = task();
      let calls = 0;
      await expect(
        host.invoke(t, leaf, async () => {
          calls++;
          if (kind === "false not-started flag")
            throw new ProviderError({
              provider: leaf.provider,
              capability: "chat",
              code: ProviderErrorCode.ProviderUnavailable,
              message: "flag",
              effectState: "not_started",
              fallbackEligible: true
            });
          throw Error(kind);
        })
      ).rejects.toMatchObject({ effectState: "unknown", fallbackEligible: false });
      expect((await store.diagnostic(taskId(t)))?.certainty).toBe("UNKNOWN");
      await expect(
        host.invoke(t, leaf, async () => {
          calls++;
          return "duplicate";
        })
      ).rejects.toMatchObject({ effectState: "unknown" });
      expect(calls).toBe(1);
    }
  );
  it("uses another canonical attempt for certified pre-transport fallback under one logical task", async () => {
    const t = task();
    const proof = certifyProviderNotStarted(
      new ProviderError({
        provider: leaf.provider,
        capability: "chat",
        code: ProviderErrorCode.ProviderUnavailable,
        message: "host preflight",
        effectState: "not_started",
        fallbackEligible: true
      })
    );
    await expect(
      host.invoke(t, leaf, async () => {
        throw proof;
      })
    ).rejects.toBe(proof);
    expect(
      await host.invoke(t, { ...leaf, provider: "fallback" }, async () => "fallback result")
    ).toBe("fallback result");
    const rows = await pool.query(
      "select ordinal from effect_attempts where intent_id=$1 order by ordinal",
      [taskId(t)]
    );
    expect(rows.rows.map((r) => String(r["ordinal"]))).toEqual(["1", "2"]);
  });
  it("preserves a streamed prefix but withholds completion after a lost response", async () => {
    const t = task();
    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const e of host.stream(t, leaf, async function* () {
          yield { type: "text-delta", text: "prefix" };
          throw Error("lost response");
        }))
          events.push(e);
      })()
    ).rejects.toMatchObject({ effectState: "unknown" });
    expect(events).toEqual([
      { type: "text-delta", text: "prefix", sourceAttemptId: expect.stringMatching(/^ea1_/) }
    ]);
    expect((await store.diagnostic(taskId(t)))?.certainty).toBe("UNKNOWN");
  });
  it("resolves a lost observation commit response without repeating the provider", async () => {
    let recorded = false,
      calls = 0;
    const override = new Proxy(store, {
      get(target, key) {
        if (key === "record")
          return async (...args: Parameters<typeof store.record>) => {
            const result = await store.record(...args);
            if (!recorded) {
              recorded = true;
              throw Error("commit response lost");
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const owned = makeHost(override);
    const t = task();
    expect(
      await owned.host.invoke(t, leaf, async () => {
        calls++;
        return "observed";
      })
    ).toBe("observed");
    expect(calls).toBe(1);
    await owned.dispatcher.shutdown();
  });
  it("a restarted owner withholds old started work and rejects stale worker evidence", async () => {
    const t = task();
    const work = await host.work({
      contractRef: "yuvi.provider.v1",
      logicalKey: `yuvi.provider.v1:test:a93:${t.operationId}`,
      operation: t.operation,
      digest: t.inputDigest,
      configurationRef: t.configurationRef,
      scope: "restart"
    });
    const intent = await admission.admit(work.request, {
      snapshot: {
        policyVersion: "test",
        authorityVersion: "test",
        scope: "restart",
        identity: work.identity,
        permissions: ["HOST_PROVIDER_INVOCATION"],
        allowed: true
      },
      isCurrent: () => true
    });
    const claim = await store.claim(
      intent.intentId,
      "yuvi.provider.v1",
      "dead-worker",
      30000,
      () => true
    );
    expect(claim).not.toBeNull();
    await store.start(claim!, () => true);
    await pool.query(
      "update effect_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where attempt_id=$1",
      [claim!.attempt.attemptId]
    );
    const fresh = makeHost();
    expect((await fresh.dispatcher.run(intent.intentId)).invoked).toBe(false);
    expect((await store.diagnostic(intent.intentId))?.certainty).toBe("UNKNOWN");
    expect(
      await store.record(claim!.attempt, {
        certainty: "APPLIED",
        layer: "PROVIDER_RESPONSE",
        reason: "RETURNED",
        remoteEffectId: null
      })
    ).toBe("STALE");
    await fresh.dispatcher.shutdown();
  });
  it.each(["HTTP", "HTTP_SSE", "WEBSOCKET", "EVENTBUS_CLIENT", "SUBTITLE"] as const)(
    "accounts %s gateway acceptance without a peer receipt claim",
    async (surface) => {
      const target = { surface, targetId: `${surface}:${++index}`, targetGeneration: "generation" };
      const unregister = host.registerTarget(
        target,
        () => true,
        () => true
      );
      let calls = 0;
      const input = {
        target,
        frameId: "terminal",
        payload: { text: "hello" },
        write: async () => {
          calls++;
        }
      };
      await host.publish(input);
      await host.publish(input);
      expect(calls).toBe(1);
      await expect(host.publish({ ...input, payload: { text: "conflict" } })).rejects.toThrow(
        /conflict/
      );
      unregister();
      await expect(host.publish(input)).rejects.toThrow(/no longer current/);
    }
  );
  it("atomically admits component/conversation/canonical publication and gates the actual write", async () => {
    const target = {
      surface: "HTTP_SSE" as const,
      targetId: `component:${++index}`,
      targetGeneration: "live"
    };
    const unregister = host.registerTarget(
      target,
      () => false,
      () => true
    );
    const message = await conversation.appendMessage({
      id: `assistant:${index}`,
      sessionId: "atomic",
      traceId: "atomic",
      parentMessageId: null,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
      completedAt: null,
      metadata: {}
    });
    const component = await conversation.appendReplyComponent({
      replyId: `reply:${index}`,
      messageId: message.id,
      sequence: "1",
      text: "delta",
      projectionVersion: "runtime-text.v1",
      publicationTargets: [target]
    });
    let writes = 0;
    await host.publish({
      target,
      frameId: component.componentId,
      replyId: `reply:${index}`,
      componentId: component.componentId,
      payload: { text: "delta" },
      write: async () => {
        writes++;
      }
    });
    expect(writes).toBe(1);
    unregister();
  });
  it("rolls canonical publication back with a failed conversation projection", async () => {
    const target = {
      surface: "HTTP_SSE" as const,
      targetId: `rollback:${++index}`,
      targetGeneration: "live"
    };
    const unregister = host.registerTarget(
      target,
      () => false,
      () => true
    );
    const message = await conversation.appendMessage({
      id: `assistant:${index}`,
      sessionId: "atomic",
      traceId: "atomic",
      parentMessageId: null,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
      completedAt: null,
      metadata: {}
    });
    await pool.query(
      `create function fail_a93_projection() returns trigger language plpgsql as $$begin raise exception 'a93 projection fault';end$$`
    );
    await pool.query(
      "create trigger fail_a93_projection before update on conversation_messages for each row execute function fail_a93_projection()"
    );
    try {
      await expect(
        conversation.appendReplyComponent({
          replyId: `rollback:${index}`,
          messageId: message.id,
          sequence: "1",
          text: "delta",
          projectionVersion: "runtime-text.v1",
          publicationTargets: [target]
        })
      ).rejects.toThrow(/projection fault/);
    } finally {
      await pool.query("drop trigger fail_a93_projection on conversation_messages");
      await pool.query("drop function fail_a93_projection()");
      unregister();
    }
    expect(
      (
        await pool.query(
          "select count(*) as n from effect_intents where intent->'request'->'payload'->>'relatedReply'=$1",
          [`rollback:${index}`]
        )
      ).rows[0]?.["n"]
    ).toBe("0");
  });
  it("write may occur plus lost ACK stays UNKNOWN; reconnect and restart cannot replay", async () => {
    const target = {
      surface: "WEBSOCKET" as const,
      targetId: `ambiguous:${++index}`,
      targetGeneration: "old"
    };
    const unregister = host.registerTarget(
      target,
      () => false,
      () => true
    );
    let calls = 0;
    const input = {
      target,
      frameId: "delta",
      payload: { text: "uncertain" },
      write: async () => {
        calls++;
        throw Error("ACK lost");
      }
    };
    await expect(host.publish(input)).rejects.toThrow(/ambiguous/);
    await expect(host.publish(input)).rejects.toThrow(/cannot be resent/);
    expect(calls).toBe(1);
    unregister();
    const fresh = makeHost();
    await expect(fresh.host.publish(input)).rejects.toThrow(/no longer current/);
    await fresh.dispatcher.shutdown();
  });
  async function speechFixture(owner = host, source = "Hello world.") {
    const id = ++index,
      sessionId = `speech-session:${id}`,
      requestId = `request:${id}`,
      replyId = `speech-reply:${id}`;
    const cause = await owner.operationCause("speech-fixture", sessionId);
    const repo = new PostgresConversationRepository(pool);
    repo.setPublicationAdmission(owner.admitReplyPublications);
    const message = await repo.appendMessage({
      id: `speech-message:${id}`,
      sessionId,
      traceId: `speech-trace:${id}`,
      parentMessageId: null,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
      completedAt: null,
      metadata: {}
    });
    await withProviderWorkContext(
      {
        scope: `session:${sessionId}`,
        cause,
        speechPlan: "CLIENT_SEGMENTED",
        speechRequestId: requestId
      },
      () =>
        repo.appendReplyComponent({
          replyId,
          messageId: message.id,
          sequence: "1",
          text: source,
          projectionVersion: "runtime-text.v1"
        })
    );
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_TTS_PROVIDER: "local",
      TTS_PROVIDER_CHAIN: "local",
      LOCAL_TTS_BASE_URL: adapterUrl,
      LOCAL_TTS_MODEL: "dots-studio/dots.tts-soar"
    });
    registry.setAccounting(owner);
    const media = new HostMediaEffects(pool, owner, () => registry),
      generation = media.generation(sessionId, requestId);
    const seal = {
      version: "speech-segment-seal.v1" as const,
      replyId,
      sequence: "1",
      throughSequence: "1",
      preparedStart: 0,
      preparedEnd: source.length,
      preparationVersion: "speech-preparation.v1" as const
    };
    return { media, generation, seal, source, registry, sessionId, requestId, replyId };
  }
  it("seals a speech decision idempotently before TTS; conflicting source and plan are rejected", async () => {
    const f = await speechFixture();
    const segment = await f.media.sealSegment({
      seal: f.seal,
      text: f.source,
      generation: f.generation
    });
    expect(
      await f.media.sealSegment({ seal: f.seal, text: f.source, generation: f.generation })
    ).toEqual(segment);
    await expect(
      f.media.sealSegment({ seal: f.seal, text: "different", generation: f.generation })
    ).rejects.toThrow(/match/);
    const rows = await pool.query("select * from speech_segment_descriptors where segment_id=$1", [
      segment.segmentId
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).not.toHaveProperty("status");
    expect(rows.rows[0]).not.toHaveProperty("attempt");
    f.media.seal();
  });
  it("a controlled HTTP TTS leaf commits A9 start and audio descriptor before playback permit", async () => {
    const f = await speechFixture();
    const segment = await f.media.sealSegment({
      seal: f.seal,
      text: f.source,
      generation: f.generation
    });
    adapterMode = "success";
    const output = await f.media.synthesize(
      segment,
      { text: f.source, format: "wav" },
      new AbortController().signal
    );
    expect(output.sourceAttemptId).toMatch(/^ea1_/);
    expect(adapterSawStart).toBe(true);
    const row = (
      await pool.query("select * from speech_audio_results where segment_id=$1", [
        segment.segmentId
      ])
    ).rows[0];
    expect(row?.["provider_attempt_id"]).toBe(output.sourceAttemptId);
    expect(row?.["byte_count"]).toBe("48");
    const permit = await f.media.permission({
      segmentId: segment.segmentId,
      generation: f.generation,
      kind: "PLAYBACK"
    });
    expect((await store.diagnostic(permit.intentId))?.certainty).toBe("UNKNOWN");
    await f.media.report({ permission: permit, observation: "ATTACHED" });
    expect((await store.diagnostic(permit.intentId))?.certainty).toBe("UNKNOWN");
    await f.media.report({ permission: permit, observation: "PLAYING" });
    expect((await store.diagnostic(permit.intentId))?.evidence).toMatchObject({
      certainty: "APPLIED",
      layer: "DEVICE_REPORTED_PLAYING"
    });
    await f.media.report({ permission: permit, observation: "COMPLETED" });
    await f.media.report({ permission: permit, observation: "COMPLETED" });
    expect(
      (
        await pool.query("select ordinal from effect_attempts where intent_id=$1", [
          permit.intentId
        ])
      ).rows
    ).toHaveLength(1);
    const subtitle = await f.media.permission({
      segmentId: segment.segmentId,
      generation: f.generation,
      kind: "SUBTITLE"
    });
    await f.media.report({ permission: subtitle, observation: "SUBTITLE_ACCEPTED" });
    expect((await store.diagnostic(subtitle.intentId))?.certainty).toBe("UNKNOWN"); // presentation fact does not claim peer/human perception
    f.media.seal();
  });
  it("lost TTS response cannot be retried and cannot mint playback permission", async () => {
    const f = await speechFixture();
    const segment = await f.media.sealSegment({
      seal: f.seal,
      text: f.source,
      generation: f.generation
    });
    adapterMode = "lost";
    const before = adapterCalls;
    await expect(
      f.media.synthesize(segment, { text: f.source, format: "wav" }, new AbortController().signal)
    ).rejects.toMatchObject({ effectState: "unknown" });
    await expect(
      f.media.synthesize(segment, { text: f.source, format: "wav" }, new AbortController().signal)
    ).rejects.toMatchObject({ effectState: "unknown" });
    expect(adapterCalls - before).toBe(1);
    await expect(
      f.media.permission({
        segmentId: segment.segmentId,
        generation: f.generation,
        kind: "PLAYBACK"
      })
    ).rejects.toThrow(/unavailable/);
    f.media.seal();
    adapterMode = "success";
  });
  it.each(["ACK lost", "shutdown", "restart", "new generation"])(
    "fences playback and subtitle after %s without stale audio replay",
    async (fault) => {
      const f = await speechFixture();
      const segment = await f.media.sealSegment({
        seal: f.seal,
        text: f.source,
        generation: f.generation
      });
      adapterMode = "success";
      await f.media.synthesize(
        segment,
        { text: f.source, format: "wav" },
        new AbortController().signal
      );
      const permission = await f.media.permission({
        segmentId: segment.segmentId,
        generation: f.generation,
        kind: "PLAYBACK"
      });
      await expect(
        f.media.permission({
          segmentId: segment.segmentId,
          generation: f.generation,
          kind: "PLAYBACK"
        })
      ).rejects.toThrow(/resent/);
      expect((await store.diagnostic(permission.intentId))?.certainty).toBe("UNKNOWN");
      if (fault === "shutdown") f.media.seal();
      else if (fault === "new generation") f.media.generation(f.sessionId, "replacement");
      else f.media.revoke(f.generation);
      await expect(f.media.report({ permission, observation: "PLAYING" })).rejects.toThrow(/Stale/);
      const fresh = new HostMediaEffects(pool, host, () => f.registry);
      await expect(fresh.report({ permission, observation: "COMPLETED" })).rejects.toThrow(/Stale/);
      fresh.seal();
      f.media.seal();
    }
  );
  function presentationDecision() {
    const id = ++index;
    return composeServerCharacterSoftSmileEmbodiedEffect(
      {
        version: "character-harness-5d.v1",
        status: "ACCEPTED",
        proposal: { disposition: "RESPOND", text: "Hello", presentation: { intent: "soft-smile" } }
      },
      { kind: "turn", reference: `turn:${id}` },
      {
        allocateProposalInstance: () => ({ reference: `proposal:${id}`, createdAtMs: 1 }),
        allocateEffectId: () => `effect:${id}`,
        policyAllowsEmbodiedEffect: () => true
      }
    )!;
  }
  it("exclusively dispatches presentation after durable start; bridge and device reports stay distinct", async () => {
    const f = await speechFixture();
    let envelope: AccountedPresentationRequest | undefined;
    const presentation = new HostPresentationEffects(
      pool,
      host,
      {
        publish: async (event) => {
          envelope = event.payload as AccountedPresentationRequest;
          expect(
            (await store.diagnostic(envelope.permission.intentId))?.currentAttempt
              ?.dispatchStartedAt
          ).toBeTruthy();
          expect(
            (
              await pool.query("select * from effect_input_exposures where intent_id=$1", [
                envelope.permission.intentId
              ])
            ).rows
          ).toHaveLength(1);
        }
      },
      (replyId) => f.media.presentationTarget(replyId)
    );
    const decision = presentationDecision(),
      reply = createEvent("agent.reply", { content: "hello" }, { id: f.replyId });
    await presentation.dispatch(decision, reply);
    expect((await store.diagnostic(envelope!.permission.intentId))?.evidence).toMatchObject({
      certainty: "APPLIED",
      layer: "BRIDGE_ACCEPTANCE"
    });
    expect(await presentation.accept(envelope!.permission)).toBe(true);
    expect(await presentation.accept(envelope!.permission)).toBe(false);
    for (const outcome of ["STARTED", "COMPLETED"] as const)
      expect(
        await presentation.report({
          permission: envelope!.permission,
          report: {
            version: "embodied-presentation-outcome-7k.v1",
            effectId: envelope!.request.effectId,
            outcome
          }
        })
      ).toBe(true);
    presentation.seal();
    expect(
      await presentation.report({
        permission: envelope!.permission,
        report: {
          version: "embodied-presentation-outcome-7k.v1",
          effectId: envelope!.request.effectId,
          outcome: "COMPLETED"
        }
      })
    ).toBe(false);
  });
  it("lost presentation callbacks preserve bridge-only evidence; restart and stale capabilities cannot mutate", async () => {
    const f = await speechFixture();
    let envelope!: AccountedPresentationRequest;
    const presentation = new HostPresentationEffects(
      pool,
      host,
      {
        publish: async (event) => {
          envelope = event.payload as AccountedPresentationRequest;
        }
      },
      (replyId) => f.media.presentationTarget(replyId)
    );
    await presentation.dispatch(
      presentationDecision(),
      createEvent("agent.reply", { content: "hello" }, { id: f.replyId })
    );
    expect((await store.diagnostic(envelope.permission.intentId))?.evidence?.layer).toBe(
      "BRIDGE_ACCEPTANCE"
    );
    const fresh = new HostPresentationEffects(
      pool,
      host,
      {
        publish: async () => {
          throw Error("must not replay");
        }
      },
      () => undefined
    );
    const report = {
      permission: envelope.permission,
      report: {
        version: "embodied-presentation-outcome-7k.v1" as const,
        effectId: envelope.request.effectId,
        outcome: "STARTED" as const
      }
    };
    expect(await fresh.report(report)).toBe(false);
    expect(
      await presentation.report({
        ...report,
        permission: { ...report.permission, capability: "stale" }
      })
    ).toBe(false);
    fresh.seal();
    presentation.seal();
  });

  it.each([
    "before-attempt",
    "after-attempt",
    "start-commit-response-lost",
    "before-observation"
  ] as const)("provider fault boundary %s preserves canonical certainty", async (boundary) => {
    let injected = false,
      calls = 0;
    const override = new Proxy(store, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (
            !injected &&
            ((boundary === "before-attempt" && key === "claim") ||
              (boundary === "after-attempt" && key === "start") ||
              (boundary === "before-observation" && key === "record"))
          ) {
            injected = true;
            throw Error("fault before commit");
          }
          const result = await value.apply(target, args);
          if (!injected && boundary === "start-commit-response-lost" && key === "start") {
            injected = true;
            throw Error("committed start ACK lost");
          }
          return result;
        };
      }
    });
    const owned = makeHost(override),
      t = task();
    if (boundary === "start-commit-response-lost")
      expect(
        await owned.host.invoke(t, leaf, async () => {
          calls++;
          return "result";
        })
      ).toBe("result");
    else
      await expect(
        owned.host.invoke(t, leaf, async () => {
          calls++;
          return "result";
        })
      ).rejects.toMatchObject({ effectState: "unknown", fallbackEligible: false });
    const d = await store.diagnostic(taskId(t));
    expect(calls).toBe(boundary === "before-attempt" || boundary === "after-attempt" ? 0 : 1);
    expect(d?.certainty).toBe(
      boundary === "before-observation"
        ? "UNKNOWN"
        : boundary === "start-commit-response-lost"
          ? "APPLIED"
          : "NO_DISPATCH"
    );
    await owned.dispatcher.shutdown();
  });
  it("forced shutdown releases the caller, retains adapter closure, and suppresses late SQL", async () => {
    let release!: () => void,
      entered!: () => void,
      queries = 0;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    const counting = new Proxy(store, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return typeof value === "function"
          ? (...args: unknown[]) => {
              queries++;
              return value.apply(target, args);
            }
          : value;
      }
    });
    const owned = makeHost(counting),
      t = task();
    const call = owned.host.invoke(t, leaf, async () => {
      entered();
      await gate;
      return "late";
    });
    const rejected = expect(call).rejects.toMatchObject({ effectState: "unknown" });
    await started;
    owned.host.seal();
    expect(await owned.dispatcher.shutdown(5)).toEqual({ drained: false });
    await rejected;
    expect((await store.diagnostic(taskId(t)))?.certainty).toBe("UNKNOWN");
    const before = queries;
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(queries).toBe(before);
  });
  it("reserved publication lane proceeds while four generation calls are occupied", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    const calls = Array.from({ length: 4 }, () =>
      host.invoke(task(), leaf, async () => {
        entered++;
        await gate;
        return "done";
      })
    );
    while (entered < 4) await new Promise((r) => setTimeout(r, 1));
    const target = {
      surface: "HTTP" as const,
      targetId: `reserve:${++index}`,
      targetGeneration: "current"
    };
    const unregister = host.registerTarget(
      target,
      () => false,
      () => true
    );
    let writes = 0;
    await host.publish({
      target,
      frameId: "control",
      payload: { ok: true },
      write: async () => {
        writes++;
      }
    });
    expect(writes).toBe(1);
    unregister();
    release();
    await Promise.all(calls);
  });
  it("exact component replay remains readable after final seal and conflicting publication is rejected", async () => {
    const target = {
      surface: "HTTP_SSE" as const,
      targetId: `sealed:${++index}`,
      targetGeneration: "current"
    };
    const unregister = host.registerTarget(
      target,
      () => false,
      () => true
    );
    const m = await conversation.appendMessage({
      id: `sealed-message:${index}`,
      sessionId: "sealed",
      traceId: "sealed",
      parentMessageId: null,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
      completedAt: null,
      metadata: {}
    });
    const input = {
      replyId: `sealed-reply:${index}`,
      messageId: m.id,
      sequence: "1",
      text: "sealed text",
      projectionVersion: "runtime-text.v1",
      publicationTargets: [target]
    };
    const c = await conversation.appendReplyComponent(input);
    await conversation.completeMessage(m.id, { content: input.text });
    expect((await conversation.appendReplyComponent(input)).inserted).toBe(false);
    expect(
      (
        await pool.query("select * from conversation_reply_seals where reply_id=$1", [
          input.replyId
        ])
      ).rows
    ).toHaveLength(1);
    await expect(
      host.publish({
        target,
        replyId: input.replyId,
        componentId: c.componentId,
        frameId: c.componentId,
        payload: { text: "conflict" },
        write: async () => {
          throw Error("must not write");
        }
      })
    ).rejects.toThrow(/conflict/);
    unregister();
  });
  it("audio descriptor commit loss withholds playback and does not repeat an applied TTS call", async () => {
    const f = await speechFixture(),
      segment = await f.media.sealSegment({
        seal: f.seal,
        text: f.source,
        generation: f.generation
      });
    await pool.query(
      `create function fail_audio_result() returns trigger language plpgsql as $$begin raise exception 'audio descriptor fault';end$$`
    );
    await pool.query(
      "create trigger fail_audio_result before insert on speech_audio_results for each row execute function fail_audio_result()"
    );
    const before = adapterCalls;
    try {
      await expect(
        f.media.synthesize(segment, { text: f.source, format: "wav" }, new AbortController().signal)
      ).rejects.toThrow(/descriptor fault/);
    } finally {
      await pool.query("drop trigger fail_audio_result on speech_audio_results");
      await pool.query("drop function fail_audio_result()");
    }
    await expect(
      f.media.permission({
        segmentId: segment.segmentId,
        generation: f.generation,
        kind: "PLAYBACK"
      })
    ).rejects.toThrow(/unavailable/);
    await expect(
      f.media.synthesize(segment, { text: f.source, format: "wav" }, new AbortController().signal)
    ).rejects.toMatchObject({ effectState: "unknown" });
    expect(adapterCalls - before).toBe(1);
    f.media.seal();
  });
  it("bridge write plus lost ACK stays UNKNOWN despite current device progress and is not redispatched", async () => {
    const f = await speechFixture();
    let envelope!: AccountedPresentationRequest,
      calls = 0;
    const presentation = new HostPresentationEffects(
      pool,
      host,
      {
        publish: async (event) => {
          calls++;
          envelope = event.payload as AccountedPresentationRequest;
          throw Error("bridge ACK lost");
        }
      },
      (id) => f.media.presentationTarget(id)
    );
    const decision = presentationDecision(),
      reply = createEvent("agent.reply", { content: "hello" }, { id: f.replyId });
    await presentation.dispatch(decision, reply);
    expect((await store.diagnostic(envelope.permission.intentId))?.certainty).toBe("UNKNOWN");
    expect(await presentation.accept(envelope.permission)).toBe(true);
    for (const outcome of ["STARTED", "COMPLETED"] as const)
      expect(
        await presentation.report({
          permission: envelope.permission,
          report: {
            version: "embodied-presentation-outcome-7k.v1",
            effectId: envelope.request.effectId,
            outcome
          }
        })
      ).toBe(true);
    await presentation.dispatch(decision, reply);
    expect(calls).toBe(1);
    expect((await store.diagnostic(envelope.permission.intentId))?.certainty).toBe("UNKNOWN");
    f.media.generation(f.sessionId, "replacement");
    expect(await presentation.accept(envelope.permission)).toBe(false);
    presentation.seal();
    f.media.seal();
  });

  it("renewal loss aborts the running provider and leaves a started attempt UNKNOWN", async () => {
    const override = new Proxy(store, {
      get(target, key) {
        if (key === "renew") return async () => false;
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      }
    });
    const worker = new EffectDispatcher(override, [], 30, 4, true),
      owner = new HostOutwardEffects(admission, override, worker, journal, "test:a93"),
      t = task();
    owner.setContextUseRepository(new PostgresContextUseRepository(pool));
    let calls = 0;
    await expect(
      owner.invoke(t, leaf, async (signal) => {
        calls++;
        await new Promise((r) => setTimeout(r, 45));
        expect(signal?.aborted).toBe(true);
        return "stale";
      })
    ).rejects.toMatchObject({ effectState: "unknown", fallbackEligible: false });
    expect((await store.diagnostic(taskId(t)))?.certainty).toBe("UNKNOWN");
    await expect(
      owner.invoke(t, leaf, async () => {
        calls++;
        return "repeat";
      })
    ).rejects.toMatchObject({ effectState: "unknown" });
    expect(calls).toBe(1);
    await worker.shutdown();
  });
  it("publication admission followed by disconnect cannot write or revive the target", async () => {
    const target = {
      surface: "HTTP_SSE" as const,
      targetId: `disconnect:${++index}`,
      targetGeneration: "current"
    };
    let current = true,
      writes = 0;
    const unregister = host.registerTarget(
        target,
        () => false,
        () => current
      ),
      replyId = `disconnect-reply:${index}`;
    const m = await conversation.appendMessage({
      id: `disconnect:${index}`,
      sessionId: "disconnect",
      traceId: "disconnect",
      parentMessageId: null,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
      completedAt: null,
      metadata: {}
    });
    const c = await conversation.appendReplyComponent({
      replyId,
      messageId: m.id,
      sequence: "1",
      text: "committed",
      projectionVersion: "runtime-text.v1",
      publicationTargets: [target]
    });
    current = false;
    await expect(
      host.publish({
        target,
        replyId,
        componentId: c.componentId,
        frameId: c.componentId,
        payload: { text: "committed" },
        write: async () => {
          writes++;
        }
      })
    ).rejects.toThrow(/current/);
    expect(writes).toBe(0);
    unregister();
  });
  it("media generation retry preserves identity and revocation cannot mint fresh replay rights", async () => {
    const f = await speechFixture();
    expect(f.media.generation(f.sessionId, f.requestId)).toBe(f.generation);
    f.media.revoke(f.generation);
    expect(() => f.media.generation(f.sessionId, f.requestId)).toThrow(/revoked/);
    f.media.seal();
  });
  it("presentation start fault publishes no bridge request", async () => {
    const override = new Proxy(store, {
      get(target, key) {
        if (key === "start")
          return async () => {
            throw Error("pre-start crash");
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      }
    });
    const owned = makeHost(override),
      f = await speechFixture(owned.host);
    let writes = 0;
    const presentation = new HostPresentationEffects(
      pool,
      owned.host,
      {
        publish: async () => {
          writes++;
        }
      },
      (id) => f.media.presentationTarget(id)
    );
    await expect(
      presentation.dispatch(
        presentationDecision(),
        createEvent("agent.reply", { content: "hello" }, { id: f.replyId })
      )
    ).rejects.toThrow(/observation/);
    expect(writes).toBe(0);
    presentation.seal();
    f.media.seal();
    await owned.dispatcher.shutdown();
  });
  it("measures unbatched canonical PostgreSQL component and target costs", async () => {
    const n = 80,
      results: Record<string, number> = {};
    const cause = await host.operationCause("performance", "perf");
    for (const mode of ["component", "admission", "publication"]) {
      const id = ++index,
        replyId = `perf-reply:${id}`,
        messageId = `perf-message:${id}`;
      const repo = new PostgresConversationRepository(pool);
      if (mode !== "component") repo.setPublicationAdmission(host.admitReplyPublications);
      const target = {
        surface: "HTTP_SSE" as const,
        targetId: `perf-target:${id}`,
        targetGeneration: "active"
      };
      const unregister = host.registerTarget(
        target,
        () => false,
        () => true
      );
      await repo.appendMessage({
        id: messageId,
        sessionId: "perf",
        traceId: `perf:${id}`,
        parentMessageId: null,
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: new Date().toISOString(),
        completedAt: null,
        metadata: {}
      });
      const started = performance.now();
      for (let i = 1; i <= n; i++)
        await withProviderWorkContext(
          { scope: "session:perf", cause, executionId: `perf:${id}` },
          async () => {
            const c = await repo.appendReplyComponent({
              replyId,
              messageId,
              sequence: String(i),
              text: "delta ",
              projectionVersion: "runtime-text.v1",
              ...(mode !== "component" ? { publicationTargets: [target] } : {})
            });
            if (mode === "publication")
              await host.publish({
                target,
                replyId,
                componentId: c.componentId,
                frameId: c.componentId,
                payload: { text: "delta " },
                write: async () => {}
              });
          }
        );
      results[mode] = (performance.now() - started) / n;
      unregister();
      await repo.completeMessage(messageId, {});
      if (mode === "publication") {
        const counts = await pool.query(
          `select count(distinct i.intent_id)::int intents,count(distinct a.attempt_id)::int attempts,count(distinct o.observation_id)::int observations
     from effect_intents i left join effect_attempts a using(intent_id) left join effect_observations o on o.attempt_id=a.attempt_id where i.intent->'request'->'payload'->>'relatedReply'=$1`,
          [replyId]
        );
        expect(counts.rows[0]).toEqual({ intents: n, attempts: n, observations: n });
      }
    }
    console.info(
      "A93_REAL_PG_PERF",
      JSON.stringify({
        deltas: n,
        msPerDelta: results,
        incrementalPublicationMs: results["publication"]! - results["component"]!,
        streamedTurnAddedMs: (results["publication"]! - results["component"]!) * n,
        canonicalRowsPerDelta: 3,
        componentRowsPerDelta: 1,
        conversationUpdatesPerDelta: 1,
        batching: false
      })
    );
  }, 20000);
});
