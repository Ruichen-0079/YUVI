import type { MemoryRepository } from "./repository.js";
import { RuleBasedMemoryExtractor } from "./extractor.js";
import { MemoryRetriever } from "./retriever.js";
import { MemoryScorer } from "./scorer.js";
import { buildCandidateFingerprint, deduplicateCandidateBatch } from "./candidate-dedupe.js";
import { detectEpisodicCorrectionRelationships, hasCorrectionRelatedMemory } from "./correction.js";
import {
  detectExplicitForgetRequest,
  detectExplicitRememberRequest,
  stripExplicitForgetPrefix
} from "./intent.js";
import { enrichCandidateProvenance, isAssistantOnlyRestatement } from "./provenance.js";
import {
  admitDurableMemoryClaim,
  claimAttributionFromUnknown,
  deserializeClaimMetadata,
  serializeClaimMetadata
} from "./claim.js";
import type { MemoryBackend } from "./backend.js";
import {
  LegacyProfileMemorySourceReader,
  Mem0ProfileMemorySourceReader,
  UnavailableProfileMemorySourceReader
} from "./profile-source-reader.js";
import type { ProfileMemorySourceReader } from "./profile-types.js";
import type { MemoryConversationTurnWriteResult, MemoryProvider } from "./provider.js";
import { Mem0MemoryProvider } from "./providers/mem0-memory-provider.js";
import { MemoryIngestionPolicy } from "./ingestion.js";
import {
  buildChatMemoryScope,
  buildMem0RetrievalResult,
  emptyMem0RetrievalResult,
  forgetMemoriesInScope,
  MEM0_CHAT_SEARCH_TIMEOUT_MS,
  MEM0_CHAT_SEARCH_TOP_K,
  MEM0_CHAT_WRITE_TIMEOUT_MS,
  MEMORY_SCOPE_MISSING,
  resolveMem0ChatIdentity,
  selectPromptMemories,
  type ForgetMemoriesResult,
  type Mem0TurnKind
} from "./mem0-chat.js";
import {
  canonicalEventKey,
  hasHistoricalEpisodicIntent,
  isDurableTemporalText,
  isOrdinaryDailyEvent,
  normalizeTemporalCandidate,
  resolveCanonicalTemporalBounds,
  resolveTemporalDebug,
  resolveTimezoneFromObservedAt
} from "./temporal.js";
import {
  detectMemoryRelationships,
  relationshipSearchText,
  type MemoryRelationshipSuggestion
} from "./relationships.js";
import { computeRetentionPolicy } from "./retention.js";
import type {
  CreateMemoryInput,
  Memory,
  MemoryCandidate,
  MemoryCandidateStorageResult,
  MemoryExtractionInput,
  MemoryExtractor,
  MemoryExtractorStatus,
  MemoryLayer,
  MemoryMatchReason,
  MemoryRetrievalMode,
  MemoryScope,
  MemoryQuery,
  MemoryRetrievalResult,
  MemorySearchQuery,
  MemorySubtype,
  MemoryType,
  RetrievedMemoryCandidate,
  RetrievedMemoryDebug,
  UpdateMemoryInput
} from "./types.js";
import {
  buildGroundedMemoryLineage,
  groundedMemoryPayloadDigest,
  JournalMemoryGroundingResolver,
  MemoryGroundingError,
  type CommittedJournalEvidenceReader,
  type GroundedMemorySource,
  type MemoryGroundingContext,
  type MemoryGroundingResolver
} from "./lineage.js";
import { MemoryLineageConflictError } from "./repository.js";

export type MemoryEmbeddingProvider = {
  readonly name: string;
  readonly dimensions: number;
  readonly model?: string | undefined;
  readonly mock?: boolean | undefined;
  embedText(text: string): Promise<number[]>;
};

export type MemoryEmbeddingConfig = {
  provider?: MemoryEmbeddingProvider | undefined;
  enabled?: boolean | undefined;
  logger?: { warn?(message: string, context?: Record<string, unknown>): void } | undefined;
};

export type MemoryServiceBackendConfig = {
  kind?: "legacy" | "mem0" | undefined;
  mem0?: MemoryBackend | undefined;
  controllerEvidence?: MemoryProvider | undefined;
  searchTimeoutMs?: number | undefined;
  writeTimeoutMs?: number | undefined;
  ingestionPolicy?: Pick<MemoryIngestionPolicy, "build"> | undefined;
  groundingResolver?: MemoryGroundingResolver | undefined;
  journalEvidenceReader?: CommittedJournalEvidenceReader | undefined;
  logger?:
    | {
        warn?(message: string, context?: Record<string, unknown>): void;
        info?(message: string, context?: Record<string, unknown>): void;
      }
    | undefined;
};

export class MemoryService {
  private readonly scorer: MemoryScorer;
  private readonly retriever: MemoryRetriever;
  private readonly embeddingProvider: MemoryEmbeddingProvider | undefined;
  private readonly embeddingEnabled: boolean;
  private readonly embeddingLogger: MemoryEmbeddingConfig["logger"];
  private readonly backendKind: "legacy" | "mem0";
  private readonly mem0Backend: MemoryBackend | undefined;
  private readonly mem0SearchTimeoutMs: number;
  private readonly mem0WriteTimeoutMs: number;
  private readonly mem0Logger: MemoryServiceBackendConfig["logger"];
  private readonly controllerEvidence: MemoryProvider | undefined;
  private readonly memoryProvider: MemoryProvider | undefined;
  private readonly memoryIngestionPolicy: Pick<MemoryIngestionPolicy, "build">;
  private readonly groundingResolver: MemoryGroundingResolver | undefined;

  constructor(
    private readonly repository: MemoryRepository,
    scorer = new MemoryScorer(),
    retriever?: MemoryRetriever,
    private readonly extractor: MemoryExtractor = new RuleBasedMemoryExtractor(),
    embedding?: MemoryEmbeddingConfig,
    backend?: MemoryServiceBackendConfig
  ) {
    this.scorer = scorer;
    this.retriever = retriever ?? new MemoryRetriever(repository, scorer);
    this.embeddingProvider = embedding?.provider;
    this.embeddingEnabled = embedding?.enabled ?? Boolean(embedding?.provider);
    this.embeddingLogger = embedding?.logger;
    this.backendKind = backend?.kind === "mem0" && backend.mem0 ? "mem0" : "legacy";
    this.mem0Backend = backend?.kind === "mem0" ? backend.mem0 : undefined;
    this.mem0SearchTimeoutMs = backend?.searchTimeoutMs ?? MEM0_CHAT_SEARCH_TIMEOUT_MS;
    this.mem0WriteTimeoutMs = backend?.writeTimeoutMs ?? MEM0_CHAT_WRITE_TIMEOUT_MS;
    this.mem0Logger = backend?.logger ?? embedding?.logger;
    this.memoryProvider = this.mem0Backend ? new Mem0MemoryProvider(this.mem0Backend) : undefined;
    this.controllerEvidence = backend?.controllerEvidence;
    this.memoryIngestionPolicy = backend?.ingestionPolicy ?? new MemoryIngestionPolicy();
    this.groundingResolver =
      backend?.groundingResolver ??
      (backend?.journalEvidenceReader
        ? new JournalMemoryGroundingResolver(backend.journalEvidenceReader)
        : undefined);
  }

  /** True when formal long-term memory is Mem0 (Legacy write/search path disabled). */
  isMem0Backend(): boolean {
    return this.backendKind === "mem0" && Boolean(this.mem0Backend);
  }

  getBackendKind(): "legacy" | "mem0" {
    return this.isMem0Backend() ? "mem0" : "legacy";
  }

  /** Runtime-facing semantic retrieval provider; legacy mode remains facade-only. */
  getVoiceBindingProvider(): MemoryProvider | undefined {
    return this.controllerEvidence;
  }

  getMemoryProvider(): MemoryProvider | undefined {
    return this.memoryProvider;
  }

  /** Internal f1 reader over this service's active backend instances. */
  getProfileMemorySourceReader(): ProfileMemorySourceReader {
    if (this.backendKind === "mem0" && this.mem0Backend) {
      return new Mem0ProfileMemorySourceReader(this.mem0Backend);
    }
    if (this.backendKind === "legacy") return new LegacyProfileMemorySourceReader(this.repository);
    return new UnavailableProfileMemorySourceReader();
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    if (!input.evidenceClassification) {
      throw new Error(
        "Direct legacy Memory creation must be explicitly classified as NON_EVIDENCE; factual writes use grounded candidate admission."
      );
    }
    return this.repository.createMemory(
      await this.withEmbedding(this.applyTestMemoryPolicy(input))
    );
  }

  async updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory | null> {
    const lifecycleOnly = Object.keys(input).every((key) =>
      ["status", "supersededAt", "supersededBy"].includes(key)
    );
    if (lifecycleOnly) {
      return this.repository.updateMemory(id, input);
    }
    const current = await this.repository.getMemoryById(id);
    if (!current) {
      return null;
    }
    if (current.lineage?.state === "GROUNDED") {
      throw new Error(
        "Grounded Memory lineage is immutable; record a new grounded correction instead."
      );
    }
    const shouldRegenerate =
      input.content !== undefined || input.summary !== undefined || input.tags !== undefined;
    if (!shouldRegenerate) {
      return this.repository.updateMemory(id, input);
    }
    const nextInput: CreateMemoryInput = {
      type: input.type ?? current.type,
      subtype: input.subtype ?? current.subtype,
      scope: input.scope ?? current.scope,
      scopeId: input.scopeId ?? current.scopeId,
      memoryLayer: input.memoryLayer ?? current.memoryLayer,
      status: input.status ?? current.status,
      content: input.content ?? current.content,
      summary: input.summary ?? current.summary,
      importance: input.importance ?? current.importance,
      emotionValence: input.emotionValence ?? current.emotionValence,
      emotionArousal: input.emotionArousal ?? current.emotionArousal,
      source: current.source,
      sourceTraceId: current.sourceTraceId,
      metadata: input.metadata ?? current.metadata,
      tags: input.tags ?? current.tags,
      observedAt: input.observedAt ?? current.observedAt,
      eventTime: input.eventTime ?? current.eventTime,
      validFrom: input.validFrom ?? current.validFrom,
      validUntil: input.validUntil ?? current.validUntil,
      expiresAt: input.expiresAt ?? current.expiresAt,
      supersededAt: input.supersededAt ?? current.supersededAt,
      supersedes: input.supersedes ?? current.supersedes,
      supersededBy: input.supersededBy ?? current.supersededBy,
      contradicts: input.contradicts ?? current.contradicts
    };
    assignDefinedIdentity(nextInput, {
      personaId: input.personaId ?? current.personaId,
      subjectUserId: input.subjectUserId ?? current.subjectUserId,
      createdByUserId: input.createdByUserId ?? current.createdByUserId,
      speakerId: input.speakerId ?? current.speakerId,
      voiceProfileId: input.voiceProfileId ?? current.voiceProfileId,
      sessionId: input.sessionId ?? current.sessionId
    });
    const embedded = await this.withEmbedding(nextInput);
    const updateInput: UpdateMemoryInput = { ...input };
    if (embedded.embedding !== undefined) updateInput.embedding = embedded.embedding;
    if (embedded.embeddingProvider !== undefined) {
      updateInput.embeddingProvider = embedded.embeddingProvider;
    }
    if (embedded.embeddingModel !== undefined) updateInput.embeddingModel = embedded.embeddingModel;
    if (embedded.embeddingDimensions !== undefined) {
      updateInput.embeddingDimensions = embedded.embeddingDimensions;
    }
    if (embedded.embeddedAt !== undefined) updateInput.embeddedAt = embedded.embeddedAt;
    if (embedded.personaId !== undefined) updateInput.personaId = embedded.personaId;
    if (embedded.subjectUserId !== undefined) updateInput.subjectUserId = embedded.subjectUserId;
    if (embedded.createdByUserId !== undefined) {
      updateInput.createdByUserId = embedded.createdByUserId;
    }
    if (embedded.speakerId !== undefined) updateInput.speakerId = embedded.speakerId;
    if (embedded.voiceProfileId !== undefined) {
      updateInput.voiceProfileId = embedded.voiceProfileId;
    }
    if (embedded.sessionId !== undefined) updateInput.sessionId = embedded.sessionId;
    return this.repository.updateMemory(id, updateInput);
  }

