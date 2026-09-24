import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  JournalAuthoritySnapshotSchema,
  JournalCommittedEnvelopeSchema,
  JournalContractError,
  JournalEventCommandSchema,
  JOURNAL_ENVELOPE_VERSION,
  validateJournalCommand,
  validateJournalEnvelope,
  type JournalAuthoritySnapshot,
  type JournalCommittedEnvelope,
  type DeepReadonly,
  type JournalEventCommand,
  type JournalEventRef,
  type JournalHistoryEntry,
  type JournalPayloadDescriptor
} from "@companion/protocol";

export type JournalAuthorityDraft = Omit<JournalAuthoritySnapshot, "journalNamespace">;

/** Host policy creates authority fields. Append callers can submit only evidence proposals. */
export type JournalAuthorityBuilder = (input: {
  command: JournalEventCommand;
  payloads: readonly JournalPayloadDescriptor[];
}) => JournalAuthorityDraft;

export type JournalRetainedTextPayload = {
  ref: JournalPayloadDescriptor["ref"];
  text: string;
};

export type JournalSourceDedupInput = {
  namespace: string;
  key: string;
  /** Already normalized by the trusted source adapter; this value is hashed, never stored. */
  normalizedPayload: string | Uint8Array;
};

export type JournalAppendInput = {
  command: unknown;
  /** Source catalog proposals; host policy decides which descriptors enter the envelope. */
  payloads?: readonly JournalPayloadDescriptor[];
  retainedText?: readonly JournalRetainedTextPayload[];
  sourceDedup?: JournalSourceDedupInput;
};

/** Producer command and retained payload only; host authority is a separate argument. */
export type JournalHostAppendInput = {
  command: unknown;
  retainedText?: readonly JournalRetainedTextPayload[];
};

export type JournalAppendResult = {
  status: "APPENDED" | "DEDUPLICATED";
  envelope: DeepReadonly<JournalCommittedEnvelope>;
};

export type JournalStoreErrorCode =
  | "DATABASE_UNAVAILABLE"
  | "TRANSACTION_FAILED"
  | "INVALID_PROPOSAL"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNKNOWN_PARENT"
  | "CROSS_NAMESPACE_PARENT"
  | "PARENT_ORDER_INVALID"
  | "SOURCE_DEDUP_CONFLICT"
  | "PAYLOAD_PERSISTENCE_FAILED"
  | "UNSUPPORTED_CROSS_NAMESPACE_HISTORY";

export class JournalStoreError extends Error {
  readonly code: JournalStoreErrorCode;
  readonly causeValue: unknown;

  constructor(code: JournalStoreErrorCode, message: string, causeValue?: unknown) {
    super(message);
    this.name = "JournalStoreError";
    this.code = code;
    this.causeValue = causeValue;
  }
}

export interface JournalRepository {
  readonly namespace: string;
  append(input: JournalAppendInput): Promise<JournalAppendResult>;
  appendWithHostAuthority(
    input: JournalHostAppendInput,
    authority: JournalAuthorityDraft
  ): Promise<JournalAppendResult>;
  get(ref: JournalEventRef): Promise<DeepReadonly<JournalCommittedEnvelope> | null>;
  resolveRetainedText(ref: JournalPayloadDescriptor["ref"]): Promise<{
    descriptor: DeepReadonly<JournalPayloadDescriptor>;
    text: string;
  } | null>;
}

export type JournalRepositoryOptions = {
  namespace: string;
  authorityBuilder: JournalAuthorityBuilder;
  now?: () => Date;
  createEventId?: () => string;
};

type PgRow = Record<string, unknown>;
type PgClient = Pick<PoolClient, "query" | "release">;

/** PostgreSQL is the only A8.2a durability implementation; this class never falls back in memory. */
export class PostgresJournalRepository implements JournalRepository {
  readonly namespace: string;
  private readonly pool: Pool;
  private readonly authorityBuilder: JournalAuthorityBuilder;
  private readonly now: () => Date;
  private readonly createEventId: () => string;

  constructor(pool: Pool, options: JournalRepositoryOptions) {
    if (options.namespace.length === 0 || options.namespace.length > 512) {
      throw new TypeError("Journal namespace must be a non-empty opaque identifier.");
    }
    this.pool = pool;
    this.namespace = options.namespace;
    this.authorityBuilder = options.authorityBuilder;
    this.now = options.now ?? (() => new Date());
    this.createEventId = options.createEventId ?? createOpaqueEventId;
  }

