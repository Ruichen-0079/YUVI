import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChildProcessEnv, loadPackagedSupervisorConfig } from "./config.js";
import { layoutFromRoot } from "./postgres-layout.js";
import { DesktopSupervisor } from "./supervisor.js";
import type { StartCommandSpec, SupervisorConfig } from "./types.js";
import * as health from "./health.js";
import * as ownership from "./ownership.js";
import * as processWindows from "./process-windows.js";

const tempDirs: string[] = [];
const supervisors = new Set<DesktopSupervisor>();
let unexpectedSpawnCalls = 0;

function createSupervisor(config: SupervisorConfig): DesktopSupervisor {
  const supervisor = new DesktopSupervisor(config);
  supervisors.add(supervisor);
  return supervisor;
}

async function shutdownTrackedSupervisors(): Promise<void> {
  const cleanupErrors: unknown[] = [];
  const results = await Promise.allSettled(
    [...supervisors].map((supervisor) => supervisor.shutdown())
  );
  for (const result of results) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }
  supervisors.clear();

  vi.restoreAllMocks();
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["DATABASE_URL"];
  delete process.env["MEM0_PG_CONNECTION_STRING"];
  delete process.env["MEM0_LLM_API_KEY"];
  delete process.env["DEEPSEEK_CHAT_MODEL"];
  delete process.env["MEM0_BASE_URL"];

  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  expect(cleanupErrors).toHaveLength(0);
  expect(unexpectedSpawnCalls).toBe(0);
}

beforeEach(() => {
  unexpectedSpawnCalls = 0;
  vi.spyOn(processWindows, "spawnManagedProcess").mockImplementation(() => {
    unexpectedSpawnCalls += 1;
    throw new Error("unexpected managed process spawn in Supervisor unit test");
  });
});

afterEach(async () => {
  await shutdownTrackedSupervisors();
});

/**
 * Platform-independent fake repo root so deriveConfigFromEnv / resolveRuntimeStart
 * keep finding the platform-native dev server runner after applyRuntimeConfig.
 */
function makeTempRepositoryRoot(): string {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-repo-"));
  tempDirs.push(repositoryRoot);
  const scriptsDir = path.join(repositoryRoot, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  const runnerName =
    process.platform === "win32" ? "dev-server-runner.ps1" : "dev-server-runner.sh";
  fs.writeFileSync(
    path.join(scriptsDir, runnerName),
    "# fixture placeholder for supervisor tests\n",
    "utf8"
  );
  return repositoryRoot;
}

function baseConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-sup-"));
  tempDirs.push(stateDirectory);
  const { repositoryRoot: overrideRoot, ...rest } = overrides;
  const repositoryRoot =
    typeof overrideRoot === "string" && overrideRoot.length > 0
      ? overrideRoot
      : makeTempRepositoryRoot();
  return {
    layout: { mode: "development", repositoryRoot },
    repositoryRoot,
    stateDirectory,
    instanceId: "inst-1",
    ownershipToken: "tok-1",
    controlToken: "a".repeat(64),
    controlHost: "127.0.0.1",
    controlPort: 0,
    env: {
      DEEPSEEK_CHAT_MODEL: "model-A",
      DEEPSEEK_API_KEY: "key-A",
      DATABASE_URL: "postgres://yuvi:a@127.0.0.1:5432/yuvi",
      MEM0_BASE_URL: "http://127.0.0.1:6131",
      SERVER_PORT: "6121",
      SERVER_HOST: "127.0.0.1"
    },
    memoryBackend: "mem0",
    autostartRuntime: false,
    autostartMem0: false,
    autostartTts: false,
    runtimeUrl: "http://127.0.0.1:6121",
    mem0Url: "http://127.0.0.1:6131",
    ttsWrapperUrl: "http://127.0.0.1:9881",
    ttsUpstreamUrl: "http://127.0.0.1:9880",
    ollamaUrl: "http://127.0.0.1:11434",
    databaseUrl: "postgres://yuvi:a@127.0.0.1:5432/yuvi",
    // Default stub; applyRuntimeConfig re-derives via fixture scripts/ path.
    // Pass runtimeStart: null when a test wants detect-only / no start command.
    runtimeStart: {
      file: "node",
      args: ["-e", "setInterval(()=>{}, 60000)"],
      cwd: stateDirectory,
      env: { SERVER_PORT: "6121" },
      commandMarker: "node"
    } satisfies StartCommandSpec,
    mem0Start: null,
    ttsWrapperStart: null,
    ttsUpstreamStart: null,
    ...rest
  };
}

it("Portable refuses a Product push that retargets Installed services before committing it", async () => {
  const cfg = baseConfig();
  cfg.env = {...cfg.env, YUVI_PORTABLE_VERSION: "0.1.2", SERVER_PORT: "16121", MEM0_BASE_URL: "http://127.0.0.1:16131"};
  const supervisor = createSupervisor(cfg);
  for (const env of [{SERVER_PORT: "6121"}, {MEM0_BASE_URL: "http://127.0.0.1:6131"}, {YUVI_DATA_ROOT: "/installed"}]) {
    await expect(supervisor.applyRuntimeConfig({env, unsetEnv: []})).rejects.toThrow("Portable isolation");
  }
  expect(supervisor.getConfig().env["SERVER_PORT"]).toBe("16121");
});

it("Portable cannot adopt or spawn over a healthy unowned local service", async () => {
  vi.spyOn(health, "probeHttpHealth").mockResolvedValue({ok: true, statusCode: 200, protocolOk: true, message: "healthy foreign", latencyMs: 1});
  const cfg = baseConfig();
  cfg.env["YUVI_PORTABLE_VERSION"] = "0.1.2";
  const supervisor = createSupervisor(cfg);
  await supervisor.ensureService("runtime");
  expect(supervisor.snapshot().services.find(s => s.id === "runtime")).toMatchObject({status: "unavailable", ownership: "external", pid: null});
  expect(unexpectedSpawnCalls).toBe(0);
});

function packagedConfig(env: Record<string, string> = {}): SupervisorConfig {
  const resourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-packaged-res-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-packaged-data-"));
  tempDirs.push(resourceRoot, dataRoot);
  const runtimeDir = path.join(resourceRoot, "runtime");
  const mem0Dir = path.join(resourceRoot, "mem0");
  const localSttDir = path.join(resourceRoot, "local-stt");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(mem0Dir, { recursive: true });
  fs.mkdirSync(path.join(localSttDir, "_internal"), { recursive: true });
  fs.mkdirSync(path.join(localSttDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "node.exe"), "MZ");
  fs.writeFileSync(path.join(runtimeDir, "yuvi-runtime-server.mjs"), "export {};\n");
  fs.writeFileSync(
    path.join(runtimeDir, "runtime-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      nodeExecutable: "node.exe",
      runtimeEntry: "yuvi-runtime-server.mjs"
    })
  );
  fs.writeFileSync(path.join(mem0Dir, "yuvi-mem0.exe"), "MZ");
  fs.writeFileSync(
    path.join(mem0Dir, "mem0-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 2,
      profileSnapshotMode: "bounded_snapshot",
      platform: "win32",
      arch: "x64",
      executable: "yuvi-mem0.exe",
      healthPath: "/health",
      defaultHost: "127.0.0.1",
      defaultPort: 6131
    })
  );
  fs.writeFileSync(path.join(localSttDir, "yuvi-local-stt.exe"), "MZ");
  fs.writeFileSync(path.join(localSttDir, "_internal", "placeholder.dat"), "x");
  fs.writeFileSync(
    path.join(localSttDir, "models.manifest.json"),
    JSON.stringify({ models: [], runtimeFiles: [] })
  );
  fs.writeFileSync(
    path.join(localSttDir, "local-stt-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      platform: "win32",
      arch: "x64",
      executable: "yuvi-local-stt.exe",
      modelDirectory: "models",
      modelManifest: "models.manifest.json",
      healthPath: "/health",
      defaultHost: "127.0.0.1",
      defaultPort: 9876
    })
  );
  return loadPackagedSupervisorConfig({
    resourceRoot,
    dataRoot,
    env: {
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: "6121",
      MEM0_BASE_URL: "http://127.0.0.1:6131",
      MEMORY_BACKEND: "mem0",
      YUVI_AUTOSTART_RUNTIME: "false",
      YUVI_AUTOSTART_MEM0: "true",
      YUVI_POSTGRES_MODE: "external",
      ...env
    },
    instanceId: "packaged-inst",
    ownershipToken: "packaged-token",
    controlToken: "b".repeat(64)
  });
}

