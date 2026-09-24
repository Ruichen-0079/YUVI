import type { VoiceBindingReferences } from "./voice-binding-references.js";
import type { CharacterAbiSemanticSection } from "@companion/character-abi";
import type { CanonicalContext } from "@companion/prompt-builder";
import type { P8CorrectionStore } from "@companion/p8";
import type { CharacterDecision, CharacterOutputLanguage } from "@companion/character-abi";
import type {
  ProactiveControlAuthority,
  RuntimeProactiveStateStore
} from "./runtime-proactive-policy.js";
import type { EventBus } from "@companion/event-bus";
import type {
  ConversationRepository,
  CurrentAffect,
  DreamWriter,
  FinalizedIngestionPort,
  Memory,
  MemoryCandidate,
  MemoryCandidateStorageResult,
  MemoryConversationTurnWriteResult,
  MemoryExtractorStatus,
  MemoryIngestionCoordinatorPort,
  MemoryProvider,
  MemoryRetrievalMode,
  MemoryRetrievalResult,
  MemoryRetrievalStatus,
  RecentEpisodeStore,
  DreamJobStore,
  RetrievedMemoryDebug
} from "@companion/memory";
import type { PromptBuildInput, PromptBuildOutput } from "@companion/prompt-builder";
import type {
  EmbodiedPresentationOutcomeReport,
  EmbodiedPresentationRequest,
  RuntimeEvent,
  TurnOrigin
} from "@companion/protocol";
import type { RuntimeEmbodiedEffectRecordInitializationDecision } from "./runtime-embodied-effect-record-initialization.js";
import type {
  ChatInput,
  ChatOutput,
  ProviderCallOptions,
  ProviderCapability,
  ProviderHealth,
  ProviderMetadata,
  ProviderResolver,
  STTInput,
  TokenUsage,
  VisionInput
} from "@companion/providers";
import type { MemoryContextBuilder, MemoryContextDrop } from "./memory-context.js";

export type RuntimeLogger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
};

export type RuntimeOrchestratorOptions = {
  eventBus: EventBus;
  memory: RuntimeMemoryPort;
  promptBuilder: RuntimePromptBuilderPort;
  providers: ProviderResolver;
  conversation?: ConversationRepository | undefined;
  finalizedIngestion?: FinalizedIngestionPort | undefined;
  memoryIngestionCoordinator?: MemoryIngestionCoordinatorPort | undefined;
  memoryRepository?: string | undefined;
  directContext?: Partial<DirectContextConfig> | undefined;
  memoryContextBuilder?: Pick<MemoryContextBuilder, "build"> | undefined;
  recentEpisodeStore?: RecentEpisodeStore | undefined;
  dreamJobStore?: DreamJobStore | undefined;
  dreamWriter?: DreamWriter | undefined;
  dreamProvider?: MemoryProvider | undefined;
  logger?: RuntimeLogger;
  /** Runtime-owned Character generation and its bounded cognition callback. */
  voiceBindingReferences?: VoiceBindingReferences | undefined;
  voicePersonaId?: string | undefined;
  p8CorrectionStore?: P8CorrectionStore | undefined;
  character?: RuntimeCharacterPort | undefined;
  characterCognition?: RuntimeCharacterCognitionExecutor | undefined;
  /** Host-owned one-shot capture; bytes never cross the Character contract. */
  captureScreen?: ((signal: AbortSignal) => Promise<Uint8Array>) | undefined;
  /** Explicit semantic preference transported to Character and final TTS. */
  outputLanguage?: CharacterOutputLanguage | undefined;
  /** Optional production Character -> Runtime -> Presentation composition. */
  embodiedPresentation?: RuntimeEmbodiedPresentationPort | undefined;
  /** Wall-clock source for suppression expiry and eligible_after. Tests inject a fake. */
  now?: (() => number) | undefined;
  /**
   * User preference for proactive initiation. `undefined` preserves existing P6
   * tests (no Runtime consent gate). Production server supplies an explicit
   * boolean and fail-closes until a control intent arrives.
   */
  proactiveConsentEnabled?: boolean | undefined;
  proactiveScoreThreshold?: number | undefined;
  proactiveEvaluationIntervalMs?: number | undefined;
  /** Smallest durable snapshot for suppression / eligible_after across Runtime reconstruction. */
  proactiveStateStore?: RuntimeProactiveStateStore | undefined;
  /** Injected wake timer for the Runtime-owned proactive scheduler. */
  setProactiveWake?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  clearProactiveWake?: ((handle: unknown) => void) | undefined;
};

