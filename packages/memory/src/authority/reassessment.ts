import { randomUUID } from "node:crypto";
import type { JournalRepository } from "@companion/journal";
import type { MemoryWriteEventInput } from "../provider.js";
import { JournalMemoryGroundingResolver } from "../lineage.js";
import { freezeFinalizedMemoryEvent } from "../finalized-memory-lineage.js";
import { lineageDigest, canonicalLineageJson } from "../lineage-encoding.js";
import { MemoryAuthorityError } from "./types.js";
import { PostgresMemoryAuthority } from "./store.js";
import type { SemanticMemoryPolicy } from "./semantic-policy.js";

/** Re-evaluates a no-effect stale decision. The original frozen delivery identity is retained. */
export class MemoryDecisionReassessment {
  constructor(
    private readonly authority: PostgresMemoryAuthority,
    private readonly policy: SemanticMemoryPolicy,
    private readonly journal: JournalRepository
  ) {}
  async reconcile(scope: string, key: string, digest: string) {
    const row = (
      await this.authority.pool.query(
        "select * from memory_decision_reassessments where scope=$1 and logical_key=$2",
        [scope, key]
      )
    ).rows[0];
    if (!row) return null;
    if (row["original_digest"] !== digest) return { status: "payload_conflict" as const };
    if (row["resolved_key"] && row["resolved_digest"]) {
      const result = await this.authority.reconcile(
        scope,
        String(row["resolved_key"]),
        String(row["resolved_digest"])
      );
      if (result.status === "applied") return result;
    }
    return {
      status: row["status"] === "processing" ? ("in_flight" as const) : ("not_applied" as const),
      errorCode: row["error_code"] as string | null
    };
  }
  async apply(input: MemoryWriteEventInput) {
    const db = this.authority.pool,
      key = input.idempotencyKey!,
      digest = input.payloadDigest!;
    await db.query(
      `insert into memory_decision_reassessments(scope,logical_key,original_digest,status) values($1,$2,$3,'pending') on conflict do nothing`,
      [input.scope, key, digest]
    );
    const old = (
      await db.query(
        "select * from memory_decision_reassessments where scope=$1 and logical_key=$2",
        [input.scope, key]
      )
    ).rows[0]!;
    if (old["original_digest"] !== digest)
      throw new MemoryAuthorityError("MEMORY_PAYLOAD_CONFLICT");
    if (old["resolved_key"] && old["resolved_digest"]) {
      const already = await this.authority.reconcile(
        input.scope,
        String(old["resolved_key"]),
        String(old["resolved_digest"])
      );
      if (already.status === "applied") {
        await db.query(
          "update memory_decision_reassessments set status='complete',resolved_event_id=$3,lease_owner=null,lease_until=null,updated_at=now() where scope=$1 and logical_key=$2",
          [input.scope, key, already.eventId]
        );
        return { eventId: already.eventId!, inserted: false };
      }
      if (already.status !== "not_applied") throw new Error("MEMORY_REASSESSMENT_COMMIT_UNKNOWN");
    }
    const owner = randomUUID();
    const claimed = (
      await db.query(
        `update memory_decision_reassessments set generation=generation+1,status='processing',lease_owner=$3,lease_until=now()+interval '60 seconds',updated_at=now()
      where scope=$1 and logical_key=$2 and generation<3 and (status in ('pending','retryable_failed') or (status='processing' and lease_until<=now())) returning generation`,
        [input.scope, key, owner]
      )
    ).rows[0];
    if (!claimed) throw new Error("MEMORY_REASSESSMENT_BUSY_OR_EXHAUSTED");
    const generation = Number(claimed["generation"]);
    try {
      const lineage = input.lineage;
      if (
        lineage?.state !== "GROUNDED" ||
        !("derivation" in lineage) ||
        lineage.derivation.kind !== "FINALIZED_INGESTION" ||
        lineage.parents.length !== 1
      )
        throw new MemoryAuthorityError("MEMORY_REASSESSMENT_SOURCE_UNSUPPORTED");
      const parent = lineage.parents[0]!,
        selector = parent.selector;
      if (selector.modality !== "TEXT")
        throw new MemoryAuthorityError("MEMORY_REASSESSMENT_SOURCE_UNSUPPORTED");
      const retained = await this.journal.resolveRetainedText(selector.payload);
      if (!retained) throw new Error("MEMORY_REASSESSMENT_SOURCE_UNAVAILABLE");
      const selected = Array.from(retained.text)
        .slice(selector.range.start, selector.range.end)
        .join("");
      const source = await new JournalMemoryGroundingResolver(this.journal).resolve({
        sourceJournalRef: parent.ref,
        sourceText: selected
      });
      const jobId = `${key}:reassessment:${generation}`;
      const evaluation = await this.policy.build({
        scope: input.scope,
        userMessage: selected,
        assistantMessage: "",
        groundedSource: source,
        idempotencyKey: jobId,
        reassessment: { proposition: input.content, originalKey: key }
      });
      if (evaluation.events.length !== 1)
        throw new MemoryAuthorityError("MEMORY_REASSESSMENT_UNRESOLVED");
      const semantic = freezeFinalizedMemoryEvent(
        source,
        evaluation.events[0]!,
        lineage.derivation.policyVersion
      );
      const next = {
        ...semantic,
        idempotencyKey: jobId,
        payloadDigest: lineageDigest(canonicalLineageJson(semantic))
      };
      const fenced = await db.query(
        `update memory_decision_reassessments set resolved_key=$4,resolved_digest=$5 where scope=$1 and logical_key=$2 and lease_owner=$3 and lease_until>now() returning logical_key`,
        [input.scope, key, owner, jobId, next.payloadDigest]
      );
      if (!fenced.rows.length) throw new Error("MEMORY_REASSESSMENT_LEASE_LOST");
      await this.authority.prepare("FINALIZED_INGESTION", next);
      const committed = await this.authority.commit(next, { logicalKey: key, leaseOwner: owner });
      return { eventId: committed.event.id, inserted: committed.inserted };
    } catch (e) {
      await db.query(
        `update memory_decision_reassessments set status=case when generation>=3 then 'terminal_failed' else 'retryable_failed' end,error_code=$4,lease_owner=null,lease_until=null,updated_at=now() where scope=$1 and logical_key=$2 and lease_owner=$3`,
        [
          input.scope,
          key,
          owner,
          e instanceof MemoryAuthorityError ? e.code : "MEMORY_REASSESSMENT_UNKNOWN"
        ]
      );
      throw e;
    }
  }
}
