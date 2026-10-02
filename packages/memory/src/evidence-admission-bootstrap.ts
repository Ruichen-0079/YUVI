/** Versioned host reconstruction. Never enumerates Mem0 or promotes its metadata.
 * A successful frozen host workflow proves the expected immutable effect; the
 * source reader separately requires that exact effect to be present and equal.
 */
import { canonicalLineageJson } from "./lineage-encoding.js";
import { stampDreamWriteEvent } from "./dream-delivery.js";
import {
  DreamSourceSnapshotV1Schema,
  dreamSourceDigest,
  groundedDreamStatements,
  freezeDerivedDreamEvent,
  canonicalDreamSources
} from "./dream-source.js";
import {
  prepareEvidenceAdmission,
  keyedMem0RecordId,
  type EvidenceAdmissionStore,
  type AdmissionQueryClient,
  type EvidenceAdmissionV1
} from "./evidence-admission.js";
import type { MemoryWriteEventInput } from "./provider.js";
import type { FinalizedIngestionEvent } from "./finalized-ingestion-ledger.js";
import type { DreamJob } from "./dream-consolidation.js";

export type AdmissionBootstrapCounts = { prepared: number; bound: number; unsupported: number };
export type FinalizedAdmissionHistory = Pick<
  FinalizedIngestionEvent,
  "eventPayload" | "backendIdempotencyKey" | "backendMemoryId" | "status"
>;
export type DreamAdmissionHistory = Pick<
  DreamJob,
  "jobId" | "sourceSnapshot" | "sourceDigest" | "memoryScope" | "resultEventPayloads" | "status"
>;

export async function reconstructEvidenceAdmissions(
  store: EvidenceAdmissionStore,
  input: {
    finalized?: readonly FinalizedAdmissionHistory[];
    dreams?: readonly DreamAdmissionHistory[];
  }
): Promise<AdmissionBootstrapCounts> {
  const counts = { prepared: 0, bound: 0, unsupported: 0 };
  const establish = async (admission: EvidenceAdmissionV1, recordId: string | null) => {
    await store.prepare(admission);
    counts.prepared += 1;
    if (recordId) {
      await store.bind(admission.scope, admission.logicalEventId, recordId);
      counts.bound += 1;
    }
  };
  for (const event of input.finalized ?? []) {
    let admission: EvidenceAdmissionV1;
    let id: string | null = null;
    try {
      admission = prepareEvidenceAdmission("FINALIZED_INGESTION", event.eventPayload);
      if (
        event.backendIdempotencyKey !== admission.logicalEventId ||
        !admission.logicalEventId.startsWith("yuvi:finalized-turn:")
      )
        throw new Error("Historical event identity is not provable.");
      if (
        (event.status === "complete" || event.status === "unchanged") &&
        event.backendMemoryId?.startsWith("mem0:")
      ) {
        id = event.backendMemoryId.slice(5);
        if (id !== keyedMem0RecordId(admission.logicalEventId))
          throw new Error("Historical effect identity conflicts.");
      }
    } catch {
      counts.unsupported += 1;
      continue;
    }
    await establish(admission, id);
  }
  for (const job of input.dreams ?? []) {
    const proven: EvidenceAdmissionV1[] = [];
    try {
      const snapshot = DreamSourceSnapshotV1Schema.parse(job.sourceSnapshot);
      if (dreamSourceDigest(snapshot, job.memoryScope) !== job.sourceDigest)
        throw new Error("Frozen Dream source conflict.");
      const sources = canonicalDreamSources(
        groundedDreamStatements(snapshot).map((entry) => entry.source!)
      );
      for (const event of job.resultEventPayloads ?? []) {
        const expected = stampDreamWriteEvent(job.jobId, freezeDerivedDreamEvent(event, sources));
        if (
          event.scope !== job.memoryScope ||
          canonicalLineageJson(expected) !== canonicalLineageJson(event)
        )
          throw new Error("Frozen Dream result conflict.");
        proven.push(prepareEvidenceAdmission("DREAM_DERIVATION", event));
      }
    } catch {
      counts.unsupported += 1;
      continue;
    }
    for (const admission of proven)
      await establish(
        admission,
        job.status === "complete" ? keyedMem0RecordId(admission.logicalEventId) : null
      );
  }
  return counts;
}

/** Bounded keyset scan, once at composition startup. Host SQL alone supplies
 * history; no sidecar availability dependency and no Profile fallback branches. */
export async function bootstrapPostgresEvidenceAdmissions(
  database: AdmissionQueryClient,
  store: EvidenceAdmissionStore
): Promise<AdmissionBootstrapCounts> {
  const counts = { prepared: 0, bound: 0, unsupported: 0 };
  const add = (next: AdmissionBootstrapCounts) => {
    counts.prepared += next.prepared;
    counts.bound += next.bound;
    counts.unsupported += next.unsupported;
  };
  let after = "";
  for (;;) {
    const page = await database.query(
      `select event_id,event_payload,backend_idempotency_key,backend_memory_id,status from finalized_ingestion_events where event_id > $1 order by event_id limit 128`,
      [after]
    );
    if (!page.rows.length) break;
    add(
      await reconstructEvidenceAdmissions(store, {
        finalized: page.rows.map((row) => ({
          eventPayload: row["event_payload"],
          backendIdempotencyKey: row["backend_idempotency_key"],
          backendMemoryId: row["backend_memory_id"],
          status: row["status"]
        }))
      })
    );
    after = page.rows.at(-1)!["event_id"];
  }
  after = "";
  for (;;) {
    const page = await database.query(
      `select job_id,source_snapshot,source_digest,memory_scope,result_event_payloads,status from dream_jobs where job_id > $1 order by job_id limit 128`,
      [after]
    );
    if (!page.rows.length) break;
    add(
      await reconstructEvidenceAdmissions(store, {
        dreams: page.rows.map((row) => ({
          jobId: row["job_id"],
          sourceSnapshot: row["source_snapshot"],
          sourceDigest: row["source_digest"],
          memoryScope: row["memory_scope"],
          resultEventPayloads: row["result_event_payloads"],
          status: row["status"]
        }))
      })
    );
    after = page.rows.at(-1)!["job_id"];
  }
  return counts;
}
