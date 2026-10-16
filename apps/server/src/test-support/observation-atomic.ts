/** SQL commit-contract fixture only. Semantic/authorization coverage uses the
 * real Server entrypoint; this helper never claims to validate model quality. */
import { createHash } from "node:crypto";
import type { EffectResultProjection, EffectEvidence } from "@companion/effects";
export const actualReadEvidence: EffectEvidence = {
  certainty: "APPLIED",
  layer: "LOCAL_READ_RETURNED",
  reason: "RETURNED",
  remoteEffectId: null
};
export function reportProjection(
  attemptId: string,
  source: unknown,
  text: string,
  checkpoint?: () => Promise<void>
): EffectResultProjection {
  const digest = createHash("sha256").update(text).digest("hex");
  const id = "ob1_" + createHash("sha256").update(attemptId).digest("hex");
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  return {
    digest,
    async commit(tx) {
      await tx.query(
        `insert into retained_observations(observation_id,attempt_id,namespace,persona_id,person_id,principal_namespace,actor_id,audience_ref,source_ref,session_id,kind,observed_at,expires_at,evidence,evidence_digest,commit_digest)
      values($1,$2,'atomic-test','synthetic-persona','synthetic-person','test','test','private-test',$3,'synthetic-session','READ_TEXT',now(),$4,$5,$6,$6)`,
        [
          id,
          attemptId,
          source,
          expiresAt,
          { text, sceneSummary: "", objects: [], confidence: null },
          digest
        ]
      );
      await checkpoint?.();
      return {
        version: "observation-retention.v1",
        state: "STORED",
        reportId: id,
        digest,
        expiresAt,
        reason: null
      };
    }
  };
}
