import { createHash } from "node:crypto";
import type { JournalRepository } from "@companion/journal";
import {
  ObservationEvidenceSchema,
  ObservationExecutionSchema,
  type JournalEventRef,
  type ObservationExecution
} from "@companion/protocol";
import type { AuthorityPool } from "@companion/memory";
import { contextUseDigest, buildMemoryScope } from "@companion/memory";
import {
  structuredVisualEvidence,
  type RuntimeObservationPort,
  type ObservationContext,
  type ObservationEvidence
} from "@companion/core";
import type { VisionInput, VisionOutput } from "@companion/providers";
import { EffectIntentSchema, EffectEvidenceSchema, effectDigest } from "@companion/effects";
import type {
  EffectResultProjection,
  EffectResultTransaction,
  EffectReportRetention
} from "@companion/effects";
import type { ConversationHostIdentity } from "./conversation-host-identity.js";

/** Retained Provider reports. Identity and execution truth remain in Host/Journal/A9. */
export class HostObservationContinuity implements RuntimeObservationPort {
  private timer: ReturnType<typeof setInterval> | undefined;
  private purging: Promise<unknown> | undefined;
  retentionHealth: { lastPurgeAt: string | null; error: string | null } = {
    lastPurgeAt: null,
    error: null
  };
  start() {
    if (this.timer) return;
    const purge = () => {
      if (this.purging) return;
      this.purging = this.purgeExpired()
        .then(
          () => {
            this.retentionHealth = { lastPurgeAt: new Date().toISOString(), error: null };
          },
          () => {
            this.retentionHealth.error = "OBSERVATION_PURGE_UNAVAILABLE";
          }
        )
        .finally(() => {
          this.purging = undefined;
        });
    };
    purge();
    this.timer = setInterval(purge, 60000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.purging;
  }
  constructor(
    private readonly db: AuthorityPool,
    private readonly journal: JournalRepository,
    private readonly host: ConversationHostIdentity,
    private readonly personaId: string,
    private readonly retention: { seconds: number; retainImages: boolean }
  ) {}
  private async owner(ref?: JournalEventRef, transaction?: EffectResultTransaction) {
    if (!ref || ref.namespace !== this.journal.namespace) return null;
    const source = await this.journal.get(ref, transaction);
    const a = source?.authority;
    if (
      !a ||
      a.principal.state !== "RESOLVED" ||
      a.binding.state !== "RESOLVED" ||
      a.audience.kind !== "PRIVATE"
    )
      return null;
    // Never trust a cached principal or a DTO to survive expiration/revocation.
    if (
      !(await this.host.readAuthority(
        ref,
        buildMemoryScope(a.binding.personId, this.personaId),
        transaction
      ))
    )
      return null;
    return { principal: a.principal, binding: a.binding, audience: a.audience, ref, source };
  }
  private ownerValues(o: NonNullable<Awaited<ReturnType<HostObservationContinuity["owner"]>>>) {
    return [
      this.journal.namespace,
      this.personaId,
      o.binding.personId,
      o.principal.namespace,
      o.principal.actorId,
      o.audience.channelRef
    ];
  }
  projectVision(
    context: ObservationContext,
    attemptId: string,
    output: VisionOutput,
    input: VisionInput
  ): EffectResultProjection {
    const source = input.image ?? input.imageBuffer;
    if (
      this.retention.seconds > 0 &&
      this.retention.retainImages &&
      ((source?.byteLength ?? 0) > 20 * 1024 * 1024 ||
        (input.imageBase64?.length ?? 0) > 28 * 1024 * 1024)
    )
      throw Error("OBSERVATION_SOURCE_TOO_LARGE");
    const image =
      this.retention.seconds > 0 && this.retention.retainImages
        ? source
          ? Buffer.from(source)
          : input.imageBase64
            ? Buffer.from(input.imageBase64, "base64")
            : null
        : null;
    return this.projection(
      context,
      attemptId,
      "VISION",
      structuredVisualEvidence(output),
      output.provider ?? null,
      output.model ?? null,
      image,
      input.mimeType ?? "image/png"
    );
  }
  projectReadText(
    context: ObservationContext,
    attemptId: string,
    text: string
  ): EffectResultProjection {
    return this.projection(
      context,
      attemptId,
      "READ_TEXT",
      structuredVisualEvidence({ text, sceneSummary: "", objects: [] }),
      "host.read_text",
      null,
      null,
      null
    );
  }
  private projection(
    context: ObservationContext,
    attemptId: string,
    kind: ObservationEvidence["kind"],
    evidence: NonNullable<ObservationEvidence["evidence"]>,
    provider: string | null,
    model: string | null,
    bytes: Buffer | null,
    mime: string | null
  ): EffectResultProjection {
    const observedAt = new Date();
    const expiresAt = new Date(observedAt.getTime() + this.retention.seconds * 1000);
    const imageDigest = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
    const evidenceDigest = contextUseDigest(evidence);
    const digest = contextUseDigest({ evidenceDigest, imageDigest, mime: bytes ? mime : null });
    const id = "ob1_" + createHash("sha256").update(attemptId).digest("hex");
    const disposition = (
      state: EffectReportRetention["state"],
      reason: EffectReportRetention["reason"]
    ): EffectReportRetention => ({
      version: "observation-retention.v1",
      state,
      reportId: state === "STORED" ? id : null,
      digest: state === "NOT_REQUESTED" ? null : digest,
      expiresAt: state === "NOT_REQUESTED" ? null : expiresAt.toISOString(),
      reason
    });
    return {
      digest,
      commit: async (transaction) => {
        if (!this.retention.seconds) return disposition("NOT_REQUESTED", "POLICY_DISABLED");
        // Grant row is locked through the shared terminal COMMIT. No remote model
        // or tool invocation belongs in this projection transaction.
        const owner = await this.owner(context.sourceJournalRef, transaction);
        if (!owner) return disposition("WITHHELD", "SOURCE_NOT_AUTHORIZED");
        const permission = (
          await transaction.query(
            `select metadata from conversation_messages
        where source_journal_ref=$1::jsonb and role='user' limit 1`,
            [context.sourceJournalRef]
          )
        ).rows[0];
        if (
          !permission ||
          (permission["metadata"] as Record<string, unknown>)["memoryWriteDisabled"] === true
        )
          return disposition("NOT_REQUESTED", "POLICY_DISABLED");
        if (bytes && bytes.length > 20 * 1024 * 1024) throw Error("OBSERVATION_SOURCE_TOO_LARGE");
        const execution = (
          await transaction.query(
            `select a.contract_ref,i.intent,clock_timestamp() as checked_at
        from effect_attempts a join effect_intents i using(intent_id)
        where a.attempt_id=$1 and a.dispatch_started_at is not null and not a.integrity_conflict
        and i.intent->'request'->'causalRefs' @> $2::jsonb`,
            [attemptId, JSON.stringify([context.sourceJournalRef])]
          )
        ).rows[0];
        if (
          !execution ||
          (kind === "READ_TEXT"
            ? execution["contract_ref"] !== "yuvi.read-text.v1"
            : execution["contract_ref"] !== "yuvi.provider.v1" ||
              (execution["intent"] as any).request.payload.operation !== "analyzeImage")
        )
          throw Error("OBSERVATION_EXECUTION_KIND_MISMATCH");
        if (
          new Date(String(execution["checked_at"])).getTime() >= expiresAt.getTime() ||
          Date.now() >= expiresAt.getTime()
        )
          return disposition("EXPIRED", "RETENTION_EXPIRED");
        const conversation = owner.source?.authority.correlations.find(
          (c) => c.kind === "CONVERSATION"
        );
        if (conversation?.kind !== "CONVERSATION")
          throw Error("OBSERVATION_SOURCE_SESSION_REQUIRED");
        const saved = await transaction.query(
          `insert into retained_observations(observation_id,attempt_id,namespace,persona_id,person_id,
        principal_namespace,actor_id,audience_ref,source_ref,session_id,kind,provider,model,observed_at,expires_at,
        evidence,evidence_digest,image_bytes,image_mime,image_digest,commit_digest)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        on conflict(observation_id) do nothing returning observation_id`,
          [
            id,
            attemptId,
            ...this.ownerValues(owner),
            context.sourceJournalRef,
            conversation.sessionId,
            kind,
            provider,
            model,
            observedAt.toISOString(),
            expiresAt.toISOString(),
            evidence,
            evidenceDigest,
            bytes,
            bytes ? mime : null,
            imageDigest,
            digest
          ]
        );
        if (!saved.rows.length) throw Error("OBSERVATION_SOURCE_CONFLICT");
        return disposition("STORED", null);
      }
    };
  }
  async read(context: ObservationContext) {
    return this.page(context, 4);
  }
  async page(context: ObservationContext, limit = 16, before?: string) {
    const owner = await this.owner(context.sourceJournalRef);
    if (!owner || this.retention.seconds === 0)
      return {
        schema: "observations.page.v1" as const,
        status: "UNAVAILABLE" as const,
        records: [],
        nextCursor: null
      };
    let anchor: { at: string; id: string } | undefined;
    if (before) {
      anchor = JSON.parse(Buffer.from(before, "base64url").toString());
      if (
        !anchor ||
        typeof anchor.at !== "string" ||
        !Number.isFinite(Date.parse(anchor.at)) ||
        !/^ob1_[a-f0-9]{64}$/u.test(anchor.id)
      )
        throw Error("OBSERVATION_CURSOR_INVALID");
    }
    const rows = (
      await this.db.query(
        `select observation_id,attempt_id,kind,source_ref,provider,model,observed_at,expires_at,erased_at,erased_by_source,evidence,evidence_digest,commit_digest,image_digest,image_mime,
      (image_bytes is not null) as has_image,expires_at<=clock_timestamp() as database_expired from retained_observations
      where namespace=$1 and persona_id=$2 and person_id=$3 and principal_namespace=$4 and actor_id=$5 and audience_ref=$6
      and ($7::timestamptz is null or (observed_at,observation_id)<($7::timestamptz,$8::text))
      order by observed_at desc,observation_id desc limit $9`,
        [
          ...this.ownerValues(owner),
          anchor?.at ?? null,
          anchor?.id ?? null,
          Math.min(32, Math.max(1, limit)) + 1
        ]
      )
    ).rows;
    const records = await Promise.all(rows.slice(0, limit).map((row) => this.project(row)));
    if (!(await this.owner(context.sourceJournalRef)))
      return {
        schema: "observations.page.v1" as const,
        status: "UNAVAILABLE" as const,
        records: [],
        nextCursor: null
      };
    const last = rows[Math.min(limit, rows.length) - 1];
    return {
      schema: "observations.page.v1" as const,
      status: "OK" as const,
      records: records.map(expireAtDisclosure),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                at: new Date(String(last["observed_at"])).toISOString(),
                id: last["observation_id"]
              })
            ).toString("base64url")
          : null
    };
  }
  private async project(row: Record<string, unknown>): Promise<ObservationEvidence> {
    const source = row["source_ref"] as JournalEventRef;
    const sourceAuthorized = await this.owner(source);
    const expired =
      row["database_expired"] === true ||
      new Date(String(row["expires_at"])).getTime() <= Date.now();
    const integrityConflict =
      (
        await this.db.query("select integrity_conflict from effect_attempts where attempt_id=$1", [
          row["attempt_id"]
        ])
      ).rows[0]?.["integrity_conflict"] === true;
    const unavailableReason = integrityConflict
      ? "EXECUTION_INTEGRITY_CONFLICT"
      : !this.retention.seconds
        ? "RETENTION_DISABLED"
        : row["erased_by_source"]
          ? "DELETED"
          : expired
            ? "EXPIRED"
            : row["erased_at"]
              ? "DELETED"
              : !sourceAuthorized
                ? "SOURCE_AUTHORITY_UNAVAILABLE"
                : undefined;
    const evidence = row["evidence"] as ObservationEvidence["evidence"];
    if (!unavailableReason) {
      if (
        contextUseDigest(evidence) !== row["evidence_digest"] ||
        (row["commit_digest"] &&
          contextUseDigest({
            evidenceDigest: row["evidence_digest"],
            imageDigest: row["image_digest"],
            mime: row["image_digest"] ? row["image_mime"] : null
          }) !== row["commit_digest"])
      )
        throw Error("OBSERVATION_INTEGRITY_FAILED");
    }
    return ObservationEvidenceSchema.parse({
      schema: "observation.v1",
      id: String(row["observation_id"]),
      kind: row["kind"] as ObservationEvidence["kind"],
      availability: unavailableReason ? "UNAVAILABLE" : "AVAILABLE",
      ...(unavailableReason ? { unavailableReason } : {}),
      source,
      observedAt: new Date(String(row["observed_at"])).toISOString(),
      expiresAt: new Date(String(row["expires_at"])).toISOString(),
      action: {
        attemptId: String(row["attempt_id"]),
        contractRef: row["kind"] === "VISION" ? "yuvi.provider.v1" : "yuvi.read-text.v1",
        certainty: "APPLIED"
      },
      goalStatus: "NOT_INFERRED",
      coverage: "BOUNDED_PROVIDER_REPORT",
      provider: row["provider"] as string | null,
      model: row["model"] as string | null,
      ...(!unavailableReason && evidence ? { evidence } : {}),
      sourceArtifact: unavailableReason
        ? "UNAVAILABLE"
        : row["has_image"]
          ? "AVAILABLE"
          : "NOT_RETAINED"
    });
  }
  async detail(context: ObservationContext, id: string) {
    const owner = await this.owner(context.sourceJournalRef);
    if (!owner) return null;
    const row = (
      await this.db.query(
        `select observation_id,attempt_id,kind,source_ref,provider,model,observed_at,expires_at,erased_at,erased_by_source,evidence,evidence_digest,commit_digest,image_digest,image_mime,
      image_bytes is not null as has_image,expires_at<=clock_timestamp() as database_expired from retained_observations
      where namespace=$1 and persona_id=$2 and person_id=$3 and principal_namespace=$4 and actor_id=$5 and audience_ref=$6 and observation_id=$7`,
        [...this.ownerValues(owner), id]
      )
    ).rows[0];
    const record = row ? await this.project(row) : null;
    return (await this.owner(context.sourceJournalRef)) && record
      ? expireAtDisclosure(record)
      : null;
  }
  /** Receipt lookup is scoped through the original accepted source identity, not
   * an operator token, guessed sessionId or untrusted effect payload. */
  async execution(
    context: ObservationContext,
    attemptId: string
  ): Promise<ObservationExecution | null> {
    const reader = await this.owner(context.sourceJournalRef);
    if (!reader) return null;
    const row = (
      await this.db.query(
        `select a.dispatch_started_at,a.integrity_conflict,i.intent,
       (select evidence from effect_observations e where e.attempt_id=a.attempt_id and e.category='TERMINAL' order by e.observation_id desc limit 1) terminal,
       (select evidence_digest from effect_observations e where e.attempt_id=a.attempt_id and e.category='TERMINAL' order by e.observation_id desc limit 1) terminal_digest,
       exists(select 1 from effect_observations e where e.attempt_id=a.attempt_id and e.category='TERMINAL' and e.evidence->>'certainty'='APPLIED') applied
       from effect_attempts a join effect_intents i using(intent_id) where a.attempt_id=$1`,
        [attemptId]
      )
    ).rows[0];
    if (!row) return null;
    const intent = EffectIntentSchema.parse(row["intent"]);
    if (
      intent.contractRef !== "yuvi.read-text.v1" &&
      !(
        intent.contractRef === "yuvi.provider.v1" &&
        (intent.request.payload as { operation?: unknown })?.operation === "analyzeImage"
      )
    )
      return null;
    let visible = false;
    for (const ref of intent.request.causalRefs) {
      if (ref.namespace !== this.journal.namespace) continue;
      const a = (await this.journal.get(ref))?.authority;
      // Execution metadata can survive the original grant's expiry; report content cannot.
      if (
        a?.principal.state === "RESOLVED" &&
        a.binding.state === "RESOLVED" &&
        a.audience.kind === "PRIVATE" &&
        a.principal.namespace === reader.principal.namespace &&
        a.principal.actorId === reader.principal.actorId &&
        a.binding.personId === reader.binding.personId &&
        a.audience.channelRef === reader.audience.channelRef
      )
        visible = true;
    }
    if (!visible) return null;
    const terminal = row["terminal"] ? EffectEvidenceSchema.parse(row["terminal"]) : null;
    if (terminal && effectDigest(terminal) !== row["terminal_digest"])
      throw Error("OBSERVATION_EXECUTION_INTEGRITY_FAILED");
    const atCommit = terminal?.reportRetention ?? null;
    const execution = row["integrity_conflict"]
      ? "INTEGRITY_CONFLICT"
      : terminal?.certainty === "APPLIED"
        ? "APPLIED"
        : terminal?.certainty === "UNKNOWN"
          ? "UNKNOWN"
          : terminal
            ? "NOT_APPLIED"
            : row["dispatch_started_at"]
              ? "UNKNOWN"
              : "NOT_STARTED";
    let report: ObservationExecution["report"] =
      execution === "UNKNOWN" ? "UNKNOWN" : "NOT_PRODUCED";
    let reportId: string | null = null;
    if (execution === "INTEGRITY_CONFLICT") report = "UNAVAILABLE";
    else if (execution === "APPLIED") {
      const saved = (
        await this.db.query(
          "select observation_id from retained_observations where attempt_id=$1",
          [attemptId]
        )
      ).rows[0];
      if (saved) {
        const detail = await this.detail(context, String(saved["observation_id"]));
        reportId = detail?.id ?? null;
        report =
          detail?.availability === "AVAILABLE"
            ? "AVAILABLE"
            : detail?.unavailableReason === "EXPIRED"
              ? "EXPIRED"
              : detail?.unavailableReason === "DELETED"
                ? "DELETED"
                : "UNAVAILABLE";
      } else if (!atCommit) report = "LEGACY_MISSING";
      else report = atCommit.state === "STORED" ? "FAILED" : atCommit.state;
    }
    if (!(await this.owner(context.sourceJournalRef))) return null;
    return ObservationExecutionSchema.parse({
      schema: "observation.execution.v1",
      attemptId,
      execution,
      hasAppliedReceipt: row["applied"],
      retentionAtCommit: atCommit,
      report,
      reportId,
      goalStatus: "NOT_INFERRED"
    });
  }
  async verify(context: ObservationContext, ids: string[]) {
    if (ids.length > 5) return false;
    const records = await Promise.all(ids.map((id) => this.detail(context, id)));
    return records.every((r) => r?.availability === "AVAILABLE");
  }
  async image(context: ObservationContext, id: string) {
    const record = await this.detail(context, id);
    if (record?.availability !== "AVAILABLE" || record.sourceArtifact !== "AVAILABLE") return null;
    const row = (
      await this.db.query(
        "select image_bytes,image_mime,image_digest from retained_observations where observation_id=$1 and erased_at is null and expires_at>clock_timestamp()",
        [id]
      )
    ).rows[0];
    if (!row?.["image_bytes"]) return null;
    const bytes = row["image_bytes"] as Buffer;
    if (createHash("sha256").update(bytes).digest("hex") !== row["image_digest"])
      throw Error("OBSERVATION_IMAGE_INTEGRITY_FAILED");
    if (!(await this.owner(context.sourceJournalRef)) || !(await this.owner(record.source)))
      return null;
    return { imageBase64: bytes.toString("base64"), mimeType: String(row["image_mime"]) };
  }
  async erase(context: ObservationContext, id: string) {
    const owner = await this.owner(context.sourceJournalRef);
    if (!owner) return false;
    const result = await this.db.query(
      `with target as materialized (
      select observation_id,erased_at from retained_observations
      where namespace=$1 and persona_id=$2 and person_id=$3 and principal_namespace=$4 and actor_id=$5 and audience_ref=$6 and observation_id=$7 for update
      ), erased as (
      update retained_observations o set erased_at=clock_timestamp(),erased_by_source=$8::jsonb,evidence=null,image_bytes=null
      from target t where o.observation_id=t.observation_id and t.erased_at is null returning o.observation_id
      ) select observation_id from erased union all select observation_id from target where erased_at is not null`,
      [...this.ownerValues(owner), id, context.sourceJournalRef]
    );
    return result.rows.length === 1;
  }
  async purgeExpired(limit = 100) {
    return (
      await this.db.query(
        `with batch as (select observation_id from retained_observations where expires_at<=clock_timestamp() and erased_at is null and namespace=$2 and persona_id=$3 order by expires_at limit $1 for update skip locked)
      update retained_observations o set evidence=null,image_bytes=null,erased_at=clock_timestamp() from batch where o.observation_id=batch.observation_id and o.erased_at is null returning o.observation_id`,
        [Math.min(1000, Math.max(1, limit)), this.journal.namespace, this.personaId]
      )
    ).rows.length;
  }
}

function expireAtDisclosure(record: ObservationEvidence): ObservationEvidence {
  if (record.availability !== "AVAILABLE" || Date.parse(record.expiresAt) > Date.now())
    return record;
  const { evidence: _evidence, ...withoutContent } = record;
  return {
    ...withoutContent,
    availability: "UNAVAILABLE",
    unavailableReason: "EXPIRED",
    sourceArtifact: "UNAVAILABLE"
  };
}
