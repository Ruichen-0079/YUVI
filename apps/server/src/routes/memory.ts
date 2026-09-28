import type {
  CreateMemoryInput,
  Memory,
  MemoryLayer,
  MemoryRetrievalMode,
  MemoryScope,
  MemorySearchQuery,
  MemoryStatus,
  MemorySubtype,
  MemoryType,
  UpdateMemoryInput
} from "@companion/memory";
import { MemoryMaintenanceService } from "@companion/memory";
import type { RetrievedMemoryDebug } from "@companion/memory";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { requireDashboardDevToken, requireLocalDashboardAccess } from "./security.js";

const MemoryTypeSchema = z.enum([
  "working",
  "episodic",
  "semantic",
  "emotional",
  "procedural",
  "relationship"
]);
const MemorySubtypeSchema = z.enum([
  "preference",
  "fact",
  "project",
  "workflow",
  "event",
  "milestone",
  "provider-choice",
  "path",
  "repo",
  "command",
  "troubleshooting",
  "config",
  "identity",
  "project-fact",
  "config-decision",
  "emotional-state",
  "emotional-pattern",
  "health-note",
  "schedule",
  "test",
  "emotion",
  "relationship"
]);
const MemoryScopeSchema = z.enum(["user", "project", "agent", "plugin", "session"]);
const MemoryLayerSchema = z.enum(["core", "recall", "archival", "working"]);
const MemoryStatusSchema = z.enum(["active", "superseded", "archived", "forgotten", "expired"]);
const OptionalDateStringSchema = z.string().min(1).nullable().optional();

const CreateMemoryRequestSchema = z.object({
  type: MemoryTypeSchema.default("working"),
  subtype: MemorySubtypeSchema.nullable().optional(),
  scope: MemoryScopeSchema.optional(),
  scopeId: z.string().min(1).nullable().optional(),
  memoryLayer: MemoryLayerSchema.optional(),
  status: MemoryStatusSchema.optional(),
  content: z.string().min(1),
  summary: z.string().nullable().optional(),
  importance: z.number().min(0).max(1).optional(),
  emotionValence: z.number().min(-1).max(1).optional(),
  emotionArousal: z.number().min(0).max(1).optional(),
  source: z.string().min(1).default("manual"),
  sourceTraceId: z.string().min(1).nullable().optional(),
  personaId: z.string().min(1).nullable().optional(),
  subjectUserId: z.string().min(1).nullable().optional(),
  createdByUserId: z.string().min(1).nullable().optional(),
  speakerId: z.string().min(1).nullable().optional(),
  voiceProfileId: z.string().min(1).nullable().optional(),
  sessionId: z.string().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).default([]),
  observedAt: OptionalDateStringSchema,
  eventTime: OptionalDateStringSchema,
  validFrom: OptionalDateStringSchema,
  validUntil: OptionalDateStringSchema,
  expiresAt: OptionalDateStringSchema,
  supersededAt: OptionalDateStringSchema,
  supersedes: z.array(z.string().min(1)).optional(),
  supersededBy: z.string().min(1).nullable().optional(),
  contradicts: z.array(z.string().min(1)).optional()
});

const UpdateMemoryRequestSchema = z
  .object({
    type: MemoryTypeSchema.optional(),
    subtype: MemorySubtypeSchema.nullable().optional(),
    scope: MemoryScopeSchema.optional(),
    scopeId: z.string().min(1).nullable().optional(),
    memoryLayer: MemoryLayerSchema.optional(),
    status: MemoryStatusSchema.optional(),
    content: z.string().min(1).optional(),
    summary: z.string().nullable().optional(),
    importance: z.number().min(0).max(1).optional(),
    emotionValence: z.number().min(-1).max(1).optional(),
    emotionArousal: z.number().min(0).max(1).optional(),
    personaId: z.string().min(1).nullable().optional(),
    subjectUserId: z.string().min(1).nullable().optional(),
    createdByUserId: z.string().min(1).nullable().optional(),
    speakerId: z.string().min(1).nullable().optional(),
    voiceProfileId: z.string().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string()).optional(),
    observedAt: OptionalDateStringSchema,
    eventTime: OptionalDateStringSchema,
    validFrom: OptionalDateStringSchema,
    validUntil: OptionalDateStringSchema,
    expiresAt: OptionalDateStringSchema,
    supersededAt: OptionalDateStringSchema,
    supersedes: z.array(z.string().min(1)).optional(),
    supersededBy: z.string().min(1).nullable().optional(),
    contradicts: z.array(z.string().min(1)).optional()
  })
  .strict();

const RecentMemoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const BooleanishSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return value;
}, z.boolean());

const SearchMemoryQuerySchema = z.object({
  view: z.enum(["semantic", "records"]).optional(),
  q: z.string().default(""),
  type: MemoryTypeSchema.optional(),
  subtype: MemorySubtypeSchema.optional(),
  source: z.string().min(1).optional(),
  personaId: z.string().min(1).optional(),
  subjectUserId: z.string().min(1).optional(),
  createdByUserId: z.string().min(1).optional(),
  speakerId: z.string().min(1).optional(),
  voiceProfileId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  scope: MemoryScopeSchema.optional(),
  scopeId: z.string().min(1).optional(),
  memoryLayer: MemoryLayerSchema.optional(),
  status: MemoryStatusSchema.optional(),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (Array.isArray(value)) {
        return value.flatMap(splitTags).filter(Boolean);
      }
      return splitTags(value);
    }),
  minImportance: z.coerce.number().min(0).max(1).optional(),
  includeArchived: BooleanishSchema.optional(),
  includeSuperseded: BooleanishSchema.optional(),
  includeHistoricalEpisodic: BooleanishSchema.optional(),
  includeExpired: BooleanishSchema.optional(),
  includeTestMemories: BooleanishSchema.optional(),
  includeHistory: BooleanishSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const SearchMemoryBodySchema = SearchMemoryQuerySchema.extend({
  q: z.string().default("")
}).strict();

const MemoryParamsSchema = z.object({
  id: z.string().min(1)
});

const BulkDeleteMemoryRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100)
});

const RecentCandidatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const CandidateParamsSchema = z.object({
  id: z.string().min(1)
});

const AcceptCandidateRequestSchema = z
  .object({
    type: MemoryTypeSchema.optional(),
    subtype: MemorySubtypeSchema.nullable().optional(),
    scope: MemoryScopeSchema.optional(),
    scopeId: z.string().min(1).nullable().optional(),
    memoryLayer: MemoryLayerSchema.optional(),
    content: z.string().min(1).optional(),
    summary: z.string().nullable().optional(),
    importance: z.number().min(0).max(1).optional(),
    tags: z.array(z.string()).optional(),
    observedAt: OptionalDateStringSchema,
    eventTime: OptionalDateStringSchema,
    validFrom: OptionalDateStringSchema,
    validUntil: OptionalDateStringSchema,
    expiresAt: OptionalDateStringSchema,
    possibleSupersedes: z.array(z.string().min(1)).optional(),
    possibleContradictions: z.array(z.string().min(1)).optional()
  })
  .strict();

const RejectCandidateRequestSchema = z
  .object({
    reason: z.string().min(1).max(200).optional()
  })
  .strict();

const MaintenanceRequestSchema = z
  .object({
    dryRun: z.boolean().default(true),
    limit: z.number().int().min(1).max(1000).default(100),
    scope: MemoryScopeSchema.optional(),
    scopeId: z.string().min(1).optional(),
    now: z.string().min(1).optional(),
    includeArchived: z.boolean().optional(),
    includeSuperseded: z.boolean().optional()
  })
  .strict();

const MaintenanceHealthQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  scope: MemoryScopeSchema.optional(),
  scopeId: z.string().min(1).optional()
});

const unsafeMetadataKeyPattern = /api[-_]?key|authorization|bearer|token|password|secret/i;

