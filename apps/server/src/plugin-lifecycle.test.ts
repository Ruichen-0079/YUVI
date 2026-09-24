import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_PLUGIN_API_VERSION,
  SERVER_PLUGIN_MANIFEST_VERSION,
  SERVER_PLUGIN_SOURCE_LIMIT,
  ServerPluginLifecycle,
  validateServerPluginManifest,
  type ServerPluginInstance,
  type ServerPluginSource
} from "./plugin-lifecycle.js";
import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import {
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
  createServerMcpReadTextRegistration,
  createServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";
import { assembleCanonicalContext } from "@companion/prompt-builder";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(async () => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: SERVER_PLUGIN_MANIFEST_VERSION,
    id: "org.yuvi.example",
    version: "1.2.3",
    compatibility: { apiVersion: SERVER_PLUGIN_API_VERSION },
    ...overrides
  };
}

function source(
  id: string,
  hooks: Partial<Record<keyof ServerPluginInstance, () => void | Promise<void>>> = {},
  manifestOverrides: Record<string, unknown> = {}
): ServerPluginSource {
  return {
    manifest: manifest({ id, ...manifestOverrides }),
    load: vi.fn(async () => ({
      start: hooks.start ?? vi.fn(),
      stop: hooks.stop ?? vi.fn(),
      dispose: hooks.dispose ?? vi.fn()
    }))
  };
}

function createLifecycle(sources: readonly unknown[], timeoutMs = 100): ServerPluginLifecycle {
  return new ServerPluginLifecycle(() => sources, { warn: vi.fn() } as never, timeoutMs);
}

