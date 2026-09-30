import type { JournalEventRef } from "@companion/protocol";
import {
  DEFAULT_MEMORY_INGESTION_MAX_DELIVERY_ATTEMPTS,
  executeFinalizedIngestionEvent
} from "./finalized-ingestion-executor.js";
import type {
  FinalizedIngestionAdmission,
  FinalizedIngestionAdmissionInput,
  FinalizedIngestionEvent,
  FinalizedIngestionEventOutcome,
  FinalizedIngestionRepository,
  FinalizedIngestionTurn,
  FinalizedIngestionWorkStats,
  MissingFinalizedConversationTurn
} from "./finalized-ingestion-ledger.js";
import type { MemoryProvider, MemoryReconciliationResult } from "./provider.js";

export type MemoryIngestionCoordinatorLogger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
};

export type MemoryIngestionRetryPolicy = {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
};

export const DEFAULT_MEMORY_INGESTION_RETRY_POLICY: MemoryIngestionRetryPolicy = {
  initialDelayMs: 5_000,
  maxDelayMs: 300_000,
  multiplier: 2
};

export {
  DEFAULT_MEMORY_INGESTION_MAX_DELIVERY_ATTEMPTS,
  MEMORY_WRITE_RETRY_EXHAUSTED
} from "./finalized-ingestion-executor.js";

export type MemoryIngestionFaultHooks = {
  afterClaim?: (event: FinalizedIngestionEvent) => Promise<void> | void;
  beforeDispatchMarker?: (event: FinalizedIngestionEvent) => Promise<void> | void;
  afterDispatchMarker?: (event: FinalizedIngestionEvent) => Promise<void> | void;
  afterBackendApplied?: (
    event: FinalizedIngestionEvent,
    outcome: FinalizedIngestionEventOutcome
  ) => Promise<void> | void;
  beforeLedgerOutcome?: (
    event: FinalizedIngestionEvent,
    outcome: FinalizedIngestionEventOutcome
  ) => Promise<void> | void;
  duringReconciliation?: (event: FinalizedIngestionEvent) => Promise<void> | void;
  duringShutdown?: () => Promise<void> | void;
};

export type MemoryIngestionCoordinatorPort = {
  notifyAdmitted(admission: FinalizedIngestionAdmission): Promise<void>;
  wake(): void;
};

export type MemoryIngestionCoordinatorStatus = "idle" | "running" | "stopping" | "stopped";

export type MemoryIngestionDiagnosticsAvailability = "ok" | "unavailable" | "error";

export const MEMORY_INGESTION_DIAGNOSTICS_UNAVAILABLE = "MEMORY_INGESTION_DIAGNOSTICS_UNAVAILABLE";

export type MemoryIngestionCoordinatorDiagnostics = {
  pendingCount: number | null;
  processingCount: number | null;
  retryableFailedCount: number | null;
  dueRetryCount: number | null;
  reconcileRequiredCount: number | null;
  completeCount: number | null;
  unchangedCount: number | null;
  skippedCount: number | null;
  terminalFailedCount: number | null;
  partialParentCount: number | null;
  staleLeaseCount: number | null;
  historicalUnknownCount: number | null;
  diagnosticsAvailability: MemoryIngestionDiagnosticsAvailability;
  diagnosticsErrorCode: string | null;
  diagnosticsError: string | null;
  activeWorkerCount: number | null;
  configuredConcurrency: number | null;
  lastScanAt: string | null;
  lastSuccessfulExecutionAt: string | null;
  lastError: string | null;
  status: MemoryIngestionCoordinatorStatus;
  ownerId: string;
};

export type MemoryIngestionCoordinatorRepository = Pick<
  FinalizedIngestionRepository,
  "claimEvent" | "markEventDispatchStarted" | "recordEventOutcome" | "reclaimExpiredEvent"
