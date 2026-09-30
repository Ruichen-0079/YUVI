import { z } from "zod";
import type { ConversationMessage } from "./conversation-repository.js";
import {
  DerivedSourceSnapshotSchema,
  MemoryGroundingError,
  type MemoryGroundingResolver
} from "./lineage.js";
import { canonicalLineageJson, lineageDigest } from "./lineage-encoding.js";
import { compactMemoryText } from "./memory-vnext-text.js";
import { DEFAULT_L1_USER_STATEMENT_CHARS } from "./hierarchy.js";
import type { RecentEpisode } from "./recent-episode.js";

export const EPISODE_SOURCE_EVIDENCE_VERSION = "episode-source-evidence.v1";
const identity = z.string().min(1).max(512);
export const EpisodeStatementSourceSchema = z
  .object({
    sourceMessageId: identity,
    statementId: identity,
    statement: z.string().min(1).max(DEFAULT_L1_USER_STATEMENT_CHARS),
    sourceContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    source: DerivedSourceSnapshotSchema.nullable(),
    unavailableReason: identity.nullable()
  })
  .strict()
  .refine(
    (entry) =>
      entry.statementId === `statement:${entry.sourceMessageId}` &&
      (entry.source !== null ? entry.unavailableReason === null : entry.unavailableReason !== null)
  );
export const EpisodeSourceEvidenceV1Schema = z
  .object({
    version: z.literal(EPISODE_SOURCE_EVIDENCE_VERSION),
    statements: z.array(EpisodeStatementSourceSchema).max(256),
    historicalMessageIds: z.array(identity).max(512)
  })
  .strict()
  .refine(
    (map) =>
      new Set(map.statements.map((entry) => entry.sourceMessageId)).size === map.statements.length
  );
export type EpisodeStatementSource = z.infer<typeof EpisodeStatementSourceSchema>;
export type EpisodeSourceEvidenceV1 = z.infer<typeof EpisodeSourceEvidenceV1Schema>;
export type EpisodeSourceCoverage = "GROUNDED" | "PARTIAL" | "LEGACY_INCOMPLETE";

/** Runs against the full persisted text, before any episode compaction. */
export async function captureEpisodeSources(
  messages: readonly ConversationMessage[],
  resolver?: MemoryGroundingResolver
): Promise<Map<string, EpisodeStatementSource>> {
  const entries = new Map<string, EpisodeStatementSource>();
  for (const message of messages) {
    if (message.role !== "user" || message.status !== "completed" || !message.content.trim())
      continue;
    let source: EpisodeStatementSource["source"] = null;
    let unavailableReason: string | null = "MEMORY_GROUNDING_MISSING_COMMITTED_SOURCE";
    if (resolver && message.sourceJournalRef) {
      try {
        const grounded = await resolver.resolve({
          sourceJournalRef: message.sourceJournalRef,
          sourceText: message.content
        });
        source = DerivedSourceSnapshotSchema.parse({
          ref: grounded.parent,
          selector: grounded.selector,
          origin: grounded.origin,
          authority: grounded.authority,
          sourceTime: { recordedAt: grounded.recordedAt, occurrenceTime: grounded.occurrenceTime }
        });
        unavailableReason = null;
      } catch (error) {
        unavailableReason =
          error instanceof MemoryGroundingError
            ? `MEMORY_GROUNDING_${error.code.replaceAll("-", "_").toUpperCase()}`
            : "MEMORY_GROUNDING_UNAVAILABLE";
      }
    }
    // Compaction follows resolution. This is display/semantic input, never a new selector.
    entries.set(
      message.id,
      EpisodeStatementSourceSchema.parse({
        sourceMessageId: message.id,
        statementId: `statement:${message.id}`,
        statement: compactMemoryText(message.content, DEFAULT_L1_USER_STATEMENT_CHARS),
        sourceContentDigest: lineageDigest(message.content),
        source,
        unavailableReason
      })
    );
  }
  return entries;
}
export function episodeEvidenceDigest(evidence: EpisodeSourceEvidenceV1): string {
  const parsed = EpisodeSourceEvidenceV1Schema.parse(evidence);
  return lineageDigest(
    canonicalLineageJson({
      ...parsed,
      statements: [...parsed.statements].sort((a, b) =>
        a.statementId < b.statementId ? -1 : a.statementId > b.statementId ? 1 : 0
      ),
      historicalMessageIds: [...parsed.historicalMessageIds].sort()
    })
  );
}
export function episodeSourceCoverage(
  evidence?: EpisodeSourceEvidenceV1 | null
): EpisodeSourceCoverage {
  if (!evidence || !evidence.statements.some((entry) => entry.source)) return "LEGACY_INCOMPLETE";
  return evidence.historicalMessageIds.length || evidence.statements.some((entry) => !entry.source)
    ? "PARTIAL"
    : "GROUNDED";
}
export function withEpisodeEvidence(
  episode: RecentEpisode,
  evidence: EpisodeSourceEvidenceV1 | null
): RecentEpisode {
  return {
    ...episode,
    sourceEvidence: evidence,
    sourceEvidenceDigest: evidence ? episodeEvidenceDigest(evidence) : null,
    sourceCoverage: episodeSourceCoverage(evidence)
  };
}
/** First observation is immutable. Old source IDs are fenced, even when reconstruction later finds ancestry. */
export function preserveEpisodeEvidence(
  incoming: RecentEpisode,
  existing?: RecentEpisode | null
): RecentEpisode {
  const candidate = incoming.sourceEvidence
    ? EpisodeSourceEvidenceV1Schema.parse(incoming.sourceEvidence)
    : null;
  if (!existing) return withEpisodeEvidence(incoming, candidate);
  const prior = existing.sourceEvidence
    ? EpisodeSourceEvidenceV1Schema.parse(existing.sourceEvidence)
    : null;
  const historical = new Set(prior?.historicalMessageIds ?? existing.sourceTurnIds);
  const entries = new Map((prior?.statements ?? []).map((entry) => [entry.sourceMessageId, entry]));
  for (const id of candidate?.historicalMessageIds ?? []) {
    if (!entries.has(id)) historical.add(id);
  }
  for (const entry of candidate?.statements ?? []) {
    const original = entries.get(entry.sourceMessageId);
    if (original && original.sourceContentDigest !== entry.sourceContentDigest)
      throw new Error("EPISODE_SOURCE_CONFLICT");
    if (original?.source && canonicalLineageJson(original) !== canonicalLineageJson(entry))
      throw new Error("EPISODE_SOURCE_CONFLICT");
    if (!original && !historical.has(entry.sourceMessageId))
      entries.set(entry.sourceMessageId, entry);
  }
  const evidence =
    prior || candidate
      ? {
          version: EPISODE_SOURCE_EVIDENCE_VERSION as typeof EPISODE_SOURCE_EVIDENCE_VERSION,
          statements: [...entries.values()],
          historicalMessageIds: [...historical]
        }
      : null;
  return withEpisodeEvidence(
    {
      ...incoming,
      status: existing.status,
      consolidatedAt: existing.consolidatedAt,
      consolidationJobId: existing.consolidationJobId
    },
    evidence
  );
}
