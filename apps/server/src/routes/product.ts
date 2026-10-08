import { hasPackagedVoice, applyPackagedSpeechRoute } from "../services/packaged-voice.js";
import { projectProductProfileEvidence } from "../services/profile-evidence.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { JournalEventRef } from "@companion/protocol";
import {
  CAPABILITY_ROUTES,
  parseProductConfiguration,
  modelEndpoint,
  createProviderRegistryFromEnv
} from "@companion/providers";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { hasLocalDashboardAccess, requireLocalDashboardAccess } from "./security.js";
import {
  commitProductSettings,
  importLegacyConfiguration,
  embeddingSignature,
  productEnvironment,
  readProductSettings,
  withProductSettingsOwner,
  writeProductSettings,
  type ProductSettings
} from "../services/product-store.js";
import { toProductControlAdmissionFailure } from "../product-control-receipt-admission.js";

const ProactiveSettingsSchema = z
  .object({
    threshold: z.number().min(0).max(1),
    intervalMs: z.number().int().min(1000).max(86_400_000)
  })
  .strict();

const ProductConfigurationRequestSchema = z
  .object({
    configuration: z.record(z.unknown()),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    proactive: ProactiveSettingsSchema.optional()
  })
  .strict();

export async function registerProductRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig,
  options: {
    env?: Record<string, string | undefined>;
    configurationOnly?: boolean;
    applyAtBoundary?: <T>(operation: () => Promise<T>) => Promise<T>;
  } = {}
) {
  const env = options.env ?? process.env;
  const readSettings = () => readProductSettings(env);
  let queue = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.then(
      () => {},
      () => {}
    );
    return next;
  };
  let applyFailure = false;
  const desired = () => {
    const saved = readSettings();
    if (saved) return saved;
    const imported = importLegacyConfiguration(context.activeRuntimeEnv);
    const active = context.activeRuntimeEnv["YUVI_PRODUCT_CONFIGURATION"];
    if (options.configurationOnly && active)
      imported.configuration = parseProductConfiguration(JSON.parse(active));
    return imported;
  };
  function snapshot() {
    const saved = desired();
    const {
      productCommandReceipts: _receipts,
      productCommandFences: _fences,
      ...visibleSaved
    } = saved;
    const activeJson = context.activeRuntimeEnv["YUVI_PRODUCT_CONFIGURATION"];
    const active = activeJson
      ? parseProductConfiguration(JSON.parse(activeJson))
      : importLegacyConfiguration(context.activeRuntimeEnv).configuration;
    const pending = JSON.stringify(saved.configuration) !== activeJson && saved.revision > 0;
    const status = context.providers.getStatus();
    const routes = Object.fromEntries(
      CAPABILITY_ROUTES.map((cap) => {
        const ids = active?.routes[cap] ?? [];
        const entries =
          cap === "proactive"
            ? ids.map((id) => ({
                provider: id,
                configured: true,
                observed: context.providers.getProactiveRouteObservations()[id] ?? "unknown"
              }))
            : (status.routes?.[cap] ?? []);
        const available = entries.findIndex(
          (e) => e.configured && e.observed !== "unavailable" && e.observed !== "degraded"
        );
        const state = pending
          ? applyFailure
            ? "APPLY_FAILED"
            : "RESTART_REQUIRED"
          : !ids.length
            ? "NOT_CONFIGURED"
            : available < 0
              ? "UNAVAILABLE"
              : available > 0
                ? "FALLBACK_ACTIVE"
                : "ACTIVE";
        return [
          cap,
          {
            state,
            modelIds: ids,
            observed: entries.map((e) => ({ modelId: e.provider, observed: e.observed }))
          }
        ];
      })
    );
    return {
      ...(options.configurationOnly
        ? { revision: saved.revision, proactive: saved.proactive }
        : visibleSaved),
      configuration: {
        ...saved.configuration,
        providers: saved.configuration.providers.map(({ apiKey, ...p }) => ({
          ...p,
          hasApiKey: Boolean(apiKey)
        }))
      },
      routes,
      conversationalReady: Boolean(
        status.routes?.chat?.some((e) => e.configured && e.observed !== "unavailable")
      ),
      adopted: Boolean(active),
      proactiveState: context.runtime.getProactiveState(),
      voiceAvailable:
        hasPackagedVoice() || Boolean(context.providers.getSTTProvider().voiceProfiles),
      applyState: applyFailure ? "APPLY_FAILED" : pending ? "RESTART_REQUIRED" : "ACTIVE"
    };
  }
  async function applyRuntime(committed: ProductSettings) {
    const previous = context.activeRuntimeEnv["YUVI_PRODUCT_CONFIGURATION"];
    const current = previous
      ? parseProductConfiguration(JSON.parse(previous))
      : importLegacyConfiguration(context.activeRuntimeEnv).configuration;
    // Embedding providers are captured by Memory stores; changing their space needs the existing restart path.
    if (embeddingSignature(current) !== embeddingSignature(committed.configuration))
      return snapshot();
    try {
      const env = productEnvironment(context.activeRuntimeEnv, committed);
      if (options.applyAtBoundary)
        await options.applyAtBoundary(() => context.reloadRuntimeConfig(env, committed));
      else await context.reloadRuntimeConfig(env, committed);
      await applyPackagedSpeechRoute(context);
      if (!options.configurationOnly)
        for (const key of [
          "YUVI_PRODUCT_CONFIGURATION",
          "MEMORY_SUBJECT_USER_ID",
          "MEMORY_PERSONA_ID",
          "PROACTIVE_SCORE_THRESHOLD",
          "PROACTIVE_EVALUATION_INTERVAL_MS"
        ]) {
          if (env[key] === undefined) delete process.env[key];
          else process.env[key] = env[key];
        }
      applyFailure = false;
    } catch {
      applyFailure = true;
    }
    return snapshot();
  }
  async function persistApply(saved: ProductSettings) {
    const committed = await withProductSettingsOwner(() => {
      const latest = readSettings();
      const rebased: ProductSettings = latest
        ? { ...saved, people: latest.people, primaryPersonId: latest.primaryPersonId }
        : saved;
      const next = commitProductSettings(rebased, latest);
      writeProductSettings(next, env);
      return next;
    });
    return applyRuntime(committed);
  }
  async function admitControl(
    input: Parameters<AppContext["productControlReceiptAdmission"]["admit"]>[0],
    reply: FastifyReply
  ): Promise<JournalEventRef | null> {
    try {
      return await context.productControlReceiptAdmission.admit(input);
    } catch (error) {
      const failure = toProductControlAdmissionFailure(error);
      reply.code(failure.statusCode).send({ error: failure.code, message: failure.message });
      return null;
    }
  }
  app.get("/product/configuration", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    return snapshot();
  });
  app.put("/product/configuration", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    return locked(async () => {
      const parsedBody = ProductConfigurationRequestSchema.safeParse(req.body);
      if (!parsedBody.success)
        return reply.code(400).send({ error: "Invalid configuration request." });
      const saved = desired();
      const body = parsedBody.data;
      if (body.revision !== saved.revision)
        return reply.code(409).send({ error: "Settings changed. Reload before saving." });
      const candidate = structuredClone(saved);
      try {
        const input = structuredClone(body.configuration) as ProductSettings["configuration"];
        // Omitted secret retains it; explicit empty string clears it.
        for (const p of input.providers)
          if (p.apiKey === undefined) {
            const key = saved.configuration.providers.find((old) => old.id === p.id)?.apiKey;
            if (key !== undefined) p.apiKey = key;
          }
        candidate.configuration = parseProductConfiguration(input);
        if (body.proactive !== undefined) candidate.proactive = body.proactive;
        createProviderRegistryFromEnv(productEnvironment(context.activeRuntimeEnv, candidate));
      } catch {
        return reply
          .code(400)
          .send({ error: "Invalid configuration or incompatible route assignment." });
      }
      if (
        !(await admitControl(
          { operation: "CONFIGURATION_SAVE", expectedRevision: saved.revision },
          reply
        ))
      )
        return;
      return persistApply(candidate);
    });
  });
  app.post("/product/providers/:id/test", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const p = desired().configuration.providers.find(
      (p) => p.id === (req.params as { id: string }).id
    );
    if (!p) return reply.code(404).send({ error: "Provider not found." });
    try {
      const specialized = p.adapter !== "openai-compatible";
      const response = await fetch(
        specialized
          ? `${p.baseUrl.replace(/\/$/, "")}/health`
          : `${modelEndpoint(p.baseUrl)}/models`,
        {
          headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
          redirect: "error",
          signal: AbortSignal.timeout(8000)
        }
      );
      if (!response.ok)
        return {
          ok: false,
          discoveryAvailable: false,
          message: `HTTP ${response.status}. You can add a model ID manually.`
        };
      const text = await response.text();
      if (text.length > 1_000_000) throw new Error();
      const data = JSON.parse(text) as { data?: Array<{ id?: unknown; context_window?: unknown }> };
      return {
        ok: true,
        discoveryAvailable: Array.isArray(data.data),
        models: (data.data ?? [])
          .slice(0, 500)
          .filter((m) => typeof m.id === "string")
          .map((m) => ({
            modelId: m.id,
            contextWindow:
              Number.isSafeInteger(m.context_window) && Number(m.context_window) >= 1024
                ? m.context_window
                : null
          })),
        message: "Endpoint responded. Model calls are verified separately."
      };
    } catch {
      return {
        ok: false,
        discoveryAvailable: false,
        message: "Connection unavailable. Check the endpoint or add a model ID manually."
      };
    }
  });
  if (options.configurationOnly) return;
  app.post("/product/people", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const body = z
      .object({
        displayName: z.string().trim().min(1).max(100),
        personaId: z.string().trim().min(1).max(100).optional(),
        notes: z.string().max(4000).default(""),
        primary: z.boolean().default(false),
        id: z.string().optional(),
        commandHandle: z.string().trim().min(1).max(256),
        expectedPersonRevision: z.string().nullable(),
        expectedPrimaryRevision: z.string().nullable()
      })
      .strict()
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter a name." });
    return locked(async () => {
      const saved = desired();
      const old = saved.people.find((p) => p.id === body.data.id);
      if (body.data.id && !old) return reply.code(404).send({ error: "Person not found." });
      const primary = saved.people.find((p) => p.id === saved.primaryPersonId);
      const personaId =
        body.data.personaId?.trim() ||
        old?.personaId ||
        primary?.personaId ||
        context.activeRuntimeEnv["MEMORY_PERSONA_ID"]?.trim();
      if (!personaId) {
        return reply.code(409).send({
          error: "Current YUVI persona is not configured. Configure it in Advanced settings first."
        });
      }
      const command = await context.productPersonCommands.execute(
        {
          commandHandle: body.data.commandHandle,
          operation: old ? "UPDATE" : "CREATE",
          ...(old ? { personId: old.id } : {}),
          displayName: body.data.displayName,
          personaId,
          notes: body.data.notes,
          requestedPrimary: body.data.primary,
          expectedPersonRevision: body.data.expectedPersonRevision,
          expectedPrimaryRevision: body.data.expectedPrimaryRevision
        },
        () => hasLocalDashboardAccess(config, req)
      );
      if (command.status === "PROVEN_NOT_APPLIED" || command.status === "CONFLICT")
        return reply.code(409).send({
          error: command.reason ?? command.status,
          message: "Product Person state changed. Reload before saving."
        });
      if (command.status === "DENIED")
        return reply.code(403).send({ error: command.reason ?? "CONTROL_DENIED" });
      if (command.status !== "APPLIED")
        return reply.code(503).send({
          error: command.reason ?? command.status,
          message:
            "Person command outcome is not yet known. Retry the same command or reload its state."
        });
      const updated = readSettings();
      const person = updated?.people.find((entry) => entry.id === command.personId);
      if (!person || !updated)
        return reply.code(503).send({ error: "NATIVE_OWNER_RECEIPT_UNAVAILABLE" });
      const result = await applyRuntime(updated);
      return {
        ...result,
        personId: person.id,
        controlReceiptRef: command.receiptRef,
        profileEvidence: projectProductProfileEvidence(
          person,
          updated.personRevisionById?.[person.id] ?? null
        ),
        message: "Person profile is saved in Product settings; no Memory evidence was created."
      };
    });
  });
  app.post("/product/proactive/resume", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    if (!(await admitControl({ operation: "PROACTIVE_RESUME" }, reply))) return;
    context.runtime.resumeProactiveNow();
    return snapshot();
  });
}
