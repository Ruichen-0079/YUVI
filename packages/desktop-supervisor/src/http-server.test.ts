import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopSupervisor } from "./supervisor.js";
import { CONTROL_TOKEN_HEADER, startSupervisorHttpServer, tokensMatch } from "./http-server.js";
import { assertLoopbackHost, generateControlToken } from "./config.js";
import type { SupervisorConfig } from "./types.js";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function cfg(): SupervisorConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-http-"));
  tempDirs.push(stateDirectory);
  const repositoryRoot = "C:\\Dev\\UV-main";
  return {
    layout: { mode: "development", repositoryRoot },
    repositoryRoot,
    stateDirectory,
    instanceId: "inst-http",
    ownershipToken: "own-tok",
    controlToken: generateControlToken(),
    controlHost: "127.0.0.1",
    controlPort: 0,
    env: {},
    memoryBackend: "mem0",
    autostartRuntime: false,
    autostartMem0: false,
    autostartTts: false,
    runtimeUrl: "http://127.0.0.1:6121",
    mem0Url: "http://127.0.0.1:6131",
    ttsWrapperUrl: "http://127.0.0.1:9881",
    ttsUpstreamUrl: "http://127.0.0.1:9880",
    ollamaUrl: "http://127.0.0.1:11434",
    databaseUrl: null,
    runtimeStart: null,
    mem0Start: null,
    ttsWrapperStart: null,
    ttsUpstreamStart: null
  };
}

