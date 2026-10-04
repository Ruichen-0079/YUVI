/** Bounded pre-QQ Linux packaged-service acceptance. No GUI certification or live vendors. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import pg from "pg";
import { bundleRuntimeServer } from "../desktop-package/build-runtime.mjs";
import { bundleSupervisorCjs } from "../desktop-package/build-supervisor.mjs";
import { stageLinuxPostgresDistribution } from "../desktop-package/stage-linux-postgres.mjs";
import { buildLinuxPackagedMem0 } from "../desktop-package/build-linux-mem0.mjs";
import { HostOutwardEffects } from "../../apps/server/dist/outward-effects.js";
import {
  HostEffectIntentAdmission,
  PostgresEffectIntentStore,
  PostgresEffectDispatchStore,
  EffectDispatcher
} from "../../packages/effects/dist/index.js";
import { PostgresJournalRepository } from "../../packages/journal/dist/index.js";
import { readFile } from "node:fs/promises";

if (process.platform !== "linux" || process.arch !== "x64")
  throw Error("Linux x64 acceptance required");
if (!process.env.YUVI_LINUX_POSTGRES_HOME)
  throw Error("Mandatory packaged PostgreSQL distribution missing");
if (process.version !== "v24.20.0") throw Error("Use packaged Linux Node 24.20.0");
const root = fs.mkdtempSync(
  path.join(process.env.YUVI_CONFORMANCE_ARCHIVE_ROOT || os.tmpdir(), "yuvi-a11-package-")
);
fs.mkdirSync(path.join(os.homedir(), ".local", "share"), { recursive: true });
const resources = path.join(root, "resources"),
  data = fs.mkdtempSync(path.join(os.homedir(), ".local", "share", "yuvi-a11-data-")),
  config = path.join(root, "config");
for (const p of [resources, data, config]) fs.mkdirSync(p, { recursive: true });
const runtimeDir = path.join(resources, "runtime"),
  supervisorDir = path.join(resources, "supervisor");
await bundleRuntimeServer(runtimeDir);
await bundleSupervisorCjs(supervisorDir);
fs.copyFileSync(process.execPath, path.join(runtimeDir, "node"));
fs.chmodSync(path.join(runtimeDir, "node"), 0o755);
const manifestPath = path.join(runtimeDir, "runtime-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
Object.assign(manifest, {
  platform: "linux",
  arch: "x64",
  nodeExecutable: "node",
  nodeVersion: "24.20.0"
});
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
fs.cpSync(
  new URL("../../packages/memory/migrations", import.meta.url),
  path.join(runtimeDir, "migrations"),
  { recursive: true }
);
stageLinuxPostgresDistribution({ destination: path.join(resources, "postgres") });
buildLinuxPackagedMem0({ artifactDir: path.join(resources, "mem0") });
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function treeDigest(dir) {
  const hash = createHash("sha256");
  const walk = (current) => {
    for (const e of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, e.name);
      if (e.isDirectory()) walk(file);
      else {
        hash.update(path.relative(dir, file));
        hash.update(sha(file));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}
const archive = {
  version: "a11-packaged-baseline.v1",
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
  stateRoot: data,
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  kernel: os.release(),
  artifactDigest: treeDigest(resources),
  runtimeDigest: sha(path.join(runtimeDir, "yuvi-runtime-server.mjs")),
  pass: 0,
  fail: 1,
  skip: 0,
  tests: [],
  limitations: [
    "Headless packaged service baseline; GUI/SecretStore UI, live vendors and QQ are outside this gate.",
    "Inactive STT is excluded using the existing external-sidecar option; PostgreSQL remains explicitly private. Mem0 is freshly packaged but tested separately.",
    "Credential delivered through the existing authenticated Supervisor config seam; no user SecretStore accessed."
  ]
};
fs.writeFileSync(path.join(root, "build.json"), JSON.stringify(archive, null, 2));
let calls = 0,
  loseResponse = false,
  endpoint,
  child,
  pool;
const provider = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  calls++;
  if (loseResponse) {
    res.destroy();
    return;
  }
  const body = JSON.parse(raw);
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "retained packaged reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
    );
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: '{"disposition":"RESPOND"}' }
          }
        ]
      })
    );
  }
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const portServer = net.createServer();
portServer.listen(0, "127.0.0.1");
await once(portServer, "listening");
const runtimePort = portServer.address().port;
await new Promise((r) => portServer.close(r));
const pgPassword = randomBytes(32).toString("hex"),
  pgRoot = path.join(data, "Postgres");
const env = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  NODE_ENV: "production",
  LOG_LEVEL: "silent",
  YUVI_RUNTIME_ENV_DIR: config,
  YUVI_CONFIG_ROOT: config,
  YUVI_DATA_ROOT: data,
  YUVI_CACHE_ROOT: path.join(root, "cache"),
  YUVI_SUPERVISOR_STATE_ROOT: path.join(root, "supervisor-state"),
  YUVI_POSTGRES_DATA_ROOT: pgRoot,
  YUVI_POSTGRES_MODE: "private",
  YUVI_PACKAGED_EXTERNAL_SIDECARS: "1",
  YUVI_AUTOSTART_RUNTIME: "1",
  YUVI_AUTOSTART_MEM0: "0",
  YUVI_AUTOSTART_LOCAL_STT: "0",
  MEMORY_BACKEND: "legacy",
  MEMORY_REPOSITORY: "postgres",
  MEMORY_MAINTENANCE_ENABLED: "false",
  MEMORY_INGESTION_COORDINATOR_ENABLED: "false",
  EVENT_BUS: "in-memory",
  SERVER_PORT: String(runtimePort),
  SERVER_HOST: "127.0.0.1",
  DEFAULT_CHAT_PROVIDER: "openai-compatible",
  CHAT_PROVIDER_CHAIN: "openai-compatible",
  OPENAI_COMPATIBLE_API_BASEURL: `http://127.0.0.1:${provider.address().port}/v1`,
  OPENAI_COMPATIBLE_API_KEY: "controlled-fixture",
  OPENAI_COMPATIBLE_CHAT_MODEL: "fixture",
  DEFAULT_EMBEDDING_PROVIDER: "mock",
  EMBEDDING_PROVIDER_CHAIN: "mock",
  PROVIDER_ALLOW_MOCKS: "true",
  MEMORY_VECTOR_INDEX_ENABLED: "false"
};
// The controlled embedding adapter is explicitly declared. Production stores, migrations,
// Supervisor ownership and real HTTP Chat leaf accounting are unchanged.
async function control(url, body) {
  const response = await fetch(endpoint.baseUrl + url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${endpoint.controlToken}`,
      "content-type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000)
  });
  assert.equal(response.status, 200, `Control ${url}`);
  return response.json();
}
async function waitFor(read, description, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    if (child && child.exitCode !== null)
      throw Error(`Packaged process exited: ${description}; see ${root}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(`Readiness watchdog: ${description}; see ${root}`);
}
async function start() {
  child = spawn(
    path.join(runtimeDir, "node"),
    [
      path.join(supervisorDir, "yuvi-desktop-supervisor.cjs"),
      "--mode",
      "packaged",
      "--resource-root",
      resources,
      "--state-root",
      data,
      "--runtime-manifest",
      manifestPath
    ],
    {
      cwd: root,
      env,
      stdio: [
        "ignore",
        fs.openSync(path.join(root, `supervisor-${archive.tests.length}.log`), "a"),
        "pipe"
      ]
    }
  );
  child.stderr.on("data", (b) => fs.appendFileSync(path.join(root, "stderr.log"), b));
  endpoint = await waitFor(async () => {
    try {
      const active = JSON.parse(
        await readFile(path.join(env.YUVI_SUPERVISOR_STATE_ROOT, "active-instance.json"), "utf8")
      );
      if (active.pid !== child.pid) return null;
      return JSON.parse(await readFile(active.endpointFile, "utf8"));
    } catch {
      return null;
    }
  }, "authenticated control plane");
  await control("/v1/config", { env: { YUVI_POSTGRES_PASSWORD: pgPassword } });
  const boot = await control("/v1/bootstrap", {});
  assert.equal(
    boot.services.find((s) => s.id === "postgres")?.ownership,
    "owned",
    "private PG ownership"
  );
  assert.equal(
    boot.services.find((s) => s.id === "runtime")?.ownership,
    "owned",
    "packaged Runtime ownership"
  );
  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${runtimePort}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      return r.ok ? r.json() : null;
    } catch {
      return null;
    }
  }, "packaged Runtime");
}
async function stop() {
  const exited = once(child, "exit");
  await control("/v1/shutdown", {});
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error("Shutdown watchdog")), 15000);
      timer.unref();
    })
  ]);
  assert(!fs.existsSync(path.join(pgRoot, "data", "postmaster.pid")), "owned PG stopped");
  child = null;
}
async function check(name, run) {
  await run();
  archive.tests.push({ name, status: "PASS" });
  console.log(`PASS ${name}`);
}
try {
  await check("startup through authenticated packaged Supervisor", start);
  const listen = JSON.parse(fs.readFileSync(path.join(pgRoot, "runtime", "listen.json"), "utf8"));
  const databaseUrl = `postgres://yuvi:${pgPassword}@127.0.0.1:${listen.port}/yuvi`;
  pool = new pg.Pool({ connectionString: databaseUrl });
  await check("all packaged A9/A10 stores migrated", async () => {
    for (const table of [
      "journal_events",
      "effect_intents",
      "effect_attempts",
      "effect_observations",
      "context_use_manifests",
      "context_use_exposures",
      "native_control_workflows",
      "conversation_reply_components",
      "speech_segment_descriptors"
    ])
      assert.equal(
        (await pool.query("select to_regclass($1) table_name", [table])).rows[0].table_name,
        table
      );
  });
  await check(
    "real Chat + streaming publication persist manifest and start before target",
    async () => {
      const r = await fetch(`http://127.0.0.1:${runtimePort}/v1/messages/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "packaged-retained",
          text: "hello",
          options: { readMemory: false, writeMemory: false }
        })
      });
      assert.equal(r.status, 200);
      assert.match(await r.text(), /retained packaged reply/);
      assert(
        Number((await pool.query("select count(*) n from context_use_manifests")).rows[0].n) > 0
      );
      assert(
        Number(
          (
            await pool.query(
              "select count(*) n from effect_attempts where dispatch_started_at is not null"
            )
          ).rows[0].n
        ) > 0
      );
    }
  );
  await check("provider lost response remains UNKNOWN", async () => {
    loseResponse = true;
    const r = await fetch(`http://127.0.0.1:${runtimePort}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "packaged-unknown",
        text: "ambiguous",
        options: { readMemory: false, writeMemory: false }
      })
    });
    assert(r.status >= 400);
    assert(
      Number(
        (
          await pool.query(
            "select count(*) n from effect_observations where evidence->>'certainty'='UNKNOWN'"
          )
        ).rows[0].n
      ) > 0
    );
  });
  const counts = await pool.query(
    "select (select count(*) from effect_intents) intents,(select count(*) from effect_attempts) attempts,(select count(*) from context_use_manifests) manifests"
  );
  const before = calls;
  await pool.end();
  pool = null;
  await check("graceful shutdown drains Runtime before private PG stop", stop);
  await check("restart reopens the same private cluster and reapplies migrations", start);
  pool = new pg.Pool({ connectionString: databaseUrl });
  await check("historical A9/A10 accounting survives restart without new attempts", async () => {
    assert.deepEqual(
      (
        await pool.query(
          "select (select count(*) from effect_intents) intents,(select count(*) from effect_attempts) attempts,(select count(*) from context_use_manifests) manifests"
        )
      ).rows,
      counts.rows
    );
    assert.equal(calls, before);
    const store = new PostgresEffectDispatchStore(pool),
      journal = new PostgresJournalRepository(pool, {
        namespace: "packaged-no-replay",
        authorityBuilder() {
          throw Error("No new receipt");
        }
      });
    const owner = new HostOutwardEffects(
      new HostEffectIntentAdmission(new PostgresEffectIntentStore(pool), journal),
      store,
      new EffectDispatcher(store, [], 30000, 4, true),
      journal,
      "packaged-no-replay"
    );
    // A fresh host holds no old transport/device capabilities and cannot publish old output.
    await assert.rejects(
      owner.publish({
        target: { surface: "SSE", targetId: "old", targetGeneration: "old" },
        frameId: "old",
        payload: {},
        write: async () => {
          throw Error("Blind resend");
        }
      }),
      /no longer current/
    );
    owner.seal();
    await owner.dispatcher.shutdown();
  });
  await pool.end();
  pool = null;
  await check("second shutdown removes all owned child processes", stop);
  assert.equal(treeDigest(resources), archive.artifactDigest, "immutable installed artifact");
  archive.pass = archive.tests.length;
  archive.fail = 0;
  archive.skip = 0;
} finally {
  await pool?.end();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 15000))]);
  }
  const pgdata = path.join(pgRoot, "data");
  if (fs.existsSync(path.join(pgdata, "postmaster.pid")))
    execFileSync(
      path.join(resources, "postgres", "bin", "pg_ctl"),
      ["-D", pgdata, "-m", "fast", "-w", "stop"],
      { stdio: "ignore" }
    );
  await new Promise((r) => provider.close(r));
  archive.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(archive, null, 2));
  console.log(`Packaged evidence: ${root}/result.json`);
}
