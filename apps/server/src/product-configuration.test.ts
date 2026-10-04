vi.mock("./outward-effects.js", () => import("./test-support/offline-outward-effects.js"));
vi.mock("./media-effects.js", () => import("./test-support/offline-media-effects.js"));
vi.mock("./presentation-effects.js", () => import("./test-support/offline-media-effects.js"));
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { emptyProductConfiguration, type ProductConfiguration } from "@companion/providers";
import { createAppContext, type AppContext } from "./context.js";
import { loadServerConfig } from "./config.js";
import { registerProductRoutes } from "./routes/product.js";
import { registerPeopleVoiceRoutes } from "./routes/people-voices.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerMessageRoutes } from "./routes/message.js";
import { createTestProductControlReceiptAdmission } from "./test-support/product-control-receipt.js";
import { createTestProductPersonCommandPort } from "./test-support/product-person-command.js";
import { createTestVoiceControlReceiptAdmission } from "./test-support/voice-control-receipt.js";
import {
  boundedWav,
  retainVoiceSample,
  retainSpeechReview,
  voiceReviews
} from "./services/voice-review.js";
import { readProductSettings, writePrivateJson } from "./services/product-store.js";
import type { MemoryEvent } from "@companion/memory";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const oldEnv = { ...process.env };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  process.env = { ...oldEnv };
  vi.unstubAllGlobals();
});
async function setup(existing?: string) {
  const dir = existing ?? (await mkdtemp(join(tmpdir(), "astra3-")));
  if (!existing) cleanups.push(() => rm(dir, { recursive: true, force: true }));
  process.env = {
    NODE_ENV: "test",
    RUNTIME_MODE: "development",
    YUVI_RUNTIME_ENV_DIR: dir,
    LOG_LEVEL: "silent",
    PROVIDER_ALLOW_MOCKS: "false",
    MEMORY_REPOSITORY: "in-memory",
    EVENT_BUS: "in-memory",
    MEMORY_INGESTION_COORDINATOR_ENABLED: "false",
    MEMORY_MAINTENANCE_ENABLED: "false"
  };
  const config = loadServerConfig(process.env);
  const app = Fastify({ logger: false });
  const context = await createAppContext(app.log, config);
  context.conversationalReceiptAdmission = {
    admit: async () => ({
      status: "APPENDED",
      envelope: {
        eventId: "jev1_productconfigurationreceipt01",
        journalNamespace: "test:product-configuration"
      } as never
    })
  };
  context.productControlReceiptAdmission = createTestProductControlReceiptAdmission();
  context.productPersonCommands = createTestProductPersonCommandPort();
  context.voiceControlReceiptAdmission = createTestVoiceControlReceiptAdmission();
  await registerProductRoutes(app, context, config);
  await registerPeopleVoiceRoutes(app, context, config);
  await registerProviderRoutes(app, context, config);
  await registerMessageRoutes(app, context);
  const close = async () => {
    context.runtime.stopProactiveScheduler();
    await context.runtime.sealAndDrainMemoryWrites();
    context.embodiedPresentationBridge.close();
    await context.memoryIngestionCoordinator.shutdown({ graceMs: 100 });
    await context.conversationRepository.close?.();
    await context.finalizedIngestionRepository.close?.();
    await context.memoryRepository.close?.();
    await app.close();
  };
  cleanups.push(close);
  const get = async () =>
    (await app.inject({ method: "GET", url: "/product/configuration" })).json();
  const save = async (configuration: ProductConfiguration, proactive?: unknown) =>
    app.inject({
      method: "PUT",
      url: "/product/configuration",
      payload: {
        configuration,
        revision: (await get()).revision,
        ...(proactive !== undefined ? { proactive } : {})
      }
    });
  return { app, context, dir, get, save };
}
function catalog(): ProductConfiguration {
  const c = emptyProductConfiguration();
  c.providers = [
    {
      id: "endpoint",
      displayName: "My endpoint",
      adapter: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000"
    }
  ];
  c.models = [
    {
      id: "model-a",
      providerId: "endpoint",
      displayName: "Model A",
      modelId: "model-a",
      enabled: true,
      temperature: 0.3,
      contextWindow: null,
      capabilities: ["chat", "reasoning", "proactive", "vision"]
    },
    {
      id: "model-b",
      providerId: "endpoint",
      displayName: "Model B",
      modelId: "model-b",
      enabled: true,
      temperature: 0.6,
      contextWindow: 32000,
      capabilities: ["chat"]
    }
  ];
  return c;
}
function wav(seconds = 1): string {
  const out = Buffer.alloc(44 + 32000 * seconds);
  out.write("RIFF");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(out.length - 44, 40);
  return out.toString("base64");
}
function installNativeVoiceFixture(
  context: AppContext,
  profiles: Array<{ speakerId: string; label: string }>
) {
  let acousticRevision = 0;
  const owner = context.memory.getNativeVoiceBindingOwner();
  if (!owner) throw new Error("Test controller owner is unavailable.");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/speakers"))
        return new Response(
          JSON.stringify({
            speakers: profiles,
            revision: `acoustic-${acousticRevision}`,
            complete: true
          })
        );
      return new Response("not found", { status: 404 });
    })
  );
  context.productPersonCommands = createTestProductPersonCommandPort(async (input) => {
    if (input.family === "ACOUSTIC_PROFILE") {
      if (input.operation === "ENROLL")
        profiles.push({ speakerId: input.voiceProfileId, label: input.label ?? "" });
      else {
        const index = profiles.findIndex((profile) => profile.speakerId === input.voiceProfileId);
        if (index >= 0) profiles.splice(index, 1);
      }
      acousticRevision += 1;
      return { status: "APPLIED", targetReference: input.voiceProfileId };
    }
    if (input.family === "VOICE_BINDING") {
      const command = {
        commandHandle: input.commandHandle,
        intentId: `test-intent-${input.commandHandle}`,
        attemptId: `test-attempt-${input.commandHandle}`,
        fence: "1",
        payloadDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        causalRefs: [
          {
            kind: "JOURNAL_EVENT" as const,
            namespace: "test:voice",
            eventId: `event-${input.commandHandle}`
          }
        ],
        operation: input.operation,
        voiceProfileId: input.voiceProfileId,
        personaId: input.personaId,
        ...(input.personId ? { personId: input.personId } : {}),
        ...(input.previousVoiceProfileId
          ? { previousVoiceProfileId: input.previousVoiceProfileId }
          : {}),
        expectedBindingRevision: input.expectedBindingRevision,
        ...(input.expectedPreviousBindingRevision !== undefined
          ? { expectedPreviousBindingRevision: input.expectedPreviousBindingRevision }
          : {})
      };
      const fence = await owner.fenceBindingCommand(command);
      if (fence === "CONFLICT")
        return { status: "CONFLICT", reason: "TEST_BINDING_FENCE_CONFLICT" };
      if (fence === "READY") {
        const applied = await owner.applyBindingCommand(command);
        if (applied.status !== "APPLIED" && applied.status !== "ALREADY_APPLIED")
          return { status: "CONFLICT", reason: "TEST_BINDING_REJECTED" };
      }
      return { status: "APPLIED", targetReference: input.voiceProfileId };
    }
    return { status: "UNAVAILABLE", reason: "TEST_NATIVE_COMMAND_NOT_CONFIGURED" };
  });
}
it("first run, discovery/manual ID, Chat admission, independent routes and UNKNOWN routing behavior", async () => {
  const { app, context, save, get } = await setup();
  expect((await get()).conversationalReady).toBe(false);
  for (const route of Object.values((await get()).routes) as any[])
    expect(route.state).toBe("NOT_CONFIGURED");
  const c = catalog();
  expect((await save(c)).statusCode).toBe(200);
  const calls: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/models"))
        return new Response(JSON.stringify({ data: [{ id: "discovered" }] }));
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.model === "model-a") return new Response("unavailable", { status: 503 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] })
      );
    })
  );
  const discovery = await app.inject({ method: "POST", url: "/product/providers/endpoint/test" });
  expect(discovery.json().models).toEqual([{ modelId: "discovered", contextWindow: null }]);
  c.routes.chat = ["model-a", "model-b"];
  expect((await save(c)).json().conversationalReady).toBe(true);
  expect(context.providers.getChatContextWindow()).toBeUndefined();
  const verification = await app.inject({ method: "POST", url: "/providers/verify/chat" });
  expect(verification.statusCode).toBe(502);
  expect(verification.json().provider).toBe("model-a");
  expect(calls.map((c) => c.model)).toEqual(["model-a"]);
  c.routes.chat.reverse();
  expect((await save(c)).statusCode).toBe(200);
  const chat = await app.inject({
    method: "POST",
    url: "/message",
    payload: {
      content: "Hello",
      sessionId: "onboarding",
      options: { readMemory: false, writeMemory: false }
    }
  });
  expect(chat.statusCode).toBe(200);
  expect(calls.map((c) => c.model)).toEqual(["model-a", "model-b"]);
  c.routes.chat.reverse();
  c.routes.reasoning = ["model-a"];
  c.routes.proactive = ["model-a"];
  c.routes.vision = ["model-a"];
  expect((await save(c, { threshold: 0.25, intervalMs: 15000 })).statusCode).toBe(200);
  expect((await get()).proactive).toEqual({ threshold: 0.25, intervalMs: 15000 });
  expect((await get()).routes.chat.modelIds).toEqual(["model-a", "model-b"]);
  expect(context.activeRuntimeEnv["PROACTIVE_SCORE_THRESHOLD"]).toBe("0.25");
  expect(context.activeRuntimeEnv["PROACTIVE_EVALUATION_INTERVAL_MS"]).toBe("15000");
  for (const cap of ["reasoning", "proactive", "vision"] as const) {
    expect((await get()).routes[cap].state).toBe("ACTIVE");
    c.routes[cap] = [];
  }
  expect((await save(c)).statusCode).toBe(200);
  expect((await get()).routes.proactive.state).toBe("NOT_CONFIGURED");
  c.routes.stt = ["model-a"];
  expect((await save(c)).statusCode).toBe(400);
});
it("discovers models at the saved custom API base", async () => {
  const { app, save } = await setup();
  const c = catalog();
  c.providers[0]!.baseUrl = "https://api.deepinfra.com/v1/openai";
  await save(c);
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "remote-model" }] })));
  vi.stubGlobal("fetch", fetchMock);
  const response = await app.inject({ method: "POST", url: "/product/providers/endpoint/test" });
  expect(response.statusCode).toBe(200);
  expect(response.json().models).toEqual([{ modelId: "remote-model", contextWindow: null }]);
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.deepinfra.com/v1/openai/models",
    expect.anything()
  );
});
it("secrets never returned, stale writes rejected, failures and embedding restart requirements are truthful", async () => {
  const { app, context, save, get } = await setup();
  const c = catalog();
  c.providers[0]!.apiKey = "private-test-key";
  c.routes.chat = ["model-a"];
  const initial = await save(c);
  expect(initial.body).not.toContain("private-test-key");
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/product/configuration",
        payload: { revision: 0, configuration: c }
      })
    ).statusCode
  ).toBe(409);
  const reload = vi
    .spyOn(context, "reloadRuntimeConfig")
    .mockRejectedValueOnce(new Error("failure"));
  c.routes.chat = ["model-b"];
  expect((await save(c)).json().applyState).toBe("APPLY_FAILED");
  expect((await get()).routes.chat.modelIds).toEqual(["model-a"]);
  expect((await save(c)).json().applyState).toBe("ACTIVE");
  c.models.push({
    id: "embed",
    providerId: "endpoint",
    displayName: "Embed",
    modelId: "embed",
    enabled: true,
    temperature: 0,
    contextWindow: null,
    capabilities: ["embedding"],
    dimensions: 1024
  });
  c.routes.embedding = ["embed"];
  const calls = reload.mock.calls.length;
  expect((await save(c)).json().applyState).toBe("RESTART_REQUIRED");
  expect(reload.mock.calls.length).toBe(calls);
  expect((await get()).routes.embedding.modelIds).toEqual([]);
});

