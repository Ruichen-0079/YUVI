import { z } from "zod";
import {
  EpisodeStatementSourceSchema,
  episodeEvidenceDigest,
  EpisodeSourceEvidenceV1Schema
} from "./episode-source-evidence.js";
import type { RecentEpisode } from "./recent-episode.js";
import {
  MemoryLineageV1Schema,
  type DerivedMemoryLineageV1,
  type DerivedSourceSnapshot
} from "./lineage.js";
import { canonicalLineageJson, encodeMemoryLineage, lineageDigest } from "./lineage-encoding.js";
import type { MemoryWriteEventInput } from "./provider.js";

export const DREAM_DERIVATION_POLICY = "a10.1e-deterministic-dream.v1";
export const DreamSourceSnapshotV1Schema = z
  .object({
    version: z.literal("dream-source-snapshot.v1"),
    policyVersion: z.literal(DREAM_DERIVATION_POLICY),
    episodes: z
      .array(
        z
          .object({
            episodeId: z.string().min(1).max(200),
            evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
            evidence: EpisodeSourceEvidenceV1Schema
          })
          .strict()
      )
      .min(1)
      .max(64)
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.episodes.some(
        (episode) => episode.evidenceDigest !== episodeEvidenceDigest(episode.evidence)
      ) ||
      new Set(snapshot.episodes.map((episode) => episode.episodeId)).size !==
        snapshot.episodes.length ||
      Buffer.byteLength(canonicalLineageJson(snapshot), "utf8") > 262144
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid or oversized Dream source snapshot."
      });
    }
  });
export type DreamSourceSnapshotV1 = z.infer<typeof DreamSourceSnapshotV1Schema>;
export function freezeDreamSources(episodes: readonly RecentEpisode[]): DreamSourceSnapshotV1 {
  return DreamSourceSnapshotV1Schema.parse({
    version: "dream-source-snapshot.v1",
    policyVersion: DREAM_DERIVATION_POLICY,
    episodes: episodes
      .filter((episode) => episode.sourceEvidence)
      .map((episode) => ({
        episodeId: episode.id,
        evidenceDigest: episode.sourceEvidenceDigest,
        evidence: episode.sourceEvidence
      }))
      .sort((a, b) => (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0))
  });
}
export function dreamSourceDigest(snapshot: DreamSourceSnapshotV1, scope: string | null): string {
  // Canonical evidence digest binds statement identity and original ancestry, independent of incidental enumeration.
  return lineageDigest(
    canonicalLineageJson({
      policy: DREAM_DERIVATION_POLICY,
      scope,
      episodes: snapshot.episodes
        .map(({ episodeId, evidenceDigest }) => ({ episodeId, evidenceDigest }))
        .sort((a, b) => (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0))
    })
  );
}
export function groundedDreamStatements(snapshot: DreamSourceSnapshotV1) {
  return snapshot.episodes
    .flatMap((episode) => episode.evidence.statements)
    .map((entry) => EpisodeStatementSourceSchema.parse(entry))
    .filter((entry) => entry.source !== null);
}
export function canonicalDreamSources(
  sources: readonly DerivedSourceSnapshot[]
): DerivedSourceSnapshot[] {
  const byParent = new Map<string, DerivedSourceSnapshot>();
  for (const source of sources) {
    const key = canonicalLineageJson({ ref: source.ref, selector: source.selector });
    const existing = byParent.get(key);
    if (existing && canonicalLineageJson(existing) !== canonicalLineageJson(source))
      throw new Error("DREAM_SOURCE_CONFLICT");
    byParent.set(key, source);
  }
  return [...byParent.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, source]) => source);
}
export function freezeDerivedDreamEvent(
  event: MemoryWriteEventInput,
  sources: readonly DerivedSourceSnapshot[]
): MemoryWriteEventInput {
  const canonical = canonicalDreamSources(sources);
  const fingerprint = lineageDigest(
    canonicalLineageJson({
      kind: event.kind,
      content: event.content.normalize("NFC"),
      scope: event.scope
    })
  );
  const consumerKey = `mld1_${lineageDigest(canonicalLineageJson({ sources: canonical, policyVersion: DREAM_DERIVATION_POLICY, fingerprint }))}`;
  const lineage = MemoryLineageV1Schema.parse({
    version: "memory-lineage.v1",
    state: "GROUNDED",
    origin: "DERIVED",
    parents: canonical.map(({ ref, selector }) => ({ ref, selector })),
    sources: canonical,
    sourceAvailability: { state: "RETAINED_SELECTABLE" },
    consumerKey,
    derivation: {
      kind: "DREAM_DERIVATION",
      producer: "@companion/memory",
      producerVersion: "0.1.0",
      policyVersion: DREAM_DERIVATION_POLICY
    }
  }) as DerivedMemoryLineageV1;
  encodeMemoryLineage(lineage); // Bound and validate before durable delivery admission, never truncate.
  // Compatibility identities, extraction clocks and original-user assertion fields are not child authority.
  return {
    kind: event.kind,
    content: event.content,
    scope: event.scope,
    confidence: event.confidence ?? null,
    assertion: { source: "system", verification: "unverified" },
    lineage,
    metadata: {
      source: "yuvi",
      sourceRole: "system",
      ingestionPolicy: DREAM_DERIVATION_POLICY,
      recurrenceDoesNotUpgradeConfidence: true,
      assistantNonAuthoritative: true
    }
  };
}
export function isGroundedDreamEvent(event: MemoryWriteEventInput): boolean {
  const parsed = MemoryLineageV1Schema.safeParse(event.lineage);
  return (
    parsed.success &&
    parsed.data.state === "GROUNDED" &&
    parsed.data.origin === "DERIVED" &&
    parsed.data.derivation.kind === "DREAM_DERIVATION" &&
    event.assertion?.source === "system" &&
    event.assertion.verification === "unverified" &&
    !event.claim &&
    !event.occurredAt &&
    !event.observedAt
  );
}
