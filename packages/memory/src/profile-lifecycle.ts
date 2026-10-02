import {
  PROFILE_MATERIALIZER_VERSION,
  PROFILE_VERSION,
  ProfileSubjectV1Schema,
  profileSubjectKey,
  profileSourceSetDigest,
  validateProfileSnapshot,
  type ProfileGenerationOutcome,
  type ProfileMemorySourceReader,
  type ProfileProvider,
  type ProfileSnapshotV1,
  type ProfileSourceReadOutcome,
  type ProfileSubjectV1
} from "./profile-types.js";
import { canonicalLineageJson } from "./lineage-encoding.js";
import { canonicalizeProfileEvidenceSource } from "./profile-materializer.js";
import {
  profileLifecycleStatus,
  type ProfileBackend,
  type ProfileLifecycleClaim,
  type ProfileLifecycleError,
  type ProfileLifecycleRow,
  type ProfileLifecycleStore,
  type ProfileSourceReadState,
  type ScopeProfileStatus
} from "./profile-lifecycle-store.js";

export type CapturedProfileComposition = {
  reader: ProfileMemorySourceReader;
  provider: ProfileProvider;
  backend: ProfileBackend;
  compositionToken: object;
};

export type ScopeModelProjection = {
  version: "yuvi-people-scope-model.v1";
  subject: ProfileSubjectV1;
  profileRevision: string;
  snapshot: ProfileSnapshotV1;
  personBinding: { state: "UNBOUND_SCOPE" };
  freshness: {
    state: "VERIFIED_AT_SOURCE_READ";
    subjectKey: string;
    profileRevision: string;
    sourceSetDigest: string;
    backend: ProfileBackend;
    controlVersion: string;
    materializerVersion: typeof PROFILE_MATERIALIZER_VERSION;
    asOf: string;
    completeness: "COMPLETE";
  };
};
export type ScopeModelReadOutcome =
  | { state: "AVAILABLE" | "EMPTY"; model: ScopeModelProjection; status: ScopeProfileStatus }
  | {
      state: "NOT_FOUND" | "WITHHELD" | "PARTIAL" | "UNAVAILABLE" | "FAILED";
      model: null;
      status: ScopeProfileStatus;
      code: ProfileLifecycleError | null;
    };
export type PersonModelReadFailure = {
  state: "UNAVAILABLE";
  model: null;
  code: "BINDING_AUTHORITY_UNAVAILABLE";
};

type LifecycleLogger = { warn?(message: string, context?: Record<string, unknown>): void };

const AUDIT_INTERVAL_MS = 30_000;
const AUDIT_BATCH_SIZE = 100;
const WORKER_POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const MAX_ATTEMPT_MS = 120_000;

