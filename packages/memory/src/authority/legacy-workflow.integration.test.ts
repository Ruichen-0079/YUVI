import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { applySqlMigrations, readSqlMigrations } from "../migrations.js";
import { buildMemoryScope } from "../scope.js";
import { PostgresMemoryAuthority } from "./store.js";
import { PostgresMemoryProvider } from "./provider.js";
import { MemoryLegacyWorkflow } from "./legacy-workflow.js";
const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
describe.skipIf(!url)("offline legacy migration durable workflow", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const authority = new PostgresMemoryAuthority(pool),
    workflow = new MemoryLegacyWorkflow(authority);
  beforeAll(async () => {
    await applySqlMigrations(pool, await readSqlMigrations());
  });
  afterAll(() => pool.end());
  async function source(n: number) {
    const person = "legacy-" + randomUUID(),
      persona = "persona-" + randomUUID(),
      scope = buildMemoryScope(person, persona),
      id = randomUUID();
    await pool.query(
      `insert into memories(subject_user_id,persona_id,type,source,content,status,metadata) select $1,$2,'semantic','legacy-synthetic', 'Retained legacy '||i,case when i%3=0 then 'superseded' else 'active' end,jsonb_build_object('originalSource','unverified','privateRawSource','never product output') from generate_series(1,$3::int) i`,
      [person, persona, n]
    );
    return { person, persona, scope, id };
  }
  it("reopens checkpoints, serializes parallel batches, preserves history and verifies 250 frozen source digests without promotion", async () => {
    const s = await source(250),
      actor = "synthetic-operator";
    const initial = await workflow.prepare({
      id: s.id,
      scope: s.scope,
      legacyPerson: s.person,
      legacyPersona: s.persona,
      actor
    });
    expect(initial.expected).toBe("250");
    await workflow.advance(s.scope, s.id, actor, 50);
    await workflow.pause(s.scope, s.id, actor, true);
    expect(
      (
        await new MemoryLegacyWorkflow(new PostgresMemoryAuthority(pool)).advance(
          s.scope,
          s.id,
          actor
        )
      ).status
    ).toBe("PAUSED");
    await workflow.pause(s.scope, s.id, actor, false);
    let status = await workflow.status(s.scope, s.id);
    for (let i = 0; i < 30 && status?.status !== "IMPORT_VERIFIED"; i++) {
      await Promise.all([
        workflow.advance(s.scope, s.id, actor, 50),
        new MemoryLegacyWorkflow(authority).advance(s.scope, s.id, actor, 50)
      ]);
      status = await workflow.status(s.scope, s.id);
    }
    expect(status).toMatchObject({
      status: "IMPORT_VERIFIED",
      snapshot: "250",
      imported: "250",
      verified: "250",
      classification: "LEGACY_UNVERIFIED",
      activation: "BLOCKED_SOURCE_REVIEW_REQUIRED"
    });
    expect(status!.sourceDigest).toBe(status!.verifyDigest);
    const provider = new PostgresMemoryProvider(authority);
    expect(await provider.knowledge.overview(s.scope)).toMatchObject({
      records: "250",
      current: "0",
      legacy: "250"
    });
    expect(
      (await provider.knowledge.timeline({ scope: s.scope, limit: 100 })).records
    ).toHaveLength(100);
    const output = JSON.stringify(await provider.knowledge.timeline({ scope: s.scope }));
    expect(output).not.toContain("privateRawSource");
    expect(
      (
        await pool.query(
          "select count(*) from memories where subject_user_id=$1 and persona_id=$2",
          [s.person, s.persona]
        )
      ).rows[0]!.count
    ).toBe("250");
    expect(
      (
        await pool.query(
          "select count(*) from memory_authority_records where scope=$1 and classification='GROUNDED'",
          [s.scope]
        )
      ).rows[0]!.count
    ).toBe("0");
    const retrieval = await provider.retrieveRelevant({
      scope: s.scope,
      text: "Retained",
      access: {
        principal: { namespace: "test", actorId: "x" },
        personId: s.person
      }
    });
    expect(retrieval).toMatchObject({
      status: "partial",
      events: [],
      limitReason: "MEMORY_LEGACY_OR_UNATTRIBUTED_REQUIRES_REVIEW"
    });
    await expect(workflow.status(buildMemoryScope("another", s.persona), s.id)).resolves.toBeNull();
    await expect(
      workflow.prepare({
        id: s.id,
        scope: s.scope,
        legacyPerson: "another",
        legacyPersona: s.persona,
        actor
      })
    ).rejects.toThrow("IDENTITY_CONFLICT");
  }, 20000);
  it("detects mutable source changes and leaves the imported archive explicitly blocked", async () => {
    const s = await source(2),
      actor = "operator";
    await workflow.prepare({
      id: s.id,
      scope: s.scope,
      legacyPerson: s.person,
      legacyPersona: s.persona,
      actor
    });
    await workflow.advance(s.scope, s.id, actor);
    await workflow.advance(s.scope, s.id, actor);
    await pool.query(
      "update memories set content='Altered',updated_at=clock_timestamp() where subject_user_id=$1",
      [s.person]
    );
    expect(await workflow.advance(s.scope, s.id, actor)).toMatchObject({
      status: "SOURCE_CHANGED",
      errorCode: "MEMORY_MIGRATION_SOURCE_CHANGED",
      activation: "BLOCKED_SOURCE_REVIEW_REQUIRED"
    });
    expect((await new PostgresMemoryProvider(authority).knowledge.overview(s.scope)).records).toBe(
      "2"
    );
  });
  it("rejects synthetic default identity, remains atomic on import failure and safely replays", async () => {
    const s = await source(2),
      actor = "operator";
    await expect(
      workflow.prepare({
        id: s.id,
        scope: s.scope,
        legacyPerson: "default-user",
        legacyPersona: s.persona,
        actor
      })
    ).rejects.toThrow("IDENTITY_UNVERIFIED");
    await workflow.prepare({
      id: s.id,
      scope: s.scope,
      legacyPerson: s.person,
      legacyPersona: s.persona,
      actor
    });
    await workflow.advance(s.scope, s.id, actor);
    const injected = new MemoryLegacyWorkflow(
      new PostgresMemoryAuthority(
        new Proxy(pool, {
          get(target, key) {
            if (key === "connect")
              return async () => {
                const c = await target.connect();
                const original = c.query,
                  query = c.query.bind(c),
                  release = c.release.bind(c);
                c.release = () => {
                  c.query = original;
                  c.release = release;
                  release();
                };
                c.query = ((...args: any[]) => {
                  if (String(args[0]).includes("update memory_legacy_workflow_items set target_id"))
                    throw Error("injected before checkpoint");
                  return (query as any)(...args);
                }) as any;
                return c;
              };
            return Reflect.get(target, key, target);
          }
        })
      )
    );
    await expect(injected.advance(s.scope, s.id, actor)).rejects.toThrow("injected");
    expect((await workflow.status(s.scope, s.id))?.imported).toBe("0");
    expect(
      (await pool.query("select count(*) from memory_authority_records where scope=$1", [s.scope]))
        .rows[0]!.count
    ).toBe("0");
    await workflow.advance(s.scope, s.id, actor);
    expect((await workflow.advance(s.scope, s.id, actor)).status).toBe("IMPORT_VERIFIED");
  });
});
