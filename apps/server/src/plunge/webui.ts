import {
  createFileP8CorrectionStore,
  characterP8Address,
  characterPersonaId
} from "@companion/core";
import { createP8CorrectionRecord } from "@companion/p8";
import { buildMemoryScope } from "@companion/memory";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { PlungeManagement } from "./qq-composition.js";
import { isLocalAddress } from "../routes/security.js";
import type { ServerConfig } from "../config.js";
import { registerProductRoutes } from "../routes/product.js";
import { registerP8CorrectionRoutes } from "../routes/local-services.js";
import { redactValue } from "../services/dashboard.js";
import type { PlungeDesktopApps } from "./desktop-apps.js";

export type PlungeWebUI = {
  directory: string;
  management: PlungeManagement;
  token: string;
  desktop?: PlungeDesktopApps;
};
/** Applies to the independent Alice server only. Protects legacy read routes too. */
export function protectPlunge(app: FastifyInstance, token: string) {
  if (token.length < 32)
    throw Error("Plunge management requires a private token of at least 32 characters.");
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    const path = request.url.split("?")[0]!;
    const hostname = request.hostname;
    if (!isLocalAddress(request.ip) || !["localhost", "127.0.0.1", "[::1]"].includes(hostname))
      return reply.code(403).send({ error: "LOCAL_ACCESS_REQUIRED" });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`)
      return reply.code(403).send({ error: "SAME_ORIGIN_REQUIRED" });
    if (["/plunge", "/plunge/", "/plunge/app.js", "/plunge/style.css"].includes(path)) return;
    const provided = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (
      Buffer.byteLength(provided) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
    )
      return reply.code(401).send({ error: "MANAGEMENT_TOKEN_REQUIRED" });
    // No legacy direct Memory-table mutations are available in this management host.
    if (request.method !== "GET" && path.startsWith("/memory/") && path !== "/memory/search")
      return reply.code(403).send({ error: "USE_GOVERNED_P8_CORRECTION" });
    if (request.method !== "GET" && path === "/memory")
      return reply.code(403).send({ error: "USE_GOVERNED_P8_CORRECTION" });
  });
}
export async function registerPlungeWebUI(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig,
  options: PlungeWebUI
) {
  for (const [url, file, contentType] of [
    ["/plunge", "index.html", "text/html; charset=utf-8"],
    ["/plunge/", "index.html", "text/html; charset=utf-8"],
    ["/plunge/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/plunge/style.css", "style.css", "text/css; charset=utf-8"]
  ]) {
    app.get(url!, async (_req, reply) => {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
      );
      return reply.type(contentType!).send(await readFile(join(options.directory, file!)));
    });
  }
  await registerProductRoutes(app, context, config, {
    env: context.activeRuntimeEnv,
    configurationOnly: true,
    applyAtBoundary: options.management.atBoundary
  });
  await registerP8CorrectionRoutes(app, context, config);
  app.get(
    "/plunge/api/apps",
    async () =>
      options.desktop?.snapshot() ?? {
        qq: { configured: false },
        snowluma: { configured: false, url: null }
      }
  );
  app.post("/plunge/api/apps/:app/open", async (req, reply) => {
    const appName = (req.params as { app: string }).app;
    if (appName !== "qq" && appName !== "snowluma")
      return reply.code(404).send({ error: "UNKNOWN_APPLICATION" });
    if (!options.desktop) return reply.code(409).send({ error: "DESKTOP_LAUNCHER_REQUIRED" });
    try {
      return await options.desktop.open(appName);
    } catch (error) {
      const code = error instanceof Error ? error.message : "APPLICATION_OPEN_FAILED";
      const messages: Record<string, string> = {
        QQ_PATH_REQUIRED: "没有可用的 QQ 启动路径。请用启动脚本的 --qq 参数指定。",
        SNOWLUMA_DIRECTORY_REQUIRED: "没有可用的 SnowLuma 目录。请用 --snowluma 参数指定。",
        SNOWLUMA_RUNNING_UI_UNAVAILABLE: "SnowLuma 已在运行，但控制台暂不可访问；未启动重复进程。",
        SNOWLUMA_START_FAILED_CHECK_LOG: "SnowLuma 启动失败，请检查 state/snowluma.log。",
        SNOWLUMA_STARTING_CHECK_LOG:
          "SnowLuma 已启动，控制台尚未就绪；请稍后刷新或检查 state/snowluma.log。",
        APPLICATION_START_FAILED_CHECK_LOG: "本机应用启动失败，请检查 state 中对应应用日志。"
      };
      return reply.code(409).send({ error: code, message: messages[code] ?? "无法打开本机应用。" });
    }
  });
  app.get("/plunge/api/status", async () => ({
    character: context.runtime.characterBinding,
    providers: redactValue(context.providers.getStatus()),
    plunge: options.management.snapshot(),
    memoryRepository: context.activeMemoryRepository,
    memoryIngestion: await context.memoryIngestionCoordinator.getDiagnostics(),
    runtime: context.runtime.getProactiveState(),
    events: context.dashboard.listRecentEvents(100)
  }));
  app.post("/plunge/api/reconnect", async () => options.management.reconnect());
  app.get("/plunge/api/participation", async () => options.management.snapshot());
  app.put("/plunge/api/participation", async (req, reply) => {
    const parsed = z
      .object({
        revision: z.string(),
        groups: z.array(z.string()),
        privatePeers: z.array(z.string()),
        participation: z.record(z.unknown())
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PARTICIPATION" });
    try {
      return options.management.save(parsed.data);
    } catch (error) {
      return reply
        .code(error instanceof Error && error.message === "CONFIGURATION_CONFLICT" ? 409 : 400)
        .send({ error: "INVALID_OR_CONFLICTING_CONFIGURATION" });
    }
  });
  app.get("/plunge/api/prompts", async () => ({ requests: context.plungeInspector?.list() ?? [] }));
  app.get("/plunge/api/prompts/:id", async (req, reply) => {
    const result = context.plungeInspector?.get((req.params as { id: string }).id);
    return result ?? reply.code(404).send({ error: "REQUEST_EXPIRED" });
  });
  app.get("/plunge/api/memory/corrections", async (req, reply) => {
    const personId = (req.query as { personId?: string }).personId;
    const people = options.management.snapshot().people;
    if (!personId || !people.some((p) => p.id === personId))
      return reply.code(403).send({ error: "GRANTED_PERSON_REQUIRED" });
    const lookup = {
      address: characterP8Address(context.runtime.characterBinding, personId),
      scopeReference: {
        reference: buildMemoryScope(personId, characterPersonaId(context.runtime.characterBinding))
      }
    };
    const loaded = await createFileP8CorrectionStore(
      join(context.activeRuntimeEnv["YUVI_RUNTIME_ENV_DIR"]!, "p8-corrections.json")
    ).loadCorrections(lookup);
    const reference = "plunge:correction:" + randomUUID();
    return {
      loaded,
      template: createP8CorrectionRecord({
        ...lookup,
        correctionReference: reference,
        target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
        action: "REVISE",
        replacementMeaning: "请输入明确纠正后的关系含义",
        provenance: {
          source: "EXPLICIT_USER_CORRECTION",
          reference,
          suppliedAt: new Date().toISOString()
        }
      })
    };
  });
  app.get("/plunge/api/memory/dream/:id", async (req, reply) => {
    const job = await context.dreamJobStore.getById((req.params as { id: string }).id);
    return job ?? reply.code(404).send({ error: "DREAM_JOB_NOT_FOUND" });
  });
  app.get("/plunge/api/memory/pipeline", async () => ({
    diagnostics: await context.memoryIngestionCoordinator.getDiagnostics(),
    pendingFinalized: await context.finalizedIngestionRepository.listNonTerminalTurns(30),
    dueDream: await context.dreamJobStore.listDue(new Date(), 30)
  }));
}
