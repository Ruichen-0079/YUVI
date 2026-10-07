import type {
  EpisodeSourceEvidenceV1,
  EpisodeSourceCoverage,
  EpisodeStatementSource
} from "./episode-source-evidence.js";
import { withEpisodeEvidence, EPISODE_SOURCE_EVIDENCE_VERSION } from "./episode-source-evidence.js";
import type { ConversationMessage } from "./conversation-repository.js";
import {
  DEFAULT_L1_EPISODE_CHARS,
  DEFAULT_L1_GAP_MS,
  DEFAULT_L1_RETENTION_MS,
  DEFAULT_L1_USER_STATEMENT_CHARS,
  type MemoryHierarchyBudgets
} from "./hierarchy.js";
import {
  compactMemoryText,
  jaccardSimilarity,
  redactUnsafeMemoryText,
  sha256Hex,
  tokenizeMemoryText
} from "./memory-vnext-text.js";

export const RECENT_EPISODE_SOURCE = "yuvi-recent-episode" as const;

export const RecentEpisodeStatuses = [
  "active",
  "rolled",
  "consolidating",
  "consolidated",
  "expired"
] as const;
export type RecentEpisodeStatus = (typeof RecentEpisodeStatuses)[number];

export const TemporalConfidenceLevels = ["high", "medium", "low", "unknown"] as const;
export type TemporalConfidence = (typeof TemporalConfidenceLevels)[number];

export type RecentEpisode = {
  id: string;
  sessionId: string;
  personaId: string | null;
  subjectUserId: string | null;
  memoryScope: string | null;
  startedAt: string;
  endedAt: string;
  recordedAt: string;
  occurredAt: string | null;
  temporalConfidence: TemporalConfidence;
  status: RecentEpisodeStatus;
  sourceTurnIds: string[];
  sourceDigest: string;
  sourceEvidence?: EpisodeSourceEvidenceV1 | null;
  sourceEvidenceDigest?: string | null;
  sourceCoverage?: EpisodeSourceCoverage;
  whatHappened: string;
  userStatements: string[];
  taskState: string | null;
  unresolved: string | null;
  outcome: string | null;
  assistantContext: string | null;
  metadata: Record<string, unknown>;
  recurrenceCount: number;
  lastAccessedAt: string;
  expiresAt: string;
  consolidatedAt: string | null;
  consolidationJobId: string | null;
};

export type RecentEpisodeAssembleInput = {
  messages: readonly ConversationMessage[];
  capturedSources?: ReadonlyMap<string, EpisodeStatementSource> | undefined;
  now: Date;
  timezone?: string | undefined;
  recordedAt?: Date | string | undefined;
  sessionId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  memoryScope?: string | null | undefined;
  gapMs?: number | undefined;
  retentionMs?: number | undefined;
  episodeChars?: number | undefined;
  budgets?:
    | Pick<MemoryHierarchyBudgets, "l1GapMs" | "l1RetentionMs" | "l1EpisodeChars">
    | undefined;
};

export function assembleRecentEpisodes(input: RecentEpisodeAssembleInput): RecentEpisode[] {
  const completed = input.messages
    .filter((message) => message.status === "completed" && message.content.trim().length > 0)
    .slice()
    .sort(compareConversationMessage);
  if (completed.length === 0) return [];

  const gapMs = input.gapMs ?? input.budgets?.l1GapMs ?? DEFAULT_L1_GAP_MS;
  const retentionMs = input.retentionMs ?? input.budgets?.l1RetentionMs ?? DEFAULT_L1_RETENTION_MS;
  const episodeChars =
    input.episodeChars ?? input.budgets?.l1EpisodeChars ?? DEFAULT_L1_EPISODE_CHARS;
  const recordedAt = toIso(input.recordedAt) ?? input.now.toISOString();
  const groups = groupMessages(completed, gapMs);

  return groups.map((group) =>
    buildEpisode(group, {
      capturedSources: input.capturedSources,
      now: input.now,
      recordedAt,
      retentionMs,
      episodeChars,
      timezone: input.timezone,
      sessionId: input.sessionId,
      personaId: input.personaId,
      subjectUserId: input.subjectUserId,
      memoryScope: input.memoryScope
    })
  );
}

