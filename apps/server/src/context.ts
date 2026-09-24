import { productEnvironment, readProductSettings } from "./services/product-store.js";
import { join } from "node:path";
import { createPostgresPool } from "@companion/database";
import {
  PostgresJournalRepository,
  JournalStoreError,
  type JournalRepository
} from "@companion/journal";
import { getRuntimeEnvDir } from "@companion/config";
import { createFileP8CorrectionStore, createFileVoiceBindingReferences } from "@companion/core";
import { captureKdeScreen, screenCaptureAvailable } from "./screen-capture.js";
import type {
  RuntimeReplyStreamEvent,
  RuntimeLogger,
  RuntimeCharacterCognitionExecutor
} from "@companion/core";
import { RuntimeOrchestrator, type RuntimeProactiveStateStore } from "@companion/core";
import { createFileProactiveStateStore } from "./proactive-policy-store.js";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  LocalControllerEvidenceProvider,
  LlmMemoryExtractor,
  MemoryService,
  RuleBasedMemoryExtractor,
  createMemoryBackend,
  createMemoryRepositoryFromEnv,
  createConversationRepositoryFromEnv,
  createFinalizedIngestionRepositoryFromEnv,
  createRecentEpisodeStoreFromEnv,
  FinalizedIngestionService,
  MemoryIngestionCoordinator,
  InMemoryDreamJobStore,
  PostgresDreamJobStore,
  parseMemoryRepositoryEnv,
  type ConversationRepository,
  type DreamJobStore,
  type FinalizedIngestionRepository,
  type MemoryProvider,
  type MemoryRepository,
  type RecentEpisodeStore
} from "@companion/memory";
import { parseRuntimeConfig } from "@companion/config";
import { normalizeCharacterOutputLanguage } from "@companion/character-abi";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createProviderRegistryFromEnv,
  type ProviderRegistry,
  type ProviderStatusMap
} from "@companion/providers";
import type { FastifyBaseLogger } from "fastify";
import type { ServerConfig } from "./config.js";
import { readRuntimeEnvFiles } from "./env.js";
import {
  editableKeys,
  getPendingRestartKeys,
  getRuntimeSettingApplyMode,
  snapshotRestartSettings,
  type EditableRuntimeSetting
} from "./runtime-settings.js";
import { DashboardStateService } from "./services/dashboard.js";
import type { MemoryMaintenanceScheduler } from "./services/memoryMaintenanceScheduler.js";
import {
  interpretCharacterHarnessOutput,
  superviseCharacterHarnessGeneration,
  superviseCharacterHarnessRepetition
} from "@companion/character-harness";
import type { CharacterHarnessCognitionRequest } from "@companion/character-harness/cognition-request";
import { composeServerCharacterSoftSmileEmbodiedEffect } from "./character-embodied-soft-smile-composition.js";
import { EmbodiedPresentationBridge } from "./embodied-presentation-bridge.js";
import { createServerCharacterPort } from "./character-runtime.js";
import { executeProductionCognition } from "./cognition-production.js";
import type { ServerPluginRuntimeCapabilitySurface } from "./plugin-lifecycle.js";

export type AppContext = {
  eventBus: InMemoryEventBus;
  dashboard: DashboardStateService;
  memoryRepository: MemoryRepository;
  conversationRepository: ConversationRepository;
  finalizedIngestionRepository: FinalizedIngestionRepository;
  journalRepository: JournalRepository | null;
  closeDatabasePool(): Promise<void>;
  finalizedIngestion: FinalizedIngestionService;
  memoryIngestionCoordinator: MemoryIngestionCoordinator;
  memory: MemoryService;
  providers: ProviderRegistry;
  runtime: RuntimeOrchestrator;
  embodiedPresentationBridge: EmbodiedPresentationBridge;
  activeMemoryRepository: string;
  activeRuntimeEnv: Record<string, string | undefined>;
  memoryMaintenanceScheduler?: MemoryMaintenanceScheduler | undefined;
  subscribeProactiveStream(listener: (event: RuntimeReplyStreamEvent) => void): () => void;
  reloadRuntimeConfig(env: Record<string, string | undefined>): Promise<RuntimeConfigReloadResult>;
};