describe("minimal server plugin manifest", () => {
  it("accepts the minimal manifest and leaves optional declarations absent", () => {
    const parsed = validateServerPluginManifest(manifest());
    expect(parsed).toEqual({
      manifestVersion: SERVER_PLUGIN_MANIFEST_VERSION,
      id: "org.yuvi.example",
      version: "1.2.3",
      compatibility: { apiVersion: SERVER_PLUGIN_API_VERSION }
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.compatibility)).toBe(true);
  });

  it("retains optional capability and surface declarations as metadata", () => {
    const parsed = validateServerPluginManifest(
      manifest({
        capabilities: ["capability://example/read"],
        surfaces: { presentation: ["avatar-overlay"], input: ["remote-chat"] }
      })
    );
    expect(parsed.capabilities).toEqual(["capability://example/read"]);
    expect(parsed.surfaces).toEqual({
      presentation: ["avatar-overlay"],
      input: ["remote-chat"]
    });
    expect(Object.isFrozen(parsed.capabilities)).toBe(true);
    expect(Object.isFrozen(parsed.surfaces?.presentation)).toBe(true);
  });

  it.each([
    ["missing id", { id: undefined }],
    ["missing version", { version: undefined }],
    ["unsupported manifest version", { manifestVersion: 2 }],
    ["invalid compatibility", { compatibility: { apiVersion: "1" } }],
    ["unknown manifest field", { storeUrl: "https://example.invalid" }],
    ["duplicate declarations", { capabilities: ["capability://x", "capability://x"] }],
    ["invalid declaration", { surfaces: { input: ["not valid"] } }]
  ])("rejects %s deterministically", (_name, override) => {
    const invalid = manifest(override);
    const message = (): string => {
      try {
        validateServerPluginManifest(invalid);
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
    };
    expect(message()).not.toBe("");
    expect(message()).toBe(message());
  });

  it("produces the same frozen metadata regardless of object property insertion order", () => {
    const first = validateServerPluginManifest({
      manifestVersion: 1,
      id: "org.yuvi.example",
      version: "1.2.3",
      compatibility: { apiVersion: 1 },
      capabilities: ["capability://a", "capability://b"]
    });
    const second = validateServerPluginManifest({
      capabilities: ["capability://a", "capability://b"],
      compatibility: { apiVersion: 1 },
      version: "1.2.3",
      id: "org.yuvi.example",
      manifestVersion: 1
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("rejects accessor-backed data without evaluating accessors", () => {
    let accessed = false;
    const input = manifest();
    Object.defineProperty(input, "id", {
      enumerable: true,
      get() {
        accessed = true;
        return "org.yuvi.example";
      }
    });
    expect(() => validateServerPluginManifest(input)).toThrow("contains an accessor-backed field");
    expect(accessed).toBe(false);
  });
});

describe("server plugin discovery and lifecycle", () => {
  it("discovers in deterministic identity order without executing loaders", async () => {
    const beta = source("org.yuvi.beta");
    const alpha = source("org.yuvi.alpha");
    const lifecycle = createLifecycle([beta, alpha]);
    const discovered = await lifecycle.discover();
    expect(discovered.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "org.yuvi.alpha",
      "org.yuvi.beta"
    ]);
    expect(beta.load).not.toHaveBeenCalled();
    expect(alpha.load).not.toHaveBeenCalled();
  });

  it("bounds candidate count and overflow diagnostics", async () => {
    const candidates = Array.from({ length: SERVER_PLUGIN_SOURCE_LIMIT + 1 }, (_, index) =>
      source(`org.yuvi.plugin-${String(index).padStart(2, "0")}`)
    );
    const lifecycle = createLifecycle(candidates);
    const result = await lifecycle.discover();
    expect(result.plugins).toHaveLength(SERVER_PLUGIN_SOURCE_LIMIT);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        phase: "DISCOVERY",
        code: "PLUGIN_SOURCE_LIMIT_EXCEEDED",
        sourceIndex: SERVER_PLUGIN_SOURCE_LIMIT
      })
    ]);
    expect(candidates[SERVER_PLUGIN_SOURCE_LIMIT]?.load).not.toHaveBeenCalled();
  });

  it("isolates malformed and incompatible candidates from a valid plugin", async () => {
    const compatible = source("org.yuvi.good");
    const incompatible = source("org.yuvi.old", {}, { compatibility: { apiVersion: 99 } });
    const lifecycle = createLifecycle([
      compatible,
      { manifest: { id: "bad" }, load: vi.fn() },
      incompatible
    ]);
    const discovered = await lifecycle.discover();
    expect(discovered.plugins.map((plugin) => plugin.state)).toEqual([
      "DISCOVERED",
      "INCOMPATIBLE",
      "REJECTED"
    ]);
    await lifecycle.load();
    expect(compatible.load).toHaveBeenCalledTimes(1);
    expect(incompatible.load).not.toHaveBeenCalled();
    expect(lifecycle.snapshot().diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "INCOMPATIBLE_PLUGIN_API"
    );
  });

  it("rejects every duplicate plugin id deterministically", async () => {
    const first = source("org.yuvi.duplicate");
    const second = source("org.yuvi.duplicate");
    const lifecycle = createLifecycle([second, first]);
    const discovered = await lifecycle.discover();
    expect(discovered.plugins.map((plugin) => plugin.state)).toEqual(["REJECTED", "REJECTED"]);
    await lifecycle.load();
    expect(first.load).not.toHaveBeenCalled();
    expect(second.load).not.toHaveBeenCalled();
    expect(
      lifecycle.snapshot().diagnostics.filter((item) => item.code === "DUPLICATE_PLUGIN_ID")
    ).toHaveLength(2);
  });

  it("contains source discovery failure and identifies its phase", async () => {
    const lifecycle = new ServerPluginLifecycle(
      async () => {
        throw new Error("sensitive discovery payload");
      },
      { warn: vi.fn() } as never,
      50
    );
    const result = await lifecycle.discover();
    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        phase: "DISCOVERY",
        code: "SOURCE_DISCOVERY_FAILED",
        message: "Plugin source discovery failed; the server will continue without plugins."
      })
    ]);
    expect(JSON.stringify(result)).not.toContain("sensitive discovery payload");
  });

  it("contains hostile manifest inspection failures without logging their payload", async () => {
    const secret = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("private manifest inspection payload");
        }
      }
    );
    const result = await createLifecycle([{ manifest: secret, load: vi.fn() }]).discover();
    expect(result.plugins[0]?.state).toBe("REJECTED");
    expect(result.diagnostics[0]).toMatchObject({
      phase: "DISCOVERY",
      code: "INVALID_MANIFEST",
      message: "Plugin manifest failed validation; check manifest v1 fields and declaration shapes."
    });
    expect(JSON.stringify(result)).not.toContain("private manifest inspection payload");
  });

  it("contains one load failure while unrelated plugins continue through start", async () => {
    const events: string[] = [];
    const failing = source("org.yuvi.a-fail", {}, {});
    (failing.load as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("private"));
    const good = source("org.yuvi.b-good", {
      start: () => {
        events.push("good:start");
      }
    });
    const lifecycle = createLifecycle([failing, good]);
    await lifecycle.discover();
    const loaded = await lifecycle.load();
    expect(loaded.plugins.map((plugin) => plugin.state)).toEqual(["FAILED", "LOADED"]);
    const started = await lifecycle.start();
    expect(started.plugins.map((plugin) => plugin.state)).toEqual(["FAILED", "STARTED"]);
    expect(events).toEqual(["good:start"]);
    expect(JSON.stringify(started.diagnostics)).not.toContain("private");
  });

  it("requires discovery and load before start", async () => {
    const lifecycle = createLifecycle([]);
    await expect(lifecycle.start()).rejects.toThrow("expected LOADED");
    await lifecycle.discover();
    await expect(lifecycle.start()).rejects.toThrow("expected LOADED");
  });

  it("stops in reverse start order and disposes in reverse load order", async () => {
    const events: string[] = [];
    const first = source("org.yuvi.first", {
      start: () => {
        events.push("first:start");
      },
      stop: () => {
        events.push("first:stop");
      },
      dispose: () => {
        events.push("first:dispose");
      }
    });
    const second = source("org.yuvi.second", {
      start: () => {
        events.push("second:start");
      },
      stop: () => {
        events.push("second:stop");
      },
      dispose: () => {
        events.push("second:dispose");
      }
    });
    const lifecycle = createLifecycle([second, first]);
    await lifecycle.discover();
    await lifecycle.load();
    await lifecycle.start();
    await lifecycle.stop();
    await lifecycle.dispose();
    expect(events).toEqual([
      "first:start",
      "second:start",
      "second:stop",
      "first:stop",
      "second:dispose",
      "first:dispose"
    ]);
    expect(lifecycle.snapshot().phase).toBe("DISPOSED");
    expect(lifecycle.snapshot().plugins.map((plugin) => plugin.state)).toEqual([
      "DISPOSED",
      "DISPOSED"
    ]);
    await expect(lifecycle.start()).rejects.toThrow("cannot start from DISPOSED");
  });

  it("disposes a loaded plugin without starting it", async () => {
    const events: string[] = [];
    const candidate = source("org.yuvi.loaded", {
      start: () => {
        events.push("start");
      },
      stop: () => {
        events.push("stop");
      },
      dispose: () => {
        events.push("dispose");
      }
    });
    const lifecycle = createLifecycle([candidate]);
    await lifecycle.discover();
    await lifecycle.load();
    await lifecycle.dispose();
    expect(events).toEqual(["dispose"]);
    expect(lifecycle.snapshot().plugins[0]?.state).toBe("DISPOSED");
  });

  it("cleans up after failed start and still reaches terminal disposal", async () => {
    const events: string[] = [];
    const candidate = source("org.yuvi.start-failure", {
      start: () => {
        events.push("start");
        throw new Error("private start detail");
      },
      stop: () => {
        events.push("stop");
      },
      dispose: () => {
        events.push("dispose");
      }
    });
    const lifecycle = createLifecycle([candidate]);
    await lifecycle.discover();
    await lifecycle.load();
    expect((await lifecycle.start()).plugins[0]?.state).toBe("FAILED");
    await lifecycle.shutdown();
    expect(events).toEqual(["start", "stop", "dispose"]);
    expect(lifecycle.snapshot().phase).toBe("DISPOSED");
    expect(JSON.stringify(lifecycle.snapshot())).not.toContain("private start detail");
  });

  it("bounds stop and dispose failures and reports each phase", async () => {
    const dispose = vi.fn(() => {
      throw new Error("secret dispose detail");
    });
    const candidate = source("org.yuvi.shutdown-failure", {
      stop: () => new Promise<void>(() => undefined),
      dispose
    });
    const lifecycle = createLifecycle([candidate], 10);
    await lifecycle.discover();
    await lifecycle.load();
    await lifecycle.start();
    await lifecycle.shutdown();
    const snapshot = lifecycle.snapshot();
    expect(snapshot.phase).toBe("DISPOSED");
    expect(snapshot.plugins[0]?.state).toBe("DISPOSED");
    expect(snapshot.diagnostics.map((item) => item.code)).toEqual([
      "PLUGIN_STOP_TIMEOUT",
      "PLUGIN_DISPOSE_FAILED"
    ]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).not.toContain("secret dispose detail");
  });

  it("continues shutdown cleanup for other plugins after stop and dispose failures", async () => {
    const events: string[] = [];
    const first = source("org.yuvi.a-good", {
      stop: () => {
        events.push("good:stop");
      },
      dispose: () => {
        events.push("good:dispose");
      }
    });
    const second = source("org.yuvi.b-failing", {
      stop: () => new Promise<void>(() => undefined),
      dispose: () => {
        throw new Error("private cleanup detail");
      }
    });
    const lifecycle = createLifecycle([first, second], 10);
    await lifecycle.discover();
    await lifecycle.load();
    await lifecycle.start();
    await lifecycle.shutdown();
    expect(events).toEqual(["good:stop", "good:dispose"]);
    expect(lifecycle.snapshot().phase).toBe("DISPOSED");
    expect(lifecycle.snapshot().plugins.map((plugin) => plugin.state)).toEqual([
      "DISPOSED",
      "DISPOSED"
    ]);
    expect(lifecycle.snapshot().diagnostics.map((entry) => entry.code)).toEqual([
      "PLUGIN_STOP_TIMEOUT",
      "PLUGIN_DISPOSE_FAILED"
    ]);
    expect(JSON.stringify(lifecycle.snapshot())).not.toContain("private cleanup detail");
  });

  it("keeps declared capabilities and surfaces out of Runtime, Cognition, and A5", async () => {
    const declarations = manifest({
      capabilities: ["capability://plugin/not-executable"],
      surfaces: { presentation: ["plugin-surface"], input: ["plugin-input"] }
    });
    const observedKeys: string[][] = [];
    const candidate: ServerPluginSource = {
      manifest: declarations,
      async load(context) {
        observedKeys.push(Object.keys(context).sort());
        return { start() {}, stop() {}, dispose() {} };
      }
    };
    const createInventory = () =>
      createServerMcpCapabilityBindings({
        version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
        capabilities: [
          createServerMcpReadTextRegistration(
            "capability://server/read-text",
            "Read text through the existing server capability"
          )
        ]
      });
    const beforeInventory = createInventory();
    const beforePrefix = assembleCanonicalContext({}).stability.stablePrefix.identity;
    const lifecycle = createLifecycle([candidate]);
    await lifecycle.discover();
    await lifecycle.load();
    await lifecycle.start();
    const afterInventory = createInventory();
    const afterPrefix = assembleCanonicalContext({}).stability.stablePrefix.identity;
    const loadedManifest = lifecycle.snapshot().plugins[0]?.manifest;
    expect(loadedManifest?.capabilities).toEqual(["capability://plugin/not-executable"]);
    expect(loadedManifest?.surfaces).toEqual({
      presentation: ["plugin-surface"],
      input: ["plugin-input"]
    });
    expect(observedKeys).toEqual([["manifest", "signal"]]);
    expect(afterInventory).toEqual(beforeInventory);
    expect(afterInventory.descriptions.capabilities.map((item) => item.capabilityRef)).toEqual([
      "capability://server/read-text"
    ]);
    expect(JSON.stringify(afterInventory)).not.toContain("capability://plugin/not-executable");
    expect(afterPrefix).toBe(beforePrefix);
    expect("registerCapability" in lifecycle.snapshot()).toBe(false);
    await lifecycle.shutdown();
  });

  it("starts only through Fastify readiness and shuts down inside application close", async () => {
    const runtimeEnvDir = await mkdtemp(path.join(tmpdir(), "yuvi-plugin-lifecycle-"));
    tempDirs.push(runtimeEnvDir);
    const env = {
      ...originalEnv,
      NODE_ENV: "test",
      RUNTIME_MODE: "test",
      LOG_LEVEL: "silent",
      YUVI_RUNTIME_ENV_DIR: runtimeEnvDir,
      PROVIDER_ALLOW_MOCKS: "true",
      MEMORY_REPOSITORY: "in-memory",
      MEMORY_EXTRACTOR: "rule-based",
      EVENT_BUS: "in-memory",
      MEMORY_MAINTENANCE_ENABLED: "false",
      MEMORY_INGESTION_COORDINATOR_ENABLED: "false"
    };
    process.env = { ...env };
    const events: string[] = [];
    const candidate = source("org.yuvi.server-owned", {
      start: () => {
        events.push("start");
      },
      stop: () => {
        events.push("stop");
      },
      dispose: () => {
        events.push("dispose");
      }
    });
    const app = await buildServer(loadServerConfig(env), {
      discoverPlugins: () => [candidate]
    });
    expect(events).toEqual([]);
    await app.ready();
    expect(events).toEqual(["start"]);
    await app.close();
    expect(events).toEqual(["start", "stop", "dispose"]);
  });
});