export type RuntimeCharacterCognitionExecutor = (
  request: unknown,
  problem: string,
  options: Readonly<{
    execution: import("./runtime-cognition-interaction.js").RuntimeCognitionExecution;
    canonicalContext?: CanonicalContext | undefined;
    signal?: AbortSignal | undefined;
    runtimeAuthorizedPath?: string | undefined;
  }>
) => Promise<unknown>;

/**
 * One Character pass result. `decision` is the stable Character semantic
 * decision (Atom 06); Runtime consumes it but never reinterprets it. When the
 * reply disposition is `NEED_COGNITION`, the Character side also supplies the
 * Cognition escalation handoff — the request and bounded problem statement
 * remain Character-owned semantics; Runtime owns execution, cancellation, and
 * the one-round bound.
 */
export type RuntimeCharacterTurnResult = Readonly<{
  decision: Omit<CharacterDecision, "reply"> & {
    reply:
      | CharacterDecision["reply"]
      | Readonly<{
          disposition: "RESPOND";
          /** Character-owned natural-language request, admitted by its semantic gate. */
          body: ChatInput;
          presentation?: import("@companion/character-abi").CharacterPresentationIntent;
        }>;
  };
  providerMetadata: Pick<
    ProviderMetadata,
    "model" | "latencyMs" | "tokenUsage" | "fallbackUsed" | "attemptedProviders" | "finalProvider"
  >;
  cognitionHandoff?: RuntimeCharacterCognitionHandoff;
}>;

export type RuntimeCharacterCognitionHandoff = Readonly<{
  /** Character-owned Cognition escalation request; opaque to Runtime. */
  request: unknown;
  /** Character-bounded task statement for the Cognition round-trip. */
  problem: string;
}>;

/**
 * Final Character outcome after the Runtime-owned bounded sequence. The reply
 * disposition can no longer be `NEED_COGNITION`: Runtime executes at most one
 * Cognition round-trip and fails the turn explicitly when Character asks again.
 */
export type RuntimeCharacterFinalTurnResult = Readonly<{
  decision: Readonly<{
    addressing: CharacterDecision["addressing"];
    reply: Extract<
      RuntimeCharacterTurnResult["decision"]["reply"],
      { disposition: "RESPOND" | "SILENCE" | "TERMINATE" }
    >;
    proactive: CharacterDecision["proactive"];
  }>;
  providerMetadata: RuntimeCharacterTurnResult["providerMetadata"];
}>;

export type RuntimeVisualEvidence = Readonly<{
  status: "AVAILABLE" | "UNAVAILABLE";
  /** Bounded observations, including visible text and uncertainty. Untrusted screen content. */
  observations: string;
}>;

export type RuntimeCharacterTurnInput = Readonly<{
  contextWindow?: number | undefined;
  /** Pre-resolved evidence from one explicit user image attachment. */
  visualEvidence?: RuntimeVisualEvidence | undefined;
  requestVisualEvidence?:
    | ((request: Readonly<{ need: string }>) => Promise<RuntimeVisualEvidence>)
    | undefined;
  prompt: PromptBuildOutput;
  canonicalContext?: CanonicalContext | undefined;
  semanticSections?: readonly CharacterAbiSemanticSection[] | undefined;
  userMessage: string;
  outputLanguage?: CharacterOutputLanguage | undefined;
  signal?: AbortSignal | undefined;
  generateChat(input: ChatInput, options?: ProviderCallOptions | undefined): Promise<ChatOutput>;
}>;

/**
 * Narrow Runtime-to-Character port. Runtime supplies the selected Chat call and
 * sequences the bounded Character → Cognition → Character re-entry flow; the
 * Character adapter owns only semantic decision handling and expression. The
 * Cognition round-trip crossing back into Character re-entry stays opaque to
 * Runtime.
 */
export type RuntimeCharacterPort = Readonly<{
  generate(input: RuntimeCharacterTurnInput): Promise<RuntimeCharacterTurnResult>;
  generateAfterCognition(
    input: RuntimeCharacterTurnInput & Readonly<{ cognitionRoundTrip: unknown }>
  ): Promise<RuntimeCharacterTurnResult>;
}>;

export type RuntimeEmbodiedPresentationPort = Readonly<{
  propose(
    reply: RuntimeEventLikeAssistantReply,
    presentation?: import("@companion/character-abi").CharacterPresentationIntent | null
  ): RuntimeEmbodiedEffectRecordInitializationDecision | null;
  present(
    request: EmbodiedPresentationRequest,
    traceAnchor: RuntimeEvent,
    observe?: (report: EmbodiedPresentationOutcomeReport) => Promise<void>
  ): EmbodiedPresentationOutcomeReport | Promise<EmbodiedPresentationOutcomeReport>;
}>;

