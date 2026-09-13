import type { ChatMessage } from "../chat-state.js";
import { resolveApiBaseUrl } from "../desktop-runtime.js";
import { withActionDeadline } from "../action-deadline.js";
import type { EmbodiedPresentationOutcomeReport } from "@companion/protocol";
import {
  MessageSseParser,
  MessageStreamError,
  MessageStreamProtocolError,
  ProactiveSseParser,
  type CompletedMessage,
  type MessageStreamEvent,
  type ProactiveDecisionEvent,
  type ProactiveMessageStreamEvent
} from "./stream.js";

export {
  MessageSseParser,
  MessageStreamError,
  MessageStreamProtocolError,
  ProactiveSseParser
} from "./stream.js";
export type {
  CompletedMessage,
  MessageStreamCompleted,
  MessageStreamErrorEvent,
  MessageStreamEvent,
  MessageStreamTextDelta,
  ProactiveDecisionEvent,
  ProactiveMessageStreamEvent,
  ProactiveShouldSpeak
} from "./stream.js";

export type ProviderHealth = {
  provider: string;
  name?: string;
  capability?: ProviderCapability;
  status: "healthy" | "degraded" | "unavailable";
  readiness?: ProviderReadinessState;
  observed?: ProviderObservedState;
  checkedAt: string;
  message?: string;
  configured?: boolean;
  available?: boolean;
  mock?: boolean;
  mode?: "real" | "mock" | "unavailable";
  mockAllowed?: boolean;
  missingFields?: string[];
  required?: boolean;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  semanticEmbedding?: boolean;
  embeddingNote?: string;
  latencyMs?: number;
  enabled?: boolean;
  priority?: number;
  fallbackEligible?: boolean;
  lastVerifiedAt?: string;
  lastErrorCode?: string;
  lastError?: string;
};

export type ProviderCapability = "chat" | "reasoning" | "embedding" | "tts" | "stt" | "vision";

export type ProviderReadinessState = "ready" | "not_ready";
export type ProviderObservedState = "unknown" | "available" | "degraded" | "unavailable";
export type ProviderVerificationMode = "live" | "config_only";

export type ProviderRouteHealth = ProviderHealth & {
  capability: ProviderCapability;
  provider: string;
  enabled: boolean;
  priority: number;
  fallbackEligible: boolean;
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  runtimeMode?: string;
  server: { status: string };
  database: {
    status: "healthy" | "degraded" | "unavailable";
    message?: string;
  };
  providers: {
    chat: ProviderHealth;
    chatCapability: ProviderCapabilityHealth;
    optional: {
      reasoning?: ProviderHealth;
      tts: ProviderHealth;
      stt: ProviderHealth;
      vision: ProviderHealth;
      embedding: ProviderHealth;
    };
  };
};

export type ProviderCapabilityHealth = {
  readiness: "ready" | "not_ready";
  observed: "unknown" | "available" | "degraded" | "unavailable";
  operational: boolean;
  routeCount: number;
  readyRouteCount: number;
  readyProviders: Array<{
    provider: string;
    priority: number;
    observed: "unknown" | "available" | "degraded" | "unavailable";
    status: "healthy" | "degraded" | "unavailable";
  }>;
};

export type RuntimeEvent = {
  id: string;
  traceId: string;
  type: string;
  timestamp?: string;
  createdAt?: string;
  payload: Record<string, unknown>;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
};

export type ProviderCallMetadata = {
  name: string;
  capability: string;
  model?: string;
  mock: boolean;
  latencyMs?: number;
  tokenUsage?: TokenUsage;
  healthStatus?: string;
  fallbackUsed?: boolean;
  attemptedProviders?: ProviderAttempt[];
  finalProvider?: string;
};

export type ProviderAttempt = {
  provider: string;
  model?: string;
  status: "skipped" | "success" | "failed" | "unavailable";
  errorCode?: string;
  error?: string;
  latencyMs?: number;
  configured?: boolean;
  enabled?: boolean;
  priority?: number;
};

export type DashboardWebSocketMessage =
  | RuntimeEvent
  | {
      kind: "dashboard.connected";
      traceId: string;
      timestamp: string;
      payload: {
        message: string;
      };
    };

export type SendMessageRequest = {
  speechObservationId?: string;
  sessionId: string;
  text: string;
  imageAttachment?: {
    imageBase64: string;
    mimeType: "image/png" | "image/jpeg";
  };
  options: {
    useMemory?: boolean;
    readMemory?: boolean;
    writeMemory?: boolean;
    voiceOutput: boolean;
    promptPreview?: boolean;
  };
};

export type ProactiveTurnStreamRequest = {
  sessionId: string;
  idempotencyKey: string;
  modality: "text";
  options: {
    readMemory: boolean;
    promptPreview?: boolean;
  };
};

export type MessageResponse = RuntimeEvent & {
  reply: string;
  promptPreview?: PromptPreviewResponse["promptPreview"];
  provider?: ProviderCallMetadata;
  memory?: {
    legacyUseMemory?: boolean;
    readMemory: boolean;
    writeMemory: boolean;
    memoryReadEnabled: boolean;
    memoryWriteEnabled: boolean;
  };
  payload: {
    sessionId?: string;
    content?: string;
    provider?: ProviderCallMetadata;
    traceId?: string;
    audio?: unknown;
  };
};

export type MemoryRecord = {
  id: string;
  type: string;
  subtype?: string | null;
  scope?: "user" | "project" | "agent" | "plugin" | "session";
  scopeId?: string | null;
  memoryLayer?: "core" | "recall" | "archival" | "working";
  status?: "active" | "superseded" | "archived" | "forgotten" | "expired";
  content: string;
  summary?: string | null;
  importance: number;
  emotionValence?: number;
  emotionArousal?: number;
  source: string;
  sourceTraceId?: string | null;
  personaId?: string | null;
  subjectUserId?: string | null;
  createdByUserId?: string | null;
  speakerId?: string | null;
  voiceProfileId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  updatedAt?: string;
  observedAt?: string;
  eventTime?: string | null;
  validFrom?: string;
  validUntil?: string | null;
  expiresAt?: string | null;
  lastAccessedAt?: string;
  supersededAt?: string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
  embedding?: null;
  embeddingModel?: string | null;
  embeddingProvider?: string | null;
  embeddingDimensions?: number | null;
  embeddedAt?: string | null;
  hasEmbedding?: boolean;
  semanticEmbedding?: boolean;
  embeddingError?: string;
  retentionClass?: string;
  retentionReason?: string;
};

export type CreateMemoryRequest = {
  emotionValence?: number;
  emotionArousal?: number;
  type: string;
  subtype?: string | null;
  scope?: string;
  scopeId?: string | null;
  memoryLayer?: string;
  status?: string;
  content: string;
  summary?: string;
  importance?: number;
  source: string;
  sourceTraceId?: string | null;
  personaId?: string | null;
  subjectUserId?: string | null;
  createdByUserId?: string | null;
  speakerId?: string | null;
  voiceProfileId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
  tags: string[];
  observedAt?: string | null;
  eventTime?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
};

