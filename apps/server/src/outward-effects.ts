import { HostContextUse } from "./context-use.js";
import { describeExposure, providerInputDigest } from "@companion/providers";
import type { PostgresContextUseRepository } from "@companion/memory";
import type { ReplyPublicationTarget, ReplyPublicationAdmission } from "@companion/memory";
import { createHash, randomUUID } from "node:crypto";
import {
  EFFECT_CONTRACTS,
  EFFECT_DELIVERY_CONTRACTS,
  EffectIdentitySnapshotSchema,
  effectDigest,
  effectIntentId,
  protocolEvidence,
  freezeEffectRequest,
  requestEffectDigest,
  HostEffectIntentAdmission,
  type EffectIntentAdmissionPort,
  type EffectDispatchStore,
  type EffectDispatcher,
  type EffectIntent,
  type EffectAttemptV1,
  type EffectEvidence,
  type EffectProgressFact
} from "@companion/effects";
import type { JournalRepository } from "@companion/journal";
import type { JournalEventRef } from "@companion/protocol";
import {
  currentProviderWorkContext,
  ProviderError,
  ProviderErrorCode,
  isCertifiedProviderNotStarted,
  isProviderResponseObservedError,
  cloneProviderError,
  type ProviderAccountingPort,
  type ProviderTaskDescriptor,
  type ProviderLeafDescriptor
} from "@companion/providers";

type Work = {
  request: EffectIntent["request"] & { payload: unknown };
  identity: EffectIntent["authorization"]["identity"];
  isCurrent(): boolean;
  verifyContext?: (() => Promise<boolean>) | undefined;
};
type Grant = {
  work: Work;
  invoke(
    attempt: EffectAttemptV1,
    signal: AbortSignal
  ): Promise<{ evidence: EffectEvidence; transientResult?: unknown }>;
};
/** Volatile invocation grants only. All durable admission/attempt/outcome lives in canonical A9. */
export class HostOutwardEffects implements ProviderAccountingPort {
  private readonly grants = new Map<string, Grant>();
  private readonly tasks = new Map<string, Work>();
  private accepting = true;
  private readonly replies = new Map<
    string,
    { requestId: string | undefined; cause: JournalEventRef; sessionId: string }
  >();
  isReplyLive(replyId: string, requestId: string) {
    return this.accepting && this.replies.get(replyId)?.requestId === requestId;
  }
  isReplyCurrent(replyId: string) {
    return this.accepting && this.replies.has(replyId);
  }
  replyRequest(replyId: string) {
    return this.replies.get(replyId);
  }
  replyCause(replyId: string) {
    return this.replies.get(replyId)?.cause;
  }

