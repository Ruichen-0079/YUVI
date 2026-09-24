import type { Pool, QueryResultRow } from "pg";
import { createPostgresPool } from "@companion/database";
import { parseMemoryRepositoryEnv, type MemoryRepositoryKind } from "./env.js";

export type ConversationRepositoryKind = MemoryRepositoryKind;
export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessageStatus = "streaming" | "completed" | "failed" | "cancelled";

export const DEFAULT_STALE_STREAMING_MESSAGE_AGE_MS = 30 * 60 * 1000;
export const DEFAULT_STALE_STREAMING_MESSAGE_LIMIT = 100;

export type ConversationRecoveryOptions = {
  olderThan?: Date | string | undefined;
  limit?: number | undefined;
  recoveredAt?: Date | string | undefined;
};

export type ConversationMessage = {
  id: string;
  sessionId: string;
  traceId: string;
  parentMessageId: string | null;
  sourceUserEventId?: string | null;
  role: ConversationMessageRole;
  content: string;
  status: ConversationMessageStatus;
  createdAt: string;
  completedAt: string | null;
  finalizedTurnId?: string | null;
  personaId?: string | null;
  subjectUserId?: string | null;
  ingestionRequested?: boolean | null;
  ingestionSkipReason?: string | null;
  metadata: Record<string, unknown>;
  sequence: number;
};

export type ConversationMessageInput = Omit<
  ConversationMessage,
  | "sequence"
  | "sourceUserEventId"
  | "finalizedTurnId"
  | "personaId"
  | "subjectUserId"
  | "ingestionRequested"
  | "ingestionSkipReason"
> &
  Partial<
    Pick<
      ConversationMessage,
      | "sourceUserEventId"
      | "finalizedTurnId"
      | "personaId"
      | "subjectUserId"
      | "ingestionRequested"
      | "ingestionSkipReason"
    >
  >;

export type ConversationFinalizationFields = {
  finalizedTurnId?: string | null | undefined;
  sourceUserEventId?: string | null | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  ingestionRequested?: boolean | null | undefined;
  ingestionSkipReason?: string | null | undefined;
};

export type ConversationListOptions = {
  limit?: number | undefined;
  maxCharacters?: number | undefined;
};

export interface ConversationRepository {
  readonly kind: ConversationRepositoryKind;
  getDatabaseClient?(): ConversationDatabaseClient;
  getMessageById?(messageId: string): Promise<ConversationMessage | null>;
  healthCheck(): Promise<{ status: "healthy" | "unavailable"; message?: string }>;
  ensureSession(sessionId: string): Promise<void>;
  appendMessage(message: ConversationMessageInput): Promise<ConversationMessage>;
  appendMessageContent(messageId: string, delta: string): Promise<ConversationMessage>;
  completeMessage(
    messageId: string,
    metadata?: Record<string, unknown>,
    fields?: ConversationFinalizationFields
  ): Promise<ConversationMessage>;
  failMessage(
    messageId: string,
    status: "failed" | "cancelled",
    metadata?: Record<string, unknown>
  ): Promise<ConversationMessage>;
  listRecentMessages(
    sessionId: string,
    options?: ConversationListOptions
  ): Promise<ConversationMessage[]>;
  recoverStaleStreamingMessages?(
    options?: ConversationRecoveryOptions
  ): Promise<ConversationMessage[]>;
  close?(): Promise<void>;
}

export type ConversationDatabaseClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
  end(): Promise<void>;
};

export class PostgresConversationRepository implements ConversationRepository {
  readonly kind = "postgres";
  private readonly pool: ConversationDatabaseClient;
  private readonly ownsPool: boolean;

  constructor(connectionString: string | ConversationDatabaseClient) {
    this.ownsPool = typeof connectionString === "string";
    this.pool =
      typeof connectionString === "string"
        ? createPostgresPool(connectionString)
        : connectionString;
  }

  async healthCheck(): Promise<{ status: "healthy" | "unavailable"; message?: string }> {
    try {
      await this.pool.query("select 1");
      return { status: "healthy" };
    } catch (error) {
      return {
        status: "unavailable",
        message: error instanceof Error ? error.message : "PostgreSQL health check failed."
      };
    }
  }