function fakeChild(pid: number): EventEmitter & { pid: number; killed: boolean; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
    kill: () => void;
  };
  child.pid = pid;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", 0, null);
  };
  return child;
}

describe("DesktopSupervisor shutdown", () => {
  it("starts cleanup for every owned service concurrently without stopping external processes", async () => {
    const supervisor = createSupervisor(baseConfig());
    const services = (
      supervisor as unknown as {
        services: Map<
          string,
          {
            child: ReturnType<typeof fakeChild> | null;
            ownership: "none" | "owned" | "external";
            pid: number | null;
          }
        >;
      }
    ).services;
    const runtime = services.get("runtime");
    const mem0 = services.get("mem0");
    const ollama = services.get("ollama");
    if (!runtime || !mem0 || !ollama) throw new Error("expected shutdown fixtures");

    runtime.child = fakeChild(41_001);
    runtime.pid = 41_001;
    runtime.ownership = "owned";
    mem0.child = fakeChild(41_002);
    mem0.pid = 41_002;
    mem0.ownership = "owned";
    ollama.pid = 41_003;
    ollama.ownership = "external";

    let cleanupMayFinish = false;
    vi.spyOn(processWindows, "isProcessAlive").mockImplementation(() => !cleanupMayFinish);
    vi.spyOn(processWindows, "inspectProcess").mockImplementation((processId) => ({
      status: "resolved",
      processId,
      info: {
        processId,
        parentProcessId: 1,
        commandLine: `shutdown-fixture-${processId}`,
        createdAtUtc: new Date()
      }
    }));
    const gracefulStop = vi
      .spyOn(processWindows, "requestGracefulStop")
      .mockImplementation(() => undefined);
    vi.spyOn(processWindows, "forceKillProcessTree").mockImplementation(() => undefined);

    const shutdown = supervisor.shutdown();
    await vi.waitFor(() => expect(gracefulStop).toHaveBeenCalledTimes(2), { timeout: 250 });
    expect(gracefulStop.mock.calls.map(([processId]) => processId).sort()).toEqual([
      41_001, 41_002
    ]);
    expect(gracefulStop).not.toHaveBeenCalledWith(41_003);

    cleanupMayFinish = true;
    await shutdown;
  });

  it("repeated shutdown stays idempotent and drains once", async () => {
    const config = baseConfig();
    const supervisor = createSupervisor(config);

    const first = supervisor.shutdown();
    const second = supervisor.shutdown();
    await Promise.all([first, second]);

    const log = fs.readFileSync(path.join(config.stateDirectory, "supervisor-exit.log"), "utf8");
    expect(log.match(/shutdown complete/g)).toHaveLength(1);
    expect(log).toContain("shutdown already in progress/complete");
  });

  it("does not stop or adopt an external foreign Runtime pid", async () => {
    const supervisor = createSupervisor(baseConfig());
    const services = (
      supervisor as unknown as {
        services: Map<
          string,
          {
            child: ReturnType<typeof fakeChild> | null;
            ownership: "none" | "owned" | "external";
            pid: number | null;
          }
        >;
      }
    ).services;
    const runtime = services.get("runtime");
    if (!runtime) throw new Error("expected runtime");
    runtime.child = null;
    runtime.pid = 41_099;
    runtime.ownership = "external";

    const gracefulStop = vi
      .spyOn(processWindows, "requestGracefulStop")
      .mockImplementation(() => undefined);
    vi.spyOn(processWindows, "forceKillProcessTree").mockImplementation(() => undefined);
    vi.spyOn(processWindows, "isProcessAlive").mockReturnValue(true);

    await supervisor.shutdown();
    expect(gracefulStop).not.toHaveBeenCalledWith(41_099);
    expect(runtime.ownership).toBe("none");
  });

  it("portable shutdown never stops externally routed local STT/TTS processes", async () => {
    const cfg = baseConfig();
    cfg.env = { ...cfg.env, YUVI_PORTABLE_VERSION: "0.1.2" };
    const supervisor = createSupervisor(cfg);
    const services = (
      supervisor as unknown as {
        services: Map<
          string,
          {
            child: ReturnType<typeof fakeChild> | null;
            ownership: "none" | "owned" | "external";
            pid: number | null;
          }
        >;
      }
    ).services;
    // Host-owned 9876/9881 while Product routes externally: observed only.
    const localStt = services.get("local_stt");
    const ttsWrapper = services.get("tts_wrapper");
    if (!localStt || !ttsWrapper) throw new Error("expected local voice services");
    localStt.child = null;
    localStt.pid = 41_976;
    localStt.ownership = "external";
    ttsWrapper.child = null;
    ttsWrapper.pid = 41_981;
    ttsWrapper.ownership = "external";

    const gracefulStop = vi
      .spyOn(processWindows, "requestGracefulStop")
      .mockImplementation(() => undefined);
    const forceKill = vi
      .spyOn(processWindows, "forceKillProcessTree")
      .mockImplementation(() => undefined);
    vi.spyOn(processWindows, "isProcessAlive").mockReturnValue(true);

    await supervisor.stopService("local_stt");
    await supervisor.stopService("tts_wrapper");
    await supervisor.shutdown();
    expect(gracefulStop).not.toHaveBeenCalledWith(41_976);
    expect(gracefulStop).not.toHaveBeenCalledWith(41_981);
    expect(forceKill).not.toHaveBeenCalledWith(41_976);
    expect(forceKill).not.toHaveBeenCalledWith(41_981);
  });
});

describe("DesktopSupervisor exec-stable Runtime ownership", () => {
  it("refresh keeps a spawned Runtime owned after the runner argv marker disappears", async () => {
    const config = baseConfig({ autostartRuntime: true });
    const child = fakeChild(52_001);
    let spawned = false;
    vi.mocked(processWindows.spawnManagedProcess).mockImplementation(() => {
      spawned = true;
      return child as never;
    });
    vi.spyOn(processWindows, "inspectProcess").mockImplementation((processId) => ({
      status: "resolved",
      processId,
      info: {
        processId,
        parentProcessId: 1,
        commandLine: "node pnpm exec tsx --conditions development apps/server/src/index.ts",
        createdAtUtc: new Date()
      }
    }));
    vi.spyOn(processWindows, "isProcessAlive").mockImplementation((pid) => pid === 52_001);
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6121") && spawned) {
        return {
          ok: true,
          statusCode: 200,
          protocolOk: true,
          message: "healthy",
          latencyMs: 1
        };
      }
      return { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });

    const supervisor = createSupervisor(config);
    await supervisor.bootstrap();
    const snap = supervisor.snapshot();
    const runtime = snap.services.find((service) => service.id === "runtime");
    expect(spawned).toBe(true);
    expect(runtime?.ownership).toBe("owned");
    expect(runtime?.pid).toBe(52_001);
  });
});

