import type { MemoryClaim, MemoryClaimAttributionInput } from "./provider.js";
import type { MemoryLineageV1 } from "./lineage.js";

export const MemoryTypes = [
  "working",
  "episodic",
  "semantic",
  "emotional",
  "procedural",
  "relationship"
] as const;

export type MemoryType = (typeof MemoryTypes)[number];

export const MemorySubtypes = [
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
] as const;

export type MemorySubtype = (typeof MemorySubtypes)[number];

export const MemoryScopes = ["user", "project", "agent", "plugin", "session"] as const;
export type MemoryScope = (typeof MemoryScopes)[number];

export const MemoryLayers = ["core", "recall", "archival", "working"] as const;
export type MemoryLayer = (typeof MemoryLayers)[number];

export const MemoryStatuses = ["active", "superseded", "archived", "forgotten", "expired"] as const;
export type MemoryStatus = (typeof MemoryStatuses)[number];

export type Memory = {
  id: string;
  type: MemoryType;
  subtype: MemorySubtype | null;
  scope: MemoryScope;
  scopeId: string | null;
  memoryLayer: MemoryLayer;
  status: MemoryStatus;
  content: string;
  summary: string | null;
  embedding: number[] | null;
  embeddingModel: string | null;
  embeddingProvider: string | null;
  embeddingDimensions: number | null;
  embeddedAt: Date | null;
  importance: number;
  emotionValence: number;
  emotionArousal: number;
  source: string;
  sourceTraceId: string | null;
  personaId?: string | null;
  subjectUserId?: string | null;
  createdByUserId?: string | null;
  speakerId?: string | null;
  voiceProfileId?: string | null;
  sessionId?: string | null;
  metadata: Record<string, unknown>;
  /** Null for pre-lineage compatibility rows; inspect with getMemoryLineageState. */
  lineage?: MemoryLineageV1 | null;
  /** Explicitly marks synthetic/admin working data that is not evidence. */
  evidenceClassification?: "NON_EVIDENCE";
  /** Durable uniqueness identity is host-generated inside the grounded write path. */
  lineageConsumerKey?: string | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  observedAt: Date;
  eventTime: Date | null;
  validFrom: Date;
  validUntil: Date | null;
  expiresAt: Date | null;
  lastAccessedAt: Date;
  supersededAt: Date | null;
  supersedes: string[];
  supersededBy: string | null;
  contradicts: string[];
  searchScore?: number;
  searchMatchedBy?: MemoryMatchReason;
  searchRetrievalMode?: MemoryRetrievalMode;
  searchRankComponents?: MemorySearchRankComponents;
};

export type CreateMemoryInput = {
  type: MemoryType;
  subtype?: MemorySubtype | null;
  scope?: MemoryScope;
  scopeId?: string | null;
  memoryLayer?: MemoryLayer;
  status?: MemoryStatus;
  content: string;
  summary?: string | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  embeddingProvider?: string | null;
  embeddingDimensions?: number | null;
  embeddedAt?: Date | string | null;
  importance?: number;
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
  evidenceClassification?: "NON_EVIDENCE";
  tags?: string[];
  observedAt?: Date | string | null;
  eventTime?: Date | string | null;
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  expiresAt?: Date | string | null;
  supersededAt?: Date | string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
};

export type UpdateMemoryInput = {
  type?: MemoryType;
  subtype?: MemorySubtype | null;
  scope?: MemoryScope;
  scopeId?: string | null;
  memoryLayer?: MemoryLayer;
  status?: MemoryStatus;
  content?: string;
  summary?: string | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  embeddingProvider?: string | null;
  embeddingDimensions?: number | null;
  embeddedAt?: Date | string | null;
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
  observedAt?: Date | string | null;
  eventTime?: Date | string | null;
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  expiresAt?: Date | string | null;
  supersededAt?: Date | string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
};

export type MemoryOriginRole = "user" | "assistant" | "mixed";