it("rejects malformed proactive settings before Journal admission or Product mutation", async () => {
  const { context, save } = await setup();
  const initial = await save(emptyProductConfiguration(), { threshold: 0.7, intervalMs: 60000 });
  expect(initial.statusCode).toBe(200);
  const before = structuredClone(readProductSettings(process.env));
  expect(before).not.toBeNull();
  const admission = vi.spyOn(context.productControlReceiptAdmission, "admit");
  const malformed: unknown[] = [
    false,
    null,
    0,
    "",
    {},
    { threshold: 0.5 },
    { intervalMs: 15000 },
    { threshold: -1, intervalMs: 15000 },
    { threshold: 0.5, intervalMs: 999 },
    { threshold: 0.5, intervalMs: 15000, extra: true }
  ];

  for (const proactive of malformed) {
    const response = await save(emptyProductConfiguration(), proactive);
    expect(response.statusCode, JSON.stringify(proactive)).toBe(400);
    expect(admission, JSON.stringify(proactive)).not.toHaveBeenCalled();
    expect(readProductSettings(process.env)).toEqual(before);
  }
});
function memoryOnDisk(context: AppContext, dir: string) {
  const file = join(dir, "test-memory-events.json");
  function events(): MemoryEvent[] {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return [];
    }
  }
  context.memory.getMemoryProvider = () => ({
    retrieveRelevant: async () => ({ status: "empty", events: [], limited: false, source: "test" }),
    getEvent: async ({ id, scope }) =>
      events().find((e) => e.id === id && e.scope === scope) ?? null,
    writeEvent: async (input) => {
      const all = events();
      const id = `event-${all.length}`;
      const event = {
        ...input,
        id,
        source: "test",
        sourceRecordId: id,
        metadata: input.metadata ?? {}
      };
      writePrivateJson(file, [...all, event]);
      return { status: "written", eventId: id, event };
    }
  });
}

