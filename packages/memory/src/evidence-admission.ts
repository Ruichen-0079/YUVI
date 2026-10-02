/** Host semantic authority, deliberately independent of workflow leases/retries and Mem0 claims. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { QueryResultRow } from "pg";
import type { MemoryRecord } from "./backend.js";
import { MemoryLineageV1Schema } from "./lineage.js";
import { canonicalLineageJson, lineageDigest } from "./lineage-encoding.js";
import type { MemoryWriteEventInput } from "./provider.js";
import { buildWriteMetadata } from "./providers/mem0-memory-provider.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const EvidenceAdmissionV1Schema = z
  .object({
    version: z.literal("evidence-admission.v1"),
    admissionId: z.string().regex(/^ea1_[a-f0-9]{64}$/u),
    scope: z.string().min(1),
    producer: z.enum(["FINALIZED_INGESTION", "DREAM_DERIVATION"]),
    logicalEventId: z.string().min(1),
    payloadDigest: digest,
    lineage: MemoryLineageV1Schema,
    lineageDigest: digest,
    effectDigest: digest,
    backend: z.literal("mem0"),
    backendRecordId: z.string().uuid().nullable(),
    state: z.enum(["PREPARED", "EFFECT_BOUND"])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.lineage.state !== "GROUNDED" ||
      value.lineage.derivation.kind !== value.producer ||
      value.lineageDigest !== lineageDigest(canonicalLineageJson(value.lineage)) ||
      value.admissionId !== admissionId(value.scope, value.logicalEventId) ||
      (value.state === "EFFECT_BOUND") !== (value.backendRecordId !== null)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Contradictory host admission." });
    }
  });
export type EvidenceAdmissionV1 = z.infer<typeof EvidenceAdmissionV1Schema>;
export type EvidenceProducer = EvidenceAdmissionV1["producer"];
export class EvidenceAdmissionIntegrityError extends Error {
  constructor() {
    super("Canonical host admission is internally contradictory.");
  }
}
function decodeAdmission(value: unknown): EvidenceAdmissionV1 {
  const parsed = EvidenceAdmissionV1Schema.safeParse(value);
  if (!parsed.success) throw new EvidenceAdmissionIntegrityError();
  return parsed.data;
}
export interface EvidenceAdmissionStore {
  prepare(value: EvidenceAdmissionV1): Promise<EvidenceAdmissionV1>;
  bind(scope: string, logicalEventId: string, backendRecordId: string): Promise<void>;
  get(scope: string, logicalEventId: string): Promise<EvidenceAdmissionV1 | null>;
  listBound(scope: string, backendRecordIds: string[]): Promise<EvidenceAdmissionV1[]>;
}
export type AdmissionQueryClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
};

function admissionId(scope: string, logicalEventId: string): string {
  return `ea1_${lineageDigest(canonicalLineageJson({ scope, logicalEventId }))}`;
}

// Mem0 adds storage bookkeeping. Every other metadata field participates in the
// immutable effect. Scope/content are bound separately, never read from claims.
const STORAGE_KEYS = new Set(["data", "hash", "user_id", "created_at", "updated_at"]);
export function memoryEffectDigest(
  record: Pick<MemoryRecord, "scope" | "content" | "metadata">
): string {
  const metadata = Object.fromEntries(
    Object.entries(record.metadata).filter(([key]) => !STORAGE_KEYS.has(key))
  );
  return lineageDigest(
    canonicalLineageJson({ scope: record.scope, content: record.content, metadata })
  );
}
export function prepareEvidenceAdmission(
  producer: EvidenceProducer,
  event: MemoryWriteEventInput
): EvidenceAdmissionV1 {
  const { signal: _signal, idempotencyKey, payloadDigest, ...semantic } = event;
  if (
    !event.scope ||
    !idempotencyKey ||
    !payloadDigest ||
    payloadDigest !== lineageDigest(canonicalLineageJson(semantic))
  )
    throw new Error("EVIDENCE_DELIVERY_IDENTITY_INVALID");
  return EvidenceAdmissionV1Schema.parse({
    version: "evidence-admission.v1",
    admissionId: admissionId(event.scope, idempotencyKey),
    scope: event.scope,
    producer,
    logicalEventId: idempotencyKey,
    payloadDigest,
    lineage: event.lineage,
    lineageDigest: lineageDigest(canonicalLineageJson(event.lineage)),
    effectDigest: memoryEffectDigest({
      scope: event.scope,
      content: event.content.trim(),
      metadata: Object.fromEntries(
        Object.entries({ schemaVersion: 1, ...buildWriteMetadata(event) }).filter(
          ([, value]) => value !== null
        )
      )
    }),
    backend: "mem0",
    backendRecordId: null,
    state: "PREPARED"
  });
}
export function matchesEvidenceEffect(
  admission: EvidenceAdmissionV1,
  record: MemoryRecord
): boolean {
  return (
    admission.state === "EFFECT_BOUND" &&
    admission.scope === record.scope &&
    admission.backendRecordId === record.id &&
    admission.effectDigest === memoryEffectDigest(record)
  );
}
function assertSamePrepared(a: EvidenceAdmissionV1, b: EvidenceAdmissionV1): void {
  if (
    canonicalLineageJson({ ...a, state: "PREPARED", backendRecordId: null }) !==
    canonicalLineageJson(b)
  )
    throw new Error("EVIDENCE_ADMISSION_CONFLICT");
}
export class InMemoryEvidenceAdmissionStore implements EvidenceAdmissionStore {
  private readonly entries = new Map<string, EvidenceAdmissionV1>();
  async prepare(value: EvidenceAdmissionV1): Promise<EvidenceAdmissionV1> {
    const parsed = EvidenceAdmissionV1Schema.parse(value);
    if (parsed.state !== "PREPARED") throw new Error("EVIDENCE_PREPARED_REQUIRED");
    const old = this.entries.get(parsed.admissionId);
    if (old) assertSamePrepared(old, parsed);
    else this.entries.set(parsed.admissionId, structuredClone(parsed));
    return structuredClone(old ?? parsed);
  }
  async get(scope: string, logicalEventId: string): Promise<EvidenceAdmissionV1 | null> {
    return structuredClone(this.entries.get(admissionId(scope, logicalEventId)) ?? null);
  }
  async bind(scope: string, logicalEventId: string, backendRecordId: string): Promise<void> {
    // No await between validation and mutation: matches PostgreSQL row fencing.
    const old = this.entries.get(admissionId(scope, logicalEventId));
    if (
      !old ||
      (old.backendRecordId && old.backendRecordId !== backendRecordId) ||
      [...this.entries.values()].some(
        (entry) =>
          entry.backendRecordId === backendRecordId && entry.admissionId !== old.admissionId
      )
    )
      throw new Error("EVIDENCE_EFFECT_CONFLICT");
    this.entries.set(
      old.admissionId,
      EvidenceAdmissionV1Schema.parse({ ...old, backendRecordId, state: "EFFECT_BOUND" })
    );
  }
  async listBound(scope: string, ids: string[]): Promise<EvidenceAdmissionV1[]> {
    const wanted = new Set(ids);
    return structuredClone(
      [...this.entries.values()].filter(
        (entry) =>
          entry.scope === scope && entry.backendRecordId && wanted.has(entry.backendRecordId)
      )
    );
  }
}
export class PostgresEvidenceAdmissionStore implements EvidenceAdmissionStore {
  constructor(private readonly database: AdmissionQueryClient) {}
  async prepare(value: EvidenceAdmissionV1): Promise<EvidenceAdmissionV1> {
    const parsed = EvidenceAdmissionV1Schema.parse(value);
    if (parsed.state !== "PREPARED") throw new Error("EVIDENCE_PREPARED_REQUIRED");
    await this.database.query(
      `insert into memory_evidence_admissions(admission_id,scope,logical_event_id,admission,state,backend_record_id)
      values($1,$2,$3,$4::jsonb,'PREPARED',null) on conflict(admission_id) do nothing`,
      [parsed.admissionId, parsed.scope, parsed.logicalEventId, JSON.stringify(parsed)]
    );
    const old = await this.get(parsed.scope, parsed.logicalEventId);
    if (!old) throw new Error("EVIDENCE_ADMISSION_MISSING");
    assertSamePrepared(old, parsed);
    return old;
  }
  async get(scope: string, logicalEventId: string): Promise<EvidenceAdmissionV1 | null> {
    const result = await this.database.query(
      "select admission from memory_evidence_admissions where scope=$1 and logical_event_id=$2",
      [scope, logicalEventId]
    );
    return result.rows[0] ? decodeAdmission(result.rows[0]["admission"]) : null;
  }
  async bind(scope: string, logicalEventId: string, backendRecordId: string): Promise<void> {
    z.string().uuid().parse(backendRecordId);
    const result = await this.database.query(
      `update memory_evidence_admissions set
      state='EFFECT_BOUND',backend_record_id=$3,admission=jsonb_set(jsonb_set(admission,'{state}','"EFFECT_BOUND"'),'{backendRecordId}',to_jsonb($3::text)),bound_at=coalesce(bound_at,now())
      where scope=$1 and logical_event_id=$2 and (backend_record_id is null or backend_record_id=$3) returning admission`,
      [scope, logicalEventId, backendRecordId]
    );
    if (!result.rows[0]) throw new Error("EVIDENCE_EFFECT_CONFLICT");
    decodeAdmission(result.rows[0]["admission"]);
  }
  async listBound(scope: string, ids: string[]): Promise<EvidenceAdmissionV1[]> {
    const result = await this.database.query(
      "select admission from memory_evidence_admissions where scope=$1 and state='EFFECT_BOUND' and backend_record_id=any($2::text[])",
      [scope, ids]
    );
    return result.rows.map((row) => decodeAdmission(row["admission"]));
  }
}
/** The existing sidecar keyed endpoint uses UUIDv5(NAMESPACE_URL, key). This is
 * effect addressing only; callers still need frozen successful host workflow proof. */
export function keyedMem0RecordId(key: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
    .update(key)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