  async ensureSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `insert into conversation_sessions (id)
       values ($1)
       on conflict (id) do update set updated_at = now()`,
      [sessionId]
    );
  }

  async appendMessage(message: ConversationMessageInput): Promise<ConversationMessage> {
    await this.ensureSession(message.sessionId);
    const result = await this.pool.query(
      `insert into conversation_messages (
        id, session_id, trace_id, parent_message_id, role, content, status,
        created_at, completed_at, metadata, source_user_event_id, finalized_turn_id,
        persona_id, subject_user_id, ingestion_requested, ingestion_skip_reason
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      on conflict (id) do nothing
      returning *`,
      [
        message.id,
        message.sessionId,
        message.traceId,
        message.parentMessageId,
        message.role,
        message.content,
        message.status,
        message.createdAt,
        message.completedAt,
        message.metadata,
        message.sourceUserEventId ?? null,
        message.finalizedTurnId ?? null,
        message.personaId ?? null,
        message.subjectUserId ?? null,
        message.ingestionRequested ?? null,
        message.ingestionSkipReason ?? null
      ]
    );

    if (result.rows.length > 0) {
      return mapConversationMessageRow(result.rows[0]);
    }

    const existing = await this.pool.query("select * from conversation_messages where id = $1", [
      message.id
    ]);
    return mapConversationMessageRow(requireConversationRow(existing.rows));
  }

  async appendMessageContent(messageId: string, delta: string): Promise<ConversationMessage> {
    if (!delta) {
      throw new Error("Conversation message delta must not be empty.");
    }

    const result = await this.pool.query(
      `update conversation_messages
       set content = content || $2
       where id = $1 and status = 'streaming'
       returning *`,
      [messageId, delta]
    );
    if (result.rows.length > 0) {
      return mapConversationMessageRow(result.rows[0]);
    }

    const existing = await this.requireMessageForTransition(messageId, "append content");
    if (existing.status === "streaming") {
      throw new Error(
        `Conversation message '${messageId}' append content update affected no rows while status is 'streaming'.`
      );
    }
    throw new Error(
      `Conversation message '${messageId}' cannot append content in status '${existing.status}'.`
    );
  }

  async completeMessage(
    messageId: string,
    metadata: Record<string, unknown> = {},
    fields: ConversationFinalizationFields = {}
  ): Promise<ConversationMessage> {
    const result =
      Object.keys(fields).length === 0
        ? await this.pool.query(
            `update conversation_messages
             set status = 'completed', completed_at = coalesce(completed_at, now()),
                 metadata = metadata || $2::jsonb
             where id = $1 and status = 'streaming'
             returning *`,
            [messageId, JSON.stringify(metadata)]
          )
        : await this.pool.query(
            `update conversation_messages
             set status = 'completed', completed_at = coalesce(completed_at, now()),
                 metadata = metadata || $2::jsonb,
                 finalized_turn_id = coalesce(finalized_turn_id, $3),
                 source_user_event_id = coalesce(source_user_event_id, $4),
                 persona_id = coalesce(persona_id, $5),
                 subject_user_id = coalesce(subject_user_id, $6),
                 ingestion_requested = coalesce(ingestion_requested, $7),
                 ingestion_skip_reason = coalesce(ingestion_skip_reason, $8)
             where id = $1 and status = 'streaming'
             returning *`,
            [
              messageId,
              JSON.stringify(metadata),
              fields.finalizedTurnId ?? null,
              fields.sourceUserEventId ?? null,
              fields.personaId ?? null,
              fields.subjectUserId ?? null,
              fields.ingestionRequested ?? null,
              fields.ingestionSkipReason ?? null
            ]
          );
    if (result.rows.length > 0) {
      return mapConversationMessageRow(result.rows[0]);
    }

    const existing = await this.requireMessageForTransition(messageId, "complete");
    if (existing.status === "completed") {
      return existing;
    }
    if (existing.status === "streaming") {
      throw new Error(
        `Conversation message '${messageId}' complete update affected no rows while status is 'streaming'.`
      );
    }
    throw new Error(
      `Conversation message '${messageId}' cannot transition from '${existing.status}' to 'completed'.`
    );
  }

  async failMessage(
    messageId: string,
    status: "failed" | "cancelled",
    metadata: Record<string, unknown> = {}
  ): Promise<ConversationMessage> {
    const result = await this.pool.query(
      `update conversation_messages
       set status = $2, completed_at = coalesce(completed_at, now()),
           metadata = metadata || $3::jsonb
       where id = $1 and status = 'streaming'
       returning *`,
      [messageId, status, JSON.stringify(metadata)]
    );
    if (result.rows.length > 0) {
      return mapConversationMessageRow(result.rows[0]);
    }

    const existing = await this.requireMessageForTransition(messageId, "finalize");
    if (existing.status === status) {
      return existing;
    }
    if (existing.status === "streaming") {
      throw new Error(
        `Conversation message '${messageId}' finalize update affected no rows while status is 'streaming'.`
      );
    }
    throw new Error(
      `Conversation message '${messageId}' cannot transition from '${existing.status}' to '${status}'.`
    );
  }

  private async requireMessageForTransition(
    messageId: string,
    operation: string
  ): Promise<ConversationMessage> {
    const result = await this.pool.query("select * from conversation_messages where id = $1", [
      messageId
    ]);
    if (result.rows.length === 0) {
      throw new Error(
        `Conversation message '${messageId}' was not found while attempting to ${operation}.`
      );
    }
    return mapConversationMessageRow(result.rows[0]);
  }

  async listRecentMessages(
    sessionId: string,
    options: ConversationListOptions = {}
  ): Promise<ConversationMessage[]> {
    const limit = clampLimit(options.limit ?? 24);
    const result = await this.pool.query(
      `select * from conversation_messages
       where session_id = $1
       order by sequence desc
       limit $2`,
      [sessionId, limit]
    );
    return applyConversationBounds(result.rows.map(mapConversationMessageRow).reverse(), options);
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async getMessageById(messageId: string): Promise<ConversationMessage | null> {
    const result = await this.pool.query("select * from conversation_messages where id = $1", [
      messageId
    ]);
    return result.rows[0] ? mapConversationMessageRow(result.rows[0]) : null;
  }

  getDatabaseClient(): ConversationDatabaseClient {
    return this.pool;
  }

  async recoverStaleStreamingMessages(
    options: ConversationRecoveryOptions = {}
  ): Promise<ConversationMessage[]> {
    const recoveredAt = toDate(options.recoveredAt) ?? new Date();
    const olderThan =
      toDate(options.olderThan) ??
      new Date(recoveredAt.getTime() - DEFAULT_STALE_STREAMING_MESSAGE_AGE_MS);
    const limit = clampLimit(options.limit ?? DEFAULT_STALE_STREAMING_MESSAGE_LIMIT);
    const recoveryMetadata = JSON.stringify({
      recoveryReason: "stale-streaming-message",
      recoveredAt: recoveredAt.toISOString()
    });
    const result = await this.pool.query(
      `with stale as (
         select id
         from conversation_messages
         where status = 'streaming' and created_at < $1
         order by created_at asc
         limit $2
         for update skip locked
       )
       update conversation_messages as message
       set status = 'failed',
           completed_at = coalesce(message.completed_at, $3),
           metadata = message.metadata || $4::jsonb
       from stale
       where message.id = stale.id
       returning message.*`,
      [olderThan.toISOString(), limit, recoveredAt.toISOString(), recoveryMetadata]
    );
    return result.rows.map(mapConversationMessageRow);
  }
}