export type RuntimeConfigReloadResult = {
  providers: ProviderStatusMap;
  restartRequired: boolean;
  notHotReloaded: string[];
  appliedKeys: string[];
  pendingRestartKeys: string[];
  message: string;
};

export async function createAppContext(
  logger: FastifyBaseLogger,
  config: ServerConfig,
  pluginCapabilities?: ServerPluginRuntimeCapabilitySurface
): Promise<AppContext> {
  if (config.eventBus === "nats") {
    throw new Error("EVENT_BUS=nats is reserved for future NATS support and is not implemented.");
  }

  const bootEnv = productEnvironment((await readRuntimeEnvFiles()).env, readProductSettings());
  for (const key of [
    "YUVI_PRODUCT_CONFIGURATION",
    "MEMORY_SUBJECT_USER_ID",
    "MEMORY_PERSONA_ID",
    "PROACTIVE_SCORE_THRESHOLD",
    "PROACTIVE_EVALUATION_INTERVAL_MS"
  ]) {
    if (bootEnv[key] !== undefined) process.env[key] = bootEnv[key];
  }
  const eventBus = new InMemoryEventBus();
  const proactiveListeners = new Set<(event: RuntimeReplyStreamEvent) => void>();
  const embodiedPresentationBridge = new EmbodiedPresentationBridge(eventBus);
  const dashboard = new DashboardStateService();
  eventBus.subscribe("*", (event) => {
    dashboard.recordEvent(event);
  });
  const activeMemoryRepository = parseMemoryRepositoryEnv().kind;
  const activeRuntimeEnv = {
    ...bootEnv,
    ...snapshotRestartSettings(bootEnv),
    MEMORY_REPOSITORY: activeMemoryRepository,
    MEMORY_MAINTENANCE_ENABLED: String(config.memoryMaintenance.enabled),
    MEMORY_MAINTENANCE_RUN_ON_STARTUP: String(config.memoryMaintenance.runOnStartup),
    MEMORY_MAINTENANCE_INTERVAL_MINUTES: String(config.memoryMaintenance.intervalMinutes),
    MEMORY_MAINTENANCE_LIMIT: String(config.memoryMaintenance.limit),
    MEMORY_VECTOR_INDEX_ENABLED: String(config.memoryVectorIndex.enabled),
    MEMORY_VECTOR_INDEX_TYPE: config.memoryVectorIndex.type,
    MEMORY_VECTOR_DISTANCE: config.memoryVectorIndex.distance,
    ...(config.memoryVectorIndex.ivfflatProbes === undefined
      ? {}
      : { MEMORY_VECTOR_IVFFLAT_PROBES: String(config.memoryVectorIndex.ivfflatProbes) }),
    ...(config.memoryVectorIndex.hnswEfSearch === undefined
      ? {}
      : { MEMORY_VECTOR_HNSW_EF_SEARCH: String(config.memoryVectorIndex.hnswEfSearch) }),
    YUVI_AUTO_MIGRATE: String(config.devSupervisor.autoMigrate),
    YUVI_DEV_SUPERVISOR: String(config.devSupervisor.active),
    EVENT_BUS: config.eventBus,
    SERVER_HOST: config.host,
    SERVER_PORT: String(config.port)
  };
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  const databasePool = databaseUrl ? createPostgresPool(databaseUrl) : undefined;
  const journalRepository = databasePool
    ? new PostgresJournalRepository(databasePool, {
        namespace: process.env["YUVI_JOURNAL_NAMESPACE"] ?? "yuvi:default",
        // Production ingress adapters are intentionally added in A8.2b-f. Until then,
        // the storage authority refuses to invent principal/source/audience evidence.
        authorityBuilder() {
          throw new JournalStoreError(
            "INVALID_PROPOSAL",
            "Journal admission authority is not wired until the production ingress leaves."
          );
        }
      })
    : null;
  const memoryRepository = createMemoryRepositoryFromEnv(process.env, databasePool);
  let conversationRepository: ConversationRepository | undefined;
  let finalizedIngestionRepository: FinalizedIngestionRepository | undefined;
  try {
    conversationRepository = createConversationRepositoryFromEnv(
      process.env,
      databasePool ?? memoryRepository.getDatabaseClient?.()
    );
    finalizedIngestionRepository = createFinalizedIngestionRepositoryFromEnv(
      process.env,
      databasePool ?? memoryRepository.getDatabaseClient?.()
    );
  } catch (error) {
    await conversationRepository?.close?.();
    await memoryRepository.close?.();
    await databasePool?.end();
    throw error;
  }
  const promptBuilder = new PromptBuilder();
  const recentEpisodeStore: RecentEpisodeStore = createRecentEpisodeStoreFromEnv(
    process.env,
    databasePool
  );
  const dreamJobStore: DreamJobStore =
    parseMemoryRepositoryEnv().kind === "postgres" && databasePool
      ? new PostgresDreamJobStore(databasePool)
      : new InMemoryDreamJobStore();
  const finalizedIngestion = new FinalizedIngestionService(finalizedIngestionRepository!);
  const ruleBasedExtractor = new RuleBasedMemoryExtractor();
  const runtimeLogger = createRuntimeLogger(logger);
  const proactiveStateStore: RuntimeProactiveStateStore = createFileProactiveStateStore(bootEnv);

  function createMemoryService(
    providers: ProviderRegistry,
    extractorMode = config.memoryExtractor,
    env: Record<string, string | undefined> = process.env
  ): MemoryService {
    const reasoningStatus = providers.getStatus().providers.reasoning;
    const memoryExtractor =
      extractorMode === "llm"
        ? new LlmMemoryExtractor(providers.getReasoningProvider(), ruleBasedExtractor, {
            enabled: true,
            providerConfigured: Boolean(reasoningStatus.configured && !reasoningStatus.mock),
            providerName: reasoningStatus.provider,
            logger: runtimeLogger,
            includeRawPreview: config.runtimeMode === "development"
          })
        : ruleBasedExtractor;

    const runtimeConfig = parseRuntimeConfig(env);
    const backendKind = runtimeConfig.memory.backend === "mem0" ? "mem0" : "legacy";
    // Runtime must not require Sidecar healthy at boot — Mem0 client is lazy HTTP.
    const mem0Backend =
      backendKind === "mem0"
        ? createMemoryBackend({
            kind: "mem0",
            ...(runtimeConfig.memory.mem0BaseUrl
              ? { mem0BaseUrl: runtimeConfig.memory.mem0BaseUrl }
              : {}),
            ...(runtimeConfig.memory.mem0TimeoutMs !== undefined
              ? { mem0TimeoutMs: runtimeConfig.memory.mem0TimeoutMs }
              : {}),
            mem0WriteTimeoutMs: 180_000,
            ...(runtimeConfig.memory.mem0HealthTimeoutMs !== undefined
              ? { mem0HealthTimeoutMs: runtimeConfig.memory.mem0HealthTimeoutMs }
              : {})
          })
        : undefined;

    if (backendKind === "mem0") {
      runtimeLogger.info("memory backend selected", {
        backend: "mem0",
        mem0BaseUrl: runtimeConfig.memory.mem0BaseUrl,
        searchTimeoutMs: runtimeConfig.memory.mem0TimeoutMs
      });
    }

    return new MemoryService(
      memoryRepository,
      undefined,
      undefined,
      memoryExtractor,
      {
        provider: providers.getEmbeddingProvider(),
        // Mem0 owns embeddings for LTM; keep provider only for legacy path.
        enabled:
          backendKind === "legacy" &&
          (providers.getStatus().routes?.embedding ?? []).some(
            (route) => route.enabled && (route.configured || route.mock)
          ),
        logger: runtimeLogger
      },
      {
        kind: backendKind,
        mem0: mem0Backend,
        controllerEvidence: new LocalControllerEvidenceProvider(
          env["YUVI_RUNTIME_DATA_DIR"] || join(getRuntimeEnvDir(env), "data")
        ),
        searchTimeoutMs: runtimeConfig.memory.mem0TimeoutMs,
        writeTimeoutMs: 180_000,
        logger: runtimeLogger
      }
    );
  }

  function createRuntime(
    providers: ProviderRegistry,
    memory: MemoryService,
    directContext = config.directContext,
    runtimeEnv: Record<string, string | undefined> = bootEnv
  ): RuntimeOrchestrator {
    const provider = memory.getMemoryProvider?.();
    const outputLanguage = parseRuntimeConfig(runtimeEnv).outputLanguage;
    // Existing test doubles and explicit offline/mock runs intentionally
    // return ordinary Chat text rather than the production Character JSON
    // ABI. Real non-mock construction binds Character and its Cognition
    // callback in one place.
    const character =
      process.env["NODE_ENV"] === "test" || process.env["PROVIDER_ALLOW_MOCKS"] === "true"
        ? undefined
        : createServerCharacterPort();
    const nextRuntime = new RuntimeOrchestrator({
      ...(screenCaptureAvailable() ? { captureScreen: captureKdeScreen } : {}),
      eventBus,
      voiceBindingReferences: createFileVoiceBindingReferences(
        join(getRuntimeEnvDir(bootEnv), "voice-binding-references.json")
      ),
      voicePersonaId: runtimeEnv["MEMORY_PERSONA_ID"],
      p8CorrectionStore: createFileP8CorrectionStore(
        join(getRuntimeEnvDir(bootEnv), "p8-corrections.json")
      ),
      memory,
      promptBuilder,
      providers,
      now: () => Date.now(),
      proactiveConsentEnabled: proactiveStateStore.load()?.consentEnabled,
      proactiveScoreThreshold: Number(runtimeEnv["PROACTIVE_SCORE_THRESHOLD"] ?? 0.7),
      proactiveEvaluationIntervalMs: Number(
        runtimeEnv["PROACTIVE_EVALUATION_INTERVAL_MS"] ?? 60_000
      ),
      proactiveStateStore,
      conversation: conversationRepository,
      finalizedIngestion,
      memoryIngestionCoordinator: coordinator,
      memoryRepository: activeMemoryRepository,
      directContext,
      outputLanguage,
      recentEpisodeStore,
      dreamJobStore,
      ...(provider ? { dreamProvider: provider } : {}),
      logger: runtimeLogger,
      ...(character
        ? {
            character,
            characterCognition: (
              request: unknown,
              problem: string,
              options: Parameters<RuntimeCharacterCognitionExecutor>[2]
            ) =>
              executeProductionCognition({
                providers,
                request: request as CharacterHarnessCognitionRequest,
                problem,
                execution: options.execution,
                canonicalContext: options.canonicalContext,
                limits: config.cognitionInteraction,
                runtimeAuthorizedPath: options?.runtimeAuthorizedPath,
                ...(pluginCapabilities === undefined ? {} : { pluginCapabilities }),
                ...(options?.signal ? { signal: options.signal } : {})
              })
          }
        : {}),
      embodiedPresentation: {
        propose: (reply, presentation) => {
          if (presentation === null) return null;
          const generation = superviseCharacterHarnessRepetition({
            generation: superviseCharacterHarnessGeneration({
              interpretation: interpretCharacterHarnessOutput({
                disposition: "RESPOND",
                text: reply.payload.content,
                presentation: presentation ?? { intent: "soft-smile" }
              }),
              finishReason: "stop",
              maxResponseCharacters: 4000
            }),
            ngramCharacters: 64,
            maxOccurrences: 3
          });
          return composeServerCharacterSoftSmileEmbodiedEffect(
            generation,
            { kind: "turn", reference: reply.traceId },
            {
              allocateProposalInstance: () => ({
                reference: `character-proposal:${crypto.randomUUID()}`,
                createdAtMs: Date.now()
              }),
              allocateEffectId: () => `runtime-effect:${crypto.randomUUID()}`,
              policyAllowsEmbodiedEffect: () => true
            }
          );
        },
        present: (request, traceAnchor, observe) =>
          embodiedPresentationBridge.present(request, traceAnchor, observe)
      }
    });
    nextRuntime.subscribeProactiveStream((event) => {
      for (const listener of proactiveListeners) listener(event);
    });
    return nextRuntime;
  }

  let providers: ProviderRegistry;
  let memory: MemoryService;
  let coordinator: MemoryIngestionCoordinator;
  let runtime: RuntimeOrchestrator;
  try {
    providers = createProviderRegistryFromEnv(bootEnv);
    memory = createMemoryService(providers);
    coordinator = new MemoryIngestionCoordinator({
      repository: finalizedIngestionRepository!,
      provider: memory.getMemoryProvider() ?? unavailableMemoryProvider(),
      admit: (input) => finalizedIngestion.admit(input),
      conversation: conversationRepository,
      logger: runtimeLogger,
      pollIntervalMs: config.memoryIngestion.pollIntervalMs,
      concurrency: config.memoryIngestion.concurrency,
      leaseSeconds: config.memoryIngestion.leaseSeconds,
      scanLimit: config.memoryIngestion.scanLimit,
      maxDeliveryAttempts: config.memoryIngestion.maxDeliveryAttempts,
      missingAdmissionEnabled: config.memoryIngestion.missingAdmissionEnabled,
      retryPolicy: {
        initialDelayMs: config.memoryIngestion.retryInitialDelayMs,
        maxDelayMs: config.memoryIngestion.retryMaxDelayMs,
        multiplier: config.memoryIngestion.retryMultiplier
      }
    });
    runtime = createRuntime(providers, memory, config.directContext, bootEnv);
    runtime.startProactiveScheduler({
      sessionId: "default",
      readMemory: true,
      personaId: parseRuntimeConfig(bootEnv).memory.personaId,
      subjectUserId: parseRuntimeConfig(bootEnv).memory.subjectUserId
    });
  } catch (error) {
    await conversationRepository.close?.();
    await finalizedIngestionRepository?.close?.();
    await memoryRepository.close?.();
    await databasePool?.end();
    throw error;
  }

  const context: AppContext = {
    eventBus,
    dashboard,
    memoryRepository,
    conversationRepository: conversationRepository!,
    finalizedIngestionRepository: finalizedIngestionRepository!,
    journalRepository,
    async closeDatabasePool() {
      await databasePool?.end();
    },
    finalizedIngestion,
    memoryIngestionCoordinator: coordinator,
    memory,
    providers,
    runtime,
    embodiedPresentationBridge,
    activeMemoryRepository,
    activeRuntimeEnv,
    subscribeProactiveStream(listener) {
      proactiveListeners.add(listener);
      return () => {
        proactiveListeners.delete(listener);
      };
    },
    async reloadRuntimeConfig(env) {
      const previousActiveRuntimeEnv = { ...context.activeRuntimeEnv };
      const notHotReloaded = getPendingRestartKeys(env, previousActiveRuntimeEnv);
      const reloadEnv = { ...env };
      for (const key of notHotReloaded) {
        if (previousActiveRuntimeEnv[key] === undefined) {
          delete reloadEnv[key];
        } else {
          reloadEnv[key] = previousActiveRuntimeEnv[key];
        }
      }

      const nextProviders = createProviderRegistryFromEnv(reloadEnv);
      const nextMemory = createMemoryService(
        nextProviders,
        parseMemoryExtractorMode(reloadEnv["MEMORY_EXTRACTOR"]),
        reloadEnv
      );
      const nextRuntime = createRuntime(
        nextProviders,
        nextMemory,
        {
          enabled: parseBoolean(reloadEnv["DIRECT_CONTEXT_ENABLED"], config.directContext.enabled),
          maxTurns: parsePositiveInteger(
            reloadEnv["DIRECT_CONTEXT_MAX_TURNS"],
            config.directContext.maxTurns
          ),
          maxChars: parsePositiveInteger(
            reloadEnv["DIRECT_CONTEXT_MAX_CHARS"],
            config.directContext.maxChars
          )
        },
        reloadEnv
      );

      // Stage all replacements before sealing or mutating the current
      // Runtime. Construction failures therefore leave the live context
      // unchanged.
      await context.runtime.sealAndDrainMemoryWrites();
      context.memoryIngestionCoordinator.replaceProvider(
        nextMemory.getMemoryProvider() ?? unavailableMemoryProvider()
      );
      context.providers = nextProviders;
      context.memory = nextMemory;
      context.runtime = nextRuntime;
      context.runtime.startProactiveScheduler({
        sessionId: "default",
        readMemory: true,
        personaId: parseRuntimeConfig(reloadEnv).memory.personaId,
        subjectUserId: parseRuntimeConfig(reloadEnv).memory.subjectUserId
      });

      const appliedKeys: string[] = [];
      for (const key of editableKeys) {
        if (getRuntimeSettingApplyMode(key) === "hot_reload") {
          if (!sameRuntimeSettingValue(key, previousActiveRuntimeEnv[key], env[key])) {
            appliedKeys.push(key);
          }
          context.activeRuntimeEnv[key] = env[key];
        }
      }

      const pendingRestartKeys = getPendingRestartKeys(env, context.activeRuntimeEnv);
      const restartRequired = pendingRestartKeys.length > 0;

      return {
        providers: nextProviders.getStatus(),
        restartRequired,
        notHotReloaded: pendingRestartKeys,
        appliedKeys,
        pendingRestartKeys,
        message: restartRequired
          ? "Hot-reloadable settings applied. Some saved settings still require a server restart."
          : "Hot-reloadable settings applied."
      };
    }
  };

  return context;
}