describe("DesktopSupervisor classification", () => {
  it("projects the private packaged database into Runtime and Mem0 child env", () => {
    const resourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-packaged-res-"));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-packaged-data-"));
    const postgresRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-packaged-pg-"));
    tempDirs.push(resourceRoot, dataRoot, postgresRoot);
    const config = baseConfig({
      layout: {
        mode: "packaged",
        resourceRoot,
        configRoot: path.join(dataRoot, "config"),
        dataRoot,
        cacheRoot: path.join(dataRoot, "cache"),
        runtimeManifestPath: path.join(resourceRoot, "runtime-manifest.json"),
        mem0ManifestPath: path.join(resourceRoot, "mem0-manifest.json")
      },
      repositoryRoot: resourceRoot,
      env: { YUVI_POSTGRES_PASSWORD: "P3@ssword/with spaces" },
      runtimeStart: {
        file: "node",
        args: ["runtime.mjs"],
        cwd: dataRoot,
        env: { YUVI_PACKAGED: "1" },
        commandMarker: "runtime.mjs"
      },
      mem0Start: {
        file: "mem0.exe",
        args: [],
        cwd: dataRoot,
        env: { YUVI_MEM0_PACKAGED: "1" },
        commandMarker: "mem0.exe"
      },
      postgresMode: "private",
      postgresLayout: layoutFromRoot(postgresRoot),
      postgresListenPort: 55432,
      postgresSecretAuthority: "credential-manager"
    });
    const supervisor = createSupervisor(config);

    const runtimeEnv = supervisor.resolveSpawnEnv("runtime");
    expect(runtimeEnv).toMatchObject({
      MEMORY_REPOSITORY: "postgres",
      CONVERSATION_REPOSITORY: "postgres",
      DATABASE_URL: "postgresql://yuvi:P3%40ssword%2Fwith%20spaces@127.0.0.1:55432/yuvi"
    });

    const mem0Env = supervisor.resolveSpawnEnv("mem0");
    expect(mem0Env?.["MEM0_PG_CONNECTION_STRING"]).toBe(
      "postgresql://yuvi:P3%40ssword%2Fwith%20spaces@127.0.0.1:55432/yuvi"
    );
    expect(mem0Env?.["DATABASE_URL"]).toBeUndefined();
  });

  it.each([false, true])(
    "treats external Mem0 as running without acquiring ownership (degraded=%s)",
    async (degraded) => {
      const resourceRoot = makeTempRepositoryRoot();
      const config = baseConfig({
        layout: {
          mode: "packaged",
          resourceRoot,
          configRoot: path.join(resourceRoot, "data", "config"),
          dataRoot: path.join(resourceRoot, "data"),
          cacheRoot: path.join(resourceRoot, "data", "cache"),
          runtimeManifestPath: path.join(resourceRoot, "runtime", "runtime-manifest.json"),
          mem0ManifestPath: path.join(resourceRoot, "mem0", "mem0-manifest.json")
        },
        repositoryRoot: resourceRoot,
        mem0Start: null,
        autostartMem0: false
      });
      vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
        if (url.includes("6131")) {
          return {
            ok: true,
            statusCode: 200,
            protocolOk: true,
            message: "running external mem0",
            degraded,
            latencyMs: 1
          };
        }
        return { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
      });
      vi.spyOn(health, "probeTcp").mockResolvedValue({
        ok: false,
        statusCode: null,
        protocolOk: false,
        message: "closed",
        latencyMs: 1
      });
      const supervisor = createSupervisor(config);
      await supervisor.refreshAll();
      const mem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");
      expect(mem0?.status).toBe(degraded ? "degraded" : "healthy");
      expect(mem0?.managed).toBe(false);
      expect(mem0?.ownership).toBe("external");
      expect(mem0?.canStop).toBe(false);
    }
  );

  it("marks packaged Mem0 as managed only when a manifest command is present", () => {
    const resourceRoot = makeTempRepositoryRoot();
    const mem0Start: StartCommandSpec = {
      file: path.join(resourceRoot, "mem0", "yuvi-mem0.exe"),
      args: [],
      cwd: path.join(resourceRoot, "data"),
      env: { YUVI_MEM0_PACKAGED: "1" },
      commandMarker: path.join(resourceRoot, "mem0", "yuvi-mem0.exe")
    };
    const supervisor = createSupervisor(
      baseConfig({
        layout: {
          mode: "packaged",
          resourceRoot,
          configRoot: path.join(resourceRoot, "data", "config"),
          dataRoot: path.join(resourceRoot, "data"),
          cacheRoot: path.join(resourceRoot, "data", "cache"),
          runtimeManifestPath: path.join(resourceRoot, "runtime", "runtime-manifest.json"),
          mem0ManifestPath: path.join(resourceRoot, "mem0", "mem0-manifest.json")
        },
        repositoryRoot: resourceRoot,
        mem0Start,
        autostartMem0: true
      })
    );
    expect(supervisor.snapshot().services.find((service) => service.id === "mem0")?.managed).toBe(
      true
    );
  });

  it("marks healthy runtime without metadata as external", async () => {
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6121")) {
        return {
          ok: true,
          statusCode: 200,
          protocolOk: true,
          message: "healthy",
          latencyMs: 5
        };
      }
      return {
        ok: false,
        statusCode: null,
        protocolOk: false,
        message: "down",
        latencyMs: 1
      };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: true,
      statusCode: null,
      protocolOk: true,
      message: "tcp open",
      latencyMs: 1
    });

    const supervisor = createSupervisor(baseConfig());
    await supervisor.refreshAll();
    const runtime = supervisor.snapshot().services.find((s) => s.id === "runtime");
    expect(runtime?.status).toBe("healthy");
    expect(runtime?.ownership).toBe("external");
    expect(runtime?.canStop).toBe(false);
  });

  it("marks protocol mismatch as unavailable without taking ownership", async () => {
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6121")) {
        return {
          ok: false,
          statusCode: 200,
          protocolOk: false,
          message: "port responds but protocol mismatch",
          latencyMs: 3
        };
      }
      return {
        ok: false,
        statusCode: null,
        protocolOk: false,
        message: "down",
        latencyMs: 1
      };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });

    const supervisor = createSupervisor(baseConfig());
    await supervisor.refreshAll();
    const runtime = supervisor.snapshot().services.find((s) => s.id === "runtime");
    expect(runtime?.status).toBe("unavailable");
    expect(runtime?.ownership).toBe("none");
    expect(runtime?.summary).toMatch(/unexpected/i);
  });

  it("mem0 failure does not remove runtime from snapshot", async () => {
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6121")) {
        return { ok: true, statusCode: 200, protocolOk: true, message: "ok", latencyMs: 1 };
      }
      if (url.includes("6131")) {
        return {
          ok: false,
          statusCode: null,
          protocolOk: false,
          message: "mem0 down",
          latencyMs: 1
        };
      }
      return { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: true,
      statusCode: null,
      protocolOk: true,
      message: "tcp open",
      latencyMs: 1
    });

    const supervisor = createSupervisor(baseConfig());
    await supervisor.refreshAll();
    const snap = supervisor.snapshot();
    expect(snap.services.find((s) => s.id === "runtime")?.status).toBe("healthy");
    expect(snap.services.find((s) => s.id === "mem0")?.status).toBe("stopped");
  });

  it("marks protocol-mismatched HTTP as unavailable (not external/owned)", async () => {
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6121")) {
        return {
          ok: false,
          statusCode: 200,
          protocolOk: false,
          message: "port responds but protocol mismatch",
          latencyMs: 2
        };
      }
      return { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });
    const supervisor = createSupervisor(baseConfig());
    await supervisor.refreshAll();
    const runtime = supervisor.snapshot().services.find((s) => s.id === "runtime");
    expect(runtime?.status).toBe("unavailable");
    expect(runtime?.ownership).toBe("none");
    expect(runtime?.canStop).toBe(false);
  });

  it("stopService refuses external processes", async () => {
    vi.spyOn(health, "probeHttpHealth").mockResolvedValue({
      ok: true,
      statusCode: 200,
      protocolOk: true,
      message: "ok",
      latencyMs: 1
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: true,
      statusCode: null,
      protocolOk: true,
      message: "tcp open",
      latencyMs: 1
    });
    const supervisor = createSupervisor(baseConfig());
    await supervisor.refreshAll();
    await supervisor.stopService("runtime");
    const runtime = supervisor.snapshot().services.find((s) => s.id === "runtime");
    expect(runtime?.lastError).toMatch(/external/i);
    expect(runtime?.status).toBe("healthy");
  });

  it("keeps an unconfigured local STT sidecar observe-only", async () => {
    const supervisor = createSupervisor(baseConfig());
    await supervisor.stopService("local_stt");
    const localStt = supervisor.snapshot().services.find((service) => service.id === "local_stt");
    expect(localStt?.managed).toBe(false);
    expect(localStt?.lastError).toMatch(/external|owned/i);
    expect(unexpectedSpawnCalls).toBe(0);
  });
});

