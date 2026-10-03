import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { registerLocalServiceRoutes } from "./local-services.js";
import { registerSystemRoutes } from "./system.js";
import { restartDailyUseServices } from "../services/daily-use.js";
import { createTestVoiceControlReceiptAdmission } from "../test-support/voice-control-receipt.js";
import { JournalStoreError } from "@companion/journal";
vi.mock("../services/daily-use.js", () => ({ restartDailyUseServices: vi.fn() }));
function pcmWav(dataSize = 900_000) {
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(dataSize, 40);
  return bytes.toString("base64");
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("fails closed before enrollment when durable voice admission is unavailable", async () => {
  const profiles = {
    enroll: vi.fn(async (input: { voiceProfileId: string; label: string }) => input),
    list: vi.fn(async () => []),
    readAuthorityState: vi.fn(async () => ({ complete: true, revision: "acoustic-before", profiles: [] }))
  };
  const admission = { admit: vi.fn(async () => { throw new JournalStoreError("DATABASE_UNAVAILABLE", "unavailable"); }) };
  const dataDir = await mkdtemp(join(tmpdir(), "yuvi-local-voice-test-"));
  vi.stubEnv("YUVI_RUNTIME_DATA_DIR", dataDir);
  const execute = vi.fn(async () => ({ status: "UNAVAILABLE" as const, reason: "DURABLE_NATIVE_CONTROL_UNAVAILABLE" }));
  const app = Fastify();
  await registerLocalServiceRoutes(
    app,
    {
      providers: { getSTTProvider: () => ({ voiceProfiles: profiles }) },
      voiceControlReceiptAdmission: admission,
      productPersonCommands: { execute, resolveExisting: vi.fn(async () => null) }
    } as unknown as AppContext,
    { runtimeMode: "development" } as ServerConfig
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/voice-profiles",
      payload: { audioBase64: pcmWav(32_000), mimeType: "audio/wav", label: "private label", commandHandle: "local-enroll-unavailable" }
    });
    expect(response.statusCode).toBe(503);
    expect(profiles.list).toHaveBeenCalledOnce();
    expect(admission.admit).not.toHaveBeenCalled();
    expect(profiles.enroll).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("protects acoustic profile operations and accepts a bounded recording larger than Fastify's default", async () => {
  const profiles = {
    enroll: vi.fn(async (input) => ({ voiceProfileId: input.voiceProfileId, label: input.label })),
    list: vi.fn(async () => []),
    readAuthorityState: vi.fn(async () => ({ complete: true, revision: "acoustic-before", profiles: [] }))
  };
  const order: string[] = [];
  profiles.enroll.mockImplementation(async (input) => {
    order.push("enroll");
    return { voiceProfileId: input.voiceProfileId, label: input.label };
  });
  const dataDir = await mkdtemp(join(tmpdir(), "yuvi-local-voice-test-"));
  vi.stubEnv("YUVI_RUNTIME_DATA_DIR", dataDir);
  const execute = vi.fn(async input => {
    order.push("a9");
    expect(input).toMatchObject({ family: "ACOUSTIC_PROFILE", operation: "ENROLL", commandHandle: "local-enroll-command:acoustic-enroll" });
    expect(input).not.toHaveProperty("audioBase64");
    return { status: "APPLIED" as const, targetReference: input.voiceProfileId };
  });
  const app = Fastify();
  await registerLocalServiceRoutes(
    app,
    {
      providers: { getSTTProvider: () => ({ voiceProfiles: profiles }) },
      voiceControlReceiptAdmission: createTestVoiceControlReceiptAdmission(() => { order.push("obsolete"); }),
      productPersonCommands: { execute, resolveExisting: vi.fn(async () => null) }
    } as unknown as AppContext,
    { runtimeMode: "development", dashboardDevToken: "test-token" } as ServerConfig
  );
  try {
    const payload = {
      audioBase64: pcmWav(),
      mimeType: "audio/wav",
      label: "Acoustic label",
      commandHandle: "local-enroll-command"
    };
    expect((await app.inject({ method: "POST", url: "/voice-profiles", payload })).statusCode).toBe(
      401
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/voice-profiles",
          remoteAddress: "192.0.2.1",
          headers: { authorization: "Bearer test-token" },
          payload
        })
      ).statusCode
    ).toBe(403);
    expect(profiles.enroll).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "POST",
      url: "/voice-profiles",
      headers: { authorization: "Bearer test-token" },
      payload
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ label: "Acoustic label", voiceProfileId: expect.any(String) });
    expect(order).toEqual(["a9"]);
    expect(profiles.enroll).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/voice-profiles",
          headers: { authorization: "Bearer test-token" },
          payload: { ...payload, personId: "forged-person", voiceProfileId: "forged-profile" }
        })
      ).statusCode
    ).toBe(400);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("only schedules the fixed daily restart for an authenticated local request under the launcher", async () => {
  const app = Fastify();
  await registerSystemRoutes(app, {
    runtimeMode: "development",
    dashboardDevToken: "test-token"
  } as ServerConfig);
  const request = {
    method: "POST" as const,
    url: "/system/local-services/restart",
    headers: { authorization: "Bearer test-token" }
  };
  try {
    vi.stubEnv("YUVI_DAILY_USE_SYSTEMD", "0");
    expect((await app.inject(request)).statusCode).toBe(409);
    vi.stubEnv("YUVI_DAILY_USE_SYSTEMD", "1");
    expect((await app.inject({ ...request, headers: {} })).statusCode).toBe(401);
    expect((await app.inject({ ...request, remoteAddress: "192.0.2.1" })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          ...request,
          headers: { ...request.headers, origin: "https://unrelated.example" }
        })
      ).statusCode
    ).toBe(403);
    expect(restartDailyUseServices).not.toHaveBeenCalled();
    if (process.platform === "linux") {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      expect(
        (await app.inject({ ...request, payload: { unit: "postgres.service" } })).statusCode
      ).toBe(200);
      expect(restartDailyUseServices).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(restartDailyUseServices).toHaveBeenCalledWith();
    }
  } finally {
    await app.close();
  }
});