async function request(
  port: number,
  method: string,
  pathName: string,
  token?: string,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = token ? { [CONTROL_TOKEN_HEADER]: token } : {};
    if (body != null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

describe("control plane auth + loopback", () => {
  it("rejects non-loopback bind hosts", () => {
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow(/loopback/i);
    expect(() => assertLoopbackHost("192.168.1.10")).toThrow(/loopback/i);
    expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
  });

  it("requires token for write and status; health is public", async () => {
    const config = cfg();
    const supervisor = new DesktopSupervisor(config);
    const { server, port } = await startSupervisorHttpServer(supervisor, {
      host: "127.0.0.1",
      controlToken: config.controlToken
    });
    servers.push(server);

    const health = await request(port, "GET", "/health");
    expect(health.status).toBe(200);

    const noTok = await request(port, "POST", "/v1/refresh");
    expect(noTok.status).toBe(401);

    const badTok = await request(
      port,
      "POST",
      "/v1/refresh",
      "wrong-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    );
    expect(badTok.status).toBe(401);

    const statusNoTok = await request(port, "GET", "/v1/status");
    expect(statusNoTok.status).toBe(401);

    const ok = await request(port, "GET", "/v1/status", config.controlToken);
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body) as Record<string, unknown>;
    expect(body["instanceId"]).toBe("inst-http");
    // Token must never appear in status payload.
    expect(JSON.stringify(body)).not.toContain(config.controlToken);
  });

  it("tokensMatch rejects mismatched lengths", () => {
    expect(tokensMatch("abcd", null)).toBe(false);
    expect(tokensMatch("abcd", "ab")).toBe(false);
    expect(tokensMatch("abcd", "abcd")).toBe(true);
  });

  it("generateControlToken is high entropy length", () => {
    const a = generateControlToken();
    const b = generateControlToken();
    expect(a).toHaveLength(64);
    expect(b).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it("POST /v1/config requires token and does not echo secrets", async () => {
    const config = cfg();
    const supervisor = new DesktopSupervisor(config);
    const { server, port } = await startSupervisorHttpServer(supervisor, {
      host: "127.0.0.1",
      controlToken: config.controlToken
    });
    servers.push(server);

    const secret = "sk-http-secret-should-not-echo";
    const payload = JSON.stringify({
      env: {
        DEEPSEEK_CHAT_MODEL: "model-B",
        DEEPSEEK_API_KEY: secret,
        MEM0_BASE_URL: "http://127.0.0.1:6133"
      },
      unsetEnv: []
    });

    const noTok = await request(port, "POST", "/v1/config", undefined, payload);
    expect(noTok.status).toBe(401);

    const badTok = await request(
      port,
      "POST",
      "/v1/config",
      "wrong-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      payload
    );
    expect(badTok.status).toBe(401);

    const ok = await request(port, "POST", "/v1/config", config.controlToken, payload);
    expect(ok.status).toBe(200);
    expect(ok.body).not.toContain(secret);
    expect(ok.body).not.toContain("DEEPSEEK_API_KEY");
    const parsed = JSON.parse(ok.body) as { ok: boolean; appliedEnvKeys: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.appliedEnvKeys).toContain("DEEPSEEK_CHAT_MODEL");
    expect(parsed.appliedEnvKeys).toContain("MEM0_BASE_URL");

    expect(supervisor.resolveHealthUrl("mem0")).toBe("http://127.0.0.1:6133/health");

    const status = await request(port, "GET", "/v1/status", config.controlToken);
    expect(status.status).toBe(200);
    expect(status.body).not.toContain(secret);
  });

  it("POST /v1/config rejected during shutdown", async () => {
    const config = cfg();
    const supervisor = new DesktopSupervisor(config);
    const { server, port } = await startSupervisorHttpServer(supervisor, {
      host: "127.0.0.1",
      controlToken: config.controlToken
    });
    servers.push(server);
    await supervisor.shutdown();
    const res = await request(
      port,
      "POST",
      "/v1/config",
      config.controlToken,
      JSON.stringify({ env: { DEEPSEEK_CHAT_MODEL: "x" }, unsetEnv: [] })
    );
    expect(res.status).toBe(409);
    expect(res.body).not.toContain("DEEPSEEK");
  });

  it("POST /v1/shutdown drains and signals terminal shutdown exactly once", async () => {
    const config = cfg();
    const supervisor = new DesktopSupervisor(config);
    let shutdownSignals = 0;
    const { server, port } = await startSupervisorHttpServer(supervisor, {
      host: "127.0.0.1",
      controlToken: config.controlToken,
      onShutdownComplete: () => {
        shutdownSignals += 1;
      }
    });
    servers.push(server);

    const first = await request(port, "POST", "/v1/shutdown", config.controlToken);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ ok: true });
    expect(shutdownSignals).toBe(1);

    // Repeated shutdown is idempotent: no second terminal-exit signal.
    const second = await request(port, "POST", "/v1/shutdown", config.controlToken);
    expect(second.status).toBe(200);
    expect(shutdownSignals).toBe(1);
  });

  it("POST local_stt stop preserves snapshot shape and reports the bounded suspend outcome", async () => {
    const config = cfg();
    const supervisor = new DesktopSupervisor(config);
    vi.spyOn(supervisor, "suspendLocalStt").mockResolvedValue({
      outcome: "BUSY",
      reason: "LEASE_ACTIVE",
      activeVoiceLeases: 1,
      snapshot: supervisor.snapshot()
    });
    const { server, port } = await startSupervisorHttpServer(supervisor, {
      host: "127.0.0.1",
      controlToken: config.controlToken
    });
    servers.push(server);

    const res = await request(port, "POST", "/v1/services/local_stt/stop", config.controlToken);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      instanceId: string;
      services: unknown[];
      operation: Record<string, unknown>;
    };
    expect(body.instanceId).toBe("inst-http");
    expect(Array.isArray(body.services)).toBe(true);
    expect(body.operation).toEqual({
      serviceId: "local_stt",
      action: "stop",
      outcome: "BUSY",
      reason: "LEASE_ACTIVE",
      activeVoiceLeases: 1
    });
  });

  it("POST /v1/shutdown signals terminal shutdown even when the drain fails", async () => {
    const config = cfg();
    const supervisor = new DesktopSupervisor(config);
    let shutdownSignals = 0;
    const { server, port } = await startSupervisorHttpServer(supervisor, {
      host: "127.0.0.1",
      controlToken: config.controlToken,
      onShutdownComplete: () => {
        shutdownSignals += 1;
      }
    });
    servers.push(server);
    vi.spyOn(supervisor, "shutdown").mockRejectedValueOnce(new Error("drain failure"));

    const res = await request(port, "POST", "/v1/shutdown", config.controlToken);
    expect(res.status).toBe(500);
    expect(shutdownSignals).toBe(1);
  });
});

it("routes numeric service IDs through the existing lifecycle authority", async () => {
  const config = cfg();
  const supervisor = new DesktopSupervisor(config);
  const start = vi.spyOn(supervisor, "ensureService").mockResolvedValue(undefined);
  const restart = vi.spyOn(supervisor, "restartService").mockResolvedValue(supervisor.snapshot());
  const stop = vi.spyOn(supervisor, "stopService").mockResolvedValue(supervisor.snapshot());
  const { server, port } = await startSupervisorHttpServer(supervisor, {
    host: "127.0.0.1",
    controlToken: config.controlToken
  });
  servers.push(server);
  for (const action of ["start", "restart", "stop"]) {
    expect(
      (await request(port, "POST", `/v1/services/mem0/${action}`, config.controlToken)).status
    ).toBe(200);
  }
  expect(start).toHaveBeenCalledWith("mem0");
  expect(restart).toHaveBeenCalledWith("mem0");
  expect(stop).toHaveBeenCalledWith("mem0");
  expect((await request(port, "POST", "/v1/services/mem1/start", config.controlToken)).status).toBe(
    404
  );
});

describe("native product pairing boundary", () => {
  it("requires controller token, refuses browser callers, and returns only one-use ceremony data", async () => {
    const config = cfg();
    const supervisor = new DesktopSupervisor(config);
    const create = vi.spyOn(supervisor, "createProductHostPairing").mockResolvedValue({
      schema: "host.product-pairing.v1",
      code: "yup_" + "x".repeat(43),
      origin: "http://127.0.0.1:31910",
      expiresInSeconds: 300
    });
    const { server, port } = await startSupervisorHttpServer(supervisor, {
      controlToken: config.controlToken
    });
    servers.push(server);
    const payload = { personId: "synthetic-x", origin: "http://127.0.0.1:31910" };
    const endpoint = `http://127.0.0.1:${port}/v1/product-host/pairings`;
    const send = (headers: Record<string, string>) =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload)
      });
    expect((await send({})).status).toBe(401);
    for (const header of ["origin", "referer", "sec-fetch-site"])
      expect(
        (
          await send({
            [CONTROL_TOKEN_HEADER]: config.controlToken,
            [header]: "http://127.0.0.1:31910"
          })
        ).status
      ).toBe(403);
    expect(create).not.toHaveBeenCalled();
    const response = await send({ [CONTROL_TOKEN_HEADER]: config.controlToken });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(config.controlToken);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(payload.personId, payload.origin);
  });
});