export type UpdateMemoryRequest = {
  type?: string;
  subtype?: string | null;
  scope?: string;
  scopeId?: string | null;
  memoryLayer?: string;
  status?: string;
  content?: string;
  summary?: string | null;
  importance?: number;
  emotionValence?: number;
  emotionArousal?: number;
  personaId?: string | null;
  subjectUserId?: string | null;
  createdByUserId?: string | null;
  speakerId?: string | null;
  voiceProfileId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
  tags?: string[];
  observedAt?: string | null;
  eventTime?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
  supersededAt?: string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
};

export type MemoryCandidateReview = {
  id: string;
  traceId: string;
  timestamp: string;
  type: string;
  subtype?: string | null;
  scope?: string;
  scopeId?: string | null;
  memoryLayer?: string;
  content: string;
  contentPreview: string;
  summary?: string | null;
  importance: number;
  confidence?: number;
  tags: string[];
  reason: string;
  decision: "stored" | "rejected";
  rejectedReason?: string;
  storageReason?: string;
  explicitRememberRequested?: boolean;
  correctionRequested?: boolean;
  originRole?: "user" | "assistant" | "mixed";
  canonicalFingerprint?: string;
  canonicalEventKey?: string;
  temporalStatus?: "not-needed" | "normalized" | "unresolved";
  temporalSuggestion?: string;
  source?: string;
  sourceTraceId?: string | null;
  storedMemoryId?: string;
  createdAt?: string;
  extractorMode?: string;
  extractorProvider?: string;
  fallbackUsed?: boolean;
  metadata?: Record<string, unknown>;
  observedAt?: string | null;
  eventTime?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
  possibleSupersedes?: string[];
  possibleContradictions?: string[];
  relationshipConfidence?: number;
  relationshipReason?: string;
  retentionClass?: string;
  computedExpiresAt?: string | null;
  subjectUserId?: string | null;
  speakerId?: string | null;
};

export type AcceptMemoryCandidateRequest = Partial<
  Pick<
    MemoryCandidateReview,
    | "type"
    | "subtype"
    | "scope"
    | "scopeId"
    | "memoryLayer"
    | "content"
    | "summary"
    | "importance"
    | "tags"
    | "observedAt"
    | "eventTime"
    | "validFrom"
    | "validUntil"
    | "expiresAt"
    | "possibleSupersedes"
    | "possibleContradictions"
  >
>;

export type ProvidersStatusResponse = {
  providers: {
    chat: ProviderHealth;
    reasoning: ProviderHealth;
    tts: ProviderHealth;
    stt: ProviderHealth;
    vision: ProviderHealth;
    embedding: ProviderHealth;
  };
  routes?: {
    chat: ProviderRouteHealth[];
    reasoning: ProviderRouteHealth[];
    tts: ProviderRouteHealth[];
    stt: ProviderRouteHealth[];
    vision: ProviderRouteHealth[];
    embedding: ProviderRouteHealth[];
  };
};

export type ProviderVerificationResponse = {
  ok: boolean;
  provider: string;
  capability: ProviderCapability;
  model?: string;
  dimensions?: number;
  expectedDimensions?: number;
  actualDimensions?: number | null;
  configuredDimensions?: number;
  semanticEmbedding?: boolean;
  mock: boolean;
  configured?: boolean;
  configOnly?: true;
  verificationMode: ProviderVerificationMode;
  readiness?: ProviderReadinessState;
  observed?: ProviderObservedState;
  lastVerifiedAt?: string;
  lastErrorCode?: string;
  lastError?: string;
  missingFields?: string[];
  latencyMs?: number;
  tokenUsage?: TokenUsage;
  errorCode?: string;
  error?: string;
  message?: string;
};

/** Response from a no-I/O provider-chain readiness inspection. */
export type ProviderChainInspectionResponse = {
  ok: boolean;
  capability: ProviderCapability;
  configOnly: true;
  verificationMode: "config_only";
  readyRouteCount: number;
  routes: ProviderRouteHealth[];
  attemptedProviders: ProviderAttempt[];
  message: string;
};

export type CapabilityRuntimeMetadata = {
  capability: "tts" | "stt" | "vision";
  fallbackUsed: boolean;
  attemptedProviders: ProviderAttempt[];
  finalProvider: string;
  provider: string;
  model?: string;
  mock: boolean;
  latencyMs?: number;
};

export type SpeechActivityResponse = {
  sessionId: string;
  speechActive: boolean;
  captureEpoch: string | null;
  activityRevision: number;
  speechPlaybackEffectId?: string | null;
  speechPlaybackRequestId?: string | null;
  speechPlaybackState?: string | null;
  revokedSpeechEffectId?: string;
  revokedSpeechRequestId?: string;
};

export type SpeechPlaybackEffectResponse = {
  effectId: string;
  requestId?: string;
  sessionId?: string;
  state: string | null;
};

export type TranscriptionResponse = CapabilityRuntimeMetadata & {
  text: string;
  language?: string;
  confidence?: number;
  observationId?: string;
  captureEpoch?: string;
  speakerId?: string | null;
  voiceProfileId?: string | null;
};

export type VoiceMessageResponse = {
  transcription: TranscriptionResponse;
  reply: string;
  traceId: string;
  provider?: ProviderCallMetadata;
  stt: CapabilityRuntimeMetadata;
  chat?: ProviderCallMetadata;
  promptPreview?: PromptPreviewResponse["promptPreview"];
};

export type TTSResponse = CapabilityRuntimeMetadata & {
  audioBase64: string;
  mimeType: string;
  durationMs?: number;
};

export type VisionAnalyzeResponse = CapabilityRuntimeMetadata & {
  analysis: string;
  labels?: string[];
  objects?: string[];
  sceneSummary?: string;
  confidence?: number;
};

export type RetrievedMemoryDebug = {
  id: string;
  type: string;
  subtype?: string | null;
  scope?: string;
  scopeId?: string | null;
  memoryLayer?: string;
  status?: string;
  source: string;
  sourceTraceId: string | null;
  metadata?: Record<string, unknown>;
  importance: number;
  createdAt: string;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string | null;
  expiresAt?: string | null;
  supersededAt?: string | null;
  lastAccessedAt?: string;
  displayText: string;
  hasEmbedding: boolean;
  embeddingProvider?: string | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
  embeddedAt?: string | null;
  semanticEmbedding?: boolean;
  embeddingError?: string;
  matchedBy?:
    | "vector"
    | "content"
    | "summary"
    | "tag"
    | "type"
    | "subtype"
    | "scope"
    | "metadata"
    | "source"
    | "keyword"
    | "fallback";
  score?: number;
  retrievalMode?: string;
  vectorScore?: number;
  keywordScore?: number;
  hybridScore?: number;
  rankComponents?: {
    vectorScore?: number;
    hybridScore?: number;
    keywordScore?: number;
    tagScore?: number;
    trigramScore?: number;
    fullTextScore?: number;
    scopeScore?: number;
    recencyScore?: number;
    importanceScore?: number;
  };
  excludedReason?: string;
  personaId?: string | null;
  subjectUserId?: string | null;
  speakerId?: string | null;
  retentionClass?: string;
  retentionReason?: string;
};