  async append(input: JournalAppendInput): Promise<JournalAppendResult> {
    return this.appendInternal(input);
  }

  /**
   * Host admission owners may supply per-request authority separately from the
   * producer command. The repository still assigns commit-owned envelope fields.
   * Transport/model input must never call this method directly.
   */
  async appendWithHostAuthority(
    input: JournalHostAppendInput,
    authority: JournalAuthorityDraft
  ): Promise<JournalAppendResult> {
    rejectAppendAuthorityOverrides(input);
    const keys = Object.keys(input as object);
    if (keys.some((key) => key !== "command" && key !== "retainedText")) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Host-authorized Journal append accepts only a command and retained payload content."
      );
    }
    if (Object.hasOwn(authority, "journalNamespace")) {
      throw new JournalStoreError(
        "INVALID_PROPOSAL",
        "Journal namespace is assigned by the repository, not the host authority draft."
      );
    }
    return this.appendInternal(input, authority);
  }

  private async appendInternal(
    input: JournalAppendInput,
    hostAuthorityDraft?: JournalAuthorityDraft
  ): Promise<JournalAppendResult> {
    rejectAppendAuthorityOverrides(input);
    let client: PgClient;
    try {
      client = (await this.pool.connect()) as PgClient;
    } catch (error) {
      throw new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is unavailable.", error);
    }

    let inTransaction = false;
    try {
      await client.query("begin");
      inTransaction = true;
      await client.query(
        `insert into journal_namespaces (journal_namespace, current_seq)
         values ($1, 0)
         on conflict (journal_namespace) do nothing`,
        [this.namespace]
      );
      // This row lock serializes sequence assignment through COMMIT. The next append cannot
      // observe an increment until the transaction holding this lock has committed or rolled back.
      const state = await client.query(
        `select current_seq from journal_namespaces
         where journal_namespace = $1 for update`,
        [this.namespace]
      );
      if (state.rows.length !== 1) throw new Error("Journal namespace state disappeared.");
      const currentSeq = Number(state.rows[0]?.["current_seq"]);
      if (!Number.isSafeInteger(currentSeq) || currentSeq < 0) {
        throw new Error("Journal namespace sequence is outside the supported integer range.");
      }

      const command = parseCommand(input.command);
      const proposedPayloads = input.payloads ?? [];
      const authorityDraft =
        hostAuthorityDraft ?? this.authorityBuilder({ command, payloads: proposedPayloads });
      let authority: JournalAuthoritySnapshot;
      try {
        authority = JournalAuthoritySnapshotSchema.parse({
          ...authorityDraft,
          journalNamespace: this.namespace
        });
      } catch (error) {
        throw new JournalStoreError(
          "INVALID_PROPOSAL",
          "Host authority builder returned an invalid A8.1 authority snapshot.",
          error
        );
      }
      const parentHistory = await this.readParentHistory(client, command.causalParents);
      const validated = validateJournalCommand(input.command, authority, {
        knownEvents: parentHistory,
        latestCommitSeq: currentSeq
      });
      await this.validateRetainedText(
        client,
        validated.authority.payloads,
        input.retainedText ?? []
      );
      await this.validateSelectorPayloadContent(
        client,
        validated.command,
        validated.authority.payloads,
        input.retainedText ?? []
      );

      const dedup = input.sourceDedup;
      let dedupDigest: string | undefined;
      if (dedup) {
        if (validated.command.kind !== "RECEIPT") {
          throw new JournalStoreError(
            "INVALID_PROPOSAL",
            "Scoped source deduplication is supported only for RECEIPT events."
          );
        }
        validateOpaqueDedup(dedup.namespace, "source dedup namespace");
        validateOpaqueDedup(dedup.key, "source dedup key");
        dedupDigest = payloadDigest(dedup.normalizedPayload);
        const existingDedup = await client.query(
          `select payload_sha256, event_id from journal_source_dedup
           where journal_namespace = $1 and source_namespace = $2 and source_key = $3`,
          [this.namespace, dedup.namespace, dedup.key]
        );
        if (existingDedup.rows.length > 0) {
          const row = existingDedup.rows[0]!;
          if (row["payload_sha256"] !== dedupDigest) {
            throw new JournalStoreError(
              "SOURCE_DEDUP_CONFLICT",
              "The source identity was already committed with a different normalized payload."
            );
          }
          const envelope = await this.readEnvelope(client, String(row["event_id"]));
          if (!envelope) throw new Error("Source dedup row referenced a missing journal event.");
          await client.query("commit");
          inTransaction = false;
          return { status: "DEDUPLICATED", envelope };
        }
      }

      const nextSeq = currentSeq + 1;
      if (!Number.isSafeInteger(nextSeq)) throw new Error("Journal commit sequence is exhausted.");
      const eventId = this.createEventId();
      const recordedAt = this.now().toISOString();
      const envelopeInput = {
        version: JOURNAL_ENVELOPE_VERSION,
        eventId,
        journalNamespace: this.namespace,
        commitSeq: nextSeq,
        recordedAt,
        command: validated.command,
        authority: validated.authority
      };
      const envelope = validateJournalEnvelope(envelopeInput, {
        knownEvents: parentHistory,
        latestCommitSeq: currentSeq
      });

      await client.query(
        `insert into journal_events
           (journal_namespace, event_id, commit_seq, recorded_at, envelope)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [this.namespace, eventId, nextSeq, recordedAt, JSON.stringify(envelope)]
      );
      await this.persistPayloads(client, eventId, validated.authority.payloads, input.retainedText ?? []);
      for (const parent of validated.command.causalParents) {
        const known = parentHistory.find(
          (entry) => entry.ref.eventId === parent.eventId && entry.ref.namespace === parent.namespace
        );
        if (!known) {
          throw new JournalStoreError("UNKNOWN_PARENT", `Journal parent ${parent.eventId} is unknown.`);
        }
        if (known.commitSeq === undefined || known.commitSeq >= nextSeq) {
          throw new JournalStoreError(
            "PARENT_ORDER_INVALID",
            "A committed parent must have a lower sequence than its child."
          );
        }
        await client.query(
          `insert into journal_event_parents
             (journal_namespace, event_id, parent_event_id)
           values ($1, $2, $3)`,
          [this.namespace, eventId, parent.eventId]
        );
      }
      if (dedup) {
        await client.query(
          `insert into journal_source_dedup
             (journal_namespace, source_namespace, source_key, payload_sha256, event_id)
           values ($1, $2, $3, $4, $5)`,
          [this.namespace, dedup.namespace, dedup.key, dedupDigest, eventId]
        );
      }
      await client.query(
        `update journal_namespaces set current_seq = $2
         where journal_namespace = $1`,
        [this.namespace, nextSeq]
      );
      await client.query("commit");
      inTransaction = false;
      return { status: "APPENDED", envelope };
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("rollback");
        } catch {
          // Preserve the failure that caused rollback; no result is accepted without COMMIT.
        }
      }
      throw normalizeStoreError(error);
    } finally {
      client.release();
    }
  }

  async get(ref: JournalEventRef): Promise<DeepReadonly<JournalCommittedEnvelope> | null> {
    if (ref.namespace !== this.namespace) return null;
    try {
      return await this.readEnvelope(this.pool, ref.eventId);
    } catch (error) {
      throw normalizeStoreError(error);
    }
  }

  async resolveRetainedText(ref: JournalPayloadDescriptor["ref"]): Promise<{
    descriptor: DeepReadonly<JournalPayloadDescriptor>;
    text: string;
  } | null> {
    try {
      const result = await this.pool.query(
        `select p.descriptor, p.text_content, p.content_sha256, p.event_id, e.envelope
         from journal_payloads p
         join journal_events e
           on e.journal_namespace = p.journal_namespace and e.event_id = p.event_id
         where p.journal_namespace = $1 and p.payload_namespace = $2
           and p.payload_id = $3 and p.payload_version = $4`,
        [this.namespace, ref.namespace, ref.payloadId, ref.version]
      );
      const row = result.rows[0] as PgRow | undefined;
      if (!row || typeof row["text_content"] !== "string") return null;
      const envelope = await this.readEnvelope(this.pool, String(row["event_id"]));
      if (!envelope) return null;
      const descriptor = envelope.authority.payloads.find(
        (candidate) => payloadRefKey(candidate.ref) === payloadRefKey(ref)
      );
      if (!descriptor || descriptor.modality !== "TEXT" || descriptor.retention !== "RETAINED") {
        throw new JournalStoreError(
          "PAYLOAD_PERSISTENCE_FAILED",
          "Stored text payload no longer matches its committed descriptor."
        );
      }
      if (
        canonicalJson(row["descriptor"]) !== canonicalJson(descriptor) ||
        row["content_sha256"] !== sha256(row["text_content"])
      ) {
        throw new JournalStoreError(
          "PAYLOAD_PERSISTENCE_FAILED",
          "Stored text payload failed its immutable descriptor or digest check."
        );
      }
      return { descriptor, text: row["text_content"] };
    } catch (error) {
      throw normalizeStoreError(error);
    }
  }

  private async readParentHistory(client: PgClient | Pool, refs: readonly JournalEventRef[]): Promise<JournalHistoryEntry[]> {
    for (const ref of refs) {
      if (ref.namespace !== this.namespace) {
        throw new JournalContractError(
          "CROSS_NAMESPACE_REFERENCE",
          "Causal parent is outside the configured journal namespace"
        );
      }
    }
    if (refs.length === 0) return [];
    const result = await client.query(
      `select event_id, commit_seq, envelope from journal_events
       where journal_namespace = $1 and event_id = any($2::text[])`,
      [this.namespace, refs.map((ref) => ref.eventId)]
    );
    return result.rows.map((raw) => {
      const row = raw as PgRow;
      const envelope = parseStoredEnvelopeShape(row["envelope"]);
      return {
        ref: { kind: "JOURNAL_EVENT", namespace: this.namespace, eventId: String(row["event_id"]) },
        kind: envelope.command.kind,
        parentRefs: envelope.command.causalParents,
        commitSeq: Number(row["commit_seq"])
      };
    });
  }

  private async readEnvelope(
    client: PgClient | Pool,
    eventId: string
  ): Promise<DeepReadonly<JournalCommittedEnvelope> | null> {
    const result = await client.query(
      `select event_id, commit_seq, recorded_at, envelope
       from journal_events where journal_namespace = $1 and event_id = $2`,
      [this.namespace, eventId]
    );
    const row = result.rows[0] as PgRow | undefined;
    if (!row) return null;
    const raw = row["envelope"];
    const parsed = parseStoredEnvelopeShape(raw);
    const recordedAt = row["recorded_at"] instanceof Date
      ? row["recorded_at"].toISOString()
      : new Date(String(row["recorded_at"])).toISOString();
    if (
      parsed.eventId !== row["event_id"] ||
      parsed.commitSeq !== Number(row["commit_seq"]) ||
      parsed.recordedAt !== recordedAt
    ) {
      throw new JournalStoreError(
        "TRANSACTION_FAILED",
        "Stored Journal envelope disagrees with its relational identity or commit fields."
      );
    }
    const parentHistory = await this.readParentHistory(client, parsed.command.causalParents);
    return validateJournalEnvelope(raw, { knownEvents: parentHistory });
  }

  private async validateRetainedText(
    client: PgClient,
    descriptors: readonly DeepReadonly<JournalPayloadDescriptor>[],
    retainedText: readonly JournalRetainedTextPayload[]
  ): Promise<void> {
    const descriptorByRef = new Map(descriptors.map((descriptor) => [payloadRefKey(descriptor.ref), descriptor]));
    const contentByRef = new Map<string, string>();
    for (const payload of retainedText) {
      const key = payloadRefKey(payload.ref);
      if (contentByRef.has(key)) {
        throw new JournalStoreError("PAYLOAD_PERSISTENCE_FAILED", "Duplicate retained payload input.");
      }
      contentByRef.set(key, payload.text);
      const descriptor = descriptorByRef.get(key);
      if (!descriptor || descriptor.modality !== "TEXT" || descriptor.retention !== "RETAINED") {
        throw new JournalStoreError(
          "PAYLOAD_PERSISTENCE_FAILED",
          "Payload content is allowed only for an authority-approved retained TEXT descriptor."
        );
      }
    }
    for (const descriptor of descriptors) {
      if (descriptor.retention !== "RETAINED") {
        if (contentByRef.has(payloadRefKey(descriptor.ref))) {
          throw new JournalStoreError(
            "PAYLOAD_PERSISTENCE_FAILED",
            "Redacted, not-retained, and unavailable payloads cannot include content."
          );
        }
        continue;
      }
      if (descriptor.modality !== "TEXT") {
        throw new JournalStoreError(
          "PAYLOAD_PERSISTENCE_FAILED",
          "A8.2a retains TEXT only; raw media and structured payload bytes are not archived."
        );
      }
      const text = contentByRef.get(payloadRefKey(descriptor.ref));
      if (text === undefined) {
        const stored = await this.readStoredPayload(client, descriptor.ref);
        if (
          !stored ||
          canonicalJson(stored.descriptor) !== canonicalJson(descriptor) ||
          typeof stored.textContent !== "string"
        ) {
          throw new JournalStoreError(
            "PAYLOAD_PERSISTENCE_FAILED",
            "A retained TEXT descriptor requires new content or an identical committed payload."
          );
        }
        if (
          descriptor.characterCount !== undefined &&
          Array.from(stored.textContent).length !== descriptor.characterCount
        ) {
          throw new JournalStoreError(
            "PAYLOAD_PERSISTENCE_FAILED",
            "Stored text length differs from its authoritative selector bounds."
          );
        }
        continue;
      }
      if (descriptor.characterCount !== undefined && Array.from(text).length !== descriptor.characterCount) {
        throw new JournalStoreError(
          "PAYLOAD_PERSISTENCE_FAILED",
          "Retained text length differs from its authoritative selector bounds."
        );
      }
    }
  }

  private async validateSelectorPayloadContent(
    client: PgClient,
    command: DeepReadonly<JournalEventCommand>,
    descriptors: readonly DeepReadonly<JournalPayloadDescriptor>[],
    retainedText: readonly JournalRetainedTextPayload[]
  ): Promise<void> {
    const selectors = selectorsOf(command);
    const contentByRef = new Map(retainedText.map((payload) => [payloadRefKey(payload.ref), payload.text]));
    for (const selector of selectors) {
      if (selector.modality !== "TEXT") continue;
      const key = payloadRefKey(selector.payload);
      const descriptor = descriptors.find((candidate) => payloadRefKey(candidate.ref) === key);
      if (!descriptor) continue; // A8.1 already emitted the typed unknown-reference failure.
      if (descriptor.retention === "REDACTED") {
        throw new JournalStoreError(
          "PAYLOAD_PERSISTENCE_FAILED",
          "A8.2a cannot ground a selector against a redacted representation that it does not store."
        );
      }
      if (descriptor.modality !== "TEXT" || descriptor.retention !== "RETAINED") continue;
      let text = contentByRef.get(key);
      if (text === undefined) {
        const stored = await this.readStoredPayload(client, descriptor.ref);
        if (typeof stored?.textContent !== "string") {
          throw new JournalStoreError(
            "PAYLOAD_PERSISTENCE_FAILED",
            "Selector text is not available from an immutable committed payload."
          );
        }
        text = stored.textContent;
      }
      if (selector.range.end > Array.from(text).length) {
        throw new JournalStoreError(
          "PAYLOAD_PERSISTENCE_FAILED",
          "Text selector exceeds the retained payload content bounds."
        );
      }
    }
  }

  private async persistPayloads(
    client: PgClient,
    eventId: string,
    descriptors: readonly DeepReadonly<JournalPayloadDescriptor>[],
    retainedText: readonly JournalRetainedTextPayload[]
  ): Promise<void> {
    const contentByRef = new Map(retainedText.map((payload) => [payloadRefKey(payload.ref), payload.text]));
    for (const descriptor of descriptors) {
      const providedText = contentByRef.get(payloadRefKey(descriptor.ref));
      const text = providedText ?? null;
      if (
        providedText === undefined &&
        descriptor.modality === "TEXT" &&
        descriptor.retention === "RETAINED"
      ) {
        const existing = await this.readStoredPayload(client, descriptor.ref);
        if (
          existing &&
          canonicalJson(existing.descriptor) === canonicalJson(descriptor) &&
          typeof existing.textContent === "string"
        ) {
          continue;
        }
      }
      const digest = text === null ? null : sha256(text);
      await client.query(
        `insert into journal_payloads (
           journal_namespace, payload_namespace, payload_id, payload_version, modality, retention,
           descriptor, text_content, content_sha256, event_id
         ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
         on conflict (journal_namespace, payload_namespace, payload_id, payload_version) do nothing`,
        [
          this.namespace,
          descriptor.ref.namespace,
          descriptor.ref.payloadId,
          descriptor.ref.version,
          descriptor.modality,
          descriptor.retention,
          JSON.stringify(descriptor),
          text,
          digest,
          eventId
        ]
      );
      const stored = await client.query(
        `select descriptor, text_content, content_sha256 from journal_payloads
         where journal_namespace = $1 and payload_namespace = $2
           and payload_id = $3 and payload_version = $4`,
        [this.namespace, descriptor.ref.namespace, descriptor.ref.payloadId, descriptor.ref.version]
      );
      const row = stored.rows[0] as PgRow | undefined;
      if (
        !row ||
        canonicalJson(row["descriptor"]) !== canonicalJson(descriptor) ||
        row["text_content"] !== text ||
        row["content_sha256"] !== digest
      ) {
        throw new JournalStoreError(
          "PAYLOAD_PERSISTENCE_FAILED",
          "An immutable payload identity was reused with different descriptor or content."
        );
      }
    }
  }

  private async readStoredPayload(
    client: PgClient,
    ref: JournalPayloadDescriptor["ref"]
  ): Promise<{ descriptor: unknown; textContent: unknown } | null> {
    const result = await client.query(
      `select descriptor, text_content from journal_payloads
       where journal_namespace = $1 and payload_namespace = $2
         and payload_id = $3 and payload_version = $4`,
      [this.namespace, ref.namespace, ref.payloadId, ref.version]
    );
    const row = result.rows[0] as PgRow | undefined;
    return row ? { descriptor: row["descriptor"], textContent: row["text_content"] } : null;
  }
}

function parseCommand(input: unknown): JournalEventCommand {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    (input as Record<string, unknown>)["version"] !== "life-event-command.v1"
  ) {
    throw new JournalStoreError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "Unsupported journal command version."
    );
  }
  const parsed = JournalEventCommandSchema.safeParse(input);
  if (!parsed.success) {
    throw new JournalStoreError("INVALID_PROPOSAL", "Invalid journal event command.", parsed.error);
  }
  return parsed.data;
}

function rejectAppendAuthorityOverrides(input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new JournalStoreError("INVALID_PROPOSAL", "Journal append input must be an object.");
  }
  const allowed = new Set(["command", "payloads", "retainedText", "sourceDedup"]);
  const authorityFields = new Set([
    "eventId",
    "eventIdentity",
    "journalNamespace",
    "namespace",
    "commitSeq",
    "recordedAt",
    "principal",
    "principalRef",
    "binding",
    "bindingVersion",
    "audience",
    "audienceSnapshot",
    "disclosurePolicy",
    "policyVersion",
    "producer",
    "producerVersion",
    "sourceReferences",
    "intentAuthorization"
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      const suffix = authorityFields.has(key) ? " is host-authority controlled" : " is unsupported";
      throw new JournalStoreError("INVALID_PROPOSAL", `Journal append field '${key}'${suffix}.`);
    }
  }
}

function parseStoredEnvelopeShape(input: unknown): JournalCommittedEnvelope {
  const parsed = JournalCommittedEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new JournalStoreError("TRANSACTION_FAILED", "Stored Journal envelope failed schema validation.", parsed.error);
  }
  return parsed.data;
}

function createOpaqueEventId(): string {
  return `jev1_${randomBytes(24).toString("base64url")}`;
}

function payloadRefKey(ref: JournalPayloadDescriptor["ref"]): string {
  return `${ref.namespace}\u0000${ref.payloadId}\u0000${ref.version}`;
}

function payloadDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function selectorsOf(command: DeepReadonly<JournalEventCommand>) {
  switch (command.kind) {
    case "RECEIPT":
    case "OUTCOME":
    case "DECISION":
      return command.data.evidenceSelectors;
    case "DERIVATION":
      return command.data.sourceSelectors;
    default:
      return [];
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateOpaqueDedup(value: string, label: string): void {
  if (value.length === 0 || value.length > 512) {
    throw new JournalStoreError("INVALID_PROPOSAL", `${label} must be a non-empty opaque identifier.`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function normalizeStoreError(error: unknown): JournalStoreError {
  if (error instanceof JournalStoreError) return error;
  if (error instanceof JournalContractError) {
    if (error.code === "UNSUPPORTED_SCHEMA_VERSION") {
      return new JournalStoreError("UNSUPPORTED_SCHEMA_VERSION", error.message, error);
    }
    if (error.code === "UNKNOWN_PARENT") {
      return new JournalStoreError("UNKNOWN_PARENT", error.message, error);
    }
    if (error.code === "CROSS_NAMESPACE_REFERENCE") {
      return new JournalStoreError("CROSS_NAMESPACE_PARENT", error.message, error);
    }
    return new JournalStoreError("INVALID_PROPOSAL", error.message, error);
  }
  if (error instanceof Error && "code" in error) {
    const pgCode = String((error as Error & { code: string }).code);
    if (pgCode.startsWith("08") || pgCode === "57P01" || pgCode === "57P02" || pgCode === "57P03") {
      return new JournalStoreError("DATABASE_UNAVAILABLE", "Journal PostgreSQL is unavailable.", error);
    }
  }
  return new JournalStoreError("TRANSACTION_FAILED", "Journal append transaction failed.", error);
}