export async function registerMemoryRoutes(
  app: FastifyInstance,
  context: AppContext,
  config?: ServerConfig
): Promise<void> {
  app.post("/memory", async (request, reply) => {
    if (!requireDevelopmentMemoryMutation(config, request, reply)) return;

    const input = CreateMemoryRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }
    const unsafeMetadataKey = findUnsafeMetadataKey(input.data.metadata);
    if (unsafeMetadataKey) {
      return reply.status(400).send({
        error: "unsafe_metadata",
        message: `Memory metadata key "${unsafeMetadataKey}" is not allowed.`
      });
    }

    const createInput: CreateMemoryInput = {
      type: input.data.type as MemoryType,
      content: input.data.content,
      source: input.data.source,
      tags: input.data.tags
    };

    if (input.data.subtype !== undefined) {
      createInput.subtype = input.data.subtype as MemorySubtype | null;
    }
    if (input.data.scope !== undefined) {
      createInput.scope = input.data.scope as MemoryScope;
    }
    if (input.data.scopeId !== undefined) {
      createInput.scopeId = input.data.scopeId;
    }
    if (input.data.memoryLayer !== undefined) {
      createInput.memoryLayer = input.data.memoryLayer as MemoryLayer;
    }
    if (input.data.status !== undefined) {
      createInput.status = input.data.status as MemoryStatus;
    }
    if (input.data.sourceTraceId !== undefined) {
      createInput.sourceTraceId = input.data.sourceTraceId;
    }
    assignIdentityFields(createInput, input.data);
    if (input.data.metadata !== undefined) {
      createInput.metadata = input.data.metadata;
    }
    if (input.data.summary !== undefined) {
      createInput.summary = input.data.summary;
    }
    if (input.data.importance !== undefined) {
      createInput.importance = input.data.importance;
    }
    if (input.data.emotionValence !== undefined) {
      createInput.emotionValence = input.data.emotionValence;
    }
    if (input.data.emotionArousal !== undefined) {
      createInput.emotionArousal = input.data.emotionArousal;
    }
    assignTemporalFields(createInput, input.data);
    assignSupersessionFields(createInput, input.data);

    const memory = await context.memory.createMemory(createInput);

    return reply.send(toSafeMemory(memory));
  });

  app.get("/memory/recent", async (request, reply) => {
    const query = RecentMemoryQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "invalid_request", details: query.error.flatten() });
    }

    const memories = await context.memoryRepository.listRecentMemories(query.data.limit);
    return reply.send({ memories: memories.map(toSafeMemory) });
  });

  app.get("/memory/search", async (request, reply) => {
    if (hasMalformedPercentEncoding(request.url)) {
      return reply.status(400).send(memorySearchValidationError());
    }

    const query = SearchMemoryQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send(memorySearchValidationError(query.error.flatten()));
    }

    return reply.send(await runMemorySearch(context, query.data));
  });

  app.post("/memory/search", async (request, reply) => {
    const query = SearchMemoryBodySchema.safeParse(request.body ?? {});
    if (!query.success) {
      return reply.status(400).send(memorySearchValidationError(query.error.flatten()));
    }

    return reply.send(await runMemorySearch(context, query.data));
  });

  app.post("/memory/bulk-delete", async (request, reply) => {
    if (!requireMemoryWithdrawalAccess(config, request, reply)) return;

    const input = BulkDeleteMemoryRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    let deleted = 0;
    for (const id of input.data.ids) {
      if (await context.memoryRepository.deleteMemory(id)) {
        deleted += 1;
      }
    }

    return reply.send({ ok: true, deleted });
  });

  app.get("/memory/maintenance/health", async (request, reply) => {
    const query = MaintenanceHealthQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "invalid_request", details: query.error.flatten() });
    }

    const maintenance = new MemoryMaintenanceService(context.memoryRepository);
    const health = await maintenance.getHealth({
      limit: query.data.limit,
      ...(query.data.scope ? { scope: query.data.scope as MemoryScope } : {}),
      ...(query.data.scopeId ? { scopeId: query.data.scopeId } : {})
    });
    return reply.send({ ok: true, repository: context.activeMemoryRepository, health });
  });

  app.get("/memory/maintenance/status", async (_request, reply) => {
    return reply.send({
      ok: true,
      repository: context.activeMemoryRepository,
      scheduler: context.memoryMaintenanceScheduler?.getStatus() ?? null
    });
  });

  app.get("/memory/vector-index/status", async (_request, reply) => {
    const status = context.memoryRepository.getVectorIndexStatus
      ? await context.memoryRepository.getVectorIndexStatus()
      : {
          vectorIndexEnabled: false,
          vectorIndexType: "unavailable",
          vectorDistance: "cosine",
          indexCreated: false,
          indexAvailable: false,
          indexFallbackReason: "Memory repository does not expose vector index diagnostics.",
          embeddedCount: 0,
          missingEmbeddingCount: 0,
          annAccelerationActive: false
        };
    return reply.send({ ok: true, repository: context.activeMemoryRepository, status });
  });

  app.post("/memory/maintenance/run", async (request, reply) => {
    if (
      !requireDevelopmentMemoryMutation(
        config,
        request,
        reply,
        "Memory maintenance endpoint is only available in development mode."
      )
    ) {
      return;
    }

    const input = MaintenanceRequestSchema.safeParse(request.body ?? {});
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const options = {
      dryRun: input.data.dryRun,
      limit: input.data.limit,
      ...(input.data.scope ? { scope: input.data.scope as MemoryScope } : {}),
      ...(input.data.scopeId ? { scopeId: input.data.scopeId } : {}),
      ...(input.data.now ? { now: input.data.now } : {}),
      ...(input.data.includeArchived !== undefined
        ? { includeArchived: input.data.includeArchived }
        : {}),
      ...(input.data.includeSuperseded !== undefined
        ? { includeSuperseded: input.data.includeSuperseded }
        : {})
    };
    const summary = context.memoryMaintenanceScheduler
      ? await context.memoryMaintenanceScheduler.run("manual", options)
      : await new MemoryMaintenanceService(context.memoryRepository).run(options);
    return reply.send({
      ok: summary.failed === 0,
      repository: context.activeMemoryRepository,
      summary
    });
  });

  app.get("/memory/candidates/recent", async (request, reply) => {
    if (config && !requireDashboardDevToken(config, request, reply)) return;

    if (config?.runtimeMode && config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Memory candidate review is only available in development mode."
      });
    }
    const query = RecentCandidatesQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "invalid_request", details: query.error.flatten() });
    }

    const candidates = context.runtime.getRecentMemoryCandidates(query.data.limit);
    return reply.send({
      mock: false,
      volatile: true,
      message: "Memory candidate history is development-only and resets when the server restarts.",
      ...summarizeCandidates(candidates),
      candidates
    });
  });

  app.post("/memory/candidates/:id/accept", async (request, reply) => {
    if (config && !requireDashboardDevToken(config, request, reply)) return;

    if (config?.runtimeMode && config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Memory candidate review is only available in development mode."
      });
    }
    const params = CandidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }
    const input = AcceptCandidateRequestSchema.safeParse(request.body ?? {});
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const result = await context.runtime.acceptMemoryCandidate(params.data.id, {
      ...(input.data.type ? { type: input.data.type as MemoryType } : {}),
      ...(input.data.subtype !== undefined
        ? { subtype: input.data.subtype as MemorySubtype | null }
        : {}),
      ...(input.data.scope ? { scope: input.data.scope as MemoryScope } : {}),
      ...(input.data.scopeId !== undefined ? { scopeId: input.data.scopeId } : {}),
      ...(input.data.memoryLayer ? { memoryLayer: input.data.memoryLayer as MemoryLayer } : {}),
      ...(input.data.content !== undefined ? { content: input.data.content } : {}),
      ...(input.data.summary !== undefined ? { summary: input.data.summary } : {}),
      ...(input.data.importance !== undefined ? { importance: input.data.importance } : {}),
      ...(input.data.tags !== undefined ? { tags: input.data.tags } : {}),
      ...(input.data.observedAt !== undefined ? { observedAt: input.data.observedAt } : {}),
      ...(input.data.eventTime !== undefined ? { eventTime: input.data.eventTime } : {}),
      ...(input.data.validFrom !== undefined ? { validFrom: input.data.validFrom } : {}),
      ...(input.data.validUntil !== undefined ? { validUntil: input.data.validUntil } : {}),
      ...(input.data.expiresAt !== undefined ? { expiresAt: input.data.expiresAt } : {}),
      ...(input.data.possibleSupersedes !== undefined
        ? { possibleSupersedes: input.data.possibleSupersedes }
        : {}),
      ...(input.data.possibleContradictions !== undefined
        ? { possibleContradictions: input.data.possibleContradictions }
        : {})
    });

    if (!result) {
      return reply.status(404).send({ error: "not_found", message: "Memory candidate not found." });
    }
    if (result.alreadyStored) {
      const existing = await context.memoryRepository.getMemoryById(result.memoryId);
      return reply.send({
        ok: true,
        alreadyStored: true,
        message: result.message,
        memoryId: result.memoryId,
        memory: existing ? toSafeMemory(existing) : null
      });
    }

    return reply.send({
      ok: true,
      alreadyStored: false,
      message: result.message,
      memory: toSafeMemory(result.memory)
    });
  });

  app.post("/memory/candidates/:id/reject", async (request, reply) => {
    if (config && !requireDashboardDevToken(config, request, reply)) return;

    if (config?.runtimeMode && config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Memory candidate review is only available in development mode."
      });
    }
    const params = CandidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }
    const input = RejectCandidateRequestSchema.safeParse(request.body ?? {});
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const candidate = context.runtime.rejectMemoryCandidate(params.data.id, input.data.reason);
    if (!candidate) {
      return reply.status(404).send({ error: "not_found", message: "Memory candidate not found." });
    }

    return reply.send({ ok: true, candidate });
  });

  app.get("/memory/:id", async (request, reply) => {
    const params = MemoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }

    const memory = await context.memoryRepository.getMemoryById(params.data.id);
    if (!memory) {
      return reply.status(404).send({ error: "not_found", message: "Memory not found." });
    }

    return reply.send(toSafeMemory(memory));
  });

  app.patch("/memory/:id", async (request, reply) => {
    if (!requireDevelopmentMemoryMutation(config, request, reply)) return;

    const params = MemoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }
    const input = UpdateMemoryRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }
    const unsafeMetadataKey = findUnsafeMetadataKey(input.data.metadata);
    if (unsafeMetadataKey) {
      return reply.status(400).send({
        error: "unsafe_metadata",
        message: `Memory metadata key "${unsafeMetadataKey}" is not allowed.`
      });
    }

    const updateInput: UpdateMemoryInput = {};
    if (input.data.type !== undefined) {
      updateInput.type = input.data.type as MemoryType;
    }
    if (input.data.subtype !== undefined) {
      updateInput.subtype = input.data.subtype as MemorySubtype | null;
    }
    if (input.data.scope !== undefined) {
      updateInput.scope = input.data.scope as MemoryScope;
    }
    if (input.data.scopeId !== undefined) {
      updateInput.scopeId = input.data.scopeId;
    }
    if (input.data.memoryLayer !== undefined) {
      updateInput.memoryLayer = input.data.memoryLayer as MemoryLayer;
    }
    if (input.data.status !== undefined) {
      updateInput.status = input.data.status as MemoryStatus;
    }
    if (input.data.content !== undefined) {
      updateInput.content = input.data.content;
    }
    if (input.data.summary !== undefined) {
      updateInput.summary = input.data.summary;
    }
    if (input.data.importance !== undefined) {
      updateInput.importance = input.data.importance;
    }
    if (input.data.emotionValence !== undefined) {
      updateInput.emotionValence = input.data.emotionValence;
    }
    if (input.data.emotionArousal !== undefined) {
      updateInput.emotionArousal = input.data.emotionArousal;
    }
    assignIdentityFields(updateInput, input.data);
    if (input.data.metadata !== undefined) {
      updateInput.metadata = input.data.metadata;
    }
    if (input.data.tags !== undefined) {
      updateInput.tags = input.data.tags;
    }
    assignTemporalFields(updateInput, input.data);
    assignSupersessionFields(updateInput, input.data);

    const updated = await context.memory.updateMemory(params.data.id, updateInput);
    if (!updated) {
      return reply.status(404).send({ error: "not_found", message: "Memory not found." });
    }

    return reply.send(toSafeMemory(updated));
  });

  app.delete("/memory/:id", async (request, reply) => {
    if (!requireMemoryWithdrawalAccess(config, request, reply)) return;

    const params = MemoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }

    const deleted = await context.memoryRepository.deleteMemory(params.data.id);
    if (!deleted) {
      return reply.status(404).send({ error: "not_found", message: "Memory not found." });
    }

    return reply.send({ ok: true, id: params.data.id });
  });

  app.post("/memory/:id/archive", async (request, reply) => {
    if (!requireMemoryWithdrawalAccess(config, request, reply)) return;

    return updateMemoryStatus(request.params, reply, context, "archived");
  });

  app.post("/memory/:id/restore", async (request, reply) => {
    if (!requireDevelopmentMemoryMutation(config, request, reply)) return;

    return updateMemoryStatus(request.params, reply, context, "active");
  });

  app.post("/memory/:id/forget", async (request, reply) => {
    if (!requireMemoryWithdrawalAccess(config, request, reply)) return;

    return updateMemoryStatus(request.params, reply, context, "forgotten");
  });
}