  async rememberInteraction(input: {
    userMessage: string;
    assistantMessage: string;
    source?: string;
    sourceTraceId?: string | null;
    tags?: string[];
    groundingContext?: MemoryGroundingContext | undefined;
  }): Promise<Memory | null> {
    if (this.isMem0Backend()) {
      // Mem0 chat path uses storeConversationTurn / storeExplicitFact instead.
      return null;
    }
    const candidates = await this.extractCandidates({
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      sourceTraceId: input.sourceTraceId
    });
    for (const candidate of candidates) {
      const result = await this.processCandidateForStorage(candidate, {
        source: input.source ?? "runtime",
        tags: input.tags ?? []
      }, input.groundingContext);
      if (result.decision === "stored") {
        return result.memory ?? null;
      }
    }
    return null;
  }

  async extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
    if (this.isMem0Backend()) {
      // Do not run Legacy LLM/rule extraction when Mem0 owns long-term memory.
      return [];
    }
    const candidates = await this.extractor.extractCandidates(input);
    const withIdentity = candidates.map((candidate) =>
      this.applyExtractionIdentity(candidate, input)
    );
    const enriched = withIdentity.map((candidate) =>
      enrichCandidateProvenance(
        {
          ...candidate,
          explicitRememberRequested:
            candidate.explicitRememberRequested ??
            (candidate.originRole === "assistant"
              ? false
              : detectExplicitRememberRequest(input.userMessage))
        },
        {
          userMessage: input.userMessage,
          assistantMessage: input.assistantMessage
        }
      )
    );
    const { kept, rejected } = deduplicateCandidateBatch(enriched);
    return [...kept, ...rejected.map((entry) => entry.candidate)];
  }

  getExtractorStatus(): MemoryExtractorStatus {
    return (
      this.extractor.getStatus?.() ?? {
        mode: "rule-based",
        active: "rule-based",
        enabled: true
      }
    );
  }

  async rememberCandidate(
    candidate: MemoryCandidate,
    options: { source?: string; tags?: string[] } = {},
    groundingContext?: MemoryGroundingContext
  ): Promise<Memory> {
    const result = await this.processCandidateForStorage(candidate, options, groundingContext);
    if (result.decision !== "stored" || !result.memory) {
      throw new MemoryGroundingError(
        "lineage-validation-failed",
        result.rejectedReason ?? "Candidate did not pass grounded Memory admission."
      );
    }
    return result.memory;
  }

  async processCandidateForStorage(
    candidate: MemoryCandidate,
    options: {
      source?: string;
      tags?: string[];
      skipAdmissionPolicy?: boolean;
      storageReason?: string;
    } = {},
    groundingContext?: MemoryGroundingContext
  ): Promise<MemoryCandidateStorageResult> {
    if (this.isMem0Backend()) {
      return {
        decision: "rejected",
        candidate,
        rejectedReason: "mem0-backend-skips-legacy-storage"
      };
    }
    const pendingRejection = candidate.metadata?.["pendingRejection"];
    if (typeof pendingRejection === "string") {
      return {
        decision: "rejected",
        candidate,
        rejectedReason: pendingRejection
      };
    }

    let groundedSource: GroundedMemorySource;
    try {
      groundedSource = await this.resolveGroundedSource(groundingContext);
    } catch (error) {
      if (error instanceof MemoryGroundingError) {
        return { decision: "rejected", candidate, rejectedReason: error.code };
      }
      throw error;
    }

    const claimGate = admitCandidateClaim(candidate);
    if (claimGate.decision === "rejected") {
      return claimGate;
    }
    candidate = claimGate.candidate;

    const normalized = this.normalizeCandidateForStorage({
      ...candidate,
      // Receipt recordedAt is the host observation anchor. Candidate clocks remain proposals.
      observedAt: groundedSource.recordedAt
    });
    const lineage = buildGroundedMemoryLineage({
      source: groundedSource,
      candidate: normalized,
      sourceText: groundingContext!.sourceText
    });
    const memoryInput = this.candidateMemoryInput(normalized, options);
    const payloadDigest = groundedMemoryPayloadDigest({
      type: memoryInput.type,
      ...(memoryInput.subtype === undefined ? {} : { subtype: memoryInput.subtype }),
      scope: memoryInput.scope ?? inferMemoryScope(normalized),
      ...(memoryInput.scopeId === undefined
        ? {}
        : { scopeId: memoryInput.scopeId ?? inferMemoryScopeId(normalized) }),
      memoryLayer: memoryInput.memoryLayer ?? inferMemoryLayer(memoryInput.type, memoryInput.subtype ?? null),
      content: memoryInput.content,
      summary: memoryInput.summary,
      importance: memoryInput.importance ?? 0.5,
      tags: memoryInput.tags ?? [],
      eventTime: memoryInput.eventTime,
      lineage
    });
    const existingGrounded = await this.repository.getGroundedMemoryByConsumerKey?.(lineage.consumerKey);
    if (existingGrounded) {
      if (existingGrounded.payloadDigest !== payloadDigest) throw new MemoryLineageConflictError();
      return {
        decision: "stored",
        candidate: normalized,
        memory: existingGrounded.memory,
        storageReason: "grounded-idempotent-replay"
      };
    }
    const relationships = await this.detectCandidateRelationships(normalized);
    const correctionRelationships = await this.detectCorrectionRelationships(normalized);
    const mergedRelationships = mergeRelationshipSuggestions(
      relationships,
      correctionRelationships
    );
    const candidateWithRelationships = applyRelationshipSuggestions(
      normalized,
      mergedRelationships
    );

    if (!options.skipAdmissionPolicy) {
      const admission = decideCandidateStorage(normalized, mergedRelationships);
      if (admission.decision === "rejected") {
        return {
          decision: "rejected",
          candidate: candidateWithRelationships,
          rejectedReason: admission.reason
        };
      }

      const skipDuplicateCheck =
        hasCorrectionRequest(normalized) &&
        hasCorrectionRelatedMemory({
          supersedes: mergedRelationships.supersedes,
          contradicts: mergedRelationships.contradicts,
          autoSupersedes: mergedRelationships.autoSupersedes,
          correctionRelated: correctionRelationships.relatedMemoryIds
        });
      if (!skipDuplicateCheck) {
        const repositoryDuplicate = await this.findRepositoryDuplicate(normalized);
        if (repositoryDuplicate) {
          return {
            decision: "rejected",
            candidate: {
              ...candidateWithRelationships,
              metadata: {
                ...(candidateWithRelationships.metadata ?? {}),
                duplicateOfMemoryId: repositoryDuplicate.id
              }
            },
            rejectedReason: "duplicate-candidate"
          };
        }
      }
    }

    const decision = {
      decision: "stored" as const,
      reason:
        options.storageReason ?? decideCandidateStorage(normalized, mergedRelationships).reason
    };

    const supersedeIds = [
      ...new Set([
        ...mergedRelationships.autoSupersedes,
        ...correctionRelationships.supersedes,
        ...(hasCorrectionRequest(normalized) ? (normalized.possibleSupersedes ?? []) : [])
      ])
    ];
    const storageCandidate: MemoryCandidate = {
      ...candidateWithRelationships,
      ...(supersedeIds.length > 0 ? { possibleSupersedes: supersedeIds } : {}),
      ...(mergedRelationships.contradicts.length > 0
        ? { possibleContradictions: mergedRelationships.contradicts }
        : normalized.possibleContradictions
          ? { possibleContradictions: normalized.possibleContradictions }
          : {})
    };
    const finalCandidate = {
        ...storageCandidate,
        metadata: {
          ...(storageCandidate.metadata ?? {}),
          storageReason: decision.reason,
          ...(hasCorrectionRequest(normalized)
            ? {
                correctionRequested: true,
                correctedMemoryIds: correctionRelationships.relatedMemoryIds
              }
            : {})
        }
      };
    const finalStorageCandidate = this.applyRetentionPolicy(finalCandidate, options);
    const finalInput = this.candidateMemoryInput(finalStorageCandidate, options);
    const memory = await this.persistGroundedCandidate(finalInput, lineage, payloadDigest);
    await this.applyAutomaticSupersession(memory.memory, supersedeIds);
    return {
      decision: "stored",
      candidate: candidateWithRelationships,
      memory: memory.memory,
      storageReason: memory.inserted ? decision.reason : "grounded-idempotent-replay"
    };
  }

  async retrieveRelevantMemories(query: MemorySearchQuery): Promise<Memory[]> {
    const result = await this.retrieveRelevantMemoriesWithMetadata(query);
    return result.selectedMemories;
  }

  async retrieveRelevantMemoriesWithMetadata(
    query: MemorySearchQuery
  ): Promise<MemoryRetrievalResult> {
    if (this.isMem0Backend() && this.mem0Backend) {
      return this.retrieveFromMem0(query);
    }
    const result = await this.retrieveWithFallback(query);
    await Promise.all(
      result.selectedMemories.map((memory) => this.repository.updateMemoryAccess(memory.id))
    );
    return result;
  }

  async consolidateMemory(_memoryId: string): Promise<void> {
    // Mem0 owns consolidation via infer; Legacy path remains a no-op placeholder.
    if (this.isMem0Backend()) {
      return;
    }
    // Placeholder: future consolidation should merge related memories into stable semantic summaries.
  }

  scoreImportance(content: string): number {
    if (this.isMem0Backend()) {
      return 0;
    }
    return this.scorer.scoreImportance(content);
  }

  async remember(_sessionId: string, content: string): Promise<void> {
    if (this.isMem0Backend()) {
      return;
    }
    await this.createMemory({
      type: "working",
      subtype: inferMemorySubtype(content),
      content,
      summary: this.compressForStorage(content),
      importance: this.scoreImportance(content),
      source: "runtime",
      evidenceClassification: "NON_EVIDENCE",
      metadata: { generatedBy: "runtime" },
      tags: []
    });
  }

  /**
   * Compatibility facade for completed chat turns. Semantic writes are
   * admitted by MemoryIngestionPolicy and dispatched through MemoryProvider.
   */
  async storeConversationTurn(input: {
    userMessage: string;
    assistantMessage: string;
    sessionId?: string | undefined;
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
    userMessageId?: string | null | undefined;
    assistantMessageId?: string | null | undefined;
    traceId?: string | null | undefined;
    idempotencyKey?: string | null | undefined;
    conversationId?: string | null | undefined;
    language?: string | null | undefined;
    cancelledOrFailed?: boolean | undefined;
    turnKind?: Mem0TurnKind | undefined;
  }): Promise<MemoryConversationTurnWriteResult & { code?: string }> {
    if (!this.isMem0Backend() || !this.memoryProvider) {
      return {
        status: "failed",
        ok: false,
        attemptedCount: 0,
        writtenCount: 0,
        rejectedCount: 0,
        deduplicatedCount: 0,
        skippedCount: 0,
        skippedReason: "not-mem0-backend",
        errorCode: "MEMORY_BACKEND_UNAVAILABLE",
        code: "MEMORY_BACKEND_UNAVAILABLE",
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      };
    }
    if (input.turnKind === "explicit_forget" || detectExplicitForgetRequest(input.userMessage)) {
      // Forget is handled on the read path only; never re-write deleted facts.
      return {
        status: "skipped",
        ok: false,
        attemptedCount: 0,
        writtenCount: 0,
        rejectedCount: 0,
        deduplicatedCount: 0,
        skippedCount: 1,
        skippedReason: "explicit-forget-skips-add",
        turnKind: "explicit_forget",
        infer: false,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      };
    }

    const resolved = resolveMem0ChatIdentity({
      subjectUserId: input.subjectUserId,
      personaId: input.personaId
    });
    if (!resolved.ok) {
      this.mem0Logger?.warn?.(MEMORY_SCOPE_MISSING, {
        missing: resolved.missing,
        turnKind: input.turnKind
      });
      return {
        status: "skipped",
        ok: false,
        attemptedCount: 0,
        writtenCount: 0,
        rejectedCount: 0,
        deduplicatedCount: 0,
        skippedCount: 1,
        skippedReason: MEMORY_SCOPE_MISSING,
        code: MEMORY_SCOPE_MISSING,
        errorCode: MEMORY_SCOPE_MISSING,
        infer: false,
        ...(input.turnKind ? { turnKind: input.turnKind } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      };
    }
    const { identity } = resolved;
    const scope = buildChatMemoryScope(identity);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.mem0WriteTimeoutMs);
    try {
      const ingestion = await this.memoryIngestionPolicy.build({
        ...input,
        scope,
        observedAt: new Date().toISOString()
      });
      if (ingestion.events.length === 0) {
        return {
          status: "skipped",
          ok: false,
          attemptedCount: 0,
          writtenCount: 0,
          rejectedCount: 0,
          deduplicatedCount: 0,
          skippedCount: 1,
          skippedReason: ingestion.skippedReason ?? "no-factual-memory",
          turnKind: ingestion.turnKind,
          infer: false,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
        };
      }

      let firstEventId: string | undefined;
      let firstOperation: string | undefined;
      const rejectedReasons: string[] = [];
      let writtenCount = 0;
      let deduplicatedCount = 0;
      let rejectedCount = 0;
      let attemptedCount = 0;
      let skippedCount = 0;
      for (const event of ingestion.events) {
        attemptedCount += 1;
        try {
          const result = await this.memoryProvider.writeEvent({
            ...event,
            signal: controller.signal
          });
          if (result.status === "written") {
            writtenCount += 1;
            firstEventId ??= result.eventId;
            firstOperation ??= result.status;
          } else if (result.status === "unchanged") {
            deduplicatedCount += 1;
            firstEventId ??= result.eventId;
            firstOperation ??= result.status;
          } else {
            rejectedCount += 1;
            rejectedReasons.push(result.errorCode ?? "mem0-write-rejected");
          }
        } catch (error) {
          rejectedCount += 1;
          rejectedReasons.push(
            error instanceof Error && error.message ? "MEMORY_WRITE_FAILED" : "mem0-write-failed"
          );
          this.mem0Logger?.warn?.("mem0 conversation event write failed", {
            message: error instanceof Error ? error.message : String(error),
            turnKind: ingestion.turnKind
          });
        }
        if (controller.signal.aborted) {
          skippedCount = ingestion.events.length - attemptedCount;
          break;
        }
      }
      const persistedCount = writtenCount + deduplicatedCount;
      const status =
        attemptedCount === 0
          ? "failed"
          : rejectedCount === 0 && skippedCount === 0
            ? "complete"
            : persistedCount > 0
              ? "partial"
              : "failed";
      return {
        status,
        ok: status === "complete",
        attemptedCount,
        writtenCount,
        rejectedCount,
        deduplicatedCount,
        skippedCount,
        ...(persistedCount > 0
          ? {
              ...(firstEventId ? { memoryId: firstEventId } : {}),
              ...(firstOperation ? { operation: firstOperation } : {}),
              storedCount: persistedCount
            }
          : {
              skippedReason: rejectedReasons[0] ?? "mem0-write-rejected"
            }),
        ...(rejectedReasons.length > 0 ? { rejectedReasons } : {}),
        turnKind: ingestion.turnKind,
        infer: false,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      };
    } catch (error) {
      this.mem0Logger?.warn?.("mem0 conversation turn write failed", {
        message: error instanceof Error ? error.message : String(error),
        turnKind: input.turnKind
      });
      return {
        status: "failed",
        ok: false,
        attemptedCount: 0,
        writtenCount: 0,
        rejectedCount: 1,
        deduplicatedCount: 0,
        skippedCount: 0,
        skippedReason: error instanceof Error ? error.message : "mem0-write-failed",
        errorCode: "MEMORY_INGESTION_FAILED",
        code: "MEMORY_INGESTION_FAILED",
        infer: false,
        ...(input.turnKind ? { turnKind: input.turnKind } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async forgetExplicitMemory(input: {
    userMessage: string;
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
  }): Promise<ForgetMemoriesResult & { code?: string }> {
    if (!this.isMem0Backend() || !this.mem0Backend) {
      return { deleted: 0, notFound: true, memoryIds: [], query: input.userMessage };
    }
    const resolved = resolveMem0ChatIdentity({
      subjectUserId: input.subjectUserId,
      personaId: input.personaId
    });
    if (!resolved.ok) {
      this.mem0Logger?.warn?.(MEMORY_SCOPE_MISSING, { missing: resolved.missing, op: "forget" });
      return {
        deleted: 0,
        notFound: true,
        memoryIds: [],
        query: input.userMessage,
        code: MEMORY_SCOPE_MISSING
      };
    }
    const scope = buildChatMemoryScope(resolved.identity);
    const query = stripExplicitForgetPrefix(input.userMessage) || input.userMessage;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.mem0WriteTimeoutMs);
    try {
      return await forgetMemoriesInScope(this.mem0Backend, {
        scope,
        query,
        signal: controller.signal
      });
    } catch (error) {
      this.mem0Logger?.warn?.("mem0 forget failed", {
        message: error instanceof Error ? error.message : String(error)
      });
      return { deleted: 0, notFound: true, memoryIds: [], query };
    } finally {
      clearTimeout(timer);
    }
  }

  private async retrieveFromMem0(query: MemorySearchQuery): Promise<MemoryRetrievalResult> {
    if (!this.mem0Backend) {
      return emptyMem0RetrievalResult(query.text ?? "");
    }
    const text = (query.text ?? "").trim();
    if (!text) {
      return emptyMem0RetrievalResult("");
    }
    const resolved = resolveMem0ChatIdentity({
      subjectUserId: query.subjectUserId,
      personaId: query.personaId
    });
    if (!resolved.ok) {
      this.mem0Logger?.warn?.(MEMORY_SCOPE_MISSING, {
        missing: resolved.missing,
        op: "search"
      });
      const empty = emptyMem0RetrievalResult(text);
      empty.fallbackUsed = true;
      empty.fallbackReason = MEMORY_SCOPE_MISSING;
      return empty;
    }
    const scope = buildChatMemoryScope(resolved.identity);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.mem0SearchTimeoutMs);
    try {
      const hits = await this.mem0Backend.search(
        {
          scope,
          query: text,
          limit: Math.min(query.limit ?? MEM0_CHAT_SEARCH_TOP_K, MEM0_CHAT_SEARCH_TOP_K)
        },
        controller.signal
      );
      if (hits.some((item) => item.scope !== scope)) {
        this.mem0Logger?.warn?.("mem0 search returned a record outside the requested scope", {
          code: "MEMORY_SCOPE_MISMATCH",
          operation: "search",
          expectedScopePresent: true
        });
        const empty = emptyMem0RetrievalResult(text);
        empty.fallbackReason = "MEMORY_SCOPE_MISMATCH";
        return empty;
      }
      const selected = selectPromptMemories(hits);
      return buildMem0RetrievalResult(text, hits, selected);
    } catch (error) {
      this.mem0Logger?.warn?.("mem0 search failed; continuing without memories", {
        message: error instanceof Error ? error.message : String(error)
      });
      const empty = emptyMem0RetrievalResult(text);
      empty.fallbackUsed = true;
      empty.fallbackReason = error instanceof Error ? error.message : "mem0-search-failed";
      return empty;
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveGroundedSource(
    context: MemoryGroundingContext | undefined
  ): Promise<GroundedMemorySource> {
    if (!context || !this.groundingResolver) {
      throw new MemoryGroundingError(
        "missing-committed-source",
        "A committed Journal source and host grounding resolver are required."
      );
    }
    return this.groundingResolver.resolve(context);
  }

  private candidateMemoryInput(
    normalized: MemoryCandidate,
    options: { source?: string; tags?: string[] }
  ): CreateMemoryInput {
    const observedAt = normalized.observedAt;
    if (observedAt === undefined || observedAt === null) {
      throw new MemoryGroundingError(
        "lineage-validation-failed",
        "Grounded candidate is missing the committed receipt observation time."
      );
    }
    return {
      type: normalized.type,
      subtype: normalized.subtype ?? null,
      scope: normalized.scope ?? inferMemoryScope(normalized),
      scopeId: normalized.scopeId ?? inferMemoryScopeId(normalized),
      memoryLayer:
        normalized.memoryLayer ?? inferMemoryLayer(normalized.type, normalized.subtype ?? null),
      content: normalized.content,
      summary: normalized.summary ?? this.compressForStorage(normalized.content),
      importance: normalized.importance,
      emotionValence: 0,
      emotionArousal: 0,
      source: options.source ?? "runtime",
      sourceTraceId: normalized.sourceTraceId ?? null,
      personaId: normalized.personaId ?? "default-persona",
      subjectUserId: normalized.subjectUserId ?? "default-user",
      createdByUserId: normalized.createdByUserId ?? normalized.subjectUserId ?? "default-user",
      speakerId: normalized.speakerId ?? null,
      voiceProfileId: normalized.voiceProfileId ?? null,
      sessionId: normalized.sessionId ?? null,
      metadata: {
        ...(normalized.metadata ?? {}),
        generatedBy: normalized.metadata?.["generatedBy"] ?? "memory-extractor",
        reason: normalized.reason,
        confidence: normalized.confidence ?? null,
        sourceTraceId: normalized.sourceTraceId ?? null,
        storageReason: normalized.metadata?.["storageReason"] ?? "explicit-save"
      },
      tags: Array.from(new Set([...(normalized.tags ?? []), ...(options.tags ?? [])])),
      observedAt,
      eventTime: normalized.eventTime ?? null,
      validFrom:
        normalized.validFrom ??
        resolveCanonicalTemporalBounds(
          normalized,
          resolveTimezoneFromObservedAt(observedAt)
        )?.validFrom ??
        observedAt,
      validUntil:
        normalized.validUntil ??
        resolveCanonicalTemporalBounds(
          normalized,
          resolveTimezoneFromObservedAt(observedAt)
        )?.validUntil ??
        null,
      expiresAt: normalized.expiresAt ?? null,
      supersedes: normalized.possibleSupersedes ?? [],
      contradicts: normalized.possibleContradictions ?? []
    };
  }

  private async persistGroundedCandidate(
    input: CreateMemoryInput,
    lineage: ReturnType<typeof buildGroundedMemoryLineage>,
    payloadDigest: string
  ): Promise<{ memory: Memory; inserted: boolean }> {
    const createGroundedMemory = this.repository.createGroundedMemory;
    if (!createGroundedMemory) {
      throw new Error("Memory repository does not support grounded lineage persistence.");
    }
    const memory = await this.withEmbedding(this.applyTestMemoryPolicy(input));
    return createGroundedMemory.call(this.repository, { memory, lineage, payloadDigest });
  }

  async retrieveForPrompt(query: MemoryQuery): Promise<string[]> {
    const memories = await this.retrieveRelevantMemories({
      text: query.text,
      limit: query.limit ?? 5
    });

    return memories.map((memory) => this.reconstructForPrompt(memory));
  }

  private async withEmbedding(input: CreateMemoryInput): Promise<CreateMemoryInput> {
    if (!this.embeddingEnabled || !this.embeddingProvider) {
      return input;
    }

    const embeddingInput = buildEmbeddingInput(input);
    if (!embeddingInput) {
      return input;
    }

    try {
      const vector = await this.embeddingProvider.embedText(embeddingInput);
      validateEmbeddingDimensions(vector, this.embeddingProvider.dimensions);
      return {
        ...input,
        embedding: vector,
        embeddingProvider: this.embeddingProvider.name,
        embeddingModel: this.embeddingProvider.model ?? this.embeddingProvider.name,
        embeddingDimensions: this.embeddingProvider.dimensions,
        embeddedAt: new Date()
      };
    } catch (error) {
      const embeddingError = embeddingFailureDiagnostic(error, this.embeddingProvider);
      this.embeddingLogger?.warn?.("memory embedding generation failed; storing without vector", {
        provider: this.embeddingProvider.name,
        message: embeddingError
      });
      return {
        ...input,
        embedding: input.embedding ?? null,
        embeddingProvider: input.embeddingProvider ?? null,
        embeddingModel: input.embeddingModel ?? null,
        embeddingDimensions: input.embeddingDimensions ?? null,
        embeddedAt: input.embeddedAt ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          embeddingError
        }
      };
    }
  }

  private async generateQueryEmbedding(
    queryText: string,
    query: MemorySearchQuery
  ): Promise<RetrievalEmbeddingDebug> {
    if (!shouldUseVectorRetrieval(query) || !this.embeddingEnabled || !this.embeddingProvider) {
      return emptyRetrievalEmbeddingDebug();
    }
    if (!shouldEmbedQuery(queryText)) {
      return {
        ...emptyRetrievalEmbeddingDebug(),
        vectorEnabled: true,
        embeddingProvider: this.embeddingProvider.name,
        embeddingModel: this.embeddingProvider.model ?? this.embeddingProvider.name,
        embeddingDimensions: this.embeddingProvider.dimensions,
        semanticEmbedding: !this.embeddingProvider.mock,
        ...(this.embeddingProvider.mock
          ? {
              embeddingNote:
                "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
            }
          : {}),
        fallbackUsed: true,
        fallbackReason: "Query was empty or too trivial for vector retrieval."
      };
    }

    try {
      const embedding = query.embedding ?? (await this.embeddingProvider.embedText(queryText));
      validateEmbeddingDimensions(embedding, this.embeddingProvider.dimensions);
      return {
        vectorEnabled: true,
        vectorUsed: true,
        queryEmbeddingGenerated: true,
        embedding,
        embeddingProvider: this.embeddingProvider.name,
        embeddingModel: this.embeddingProvider.model ?? this.embeddingProvider.name,
        embeddingDimensions: this.embeddingProvider.dimensions,
        semanticEmbedding: !this.embeddingProvider.mock,
        ...(this.embeddingProvider.mock
          ? {
              embeddingNote:
                "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
            }
          : {}),
        fallbackUsed: false
      };
    } catch (error) {
      this.embeddingLogger?.warn?.("query embedding generation failed; using keyword retrieval", {
        provider: this.embeddingProvider.name,
        message: safeErrorMessage(error)
      });
      return {
        vectorEnabled: true,
        vectorUsed: false,
        queryEmbeddingGenerated: false,
        embeddingProvider: this.embeddingProvider.name,
        embeddingModel: this.embeddingProvider.model ?? this.embeddingProvider.name,
        embeddingDimensions: this.embeddingProvider.dimensions,
        semanticEmbedding: !this.embeddingProvider.mock,
        ...(this.embeddingProvider.mock
          ? {
              embeddingNote:
                "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
            }
          : {}),
        fallbackUsed: true,
        fallbackReason: safeErrorMessage(error)
      };
    }
  }

  private compressForStorage(content: string): string {
    const compact = content.replace(/\s+/g, " ").trim();
    return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
  }

  private applyExtractionIdentity(
    candidate: MemoryCandidate,
    input: MemoryExtractionInput
  ): MemoryCandidate {
    return {
      ...candidate,
      ...(candidate.personaId !== undefined
        ? {}
        : input.personaId !== undefined
          ? { personaId: input.personaId }
          : {}),
      ...(candidate.subjectUserId !== undefined
        ? {}
        : input.subjectUserId !== undefined
          ? { subjectUserId: input.subjectUserId }
          : {}),
      ...(candidate.createdByUserId !== undefined
        ? {}
        : input.createdByUserId !== undefined
          ? { createdByUserId: input.createdByUserId }
          : {}),
      ...(candidate.speakerId !== undefined
        ? {}
        : input.speakerId !== undefined
          ? { speakerId: input.speakerId }
          : {}),
      ...(candidate.voiceProfileId !== undefined
        ? {}
        : input.voiceProfileId !== undefined
          ? { voiceProfileId: input.voiceProfileId }
          : {}),
      ...(candidate.sessionId !== undefined
        ? {}
        : input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
      metadata: {
        ...(candidate.metadata ?? {}),
        ...(input.personaId !== undefined ? { personaId: input.personaId } : {}),
        ...(input.subjectUserId !== undefined ? { subjectUserId: input.subjectUserId } : {}),
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
        ...(input.speakerId !== undefined ? { speakerId: input.speakerId } : {}),
        ...(input.voiceProfileId !== undefined ? { voiceProfileId: input.voiceProfileId } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        extractionUserMessage: input.userMessage,
        extractionAssistantMessage: input.assistantMessage ?? null
      }
    };
  }

  private async findRepositoryDuplicate(candidate: MemoryCandidate): Promise<Memory | null> {
    const fingerprint = buildCandidateFingerprint(candidate);
    const scope = candidate.scope ?? inferMemoryScope(candidate);
    const scopeId = candidate.scopeId ?? inferMemoryScopeId(candidate);
    const recent = await this.repository.listRecentMemories(80);
    for (const memory of recent) {
      if (memory.status !== "active") {
        continue;
      }
      if (
        (memory.subjectUserId ?? "default-user") !== (candidate.subjectUserId ?? "default-user")
      ) {
        continue;
      }
      if (memory.scope !== scope) {
        continue;
      }
      if ((memory.scopeId ?? "") !== (scopeId ?? "")) {
        continue;
      }
      const memoryFingerprint = buildCandidateFingerprint({
        type: memory.type,
        subtype: memory.subtype,
        scope: memory.scope,
        scopeId: memory.scopeId,
        content: memory.content,
        importance: memory.importance,
        tags: memory.tags,
        reason: typeof memory.metadata?.["reason"] === "string" ? memory.metadata["reason"] : "",
        subjectUserId: memory.subjectUserId ?? null,
        personaId: memory.personaId ?? null,
        metadata: memory.metadata,
        eventTime: memory.eventTime?.toISOString() ?? null,
        validFrom: memory.validFrom.toISOString(),
        validUntil: memory.validUntil?.toISOString() ?? null
      });
      if (memoryFingerprint === fingerprint) {
        return memory;
      }
    }
    return null;
  }

  private async detectCorrectionRelationships(
    candidate: MemoryCandidate
  ): Promise<ReturnType<typeof detectEpisodicCorrectionRelationships>> {
    const scope = candidate.scope ?? inferMemoryScope(candidate);
    const scopeId = candidate.scopeId ?? inferMemoryScopeId(candidate);
    const recent = await this.repository.listRecentMemories(80);
    const scoped = recent.filter(
      (memory) =>
        memory.scope === scope &&
        (memory.scopeId ?? "") === (scopeId ?? "") &&
        (memory.subjectUserId ?? "default-user") === (candidate.subjectUserId ?? "default-user")
    );
    return detectEpisodicCorrectionRelationships(candidate, scoped);
  }

  private normalizeCandidateForStorage(candidate: MemoryCandidate): MemoryCandidate {
    const timezone = resolveTimezoneFromObservedAt(candidate.observedAt);
    const normalized = normalizeTemporalCandidate(candidate, {
      timestamp: candidate.observedAt ?? new Date(),
      timezone
    }).candidate;
    const bounds = resolveCanonicalTemporalBounds(normalized, timezone);
    const temporalDebug = resolveTemporalDebug({
      ...normalized,
      ...(bounds
        ? {
            validFrom: bounds.validFrom,
            validUntil: bounds.validUntil
          }
        : {})
    });
    const metadata = normalized.metadata ?? {};
    const withBounds = {
      ...normalized,
      ...(bounds
        ? {
            validFrom: bounds.validFrom,
            validUntil: bounds.validUntil
          }
        : {})
    };
    const fingerprint = buildCandidateFingerprint(withBounds);
    const eventKey = canonicalEventKey(withBounds);
    return {
      ...withBounds,
      personaId: withBounds.personaId ?? metadataString(metadata, "personaId") ?? "default-persona",
      subjectUserId:
        withBounds.subjectUserId ?? metadataString(metadata, "subjectUserId") ?? "default-user",
      createdByUserId:
        withBounds.createdByUserId ??
        metadataString(metadata, "createdByUserId") ??
        withBounds.subjectUserId ??
        "default-user",
      speakerId: withBounds.speakerId ?? metadataString(metadata, "speakerId") ?? null,
      voiceProfileId:
        withBounds.voiceProfileId ?? metadataString(metadata, "voiceProfileId") ?? null,
      sessionId: withBounds.sessionId ?? metadataString(metadata, "sessionId") ?? null,
      metadata: {
        ...metadata,
        canonicalFingerprint: fingerprint,
        ...(eventKey ? { canonicalEventKey: eventKey } : {}),
        temporalStatus: temporalDebug.temporalStatus,
        ...(temporalDebug.temporalSuggestion
          ? { temporalSuggestion: temporalDebug.temporalSuggestion }
          : {})
      }
    };
  }

  private applyRetentionPolicy(
    candidate: MemoryCandidate,
    options: { source?: string; tags?: string[] }
  ): MemoryCandidate {
    const source = options.source ?? "runtime";
    const policy = computeRetentionPolicy({ candidate, source });
    return {
      ...candidate,
      expiresAt: candidate.expiresAt ?? policy.expiresAt ?? null,
      validUntil: candidate.validUntil ?? policy.validUntil ?? null,
      metadata: {
        ...(candidate.metadata ?? {}),
        retentionClass: policy.retentionClass,
        retentionReason: policy.retentionReason,
        computedExpiresAt: (candidate.expiresAt ?? policy.expiresAt)?.toString() ?? null,
        ...(source === "smoke" || source === "test" || candidate.subtype === "test"
          ? { testMemory: true }
          : {})
      }
    };
  }

  private applyTestMemoryPolicy(input: CreateMemoryInput): CreateMemoryInput {
    if (!isTestMemoryInput(input)) {
      return input;
    }
    const createdAt = toValidDate(input.observedAt) ?? new Date();
    const expiresAt = input.expiresAt
      ? (toValidDate(input.expiresAt) ?? input.expiresAt)
      : addDays(createdAt, 1);
    return {
      ...input,
      memoryLayer:
        input.memoryLayer === "core" || input.memoryLayer === undefined
          ? "recall"
          : input.memoryLayer,
      importance: Math.min(input.importance ?? 0.3, 0.3),
      expiresAt,
      metadata: {
        ...(input.metadata ?? {}),
        testMemory: true,
        retentionClass: "test",
        retentionReason: "smoke/test memory should expire quickly",
        computedExpiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt)
      },
      tags: Array.from(new Set([...(input.tags ?? []), "test"]))
    };
  }

  private async detectCandidateRelationships(
    candidate: MemoryCandidate
  ): Promise<MemoryRelationshipSuggestion> {
    const scope = candidate.scope ?? inferMemoryScope(candidate);
    const scopeId = candidate.scopeId ?? inferMemoryScopeId({ ...candidate, scope });
    const textMatches = await this.repository.searchMemoriesByTextFallback({
      text: relationshipSearchText({ ...candidate, scope, scopeId }),
      includeHistory: true,
      includeExpired: true,
      limit: 30,
      scope,
      ...(scopeId ? { scopeId } : {})
    });
    const recent = await this.repository.listRecentMemories(30);
    const existing = [...textMatches, ...recent].filter(
      (memory, index, memories) => memories.findIndex((entry) => entry.id === memory.id) === index
    );
    return detectMemoryRelationships({ ...candidate, scope, scopeId }, existing);
  }

  private async applyAutomaticSupersession(memory: Memory, supersededIds: string[]): Promise<void> {
    if (supersededIds.length === 0) return;
    await Promise.all(
      supersededIds.map((id) =>
        this.repository.updateMemory(id, {
          status: "superseded",
          supersededBy: memory.id,
          supersededAt: new Date()
        })
      )
    );
  }

  private reconstructForPrompt(memory: Memory): string {
    return memory.summary ?? this.compressForStorage(memory.content);
  }

  private async retrieveWithFallback(query: MemorySearchQuery): Promise<MemoryRetrievalResult> {
    const policy = createRetrievalPolicy(query);
    const queryText = query.text?.trim() ?? "";
    const keywords = queryText ? extractSearchKeywords(queryText) : [];
    const embeddingDebug = await this.generateQueryEmbedding(queryText, query);
    const broadQuery: MemorySearchQuery = {
      includeHistory: true,
      includeHistoricalEpisodic:
        query.includeHistoricalEpisodic ?? hasHistoricalEpisodicIntent(query.text),
      limit: Math.max(query.limit ?? 6, 20)
    };
    if (query.text !== undefined) broadQuery.text = query.text;
    if (query.types !== undefined) broadQuery.types = query.types;
    if (query.subtypes !== undefined) broadQuery.subtypes = query.subtypes;
    if (query.memoryLayers !== undefined) broadQuery.memoryLayers = query.memoryLayers;
    if (query.statuses !== undefined) broadQuery.statuses = query.statuses;
    if (query.sources !== undefined) broadQuery.sources = query.sources;
    if (query.personaId !== undefined) broadQuery.personaId = query.personaId;
    if (query.subjectUserId !== undefined) broadQuery.subjectUserId = query.subjectUserId;
    if (query.createdByUserId !== undefined) broadQuery.createdByUserId = query.createdByUserId;
    if (query.speakerId !== undefined) broadQuery.speakerId = query.speakerId;
    if (query.voiceProfileId !== undefined) broadQuery.voiceProfileId = query.voiceProfileId;
    if (query.userId !== undefined) broadQuery.userId = query.userId;
    if (query.sessionId !== undefined) broadQuery.sessionId = query.sessionId;
    if (query.minImportance !== undefined) broadQuery.minImportance = query.minImportance;
    if (query.tags !== undefined) broadQuery.tags = query.tags;
    const memories = await this.retriever.retrieve(broadQuery);
    const vectorCandidates =
      embeddingDebug.embedding && shouldUseVectorRetrieval(query)
        ? this.toCandidates(
            await this.repository.searchMemoriesByEmbedding({
              ...broadQuery,
              embedding: embeddingDebug.embedding,
              limit: Math.max(query.limit ?? 6, 10)
            }),
            keywords,
            policy
          )
        : [];
    if (!queryText || keywords.length === 0) {
      return this.buildRetrievalResult(
        query,
        policy,
        keywords,
        [...memories, ...vectorCandidates.map((candidate) => candidate.memory)],
        vectorCandidates.length > 0
          ? this.hybridRetrievalMode()
          : (this.repository.getRetrievalMode?.() ?? "in-memory-keyword"),
        embeddingDebug,
        vectorCandidates.length,
        memories.length
      );
    }

    const candidates = [
      ...this.toCandidates(memories, keywords, policy),
      ...vectorCandidates,
      ...(await this.retrieveByKeywords(query, keywords, policy))
    ].sort(compareCandidates);

    if (candidates.length > 0) {
      return this.buildRetrievalResultFromCandidates(
        query,
        policy,
        keywords,
        candidates,
        vectorCandidates.length > 0 ? this.hybridRetrievalMode() : this.resolveRetrievalMode(true),
        embeddingDebug,
        vectorCandidates.length,
        memories.length
      );
    }

    const recent = await this.repository.listRecentMemories(Math.max(query.limit ?? 6, 20));
    return this.buildRetrievalResultFromCandidates(
      query,
      policy,
      keywords,
      this.rankFallbackRecent(recent, policy),
      "fallback-recent",
      {
        ...embeddingDebug,
        fallbackUsed: true,
        fallbackReason: "No keyword or vector candidates matched."
      },
      vectorCandidates.length,
      memories.length
    );
  }

  private async retrieveByKeywords(
    query: MemorySearchQuery,
    keywords: string[],
    policy: RetrievalPolicy
  ): Promise<RetrievedMemoryCandidate[]> {
    const matches = new Map<string, RetrievedMemoryCandidate>();
    for (const keyword of keywords.slice(0, 8)) {
      const results = await this.repository.searchMemoriesByTextFallback({
        text: keyword,
        includeHistory: true,
        limit: Math.max(query.limit ?? 6, 10),
        ...(query.types !== undefined ? { types: query.types } : {}),
        ...(query.subtypes !== undefined ? { subtypes: query.subtypes } : {}),
        ...(query.memoryLayers !== undefined ? { memoryLayers: query.memoryLayers } : {}),
        ...(query.statuses !== undefined ? { statuses: query.statuses } : {}),
        ...(query.sources !== undefined ? { sources: query.sources } : {}),
        ...(query.personaId !== undefined ? { personaId: query.personaId } : {}),
        ...(query.subjectUserId !== undefined ? { subjectUserId: query.subjectUserId } : {}),
        ...(query.createdByUserId !== undefined ? { createdByUserId: query.createdByUserId } : {}),
        ...(query.speakerId !== undefined ? { speakerId: query.speakerId } : {}),
        ...(query.voiceProfileId !== undefined ? { voiceProfileId: query.voiceProfileId } : {}),
        ...(query.userId !== undefined ? { userId: query.userId } : {}),
        ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
        ...(query.minImportance !== undefined ? { minImportance: query.minImportance } : {}),
        ...(query.tags !== undefined ? { tags: query.tags } : {})
      });
      for (const candidate of this.rankKeywordMatches(results, keywords, policy)) {
        const current = matches.get(candidate.memory.id);
        if (!current || candidate.score > current.score) {
          matches.set(candidate.memory.id, candidate);
        }
      }
    }

    return [...matches.values()].sort(compareCandidates);
  }

  private rankKeywordMatches(
    memories: Memory[],
    keywords: string[],
    policy: RetrievalPolicy
  ): RetrievedMemoryCandidate[] {
    return this.toCandidates(memories, keywords, policy).sort(compareCandidates);
  }

  private toCandidates(
    memories: Memory[],
    keywords: string[],
    policy: RetrievalPolicy
  ): RetrievedMemoryCandidate[] {
    return memories
      .map((memory) => {
        const lexicalScore = scoreMemory(memory, keywords, policy);
        const matchedBy = memory.searchMatchedBy ?? detectMatchReason(memory, keywords);
        const vectorScore = memory.searchRankComponents?.vectorScore ?? 0;
        const vectorOnlyMatch = matchedBy === "vector" && keywords.length > 0 && lexicalScore <= 0;
        const vectorThreshold = this.embeddingProvider?.mock ? 0.95 : 0.78;
        const vectorExclusion =
          vectorOnlyMatch && vectorScore < vectorThreshold
            ? { excludedReason: `vector-below-threshold:${vectorScore.toFixed(3)}` }
            : {};

        return {
          memory,
          displayText: createMemoryDisplayText(memory),
          matchedBy,
          score: lexicalScore + (memory.searchScore ?? 0),
          ...(memory.searchRankComponents ? { rankComponents: memory.searchRankComponents } : {}),
          ...memoryExclusion(memory, policy),
          ...vectorExclusion
        };
      })
      .filter((entry) => entry.score > 0 || Boolean(entry.excludedReason));
  }

  private rankFallbackRecent(
    memories: Memory[],
    policy: RetrievalPolicy
  ): RetrievedMemoryCandidate[] {
    return memories
      .map((memory) => ({
        memory,
        displayText: createMemoryDisplayText(memory),
        matchedBy: "fallback" as const,
        score:
          typePriority(memory.type) +
          layerPriority(memory.memoryLayer) +
          memory.importance +
          sourceQuality(memory.source) +
          scopeQuality(memory, policy),
        ...memoryExclusion(memory, policy)
      }))
      .sort(compareCandidates);
  }

  private buildRetrievalResult(
    query: MemorySearchQuery,
    policy: RetrievalPolicy,
    keywords: string[],
    memories: Memory[],
    retrievalMode: MemoryRetrievalMode,
    embeddingDebug: RetrievalEmbeddingDebug = emptyRetrievalEmbeddingDebug(),
    vectorResultCount = 0,
    keywordResultCount = memories.length
  ): MemoryRetrievalResult {
    return this.buildRetrievalResultFromCandidates(
      query,
      policy,
      keywords,
      memories
        .map((memory) => ({
          memory,
          displayText: createMemoryDisplayText(memory),
          matchedBy: memory.searchMatchedBy ?? detectMatchReason(memory, keywords),
          score: scoreMemory(memory, keywords, policy) + (memory.searchScore ?? 0),
          ...(memory.searchRankComponents ? { rankComponents: memory.searchRankComponents } : {}),
          ...memoryExclusion(memory, policy)
        }))
        .sort(compareCandidates),
      retrievalMode,
      embeddingDebug,
      vectorResultCount,
      keywordResultCount
    );
  }

  private resolveRetrievalMode(hasKeywordFallback: boolean): MemoryRetrievalMode {
    const repositoryMode = this.repository.getRetrievalMode?.() ?? "in-memory-keyword";
    if (
      repositoryMode === "postgres-hybrid" ||
      repositoryMode === "postgres-hybrid-keyword" ||
      repositoryMode === "postgres-trigram" ||
      repositoryMode === "in-memory-hybrid" ||
      repositoryMode === "in-memory-keyword"
    ) {
      return repositoryMode;
    }
    return hasKeywordFallback ? "hybrid-keyword" : "keyword";
  }

  private hybridRetrievalMode(): MemoryRetrievalMode {
    const repositoryMode = this.repository.getRetrievalMode?.() ?? "in-memory-keyword";
    return repositoryMode.startsWith("postgres") ? "postgres-hybrid" : "in-memory-hybrid";
  }

  private buildRetrievalResultFromCandidates(
    query: MemorySearchQuery,
    policy: RetrievalPolicy,
    keywords: string[],
    candidates: RetrievedMemoryCandidate[],
    retrievalMode: MemoryRetrievalMode,
    embeddingDebug: RetrievalEmbeddingDebug = emptyRetrievalEmbeddingDebug(),
    vectorResultCount = candidates.filter((candidate) => candidate.matchedBy === "vector").length,
    keywordResultCount = candidates.length - vectorResultCount
  ): MemoryRetrievalResult {
    const mergedCandidates = mergeCandidateMatches(candidates);
    const { selected, all } = dedupeCandidates(
      mergedCandidates.filter((candidate) => !candidate.excludedReason)
    );
    const excluded = mergedCandidates.filter((candidate) => candidate.excludedReason);
    const selectedLimited = selected.slice(0, query.limit ?? 6);
    const selectedIds = new Set(selectedLimited.map((candidate) => candidate.memory.id));
    const debug = [...all, ...excluded].map((candidate) =>
      toDebugMemory(
        selectedIds.has(candidate.memory.id)
          ? candidate
          : { ...candidate, excludedReason: candidate.excludedReason ?? "filtered-after-ranking" }
      )
    );

    return {
      query: query.text ?? "",
      keywords,
      rawCount: candidates.length,
      count: selectedLimited.length,
      retrievalMode,
      vectorEnabled: embeddingDebug.vectorEnabled,
      vectorUsed: embeddingDebug.vectorUsed || vectorResultCount > 0,
      ...(embeddingDebug.embeddingProvider
        ? { embeddingProvider: embeddingDebug.embeddingProvider }
        : {}),
      ...(embeddingDebug.embeddingModel ? { embeddingModel: embeddingDebug.embeddingModel } : {}),
      ...(embeddingDebug.embeddingDimensions
        ? { embeddingDimensions: embeddingDebug.embeddingDimensions }
        : {}),
      ...(embeddingDebug.semanticEmbedding !== undefined
        ? { semanticEmbedding: embeddingDebug.semanticEmbedding }
        : {}),
      ...(embeddingDebug.embeddingNote ? { embeddingNote: embeddingDebug.embeddingNote } : {}),
      queryEmbeddingGenerated: embeddingDebug.queryEmbeddingGenerated,
      vectorResultCount,
      keywordResultCount,
      hybridResultCount: selectedLimited.length,
      fallbackUsed: Boolean(embeddingDebug.fallbackUsed || retrievalMode === "fallback-recent"),
      ...(embeddingDebug.fallbackReason ? { fallbackReason: embeddingDebug.fallbackReason } : {}),
      retrievalScope: policy.retrievalScope,
      includedScopes: policy.includedScopes,
      includeArchived: policy.includeArchived,
      includeSuperseded: policy.includeSuperseded,
      includeExpired: policy.includeExpired,
      currentTime: policy.currentTime.toISOString(),
      excludedByStatus: countUniqueExcluded(debug, "status:"),
      excludedByTime: countUniqueExcluded(debug, "time:"),
      excludedByScope: countUniqueExcluded(debug, "scope:"),
      rawMemories: debug,
      memories: debug.filter((memory) => !memory.excludedReason),
      selectedMemories: selectedLimited.map((candidate) => candidate.memory)
    };
  }
}

export type { CreateMemoryInput };

export function extractSearchKeywords(text: string): string[] {
  const normalized = text.toLowerCase();
  const latinTokens = normalized
    .match(/[a-z0-9][a-z0-9_-]*/gu)
    ?.map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !stopWords.has(token));
  const cjkTokens = normalized
    .match(/[\u4e00-\u9fff]{2,}/gu)
    ?.flatMap((token) => cjkKeywordCandidates(token));

  return Array.from(new Set([...(latinTokens ?? []), ...(cjkTokens ?? [])])).slice(0, 16);
}

function cjkKeywordCandidates(token: string): string[] {
  const candidates = new Set<string>();
  if (token.length <= 6 && !cjkStopWords.has(token)) {
    candidates.add(token);
  }

  for (let size = 2; size <= Math.min(4, token.length); size += 1) {
    for (let index = 0; index <= token.length - size; index += 1) {
      const gram = token.slice(index, index + size);
      if (!cjkStopWords.has(gram)) {
        candidates.add(gram);
      }
    }
  }

  return [...candidates];
}

export function createMemoryDisplayText(memory: Memory): string {
  const content = normalizeDisplayText(memory.content);
  const summary = memory.summary ? normalizeDisplayText(memory.summary) : "";
  const summaryIsUseful =
    summary.length >= 12 && summary.length < content.length && !isVerboseRuntimeSummary(summary);
  const selected = summaryIsUseful ? summary : content;

  return truncateDisplayText(stripVerboseRuntimeTranscript(selected), 220);
}

export function normalizeDisplayText(text: string): string {
  return stripEdgeQuotes(text)
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function stripEdgeQuotes(text: string): string {
  let result = text.trim();
  let changed = true;
  while (changed && result.length > 0) {
    changed = false;
    if (quoteChars.has(result.at(0) ?? "")) {
      result = result.slice(1).trimStart();
      changed = true;
    }
    if (quoteChars.has(result.at(-1) ?? "")) {
      result = result.slice(0, -1).trimEnd();
      changed = true;
    }
  }
  return result;
}

function stripVerboseRuntimeTranscript(text: string): string {
  const userIntent = text.match(/User intent:\s*([^\n]+)/i)?.[1];
  if (userIntent && isVerboseRuntimeSummary(text)) {
    return normalizeDisplayText(userIntent);
  }

  return text
    .replace(/Assistant response summary:\s*.*$/gis, "")
    .replace(/User intent:\s*/gi, "")
    .trim();
}

function isVerboseRuntimeSummary(text: string): boolean {
  return /Assistant response summary:/i.test(text) && text.length > 160;
}

function truncateDisplayText(text: string, maxLength: number): string {
  const normalized = stripLeadingListMarkers(normalizeDisplayText(text));
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trim()}...`
    : normalized;
}

function stripLeadingListMarkers(text: string): string {
  let result = text.trim();
  let previous = "";

  while (result && result !== previous) {
    previous = result;
    result = result
      .replace(/^>\s*/, "")
      .replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/u, "")
      .trimStart();
  }

  return result;
}

type RetrievalPolicy = {
  retrievalScope: string;
  includedScopes: Array<{ scope: MemoryScope; scopeId?: string | null }>;
  includeArchived: boolean;
  includeSuperseded: boolean;
  includeExpired: boolean;
  includeHistoricalEpisodic: boolean;
  includeTestMemories: boolean;
  currentTime: Date;
};

type RetrievalEmbeddingDebug = {
  vectorEnabled: boolean;
  vectorUsed: boolean;
  queryEmbeddingGenerated: boolean;
  embedding?: number[] | undefined;
  embeddingProvider?: string | undefined;
  embeddingModel?: string | undefined;
  embeddingDimensions?: number | undefined;
  semanticEmbedding?: boolean | undefined;
  embeddingNote?: string | undefined;
  fallbackUsed?: boolean | undefined;
  fallbackReason?: string | undefined;
};

function emptyRetrievalEmbeddingDebug(): RetrievalEmbeddingDebug {
  return {
    vectorEnabled: false,
    vectorUsed: false,
    queryEmbeddingGenerated: false,
    fallbackUsed: false
  };
}

function shouldUseVectorRetrieval(query: MemorySearchQuery): boolean {
  return query.vectorEnabled !== false;
}

function shouldEmbedQuery(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length < 3) {
    return false;
  }
  return !/^(hi|hey|hello|你好|在吗)[!.。！\s]*$/iu.test(normalized);
}

function buildEmbeddingInput(input: CreateMemoryInput): string {
  return [input.summary, input.content, input.tags?.join(" ")]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

function validateEmbeddingDimensions(vector: number[], expected: number): void {
  if (vector.length !== expected) {
    throw new EmbeddingDimensionMismatchError(expected, vector.length);
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new Error("Embedding vector contained non-finite values.");
  }
}

function embeddingFailureDiagnostic(error: unknown, provider: MemoryEmbeddingProvider): string {
  return [
    safeErrorMessage(error),
    `provider=${provider.name}`,
    `model=${provider.model ?? provider.name}`,
    `expectedDimensions=${provider.dimensions}`
  ].join(" ");
}

class EmbeddingDimensionMismatchError extends Error {
  constructor(
    readonly expectedDimensions: number,
    readonly actualDimensions: number
  ) {
    super(
      `Embedding dimension mismatch: expected ${expectedDimensions}, received ${actualDimensions}.`
    );
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]").slice(0, 300);
}

function safeEmbeddingError(metadata: Record<string, unknown>): string | undefined {
  const value = metadata["embeddingError"];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return safeErrorMessage(value);
}

function createRetrievalPolicy(query: MemorySearchQuery): RetrievalPolicy {
  const includedScopes = resolveIncludedScopes(query);
  const currentTime = toValidDate(query.currentTime) ?? new Date();
  const includeHistoricalEpisodic =
    Boolean(query.includeHistoricalEpisodic) || hasHistoricalEpisodicIntent(query.text);
  return {
    retrievalScope: includedScopes
      .map((entry) => `${entry.scope}${entry.scopeId ? `:${entry.scopeId}` : ""}`)
      .join(","),
    includedScopes,
    includeArchived: Boolean(query.includeArchived),
    includeSuperseded: Boolean(query.includeSuperseded || query.includeHistory),
    includeExpired: Boolean(query.includeExpired),
    includeHistoricalEpisodic,
    includeTestMemories: Boolean(query.includeTestMemories),
    currentTime
  };
}

function resolveIncludedScopes(
  query: MemorySearchQuery
): Array<{ scope: MemoryScope; scopeId?: string | null }> {
  if (query.scope) {
    return [{ scope: query.scope, ...(query.scopeId ? { scopeId: query.scopeId } : {}) }];
  }
  if (query.scopes?.length) {
    return query.scopes.map((scope) => scopeEntryForQuery(scope, query));
  }

  const scopes: MemoryScope[] = ["user", "project"];
  if (query.sessionId) scopes.push("session");
  if (query.agentId) scopes.push("agent");
  if (query.pluginId) scopes.push("plugin");
  return scopes.map((scope) => scopeEntryForQuery(scope, query));
}

function scopeEntryForQuery(
  scope: MemoryScope,
  query: MemorySearchQuery
): { scope: MemoryScope; scopeId?: string | null } {
  if (scope === "project") {
    return { scope, scopeId: query.projectId ?? query.scopeId ?? "yuvi-runtime" };
  }
  if (scope === "session" && query.sessionId) {
    return { scope, scopeId: query.sessionId };
  }
  if (scope === "agent" && query.agentId) {
    return { scope, scopeId: query.agentId };
  }
  if (scope === "plugin" && query.pluginId) {
    return { scope, scopeId: query.pluginId };
  }
  return { scope };
}

function memoryExclusion(
  memory: Memory,
  policy: RetrievalPolicy
): Pick<RetrievedMemoryCandidate, "excludedReason"> {
  if (!policy.includeTestMemories && isTestMemoryRecord(memory)) {
    return { excludedReason: "test-memory" };
  }

  const scopeReason = scopeExclusion(memory, policy);
  if (scopeReason) return { excludedReason: scopeReason };

  const statusReason = statusExclusion(memory, policy);
  if (statusReason) return { excludedReason: statusReason };

  const timeReason = timeExclusion(memory, policy);
  if (timeReason) return { excludedReason: timeReason };

  return {};
}

function scopeExclusion(memory: Memory, policy: RetrievalPolicy): string | null {
  const match = policy.includedScopes.some((entry) => {
    if (entry.scope !== memory.scope) return false;
    if (!entry.scopeId) return true;
    if (!memory.scopeId && memory.scope === "session") return true;
    return memory.scopeId === entry.scopeId;
  });
  return match
    ? null
    : `scope:not-included:${memory.scope}${memory.scopeId ? `:${memory.scopeId}` : ""}`;
}

function statusExclusion(memory: Memory, policy: RetrievalPolicy): string | null {
  if (memory.status === "active") return null;
  if (memory.status === "archived" && policy.includeArchived) return null;
  if (memory.status === "superseded" && policy.includeSuperseded) return null;
  if (memory.status === "expired" && policy.includeExpired) return null;
  return `status:${memory.status}`;
}

function timeExclusion(memory: Memory, policy: RetrievalPolicy): string | null {
  const now = policy.currentTime.getTime();
  const historicalEpisodic =
    policy.includeHistoricalEpisodic &&
    memory.type === "episodic" &&
    memory.memoryLayer === "recall";
  if (
    !policy.includeExpired &&
    !historicalEpisodic &&
    memory.expiresAt &&
    memory.expiresAt.getTime() <= now
  ) {
    return "time:expiresAt";
  }
  if (
    !policy.includeExpired &&
    !historicalEpisodic &&
    memory.validUntil &&
    memory.validUntil.getTime() <= now
  ) {
    return "time:validUntil";
  }
  if (memory.validFrom && memory.validFrom.getTime() > now) {
    return "time:validFrom";
  }
  return null;
}

function scoreMemory(memory: Memory, keywords: string[], policy: RetrievalPolicy): number {
  const matchCount = keywords.reduce(
    (score, keyword) => score + keywordMatchWeight(memory, keyword),
    0
  );
  if (keywords.length > 0 && matchCount === 0) {
    return 0;
  }

  const isRuntimeNoise = isVerboseRuntimeSummary(memory.summary ?? memory.content);
  const effectiveMatchCount = isRuntimeNoise ? Math.min(matchCount, 1) : matchCount;
  const runtimeNoisePenalty = isRuntimeNoise ? 3 : 0;
  const recencyBonus = recencyScore(memory.createdAt);
  const accessBonus = accessScore(memory.lastAccessedAt);
  return (
    effectiveMatchCount * 4 +
    typePriority(memory.type) +
    layerPriority(memory.memoryLayer) +
    memory.importance * 2 -
    runtimeNoisePenalty +
    sourceQuality(memory.source) +
    scopeQuality(memory, policy) +
    recencyBonus +
    accessBonus
  );
}

function detectMatchReason(memory: Memory, keywords: string[]): MemoryMatchReason {
  if (keywords.length === 0) {
    return "keyword";
  }

  for (const keyword of keywords) {
    if (includesKeyword(memory.content, keyword)) {
      return "content";
    }
    if (memory.summary && includesKeyword(memory.summary, keyword)) {
      return "summary";
    }
    if (memory.tags.some((tag) => includesKeyword(tag, keyword))) {
      return "tag";
    }
    if (
      includesKeyword(memory.type, keyword) ||
      (memory.subtype && includesKeyword(memory.subtype, keyword))
    ) {
      return memory.subtype && includesKeyword(memory.subtype, keyword) ? "subtype" : "type";
    }
    if (
      includesKeyword(memory.scope, keyword) ||
      (memory.scopeId && includesKeyword(memory.scopeId, keyword)) ||
      includesKeyword(memory.memoryLayer, keyword)
    ) {
      return "scope";
    }
    if (
      includesKeyword(memory.source, keyword) ||
      (memory.sourceTraceId && includesKeyword(memory.sourceTraceId, keyword))
    ) {
      return "source";
    }
    if (includesKeyword(JSON.stringify(memory.metadata), keyword)) {
      return "metadata";
    }
  }

  return "keyword";
}

function keywordMatchWeight(memory: Memory, keyword: string): number {
  let score = 0;
  if (includesKeyword(memory.content, keyword)) {
    score += 2.5;
  }
  if (memory.summary && includesKeyword(memory.summary, keyword)) {
    score += 3;
  }
  if (memory.tags.some((tag) => includesKeyword(tag, keyword))) {
    score += 3.5;
  }
  if (
    includesKeyword(memory.type, keyword) ||
    (memory.subtype && includesKeyword(memory.subtype, keyword))
  ) {
    score += 2.25;
  }
  if (
    includesKeyword(memory.scope, keyword) ||
    (memory.scopeId && includesKeyword(memory.scopeId, keyword)) ||
    includesKeyword(memory.memoryLayer, keyword)
  ) {
    score += 1.75;
  }
  if (
    includesKeyword(memory.source, keyword) ||
    (memory.sourceTraceId && includesKeyword(memory.sourceTraceId, keyword))
  ) {
    score += 1.5;
  }
  if (includesKeyword(JSON.stringify(memory.metadata), keyword)) {
    score += 1.25;
  }
  return score;
}

function includesKeyword(value: string, keyword: string): boolean {
  return value.toLowerCase().includes(keyword.toLowerCase());
}

function dedupeCandidates(candidates: RetrievedMemoryCandidate[]): {
  selected: RetrievedMemoryCandidate[];
  all: RetrievedMemoryCandidate[];
} {
  const all: RetrievedMemoryCandidate[] = [];
  const selected: RetrievedMemoryCandidate[] = [];

  for (const candidate of [...candidates].sort(compareCandidates)) {
    const duplicateOf = selected.find((kept) =>
      isDuplicateDisplayText(kept.displayText, candidate.displayText)
    );
    if (duplicateOf) {
      all.push({
        ...candidate,
        excludedReason: `deduped-near-duplicate-of:${duplicateOf.memory.id}`
      });
      continue;
    }
    selected.push(candidate);
    all.push(candidate);
  }

  return { selected, all };
}

function mergeCandidateMatches(candidates: RetrievedMemoryCandidate[]): RetrievedMemoryCandidate[] {
  const byId = new Map<string, RetrievedMemoryCandidate>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.memory.id);
    if (!current) {
      byId.set(candidate.memory.id, candidate);
      continue;
    }

    const merged = mergeCandidateScore(current, candidate);
    if (candidate.score > current.score) {
      byId.set(candidate.memory.id, merged);
    } else {
      byId.set(candidate.memory.id, {
        ...merged,
        matchedBy:
          current.matchedBy === "vector" && candidate.matchedBy !== "vector"
            ? candidate.matchedBy
            : current.matchedBy
      });
    }
  }
  return [...byId.values()].sort(compareCandidates);
}

function mergeCandidateScore(
  left: RetrievedMemoryCandidate,
  right: RetrievedMemoryCandidate
): RetrievedMemoryCandidate {
  const keywordCandidate =
    left.matchedBy === "vector" && right.matchedBy !== "vector" ? right : left;
  return {
    ...keywordCandidate,
    score: Math.max(left.score, right.score) + Math.min(left.score, right.score) * 0.15,
    rankComponents: {
      ...(left.rankComponents ?? {}),
      ...(right.rankComponents ?? {})
    }
  };
}

function countUniqueExcluded(memories: RetrievedMemoryDebug[], prefix: string): number {
  return new Set(
    memories
      .filter((memory) => memory.excludedReason?.startsWith(prefix))
      .map((memory) => memory.id)
  ).size;
}

function isDuplicateDisplayText(left: string, right: string): boolean {
  const normalizedLeft = normalizeForDedup(left);
  const normalizedRight = normalizeForDedup(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const shorter =
    normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight;
  return shorter.length >= 24 && longer.includes(shorter);
}

function normalizeForDedup(text: string): string {
  return normalizeDisplayText(text)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function compareCandidates(
  left: RetrievedMemoryCandidate,
  right: RetrievedMemoryCandidate
): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const typeDelta = typePriority(right.memory.type) - typePriority(left.memory.type);
  if (typeDelta !== 0) {
    return typeDelta;
  }

  const layerDelta =
    layerPriority(right.memory.memoryLayer) - layerPriority(left.memory.memoryLayer);
  if (layerDelta !== 0) {
    return layerDelta;
  }

  const importanceDelta = right.memory.importance - left.memory.importance;
  if (importanceDelta !== 0) {
    return importanceDelta;
  }

  return right.memory.createdAt.getTime() - left.memory.createdAt.getTime();
}

function sourceQuality(source: string): number {
  if (source === "dashboard" || source === "manual") {
    return 1.5;
  }
  if (source === "runtime") {
    return -0.4;
  }
  return 0;
}

function recencyScore(createdAt: Date): number {
  const ageMs = Date.now() - createdAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 0;
  }
  const ageDays = ageMs / 86_400_000;
  return Math.max(0, 1 - ageDays / 30) * 0.5;
}

function accessScore(lastAccessedAt: Date): number {
  const ageMs = Date.now() - lastAccessedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 0;
  }
  const ageDays = ageMs / 86_400_000;
  return Math.max(0, 1 - ageDays / 14) * 0.25;
}

function isTestMemoryInput(input: CreateMemoryInput): boolean {
  return (
    input.source === "smoke" ||
    input.source === "mock" ||
    input.subtype === "test" ||
    input.metadata?.["testMemory"] === true ||
    input.tags?.some((tag) => ["smoke", "mock", "test"].includes(tag)) === true ||
    normalizeDisplayText(input.content).toLowerCase() === "smoke test memory."
  );
}

function isTestMemoryRecord(memory: Memory): boolean {
  return (
    memory.source === "smoke" ||
    memory.source === "mock" ||
    memory.subtype === "test" ||
    memory.metadata["testMemory"] === true ||
    memory.tags.some((tag) => ["smoke", "mock", "test"].includes(tag)) ||
    normalizeDisplayText(memory.content).toLowerCase() === "smoke test memory." ||
    (memory.summary !== null &&
      normalizeDisplayText(memory.summary).toLowerCase() === "smoke test memory.")
  );
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function scopeQuality(memory: Memory, policy: RetrievalPolicy): number {
  const matchingScope = policy.includedScopes.find((entry) => entry.scope === memory.scope);
  if (!matchingScope) {
    return -6;
  }
  if (!matchingScope.scopeId) {
    return memory.scope === "user" ? 1.2 : 0.6;
  }
  if (memory.scopeId === matchingScope.scopeId) {
    return 2;
  }
  if (!memory.scopeId && memory.scope === "session") {
    return 0.5;
  }
  return -6;
}

function layerPriority(layer: MemoryLayer): number {
  switch (layer) {
    case "core":
      return 3;
    case "working":
      return 2.5;
    case "recall":
      return 1.5;
    case "archival":
      return -0.5;
  }
}

function typePriority(type: MemoryType): number {
  switch (type) {
    case "semantic":
      return 5;
    case "procedural":
      return 4;
    case "relationship":
      return 4;
    case "emotional":
      return 3;
    case "episodic":
      return 2;
    case "working":
      return 1;
  }
}

function toDebugMemory(candidate: RetrievedMemoryCandidate): RetrievedMemoryDebug {
  const embeddingError = safeEmbeddingError(candidate.memory.metadata);
  const semanticEmbedding =
    candidate.memory.embeddingProvider === null || candidate.memory.embeddingProvider === undefined
      ? undefined
      : candidate.memory.embeddingProvider !== "mock";
  return {
    id: candidate.memory.id,
    type: candidate.memory.type,
    subtype: candidate.memory.subtype,
    scope: candidate.memory.scope,
    scopeId: candidate.memory.scopeId,
    memoryLayer: candidate.memory.memoryLayer,
    status: candidate.memory.status,
    source: candidate.memory.source,
    sourceTraceId: candidate.memory.sourceTraceId,
    ...(candidate.memory.personaId !== undefined ? { personaId: candidate.memory.personaId } : {}),
    ...(candidate.memory.subjectUserId !== undefined
      ? { subjectUserId: candidate.memory.subjectUserId }
      : {}),
    ...(candidate.memory.createdByUserId !== undefined
      ? { createdByUserId: candidate.memory.createdByUserId }
      : {}),
    ...(candidate.memory.speakerId !== undefined ? { speakerId: candidate.memory.speakerId } : {}),
    ...(candidate.memory.voiceProfileId !== undefined
      ? { voiceProfileId: candidate.memory.voiceProfileId }
      : {}),
    ...(candidate.memory.sessionId !== undefined ? { sessionId: candidate.memory.sessionId } : {}),
    metadata: candidate.memory.metadata,
    importance: candidate.memory.importance,
    createdAt: candidate.memory.createdAt,
    observedAt: candidate.memory.observedAt,
    eventTime: candidate.memory.eventTime,
    validFrom: candidate.memory.validFrom,
    validUntil: candidate.memory.validUntil,
    expiresAt: candidate.memory.expiresAt,
    ...(typeof candidate.memory.metadata["retentionClass"] === "string"
      ? { retentionClass: candidate.memory.metadata["retentionClass"] }
      : {}),
    ...(typeof candidate.memory.metadata["retentionReason"] === "string"
      ? { retentionReason: candidate.memory.metadata["retentionReason"] }
      : {}),
    lastAccessedAt: candidate.memory.lastAccessedAt,
    supersededAt: candidate.memory.supersededAt,
    displayText: candidate.displayText,
    matchedBy: candidate.matchedBy,
    hasEmbedding: Boolean(candidate.memory.embedding?.length),
    embeddingProvider: candidate.memory.embeddingProvider,
    embeddingModel: candidate.memory.embeddingModel,
    embeddingDimensions: candidate.memory.embeddingDimensions,
    embeddedAt: candidate.memory.embeddedAt,
    ...(semanticEmbedding !== undefined ? { semanticEmbedding } : {}),
    ...(embeddingError ? { embeddingError } : {}),
    ...(candidate.memory.searchRetrievalMode
      ? { retrievalMode: candidate.memory.searchRetrievalMode }
      : {}),
    ...(candidate.rankComponents?.vectorScore !== undefined
      ? { vectorScore: candidate.rankComponents.vectorScore }
      : {}),
    ...(candidate.rankComponents?.keywordScore !== undefined
      ? { keywordScore: candidate.rankComponents.keywordScore }
      : {}),
    ...(candidate.rankComponents?.hybridScore !== undefined
      ? { hybridScore: candidate.rankComponents.hybridScore }
      : {}),
    score: candidate.score,
    ...(candidate.rankComponents ? { rankComponents: candidate.rankComponents } : {}),
    ...(candidate.excludedReason ? { excludedReason: candidate.excludedReason } : {})
  };
}

function isPromptRetrievableMemory(memory: Memory): boolean {
  const now = Date.now();
  return (
    memory.status === "active" &&
    (!memory.expiresAt || memory.expiresAt.getTime() > now) &&
    (!memory.validFrom || memory.validFrom.getTime() <= now) &&
    (!memory.validUntil || memory.validUntil.getTime() > now)
  );
}

function mergeRelationshipSuggestions(
  relationships: MemoryRelationshipSuggestion,
  correction: ReturnType<typeof detectEpisodicCorrectionRelationships>
): MemoryRelationshipSuggestion & { correctionRelated: string[] } {
  const supersedes = new Set([...relationships.supersedes, ...correction.supersedes]);
  const autoSupersedes = new Set([...relationships.autoSupersedes, ...correction.supersedes]);
  const contradicts = new Set([...relationships.contradicts, ...correction.contradicts]);
  return {
    ...relationships,
    supersedes: [...supersedes],
    autoSupersedes: [...autoSupersedes],
    contradicts: [...contradicts],
    correctionRelated: correction.relatedMemoryIds
  };
}

function hasCorrectionRequest(candidate: MemoryCandidate): boolean {
  return Boolean(
    candidate.correctionRequested || candidate.metadata?.["correctionRequested"] === true
  );
}

function decideCandidateStorage(
  candidate: MemoryCandidate,
  relationships?: (MemoryRelationshipSuggestion & { correctionRelated?: string[] }) | null
): {
  decision: "stored" | "rejected";
  reason: string;
} {
  const text = `${candidate.content} ${candidate.summary ?? ""} ${(candidate.tags ?? []).join(" ")}`;
  if (!candidate.content.trim()) {
    return { decision: "rejected", reason: "invalid-candidate" };
  }

  const extractionInput = {
    userMessage:
      typeof candidate.metadata?.["extractionUserMessage"] === "string"
        ? candidate.metadata["extractionUserMessage"]
        : "",
    assistantMessage:
      typeof candidate.metadata?.["extractionAssistantMessage"] === "string"
        ? candidate.metadata["extractionAssistantMessage"]
        : undefined
  };
  if (isAssistantOnlyRestatement(candidate, extractionInput)) {
    const claim =
      claimAttributionFromUnknown(candidate.claim) ?? deserializeClaimMetadata(candidate.metadata);
    if (claim?.provenanceClass !== "ASSISTANT_INFERENCE") {
      return { decision: "rejected", reason: "assistant-only-restatement" };
    }
  }

  const temporalConfidence = temporalResolutionConfidence(candidate.metadata);
  if (temporalConfidence !== null && temporalConfidence < 0.7) {
    return { decision: "rejected", reason: "low-confidence-temporal-resolution" };
  }

  const explicitRemember = hasExplicitRememberRequest(candidate);

  if (explicitRemember) {
    return { decision: "stored", reason: "explicit-user-memory-request" };
  }

  if (
    hasCorrectionRequest(candidate) &&
    hasCorrectionRelatedMemory(
      relationships
        ? {
            supersedes: relationships.supersedes,
            contradicts: relationships.contradicts,
            autoSupersedes: relationships.autoSupersedes,
            ...(relationships.correctionRelated
              ? { correctionRelated: relationships.correctionRelated }
              : {})
          }
        : null
    )
  ) {
    return { decision: "stored", reason: "user-correction" };
  }

  if (
    candidate.type === "episodic" &&
    candidate.subtype === "event" &&
    (isOrdinaryDailyEvent(text) || !isDurableTemporalText(text))
  ) {
    return { decision: "rejected", reason: "ordinary-one-off-daily-event" };
  }

  if (isDurableCandidate(candidate, text)) {
    return { decision: "stored", reason: "durable-memory-signal" };
  }

  if (candidate.importance >= 0.65) {
    return { decision: "stored", reason: "importance-threshold" };
  }

  return { decision: "rejected", reason: "below-durable-storage-threshold" };
}

function hasExplicitRememberRequest(candidate: MemoryCandidate): boolean {
  return Boolean(
    candidate.explicitRememberRequested ||
    candidate.metadata?.["explicitRememberRequested"] === true ||
    candidate.reason === "explicit-remember" ||
    candidate.metadata?.["explicitRemember"] === true
  );
}

function applyRelationshipSuggestions(
  candidate: MemoryCandidate,
  relationships: MemoryRelationshipSuggestion
): MemoryCandidate {
  if (
    relationships.supersedes.length === 0 &&
    relationships.contradicts.length === 0 &&
    relationships.relationshipConfidence <= 0
  ) {
    return candidate;
  }

  return {
    ...candidate,
    ...(relationships.supersedes.length > 0
      ? { possibleSupersedes: relationships.supersedes }
      : candidate.possibleSupersedes
        ? { possibleSupersedes: candidate.possibleSupersedes }
        : {}),
    ...(relationships.contradicts.length > 0
      ? { possibleContradictions: relationships.contradicts }
      : candidate.possibleContradictions
        ? { possibleContradictions: candidate.possibleContradictions }
        : {}),
    relationshipConfidence: relationships.relationshipConfidence,
    ...(relationships.relationshipReason
      ? { relationshipReason: relationships.relationshipReason }
      : {}),
    metadata: {
      ...(candidate.metadata ?? {}),
      relationshipConfidence: relationships.relationshipConfidence,
      ...(relationships.relationshipReason
        ? { relationshipReason: relationships.relationshipReason }
        : {}),
      relationshipMemoryPreviews: relationships.relationshipMemoryPreviews
    }
  };
}

function isDurableCandidate(candidate: MemoryCandidate, text: string): boolean {
  if (candidate.type === "semantic" && candidate.memoryLayer === "core") {
    return true;
  }
  if (
    candidate.subtype === "preference" ||
    candidate.subtype === "identity" ||
    candidate.subtype === "project" ||
    candidate.subtype === "project-fact" ||
    candidate.subtype === "provider-choice" ||
    candidate.subtype === "workflow" ||
    candidate.subtype === "command" ||
    candidate.subtype === "config" ||
    candidate.subtype === "config-decision" ||
    candidate.subtype === "troubleshooting" ||
    candidate.subtype === "milestone" ||
    candidate.subtype === "emotional-pattern" ||
    candidate.subtype === "health-note" ||
    candidate.subtype === "schedule"
  ) {
    return true;
  }
  return isDurableTemporalText(text);
}

function admitCandidateClaim(
  candidate: MemoryCandidate
):
  | { decision: "rejected"; candidate: MemoryCandidate; rejectedReason: string }
  | { decision: "continue"; candidate: MemoryCandidate } {
  const claimInput =
    claimAttributionFromUnknown(candidate.claim) ??
    claimAttributionFromUnknown(candidate.metadata?.["claim"]);
  if (!claimInput) {
    return { decision: "continue", candidate };
  }
  const rawText =
    claimInput.rawText ??
    (typeof candidate.metadata?.["rawText"] === "string"
      ? candidate.metadata["rawText"]
      : undefined);
  const admitted = admitDurableMemoryClaim({
    ...claimInput,
    content: claimInput.content ?? candidate.content,
    ...(rawText ? { rawText } : {})
  });
  if (admitted.decision === "reject") {
    return {
      decision: "rejected",
      candidate,
      rejectedReason: admitted.reason
    };
  }
  return {
    decision: "continue",
    candidate: {
      ...candidate,
      content: admitted.content,
      claim: admitted.claim,
      metadata: {
        ...(candidate.metadata ?? {}),
        ...serializeClaimMetadata(admitted.claim)
      }
    }
  };
}

function toValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function temporalResolutionConfidence(
  metadata: Record<string, unknown> | undefined
): number | null {
  const value = metadata?.["temporalResolution"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const confidence = (value as Record<string, unknown>)["confidence"];
  return typeof confidence === "number" ? confidence : null;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function assignDefinedIdentity(
  target: CreateMemoryInput,
  identity: {
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
    createdByUserId?: string | null | undefined;
    speakerId?: string | null | undefined;
    voiceProfileId?: string | null | undefined;
    sessionId?: string | null | undefined;
  }
): void {
  if (identity.personaId !== undefined) target.personaId = identity.personaId;
  if (identity.subjectUserId !== undefined) target.subjectUserId = identity.subjectUserId;
  if (identity.createdByUserId !== undefined) target.createdByUserId = identity.createdByUserId;
  if (identity.speakerId !== undefined) target.speakerId = identity.speakerId;
  if (identity.voiceProfileId !== undefined) target.voiceProfileId = identity.voiceProfileId;
  if (identity.sessionId !== undefined) target.sessionId = identity.sessionId;
}

function inferMemoryScope(
  candidate: MemoryCandidate
): "user" | "project" | "agent" | "plugin" | "session" {
  if (candidate.type === "working") {
    return "session";
  }
  const haystack =
    `${candidate.content} ${candidate.summary ?? ""} ${candidate.tags.join(" ")}`.toLowerCase();
  return haystack.includes("yuvi") || haystack.includes("runtime") ? "project" : "user";
}

function inferMemoryScopeId(candidate: MemoryCandidate): string | null {
  return inferMemoryScope(candidate) === "project" ? "yuvi-runtime" : null;
}

function inferMemoryLayer(
  type: MemoryType,
  subtype: MemorySubtype | null
): "core" | "recall" | "archival" | "working" {
  if (type === "working") {
    return "working";
  }
  if (
    type === "semantic" ||
    subtype === "preference" ||
    subtype === "identity" ||
    subtype === "project" ||
    subtype === "project-fact" ||
    subtype === "provider-choice"
  ) {
    return "core";
  }
  if (type === "episodic" || subtype === "milestone" || subtype === "troubleshooting") {
    return "recall";
  }
  return "recall";
}

function inferRuntimeMemoryType(text: string): MemoryType {
  const normalized = text.toLowerCase();
  if (/workflow|流程|步骤|command|命令|脚本|script/u.test(normalized)) {
    return "procedural";
  }
  if (/relationship|关系|称呼/u.test(normalized)) {
    return "relationship";
  }
  if (/prefer|preference|偏好|默认|provider|deepseek|xai|dashscope|使用/u.test(normalized)) {
    return "semantic";
  }
  return "episodic";
}

function inferMemorySubtype(text: string): MemorySubtype | null {
  const normalized = text.toLowerCase();
  if (
    /deepseek|xai|dashscope|provider|chat|reasoning|tts|stt|vision|供应商|模型/u.test(normalized)
  ) {
    return "provider-choice";
  }
  if (/repo|repository|仓库|github/u.test(normalized)) {
    return "repo";
  }
  if (/\/home\/|c:\\|\\\\wsl|路径|目录|workspace|工作区/u.test(normalized)) {
    return "path";
  }
  if (/workflow|流程|步骤/u.test(normalized)) {
    return "workflow";
  }
  if (/command|命令|pnpm|docker|script|脚本/u.test(normalized)) {
    return "command";
  }
  if (/完成|implemented|finished|milestone|里程碑|通过验证/u.test(normalized)) {
    return "milestone";
  }
  if (/prefer|preference|偏好|默认|喜欢/u.test(normalized)) {
    return "preference";
  }
  if (/my name is|call me|我叫|我的名字|叫我/u.test(normalized)) {
    return "identity";
  }
  if (/project|项目|yuvi|runtime/u.test(normalized)) {
    return "project-fact";
  }
  if (/emotion|情绪|感受/u.test(normalized)) {
    return "emotion";
  }
  if (/relationship|关系|称呼/u.test(normalized)) {
    return "relationship";
  }
  return null;
}

const stopWords = new Set([
  "the",
  "and",
  "you",
  "what",
  "know",
  "about",
  "with",
  "that",
  "this",
  "for"
]);

const cjkStopWords = new Set(["什么", "是什", "是什么", "的吗", "这个", "那个"]);

const quoteChars = new Set(['"', "'", "“", "”", "‘", "’"]);