  private readonly targets = new Map<
    string,
    {
      target: ReplyPublicationTarget;
      match: (session: string, trace: string) => boolean;
      current: () => boolean;
      admitComponents: boolean;
    }
  >();
  registerTarget(
    target: ReplyPublicationTarget,
    match: (session: string, trace: string) => boolean,
    current: () => boolean,
    admitComponents = true
  ): () => void {
    if (!this.accepting || this.targets.size >= 1024)
      throw Error("Publication ingress is sealed or full.");
    const key = `${target.targetId}:${target.targetGeneration}`;
    if (this.targets.has(key)) throw Error("Target generation is already registered.");
    this.targets.set(key, { target, match, current, admitComponents });
    return () => {
      this.targets.delete(key);
    };
  }
  readonly admitReplyPublications: ReplyPublicationAdmission = async (input, client) => {
    if (!this.accepting) throw Error("Publication ingress is sealed.");
    const targets = new Map<string, ReplyPublicationTarget>();
    for (const target of input.targets)
      targets.set(`${target.targetId}:${target.targetGeneration}`, target);
    for (const entry of this.targets.values())
      if (
        entry.admitComponents &&
        entry.current() &&
        entry.match(input.message.sessionId, input.message.traceId)
      )
        targets.set(`${entry.target.targetId}:${entry.target.targetGeneration}`, entry.target);
    const context = currentProviderWorkContext();
    if (client) {
      const plan = context?.speechPlan ?? "NONE",
        requestId = context?.speechRequestId ?? null;
      await client.query(
        "insert into reply_speech_plans(reply_id,plan,request_id) values($1,$2,$3) on conflict do nothing",
        [input.replyId, plan, requestId]
      );
      const prior = await client.query(
        "select plan,request_id from reply_speech_plans where reply_id=$1",
        [input.replyId]
      );
      if (prior.rows[0]?.["plan"] !== plan || prior.rows[0]?.["request_id"] !== requestId)
        throw Error("Frozen speech plan conflict.");
    }
    for (const target of targets.values()) {
      const live = this.targets.get(`${target.targetId}:${target.targetGeneration}`);
      if (!live || !live.current())
        throw Error("Publication target lacks a live authorized owner.");
      const work = await this.work({
        contractRef: "yuvi.publication.v1",
        logicalKey: targetPublicationKey({ ...input, target }),
        operation: "reply-component",
        digest: input.textDigest,
        configurationRef: "runtime-text.v1",
        snapshotReference: input.componentId,
        scope: `session:${input.message.sessionId}`,
        cause: context?.cause ?? input.message.sourceJournalRef ?? undefined,
        executionId: context?.executionId ?? input.message.traceId,
        replyId: input.replyId,
        target: {
          surface: target.surface,
          recipient: target.targetId,
          generation: target.targetGeneration
        },
        isCurrent: live.current
      });
      const authority = {
        snapshot: {
          policyVersion: "yuvi-publication-policy.v1",
          authorityVersion: target.targetGeneration,
          scope: work.request.scope,
          identity: work.identity,
          permissions: ["HOST_TARGET_PUBLICATION"],
          allowed: true
        },
        isCurrent: work.isCurrent
      };
      if (!client || !(this.admission instanceof HostEffectIntentAdmission) || !this.journal)
        throw Error("Atomic durable component/publication admission is unavailable.");
      const receipt = await this.journal.get(work.request.causalRefs[0]!);
      if (!receipt) throw Error("Publication cause unavailable.");
      const intent = await this.admission.admitWithExactReceiptInTransaction(
        work.request,
        authority,
        receipt,
        client
      );
      if (intent.decision !== "ADMITTED") throw Error("Publication admission denied.");
    }
    return () => {
      if (!context?.cause || !this.accepting) return;
      for (const [reply, entry] of this.replies)
        if (entry.sessionId === input.message.sessionId && reply !== input.replyId)
          this.replies.delete(reply);
      if (this.replies.size >= 512 && !this.replies.has(input.replyId))
        this.replies.delete(this.replies.keys().next().value!);
      this.replies.set(input.replyId, {
        cause: context.cause,
        requestId: context.speechRequestId,
        sessionId: input.message.sessionId
      });
    };
  };
  async publish(input: {
    target: ReplyPublicationTarget;
    frameId: string;
    payload: unknown;
    write: () => Promise<void>;
    scope?: string | undefined;
    cause?: JournalEventRef | undefined;
    replyId?: string | undefined;
    componentId?: string | undefined;
  }): Promise<void> {
    const live = this.targets.get(`${input.target.targetId}:${input.target.targetGeneration}`);
    if (!this.accepting || !live?.current())
      throw Error("Publication target is no longer current.");
    let work: Work;
    let admitted: EffectIntent | undefined;
    if (input.replyId && input.componentId) {
      const id = effectIntentId(
        "yuvi.publication.v1",
        targetPublicationKey({
          replyId: input.replyId,
          componentId: input.componentId,
          target: input.target
        })
      );
      const intent = await this.admission.get(id);
      if (!intent || intent.decision !== "ADMITTED")
        throw Error("Component publication was not atomically admitted.");
      admitted = intent;
      const body = input.payload as { text?: string; reply?: string };
      const text = body?.text ?? body?.reply;
      const descriptor = intent.request.payload as { inputSnapshot: { digest: string } };
      if (
        typeof text !== "string" ||
        createHash("sha256").update(text).digest("hex") !== descriptor.inputSnapshot.digest
      )
        throw Error("Component publication payload conflict.");
      work = {
        request: intent.request as Work["request"],
        identity: intent.authorization.identity,
        isCurrent: () => this.accepting && live.current()
      };
    } else {
      work = await this.work({
        contractRef: "yuvi.publication.v1",
        logicalKey: targetPublicationKey({
          replyId: input.replyId ?? input.frameId,
          componentId: input.frameId,
          target: input.target
        }),
        operation: "target-frame",
        digest: effectDigest(input.payload),
        configurationRef: "target-frame.v1",
        scope: input.scope ?? "target-publication",
        cause: input.cause,
        replyId: input.replyId,
        target: {
          surface: input.target.surface,
          recipient: input.target.targetId,
          generation: input.target.targetGeneration
        },
        isCurrent: live.current
      });
    }
    const previous = await this.dispatcher?.diagnostic(
      effectIntentId(work.request.contractRef, work.request.logicalKey)
    );
    if (previous?.certainty === "APPLIED") return;
    if (previous?.currentAttempt?.dispatchStartedAt)
      throw Error("Ambiguous target publication cannot be resent.");
    const accepted = await this.execute(
      work,
      async () => {
        try {
          await input.write();
          return {
            evidence: {
              certainty: "APPLIED",
              layer: "LOCAL_GATEWAY_WRITE_ACCEPTED",
              reason: "RETURNED",
              remoteEffectId: null
            },
            transientResult: true
          };
        } catch {
          return { evidence: protocolEvidence("CALL_UNCERTAIN", true) };
        }
      },
      undefined,
      admitted
    );
    if (accepted !== true) throw Error("Target write is ambiguous.");
  }