export type RuntimeEventLikeAssistantReply = RuntimeEvent<
  "agent.reply",
  { content: string; sessionId?: string }
>;

export type ConversationPersistenceOperation =
  | "session_create"
  | "user_message_save"
  | "assistant_message_save"
  | "assistant_stream_create"
  | "assistant_stream_append"
  | "assistant_stream_complete"
  | "assistant_stream_fail"
  | "stream_recovery"
  | "context_restore";

export type DirectContextConfig = {
  enabled: boolean;
  maxTurns: number;
  maxChars: number;
};

export type RuntimeMemoryPort = {
  retrieveRelevantMemories(input: {
    text: string;
    limit?: number;
    sessionId?: string;
    projectId?: string;
    personaId?: string;
    subjectUserId?: string;
    speakerId?: string;
  }): Promise<Memory[]>;
  /** Optional semantic provider used by the Runtime read path during migration. */
  getVoiceBindingProvider?(): MemoryProvider | undefined;
  getMemoryProvider?(): MemoryProvider | undefined;
  retrieveRelevantMemoriesWithMetadata?(input: {
    text: string;
    limit?: number;
    sessionId?: string;
    projectId?: string;
    personaId?: string;
    subjectUserId?: string;
    speakerId?: string;
  }): Promise<MemoryRetrievalResult>;
  scoreImportance(text: string): number;
  /** When true, formal LTM is Mem0 — Legacy extract/write must not run. */
  isMem0Backend?(): boolean;
  getBackendKind?(): "legacy" | "mem0";
  storeConversationTurn?(input: {
    userMessage: string;
    assistantMessage: string;
    sessionId?: string | undefined;
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
    userMessageId?: string | null | undefined;
    assistantMessageId?: string | null | undefined;
    traceId?: string | null | undefined;
    conversationId?: string | null | undefined;
    language?: string | null | undefined;
    idempotencyKey?: string | null | undefined;
  }): Promise<MemoryConversationTurnWriteResult>;
  forgetExplicitMemory?(input: {
    userMessage: string;
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
  }): Promise<{ deleted: number; notFound: boolean; memoryIds: string[]; query: string }>;
  extractCandidates?(input: {
    sessionId?: string | undefined;
    userMessage: string;
    assistantMessage?: string | undefined;
    sourceTraceId?: string | null | undefined;
    timestamp?: string | undefined;
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
    createdByUserId?: string | null | undefined;
    speakerId?: string | null | undefined;
    voiceProfileId?: string | null | undefined;
    providerMetadata?: SafeProviderCallMetadata | undefined;
    memoryOptions?:
      | {
          readMemory: boolean;
          writeMemory: boolean;
        }
      | undefined;
  }): Promise<MemoryCandidate[]>;
  getExtractorStatus?(): MemoryExtractorStatus;
  rememberCandidate?(
    candidate: MemoryCandidate,
    options?: { source?: string; tags?: string[] }
  ): Promise<Memory>;
  processCandidateForStorage?(
    candidate: MemoryCandidate,
    options?: {
      source?: string;
      tags?: string[];
      skipAdmissionPolicy?: boolean;
      storageReason?: string;
    }
  ): Promise<MemoryCandidateStorageResult>;
  rememberInteraction(input: {
    userMessage: string;
    assistantMessage: string;
    source?: string;
    sourceTraceId?: string | null;
    tags?: string[];
  }): Promise<Memory | null>;
};

export type RuntimePromptBuilderPort = {
  buildPrompt(input: PromptBuildInput): PromptBuildOutput;
};

export type HandleUserMessageInput = {
  sessionId: string;
  content: string;
  voiceOutput?: boolean | undefined;
  traceId?: string | undefined;
  parentId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  createdByUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  voiceProfileId?: string | null | undefined;
};

export type RuntimeImageAttachment = Readonly<{
  imageBase64: string;
  mimeType: "image/png" | "image/jpeg";
}>;

export type HandleUserMessageOptions = {
  voiceOutput?: boolean | undefined;
  useMemory?: boolean | undefined;
  readMemory?: boolean | undefined;
  writeMemory?: boolean | undefined;
  /** One explicit user-provided image for the same reactive turn. Never persisted as bytes. */
  imageAttachment?: RuntimeImageAttachment | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Semantic controller boundary for durable proactive policy. This is not a
   * person identity and must not be inferred from speakerId.
   */
  controlAuthority?: ProactiveControlAuthority | undefined;
};