export class ProfileLifecycleCoordinator {
  private composition: CapturedProfileComposition | null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickPromise: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;
  private activeClaim: ProfileLifecycleClaim | null = null;
  private stopped = false;
  private started = false;
  private lastAuditAt = 0;
  private auditCursor: string | null = null;
  private auditRows: ProfileLifecycleRow[] = [];
  private auditIndex = 0;
  private preferAudit = false;
  private compositionGate: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ProfileLifecycleStore,
    private readonly logger?: LifecycleLogger,
    composition: CapturedProfileComposition | null = null,
    private readonly now: () => Date = () => new Date()
  ) {
    this.composition = composition;
  }

  async requestGeneration(input: { subject: ProfileSubjectV1 }): Promise<ScopeProfileStatus> {
    const subject = ProfileSubjectV1Schema.parse(input.subject);
    const row = await this.store.requestGeneration(subject, "EXPLICIT_REQUEST");
    this.wake();
    return profileLifecycleStatus(row, this.now());
  }

  async invalidateScope(input: {
    scope: string;
    reason: Parameters<ProfileLifecycleStore["invalidateScope"]>[1];
  }): Promise<void> {
    await this.store.invalidateScope(input.scope, input.reason);
    this.wake();
  }

  async getStatus(input: { subject: ProfileSubjectV1 }): Promise<ScopeProfileStatus> {
    const subject = ProfileSubjectV1Schema.parse(input.subject);
    const row = await this.store.enroll(subject);
    return profileLifecycleStatus(row, this.now());
  }

  async readScopeModel(input: {
    subject: ProfileSubjectV1;
    readMemory: boolean;
    signal?: AbortSignal;
  }): Promise<ScopeModelReadOutcome> {
    const subject = ProfileSubjectV1Schema.parse(input.subject);
    let row: ProfileLifecycleRow;
    try {
      row = await this.store.enroll(subject);
    } catch {
      return {
        state: "UNAVAILABLE",
        model: null,
        status: unavailableStatus(subject),
        code: "STORE_UNAVAILABLE"
      };
    }
    if (!input.readMemory) return unavailable(row, "MEMORY_DISABLED", this.now());
    const handle = this.composition;
    if (!handle) return unavailable(row, "MEMORY_DISABLED", this.now());
    if (input.signal?.aborted) return unavailable(row, "CANCELLED", this.now());

    if (!row.candidateRevision) {
      this.wake();
      return {
        state: "NOT_FOUND",
        model: null,
        status: profileLifecycleStatus(row, this.now()),
        code: "NO_CANDIDATE"
      };
    }
    if (
      row.regenerationNeeded ||
      row.lastError !== null ||
      hasLiveLease(row, this.now()) ||
      row.candidateVersion !== row.controlVersion
    ) {
      return {
        state: "WITHHELD",
        model: null,
        status: profileLifecycleStatus(row, this.now()),
        code: row.lastError ?? "REGENERATION_REQUIRED"
      };
    }

    let historical: Awaited<ReturnType<ProfileProvider["getProfile"]>>;
    try {
      historical = await handle.provider.getProfile({
        subject,
        profileRevision: row.candidateRevision,
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch {
      await this.store
        .observeFailure(row.subjectKey, "ERROR", "STORE_ERROR")
        .catch(() => undefined);
      return failed(row, "STORE_ERROR", this.now());
    }
    if (historical.state === "NOT_FOUND" || !historical.snapshot) {
      const error =
        historical.state === "FAILED" || historical.state === "UNAVAILABLE"
          ? mapFailure(historical.code)
          : "NO_CANDIDATE";
      await this.store.observeFailure(row.subjectKey, "ERROR", error).catch(() => undefined);
      return historical.state === "UNAVAILABLE"
        ? unavailable(row, error, this.now())
        : failed(row, error, this.now());
    }
    let snapshot: ProfileSnapshotV1;
    try {
      snapshot = validateProfileSnapshot(historical.snapshot);
    } catch {
      await this.store
        .observeFailure(row.subjectKey, "ERROR", "STORE_ERROR")
        .catch(() => undefined);
      return failed(row, "STORE_ERROR", this.now());
    }
    if (
      snapshot.profileRevision !== row.candidateRevision ||
      canonicalLineageJson(snapshot.subject) !== canonicalLineageJson(subject) ||
      snapshot.producer.materializerVersion !== PROFILE_MATERIALIZER_VERSION ||
      snapshot.sourceSet.backend !== row.candidateBackend
    ) {
      await this.store
        .observeFailure(row.subjectKey, "ERROR", "STORE_ERROR")
        .catch(() => undefined);
      return failed(row, "STORE_ERROR", this.now());
    }

    if (this.composition !== handle || input.signal?.aborted)
      return unavailable(
        row,
        input.signal?.aborted ? "CANCELLED" : "COMPOSITION_CHANGED",
        this.now()
      );
    const liveAsOf = this.now().toISOString();
    let live: ProfileSourceReadOutcome;
    try {
      live = await handle.reader.listEligibleSources({
        subject,
        asOf: liveAsOf,
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch {
      live = nullOutcome(input.signal?.aborted ? "UNAVAILABLE" : "ERROR", handle.backend, liveAsOf);
    }
    if (live.state !== "COMPLETE") {
      const error = sourceError(live);
      await this.store
        .observeFailure(row.subjectKey, sourceState(live.state), error)
        .catch(() => undefined);
      let latest: ProfileLifecycleRow | null = null;
      try {
        latest = await this.store.getByKey(row.subjectKey);
      } catch {
        /* fail closed with the observed row */
      }
      return {
        state:
          live.state === "PARTIAL"
            ? "PARTIAL"
            : live.state === "UNAVAILABLE"
              ? "UNAVAILABLE"
              : "FAILED",
        model: null,
        status: profileLifecycleStatus(latest ?? row, this.now()),
        code: error
      };
    }
    let digest: string;
    try {
      digest = digestCompleteRead(live);
    } catch {
      await this.store
        .observeFailure(row.subjectKey, "ERROR", "SOURCE_ERROR")
        .catch(() => undefined);
      return failed(row, "SOURCE_ERROR", this.now());
    }

    if (
      row.candidateVersion !== row.controlVersion ||
      row.candidateDigest !== snapshot.sourceSet.sourceSetDigest ||
      digest !== row.candidateDigest ||
      digest !== snapshot.sourceSet.sourceSetDigest ||
      row.candidateBackend !== handle.backend ||
      live.backend !== handle.backend
    ) {
      let observed: ProfileLifecycleRow | null = null;
      try {
        observed = await this.store.observeComplete(
          row.subjectKey,
          live.backend ?? handle.backend,
          digest
        );
      } catch {
        /* the mismatch still withholds content */
      }
      if (!observed || observed.controlVersion === row.controlVersion) {
        await this.store.requestGeneration(subject, "SOURCE_SET_CHANGED").catch(() => undefined);
      }
      this.wake();
      let current: ProfileLifecycleRow | null = null;
      try {
        current = await this.store.getByKey(row.subjectKey);
      } catch {
        /* return without model */
      }
      return {
        state: "WITHHELD",
        model: null,
        status: profileLifecycleStatus(current ?? observed ?? row, this.now()),
        code: "SOURCE_CHANGED"
      };
    }

    const finalRow = await this.store.getByKey(row.subjectKey).catch(() => null);
    if (
      !finalRow ||
      finalRow.controlVersion !== row.controlVersion ||
      finalRow.candidateRevision !== row.candidateRevision ||
      finalRow.candidateVersion !== row.candidateVersion ||
      finalRow.regenerationNeeded ||
      finalRow.lastError !== null ||
      hasLiveLease(finalRow, this.now())
    ) {
      return {
        state: "WITHHELD",
        model: null,
        status: profileLifecycleStatus(finalRow ?? row, this.now()),
        code: "FENCE_LOST"
      };
    }
    if (this.composition !== handle || input.signal?.aborted)
      return unavailable(
        finalRow,
        input.signal?.aborted ? "CANCELLED" : "COMPOSITION_CHANGED",
        this.now()
      );
    if (sourceValidityExpired(snapshot, liveAsOf, this.now())) {
      await this.store.requestGeneration(subject, "SOURCE_SET_CHANGED").catch(() => undefined);
      this.wake();
      let latest: ProfileLifecycleRow | null = null;
      try {
        latest = await this.store.getByKey(row.subjectKey);
      } catch {
        /* return without model */
      }
      return {
        state: "WITHHELD",
        model: null,
        status: profileLifecycleStatus(latest ?? finalRow, this.now()),
        code: "SOURCE_CHANGED"
      };
    }

    // This is deliberately the final local fence. No awaited operation follows it.
    if (this.composition !== handle || input.signal?.aborted)
      return unavailable(
        finalRow,
        input.signal?.aborted ? "CANCELLED" : "COMPOSITION_CHANGED",
        this.now()
      );
    const status = profileLifecycleStatus(finalRow, this.now(), true);
    const model: ScopeModelProjection = {
      version: "yuvi-people-scope-model.v1",
      subject: structuredClone(subject),
      profileRevision: snapshot.profileRevision,
      snapshot: structuredClone(snapshot),
      personBinding: { state: "UNBOUND_SCOPE" },
      freshness: {
        state: "VERIFIED_AT_SOURCE_READ",
        subjectKey: row.subjectKey,
        profileRevision: snapshot.profileRevision,
        sourceSetDigest: digest,
        backend: handle.backend,
        controlVersion: finalRow.controlVersion,
        materializerVersion: PROFILE_MATERIALIZER_VERSION,
        asOf: liveAsOf,
        completeness: "COMPLETE"
      }
    };
    return {
      state: snapshot.generationState === "INSUFFICIENT_EVIDENCE" ? "EMPTY" : "AVAILABLE",
      model,
      status
    };
  }

  readPersonModel(): PersonModelReadFailure {
    return { state: "UNAVAILABLE", model: null, code: "BINDING_AUTHORITY_UNAVAILABLE" };
  }

  async replaceComposition(
    next: CapturedProfileComposition | null,
    activate?: () => void
  ): Promise<void> {
    await this.withCompositionGate(async () => {
      const previous = this.composition;
      this.composition = next;
      activate?.();
      if (previous !== next) this.activeAbort?.abort();
    });
    if (this.started) {
      let cursor: string | null = null;
      while (true) {
        const page = await this.store.listAuditPage(cursor, AUDIT_BATCH_SIZE);
        if (!page.length) break;
        for (const row of page)
          await this.store.requestGeneration(row.subject, "SOURCE_SELECTION_CHANGED");
        cursor = page.at(-1)!.subjectKey;
        if (page.length < AUDIT_BATCH_SIZE) break;
      }
    }
    this.wake();
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.recheckStartup()
      .then(() => this.schedule())
      .catch((error) => {
        this.logger?.warn?.("Profile lifecycle startup recheck failed.", {
          errorClass: safeErrorClass(error)
        });
        this.schedule();
      });
  }

  async shutdown(input: { graceMs: 2_000 }): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.activeAbort?.abort();
    const draining = this.tickPromise;
    if (draining)
      await Promise.race([draining, delay(Math.min(2_000, Math.max(0, input.graceMs)))]);
    if (this.activeClaim) await this.store.release(this.activeClaim).catch(() => undefined);
    this.activeClaim = null;
  }

  private wake(): void {
    if (this.started && !this.stopped && !this.tickPromise) void this.tick();
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, WORKER_POLL_MS);
    this.timer.unref?.();
    void this.tick();
  }

  private async recheckStartup(): Promise<void> {
    let cursor: string | null = null;
    while (!this.stopped) {
      const result = await this.store.startupRecheckBatch(cursor, AUDIT_BATCH_SIZE);
      if (!result.count || !result.lastSubjectKey) return;
      cursor = result.lastSubjectKey;
      if (result.count < AUDIT_BATCH_SIZE) return;
    }
  }

  private async tick(): Promise<void> {
    if (this.tickPromise || this.stopped) return;
    this.tickPromise = this.runTick()
      .catch((error) => {
        this.logger?.warn?.("Profile lifecycle worker tick failed.", {
          errorClass: safeErrorClass(error)
        });
      })
      .finally(() => {
        this.tickPromise = null;
      });
    await this.tickPromise;
  }

  private async runTick(): Promise<void> {
    const now = this.now().getTime();
    if (now - this.lastAuditAt >= AUDIT_INTERVAL_MS && this.auditRows.length === 0) {
      this.lastAuditAt = now;
      this.auditCursor = null;
      this.auditIndex = 0;
      this.auditRows = await this.store.listAuditPage(null, AUDIT_BATCH_SIZE);
      this.preferAudit = true;
    }
    if (this.preferAudit && this.auditRows.length > 0) {
      await this.auditOne();
      this.preferAudit = false;
      return;
    }
    const claim = await this.store.claimDue();
    if (claim) {
      await this.runClaim(claim);
      this.preferAudit = true;
      return;
    }
    if (this.auditRows.length > 0) await this.auditOne();
  }

  private async auditOne(): Promise<void> {
    if (this.auditIndex >= this.auditRows.length) {
      this.auditCursor = this.auditRows.at(-1)?.subjectKey ?? this.auditCursor;
      const page = await this.store.listAuditPage(this.auditCursor, AUDIT_BATCH_SIZE);
      this.auditRows = page;
      this.auditIndex = 0;
      if (!page.length) {
        this.auditCursor = null;
        return;
      }
    }
    const row = this.auditRows[this.auditIndex++]!;
    const handle = this.composition;
    if (!handle || this.stopped) return;
    const asOf = this.now().toISOString();
    let result: ProfileSourceReadOutcome;
    try {
      result = await handle.reader.listEligibleSources({ subject: row.subject, asOf });
    } catch {
      result = nullOutcome("ERROR", handle.backend, asOf);
    }
    if (this.composition !== handle || this.stopped) return;
    if (result.state === "COMPLETE") {
      try {
        await this.store.observeComplete(
          row.subjectKey,
          result.backend ?? handle.backend,
          digestCompleteRead(result)
        );
      } catch (error) {
        this.logger?.warn?.("Profile lifecycle audit observation failed.", {
          subjectKey: row.subjectKey,
          errorClass: safeErrorClass(error)
        });
      }
    } else {
      await this.store
        .observeFailure(row.subjectKey, sourceState(result.state), sourceError(result))
        .catch((error) =>
          this.logger?.warn?.("Profile lifecycle audit failure could not be recorded.", {
            subjectKey: row.subjectKey,
            errorClass: safeErrorClass(error)
          })
        );
    }
  }

  private async runClaim(claim: ProfileLifecycleClaim): Promise<void> {
    this.activeClaim = claim;
    const handle = this.composition;
    if (!handle) {
      await this.store.failAttempt(claim, "MEMORY_DISABLED", "UNAVAILABLE");
      this.activeClaim = null;
      return;
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    let heartbeatLost = false;
    const heartbeat = setInterval(() => {
      void this.store
        .renew(claim)
        .then((ok) => {
          if (!ok) {
            heartbeatLost = true;
            abort.abort();
          }
        })
        .catch(() => {
          heartbeatLost = true;
          abort.abort();
        });
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        abort.abort();
        reject(new AttemptTimeoutError());
      }, MAX_ATTEMPT_MS);
      deadlineTimer.unref?.();
    });
    try {
      const work = this.certifyClaim(claim, handle, abort.signal, () => heartbeatLost);
      await Promise.race([work, deadline]);
    } catch (error) {
      if (heartbeatLost) await this.store.failAttempt(claim, "FENCE_LOST").catch(() => undefined);
      else if (abort.signal.aborted || error instanceof AttemptTimeoutError)
        await this.store
          .failAttempt(
            claim,
            error instanceof AttemptTimeoutError ? "SOURCE_UNAVAILABLE" : "CANCELLED",
            "UNAVAILABLE"
          )
          .catch(() => undefined);
      else await this.store.failAttempt(claim, mapThrownError(error)).catch(() => undefined);
      this.logger?.warn?.("Profile lifecycle attempt failed.", {
        subjectKey: claim.row.subjectKey,
        controlVersion: claim.version,
        leaseFence: claim.fence,
        errorClass: safeErrorClass(error)
      });
    } finally {
      clearInterval(heartbeat);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (this.activeClaim === claim) this.activeClaim = null;
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  private async certifyClaim(
    claim: ProfileLifecycleClaim,
    handle: CapturedProfileComposition,
    signal: AbortSignal,
    heartbeatLost: () => boolean
  ): Promise<void> {
    const subject = claim.row.subject;
    const capabilities = handle.provider.capabilities();
    if (
      capabilities.providerId !== "yuvi-local-profile" ||
      capabilities.providerVersion !== "1" ||
      !capabilities.localPrivate ||
      capabilities.hosted ||
      capabilities.asyncGeneration ||
      capabilities.schemaVersion !== PROFILE_VERSION ||
      capabilities.materializerVersion !== PROFILE_MATERIALIZER_VERSION ||
      !capabilities.sourceBackends.includes(handle.backend)
    ) {
      await this.store.failAttempt(claim, "PROFILE_POLICY_UNSUPPORTED");
      return;
    }
    const pre = await handle.reader.listEligibleSources({
      subject,
      asOf: this.now().toISOString(),
      signal
    });
    if (pre.state !== "COMPLETE") {
      await this.store.failAttempt(claim, sourceError(pre), sourceState(pre.state));
      return;
    }
    if (pre.backend !== handle.backend) {
      await this.store.failAttempt(claim, "SOURCE_AUTHORITY_UNSUPPORTED");
      return;
    }
    const dPre = digestCompleteRead(pre);
    if (!this.localFence(handle, signal, heartbeatLost)) {
      await this.store.failAttempt(claim, signal.aborted ? "CANCELLED" : "COMPOSITION_CHANGED");
      return;
    }
    let generated: ProfileGenerationOutcome;
    try {
      generated = await handle.provider.generate({ subject, signal });
    } catch {
      await this.store.failAttempt(claim, "SOURCE_ERROR");
      return;
    }
    if (
      !("sourceRead" in generated) ||
      !generated.snapshot ||
      !generated.sourceRead ||
      generated.sourceRead.state !== "COMPLETE"
    ) {
      const code = "code" in generated ? mapFailure(generated.code) : "SOURCE_ERROR";
      const sourceRead = "sourceRead" in generated ? generated.sourceRead : null;
      await this.store.failAttempt(
        claim,
        code,
        sourceRead && sourceRead.state !== "COMPLETE" ? sourceState(sourceRead.state) : undefined
      );
      return;
    }
    let generatedSnapshot: ProfileSnapshotV1;
    try {
      generatedSnapshot = validateProfileSnapshot(generated.snapshot);
    } catch {
      await this.store.failAttempt(claim, "PROFILE_POLICY_UNSUPPORTED");
      return;
    }
    const dGen = digestCompleteRead(generated.sourceRead);
    const generatedPolicyValid =
      generatedSnapshot.producer.materializerVersion === PROFILE_MATERIALIZER_VERSION &&
      canonicalLineageJson(generatedSnapshot.subject) === canonicalLineageJson(subject) &&
      generatedSnapshot.sourceSet.backend === handle.backend;
    if (!this.localFence(handle, signal, heartbeatLost)) {
      await this.store.failAttempt(claim, signal.aborted ? "CANCELLED" : "COMPOSITION_CHANGED");
      return;
    }
    const post = await handle.reader.listEligibleSources({
      subject,
      asOf: this.now().toISOString(),
      signal
    });
    if (post.state !== "COMPLETE") {
      await this.store.failAttempt(claim, sourceError(post), sourceState(post.state));
      return;
    }
    if (!post.backend) {
      await this.store.failAttempt(claim, "SOURCE_AUTHORITY_UNSUPPORTED");
      return;
    }
    const dPost = digestCompleteRead(post);
    if (
      !generatedPolicyValid ||
      generated.sourceRead.backend !== handle.backend ||
      post.backend !== handle.backend ||
      dPre !== dGen ||
      dGen !== dPost
    ) {
      await this.store.failAttempt(
        claim,
        !generatedPolicyValid ? "PROFILE_POLICY_UNSUPPORTED" : "SOURCE_CHANGED"
      );
      try {
        await this.store.observeComplete(claim.row.subjectKey, post.backend, dPost);
      } catch {
        /* failed certification stays withheld */
      }
      return;
    }
    if (!this.localFence(handle, signal, heartbeatLost)) {
      await this.store.failAttempt(claim, signal.aborted ? "CANCELLED" : "COMPOSITION_CHANGED");
      return;
    }
    const selected = await this.withCompositionGate(async () => {
      if (!this.localFence(handle, signal, heartbeatLost)) return false;
      return this.store.selectCandidate(claim, {
        revision: generatedSnapshot.profileRevision,
        digest: dPost,
        backend: post.backend!,
        asOf: post.diagnostics.asOf
      });
    });
    if (!selected)
      await this.store.failAttempt(claim, heartbeatLost() ? "FENCE_LOST" : "SOURCE_CHANGED");
  }

  private localFence(
    handle: CapturedProfileComposition,
    signal: AbortSignal,
    heartbeatLost: () => boolean
  ): boolean {
    return !this.stopped && !signal.aborted && !heartbeatLost() && this.composition === handle;
  }

  private async withCompositionGate<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.compositionGate;
    let release!: () => void;
    const own = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.compositionGate = previous.then(() => own);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class AttemptTimeoutError extends Error {
  constructor() {
    super("Profile lifecycle attempt deadline elapsed.");
  }
}

export class ScopePeopleModelReader {
  constructor(private readonly coordinator: ProfileLifecycleCoordinator) {}
  read(input: {
    subject: ProfileSubjectV1;
    readMemory: boolean;
    signal?: AbortSignal;
  }): Promise<ScopeModelReadOutcome> {
    return this.coordinator.readScopeModel(input);
  }
  readPersonModel(): PersonModelReadFailure {
    return this.coordinator.readPersonModel();
  }
}

export function digestCompleteRead(read: ProfileSourceReadOutcome): string {
  if (read.state !== "COMPLETE" || (read.backend !== "legacy" && read.backend !== "mem0"))
    throw new TypeError("A COMPLETE source read is required.");
  const byIdentity = new Map<string, ReturnType<typeof canonicalizeProfileEvidenceSource>>();
  for (const raw of read.sources) {
    const source = canonicalizeProfileEvidenceSource(raw);
    if (source.memory.backend !== read.backend) throw new TypeError("Source backend mismatch.");
    const key = source.memory.backend + ":" + source.memory.sourceRecordId,
      prior = byIdentity.get(key);
    if (prior && canonicalLineageJson(prior) !== canonicalLineageJson(source))
      throw new TypeError("Physical source identity conflict.");
    byIdentity.set(key, source);
  }
  const sources = [...byIdentity.values()].sort(
    (a, b) =>
      ordinal(a.memory.backend, b.memory.backend) ||
      ordinal(a.memory.sourceRecordId, b.memory.sourceRecordId)
  );
  return profileSourceSetDigest(sources);
}

function hasLiveLease(row: ProfileLifecycleRow, now: Date): boolean {
  return (
    row.leaseOwner !== null && row.leaseUntil !== null && Date.parse(row.leaseUntil) > now.getTime()
  );
}
function unavailable(
  row: ProfileLifecycleRow,
  code: ProfileLifecycleError,
  now: Date
): ScopeModelReadOutcome {
  return { state: "UNAVAILABLE", model: null, status: profileLifecycleStatus(row, now), code };
}
function unavailableStatus(subject: ProfileSubjectV1): ScopeProfileStatus {
  return {
    subject: structuredClone(subject),
    controlVersion: "0",
    candidateRevision: null,
    evidenceState: "NO_PROFILE",
    regenerationRequired: true,
    workState: "BLOCKED",
    lastError: "STORE_UNAVAILABLE"
  };
}
function failed(
  row: ProfileLifecycleRow,
  code: ProfileLifecycleError,
  now: Date
): ScopeModelReadOutcome {
  return { state: "FAILED", model: null, status: profileLifecycleStatus(row, now), code };
}
function sourceState(
  state: Exclude<ProfileSourceReadOutcome["state"], "COMPLETE">
): Exclude<ProfileSourceReadState, "NONE" | "COMPLETE"> {
  return state;
}
function sourceError(read: ProfileSourceReadOutcome): ProfileLifecycleError {
  if (read.state === "PARTIAL")
    return read.reasons.includes("ENUMERATION_UNSUPPORTED")
      ? "SOURCE_AUTHORITY_UNSUPPORTED"
      : "SOURCE_PARTIAL";
  if (read.state === "UNAVAILABLE") {
    if (read.reasons.includes("MEMORY_DISABLED")) return "MEMORY_DISABLED";
    if (read.reasons.includes("ENUMERATION_UNSUPPORTED")) return "SOURCE_AUTHORITY_UNSUPPORTED";
    return "SOURCE_UNAVAILABLE";
  }
  if (
    read.reasons.some((reason) =>
      ["RECORD_INVALID", "LINEAGE_INVALID", "SCOPE_MISMATCH", "SOURCE_IDENTITY_CONFLICT"].includes(
        reason
      )
    )
  )
    return "SOURCE_AUTHORITY_UNSUPPORTED";
  return "SOURCE_ERROR";
}
function nullOutcome(
  state: "UNAVAILABLE" | "ERROR",
  backend: ProfileBackend,
  asOf: string
): ProfileSourceReadOutcome {
  return {
    state,
    backend,
    sources: [],
    reasons: [state === "UNAVAILABLE" ? "BACKEND_UNAVAILABLE" : "BACKEND_ERROR"],
    diagnostics: {
      asOf,
      scannedCount: 0,
      eligibleCount: 0,
      excludedCounts: {
        LEGACY_INCOMPLETE: 0,
        NON_EVIDENCE: 0,
        PAYLOAD_UNAVAILABLE: 0,
        UNSUPPORTED_ORIGIN: 0,
        UNSUPPORTED_DERIVATION: 0,
        UNSUPPORTED_SELECTOR: 0,
        INACTIVE: 0,
        SUPERSEDED: 0,
        NOT_YET_VALID: 0,
        EXPIRED: 0,
        ROOT_RETIRED: 0
      },
      exhausted: false
    }
  };
}
function mapFailure(code: string): ProfileLifecycleError {
  switch (code) {
    case "SOURCE_UNAVAILABLE":
      return "SOURCE_UNAVAILABLE";
    case "SOURCE_PARTIAL":
      return "SOURCE_PARTIAL";
    case "SNAPSHOT_BOUND":
      return "SNAPSHOT_BOUND";
    case "STORE_UNAVAILABLE":
      return "STORE_UNAVAILABLE";
    case "STORE_ERROR":
      return "STORE_ERROR";
    case "PROFILE_REVISION_CONFLICT":
      return "PROFILE_REVISION_CONFLICT";
    default:
      return "SOURCE_ERROR";
  }
}
function mapThrownError(error: unknown): ProfileLifecycleError {
  return error instanceof Error && error.name === "ProfileLifecycleStoreUnavailableError"
    ? "STORE_UNAVAILABLE"
    : "SOURCE_ERROR";
}
function safeErrorClass(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 80) : "unknown";
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function sourceValidityExpired(snapshot: ProfileSnapshotV1, asOf: string, now: Date): boolean {
  const observed = Date.parse(asOf),
    current = now.getTime();
  return snapshot.sourceSet.sources.some((source) =>
    [source.lifecycle.validUntil, source.lifecycle.expiresAt].some(
      (value) => value !== null && Date.parse(value) > observed && Date.parse(value) <= current
    )
  );
}
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
