import { randomUUID } from "node:crypto";
import type { EffectIntent } from "./model.js";
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
    { promise: Promise<EffectRunResult>; controller: AbortController; claim: EffectClaim | null }
  >();
  private readonly owner = `a9:${randomUUID()}`;
  private accepting = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  constructor(
    private readonly store: EffectDispatchStore,
    adapters: readonly EffectAdapter[],
    private readonly leaseMs = 30_000,
    private readonly concurrency = 4
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
        if (!this.accepting || this.active.size >= this.concurrency) break;
        void this.run(id).catch(() => undefined);
      }
    } finally {
      this.polling = false;
    }
  }
  run(id: string): Promise<EffectRunResult> {
    const existing = this.active.get(id);
    if (existing) return existing.promise;
    if (!this.accepting || this.active.size >= this.concurrency)
      return Promise.resolve({ invoked: false, recorded: false });
    const entry = {
      promise: Promise.resolve<EffectRunResult>({ invoked: false, recorded: false }),
      controller: new AbortController(),
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
          const current = (i: EffectIntent) =>
            this.accepting &&
            !entry.controller.signal.aborted &&
            Date.parse(i.request.expiresAt) > Date.now() &&
            adapter.isCurrent(i);
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
            const recorded = await this.store.record(claim.attempt, e);
            return { invoked: false, recorded: recorded === "RECORDED" || recorded === "REPLAY" };
          }
          if (!(await this.store.start(claim, () => current(claim.intent))))
            return { invoked: false, recorded: false };
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
          try {
            result = await adapter.invoke(intent, started, entry.controller.signal);
          } catch {
            result = { evidence: protocolEvidence("CALL_UNCERTAIN", true) };
          }
          const status = await this.store.record(claim.attempt, result.evidence);
          const recorded = status === "RECORDED" || status === "REPLAY";
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
        }
        return { invoked: false, recorded: false };
      })
      .finally(() => {
        this.active.delete(id);
      });
    this.active.set(id, entry);
    return entry.promise;
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
        }
    // Keep implementations referenced by admitted promises until they settle. DB/accounting certainty
    // is independent of the lifetime of the abandoned caller; no result will publish after shutdown.
    return { drained };
  }
}
