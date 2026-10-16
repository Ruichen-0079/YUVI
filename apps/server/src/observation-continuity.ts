import { createHash } from "node:crypto";
import type { JournalRepository } from "@companion/journal";
import { ObservationEvidenceSchema, type JournalEventRef } from "@companion/protocol";
import type { AuthorityPool } from "@companion/memory";
import { contextUseDigest, buildMemoryScope } from "@companion/memory";
import {
  structuredVisualEvidence,
  type RuntimeObservationPort,
  type ObservationContext,
  type ObservationEvidence
} from "@companion/core";
import type { VisionOutput } from "@companion/providers";
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
  private async owner(ref?: JournalEventRef) {
    if (this.retention.seconds === 0) return null;
    if (!ref || ref.namespace !== this.journal.namespace) return null;
    const source = await this.journal.get(ref);
    const a = source?.authority;
    if (
      !a ||
      a.principal.state !== "RESOLVED" ||
      a.binding.state !== "RESOLVED" ||
      a.audience.kind !== "PRIVATE"
    )
      return null;
    // Never trust a cached principal or a DTO to survive expiration/revocation.
    if (!(await this.host.readAuthority(ref, buildMemoryScope(a.binding.personId, this.personaId))))
      return null;
    return { principal: a.principal, binding: a.binding, audience: a.audience, ref };
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
  async saveVision(
    context: ObservationContext,
    output: VisionOutput,
    image?: { imageBase64: string; mimeType: string }
  ) {
    if (!output.sourceAttemptId) return; // A direct fixture or arbitrary model JSON is not an execution receipt.
    await this.save(
      context,
      output.sourceAttemptId,
      "VISION",
      structuredVisualEvidence(output),
      output.provider ?? null,
      output.model ?? null,
      image
    );
  }
  async saveReadText(
    context: ObservationContext,
    attemptId: string,
    text: string,
    _executionDeadline: string
  ) {
    await this.save(
      context,
      attemptId,
      "READ_TEXT",
      structuredVisualEvidence({ text, sceneSummary: "", objects: [] }),
      "host.read_text",
      null,
      undefined
    );
  }
  private async save(
    context: ObservationContext,
    attemptId: string,
    kind: ObservationEvidence["kind"],
    evidence: NonNullable<ObservationEvidence["evidence"]>,
    provider: string | null,
    model: string | null,
    image?: { imageBase64: string; mimeType: string },
    expiry?: string
  ) {
    const owner = await this.owner(context.sourceJournalRef);
    if (!owner || this.retention.seconds === 0) return;
    const permission = (
      await this.db.query(
        `select metadata from conversation_messages
      where source_journal_ref=$1::jsonb and role='user' limit 1`,
        [context.sourceJournalRef]
      )
    ).rows[0];
    if (
      !permission ||
      (permission["metadata"] as Record<string, unknown>)["memoryWriteDisabled"] === true
    )
      return;
    const receipt = (
      await this.db.query(
        `select a.contract_ref,o.observed_at,i.intent from effect_attempts a
      join effect_intents i using(intent_id) join effect_observations o using(attempt_id)
      where a.attempt_id=$1 and o.category='TERMINAL' and o.evidence->>'certainty'='APPLIED'
        and i.intent->'request'->'causalRefs' @> $2::jsonb
        and (a.contract_ref='yuvi.read-text.v1' or (a.contract_ref='yuvi.provider.v1' and i.intent->'request'->'payload'->>'operation'='analyzeImage'))`,
        [attemptId, JSON.stringify([context.sourceJournalRef])]
      )
    ).rows[0];
    if (!receipt) throw Error("OBSERVATION_APPLIED_RECEIPT_REQUIRED");
    if ((kind === "READ_TEXT") !== (receipt["contract_ref"] === "yuvi.read-text.v1"))
      throw Error("OBSERVATION_EXECUTION_KIND_MISMATCH");
    const observedAt = new Date(String(receipt["observed_at"]));
    const expiresAt = new Date(
      Math.min(
        observedAt.getTime() + this.retention.seconds * 1000,
        expiry ? new Date(expiry).getTime() : Infinity
      )
    );
    if (expiresAt.getTime() <= Date.now()) return;
    const bytes =
      image && this.retention.retainImages ? Buffer.from(image.imageBase64, "base64") : null;
    if (bytes && bytes.length > 20 * 1024 * 1024) throw Error("OBSERVATION_SOURCE_TOO_LARGE");
    const id = "ob1_" + createHash("sha256").update(attemptId).digest("hex");
    const digest = contextUseDigest(evidence);
    const saved = await this.db.query(
      `insert into retained_observations(observation_id,attempt_id,namespace,persona_id,person_id,principal_namespace,actor_id,audience_ref,
      source_ref,session_id,kind,provider,model,observed_at,expires_at,evidence,evidence_digest,image_bytes,image_mime,image_digest)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      on conflict(observation_id) do nothing returning observation_id`,
      [
        id,
        attemptId,
        ...this.ownerValues(owner),
        context.sourceJournalRef,
        context.sessionId,
        kind,
        provider,
        model,
        observedAt.toISOString(),
        expiresAt.toISOString(),
        evidence,
        digest,
        bytes,
        bytes ? image!.mimeType : null,
        bytes ? createHash("sha256").update(bytes).digest("hex") : null
      ]
    );
    if (!saved.rows.length) {
      const old = (
        await this.db.query(
          "select evidence_digest from retained_observations where observation_id=$1",
          [id]
        )
      ).rows[0];
      if (old?.["evidence_digest"] !== digest) throw Error("OBSERVATION_SOURCE_CONFLICT");
    }
  }
  async read(context: ObservationContext) {
    return this.page(context, 4);
  }
  async page(context: ObservationContext, limit = 16, before?: string) {
    const owner = await this.owner(context.sourceJournalRef);
    if (!owner)
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
        `select observation_id,attempt_id,kind,source_ref,provider,model,observed_at,expires_at,erased_at,evidence,evidence_digest,
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
    const unavailableReason = expired
      ? "EXPIRED"
      : row["erased_at"]
        ? "DELETED"
        : !sourceAuthorized
          ? "SOURCE_AUTHORITY_UNAVAILABLE"
          : undefined;
    const evidence = row["evidence"] as ObservationEvidence["evidence"];
    if (!unavailableReason && contextUseDigest(evidence) !== row["evidence_digest"])
      throw Error("OBSERVATION_INTEGRITY_FAILED");
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
        `select observation_id,attempt_id,kind,source_ref,provider,model,observed_at,expires_at,erased_at,evidence,evidence_digest,
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
      `update retained_observations set erased_at=coalesce(erased_at,now()),erased_by_source=coalesce(erased_by_source,$8::jsonb),evidence=null,image_bytes=null
      where namespace=$1 and persona_id=$2 and person_id=$3 and principal_namespace=$4 and actor_id=$5 and audience_ref=$6 and observation_id=$7 returning observation_id`,
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
