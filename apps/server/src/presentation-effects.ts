import { randomUUID } from "node:crypto";
import type { PostgresPool } from "@companion/database";
import type { RuntimeEmbodiedEffectRecordInitializationDecision } from "@companion/core";
import {
  createEvent,
  AccountedPresentationReportSchema,
  type RuntimeEvent,
  type PresentationPermission,
  type AccountedPresentationRequest
} from "@companion/protocol";
import {
  effectDigest,
  protocolEvidence,
  type EffectAttemptV1,
  type EffectProgressFact
} from "@companion/effects";
import type { EventBus } from "@companion/event-bus";
import { currentProviderWorkContext } from "@companion/providers";
import { HostOutwardEffects } from "./outward-effects.js";
/** Volatile report capabilities, not a second dispatch authority or queue. */
export class HostPresentationEffects {
  private accepting = true;
  private readonly consumed = new Set<string>();
  private readonly reports = new Map<
    string,
    {
      permission: PresentationPermission;
      attempt: EffectAttemptV1;
      traceId: string;
      isCurrent: () => boolean;
      expiresAt: string;
    }
  >();
  constructor(
    private readonly pool: PostgresPool | undefined,
    private readonly outward: HostOutwardEffects,
    private readonly bus: Pick<EventBus, "publish">,
    private readonly target: (
      replyId: string
    ) => { generation: string; requestId: string; current: () => boolean } | undefined
  ) {}
  invalidateAll() {
    this.reports.clear();
    this.consumed.clear();
  }
  seal() {
    this.accepting = false;
    this.invalidateAll();
  }
  async dispatch(
    decision: RuntimeEmbodiedEffectRecordInitializationDecision,
    reply: RuntimeEvent
  ): Promise<void> {
    if (decision.status !== "RECORD_INITIALIZED") return;
    if (!this.accepting || !this.pool) throw Error("Durable presentation accounting unavailable.");
    const { effectId, behavior } = decision.record.identity;
    const context = currentProviderWorkContext(),
      target = this.target(reply.id);
    if (!target) return; // No active device owner: intentionally unsupported, no dispatch.
    const isCurrent = () =>
      this.accepting &&
      this.outward.isReplyCurrent(reply.id) &&
      target.current() &&
      (context?.isCurrent?.() ?? true);
    if (!isCurrent()) throw Error("Presentation reply/execution is stale.");
    // The legacy record is a semantic proposal only; no legacy advancement/present is invoked.
    const work = await this.outward.work({
      contractRef: "yuvi.embodied-presentation.v1",
      logicalKey: effectId,
      operation: "embodied-presentation",
      digest: effectDigest(behavior),
      payload: behavior,
      configurationRef: "character-presentation.v1",
      scope: `presentation:${reply.traceId}`,
      executionId: reply.traceId,
      replyId: reply.id,
      cause: this.outward.replyCause(reply.id),
      isCurrent
    });
    await this.outward.execute(
      work,
      async (attempt, signal) => {
        const permission: PresentationPermission = {
          version: "presentation-permission.v1",
          intentId: attempt.intentId,
          attemptId: attempt.attemptId,
          fence: attempt.fence,
          generation: target.generation,
          requestId: target.requestId,
          expiresAt: work.request.expiresAt,
          capability: randomUUID(),
          effectId
        };
        await this.outward.fact(attempt, {
          factKey: "presentation-permission",
          kind: "PERMISSION_ISSUED",
          reference: permission.capability,
          digest: effectDigest(permission),
          generation: target.generation
        });
        if (signal.aborted || !this.accepting)
          return { evidence: protocolEvidence("AUTHORITY_REVOKED", false) };
        if (this.reports.size >= 256)
          return { evidence: protocolEvidence("AUTHORITY_REVOKED", false) };
        this.reports.set(permission.capability, {
          permission,
          attempt,
          traceId: reply.traceId,
          isCurrent,
          expiresAt: work.request.expiresAt
        });
        const envelope: AccountedPresentationRequest = {
          version: "accounted-presentation.v1",
          request: { version: "embodied-presentation-request-7ad.v1", effectId, behavior },
          permission
        };
        try {
          await this.bus.publish(
            createEvent("runtime.embodied.presentation.request", envelope, {
              traceId: reply.traceId,
              parentId: reply.id
            })
          );
          return {
            evidence: {
              certainty: "APPLIED" as const,
              layer: "BRIDGE_ACCEPTANCE" as const,
              reason: "RETURNED" as const,
              remoteEffectId: null
            }
          };
        } catch {
          return { evidence: protocolEvidence("CALL_UNCERTAIN", true) };
        }
      },
      async (intent) => {
        await this.pool!.query(
          `insert into effect_input_exposures(intent_id,descriptor) values($1,$2::jsonb) on conflict do nothing`,
          [
            intent.intentId,
            JSON.stringify({
              version: "a9-input-snapshot.v1",
              digest: effectDigest(behavior),
              availability: "RETAINED_REFERENCE",
              reference: effectId,
              manifest: "A10_3_NOT_IMPLEMENTED"
            })
          ]
        );
      }
    );
  }
  async accept(permission: PresentationPermission): Promise<boolean> {
    const entry = this.reports.get(permission.capability);
    if (
      !this.accepting ||
      !entry ||
      !entry.isCurrent() ||
      Date.parse(entry.expiresAt) <= Date.now() ||
      this.consumed.has(permission.capability) ||
      effectDigest(entry.permission) !== effectDigest(permission)
    )
      return false;
    this.consumed.add(permission.capability);
    const attempt = (await this.outward.dispatcher?.diagnostic(permission.intentId))
      ?.currentAttempt;
    if (!attempt) return false;
    const result = await this.outward.store?.progress?.(
      attempt,
      {
        factKey: "presentation-device-permit",
        kind: "PRESENTATION_PERMISSION_ACCEPTED",
        reference: permission.capability,
        digest: effectDigest(permission),
        generation: permission.generation
      },
      { reference: permission.capability, generation: permission.generation }
    );
    return result === "RECORDED" && entry.isCurrent();
  }
  async report(input: unknown): Promise<boolean> {
    const parsed = AccountedPresentationReportSchema.parse(input),
      entry = this.reports.get(parsed.permission.capability);
    if (
      !this.accepting ||
      !entry ||
      !this.consumed.has(parsed.permission.capability) ||
      !entry.isCurrent() ||
      Date.parse(entry.expiresAt) <= Date.now() ||
      effectDigest(entry.permission) !== effectDigest(parsed.permission)
    )
      return false;
    const current = await this.outward.dispatcher?.diagnostic(entry.permission.intentId);
    if (!current?.currentAttempt || current.currentAttempt.attemptId !== entry.attempt.attemptId)
      return false;
    const kinds = {
      STARTED: "PRESENTATION_STARTED",
      COMPLETED: "PRESENTATION_COMPLETED",
      INTERRUPTED: "PRESENTATION_INTERRUPTED",
      REJECTED: "PRESENTATION_REJECTED",
      FAILED: "PRESENTATION_ERROR"
    } as const;
    const fact: EffectProgressFact = {
      factKey: `presentation:${parsed.report.outcome}`,
      kind: kinds[parsed.report.outcome],
      reference: parsed.report.effectId,
      digest: effectDigest(parsed.report),
      generation: parsed.permission.generation
    };
    const status = await this.outward.store?.progress?.(current.currentAttempt, fact, {
      reference: entry.permission.capability,
      generation: parsed.permission.generation
    });
    return status === "RECORDED" || status === "REPLAY";
  }
}
