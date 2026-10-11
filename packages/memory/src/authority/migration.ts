import type { MemoryEvent } from "../provider.js";
import { canonicalLineageJson, lineageDigest } from "../lineage-encoding.js";
import { PostgresMemoryAuthority } from "./store.js";
import { MemoryAuthorityError, canonicalScope } from "./types.js";

/** Bounded batch and durable receipt. Checkpoint, records and receipt commit together. */
export async function importLegacyMemoryBatch(
  authority: PostgresMemoryAuthority,
  input: {
    migrationId: string;
    scope: string;
    source: string;
    expectedCheckpoint: string | null;
    nextCheckpoint: string | null;
    complete: boolean;
    records: MemoryEvent[];
  }
) {
  canonicalScope(input.scope);
  if (input.records.length > 100) throw new MemoryAuthorityError("MEMORY_MIGRATION_BATCH_BOUND");
  const digest = lineageDigest(canonicalLineageJson(input));
  const batchKey = lineageDigest(
    canonicalLineageJson([input.expectedCheckpoint, input.nextCheckpoint])
  );
  // The operation identity exists before work, including a failed first batch.
  await authority.pool.query(
    `insert into memory_authority_migrations(migration_id,scope,source,state) values($1,$2,$3,'running') on conflict do nothing`,
    [input.migrationId, input.scope, input.source]
  );
  try {
    return await authority.transaction(async (tx) => {
      const old = (
        await tx.query(
          "select * from memory_authority_migrations where migration_id=$1 for update",
          [input.migrationId]
        )
      ).rows[0]!;
      if (old["scope"] !== input.scope || old["source"] !== input.source)
        throw new MemoryAuthorityError("MEMORY_MIGRATION_IDENTITY_CONFLICT");
      const receipt = (
        await tx.query(
          "select input_digest from memory_authority_migration_batches where migration_id=$1 and batch_key=$2",
          [input.migrationId, batchKey]
        )
      ).rows[0];
      if (receipt) {
        if (receipt["input_digest"] !== digest)
          throw new MemoryAuthorityError("MEMORY_MIGRATION_BATCH_PAYLOAD_CONFLICT");
        return { status: "REPLAYED" as const, imported: 0 };
      }
      if (old["checkpoint"] !== input.expectedCheckpoint)
        throw new MemoryAuthorityError("MEMORY_MIGRATION_CHECKPOINT_CONFLICT");
      if (old["state"] === "complete")
        throw new MemoryAuthorityError("MEMORY_MIGRATION_ALREADY_COMPLETE");
      let imported = 0;
      for (const event of input.records) {
        if (event.scope !== input.scope || !event.sourceRecordId)
          throw new MemoryAuthorityError("MEMORY_MIGRATION_SCOPE_MISMATCH");
        if (
          await authority.importLegacy(
            { scope: input.scope, source: input.source, sourceId: event.sourceRecordId, event },
            tx
          )
        )
          imported++;
      }
      await tx.query(
        `insert into memory_authority_migration_batches(migration_id,batch_key,input_digest,imported_count) values($1,$2,$3,$4)`,
        [input.migrationId, batchKey, digest, imported]
      );
      await tx.query(
        `update memory_authority_migrations set checkpoint=$2,state=$3,imported_count=imported_count+$4,error_code=null,updated_at=now() where migration_id=$1`,
        [input.migrationId, input.nextCheckpoint, input.complete ? "complete" : "running", imported]
      );
      return { status: "COMMITTED" as const, imported };
    });
  } catch (error) {
    // An unknown DB outcome is reconciled by replaying the same batch receipt.
    // Do not overwrite a successfully committed final manifest after response loss.
    await authority.pool
      .query(
        `update memory_authority_migrations set state=$6,error_code=$4,updated_at=now()
      where migration_id=$1 and scope=$2 and source=$3 and state!='complete' and not exists(select 1 from memory_authority_migration_batches where migration_id=$1 and batch_key=$5)`,
        [
          input.migrationId,
          input.scope,
          input.source,
          error instanceof MemoryAuthorityError ? error.code : "MEMORY_MIGRATION_OUTCOME_UNKNOWN",
          batchKey,
          error instanceof MemoryAuthorityError ? "failed" : "reconcile_required"
        ]
      )
      .catch(() => undefined);
    throw error;
  }
}
