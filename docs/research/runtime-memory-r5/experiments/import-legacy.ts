/** Explicit offline JSONL adapter. Export must be complete, scoped and backed up.
 * Atomic checkpoint per 100 records; restart replays the input safely.
 * Unknown timestamps stop the batch instead of fabricating a source clock.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  PostgresMemoryAuthority,
  importLegacyMemoryBatch,
  type MemoryEvent
} from "../../../../packages/memory/src/index.js";
const [scope, file] = process.argv.slice(2);
if (
  !scope ||
  !file ||
  !process.env["DATABASE_URL"] ||
  process.env["YUVI_R5_MIGRATION_ACK"] !== "BACKUP_VERIFIED"
)
  throw new Error("Explicit scope, JSONL export, DATABASE_URL and backup acknowledgment required");
const hash = createHash("sha256");
for await (const chunk of createReadStream(file)) hash.update(chunk);
const source = "jsonl-export:" + hash.digest("hex");
const migrationId = "legacy:" + scope + ":" + source;
const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"], max: 2 });
try {
  const authority = new PostgresMemoryAuthority(pool);
  const old = (
    await pool.query(
      "select checkpoint,state from memory_authority_migrations where migration_id=$1",
      [migrationId]
    )
  ).rows[0];
  if (old?.["state"] === "complete") {
    console.log(JSON.stringify({ status: "ALREADY_COMPLETE", migrationId }));
    process.exitCode = 0;
  } else {
    let checkpoint: string | null = old?.["checkpoint"] ?? null;
    const batchLimit = process.env["YUVI_R5_MIGRATION_BATCH_LIMIT"]
      ? Number(process.env["YUVI_R5_MIGRATION_BATCH_LIMIT"])
      : Infinity;
    if (!(batchLimit === Infinity || (Number.isInteger(batchLimit) && batchLimit > 0)))
      throw new Error("Invalid migration batch limit");
    let committedBatches = 0;
    let stopped = false;
    let line = 0;
    let batch: MemoryEvent[] = [];
    for await (const text of createInterface({
      input: createReadStream(file),
      crlfDelay: Infinity
    })) {
      line++;
      if (line <= Number(checkpoint ?? 0)) continue;
      if (!text.trim()) throw new Error("Empty JSONL record at line " + line);
      const record = JSON.parse(text) as MemoryEvent;
      if (record.scope !== scope) throw new Error("Export scope mismatch at line " + line);
      batch.push(record);
      if (batch.length === 100) {
        await importLegacyMemoryBatch(authority, {
          migrationId,
          scope,
          source,
          expectedCheckpoint: checkpoint,
          nextCheckpoint: String(line),
          complete: false,
          records: batch
        });
        checkpoint = String(line);
        batch = [];
        if (++committedBatches >= batchLimit) {
          stopped = true;
          break;
        }
      }
    }
    if (!stopped)
      await importLegacyMemoryBatch(authority, {
        migrationId,
        scope,
        source,
        expectedCheckpoint: checkpoint,
        nextCheckpoint: String(line),
        complete: true,
        records: batch
      });
    console.log(
      JSON.stringify({
        status: stopped ? "STOPPED_AT_CHECKPOINT" : "COMMITTED",
        migrationId,
        checkpoint: String(line)
      })
    );
  }
} finally {
  await pool.end();
}
