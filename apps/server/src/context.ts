import {
  expandMemorySearch,
  assessEvidenceSupport,
  type MemoryRetrievalInput
} from "@companion/memory";
import { MemoryAuthorityError } from "@companion/memory";
import { observationRetentionConfig } from "./config.js";
import { HostObservationContinuity } from "./observation-continuity.js";
import { personAuthorityRevision } from "./services/product-store.js";
import { ConversationHostIdentity } from "./conversation-host-identity.js";
import {
  MemoryDecisionReassessment,
  assertMemoryAuthorityDatabase,
  MemoryIntegrityAudit,
  PostgresMemoryAuthority,
  PostgresMemoryProvider,
  SemanticMemoryPolicy,
  MemoryVectorIndexer,
  embeddingModelTag,
  type AuthorityPool
} from "@companion/memory";
import {
  preserveCharacterEnvironment,
  type CharacterComposition
} from "./character-composition.js";
import { claimCharacterFiles, claimCharacterDatabase } from "./character-storage.js";
import { PRIMARY_CHARACTER, characterPersonaId } from "@companion/core";
import { PostgresContextUseRepository, contextUseDigest } from "@companion/memory";
import type { ContextSourceUse } from "@companion/protocol";
import { HostPresentationEffects } from "./presentation-effects.js";
import { HostMediaEffects } from "./media-effects.js";
import { HostOutwardEffects } from "./outward-effects.js";
import { HostReadTextEffects } from "./read-text-effect.js";
import {
  HostProductPersonCommandEffects,
  type NativeControlOwnerHandler,
  type P8CorrectionProtectedCommand,
  type ProductPersonCommandPort,
  type VoiceBindingProtectedCommand,
  type AcousticProfileProtectedCommand
} from "./product-person-command-effects.js";
import {
  buildMemoryScope,
  projectFinalizedEffectIntent,
  projectDreamEffectIntents
} from "@companion/memory";
import {
  HostEffectIntentAdmission,
  PostgresEffectIntentStore,
  PostgresEffectDispatchStore,
  type EffectAttemptV1,
  type EffectEvidence,
  type EffectIntent,
  type EffectIntentAdmissionPort,
  type NativeOwnerCommitV1
} from "@companion/effects";
import { JournalMemoryGroundingResolver } from "@companion/memory";
import {
  productEnvironment,
  readProductSettings,
  type ProductSettings
} from "./services/product-store.js";
import { join } from "node:path";
import { createPostgresPool } from "@companion/database";
import { PostgresJournalRepository, JournalStoreError } from "@companion/journal";
import {
  HostConversationalReceiptAdmission,
  type ConversationalReceiptAdmission
} from "./conversational-receipt-admission.js";
import {
  HostSpeechReceiptAdmission,
  type SpeechReceiptAdmission
} from "./speech-receipt-admission.js";
import {
  HostVisionReceiptAdmission,
  type VisionReceiptAdmission
} from "./vision-receipt-admission.js";
import {
  HostProductControlReceiptAdmission,
  type ProductControlReceiptAdmission
} from "./product-control-receipt-admission.js";
import {
  HostRuntimeControlReceiptAdmission,
  type RuntimeControlReceiptAdmission
} from "./runtime-control-receipt-admission.js";
import {
  HostProactiveConsentReceiptAdmission,
  type ProactiveConsentReceiptAdmission
} from "./proactive-consent-receipt-admission.js";
import {
  HostProactiveTurnReceiptAdmission,
  type ProactiveTurnReceiptAdmission
} from "./proactive-turn-receipt-admission.js";
import { HostTtsReceiptAdmission, type TtsReceiptAdmission } from "./tts-receipt-admission.js";
import {
  HostVoiceControlReceiptAdmission,
  type VoiceControlReceiptAdmission
} from "./voice-control-receipt-admission.js";
import {
  getRuntimeEnvDir,
  parseMemoryExtractorDriver,
  parseRuntimeConfig
} from "@companion/config";
import { createFileP8CorrectionStore, createFileVoiceBindingReferences } from "@companion/core";
import { captureKdeScreen, screenCaptureAvailable } from "./screen-capture.js";
import type {
  RuntimeReplyStreamEvent,
  RuntimeLogger,
  RuntimeCharacterCognitionExecutor
} from "@companion/core";
import { RuntimeOrchestrator, type RuntimeProactiveStateStore } from "@companion/core";
import { productVoiceProfiles } from "./services/packaged-voice.js";
import { combineVoiceCommandSamples, readVoiceCommandSamples } from "./services/voice-review.js";
import type { P8ExplicitCorrection, P8NativeCorrectionReceipt } from "@companion/p8";
import type { ControllerBindingCommand, ControllerBindingCommandReceipt } from "@companion/memory";
import type {
  VoiceProfileNativeCommand,
  VoiceProfileNativeCommandReceipt
} from "@companion/providers";
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
  InMemoryEvidenceAdmissionStore,
  PostgresEvidenceAdmissionStore,
  bootstrapPostgresEvidenceAdmissions,
  InMemoryProfileSnapshotStore,
  InMemoryProfileLifecycleStore,
  LocalProfileProvider,
  PostgresProfileSnapshotStore,
  PostgresProfileLifecycleStore,
  ProfileLifecycleCoordinator,
  ScopePeopleModelReader,
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
  type ProfileProvider,
  type ProfileSnapshotStore,
  type CapturedProfileComposition,
  type ProfileLifecycleStore,
  type RecentEpisodeStore
} from "@companion/memory";
import { normalizeCharacterOutputLanguage } from "@companion/character-abi";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createProviderRegistryFromEnv,
  withProviderWorkContext,
  type ProviderRegistry,
  type ProviderStatusMap
} from "@companion/providers";
import type { FastifyBaseLogger } from "fastify";
import { loadServerConfig, type ServerConfig } from "./config.js";
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
  effectIntents: EffectIntentAdmissionPort;
  outwardEffects: HostOutwardEffects;
  mediaEffects: HostMediaEffects;
  presentationEffects: HostPresentationEffects;
  readTextEffects: HostReadTextEffects;
  existingMemoryEffectIntents: {
    finalized(
      finalizedTurnId: string
    ): Promise<import("@companion/effects").ExistingEffectIntent[]>;
    dream(jobId: string): Promise<import("@companion/effects").ExistingEffectIntent[]>;
  };
  eventBus: InMemoryEventBus;
  dashboard: DashboardStateService;
  memoryRepository: MemoryRepository;
  conversationRepository: ConversationRepository;
  finalizedIngestionRepository: FinalizedIngestionRepository;
  conversationalReceiptAdmission: ConversationalReceiptAdmission;
  conversationHost?: ConversationHostIdentity | undefined;
  observations?: HostObservationContinuity | undefined;
  memoryIntegrity?: MemoryIntegrityAudit | undefined;
  speechReceiptAdmission: SpeechReceiptAdmission;
  visionReceiptAdmission: VisionReceiptAdmission;
  productControlReceiptAdmission: ProductControlReceiptAdmission;
  productPersonCommands: ProductPersonCommandPort;
  runtimeControlReceiptAdmission: RuntimeControlReceiptAdmission;
  proactiveConsentReceiptAdmission: ProactiveConsentReceiptAdmission;
  proactiveTurnReceiptAdmission: ProactiveTurnReceiptAdmission;
  ttsReceiptAdmission: TtsReceiptAdmission;
  voiceControlReceiptAdmission: VoiceControlReceiptAdmission;
  closeDatabasePool(): Promise<void>;
  finalizedIngestion: FinalizedIngestionService;
  memoryIngestionCoordinator: MemoryIngestionCoordinator;
  memory: MemoryService;
  profileProvider: ProfileProvider;
  profileLifecycleStore: ProfileLifecycleStore;
  profileLifecycle: ProfileLifecycleCoordinator;
  scopePeopleModelReader: ScopePeopleModelReader;
  providers: ProviderRegistry;
  runtime: RuntimeOrchestrator;
  embodiedPresentationBridge: EmbodiedPresentationBridge;
  activeMemoryRepository: string;
  activeRuntimeEnv: Record<string, string | undefined>;
  memoryMaintenanceScheduler?: MemoryMaintenanceScheduler | undefined;
  subscribeProactiveStream(listener: (event: RuntimeReplyStreamEvent) => unknown): () => void;
  reloadRuntimeConfig(
    env: Record<string, string | undefined>,
    productSnapshot?: ProductSettings | null
  ): Promise<RuntimeConfigReloadResult>;
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
  pluginCapabilities?: ServerPluginRuntimeCapabilitySurface,
  composition?: CharacterComposition
): Promise<AppContext> {
  if (config.eventBus === "nats") {
    throw new Error("EVENT_BUS=nats is reserved for future NATS support and is not implemented.");
  }

  const bootstrapEnv = composition?.env ?? process.env;
  const bootProductSettings = readProductSettings(bootstrapEnv);
  const productEnv = productEnvironment(
    (await readRuntimeEnvFiles({ env: bootstrapEnv })).env,
    bootProductSettings
  );
  const bootEnv = composition ? preserveCharacterEnvironment(composition, productEnv) : productEnv;
  claimCharacterFiles(composition?.binding ?? PRIMARY_CHARACTER, bootEnv, !composition);
  let releaseDatabaseOwner: () => Promise<void> = async () => {};
  for (const key of [
    "YUVI_PRODUCT_CONFIGURATION",
    "MEMORY_SUBJECT_USER_ID",
    "MEMORY_PERSONA_ID",
    "PROACTIVE_SCORE_THRESHOLD",
    "PROACTIVE_EVALUATION_INTERVAL_MS"
  ]) {
    if (!composition && bootEnv[key] !== undefined) process.env[key] = bootEnv[key];
  }
  const eventBus = new InMemoryEventBus();
  const proactiveListeners = new Set<(event: RuntimeReplyStreamEvent) => unknown>();
  const embodiedPresentationBridge = new EmbodiedPresentationBridge(eventBus);
  const dashboard = new DashboardStateService();
  eventBus.subscribe("*", (event) => {
    dashboard.recordEvent(event);
  });
  const activeMemoryRepository = parseMemoryRepositoryEnv(bootEnv).kind;
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
  const databaseUrl = bootEnv["DATABASE_URL"]?.trim();
  const databasePool = databaseUrl ? createPostgresPool(databaseUrl) : undefined;
  try {
    releaseDatabaseOwner = await claimCharacterDatabase(
      databasePool,
      composition?.binding ?? PRIMARY_CHARACTER,
      !composition
    );
  } catch (error) {
    await databasePool?.end();
    throw error;
  }
  const profileSnapshotStore: ProfileSnapshotStore = databasePool
    ? new PostgresProfileSnapshotStore(databasePool)
    : new InMemoryProfileSnapshotStore();
  const profileLifecycleStore: ProfileLifecycleStore = databasePool
    ? new PostgresProfileLifecycleStore(databasePool)
    : new InMemoryProfileLifecycleStore();
  const journalNamespace = bootEnv["YUVI_JOURNAL_NAMESPACE"] ?? "yuvi:default";
  const journalRepository = databasePool
    ? new PostgresJournalRepository(databasePool, {
        namespace: journalNamespace,
        // Per-request conversational authority is supplied only through the host-owned
        // A8.2b admission facade; generic producer appends remain fail-closed.
        authorityBuilder() {
          throw new JournalStoreError(
            "INVALID_PROPOSAL",
            "Journal writes require a host-owned admission boundary."
          );
        }
      })
    : null;
  // Production never substitutes process-local decisions for durable A9 authority.
  const effectIntents = new HostEffectIntentAdmission(
    databasePool ? new PostgresEffectIntentStore(databasePool) : null,
    journalRepository
  );
  const effectDispatchStore = databasePool ? new PostgresEffectDispatchStore(databasePool) : null;
  const readTextEffects = new HostReadTextEffects(
    effectIntents,
    effectDispatchStore,
    journalRepository
  );
  const outwardEffects = new HostOutwardEffects(
    effectIntents,
    effectDispatchStore,
    readTextEffects.dispatcher,
    journalRepository,
    journalNamespace
  );
  const conversationHost =
    databasePool && journalRepository && parseRuntimeConfig(bootEnv).memory.backend === "postgres"
      ? new ConversationHostIdentity(
          databasePool as AuthorityPool,
          journalRepository,
          {
            instanceId: composition?.binding.instanceId ?? PRIMARY_CHARACTER.instanceId,
            personaId: composition
              ? characterPersonaId(composition.binding)
              : (parseRuntimeConfig(bootEnv).memory.personaId ??
                characterPersonaId(PRIMARY_CHARACTER))
          },
          (id) => {
            if (composition?.people) {
              const person = composition.people.readPerson(id);
              return person?.authorityRevision ?? person?.revision ?? null;
            }
            const settings = readProductSettings(bootEnv);
            return personAuthorityRevision(settings, id);
          }
        )
      : undefined;
  const conversationalReceiptAdmission = new HostConversationalReceiptAdmission(
    journalRepository,
    undefined,
    conversationHost
  );
  const speechReceiptAdmission = new HostSpeechReceiptAdmission(journalRepository);
  const visionReceiptAdmission = new HostVisionReceiptAdmission(journalRepository);
  const productControlReceiptAdmission = new HostProductControlReceiptAdmission(journalRepository);
  const productPersonCommands = new HostProductPersonCommandEffects(
    databasePool ?? null,
    journalRepository,
    effectIntents,
    effectDispatchStore,
    readTextEffects.dispatcher,
    journalNamespace,
    composition ? ["P8_CORRECTION"] : undefined
  );
  const runtimeControlReceiptAdmission = new HostRuntimeControlReceiptAdmission(journalRepository);
  const proactiveConsentReceiptAdmission = new HostProactiveConsentReceiptAdmission(
    journalRepository
  );
  const proactiveTurnReceiptAdmission = new HostProactiveTurnReceiptAdmission(journalRepository);
  const ttsReceiptAdmission = new HostTtsReceiptAdmission(journalRepository);
  const voiceControlReceiptAdmission = new HostVoiceControlReceiptAdmission(journalRepository);
  const memoryRepository = createMemoryRepositoryFromEnv(bootEnv, databasePool);
  let conversationRepository: ConversationRepository | undefined;
  const verifySourceAuthority = async (ref: import("@companion/protocol").JournalEventRef) => {
    const source = await journalRepository?.get(ref);
    if (!source) return false;
    const binding = source.authority.binding;
    // Anonymous operations retain their separate Host policy and cannot gain Memory access.
    if (binding.state !== "RESOLVED") return true;
    if (!conversationHost) return true;
    const personaId = composition
      ? characterPersonaId(composition.binding)
      : (parseRuntimeConfig(bootEnv).memory.personaId ?? characterPersonaId(PRIMARY_CHARACTER));
    return Boolean(
      await conversationHost.readAuthority(ref, buildMemoryScope(binding.personId, personaId))
    );
  };
  outwardEffects.verifySourceAuthority = verifySourceAuthority;
  readTextEffects.verifySourceAuthority = verifySourceAuthority;

  const observations =
    databasePool && journalRepository && conversationHost
      ? new HostObservationContinuity(
          databasePool as AuthorityPool,
          journalRepository,
          conversationHost,
          composition
            ? characterPersonaId(composition.binding)
            : (parseRuntimeConfig(bootEnv).memory.personaId ??
                characterPersonaId(PRIMARY_CHARACTER)),
          observationRetentionConfig(bootEnv)
        )
      : undefined;
  if (observations) {
    readTextEffects.projectObservation = (input, attemptId, result) => {
      const text = result.content
        .filter((p): p is { type: "text"; text: string } =>
          Boolean(
            p &&
            typeof p === "object" &&
            "type" in p &&
            p.type === "text" &&
            "text" in p &&
            typeof p.text === "string"
          )
        )
        .map((p) => p.text)
        .join("\n");
      return observations.projectReadText(
        { sourceJournalRef: input.cause, sessionId: "" },
        attemptId,
        text
      );
    };
    outwardEffects.projectProviderResult = (task, attemptId, output) =>
      observations.projectVision(
        { sourceJournalRef: task.context?.cause, sessionId: "" },
        attemptId,
        output as import("@companion/providers").VisionOutput,
        task.transientInput as import("@companion/providers").VisionInput
      );
  }

  let finalizedIngestionRepository: FinalizedIngestionRepository | undefined;
  try {
    conversationRepository = createConversationRepositoryFromEnv(
      bootEnv,
      databasePool ?? memoryRepository.getDatabaseClient?.()
    );
    conversationRepository?.setPublicationAdmission?.(outwardEffects.admitReplyPublications);
    if (
      parseRuntimeConfig(bootEnv).memory.backend === "postgres" &&
      (!databasePool ||
        !journalRepository?.appendWithHostAuthorityInTransaction ||
        !conversationRepository.appendAcceptedUserInTransaction)
    )
      throw Error("MEMORY_ACCEPTED_SOURCE_TRANSACTION_REQUIRED");
    finalizedIngestionRepository = createFinalizedIngestionRepositoryFromEnv(
      bootEnv,
      databasePool ?? memoryRepository.getDatabaseClient?.(),
      parseRuntimeConfig(bootEnv).memory.backend === "postgres"
        ? composition
          ? characterPersonaId(composition.binding)
          : (parseRuntimeConfig(bootEnv).memory.personaId ?? characterPersonaId(PRIMARY_CHARACTER))
        : undefined
    );
  } catch (error) {
    await conversationRepository?.close?.();
    await memoryRepository.close?.();
    await releaseDatabaseOwner();
    await databasePool?.end();
    throw error;
  }
  if (
    databasePool &&
    journalRepository?.appendWithHostAuthorityInTransaction &&
    conversationRepository.appendAcceptedUserInTransaction &&
    parseRuntimeConfig(bootEnv).memory.backend === "postgres"
  ) {
    conversationalReceiptAdmission.commitAcceptedSource = async (
      input,
      append,
      authority,
      identity
    ) => {
      const tx = await databasePool.connect();
      const ignoreDisconnect = () => {};
      tx.on("error", ignoreDisconnect);
      try {
        await tx.query("begin");
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          journalRepository.namespace + ":accepted-user:" + input.runtimeEventId
        ]);
        if (identity && !(await conversationHost?.lockCurrentGrant(identity, tx)))
          throw new JournalStoreError(
            "INVALID_PROPOSAL",
            "Host credential revoked before source acceptance."
          );
        const existing = (
          await tx.query("select * from conversation_messages where id=$1", [input.runtimeEventId])
        ).rows[0];
        if (existing) {
          const ref = existing["source_journal_ref"] as
            | import("@companion/protocol").JournalEventRef
            | undefined;
          const old = ref ? await journalRepository.get(ref) : null;
          const sameOwner =
            old &&
            contextUseDigest(old.authority.principal) === contextUseDigest(authority.principal) &&
            contextUseDigest(old.authority.binding) === contextUseDigest(authority.binding) &&
            contextUseDigest(old.authority.audience) === contextUseDigest(authority.audience);
          if (
            !sameOwner ||
            existing["session_id"] !== input.sessionId ||
            existing["trace_id"] !== (input.traceId ?? input.runtimeEventId) ||
            existing["content"] !== input.content ||
            existing["ingestion_requested"] !== Boolean(input.memoryWriteRequested && identity)
          )
            throw new JournalStoreError(
              "SOURCE_DEDUP_CONFLICT",
              "Accepted source ID conflicts with its immutable original."
            );
          await tx.query("commit");
          return { status: "DEDUPLICATED", envelope: old! };
        }
        const receipt = await journalRepository.appendWithHostAuthorityInTransaction!(
          tx,
          append,
          authority
        );
        const requested = Boolean(input.memoryWriteRequested && identity);
        await conversationRepository.appendAcceptedUserInTransaction!(tx, {
          id: input.runtimeEventId,
          sessionId: input.sessionId,
          traceId: input.traceId ?? input.runtimeEventId,
          parentMessageId: null,
          role: "user",
          content: input.content,
          status: "completed",
          createdAt: receipt.envelope.recordedAt,
          completedAt: receipt.envelope.recordedAt,
          sourceJournalRef: {
            kind: "JOURNAL_EVENT",
            namespace: receipt.envelope.journalNamespace,
            eventId: receipt.envelope.eventId
          },
          sourceUserEventId: input.runtimeEventId,
          finalizedTurnId: `accepted-user:${input.runtimeEventId}`,
          personaId: identity?.personaId ?? null,
          subjectUserId: identity?.personId ?? null,
          ingestionRequested: requested,
          ingestionSkipReason: requested
            ? null
            : input.memoryWriteRequested
              ? "authority-unresolved"
              : "memory-disabled",
          metadata: {
            ...(!input.memoryWriteRequested ? { memoryWriteDisabled: true } : {}),
            ...(input.hasImageAttachment ? { memoryEphemeral: true } : {})
          }
        });
        await tx.query("commit");
        // Polling recovers even if the process exits before this wake.
        try {
          coordinator?.wake();
        } catch {
          runtimeLogger.warn?.(
            "Accepted source committed; wake unavailable, polling will recover",
            { runtimeEventId: input.runtimeEventId }
          );
        }
        return receipt;
      } catch (error) {
        await tx.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        tx.removeListener("error", ignoreDisconnect);
        tx.release();
      }
    };
  }
  // One host authority survives provider/settings composition replacement.
  const evidenceAdmissionDatabase = databasePool ?? memoryRepository.getDatabaseClient?.();
  const evidenceAdmissions = evidenceAdmissionDatabase
    ? new PostgresEvidenceAdmissionStore(evidenceAdmissionDatabase)
    : new InMemoryEvidenceAdmissionStore();
  const evidenceAdmissionReady = evidenceAdmissionDatabase
    ? bootstrapPostgresEvidenceAdmissions(evidenceAdmissionDatabase, evidenceAdmissions)
    : Promise.resolve();
  void evidenceAdmissionReady.catch(() => undefined);
  outwardEffects.setContextUseRepository(
    databasePool ? new PostgresContextUseRepository(databasePool) : null
  );
  readTextEffects.captureContext = (key, input) =>
    outwardEffects.captureOperationContext(key, "read_text_file", input);
  const promptBuilder = new PromptBuilder();
  const recentEpisodeStore: RecentEpisodeStore = createRecentEpisodeStoreFromEnv(
    bootEnv,
    databasePool
  );
  const dreamJobStore: DreamJobStore =
    parseMemoryRepositoryEnv(bootEnv).kind === "postgres" && databasePool
      ? new PostgresDreamJobStore(databasePool)
      : new InMemoryDreamJobStore();
  const finalizedIngestion = new FinalizedIngestionService(
    finalizedIngestionRepository!,
    {
      build: (input) => memory.getIngestionPolicy().build(input),
      get semanticOnly() {
        return memory.getBackendKind() === "postgres";
      }
    },
    journalRepository ? new JournalMemoryGroundingResolver(journalRepository) : undefined,
    async (input, source) => {
      if (
        !input.sourceUserEventId ||
        !conversationRepository.listMessagesBefore ||
        !journalRepository
      )
        return [];
      // The Host session fence prevents another actor joining this conversation.
      // Recheck every user source; assistant text is interpretation only.
      const rows = await conversationRepository.listMessagesBefore(input.sourceUserEventId, {
        limit: 12,
        maxCharacters: 12000
      });
      const context: NonNullable<
        import("@companion/memory").MemoryIngestionInput["dialogueContext"]
      > = [];
      for (const row of rows) {
        if (
          row.status !== "completed" ||
          row.metadata["memoryWriteDisabled"] === true ||
          row.metadata["memoryEphemeral"] === true ||
          row.metadata["observationDependent"] === true
        )
          continue;
        if (row.role === "user") {
          if (!row.sourceJournalRef) continue;
          const prior = await new JournalMemoryGroundingResolver(journalRepository).resolve({
            sourceJournalRef: row.sourceJournalRef,
            sourceText: row.content
          });
          if (
            contextUseDigest(prior.authority.principal) !==
              contextUseDigest(source.authority.principal) ||
            contextUseDigest(prior.authority.binding) !==
              contextUseDigest(source.authority.binding) ||
            contextUseDigest(prior.authority.audience) !==
              contextUseDigest(source.authority.audience)
          )
            continue;
        }
        context.push({
          id: row.id,
          role: row.role,
          content: row.content,
          ...(row.sourceJournalRef ? { sourceJournalRef: row.sourceJournalRef } : {})
        });
      }
      return context;
    }
  );
  const ruleBasedExtractor = new RuleBasedMemoryExtractor();
  const runtimeLogger = createRuntimeLogger(logger);
  const proactiveStateStore: RuntimeProactiveStateStore = createFileProactiveStateStore(bootEnv);
  let profileLifecycleCoordinator: ProfileLifecycleCoordinator;

  function createMemoryService(
    providers: ProviderRegistry,
    extractorMode = config.memoryExtractor,
    env: Record<string, string | undefined> = bootEnv
  ): MemoryService {
    const reasoningStatus = providers.getStatus().providers.reasoning;
    const memoryExtractor: import("@companion/memory").MemoryExtractor =
      extractorMode === "llm"
        ? new LlmMemoryExtractor(providers.getReasoningProvider(), ruleBasedExtractor, {
            enabled: true,
            providerConfigured: Boolean(reasoningStatus.configured && !reasoningStatus.mock),
            providerName: reasoningStatus.provider,
            logger: runtimeLogger,
            includeRawPreview: config.runtimeMode === "development",
            withSourceContext: (source, scope, call) =>
              withProviderWorkContext(
                {
                  scope,
                  cause: source.parent,
                  isCurrent: () => memory === service
                },
                call
              )
          })
        : ruleBasedExtractor;

    const runtimeConfig = parseRuntimeConfig(env);
    const backendKind =
      runtimeConfig.memory.backend === "postgres"
        ? "postgres"
        : runtimeConfig.memory.backend === "mem0"
          ? "mem0"
          : "legacy";
    const embeddingProvider = providers.getEmbeddingProvider();
    const vectorEnabled =
      backendKind === "postgres" &&
      embeddingProvider.dimensions === 512 &&
      !embeddingProvider.mock &&
      (providers.getStatus().routes?.embedding ?? []).some(
        (r) => r.enabled && r.configured && !r.mock
      );
    const authority =
      backendKind === "postgres"
        ? new PostgresMemoryAuthority(
            (databasePool ?? memoryRepository.getDatabaseClient?.()) as AuthorityPool,
            vectorEnabled ? embeddingModelTag(embeddingProvider) : undefined
          )
        : undefined;
    if (authority)
      authority.authorizeSource = async (event, transaction) => {
        const lineage = event.lineage;
        if (lineage?.state !== "GROUNDED" || lineage.parents.length !== 1) return false;
        return Boolean(
          await conversationHost?.readAuthority(lineage.parents[0]!.ref, event.scope, transaction)
        );
      };
    const vectorIndexer =
      authority && vectorEnabled
        ? new MemoryVectorIndexer(
            authority,
            embeddingProvider,
            (event, call) =>
              withProviderWorkContext(
                {
                  scope: event.scope!,
                  authorizationBasis: "HOST_SCOPE_MAINTENANCE",
                  // Configured Host indexing owns this private Character view.
                  // An old transport token is causal evidence, not a perpetual
                  // maintenance credential. Lifecycle/Person removal still fence reads.
                  verifyAuthority: async () => {
                    if (memory !== service) return false;
                    service.getKnowledgeReader(event.scope!);
                    const source = event.lineage;
                    if (
                      source?.state !== "GROUNDED" ||
                      !("authority" in source) ||
                      source.authority.binding.state !== "RESOLVED" ||
                      source.authority.audience.kind !== "PRIVATE"
                    )
                      return false;
                    const id = source.authority.binding.personId;
                    return composition?.people
                      ? composition.people.readPerson(id) !== null
                      : personAuthorityRevision(readProductSettings(bootEnv), id) !== null;
                  },
                  cause:
                    event.lineage?.state === "GROUNDED"
                      ? event.lineage.parents[0]!.ref
                      : (() => {
                          throw new Error("Vector source lineage unavailable");
                        })(),
                  isCurrent: () => memory === service
                },
                call
              ),
            {
              characterId: composition
                ? characterPersonaId(composition.binding)
                : "unbound-postgres",
              journalNamespace: journalRepository?.namespace ?? "unbound-postgres"
            }
          )
        : undefined;
    const guardedMemoryRead = async <T>(
      input: MemoryRetrievalInput,
      work: () => Promise<T>
    ): Promise<T> => {
      const scope = input.scope;
      if (!scope) throw new MemoryAuthorityError("MEMORY_SCOPE_MISSING");
      const verify = async () => {
        try {
          if (memory !== service || !input.scope || !input.access) return false;
          const actual = await conversationHost?.readAuthority(input.sourceJournalRef, input.scope);
          return (
            !!actual &&
            actual.personId === input.access.personId &&
            actual.principal.namespace === input.access.principal.namespace &&
            actual.principal.actorId === input.access.principal.actorId
          );
        } catch {
          return false;
        }
      };
      if (!(await verify())) throw new MemoryAuthorityError("MEMORY_READER_AUTHORITY_UNRESOLVED");
      let result;
      try {
        result = await withProviderWorkContext(
          {
            scope,
            cause: input.sourceJournalRef,
            verifyAuthority: verify,
            isCurrent: () => memory === service
          },
          () => work()
        );
      } catch (error) {
        if (!(await verify())) throw new MemoryAuthorityError("MEMORY_READER_AUTHORITY_REVOKED");
        throw error;
      }
      if (!(await verify())) throw new MemoryAuthorityError("MEMORY_READER_AUTHORITY_REVOKED");
      return result;
    };
    const postgresProvider = authority
      ? new PostgresMemoryProvider(
          authority,
          vectorIndexer,
          config.memoryQueryExpansion
            ? async (input) => {
                return guardedMemoryRead(input, () =>
                  expandMemorySearch(providers.getReasoningProvider(), input.text, input.signal)
                );
              }
            : undefined,
          config.memoryEvidenceSupport
            ? (support) =>
                guardedMemoryRead(support.request, () =>
                  assessEvidenceSupport(providers.getReasoningProvider(), support)
                )
            : undefined
        )
      : undefined;
    const semanticPolicy = postgresProvider
      ? new SemanticMemoryPolicy(
          providers.getReasoningProvider(),
          async (scope, text) => {
            const relevant = await postgresProvider.knowledge.search(scope, text, 32);
            const recent = await postgresProvider.knowledge.page({ scope, limit: 32 });
            const vectorIds = postgresProvider.vectors
              ? await postgresProvider.vectors.search(scope, text, 32).catch(() => [])
              : [];
            const vectorRecords = await Promise.all(
              vectorIds.map((id) => postgresProvider.knowledge.detail(scope, id))
            );
            return [
              ...new Map(
                [
                  ...Array.from({ length: 32 }, (_, i) => [
                    recent.records[i],
                    relevant.records[i],
                    vectorRecords[i]
                  ])
                    .flat()
                    .filter((r): r is NonNullable<typeof r> => r != null)
                ].map((r) => [r.id, r.event])
              ).values()
            ];
          },
          {
            providerConfigured:
              providers
                .getStatus()
                .routes?.reasoning?.some((r) => r.enabled && r.configured && !r.mock) ?? false,
            withSourceContext: async (source, scope, call) => {
              if (!(await conversationHost?.readAuthority(source.parent, scope)))
                throw new MemoryAuthorityError("MEMORY_SOURCE_AUTHORITY_REVOKED");
              const result = await withProviderWorkContext(
                { scope, cause: source.parent, isCurrent: () => memory === service },
                call
              );
              if (!(await conversationHost?.readAuthority(source.parent, scope)))
                throw new MemoryAuthorityError("MEMORY_SOURCE_AUTHORITY_REVOKED");
              return result;
            }
          },
          postgresProvider.authority.pool
        )
      : undefined;
    if (postgresProvider && semanticPolicy && journalRepository)
      postgresProvider.reassessment = new MemoryDecisionReassessment(
        postgresProvider.authority,
        semanticPolicy,
        journalRepository
      );
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
              : {}),
            onProfileMutation: ({ scope, reason }) =>
              profileLifecycleCoordinator.invalidateScope({ scope, reason })
          })
        : undefined;

    if (backendKind === "mem0") {
      runtimeLogger.info("memory backend selected", {
        backend: "mem0",
        mem0BaseUrl: runtimeConfig.memory.mem0BaseUrl,
        searchTimeoutMs: runtimeConfig.memory.mem0TimeoutMs
      });
    }

    const service: MemoryService = new MemoryService(
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
        postgres: postgresProvider,
        ingestionPolicy: semanticPolicy,
        mem0: mem0Backend,
        evidenceAdmissions,
        evidenceAdmissionReady,
        controllerEvidence:
          composition?.voiceBindingOwner ??
          new LocalControllerEvidenceProvider(
            env["YUVI_RUNTIME_DATA_DIR"] || join(getRuntimeEnvDir(env), "data")
          ),
        searchTimeoutMs: runtimeConfig.memory.mem0TimeoutMs,
        writeTimeoutMs: 180_000,
        journalEvidenceReader: journalRepository ?? undefined,
        onProfileMutation: ({ scope, reason }) =>
          profileLifecycleCoordinator.invalidateScope({ scope, reason }),
        logger: runtimeLogger
      }
    );
    service.bindCharacterOwner({
      instanceId: composition?.binding.instanceId ?? PRIMARY_CHARACTER.instanceId,
      personaId: composition ? characterPersonaId(composition.binding) : null
    });
    vectorIndexer?.start();
    return service;
  }

  function createRuntime(
    providers: ProviderRegistry,
    memory: MemoryService,
    directContext = config.directContext,
    runtimeEnv: Record<string, string | undefined> = bootEnv,
    capturedProduct: ProductSettings | null = bootProductSettings
  ): RuntimeOrchestrator {
    const provider = memory.getMemoryProvider?.();
    const outputLanguage = parseRuntimeConfig(runtimeEnv).outputLanguage;
    // Provider substitutions never change the product's control structure.
    const character = createServerCharacterPort();
    const personId = parseRuntimeConfig(runtimeEnv).memory.subjectUserId;
    const sharedPerson = personId ? composition?.people?.readPerson(personId) : null;
    const consumedPerson = capturedProduct?.people.find((p) => p.id === personId);
    const productDependency = composition?.people
      ? sharedPerson
        ? { ...sharedPerson, primary: null, primaryRevision: null }
        : null
      : consumedPerson
        ? {
            person: consumedPerson,
            revision: capturedProduct?.personRevisionById?.[consumedPerson.id] ?? null,
            primary: capturedProduct?.primaryPersonId ?? null,
            primaryRevision: capturedProduct?.primaryPersonRevision ?? null
          }
        : null;
    const contextOwnerSources: ContextSourceUse[] = [
      {
        owner: "PERSON",
        reference: personId ? `person:${personId}` : "person:NOT_USED",
        revision: productDependency?.revision ?? null,
        digest: productDependency ? contextUseDigest(productDependency) : null,
        availability: productDependency
          ? productDependency.revision
            ? "AVAILABLE"
            : "LEGACY_UNLINEAGED"
          : "NOT_USED",
        revisionKind: productDependency?.revision
          ? "NATIVE"
          : productDependency
            ? "OBSERVED_SNAPSHOT"
            : "NOT_USED",
        selection: productDependency ? "SELECTED" : "OMITTED",
        reason: "Product snapshot consumed for Runtime scope selection",
        roots: productDependency?.primaryRevision ? [productDependency.primaryRevision] : []
      }
    ];
    const nextRuntime = new RuntimeOrchestrator({
      ...(composition ? { characterBinding: composition.binding } : {}),
      contextOwnerSources,
      resolveMemoryReadAuthority: conversationHost
        ? (ref, scope) => conversationHost.readAuthority(ref, scope)
        : undefined,
      verifyContextOwners: async () => {
        if (!productDependency) return true;
        if (composition?.people) {
          const current = personId ? composition.people.readPerson(personId) : null;
          return Boolean(
            current &&
            (current.authorityRevision ?? current.revision) ===
              (sharedPerson?.authorityRevision ?? sharedPerson?.revision)
          );
        }
        const current = readProductSettings(bootEnv);
        return (
          personAuthorityRevision(current, personId!) ===
            personAuthorityRevision(capturedProduct, personId!) &&
          current?.primaryPersonId === capturedProduct?.primaryPersonId
        );
      },
      checkContextOwnerFreshness: async () => {
        if (!productDependency) return true;
        if (composition?.people) {
          const person = personId ? composition.people.readPerson(personId) : null;
          return (
            contextUseDigest(
              person ? { ...person, primary: null, primaryRevision: null } : null
            ) === contextUseDigest(productDependency)
          );
        }
        const current = readProductSettings(bootEnv);
        const person = current?.people.find((p) => p.id === personId);
        return (
          contextUseDigest({
            person,
            revision: current?.personRevisionById?.[personId!] ?? null,
            primary: current?.primaryPersonId ?? null,
            primaryRevision: current?.primaryPersonRevision ?? null
          }) === contextUseDigest(productDependency)
        );
      },
      ...(screenCaptureAvailable() ? { captureScreen: captureKdeScreen } : {}),
      eventBus,
      effectIntents,
      voiceBindingReferences: createFileVoiceBindingReferences(
        join(getRuntimeEnvDir(bootEnv), "voice-binding-references.json")
      ),
      voicePersonaId: composition?.voiceBindingPersonaId ?? runtimeEnv["MEMORY_PERSONA_ID"],
      p8CorrectionStore: createFileP8CorrectionStore(
        join(getRuntimeEnvDir(bootEnv), "p8-corrections.json")
      ),
      memory,
      promptBuilder,
      providers,
      now: () => Date.now(),
      proactiveConsentProjectionRequired: true,
      proactiveScoreThreshold: Number(runtimeEnv["PROACTIVE_SCORE_THRESHOLD"] ?? 0.7),
      proactiveEvaluationIntervalMs: Number(
        runtimeEnv["PROACTIVE_EVALUATION_INTERVAL_MS"] ?? 60_000
      ),
      proactiveStateStore,
      conversation: conversationRepository,
      observations,
      finalizedIngestion,
      deferFinalizedMemoryAdmission:
        memory.getBackendKind() === "postgres" ||
        (memory.getExtractorStatus().mode === "llm" && memory.getExtractorStatus().enabled),
      memoryIngestionCoordinator: coordinator,
      memoryRepository: activeMemoryRepository,
      directContext,
      outputLanguage,
      recentEpisodeStore,
      dreamJobStore,
      episodeGroundingResolver: journalRepository
        ? new JournalMemoryGroundingResolver(journalRepository)
        : undefined,
      ...(provider && memory.getBackendKind() !== "postgres" ? { dreamProvider: provider } : {}),
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
                runtimeReadTextIsCurrent: options.runtimeReadTextIsCurrent,
                runtimeReadTextVerifyAuthority: options.runtimeReadTextVerifyAuthority,
                onObservation: options.onObservation,
                readTextEffects,
                effectContext: options.effectContext,
                ...(pluginCapabilities === undefined ? {} : { pluginCapabilities }),
                ...(options?.signal ? { signal: options.signal } : {})
              })
          }
        : {}),
      prepareProviderCause: (operation, scope) => outwardEffects.operationCause(operation, scope),
      synthesizeWholeSpeech: async (reply, input, signal) => {
        const segment = await context.mediaEffects.sealWhole(
          input.text,
          reply.payload.sessionId ?? "default",
          outwardEffects.replyCause(reply.id),
          reply.id
        );
        return context.mediaEffects.synthesize(
          segment,
          input,
          signal ?? new AbortController().signal
        );
      },
      embodiedPresentation: {
        dispatchCanonical: (decision, reply) =>
          context.presentationEffects.dispatch(decision, reply),
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
    nextRuntime.subscribeProactiveStream(async (event) => {
      for (const listener of proactiveListeners) await listener(event);
    });
    return nextRuntime;
  }

  let providers: ProviderRegistry;
  let memory: MemoryService;
  let profileProvider: ProfileProvider;
  let coordinator: MemoryIngestionCoordinator;
  let runtime: RuntimeOrchestrator;
  try {
    profileLifecycleCoordinator = new ProfileLifecycleCoordinator(
      profileLifecycleStore,
      runtimeLogger
    );
    memoryRepository.setProfileMutationNotifier?.(({ scope, reason }) =>
      profileLifecycleCoordinator.invalidateScope({ scope, reason })
    );
    providers = createProviderRegistryFromEnv(bootEnv);
    providers.setAccounting(outwardEffects);
    if (parseRuntimeConfig(bootEnv).memory.backend === "postgres") {
      if (!databasePool) throw new Error("MEMORY_AUTHORITY_DATABASE_REQUIRED");
      await assertMemoryAuthorityDatabase(databasePool, config.runtimeMode === "production");
    }
    memory = createMemoryService(providers);
    const initialComposition = captureProfileComposition(memory, profileSnapshotStore);
    await profileLifecycleCoordinator.replaceComposition(initialComposition);
    profileProvider = new LocalProfileProvider({
      resolveSourceReader: () => memory.getProfileMemorySourceReader(),
      store: profileSnapshotStore
    });
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
    await releaseDatabaseOwner();
    await databasePool?.end();
    throw error;
  }

  const context: AppContext = {
    effectIntents,
    outwardEffects,
    presentationEffects: new HostPresentationEffects(
      databasePool,
      outwardEffects,
      eventBus,
      (replyId) => context.mediaEffects.presentationTarget(replyId)
    ),
    mediaEffects: new HostMediaEffects(
      databasePool,
      outwardEffects,
      () => context.providers,
      (intent, request, observation) =>
        context.runtime.observeAccountedPlayback(intent, request, observation)
    ),
    readTextEffects,
    observations,
    existingMemoryEffectIntents: {
      async finalized(id) {
        return (await finalizedIngestionRepository!.listEvents(id)).map(
          projectFinalizedEffectIntent
        );
      },
      async dream(id) {
        const job = await dreamJobStore.getById(id);
        return job ? projectDreamEffectIntents(job) : [];
      }
    },
    eventBus,
    dashboard,
    memoryRepository,
    conversationRepository: conversationRepository!,
    finalizedIngestionRepository: finalizedIngestionRepository!,
    conversationalReceiptAdmission,
    conversationHost,
    memoryIntegrity:
      memory.getAuthorityInfrastructure() && journalRepository
        ? new MemoryIntegrityAudit(
            memory.getAuthorityInfrastructure()!.authority,
            journalRepository
          )
        : undefined,
    speechReceiptAdmission,
    visionReceiptAdmission,
    productControlReceiptAdmission,
    productPersonCommands,
    runtimeControlReceiptAdmission,
    proactiveConsentReceiptAdmission,
    proactiveTurnReceiptAdmission,
    ttsReceiptAdmission,
    voiceControlReceiptAdmission,
    async closeDatabasePool() {
      await observations?.stop();
      productPersonCommands.shutdown();
      outwardEffects.seal();
      context.mediaEffects.seal();
      context.presentationEffects.seal();
      await memory.stopAuthorityIndexing();
      await readTextEffects.shutdown();
      await profileLifecycleCoordinator.shutdown({ graceMs: 2_000 });
      await releaseDatabaseOwner();
      await databasePool?.end();
    },
    finalizedIngestion,
    memoryIngestionCoordinator: coordinator,
    memory,
    profileProvider,
    profileLifecycleStore,
    profileLifecycle: profileLifecycleCoordinator,
    scopePeopleModelReader: new ScopePeopleModelReader(profileLifecycleCoordinator),
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
    async reloadRuntimeConfig(env, productSnapshot = null) {
      const previousActiveRuntimeEnv = { ...context.activeRuntimeEnv };
      const notHotReloaded = getPendingRestartKeys(env, previousActiveRuntimeEnv);
      const reloadEnv = composition ? preserveCharacterEnvironment(composition, env) : { ...env };
      for (const key of notHotReloaded) {
        if (previousActiveRuntimeEnv[key] === undefined) {
          delete reloadEnv[key];
        } else {
          reloadEnv[key] = previousActiveRuntimeEnv[key];
        }
      }

      const extractorMode = parseMemoryExtractorDriver(reloadEnv["MEMORY_EXTRACTOR"]);
      const nextProviders = createProviderRegistryFromEnv(reloadEnv);
      nextProviders.setAccounting(outwardEffects);
      if (parseRuntimeConfig(reloadEnv).memory.backend === "postgres") {
        if (!databasePool) throw new Error("MEMORY_AUTHORITY_DATABASE_REQUIRED");
        await assertMemoryAuthorityDatabase(databasePool, config.runtimeMode === "production");
      }
      await memory.stopAuthorityIndexing();
      const nextMemory = createMemoryService(nextProviders, extractorMode, reloadEnv);
      const nextProfileComposition = captureProfileComposition(nextMemory, profileSnapshotStore);
      const nextRuntime = createRuntime(
        nextProviders,
        nextMemory,
        loadServerConfig(reloadEnv).directContext,
        reloadEnv,
        productSnapshot
      );

      // Stage all replacements before sealing or mutating the current
      // Runtime. Construction failures therefore leave the live context
      // unchanged.
      context.mediaEffects.invalidateAll();
      context.presentationEffects.invalidateAll();
      await context.runtime.sealAndDrainMemoryWrites();
      nextRuntime.adoptProactiveConsentProjection(context.runtime);
      context.memoryIngestionCoordinator.replaceProvider(
        nextMemory.getMemoryProvider() ?? unavailableMemoryProvider()
      );
      await context.profileLifecycle.replaceComposition(nextProfileComposition, () => {
        context.providers = nextProviders;
        memory = nextMemory;
        context.memory = nextMemory;
        context.runtime = nextRuntime;
        context.runtime.startProactiveScheduler({
          sessionId: "default",
          readMemory: true,
          personaId: parseRuntimeConfig(reloadEnv).memory.personaId,
          subjectUserId: parseRuntimeConfig(reloadEnv).memory.subjectUserId
        });
      });

      const appliedKeys: string[] = [];
      for (const key of editableKeys) {
        if (getRuntimeSettingApplyMode(key) === "hot_reload") {
          if (!sameRuntimeSettingValue(key, previousActiveRuntimeEnv[key], env[key])) {
            appliedKeys.push(key);
          }
          context.activeRuntimeEnv[key] = reloadEnv[key];
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

  productPersonCommands.registerOwnerHandler("VOICE_BINDING", {
    async invoke(raw, intent, attempt, signal) {
      if (raw.family !== "VOICE_BINDING")
        throw new Error("Native voice handler received another family.");
      signal.throwIfAborted();
      const owner = context.memory.getNativeVoiceBindingOwner();
      if (!owner) throw new Error("Native voice binding owner is unavailable.");
      const command = controllerBindingCommand(raw, intent, attempt);
      if (raw.operation !== "REMOVE") {
        const settings = readProductSettings(bootEnv);
        if (!settings) throw new Error("Product Person owner is unavailable.");
        if (!settings.people.some((person) => person.id === raw.personId))
          return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
        const profiles = productVoiceProfiles(context);
        if (!profiles?.readAuthorityState)
          throw new Error("Acoustic profile owner is unavailable.");
        const snapshot = await profiles.readAuthorityState();
        if (!snapshot.complete)
          throw new Error("Acoustic profile owner enumeration is incomplete.");
        if (
          !snapshot.profiles.some((profile) => profile.voiceProfileId === raw.voiceProfileId) ||
          (raw.previousVoiceProfileId !== undefined &&
            !snapshot.profiles.some(
              (profile) => profile.voiceProfileId === raw.previousVoiceProfileId
            ))
        )
          return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
      }
      const fenced = await owner.fenceBindingCommand(command);
      if (fenced === "APPLIED") {
        const reconciled = await owner.reconcileBindingCommand(command);
        if (
          reconciled.status === "ALREADY_APPLIED" &&
          controllerReceiptMatches(reconciled.receipt, command, false)
        )
          return nativeOwnerEvidence(
            "APPLIED",
            "OWNER_RECONCILED_APPLIED",
            controllerOwnerCommit(reconciled.receipt)
          );
        throw new Error("Native voice command receipt is not exact.");
      }
      if (fenced === "CONFLICT")
        return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
      if (fenced !== "READY") throw new Error("Native voice command fence is uncertain.");
      signal.throwIfAborted();
      const result = await owner.applyBindingCommand(command);
      if (
        (result.status === "APPLIED" || result.status === "ALREADY_APPLIED") &&
        controllerReceiptMatches(result.receipt, command, true)
      )
        return nativeOwnerEvidence(
          "APPLIED",
          result.status === "APPLIED" ? "OWNER_COMMITTED" : "OWNER_RECONCILED_APPLIED",
          controllerOwnerCommit(result.receipt)
        );
      if (result.status === "PROVEN_NOT_APPLIED")
        return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
      throw new Error("Native voice owner could not establish an exact result.");
    },
    async reconcile(raw, intent, attempt, signal) {
      if (raw.family !== "VOICE_BINDING")
        throw new Error("Native voice handler received another family.");
      signal.throwIfAborted();
      const owner = context.memory.getNativeVoiceBindingOwner();
      if (!owner) throw new Error("Native voice owner is unavailable.");
      const command = controllerBindingCommand(raw, intent, attempt);
      const result = await owner.reconcileBindingCommand(command);
      if (
        result.status === "ALREADY_APPLIED" &&
        controllerReceiptMatches(result.receipt, command, false)
      )
        return nativeOwnerEvidence(
          "APPLIED",
          "OWNER_RECONCILED_APPLIED",
          controllerOwnerCommit(result.receipt)
        );
      if (result.status === "PROVEN_NOT_APPLIED")
        return nativeOwnerEvidence("PROVEN_NOT_APPLIED", "OWNER_RECONCILED_NOT_APPLIED");
      throw new Error("Native voice command reconciliation is inconclusive.");
    }
  } satisfies NativeControlOwnerHandler);

  productPersonCommands.registerOwnerHandler("P8_CORRECTION", {
    async invoke(raw, intent, attempt, signal) {
      if (raw.family !== "P8_CORRECTION")
        throw new Error("Native P8 handler received another family.");
      signal.throwIfAborted();
      const correction = raw.correction as unknown as P8ExplicitCorrection;
      if (
        correction.correctionReference !== raw.correctionReference ||
        correction.action !== raw.operation
      )
        return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
      const command = p8NativeCommand(raw, intent, attempt);
      const fenced = await context.runtime.fenceP8CorrectionCommand(command);
      if (fenced === "APPLIED") {
        const reconciled = await context.runtime.reconcileP8CorrectionCommand(correction, command);
        if (reconciled.status === "ALREADY_STORED" && p8ReceiptMatches(reconciled.receipt, command))
          return nativeOwnerEvidence(
            "APPLIED",
            "OWNER_RECONCILED_APPLIED",
            p8OwnerCommit(reconciled.receipt)
          );
        throw new Error("Native P8 command receipt is not exact.");
      }
      if (fenced === "CONFLICT")
        return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
      if (fenced !== "READY") throw new Error("Native P8 command fence is uncertain.");
      signal.throwIfAborted();
      const result = await context.runtime.appendP8CorrectionCommand(correction, command);
      if (
        (result.status === "STORED" || result.status === "ALREADY_STORED") &&
        p8ReceiptMatches(result.receipt, command)
      )
        return nativeOwnerEvidence(
          "APPLIED",
          result.status === "STORED" ? "OWNER_COMMITTED" : "OWNER_RECONCILED_APPLIED",
          p8OwnerCommit(result.receipt)
        );
      if (result.status === "PROVEN_NOT_APPLIED" || result.status === "CONFLICT")
        return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
      throw new Error("Native P8 owner could not establish an exact result.");
    },
    async reconcile(raw, intent, attempt, signal) {
      if (raw.family !== "P8_CORRECTION")
        throw new Error("Native P8 handler received another family.");
      signal.throwIfAborted();
      const correction = raw.correction as unknown as P8ExplicitCorrection;
      const command = p8NativeCommand(raw, intent, attempt);
      const result = await context.runtime.reconcileP8CorrectionCommand(correction, command);
      if (
        (result.status === "ALREADY_STORED" || result.status === "STORED") &&
        p8ReceiptMatches(result.receipt, command)
      )
        return nativeOwnerEvidence(
          "APPLIED",
          "OWNER_RECONCILED_APPLIED",
          p8OwnerCommit(result.receipt)
        );
      if (result.status === "PROVEN_NOT_APPLIED")
        return nativeOwnerEvidence("PROVEN_NOT_APPLIED", "OWNER_RECONCILED_NOT_APPLIED");
      throw new Error("Native P8 command reconciliation is inconclusive.");
    }
  } satisfies NativeControlOwnerHandler);

  productPersonCommands.registerOwnerHandler("ACOUSTIC_PROFILE", {
    async invoke(raw, intent, attempt, signal) {
      if (raw.family !== "ACOUSTIC_PROFILE")
        throw new Error("Native acoustic handler received another family.");
      signal.throwIfAborted();
      const profiles = productVoiceProfiles(context);
      if (
        !profiles?.readAuthorityState ||
        !profiles.fenceNativeCommand ||
        !profiles.applyNativeCommand ||
        !profiles.reconcileNativeCommand
      )
        throw new Error("Governed acoustic profile owner is unavailable.");
      const snapshot = await profiles.readAuthorityState();
      if (!snapshot.complete) throw new Error("Acoustic profile enumeration is incomplete.");
      if (raw.operation === "DELETE") {
        const bindings = await context.runtime.getVoiceProfileBindingAuthorityState();
        if (bindings.status !== "AVAILABLE") throw new Error("Voice binding owner is unavailable.");
        if (
          bindings.bindings.some(
            (binding) =>
              binding.voiceProfileId === raw.voiceProfileId && binding.status !== "UNBOUND"
          )
        )
          return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
      }
      const command = acousticProfileNativeCommand(raw, intent, attempt);
      const fenced = await profiles.fenceNativeCommand(command);
      if (fenced === "APPLIED") {
        const reconciled = await profiles.reconcileNativeCommand(command);
        if (
          reconciled.status === "ALREADY_APPLIED" &&
          acousticProfileReceiptMatches(reconciled.receipt, command, false)
        )
          return nativeOwnerEvidence(
            "APPLIED",
            "OWNER_RECONCILED_APPLIED",
            acousticOwnerCommit(reconciled.receipt)
          );
        throw new Error("Native acoustic command receipt is not exact.");
      }
      if (fenced === "CONFLICT")
        return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
      if (fenced !== "READY") throw new Error("Native acoustic command fence is uncertain.");
      const audioBase64 =
        raw.operation === "ENROLL"
          ? combineVoiceCommandSamples(
              readVoiceCommandSamples(raw.sampleReferences ?? [], raw.sampleDigests ?? [])
            )
          : undefined;
      signal.throwIfAborted();
      const result = await profiles.applyNativeCommand({
        ...command,
        ...(raw.label ? { label: raw.label } : {}),
        ...(audioBase64 ? { audioBase64 } : {})
      });
      if (
        (result.status === "APPLIED" || result.status === "ALREADY_APPLIED") &&
        acousticProfileReceiptMatches(result.receipt, command, true)
      )
        return nativeOwnerEvidence(
          "APPLIED",
          result.status === "APPLIED"
            ? result.cleanupPending
              ? "OWNER_COMMITTED_CLEANUP_PENDING"
              : "OWNER_COMMITTED"
            : "OWNER_RECONCILED_APPLIED",
          acousticOwnerCommit(result.receipt)
        );
      if (result.status === "PROVEN_NOT_APPLIED")
        return nativeOwnerEvidence("DEFINITIVE_REJECTION", "OWNER_REJECTED");
      throw new Error("Native acoustic owner could not establish an exact result.");
    },
    async reconcile(raw, intent, attempt, signal) {
      if (raw.family !== "ACOUSTIC_PROFILE")
        throw new Error("Native acoustic handler received another family.");
      signal.throwIfAborted();
      const profiles = productVoiceProfiles(context);
      if (!profiles?.reconcileNativeCommand)
        throw new Error("Native acoustic owner is unavailable.");
      const command = acousticProfileNativeCommand(raw, intent, attempt);
      const result = await profiles.reconcileNativeCommand(command);
      if (
        result.status === "ALREADY_APPLIED" &&
        acousticProfileReceiptMatches(result.receipt, command, false)
      )
        return nativeOwnerEvidence(
          "APPLIED",
          result.cleanupPending
            ? "OWNER_RECONCILED_APPLIED_CLEANUP_PENDING"
            : "OWNER_RECONCILED_APPLIED",
          acousticOwnerCommit(result.receipt)
        );
      if (
        result.status === "PROVEN_NOT_APPLIED" &&
        result.reason === "EXACT_PREDECESSOR_REMAINS" &&
        result.revision === command.expectedRevision
      )
        return nativeOwnerEvidence("PROVEN_NOT_APPLIED", "OWNER_RECONCILED_NOT_APPLIED");
      throw new Error("Native acoustic command reconciliation is inconclusive.");
    }
  } satisfies NativeControlOwnerHandler);

  return context;
}

function nativeOwnerEvidence(
  certainty: EffectEvidence["certainty"],
  reason:
    | "OWNER_COMMITTED"
    | "OWNER_COMMITTED_CLEANUP_PENDING"
    | "OWNER_REJECTED"
    | "OWNER_RECONCILED_APPLIED"
    | "OWNER_RECONCILED_APPLIED_CLEANUP_PENDING"
    | "OWNER_RECONCILED_NOT_APPLIED",
  nativeOwnerCommit?: NativeOwnerCommitV1
): EffectEvidence {
  return {
    certainty,
    layer:
      certainty === "DEFINITIVE_REJECTION"
        ? "NATIVE_OWNER_RECONCILIATION"
        : reason === "OWNER_COMMITTED" || reason === "OWNER_COMMITTED_CLEANUP_PENDING"
          ? "NATIVE_OWNER_COMMIT"
          : "NATIVE_OWNER_RECONCILIATION",
    reason,
    remoteEffectId: null,
    ...(nativeOwnerCommit ? { nativeOwnerCommit } : {})
  };
}

function controllerOwnerCommit(receipt: ControllerBindingCommandReceipt): NativeOwnerCommitV1 {
  return {
    version: "native-owner-commit.v1",
    ownerFamily: "VOICE_BINDING",
    targetReference: receipt.voiceProfileId,
    revisions: Object.entries(receipt.resultingRevisionByScope).map(([scope, revision]) => ({
      ownerReference: scope,
      revision
    })),
    eventIds: receipt.eventIds
  };
}

function p8OwnerCommit(receipt: P8NativeCorrectionReceipt): NativeOwnerCommitV1 {
  return {
    version: "native-owner-commit.v1",
    ownerFamily: "P8_CORRECTION",
    targetReference: receipt.correctionReference,
    revisions: [
      { ownerReference: receipt.correctionReference, revision: receipt.resultingRevision }
    ],
    eventIds: [receipt.correctionReference]
  };
}

function acousticOwnerCommit(receipt: VoiceProfileNativeCommandReceipt): NativeOwnerCommitV1 {
  return {
    version: "native-owner-commit.v1",
    ownerFamily: "ACOUSTIC_PROFILE",
    targetReference: receipt.voiceProfileId,
    revisions: [
      { ownerReference: "speaker-store-generation", revision: receipt.resultingRevision }
    ],
    eventIds: []
  };
}

function controllerBindingCommand(
  raw: VoiceBindingProtectedCommand,
  intent: EffectIntent,
  attempt: EffectAttemptV1
): ControllerBindingCommand {
  const payload = intent.request.payload as { payloadDigest: string };
  const causal = intent.request.causalRefs[0];
  if (!causal || causal.kind !== "JOURNAL_EVENT")
    throw new Error("Native voice command has no committed CONTROL receipt.");
  return {
    commandHandle: raw.commandHandle,
    intentId: intent.intentId,
    attemptId: attempt.attemptId,
    fence: attempt.fence,
    payloadDigest: payload.payloadDigest,
    causalRefs: [causal],
    operation: raw.operation,
    voiceProfileId: raw.voiceProfileId,
    personaId: raw.personaId,
    ...(raw.personId ? { personId: raw.personId } : {}),
    ...(raw.previousVoiceProfileId ? { previousVoiceProfileId: raw.previousVoiceProfileId } : {}),
    ...(raw.previousPersonaId ? { previousPersonaId: raw.previousPersonaId } : {}),
    expectedBindingRevision: raw.expectedBindingRevision,
    ...(raw.expectedPreviousBindingRevision !== undefined
      ? { expectedPreviousBindingRevision: raw.expectedPreviousBindingRevision }
      : {})
  };
}

function controllerReceiptMatches(
  receipt: ControllerBindingCommandReceipt,
  command: ControllerBindingCommand,
  exactFence: boolean
) {
  return (
    receipt.commandHandle === command.commandHandle &&
    receipt.intentId === command.intentId &&
    receipt.attemptId === command.attemptId &&
    BigInt(receipt.fence) <= BigInt(command.fence) &&
    (!exactFence || receipt.fence === command.fence) &&
    receipt.payloadDigest === command.payloadDigest &&
    receipt.operation === command.operation &&
    receipt.voiceProfileId === command.voiceProfileId &&
    receipt.previousVoiceProfileId === (command.previousVoiceProfileId ?? null) &&
    (receipt.previousPersonaId ?? null) ===
      (command.previousVoiceProfileId ? (command.previousPersonaId ?? command.personaId) : null) &&
    receipt.personId === (command.operation === "REMOVE" ? null : command.personId) &&
    receipt.eventIds.length === (command.previousVoiceProfileId ? 2 : 1) &&
    receipt.priorRevisionByScope[
      buildMemoryScope(`voice-profile:${command.voiceProfileId}`, command.personaId)
    ] === command.expectedBindingRevision &&
    (!command.previousVoiceProfileId ||
      receipt.priorRevisionByScope[
        buildMemoryScope(
          `voice-profile:${command.previousVoiceProfileId}`,
          command.previousPersonaId ?? command.personaId
        )
      ] === (command.expectedPreviousBindingRevision ?? null)) &&
    receipt.causalRefs.length === command.causalRefs.length &&
    receipt.causalRefs.every(
      (ref, index) =>
        ref.namespace === command.causalRefs[index]?.namespace &&
        ref.eventId === command.causalRefs[index]?.eventId
    )
  );
}

function p8NativeCommand(
  raw: P8CorrectionProtectedCommand,
  intent: EffectIntent,
  attempt: EffectAttemptV1
) {
  const payload = intent.request.payload as { payloadDigest: string };
  const causal = intent.request.causalRefs[0];
  if (!causal || causal.kind !== "JOURNAL_EVENT")
    throw new Error("Native P8 command has no committed CONTROL receipt.");
  return {
    commandHandle: raw.commandHandle,
    intentId: intent.intentId,
    attemptId: attempt.attemptId,
    fence: attempt.fence,
    payloadDigest: payload.payloadDigest,
    expectedRevision: raw.expectedRevision,
    causalRefs: [causal]
  };
}

function p8ReceiptMatches(
  receipt: import("@companion/p8").P8NativeCorrectionReceipt | undefined,
  command: ReturnType<typeof p8NativeCommand>
) {
  return Boolean(
    receipt &&
    receipt.commandHandle === command.commandHandle &&
    receipt.intentId === command.intentId &&
    receipt.attemptId === command.attemptId &&
    BigInt(receipt.fence) <= BigInt(command.fence) &&
    receipt.payloadDigest === command.payloadDigest &&
    receipt.correctionReference === command.commandHandle &&
    receipt.priorRevision === command.expectedRevision &&
    receipt.causalRefs.length === command.causalRefs.length &&
    receipt.causalRefs.every(
      (ref, index) =>
        ref.kind === command.causalRefs[index]?.kind &&
        ref.namespace === command.causalRefs[index]?.namespace &&
        ref.eventId === command.causalRefs[index]?.eventId
    )
  );
}

function acousticProfileNativeCommand(
  raw: AcousticProfileProtectedCommand,
  intent: EffectIntent,
  attempt: EffectAttemptV1
): VoiceProfileNativeCommand {
  const payload = intent.request.payload as { payloadDigest: string };
  const causal = intent.request.causalRefs[0];
  if (!causal || causal.kind !== "JOURNAL_EVENT")
    throw new Error("Native acoustic command has no committed CONTROL receipt.");
  return {
    operation: raw.operation,
    commandHandle: raw.commandHandle,
    intentId: intent.intentId,
    attemptId: attempt.attemptId,
    fence: attempt.fence,
    payloadDigest: payload.payloadDigest,
    expectedRevision: raw.expectedAcousticRevision,
    voiceProfileId: raw.voiceProfileId,
    ...(raw.label ? { label: raw.label } : {}),
    causalRefs: [causal]
  };
}

function acousticProfileReceiptMatches(
  receipt: VoiceProfileNativeCommandReceipt | undefined,
  command: VoiceProfileNativeCommand,
  exactFence: boolean
) {
  return Boolean(
    receipt &&
    receipt.commandHandle === command.commandHandle &&
    receipt.intentId === command.intentId &&
    receipt.attemptId === command.attemptId &&
    BigInt(receipt.fence) <= BigInt(command.fence) &&
    (!exactFence || receipt.fence === command.fence) &&
    receipt.payloadDigest === command.payloadDigest &&
    receipt.operation === command.operation &&
    receipt.voiceProfileId === command.voiceProfileId &&
    receipt.priorRevision === command.expectedRevision &&
    typeof receipt.resultingRevision === "string" &&
    receipt.resultingRevision.length > 0 &&
    receipt.resultingRevision !== receipt.priorRevision &&
    receipt.causalRefs.length === command.causalRefs.length &&
    receipt.causalRefs.every(
      (ref, index) =>
        ref.kind === command.causalRefs[index]?.kind &&
        ref.namespace === command.causalRefs[index]?.namespace &&
        ref.eventId === command.causalRefs[index]?.eventId
    )
  );
}

function captureProfileComposition(
  memory: MemoryService,
  store: ProfileSnapshotStore
): CapturedProfileComposition | null {
  const backend = memory.getBackendKind();
  if (backend === "postgres") return null;
  const reader = memory.getProfileMemorySourceReader();
  const provider = new LocalProfileProvider({ resolveSourceReader: () => reader, store });
  return {
    reader,
    provider,
    backend,
    compositionToken: {}
  };
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