// This policy is Memory-route-specific: requireDashboardDevToken intentionally
// does not authenticate production callers, so additive manual writes are hidden there.
function requireDevelopmentMemoryMutation(
  config: ServerConfig | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  message = "Manual Memory authoring is only available in development mode."
): boolean {
  if (!config) return true;
  if (config.runtimeMode !== "development") {
    reply.status(404).send({ error: "not_found", message });
    return false;
  }
  return requireDashboardDevToken(config, request, reply);
}

// Privacy withdrawal stays usable without Journal admission, but production
// callers must be localhost-bound. Development keeps its existing LAN/token policy.
function requireMemoryWithdrawalAccess(
  config: ServerConfig | undefined,
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  if (!config) return true;
  if (config.runtimeMode === "development") {
    return requireDashboardDevToken(config, request, reply);
  }
  return requireLocalDashboardAccess(config, request, reply);
}

async function updateMemoryStatus(
  rawParams: unknown,
  reply: FastifyReply,
  context: AppContext,
  status: MemoryStatus
): Promise<unknown> {
  const params = MemoryParamsSchema.safeParse(rawParams);
  if (!params.success) {
    return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
  }

  const updated = await context.memoryRepository.updateMemory(params.data.id, { status });
  if (!updated) {
    return reply.status(404).send({ error: "not_found", message: "Memory not found." });
  }

  return reply.send({ ok: true, id: params.data.id, memory: toSafeMemory(updated) });
}