export class InMemoryConversationRepository implements ConversationRepository {
  readonly kind = "in-memory";
  private readonly sessions = new Map<string, { createdAt: string; updatedAt: string }>();
  private readonly messages = new Map<string, ConversationMessage[]>();

  async healthCheck(): Promise<{ status: "healthy"; message: string }> {
    return { status: "healthy", message: "Using in-memory conversation repository." };
  }

  async ensureSession(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }

  async appendMessage(message: ConversationMessageInput): Promise<ConversationMessage> {
    await this.ensureSession(message.sessionId);
    const messages = this.messages.get(message.sessionId) ?? [];
    const existing = messages.find((candidate) => candidate.id === message.id);
    if (existing) {
      return cloneConversationMessage(existing);
    }

    const stored: ConversationMessage = {
      ...message,
      sourceUserEventId: message.sourceUserEventId ?? null,
      finalizedTurnId: message.finalizedTurnId ?? null,
      personaId: message.personaId ?? null,
      subjectUserId: message.subjectUserId ?? null,
      ingestionRequested: message.ingestionRequested ?? null,
      ingestionSkipReason: message.ingestionSkipReason ?? null,
      metadata: { ...message.metadata },
      sequence: messages.length + 1
    };
    messages.push(stored);
    this.messages.set(message.sessionId, messages);
    return cloneConversationMessage(stored);
  }