export type CurrentAffectDebug = {
  affectLabel: string;
  affectValence: number;
  affectArousal: number;
  confidence: number;
  evidenceSnippet: string;
  timestamp: string;
  sourceTraceId?: string | null;
  promptHint: string;
};

export type PromptPreviewResponse = {
  mock: boolean;
  message?: string;
  traceId?: string;
  timestamp?: string;
  userMessage?: string;
  legacyUseMemory?: boolean;
  useMemory?: boolean;
  readMemory?: boolean;
  writeMemory?: boolean;
  memoryReadEnabled?: boolean;
  memoryWriteEnabled?: boolean;
  memoryRepository?: string;
  memoryExtractorMode?: string;
  memoryExtractorActive?: string;
  memoryExtractorUsed?: boolean;
  memoryExtractorProvider?: string;
  memoryExtractionCandidateCount?: number;
  storedMemoryCount?: number;
  rejectedMemoryCount?: number;
  rejectedReasons?: string[];
  fallbackUsed?: boolean;
  llmExtractionError?: string;
  llmExtractionRawPreview?: string;
  validationIssues?: string[];
  memoryExtractionSkippedReason?: string;
  memoryCandidates?: MemoryCandidateReview[];
  retrievedMemoryCountRaw?: number;
  retrievedMemoryCount?: number;
  retrievalMode?: string;
  vectorEnabled?: boolean;
  vectorUsed?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  semanticEmbedding?: boolean;
  embeddingNote?: string;
  queryEmbeddingGenerated?: boolean;
  vectorResultCount?: number;
  keywordResultCount?: number;
  hybridResultCount?: number;
  retrievalFallbackUsed?: boolean;
  retrievalFallbackReason?: string;
  retrievalScope?: string;
  includedScopes?: Array<{ scope: string; scopeId?: string | null }>;
  includeArchived?: boolean;
  includeSuperseded?: boolean;
  includeExpired?: boolean;
  includeHistoricalEpisodic?: boolean;
  currentTime?: string;
  currentAffect?: CurrentAffectDebug;
  directContextEnabled?: boolean;
  directContextTurnCount?: number;
  directContextCharCount?: number;
  directContextTruncated?: boolean;
  directContextSource?: string;
  excludedByStatus?: number;
  excludedByTime?: number;
  excludedByScope?: number;
  retrievedMemories?: RetrievedMemoryDebug[];
  providerName?: string;
  providerModel?: string;
  providerMock?: boolean;
  providerLatencyMs?: number;
  providerHealthStatus?: string;
  tokenUsage?: TokenUsage;
  promptPreview: null | {
    traceId?: string;
    timestamp?: string;
    userMessage?: string;
    legacyUseMemory?: boolean;
    useMemory?: boolean;
    readMemory?: boolean;
    writeMemory?: boolean;
    memoryReadEnabled?: boolean;
    memoryWriteEnabled?: boolean;
    memoryRepository?: string;
    memoryExtractorMode?: string;
    memoryExtractorActive?: string;
    memoryExtractorUsed?: boolean;
    memoryExtractorProvider?: string;
    memoryExtractionCandidateCount?: number;
    storedMemoryCount?: number;
    rejectedMemoryCount?: number;
    rejectedReasons?: string[];
    fallbackUsed?: boolean;
    llmExtractionError?: string;
    llmExtractionRawPreview?: string;
    validationIssues?: string[];
    memoryExtractionSkippedReason?: string;
    memoryCandidates?: MemoryCandidateReview[];
    retrievedMemoryCountRaw?: number;
    retrievedMemoryCount?: number;
    retrievalMode?: string;
    vectorEnabled?: boolean;
    vectorUsed?: boolean;
    embeddingProvider?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    semanticEmbedding?: boolean;
    embeddingNote?: string;
    queryEmbeddingGenerated?: boolean;
    vectorResultCount?: number;
    keywordResultCount?: number;
    hybridResultCount?: number;
    retrievalFallbackUsed?: boolean;
    retrievalFallbackReason?: string;
    retrievalScope?: string;
    includedScopes?: Array<{ scope: string; scopeId?: string | null }>;
    includeArchived?: boolean;
    includeSuperseded?: boolean;
    includeExpired?: boolean;
    includeHistoricalEpisodic?: boolean;
    currentTime?: string;
    currentAffect?: CurrentAffectDebug;
    directContextEnabled?: boolean;
    directContextTurnCount?: number;
    directContextCharCount?: number;
    directContextTruncated?: boolean;
    directContextSource?: string;
    excludedByStatus?: number;
    excludedByTime?: number;
    excludedByScope?: number;
    retrievedMemories?: RetrievedMemoryDebug[];
    sections: Array<{
      name: string;
      content: string;
      priority: number;
      stable: boolean;
    }>;
    prompt?: string;
    finalPrompt?: string;
    finalMessages?: Array<{ role: string; content: string }>;
    characterCount: number;
    estimatedTokens: number;
    truncated: boolean;
    providerName?: string;
    providerModel?: string;
    providerMock?: boolean;
    providerLatencyMs?: number;
    providerHealthStatus?: string;
    tokenUsage?: TokenUsage;
  };
};