export type AssistantInitiatedTurnInput = {
  sessionId: string;
  idempotencyKey: string;
  readMemory: boolean;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
};

export type AssistantInitiatedTurnOptions = {
  signal?: AbortSignal | undefined;
  promptPreview?: boolean | undefined;
};

export type ProactiveShouldSpeak = "NO_OP" | "REQUEST_TEXT";

export type MaybeSynthesizeSpeechOptions = {
  signal?: AbortSignal | undefined;
};

export type RuntimeReplyStreamEvent =
  | {
      type: "proactive-decision";
      decision: ProactiveShouldSpeak;
      sessionId: string;
      traceId: string;
    }
  | {
      type: "text-delta";
      language?: string;
      text: string;
      messageId: string;
      sessionId: string;
      traceId: string;
    }
  | {
      type: "completed";
      language?: string;
      messageId: string;
      sessionId: string;
      traceId: string;
      content: string;
      provider: string;
    };

export type StreamUserMessageOptions = HandleUserMessageOptions & {
  signal?: AbortSignal | undefined;
};

export type RuntimePromptPreview = {
  traceId: string;
  timestamp: string;
  turnOrigin: TurnOrigin;
  userMessage?: string | undefined;
  proactiveInstruction?: string | undefined;
  legacyUseMemory: boolean | undefined;
  useMemory: boolean;
  readMemory: boolean;
  writeMemory: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  memoryRepository: string;
  retrievedMemoryCountRaw: number;
  retrievedMemoryCount: number;
  memoryProviderStatus?: MemoryRetrievalStatus | undefined;
  memoryFinalStatus?: MemoryRetrievalStatus | undefined;
  memoryProviderSource?: string | undefined;
  memoryProviderErrorCode?: string | null | undefined;
  memoryRetrievalLimited: boolean;
  memoryQueryLength: number;
  memoryRetrievalEventIds: string[];
  memoryRetrievalDroppedCount: number;
  memoryRetrievalDropped: MemoryContextDrop[];
  memoryMetadataPresent: boolean;
  memorySourceTurnLinkCount: number;
  memoryConversationLinked: boolean;
  memoryParticipantsCount: number;
  memoryFallbackProducedResults: boolean;
  memoryFallbackUsed: boolean;
  memoryFallbackReason?: string | undefined;
  memoryFallbackSource?: "legacy" | undefined;
  retrievalMode: MemoryRetrievalMode;
  vectorEnabled: boolean;
  vectorUsed: boolean;
  embeddingProvider?: string | undefined;
  embeddingModel?: string | undefined;
  embeddingDimensions?: number | undefined;
  semanticEmbedding?: boolean | undefined;
  embeddingNote?: string | undefined;
  queryEmbeddingGenerated: boolean;
  vectorResultCount: number;
  keywordResultCount: number;
  hybridResultCount: number;
  retrievalFallbackUsed: boolean;
  retrievalFallbackReason?: string | undefined;
  retrievalScope: string;
  includedScopes: Array<{ scope: string; scopeId?: string | null }>;
  includeArchived: boolean;
  includeSuperseded: boolean;
  includeExpired: boolean;
  currentTime: string;
  currentAffect?: CurrentAffect | undefined;
  directContextEnabled: boolean;
  directContextTurnCount: number;
  directContextCharCount: number;
  directContextTruncated: boolean;
  directContextSource: string;
  recentEpisodicCount?: number | undefined;
  associativeCount?: number | undefined;
  associativeSkippedReason?: string | undefined;
  temporalAgeBand?: string | undefined;
  contextCompressionBeforeTokens?: number | undefined;
  contextCompressionAfterTokens?: number | undefined;
  excludedByStatus: number;
  excludedByTime: number;
  excludedByScope: number;
  retrievedMemories: RetrievedMemoryDebug[];
  sections: PromptBuildOutput["sections"];
  finalMessages: PromptBuildOutput["messages"];
  finalPrompt: string;
  characterCount: number;
  estimatedTokens: number;
  truncated: boolean;
  providerName?: string | undefined;
  providerModel?: string | undefined;
  providerMock?: boolean | undefined;
  providerLatencyMs?: number | undefined;
  providerHealthStatus?: string | undefined;
  tokenUsage?: TokenUsage | undefined;
  memoryExtractorMode: string;
  memoryExtractorActive: string;
  memoryExtractorUsed: boolean;
  memoryExtractorProvider?: string | undefined;
  memoryExtractionCandidateCount: number;
  storedMemoryCount: number;
  rejectedMemoryCount: number;
  rejectedReasons: string[];
  fallbackUsed: boolean;
  llmExtractionError?: string | undefined;
  llmExtractionRawPreview?: string | undefined;
  validationIssues?: string[] | undefined;
  memoryCandidates: RuntimeMemoryCandidateReview[];
  memoryExtractionSkippedReason?: string | undefined;
  memoryWriteStatus?: RuntimeMemoryWriteStatus | undefined;
  memoryWriteAttemptedCount?: number | undefined;
  memoryWriteWrittenCount?: number | undefined;
  memoryWriteRejectedCount?: number | undefined;
  memoryWriteDeduplicatedCount?: number | undefined;
  memoryWriteSkippedCount?: number | undefined;
  memoryWriteIdempotencyKey?: string | undefined;
};

