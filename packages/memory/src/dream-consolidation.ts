import type { Pool } from "pg";
import { createPostgresPool } from "@companion/database";
import type { QueryResultRow } from "pg";
import { MemoryIngestionPolicy } from "./ingestion.js";
import {
  deliverDreamEventsIdempotent,
  isAmbiguousWriteOutcome,
  isSuccessfulWriteOutcome,
  reconcileDreamEvent,
  stampDreamWriteEvent
} from "./dream-delivery.js";
import { DEFAULT_MEMORY_HIERARCHY_BUDGETS, type MemoryHierarchyBudgets } from "./hierarchy.js";
import { jaccardSimilarity, sha256Hex, tokenizeMemoryText } from "./memory-vnext-text.js";
import type { MemoryProvider, MemoryWriteEventInput, MemoryWriteEventOutcome } from "./provider.js";
import { sourceTurnIdsOverlap, type RecentEpisode } from "./recent-episode.js";
import type { RecentEpisodeStore } from "./recent-episode-store.js";

export const DREAM_CONSOLIDATION_VERSION = "memory-vnext-dream.v1" as const;
export const DEFAULT_DREAM_LEASE_MS = 30_000;

export const DreamTriggerKinds = [
  "recurrence",
  "salience",
  "explicit",
  "idle",
  "scheduled"
] as const;
export type DreamTriggerKind = (typeof DreamTriggerKinds)[number];

export const DreamJobStatuses = [
  "pending",
  "processing",
  "complete",
  "skipped",
  "terminal_failed",
  "reconcile_required"
] as const;
export type DreamJobStatus = (typeof DreamJobStatuses)[number];