describe("DesktopSupervisor runtime config push", () => {
  beforeEach(() => {
    // Secret changes schedule background Runtime reload — do not spawn children in unit tests.
    vi.spyOn(DesktopSupervisor.prototype, "restartService").mockImplementation(async function (
      this: DesktopSupervisor
    ) {
      return this.snapshot();
    });
  });

  it("starts with env A, applyRuntimeConfig B, resolveSpawnEnv uses B", async () => {
    process.env["DEEPSEEK_API_KEY"] = "key-A";
    process.env["DEEPSEEK_CHAT_MODEL"] = "model-A";
    const supervisor = createSupervisor(baseConfig());

    // Fixture repositoryRoot keeps startCommand resolvable before and after derive.
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    const envA = supervisor.resolveSpawnEnv("runtime");
    expect(envA?.["DEEPSEEK_CHAT_MODEL"]).toBe("model-A");
    expect(envA?.["DEEPSEEK_API_KEY"]).toBe("key-A");

    const result = await supervisor.applyRuntimeConfig({
      env: {
        DEEPSEEK_CHAT_MODEL: "model-B",
        DEEPSEEK_API_KEY: "key-B",
        SERVER_PORT: "6121",
        SERVER_HOST: "127.0.0.1",
        MEM0_BASE_URL: "http://127.0.0.1:6131"
      },
      unsetEnv: []
    });
    expect(result.ok).toBe(true);
    expect(result.appliedEnvKeys).toContain("DEEPSEEK_CHAT_MODEL");
    expect(result.restartedServices).toContain("runtime");
    // Secret values never appear in ack.
    expect(JSON.stringify(result)).not.toContain("key-B");
    expect(JSON.stringify(result)).not.toContain("key-A");

    // deriveConfigFromEnv re-ran resolveRuntimeStart against the temp repo fixture.
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    const envB = supervisor.resolveSpawnEnv("runtime");
    expect(envB?.["DEEPSEEK_CHAT_MODEL"]).toBe("model-B");
    expect(envB?.["DEEPSEEK_API_KEY"]).toBe("key-B");
  });

  it("propagates the selected Chat and Cognition model paths to packaged Runtime", async () => {
    const supervisor = createSupervisor(baseConfig());
    const result = await supervisor.applyRuntimeConfig({
      env: {
        DEFAULT_CHAT_PROVIDER: "openai-compatible",
        CHAT_PROVIDER_CHAIN: "openai-compatible",
        DEFAULT_REASONING_PROVIDER: "openai-compatible",
        REASONING_PROVIDER_CHAIN: "openai-compatible",
        OPENAI_COMPATIBLE_API_BASEURL: "https://gateway.example/v1",
        OPENAI_COMPATIBLE_API_KEY: "shared-secret",
        OPENAI_COMPATIBLE_CHAT_MODEL: "deepseek-flash",
        OPENAI_COMPATIBLE_REASONING_MODEL: "zai-org/GLM-5.3-Flash"
      },
      unsetEnv: []
    });

    expect(result.restartedServices).toContain("runtime");
    const env = supervisor.resolveSpawnEnv("runtime");
    expect(env?.["DEFAULT_CHAT_PROVIDER"]).toBe("openai-compatible");
    expect(env?.["CHAT_PROVIDER_CHAIN"]).toBe("openai-compatible");
    expect(env?.["DEFAULT_REASONING_PROVIDER"]).toBe("openai-compatible");
    expect(env?.["REASONING_PROVIDER_CHAIN"]).toBe("openai-compatible");
    expect(env?.["OPENAI_COMPATIBLE_API_BASEURL"]).toBe("https://gateway.example/v1");
    expect(env?.["OPENAI_COMPATIBLE_CHAT_MODEL"]).toBe("deepseek-flash");
    expect(env?.["OPENAI_COMPATIBLE_REASONING_MODEL"]).toBe("zai-org/GLM-5.3-Flash");
    expect(env?.["OPENAI_COMPATIBLE_API_KEY"]).toBe("shared-secret");
    expect(JSON.stringify(result)).not.toContain("shared-secret");
    expect(result.appliedEnvKeys).not.toContain("OPENAI_COMPATIBLE_API_KEY");
  });

  it("projects local STT selection and preserves the Supervisor-owned command", async () => {
    const supervisor = createSupervisor(
      baseConfig({
        localSttStart: {
          file: "python",
          args: ["services/local-stt/server.py"],
          cwd: "/tmp/yuvi-local-stt",
          env: {},
          commandMarker: "server.py"
        },
        autostartLocalStt: false
      })
    );

    const result = await supervisor.applyRuntimeConfig({
      env: {
        DEFAULT_STT_PROVIDER: "local",
        STT_PROVIDER_CHAIN: "local",
        LOCAL_MODEL_BASEURL: "http://127.0.0.1:9876",
        LOCAL_STT_BASE_URL: "http://127.0.0.1:9876",
        LOCAL_STT_MODEL: "sense-voice",
        YUVI_AUTOSTART_LOCAL_STT: "false"
      },
      unsetEnv: []
    });

    expect(result.restartedServices).toContain("runtime");
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEFAULT_STT_PROVIDER"]).toBe("local");
    expect(supervisor.resolveSpawnEnv("runtime")?.["STT_PROVIDER_CHAIN"]).toBe("local");
    expect(supervisor.resolveSpawnEnv("runtime")?.["LOCAL_MODEL_BASEURL"]).toBe(
      "http://127.0.0.1:9876"
    );
    expect(
      supervisor.snapshot().services.find((service) => service.id === "local_stt")
    ).toMatchObject({ managed: true });

    const changed = await supervisor.applyRuntimeConfig({
      env: { LOCAL_STT_BASE_URL: "http://127.0.0.1:9987" },
      unsetEnv: []
    });
    expect(changed.restartedServices).toContain("runtime");
  });

  it("base fallback A → override B → delete restores A (not stale B)", async () => {
    process.env["DEEPSEEK_API_KEY"] = "fallback-A";
    const supervisor = createSupervisor(
      baseConfig({
        env: {
          DEEPSEEK_CHAT_MODEL: "model-A",
          DEEPSEEK_API_KEY: "fallback-A",
          DATABASE_URL: "postgres://yuvi:a@127.0.0.1:5432/yuvi",
          MEM0_BASE_URL: "http://127.0.0.1:6131",
          SERVER_PORT: "6121",
          SERVER_HOST: "127.0.0.1"
        }
      })
    );
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("fallback-A");

    await supervisor.applyRuntimeConfig({
      env: { DEEPSEEK_API_KEY: "user-secret-B", DEEPSEEK_CHAT_MODEL: "model-B" },
      unsetEnv: []
    });
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("user-secret-B");
    // Dynamic settings stay inside Supervisor state; process.env is never
    // mutated by a config update.
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("fallback-A");

    await supervisor.applyRuntimeConfig({
      env: { DEEPSEEK_CHAT_MODEL: "model-B", SERVER_PORT: "6121" },
      unsetEnv: ["DEEPSEEK_API_KEY"]
    });

    // Must not keep dynamic B; restore base fallback A.
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("fallback-A");
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("fallback-A");
    // Live process.env pollution must not replace the resolved child map.
    process.env["DEEPSEEK_API_KEY"] = "stale-from-shell";
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("fallback-A");
  });

  it("delete secret with no base fallback leaves key absent (no stale B)", async () => {
    delete process.env["DEEPSEEK_API_KEY"];
    const supervisor = createSupervisor(
      baseConfig({
        env: {
          DEEPSEEK_CHAT_MODEL: "model-A",
          SERVER_PORT: "6121",
          SERVER_HOST: "127.0.0.1",
          MEM0_BASE_URL: "http://127.0.0.1:6131"
        }
      })
    );
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    await supervisor.applyRuntimeConfig({
      env: { DEEPSEEK_API_KEY: "user-secret-B" },
      unsetEnv: []
    });
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("user-secret-B");

    await supervisor.applyRuntimeConfig({
      env: {},
      unsetEnv: ["DEEPSEEK_API_KEY"]
    });
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBeUndefined();
    expect(process.env["DEEPSEEK_API_KEY"]).toBeUndefined();
  });

  it("updates health probe URLs for mem0 / ollama / tts without spawn", async () => {
    const spawnSpy = vi.mocked(processWindows.spawnManagedProcess);
    const supervisor = createSupervisor(
      baseConfig({
        runtimeStart: null,
        mem0Start: null,
        ttsWrapperStart: null
      })
    );

    await supervisor.applyRuntimeConfig({
      env: {
        MEM0_BASE_URL: "http://127.0.0.1:6199",
        MEM0_OLLAMA_BASE_URL: "http://127.0.0.1:11999",
        GPT_SOVITS_TTS_BASE_URL: "http://127.0.0.1:9899",
        GPT_SOVITS_TTS_UPSTREAM_URL: "http://127.0.0.1:9898",
        SERVER_PORT: "6121"
      },
      unsetEnv: []
    });

    expect(supervisor.resolveHealthUrl("mem0")).toBe("http://127.0.0.1:6199/health");
    expect(supervisor.resolveHealthUrl("ollama")).toBe("http://127.0.0.1:11999/api/tags");
    expect(supervisor.resolveHealthUrl("tts_wrapper")).toBe("http://127.0.0.1:9899/health");
    expect(spawnSpy).not.toHaveBeenCalled();

    // External-only refresh must not spawn or kill.
    vi.spyOn(health, "probeHttpHealth").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "down",
      latencyMs: 1
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });
    await supervisor.refreshAll();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("rejects config update while shutting down", async () => {
    const supervisor = createSupervisor(baseConfig({ runtimeStart: null }));
    await supervisor.shutdown();
    await expect(
      supervisor.applyRuntimeConfig({ env: { DEEPSEEK_CHAT_MODEL: "x" }, unsetEnv: [] })
    ).rejects.toThrow(/shutting down/i);
  });

  it("external services stay unspawned when config changes", async () => {
    const spawnSpy = vi.mocked(processWindows.spawnManagedProcess);
    const supervisor = createSupervisor(
      baseConfig({
        runtimeStart: null,
        mem0Start: null,
        ttsWrapperStart: null,
        ttsUpstreamStart: null
      })
    );
    await supervisor.applyRuntimeConfig({
      env: {
        YUVI_AUTOSTART_RUNTIME: "false",
        YUVI_AUTOSTART_MEM0: "false",
        YUVI_AUTOSTART_TTS: "false",
        MEM0_BASE_URL: "http://127.0.0.1:6200"
      },
      unsetEnv: ["DEEPSEEK_API_KEY", "DATABASE_URL"]
    });
    expect(spawnSpy).not.toHaveBeenCalled();
    const snap = supervisor.snapshot();
    expect(snap.services.find((s) => s.id === "ollama")?.managed).toBe(false);
    expect(snap.services.find((s) => s.id === "postgres")?.managed).toBe(false);
  });

  it("status snapshot never contains secret values", async () => {
    process.env["DEEPSEEK_API_KEY"] = "sk-super-secret-value";
    const supervisor = createSupervisor(baseConfig());
    await supervisor.applyRuntimeConfig({
      env: { DEEPSEEK_API_KEY: "sk-super-secret-value", DEEPSEEK_CHAT_MODEL: "m" },
      unsetEnv: []
    });
    const text = JSON.stringify(supervisor.snapshot());
    expect(text).not.toContain("sk-super-secret-value");
    expect(text).not.toContain("DEEPSEEK_API_KEY");
  });

  it("buildChildProcessEnv deletes unset keys after merge", () => {
    const env = buildChildProcessEnv(
      { DEEPSEEK_API_KEY: "old", PATH: "/bin", SERVER_PORT: "1" },
      { SERVER_PORT: "2" },
      ["DEEPSEEK_API_KEY"]
    );
    expect(env["SERVER_PORT"]).toBe("2");
    expect(env["DEEPSEEK_API_KEY"]).toBeUndefined();
    expect(env["PATH"]).toBe("/bin");
  });
});

