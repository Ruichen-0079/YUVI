export type {
  CreateEntityInput,
  CreateMemoryInput,
  UpdateMemoryInput,
  CreateRelationInput,
  Entity,
  Memory,
  MemoryCandidate,
  MemoryOriginRole,
  MemoryCandidateStorageResult,
  MemoryGroundingContext,
  MemoryGroundingResolver,
  CurrentAffect,
  CurrentAffectLabel,
  MemoryExtractionInput,
  MemoryExtractor,
  MemoryExtractorActive,
  MemoryExtractorMode,
  MemoryExtractorStatus,
  MemoryExtractorFailureStage,
  MemoryExtractorSelectedOutputSource,
  MemoryLayer,
  MemoryScope,
  MemoryMatchReason,
  MemoryQuery,
  MemoryRetrievalMode,
  MemoryRetrievalResult,
  MemorySearchRankComponents,
  MemorySearchQuery,
  MemoryStatus,
  MemorySubtype,
  MemoryType,
  MemoryVectorIndexStatus,
  RetrievedMemoryCandidate,
  RetrievedMemoryDebug,
  Relation
} from "./types.js";
export {
  JournalMemoryGroundingResolver,
  LEGACY_MEMORY_GROUNDING_POLICY,
  MEMORY_LINEAGE_VERSION,
  MemoryGroundingError,
  MemoryLineageV1Schema,
  getMemoryLineageState,
  legacyIncompleteMemoryLineage,
  buildGroundedMemoryLineage,
  groundedMemoryPayloadDigest,
  type DerivedMemoryLineageV1,
  type DerivedSourceSnapshot,
  type GroundedMemoryLineageV1,
  type GroundedMemorySource,
  type MemoryGroundingFailureCode,
  type MemoryLineageState,
  type MemoryLineageV1,
  type CommittedJournalEvidenceReader
} from "./lineage.js";
export type {
  MemoryClaim,
  MemoryClaimAttributionInput,
  MemoryClaimIdentity,
  MemoryClaimIdentityInput,
  MemoryClaimIdentityResolution,
  MemoryClaimProvenanceClass,
  MemoryEvent,
  MemoryEventAssertion,
  MemoryEventAssertionSource,
  MemoryEventId,
  MemoryEventKind,
  MemoryEventSource,
  MemoryEventVerification,
  MemorySourceObservationRef,
  MemoryGetEventInput,
  MemoryProvider,
  MemoryRetrievalInput,
  MemoryRetrievalOutcome,
  MemoryRetrievalStatus,
  MemoryWriteEventInput,
  MemoryWriteFailureClass,
  MemoryWriteEventOutcome,
  MemoryWriteEventStatus,
  MemoryConversationTurnWriteResult,
  MemoryConversationTurnWriteStatus
} from "./provider.js";
export { MEMORY_CLAIM_PROVENANCE_CLASSES } from "./provider.js";
export {
  admitDurableMemoryClaim,
  claimAttributionFromUnknown,
  currentEligibleMemoryEvents,
  deserializeClaimMetadata,
  MEMORY_CLAIM_METADATA,
  planClaimAttributionCorrection,
  serializeClaimMetadata,
  type MemoryClaimAdmission,
  type MemoryClaimCorrectionPlan
} from "./claim.js";
export {
  IDENTITY_EVIDENCE_SEAM_VERSION,
  selectIdentityEvidence,
  type IdentityEvidenceSelection,
  type IdentityEvidenceSelectionInput
} from "./identity-evidence.js";
export {
  VOICE_PROFILE_BINDING_KIND,
  VOICE_PROFILE_BINDING_METADATA,
  admitVoiceProfilePersonBinding,
  assertNoBiometricMetadata,
  isVoiceProfileBindingEvent,
  planVoiceProfilePersonBindingCorrection,
  readVoiceProfileId,
  voiceProfileBindingWriteFields,
  type VoiceProfilePersonBindingAdmission,
  type VoiceProfilePersonBindingInput
} from "./voice-profile-binding.js";
export { detectCurrentAffect } from "./affect.js";
export { computeRetentionPolicy, type RetentionPolicy } from "./retention.js";
export {
  MemoryLayers,
  MemoryScopes,
  MemoryStatuses,
  MemorySubtypes,
  MemoryTypes
} from "./types.js";
export {
  buildCandidateFingerprint,
  deduplicateCandidateBatch,
  type CandidateDedupeResult
} from "./candidate-dedupe.js";
export {
  detectCorrectionRequest,
  detectExplicitForgetRequest,
  detectExplicitRememberRequest,
  extractCorrectionEvidence,
  inferUserMemoryIntent,
  stripExplicitForgetPrefix,
  stripExplicitRememberPrefix,
  type UserMemoryIntent
} from "./intent.js";
export {
  buildChatMemoryScope,
  buildMem0RetrievalResult,
  classifyMem0Turn,
  dedupeSearchResults,
  emptyMem0RetrievalResult,
  forgetMemoriesInScope,
  MEM0_CHAT_PROMPT_MAX,
  MEM0_CHAT_PROMPT_TOKEN_BUDGET,
  MEM0_CHAT_SEARCH_TIMEOUT_MS,
  MEM0_CHAT_SEARCH_TOP_K,
  MEM0_CHAT_WRITE_TIMEOUT_MS,
  MEMORY_SCOPE_MISSING,
  resolveMem0ChatIdentity,
  selectPromptMemories,
  toPromptMemoryDebug,
  type ForgetMemoriesResult,
  type Mem0ChatIdentity,
  type Mem0IdentityResolution,
  type Mem0TurnKind
} from "./mem0-chat.js";
export type { MemoryServiceBackendConfig } from "./service.js";
export {
  detectEpisodicCorrectionRelationships,
  hasCorrectionRelatedMemory,
  type EpisodicCorrectionSuggestion
} from "./correction.js";
export {
  MemoryIngestionPolicy,
  canonicalizeUserClaim,
  type MemoryIngestionInput,
  type MemoryIngestionResult
} from "./ingestion.js";
export { enrichCandidateProvenance, isAssistantOnlyRestatement } from "./provenance.js";
export {
  buildTemporalSuggestion,
  canonicalEventKey,
  hasHistoricalEpisodicIntent,
  hasRelativeTemporalExpression,
  hasUnresolvedRelativeTime,
  normalizeTemporalCandidate,
  resolveCanonicalTemporalBounds,
  resolveTemporalDebug,
  resolveTimezoneFromObservedAt,
  temporalWarningForText,
  type TemporalDebugInfo,
  type TemporalDebugStatus,
  type TemporalNormalizationResult,
  type TemporalResolution
} from "./temporal.js";
export {
  detectMemoryRelationships,
  relationshipSearchText,
  type MemoryRelationshipSuggestion
} from "./relationships.js";
export {
  MemoryMaintenanceService,
  getMemoryHealth,
  runMemoryMaintenance,
  type MemoryHealthSummary,
  type MemoryMaintenanceOptions,
  type MemoryMaintenanceSummary,
  type MemoryMaintenanceWarning
} from "./maintenance.js";
export { parseMemoryRepositoryEnv, type MemoryRepositoryKind } from "./env.js";
export { normalizePostgresConnectionString } from "./postgres-connection.js";
export {
  InMemoryMemoryRepository,
  PostgresMemoryRepository,
  MemoryLineageConflictError,
  type GroundedMemoryRepositoryWrite,
  type GroundedMemoryRepositoryResult,
  createMemoryRepositoryFromEnv,
  type MemoryRepository
} from "./repository.js";
export { MemoryScorer } from "./scorer.js";
export { MemoryRetriever } from "./retriever.js";
export {
  LlmMemoryExtractor,
  RuleBasedMemoryExtractor,
  type LlmMemoryExtractorOptions,
  type MemoryExtractionReasoner
} from "./extractor.js";
export { MemoryService } from "./service.js";
export {
  buildMemoryScope,
  hashMemoryScope,
  parseMemoryScope,
  MemoryScopeError,
  type MemoryScopeParts
} from "./scope.js";
export {
  MemoryBackendError,
  type AddMemoryInput,
  type DeleteMemoryInput,
  type GetMemoryInput,
  type ListMemoryInput,
  type ListMemoryResult,
  type MemoryBackend,
  type MemoryBackendHealth,
  type MemoryBackendKind,
  type MemoryHistoryEntry,
  type MemoryHistoryInput,
  type MemoryRecord,
  type MemorySearchResult,
  type MemoryWriteOperation,
  type MemoryWriteResult,
  type SearchMemoryInput,
  type UpdateMemoryInput as BackendUpdateMemoryInput
} from "./backend.js";
export {
  createMemoryBackend,
  LegacyMemoryBackend,
  Mem0MemoryBackend,
  type Mem0MemoryBackendOptions,
  type MemoryBackendFactoryOptions
} from "./backends/index.js";
export {
  MEM0_EVENT_ID_PREFIX,
  MEM0_MEMORY_SOURCE,
  Mem0MemoryProvider,
  Mem0MemoryProviderError,
  buildWriteMetadata,
  canonicalMem0EventId,
  mapMem0RecordToMemoryEvent,
  sanitizeSemanticMetadata
} from "./providers/mem0-memory-provider.js";
export {
  InMemoryConversationRepository,
  PostgresConversationRepository,
  createConversationRepositoryFromEnv,
  parseConversationRepositoryEnv,
  type ConversationDatabaseClient,
  type ConversationFinalizationFields,
  type ConversationListOptions,
  type ConversationMessage,
  type ConversationMessageInput,
  type ConversationMessageRole,
  type ConversationMessageStatus,
  type ConversationRecoveryOptions,
  type ConversationRepository,
  type ConversationRepositoryKind,
  DEFAULT_STALE_STREAMING_MESSAGE_AGE_MS,
  DEFAULT_STALE_STREAMING_MESSAGE_LIMIT
} from "./conversation-repository.js";
export {
  FINALIZED_INGESTION_POLICY_VERSION,
  FinalizedIngestionService,
  InMemoryFinalizedIngestionRepository,
  PostgresFinalizedIngestionRepository,
  createFinalizedIngestionRepositoryFromEnv,
  type FinalizedIngestionAdmission,
  type FinalizedIngestionAdmissionInput,
  type FinalizedIngestionEvent,
  type FinalizedIngestionEventOutcome,
  type FinalizedIngestionEventPayload,
  type FinalizedIngestionEventStatus,
  type FinalizedIngestionPort,
  type FinalizedIngestionRepository,
  type FinalizedIngestionRepositoryKind,
  type FinalizedIngestionTurn,
  type FinalizedIngestionTurnStatus,
  type FinalizedIngestionWorkStats,
  type MissingFinalizedConversationTurn
} from "./finalized-ingestion-ledger.js";
export {
  DEFAULT_MEMORY_INGESTION_MAX_DELIVERY_ATTEMPTS,
  executeFinalizedIngestionEvent,
  MEMORY_WRITE_RETRY_EXHAUSTED,
  type FinalizedIngestionDeliveryResult
} from "./finalized-ingestion-executor.js";
export {
  DEFAULT_MEMORY_INGESTION_RETRY_POLICY,
  MEMORY_INGESTION_DIAGNOSTICS_UNAVAILABLE,
  MemoryIngestionCoordinator,
  type MemoryIngestionCoordinatorDiagnostics,
  type MemoryIngestionCoordinatorLogger,
  type MemoryIngestionCoordinatorOptions,
  type MemoryIngestionCoordinatorPort,
  type MemoryIngestionCoordinatorRepository,
  type MemoryIngestionCoordinatorStatus,
  type MemoryIngestionDiagnosticsAvailability,
  type MemoryIngestionFaultHooks,
  type MemoryIngestionRetryPolicy
} from "./memory-ingestion-coordinator.js";
export {
  MissingDatabaseUrlError,
  parseDotEnv,
  readSqlMigrations,
  resolveDatabaseUrl,
  runPostgresMigrations,
  type SqlMigration
} from "./migrations.js";
export {
  DEFAULT_MEMORY_HIERARCHY_BUDGETS,
  MEMORY_HIERARCHY_VERSION,
  MemoryHierarchyLayers,
  normalizeMemoryHierarchyBudgets,
  type MemoryHierarchyBudgets,
  type MemoryHierarchyLayer
} from "./hierarchy.js";
export {
  assembleRecentEpisodes,
  ASSISTANT_CONTEXT_DISCLAIMER,
  episodeSearchCorpus,
  formatRecentEpisodeForPrompt,
  rankRecentEpisodesForQuery,
  sourceTurnIdsOverlap,
  RECENT_EPISODE_SOURCE,
  RecentEpisodeStatuses,
  TemporalConfidenceLevels,
  type RecentEpisode,
  type RecentEpisodeAssembleInput,
  type RecentEpisodeStatus,
  type TemporalConfidence
} from "./recent-episode.js";
export {
  createRecentEpisodeStoreFromEnv,
  InMemoryRecentEpisodeStore,
  PostgresRecentEpisodeStore,
  type RecentEpisodeListQuery,
  type RecentEpisodeStore
} from "./recent-episode-store.js";
export {
  activateAssociativeMemories,
  ASSOCIATIVE_RECALL_VERSION,
  type AssociativeRecallInput,
  type AssociativeRecallItem,
  type AssociativeRecallResult
} from "./associative-recall.js";
export {
  DEFAULT_DREAM_LEASE_MS,
  DREAM_CONSOLIDATION_VERSION,
  DreamConsolidationEngine,
  DreamJobStatuses,
  DreamTriggerKinds,
  findRecurrenceCluster,
  InMemoryDreamJobStore,
  PostgresDreamJobStore,
  type DreamConsiderInput,
  type DreamConsiderResult,
  type DreamJob,
  type DreamJobStatus,
  type DreamJobStore,
  type DreamTriggerKind,
  type DreamWriter
} from "./dream-consolidation.js";
export {
  DREAM_DELIVERY_KEY_PREFIX,
  DREAM_SEMANTIC_DELIVERY_AUTHORITY,
  stampDreamWriteEvent
} from "./dream-delivery.js";
export {
  compressHierarchicalContext,
  CONTEXT_COMPRESSION_RUNTIME_STATUS,
  CONTEXT_COMPRESSION_VERSION,
  ProtectedPromptSectionNames,
  type ContextCompressionInput,
  type ContextCompressionMetrics,
  type ContextCompressionResult,
  type HierarchicalContextSection
} from "./context-compression.js";
export {
  ageBand,
  projectThinTemporalContext,
  TemporalAgeBands,
  THIN_TEMPORAL_PROJECTION_VERSION,
  type TemporalAgeBand,
  type ThinTemporalProjection,
  type ThinTemporalProjectionInput
} from "./temporal-projection.js";
export {
  assembleMemoryVNextContext,
  defaultMemoryVNextBudgets,
  MEMORY_VNEXT_VERSION,
  memoryVNextMessageWindow,
  type MemoryVNextAssembleInput,
  type MemoryVNextAssembly,
  type MemoryVNextCharacterProjection
} from "./memory-vnext.js";
export {
  compactMemoryText,
  hasTechnicalExactOverlap,
  jaccardSimilarity,
  redactUnsafeMemoryText,
  tokenizeMemoryText
} from "./memory-vnext-text.js";

export { modelContextBudget } from "./context-compression.js";

export { LocalControllerEvidenceProvider } from "./providers/local-controller-evidence.js";

export * from "./episode-source-evidence.js";

export * from "./dream-source.js";