type SearchMemoryInput = z.infer<typeof SearchMemoryQuerySchema>;

async function runMemorySearch(context: AppContext, input: SearchMemoryInput) {
  const searchQuery: MemorySearchQuery = {
    text: input.q,
    limit: input.limit
  };
  if (input.includeArchived !== undefined) searchQuery.includeArchived = input.includeArchived;
  if (input.includeSuperseded !== undefined)
    searchQuery.includeSuperseded = input.includeSuperseded;
  if (input.includeExpired !== undefined) searchQuery.includeExpired = input.includeExpired;
  if (input.includeTestMemories !== undefined) {
    searchQuery.includeTestMemories = input.includeTestMemories;
  }
  if (input.includeHistory !== undefined) searchQuery.includeHistory = input.includeHistory;
  if (input.includeHistoricalEpisodic !== undefined) {
    searchQuery.includeHistoricalEpisodic = input.includeHistoricalEpisodic;
  }
  if (input.type) searchQuery.types = [input.type as MemoryType];
  if (input.subtype) searchQuery.subtypes = [input.subtype as MemorySubtype];
  if (input.source) searchQuery.sources = [input.source];
  if (input.personaId) searchQuery.personaId = input.personaId;
  if (input.subjectUserId) searchQuery.subjectUserId = input.subjectUserId;
  if (input.createdByUserId) searchQuery.createdByUserId = input.createdByUserId;
  if (input.speakerId) searchQuery.speakerId = input.speakerId;
  if (input.voiceProfileId) searchQuery.voiceProfileId = input.voiceProfileId;
  if (input.sessionId) searchQuery.sessionId = input.sessionId;
  if (input.scope) searchQuery.scope = input.scope as MemoryScope;
  if (input.scopeId) searchQuery.scopeId = input.scopeId;
  if (input.memoryLayer) searchQuery.memoryLayers = [input.memoryLayer as MemoryLayer];
  if (input.status) searchQuery.statuses = [input.status as MemoryStatus];
  if (input.tags?.length) searchQuery.tags = input.tags;
  if (input.minImportance !== undefined) searchQuery.minImportance = input.minImportance;

  if (input.view === "records") {
    // The development CRUD console browses the same repository it edits. It must
    // not switch to Mem0 semantic retrieval merely because Runtime uses Mem0.
    searchQuery.includeHistory = true;
    searchQuery.statuses = input.status
      ? [input.status as MemoryStatus]
      : [
          "active",
          ...(input.includeArchived ? ["archived" as const] : []),
          ...(input.includeSuperseded ? ["superseded" as const] : []),
          ...(input.includeExpired ? ["expired" as const] : [])
        ];
    const records = await context.memoryRepository.searchMemoriesByTextFallback(searchQuery);
    return {
      mock: false,
      repository: context.activeMemoryRepository,
      retrievalMode: "repository-records",
      query: input.q,
      count: records.length,
      memories: records.map(toSafeMemory)
    };
  }

  const result = await context.memory.retrieveRelevantMemoriesWithMetadata(searchQuery);
  const retrievalMode = normalizeRetrievalModeForRepository(
    result.retrievalMode,
    context.activeMemoryRepository
  );

  return {
    mock: false,
    query: result.query,
    repository: context.activeMemoryRepository,
    rawCount: result.rawCount,
    count: result.count,
    retrievalMode,
    vectorEnabled: result.vectorEnabled,
    vectorUsed: result.vectorUsed,
    embeddingProvider: result.embeddingProvider,
    embeddingModel: result.embeddingModel,
    embeddingDimensions: result.embeddingDimensions,
    semanticEmbedding: result.semanticEmbedding,
    embeddingNote: result.embeddingNote,
    queryEmbeddingGenerated: result.queryEmbeddingGenerated,
    vectorResultCount: result.vectorResultCount,
    keywordResultCount: result.keywordResultCount,
    hybridResultCount: result.hybridResultCount,
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason,
    retrievalScope: result.retrievalScope,
    includedScopes: result.includedScopes,
    excludedByStatus: result.excludedByStatus,
    excludedByTime: result.excludedByTime,
    excludedByScope: result.excludedByScope,
    includeArchived: result.includeArchived,
    includeSuperseded: result.includeSuperseded,
    includeExpired: result.includeExpired,
    debugMemories: result.rawMemories.map(toSafeRetrievedMemory),
    memories: result.selectedMemories.map(toSafeMemory)
  };
}