  async appendMessageContent(messageId: string, delta: string): Promise<ConversationMessage> {
    if (!delta) {
      throw new Error("Conversation message delta must not be empty.");
    }

    const message = this.findMessage(messageId);
    if (!message) {
      throw new Error(`Conversation message '${messageId}' was not found while appending content.`);
    }
    if (message.status !== "streaming") {
      throw new Error(
        `Conversation message '${messageId}' cannot append content in status '${message.status}'.`
      );
    }
    message.content += delta;
    return cloneConversationMessage(message);
  }

  async completeMessage(
    messageId: string,
    metadata: Record<string, unknown> = {},
    fields: ConversationFinalizationFields = {}
  ): Promise<ConversationMessage> {
    const message = this.requireMessage(messageId, "complete");
    if (message.status === "completed") {
      return cloneConversationMessage(message);
    }
    if (message.status !== "streaming") {
      throw new Error(
        `Conversation message '${messageId}' cannot transition from '${message.status}' to 'completed'.`
      );
    }
    message.status = "completed";
    message.completedAt = new Date().toISOString();
    message.metadata = { ...message.metadata, ...metadata };
    message.finalizedTurnId ??= fields.finalizedTurnId ?? null;
    message.sourceUserEventId ??= fields.sourceUserEventId ?? null;
    message.personaId ??= fields.personaId ?? null;
    message.subjectUserId ??= fields.subjectUserId ?? null;
    message.ingestionRequested ??= fields.ingestionRequested ?? null;
    message.ingestionSkipReason ??= fields.ingestionSkipReason ?? null;
    return cloneConversationMessage(message);
  }

  async failMessage(
    messageId: string,
    status: "failed" | "cancelled",
    metadata: Record<string, unknown> = {}
  ): Promise<ConversationMessage> {
    const message = this.requireMessage(messageId, "finalize");
    if (message.status === status) {
      return cloneConversationMessage(message);
    }
    if (message.status !== "streaming") {
      throw new Error(
        `Conversation message '${messageId}' cannot transition from '${message.status}' to '${status}'.`
      );
    }
    message.status = status;
    message.completedAt = message.completedAt ?? new Date().toISOString();
    message.metadata = { ...message.metadata, ...metadata };
    return cloneConversationMessage(message);
  }

  async listRecentMessages(
    sessionId: string,
    options: ConversationListOptions = {}
  ): Promise<ConversationMessage[]> {
    const messages = this.messages.get(sessionId) ?? [];
    return applyConversationBounds(
      messages.slice(-(options.limit ?? 24)).map(cloneConversationMessage),
      options
    );
  }

  private findMessage(messageId: string): ConversationMessage | undefined {
    for (const messages of this.messages.values()) {
      const message = messages.find((candidate) => candidate.id === messageId);
      if (message) {
        return message;
      }
    }
    return undefined;
  }

  private requireMessage(messageId: string, operation: string): ConversationMessage {
    const message = this.findMessage(messageId);
    if (!message) {
      throw new Error(
        `Conversation message '${messageId}' was not found while attempting to ${operation}.`
      );
    }
    return message;
  }

  async getMessageById(messageId: string): Promise<ConversationMessage | null> {
    const message = this.findMessage(messageId);
    return message ? cloneConversationMessage(message) : null;
  }

  async recoverStaleStreamingMessages(
    options: ConversationRecoveryOptions = {}
  ): Promise<ConversationMessage[]> {
    const recoveredAt = toDate(options.recoveredAt) ?? new Date();
    const olderThan =
      toDate(options.olderThan) ??
      new Date(recoveredAt.getTime() - DEFAULT_STALE_STREAMING_MESSAGE_AGE_MS);
    const limit = clampLimit(options.limit ?? DEFAULT_STALE_STREAMING_MESSAGE_LIMIT);
    const recovered: ConversationMessage[] = [];

    for (const messages of this.messages.values()) {
      for (const message of messages) {
        if (
          recovered.length >= limit ||
          message.status !== "streaming" ||
          !isBefore(message.createdAt, olderThan)
        ) {
          continue;
        }
        message.status = "failed";
        message.completedAt = message.completedAt ?? recoveredAt.toISOString();
        message.metadata = {
          ...message.metadata,
          recoveryReason: "stale-streaming-message",
          recoveredAt: recoveredAt.toISOString()
        };
        recovered.push(cloneConversationMessage(message));
      }
    }

    return recovered;
  }
}