export type MemoryCandidate = {
  type: MemoryType;
  subtype?: MemorySubtype | null;
  scope?: MemoryScope;
  scopeId?: string | null;
  memoryLayer?: MemoryLayer;
  content: string;
  summary?: string | null;
  importance: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
  tags: string[];
  reason: string;
  explicitRememberRequested?: boolean;
  correctionRequested?: boolean;
  userIntent?: "remember" | "correct" | "state" | "recall" | "other";
  originRole?: MemoryOriginRole;
  evidenceText?: string;
  sourceTraceId?: string | null;
  personaId?: string | null;
  subjectUserId?: string | null;
  createdByUserId?: string | null;
  speakerId?: string | null;
  voiceProfileId?: string | null;
  sessionId?: string | null;
  claim?: MemoryClaim | MemoryClaimAttributionInput;
  observedAt?: Date | string | null;
  eventTime?: Date | string | null;
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  expiresAt?: Date | string | null;
  possibleSupersedes?: string[];
  possibleContradictions?: string[];
  relationshipConfidence?: number;
  relationshipReason?: string;
};

export type MemoryCandidateStorageDecision = "stored" | "rejected";

export type MemoryCandidateStorageResult = {
  decision: MemoryCandidateStorageDecision;
  candidate: MemoryCandidate;
  memory?: Memory;
  storageReason?: string;
  rejectedReason?: string;
};

export type MemoryGroundingContext = import("./lineage.js").MemoryGroundingContext;
export type MemoryGroundingResolver = import("./lineage.js").MemoryGroundingResolver;

export type MemoryExtractorMode = "rule-based" | "llm";
export type MemoryExtractorActive = "rule-based" | "llm" | "fallback-rule-based" | "disabled";

export type MemoryExtractorFailureStage =
  | "empty-output"
  | "truncated-output"
  | "json-extraction"
  | "json-parse"
  | "root-schema"
  | "candidate-schema"
  | "provider-call";

export type MemoryExtractorSelectedOutputSource = "answer" | "reasoning" | "none";

export type MemoryExtractorStatus = {
  mode: MemoryExtractorMode;
  active: MemoryExtractorActive;
  enabled: boolean;
  provider?: string;
  fallbackUsed?: boolean;
  candidateCount?: number;
  rejectedCount?: number;
  rejectedReasons?: string[];
  error?: string;
  rawPreview?: string;
  validationIssues?: string[];
  skippedReason?: string;
  failureStage?: MemoryExtractorFailureStage;
  selectedOutputSource?: MemoryExtractorSelectedOutputSource;
  finishReason?: string;
  answerLength?: number;
  reasoningLength?: number;
  lastAttemptAt?: string;
};

export type MemoryExtractionInput = {
  /** Supplied only after host resolution of the exact committed user source. */
  groundedSource?: import("./lineage.js").GroundedMemorySource | undefined;
  /** Host-validated prior evidence in the same subject × persona scope. */
  priorEvents?: import("./provider.js").MemoryEvent[] | undefined;
  memoryScope?: string | undefined;
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
  providerMetadata?:
    | {
        name?: string | undefined;
        capability?: string | undefined;
        model?: string | undefined;
        mock?: boolean | undefined;
        latencyMs?: number | undefined;
      }
    | undefined;
  memoryOptions?:
    | {
        readMemory: boolean;
        writeMemory: boolean;
      }
    | undefined;
};

export type MemoryExtractor = {
  getStatus?(): MemoryExtractorStatus;
  extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]>;
};

export type MemorySearchQuery = {
  text?: string;
  embedding?: number[];
  vectorEnabled?: boolean;
  types?: MemoryType[];
  subtypes?: MemorySubtype[];
  memoryLayers?: MemoryLayer[];
  statuses?: MemoryStatus[];
  sources?: string[];
  personaId?: string;
  subjectUserId?: string;
  createdByUserId?: string;
  speakerId?: string;
  voiceProfileId?: string;
  minImportance?: number;
  tags?: string[];
  scope?: MemoryScope;
  scopeId?: string;
  scopes?: MemoryScope[];
  sessionId?: string;
  userId?: string;
  projectId?: string;
  agentId?: string;
  pluginId?: string;
  includeArchived?: boolean;
  includeSuperseded?: boolean;
  includeHistory?: boolean;
  includeHistoricalEpisodic?: boolean;
  includeExpired?: boolean;
  includeTestMemories?: boolean;
  currentTime?: Date | string;
  limit?: number;
};