function normalizeRetrievalModeForRepository(
  mode: MemoryRetrievalMode,
  repository: string
): MemoryRetrievalMode {
  if (repository === "postgres") {
    return mode;
  }
  if (mode.startsWith("postgres-")) {
    return mode.includes("hybrid") || mode.includes("vector")
      ? "in-memory-hybrid"
      : "in-memory-keyword";
  }
  if (mode === "hybrid-keyword") {
    return "in-memory-hybrid";
  }
  if (mode === "keyword") {
    return "in-memory-keyword";
  }
  return mode;
}

export function memorySearchValidationError(details?: unknown) {
  return {
    error: "invalid_memory_search_query",
    message:
      "Invalid memory search query. URL-encode Unicode query strings for GET /memory/search, or use POST /memory/search with a JSON body.",
    details,
    examples: {
      getEncoded:
        'curl -G "http://localhost:6121/memory/search" --data-urlencode "q=模型供应商偏好"',
      postJson:
        'curl -X POST "http://localhost:6121/memory/search" -H "Content-Type: application/json" -d \'{"q":"模型供应商偏好","limit":10}\''
    }
  };
}

function hasMalformedPercentEncoding(url: string): boolean {
  try {
    decodeURIComponent(url);
    return false;
  } catch {
    return true;
  }
}

