/** Explicit committed source snapshots for delivery/trigger unit fixtures.
 * Grounding itself is exercised with the real resolver in grounded-dream.test.ts.
 */
import { receipt } from "./journal-evidence.test-fixture.js";
import { EpisodeStatementSourceSchema } from "./episode-source-evidence.js";
import { lineageDigest } from "./lineage-encoding.js";
import { compactMemoryText } from "./memory-vnext-text.js";
import { DEFAULT_L1_USER_STATEMENT_CHARS } from "./hierarchy.js";
import { assembleRecentEpisodes, type RecentEpisodeAssembleInput } from "./recent-episode.js";
export function assembleDreamFixtureEpisodes(input: RecentEpisodeAssembleInput) {
  const capturedSources = new Map(
    input.messages
      .filter((message) => message.role === "user")
      .map((message) => {
        const envelope = receipt({ text: message.content });
        const source = {
          ref: {
            kind: "JOURNAL_EVENT",
            namespace: envelope.journalNamespace,
            eventId: `jev1_${lineageDigest(message.id).slice(0, 32)}`
          },
          selector: {
            ...(envelope.command.kind === "RECEIPT"
              ? envelope.command.data.evidenceSelectors[0]!
              : {}),
            payload: { ...envelope.authority.payloads[0]!.ref, payloadId: `payload-${message.id}` }
          },
          origin: "USER_ASSERTION",
          authority: {
            principal: envelope.authority.principal,
            binding: envelope.authority.binding,
            audience: envelope.authority.audience
          },
          sourceTime: {
            recordedAt: envelope.recordedAt,
            occurrenceTime: envelope.command.occurrenceTime
          }
        };
        return [
          message.id,
          EpisodeStatementSourceSchema.parse({
            sourceMessageId: message.id,
            statementId: `statement:${message.id}`,
            statement: compactMemoryText(message.content, DEFAULT_L1_USER_STATEMENT_CHARS),
            sourceContentDigest: lineageDigest(message.content),
            source,
            unavailableReason: null
          })
        ] as const;
      })
  );
  return assembleRecentEpisodes({ ...input, capturedSources });
}
