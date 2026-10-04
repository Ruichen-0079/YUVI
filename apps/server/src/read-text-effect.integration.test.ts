import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createPostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import {
  HostEffectIntentAdmission,
  PostgresEffectIntentStore,
  PostgresEffectDispatchStore,
  effectIntentId,
  type EffectIntentRequest
} from "@companion/effects";
import { fixtureIdentity } from "../../../packages/effects/src/test-fixture.js";
import {
  HostReadTextEffects,
  readAuthorizedLocalText,
  type ReadTextEffectInput
} from "./read-text-effect.js";
import { executeProductionCognition } from "./cognition-production.js";
import { SERVER_MCP_READ_TEXT_CAPABILITY_REF } from "./mcp-capability-binding.js";
const url = process.env["YUVI_EFFECT_TEST_DATABASE_URL"],
  schema = `host_a92_${randomBytes(6).toString("hex")}`;
let admin: ReturnType<typeof createPostgresPool>,
  pool: ReturnType<typeof createPostgresPool>,
  journal: PostgresJournalRepository,
  admission: HostEffectIntentAdmission,
  store: PostgresEffectDispatchStore,
  host: HostReadTextEffects,
  dir: string,
  path: string;
let cause: EffectIntentRequest["causalRefs"][number],
  seq = 0;