function assignTemporalFields(
  target: CreateMemoryInput | UpdateMemoryInput,
  input: {
    observedAt?: string | null | undefined;
    eventTime?: string | null | undefined;
    validFrom?: string | null | undefined;
    validUntil?: string | null | undefined;
    expiresAt?: string | null | undefined;
    supersededAt?: string | null | undefined;
  }
): void {
  if (input.observedAt !== undefined) target.observedAt = input.observedAt;
  if (input.eventTime !== undefined) target.eventTime = input.eventTime;
  if (input.validFrom !== undefined) target.validFrom = input.validFrom;
  if (input.validUntil !== undefined) target.validUntil = input.validUntil;
  if (input.expiresAt !== undefined) target.expiresAt = input.expiresAt;
  if (input.supersededAt !== undefined) target.supersededAt = input.supersededAt;
}

function assignSupersessionFields(
  target: CreateMemoryInput | UpdateMemoryInput,
  input: {
    supersedes?: string[] | undefined;
    supersededBy?: string | null | undefined;
    contradicts?: string[] | undefined;
  }
): void {
  if (input.supersedes !== undefined) target.supersedes = input.supersedes;
  if (input.supersededBy !== undefined) target.supersededBy = input.supersededBy;
  if (input.contradicts !== undefined) target.contradicts = input.contradicts;
}

