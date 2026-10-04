import { randomUUID } from "node:crypto";
import { effectDigest, type EffectIntent } from "./model.js";
import {
  EFFECT_DELIVERY_CONTRACTS,
  protocolEvidence,
  type EffectAttemptV1,
  type EffectEvidence
} from "./dispatch-model.js";
import type { EffectClaim, EffectDispatchStore } from "./dispatch-store.js";

/** Host-bound implementation, never a model/plugin supplied callback or delivery declaration. */
export interface EffectAdapter {
  readonly contractRef: EffectIntent["contractRef"];
  readonly adapter: string;
  isCurrent(intent: EffectIntent): boolean;
  invoke(
    intent: EffectIntent,
    attempt: EffectAttemptV1,
    signal: AbortSignal
  ): Promise<{ evidence: EffectEvidence; transientResult?: unknown }>;
  /** Only a host contract permitting lookup may supply this. No invocation inside reconciliation. */
  reconcile?(
    intent: EffectIntent,
    attempt: EffectAttemptV1,
    signal: AbortSignal
  ): Promise<EffectEvidence>;
}
export type EffectRunResult = { invoked: boolean; recorded: boolean; transientResult?: unknown };
/** Bounded single-flight worker. The durable store arbitrates between processes. */
export class EffectDispatcher {
  private readonly adapters = new Map<EffectIntent["contractRef"], EffectAdapter>();
  private readonly active = new Map<
    string,
    {
      promise: Promise<EffectRunResult>;
      controller: AbortController;
      claim: EffectClaim | null;
      detached: boolean;
      caller: Promise<EffectRunResult>;
      detach(result: EffectRunResult): void;
    }
  >();
  private readonly owner = `a9:${randomUUID()}`;
  private accepting = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private readonly lanes = new Map<string, number>();
  private lane(contract: EffectIntent["contractRef"]) {
    return contract === "yuvi.provider.v1"
      ? "generation"
      : contract === "yuvi.read-text.v1" || contract === "yuvi.native-control.v1"
        ? "control"
        : "publication";
  }
  private async enterLane(contract: EffectIntent["contractRef"], signal: AbortSignal) {
    if (!this.reservedLanes) return () => {};
    const lane = this.lane(contract),
      limit = lane === "control" ? 2 : 4;
    while (this.accepting && !signal.aborted) {
      const count = this.lanes.get(lane) ?? 0;
      if (count < limit) {
        this.lanes.set(lane, count + 1);
        return () => this.lanes.set(lane, (this.lanes.get(lane) ?? 1) - 1);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Effect lane was sealed.");
  }
  constructor(
    private readonly store: EffectDispatchStore,
    adapters: readonly EffectAdapter[],
    private readonly leaseMs = 30_000,
    private readonly concurrency = 4,
    private readonly reservedLanes = false
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
      throw Error("Invalid effect concurrency bound.");
    for (const adapter of adapters) this.registerAdapter(adapter);
  }
  /** Composition-only registration before the shared worker starts polling. */
  registerAdapter(adapter: EffectAdapter) {
    const contract = EFFECT_DELIVERY_CONTRACTS[adapter.contractRef];
    if (
      this.timer ||
      !contract ||
      adapter.adapter !== contract.adapter ||
      this.adapters.has(adapter.contractRef) ||
      (adapter.reconcile && contract.reconciliation !== "OPTIONAL_HOST_LOOKUP")
    )
      throw Error("Invalid host effect adapter contract.");
    this.adapters.set(adapter.contractRef, adapter);
  }
  start(intervalMs = 500) {
    if (this.timer || !this.accepting) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }
  async tick() {
    if (!this.accepting || this.polling) return;
    this.polling = true;
    try {
      for (const id of await this.store.discover(64, [...this.adapters.keys()])) {
        if (!this.accepting || this.active.size >= (this.reservedLanes ? 64 : this.concurrency))
          break;
        void this.run(id).catch(() => undefined);
      }
    } finally {
      this.polling = false;
    }
  }
  run(id: string): Promise<EffectRunResult> {
    const existing = this.active.get(id);
    if (existing) return existing.caller;
    if (!this.accepting || this.active.size >= (this.reservedLanes ? 64 : this.concurrency))
      return Promise.resolve({ invoked: false, recorded: false });
    let detach!: (result: EffectRunResult) => void;
    const detached = new Promise<EffectRunResult>((resolve) => {
      detach = resolve;
    });
    const entry = {
      promise: Promise.resolve<EffectRunResult>({ invoked: false, recorded: false }),
      controller: new AbortController(),
      detached: false,
      caller: detached,
      detach,
      claim: null as EffectClaim | null
    };
    // Schedule only after single-flight registration, including synchronous adapters.
    entry.promise = Promise.resolve()
      .then(async () => {
        const d = await this.store.diagnostic(id);
        if (!d || !this.accepting) return { invoked: false, recorded: false };
        // The payload is never returned by diagnostics. Contract selection comes from the current attempt
        // or a narrow host store lookup through claim; unactivated contracts simply remain pending.
        for (const adapter of this.adapters.values()) {
          if (d.contractRef && d.contractRef !== adapter.contractRef) continue;
          const current = (i: EffectIntent) =>
            this.accepting &&
            !entry.controller.signal.aborted &&
            Date.parse(i.request.expiresAt) > Date.now() &&
            adapter.isCurrent(i);
          const releaseLane = await this.enterLane(adapter.contractRef, entry.controller.signal);
          try {
            let intent: EffectIntent | null = null;
            const claim = await this.store.claim(
              id,
              adapter.contractRef,
              this.owner,
              this.leaseMs,
              (i) => current(i)
            );
            if (!claim) continue;
            intent = claim.intent;
            entry.claim = claim;
            if (claim.mode === "RECONCILE") {
              let e: EffectEvidence;
              try {
                e = adapter.reconcile
                  ? await adapter.reconcile(intent, claim.attempt, entry.controller.signal)
                  : protocolEvidence("RECONCILIATION_UNSUPPORTED", true);
              } catch {
                e = protocolEvidence("CALL_UNCERTAIN", true);
              }
              if (entry.detached) return { invoked: false, recorded: false };
              const recorded = await this.store.record(claim.attempt, e);
              return { invoked: false, recorded: recorded === "RECORDED" || recorded === "REPLAY" };
            }
            let didStart = false;
            try {
              didStart = await this.store.start(claim, () => current(claim.intent));
            } catch {
              // A COMMIT response can be lost. Resolve the committed fence before invoking.
              const state = await this.store.diagnostic(id);
              didStart =
                !!state?.currentAttempt?.dispatchStartedAt &&
                state.currentAttempt.attemptId === claim.attempt.attemptId &&
                state.currentAttempt.fence === claim.attempt.fence &&
                state.currentAttempt.leaseOwner === this.owner &&
                !state.evidence;
            }
            if (!didStart) return { invoked: false, recorded: false };
            const diagnostic = await this.store.diagnostic(id);
            const started = diagnostic?.currentAttempt;
            // Recovery may have fenced this worker while the COMMIT response was delayed.
            // Check the durable owner and lease again; no asynchronous yield separates this check
            // from entering the adapter. The adapter receives the committed start snapshot.
            if (
              !started ||
              started.attemptId !== claim.attempt.attemptId ||
              started.fence !== claim.attempt.fence ||
              started.leaseOwner !== this.owner ||
              !started.dispatchStartedAt ||
              diagnostic.evidence ||
              Date.parse(started.leaseExpiresAt) <= Date.now()
            )
              return { invoked: false, recorded: false };
            // A synchronous currentness check is the last host boundary before invocation. If revoked,
            // this worker knows it did NOT invoke; a restart without that observation knows only UNKNOWN.
            if (!current(intent)) {
              await this.store.record(claim.attempt, protocolEvidence("AUTHORITY_REVOKED", false));
              return { invoked: false, recorded: true };
            }
            let result: { evidence: EffectEvidence; transientResult?: unknown };
            let renewalBusy = false;
            const renewal = this.store.renew
              ? setInterval(
                  () => {
                    if (renewalBusy || entry.controller.signal.aborted) return;
                    renewalBusy = true;
                    void this.store.renew!(started, this.leaseMs)
                      .then(
                        (ok) => {
                          if (!ok) entry.controller.abort();
                        },
                        () => entry.controller.abort()
                      )
                      .finally(() => {
                        renewalBusy = false;
                      });
                  },
                  Math.max(1, Math.floor(this.leaseMs / 3))
                )
              : undefined;
            renewal?.unref();
            try {
              result = await adapter.invoke(intent, started, entry.controller.signal);
            } catch {
              result = { evidence: protocolEvidence("CALL_UNCERTAIN", true) };
            } finally {
              if (renewal) clearInterval(renewal);
            }
            if (entry.detached) return { invoked: true, recorded: false };
            let recorded = false;
            try {
              const status = await this.store.record(claim.attempt, result.evidence);
              recorded = status === "RECORDED" || status === "REPLAY";
            } catch {
              const state = await this.store.diagnostic(id);
              recorded =
                state?.currentAttempt?.attemptId === started.attemptId &&
                state.currentAttempt.fence === started.fence &&
                !!state.evidence &&
                effectDigest(state.evidence) === effectDigest(result.evidence);
            }
            return {
              invoked: true,
              recorded,
              ...(recorded &&
              result.evidence.certainty === "APPLIED" &&
              current(intent) &&
              Object.hasOwn(result, "transientResult")
                ? { transientResult: result.transientResult }
                : {})
            };
          } finally {
            releaseLane();
          }
        }
        return { invoked: false, recorded: false };
      })
      .finally(() => {
        this.active.delete(id);
      });
    entry.caller = Promise.race([entry.promise, detached]);
    this.active.set(id, entry);
    return entry.caller;
  }
  diagnostic(id: string) {
    return this.store.diagnostic(id);
  }
  cancel(id: string) {
    return this.store.cancel(id);
  }
  async shutdown(graceMs = 2_000): Promise<{ drained: boolean }> {
    this.accepting = false;
    if (this.timer) clearInterval(this.timer);
    for (const e of this.active.values()) e.controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled([...this.active.values()].map((e) => e.promise)).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), graceMs);
      })
    ]);
    if (timeout) clearTimeout(timeout);
    if (!drained)
      for (const e of this.active.values())
        if (e.claim) {
          const d = await this.store.diagnostic(e.claim.intent.intentId);
          if (!d?.evidence)
            await this.store.record(
              e.claim.attempt,
              protocolEvidence("SHUTDOWN", !!d?.currentAttempt?.dispatchStartedAt)
            );
          e.detached = true;
          e.detach({ invoked: !!d?.currentAttempt?.dispatchStartedAt, recorded: false });
        }
    // Keep implementations referenced by admitted promises until they settle. DB/accounting certainty
    // is independent of the lifetime of the abandoned caller; no result will publish after shutdown.
    return { drained };
  }
}
