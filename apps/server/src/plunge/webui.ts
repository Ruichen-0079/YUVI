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

export type PlungeWebUI = { directory: string; management: PlungeManagement; token: string };
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