export type RuntimeSettingsResponse = {
  configFiles: {
    ".env": {
      exists: boolean;
      gitIgnored: boolean;
      path?: string;
    };
    ".env.local": {
      exists: boolean;
      gitIgnored: boolean;
      path?: string;
    };
  };
  baseConfig: Record<string, unknown>;
  localOverrideConfig: Record<string, unknown>;
  effectiveConfig: Record<string, unknown>;
  activeRuntimeConfig: {
    visualGroundingAvailable?: boolean;
    outputLanguage?: "AUTO" | "EN" | "ZH" | "JA";
    serverHost: string;
    serverPort: number;
    eventBus: string;
    memoryRepository: string;
    memoryExtractor?: string;
    memoryExtractorActive?: string;
    providers: {
      chat: ProviderHealth;
      reasoning: ProviderHealth;
      embedding: ProviderHealth;
      tts: ProviderHealth;
      stt: ProviderHealth;
      vision: ProviderHealth;
    };
  };
  settings: Record<string, LayeredSetting>;
  runtime: {
    serverHost: string;
    serverPort: number;
    activeServerHost: string;
    activeServerPort: number;
    runtimeMode: string;
    eventBus: string;
    activeEventBus: string;
    providerAllowMocks?: boolean;
    devSupervisor?: {
      active: boolean;
      autoMigrate: boolean;
      restartSupported: boolean;
      runtimeEnvDir: string;
    };
    pendingRestart: boolean;
  };
  memory: {
    memoryRepository: string;
    activeMemoryRepository: string;
    databaseUrlConfigured: boolean;
    restartRequiredForChanges: boolean;
    postgresRequiresDatabaseUrl: boolean;
    postgresMigrationReminder: string;
    memoryExtractor?: string;
    activeMemoryExtractor?: string;
    memoryExtractorActive?: string;
    memoryExtractorDefault?: string;
    memoryExtractorFallbackUsed?: boolean;
    memoryExtractorSkippedReason?: string;
    memoryExtractorFailureStage?: string;
    memoryExtractorError?: string;
    memoryExtractorValidationIssues?: string[];
    memoryExtractorRejectedReasons?: string[];
    memoryExtractorRawPreview?: string;
    memoryExtractorCandidateCount?: number;
    memoryExtractorRejectedCount?: number;
    memoryExtractorFinishReason?: string;
    memoryExtractorSelectedOutputSource?: string;
    memoryExtractorAnswerLength?: number;
    memoryExtractorReasoningLength?: number;
    memoryExtractorLastAttemptAt?: string;
    reasoningProviderConfigured?: boolean;
    vectorIndex?: {
      enabled: boolean;
      type: string;
      distance: string;
      ivfflatProbes?: number;
      hnswEfSearch?: number;
    };
  };
  providers: {
    deepseek: {
      baseUrl: string;
      apiKeyConfigured: boolean;
      apiKeyPreview?: string;
      chatModel: string;
      reasoningModel: string;
      status?: {
        chat: ProviderHealth;
        reasoning: ProviderHealth;
      };
    };
    openaiCompatible: {
      baseUrl: string;
      apiKeyConfigured: boolean;
      apiKeyPreview?: string;
      chatModel: string;
      reasoningModel: string;
      status?: {
        chat: ProviderHealth;
        reasoning: ProviderHealth;
      };
    };
    xai: {
      baseUrl: string;
      apiKeyConfigured: boolean;
      apiKeyPreview?: string;
      ttsModel: string;
      ttsVoice: string;
      visionModel: string;
      optional: boolean;
      implementedCapabilities: Array<"tts" | "vision">;
    };
    dashscope: {
      baseUrl: string;
      apiKeyConfigured: boolean;
      apiKeyPreview?: string;
      sttModel: string;
      optional: boolean;
      implementedCapabilities: Array<"stt">;
    };
    embedding: {
      provider: string;
      baseUrl: string;
      apiKeyConfigured: boolean;
      apiKeyPreview?: string;
      model: string;
      dimensions: string;
      status?: ProviderHealth;
    };
  };
  restartRequired: boolean;
  editableKeys: string[];
};

export type LayeredSetting =
  | {
      base: string;
      localOverride: string;
      effective: string;
      source: string;
    }
  | {
      baseConfigured: boolean;
      localOverrideConfigured: boolean;
      effectiveConfigured: boolean;
      maskedValue?: string;
      source: string;
    };

export type RuntimeSettingsUpdateRequest = {
  values: Record<string, string | null>;
};

export type RuntimeSettingsUpdateResponse = {
  ok: boolean;
  restartRequired: boolean;
  changedKeys: string[];
  settings: RuntimeSettingsResponse;
};

export type RuntimeSettingsReloadResponse = {
  ok: boolean;
  applied: boolean;
  restartRequired: boolean;
  active: {
    providers: ProvidersStatusResponse["providers"];
    memoryRepository: string;
  };
  notHotReloaded: string[];
  message: string;
  settings: RuntimeSettingsResponse;
};

export type MemoryHealthSummary = {
  scanned: number;
  active: number;
  expired: number;
  archived: number;
  superseded: number;
  forgotten: number;
  staleEpisodic: number;
  missingEmbedding: number;
};

export type MemoryMaintenanceSummary = {
  dryRun: boolean;
  scanned: number;
  expired: number;
  stale: number;
  supersessionWarnings: number;
  skipped: number;
  failed: number;
  expiredIds: string[];
  staleIds: string[];
  warnings: Array<{
    memoryId: string;
    kind: string;
    message: string;
    relatedId?: string;
    fixed?: boolean;
  }>;
};

export type MemoryMaintenanceSchedulerStatus = {
  enabled: boolean;
  runOnStartup: boolean;
  intervalMinutes: number;
  limit: number;
  running: boolean;
  lastRunAt: string | null;
  lastSummary: MemoryMaintenanceSummary | null;
  lastError: string | null;
  nextRunAt: string | null;
};

export type MemoryVectorIndexStatus = {
  vectorIndexEnabled: boolean;
  vectorIndexType: "hnsw" | "ivfflat" | "none" | "unavailable";
  vectorDistance: "cosine";
  embeddingDimensions?: number;
  indexCreated: boolean;
  indexAvailable: boolean;
  indexFallbackReason?: string;
  embeddedCount: number;
  missingEmbeddingCount: number;
  annAccelerationActive: boolean;
};

const apiBaseUrl = (): string => resolveApiBaseUrl();
const explicitWebSocketBaseUrl = import.meta.env["VITE_WS_BASE_URL"] as string | undefined;
let dashboardDevToken = "";

export class ApiError extends Error {
  readonly status: number;
  readonly error?: string;
  readonly reason?: string;