> & {
  getTurn?(finalizedTurnId: string): Promise<FinalizedIngestionTurn | null>;
  listEvents?(finalizedTurnId: string): Promise<FinalizedIngestionEvent[]>;
  listDueWork?(input?: {
    limit?: number;
    now?: string | undefined;
  }): Promise<FinalizedIngestionEvent[]>;
  getWorkStats?(input?: { now?: string | undefined }): Promise<FinalizedIngestionWorkStats>;
  claimReconcileEvent?(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    leaseSeconds: number;
    expectedVersion: number;
    now?: string | undefined;
  }): Promise<FinalizedIngestionEvent | null>;
  recordReconcileOutcome?(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    expectedVersion: number;
    result: MemoryReconciliationResult;
    nextAttemptAt?: string | null;
  }): Promise<FinalizedIngestionEvent>;
  listMissingAdmissions?(limit?: number): Promise<MissingFinalizedConversationTurn[]>;
  listHistoricalUnknownAdmissions?(limit?: number): Promise<MissingFinalizedConversationTurn[]>;
};

export type MemoryIngestionCoordinatorOptions = {
  repository: MemoryIngestionCoordinatorRepository;
  provider: MemoryProvider;
  admit?: (input: FinalizedIngestionAdmissionInput) => Promise<FinalizedIngestionAdmission>;
  conversation?: {
    getMessageById?(
      messageId: string
    ): Promise<{ role: string; content: string; sourceJournalRef?: JournalEventRef | null } | null>;
  };
  clock?: () => Date;
  logger?: MemoryIngestionCoordinatorLogger;
  retryPolicy?: Partial<MemoryIngestionRetryPolicy>;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  concurrency?: number;
  maxDeliveryAttempts?: number;
  ownerId?: string;
  scanLimit?: number;
  missingAdmissionEnabled?: boolean;
  missingAdmissionAfter?: string;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  hooks?: MemoryIngestionFaultHooks;
};

const EMPTY_STATS: FinalizedIngestionWorkStats = {
  pendingCount: 0,
  processingCount: 0,
  retryableFailedCount: 0,
  dueRetryCount: 0,
  reconcileRequiredCount: 0,
  completeCount: 0,
  unchangedCount: 0,
  skippedCount: 0,
  terminalFailedCount: 0,
  partialParentCount: 0,
  staleLeaseCount: 0,
  historicalUnknownCount: 0
};

const UNKNOWN_STATS: {
  [K in keyof FinalizedIngestionWorkStats]: null;
} = {
  pendingCount: null,
  processingCount: null,
  retryableFailedCount: null,
  dueRetryCount: null,
  reconcileRequiredCount: null,
  completeCount: null,
  unchangedCount: null,
  skippedCount: null,
  terminalFailedCount: null,
  partialParentCount: null,
  staleLeaseCount: null,
  historicalUnknownCount: null
};

const TERMINAL_EVENT_STATUSES = new Set(["complete", "unchanged", "skipped", "terminal_failed"]);

export class MemoryIngestionCoordinator implements MemoryIngestionCoordinatorPort {
  private readonly repository: MemoryIngestionCoordinatorRepository;
  private provider: MemoryProvider;
  private readonly admit:
    | ((input: FinalizedIngestionAdmissionInput) => Promise<FinalizedIngestionAdmission>)
    | undefined;
  private readonly conversation:
    | {
        getMessageById?(
          messageId: string
        ): Promise<{
          role: string;
          content: string;
          sourceJournalRef?: JournalEventRef | null;
        } | null>;
      }
    | undefined;
  private readonly clock: () => Date;
  private readonly logger: MemoryIngestionCoordinatorLogger | undefined;
  private readonly retryPolicy: MemoryIngestionRetryPolicy;
  private readonly pollIntervalMs: number;
  private readonly leaseSeconds: number;
  private readonly concurrency: number;
  private readonly maxDeliveryAttempts: number;
  private readonly ownerId: string;
  private readonly scanLimit: number;
  private readonly missingAdmissionEnabled: boolean;
  private readonly missingAdmissionAfter: string | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly hooks: MemoryIngestionFaultHooks;
  private readonly wakeWaiters = new Set<() => void>();
  private readonly inFlight = new Set<Promise<void>>();

