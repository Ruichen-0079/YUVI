import { createServer } from "node:http";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createPostgresPool } from "@companion/database";
import { applySqlMigrations, readSqlMigrations } from "@companion/memory";
import {
  commitProductSettings,
  defaultProductSettings,
  writeProductSettings,
  readProductSettings
} from "./services/product-store.js";
import { SERVER_MCP_READ_TEXT_CAPABILITY_REF } from "./mcp-capability-binding.js";
import { chatCompletionFixture } from "./test-support/chat-completion.js";

const url = process.env["YUVI_PRODUCTION_PATH_TEST_DATABASE_URL"];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
describe.skipIf(!url)("accepted sources through the actual Server/Character entrypoint", () => {
  it("recovers user-only sources independently of reply outcome, freezes prior dialogue, and fences identity", async () => {
    const location = new URL(url!);
    if (
      !(
        (process.env["CI"] === "true" &&
          ["/yuvi_conformance", "/yuvi_smoke"].includes(location.pathname)) ||
        (location.hostname === "127.0.0.1" &&
          location.port === "31508" &&
          location.pathname.startsWith("/yuvi_pr_"))
      )
    )
      throw Error("Explicit isolated production-path database required");
    const root = await mkdtemp(join(tmpdir(), "yuvi-evidence-entry-"));
    const runtimeCheckout =
      process.env["YUVI_EVIDENCE_RUNTIME_CHECKOUT"] ??
      fileURLToPath(new URL("../../../", import.meta.url));
    const schema = "ec_entry_" + randomUUID().replaceAll("-", "");
    const admin = createPostgresPool(url!);
    const connection = new URL(url!);
    connection.searchParams.set("options", `-c search_path=${schema},public`);
    const pool = createPostgresPool(connection.toString());
    const semanticInputs: any[] = [];
    const calls: any[] = [];
    let release: (() => void) | undefined;
    let blocked = false;
    let reobserveTarget: string | undefined;
    let reobserveRequested = false;
    let holdReasoning = false;
    let holdVision = false;
    let retentionSeconds = 1200;
    let child: ChildProcess | undefined;
    let log = "";
    let base = "";
    let verified = false;
    const gateway = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(body);
      const source = body.messages.at(-1)?.content ?? "";
      if (body.model === "fixture-vision") {
        if (holdVision) {
          holdVision = false;
          blocked = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        const detail = {
          text: "LONG_OCR ".repeat(2000) + " OCR_TAIL_DETAIL",
          sceneSummary: "SCENE_MARKER",
          objects: ["OBJECT_STAMP", "DATE_2031_04_17"],
          confidence: 0.71
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: body.model,
            choices: [{ message: { content: JSON.stringify(detail) }, finish_reason: "stop" }]
          })
        );
        return;
      }
      if (body.messages[0]?.content.includes("Evaluate every source")) {
        const input = JSON.parse(source);
        semanticInputs.push(input);
        const value = input.source as string;
        const propositions: any[] = [];
        if (value.startsWith("EC_FACT_") && !value.includes("WAIT_FOR_"))
          propositions.push({
            content: value,
            evidenceText: value,
            relation: "new",
            targetIds: []
          });
        if (value === "EC_REPLACEMENT") {
          const previous = input.prior.find((p: any) => p.content === "EC_FACT_NORMAL_REPLY");
          propositions.push({
            content: "EC_REPLACEMENT",
            evidenceText: value,
            relation: "supersedes",
            targetIds: [previous.id]
          });
        }
        if (value === "周三。" || value === "不对，是周四。") {
          const previous = input.prior.find((p: any) => p.content === "用户面试在周三。");
          propositions.push({
            content: value === "周三。" ? "用户面试在周三。" : "用户面试在周四。",
            evidenceText: value,
            relation: previous ? "supersedes" : "new",
            targetIds: previous ? [previous.id] : []
          });
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: body.model,
            choices: [
              { message: { content: JSON.stringify({ propositions }) }, finish_reason: "stop" }
            ]
          })
        );
        return;
      }
      if (!body.stream && source === "REOBSERVE_IMAGE" && !reobserveRequested) {
        reobserveRequested = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: body.model,
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    visualNeed: "Read the supplied image again",
                    observationId: reobserveTarget
                  })
                },
                finish_reason: "stop"
              }
            ]
          })
        );
        return;
      }
      if (body.model === "fixture-reasoning") {
        if (holdReasoning) {
          holdReasoning = false;
          blocked = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: body.model,
            choices: [
              {
                message: {
                  content: `REQUEST_CAPABILITY\n${JSON.stringify({ capabilityRef: SERVER_MCP_READ_TEXT_CAPABILITY_REF, request: "Read the authorized text." })}`
                },
                finish_reason: "stop"
              }
            ]
          })
        );
        return;
      }
      if (
        !body.stream &&
        source === "READ_OBSERVATION_PROBE" &&
        !body.messages[0].content.includes('"kind":"COGNITION_RESULT"')
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: body.model,
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    disposition: "NEED_COGNITION",
                    focus: "Read the authorized evidence."
                  })
                },
                finish_reason: "stop"
              }
            ]
          })
        );
        return;
      }
      if (
        !body.stream &&
        (source.includes("CANCEL_REPLY") ||
          source.includes("WAIT_FOR_SUPERSEDE") ||
          source.includes("WAIT_FOR_REVOKE") ||
          source.includes("WAIT_FOR_NOTES"))
      ) {
        blocked = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (
        !body.stream &&
        (source.includes("SILENCE_REPLY") ||
          source.includes("TERMINATE_REPLY") ||
          source.includes("BAD_GATE"))
      ) {
        const content = source.includes("BAD_GATE")
          ? "invalid gate output"
          : JSON.stringify({
              disposition: source.includes("SILENCE_REPLY") ? "SILENCE" : "TERMINATE"
            });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: body.model,
            choices: [{ message: { content }, finish_reason: "stop" }]
          })
        );
        return;
      }
      if (body.stream && source.includes("REJECT_BODY")) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "synthetic 429" } }));
        return;
      }
      const result = chatCompletionFixture(body, {
        content:
          source === "问我面试时间。"
            ? "你哪天面试？"
            : "Synthetic response; no semantic quality claim."
      });
      response.writeHead(result.status, { "content-type": result.headers.get("content-type")! });
      response.end(await result.text());
    });
    const stop = async () => {
      release?.();
      if (!child || child.exitCode !== null) return;
      const done = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([done, delay(10000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await done;
      }
    };
    try {
      await admin.query(`create schema "${schema}"`);
      await applySqlMigrations(pool, await readSqlMigrations());
      const settings = defaultProductSettings();
      settings.people = [
        { id: "ec-person", displayName: "Synthetic Person", personaId: "ec-persona", notes: "" }
      ];
      settings.people.push({
        id: "ec-other",
        displayName: "Other Person",
        personaId: "ec-persona",
        notes: ""
      });
      settings.primaryPersonId = "ec-person";
      writeProductSettings(commitProductSettings(settings, null), { YUVI_RUNTIME_ENV_DIR: root });
      await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
      const gatewayPort = (gateway.address() as { port: number }).port;
      settings.configuration.providers = [
        {
          id: "fixture",
          displayName: "Isolated fixture",
          adapter: "openai-compatible",
          baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
          apiKey: "synthetic-only"
        }
      ];
      settings.configuration.models = ["chat", "reasoning", "vision"].map((capability) => ({
        id: capability,
        providerId: "fixture",
        displayName: capability,
        modelId: `fixture-${capability}`,
        temperature: 0,
        contextWindow: 65536,
        capabilities: [capability as "chat" | "reasoning" | "vision"],
        enabled: true
      }));
      settings.configuration.routes.chat = ["chat"];
      settings.configuration.routes.reasoning = ["reasoning"];
      settings.configuration.routes.vision = ["vision"];
      writeProductSettings(commitProductSettings(settings, null), { YUVI_RUNTIME_ENV_DIR: root });

      const crashModule = join(root, "crash-before-runtime.mjs");
      await writeFile(
        crashModule,
        `import {RuntimeOrchestrator} from ${JSON.stringify(pathToFileURL(join(runtimeCheckout, "packages/core/src/runtime-orchestrator.ts")).href)};
const original=RuntimeOrchestrator.prototype.handleUserMessage;
RuntimeOrchestrator.prototype.handleUserMessage=function(input,...args){if(input.payload?.content?.includes("EC_BEFORE_RUNTIME")) process.exit(73); return original.call(this,input,...args);};`
      );
      const start = async (enabled: boolean, crashBeforeRuntime = false) => {
        let legacyPort = 0;
        base = "";
        // Historical checkouts predate readiness IPC. Only the explicit
        // baseline replay uses the old allocation; normal CI binds atomically.
        if (process.env["YUVI_EVIDENCE_RUNTIME_CHECKOUT"]) {
          const listener = createServer();
          await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
          legacyPort = (listener.address() as { port: number }).port;
          await new Promise<void>((resolve) => listener.close(() => resolve()));
          base = `http://127.0.0.1:${legacyPort}`;
        }
        child = spawn(
          process.execPath,
          [
            "--conditions=development",
            "--import",
            "tsx",
            ...(crashBeforeRuntime ? ["--import", crashModule] : []),
            "apps/server/src/index.ts"
          ],
          {
            cwd: runtimeCheckout,
            env: {
              PATH: process.env["PATH"],
              NODE_ENV: "test",
              PROVIDER_ALLOW_MOCKS: "true",
              YUVI_RUNTIME_ENV_DIR: root,
              YUVI_RUNTIME_DATA_DIR: join(root, "data"),
              YUVI_CONFIG_ROOT: root,
              YUVI_DATA_ROOT: join(root, "data"),
              YUVI_CACHE_ROOT: join(root, "cache"),
              SERVER_HOST: "127.0.0.1",
              SERVER_PORT: String(legacyPort),
              LOG_LEVEL: "warn",
              DATABASE_URL: connection.toString(),
              MEMORY_BACKEND: "postgres",
              MEMORY_REPOSITORY: "postgres",
              CONVERSATION_REPOSITORY: "postgres",
              YUVI_JOURNAL_NAMESPACE: schema,
              DEFAULT_CHAT_PROVIDER: "openai-compatible",
              CHAT_PROVIDER_CHAIN: "openai-compatible",
              DEFAULT_REASONING_PROVIDER: "openai-compatible",
              REASONING_PROVIDER_CHAIN: "openai-compatible",
              OPENAI_COMPATIBLE_API_BASEURL: `http://127.0.0.1:${gatewayPort}/v1`,
              OPENAI_COMPATIBLE_API_KEY: "synthetic-only",
              OPENAI_COMPATIBLE_CHAT_MODEL: "fixture-chat",
              OPENAI_COMPATIBLE_REASONING_MODEL: "fixture-reasoning",
              MEMORY_EXTRACTOR: "llm",
              MEMORY_MAINTENANCE_ENABLED: "false",
              MEMORY_INGESTION_COORDINATOR_ENABLED: String(enabled),
              MEMORY_INGESTION_POLL_INTERVAL_MS: "100",
              YUVI_OBSERVATION_RETENTION_SECONDS: String(retentionSeconds),
              YUVI_OBSERVATION_RETAIN_IMAGES: "true",
              COGNITION_MAX_REASONING_ROUNDS: "1",
              MEMORY_VECTOR_INDEX_ENABLED: "false",
              YUVI_AUTO_MIGRATE: "0",
              DASHBOARD_DEV_TOKEN: "synthetic-operator"
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"]
          }
        );
        child.on("message", (message) => {
          const ready = message as { schema?: string; port?: number };
          if (
            ready.schema === "yuvi.server-ready.v1" &&
            Number.isInteger(ready.port) &&
            ready.port! > 0
          )
            base = `http://127.0.0.1:${ready.port}`;
        });
        for (const stream of [child.stdout, child.stderr])
          stream?.on("data", (d) => {
            log = (log + d.toString()).slice(-10000);
          });
        for (let i = 0; i < 200; i++) {
          if (child.exitCode !== null) throw Error(log);
          try {
            if (base && (await fetch(base + "/health")).ok) return;
          } catch {
            /* startup */
          }
          await delay(50);
        }
        throw Error("Startup timeout: " + log);
      };
      const request = (
        path: string,
        body: unknown,
        token = "synthetic-operator",
        signal?: AbortSignal
      ) =>
        fetch(base + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: "Bearer " + token } : {})
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {})
        });
      await start(false, true);
      const issued = await request("/host/v1/conversation-grants/issue", { personId: "ec-person" });
      expect(issued.status).toBe(200);
      const grant = (await issued.json()) as any;
      const send = async (
        content: string,
        sessionId = randomUUID(),
        writeMemory = true,
        token = grant.token
      ) => {
        const response = await request(
          "/message",
          { sessionId, content, options: { readMemory: true, writeMemory } },
          token
        ).catch((error) => {
          if (content.includes("BAD_GATE")) return null;
          throw Error(`HTTP ${content}: ${String(error)}\n${log}`);
        });
        return response
          ? { status: response.status, body: await response.json(), sessionId }
          : { status: 0, body: { transport: "CLOSED_AFTER_INVALID_GATE" }, sessionId };
      };
      const crashedSource = "EC_FACT_crash EC_BEFORE_RUNTIME";
      const crashResponse = await request(
        "/message",
        { sessionId: randomUUID(), content: crashedSource },
        grant.token
      ).catch(() => null);
      expect(crashResponse).toBeNull();
      expect(
        (
          await pool.query("select event_id from journal_payloads where text_content=$1", [
            crashedSource
          ])
        ).rows
      ).toHaveLength(1);
      const crashAccepted = (
        await pool.query(
          "select source_journal_ref,ingestion_requested from conversation_messages where content=$1 and role='user'",
          [crashedSource]
        )
      ).rows[0];
      expect(
        crashAccepted,
        "Journal ingress committed, but accepted user source must survive a pre-Runtime crash"
      ).toBeDefined();
      expect(crashAccepted.ingestion_requested).toBe(true);
      expect(crashAccepted.source_journal_ref).toBeTruthy();
      await stop();
      await start(false);
      // Commit the accepted source while the worker is disabled. No assistant exists.
      const orphan = "EC_FACT_restart SILENCE_REPLY";
      const orphanReply = await send(orphan);
      expect(orphanReply.status, JSON.stringify(orphanReply) + "\n" + log).toBe(200);
      const accepted = (
        await pool.query("select * from conversation_messages where role='user' and content=$1", [
          orphan
        ])
      ).rows[0];
      expect(accepted.ingestion_requested).toBe(true);
      expect(
        (
          await pool.query("select * from finalized_ingestion_turns where finalized_turn_id=$1", [
            accepted.finalized_turn_id
          ])
        ).rows
      ).toHaveLength(0);
      await stop();
      await start(true);
      const waitFor = async (content: string) => {
        for (let i = 0; i < 180; i++) {
          const result = (
            await pool.query(
              `select fit.* from finalized_ingestion_turns fit join conversation_messages cm using(finalized_turn_id) where cm.role='user' and cm.content=$1`,
              [content]
            )
          ).rows[0];
          if (
            result &&
            ["complete", "skipped", "terminal_failed", "partial"].includes(result.status)
          )
            return result;
          await delay(100);
        }
        throw Error(
          "Source not processed: " +
            content +
            " " +
            JSON.stringify({
              turns: (
                await pool.query(
                  "select finalized_turn_id,status,last_error_code,last_error_message,persona_id from finalized_ingestion_turns"
                )
              ).rows,
              jobs: (await pool.query("select job_id,status,error_code from memory_semantic_jobs"))
                .rows,
              inputs: semanticInputs.length
            }) +
            " " +
            log
        );
      };
      expect(await waitFor(crashedSource)).toMatchObject({
        status: "complete",
        assistant_message_id: null
      });
      expect(await waitFor(orphan)).toMatchObject({
        status: "complete",
        assistant_message_id: null
      });
      for (const kind of [
        "NORMAL_REPLY",
        "SILENCE_REPLY",
        "TERMINATE_REPLY",
        "REJECT_BODY",
        "BAD_GATE"
      ]) {
        const source = "EC_FACT_" + kind;
        const result = await send(source);
        expect(kind === "BAD_GATE" ? [0, 503] : [200, 503]).toContain(result.status);
        expect(await waitFor(source)).toMatchObject({
          status: "complete",
          assistant_message_id: null
        });
      }
      const cancelled = "EC_FACT_cancel CANCEL_REPLY";
      const abort = new AbortController();
      const pending = request(
        "/v1/messages/stream",
        { sessionId: randomUUID(), content: cancelled },
        grant.token,
        abort.signal
      ).catch(() => null);
      for (let i = 0; i < 150 && !blocked; i++) await delay(20);
      expect(blocked).toBe(true);
      abort.abort();
      release?.();
      await pending;
      expect(await waitFor(cancelled)).toMatchObject({
        status: "complete",
        assistant_message_id: null
      });
      const dialogue = randomUUID();
      await send("问我面试时间。", dialogue);
      await send("周三。", dialogue);
      expect((await waitFor("周三。")).status).toBe("complete");
      await send("不对，是周四。", dialogue);
      expect((await waitFor("不对，是周四。")).status).toBe("complete");
      const interpreted = semanticInputs.find((input) => input.source === "周三。");
      expect(
        interpreted.dialogueContext.some(
          (m: any) => m.role === "assistant" && m.content === "你哪天面试？"
        )
      ).toBe(true);
      expect(interpreted.dialogueContext.some((m: any) => m.content === "不对，是周四。")).toBe(
        false
      );
      const frozen = (
        await pool.query(
          "select input_context from memory_semantic_jobs where job_id=(select finalized_turn_id from conversation_messages where content='周三。' and role='user')"
        )
      ).rows[0];
      expect(frozen.input_context).toEqual(interpreted.dialogueContext);
      for (const [content, write, token] of [
        ["EC_FACT_optout", false, grant.token],
        ["EC_FACT_anonymous", true, ""]
      ] as const) {
        await send(content, randomUUID(), write, token);
        expect(
          (
            await pool.query(
              "select ingestion_requested from conversation_messages where content=$1 and role='user'",
              [content]
            )
          ).rows[0].ingestion_requested
        ).toBe(false);
      }
      await stop();
      await start(true);
      const before = calls.length;
      expect((await send("面试当前在什么时候？", randomUUID(), false)).status).toBe(200);
      expect(
        JSON.stringify(calls.slice(before).filter((c) => c.model === "fixture-chat"))
      ).toContain("用户面试在周四。");
      const sourceRuns = (
        await pool.query(
          "select finalized_turn_id,count(*)::int n from finalized_ingestion_events group by finalized_turn_id"
        )
      ).rows;
      expect(sourceRuns.every((r) => r.n === 1)).toBe(true);
      const imageSession = randomUUID();
      const imageReply = await request(
        "/message",
        {
          sessionId: imageSession,
          content: "Inspect this synthetic image.",
          imageAttachment: {
            mimeType: "image/png",
            imageBase64:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD9sAAAAASUVORK5CYII="
          }
        },
        grant.token
      );
      expect(imageReply.status, await imageReply.text()).toBe(200);
      const imageRecord = (
        await pool.query(
          "select observation_id,attempt_id,commit_digest,octet_length(image_bytes) bytes from retained_observations where kind='VISION'"
        )
      ).rows[0];
      expect(imageRecord?.bytes).toBeGreaterThan(0);
      expect(imageRecord?.commit_digest).toMatch(/^[a-f0-9]{64}$/u);
      const executionUrl = `/observations/v1/executions/${imageRecord.attempt_id}?sessionId=${randomUUID()}`;
      const executionEvidence = await fetch(base + executionUrl, {
        headers: { authorization: "Bearer " + grant.token }
      });
      expect(executionEvidence.status).toBe(200);
      expect(await executionEvidence.json()).toMatchObject({
        execution: "APPLIED",
        hasAppliedReceipt: true,
        retentionAtCommit: { state: "STORED", digest: imageRecord.commit_digest },
        report: "AVAILABLE"
      });
      for (const round of [2, 3, 4, 5]) {
        const before = calls.length;
        expect((await send(`Follow-up image round ${round}`, imageSession, false)).status).toBe(
          200
        );
        const visible = JSON.stringify(
          calls.slice(before).filter((c) => c.model === "fixture-chat")
        );
        expect(visible).toContain("SCENE_MARKER");
        expect(visible).toContain("OBJECT_STAMP");
      }
      await stop();
      await start(true);
      const beforeRestoredImage = calls.length;
      expect((await send("Image detail after restart", randomUUID(), false)).status).toBe(200);
      expect(JSON.stringify(calls.slice(beforeRestoredImage))).toContain("SCENE_MARKER");
      const detailUrl = `/observations/v1/${imageRecord.observation_id}?sessionId=${randomUUID()}`;
      const imageDetail = await fetch(base + detailUrl, {
        headers: { authorization: "Bearer " + grant.token }
      });
      expect(imageDetail.status).toBe(200);
      const imageData = (await imageDetail.json()) as any;
      expect(imageData.evidence.text).toContain("OCR_TAIL_DETAIL");
      expect(imageData.action.certainty).toBe("APPLIED");
      expect(imageData.goalStatus).toBe("NOT_INFERRED");
      const imageRowsBeforeReobserve = (
        await pool.query("select count(*)::int n from retained_observations where kind='VISION'")
      ).rows[0].n;
      reobserveTarget = imageRecord.observation_id;
      const beforeReobserve = calls.filter((c) => c.model === "fixture-vision").length;
      expect((await send("REOBSERVE_IMAGE", imageSession, false)).status).toBe(200);
      expect(calls.filter((c) => c.model === "fixture-vision")).toHaveLength(beforeReobserve + 1);
      expect(
        (await pool.query("select count(*)::int n from retained_observations where kind='VISION'"))
          .rows[0].n
      ).toBe(imageRowsBeforeReobserve);
      expect(
        (
          await pool.query(
            "select evidence from effect_observations where category='TERMINAL' and evidence->'reportRetention'->>'state'='NOT_REQUESTED'"
          )
        ).rows.length
      ).toBeGreaterThan(0);
      const beforeHistory = await fetch(
        base + `/v1/conversations/history?sessionId=${imageSession}`
      );
      expect(beforeHistory.status).toBe(409);
      const ownHistory = await fetch(base + `/v1/conversations/history?sessionId=${imageSession}`, {
        headers: { authorization: "Bearer " + grant.token }
      });
      expect(ownHistory.status).toBe(200);
      expect(await ownHistory.text()).not.toContain("SCENE_MARKER");

      const otherGrant = (await (
        await request("/host/v1/conversation-grants/issue", { personId: "ec-other" })
      ).json()) as any;
      const deniedImage = await fetch(
        base + `/observations/v1/${imageRecord.observation_id}?sessionId=${randomUUID()}`,
        { headers: { authorization: "Bearer " + otherGrant.token } }
      );
      expect(deniedImage.status).toBe(404);
      const otherExecution = await fetch(base + executionUrl, {
        headers: { authorization: "Bearer " + otherGrant.token }
      });
      // A session claimed by the first Person remains isolated even for metadata queries.
      expect([404, 409]).toContain(otherExecution.status);
      const invisibleExecution = await fetch(
        base + `/observations/v1/executions/${imageRecord.attempt_id}?sessionId=${randomUUID()}`,
        { headers: { authorization: "Bearer " + otherGrant.token } }
      );
      expect(invisibleExecution.status).toBe(404);
      const erasedImage = await fetch(base + detailUrl, {
        method: "DELETE",
        headers: { authorization: "Bearer " + grant.token }
      });
      expect(erasedImage.status).toBe(200);
      expect(
        await (
          await fetch(base + executionUrl, { headers: { authorization: "Bearer " + grant.token } })
        ).json()
      ).toMatchObject({
        execution: "APPLIED",
        hasAppliedReceipt: true,
        report: "DELETED",
        retentionAtCommit: { state: "STORED" }
      });
      reobserveRequested = false;
      const unavailableReobserve = calls.filter((c) => c.model === "fixture-vision").length;
      expect((await send("REOBSERVE_IMAGE", imageSession, false)).status).toBe(200);
      expect(calls.filter((c) => c.model === "fixture-vision")).toHaveLength(unavailableReobserve);
      const afterErase = calls.length;
      expect((await send("Image detail after erasure", imageSession, false)).status).toBe(200);
      expect(JSON.stringify(calls.slice(afterErase))).not.toContain("SCENE_MARKER");
      expect(
        (
          await pool.query(
            "select evidence,image_bytes from retained_observations where observation_id=$1",
            [imageRecord.observation_id]
          )
        ).rows[0]
      ).toMatchObject({ evidence: null, image_bytes: null });
      await stop();
      retentionSeconds = 10;
      await start(true);
      const filePath = join(root, "read-observation.txt");
      await writeFile(filePath, "TOOL_OBSERVATION_RANDOM_" + randomUUID());
      const fileSession = randomUUID();
      expect(
        (
          await request("/capabilities/read-text/authorize", {
            sessionId: fileSession,
            path: filePath,
            personId: "ec-person"
          })
        ).status
      ).toBe(200);
      expect((await send("READ_OBSERVATION_PROBE", fileSession)).status).toBe(200);
      const toolRecord = (
        await pool.query(
          "select observation_id,attempt_id from retained_observations where kind='READ_TEXT'"
        )
      ).rows[0];
      expect(toolRecord).toBeDefined();
      const beforeToolFollow = calls.length;
      expect((await send("What did we actually read?", randomUUID(), false)).status).toBe(200);
      const toolContext = JSON.stringify(calls.slice(beforeToolFollow));
      expect(toolContext).toContain("TOOL_OBSERVATION_RANDOM_");
      expect(toolContext).toContain("NOT_INFERRED");
      await delay(11000); // Actual configured TTL, not a fabricated expired database row.
      const afterExpiry = calls.length;
      expect((await send("What did we read after expiry?", fileSession, false)).status).toBe(200);
      expect(JSON.stringify(calls.slice(afterExpiry))).not.toContain("TOOL_OBSERVATION_RANDOM_");
      // Restart invokes the real expiry purge. Deletion of an already erased
      // tombstone is a successful postcondition, not a provenance rewrite.
      await stop();
      await start(true);
      let purged;
      for (let n = 0; n < 50; n++) {
        purged = (
          await pool.query(
            "select erased_at,erased_by_source from retained_observations where observation_id=$1",
            [toolRecord.observation_id]
          )
        ).rows[0];
        if (purged?.erased_at) break;
        await delay(20);
      }
      expect(purged.erased_at).not.toBeNull();
      const expiredDeleteUrl = `/observations/v1/${toolRecord.observation_id}?sessionId=${randomUUID()}`;
      for (let retry = 0; retry < 2; retry++) {
        const erasedExpired = await fetch(base + expiredDeleteUrl, {
          method: "DELETE",
          headers: { authorization: "Bearer " + grant.token }
        });
        expect(erasedExpired.status).toBe(200);
      }
      expect(
        (
          await pool.query(
            "select evidence,image_bytes from retained_observations where observation_id=$1",
            [toolRecord.observation_id]
          )
        ).rows[0]
      ).toMatchObject({ evidence: null, image_bytes: null });
      expect(
        (
          await pool.query(
            "select erased_at,erased_by_source from retained_observations where observation_id=$1",
            [toolRecord.observation_id]
          )
        ).rows[0]
      ).toEqual(purged);
      expect(
        (
          await pool.query(
            "select evidence from effect_observations where attempt_id=$1 and category='TERMINAL'",
            [toolRecord.attempt_id]
          )
        ).rows[0].evidence.certainty
      ).toBe("APPLIED");
      const toolCalls = async () =>
        (
          await pool.query(
            "select count(*)::int as n from effect_intents where contract_ref='yuvi.read-text.v1'"
          )
        ).rows[0].n;
      const priorToolCalls = await toolCalls();
      const deniedSession = randomUUID();
      await request("/capabilities/read-text/authorize", {
        sessionId: deniedSession,
        path: filePath,
        personId: "ec-other"
      });
      await send("READ_OBSERVATION_PROBE", deniedSession, false);
      expect(await toolCalls()).toBe(priorToolCalls);
      const revokedSession = randomUUID();
      await request("/capabilities/read-text/authorize", {
        sessionId: revokedSession,
        path: filePath,
        personId: "ec-person"
      });
      blocked = false;
      holdReasoning = true;
      const revokedRead = send("READ_OBSERVATION_PROBE", revokedSession, false);
      for (let i = 0; i < 150 && !blocked; i++) await delay(20);
      expect(blocked).toBe(true);
      expect(
        (await request("/capabilities/read-text/revoke", { sessionId: revokedSession })).status
      ).toBe(200);
      release?.();
      await revokedRead;
      expect(await toolCalls()).toBe(priorToolCalls);
      // Actual Provider/Dispatcher path: SQL failure is a retention failure,
      // never an invented failed external invocation or a retry of Vision.
      const imageBody = (content: string) => ({
        sessionId: randomUUID(),
        content,
        imageAttachment: {
          mimeType: "image/png",
          imageBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD9sAAAAASUVORK5CYII="
        }
      });
      const receiptFor = async (content: string) =>
        (
          await pool.query(
            `select o.evidence,a.attempt_id from effect_observations o join effect_attempts a using(attempt_id)
        join effect_intents i using(intent_id) join conversation_messages cm on cm.source_journal_ref=i.intent->'request'->'causalRefs'->0
        where cm.content=$1 and cm.role='user' and i.intent->'request'->'payload'->>'operation'='analyzeImage' and o.category='TERMINAL' order by o.observation_id desc limit 1`,
            [content]
          )
        ).rows[0];
      await pool.query(`create function fail_report_fixture() returns trigger language plpgsql as $$ begin raise exception 'synthetic SQL report failure'; end $$;
        create trigger fail_report_fixture before insert on retained_observations for each row execute function fail_report_fixture()`);
      const visionBeforeFailure = calls.filter((c) => c.model === "fixture-vision").length;
      expect((await request("/message", imageBody("REPORT_SQL_FAILURE"), grant.token)).status).toBe(
        200
      );
      const failedReport = await receiptFor("REPORT_SQL_FAILURE");
      expect(failedReport.evidence).toMatchObject({
        certainty: "APPLIED",
        reportRetention: { state: "FAILED" }
      });
      expect(calls.filter((c) => c.model === "fixture-vision")).toHaveLength(
        visionBeforeFailure + 1
      );
      expect(
        (
          await pool.query("select * from retained_observations where attempt_id=$1", [
            failedReport.attempt_id
          ])
        ).rows
      ).toHaveLength(0);
      expect(
        await (
          await fetch(
            base +
              `/observations/v1/executions/${failedReport.attempt_id}?sessionId=${randomUUID()}`,
            { headers: { authorization: "Bearer " + grant.token } }
          )
        ).json()
      ).toMatchObject({ execution: "APPLIED", report: "FAILED" });
      await pool.query(
        "drop trigger fail_report_fixture on retained_observations; drop function fail_report_fixture()"
      );
      // Revocation after Provider invocation does not falsify APPLIED, but
      // prevents the private response from entering retained storage or Context.
      const shortGrant = (await (
        await request("/host/v1/conversation-grants/issue", { personId: "ec-person" })
      ).json()) as any;
      blocked = false;
      holdVision = true;
      const revokedVision = request(
        "/message",
        imageBody("REPORT_SOURCE_REVOKED"),
        shortGrant.token
      ).catch(() => null);
      for (let i = 0; i < 150 && !blocked; i++) await delay(20);
      expect(blocked).toBe(true);
      expect(
        (await request("/host/v1/conversation-grants/revoke", { grantId: shortGrant.grantId }))
          .status
      ).toBe(200);
      release?.();
      await revokedVision;
      const withheldReport = await receiptFor("REPORT_SOURCE_REVOKED");
      expect(withheldReport.evidence).toMatchObject({
        certainty: "APPLIED",
        reportRetention: { state: "WITHHELD" }
      });
      expect(
        (
          await pool.query("select * from retained_observations where attempt_id=$1", [
            withheldReport.attempt_id
          ])
        ).rows
      ).toHaveLength(0);
      // TTL can elapse during the SQL COMMIT path. STORED means committed,
      // never a promise that content remains AVAILABLE at disclosure time.
      await stop();
      retentionSeconds = 1;
      await start(true);
      await pool.query(`create function delay_report_fixture() returns trigger language plpgsql as $$ begin perform pg_sleep(1.2); return new; end $$;
        create trigger delay_report_fixture before insert on retained_observations for each row execute function delay_report_fixture()`);
      await request("/message", imageBody("REPORT_TTL_AT_COMMIT"), grant.token);
      const expiredReport = await receiptFor("REPORT_TTL_AT_COMMIT");
      expect(expiredReport.evidence).toMatchObject({
        certainty: "APPLIED",
        reportRetention: { state: "STORED" }
      });
      expect(
        await (
          await fetch(
            base +
              `/observations/v1/executions/${expiredReport.attempt_id}?sessionId=${randomUUID()}`,
            { headers: { authorization: "Bearer " + grant.token } }
          )
        ).json()
      ).toMatchObject({ execution: "APPLIED", report: "EXPIRED" });
      const expiredDetail = (await (
        await fetch(
          base +
            `/observations/v1/${expiredReport.evidence.reportRetention.reportId}?sessionId=${randomUUID()}`,
          { headers: { authorization: "Bearer " + grant.token } }
        )
      ).json()) as any;
      expect(expiredDetail.availability).toBe("UNAVAILABLE");
      expect(expiredDetail.evidence).toBeUndefined();
      await pool.query(
        "drop trigger delay_report_fixture on retained_observations; drop function delay_report_fixture()"
      );
      await stop();
      retentionSeconds = 0;
      await start(true);
      await request("/message", imageBody("REPORT_RETENTION_OFF"), grant.token);
      expect((await receiptFor("REPORT_RETENTION_OFF")).evidence).toMatchObject({
        certainty: "APPLIED",
        reportRetention: { state: "NOT_REQUESTED", digest: null }
      });
      await stop();
      retentionSeconds = 10;
      await start(true);
      blocked = false;
      const raceText = "EC_FACT_NORMAL_REPLY WAIT_FOR_SUPERSEDE";
      const running = send(raceText, randomUUID(), false);
      for (let i = 0; i < 150 && !blocked; i++) await delay(20);
      expect(blocked).toBe(true);
      await send("EC_REPLACEMENT");
      expect((await waitFor("EC_REPLACEMENT")).status).toBe("complete");
      release?.();
      const racedReply = await running;
      expect(
        racedReply.status,
        JSON.stringify(racedReply) +
          " " +
          JSON.stringify(
            (
              await pool.query(
                "select evidence from effect_observations where category='TERMINAL' limit 12"
              )
            ).rows
          ) +
          "\n" +
          log
      ).toBe(200);
      const staleExposures = await pool.query(
        "select body from context_use_exposures where body->'snapshot'->>'freshness'='STALE'"
      );
      expect(staleExposures.rows.length).toBeGreaterThan(0);
      // The running Body sees exactly its captured A; a later new turn sees B.
      const frozenBody = calls.find((c) => c.stream && c.messages.at(-1)?.content === raceText);
      expect(JSON.stringify(frozenBody)).toContain("EC_FACT_NORMAL_REPLY");
      expect(JSON.stringify(frozenBody)).not.toContain('"content":"EC_REPLACEMENT"');
      blocked = false;
      const notesRun = send("WAIT_FOR_NOTES", randomUUID(), false);
      for (let i = 0; i < 150 && !blocked; i++) await delay(20);
      expect(blocked).toBe(true);
      const beforeNotes = readProductSettings({ YUVI_RUNTIME_ENV_DIR: root })!;
      const afterNotes = structuredClone(beforeNotes);
      afterNotes.people.find((p) => p.id === "ec-person")!.notes = "Ordinary updated knowledge";
      writeProductSettings(commitProductSettings(afterNotes, beforeNotes), {
        YUVI_RUNTIME_ENV_DIR: root
      });
      release?.();
      expect((await notesRun).status).toBe(200);
      blocked = false;
      const revokeText = "WAIT_FOR_REVOKE";
      const revoking = send(revokeText, randomUUID(), false).catch(() => ({ status: 0 }));
      for (let i = 0; i < 150 && !blocked; i++) await delay(20);
      expect(blocked).toBe(true);
      await request("/host/v1/conversation-grants/revoke", { grantId: grant.grantId });
      release?.();
      expect([0, 403, 503]).toContain((await revoking).status);
      expect(calls.some((c) => c.stream && c.messages.at(-1)?.content === revokeText)).toBe(false);
      // Denial may happen before Body admission: no fictional attempt is required.
      const appliedGate = await pool.query(
        `select o.evidence from effect_observations o join effect_attempts a using(attempt_id)
        join effect_intents i using(intent_id) join conversation_messages cm on cm.source_journal_ref=i.intent->'request'->'causalRefs'->0
        where cm.content=$1 and cm.role='user' and o.category='TERMINAL' and o.evidence->>'certainty'='APPLIED'`,
        [revokeText]
      );
      expect(appliedGate.rows.length).toBe(1);
      expect((await send("Revoked identity must fail")).status).toBe(401);
      verified = true;
    } finally {
      await stop();
      release?.();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      const evidenceDirectory =
        process.env["YUVI_PRODUCTION_PATH_EVIDENCE_DIRECTORY"] ??
        process.env["YUVI_CONFORMANCE_ARCHIVE_ROOT"];
      if (evidenceDirectory) {
        await mkdir(evidenceDirectory, { recursive: true });
        const evidence = {
          schema: "evidence-continuity-entry.v1",
          runtimeSha: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: runtimeCheckout,
            encoding: "utf8"
          }).trim(),
          runtimeDirty: Boolean(
            execFileSync("git", ["status", "--porcelain"], {
              cwd: runtimeCheckout,
              encoding: "utf8"
            }).trim()
          ),
          verified,
          kind: "deterministic-provider-real-server-postgresql",
          preRuntimeCrash: {
            journalSources: (
              await pool.query(
                "select count(*)::int as n from journal_payloads where text_content like 'EC_FACT_crash EC_BEFORE_RUNTIME%'"
              )
            ).rows[0].n,
            acceptedSources: (
              await pool.query(
                "select count(*)::int as n from conversation_messages where content like 'EC_FACT_crash EC_BEFORE_RUNTIME%' and role='user'"
              )
            ).rows[0].n
          },
          calls: calls.map((call) => ({
            model: call.model,
            stream: call.stream ?? false,
            digest: createHash("sha256").update(JSON.stringify(call.messages)).digest("hex"),
            messages: call.messages.map((m: { role: string; content: unknown }) => ({
              role: m.role,
              bytes: Buffer.byteLength(JSON.stringify(m.content))
            })),
            hasScene: JSON.stringify(call.messages).includes("SCENE_MARKER"),
            hasToolObservation: JSON.stringify(call.messages).includes("TOOL_OBSERVATION_RANDOM_"),
            hasSnapshotNotice: JSON.stringify(call.messages).includes("Context snapshot notice")
          })),
          sources: (
            await pool.query(`select cm.content,cm.ingestion_requested,cm.ingestion_skip_reason,
            f.status,f.last_error_code, f.assistant_message_id is null as user_only
            from conversation_messages cm left join finalized_ingestion_turns f using(finalized_turn_id)
            where cm.role='user' order by cm.sequence limit 128`)
          ).rows,
          observations: (
            await pool.query(`select kind,erased_at is not null as erased,
            evidence is not null as has_payload,image_bytes is not null as has_image from retained_observations`)
          ).rows,
          reportCommitStates: (
            await pool.query(
              `select evidence->'reportRetention'->>'state' as state,count(*)::int from effect_observations where category='TERMINAL' and evidence ? 'reportRetention' group by 1`
            )
          ).rows,
          executionReportContract: "same-postgresql-terminal-transaction-v1",
          effects: (
            await pool.query(`select evidence->>'certainty' as certainty,evidence->>'reason' as reason,
            count(*)::int from effect_observations where category='TERMINAL' group by 1,2`)
          ).rows,
          exposures: (
            await pool.query(`select body->'snapshot' as snapshot,count(*)::int
            from context_use_exposures group by 1`)
          ).rows
        };
        await writeFile(
          join(evidenceDirectory, "evidence-continuity-entry.json"),
          JSON.stringify(evidence, null, 2)
        );
      }
      await pool.end();
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