function assignIdentityFields(
  target: CreateMemoryInput | UpdateMemoryInput,
  input: {
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
    createdByUserId?: string | null | undefined;
    speakerId?: string | null | undefined;
    voiceProfileId?: string | null | undefined;
    sessionId?: string | null | undefined;
  }
): void {
  if (input.personaId !== undefined) target.personaId = input.personaId;
  if (input.subjectUserId !== undefined) target.subjectUserId = input.subjectUserId;
  if (input.createdByUserId !== undefined) target.createdByUserId = input.createdByUserId;
  if (input.speakerId !== undefined) target.speakerId = input.speakerId;
  if (input.voiceProfileId !== undefined) target.voiceProfileId = input.voiceProfileId;
  if (input.sessionId !== undefined) target.sessionId = input.sessionId;
}

function splitTags(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function toSafeMemory(memory: Memory): Memory {
  return {
    ...memory,
    embedding: null,
    metadata: redactUnsafeMetadata(memory.metadata),
    retentionClass:
      typeof memory.metadata["retentionClass"] === "string"
        ? memory.metadata["retentionClass"]
        : undefined,
    retentionReason:
      typeof memory.metadata["retentionReason"] === "string"
        ? memory.metadata["retentionReason"]
        : undefined,
    hasEmbedding: Boolean(memory.embedding?.length),
    semanticEmbedding:
      memory.embeddingProvider === null || memory.embeddingProvider === undefined
        ? undefined
        : memory.embeddingProvider !== "mock",
    embeddingError: safeEmbeddingError(memory.metadata)
  } as Memory & {
    hasEmbedding: boolean;
    semanticEmbedding?: boolean;
    embeddingError?: string;
  };
}

function toSafeRetrievedMemory(memory: RetrievedMemoryDebug): RetrievedMemoryDebug {
  const metadata = memory.metadata ? redactUnsafeMetadata(memory.metadata) : undefined;
  return {
    ...memory,
    ...(metadata ? { metadata } : {})
  };
}

function findUnsafeMetadataKey(value: unknown, path: string[] = []): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (unsafeMetadataKeyPattern.test(key)) {
      return nextPath.join(".");
    }
    const nested = findUnsafeMetadataKey(child, nextPath);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function redactUnsafeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (unsafeMetadataKeyPattern.test(key)) {
      output[key] = "[redacted]";
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      output[key] = redactUnsafeMetadata(child as Record<string, unknown>);
    } else {
      output[key] = child;
    }
  }
  return output;
}

function safeEmbeddingError(metadata: Record<string, unknown>): string | undefined {
  const value = metadata["embeddingError"];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]").slice(0, 300);
}

function summarizeCandidates(candidates: Array<{ decision: string; fallbackUsed?: boolean }>): {
  count: number;
  storedCount: number;
  rejectedCount: number;
  candidateCount: number;
  fallbackUsed: boolean;
} {
  return {
    count: candidates.length,
    storedCount: candidates.filter((candidate) => candidate.decision === "stored").length,
    rejectedCount: candidates.filter((candidate) => candidate.decision === "rejected").length,
    candidateCount: candidates.filter((candidate) => candidate.decision === "candidate").length,
    fallbackUsed: candidates.some((candidate) => Boolean(candidate.fallbackUsed))
  };
}
