import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
export { ObservationRetentionSchema as EffectReportRetentionSchema } from "@companion/protocol";
import type { ObservationRetention as EffectReportRetention } from "@companion/protocol";
export type { ObservationRetention as EffectReportRetention } from "@companion/protocol";
export type EffectResultTransaction = Pick<PoolClient, "query">;
/** Host-only SQL projection. No dispatch or COMMIT. Its private contents never
 * enter A9 history. Failure rolls back to a savepoint and records FAILED retention. */
export interface EffectResultProjection {
  readonly digest: string;
  commit(transaction: EffectResultTransaction): Promise<EffectReportRetention>;
}
/** Even projection preparation failure must not erase a proven adapter result. */
export function prepareResultProjection(
  factory: () => EffectResultProjection
): EffectResultProjection {
  try {
    return factory();
  } catch {
    return {
      digest: createHash("sha256")
        .update("observation-projection-preparation-failed.v1")
        .digest("hex"),
      async commit() {
        throw Error("REPORT_PROJECTION_PREPARATION_FAILED");
      }
    };
  }
}
