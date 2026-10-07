import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  readdirSync
} from "node:fs";
import { join } from "node:path";
import { getRuntimeEnvDir } from "@companion/config";
import { characterPersonaId, type CharacterBinding } from "@companion/core";
import type { PostgresPool } from "@companion/database";

type StorageOwner = Readonly<{
  version: 1;
  instanceId: string;
  definitionId: string;
  memoryPersonaId: string | null;
}>;

function ownerFor(binding: CharacterBinding, legacy: boolean): StorageOwner {
  return {
    version: 1,
    instanceId: binding.instanceId,
    definitionId: binding.definition.id,
    memoryPersonaId: legacy ? null : characterPersonaId(binding)
  };
}

/** Ownership metadata is not persona truth, Memory evidence or a second Journal. */
export function claimCharacterFiles(
  binding: CharacterBinding,
  env: Record<string, string | undefined>,
  legacy: boolean
): void {
  const config = getRuntimeEnvDir(env);
  const roots = new Set([config, env["YUVI_RUNTIME_DATA_DIR"] || join(config, "data")]);
  const expected = ownerFor(binding, legacy);
  for (const root of roots) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, "character-owner.json");
    let existing: StorageOwner | undefined;
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as StorageOwner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (
        existing.version !== expected.version ||
        existing.instanceId !== expected.instanceId ||
        existing.definitionId !== expected.definitionId ||
        existing.memoryPersonaId !== expected.memoryPersonaId
      )
        throw new Error("Character storage directory belongs to another instance or definition.");
      continue;
    }
    if (!legacy && readdirSync(root).some((file) => file !== ".env" && file !== ".env.local"))
      throw new Error("A new Character cannot adopt unowned historical state.");
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(expected));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * Existing algorithms use unqualified tables. A logical database/schema view
 * must have one Character owner; changing only Journal namespace is insufficient.
 */
export async function claimCharacterDatabase(
  pool: PostgresPool | undefined,
  binding: CharacterBinding,
  legacy: boolean
): Promise<() => Promise<void>> {
  if (!pool) return async () => {};
  const client = await pool.connect();
  let locked = false;
  try {
    const availability = await client.query(
      "select to_regclass('character_runtime_owner') as owner_table, current_schema() as schema, (select n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=to_regclass('character_runtime_owner')) as owner_schema"
    );
    if (!availability.rows[0]?.owner_table) {
      if (legacy) {
        client.release();
        return async () => {};
      }
      throw new Error("Character storage requires the current Memory migrations.");
    }
    const schema = availability.rows[0].schema as string;
    if (availability.rows[0].owner_schema !== schema)
      throw new Error("Character ownership table must belong to the selected private schema.");
    const lock = "yuvi-character-writer:" + schema;
    const result = await client.query(
      "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
      [lock]
    );
    if (!result.rows[0]?.locked) throw new Error("Character storage already has an active writer.");
    locked = true;
    await client.query("begin");
    const expected = ownerFor(binding, legacy);
    const prior = await client.query(
      "select owner from character_runtime_owner where singleton=true for update"
    );
    if (prior.rows[0]) {
      const actual = prior.rows[0].owner as StorageOwner;
      if (
        actual.version !== expected.version ||
        actual.instanceId !== expected.instanceId ||
        actual.definitionId !== expected.definitionId ||
        actual.memoryPersonaId !== expected.memoryPersonaId
      )
        throw new Error("Database view belongs to another Character.");
    } else {
      if (!legacy) {
        const historical = await client.query(
          "select exists(select 1 from memories) or exists(select 1 from conversation_messages) or exists(select 1 from journal_events) or exists(select 1 from effect_intents) or exists(select 1 from recent_episodes) or exists(select 1 from profile_snapshots) or exists(select 1 from p8_corrections) or exists(select 1 from dream_jobs) or exists(select 1 from finalized_ingestion_turns) or exists(select 1 from profile_lifecycle) or exists(select 1 from memory_evidence_admissions) or exists(select 1 from conversation_sessions) or exists(select 1 from entities) or exists(select 1 from relations) as present"
        );
        if (historical.rows[0]?.present)
          throw new Error("A new Character cannot adopt historical Memory/conversations.");
      }
      await client.query("insert into character_runtime_owner(singleton,owner) values(true,$1)", [
        expected
      ]);
    }
    await client.query("commit");
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1,0))", [lock]);
      } finally {
        client.release();
      }
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (locked) await client.query("select pg_advisory_unlock_all()").catch(() => undefined);
    client.release();
    throw error;
  }
}