function input(): ReadTextEffectInput {
  return {
    path,
    logicalKey: `read-local:${++seq}`,
    scope: "session:controlled",
    executionId: "runtime:controlled",
    cause,
    expiresAt: "2099-01-01T00:00:00.000Z",
    isCurrent: () => true
  };
}
describe.skipIf(!url)("A9.2 real host read-text / Journal / PostgreSQL integration", () => {
  beforeAll(async () => {
    admin = createPostgresPool(url!);
    await admin.query(`create schema "${schema}"`);
    pool = createPostgresPool(url!, { options: `-c search_path=${schema},public` });
    for (const name of [
      "013_life_event_journal_v1.sql",
      "020_effect_intents_v1.sql",
      "021_effect_attempts_v1.sql",
      "022_native_control_effects_v1.sql",
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "023_reply_components_v1.sql"
    ])
      await pool.query(
        await readFile(
          new URL(`../../../packages/memory/migrations/${name}`, import.meta.url),
          "utf8"
        )
      );
    journal = new PostgresJournalRepository(pool, {
      namespace: "test:host:a92",
      authorityBuilder() {
        throw Error("host only");
      }
    });
    const receipt = await journal.appendWithHostAuthority(
      {
        command: {
          version: "life-event-command.v1",
          kind: "RECEIPT",
          occurrenceTime: { state: "UNKNOWN" },
          causalParents: [],
          data: { receiptClass: "CONTROL", evidenceSelectors: [] }
        }
      },
      {
        ...fixtureIdentity,
        surface: { kind: "LOCAL", reference: "task:read-text" },
        correlations: [],
        policyVersion: "host-test.v1",
        producer: { name: "host-test", version: "1" },
        sourceReferences: [{ kind: "UNRESOLVED_SOURCE", reason: "controlled local task" }],
        payloads: []
      }
    );
    cause = {
      kind: "JOURNAL_EVENT",
      namespace: receipt.envelope.journalNamespace,
      eventId: receipt.envelope.eventId
    };
    admission = new HostEffectIntentAdmission(new PostgresEffectIntentStore(pool), journal);
    store = new PostgresEffectDispatchStore(pool);
    host = new HostReadTextEffects(admission, store, journal);
    dir = await mkdtemp(join(tmpdir(), "yuvi-a92-read-"));
    path = join(dir, "authorized.txt");
    await writeFile(path, "controlled private UTF-8 文本");
  });
  afterAll(async () => {
    await host?.shutdown();
    await pool?.end();
    if (admin) {
      await admin.query(`drop schema "${schema}" cascade`);
      await admin.end();
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it("committed authority reaches actual adapter after durable start, contents never persist", async () => {
    const g = input();
    const result = await host.execute(g);
    expect(result.content).toEqual([{ type: "text", text: "controlled private UTF-8 文本" }]);
    const id = effectIntentId("yuvi.read-text.v1", g.logicalKey);
    const d = await host.dispatcher!.diagnostic(id);
    expect(d?.currentAttempt?.dispatchStartedAt).not.toBeNull();
    expect(d?.evidence?.certainty).toBe("APPLIED");
    const rows = await pool.query("select intent from effect_intents where intent_id=$1", [id]);
    const observations = await pool.query(
      "select evidence from effect_observations where attempt_id=$1",
      [d!.currentAttempt!.attemptId]
    );
    expect(JSON.stringify([rows.rows, observations.rows])).not.toContain(
      "controlled private UTF-8"
    );
    expect((await admission.get(id))?.authorization.identity.principal.state).toBe("UNRESOLVED");
    expect((await admission.get(id))?.authorization.identity.binding.state).toBe("UNRESOLVED");
  });
  it("duplicate logical call does not read again or regrant access", async () => {
    const g = input();
    await host.execute(g);
    await expect(host.execute(g)).rejects.toThrow("not pending");
    expect(
      (
        await pool.query("select count(*) from effect_attempts where intent_id=$1", [
          effectIntentId("yuvi.read-text.v1", g.logicalKey)
        ])
      ).rows[0]["count"]
    ).toBe("1");
  });
  it("missing Journal ancestry fails closed", async () => {
    const g = input();
    g.cause = { ...cause, eventId: "jev1_missing_authority" };
    await expect(host.execute(g)).rejects.toThrow();
    expect(await admission.get(effectIntentId("yuvi.read-text.v1", g.logicalKey))).toBeNull();
  });
  it("revoked currentness yields denied admission and no file access", async () => {
    const g = input();
    g.isCurrent = () => false;
    await expect(host.execute(g)).rejects.toThrow("not pending");
    const i = await admission.get(effectIntentId("yuvi.read-text.v1", g.logicalKey));
    expect(i?.decision).toBe("DENIED");
    expect(i?.request.payload).toBeUndefined();
  });
  it("restart has no volatile grant and cannot read admitted pending file", async () => {
    const g = input();
    const identity = fixtureIdentity;
    await admission.admit(
      {
        contractRef: "yuvi.read-text.v1",
        logicalKey: g.logicalKey,
        scope: g.scope,
        audience: identity.audience,
        payload: { path },
        causalRefs: [cause],
        executionId: g.executionId,
        expiresAt: g.expiresAt
      },
      {
        snapshot: {
          policyVersion: "runtime-read-text.v1",
          authorityVersion: "runtime:controlled",
          scope: g.scope,
          identity,
          permissions: ["RUNTIME_AUTHORIZED_PATH_READ"],
          allowed: true
        },
        isCurrent: () => true
      }
    );
    const reopened = new HostReadTextEffects(
      admission,
      new PostgresEffectDispatchStore(pool),
      journal
    );
    const id = effectIntentId("yuvi.read-text.v1", g.logicalKey);
    expect((await reopened.dispatcher!.run(id)).invoked).toBe(false);
    expect((await reopened.dispatcher!.diagnostic(id))?.preDispatchReason).toBe(
      "AUTHORITY_REVOKED"
    );
    await reopened.shutdown();
  });
  it("production Cognition uses A9 exclusively while Core owns capability/currentness", async () => {
    const answers = [
      `REQUEST_CAPABILITY\n${JSON.stringify({ capabilityRef: SERVER_MCP_READ_TEXT_CAPABILITY_REF, request: "Read admitted text" })}`,
      "COMPLETE\nVerified."
    ];
    const reason = vi.fn(async () => ({
      reasoning: "",
      answer: answers.shift()!,
      finishReason: "stop" as const
    }));
    await executeProductionCognition({
      providers: {
        getReasoningProvider: () => ({
          name: "local-fixture",
          healthCheck: vi.fn(),
          generateReasoning: reason
        })
      },
      request: { version: "character-harness-5g.v1", kind: "NEED_COGNITION", focus: "verify" },
      problem: "Controlled read",
      runtimeAuthorizedPath: path,
      readTextEffects: host,
      effectContext: { scope: "session:controlled", cause },
      execution: { executionId: "runtime:cognition", isCurrent: () => true },
      limits: { maxReasoningRounds: 4, maxCapabilityCalls: 2, timeBudgetMs: 60000 }
    });
    expect(reason).toHaveBeenCalledTimes(2);
    const i = effectIntentId(
      "yuvi.read-text.v1",
      `read-text:${cause.namespace}:${cause.eventId}:round:0`
    );
    expect((await store.diagnostic(i))?.evidence?.layer).toBe("LOCAL_READ_RETURNED");
  });
  it.each(["oversized", "invalid-utf8", "directory"])(
    "%s produces no false successful read",
    async (kind) => {
      const p = kind === "directory" ? dir : join(dir, kind);
      if (kind === "oversized") await writeFile(p, Buffer.alloc(64001));
      if (kind === "invalid-utf8") await writeFile(p, Buffer.from([0xff]));
      const g = input();
      g.path = p;
      await expect(host.execute(g)).rejects.toThrow();
      expect(
        (await store.diagnostic(effectIntentId("yuvi.read-text.v1", g.logicalKey)))?.evidence
          ?.certainty
      ).toBe("UNKNOWN");
    }
  );
  it("aborted file grant cannot execute", async () => {
    const c = new AbortController();
    c.abort();
    await expect(readAuthorizedLocalText(path, c.signal)).rejects.toThrow();
  });
  it("host shutdown refuses new admission", async () => {
    const closed = new HostReadTextEffects(admission, store, journal);
    await closed.shutdown();
    await expect(closed.execute(input())).rejects.toThrow("unavailable");
  });
});