  private readonly contextUse: HostContextUse;
  setContextUseRepository(repository: PostgresContextUseRepository | null) {
    this.contextUse.setRepository(repository);
  }

  constructor(
    private readonly admission: EffectIntentAdmissionPort,
    readonly store: EffectDispatchStore | null,
    readonly dispatcher: EffectDispatcher | null,
    private readonly journal: JournalRepository | null,
    private readonly namespace: string
  ) {
    this.contextUse = new HostContextUse(journal, namespace);
    for (const contractRef of [
      "yuvi.provider.v1",
      "yuvi.publication.v1",
      "yuvi.playback.v1",
      "yuvi.embodied-presentation.v1"
    ] as const) {
      dispatcher?.registerAdapter({
        contractRef,
        adapter: EFFECT_DELIVERY_CONTRACTS[contractRef].adapter,
        isCurrent: (i) => this.accepting && this.grants.get(i.intentId)?.work.isCurrent() === true,
        invoke: async (i, a, signal) => {
          const grant = this.grants.get(i.intentId);
          if (!grant || !this.accepting || !grant.work.isCurrent())
            return Promise.resolve({ evidence: protocolEvidence("AUTHORITY_REVOKED", false) });
          if (grant.work.verifyContext && !(await grant.work.verifyContext()))
            return { evidence: protocolEvidence("AUTHORITY_REVOKED", false) };
          return grant.invoke(a, signal);
        },
        ...(contractRef === "yuvi.playback.v1"
          ? {
              reconcile: async (i: EffectIntent, a: EffectAttemptV1, signal: AbortSignal) =>
                (await this.grants.get(i.intentId)?.invoke(a, signal))?.evidence ??
                protocolEvidence("RECONCILIATION_UNSUPPORTED", true)
            }
          : {})
      });
    }
  }
  seal() {
    this.accepting = false;
  }
  async operationCause(operation: string, scope: string): Promise<JournalEventRef> {
    if (!this.accepting || !this.journal) throw Error("Durable outward accounting unavailable.");
    const receipt = await this.journal.appendWithHostAuthority(
      {
        command: {
          version: "life-event-command.v1",
          kind: "RECEIPT",
          occurrenceTime: { state: "UNKNOWN" },
          causalParents: [],
          data: { receiptClass: "CONTROL", evidenceSelectors: [] }
        }
      },
      {
        principal: {
          state: "UNRESOLVED",
          reason: "host operation does not authenticate a human principal"
        },
        subjects: [],
        binding: { state: "UNRESOLVED", reason: "no Person binding for this host operation" },
        audience: { kind: "UNKNOWN", reason: "no recipient membership snapshot" },
        disclosurePolicy: { state: "UNRESOLVED", reason: "no disclosure policy snapshot" },
        surface: { kind: "LOCAL", reference: `yuvi:operation:${operation}` },
        correlations: [{ kind: "CONVERSATION", sessionId: scope }],
        policyVersion: "yuvi-outward-operation.v1",
        producer: { name: "yuvi-host-operation", version: "0.1.3-a9.3" },
        sourceReferences: [
          {
            kind: "UNRESOLVED_SOURCE",
            reason: "host operation has no authenticated transport source identity"
          }
        ],
        payloads: []
      }
    );
    return {
      kind: "JOURNAL_EVENT",
      namespace: receipt.envelope.journalNamespace,
      eventId: receipt.envelope.eventId
    };
  }
  async work(input: {
    contextManifest?: { manifestId: string; exposureId: string } | undefined;
    contractRef:
      | "yuvi.provider.v1"
      | "yuvi.publication.v1"
      | "yuvi.playback.v1"
      | "yuvi.embodied-presentation.v1";
    payload?: unknown;
    snapshotReference?: string;
    logicalKey: string;
    operation: string;
    digest: string;
    configurationRef: string;
    scope: string;
    cause?: JournalEventRef | undefined;
    executionId?: string | undefined;
    replyId?: string | undefined;
    target?: { surface: string; recipient: string; generation: string } | undefined;
    routingPlan?: { provider: string; model: string | null }[] | undefined;
    isCurrent?: (() => boolean) | undefined;
  }): Promise<Work> {
    if (!this.accepting || !this.store || !this.dispatcher || !this.journal)
      throw Error("Durable outward accounting unavailable.");
    const existing = await this.admission.get(effectIntentId(input.contractRef, input.logicalKey));
    const cause =
      input.cause ??
      existing?.request.causalRefs[0] ??
      (await this.operationCause(input.operation, input.scope));
    const receipt = await this.journal.get(cause);
    if (!receipt) throw Error("Committed outward cause unavailable.");
    const { principal, subjects, binding, audience, disclosurePolicy } = receipt.authority;
    const identity = EffectIdentitySnapshotSchema.parse({
      principal,
      subjects,
      binding,
      audience,
      disclosurePolicy
    });
    const work: Work = {
      identity,
      isCurrent: () => this.accepting && (input.isCurrent?.() ?? true),
      request: {
        contractRef: input.contractRef,
        logicalKey: input.logicalKey,
        scope: input.scope,
        audience: identity.audience,
        causalRefs: [cause],
        executionId: input.executionId ?? null,
        expiresAt: existing?.request.expiresAt ?? new Date(Date.now() + 300_000).toISOString(),
        payload: input.payload ?? {
          version: "outward-work-descriptor.v1",
          operation: input.operation,
          inputSnapshot: {
            version: "a9-input-snapshot.v1",
            digest: input.digest,
            availability: input.snapshotReference ? "RETAINED_REFERENCE" : "TRANSIENT",
            reference: input.snapshotReference ?? null,
            manifest: input.contextManifest ?? "A10_3_NOT_IMPLEMENTED"
          },
          configurationRef: input.configurationRef,
          relatedReply: input.replyId ?? null,
          target: input.target ?? null,
          routingPlan: input.routingPlan ?? []
        }
      }
    };
    if (
      existing &&
      requestEffectDigest(freezeEffectRequest(work.request)) !== existing.payloadDigest
    )
      throw Error("Outward identity conflicts with its frozen descriptor.");
    return work;
  }
  async execute(
    work: Work,
    invoke: Grant["invoke"],
    beforeDispatch?: (intent: EffectIntent) => Promise<void>,
    admitted?: EffectIntent
  ): Promise<unknown> {
    if (!this.accepting || !this.dispatcher) throw Error("Outward work is sealed.");
    const id = effectIntentId(work.request.contractRef, work.request.logicalKey);
    if (this.grants.has(id)) throw Error("Outward task already has an active invocation owner.");
    this.grants.set(id, { work, invoke });
    try {
      // Components already committed their canonical admission in the projection transaction.
      const intent =
        admitted ??
        (await this.admission.admit(work.request, {
          snapshot: {
            policyVersion: "yuvi-outward-policy.v1",
            authorityVersion: work.request.executionId ?? "host-operation",
            scope: work.request.scope,
            identity: work.identity,
            permissions: [EFFECT_CONTRACTS[work.request.contractRef].permission],
            allowed: true
          },
          isCurrent: work.isCurrent
        }));
      if (intent.decision !== "ADMITTED" || intent.intentId !== id)
        throw Error("Outward work was denied.");
      await beforeDispatch?.(intent);
      const result = await this.dispatcher.run(intent.intentId);
      if (!result.recorded || !work.isCurrent())
        throw Error("Outward observation unavailable or stale.");
      return result.transientResult;
    } finally {
      this.grants.delete(id);
    }
  }
  private async providerWork(task: ProviderTaskDescriptor, signal?: AbortSignal): Promise<Work> {
    const contextManifest = await this.contextUse.capture(task);
    let work = this.tasks.get(task.operationId);
    if (
      work &&
      ((work.request.payload as { inputSnapshot: { digest: string }; configurationRef: string })
        .inputSnapshot.digest !== task.inputDigest ||
        (work.request.payload as { configurationRef: string }).configurationRef !==
          task.configurationRef)
    )
      throw Error("Frozen provider task input conflict.");
    if (
      work &&
      JSON.stringify(
        (work.request.payload as { inputSnapshot: { manifest: unknown } }).inputSnapshot.manifest
      ) !== JSON.stringify(contextManifest)
    )
      throw Error("Provider operation changed historical context identity.");
    if (!work) {
      if (this.tasks.size >= 128) this.tasks.delete(this.tasks.keys().next().value!);
      const context = task.context;
      work = await this.work({
        contextManifest,
        contractRef: "yuvi.provider.v1",
        logicalKey: `yuvi.provider.v1:${this.namespace}:${task.operationId}`,
        operation: task.operation,
        digest: task.inputDigest,
        configurationRef: task.configurationRef,
        routingPlan: task.routingPlan,
        scope: context?.scope ?? "host-provider-operation",
        cause: context?.cause,
        executionId: context?.executionId,
        replyId: context?.replyId,
        isCurrent: () => !signal?.aborted && (context?.isCurrent?.() ?? true)
      });
      work.verifyContext = task.contextUse?.verifyCurrent;
      this.tasks.set(task.operationId, work);
    }
    return work;
  }
  async captureOperationContext(operationId: string, operation: string, input: unknown) {
    const context = currentProviderWorkContext();
    return this.contextUse.capture({
      operationId,
      operation,
      inputDigest: providerInputDigest(input),
      configurationRef: "host-capability.v1",
      routingPlan: [],
      context,
      contextUse: context?.contextUse,
      assemblyOrdinal: String(context?.assemblyOrdinal ?? 1),
      exposure: describeExposure(input, context?.contextUse)
    });
  }