export type DreamJob = {
  jobId: string;
  triggerKind: DreamTriggerKind;
  status: DreamJobStatus;
  memoryScope: string | null;
  personaId: string | null;
  subjectUserId: string | null;
  sourceEpisodeIds: string[];
  sourceDigest: string;
  payload: Record<string, unknown>;
  resultEventPayloads: MemoryWriteEventInput[] | null;
  resultSummary: string | null;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DreamWriter = (events: MemoryWriteEventInput[]) => Promise<MemoryWriteEventOutcome[]>;

export interface DreamJobStore {
  upsertPending(job: DreamJob): Promise<DreamJob>;
  getByDigest(sourceDigest: string): Promise<DreamJob | null>;
  getById(jobId: string): Promise<DreamJob | null>;
  listDue(now: Date, limit: number): Promise<DreamJob[]>;
  claimDue(input: {
    now: Date;
    leaseOwner: string;
    leaseMs: number;
    limit: number;
  }): Promise<DreamJob[]>;
  claimJob(input: {
    jobId: string;
    now: Date;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<DreamJob | null>;
  save(job: DreamJob): Promise<DreamJob>;
}

export class InMemoryDreamJobStore implements DreamJobStore {
  private readonly jobs = new Map<string, DreamJob>();
  private readonly digestIndex = new Map<string, string>();
  private claimChain: Promise<unknown> = Promise.resolve();

  async upsertPending(job: DreamJob): Promise<DreamJob> {
    const existingId = this.digestIndex.get(job.sourceDigest);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (
        existing &&
        (existing.status === "complete" ||
          existing.status === "processing" ||
          existing.status === "pending")
      ) {
        return cloneJob(existing);
      }
    }
    const stored = cloneJob(job);
    this.jobs.set(stored.jobId, stored);
    this.digestIndex.set(stored.sourceDigest, stored.jobId);
    return cloneJob(stored);
  }

  async getByDigest(sourceDigest: string): Promise<DreamJob | null> {
    const id = this.digestIndex.get(sourceDigest);
    const job = id ? this.jobs.get(id) : undefined;
    return job ? cloneJob(job) : null;
  }

  async getById(jobId: string): Promise<DreamJob | null> {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : null;
  }

  async listDue(now: Date, limit: number): Promise<DreamJob[]> {
    const nowMs = now.getTime();
    return [...this.jobs.values()]
      .filter((job) => isDue(job, nowMs))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map(cloneJob);
  }

  async claimDue(input: {
    now: Date;
    leaseOwner: string;
    leaseMs: number;
    limit: number;
  }): Promise<DreamJob[]> {
    const run = this.claimChain.then(() => this.claimDueLocked(input));
    this.claimChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private claimDueLocked(input: {
    now: Date;
    leaseOwner: string;
    leaseMs: number;
    limit: number;
  }): DreamJob[] {
    const nowMs = input.now.getTime();
    const due = [...this.jobs.values()]
      .filter((job) => isDue(job, nowMs))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, input.limit);
    const claimed: DreamJob[] = [];
    for (const job of due) {
      const next: DreamJob = {
        ...job,
        status: "processing",
        attemptCount: job.attemptCount + 1,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: new Date(nowMs + input.leaseMs).toISOString(),
        updatedAt: input.now.toISOString()
      };
      this.jobs.set(next.jobId, next);
      this.digestIndex.set(next.sourceDigest, next.jobId);
      claimed.push(cloneJob(next));
    }
    return claimed;
  }

  async claimJob(input: {
    jobId: string;
    now: Date;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<DreamJob | null> {
    const run = this.claimChain.then(() => {
      const job = this.jobs.get(input.jobId);
      if (!job || !isDue(job, input.now.getTime())) return null;
      const next: DreamJob = {
        ...job,
        status: "processing",
        attemptCount: job.attemptCount + 1,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs).toISOString(),
        updatedAt: input.now.toISOString()
      };
      this.jobs.set(next.jobId, next);
      this.digestIndex.set(next.sourceDigest, next.jobId);
      return cloneJob(next);
    });
    this.claimChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async save(job: DreamJob): Promise<DreamJob> {
    const stored = cloneJob(job);
    this.jobs.set(stored.jobId, stored);
    this.digestIndex.set(stored.sourceDigest, stored.jobId);
    return cloneJob(stored);
  }
}

export type DreamConsiderInput = {
  episode: RecentEpisode;
  existing: readonly RecentEpisode[];
  now: Date;
  idleMs?: number | undefined;
  explicitImportance?: boolean | undefined;
};

export type DreamConsiderResult = {
  triggered: boolean;
  triggerKind?: DreamTriggerKind;
  job?: DreamJob;
  skippedReason?: string;
};

export class DreamConsolidationEngine {
  constructor(
    private readonly jobs: DreamJobStore,
    private readonly episodes: RecentEpisodeStore,
    private readonly options: {
      budgets?: Partial<MemoryHierarchyBudgets> | undefined;
      writer?: DreamWriter | undefined;
      provider?: Pick<MemoryProvider, "writeEventIdempotent" | "reconcileEvent"> | undefined;
      ingestion?: MemoryIngestionPolicy | undefined;
      leaseMs?: number | undefined;
      idleMs?: number | undefined;
    } = {}
  ) {}

  async consider(input: DreamConsiderInput): Promise<DreamConsiderResult> {
    if (input.episode.userStatements.length === 0) {
      return { triggered: false, skippedReason: "no-user-statements" };
    }

    const budgets = { ...DEFAULT_MEMORY_HIERARCHY_BUDGETS, ...this.options.budgets };
    const cluster = findRecurrenceCluster(input.episode, input.existing, budgets);
    const explicit = input.explicitImportance === true || hasExplicitImportance(input.episode);
    const idle = (input.idleMs ?? 0) >= (this.options.idleMs ?? 30 * 60 * 1000);
    let triggerKind: DreamTriggerKind | undefined;
    let members = [input.episode];

    if (cluster.length >= budgets.recurrenceMinCount) {
      triggerKind = "recurrence";
      members = cluster;
    } else if (explicit) {
      triggerKind = hasExplicitRemember(input.episode) ? "explicit" : "salience";
    } else if (idle) {
      triggerKind = "idle";
    }

    if (!triggerKind) {
      return { triggered: false, skippedReason: "no-trigger" };
    }

    const sourceEpisodeIds = [...new Set(members.map((item) => item.id))].sort();
    const sourceDigest = sha256Hex(
      members
        .map((item) => item.sourceDigest)
        .sort()
        .join("|")
    );
    const existing = await this.jobs.getByDigest(sourceDigest);
    if (existing?.status === "complete") {
      return { triggered: false, job: existing, skippedReason: "already-complete" };
    }
    if (existing?.status === "pending" || existing?.status === "processing") {
      return { triggered: false, job: existing, skippedReason: "already-queued" };
    }
    if (existing?.status === "skipped" && existing.lastErrorCode === "MEMORY_WRITER_UNAVAILABLE") {
      return { triggered: false, job: existing, skippedReason: "writer-unavailable" };
    }
    if (existing?.status === "reconcile_required") {
      return { triggered: false, job: existing, skippedReason: "reconcile-required" };
    }

    const nowIso = input.now.toISOString();
    const job = await this.jobs.upsertPending({
      jobId: `dream:${sourceDigest.slice(0, 16)}`,
      triggerKind,
      status: "pending",
      memoryScope: input.episode.memoryScope,
      personaId: input.episode.personaId,
      subjectUserId: input.episode.subjectUserId,
      sourceEpisodeIds,
      sourceDigest,
      payload: {
        version: DREAM_CONSOLIDATION_VERSION,
        userOnly: true,
        assistantNonAuthoritative: true,
        recurrenceDoesNotUpgradeConfidence: true
      },
      resultEventPayloads: null,
      resultSummary: null,
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null
    });
    return { triggered: true, triggerKind, job };
  }

  async runDue(now: Date, leaseOwner: string, limit = 4): Promise<DreamJob[]> {
    const leaseMs = this.options.leaseMs ?? DEFAULT_DREAM_LEASE_MS;
    const claimed = await this.jobs.claimDue({ now, leaseOwner, leaseMs, limit });
    const completed: DreamJob[] = [];
    for (const job of claimed) {
      completed.push(await this.executeClaimedJob(job, now));
    }
    return completed;
  }

  async runJob(job: DreamJob, now: Date, leaseOwner: string): Promise<DreamJob> {
    if (job.status === "complete" || job.status === "skipped") return job;
    if (job.status === "reconcile_required") return job;
    const leaseMs = this.options.leaseMs ?? DEFAULT_DREAM_LEASE_MS;
    const claimed = await this.jobs.claimJob({
      jobId: job.jobId,
      now,
      leaseOwner,
      leaseMs
    });
    if (!claimed) {
      return (await this.jobs.getById(job.jobId)) ?? job;
    }
    return this.executeClaimedJob(claimed, now);
  }

  async reconcileJob(job: DreamJob, now: Date, leaseOwner: string): Promise<DreamJob> {
    if (job.status !== "reconcile_required") return job;
    const provider = this.options.provider;
    if (!provider?.reconcileEvent) return job;
    const events = job.resultEventPayloads ?? [];
    let needsRetry = false;
    let stillAmbiguous = false;
    for (const event of events) {
      const result = await reconcileDreamEvent(provider, event);
      if (result.status === "applied") continue;
      if (result.status === "not_applied") {
        needsRetry = true;
        continue;
      }
      stillAmbiguous = true;
    }
    if (stillAmbiguous) return job;
    if (needsRetry && provider.writeEventIdempotent) {
      const retried = await deliverDreamEventsIdempotent(provider, events);
      if (retried.some(isAmbiguousWriteOutcome)) return job;
      if (!retried.every(isSuccessfulWriteOutcome)) return job;
    } else if (needsRetry) {
      return job;
    }
    const episodes = await this.loadEpisodes(job.sourceEpisodeIds);
    for (const episode of episodes) {
      await this.episodes.markStatus(episode.id, "consolidated", {
        consolidatedAt: now.toISOString(),
        consolidationJobId: job.jobId
      });
    }
    return this.jobs.save({
      ...job,
      status: "complete",
      resultSummary: "Reconciled: original effect was applied or safely retried after not_applied.",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      completedAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
  }

  private async executeClaimedJob(claimed: DreamJob, now: Date): Promise<DreamJob> {
    try {
      const episodes = await this.loadEpisodes(claimed.sourceEpisodeIds);
      const events = await this.extractUserGroundedEvents(episodes, claimed);
      if (events.length === 0) {
        return this.jobs.save({
          ...claimed,
          status: "skipped",
          resultEventPayloads: [],
          resultSummary: "No user-grounded long-term evidence extracted.",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now.toISOString(),
          updatedAt: now.toISOString()
        });
      }

      if ((claimed.resultEventPayloads?.length ?? 0) > 0) {
        return this.jobs.save({
          ...claimed,
          status: "reconcile_required",
          resultSummary: "Reclaimed after a previous dispatch; automatic rewrite is forbidden.",
          lastErrorCode: "AMBIGUOUS_WRITE",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now.toISOString()
        });
      }

      const stamped = events.map((event) => stampDreamWriteEvent(claimed.jobId, event));
      if (!this.hasDeliveryAuthority()) {
        return this.jobs.save({
          ...claimed,
          status: "skipped",
          resultEventPayloads: stamped,
          resultSummary: "No durable Memory delivery authority is available.",
          lastErrorCode: "MEMORY_WRITER_UNAVAILABLE",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now.toISOString(),
          updatedAt: now.toISOString()
        });
      }

      await this.jobs.save({
        ...claimed,
        resultEventPayloads: stamped,
        updatedAt: now.toISOString()
      });
      const outcomes = await this.deliver(stamped);
      if (outcomes.some(isAmbiguousWriteOutcome)) {
        return this.jobs.save({
          ...claimed,
          status: "reconcile_required",
          resultEventPayloads: stamped,
          resultSummary: "Ambiguous external effect; automatic rewrite is forbidden.",
          lastErrorCode: "AMBIGUOUS_WRITE",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now.toISOString()
        });
      }
      if (!outcomes.every(isSuccessfulWriteOutcome)) {
        return this.jobs.save({
          ...claimed,
          status: "terminal_failed",
          resultEventPayloads: stamped,
          resultSummary: "Durable delivery rejected one or more events.",
          lastErrorCode:
            outcomes.find((outcome) => !isSuccessfulWriteOutcome(outcome))?.errorCode ??
            "MEMORY_WRITE_REJECTED",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now.toISOString()
        });
      }

      for (const episode of episodes) {
        await this.episodes.markStatus(episode.id, "consolidated", {
          consolidatedAt: now.toISOString(),
          consolidationJobId: claimed.jobId
        });
      }

      return this.jobs.save({
        ...claimed,
        status: "complete",
        resultEventPayloads: stamped,
        resultSummary: `Consolidated ${stamped.length} user-grounded event(s) from ${episodes.length} episode(s).`,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
    } catch (error) {
      return this.jobs.save({
        ...claimed,
        status: "terminal_failed",
        lastErrorCode: "DREAM_EXECUTION_FAILED",
        lastErrorMessage: error instanceof Error ? error.message : "dream failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now.toISOString()
      });
    }
  }

  private hasDeliveryAuthority(): boolean {
    return Boolean(this.options.writer || this.options.provider?.writeEventIdempotent);
  }

  private async deliver(events: MemoryWriteEventInput[]): Promise<MemoryWriteEventOutcome[]> {
    if (this.options.provider?.writeEventIdempotent) {
      return deliverDreamEventsIdempotent(this.options.provider, events);
    }
    if (this.options.writer) {
      return this.options.writer(events);
    }
    return [];
  }

  private async loadEpisodes(ids: readonly string[]): Promise<RecentEpisode[]> {
    const episodes: RecentEpisode[] = [];
    for (const id of ids) {
      const episode = await this.episodes.getById(id);
      if (episode) episodes.push(episode);
    }
    return episodes;
  }

  private async extractUserGroundedEvents(
    episodes: RecentEpisode[],
    job: DreamJob
  ): Promise<MemoryWriteEventInput[]> {
    const ingestion = this.options.ingestion ?? new MemoryIngestionPolicy();
    const userStatements = episodes.flatMap((episode) => episode.userStatements);
    const unique = dedupeStatements(userStatements);
    const events: MemoryWriteEventInput[] = [];
    for (const [index, statement] of unique.entries()) {
      const result = await ingestion.build({
        userMessage: statement,
        assistantMessage: "Consolidation context only; assistant prose is not evidence.",
        scope: job.memoryScope ?? "user",
        sessionId: episodes[0]?.sessionId,
        personaId: job.personaId,
        subjectUserId: job.subjectUserId,
        observedAt: episodes[0]?.occurredAt ?? episodes[0]?.recordedAt,
        conversationId: episodes[0]?.sessionId,
        idempotencyKey: `${job.sourceDigest}:${index}`
      });
      for (const event of result.events) {
        if (event.assertion?.source !== "user") continue;
        events.push({
          ...event,
          confidence: event.confidence ?? null,
          metadata: {
            ...event.metadata,
            dreamJobId: job.jobId,
            dreamTrigger: job.triggerKind,
            sourceEpisodeIds: job.sourceEpisodeIds,
            recurrenceDoesNotUpgradeConfidence: true,
            assistantNonAuthoritative: true
          }
        });
      }
    }
    return events;
  }
}

export function findRecurrenceCluster(
  episode: RecentEpisode,
  existing: readonly RecentEpisode[],
  budgets: MemoryHierarchyBudgets
): RecentEpisode[] {
  const seedTokens = tokenizeMemoryText(episode.userStatements.join(" "));
  if (seedTokens.length === 0) return [];
  const cluster = [episode];
  for (const candidate of existing) {
    if (candidate.id === episode.id) continue;
    if (candidate.userStatements.length === 0) continue;
    if (sourceTurnIdsOverlap(episode.sourceTurnIds, candidate.sourceTurnIds)) continue;
    const similarity = jaccardSimilarity(
      seedTokens,
      tokenizeMemoryText(candidate.userStatements.join(" "))
    );
    if (similarity >= budgets.recurrenceMinSimilarity) cluster.push(candidate);
  }
  return cluster;
}

function hasExplicitImportance(episode: RecentEpisode): boolean {
  const text = episode.userStatements.join(" ");
  return /记住|重要|决定了|以后都|from now on|remember|important|decided/iu.test(text);
}

function hasExplicitRemember(episode: RecentEpisode): boolean {
  return /记住|please remember|记住：|记住:/iu.test(episode.userStatements.join(" "));
}

function isDue(job: DreamJob, nowMs: number): boolean {
  if (job.status === "pending") return true;
  if (job.status === "processing") {
    return job.leaseExpiresAt !== null && Date.parse(job.leaseExpiresAt) <= nowMs;
  }
  return false;
}

function dedupeStatements(statements: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const statement of statements) {
    const key = statement.replace(/\s+/g, "").toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(statement);
  }
  return result;
}

function cloneJob(job: DreamJob): DreamJob {
  return {
    ...job,
    sourceEpisodeIds: [...job.sourceEpisodeIds],
    payload: { ...job.payload },
    resultEventPayloads: job.resultEventPayloads
      ? job.resultEventPayloads.map((event) => ({ ...event, metadata: { ...event.metadata } }))
      : null
  };
}

export class PostgresDreamJobStore implements DreamJobStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(connectionString: string | Pool) {
    this.ownsPool = typeof connectionString === "string";
    this.pool =
      typeof connectionString === "string"
        ? createPostgresPool(connectionString)
        : connectionString;
  }

  async upsertPending(job: DreamJob): Promise<DreamJob> {
    const existing = await this.getByDigest(job.sourceDigest);
    if (
      existing &&
      (existing.status === "complete" ||
        existing.status === "processing" ||
        existing.status === "pending")
    ) {
      return existing;
    }
    const result = await this.pool.query(
      `insert into dream_jobs (
        job_id, trigger_kind, status, memory_scope, persona_id, subject_user_id,
        source_episode_ids, source_digest, payload, result_event_payloads,
        result_summary, attempt_count, lease_owner, lease_expires_at,
        last_error_code, last_error_message, created_at, updated_at, completed_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19
      )
      on conflict (source_digest) do update set
        updated_at = dream_jobs.updated_at
      returning *`,
      bindJob(job)
    );
    return mapJobRow(result.rows[0]);
  }

  async getByDigest(sourceDigest: string): Promise<DreamJob | null> {
    const result = await this.pool.query(`select * from dream_jobs where source_digest = $1`, [
      sourceDigest
    ]);
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  async getById(jobId: string): Promise<DreamJob | null> {
    const result = await this.pool.query(`select * from dream_jobs where job_id = $1`, [jobId]);
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  async listDue(now: Date, limit: number): Promise<DreamJob[]> {
    const result = await this.pool.query(
      `select * from dream_jobs
       where status = 'pending'
          or (status = 'processing' and lease_expires_at is not null and lease_expires_at <= $1)
       order by created_at asc
       limit $2`,
      [now.toISOString(), limit]
    );
    return result.rows.map(mapJobRow);
  }

  async claimDue(input: {
    now: Date;
    leaseOwner: string;
    leaseMs: number;
    limit: number;
  }): Promise<DreamJob[]> {
    const result = await this.pool.query(
      `with due as (
         select job_id
         from dream_jobs
         where status = 'pending'
            or (status = 'processing' and lease_expires_at is not null and lease_expires_at <= $1)
         order by created_at asc
         for update skip locked
         limit $2
       )
       update dream_jobs as jobs
       set status = 'processing',
           lease_owner = $3,
           lease_expires_at = $4,
           attempt_count = jobs.attempt_count + 1,
           updated_at = $1
       from due
       where jobs.job_id = due.job_id
       returning jobs.*`,
      [
        input.now.toISOString(),
        input.limit,
        input.leaseOwner,
        new Date(input.now.getTime() + input.leaseMs).toISOString()
      ]
    );
    return result.rows.map(mapJobRow);
  }

  async claimJob(input: {
    jobId: string;
    now: Date;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<DreamJob | null> {
    const result = await this.pool.query(
      `update dream_jobs
       set status = 'processing',
           lease_owner = $2,
           lease_expires_at = $3,
           attempt_count = attempt_count + 1,
           updated_at = $4
       where job_id = $1
         and (
           status = 'pending'
           or (status = 'processing' and lease_expires_at is not null and lease_expires_at <= $4)
         )
       returning *`,
      [
        input.jobId,
        input.leaseOwner,
        new Date(input.now.getTime() + input.leaseMs).toISOString(),
        input.now.toISOString()
      ]
    );
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  async save(job: DreamJob): Promise<DreamJob> {
    const result = await this.pool.query(
      `insert into dream_jobs (
        job_id, trigger_kind, status, memory_scope, persona_id, subject_user_id,
        source_episode_ids, source_digest, payload, result_event_payloads,
        result_summary, attempt_count, lease_owner, lease_expires_at,
        last_error_code, last_error_message, created_at, updated_at, completed_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19
      )
      on conflict (job_id) do update set
        trigger_kind = excluded.trigger_kind,
        status = excluded.status,
        payload = excluded.payload,
        result_event_payloads = excluded.result_event_payloads,
        result_summary = excluded.result_summary,
        attempt_count = excluded.attempt_count,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        last_error_code = excluded.last_error_code,
        last_error_message = excluded.last_error_message,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
      returning *`,
      bindJob(job)
    );
    return mapJobRow(result.rows[0]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

function bindJob(job: DreamJob): unknown[] {
  return [
    job.jobId,
    job.triggerKind,
    job.status,
    job.memoryScope,
    job.personaId,
    job.subjectUserId,
    JSON.stringify(job.sourceEpisodeIds),
    job.sourceDigest,
    JSON.stringify(job.payload),
    job.resultEventPayloads ? JSON.stringify(job.resultEventPayloads) : null,
    job.resultSummary,
    job.attemptCount,
    job.leaseOwner,
    job.leaseExpiresAt,
    job.lastErrorCode,
    job.lastErrorMessage,
    job.createdAt,
    job.updatedAt,
    job.completedAt
  ];
}

function mapJobRow(row: QueryResultRow | undefined): DreamJob {
  if (!row) throw new Error("Dream job row was empty.");
  return {
    jobId: String(row["job_id"]),
    triggerKind: row["trigger_kind"] as DreamTriggerKind,
    status: row["status"] as DreamJobStatus,
    memoryScope: row["memory_scope"] ?? null,
    personaId: row["persona_id"] ?? null,
    subjectUserId: row["subject_user_id"] ?? null,
    sourceEpisodeIds: asJsonArray(row["source_episode_ids"]),
    sourceDigest: String(row["source_digest"]),
    payload: asJsonObject(row["payload"]),
    resultEventPayloads: row["result_event_payloads"]
      ? (asJsonValue(row["result_event_payloads"]) as MemoryWriteEventInput[])
      : null,
    resultSummary: row["result_summary"] ?? null,
    attemptCount: Number(row["attempt_count"] ?? 0),
    leaseOwner: row["lease_owner"] ?? null,
    leaseExpiresAt: row["lease_expires_at"]
      ? new Date(String(row["lease_expires_at"])).toISOString()
      : null,
    lastErrorCode: row["last_error_code"] ?? null,
    lastErrorMessage: row["last_error_message"] ?? null,
    createdAt: new Date(String(row["created_at"])).toISOString(),
    updatedAt: new Date(String(row["updated_at"])).toISOString(),
    completedAt: row["completed_at"] ? new Date(String(row["completed_at"])).toISOString() : null
  };
}

function asJsonArray(value: unknown): string[] {
  const parsed = asJsonValue(value);
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}

function asJsonObject(value: unknown): Record<string, unknown> {
  const parsed = asJsonValue(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function asJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
