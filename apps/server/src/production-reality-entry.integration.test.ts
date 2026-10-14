import { createServer } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresPool } from "@companion/database";
import { describe, expect, it } from "vitest";
import { applySqlMigrations, readSqlMigrations } from "@companion/memory";
import { chatCompletionFixture } from "./test-support/chat-completion.js";
import { SERVER_MCP_READ_TEXT_CAPABILITY_REF } from "./mcp-capability-binding.js";

const url = process.env["YUVI_PRODUCTION_PATH_TEST_DATABASE_URL"];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs the actual startup module and durable Host/Journal/Effects composition.
 * The loopback HTTP model is a dependency fixture, not a model quality verdict.
 */
describe.skipIf(!url)("normal Server entrypoint production reality", () => {
  it.each([false, true])(
    "keeps real Character evidence and scoped capability control (independent composition=%s)",
    async (independent) => {
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
        throw new Error("Production path fixture requires its explicitly isolated database.");
      const schema = `pr_entry_${randomUUID().replaceAll("-", "")}`;
      const root = await mkdtemp(join(tmpdir(), "yuvi-production-entry-"));
      const envRoot = independent ? join(root, "character-env") : root;
      const characterConfigPath = join(root, "independent-character.json");
      const admin = createPostgresPool(url!);
      const connection = new URL(url!);
      connection.searchParams.set("options", `-c search_path=${schema},public`);
      const pool = createPostgresPool(connection.toString());
      const received: Array<{
        stream: boolean;
        current: string;
        messages: Array<{ role: string; content: string }>;
      }> = [];
      const marker = `PR_FIRST_${randomUUID()}`;
      const accepted = `PR_ACCEPTED_${randomUUID()}`;
      const fileMarker = `PR_TOOL_${randomUUID()}`;
      const filePath = join(root, "authorized-evidence.txt");
      const gateway = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const current = body.messages.at(-1)?.content ?? "";
        received.push({ stream: body.stream === true, current, messages: body.messages });
        if (body.model === "fixture-reasoning") {
          const answer = JSON.stringify(body.messages).includes(fileMarker)
            ? "CONTINUE"
            : `REQUEST_CAPABILITY\n${JSON.stringify({ capabilityRef: SERVER_MCP_READ_TEXT_CAPABILITY_REF, request: "Read the controller-authorized evidence." })}`;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              model: body.model,
              choices: [{ message: { content: answer }, finish_reason: "stop" }]
            })
          );
          return;
        }
        if (
          !body.stream &&
          current.includes("READ_PARTIAL_PROBE") &&
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
                      focus: "Inspect the authorized file."
                    })
                  },
                  finish_reason: "stop"
                }
              ]
            })
          );
          return;
        }
        if (body.stream && current.includes("FAIL_THIS_BODY")) {
          response.writeHead(429, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "synthetic body rejection" } }));
          return;
        }
        const output = chatCompletionFixture(body, {
          content: `Normal fixture answer. ${"bounded context detail ".repeat(35)}`,
          model: "fixture-chat"
        });
        response.writeHead(output.status, { "content-type": output.headers.get("content-type")! });
        response.end(await output.text());
      });
      let child: ChildProcess | undefined;
      let log = "";
      try {
        await admin.query(`create schema "${schema}"`);
        await applySqlMigrations(pool, await readSqlMigrations());
        if (independent)
          await writeFile(
            characterConfigPath,
            JSON.stringify({
              version: 1,
              instanceId: `independent-${schema}`,
              envDirectory: envRoot,
              dataDirectory: join(root, "character-data"),
              definition: {
                id: `independent-${schema}`,
                revision: "fixture-v1",
                name: "Isolated Fixture Alice",
                persona:
                  "Use evidence, uncertainty and authorized tools. This is an isolated synthetic character."
              }
            }),
            { mode: 0o600 }
          );
        await writeFile(filePath, `Confirmed tool observation marker: ${fileMarker}`, {
          mode: 0o600
        });
        await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
        const gatewayPort = (gateway.address() as { port: number }).port;
        const reservation = createServer();
        await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
        const port = (reservation.address() as { port: number }).port;
        await new Promise<void>((resolve) => reservation.close(() => resolve()));
        const base = `http://127.0.0.1:${port}`;
        const start = async (mode: string, mocks: string) => {
          child = spawn(
            process.execPath,
            ["--conditions=development", "--import", "tsx", "apps/server/src/index.ts"],
            {
              cwd: new URL("../../../", import.meta.url),
              env: {
                PATH: process.env["PATH"],
                NODE_ENV: mode,
                RUNTIME_MODE: "development",
                PROVIDER_ALLOW_MOCKS: mocks,
                YUVI_RUNTIME_ENV_DIR: envRoot,
                YUVI_CHARACTER_CONFIG_PATH: independent ? characterConfigPath : undefined,
                YUVI_RUNTIME_DATA_DIR: join(root, "data"),
                YUVI_CONFIG_ROOT: envRoot,
                YUVI_DATA_ROOT: join(root, "data"),
                YUVI_CACHE_ROOT: join(root, "cache"),
                SERVER_HOST: "127.0.0.1",
                SERVER_PORT: String(port),
                LOG_LEVEL: "error",
                DATABASE_URL: connection.toString(),
                MEMORY_BACKEND: "postgres",
                MEMORY_REPOSITORY: "postgres",
                CONVERSATION_REPOSITORY: "postgres",
                YUVI_JOURNAL_NAMESPACE: `production-fixture:${schema}`,
                DEFAULT_CHAT_PROVIDER: "openai-compatible",
                CHAT_PROVIDER_CHAIN: "openai-compatible",
                DEFAULT_REASONING_PROVIDER: "openai-compatible",
                REASONING_PROVIDER_CHAIN: "openai-compatible",
                OPENAI_COMPATIBLE_API_BASEURL: `http://127.0.0.1:${gatewayPort}/v1`,
                OPENAI_COMPATIBLE_API_KEY: "synthetic-fixture-key",
                OPENAI_COMPATIBLE_CHAT_MODEL: "fixture-chat",
                OPENAI_COMPATIBLE_REASONING_MODEL: "fixture-reasoning",
                COGNITION_MAX_REASONING_ROUNDS: "2",
                OPENAI_COMPATIBLE_CHAT_CONTEXT_WINDOW: "65536",
                MEMORY_EXTRACTOR: "llm",
                MEMORY_MAINTENANCE_ENABLED: "false",
                MEMORY_INGESTION_COORDINATOR_ENABLED: "false",
                MEMORY_VECTOR_INDEX_ENABLED: "false",
                YUVI_AUTO_MIGRATE: "0",
                DASHBOARD_DEV_TOKEN: "synthetic-operator-token"
              },
              stdio: ["ignore", "pipe", "pipe"]
            }
          );
          child.stdout?.on("data", (data) => {
            log = (log + data.toString()).slice(-10000);
          });
          child.stderr?.on("data", (data) => {
            log = (log + data.toString()).slice(-10000);
          });
          for (let attempt = 0; attempt < 200; attempt++) {
            if (child.exitCode !== null) throw new Error(`Isolated Server startup failed: ${log}`);
            try {
              if ((await fetch(`${base}/health`)).ok) return;
            } catch {
              /* startup only */
            }
            await delay(50);
          }
          throw new Error(`Isolated Server startup timed out: ${log}`);
        };
        const stop = async () => {
          if (!child || child.exitCode !== null) return;
          const done = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
          child.kill("SIGTERM");
          await Promise.race([done, delay(10000)]);
          if (child.exitCode === null) {
            child.kill("SIGKILL");
            await done;
          }
        };
        const send = async (text: string, sessionId = "long-dialogue") => {
          const response = await fetch(`${base}/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              text,
              options: { readMemory: false, writeMemory: false, voiceOutput: false }
            })
          });
          return { status: response.status, body: await response.json() };
        };
        await start("test", " TRUE ");
        for (let turn = 1; turn <= 30; turn++) {
          const text =
            turn === 1
              ? `Our project evidence marker is ${marker}.`
              : turn === 30
                ? "Recall the project marker from our first turn."
                : `Continue discussion turn ${turn}; ${"ordinary bounded context ".repeat(20)}`;
          const before = received.length;
          const reply = await send(text);
          expect(
            reply.status,
            `turn=${turn} calls=${received.length - before} response=${JSON.stringify(reply.body)}\n${log}`
          ).toBe(200);
          expect(received.slice(before).map((call) => call.stream)).toEqual([false, true]);
        }
        const thirtieth = received.slice(-2);
        for (const call of thirtieth) {
          expect(
            JSON.stringify(call.messages).includes(marker),
            "Actual model input must contain the first accepted fact, without pre-seeding its answer."
          ).toBe(true);
          expect(call.messages[0]!.content).toContain("character-abi-2d");
          expect(call.current).toBe("Recall the project marker from our first turn.");
        }
        const manifests = await pool.query("select count(*)::int count from context_use_manifests");
        expect(manifests.rows[0].count).toBeGreaterThanOrEqual(30);
        await writeFile(join(envRoot, "p8-corrections.json"), '{"truncated":');
        expect((await send("Continue with your authored identity.", "p8-fault")).status).toBe(200);
        expect(received.at(-2)!.messages[0]!.content).toContain("character.name");
        expect(received.at(-2)!.messages[0]!.content).toContain("reconstruction is ERROR");
        expect(
          (await send(`An accepted fact is ${accepted}. FAIL_THIS_BODY`, "failed-turn")).status
        ).toBe(503);
        await stop();
        await start("development", "false");
        expect(
          (await send("What did I tell you before the failed response?", "failed-turn")).status
        ).toBe(200);
        expect(JSON.stringify(received.at(-2)!.messages)).toContain(accepted);
        expect(JSON.stringify(received.at(-1)!.messages)).toContain(accepted);
        const users = await pool.query(
          "select source_journal_ref,status from conversation_messages where role='user' and content like $1",
          [`%${accepted}%`]
        );
        expect(users.rows).toHaveLength(1);
        expect(users.rows[0].status).toBe("completed");
        expect(users.rows[0].source_journal_ref).not.toBeNull();
        const denied = await fetch(`${base}/capabilities/read-text/authorize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "partial-read", path: filePath })
        });
        expect([401, 403]).toContain(denied.status);
        const authorization = await fetch(`${base}/capabilities/read-text/authorize`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer synthetic-operator-token"
          },
          body: JSON.stringify({ sessionId: "partial-read", path: filePath })
        });
        expect(authorization.status).toBe(200);
        const beforeRead = received.length;
        expect(
          (await send("READ_PARTIAL_PROBE: inspect authorized evidence.", "partial-read")).status
        ).toBe(200);
        const readCalls = received.slice(beforeRead);
        expect(JSON.stringify(readCalls[0]!.messages)).not.toContain(fileMarker);
        expect(readCalls).toHaveLength(5); // gate, reason, reason, post gate, body
        expect(JSON.stringify(readCalls.at(-1)!.messages)).toContain(fileMarker);
        expect(readCalls.at(-1)!.messages[0]!.content).toContain('"status":"PARTIAL"');
        expect(readCalls.at(-1)!.messages[0]!.content).toContain("REASONING_BUDGET_EXHAUSTED");
        expect(
          (
            await pool.query(
              "select count(*)::int count from effect_intents where contract_ref='yuvi.read-text.v1'"
            )
          ).rows[0].count
        ).toBe(1);
        const evidenceDirectory =
          process.env["YUVI_PRODUCTION_PATH_EVIDENCE_DIRECTORY"] ??
          process.env["YUVI_CONFORMANCE_ARCHIVE_ROOT"];
        if (evidenceDirectory) {
          await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
          const snapshot = {
            schema: "production-path-inputs.v1",
            verificationKind: "DETERMINISTIC_PRODUCTION_PATH_NOT_MODEL_QUALITY",
            gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: new URL("../../../", import.meta.url),
              encoding: "utf8"
            }).trim(),
            dirty: Boolean(
              execFileSync("git", ["status", "--porcelain"], {
                cwd: new URL("../../../", import.meta.url),
                encoding: "utf8"
              }).trim()
            ),
            entrypoint: "apps/server/src/index.ts",
            independentCharacter: independent,
            model: "fixture-chat",
            declaredContextWindow: 65536,
            startupVariants: [
              { nodeEnv: "test", allowMocks: " TRUE " },
              { nodeEnv: "development", allowMocks: "false" }
            ],
            turns: 30,
            firstSourceReachedThirtiethGateAndBody: true,
            corruptP8: { status: "ERROR", authoredIdentityRetained: true },
            acceptedFailedSourceRecoveredAfterRestart: true,
            partialRead: {
              modelCalls: 5,
              effectIntents: 1,
              observationReachedBody: true,
              goalStatus: "PARTIAL",
              terminal: "REASONING_BUDGET_EXHAUSTED"
            },
            calls: received.map((call, ordinal) => ({
              ordinal,
              stream: call.stream,
              inputDigest: createHash("sha256").update(JSON.stringify(call.messages)).digest("hex"),
              fields: call.messages.map((message, index) => ({
                index,
                role: message.role,
                characters: message.content.length,
                utf8Bytes: Buffer.byteLength(message.content),
                digest: createHash("sha256").update(message.content).digest("hex")
              })),
              firstSourcePresent: JSON.stringify(call.messages).includes(marker),
              acceptedFailedSourcePresent: JSON.stringify(call.messages).includes(accepted),
              toolObservationPresent: JSON.stringify(call.messages).includes(fileMarker)
            }))
          };
          await writeFile(
            join(
              evidenceDirectory,
              independent ? "entry-independent-input-summary.json" : "entry-input-summary.json"
            ),
            JSON.stringify(snapshot, null, 2),
            { mode: 0o600 }
          );
        }
        // Safe synthetic input summary. No credentials or private source bodies.
        expect(createHash("sha256").update(JSON.stringify(thirtieth)).digest("hex")).toMatch(
          /^[a-f0-9]{64}$/u
        );
        await stop();
      } catch (failure) {
        const evidenceDirectory =
          process.env["YUVI_PRODUCTION_PATH_EVIDENCE_DIRECTORY"] ??
          process.env["YUVI_CONFORMANCE_ARCHIVE_ROOT"];
        if (evidenceDirectory) {
          await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
          let effects: unknown = { status: "UNAVAILABLE" };
          try {
            effects = (
              await pool.query(`select i.intent_id,i.contract_ref,i.work_state,i.created_at,
              a.attempt_id,a.dispatch_started_at,a.lease_expires_at,a.lease_owner,o.evidence
              from effect_intents i left join effect_attempts a using(intent_id)
              left join effect_observations o on o.attempt_id=a.attempt_id and o.category='TERMINAL'
              order by i.created_at desc limit 40`)
            ).rows;
          } catch {
            /* Diagnostic failure must not mask the original failure. */
          }
          await writeFile(
            join(
              evidenceDirectory,
              independent ? "entry-independent-failure.json" : "entry-failure.json"
            ),
            JSON.stringify(
              {
                schema: "production-path-failure.v1",
                independentCharacter: independent,
                modelCalls: received.length,
                effects,
                error: failure instanceof Error ? failure.message : "UNKNOWN",
                inputDigests: received.map((call) =>
                  createHash("sha256").update(JSON.stringify(call.messages)).digest("hex")
                )
              },
              null,
              2
            ),
            { mode: 0o600 }
          );
        }
        throw failure;
      } finally {
        if (child && child.exitCode === null) {
          const done = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
          child.kill("SIGKILL");
          await done;
        }
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        await pool.end();
        await admin.query(`drop schema if exists "${schema}" cascade`);
        await admin.end();
        await rm(root, { recursive: true, force: true });
      }
    },
    120000
  );
});