  private uncertain(leaf: ProviderLeafDescriptor): ProviderError {
    return new ProviderError({
      provider: leaf.provider,
      capability:
        leaf.method === "synthesizeSpeech"
          ? "tts"
          : leaf.method === "transcribeAudio" || leaf.method === "detectVoiceActivity"
            ? "stt"
            : leaf.method === "analyzeImage"
              ? "vision"
              : leaf.method.startsWith("embed")
                ? "embedding"
                : leaf.method === "generateReasoning"
                  ? "reasoning"
                  : "chat",
      code: ProviderErrorCode.ProviderUnavailable,
      message: "Provider observation is unavailable or ambiguous.",
      effectState: "unknown",
      fallbackEligible: false,
      retryable: false
    });
  }
  async invoke<T>(
    task: ProviderTaskDescriptor,
    leaf: ProviderLeafDescriptor,
    call: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const work = await this.providerWork(task, signal);
    let noEffectError: unknown, observedError: unknown;
    try {
      const result = await this.execute(work, async (a, dispatchSignal) => {
        await this.fact(a, {
          factKey: "provider-leaf",
          kind: "PROVIDER_LEAF",
          reference: leaf.provider,
          digest: effectDigest(leaf),
          generation: task.configurationRef
        });
        try {
          const raw = await call(
            signal ? AbortSignal.any([dispatchSignal, signal]) : dispatchSignal
          );
          const value =
            raw && typeof raw === "object" && !Array.isArray(raw)
              ? { ...raw, sourceAttemptId: a.attemptId }
              : raw;
          return {
            evidence: {
              certainty: "APPLIED",
              layer: "PROVIDER_RESPONSE",
              reason: "RETURNED",
              remoteEffectId: null
            },
            transientResult: value
          };
        } catch (error) {
          if (isCertifiedProviderNotStarted(error)) {
            noEffectError = error;
            return {
              evidence: {
                certainty: "PROVEN_NOT_APPLIED",
                layer: "PROVIDER_PRE_TRANSPORT",
                reason: "HOST_CERTIFIED_NOT_STARTED",
                remoteEffectId: null
              }
            };
          }
          if (isProviderResponseObservedError(error)) {
            observedError =
              error instanceof ProviderError
                ? cloneProviderError(error, {
                    effectState: "committed",
                    fallbackEligible: false,
                    retryable: false
                  })
                : error;
            return {
              evidence: {
                certainty: "APPLIED",
                layer: "PROVIDER_RESPONSE",
                reason: "RETURNED",
                remoteEffectId: null
              }
            };
          }
          return { evidence: protocolEvidence("CALL_UNCERTAIN", true) };
        }
      });
      if (noEffectError) throw noEffectError;
      if (observedError) {
        this.tasks.delete(task.operationId);
        throw observedError;
      }
      if (result === undefined) throw this.uncertain(leaf);
      this.tasks.delete(task.operationId);
      return result as T;
    } catch (error) {
      if (observedError === error) throw error;
      if (isCertifiedProviderNotStarted(error)) throw error;
      this.tasks.delete(task.operationId);
      throw this.uncertain(leaf);
    }
  }
  async *stream<T>(
    task: ProviderTaskDescriptor,
    leaf: ProviderLeafDescriptor,
    call: (signal?: AbortSignal) => AsyncIterable<T>,
    signal?: AbortSignal
  ): AsyncIterable<T> {
    const work = await this.providerWork(task, signal);
    // One unconsumed event at most; the Runtime controls its projection/persistence pace.
    let next: { value: T; consumed: () => void } | undefined;
    let wake: (() => void) | undefined;
    let done = false,
      error: unknown,
      completion: T | undefined;
    const local = new AbortController();
    const running = this.execute(work, async (a, dispatchSignal) => {
      await this.fact(a, {
        factKey: "provider-leaf",
        kind: "PROVIDER_LEAF",
        reference: leaf.provider,
        digest: effectDigest(leaf),
        generation: task.configurationRef
      });
      try {
        for await (const raw of call(
          AbortSignal.any([local.signal, dispatchSignal, ...(signal ? [signal] : [])])
        )) {
          const value = (
            raw && typeof raw === "object"
              ? {
                  ...raw,
                  sourceAttemptId: a.attemptId,
                  ...((raw as { type?: string; output?: object }).type === "completed"
                    ? {
                        output: {
                          ...(raw as unknown as { output: object }).output,
                          sourceAttemptId: a.attemptId
                        }
                      }
                    : {})
                }
              : raw
          ) as T;
          if (local.signal.aborted || signal?.aborted || !work.isCurrent())
            throw Error("Stale provider stream.");
          if ((value as { type?: string })?.type === "completed") {
            completion = value;
            continue;
          }
          await new Promise<void>((resolve) => {
            next = { value, consumed: resolve };
            wake?.();
          });
        }
        if (completion === undefined) throw Error("Provider stream lacks completion.");
        return {
          evidence: {
            certainty: "APPLIED",
            layer: "PROVIDER_RESPONSE",
            reason: "RETURNED",
            remoteEffectId: null
          },
          transientResult: completion
        };
      } catch (e) {
        if (isCertifiedProviderNotStarted(e)) {
          error = e;
          return {
            evidence: {
              certainty: "PROVEN_NOT_APPLIED",
              layer: "PROVIDER_PRE_TRANSPORT",
              reason: "HOST_CERTIFIED_NOT_STARTED",
              remoteEffectId: null
            }
          };
        }
        error = this.uncertain(leaf);
        return { evidence: protocolEvidence("CALL_UNCERTAIN", true) };
      }
    })
      .then(
        (result) => {
          if (!error && result === undefined) error = this.uncertain(leaf);
        },
        () => {
          error = this.uncertain(leaf);
        }
      )
      .finally(() => {
        done = true;
        wake?.();
      });
    try {
      while (!done || next) {
        if (next) {
          const item = next;
          next = undefined;
          try {
            yield item.value;
          } finally {
            item.consumed();
          }
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      await running;
      if (error) throw error;
      if (completion !== undefined) yield completion;
    } finally {
      local.abort();
      next?.consumed();
      if (!isCertifiedProviderNotStarted(error)) this.tasks.delete(task.operationId);
    }
  }
  async fact(attempt: EffectAttemptV1, fact: EffectProgressFact) {
    if (!this.accepting) throw Error("Outward observations are sealed.");
    const result = await this.store?.progress?.(attempt, fact);
    if (result !== "RECORDED" && result !== "REPLAY")
      throw Error("Outward progress was not committed under the current fence.");
  }
}

export function targetPublicationKey(input: {
  replyId: string;
  componentId: string;
  target: { surface: string; targetId: string; targetGeneration: string };
}): string {
  return `yuvi.publication.v1:${effectDigest([input.replyId, input.componentId, input.target.surface, input.target.targetId, input.target.targetGeneration])}`;
}
