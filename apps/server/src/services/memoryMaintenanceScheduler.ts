import {
  MemoryMaintenanceService,
  type MemoryMaintenanceOptions,
  type MemoryMaintenanceSummary
} from "@companion/memory";
import type { FastifyBaseLogger } from "fastify";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";

export type MemoryMaintenanceSchedulerStatus = {
  enabled: boolean;
  mode: "LEGACY_MEMORY" | "CONVERSATION_RECOVERY_ONLY";
  runOnStartup: boolean;
  intervalMinutes: number;
  limit: number;
  running: boolean;
  lastRunAt: string | null;
  lastSummary: MemoryMaintenanceSummary | null;
  lastError: string | null;
  nextRunAt: string | null;
};

export class MemoryMaintenanceScheduler {
  private readonly service: MemoryMaintenanceService;
  private readonly enabled: boolean;
  private readonly runOnStartup: boolean;
  private readonly intervalMinutes: number;
  private readonly limit: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt: Date | null = null;
  private lastSummary: MemoryMaintenanceSummary | null = null;
  private lastError: string | null = null;
  private nextRunAt: Date | null = null;

  constructor(
    private readonly context: AppContext,
    config: ServerConfig,
    private readonly logger: FastifyBaseLogger
  ) {
    this.service = new MemoryMaintenanceService(context.memoryRepository);
    this.enabled = config.memoryMaintenance.enabled;
    this.runOnStartup = config.memoryMaintenance.runOnStartup;
    this.intervalMinutes = config.memoryMaintenance.intervalMinutes;
    this.limit = config.memoryMaintenance.limit;
  }

  start(): void {
    if (!this.enabled) return;

    if (this.runOnStartup) {
      void this.run("startup").catch(() => undefined);
    }

    if (this.intervalMinutes > 0) {
      const intervalMs = this.intervalMinutes * 60_000;
      this.nextRunAt = new Date(Date.now() + intervalMs);
      this.timer = setInterval(() => {
        this.nextRunAt = new Date(Date.now() + intervalMs);
        void this.run("interval").catch(() => undefined);
      }, intervalMs);
      this.timer.unref?.();
    }
  }

  async run(
    reason: "startup" | "interval" | "manual",
    options: MemoryMaintenanceOptions = {}
  ): Promise<MemoryMaintenanceSummary> {
    if (this.running) {
      throw new Error("Memory maintenance is already running.");
    }

    this.running = true;
    this.lastError = null;
    try {
      if (!options.dryRun) {
        const recoveredStreaming = await this.context.runtime.recoverStaleStreamingMessages({
          limit: options.limit ?? this.limit
        });
        if (recoveredStreaming.length > 0) {
          this.logger.warn(
            { reason, recoveredCount: recoveredStreaming.length },
            "recovered stale streaming conversation messages during maintenance"
          );
        }
      }
      const summary: MemoryMaintenanceSummary = this.context.memory.usesSemanticMemoryPolicy?.()
        ? {
            dryRun: Boolean(options.dryRun),
            scanned: 0,
            expired: 0,
            stale: 0,
            supersessionWarnings: 0,
            skipped: 0,
            failed: 0,
            expiredIds: [],
            staleIds: [],
            warnings: []
          }
        : await this.service.run({
            ...options,
            dryRun: options.dryRun ?? false,
            limit: options.limit ?? this.limit
          });
      this.lastRunAt = new Date();
      this.lastSummary = summary;
      this.logger.info(
        {
          reason,
          scanned: summary.scanned,
          expired: summary.expired,
          stale: summary.stale,
          supersessionWarnings: summary.supersessionWarnings,
          skipped: summary.skipped,
          failed: summary.failed
        },
        "memory maintenance completed"
      );
      return summary;
    } catch (error) {
      this.lastRunAt = new Date();
      this.lastError = safeErrorMessage(error);
      this.logger.warn({ reason, error: this.lastError }, "memory maintenance failed");
      throw error;
    } finally {
      this.running = false;
    }
  }

  getStatus(): MemoryMaintenanceSchedulerStatus {
    return {
      enabled: this.enabled,
      mode: this.context.memory.usesSemanticMemoryPolicy?.()
        ? "CONVERSATION_RECOVERY_ONLY"
        : "LEGACY_MEMORY",
      runOnStartup: this.runOnStartup,
      intervalMinutes: this.intervalMinutes,
      limit: this.limit,
      running: this.running,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastSummary: this.lastSummary,
      lastError: this.lastError,
      nextRunAt: this.nextRunAt?.toISOString() ?? null
    };
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(DATABASE_URL|API_KEY|TOKEN|SECRET|PASSWORD)=([^\s]+)/giu, "$1=[REDACTED]")
    .slice(0, 300);
}