it("product people reuse the current persona without exposing a second persona writer", async () => {
  const run = await setup();
  run.context.activeRuntimeEnv["MEMORY_PERSONA_ID"] = "alice";
  const memoryWrite = vi.fn();
  run.context.memory.getMemoryProvider = () => ({ writeEvent: memoryWrite }) as never;
  const response = await run.app.inject({
    method: "POST",
    url: "/product/people",
    payload: {
      displayName: "Rui",
      notes: "My profile",
      primary: true,
      commandHandle: "person-create-non-evidence",
      expectedPersonRevision: null,
      expectedPrimaryRevision: null
    }
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.profileEvidence).toMatchObject({
    classification: "NON_EVIDENCE",
    projectionVersion: "product-person-profile.v1",
    owner: "PRODUCT_PERSON_STORE"
  });
  expect(memoryWrite).not.toHaveBeenCalled();
  expect(body.personId).toMatch(/^[a-f0-9-]{36}$/);
  const saved = readProductSettings();
  expect(body.profileEvidence.personRevision).toBe(saved?.personRevisionById?.[body.personId]);
  expect(saved?.personRevisionById?.[body.personId]).toMatch(/^[a-f0-9-]{36}$/);
  expect(saved?.primaryPersonRevision).toMatch(/^[a-f0-9-]{36}$/);
  expect(saved?.primaryPersonId).toBe(body.personId);
  expect(saved?.people[0]).toMatchObject({
    id: body.personId,
    displayName: "Rui",
    personaId: "alice",
    notes: "My profile"
  });
});

it("product people never invent a persona when no current scope exists", async () => {
  const run = await setup();
  delete run.context.activeRuntimeEnv["MEMORY_PERSONA_ID"];
  const response = await run.app.inject({
    method: "POST",
    url: "/product/people",
    payload: {
      displayName: "Rui",
      notes: "",
      primary: true,
      commandHandle: "person-create-no-persona",
      expectedPersonRevision: null,
      expectedPrimaryRevision: null
    }
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain("Current YUVI persona is not configured");
  expect(readProductSettings()?.people ?? []).toEqual([]);
});

it("compares authored Person and primary revisions independently of global settings", async () => {
  const run = await setup();
  run.context.activeRuntimeEnv["MEMORY_PERSONA_ID"] = "alice";
  const create = await run.app.inject({
    method: "POST",
    url: "/product/people",
    payload: {
      displayName: "Rui",
      notes: "first",
      primary: true,
      commandHandle: "person-create-revision-check",
      expectedPersonRevision: null,
      expectedPrimaryRevision: null
    }
  });
  const personId = create.json().personId as string;
  const before = readProductSettings()!;
  const personRevision = before.personRevisionById?.[personId];
  const primaryRevision = before.primaryPersonRevision;
  expect(personRevision).toBeTruthy();
  expect(primaryRevision).toBeTruthy();

  const update = await run.app.inject({
    method: "POST",
    url: "/product/people",
    payload: {
      id: personId,
      displayName: "Rui",
      notes: "second",
      primary: true,
      commandHandle: "person-update-revision-check",
      expectedPersonRevision: personRevision,
      expectedPrimaryRevision: primaryRevision
    }
  });
  expect(update.statusCode).toBe(200);
  const after = readProductSettings()!;
  expect(after.personRevisionById?.[personId]).not.toBe(personRevision);
  expect(after.primaryPersonRevision).toBe(primaryRevision);

  const stale = await run.app.inject({
    method: "POST",
    url: "/product/people",
    payload: {
      id: personId,
      displayName: "Stale",
      notes: "must not commit",
      primary: false,
      commandHandle: "person-update-stale-revision",
      expectedPersonRevision: personRevision,
      expectedPrimaryRevision: primaryRevision
    }
  });
  expect(stale.statusCode).toBe(409);
  expect(readProductSettings()).toEqual(after);
});
it("explicit three-utterance enrollment, Person binding restart, unknown sample review and unbinding use Runtime/Memory seams", async () => {
  let run = await setup();
  const c = catalog();
  c.providers.push({
    id: "local-stt",
    displayName: "Local speech",
    baseUrl: "http://127.0.0.1:9876",
    adapter: "local-stt"
  });
  c.models.push({
    id: "speech",
    displayName: "Speech",
    modelId: "sensevoice",
    providerId: "local-stt",
    capabilities: ["stt"],
    contextWindow: null,
    temperature: 0,
    enabled: true
  });
  c.routes.stt = ["speech"];
  await run.save(c);
  const personResponse = await run.app.inject({
    method: "POST",
    url: "/product/people",
    payload: {
      displayName: "Rui",
      personaId: "alice",
      notes: "My profile",
      primary: true,
      commandHandle: "person-create-voice-flow",
      expectedPersonRevision: null,
      expectedPrimaryRevision: null
    }
  });
  expect(personResponse.statusCode).toBe(200);
  const personId = (await run.get()).primaryPersonId;
  expect(personId).toMatch(/^[a-f0-9-]{36}$/);
  memoryOnDisk(run.context, run.dir);
  const profiles: any[] = [];
  installNativeVoiceFixture(run.context, profiles);
  const enrolled = await run.app.inject({
    method: "POST",
    url: "/product/voices/enroll",
    payload: {
      personId,
      commandHandle: "product-voice-enroll-flow",
      recordings: [wav(), wav(), wav()]
    }
  });
  expect(enrolled.statusCode).toBe(200);
  const id = profiles[0].speakerId;
  expect(await run.context.runtime.getVoiceProfilePerson(id)).toBe(personId);
  run = await setup(run.dir);
  memoryOnDisk(run.context, run.dir);
  installNativeVoiceFixture(run.context, profiles);
  expect((await run.get()).primaryPersonId).toBe(personId);
  expect(await run.context.runtime.getVoiceProfilePerson(id)).toBe(personId);
  expect(await run.context.runtime.getVoiceProfilePerson("unknown")).toBeNull();
  const sample = retainVoiceSample(wav());
  const play = await run.app.inject({ method: "GET", url: `/product/voice-samples/${sample.id}` });
  expect(play.headers["content-type"]).toContain("audio/wav");
  expect(play.rawPayload.length).toBeGreaterThan(44);
  expect(
    (
      await run.app.inject({
        method: "POST",
        url: `/product/voice-samples/${sample.id}/review`,
        payload: { leaveUnknown: true }
      })
    ).statusCode
  ).toBe(200);
  expect(profiles).toHaveLength(1);
  expect(
    (
      await run.app.inject({
        method: "POST",
        url: `/product/voice-samples/${sample.id}/review`,
        payload: { personId, commandHandle: "review-sample-voice-command" }
      })
    ).statusCode
  ).toBe(200);
  expect(profiles).toHaveLength(2);
  expect(await run.context.runtime.getVoiceProfilePerson(profiles[1].speakerId)).toBe(personId);
  expect(
    (
      await run.app.inject({
        method: "DELETE",
        url: `/product/voices/${id}/binding?commandHandle=remove-integration-binding`
      })
    ).statusCode
  ).toBe(200);
  expect(await run.context.runtime.getVoiceProfilePerson(id)).toBeNull();
  expect(await run.context.runtime.getVoiceProfilePerson(profiles[1].speakerId)).toBe(personId);
  await run.app.inject({ method: "DELETE", url: `/product/voice-samples/${sample.id}` });
  expect(
    (await run.app.inject({ method: "GET", url: `/product/voice-samples/${sample.id}` })).statusCode
  ).toBe(404);
  expect(readProductSettings()?.people[0]?.notes).toBe("My profile");
});
it("rejects ambiguous voice-review intent before Journal admission or review mutation", async () => {
  const run = await setup();
  const sample = retainVoiceSample(wav());
  const admit = vi.spyOn(run.context.voiceControlReceiptAdmission, "admit");
  const malformed: Array<Record<string, unknown>> = [
    {},
    { leaveUnknown: false },
    { leaveUnknown: true, personId: "person-target" },
    { personId: "" },
    { personId: "   " },
    { personId: "person-target", extra: true }
  ];
  for (const payload of malformed) {
    const response = await run.app.inject({
      method: "POST",
      url: `/product/voice-samples/${sample.id}/review`,
      payload
    });
    expect(response.statusCode).toBe(400);
    expect(admit).not.toHaveBeenCalled();
    expect(voiceReviews().find((row) => row.id === sample.id)).toEqual(sample);
  }
});
it("re-enrollment replaces the old acoustic profile instead of leaving an unbound residual", async () => {
  const run = await setup();
  const c = catalog();
  c.providers.push({
    id: "local-stt",
    displayName: "Local speech",
    baseUrl: "http://127.0.0.1:9876",
    adapter: "local-stt"
  });
  c.models.push({
    id: "speech",
    displayName: "Speech",
    modelId: "sensevoice",
    providerId: "local-stt",
    capabilities: ["stt"],
    contextWindow: null,
    temperature: 0,
    enabled: true
  });
  c.routes.stt = ["speech"];
  await run.save(c);
  const person = await run.app.inject({
    method: "POST",
    url: "/product/people",
    payload: {
      displayName: "Rui",
      personaId: "alice",
      notes: "",
      primary: true,
      commandHandle: "person-create-reenroll-flow",
      expectedPersonRevision: null,
      expectedPrimaryRevision: null
    }
  });
  expect(person.statusCode).toBe(200);
  const personId = (await run.get()).primaryPersonId;
  memoryOnDisk(run.context, run.dir);

  const profiles: Array<{ speakerId: string; label: string }> = [];
  installNativeVoiceFixture(run.context, profiles);

  const first = await run.app.inject({
    method: "POST",
    url: "/product/voices/enroll",
    payload: {
      personId,
      commandHandle: "initial-voice-reenroll",
      recordings: [wav(), wav(), wav()]
    }
  });
  expect(first.statusCode).toBe(200);
  const originalId = profiles[0]!.speakerId;
  expect(voiceReviews().some((r) => r.voiceProfileId === originalId)).toBe(true);

  const replacement = await run.app.inject({
    method: "POST",
    url: "/product/voices/enroll",
    payload: {
      personId,
      commandHandle: "replacement-voice-reenroll",
      recordings: [wav(), wav(), wav()],
      replaceVoiceId: originalId
    }
  });
  expect(replacement.statusCode).toBe(200);
  expect(profiles).toHaveLength(1);
  expect(profiles[0]!.speakerId).not.toBe(originalId);
  expect(await run.context.runtime.getVoiceProfilePerson(originalId)).toBeNull();
  expect(await run.context.runtime.getVoiceProfilePerson(profiles[0]!.speakerId)).toBe(personId);
  expect(voiceReviews().some((r) => r.voiceProfileId === originalId)).toBe(false);
});
it("samples are local, bounded, single-speaker excerpts and never continuous", async () => {
  await setup();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(boundedWav(wav(12)).length).toBe(44 + 8 * 32000);
  expect(() => boundedWav("not-a-wav")).toThrow();
  for (let i = 0; i < 35; i++) retainVoiceSample(wav(), `profile-${i}`);
  expect(voiceReviews()).toHaveLength(30);
  const prior = voiceReviews().length;
  retainSpeechReview(wav(), {
    text: "mixed",
    segments: [
      { speakerClusterId: "a", segmentId: "a" },
      { speakerClusterId: "b", segmentId: "b" }
    ],
    voiceProfileMatch: { status: "NO_MATCH" }
  });
  expect(voiceReviews()).toHaveLength(prior);
  expect(fetch).not.toHaveBeenCalled();
});
