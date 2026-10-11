import { parseMemoryScope } from "../scope.js";
import { createHash } from "node:crypto";
import { MemoryLineageV1Schema } from "../lineage.js";
import { canonicalLineageJson, lineageDigest } from "../lineage-encoding.js";
import type { EvidenceProducer } from "../evidence-admission.js";
import type { MemoryEvent, MemoryWriteEventInput } from "../provider.js";
import {
  canonicalScope,
  eventSemantic,
  MemoryAuthorityError,
  searchTerms,
  type AuthorityPool,
  type AuthorityQuery
} from "./types.js";

const poolHealth = new WeakMap<object, { failures: number; lastFailureAt: string | null }>();
export class PostgresMemoryAuthority {
  constructor(
    readonly pool: AuthorityPool,
    readonly indexModel?: string
  ) {
    if (!pool || typeof pool.connect !== "function")
      throw new MemoryAuthorityError("MEMORY_AUTHORITY_REQUIRES_TRANSACTION_POOL");
    if (!poolHealth.has(pool)) {
      const health = { failures: 0, lastFailureAt: null as string | null };
      poolHealth.set(pool, health);
      pool.on?.("error", () => {
        health.failures++;
        health.lastFailureAt = new Date().toISOString();
      });
    }
  }
  getDatabaseDiagnostics() {
    return { ...poolHealth.get(this.pool)! };
  }
  async prepare(producer: EvidenceProducer, input: MemoryWriteEventInput): Promise<void> {
    this.validate(input);
    if (input.lineage?.state !== "GROUNDED" || input.lineage.derivation.kind !== producer)
      throw new MemoryAuthorityError("MEMORY_PRODUCER_MISMATCH");
    const inserted = await this.pool.query(
      `insert into memory_authority_admissions(scope,logical_key,digest,producer)
      values($1,$2,$3,$4) on conflict do nothing returning digest`,
      [input.scope, input.idempotencyKey, input.payloadDigest, producer]
    );
    if (!inserted.rows.length) {
      const old = await this.pool.query(
        "select digest,producer from memory_authority_admissions where scope=$1 and logical_key=$2",
        [input.scope, input.idempotencyKey]
      );
      if (old.rows[0]?.["digest"] !== input.payloadDigest || old.rows[0]?.["producer"] !== producer)
        throw new MemoryAuthorityError("MEMORY_ADMISSION_CONFLICT");
    }
  }
  validate(input: MemoryWriteEventInput): void {
    canonicalScope(input.scope);
    if (
      !input.idempotencyKey ||
      !input.payloadDigest ||
      !input.content.trim() ||
      input.content.length > 16_000 ||
      input.payloadDigest !== lineageDigest(canonicalLineageJson(eventSemantic(input)))
    )
      throw new MemoryAuthorityError("MEMORY_DELIVERY_IDENTITY_INVALID");
    const parsed = MemoryLineageV1Schema.safeParse(input.lineage);
    if (
      !parsed.success ||
      parsed.data.state !== "GROUNDED" ||
      !("authority" in parsed.data) ||
      !["USER_ASSERTION", "EXTERNAL_OBSERVATION"].includes(parsed.data.origin)
    )
      throw new MemoryAuthorityError("MEMORY_GROUNDED_SOURCE_REQUIRED");
    if (
      "authority" in parsed.data &&
      parsed.data.authority.binding.state === "RESOLVED" &&
      parsed.data.authority.binding.personId !== parseMemoryScope(input.scope).userId
    )
      throw new MemoryAuthorityError("MEMORY_SCOPE_PERSON_MISMATCH");
    if (
      ![input.supersedes, input.conflicts, input.supports].every(
        (ids) => !ids || (ids.length <= 8 && new Set(ids).size === ids.length)
      )
    )
      throw new MemoryAuthorityError("MEMORY_RELATION_BOUND");
    const kinds = [input.supersedes, input.conflicts, input.supports].filter((ids) => ids?.length);
    if (kinds.length > 1) throw new MemoryAuthorityError("MEMORY_RELATION_AMBIGUOUS");
  }
  async commit(
    input: MemoryWriteEventInput,
    reassessment?: { logicalKey: string; leaseOwner: string }
  ): Promise<{ event: MemoryEvent; inserted: boolean }> {
    this.validate(input);
    return this.transaction(async (tx) => {
      const admission = await tx.query(
        "select digest from memory_authority_admissions where scope=$1 and logical_key=$2",
        [input.scope, input.idempotencyKey]
      );
      if (admission.rows[0]?.["digest"] !== input.payloadDigest)
        throw new MemoryAuthorityError("MEMORY_HOST_ADMISSION_REQUIRED");
      await tx.query(
        "insert into memory_authority_scopes(scope) values($1) on conflict do nothing",
        [input.scope]
      );
      await tx.query("select version from memory_authority_scopes where scope=$1 for update", [
        input.scope
      ]);
      if (reassessment) {
        const fenced = await tx.query(
          `select logical_key from memory_decision_reassessments where scope=$1 and logical_key=$2 and lease_owner=$3 and lease_until>now() and resolved_key=$4 and resolved_digest=$5 for update`,
          [
            input.scope,
            reassessment.logicalKey,
            reassessment.leaseOwner,
            input.idempotencyKey,
            input.payloadDigest
          ]
        );
        if (!fenced.rows.length) throw new MemoryAuthorityError("MEMORY_REASSESSMENT_LEASE_LOST");
      }
      const old = await tx.query(
        "select digest,event from memory_authority_records where scope=$1 and logical_key=$2",
        [input.scope, input.idempotencyKey]
      );
      if (old.rows[0]) {
        if (old.rows[0]["digest"] !== input.payloadDigest)
          throw new MemoryAuthorityError("MEMORY_PAYLOAD_CONFLICT");
        return { event: old.rows[0]["event"] as MemoryEvent, inserted: false };
      }
      const targets = await this.validateTargets(tx, input);
      const version = (
        await tx.query(
          "update memory_authority_scopes set version=version+1 where scope=$1 returning version",
          [input.scope]
        )
      ).rows[0]!["version"] as string;
      const id = authorityId(input.scope, input.idempotencyKey!);
      const event = authorityEvent(input, id);
      const terms = searchTerms(event.content).join(" ");
      await tx.query(
        `insert into memory_authority_records(scope,id,logical_key,digest,version,source_at,classification,event,search_terms,semantic_payload)
        values($1,$2,$3,$4,$5,$6,'GROUNDED',$7,$8,$9)`,
        [
          input.scope,
          id,
          input.idempotencyKey,
          input.payloadDigest,
          version,
          input.lineage && "sourceTime" in input.lineage
            ? input.lineage.sourceTime.recordedAt
            : null,
          event,
          terms,
          eventSemantic(input)
        ]
      );
      const lineage = input.lineage!;
      const attributed =
        lineage.state === "GROUNDED" &&
        "authority" in lineage &&
        lineage.authority.principal.state === "RESOLVED" &&
        lineage.authority.binding.state === "RESOLVED" &&
        lineage.authority.audience.kind === "PRIVATE";
      const state = !attributed
        ? "unattributed"
        : input.supports?.length
          ? "supporting"
          : input.conflicts?.length
            ? "conflicted"
            : "current";
      await tx.query(
        `insert into memory_authority_current(scope,id,version,state,search) values($1,$2,$3,$4,to_tsvector('simple',$5))`,
        [input.scope, id, version, state, terms]
      );
      if (this.indexModel && ["current", "conflicted"].includes(state))
        await tx.query(
          `insert into memory_authority_index_jobs(scope,id,model_tag) values($1,$2,$3) on conflict do nothing`,
          [input.scope, id, this.indexModel]
        );
      for (const target of targets) {
        await tx.query(
          "insert into memory_authority_relations(scope,from_id,to_id,kind,version) values($1,$2,$3,$4,$5)",
          [input.scope, id, target.id, target.kind, version]
        );
        if (target.kind !== "supports")
          await tx.query("update memory_authority_current set state=$3 where scope=$1 and id=$2", [
            input.scope,
            target.id,
            target.kind === "supersedes" ? "superseded" : "conflicted"
          ]);
      }
      if (input.supersedes?.length)
        await tx.query(
          "delete from memory_authority_vectors where scope=$1 and id=any($2::text[])",
          [input.scope, input.supersedes]
        );
      await tx.query(
        `update memory_authority_scopes set record_count=record_count+1,
        current_count=current_count+$2, unattributed_count=unattributed_count+$3, projection_version=version where scope=$1`,
        [
          input.scope,
          (["current", "conflicted"].includes(state) ? 1 : 0) - (input.supersedes?.length ?? 0),
          state === "unattributed" ? 1 : 0
        ]
      );
      if (reassessment)
        await tx.query(
          `update memory_decision_reassessments set status='complete',resolved_event_id=$3,error_code=null,lease_owner=null,lease_until=null,updated_at=now() where scope=$1 and logical_key=$2`,
          [input.scope, reassessment.logicalKey, id]
        );
      return { event, inserted: true };
    });
  }
  private async validateTargets(tx: AuthorityQuery, input: MemoryWriteEventInput) {
    const targets = [
      ...(input.supersedes ?? []).map((id) => ({ id, kind: "supersedes" as const })),
      ...(input.conflicts ?? []).map((id) => ({ id, kind: "conflicts" as const })),
      ...(input.supports ?? []).map((id) => ({ id, kind: "supports" as const }))
    ];
    if (!targets.length) return targets;
    const source = input.lineage;
    if (
      source?.state !== "GROUNDED" ||
      !("authority" in source) ||
      source.origin !== "USER_ASSERTION" ||
      source.authority.principal.state !== "RESOLVED" ||
      source.authority.binding.state !== "RESOLVED"
    )
      throw new MemoryAuthorityError("MEMORY_RELATION_AUTHORITY_UNRESOLVED");
    const rows = await tx.query(
      `select r.id,r.event,r.source_at,c.state from memory_authority_records r
      join memory_authority_current c using(scope,id) where r.scope=$1 and r.id=any($2::text[])`,
      [input.scope, targets.map((t) => t.id)]
    );
    for (const target of targets) {
      const row = rows.rows.find((r) => r["id"] === target.id);
      if (!row || !["current", "conflicted"].includes(String(row["state"])))
        throw new MemoryAuthorityError("MEMORY_TARGET_STALE_OR_INACCESSIBLE");
      const prior = (row["event"] as MemoryEvent).lineage;
      if (
        prior?.state !== "GROUNDED" ||
        !("authority" in prior) ||
        prior.origin !== "USER_ASSERTION" ||
        prior.authority.principal.state !== "RESOLVED" ||
        prior.authority.binding.state !== "RESOLVED" ||
        prior.authority.principal.namespace !== source.authority.principal.namespace ||
        prior.authority.principal.actorId !== source.authority.principal.actorId ||
        prior.authority.binding.personId !== source.authority.binding.personId
      )
        throw new MemoryAuthorityError("MEMORY_TARGET_AUTHORITY_MISMATCH");
      const sourceSeq = source.sourceTime.commitSeq,
        priorSeq = prior.sourceTime.commitSeq;
      const sameJournal = source.parents[0]?.ref.namespace === prior.parents[0]?.ref.namespace;
      const later =
        sameJournal && sourceSeq && priorSeq
          ? sourceSeq > priorSeq
          : new Date(String(row["source_at"])).getTime() < Date.parse(source.sourceTime.recordedAt);
      if (target.kind === "supersedes" && !later)
        throw new MemoryAuthorityError("MEMORY_TARGET_TIME_ORDER");
    }
    return targets;
  }
  async reconcile(scope: string, key: string, digest: string) {
    canonicalScope(scope);
    const row = (
      await this.pool.query(
        "select id,digest from memory_authority_records where scope=$1 and logical_key=$2",
        [scope, key]
      )
    ).rows[0];
    return row
      ? row["digest"] === digest
        ? { status: "applied" as const, eventId: String(row["id"]) }
        : { status: "payload_conflict" as const }
      : { status: "not_applied" as const };
  }
  /** Privileged migration path: preserves legacy provenance, never manufactures grounding. */
  async importLegacy(
    input: { scope: string; source: string; sourceId: string; event: MemoryEvent },
    tx?: AuthorityQuery
  ): Promise<boolean> {
    canonicalScope(input.scope);
    const work = async (q: AuthorityQuery) => {
      await q.query(
        "insert into memory_authority_scopes(scope) values($1) on conflict do nothing",
        [input.scope]
      );
      await q.query("select version from memory_authority_scopes where scope=$1 for update", [
        input.scope
      ]);
      const key = `legacy:${input.source}:${input.sourceId}`;
      const digest = lineageDigest(canonicalLineageJson(input.event));
      const old = (
        await q.query(
          "select digest from memory_authority_records where scope=$1 and logical_key=$2",
          [input.scope, key]
        )
      ).rows[0];
      if (old) {
        if (old["digest"] !== digest)
          throw new MemoryAuthorityError("MEMORY_LEGACY_PAYLOAD_CONFLICT");
        return false;
      }
      const version = (
        await q.query(
          "update memory_authority_scopes set version=version+1 where scope=$1 returning version",
          [input.scope]
        )
      ).rows[0]!["version"];
      const id = authorityId(input.scope, key);
      // Preserve original lineage only in protected authority payload. Classification remains unverified.
      const event: MemoryEvent = {
        ...input.event,
        id,
        source: "postgres",
        sourceRecordId: id,
        scope: input.scope,
        metadata: {
          ...input.event.metadata,
          legacySource: input.source,
          legacySourceId: input.sourceId
        }
      };
      const sourceAt = input.event.recordedAt ?? input.event.observedAt ?? null;
      if (!sourceAt || !Number.isFinite(Date.parse(sourceAt)))
        throw new MemoryAuthorityError("MEMORY_LEGACY_SOURCE_TIME_UNKNOWN");
      const terms = searchTerms(event.content).join(" ");
      await q.query(
        `insert into memory_authority_records(scope,id,logical_key,digest,version,source_at,classification,event,search_terms,semantic_payload)
        values($1,$2,$3,$4,$5,$6,'LEGACY_UNVERIFIED',$7,$8,$9)`,
        [input.scope, id, key, digest, version, sourceAt, event, terms, input.event]
      );
      await q.query(
        `insert into memory_authority_current(scope,id,version,state,search) values($1,$2,$3,'legacy_unverified',to_tsvector('simple',$4))`,
        [input.scope, id, version, terms]
      );
      await q.query(
        "update memory_authority_scopes set record_count=record_count+1,legacy_count=legacy_count+1,projection_version=version where scope=$1",
        [input.scope]
      );
      return true;
    };
    return tx ? work(tx) : this.transaction(work);
  }
  async transaction<T>(work: (tx: AuthorityQuery) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let connectionError: Error | undefined;
    const observeError = (error: Error) => {
      connectionError = error;
    };
    client.on?.("error", observeError);
    try {
      await client.query("begin");
      const result = await work(client);
      if (connectionError) throw connectionError;
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        /* Preserve original, possibly ambiguous COMMIT error. */
      }
      throw error;
    } finally {
      client.release();
      client.off?.("error", observeError);
    }
  }
}
export function authorityId(scope: string, key: string): string {
  return `pgm1_${createHash("sha256")
    .update(canonicalLineageJson([scope, key]))
    .digest("hex")}`;
}
export function authorityEvent(input: MemoryWriteEventInput, id: string): MemoryEvent {
  const {
    signal: _signal,
    idempotencyKey: _key,
    payloadDigest: _digest,
    supersedes: _supersedes,
    conflicts: _conflicts,
    supports: _supports,
    ...semantic
  } = input;
  return {
    ...semantic,
    id,
    source: "postgres",
    sourceRecordId: id,
    metadata: input.metadata ?? {},
    recordedAt:
      input.lineage && "sourceTime" in input.lineage ? input.lineage.sourceTime.recordedAt : null
  };
}