function sameRuntimeSettingValue(
  key: EditableRuntimeSetting,
  previous: string | undefined,
  next: string | undefined
): boolean {
  if (key === "MEMORY_REPOSITORY") {
    return normalizeMemoryRepository(previous) === normalizeMemoryRepository(next);
  }
  if (key === "EVENT_BUS") {
    return normalizeEventBus(previous) === normalizeEventBus(next);
  }
  if (key === "OUTPUT_LANGUAGE") {
    return normalizeCharacterOutputLanguage(previous) === normalizeCharacterOutputLanguage(next);
  }
  return (previous ?? "").trim() === (next ?? "").trim();
}

function normalizeMemoryRepository(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized === "memory" ? "in-memory" : (normalized ?? "");
}

function normalizeEventBus(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized === "memory" ? "in-memory" : (normalized ?? "");
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1" || value === "yes";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseStrictPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMemoryExtractorMode(value: string | undefined): "rule-based" | "llm" {
  return value === "llm" ? "llm" : "rule-based";
}

function unavailableMemoryProvider(): MemoryProvider {
  return {
    async retrieveRelevant() {
      return { status: "unavailable", events: [], source: "none", limited: false };
    },
    async getEvent() {
      return null;
    },
    async writeEvent() {
      return {
        status: "rejected",
        errorCode: "MEMORY_PROVIDER_UNAVAILABLE",
        failureClass: "definitive_rejection"
      };
    }
  };
}

function createRuntimeLogger(logger: FastifyBaseLogger): RuntimeLogger {
  return {
    info(message, context) {
      logger.info(context ?? {}, message);
    },
    warn(message, context) {
      logger.warn(context ?? {}, message);
    },
    error(message, context) {
      logger.error(context ?? {}, message);
    }
  };
}