export function rankRecentEpisodesForQuery(
  query: string,
  episodes: readonly RecentEpisode[],
  now: Date,
  timezone?: string
): RecentEpisode[] {
  const queryTokens = tokenizeMemoryText(query);
  return episodes
    .map((episode) => ({
      episode,
      score: scoreEpisodeForQuery(query, queryTokens, episode, now, timezone)
    }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.episode.endedAt.localeCompare(left.episode.endedAt)
    )
    .map((item) => item.episode);
}

export function formatRecentEpisodeForPrompt(
  episode: RecentEpisode,
  timezone?: string,
  options: { includeAssistantContext?: boolean } = {}
): string {
  const age = formatEpisodePosition(episode, timezone);
  const hints = [
    `L1`,
    age,
    episode.temporalConfidence === "unknown" ? "time-unknown" : null
  ].filter(Boolean);
  // These fields are also embedded by the legacy prose builder. Project each
  // semantic state once and keep its historical scope explicit.
  let happened = episode.whatHappened;
  if (episode.unresolved)
    happened = happened.replace(`Still unresolved: ${episode.unresolved}.`, "");
  if (episode.taskState)
    happened = happened.replace(`Current task/context: ${episode.taskState}.`, "");
  happened = happened.trim();
  const details = [
    happened,
    episode.unresolved ? `Unresolved then: ${episode.unresolved}` : null,
    episode.taskState ? `Task state then: ${episode.taskState}` : null,
    options.includeAssistantContext !== false && episode.assistantContext
      ? `${ASSISTANT_CONTEXT_DISCLAIMER}: ${episode.assistantContext}`
      : null
  ].filter(Boolean);
  return `- [${hints.join("][")}] ${details.join(" ")}`;
}

export function formatEpisodePosition(episode: RecentEpisode, timezone?: string): string {
  const occurred = parseDate(episode.occurredAt ?? episode.startedAt);
  if (!occurred) return "time-unknown";
  const zone = timezone ?? "UTC";
  const local = occurred.toLocaleString("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  return local.replace(",", "");
}

function groupMessages(messages: ConversationMessage[], gapMs: number): ConversationMessage[][] {
  const groups: ConversationMessage[][] = [];
  let current: ConversationMessage[] = [];
  let previousTime: number | undefined;

  for (const message of messages) {
    const time = parseDate(message.createdAt)?.getTime();
    const sessionChanged = current.length > 0 && current[0]?.sessionId !== message.sessionId;
    const gap =
      previousTime !== undefined && time !== undefined ? time - previousTime > gapMs : false;
    if (sessionChanged || gap) {
      groups.push(current);
      current = [];
    }
    current.push(message);
    if (time !== undefined) previousTime = time;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildEpisode(
  messages: ConversationMessage[],
  options: {
    capturedSources?: ReadonlyMap<string, EpisodeStatementSource> | undefined;
    now: Date;
    recordedAt: string;
    retentionMs: number;
    episodeChars: number;
    timezone?: string | undefined;
    sessionId?: string | undefined;
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
    memoryScope?: string | null | undefined;
  }
): RecentEpisode {
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const startedAt = toIso(first.createdAt) ?? options.now.toISOString();
  const endedAt = toIso(last.completedAt ?? last.createdAt) ?? startedAt;
  const startedMs = parseDate(startedAt)?.getTime();
  const temporalConfidence: TemporalConfidence =
    startedMs === undefined || Number.isNaN(startedMs) ? "unknown" : "high";
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const userStatements = userMessages
    .map((message) => compactMemoryText(message.content, DEFAULT_L1_USER_STATEMENT_CHARS))
    .filter(Boolean);
  const assistantContext =
    assistantMessages.length === 0
      ? null
      : compactMemoryText(
          assistantMessages.map((message) => `Assistant: ${message.content}`).join(" "),
          Math.floor(options.episodeChars / 3)
        );
  const unresolved = detectUnresolved(userMessages, assistantMessages);
  const taskState = detectTaskState(userStatements);
  const outcome =
    assistantMessages.length === 0
      ? null
      : compactMemoryText(assistantMessages[assistantMessages.length - 1]!.content, 220);
  const whatHappened = compactMemoryText(
    buildWhatHappened(userStatements, taskState, unresolved, outcome, startedAt, endedAt),
    options.episodeChars
  );
  const sourceTurnIds = messages.map((message) => message.id);
  const sourceDigest = sha256Hex(
    sourceTurnIds.map((id, index) => `${id}:${messages[index]?.content ?? ""}`).join("\n")
  );
  const personaId = options.personaId ?? last.personaId ?? first.personaId ?? null;
  const subjectUserId = options.subjectUserId ?? last.subjectUserId ?? first.subjectUserId ?? null;
  const sessionId = options.sessionId ?? first.sessionId;
  const expiresAt = new Date(
    (parseDate(endedAt)?.getTime() ?? options.now.getTime()) + options.retentionMs
  ).toISOString();

  const episode: RecentEpisode = {
    id: `episode:${sessionId}:${first.id}`,
    sessionId,
    personaId,
    subjectUserId,
    memoryScope: options.memoryScope ?? null,
    startedAt,
    endedAt,
    recordedAt: options.recordedAt,
    occurredAt: temporalConfidence === "unknown" ? null : startedAt,
    temporalConfidence,
    status: "active",
    sourceTurnIds,
    sourceDigest,
    whatHappened,
    userStatements,
    taskState,
    unresolved,
    outcome,
    assistantContext,
    metadata: {
      source: RECENT_EPISODE_SOURCE,
      messageCount: messages.length,
      userTurnCount: userMessages.length,
      assistantTurnCount: assistantMessages.length,
      assistantNonAuthoritative: true
    },
    recurrenceCount: 0,
    lastAccessedAt: options.recordedAt,
    expiresAt,
    consolidatedAt: null,
    consolidationJobId: null
  };
  return withEpisodeEvidence(
    episode,
    options.capturedSources
      ? {
          version: EPISODE_SOURCE_EVIDENCE_VERSION,
          statements: userMessages
            .map((message) => options.capturedSources!.get(message.id))
            .filter((entry): entry is EpisodeStatementSource => !!entry),
          historicalMessageIds: userMessages
            .filter((message) => !options.capturedSources!.has(message.id))
            .map((message) => message.id)
        }
      : null
  );
}

export const ASSISTANT_CONTEXT_DISCLAIMER =
  "Assistant previously said (non-authoritative, not evidence)";

function buildWhatHappened(
  userStatements: string[],
  taskState: string | null,
  unresolved: string | null,
  _outcome: string | null,
  startedAt: string,
  endedAt: string
): string {
  const important = userStatements.slice(0, 4).join(" / ");
  const parts = [
    `From ${startedAt} to ${endedAt}.`,
    important ? `User said: ${important}.` : "No user statements were captured.",
    taskState ? `Current task/context: ${taskState}.` : null,
    unresolved ? `Still unresolved: ${unresolved}.` : null
  ];
  return parts.filter(Boolean).join(" ");
}

function detectUnresolved(
  userMessages: ConversationMessage[],
  assistantMessages: ConversationMessage[]
): string | null {
  const lastUser = userMessages[userMessages.length - 1];
  if (!lastUser) return null;
  if (!/[?？]|吗$|呢$|怎么|如何|why|how|what/iu.test(lastUser.content)) return null;
  const lastUserTime = parseDate(lastUser.createdAt)?.getTime() ?? 0;
  const laterAssistant = assistantMessages.some((message) => {
    const time = parseDate(message.createdAt)?.getTime() ?? 0;
    return time > lastUserTime;
  });
  if (laterAssistant) return null;
  return compactMemoryText(lastUser.content, 180);
}

function detectTaskState(userStatements: string[]): string | null {
  const text = userStatements.join(" ");
  const tokens = tokenizeMemoryText(text).filter(
    (token) =>
      /训练|脚本|端口|报错|项目|模型|provider|port|error|path|训练/.test(token) ||
      /[\\/.:]/.test(token) ||
      /^\d{2,5}$/.test(token)
  );
  if (tokens.length === 0) return null;
  return compactMemoryText(Array.from(new Set(tokens)).slice(0, 8).join(" "), 160);
}

function scoreEpisodeForQuery(
  query: string,
  queryTokens: string[],
  episode: RecentEpisode,
  now: Date,
  timezone?: string
): number {
  const corpus = [
    episode.whatHappened,
    ...episode.userStatements,
    episode.taskState ?? "",
    episode.unresolved ?? "",
    episode.outcome ?? ""
  ].join(" ");
  const lexical = jaccardSimilarity(queryTokens, tokenizeMemoryText(corpus));
  const recency = recencyBoost(episode, now);
  const temporal = temporalQueryBoost(query, episode, now, timezone);
  return lexical * 0.62 + recency * 0.18 + temporal * 0.2;
}

function recencyBoost(episode: RecentEpisode, now: Date): number {
  const ended = parseDate(episode.endedAt)?.getTime();
  if (ended === undefined) return 0;
  const ageMs = Math.max(0, now.getTime() - ended);
  const day = 24 * 60 * 60 * 1000;
  if (ageMs < 2 * 60 * 1000) return 1;
  if (ageMs < day) return 0.85;
  if (ageMs < 2 * day) return 0.7;
  if (ageMs < 7 * day) return 0.45;
  return 0.15;
}

function temporalQueryBoost(
  query: string,
  episode: RecentEpisode,
  now: Date,
  timezone?: string
): number {
  const occurred = parseDate(episode.occurredAt ?? episode.startedAt);
  if (!occurred) return 0;
  const zone = timezone ?? "UTC";
  const episodeDate = localDate(occurred, zone);
  const nowDate = localDate(now, zone);
  if (/昨天|yesterday/iu.test(query) && isYesterday(episodeDate, nowDate)) return 1;
  if (
    /刚才|刚刚|just now|a moment ago/iu.test(query) &&
    now.getTime() - occurred.getTime() < 30 * 60 * 1000
  )
    return 1;
  if (/上午|this morning|morning/iu.test(query) && localHour(occurred, zone) < 12) return 0.8;
  if (/下午|afternoon/iu.test(query) && localHour(occurred, zone) >= 12) return 0.8;
  if (/今天|today/iu.test(query) && episodeDate === nowDate) return 0.9;
  return 0;
}

function localDate(value: Date, timezone: string): string {
  return value.toLocaleDateString("en-CA", { timeZone: timezone });
}

function localHour(value: Date, timezone: string): number {
  const formatted = value.toLocaleString("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false
  });
  const hour = Number.parseInt(formatted, 10);
  return Number.isFinite(hour) ? hour : 0;
}

function isYesterday(episodeDate: string, nowDate: string): boolean {
  const episode = Date.parse(`${episodeDate}T00:00:00Z`);
  const current = Date.parse(`${nowDate}T00:00:00Z`);
  if (Number.isNaN(episode) || Number.isNaN(current)) return false;
  return current - episode === 24 * 60 * 60 * 1000;
}

function compareConversationMessage(left: ConversationMessage, right: ConversationMessage): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.createdAt.localeCompare(right.createdAt);
}

function parseDate(value: Date | string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function episodeSearchCorpus(episode: RecentEpisode): string {
  return redactUnsafeMemoryText(
    [
      episode.whatHappened,
      ...episode.userStatements,
      episode.taskState ?? "",
      episode.unresolved ?? ""
    ]
      .filter(Boolean)
      .join(" ")
  );
}

export function sourceTurnIdsOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((id) => rightSet.has(id));
}