  private status: MemoryIngestionCoordinatorStatus = "idle";
  private acceptingWork = false;
  private loop: Promise<void> | undefined;
  private drainPromise: Promise<void> | undefined;
  private scanLock: Promise<void> = Promise.resolve();
  private scanRequested = false;
  private activeWorkerCount = 0;
  private lastScanAt: string | null = null;
  private lastSuccessfulExecutionAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: MemoryIngestionCoordinatorOptions) {
    this.repository = options.repository;
    this.provider = options.provider;
    this.admit = options.admit;
    this.conversation = options.conversation;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger;
    this.retryPolicy = {
      ...DEFAULT_MEMORY_INGESTION_RETRY_POLICY,
      ...options.retryPolicy
    };
    this.pollIntervalMs = Math.max(1, Math.trunc(options.pollIntervalMs ?? 15_000));
    this.leaseSeconds = Math.max(1, Math.trunc(options.leaseSeconds ?? 300));
    this.concurrency = Math.max(1, Math.trunc(options.concurrency ?? 4));
    this.maxDeliveryAttempts = Math.max(
      1,
      Math.trunc(options.maxDeliveryAttempts ?? DEFAULT_MEMORY_INGESTION_MAX_DELIVERY_ATTEMPTS)
    );
    this.ownerId = options.ownerId ?? `yuvi-coordinator:${crypto.randomUUID()}`;
    this.scanLimit = Math.max(1, Math.trunc(options.scanLimit ?? 50));
    this.missingAdmissionEnabled = options.missingAdmissionEnabled ?? Boolean(options.admit);
    this.missingAdmissionAfter = options.missingAdmissionAfter;
    this.signal = options.signal;
    this.sleep = options.sleep ?? defaultSleep;
    this.hooks = options.hooks ?? {};
    this.signal?.addEventListener(
      "abort",
      () => {
        void this.shutdown();
      },
      { once: true }
    );
  }

  replaceProvider(provider: MemoryProvider): void {
    this.provider = provider;
  }

  getStatus(): MemoryIngestionCoordinatorStatus {
    return this.status;
  }

  getOwnerId(): string {
    return this.ownerId;
  }

  /**
   * Begin the background recovery loop. Returns immediately; backlog drain is
   * asynchronous and must not gate application readiness.
   */
  start(): void {
    if (this.loop || this.status === "running") {
      return;
    }
    this.acceptingWork = true;
    this.status = "running";
    this.scanRequested = true;
    this.loop = this.runLoop().finally(() => {
      this.loop = undefined;
      if (this.status !== "stopped") {
        this.status = this.acceptingWork ? "idle" : "stopped";
      }
    });
  }

  wake(): void {
    this.scanRequested = true;
    for (const resolve of this.wakeWaiters) {
      resolve();
    }
    this.wakeWaiters.clear();
  }

  /**
   * Wake the single scheduler. Does not execute a separate delivery batch.
   * Durable admission remains the correctness boundary if this signal is lost.
   */
  async notifyAdmitted(_admission: FinalizedIngestionAdmission): Promise<void> {
    this.wake();
  }

  getConfiguredConcurrency(): number {
    return this.concurrency;
  }

  getActiveWorkerCount(): number {
    return this.activeWorkerCount;
  }

  async drain(timeoutMs = 10_000): Promise<void> {
    const running = this.drainPromise;
    if (running) {
      await running;
      return;
    }
    const drain = this.runDrain(timeoutMs);
    this.drainPromise = drain;
    try {
      await drain;
    } finally {
      if (this.drainPromise === drain) {
        this.drainPromise = undefined;
      }
    }
  }

  private async runDrain(timeoutMs: number): Promise<void> {
    if (this.isStoppingOrStopped()) {
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.runScheduledScan();
      await this.waitForInFlight();
      if (this.isStoppingOrStopped()) {
        return;
      }
      const due = await this.listDueWork(1);
      if (this.activeWorkerCount === 0 && due.length === 0 && this.inFlight.size === 0) {
        return;
      }
      await this.sleep(5);
    }
  }

  async shutdown(input: { graceMs?: number } = {}): Promise<void> {
    this.acceptingWork = false;
    this.status = "stopping";
    this.wake();
    await this.hooks.duringShutdown?.();
    const graceMs = Math.max(0, Math.trunc(input.graceMs ?? 2_000));
    await Promise.race([this.waitForInFlight(), this.sleep(graceMs)]);
    this.status = "stopped";
    this.wake();
    if (this.loop) {
      await Promise.race([this.loop, this.sleep(graceMs)]);
    }
  }

  async getDiagnostics(): Promise<MemoryIngestionCoordinatorDiagnostics> {
    let stats: FinalizedIngestionWorkStats | undefined;
    let diagnosticsError: string | null = null;
    try {
      stats = this.repository.getWorkStats
        ? await this.repository.getWorkStats({ now: this.clock().toISOString() })
        : EMPTY_STATS;
    } catch (error) {
      this.recordError(error, "memory ingestion coordinator diagnostics failed");
      diagnosticsError = sanitizeErrorMessage(error);
    }
    return {
      ...(stats ?? UNKNOWN_STATS),
      diagnosticsAvailability: stats ? "ok" : "error",
      diagnosticsErrorCode: stats ? null : MEMORY_INGESTION_DIAGNOSTICS_UNAVAILABLE,
      diagnosticsError,
      activeWorkerCount: this.activeWorkerCount,
      configuredConcurrency: this.concurrency,
      lastScanAt: this.lastScanAt,
      lastSuccessfulExecutionAt: this.lastSuccessfulExecutionAt,
      lastError: this.lastError,
      status: this.status,
      ownerId: this.ownerId
    };
  }

  private async runLoop(): Promise<void> {
    while (this.acceptingWork && !this.signal?.aborted) {
      try {
        await this.runScheduledScan();
      } catch (error) {
        this.recordError(error, "memory ingestion coordinator scan failed");
      }
      if (!this.acceptingWork || this.signal?.aborted) {
        break;
      }
      if (this.scanRequested) {
        continue;
      }
      await this.waitForWakeOrPoll();
    }
  }

  /**
   * Serialize all scans for this instance so wake, poll, drain, and startup
   * share one scheduler budget. Wakes that arrive mid-scan coalesce into one
   * follow-up pass.
   */
  private async runScheduledScan(): Promise<void> {
    const previous = this.scanLock;
    let release!: () => void;
    this.scanLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      do {
        this.scanRequested = false;
        await this.scan();
      } while (this.scanRequested && this.canSchedule());
    } finally {
      release();
    }
  }

  private async scan(): Promise<void> {
    this.lastScanAt = this.clock().toISOString();
    if (this.missingAdmissionEnabled) {
      await this.admitMissingWork();
    }
    const due = await this.listDueWork(this.scanLimit);
    await this.processEvents(due);
  }

  private async processEvents(events: FinalizedIngestionEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    let next = 0;
    const workerCount = Math.min(this.availableSlots(), events.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (this.canClaim()) {
        const index = next;
        next += 1;
        const event = events[index];
        if (!event) {
          return;
        }
        await this.runIsolated(event);
      }
    });
    await Promise.all(workers);
  }

  private async runIsolated(event: FinalizedIngestionEvent): Promise<void> {
    const work = (async () => {
      this.activeWorkerCount += 1;
      try {
        await this.processEvent(event);
      } catch (error) {
        this.recordError(error, "memory ingestion coordinator event failed", {
          eventId: event.eventId,
          finalizedTurnId: event.finalizedTurnId,
          status: event.status
        });
      } finally {
        this.activeWorkerCount = Math.max(0, this.activeWorkerCount - 1);
      }
    })();
    this.inFlight.add(work);
    try {
      await work;
    } finally {
      this.inFlight.delete(work);
    }
  }

  private async processEvent(event: FinalizedIngestionEvent): Promise<void> {
    if (TERMINAL_EVENT_STATUSES.has(event.status)) {
      return;
    }
    const now = this.clock();
    if (event.status === "processing") {
      if (hasValidLease(event, now)) {
        return;
      }
      if (!this.canClaim()) {
        return;
      }
      const reclaimed = await this.repository.reclaimExpiredEvent({
        finalizedTurnId: event.finalizedTurnId,
        eventId: event.eventId,
        expectedVersion: event.version,
        now: now.toISOString()
      });
      if (!reclaimed) {
        return;
      }
      if (reclaimed.status === "pending") {
        await this.deliver(reclaimed);
        return;
      }
      if (reclaimed.status === "reconcile_required") {
        await this.reconcile(reclaimed);
      }
      return;
    }
    if (event.status === "reconcile_required") {
      if (hasValidLease(event, now)) {
        return;
      }
      await this.reconcile(event);
      return;
    }
    if (event.status === "retryable_failed") {
      if (event.nextAttemptAt && new Date(event.nextAttemptAt).getTime() > now.getTime()) {
        return;
      }
      await this.deliver(event);
      return;
    }
    if (event.status === "pending") {
      await this.deliver(event);
    }
  }

  private async deliver(event: FinalizedIngestionEvent): Promise<void> {
    if (!this.canClaim()) {
      return;
    }
    const result = await executeFinalizedIngestionEvent({
      repository: this.executionRepository(),
      provider: this.executionProvider(),
      event,
      leaseOwner: this.ownerId,
      leaseSeconds: this.leaseSeconds,
      maxDeliveryAttempts: this.maxDeliveryAttempts
    });
    if (result.claimed && result.event) {
      this.lastSuccessfulExecutionAt = this.clock().toISOString();
      this.lastError = result.event.errorCode
        ? `${result.event.errorCode}${result.event.errorMessage ? `: ${result.event.errorMessage}` : ""}`
        : this.lastError;
    }
  }

  private async reconcile(event: FinalizedIngestionEvent): Promise<void> {
    if (!this.canClaim()) {
      return;
    }
    if (!this.repository.claimReconcileEvent || !this.repository.recordReconcileOutcome) {
      this.logger?.warn?.(
        "exact reconciliation primitives are unavailable; leaving event unresolved",
        {
          eventId: event.eventId,
          finalizedTurnId: event.finalizedTurnId
        }
      );
      return;
    }
    const claimed = await this.repository.claimReconcileEvent({
      finalizedTurnId: event.finalizedTurnId,
      eventId: event.eventId,
      leaseOwner: this.ownerId,
      leaseSeconds: this.leaseSeconds,
      expectedVersion: event.version,
      now: this.clock().toISOString()
    });
    if (!claimed) {
      return;
    }
    await this.hooks.duringReconciliation?.(claimed);
    const payloadDigest = claimed.eventPayload.payloadDigest?.trim();
    let result: MemoryReconciliationResult;
    if (!payloadDigest) {
      result = { status: "unknown", errorCode: "MEMORY_PAYLOAD_DIGEST_MISSING" };
    } else if (!this.provider.reconcileEvent) {
      result = { status: "unknown", errorCode: "MEMORY_RECONCILIATION_UNSUPPORTED" };
    } else {
      try {
        result = await this.provider.reconcileEvent({
          idempotencyKey: claimed.backendIdempotencyKey,
          payloadDigest
        });
      } catch (error) {
        result = {
          status: "unknown",
          errorCode: "MEMORY_RECONCILIATION_UNAVAILABLE",
          operation: undefined
        };
        this.recordError(error, "exact reconciliation probe failed", {
          eventId: claimed.eventId,
          finalizedTurnId: claimed.finalizedTurnId
        });
      }
    }
    if (result.status === "not_applied" && !this.canClaim()) {
      result = { status: "unknown", errorCode: "MEMORY_RECONCILE_SHUTDOWN" };
    }
    const recorded = await this.repository.recordReconcileOutcome({
      finalizedTurnId: claimed.finalizedTurnId,
      eventId: claimed.eventId,
      leaseOwner: this.ownerId,
      expectedVersion: claimed.version,
      result,
      nextAttemptAt:
        result.status === "in_flight" || result.status === "unknown"
          ? new Date(this.clock().getTime() + this.retryPolicy.initialDelayMs).toISOString()
          : null
    });
    this.lastSuccessfulExecutionAt = this.clock().toISOString();
    if (recorded.status === "pending" && this.canClaim()) {
      await this.deliver(recorded);
    }
  }

  private async admitMissingWork(): Promise<void> {
    if (!this.admit || !this.repository.listMissingAdmissions || !this.canClaim()) {
      return;
    }
    const missing = await this.repository.listMissingAdmissions(this.scanLimit);
    for (const row of missing) {
      if (!this.canClaim()) {
        return;
      }
      try {
        await this.admitMissingRow(row);
      } catch (error) {
        this.recordError(error, "missing finalized admission failed", {
          finalizedTurnId: row.finalizedTurnId,
          assistantMessageId: row.assistantMessageId
        });
      }
    }
  }

  private async admitMissingRow(row: MissingFinalizedConversationTurn): Promise<void> {
    if (row.ingestionRequested !== true) {
      return;
    }
    if (
      this.missingAdmissionAfter &&
      new Date(row.finalizedAt).getTime() < new Date(this.missingAdmissionAfter).getTime()
    ) {
      return;
    }
    if (!row.personaId?.trim() || !row.subjectUserId?.trim() || !row.finalizedTurnId?.trim()) {
      return;
    }
    const userMessage = await this.resolveUserMessage(row);
    if (userMessage === null) {
      this.logger?.warn?.("skipping missing admission without recoverable user message", {
        finalizedTurnId: row.finalizedTurnId
      });
      return;
    }
    await this.admit!({
      finalizedTurnId: row.finalizedTurnId,
      assistantMessageId: row.assistantMessageId,
      sourceUserEventId: row.sourceUserEventId,
      conversationId: row.conversationId,
      traceId: row.traceId,
      personaId: row.personaId,
      subjectUserId: row.subjectUserId,
      finalizedAt: row.finalizedAt,
      ingestionRequested: true,
      userMessage: userMessage.content,
      sourceText: userMessage.content,
      sourceJournalRef: userMessage.sourceJournalRef,
      assistantMessage: row.content,
      sessionId: row.conversationId
    });
  }

  private async resolveUserMessage(
    row: MissingFinalizedConversationTurn
  ): Promise<{ content: string; sourceJournalRef?: JournalEventRef | null } | null> {
    if (!row.sourceUserEventId || !this.conversation?.getMessageById) {
      return null;
    }
    const user = await this.conversation.getMessageById(row.sourceUserEventId);
    if (!user || user.role !== "user") {
      return null;
    }
    return user.content.trim() ? user : null;
  }

  private async listDueWork(limit: number): Promise<FinalizedIngestionEvent[]> {
    if (!this.repository.listDueWork) {
      return [];
    }
    return this.repository.listDueWork({
      limit,
      now: this.clock().toISOString()
    });
  }

  private executionRepository(): Pick<
    FinalizedIngestionRepository,
    "claimEvent" | "markEventDispatchStarted" | "recordEventOutcome"
  > {
    return {
      claimEvent: async (input) => {
        if (!this.canClaim()) {
          return null;
        }
        const claimed = await this.repository.claimEvent(input);
        if (claimed) {
          await this.hooks.afterClaim?.(claimed);
        }
        return claimed;
      },
      markEventDispatchStarted: async (input) => {
        const current = await this.lookupEvent(input.finalizedTurnId, input.eventId);
        if (current) {
          await this.hooks.beforeDispatchMarker?.(current);
        }
        const marked = await this.repository.markEventDispatchStarted(input);
        if (marked) {
          await this.hooks.afterDispatchMarker?.(marked);
        }
        return marked;
      },
      recordEventOutcome: async (input) => {
        const current = await this.lookupEvent(input.finalizedTurnId, input.eventId);
        const outcome = this.applyRetryPolicy(input.outcome, current?.attemptCount ?? 1);
        if (current) {
          await this.hooks.afterBackendApplied?.(current, outcome);
          await this.hooks.beforeLedgerOutcome?.(current, outcome);
        }
        return this.repository.recordEventOutcome({ ...input, outcome });
      }
    };
  }

  private executionProvider(): MemoryProvider {
    const writeEventIdempotent = this.provider.writeEventIdempotent
      ? async (input: Parameters<NonNullable<MemoryProvider["writeEventIdempotent"]>>[0]) => {
          const outcome = await this.provider.writeEventIdempotent!(input);
          return outcome;
        }
      : undefined;
    return {
      ...this.provider,
      ...(writeEventIdempotent ? { writeEventIdempotent } : {})
    };
  }

  private applyRetryPolicy(
    outcome: FinalizedIngestionEventOutcome,
    attemptCount: number
  ): FinalizedIngestionEventOutcome {
    const retryable =
      outcome.status === "retryable_failed" ||
      (outcome.status === "rejected" && outcome.failureClass === "retryable_no_effect");
    if (!retryable) {
      return outcome;
    }
    if ("nextAttemptAt" in outcome && outcome.nextAttemptAt) {
      return outcome;
    }
    const exponent = Math.max(0, attemptCount - 1);
    const delay = Math.min(
      this.retryPolicy.maxDelayMs,
      this.retryPolicy.initialDelayMs * this.retryPolicy.multiplier ** exponent
    );
    const nextAttemptAt = new Date(this.clock().getTime() + delay).toISOString();
    if (outcome.status === "retryable_failed") {
      return { ...outcome, nextAttemptAt };
    }
    return {
      status: "retryable_failed",
      errorCode: outcome.errorCode ?? "MEMORY_WRITE_RETRYABLE_FAILED",
      nextAttemptAt
    };
  }

  private async lookupEvent(
    finalizedTurnId: string,
    eventId: string
  ): Promise<FinalizedIngestionEvent | undefined> {
    if (!this.repository.listEvents) {
      return undefined;
    }
    const events = await this.repository.listEvents(finalizedTurnId);
    return events.find((event) => event.eventId === eventId);
  }

  private canClaim(): boolean {
    return this.canSchedule();
  }

  private isStoppingOrStopped(): boolean {
    return this.status === "stopping" || this.status === "stopped";
  }

  private canSchedule(): boolean {
    return this.acceptingWork || this.status === "idle";
  }

  private availableSlots(): number {
    return Math.max(0, this.concurrency - this.activeWorkerCount);
  }

  private async waitForWakeOrPoll(): Promise<void> {
    if (!this.acceptingWork || this.signal?.aborted || this.scanRequested) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeWaiters.delete(onWake);
        resolve();
      }, this.pollIntervalMs);
      timer.unref?.();
      const onWake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.wakeWaiters.add(onWake);
    });
  }

  private async waitForInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight));
    }
  }

  private recordError(
    error: unknown,
    message: string,
    context: Record<string, unknown> = {}
  ): void {
    this.lastError = sanitizeErrorMessage(error);
    this.logger?.error?.(message, { ...context, error: this.lastError });
  }
}

function hasValidLease(event: FinalizedIngestionEvent, now: Date): boolean {
  return Boolean(
    event.leaseOwner &&
    event.leaseExpiresAt &&
    new Date(event.leaseExpiresAt).getTime() > now.getTime()
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(DATABASE_URL|API_KEY|TOKEN|SECRET|PASSWORD)=([^\s]+)/giu, "$1=[REDACTED]")
    .slice(0, 300);
}