export function createConversationRepositoryFromEnv(
  env: Record<string, string | undefined> = process.env,
  sharedClient?: ConversationDatabaseClient
): ConversationRepository {
  const repositoryMode = parseConversationRepositoryEnv(env);
  const databaseUrl = env["DATABASE_URL"];

  if (repositoryMode.kind === "postgres") {
    if (sharedClient) {
      return new PostgresConversationRepository(sharedClient);
    }
    if (!databaseUrl) {
      throw new Error("CONVERSATION_REPOSITORY=postgres requires DATABASE_URL.");
    }
    return new PostgresConversationRepository(databaseUrl);
  }

  return new InMemoryConversationRepository();
}

export function parseConversationRepositoryEnv(
  env: Record<string, string | undefined> = process.env
): { kind: ConversationRepositoryKind } {
  const explicitValue = env["CONVERSATION_REPOSITORY"]?.trim().toLowerCase();
  if (!explicitValue) {
    return { kind: parseMemoryRepositoryEnv(env).kind };
  }
  if (explicitValue === "memory" || explicitValue === "in-memory") {
    return { kind: "in-memory" };
  }
  if (explicitValue === "postgres") {
    return { kind: "postgres" };
  }
  throw new Error(
    `Invalid CONVERSATION_REPOSITORY value '${env["CONVERSATION_REPOSITORY"]?.trim()}'. Valid values are: in-memory, memory, postgres.`
  );
}

function mapConversationMessageRow(row: QueryResultRow | undefined): ConversationMessage {
  if (!row) {
    throw new Error("Conversation message row was empty.");
  }
  return {
    id: String(row["id"]),
    sessionId: String(row["session_id"]),
    traceId: String(row["trace_id"]),
    parentMessageId: row["parent_message_id"] ?? null,
    sourceUserEventId: row["source_user_event_id"] ?? null,
    role: row["role"] as ConversationMessageRole,
    content: String(row["content"]),
    status: row["status"] as ConversationMessageStatus,
    createdAt: toIsoString(row["created_at"]),
    completedAt: row["completed_at"] ? toIsoString(row["completed_at"]) : null,
    finalizedTurnId: row["finalized_turn_id"] ?? null,
    personaId: row["persona_id"] ?? null,
    subjectUserId: row["subject_user_id"] ?? null,
    ingestionRequested:
      row["ingestion_requested"] === null || row["ingestion_requested"] === undefined
        ? null
        : Boolean(row["ingestion_requested"]),
    ingestionSkipReason: row["ingestion_skip_reason"] ?? null,
    metadata: parseMetadata(row["metadata"]),
    sequence: Number(row["sequence"])
  };
}

function applyConversationBounds(
  messages: ConversationMessage[],
  options: ConversationListOptions
): ConversationMessage[] {
  const limit = clampLimit(options.limit ?? messages.length);
  const selected = messages.slice(-limit);
  if (options.maxCharacters === undefined || options.maxCharacters <= 0) {
    return selected.map(cloneConversationMessage);
  }

  const bounded: ConversationMessage[] = [];
  let characters = 0;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const message = selected[index]!;
    if (characters + message.content.length > options.maxCharacters && bounded.length > 0) {
      break;
    }
    bounded.unshift(message);
    characters += message.content.length;
  }
  return bounded.map(cloneConversationMessage);
}

function cloneConversationMessage(message: ConversationMessage): ConversationMessage {
  return { ...message, metadata: { ...message.metadata } };
}

function requireConversationRow(rows: QueryResultRow[]): QueryResultRow {
  const row = rows[0];
  if (!row) {
    throw new Error("Conversation message was not returned after insert.");
  }
  return row;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isBefore(value: Date | string, boundary: Date): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() < boundary.getTime();
}

function clampLimit(value: number): number {
  return Math.max(1, Math.min(Math.floor(value), 200));
}
