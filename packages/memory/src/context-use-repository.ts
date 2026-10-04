import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  ContextManifestSchema,
  ContextExposureSchema,
  type ContextManifest,
  type ContextExposure,
  type ContextSourceUse
} from "@companion/protocol";
export function contextUseCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(contextUseCanonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map(
        (k) => `${JSON.stringify(k)}:${contextUseCanonical((value as Record<string, unknown>)[k])}`
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function contextUseDigest(value: unknown): string {
  return createHash("sha256").update(contextUseCanonical(value)).digest("hex");
}
export function contextManifestId(
  body: Pick<ContextManifest, "namespace" | "executionId" | "assemblyOrdinal">
): string {
  return `cm1_${contextUseDigest([body.namespace, body.executionId, body.assemblyOrdinal])}`;
}
export function contextExposureId(
  body: Pick<ContextExposure, "manifestId" | "consumerOperationSlot" | "exposureOrdinal">
): string {
  return `ce1_${contextUseDigest([body.manifestId, body.consumerOperationSlot, body.exposureOrdinal])}`;
}
export class ContextUseConflict extends Error {}
export class PostgresContextUseRepository {
  constructor(private readonly pool: Pool) {}
  async admit(
    manifest: ContextManifest,
    exposure?: ContextExposure
  ): Promise<{ manifestId: string; exposureId: string | null }> {
    const m = ContextManifestSchema.parse(manifest),
      mid = contextManifestId(m);
    const e = exposure ? ContextExposureSchema.parse(exposure) : null;
    if (e && e.manifestId !== mid)
      throw new ContextUseConflict("Exposure has a different base manifest.");
    if (
      Buffer.byteLength(contextUseCanonical(m)) > 1_000_000 ||
      (e && Buffer.byteLength(contextUseCanonical(e)) > 1_000_000)
    )
      throw Error("Context metadata exceeds bounded admission.");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "insert into context_use_manifests(manifest_id, namespace, execution_id, assembly_ordinal, body, body_digest) values($1,$2,$3,$4,$5::jsonb,$6) on conflict do nothing",
        [
          mid,
          m.namespace,
          m.executionId,
          m.assemblyOrdinal,
          contextUseCanonical(m),
          contextUseDigest(m)
        ]
      );
      const existing = await client.query(
        "select body_digest from context_use_manifests where manifest_id=$1",
        [mid]
      );
      if (existing.rows[0]?.body_digest !== contextUseDigest(m))
        throw new ContextUseConflict("Manifest identity reused with different historical state.");
      const eid = e ? contextExposureId(e) : null;
      if (e) {
        await client.query(
          "insert into context_use_exposures(exposure_id, manifest_id, consumer_operation_slot, exposure_ordinal, body, body_digest) values($1,$2,$3,$4,$5::jsonb,$6) on conflict do nothing",
          [
            eid,
            mid,
            e.consumerOperationSlot,
            e.exposureOrdinal,
            contextUseCanonical(e),
            contextUseDigest(e)
          ]
        );
        const existingExposure = await client.query(
          "select body_digest from context_use_exposures where exposure_id=$1",
          [eid]
        );
        if (existingExposure.rows[0]?.body_digest !== contextUseDigest(e))
          throw new ContextUseConflict(
            "Exposure identity reused with different submitted projection."
          );
      }
      await client.query("commit");
      return { manifestId: mid, exposureId: eid };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async get(
    manifestId: string
  ): Promise<{ manifest: ContextManifest; exposures: ContextExposure[] } | null> {
    const m = await this.pool.query(
      "select body, body_digest from context_use_manifests where manifest_id=$1",
      [manifestId]
    );
    if (!m.rows[0]) return null;
    if (contextUseDigest(m.rows[0].body) !== m.rows[0].body_digest)
      throw new ContextUseConflict("Manifest integrity failure.");
    const manifest = ContextManifestSchema.parse(m.rows[0].body);
    if (contextManifestId(manifest) !== manifestId)
      throw new ContextUseConflict("Manifest identity integrity failure.");
    const result = await this.pool.query(
      "select exposure_id,body,body_digest from context_use_exposures where manifest_id=$1 order by consumer_operation_slot,exposure_ordinal",
      [manifestId]
    );
    const exposures = result.rows.map((r) => {
      if (contextUseDigest(r.body) !== r.body_digest)
        throw new ContextUseConflict("Exposure integrity failure.");
      const exposure = ContextExposureSchema.parse(r.body);
      if (exposure.manifestId !== manifestId || contextExposureId(exposure) !== r.exposure_id)
        throw new ContextUseConflict("Exposure identity integrity failure.");
      return exposure;
    });
    return { manifest, exposures };
  }
  /** Resolver receives the exact historical descriptor; never a request for latest. */
  async reconstruct(
    manifestId: string,
    resolve: (source: ContextSourceUse) => Promise<{
      availability: ContextSourceUse["availability"];
      revision: string | null;
      digest: string | null;
    }>
  ) {
    const history = await this.get(manifestId);
    if (!history) return null;
    const sources = await Promise.all(
      history.manifest.sources.map(async (source) => {
        if (
          [
            "NOT_USED",
            "EMPTY",
            "UNAVAILABLE",
            "ERROR",
            "NOT_RETAINED",
            "REDACTED",
            "DELETED"
          ].includes(source.availability)
        )
          return { source, currentAvailability: source.availability, exact: false };
        const result = await resolve(source);
        const exact =
          result.availability === "AVAILABLE" &&
          result.revision === source.revision &&
          result.digest === source.digest;
        return {
          source,
          currentAvailability: exact
            ? ("AVAILABLE" as const)
            : result.availability === "AVAILABLE"
              ? ("UNAVAILABLE" as const)
              : result.availability,
          exact
        };
      })
    );
    const consumerUse = await Promise.all(
      history.exposures.map(async (exposure) => {
        const result = await this.pool.query(
          `select i.intent_id, a.attempt_id, a.dispatch_started_at, o.evidence->>'certainty' as certainty, o.evidence->>'layer' as evidence_layer
    from effect_intents i left join effect_attempts a on a.intent_id=i.intent_id
    left join effect_observations o on o.attempt_id=a.attempt_id and o.category='TERMINAL'
    where i.intent->'request'->'payload'->'inputSnapshot'->'manifest'->>'exposureId'=$1
    or i.intent->'request'->'payload'->'contextUse'->>'exposureId'=$1 order by a.ordinal`,
          [contextExposureId(exposure)]
        );
        return {
          exposureId: contextExposureId(exposure),
          boundary: exposure.boundary,
          canonicalA9Evidence: result.rows
        };
      })
    );
    return {
      ...history,
      sources,
      consumerUse,
      guarantee: "IDENTITIES_AND_USE_RELATIONSHIPS" as const,
      renderedContext: "NOT_ARCHIVED" as const
    };
  }
}

/** Owner observation fingerprint; access/embedding maintenance is not semantic replacement. */
export function legacyMemoryContextRevision(value: import("./types.js").Memory): string {
  return contextUseDigest({
    id: value.id,
    content: value.content,
    summary: value.summary,
    type: value.type,
    subtype: value.subtype,
    scope: value.scope,
    scopeId: value.scopeId,
    status: value.status,
    validFrom: value.validFrom,
    validUntil: value.validUntil,
    expiresAt: value.expiresAt,
    supersededAt: value.supersededAt,
    metadata: value.metadata,
    personaId: value.personaId,
    subjectUserId: value.subjectUserId,
    tags: value.tags
  });
}
export function semanticMemoryContextRevision(value: import("./provider.js").MemoryEvent): string {
  return contextUseDigest({
    id: value.id,
    kind: value.kind,
    content: value.content,
    source: value.source,
    sourceRecordId: value.sourceRecordId,
    scope: value.scope,
    recordedAt: value.recordedAt,
    observedAt: value.observedAt,
    occurredAt: value.occurredAt,
    sourceTurnIds: value.sourceTurnIds,
    conversationId: value.conversationId,
    participants: value.participants,
    lineage: value.lineage,
    assertion: value.assertion,
    claim: value.claim
  });
}
