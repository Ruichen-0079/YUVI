/** Explicit, disposable product acceptance. Never reads installation endpoints or provider secrets.
 * Uses the production Supervisor, Server entrypoint, packaged static WebUI server and Chromium.
 * The network model is deterministic: this proves lifecycle/product wiring, not language quality.
 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
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
const personId = "synthetic-person-x";
const scope = `yuvi:v1:user:${personId}:character:${encodeURIComponent(personaId)}`;
const results: Array<{ check: string; status: string }> = [];
const observed: Array<{ model: string; stream: boolean; hasMemory: boolean }> = [];
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
let web: ChildProcess | undefined, browser: any;
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
  const runtimePort = await freePort(),
    webPort = await freePort();
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`,
    webUrl = `http://127.0.0.1:${webPort}`;
  const env: Record<string, string> = {
    PATH: process.env["PATH"]!,
    NODE_ENV: "test",
    RUNTIME_MODE: "production",
    PROVIDER_ALLOW_MOCKS: "false",
    YUVI_RUNTIME_ENV_DIR: join(root, "character-env"),
    YUVI_RUNTIME_DATA_DIR: join(root, "data"),
    YUVI_CONFIG_ROOT: root,
    YUVI_DATA_ROOT: join(root, "data"),
    YUVI_CACHE_ROOT: join(root, "cache"),
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(runtimePort),
    LOG_LEVEL: "error",
    DATABASE_URL: connection.toString(),
    MEMORY_BACKEND: "postgres",
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
  writeProductSettings(settings, { ...env, YUVI_RUNTIME_ENV_DIR: join(root, "people") });
  await writeFile(
    env["YUVI_CHARACTER_CONFIG_PATH"]!,
    JSON.stringify({
      version: 1,
      instanceId,
      envDirectory: join(root, "character-env"),
      dataDirectory: join(root, "data"),
      peopleDirectory: join(root, "people"),
      definition: {
        id: "product-fixture",
        revision: "v1",
        name: "Synthetic Product Companion",
        persona: "Use only authorized evidence. This is a synthetic lifecycle acceptance character."
      }
    }),
    { mode: 0o600 }
  );
  const config: SupervisorConfig = {
    layout: { mode: "development", repositoryRoot: repository },
    repositoryRoot: repository,
    stateDirectory: join(root, "supervisor"),
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
    (v) => v.memory?.productHost === true,
    "normal runtime entrypoint"
  );
  record("Supervisor owns normal production Runtime/Character with restricted PostgreSQL role");
  await writeFile(
    join(root, "supervisor-endpoint.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${control.port}`,
      controlToken: config.controlToken
    }),
    { mode: 0o600 }
  );
  async function pairing(person = personId) {
    const r = await fetch(`http://127.0.0.1:${control!.port}/v1/product-host/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-yuvi-control-token": config.controlToken },
      body: JSON.stringify({ personId: person, origin: webUrl })
    });
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()).code;
  }
  web = spawn(
    process.execPath,
    [
      "scripts/desktop-package/linux-static-web-server.mjs",
      "--root",
      "apps/web/dist",
      "--port",
      String(webPort),
      "--runtime-port",
      String(runtimePort)
    ],
    {
      cwd: repository,
      env: { PATH: env.PATH, YUVI_SUPERVISOR_STATE_ROOT: join(root, "supervisor") },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  await until(
    async () => (await fetch(webUrl)).status,
    (v) => v === 200,
    "packaged static WebUI"
  );
  const pwPath = process.env["YUVI_PLAYWRIGHT_MODULE"];
  const { chromium } = await import(pwPath ? pathToFileURL(resolve(pwPath)).href : "playwright");
  const launchBrowser = () =>
    chromium.launchPersistentContext(join(root, "browser-profile"), {
      headless: true,
      args: ["--no-sandbox"],
      ...(process.env["YUVI_CHROMIUM_EXECUTABLE"]
        ? { executablePath: process.env["YUVI_CHROMIUM_EXECUTABLE"] }
        : {})
    });
  browser = await launchBrowser();
  let context = browser;
  await context.addInitScript(() => localStorage.setItem("yuvi.ui.locale", "en"));
  let page = await context.newPage();
  page.setDefaultTimeout(15000);
  let operatorRequests = 0,
    legacyRequests = 0;
  const observeRequests = () => {
    context.on("request", (r: any) => {
      if (r.headers()["authorization"]) operatorRequests++;
      if (/\/api\/memory(?:\?|$|\/search)/.test(r.url())) legacyRequests++;
    });
  };
  observeRequests();
  await page.goto(webUrl + "/#/webui");
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByLabel("一次性配对码").fill(await pairing());
  await page.getByRole("button", { name: "绑定身份", exact: true }).click();
  await page.getByRole("status").filter({ hasText: personId }).waitFor();
  assert.equal(await page.evaluate(() => document.cookie.includes("yuvi_product_host")), false);
  const cookie = (await context.cookies()).find((c: any) => c.name === "yuvi_product_host");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "Strict");
  record("Browser pairs via authenticated Supervisor, HttpOnly cookie; no operator in JavaScript");
  let main = await context.newPage();
  await main.goto(webUrl + "/#/main");
  async function send(text: string) {
    await main.getByRole("textbox", { name: "Chat message", exact: true }).fill(text);
    const response = main.waitForResponse(
      (r: any) => r.url().endsWith("/v1/messages/stream") && r.request().method() === "POST"
    );
    await main.getByRole("button", { name: "Send message", exact: true }).click();
    const r = await response;
    assert.equal(r.status(), 200, await r.text());
    await main
      .getByRole("button", { name: "Send message", exact: true })
      .waitFor({ state: "visible" });
  }
  async function api(path: string, body?: unknown) {
    return page.evaluate(
      async ({ path, body }: { path: string; body?: unknown }) => {
        const r = await fetch("/api" + path, {
          credentials: "include",
          ...(body === undefined
            ? {}
            : {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
              })
        });
        return { status: r.status, body: await r.json() };
      },
      { path, body }
    );
  }
  const current = () => api("/memory/v1/current?" + new URLSearchParams({ scope }));
  await send("Please remember: my favorite color is lake-blue.");
  const first = await until(
    current,
    (v) => v.body.records?.some((r: any) => r.event.content.includes("lake-blue")),
    "durable fact formed by Worker"
  );
  assert.equal(first.status, 200);
  await page.getByRole("button", { name: "刷新记忆", exact: true }).click();
  await page
    .getByRole("button", { name: "My favorite color is lake-blue.", exact: true })
    .waitFor();
  record("Normal Main SSE → Character → Journal → Memory Worker → R5 → actual Memory UI");
  await send("Correction: my favorite color is forest-green now, not lake-blue.");
  await until(
    current,
    (v) =>
      v.body.records?.some((r: any) => r.event.content.includes("forest-green")) &&
      !v.body.records?.some(
        (r: any) => r.state === "current" && r.event.content.includes("lake-blue")
      ),
    "natural correction materialized"
  );
  await page.getByRole("button", { name: "历史与纠正", exact: true }).click();
  await page
    .getByRole("button", { name: "My favorite color is forest-green.", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "My favorite color is lake-blue.", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "My favorite color is forest-green.", exact: true })
    .click();
  await page.getByRole("heading", { name: "记忆来源", exact: true }).waitFor();
  await page.screenshot({ path: join(root, "history-source.png"), fullPage: true });
  record(
    "Natural correction displays current + superseded history and traceable source in browser"
  );
  await page.reload();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("status").filter({ hasText: personId }).waitFor();
  await supervisor.restartService("runtime");
  await until(
    async () => (await fetch(runtimeUrl + "/health")).status,
    (v) => v === 200,
    "Runtime restart"
  );
  await page.getByRole("button", { name: "刷新身份", exact: true }).click();
  await page.getByRole("status").filter({ hasText: personId }).waitFor();
  await browser.close();
  browser = await launchBrowser();
  context = browser;
  observeRequests();
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(webUrl + "/#/webui");
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByRole("status").filter({ hasText: personId }).waitFor();
  main = await context.newPage();
  await main.goto(webUrl + "/#/main");
  await send("What is my favorite color?");
  await until(
    async () => main.locator("body").innerText(),
    (v) => v.includes("Your current favorite color is forest-green"),
    "R5 recall through normal Character input"
  );
  await page.getByRole("button", { name: "刷新记忆", exact: true }).click();
  const runs = await until(
    () => api("/memory/v1/retrievals?" + new URLSearchParams({ scope })),
    (v) => v.body.items?.length > 0,
    "own retrieval evidence"
  );
  assert.equal(runs.status, 200);
  record(
    "Browser process/profile restart + Supervisor Runtime restart preserve identity, current fact, legal recall and retrieval audit"
  );
  const cross = await api(
    "/memory/v1/current?" +
      new URLSearchParams({ scope: scope.replace(personId, "synthetic-person-y") })
  );
  assert.equal(cross.status, 403);
  const override = await api("/message", {
    sessionId: randomUUID(),
    text: "override",
    subjectUserId: "synthetic-person-y"
  });
  assert.equal(override.status, 403);
  const forbidden = await api("/host/v1/conversation-grants/issue", { personId });
  assert.equal(forbidden.status, 401);
  record("Scope/subject overrides and management access are refused for product cookie");
  await page.getByRole("button", { name: "关闭长期记忆权限", exact: true }).click();
  await page.getByRole("button", { name: "开启长期记忆权限", exact: true }).waitFor();
  assert.equal((await current()).status, 403);
  await send("Please remember: my favorite color is ignored-disabled.");
  const wsDisabled = await page.evaluate(async () => {
    const socket = new WebSocket(location.origin.replace(/^http/u, "ws") + "/ws");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(Error("WebSocket disabled-memory chat timeout"));
      }, 15000);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            id: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            type: "user.message",
            payload: {
              sessionId: crypto.randomUUID(),
              content: "Please remember: my favorite color is ignored-websocket."
            }
          })
        );
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (["agent.reply", "runtime.error"].includes(message.type)) {
          clearTimeout(timer);
          socket.close();
          resolve(message.type);
        }
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(Error("WebSocket failed"));
      };
    });
  });
  assert.equal(wsDisabled, "agent.reply");
  const count = await admin.query(
    `select count(*) from ${schema}.memory_authority_records where scope=$1`,
    [scope]
  );
  assert.equal(count.rows[0].count, "2");
  record("Server enforces memory disable even when chat requests readMemory/writeMemory=true");
  await page.getByRole("button", { name: "开启长期记忆权限", exact: true }).click();
  await page.getByRole("button", { name: "关闭长期记忆权限", exact: true }).waitFor();
  const beforeRenew = (await context.cookies()).find(
    (c: any) => c.name === "yuvi_product_host"
  ).value;
  await page.getByRole("button", { name: "续期授权", exact: true }).click();
  await until(
    async () => (await context.cookies()).find((c: any) => c.name === "yuvi_product_host").value,
    (v) => v !== beforeRenew,
    "rotated HttpOnly cookie"
  );
  record("Browser renew updates HttpOnly cookie and invalidates previous token");
  const captured = (await context.cookies()).find((c: any) => c.name === "yuvi_product_host").value;
  const oldSession = await main.evaluate(
    () =>
      Object.entries(localStorage).find(([k]) =>
        k.startsWith("yuvi.conversation-session.default.")
      )?.[1]
  );
  await page.getByLabel("一次性配对码").fill(await pairing("synthetic-person-y"));
  await page.getByRole("button", { name: "绑定身份", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "synthetic-person-y" }).waitFor();
  assert.equal((await current()).status, 403);
  assert.equal(
    (await api("/v1/conversations/history?sessionId=" + encodeURIComponent(oldSession))).status,
    409
  );
  assert.equal(
    await page.getByText("My favorite color is forest-green.", { exact: true }).count(),
    0
  );
  record("Person switch clears Memory UI and rejects prior Person history/session reuse");
  const revokedToken = (await context.cookies()).find(
    (c: any) => c.name === "yuvi_product_host"
  ).value;
  const revokedResponse = page.waitForResponse((r: any) =>
    r.url().endsWith("/host/v1/product/revoke")
  );
  await page.getByRole("button", { name: "撤销此客户端授权", exact: true }).click();
  assert.equal((await revokedResponse).status(), 200);
  await until(
    async () => (await context.cookies()).some((c: any) => c.name === "yuvi_product_host"),
    (value) => !value,
    "browser revocation committed and cookie cleared"
  );
  const stale = await fetch(runtimeUrl + "/message", {
    method: "POST",
    headers: {
      cookie: "yuvi_product_host=" + revokedToken,
      origin: webUrl,
      "content-type": "application/json"
    },
    body: JSON.stringify({ sessionId: randomUUID(), text: "stale credential" })
  });
  assert.equal(stale.status, 401);
  const staleRead = await fetch(
    runtimeUrl +
      "/memory/v1/current?" +
      new URLSearchParams({ scope: scope.replace(personId, "synthetic-person-y") }),
    { headers: { cookie: "yuvi_product_host=" + revokedToken, origin: webUrl } }
  );
  assert.equal(staleRead.status, 401);
  const afterRevoke = (await context.cookies()).find((c: any) => c.name === "yuvi_product_host");
  assert.equal(afterRevoke, undefined);
  record("Revocation clears browser cookie; captured old client cannot issue private reads/writes");
  assert.equal(operatorRequests, 0);
  assert.equal(legacyRequests, 0);
  const sources = await admin.query(
    `select count(*) from ${schema}.memory_authority_records where scope=$1`,
    [scope]
  );
  assert.equal(sources.rows[0].count, "2");
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(
      {
        status: "PASS",
        schema: "product-host-acceptance.v1",
        mode: "real Chromium + normal production services + deterministic network model fixture",
        checks: results,
        operatorRequests,
        legacyRequests,
        authorityRecords: sources.rows[0].count,
        modelCalls: observed,
        nativePackagedDesktop: "NOT_TESTED"
      },
      null,
      2
    )
  );
  console.log("Acceptance evidence:", root);
} catch (error) {
  await writeFile(
    join(root, "result.json"),
    JSON.stringify({ status: "FAIL", checks: results, error: String(error) }, null, 2)
  );
  console.error("Acceptance failed; isolated evidence:", root);
  throw error;
} finally {
  await browser?.close();
  if (web && web.exitCode === null) {
    const done = new Promise<void>((r) => web!.once("exit", () => r()));
    web.kill("SIGTERM");
    await done;
  }
  await supervisor?.shutdown();
  if (control) await new Promise<void>((r) => control!.server.close(() => r()));
  await new Promise<void>((r) => model.close(() => r()));
  if (schemaCreated) await admin.query(`drop schema "${schema}" cascade`);
  if (roleCreated) {
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role ${role}`);
  }
  await admin.end();
}