export type RuntimeMemoryWriteStatus = "pending" | "complete" | "partial" | "failed" | "skipped";

export type RuntimeLifecycleState = "active" | "sealing" | "disposed";

export type RuntimeMemoryCandidateDecision = "stored" | "rejected";

export type RuntimeMemoryCandidateReview = {
  id: string;
  traceId: string;
  timestamp: string;
  type: MemoryCandidate["type"];
  subtype?: MemoryCandidate["subtype"];
  scope?: MemoryCandidate["scope"];
  scopeId?: MemoryCandidate["scopeId"];
  memoryLayer?: MemoryCandidate["memoryLayer"];
  content: string;
  contentPreview: string;
  summary?: string | null | undefined;
  importance: number;
  confidence?: number | undefined;
  tags: string[];
  reason: string;
  decision: RuntimeMemoryCandidateDecision;
  rejectedReason?: string | undefined;
  storageReason?: string | undefined;
  explicitRememberRequested?: boolean | undefined;
  correctionRequested?: boolean | undefined;
  originRole?: "user" | "assistant" | "mixed" | undefined;
  canonicalFingerprint?: string | undefined;
  canonicalEventKey?: string | undefined;
  temporalStatus?: "not-needed" | "normalized" | "unresolved" | undefined;
  temporalSuggestion?: string | undefined;
  source: "runtime" | "dashboard";
  sourceTraceId?: string | null | undefined;
  storedMemoryId?: string | undefined;
  createdAt: string;
  extractorMode: string;
  extractorProvider?: string | undefined;
  fallbackUsed: boolean;
  metadata?: Record<string, unknown> | undefined;
  retentionClass?: string | undefined;
  computedExpiresAt?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  observedAt?: string | undefined;
  eventTime?: string | null | undefined;
  validFrom?: string | undefined;
  validUntil?: string | null | undefined;
  expiresAt?: string | null | undefined;
  possibleSupersedes?: string[] | undefined;
  possibleContradictions?: string[] | undefined;
  relationshipConfidence?: number | undefined;
  relationshipReason?: string | undefined;
};

export type RuntimeMemoryCandidateAcceptResult =
  | {
      alreadyStored: false;
      memory: Memory;
      memoryId: string;
      message: string;
    }
  | {
      alreadyStored: true;
      memory: null;
      memoryId: string;
      message: string;
    };

export type SafeProviderCallMetadata = {
  name: string;
  capability: ProviderCapability;
  model?: string | undefined;
  mock: boolean;
  latencyMs?: number | undefined;
  tokenUsage?: TokenUsage | undefined;
  healthStatus?: ProviderHealth["status"] | undefined;
  fallbackUsed?: boolean | undefined;
  attemptedProviders?: ProviderMetadata["attemptedProviders"];
  finalProvider?: string | undefined;
};

export type SpeechTranscriptionInput = STTInput & {
  sessionId?: string | undefined;
  captureEpoch?: string | undefined;
  traceId?: string | undefined;
  parentId?: string | undefined;
  signal?: AbortSignal | undefined;
};

export type ReserveFinalizedSpeechObservationInput = {
  sessionId?: string | undefined;
  captureEpoch?: string | undefined;
};

export type SpeechActivityObservationInput = {
  sessionId?: string | undefined;
  captureEpoch: string;
  active: boolean;
};

export type SpeechActivitySnapshot = {
  speechActive: boolean;
  captureEpoch: string | null;
  activityRevision: number;
  speechPlaybackEffectId?: string | null;
  speechPlaybackRequestId?: string | null;
  speechPlaybackState?: string | null;
  revokedSpeechEffectId?: string;
  revokedSpeechRequestId?: string;
};

export type HandleImageInputInput = VisionInput & {
  sessionId: string;
  traceId?: string | undefined;
  parentId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  createdByUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  voiceProfileId?: string | null | undefined;
};