export type MemoryVectorIndexStatus = {
  vectorIndexEnabled: boolean;
  vectorIndexType: "hnsw" | "ivfflat" | "none" | "unavailable";
  vectorDistance: "cosine";
  embeddingDimensions?: number | undefined;
  indexCreated: boolean;
  indexAvailable: boolean;
  indexFallbackReason?: string | undefined;
  embeddedCount: number;
  missingEmbeddingCount: number;
  annAccelerationActive: boolean;
};

export type MemoryMatchReason =
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
export type MemoryRetrievalMode =
  | "in-memory-keyword"
  | "in-memory-hybrid"
  | "keyword"
  | "postgres-trigram"
  | "postgres-full-text"
  | "postgres-vector"
  | "postgres-hybrid"
  | "postgres-hybrid-keyword"
  | "hybrid-keyword"
  | "fallback-recent";

export type MemorySearchRankComponents = {
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

export type RetrievedMemoryDebug = {
  contextRevision?: string | undefined;
  id: string;
  type: MemoryType;
  subtype: MemorySubtype | null;
  scope: MemoryScope;
  scopeId: string | null;
  memoryLayer: MemoryLayer;
  status: MemoryStatus;
  source: string;
  sourceTraceId: string | null;
  personaId?: string | null;
  subjectUserId?: string | null;
  createdByUserId?: string | null;
  speakerId?: string | null;
  voiceProfileId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
  importance: number;
  createdAt: Date;
  observedAt?: Date;
  eventTime?: Date | null;
  validFrom?: Date;
  validUntil?: Date | null;
  expiresAt?: Date | null;
  retentionClass?: string;
  retentionReason?: string;
  supersededAt?: Date | null;
  lastAccessedAt?: Date;
  displayText: string;
  matchedBy: MemoryMatchReason;
  retrievalMode?: MemoryRetrievalMode;
  hasEmbedding: boolean;
  embeddingProvider?: string | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
  embeddedAt?: Date | null;
  semanticEmbedding?: boolean;
  embeddingError?: string;
  vectorScore?: number;
  keywordScore?: number;
  hybridScore?: number;
  score?: number;
  rankComponents?: MemorySearchRankComponents;
  excludedReason?: string;
};

export type RetrievedMemoryCandidate = {
  memory: Memory;
  displayText: string;
  matchedBy: MemoryMatchReason;
  score: number;
  rankComponents?: MemorySearchRankComponents;
  excludedReason?: string;
};

export type MemoryRetrievalResult = {
  query: string;
  keywords: string[];
  rawCount: number;
  count: number;
  retrievalMode: MemoryRetrievalMode;
  vectorEnabled: boolean;
  vectorUsed: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  semanticEmbedding?: boolean;
  embeddingNote?: string;
  queryEmbeddingGenerated: boolean;
  vectorResultCount: number;
  keywordResultCount: number;
  hybridResultCount: number;
  fallbackUsed: boolean;
  fallbackReason?: string;
  retrievalScope: string;
  includedScopes: Array<{ scope: MemoryScope; scopeId?: string | null }>;
  includeArchived: boolean;
  includeSuperseded: boolean;
  includeExpired: boolean;
  currentTime: string;
  excludedByStatus: number;
  excludedByTime: number;
  excludedByScope: number;
  rawMemories: RetrievedMemoryDebug[];
  memories: RetrievedMemoryDebug[];
  selectedMemories: Memory[];
};

export type CurrentAffectLabel =
  | "frustrated"
  | "anxious"
  | "excited"
  | "tired"
  | "confused"
  | "angry"
  | "sad"
  | "calm"
  | "neutral";

export type CurrentAffect = {
  affectLabel: CurrentAffectLabel;
  affectValence: number;
  affectArousal: number;
  confidence: number;
  evidenceSnippet: string;
  timestamp: string;
  sourceTraceId?: string | null;
  promptHint: string;
};

export type Entity = {
  id: string;
  name: string;
  type: string;
  createdAt: Date;
};

export type CreateEntityInput = {
  name: string;
  type: string;
};

export type Relation = {
  id: string;
  sourceEntity: string;
  targetEntity: string;
  relation: string;
  weight: number;
  createdAt: Date;
};

export type CreateRelationInput = {
  sourceEntity: string;
  targetEntity: string;
  relation: string;
  weight?: number;
};

export type MemoryQuery = {
  sessionId?: string;
  text: string;
  limit?: number;
};