  constructor(message: string, status: number, extras: { error?: string; reason?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (extras.error !== undefined) this.error = extras.error;
    if (extras.reason !== undefined) this.reason = extras.reason;
  }
}

export type MessageStreamOptions = {
  signal?: AbortSignal;
  onEvent?: (event: MessageStreamEvent) => void;
};

export type ProactiveStreamOptions = {
  signal?: AbortSignal;
  onEvent?: (event: ProactiveMessageStreamEvent) => void;
};

export type ProactiveTurnResult = CompletedMessage | ProactiveDecisionEvent;

export type Live2DModel = { id: string; name: string; model: string; source: "user" | "configured"; url: string };
export type Live2DModelState = { models: Live2DModel[]; activeId: string | null; activeUrl: string | null; intendedDefault: string };
export const apiClient = {
  getConversationHistory(sessionId: string, signal?: AbortSignal): Promise<{ sessionId: string; messages: ChatMessage[] }> {
    return request(`/v1/conversations/history?sessionId=${encodeURIComponent(sessionId)}`, signalRequestInit(signal));
  },
  getLive2DModels(signal?: AbortSignal): Promise<Live2DModelState> { return request("/live2d/models", signalRequestInit(signal)); },
  importLive2DZip(input: { name: string; archiveBase64: string }): Promise<Live2DModelState> {
    return request("/live2d/models/import-zip", { method: "POST", body: JSON.stringify(input) });
  },
  selectLive2DModel(id: string | null): Promise<Live2DModelState> { return request("/live2d/models/select", { method: "POST", body: JSON.stringify({ id }) }); },
  removeLive2DModel(id: string): Promise<Live2DModelState> { return request(`/live2d/models/${encodeURIComponent(id)}`, { method: "DELETE" }); },
  setDashboardDevToken(token: string): void {
    dashboardDevToken = token;
  },

  getDashboardDevTokenConfigured(): boolean {
    return dashboardDevToken.length > 0;
  },

  getHealth(signal?: AbortSignal): Promise<HealthResponse> {
    return request<HealthResponse>("/health", signalRequestInit(signal));
  },

  getLocalServices(signal?: AbortSignal): Promise<LocalServicesStatus> {
    return request("/local-services/status", signalRequestInit(signal));
  },
  detectLocalServices(signal?: AbortSignal): Promise<LocalConnectionDetectResponse> {
    return request("/product/local-services/detect", signalRequestInit(signal));
  },
  probeLocalService(input: {
    service: LocalConnectionService;
    endpoint: string;
    apiKey?: string;
  }): Promise<LocalConnectionFinding> {
    return request("/product/local-services/probe", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  restartLocalServices(): Promise<{ ok: boolean }> {
    return request("/system/local-services/restart", { method: "POST" });
  },
  getVoiceProfiles(): Promise<{ profiles: Array<{ voiceProfileId: string; label: string }> }> {
    return request("/voice-profiles");
  },
  enrollVoiceProfile(input: {
    audioBase64: string;
    mimeType: string;
    label: string;
  }): Promise<{ voiceProfileId: string; label: string }> {
    return request("/voice-profiles", { method: "POST", body: JSON.stringify(input) });
  },
  identifyVoiceProfile(input: {
    audioBase64: string;
    mimeType: string;
  }): Promise<{ status: string; voiceProfileId?: string }> {
    return request("/voice-profiles/identify", { method: "POST", body: JSON.stringify(input) });
  },
  bindVoiceProfilePerson(id: string, personId: string): Promise<{ status: string }> {
    return request(`/voice-profiles/${encodeURIComponent(id)}/person`, {
      method: "POST",
      body: JSON.stringify({ personId })
    });
  },
  deleteVoiceProfile(id: string): Promise<{ ok: boolean }> {
    return request(`/voice-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  sendMessage(input: SendMessageRequest): Promise<MessageResponse> {
    return request<MessageResponse>("/message", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  streamMessage(
    input: SendMessageRequest,
    options: MessageStreamOptions = {}
  ): Promise<CompletedMessage> {
    return streamTextResponse("/v1/messages/stream", input, options);
  },

  streamProactiveTurn(
    input: ProactiveTurnStreamRequest,
    options: ProactiveStreamOptions = {}
  ): Promise<ProactiveTurnResult> {
    return streamProactiveTextResponse(toProactiveTurnStreamRequestBody(input), options);
  },

  subscribeProactiveLive(sessionId: string, options: ProactiveStreamOptions = {}): Promise<void> {
    return streamProactiveLive(sessionId, options);
  },

  setProactiveConsent(
    enabled: boolean,
    signal?: AbortSignal
  ): Promise<{ ok: true; enabled: boolean }> {
    return request<{ ok: true; enabled: boolean }>("/v1/proactive/consent", {
      method: "POST",
      body: JSON.stringify({ enabled }),
      ...signalRequestInit(signal)
    });
  },

  listRecentMemories(limit = 20, signal?: AbortSignal): Promise<{ memories: MemoryRecord[] }> {
    return request<{ memories: MemoryRecord[] }>(
      `/memory/recent?limit=${limit}`,
      signalRequestInit(signal)
    );
  },

  searchMemories(
    query: string,
    options: {
      view?: "semantic" | "records";
      type?: string;
      subtype?: string;
      source?: string;
      scope?: string;
      scopeId?: string;
      memoryLayer?: string;
      status?: string;
      tags?: string;
      minImportance?: string;
      includeArchived?: boolean;
      includeSuperseded?: boolean;
      includeExpired?: boolean;
      includeHistoricalEpisodic?: boolean;
      limit?: number;
    } = {}
  ): Promise<{
    mock: boolean;
    memories: MemoryRecord[];
    rawCount?: number;
    count?: number;
    retrievalMode?: string;
    vectorEnabled?: boolean;
    vectorUsed?: boolean;
    embeddingProvider?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    semanticEmbedding?: boolean;
    embeddingNote?: string;
    queryEmbeddingGenerated?: boolean;
    vectorResultCount?: number;
    keywordResultCount?: number;
    hybridResultCount?: number;
    fallbackUsed?: boolean;
    fallbackReason?: string;
    retrievalScope?: string;
    includedScopes?: Array<{ scope: string; scopeId?: string | null }>;
    includeArchived?: boolean;
    includeSuperseded?: boolean;
    includeExpired?: boolean;
    includeHistoricalEpisodic?: boolean;
    excludedByStatus?: number;
    excludedByTime?: number;
    excludedByScope?: number;
    debugMemories?: RetrievedMemoryDebug[];
    query?: string;
    repository?: string;
  }> {
    const body: Record<string, string | number | boolean> = {
      q: query,
      ...(options.view ? { view: options.view } : {}),
      limit: String(options.limit ?? 20)
    };
    if (options.type && options.type !== "all") {
      body["type"] = options.type;
    }
    if (options.subtype && options.subtype !== "all") {
      body["subtype"] = options.subtype;
    }
    if (options.source && options.source !== "all") {
      body["source"] = options.source;
    }
    if (options.scope && options.scope !== "all") {
      body["scope"] = options.scope;
    }
    if (options.scopeId?.trim()) {
      body["scopeId"] = options.scopeId.trim();
    }
    if (options.memoryLayer && options.memoryLayer !== "all") {
      body["memoryLayer"] = options.memoryLayer;
    }
    if (options.status && options.status !== "all") {
      body["status"] = options.status;
    }
    if (options.tags?.trim()) {
      body["tags"] = options.tags.trim();
    }
    if (options.minImportance?.trim()) {
      body["minImportance"] = options.minImportance.trim();
    }
    if (options.includeArchived) {
      body["includeArchived"] = true;
    }
    if (options.includeSuperseded) {
      body["includeSuperseded"] = true;
    }
    if (options.includeExpired) {
      body["includeExpired"] = true;
    }
    if (options.includeHistoricalEpisodic) {
      body["includeHistoricalEpisodic"] = true;
    }

    return request<{
      mock: boolean;
      memories: MemoryRecord[];
      rawCount?: number;
      count?: number;
      retrievalMode?: string;
      vectorEnabled?: boolean;
      vectorUsed?: boolean;
      embeddingProvider?: string;
      embeddingModel?: string;
      embeddingDimensions?: number;
      semanticEmbedding?: boolean;
      embeddingNote?: string;
      queryEmbeddingGenerated?: boolean;
      vectorResultCount?: number;
      keywordResultCount?: number;
      hybridResultCount?: number;
      fallbackUsed?: boolean;
      fallbackReason?: string;
      retrievalScope?: string;
      includedScopes?: Array<{ scope: string; scopeId?: string | null }>;
      includeArchived?: boolean;
      includeSuperseded?: boolean;
      includeExpired?: boolean;
      includeHistoricalEpisodic?: boolean;
      excludedByStatus?: number;
      excludedByTime?: number;
      excludedByScope?: number;
      debugMemories?: RetrievedMemoryDebug[];
      query?: string;
      repository?: string;
    }>("/memory/search", {
      method: "POST",
      body: JSON.stringify(body)
    });
  },

  createMemory(input: CreateMemoryRequest): Promise<MemoryRecord> {
    return request<MemoryRecord>("/memory", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  getMemory(id: string): Promise<MemoryRecord> {
    return request<MemoryRecord>(`/memory/${encodeURIComponent(id)}`);
  },

  updateMemory(id: string, input: UpdateMemoryRequest): Promise<MemoryRecord> {
    return request<MemoryRecord>(`/memory/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  deleteMemory(id: string): Promise<{ ok: boolean; id: string }> {
    return request<{ ok: boolean; id: string }>(`/memory/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  },

  archiveMemory(id: string): Promise<{ ok: boolean; id: string; memory: MemoryRecord }> {
    return request<{ ok: boolean; id: string; memory: MemoryRecord }>(
      `/memory/${encodeURIComponent(id)}/archive`,
      { method: "POST" }
    );
  },

  restoreMemory(id: string): Promise<{ ok: boolean; id: string; memory: MemoryRecord }> {
    return request<{ ok: boolean; id: string; memory: MemoryRecord }>(
      `/memory/${encodeURIComponent(id)}/restore`,
      { method: "POST" }
    );
  },

  forgetMemory(id: string): Promise<{ ok: boolean; id: string; memory: MemoryRecord }> {
    return request<{ ok: boolean; id: string; memory: MemoryRecord }>(
      `/memory/${encodeURIComponent(id)}/forget`,
      { method: "POST" }
    );
  },

  bulkDeleteMemories(ids: string[]): Promise<{ ok: boolean; deleted: number }> {
    return request<{ ok: boolean; deleted: number }>("/memory/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
  },

  getMemoryMaintenanceHealth(signal?: AbortSignal): Promise<{
    ok: boolean;
    repository: string;
    health: MemoryHealthSummary;
  }> {
    return request<{ ok: boolean; repository: string; health: MemoryHealthSummary }>(
      "/memory/maintenance/health",
      signalRequestInit(signal)
    );
  },

  getMemoryMaintenanceStatus(signal?: AbortSignal): Promise<{
    ok: boolean;
    repository: string;
    scheduler: MemoryMaintenanceSchedulerStatus | null;
  }> {
    return request<{
      ok: boolean;
      repository: string;
      scheduler: MemoryMaintenanceSchedulerStatus | null;
    }>("/memory/maintenance/status", signalRequestInit(signal));
  },

  getMemoryVectorIndexStatus(signal?: AbortSignal): Promise<{
    ok: boolean;
    repository: string;
    status: MemoryVectorIndexStatus;
  }> {
    return request<{ ok: boolean; repository: string; status: MemoryVectorIndexStatus }>(
      "/memory/vector-index/status",
      signalRequestInit(signal)
    );
  },

  runMemoryMaintenance(input: {
    dryRun: boolean;
    limit?: number;
    scope?: string;
    scopeId?: string;
  }): Promise<{
    ok: boolean;
    repository: string;
    summary: MemoryMaintenanceSummary;
  }> {
    return request<{
      ok: boolean;
      repository: string;
      summary: MemoryMaintenanceSummary;
    }>("/memory/maintenance/run", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  listRecentMemoryCandidates(
    limit = 20,
    signal?: AbortSignal
  ): Promise<{
    mock: boolean;
    volatile: boolean;
    message?: string;
    count: number;
    storedCount: number;
    rejectedCount: number;
    candidateCount: number;
    fallbackUsed: boolean;
    candidates: MemoryCandidateReview[];
  }> {
    return request<{
      mock: boolean;
      volatile: boolean;
      message?: string;
      count: number;
      storedCount: number;
      rejectedCount: number;
      candidateCount: number;
      fallbackUsed: boolean;
      candidates: MemoryCandidateReview[];
    }>(`/memory/candidates/recent?limit=${limit}`, signalRequestInit(signal));
  },

  acceptMemoryCandidate(
    id: string,
    input: AcceptMemoryCandidateRequest
  ): Promise<{
    ok: boolean;
    alreadyStored?: boolean;
    message?: string;
    memoryId?: string;
    memory: MemoryRecord | null;
  }> {
    return request<{
      ok: boolean;
      alreadyStored?: boolean;
      message?: string;
      memoryId?: string;
      memory: MemoryRecord | null;
    }>(`/memory/candidates/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  rejectMemoryCandidate(
    id: string,
    reason?: string
  ): Promise<{ ok: boolean; candidate: MemoryCandidateReview }> {
    return request<{ ok: boolean; candidate: MemoryCandidateReview }>(
      `/memory/candidates/${encodeURIComponent(id)}/reject`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {})
      }
    );
  },

  getProviderStatus(signal?: AbortSignal): Promise<ProvidersStatusResponse> {
    return request<ProvidersStatusResponse>("/providers/status", signalRequestInit(signal));
  },

  verifyProvider(capability: ProviderCapability): Promise<ProviderVerificationResponse> {
    return request<ProviderVerificationResponse>(`/providers/verify/${capability}`, {
      method: "POST"
    });
  },

  verifyProviderChain(capability: ProviderCapability): Promise<ProviderChainInspectionResponse> {
    return request<ProviderChainInspectionResponse>(`/providers/verify-chain/${capability}`, {
      method: "POST"
    });
  },

  postSpeechActivity(input: {
    sessionId: string;
    captureEpoch: string;
    active: boolean;
  }): Promise<SpeechActivityResponse> {
    return request<SpeechActivityResponse>("/v1/speech-activity", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  postSpeechActivityFrame(
    input: {
      sessionId: string;
      captureEpoch: string;
      pcmBase64: string;
      sampleRate: number;
    },
    signal?: AbortSignal
  ): Promise<SpeechActivityResponse> {
    return request<SpeechActivityResponse>("/v1/speech-activity/frames", {
      ...signalRequestInit(signal),
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  getSpeechActivity(sessionId = "default", signal?: AbortSignal): Promise<SpeechActivityResponse> {
    return request<SpeechActivityResponse>(
      `/v1/speech-activity?sessionId=${encodeURIComponent(sessionId)}`,
      signalRequestInit(signal)
    );
  },

  transcribeAudio(input: {
    preview?: boolean;
    audioBase64?: string;
    mimeType?: string;
    language?: string;
    sessionId?: string;
    captureEpoch?: string;
    speakerId?: string;
    voiceProfileId?: string;
    subjectUserId?: string;
    createdByUserId?: string;
    mockText?: string;
    signal?: AbortSignal;
  }): Promise<TranscriptionResponse> {
    const { signal, ...payload } = input;
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify(payload)
    };
    if (signal) init.signal = signal;
    return request<TranscriptionResponse>("/v1/audio/transcriptions", init);
  },

  admitSpeechPlayback(input: {
    sessionId: string;
    requestId: string;
  }): Promise<SpeechPlaybackEffectResponse> {
    return request<SpeechPlaybackEffectResponse>("/v1/speech-playback", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  reportSpeechPlaybackOutcome(input: {
    effectId: string;
    outcome: "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED";
  }): Promise<SpeechPlaybackEffectResponse> {
    return request<SpeechPlaybackEffectResponse>("/v1/speech-playback/outcome", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  sendVoiceMessage(input: {
    audioBase64?: string;
    mimeType?: string;
    language?: string;
    sessionId?: string;
    speakerId?: string;
    voiceProfileId?: string;
    subjectUserId?: string;
    createdByUserId?: string;
    mockText?: string;
    options?: {
      readMemory?: boolean;
      writeMemory?: boolean;
      promptPreview?: boolean;
      voiceOutput?: boolean;
    };
  }): Promise<VoiceMessageResponse> {
    return request<VoiceMessageResponse>("/v1/voice/message", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  synthesizeSpeech(input: {
    text: string;
    voice?: string;
    format?: "mp3" | "wav" | "opus" | "pcm" | "mulaw" | "alaw";
    language?: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<TTSResponse> {
    const { signal, ...payload } = input;
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify(payload)
    };
    if (signal) init.signal = signal;
    return request<TTSResponse>("/v1/tts", {
      ...init
    });
  },

  analyzeVision(input: {
    imageBase64?: string;
    imageUrl?: string;
    mimeType?: string;
    prompt?: string;
    sessionId?: string;
    speakerId?: string;
    subjectUserId?: string;
    createdByUserId?: string;
    signal?: AbortSignal;
  }): Promise<VisionAnalyzeResponse> {
    const { signal, ...payload } = input;
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify(payload)
    };
    if (signal) init.signal = signal;
    return request<VisionAnalyzeResponse>("/v1/vision/analyze", {
      ...init
    });
  },

  listRecentEvents(
    limit = 50,
    signal?: AbortSignal
  ): Promise<{ mock: boolean; events: RuntimeEvent[] }> {
    return request<{ mock: boolean; events: RuntimeEvent[] }>(
      `/events/recent?limit=${limit}`,
      signalRequestInit(signal)
    );
  },

  getLatestPromptPreview(signal?: AbortSignal): Promise<PromptPreviewResponse> {
    return request<PromptPreviewResponse>("/debug/prompt/latest", signalRequestInit(signal));
  },

  getRuntimeSettings(signal?: AbortSignal): Promise<RuntimeSettingsResponse> {
    return request<RuntimeSettingsResponse>("/settings/runtime", signalRequestInit(signal));
  },

  updateRuntimeSettings(
    input: RuntimeSettingsUpdateRequest
  ): Promise<RuntimeSettingsUpdateResponse> {
    return request<RuntimeSettingsUpdateResponse>("/settings/runtime", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  reloadRuntimeSettings(): Promise<RuntimeSettingsReloadResponse> {
    return request<RuntimeSettingsReloadResponse>("/settings/runtime/reload", {
      method: "POST"
    });
  },

  deepRestartRuntime(): Promise<{
    ok?: boolean;
    restartRequested?: boolean;
    message: string;
    supervisorActive?: boolean;
    autoMigrate?: boolean;
    runtimeEnvDir?: string;
  }> {
    return request("/system/restart/deep", {
      method: "POST"
    });
  },

  createDashboardWebSocket(): WebSocket {
    return new WebSocket(resolveWebSocketUrl("/ws?dashboard=true"));
  },

  async postEmbodiedPresentationOutcome(report: EmbodiedPresentationOutcomeReport): Promise<void> {
    await request("/v1/embodied-presentation/outcome", {
      method: "POST",
      body: JSON.stringify(report)
    });
  }
};

function signalRequestInit(signal: AbortSignal | undefined): RequestInit | undefined {
  return signal ? { signal } : undefined;
}

async function streamTextResponse(
  path: "/v1/messages/stream" | "/v1/proactive-turns/stream",
  input: SendMessageRequest | ProactiveTurnStreamRequest,
  options: MessageStreamOptions
): Promise<CompletedMessage> {
  const headers = new Headers({ "content-type": "application/json" });
  if (dashboardDevToken && shouldAttachDashboardDevToken(path, "POST")) {
    headers.set("authorization", `Bearer ${dashboardDevToken}`);
  }

  const requestInit: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(input)
  };
  if (options.signal) {
    requestInit.signal = options.signal;
  }
  const response = await fetch(`${apiBaseUrl()}${path}`, requestInit);

  if (!response.ok) {
    throw new ApiError(await safeHttpStreamError(response), response.status);
  }

  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    throw new MessageStreamProtocolError("The streaming response was not SSE.");
  }
  if (!response.body) {
    throw new MessageStreamProtocolError("The streaming response has no body.");
  }

  const parser = new MessageSseParser();
  const reader = response.body.getReader();
  let accumulatedText = "";
  let completed: CompletedMessage | undefined;
  let readerDone = false;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        readerDone = true;
        break;
      }
      for (const event of parser.push(result.value)) {
        if (event.type === "text-delta") {
          if (completed) {
            throw new MessageStreamProtocolError("The message stream continued after completion.");
          }
          accumulatedText += event.text;
          options.onEvent?.(event);
          continue;
        }
        if (event.type === "error") {
          options.onEvent?.(event);
          throw new MessageStreamError(event);
        }
        if (event.content !== accumulatedText) {
          throw new MessageStreamProtocolError(
            "The completed message does not match its text deltas."
          );
        }
        completed = event;
        options.onEvent?.(event);
      }
    }

    parser.finish();
    if (!completed) {
      throw new MessageStreamProtocolError("The message stream ended before completion.");
    }
    return completed;
  } finally {
    if (!readerDone) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function streamProactiveLive(
  sessionId: string,
  options: ProactiveStreamOptions
): Promise<void> {
  const headers = new Headers();
  if (dashboardDevToken && shouldAttachDashboardDevToken("/v1/proactive-turns/live", "GET")) {
    headers.set("authorization", `Bearer ${dashboardDevToken}`);
  }
  const requestInit: RequestInit = { method: "GET", headers };
  if (options.signal) requestInit.signal = options.signal;
  const response = await fetch(
    `${apiBaseUrl()}/v1/proactive-turns/live?sessionId=${encodeURIComponent(sessionId)}`,
    requestInit
  );
  if (!response.ok) {
    throw await createHttpStreamError(response);
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    throw new MessageStreamProtocolError("The streaming response was not SSE.");
  }
  if (!response.body) {
    throw new MessageStreamProtocolError("The streaming response has no body.");
  }
  const parser = new ProactiveSseParser();
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      for (const event of parser.push(result.value)) {
        if (event.type === "error") {
          options.onEvent?.(event);
          continue;
        }
        options.onEvent?.(event);
      }
    }
    parser.finish();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function streamProactiveTextResponse(
  input: ProactiveTurnStreamRequest,
  options: ProactiveStreamOptions
): Promise<ProactiveTurnResult> {
  const headers = new Headers({ "content-type": "application/json" });
  if (dashboardDevToken && shouldAttachDashboardDevToken("/v1/proactive-turns/stream", "POST")) {
    headers.set("authorization", `Bearer ${dashboardDevToken}`);
  }

  const requestInit: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(input)
  };
  if (options.signal) requestInit.signal = options.signal;
  const response = await fetch(`${apiBaseUrl()}/v1/proactive-turns/stream`, requestInit);

  if (!response.ok) {
    throw await createHttpStreamError(response);
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    throw new MessageStreamProtocolError("The streaming response was not SSE.");
  }
  if (!response.body) {
    throw new MessageStreamProtocolError("The streaming response has no body.");
  }

  const parser = new ProactiveSseParser();
  const reader = response.body.getReader();
  let accumulatedText = "";
  let decision: ProactiveDecisionEvent | undefined;
  let completed: CompletedMessage | undefined;
  let readerDone = false;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        readerDone = true;
        break;
      }
      for (const event of parser.push(result.value)) {
        if (event.type === "proactive-decision") {
          decision = event;
          options.onEvent?.(event);
          continue;
        }
        if (event.type === "text-delta") {
          accumulatedText += event.text;
          options.onEvent?.(event);
          continue;
        }
        if (event.type === "error") {
          options.onEvent?.(event);
          throw new MessageStreamError(event);
        }
        if (event.content !== accumulatedText || accumulatedText.length === 0) {
          throw new MessageStreamProtocolError(
            "The proactive completion does not match meaningful text deltas."
          );
        }
        completed = event;
        options.onEvent?.(event);
      }
    }

    parser.finish();
    if (decision?.decision === "NO_OP") return decision;
    if (!completed || decision?.decision !== "REQUEST_TEXT") {
      throw new MessageStreamProtocolError("The proactive stream ended before completion.");
    }
    return completed;
  } finally {
    if (!readerDone) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function toProactiveTurnStreamRequestBody(
  input: ProactiveTurnStreamRequest
): ProactiveTurnStreamRequest {
  return {
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    modality: "text",
    options: {
      readMemory: input.options.readMemory,
      ...(input.options.promptPreview === undefined
        ? {}
        : { promptPreview: input.options.promptPreview })
    }
  };
}

export type LocalServicesStatus = {
  checkedAt: string;
  stt: {
    available: boolean;
    selected: boolean;
    speakerProfiles: boolean;
    diarization: boolean;
    vad: boolean;
    profileCount: number;
  };
  memory: {
    backend: string;
    repository: string;
    database: string;
    ollama: boolean;
    embedderPresent: boolean;
    model: string;
    dimensions: number;
    status: string;
    crud: boolean;
    search: boolean;
    infer: boolean;
    embedder: boolean;
    vectorStore: boolean;
  };
  tts: {
    configured: boolean;
    observed: string;
    provider: string;
    available?: boolean;
    message?: string;
  };
};

export type LocalConnectionService = "embedding" | "stt" | "tts";
export type LocalConnectionState =
  | "ready"
  | "hibernated"
  | "warming"
  | "unavailable"
  | "needs-key"
  | "not-configured";
export type LocalConnectionFinding = {
  service: LocalConnectionService;
  testedEndpoint: string;
  source: "saved" | "default" | "explicit";
  state: LocalConnectionState;
  model?: string;
  dimensions?: number;
  voice?: string;
  detail?: string;
};
export type LocalConnectionDetectResponse = {
  checkedAt: string;
  services: Record<LocalConnectionService, LocalConnectionFinding>;
};

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (dashboardDevToken && shouldAttachDashboardDevToken(path, init?.method)) {
    headers.set("authorization", `Bearer ${dashboardDevToken}`);
  }

  const controller = new AbortController();
  const abort = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) abort();
  init?.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await withActionDeadline((async () => {
      const response = await fetch(`${apiBaseUrl()}${path}`, {
        ...init, headers, signal: controller.signal
      });
      if (!response.ok) {
        const text = await response.text();
        throw new ApiError(text || response.statusText, response.status);
      }
      return response.json() as Promise<T>;
    })(), path.includes("/import") ? 120_000 : 60_000, () => controller.abort());
  } finally {
    init?.signal?.removeEventListener("abort", abort);
  }
}

function shouldAttachDashboardDevToken(path: string, method: string | undefined): boolean {
  if (path.startsWith("/product/")) return true;
  if (path.startsWith("/memory/candidates")) {
    return true;
  }
  const normalized = method?.toUpperCase() ?? "GET";
  if (
    normalized === "GET" &&
    ["/settings/runtime", "/local-services/status", "/voice-profiles"].includes(path)
  ) {
    return true;
  }
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

async function createHttpStreamError(response: Response): Promise<ApiError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new ApiError(
      response.status === 400 ? "请求内容无效。" : "消息流请求失败。",
      response.status
    );
  }
  const extras = isRecord(payload)
    ? {
        ...(typeof payload["error"] === "string" ? { error: payload["error"] } : {}),
        ...(typeof payload["reason"] === "string" ? { reason: payload["reason"] } : {})
      }
    : {};
  return new ApiError(describeHttpStreamError(payload, response.status), response.status, extras);
}

async function safeHttpStreamError(response: Response): Promise<string> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return response.status === 400 ? "请求内容无效。" : "消息流请求失败。";
  }

  return describeHttpStreamError(payload, response.status);
}

function describeHttpStreamError(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    if (payload["error"] === "invalid_request") {
      return "请求内容无效。";
    }
    if (payload["error"] === "proactive_not_admitted") {
      return "Runtime 未接纳此次主动发起。";
    }
    if (typeof payload["code"] === "string") {
      return safeClientErrorMessage(payload["code"]);
    }
    if (payload["error"] === "persistence_failed") {
      return "消息保存失败，请稍后重试。";
    }
  }
  return status === 400 ? "请求内容无效。" : "消息流请求失败。";
}

function safeClientErrorMessage(code: string): string {
  switch (code) {
    case "MISSING_API_KEY":
    case "INVALID_API_KEY":
    case "PERMISSION_DENIED":
      return "Provider 认证失败。";
    case "MODEL_NOT_FOUND":
      return "Provider 模型或 API 地址不存在，请检查模型 ID 和 API Base URL。";
    case "RATE_LIMITED":
      return "Provider 请求过于频繁。";
    case "TIMEOUT":
      return "Provider 请求超时。";
    case "CANCELLED":
      return "生成已取消。";
    case "PROVIDER_UNAVAILABLE":
      return "Provider 当前不可用。";
    default:
      return "消息流请求失败。";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveWebSocketUrl(path: string): string {
  if (explicitWebSocketBaseUrl) {
    return `${explicitWebSocketBaseUrl.replace(/\/$/, "")}${path}`;
  }

  const base = apiBaseUrl();
  if (base.startsWith("http://") || base.startsWith("https://")) {
    return `${base.replace(/^http/, "ws").replace(/\/$/, "")}${path}`;
  }

  // Browser product surfaces use the WebUI's own origin. Development Vite and
  // packaged static WebUI each proxy /ws to the Runtime selected for that
  // product instance, so there is no well-known-port escape hatch here.
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (!window.location.host) {
    throw new Error("Browser WebSocket origin is unavailable.");
  }
  return `${protocol}//${window.location.host}${path}`;
}

export async function productSample(id: string): Promise<Blob> {
  const controller = new AbortController();
  return withActionDeadline((async () => {
    const response = await fetch(`${apiBaseUrl()}/product/voice-samples/${encodeURIComponent(id)}`, {
      headers: dashboardDevToken ? { authorization: `Bearer ${dashboardDevToken}` } : {},
      signal: controller.signal
    });
    if (!response.ok) throw new Error("Sample unavailable.");
    return response.blob();
  })(), 30_000, () => controller.abort());
}
