import type { JournalRepository } from "@companion/journal";
import { MemoryLineageV1Schema } from "../lineage.js";
import { canonicalLineageJson, lineageDigest } from "../lineage-encoding.js";
import { parseMemoryScope } from "../scope.js";
import { PostgresMemoryAuthority, authorityEvent } from "./store.js";
import { canonicalScope, MemoryAuthorityError } from "./types.js";
import { verifyMemoryProjection } from "./maintenance.js";
/** A persisted, bounded audit. A watermark is certified only for an unchanged authority version. */
export class MemoryIntegrityAudit {
  constructor(
    private readonly authority: PostgresMemoryAuthority,
    private readonly journal: JournalRepository
  ) {}
  async start(scope: string, auditId: string) {
    canonicalScope(scope);
    if (!/^[A-Za-z0-9_-]{1,160}$/u.test(auditId))
      throw new MemoryAuthorityError("MEMORY_AUDIT_ID_INVALID");
    await this.authority.pool.query(
      `insert into memory_authority_audits(scope,audit_id,anchor,status) select $1,$2,coalesce((select version from memory_authority_scopes where scope=$1),0),'RUNNING' on conflict do nothing`,
      [scope, auditId]
    );
    return this.status(scope, auditId);
  }
  async status(scope: string, auditId: string) {
    canonicalScope(scope);
    const row = (
      await this.authority.pool.query(
        "select * from memory_authority_audits where scope=$1 and audit_id=$2",
        [scope, auditId]
      )
    ).rows[0];
    if (!row) return null;
    const items = (
      await this.authority.pool.query(
        "select record_id,code from memory_authority_audit_issues where scope=$1 and audit_id=$2 order by record_id,code limit 101",
        [scope, auditId]
      )
    ).rows;
    return {
      schema: "memory.integrity.v1" as const,
      id: auditId,
      status: String(row["status"]),
      anchor: String(row["anchor"]),
      checkpoint: String(row["checkpoint"]),
      checked: String(row["checked"]),
      issues: String(row["issues"]),
      incomplete: String(row["incomplete"]),
      problems: items
        .slice(0, 100)
        .map((i) => ({ id: String(i["record_id"]), code: String(i["code"]) })),
      problemsLimited: items.length > 100
    };
  }
  async advance(scope: string, auditId: string, limit = 100) {
    canonicalScope(scope);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new MemoryAuthorityError("MEMORY_AUDIT_BATCH_INVALID");
    const job = (
      await this.authority.pool.query(
        "select * from memory_authority_audits where scope=$1 and audit_id=$2",
        [scope, auditId]
      )
    ).rows[0];
    if (!job) throw new MemoryAuthorityError("MEMORY_AUDIT_NOT_FOUND");
    if (job["status"] !== "RUNNING") return this.status(scope, auditId);
    const checkpoint = String(job["checkpoint"]),
      anchor = String(job["anchor"]);
    const rows = (
      await this.authority.pool.query(
        `select r.*,a.digest as admission_digest from memory_authority_records r left join memory_authority_admissions a on a.scope=r.scope and a.logical_key=r.logical_key where r.scope=$1 and r.version>$2 and r.version<=$3 order by r.version limit $4`,
        [scope, checkpoint, anchor, limit]
      )
    ).rows;
    const problems: { id: string; code: string }[] = [];
    let incomplete = 0;
    for (const row of rows) {
      const id = String(row["id"]);
      const fail = (code: string) => problems.push({ id, code });
      if (
        !row["semantic_payload"] ||
        lineageDigest(canonicalLineageJson(row["semantic_payload"])) !== row["digest"]
      )
        fail("PAYLOAD_DIGEST_MISMATCH");
      if (row["classification"] === "LEGACY_UNVERIFIED") {
        incomplete++;
        fail("LEGACY_PROVENANCE_UNVERIFIED");
        continue;
      }
      if (row["admission_digest"] !== row["digest"]) fail("ADMISSION_MISSING_OR_MISMATCH");
      const event = row["event"] as Record<string, any>;
      if (
        row["semantic_payload"] &&
        canonicalLineageJson(
          authorityEvent(
            row["semantic_payload"] as import("../provider.js").MemoryWriteEventInput,
            id
          )
        ) !== canonicalLineageJson(event)
      )
        fail("EVENT_PAYLOAD_MISMATCH");
      const lineage = MemoryLineageV1Schema.safeParse(event["lineage"]);
      if (!lineage.success || lineage.data.state !== "GROUNDED" || !("authority" in lineage.data)) {
        fail("LINEAGE_INVALID");
        continue;
      }
      const l = lineage.data;
      if (
        event["scope"] !== scope ||
        l.authority.binding.state !== "RESOLVED" ||
        l.authority.binding.personId !== parseMemoryScope(scope).userId
      )
        fail("SCOPE_PERSON_MISMATCH");
      for (const parent of l.parents) {
        try {
          const envelope = await this.journal.get(parent.ref);
          if (!envelope) {
            incomplete++;
            fail("JOURNAL_SOURCE_UNAVAILABLE");
            continue;
          }
          if (
            (l.sourceTime.commitSeq !== undefined &&
              l.sourceTime.commitSeq !== envelope.commitSeq) ||
            envelope.recordedAt !== l.sourceTime.recordedAt ||
            canonicalLineageJson({
              principal: envelope.authority.principal,
              binding: envelope.authority.binding,
              audience: envelope.authority.audience
            }) !== canonicalLineageJson(l.authority)
          )
            fail("SOURCE_AUTHORITY_OR_TIME_MISMATCH");
          const selector = parent.selector;
          if (selector.modality !== "TEXT") {
            incomplete++;
            fail("SOURCE_MODALITY_NOT_VERIFIED");
            continue;
          }
          const retained = await this.journal.resolveRetainedText(selector.payload);
          if (!retained) {
            incomplete++;
            fail("SOURCE_PAYLOAD_UNAVAILABLE");
            continue;
          }
          const chars = Array.from(retained.text);
          if (selector.range.end > chars.length || selector.range.end <= selector.range.start)
            fail("SOURCE_SELECTOR_INVALID");
          const selections =
            "evidenceSelectors" in envelope.command.data
              ? envelope.command.data.evidenceSelectors
              : [];
          if (!selections.some((s) => canonicalLineageJson(s) === canonicalLineageJson(selector)))
            fail("SELECTOR_NOT_ADMITTED");
        } catch (e) {
          if (e instanceof MemoryAuthorityError) throw e;
          incomplete++;
          fail("SOURCE_VERIFICATION_UNAVAILABLE");
        }
      }
    }
    if (rows.length && this.authority.indexModel) {
      const indexes = (
        await this.authority.pool.query(
          `select r.id,c.state,j.status,v.authority_version,c.version from memory_authority_records r join memory_authority_current c using(scope,id) left join memory_authority_index_jobs j on j.scope=r.scope and j.id=r.id and j.model_tag=$3 left join memory_authority_vectors v on v.scope=r.scope and v.id=r.id and v.model_tag=$3 where r.scope=$1 and r.id=any($2::text[])`,
          [scope, rows.map((r) => r["id"]), this.authority.indexModel]
        )
      ).rows;
      for (const i of indexes)
        if (
          ["current", "conflicted"].includes(String(i["state"])) &&
          (i["status"] !== "complete" || String(i["authority_version"]) !== String(i["version"]))
        ) {
          incomplete++;
          problems.push({ id: String(i["id"]), code: "INDEX_NOT_CURRENT_UNAVAILABLE" });
        }
    }
    if (rows.length) {
      const receipts = (
        await this.authority.pool.query(
          `select r.id from memory_authority_records r where r.scope=$1 and r.id=any($2::text[]) and r.logical_key like 'yuvi:finalized-turn:%' and not exists(select 1 from finalized_ingestion_events e where e.backend_memory_id=r.id and e.status in ('complete','unchanged'))`,
          [scope, rows.map((r) => r["id"])]
        )
      ).rows;
      for (const r of receipts) {
        incomplete++;
        problems.push({ id: String(r["id"]), code: "FINALIZED_RECEIPT_UNAVAILABLE" });
      }
    }
    const verification = await verifyMemoryProjection(
      this.authority.pool,
      scope,
      checkpoint,
      limit
    );
    for (const mismatch of verification.mismatches)
      problems.push({ id: mismatch.id, code: "PROJECTION_MISMATCH" });
    // Validate only the bounded batch's edges; FK and version index avoid scope scans.
    if (rows.length) {
      const edges = (
        await this.authority.pool.query(
          `select e.from_id,e.to_id,e.kind,e.version,f.source_at as from_time,t.source_at as to_time,f.version as from_version,t.version as to_version,f.event->'lineage'->'sourceTime'->>'commitSeq' as from_seq,t.event->'lineage'->'sourceTime'->>'commitSeq' as to_seq,f.event->'lineage'->'parents'->0->'ref'->>'namespace' as from_namespace,t.event->'lineage'->'parents'->0->'ref'->>'namespace' as to_namespace,f.event->'lineage'->'authority' as from_authority,t.event->'lineage'->'authority' as to_authority from memory_authority_relations e join memory_authority_records f on f.scope=e.scope and f.id=e.from_id join memory_authority_records t on t.scope=e.scope and t.id=e.to_id where e.scope=$1 and e.from_id=any($2::text[])`,
          [scope, rows.map((r) => r["id"])]
        )
      ).rows;
      for (const edge of edges)
        if (
          String(edge["version"]) !== String(edge["from_version"]) ||
          BigInt(edge["to_version"]) >= BigInt(edge["from_version"]) ||
          (edge["kind"] === "supersedes" &&
            !(edge["from_namespace"] === edge["to_namespace"] &&
            /^\d+$/.test(String(edge["from_seq"])) &&
            /^\d+$/.test(String(edge["to_seq"]))
              ? BigInt(edge["from_seq"]) > BigInt(edge["to_seq"])
              : new Date(edge["from_time"]).getTime() > new Date(edge["to_time"]).getTime())) ||
          canonicalLineageJson((edge["from_authority"] as any)?.principal) !==
            canonicalLineageJson((edge["to_authority"] as any)?.principal) ||
          (edge["from_authority"] as any)?.binding?.personId !==
            (edge["to_authority"] as any)?.binding?.personId
        )
          problems.push({ id: String(edge["from_id"]), code: "RELATION_INVALID" });
    }
    await this.authority.transaction(async (tx) => {
      const current = (
        await tx.query("select version from memory_authority_scopes where scope=$1 for share", [
          scope
        ])
      ).rows[0];
      const locked = (
        await tx.query(
          "select checkpoint,status from memory_authority_audits where scope=$1 and audit_id=$2 for update",
          [scope, auditId]
        )
      ).rows[0]!;
      if (String(locked["checkpoint"]) !== checkpoint || locked["status"] !== "RUNNING") return;
      if (String(current?.["version"] ?? "0") !== anchor) {
        await tx.query(
          "update memory_authority_audits set status='STALE',updated_at=now() where scope=$1 and audit_id=$2",
          [scope, auditId]
        );
        return;
      }
      for (const problem of problems)
        await tx.query(
          "insert into memory_authority_audit_issues(scope,audit_id,record_id,code) values($1,$2,$3,$4) on conflict do nothing",
          [scope, auditId, problem.id, problem.code]
        );
      const next = String(rows.at(-1)?.["version"] ?? checkpoint);
      const exhausted = rows.length < limit || next === anchor;
      const severe = problems.some(
        (p) =>
          !p.code.includes("UNAVAILABLE") &&
          p.code !== "LEGACY_PROVENANCE_UNVERIFIED" &&
          p.code !== "SOURCE_MODALITY_NOT_VERIFIED"
      );
      const hasSevere =
        (
          await tx.query(
            `select exists(select 1 from memory_authority_audit_issues where scope=$1 and audit_id=$2 and code not like '%UNAVAILABLE%' and code not in ('LEGACY_PROVENANCE_UNVERIFIED','SOURCE_MODALITY_NOT_VERIFIED')) as bad`,
            [scope, auditId]
          )
        ).rows[0]!["bad"] === true;
      await tx.query(
        `update memory_authority_audits set checkpoint=$3,checked=checked+$4,issues=(select count(*) from memory_authority_audit_issues where scope=$1 and audit_id=$2),incomplete=incomplete+$5,status=$6,updated_at=now() where scope=$1 and audit_id=$2`,
        [
          scope,
          auditId,
          next,
          rows.length,
          incomplete,
          exhausted
            ? severe || hasSevere
              ? "FAILED"
              : Number(job["incomplete"]) + incomplete > 0
                ? "INCOMPLETE"
                : "VERIFIED"
            : "RUNNING"
        ]
      );
    });
    return this.status(scope, auditId);
  }
}