describe("DesktopSupervisor packaged Mem0 reconcile", () => {
  async function waitForReconcile(supervisor: DesktopSupervisor): Promise<void> {
    await (supervisor as unknown as { configReconcileOp: Promise<void> | null }).configReconcileOp;
  }

  function mockMem0Health(healthy = false) {
    let ready = healthy;
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6131") || url.includes("6132")) {
        return ready
          ? { ok: true, statusCode: 200, protocolOk: true, message: "healthy", latencyMs: 1 }
          : { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
      }
      return { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });
    return { setReady: () => (ready = true), setDown: () => (ready = false) };
  }

  function mockManagedSpawn(
    onSpawn?: () => void,
    onStop?: () => void,
    onInspectionReady?: (command: StartCommandSpec) => void
  ) {
    const children: Array<EventEmitter & { pid: number; killed: boolean; kill: () => void }> = [];
    const spawn = vi.mocked(processWindows.spawnManagedProcess);
    spawn.mockImplementation((command) => {
      onSpawn?.();
      const child = fakeChild(40_000 + children.length);
      children.push(child);
      const originalKill = child.kill;
      child.kill = () => {
        onStop?.();
        originalKill();
      };
      vi.spyOn(processWindows, "inspectProcess").mockImplementation((pid) => ({
        status: "resolved",
        processId: pid,
        info: {
          processId: pid,
          parentProcessId: 1,
          commandLine: `${command.commandMarker} ${command.cwd}`,
          createdAtUtc: new Date()
        }
      }));
      onInspectionReady?.(command);
      return child as never;
    });
    vi.spyOn(processWindows, "inspectProcess").mockImplementation((pid) => ({
      status: "resolved",
      processId: pid,
      info: {
        processId: pid,
        parentProcessId: 1,
        commandLine: `external-process ${pid}`,
        createdAtUtc: new Date()
      }
    }));
    vi.spyOn(processWindows, "isProcessAlive").mockReturnValue(false);
    vi.spyOn(processWindows, "requestGracefulStop").mockImplementation(() => undefined);
    vi.spyOn(processWindows, "forceKillProcessTree").mockImplementation(() => undefined);
    return { spawn, children };
  }

  it("rejects invalid managed remote URL without changing config or specs", async () => {
    const supervisor = createSupervisor(packagedConfig());
    const beforeEnv = { ...supervisor.getConfig().env };
    const before = supervisor.snapshot();
    await expect(
      supervisor.applyRuntimeConfig({
        env: { MEM0_BASE_URL: "https://remote.example.invalid:6131" },
        unsetEnv: []
      })
    ).rejects.toThrow(/loopback|http/i);
    expect(supervisor.getConfig().env).toEqual(beforeEnv);
    const afterMem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");
    const beforeMem0 = before.services.find((service) => service.id === "mem0");
    expect(afterMem0?.url).toBe(beforeMem0?.url);
    expect(afterMem0?.managed).toBe(beforeMem0?.managed);
    expect(afterMem0?.status).toBe(beforeMem0?.status);
    expect(afterMem0?.ownership).toBe(beforeMem0?.ownership);
  });

  it("keeps dynamic secrets out of process.env and injects them only into child env", async () => {
    const supervisor = createSupervisor(packagedConfig());
    delete process.env["MEM0_LLM_API_KEY"];
    const result = await supervisor.applyRuntimeConfig({
      env: { MEM0_LLM_API_KEY: "P3_MEM0_LLM_SECRET_NEVER_LOG" },
      unsetEnv: []
    });
    expect(process.env["MEM0_LLM_API_KEY"]).toBeUndefined();
    expect(result.appliedEnvKeys).not.toContain("MEM0_LLM_API_KEY");
    expect(JSON.stringify(result)).not.toContain("P3_MEM0_LLM_SECRET_NEVER_LOG");
    expect(supervisor.resolveSpawnEnv("mem0")?.["MEM0_LLM_API_KEY"]).toBe(
      "P3_MEM0_LLM_SECRET_NEVER_LOG"
    );
    await supervisor.shutdown();
  });

  it("suppresses a no-op secret save", async () => {
    const supervisor = createSupervisor(packagedConfig({ YUVI_AUTOSTART_MEM0: "false" }));
    await supervisor.applyRuntimeConfig({
      env: { MEM0_LLM_API_KEY: "same-secret" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    const result = await supervisor.applyRuntimeConfig({
      env: { MEM0_LLM_API_KEY: "same-secret" },
      unsetEnv: []
    });
    expect(result.restartedServices).toEqual([]);
    await supervisor.shutdown();
  });

  it("does not restart Mem0 when DATABASE_URL changes under an explicit PG override", async () => {
    const supervisor = createSupervisor(
      packagedConfig({
        MEM0_PG_CONNECTION_STRING: "explicit-pg-a",
        DATABASE_URL: "database-a"
      })
    );
    const result = await supervisor.applyRuntimeConfig({
      env: { DATABASE_URL: "database-b" },
      unsetEnv: []
    });
    expect(result.restartedServices).toEqual(["runtime"]);
    expect(supervisor.resolveSpawnEnv("mem0")?.["MEM0_PG_CONNECTION_STRING"]).toBe("explicit-pg-a");
    await supervisor.shutdown();
  });

  it("does not reconcile Mem0 for unrelated TTS settings", async () => {
    const supervisor = createSupervisor(packagedConfig({ YUVI_AUTOSTART_MEM0: "false" }));
    const result = await supervisor.applyRuntimeConfig({
      env: { GPT_SOVITS_TTS_BASE_URL: "http://127.0.0.1:9899" },
      unsetEnv: []
    });
    expect(result.restartedServices).toEqual([]);
    await supervisor.shutdown();
  });

  it("maps DATABASE_URL to Mem0 PG env and removes it after unset", async () => {
    const healthMock = mockMem0Health(false);
    mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig());
    const first = await supervisor.applyRuntimeConfig({
      env: { DATABASE_URL: "postgres://P3_MEM0_DB_SECRET_NEVER_LOG@127.0.0.1:5432/mem0" },
      unsetEnv: []
    });
    expect(first.restartedServices).toEqual(["runtime", "mem0"]);
    const childEnv = supervisor.resolveSpawnEnv("mem0");
    expect(childEnv?.["MEM0_PG_CONNECTION_STRING"]).toContain("P3_MEM0_DB_SECRET_NEVER_LOG");
    expect(childEnv?.["DATABASE_URL"]).toBeUndefined();
    const second = await supervisor.applyRuntimeConfig({ env: {}, unsetEnv: ["DATABASE_URL"] });
    expect(second.restartedServices).toEqual(["runtime", "mem0"]);
    expect(supervisor.resolveSpawnEnv("mem0")?.["DATABASE_URL"]).toBeUndefined();
    expect(supervisor.resolveSpawnEnv("mem0")?.["MEM0_PG_CONNECTION_STRING"]).toBeUndefined();
    expect(JSON.stringify(supervisor.snapshot())).not.toContain("P3_MEM0_DB_SECRET_NEVER_LOG");
    await supervisor.shutdown();
  });

  it("stops an owned Mem0 when managed mode is disabled", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig());
    await supervisor.bootstrap();
    await waitForReconcile(supervisor);
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    const result = await supervisor.applyRuntimeConfig({
      env: { YUVI_AUTOSTART_MEM0: "false" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    const mem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(result.restartedServices).toEqual(["mem0"]);
    expect(mem0?.managed).toBe(false);
    expect(mem0?.ownership).toBe("none");
    expect(mem0?.status).toBe("stopped");
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
  });

  it("tears down a reconciled packaged Mem0 through the tracked fixture lifecycle", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig());
    await supervisor.bootstrap();
    await waitForReconcile(supervisor);

    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot().services.find((service) => service.id === "mem0")?.ownership).toBe(
      "owned"
    );
  });

  it("publishes managed Mem0 metadata before concurrent refresh can classify it", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig());

    await Promise.all([supervisor.bootstrap(), supervisor.refreshAll()]);

    const config = supervisor.getConfig();
    const metadataPath = path.join(config.stateDirectory, "mem0.pid.json");
    const metadata = ownership.readProcessMetadata(metadataPath);
    const mem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");

    expect(metadata).toMatchObject({
      schemaVersion: 1,
      role: "mem0",
      pid: processMock.children[0]?.pid,
      stateDirectory: config.stateDirectory,
      instanceId: config.instanceId
    });
    expect(metadata?.commandMarker).toBe(processMock.spawn.mock.calls[0]?.[0].commandMarker);
    expect(mem0?.status).toBe("healthy");
    expect(mem0?.ownership).toBe("owned");
    expect(
      fs.readdirSync(config.stateDirectory).some((name) => name.includes(".mem0.pid.json."))
    ).toBe(false);
  });

  it("preserves a tracked Mem0 child across one identity query timeout", async () => {
    const healthMock = mockMem0Health(false);
    let inspectionCalls = 0;
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown, (command) => {
      vi.spyOn(processWindows, "inspectProcess").mockImplementation((pid) => {
        inspectionCalls += 1;
        if (inspectionCalls === 1) {
          return {
            status: "resolved",
            processId: pid,
            info: {
              processId: pid,
              parentProcessId: 1,
              commandLine: `${command.commandMarker} ${command.cwd}`,
              createdAtUtc: new Date()
            }
          };
        }
        return {
          status: "unavailable",
          processId: pid,
          reason: "query-timeout"
        };
      });
    });
    const supervisor = createSupervisor(packagedConfig());

    await supervisor.bootstrap();
    await waitForReconcile(supervisor);

    const config = supervisor.getConfig();
    const metadataPath = path.join(config.stateDirectory, "mem0.pid.json");
    const afterTimeout = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(inspectionCalls).toBeGreaterThanOrEqual(2);
    expect(afterTimeout?.status).toBe("healthy");
    expect(afterTimeout?.ownership).toBe("owned");
    expect(fs.existsSync(metadataPath)).toBe(true);

    vi.spyOn(processWindows, "inspectProcess").mockImplementation((pid) => {
      const command = processMock.spawn.mock.calls[0]?.[0];
      return {
        status: "resolved",
        processId: pid,
        info: {
          processId: pid,
          parentProcessId: 1,
          commandLine: `${command?.commandMarker ?? "yuvi-mem0.exe"} ${command?.cwd ?? ""}`,
          createdAtUtc: new Date()
        }
      };
    });
    await supervisor.refreshAll();
    const afterResolved = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(afterResolved?.status).toBe("healthy");
    expect(afterResolved?.ownership).toBe("owned");
    expect(fs.existsSync(metadataPath)).toBe(true);

    await supervisor.shutdown();
    expect(fs.existsSync(metadataPath)).toBe(false);
  });

  it("does not replace a live managed generation when identity is unavailable during a health failure", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig());

    await supervisor.ensureService("mem0");
    expect(processMock.spawn).toHaveBeenCalledTimes(1);

    healthMock.setDown();
    vi.spyOn(processWindows, "inspectProcess").mockImplementation((pid) => ({
      status: "unavailable",
      processId: pid,
      reason: "query-timeout"
    }));

    await supervisor.ensureService("mem0");

    const config = supervisor.getConfig();
    const metadataPath = path.join(config.stateDirectory, "mem0.pid.json");
    const mem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(mem0?.status).toBe("unavailable");
    expect(mem0?.ownership).toBe("owned");
    expect(fs.existsSync(metadataPath)).toBe(true);
  });

  it("does not spawn over a live child when unavailable metadata cannot match it", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig());

    await supervisor.ensureService("mem0");
    const config = supervisor.getConfig();
    const metadataPath = path.join(config.stateDirectory, "mem0.pid.json");
    const metadata = ownership.readProcessMetadata(metadataPath);
    if (!metadata) throw new Error("expected managed metadata");
    ownership.writeProcessMetadata(metadataPath, { ...metadata, pid: metadata.pid + 1 });

    healthMock.setDown();
    vi.spyOn(processWindows, "inspectProcess").mockImplementation((pid) => ({
      status: "unavailable",
      processId: pid,
      reason: "query-timeout"
    }));

    await supervisor.ensureService("mem0");

    const mem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(mem0?.status).toBe("unavailable");
    expect(mem0?.ownership).toBe("none");
    expect(fs.existsSync(metadataPath)).toBe(true);
  });

  it("ignores a stale exit callback from a previous managed generation", async () => {
    const healthMock = mockMem0Health(false);
    const children: Array<ReturnType<typeof fakeChild>> = [];
    const spawn = vi.mocked(processWindows.spawnManagedProcess);
    spawn.mockImplementation((command) => {
      const child = fakeChild(41_000);
      const originalKill = child.kill;
      child.kill = () => {
        // Deliberately defer the old generation's exit event until after the
        // replacement has been published.
        child.killed = true;
        healthMock.setDown();
        if (children.length > 1) originalKill();
      };
      children.push(child);
      healthMock.setReady();
      vi.spyOn(processWindows, "inspectProcess").mockImplementation((pid) => ({
        status: "resolved",
        processId: pid,
        info: {
          processId: pid,
          parentProcessId: 1,
          commandLine: `${command.commandMarker} ${command.cwd}`,
          createdAtUtc: new Date()
        }
      }));
      return child as never;
    });
    vi.spyOn(processWindows, "inspectProcess").mockReturnValue({
      status: "resolved",
      processId: 41_000,
      info: {
        processId: 41_000,
        parentProcessId: 1,
        commandLine: "external-process 41000",
        createdAtUtc: new Date()
      }
    });
    vi.spyOn(processWindows, "isProcessAlive").mockReturnValue(false);
    vi.spyOn(processWindows, "requestGracefulStop").mockImplementation(() => undefined);
    vi.spyOn(processWindows, "forceKillProcessTree").mockImplementation(() => undefined);

    const supervisor = createSupervisor(packagedConfig());
    await supervisor.ensureService("mem0");
    expect(spawn).toHaveBeenCalledTimes(1);

    await supervisor.restartService("mem0");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot().services.find((service) => service.id === "mem0")?.ownership).toBe(
      "owned"
    );

    children[0]?.emit("exit", 0, null);
    const afterStaleExit = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(afterStaleExit?.ownership).toBe("owned");
    expect(afterStaleExit?.pid).toBe(41_000);
  });

  it("keeps metadata pending when a restarted Supervisor cannot inspect the process", async () => {
    const config = packagedConfig();
    const command = config.mem0Start;
    if (!command) throw new Error("expected packaged Mem0 start command");
    const metadataPath = path.join(config.stateDirectory, "mem0.pid.json");
    const now = new Date().toISOString();
    ownership.writeProcessMetadata(metadataPath, {
      schemaVersion: 1,
      role: "mem0",
      pid: 5010,
      repositoryRoot: config.repositoryRoot,
      stateDirectory: config.stateDirectory,
      commandMarker: command.commandMarker,
      processStartedAtUtc: now,
      createdAtUtc: now,
      ownershipToken: config.ownershipToken,
      instanceId: config.instanceId
    });
    vi.spyOn(processWindows, "inspectProcess").mockReturnValue({
      status: "unavailable",
      processId: 5010,
      reason: "query-timeout"
    });
    vi.spyOn(health, "probeHttpHealth").mockResolvedValue({
      ok: true,
      statusCode: 200,
      protocolOk: true,
      message: "healthy",
      latencyMs: 1
    });
    const supervisor = createSupervisor(config);

    await supervisor.refreshAll();

    const mem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(mem0?.status).toBe("unavailable");
    expect(mem0?.ownership).toBe("none");
    expect(mem0?.summary).toMatch(/ownership verification unavailable/i);
    expect(fs.existsSync(metadataPath)).toBe(true);
  });

  it("cleans the exact child and preserves metadata errors", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const publishError = new Error("metadata publish failed");
    vi.spyOn(ownership, "writeProcessMetadata").mockImplementation(() => {
      throw publishError;
    });
    const supervisor = createSupervisor(packagedConfig());

    await expect(supervisor.bootstrap()).rejects.toBe(publishError);

    const config = supervisor.getConfig();
    const mem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(processMock.children[0]?.killed).toBe(true);
    expect(mem0?.status).toBe("unavailable");
    expect(mem0?.ownership).toBe("none");
    expect(mem0?.lastError).toBe(publishError.message);
    expect(fs.existsSync(path.join(config.stateDirectory, "mem0.pid.json"))).toBe(false);
    expect(fs.readdirSync(config.stateDirectory).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("starts packaged Mem0 when external mode becomes managed", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig({ YUVI_AUTOSTART_MEM0: "false" }));
    const result = await supervisor.applyRuntimeConfig({
      env: { YUVI_AUTOSTART_MEM0: "true" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    const mem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(result.restartedServices).toEqual(["mem0"]);
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(mem0?.ownership).toBe("owned");
    await supervisor.shutdown();
  });

  it("coordinates the mem0 backend transition from legacy to packaged Mem0", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(
      packagedConfig({ MEMORY_BACKEND: "legacy", YUVI_AUTOSTART_MEM0: "true" })
    );
    const result = await supervisor.applyRuntimeConfig({
      env: { MEMORY_BACKEND: "mem0" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    expect(result.restartedServices).toEqual(["runtime", "mem0"]);
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(supervisor.getConfig().memoryBackend).toBe("mem0");
    await supervisor.shutdown();
  });

  it("keeps a healthy external Mem0 pending instead of claiming or killing it", async () => {
    mockMem0Health(true);
    const processMock = mockManagedSpawn();
    const supervisor = createSupervisor(packagedConfig({ YUVI_AUTOSTART_MEM0: "false" }));
    await supervisor.bootstrap();
    const result = await supervisor.applyRuntimeConfig({
      env: { YUVI_AUTOSTART_MEM0: "true" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    const mem0 = supervisor.snapshot().services.find((service) => service.id === "mem0");
    expect(result.restartedServices).toEqual(["mem0"]);
    expect(processMock.spawn).not.toHaveBeenCalled();
    expect(mem0?.ownership).toBe("external");
    expect(mem0?.canStop).toBe(false);
    expect(mem0?.canRestart).toBe(false);
    expect(mem0?.summary).toMatch(/pending.*external/i);
    await supervisor.shutdown();
  });

  it("recovers managed Mem0 after a pending external service disappears", async () => {
    const healthMock = mockMem0Health(true);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig({ YUVI_AUTOSTART_MEM0: "false" }));
    await supervisor.bootstrap();
    await supervisor.applyRuntimeConfig({
      env: { YUVI_AUTOSTART_MEM0: "true" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    expect(processMock.spawn).not.toHaveBeenCalled();
    healthMock.setDown();
    await supervisor.refreshAll();
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot().services.find((service) => service.id === "mem0")?.ownership).toBe(
      "owned"
    );
    await supervisor.shutdown();
  });

  it("restarts an owned Mem0 once when its managed port changes", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig());
    await supervisor.bootstrap();
    await waitForReconcile(supervisor);
    const result = await supervisor.applyRuntimeConfig({
      env: { MEM0_BASE_URL: "http://127.0.0.1:6132" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    expect(result.restartedServices).toEqual(["runtime", "mem0"]);
    expect(processMock.spawn).toHaveBeenCalledTimes(2);
    const lastCall = processMock.spawn.mock.calls.at(-1);
    expect(lastCall?.[0].env["MEM0_SIDECAR_PORT"]).toBe("6132");
    await supervisor.shutdown();
  });

  it("serializes rapid config updates and does not run parallel reconcile", async () => {
    const healthMock = mockMem0Health(false);
    const processMock = mockManagedSpawn(healthMock.setReady, healthMock.setDown);
    const supervisor = createSupervisor(packagedConfig());
    const first = supervisor.applyRuntimeConfig({
      env: { MEM0_LLM_MODEL: "model-a" },
      unsetEnv: []
    });
    const second = supervisor.applyRuntimeConfig({
      env: { MEM0_LLM_MODEL: "model-b" },
      unsetEnv: []
    });
    const results = await Promise.all([first, second]);
    await waitForReconcile(supervisor);
    expect(results[0].restartedServices).toEqual(["mem0"]);
    expect(results[1].restartedServices).toEqual(["mem0"]);
    expect(supervisor.getConfig().env["MEM0_LLM_MODEL"]).toBe("model-b");
    expect(processMock.spawn).toHaveBeenCalledTimes(2);
    await supervisor.shutdown();
  });

  it("does not restart an external Runtime when a secret changes", async () => {
    vi.spyOn(health, "probeHttpHealth").mockResolvedValue({
      ok: true,
      statusCode: 200,
      protocolOk: true,
      message: "healthy",
      latencyMs: 1
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });
    const spawnSpy = vi.mocked(processWindows.spawnManagedProcess);
    const supervisor = createSupervisor(baseConfig({ autostartRuntime: false }));
    await supervisor.refreshAll();
    const result = await supervisor.applyRuntimeConfig({
      env: { DEEPSEEK_API_KEY: "P3_RUNTIME_SECRET_NEVER_LOG" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    const runtime = supervisor.snapshot().services.find((service) => service.id === "runtime");
    expect(result.restartedServices).toEqual(["runtime"]);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(runtime?.ownership).toBe("external");
    expect(runtime?.summary).toMatch(/pending|external/i);
    expect(JSON.stringify(supervisor.snapshot())).not.toContain("P3_RUNTIME_SECRET_NEVER_LOG");
    await supervisor.shutdown();
  });
});

describe("DesktopSupervisor bounded Local STT suspend", () => {
  function localSttConfig(autostartLocalStt: boolean): SupervisorConfig {
    return baseConfig({
      localSttUrl: "http://127.0.0.1:9876",
      autostartLocalStt,
      localSttStart: {
        file: "yuvi-local-stt",
        args: [],
        cwd: os.tmpdir(),
        env: {},
        commandMarker: "yuvi-local-stt"
      }
    });
  }

  function waitForReconcile(supervisor: DesktopSupervisor): Promise<void> {
    return (
      (supervisor as unknown as { configReconcileOp: Promise<void> | null }).configReconcileOp ??
      Promise.resolve()
    );
  }

  function mockLocalSttLifecycle(options: {
    initiallyHealthy?: boolean;
    readyOnSpawn?: boolean;
  } = {}) {
    let healthy = options.initiallyHealthy ?? false;
    const readyOnSpawn = options.readyOnSpawn ?? true;
    const children: Array<ReturnType<typeof fakeChild>> = [];
    const commands = new Map<number, StartCommandSpec>();

    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("9876")) {
        return healthy
          ? { ok: true, statusCode: 200, protocolOk: true, message: "healthy", latencyMs: 1 }
          : { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
      }
      return { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });

    const spawn = vi.mocked(processWindows.spawnManagedProcess);
    spawn.mockImplementation((command) => {
      const child = fakeChild(61_000 + children.length);
      commands.set(child.pid, command);
      const originalKill = child.kill;
      child.kill = () => {
        healthy = false;
        originalKill();
      };
      children.push(child);
      if (readyOnSpawn) healthy = true;
      return child as never;
    });
    vi.spyOn(processWindows, "inspectProcess").mockImplementation((pid) => {
      const command = commands.get(pid);
      return {
        status: "resolved",
        processId: pid,
        info: {
          processId: pid,
          parentProcessId: 1,
          commandLine: command
            ? `${command.commandMarker} ${command.cwd}`
            : `external-local-stt-${pid}`,
          createdAtUtc: new Date()
        }
      };
    });
    vi.spyOn(processWindows, "isProcessAlive").mockImplementation(
      (pid) => children.some((child) => child.pid === pid && !child.killed)
    );
    vi.spyOn(processWindows, "requestGracefulStop").mockImplementation(() => undefined);
    vi.spyOn(processWindows, "forceKillProcessTree").mockImplementation(() => undefined);

    return {
      spawn,
      children,
      setHealthy(value: boolean) {
        healthy = value;
      }
    };
  }

  it("stops an owned STT, resists route autostart reapply, and explicit start clears suspend", async () => {
    const processMock = mockLocalSttLifecycle();
    const supervisor = createSupervisor(localSttConfig(true));

    await supervisor.ensureService("local_stt");
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot().services.find((service) => service.id === "local_stt")).toMatchObject({
      status: "healthy",
      ownership: "owned"
    });

    const suspended = await supervisor.suspendLocalStt();
    expect(suspended.outcome).toBe("STOPPED");
    expect(suspended.reason).toBe("STOPPED");
    expect(suspended.snapshot.localSttControl).toEqual({
      manuallySuspended: true,
      activeVoiceLeases: 0
    });
    expect(suspended.snapshot.services.find((service) => service.id === "local_stt")).toMatchObject({
      status: "stopped",
      ownership: "none"
    });

    await supervisor.applyRuntimeConfig({
      env: { YUVI_AUTOSTART_LOCAL_STT: "false" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    const reenabled = await supervisor.applyRuntimeConfig({
      env: { YUVI_AUTOSTART_LOCAL_STT: "true" },
      unsetEnv: []
    });
    await waitForReconcile(supervisor);
    expect(reenabled.restartedServices).toContain("local_stt");
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot().localSttControl?.manuallySuspended).toBe(true);
    expect(supervisor.snapshot().services.find((service) => service.id === "local_stt")?.status).toBe(
      "stopped"
    );

    await supervisor.ensureService("local_stt");
    expect(processMock.spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot().localSttControl?.manuallySuspended).toBe(false);
    expect(supervisor.snapshot().services.find((service) => service.id === "local_stt")).toMatchObject({
      status: "healthy",
      ownership: "owned"
    });
  });

  it("returns BUSY for an active voice lease and stops after the last lease releases", async () => {
    const processMock = mockLocalSttLifecycle();
    const supervisor = createSupervisor(localSttConfig(false));

    const lease = await supervisor.acquireVoiceLease();
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot().localSttControl?.activeVoiceLeases).toBe(1);

    const suspended = await supervisor.suspendLocalStt();
    expect(suspended).toMatchObject({
      outcome: "BUSY",
      reason: "LEASE_ACTIVE",
      activeVoiceLeases: 1
    });
    expect(processMock.children[0]?.killed).toBe(false);
    expect(supervisor.snapshot().localSttControl?.manuallySuspended).toBe(true);

    await supervisor.releaseVoiceLease(lease.leaseId);
    expect(processMock.children[0]?.killed).toBe(true);
    expect(supervisor.snapshot().localSttControl).toEqual({
      manuallySuspended: true,
      activeVoiceLeases: 0
    });
    expect(supervisor.snapshot().services.find((service) => service.id === "local_stt")).toMatchObject({
      status: "stopped",
      ownership: "none"
    });
  });

  it("returns RECONCILE_REQUIRED instead of killing a healthy external STT", async () => {
    mockLocalSttLifecycle({ initiallyHealthy: true });
    const supervisor = createSupervisor(
      baseConfig({
        localSttUrl: "http://127.0.0.1:9876",
        localSttStart: null,
        autostartLocalStt: false
      })
    );

    const gracefulStop = vi.mocked(processWindows.requestGracefulStop);
    const suspended = await supervisor.suspendLocalStt();
    expect(suspended).toMatchObject({
      outcome: "RECONCILE_REQUIRED",
      reason: "EXTERNAL_PROCESS",
      activeVoiceLeases: 0
    });
    expect(suspended.snapshot.services.find((service) => service.id === "local_stt")).toMatchObject({
      status: "healthy",
      ownership: "external"
    });
    expect(gracefulStop).not.toHaveBeenCalled();
  });

  it("interrupts an in-flight managed readiness wait so suspend stays bounded", async () => {
    const processMock = mockLocalSttLifecycle({ readyOnSpawn: false });
    const supervisor = createSupervisor(localSttConfig(true));

    const starting = supervisor.ensureService("local_stt");
    await vi.waitFor(() => expect(processMock.spawn).toHaveBeenCalledTimes(1), { timeout: 1_000 });

    const startedAt = Date.now();
    const suspended = await supervisor.suspendLocalStt();
    const elapsedMs = Date.now() - startedAt;
    await starting;

    expect(elapsedMs).toBeLessThan(3_000);
    expect(suspended.outcome).toBe("STOPPED");
    expect(processMock.children[0]?.killed).toBe(true);
    expect(supervisor.snapshot().services.find((service) => service.id === "local_stt")?.status).toBe(
      "stopped"
    );
  });
});
