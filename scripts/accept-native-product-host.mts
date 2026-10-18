/** Explicit, disposable product acceptance. Never reads installation endpoints or provider secrets.
 * Uses the actual packaged Tauri WebKitGTK app, OS confirmation dialogs, production Supervisor,
 * Server/Character/Journal/Worker and restricted PostgreSQL role. No Chromium is used.
 * The network model is deterministic: this proves lifecycle/product wiring, not language quality.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import pg from "pg";
import {
  DesktopSupervisor,
  startSupervisorHttpServer,
  type SupervisorConfig
} from "../packages/desktop-supervisor/src/index.js";
import { applySqlMigrations, readSqlMigrations } from "../packages/memory/src/migrations.js";
import {
  importLegacyConfiguration,
  writeProductSettings,
  commitProductSettings
} from "../apps/server/src/services/product-store.js";
import { chatCompletionFixture } from "../apps/server/src/test-support/chat-completion.js";

const database = process.env["YUVI_PRODUCT_HOST_TEST_DATABASE_URL"];
if (!database || !process.argv.includes("--run"))
  throw Error("Requires --run and explicit YUVI_PRODUCT_HOST_TEST_DATABASE_URL");
const location = new URL(database);
if (
  location.hostname !== "127.0.0.1" ||
  !["31518", "31508"].includes(location.port) ||
  !location.pathname.startsWith("/yuvi_pr_")
)
  throw Error("Requires a disposable local yuvi_pr_* database on 31518/31508");
const repository = resolve(new URL("../", import.meta.url).pathname);
const output = process.env["YUVI_PRODUCT_HOST_ACCEPTANCE_ROOT"];
if (!output || !output.startsWith("/"))
  throw Error("Explicit absolute acceptance output directory required");
await mkdir(output, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(output, "run-"));
const schema = "product_ui_" + randomUUID().replaceAll("-", "");
const role = "product_ui_app_" + randomUUID().replaceAll("-", "");
const admin = new pg.Pool({ connectionString: database });
const connection = new URL(database);
connection.searchParams.set("options", `-c search_path=${schema},public -c role=${role}`);
const operator = "synthetic-operator-" + randomBytes(24).toString("hex");
const instanceId = "product-ui-" + randomUUID();
const personaId = "character-instance:" + instanceId;
let personId = "synthetic-person-x";
let scope = `yuvi:v1:user:${personId}:character:${encodeURIComponent(personaId)}`;
const results: Array<{ check: string; status: string }> = [];
const observed: Array<{ model: string; stream: boolean; hasMemory: boolean }> = [];
const transcripts: unknown[] = [];
const record = (check: string) => {
  results.push({ check, status: "PASS" });
  console.log("PASS", check);
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  work: () => Promise<T>,
  good: (v: T) => boolean,
  label: string
): Promise<T> {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    try {
      const v = await work();
      if (good(v)) return v;
    } catch {}
    await delay(150);
  }
  throw Error("Timed out: " + label);
}
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const model = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const system = body.messages?.[0]?.content ?? "";
    const current = body.messages?.at(-1)?.content ?? "";
    const whole = JSON.stringify(body.messages);
    assert.ok(!/(?:yuh_|ydc_|yno_)[A-Za-z0-9_-]{43,}/u.test(whole));
    assert.ok(!whole.includes(operator));
    observed.push({
      model: body.model,
      stream: body.stream === true,
      hasMemory: whole.includes("lake-blue") || whole.includes("forest-green")
    });
    let answer: string;
    if (system.includes("Evaluate every source for useful long-term memory")) {
      const input = JSON.parse(current);
      const value = input.source.includes("forest-green") ? "forest-green" : "lake-blue";
      const target = input.prior.find((p: { content: string }) => p.content.includes("lake-blue"));
      answer = JSON.stringify({
        propositions:
          input.source.includes("favorite color") && !input.source.endsWith("?")
            ? [
                {
                  content: `My favorite color is ${value}.`,
                  evidenceText: input.source,
                  relation: target && value === "forest-green" ? "supersedes" : "new",
                  targetIds: target && value === "forest-green" ? [target.id] : []
                }
              ]
            : []
      });
    } else if (system.includes("Decompose the untrusted question")) {
      const input = JSON.parse(current);
      answer = JSON.stringify({ needs: [{ quote: input.question, queries: ["favorite color"] }] });
    } else if (system.includes("Evaluate whether each untrusted question")) {
      const input = JSON.parse(current);
      answer = JSON.stringify({
        needs: (input.needs ?? [{ id: "q0", quote: input.question }]).map(
          (n: { id: string; quote: string }) => ({
            ...n,
            verdict: input.claims.length ? "SUPPORTED" : "INSUFFICIENT",
            citations: input.claims
              .slice(0, 1)
              .map((c: { id: string; text: string }) => ({ id: c.id, quote: c.text }))
          })
        )
      });
    } else {
      answer = whole.includes("forest-green")
        ? "Your current favorite color is forest-green, from your own correction."
        : "Your statement was received; memory formation is checked separately.";
    }
    transcripts.push({
      input: body.messages,
      answer,
      model: body.model,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
    });
    const out = chatCompletionFixture(body, {
      content: answer,
      model: body.model,
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
    });
    res.writeHead(out.status, { "content-type": out.headers.get("content-type")! });
    res.end(await out.text());
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(e) }));
  }
});
let supervisor: DesktopSupervisor | undefined,
  control: Awaited<ReturnType<typeof startSupervisorHttpServer>> | undefined;
let driver: ChildProcess | undefined;
let session = "";
let driverUrl = "";
let secretNamespace: string | undefined;
let accepted = false;
let schemaCreated = false,
  roleCreated = false;
try {
  await applySqlMigrations(admin, await readSqlMigrations());
  await admin.query(`create schema "${schema}"`);
  schemaCreated = true;
  const provision = new pg.Pool({
    connectionString: database,
    options: `-c search_path=${schema},public`
  });
  try {
    await applySqlMigrations(provision, await readSqlMigrations());
  } finally {
    await provision.end();
  }
  await admin.query(`create role ${role} nologin nosuperuser nocreatedb nocreaterole`);
  roleCreated = true;
  await admin.query(`grant usage on schema ${schema},public to ${role}`);
  await admin.query(
    `grant select,insert,update,delete on all tables in schema ${schema} to ${role}`
  );
  await admin.query(`grant usage,select on all sequences in schema ${schema} to ${role}`);
  await admin.query(
    `revoke update,delete on ${schema}.memory_authority_records,${schema}.memory_authority_relations,${schema}.memory_authority_admissions,${schema}.context_use_manifests,${schema}.context_use_exposures,${schema}.journal_events,${schema}.journal_event_parents,${schema}.retained_observations from ${role}`
  );
  await admin.query(
    `grant update(evidence,image_bytes,erased_at,erased_by_source) on ${schema}.retained_observations to ${role}`
  );
  await admin.query(`revoke insert,update,delete on ${schema}.yuvi_schema_migrations from ${role}`);
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  const modelPort = (model.address() as { port: number }).port;
  const runtimePort = await freePort();
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const env: Record<string, string> = {
    PATH: process.env["PATH"]!,
    NODE_ENV: "test",
    RUNTIME_MODE: "production",
    PROVIDER_ALLOW_MOCKS: "false",
    YUVI_RUNTIME_ENV_DIR: join(root, "character-env"),
    LIVE2D_CORE_PATH: join(root, "public-assets/live2dcubismcore.min.js"),
    YUVI_RUNTIME_DATA_DIR: join(root, "data"),
    YUVI_CONFIG_ROOT: root,
    YUVI_DATA_ROOT: join(root, "data"),
    YUVI_CACHE_ROOT: join(root, "cache"),
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(runtimePort),
    LOG_LEVEL: "error",
    DATABASE_URL: connection.toString(),
    MEMORY_BACKEND: "legacy",
    MEMORY_REPOSITORY: "postgres",
    CONVERSATION_REPOSITORY: "postgres",
    DEFAULT_CHAT_PROVIDER: "openai-compatible",
    CHAT_PROVIDER_CHAIN: "openai-compatible",
    DEFAULT_REASONING_PROVIDER: "openai-compatible",
    REASONING_PROVIDER_CHAIN: "openai-compatible",
    OPENAI_COMPATIBLE_API_BASEURL: `http://127.0.0.1:${modelPort}/v1`,
    OPENAI_COMPATIBLE_API_KEY: "synthetic-network-fixture-key",
    OPENAI_COMPATIBLE_CHAT_MODEL: "fixture-chat",
    OPENAI_COMPATIBLE_REASONING_MODEL: "fixture-reasoning",
    OPENAI_COMPATIBLE_CHAT_CONTEXT_WINDOW: "65536",
    MEMORY_EXTRACTOR: "llm",
    MEMORY_MAINTENANCE_ENABLED: "false",
    MEMORY_INGESTION_COORDINATOR_ENABLED: "true",
    MEMORY_INGESTION_POLL_INTERVAL_MS: "100",
    MEMORY_VECTOR_INDEX_ENABLED: "false",
    MEMORY_QUERY_EXPANSION_ENABLED: "true",
    MEMORY_EVIDENCE_SUPPORT_ENABLED: "true",
    YUVI_AUTO_MIGRATE: "0",
    DASHBOARD_DEV_TOKEN: operator,
    YUVI_CHARACTER_CONFIG_PATH: join(root, "character.json")
  };
  await mkdir(join(root, "public-assets"), { recursive: true });
  await writeFile(env["LIVE2D_CORE_PATH"]!, "globalThis.__nativePublicAssetProbe = true;");
  const settings = commitProductSettings(
    {
      ...importLegacyConfiguration(env),
      people: [
        { id: personId, displayName: "Synthetic X", personaId, notes: "" },
        { id: "synthetic-person-y", displayName: "Synthetic Y", personaId, notes: "" }
      ],
      primaryPersonId: personId
    },
    null
  );

  await writeFile(
    env["YUVI_CHARACTER_CONFIG_PATH"]!,
    JSON.stringify({
      version: 1,
      instanceId,
      envDirectory: join(root, "character-env"),
      dataDirectory: join(root, "data"),
      definition: {
        id: "product-fixture",
        revision: "v1",
        name: "Synthetic Product Companion",
        persona: "Use only authorized evidence. This is a synthetic lifecycle acceptance character."
      }
    }),
    { mode: 0o600 }
  );
  const { readCharacterComposition } = await import("../apps/server/src/character-composition.js");
  const { claimCharacterFiles } = await import("../apps/server/src/character-storage.js");
  claimCharacterFiles(
    readCharacterComposition(env["YUVI_CHARACTER_CONFIG_PATH"], env)!.binding,
    env,
    false
  );
  writeProductSettings(settings, env);
  const config: SupervisorConfig = {
    layout: { mode: "development", repositoryRoot: repository },
    repositoryRoot: repository,
    stateDirectory: join(root, "supervisor", instanceId),
    instanceId,
    ownershipToken: randomUUID(),
    controlToken: randomBytes(32).toString("hex"),
    controlHost: "127.0.0.1",
    controlPort: 0,
    env,
    memoryBackend: "postgres",
    autostartRuntime: true,
    autostartMem0: false,
    autostartTts: false,
    runtimeUrl,
    mem0Url: "http://127.0.0.1:1",
    ttsWrapperUrl: "http://127.0.0.1:1",
    ttsUpstreamUrl: "http://127.0.0.1:1",
    ollamaUrl: "http://127.0.0.1:1",
    databaseUrl: connection.toString(),
    runtimeStart: {
      file: process.execPath,
      args: ["--conditions=development", "--import", "tsx", "apps/server/src/index.ts"],
      cwd: repository,
      env: {},
      commandMarker: "apps/server/src/index.ts"
    },
    mem0Start: null,
    ttsWrapperStart: null,
    ttsUpstreamStart: null
  };
  supervisor = new DesktopSupervisor(config);
  control = await startSupervisorHttpServer(supervisor, { controlToken: config.controlToken });
  await supervisor.ensureService("runtime");
  await until(
    async () => (await fetch(runtimeUrl + "/health")).json(),
    (v) => v.memory?.productHost === false,
    "normal legacy runtime entrypoint before explicit native activation"
  );
  record("Supervisor owns normal production Runtime/Character with restricted PostgreSQL role");
  const nativeRoot = process.env["YUVI_NATIVE_TOOLS_ROOT"];
  if (!nativeRoot) throw Error("Explicit native tools root required");
  const stateRoot = join(root, "supervisor");
  const endpointFile = join(config.stateDirectory, "control-endpoint.json");
  await writeFile(
    endpointFile,
    JSON.stringify({
      host: "127.0.0.1",
      port: control.port,
      baseUrl: `http://127.0.0.1:${control.port}`,
      instanceId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      controlToken: config.controlToken
    }),
    { mode: 0o600 }
  );
  await writeFile(
    join(stateRoot, "active-instance.json"),
    JSON.stringify({ instanceId, pid: process.pid, endpointFile }),
    { mode: 0o600 }
  );
  const nativeConfig = join(root, "xdg-config", "com.yuvi.companion");
  await mkdir(nativeConfig, { recursive: true, mode: 0o700 });
  await writeFile(
    join(nativeConfig, "settings.json"),
    JSON.stringify({
      schemaVersion: 1,
      app: { language: "en" },
      chat: { provider: "openai-compatible", model: "fixture-chat" },
      cognition: { provider: "openai-compatible", model: "fixture-reasoning" },
      openaiCompatible: { baseUrl: `http://127.0.0.1:${modelPort}/v1` },
      runtime: { mode: "managed", autostart: true, url: runtimeUrl },
      memory: {
        enabled: true,
        backend: "legacy",
        mode: "managed",
        baseUrl: "http://127.0.0.1:1",
        subjectUserId: "unused",
        personaId,
        ollamaUrl: "http://127.0.0.1:1",
        llm: { provider: "none", model: "", baseUrl: "" }
      },
      tts: {
        enabled: false,
        mode: "external",
        wrapperUrl: "http://127.0.0.1:1",
        upstreamUrl: "http://127.0.0.1:1"
      },
      companion: { alwaysOnTop: false },
      proactive: { enabled: false }
    })
  );
  const namespace = `YUVI-portable-0.0.${Date.now()}`;
  secretNamespace = namespace;
  const driverPort = await freePort(),
    nativePort = await freePort();
  const driverEnv = {
    ...process.env,
    YUVI_SECRET_NAMESPACE: namespace,
    YUVI_SUPERVISOR_STATE_ROOT: stateRoot,
    YUVI_DESKTOP_SUPERVISOR_BINDING: "attach",
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    GDK_BACKEND: "x11",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    LIBGL_ALWAYS_SOFTWARE: "1",
    TAURI_WEBVIEW_AUTOMATION: "true",
    LD_LIBRARY_PATH: join(nativeRoot, "icu/usr/lib/x86_64-linux-gnu")
  };
  // Namespace is unique and contains only this test's synthetic secrets.
  for (const [key, value] of [
    ["YUVI/memory/database-url", connection.toString()],
    ["YUVI/models/openai-compatible-api-key", "synthetic-network-fixture-key"]
  ]) {
    const r = spawnSync(
      "secret-tool",
      [
        "store",
        "--label=YUVI isolated native acceptance",
        "service",
        namespace,
        "username",
        key!,
        "target",
        "default",
        "application",
        "rust-keyring"
      ],
      { input: value, env: driverEnv, encoding: "utf8" }
    );
    if (r.status !== 0)
      throw Error("Cannot provision isolated native secret namespace: " + r.stderr);
  }
  driverUrl = `http://127.0.0.1:${driverPort}`;
  const log = await import("node:fs").then((fs) =>
    fs.openSync(join(root, "tauri.log"), "a", 0o600)
  );
  driver = spawn(
    join(nativeRoot, "bin/tauri-driver"),
    [
      "--port",
      String(driverPort),
      "--native-port",
      String(nativePort),
      "--native-driver",
      join(nativeRoot, "usr/bin/WebKitWebDriver")
    ],
    { cwd: repository, env: driverEnv, stdio: ["ignore", log, log] }
  );
  async function wd(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST"
  ): Promise<any> {
    const r = await fetch(driverUrl + path, {
      signal: AbortSignal.timeout(60000),
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    });
    const data = await r.json();
    if (!r.ok || data.value?.error) throw Error(JSON.stringify(data));
    return data.value;
  }
  await until(
    () => wd("/status"),
    () => true,
    "tauri-driver ready"
  );
  const started = await wd("/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": {
          application:
            process.env["YUVI_NATIVE_APP_BINARY"] ??
            join(repository, "apps/desktop/src-tauri/target/debug/yuvi-desktop")
        }
      }
    }
  });
  session = started.sessionId;
  await writeFile(join(root, "webdriver.json"), JSON.stringify({ driverUrl, session }), {
    mode: 0o600
  });
  console.log("Native WebDriver session established");
  const script = (source: string, args: unknown[] = []) =>
    wd(`/session/${session}/execute/sync`, { script: source, args });
  const text = () => script("return document.body.innerText");
  const click = async (label: string) =>
    until(
      () =>
        script(
          "const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===arguments[0]); if(!b||b.disabled)throw Error('Button absent or unavailable: '+arguments[0]); b.click();return true;",
          [label]
        ),
      (v) => v,
      "button " + label
    );
  const fill = async (selector: string, value: string) =>
    script(
      "const e=document.querySelector(arguments[0]);if(!e)throw Error('Field absent'); const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,arguments[1]);e.dispatchEvent(new Event('input',{bubbles:true}));return true;",
      [selector, value]
    );
  const native = async (command: string, args: unknown) =>
    script(
      "return window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).catch(e=>{throw new Error(String(e))});",
      [command, args]
    );
  async function confirm() {
    const ids = await until(
      async () =>
        spawnSync("xdotool", ["search", "--onlyvisible", "--name", "YUVI · 本机身份确认"], {
          encoding: "utf8"
        })
          .stdout.trim()
          .split("\n")
          .filter(Boolean),
      (v) => v.length > 0,
      "native ownership dialog"
    );
    for (const id of ids) {
      const pid = spawnSync("xdotool", ["getwindowpid", id], { encoding: "utf8" }).stdout.trim();
      assert.match(pid, /^[0-9]+$/u);
      const environment = await readFile(`/proc/${pid}/environ`);
      assert.ok(
        environment.toString().split("\0").includes(`XDG_CONFIG_HOME=${root}/xdg-config`),
        "Confirmation belongs to this isolated native process"
      );
      // Focus the exact isolated dialog before keyboard activation. XWayland's
      // virtual multi-monitor pointer coordinates are unreliable under this compositor.
      const focus = spawnSync("xdotool", ["windowfocus", "--sync", id], {
        encoding: "utf8",
        timeout: 1000
      });
      assert.equal(focus.status, 0, focus.stderr);
      const accept = spawnSync(
        "xdotool",
        ["key", "--window", id, "--clearmodifiers", "Right", "Return"],
        { encoding: "utf8" }
      );
      assert.equal(accept.status, 0, accept.stderr);
      await until(
        async () => spawnSync("xdotool", ["getwindowgeometry", id], { encoding: "utf8" }).status,
        (v) => v !== 0,
        "owned native dialog accepted"
      );
    }
  }
  async function screenshot(name: string) {
    const data = await wd(`/session/${session}/screenshot`);
    await writeFile(join(root, name + ".png"), Buffer.from(data, "base64"));
  }
  await until(text, (v) => v.includes("确认本机所有权"), "bundled native first run");
  assert.match(await script("return location.href"), /^tauri:\/\/localhost/);
  await screenshot("01-first-run");
  assert.equal(
    await native("service_action", { action: "restart", serviceId: "runtime" }).then(
      () => false,
      () => true
    ),
    true
  );
  await click("确认本机所有权");
  await confirm();
  await until(text, (v) => v.includes("创建我的身份"), "native owner confirmed");
  assert.equal((await text()).includes("Synthetic X"), false);
  record(
    "Actual bundled Tauri WebKitGTK first run; OS ownership confirmation; no adoption of existing People"
  );
  let droppedCreationReceipt = false;
  control.server.prependListener("request", (request, response) => {
    if (request.url !== "/v1/native-product/create" || droppedCreationReceipt) return;
    const end = response.end.bind(response);
    response.end = ((chunk: unknown, ...args: unknown[]) => {
      if (
        typeof chunk === "string" &&
        JSON.parse(chunk).status === "APPLIED" &&
        !droppedCreationReceipt
      ) {
        droppedCreationReceipt = true;
        response.destroy();
        return response;
      }
      return (end as (...args: unknown[]) => unknown)(chunk, ...args);
    }) as typeof response.end;
  });
  await click("启用本机记忆");
  await confirm();
  await until(
    async () => (await fetch(runtimeUrl + "/health")).json(),
    (v) => v.memory?.productHost === true,
    "explicit native R5 activation uses existing config/Supervisor lifecycle"
  );
  await until(
    () =>
      script(
        "return ![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='启用本机记忆')"
      ),
    (v) => v,
    "first-use identity service ready after opt-in"
  );
  record(
    "Legacy configuration upgrades to R5 only after real native ownership and activation consent; existing People remain unclaimed"
  );
  await fill('input[aria-label="你的名字"]', "Native Synthetic X");
  await click("创建我的身份");
  await confirm();
  await until(
    async () => droppedCreationReceipt,
    (v) => v,
    "native create receipt deliberately lost after real A9 commit"
  );
  const pendingVault = JSON.parse(
    await readFile(join(nativeConfig, "native-product/owner.json"), "utf8")
  );
  assert.ok(pendingVault.pending?.handle);
  const application = JSON.parse(
    await readFile(join(root, "character-env/product-settings.json"), "utf8")
  );
  assert.equal(
    application.productCommandReceipts.filter(
      (r: any) => r.commandHandle === pendingVault.pending.handle
    ).length,
    1
  );
  await wd(`/session/${session}`, undefined, "DELETE");
  session = "";
  const creationRestart = await wd("/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": {
          application:
            process.env["YUVI_NATIVE_APP_BINARY"] ??
            join(repository, "apps/desktop/src-tauri/target/debug/yuvi-desktop")
        }
      }
    }
  });
  session = creationRestart.sessionId;
  await until(
    text,
    (v) => v.includes("恢复上次创建"),
    "native pending creation survives application restart"
  );
  await click("恢复上次创建");
  await until(text, (v) => v.includes("以 Native Synthetic X 进入"), "A9 Person creation");
  const recovered = JSON.parse(
    await readFile(join(root, "character-env/product-settings.json"), "utf8")
  );
  assert.equal(
    recovered.productCommandReceipts.filter(
      (r: any) => r.commandHandle === pendingVault.pending.handle
    ).length,
    1
  );
  record(
    "Real A9 Person creation committed, control receipt lost, native application restarted, frozen command recovered without duplicate creation"
  );

  const people = await native("native_product_activation", { action: "status" });
  assert.equal(people.people.length, 1);
  personId = people.people[0].id;
  scope = `yuvi:v1:user:${encodeURIComponent(personId)}:character:${encodeURIComponent(personaId)}`;
  await script(
    "window.__nativeErrors=[];addEventListener('error',e=>window.__nativeErrors.push(String(e.error?.stack||e.message)));addEventListener('unhandledrejection',e=>window.__nativeErrors.push(String(e.reason?.stack||e.reason)));"
  );
  await click("以 Native Synthetic X 进入");
  await confirm();
  await delay(1000);
  await writeFile(join(root, "activation-view.txt"), await text());
  await writeFile(
    join(root, "activation-errors.json"),
    JSON.stringify(await script("return window.__nativeErrors"))
  );
  const debugState = await native("native_product_request", {
    path: "/host/v1/product/status",
    method: "GET"
  }).catch((e) => ({ error: String(e) }));
  await writeFile(join(root, "activation-status.json"), JSON.stringify(debugState));
  await until(
    text,
    (v) => v.includes("Native Synthetic X") && v.includes("切换身份"),
    "native product session"
  );
  await screenshot("02-active");
  record(
    "Native Person created through A9 and selected; product Host credential stays outside JavaScript"
  );
  const result = await native("native_product_request", {
    path: "/host/v1/product/status",
    method: "GET"
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).personId, personId);
  assert.equal(await script("return document.cookie.includes('yuvi_product_host')"), false);
  const privateVault = JSON.parse(
    await readFile(join(nativeConfig, "native-product/owner.json"), "utf8")
  );
  for (const command of [
    "get_service_status",
    "get_user_settings",
    "get_desktop_runtime_binding"
  ]) {
    const metadata = JSON.stringify(await native(command, {}));
    for (const secret of [
      operator,
      config.controlToken,
      privateVault.ownerId,
      privateVault.cookie.split("=")[1]
    ])
      assert.equal(metadata.includes(secret), false);
    assert.equal(/ydc_[a-f0-9]{64}/u.test(metadata), false);
  }
  console.log("Native checkpoint:", root);
  await writeFile(
    join(root, "checkpoint.json"),
    JSON.stringify({ status: "PASS", checks: results, personId, scope })
  );
  async function api(path: string, body?: unknown) {
    const r = await native("native_product_request", {
      path,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body })
    });
    return { status: r.status, body: JSON.parse(r.body) };
  }
  const current = () => api("/memory/v1/current?" + new URLSearchParams({ scope }));
  async function send(text: string) {
    await fill('textarea[aria-label="Chat message"]', text);
    await script(
      "const b=document.querySelector('[aria-label=\"Send message\"]');if(!b||b.disabled)throw Error('Chat is unavailable'); b.click();return true;"
    );
    await until(
      async () => script("return !document.querySelector('[aria-label=\"Stop generating\"]')"),
      (v) => v,
      "chat stream completes"
    );
  }
  await send("Please remember: my favorite color is lake-blue.");
  const first = await until(
    current,
    (v) => v.body.records?.some((r: any) => r.event.content.includes("lake-blue")),
    "native Worker durable fact"
  );
  assert.equal(first.status, 200);
  await click("记忆");
  await until(
    text,
    (v) => v.includes("My favorite color is lake-blue."),
    "same native window Authority fact"
  );
  await screenshot("03-native-memory");
  const ownRows = await admin.query(
    `select count(*)::int as count from ${schema}.memory_authority_records where scope=$1`,
    [scope]
  );
  assert.ok(ownRows.rows[0].count > 0);
  record(
    "Native UI chat/SSE → actual Character/Journal/Worker → restricted PostgreSQL R5 → same-window Memory UI"
  );
  await click("聊天");
  await until(
    () => script("return !!document.querySelector('textarea[aria-label=\"Chat message\"]')"),
    (v) => v,
    "chat returns"
  );
  await send("Correction: my favorite color is forest-green.");
  await until(
    current,
    (v) => v.body.records?.some((r: any) => r.event.content.includes("forest-green")),
    "natural correction current projection"
  );
  await click("记忆");
  await click("历史与纠正");
  await until(
    text,
    (v) =>
      v.includes("My favorite color is lake-blue.") &&
      v.includes("My favorite color is forest-green.") &&
      v.includes("superseded"),
    "native traceable correction history"
  );
  await click("My favorite color is forest-green.");
  await until(text, (v) => v.includes("记忆来源"), "native provenance detail");
  await screenshot("04-native-history");
  record(
    "Natural correction; same native window displays current + superseded history and provenance"
  );
  // A separate browser cannot take the native session: JS has neither Cookie nor Bearer.
  const unowned = await fetch(runtimeUrl + "/host/v1/native/people", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:9999" },
    body: JSON.stringify({ ownerId: "yno_" + "a".repeat(43) })
  });
  assert.equal(unowned.status, 401);
  const illegal = await native("native_product_request", {
    path: "/product/settings",
    method: "GET"
  }).then(
    () => false,
    () => true
  );
  assert.equal(illegal, true);
  const cross = await api(
    "/memory/v1/current?" +
      new URLSearchParams({
        scope: `yuvi:v1:user:synthetic-person-y:character:${encodeURIComponent(personaId)}`
      })
  );
  assert.equal(cross.status, 403);
  const before = await admin.query(
    `select count(*)::int as count from ${schema}.memory_authority_records`
  );
  const readonly = await api("/v1/messages", {
    sessionId: "read-only-native-" + randomUUID(),
    text: "My favorite color is ultraviolet.",
    options: { readMemory: false, writeMemory: false, voiceOutput: false }
  });
  assert.equal(readonly.status, 200);
  const after = await admin.query(
    `select count(*)::int as count from ${schema}.memory_authority_records`
  );
  assert.equal(before.rows[0].count, after.rows[0].count);
  record(
    "Unauthorized webpage/control, unlisted native operations, modified Scope and read/write=false boundaries"
  );
  // Native URI/CSP boundaries are tested in the actual packaged WebKit process.
  const originalUrl = await script("return location.href");
  await script("location.href='http://127.0.0.1:9/evil';return true");
  await delay(100);
  assert.equal(await script("return location.href"), originalUrl);
  await script(
    "window.__csp=[];addEventListener('securitypolicyviolation',e=>window.__csp.push(e.effectiveDirective));const s=document.createElement('script');s.textContent='window.__nativeInjected=true';document.head.appendChild(s);return true"
  );
  await until(
    () => script("return window.__csp"),
    (v) => v.includes("script-src-elem") || v.includes("script-src"),
    "actual native CSP rejects injected script"
  );
  assert.equal(await script("return window.__nativeInjected===undefined"), true);
  record("Native navigation refuses a foreign Origin; packaged CSP is present");
  await script(
    "const asset=document.createElement('script');asset.src='yuvi-asset://localhost/live2d-core/live2dcubismcore.min.js';document.head.appendChild(asset);return true"
  );
  await until(
    () => script("return window.__nativePublicAssetProbe===true"),
    (v) => v,
    "allowlisted native public resource loads through owned Runtime and CSP"
  );
  record(
    "Packaged CSP rejects inline injection while allowing the exact public Core resource transport; no private asset credential"
  );

  async function openSocket(id: string) {
    await script(
      "window.__nativeSocketEvents=[];const c=window.__TAURI_INTERNALS__.transformCallback(e=>{if(e.message)window.__nativeSocketEvents.push(e.message)});return window.__TAURI_INTERNALS__.invoke('native_product_socket',{id:arguments[0],channel:'__CHANNEL__:'+c});",
      [id]
    );
    await until(
      () => script("return window.__nativeSocketEvents"),
      (v) => v.some((e: any) => e.type === "open"),
      "native authenticated WebSocket opens"
    );
  }
  const wsId = "native-bounded-socket";
  await openSocket(wsId);
  await api("/host/v1/product/memory", { enabled: false });
  const wsBefore = await admin.query(
    `select count(*)::int as count from ${schema}.memory_authority_records`
  );
  const wsTrace = randomUUID();
  await native("native_product_socket_send", {
    id: wsId,
    packet: {
      id: randomUUID(),
      type: "user.message",
      timestamp: new Date().toISOString(),
      traceId: wsTrace,
      payload: {
        sessionId: "native-ws-" + randomUUID(),
        content: "My favorite color is ultraviolet."
      }
    }
  });
  await until(
    () => script("return window.__nativeSocketEvents"),
    (v) => v.some((e: any) => e.type === "message" && e.text?.includes("agent.reply")),
    "normal native WebSocket chat with memory disabled"
  );
  assert.equal(
    (await admin.query(`select count(*)::int as count from ${schema}.memory_authority_records`))
      .rows[0].count,
    wsBefore.rows[0].count
  );
  assert.equal(
    await native("native_product_socket_send", {
      id: wsId,
      packet: { type: "dashboard.subscribe" }
    }).then(
      () => false,
      () => true
    ),
    true
  );
  await native("native_product_cancel", { id: wsId });
  await api("/host/v1/product/memory", { enabled: true });
  record(
    "Native fixed-route WebSocket chats with server-enforced Memory disable; operator packets denied; explicit cancellation"
  );
  const vaultPath = join(nativeConfig, "native-product", "owner.json");
  const vaultBefore = JSON.parse(await readFile(vaultPath, "utf8"));
  // Expiration is a deterministic DB fault, not a shortened production lifetime.
  await admin.query(
    `update ${schema}.memory_host_grants set expires_at=clock_timestamp()-interval '1 second' where person_id=$1`,
    [personId]
  );
  await until(
    async () => JSON.parse(await readFile(vaultPath, "utf8")),
    (v) => v.cookie !== vaultBefore.cookie,
    "controlled native renewal after expiry"
  );
  assert.equal((await current()).status, 200);
  const oldCookie = await fetch(runtimeUrl + "/host/v1/product/status", {
    headers: { origin: "tauri://localhost", cookie: vaultBefore.cookie }
  });
  assert.equal(oldCookie.status, 401);
  record(
    "Expiry triggers native-only controlled renewal; old credential cannot restore permissions"
  );
  await supervisor.restartService("runtime");
  await until(
    async () => (await fetch(runtimeUrl + "/health")).json(),
    (v) => v.memory?.productHost === true,
    "Runtime restart product readiness"
  );
  assert.equal((await current()).status, 200);
  const healthySnapshot = await (await fetch(runtimeUrl + "/health")).json();
  await supervisor.stopService("runtime");
  let impostorSawCredential = false;
  const impostor = createServer((request, response) => {
    if (request.headers.cookie || request.headers.authorization) impostorSawCredential = true;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(healthySnapshot));
  });
  await new Promise<void>((r) => impostor.listen(runtimePort, "127.0.0.1", r));
  try {
    assert.equal(
      await native("native_product_request", {
        path: "/host/v1/product/status",
        method: "GET"
      }).then(
        () => false,
        () => true
      ),
      true
    );
    assert.equal(impostorSawCredential, false);
  } finally {
    await new Promise<void>((r) => impostor.close(() => r()));
  }
  await supervisor.ensureService("runtime");
  await until(
    async () => (await fetch(runtimeUrl + "/health")).json(),
    (v) => v.memory?.productHost === true,
    "owned Runtime restored after port impostor"
  );
  assert.equal((await current()).status, 200);
  record(
    "Same-port healthy impostor is rejected before receiving any native credential; only the owned Runtime recovers"
  );
  // A fresh conversation makes this a retrieval test, not replay of the old transcript.
  await script(
    "for(const key of Object.keys(localStorage)) if(key.startsWith('yuvi.conversation-session.')) localStorage.removeItem(key);return true"
  );
  await wd(`/session/${session}`, undefined, "DELETE");
  session = "";
  const restored = await wd("/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": {
          application:
            process.env["YUVI_NATIVE_APP_BINARY"] ??
            join(repository, "apps/desktop/src-tauri/target/debug/yuvi-desktop")
        }
      }
    }
  });
  session = restored.sessionId;
  await until(
    text,
    (v) => v.includes("Native Synthetic X") && v.includes("切换身份"),
    "native app restart identity restored without new pairing"
  );
  await send("What is my favorite color?");
  await until(
    text,
    (v) => v.includes("Your current favorite color is forest-green"),
    "native restart recall"
  );
  const retrievals = await api("/memory/v1/retrievals?" + new URLSearchParams({ scope }));
  assert.equal(retrievals.status, 200);
  assert.ok(retrievals.body.items?.length > 0);
  await screenshot("05-native-restart-recall");
  record("Runtime and real native application restart; private identity and R5 recall recover");
  const beforeSwitch = JSON.parse(await readFile(vaultPath, "utf8"));
  await click("切换身份");
  await fill('input[aria-label="你的名字"]', "Native Synthetic Y");
  await click("创建我的身份");
  await confirm();
  await until(
    text,
    (v) => v.includes("以 Native Synthetic Y 进入"),
    "second native Person creation"
  );
  await click("以 Native Synthetic Y 进入");
  await confirm();
  await until(text, (v) => v.includes("当前身份：Native Synthetic Y"), "native Person switch");
  const switched = await api("/memory/v1/current?" + new URLSearchParams({ scope }));
  assert.equal(switched.status, 403);
  const previous = await fetch(
    runtimeUrl + "/memory/v1/current?" + new URLSearchParams({ scope }),
    { headers: { origin: "tauri://localhost", cookie: beforeSwitch.cookie } }
  );
  assert.equal(previous.status, 401);
  assert.equal((await text()).includes("forest-green"), false);
  record(
    "Native Person switch revokes previous credential, denies old Scope and removes old UI data"
  );
  const activeVault = JSON.parse(await readFile(vaultPath, "utf8"));
  await openSocket("native-revoked-socket");
  await supervisor.stopService("runtime");
  // Disconnect the service during logout: the local tombstone must outlive Runtime recovery.
  await native("native_product_activation", { action: "logout" }).then(
    () => false,
    () => true
  );
  assert.equal(JSON.parse(await readFile(vaultPath, "utf8")).suspended, true);
  assert.equal(
    await native("native_product_request", { path: "/host/v1/product/status", method: "GET" }).then(
      () => false,
      () => true
    ),
    true
  );
  await supervisor.ensureService("runtime");
  await until(
    async () => (await fetch(runtimeUrl + "/health")).json(),
    (v) => v.memory?.productHost === true,
    "Runtime recovered during pending revocation"
  );
  assert.equal(
    await native("native_product_request", { path: "/host/v1/product/status", method: "GET" }).then(
      () => false,
      () => true
    ),
    true
  );
  await until(text, (v) => v.includes("继续完成退出"), "pending native revocation remains visible");
  await click("继续完成退出");

  await until(
    text,
    (v) => v.includes("以 Native Synthetic Y 进入") && !v.includes("退出身份"),
    "native logout clears UI"
  );
  const revoked = await fetch(runtimeUrl + "/v1/messages", {
    method: "POST",
    headers: {
      origin: "tauri://localhost",
      cookie: activeVault.cookie,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sessionId: "revoked-native",
      text: "What is my favorite color?",
      options: { readMemory: true, writeMemory: true, voiceOutput: false }
    })
  });
  assert.equal(revoked.status, 401);
  assert.equal(
    await native("native_product_socket_send", {
      id: "native-revoked-socket",
      packet: { type: "user.message" }
    }).then(
      () => false,
      () => true
    ),
    true
  );
  const oldSse = await fetch(runtimeUrl + "/v1/messages/stream", {
    method: "POST",
    headers: {
      origin: "tauri://localhost",
      cookie: activeVault.cookie,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sessionId: "revoked-sse",
      text: "What is my favorite color?",
      options: { readMemory: true, writeMemory: true, voiceOutput: false }
    })
  });
  assert.equal(oldSse.status, 401);
  record(
    "Interrupted logout persists a fail-closed tombstone across Runtime restart; old WebSocket and SSE cannot restore authority"
  );

  const denied = await native("native_product_request", {
    path: "/memory/v1/current?" + new URLSearchParams({ scope }),
    method: "GET"
  }).then(
    () => false,
    () => true
  );
  assert.equal(denied, true);
  record(
    "Native logout/revocation rejects old private chat and Memory; local page cannot silently regain a Host"
  );
  const finalRows = await admin.query(
    `select scope,count(*)::int as count from ${schema}.memory_authority_records group by scope`
  );
  const appBinary =
    process.env["YUVI_NATIVE_APP_BINARY"] ??
    join(repository, "apps/desktop/src-tauri/target/debug/yuvi-desktop");
  const authority = await admin.query(
    `select r.scope,r.id,r.digest,r.version,r.classification,r.event,c.state from ${schema}.memory_authority_records r join ${schema}.memory_authority_current c using(scope,id) order by r.version`
  );
  const grants = await admin.query(
    `select person_id,revoked_at is not null as revoked,expires_at from ${schema}.memory_host_grants order by granted_at`
  );
  await writeFile(
    join(root, "database-evidence.json"),
    JSON.stringify({ authority: authority.rows, grants: grants.rows }, null, 2)
  );
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        status: "PASS",
        appBinary,
        appSha256: createHash("sha256")
          .update(await readFile(appBinary))
          .digest("hex"),
        mode: "actual bundled Tauri WebKitGTK + production Supervisor/Runtime/Character/Journal/Worker + deterministic network model fixture",
        checks: results,
        authority: finalRows.rows,
        modelCalls: observed,
        realModel: "NOT_RUN",
        platform: "Linux x86_64 / WebKitGTK software rendering",
        fixtureCostUsd: 0
      },
      null,
      2
    )
  );
  await writeFile(join(root, "model-transcripts.json"), JSON.stringify(transcripts, null, 2));
  accepted = true;
  console.log("Native acceptance evidence:", root);
} catch (error) {
  if (session) {
    const r = await fetch(driverUrl + `/session/${session}/execute/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script: "return document.body.innerText", args: [] }),
      signal: AbortSignal.timeout(3000)
    })
      .then((r) => r.json())
      .catch(() => null);
    await writeFile(join(root, "failure-view.json"), JSON.stringify(r));
  }
  await writeFile(
    join(root, "result.json"),
    JSON.stringify({ status: "FAIL", checks: results, error: String(error) }, null, 2)
  );
  console.error("Native failure evidence:", root);
  throw error;
} finally {
  if (session) await fetch(driverUrl + `/session/${session}`, { method: "DELETE" }).catch(() => {});
  driver?.kill("SIGTERM");
  await supervisor?.shutdown();
  if (control) await new Promise<void>((r) => control!.server.close(() => r()));
  await new Promise<void>((r) => model.close(() => r()));
  if (accepted && schemaCreated) await admin.query(`drop schema "${schema}" cascade`);
  if (accepted && roleCreated) {
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role ${role}`);
  }
  if (secretNamespace)
    spawnSync("secret-tool", ["clear", "service", secretNamespace, "application", "rust-keyring"], {
      encoding: "utf8"
    });
  await admin.end();
}
