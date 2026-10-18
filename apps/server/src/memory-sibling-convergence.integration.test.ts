import { randomUUID } from "node:crypto";
import { createPostgresPool } from "@companion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresJournalRepository } from "@companion/journal";
import {
  PostgresMemoryAuthority,
  PostgresMemoryProvider,
  SemanticMemoryPolicy,
  FinalizedIngestionService,
  PostgresFinalizedIngestionRepository,
  JournalMemoryGroundingResolver,
  buildMemoryScope,
  readSqlMigrations,
  applySqlMigrations,
  verifyMemoryProjection,
  rebuildMemoryProjection,
  type AuthorityPool
} from "@companion/memory";
import { executeFinalizedIngestionEvent } from "../../../packages/memory/src/finalized-ingestion-executor.js";
import type { FinalizedIngestionAdmission } from "@companion/memory";
import { ConversationHostIdentity } from "./conversation-host-identity.js";
import {
  HostConversationalReceiptAdmission,
  toConversationalJournalRef
} from "./conversational-receipt-admission.js";

const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
type Proposition = {
  content: string;
  evidenceText: string;
  relation: "new" | "supersedes";
  targetIds: string[];
};
describe.skipIf(!url)("trusted source sibling correction convergence", () => {
  const schema = "sibling_" + randomUUID().replaceAll("-", "");
  const admin = createPostgresPool(url!);
  const pool = createPostgresPool(url!, {
    options: `-c search_path=${schema},public`,
    max: 8
  });
  const personaId = "character-instance:" + randomUUID(),
    personId = "person-" + randomUUID();
  const scope = buildMemoryScope(personId, personaId),
    namespace = "sibling-" + randomUUID();
  const journal = new PostgresJournalRepository(pool, {
    namespace,
    authorityBuilder() {
      throw Error("Host required");
    }
  });
  const host = new ConversationHostIdentity(
    pool,
    journal,
    { instanceId: personaId, personaId },
    () => "1"
  );
  const ingress = new HostConversationalReceiptAdmission(journal, undefined, host);
  const authority = new PostgresMemoryAuthority(pool, "synthetic-pending-index");
  const provider = new PostgresMemoryProvider(authority);
  const repository = new PostgresFinalizedIngestionRepository(pool);
  let token: string;
  beforeAll(async () => {
    await admin.query(`create schema "${schema}"`);
    await applySqlMigrations(pool, await readSqlMigrations());
    token = (await host.issue(personId)).token;
    authority.authorizeSource = async (input, tx) =>
      input.lineage?.state === "GROUNDED" &&
      Boolean(await host.readAuthority(input.lineage.parents[0]!.ref, scope, tx));
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  async function admit(text: string, propositions: Proposition[]) {
    const sessionId = randomUUID();
    const identity = await host.authorize(
      { headers: { authorization: "Bearer " + token } },
      { sessionId }
    );
    const receipt = await ingress.admit({
      surface: "HTTP_MESSAGE",
      sessionId,
      runtimeEventId: randomUUID(),
      content: text,
      hostIdentity: identity!
    });
    const ref = toConversationalJournalRef(receipt.envelope);
    const policy = new SemanticMemoryPolicy(
      {
        name: "protocol-fixture",
        async generateReasoning() {
          return { reasoning: "", answer: JSON.stringify({ propositions }) };
        }
      },
      async () =>
        (await provider.knowledge.page({ scope, limit: 100 })).records.map((r) => r.event),
      { providerConfigured: true },
      pool
    );
    const service = new FinalizedIngestionService(
      repository,
      policy,
      new JournalMemoryGroundingResolver(journal)
    );
    const input = {
      finalizedTurnId: "accepted-user:" + ref.eventId,
      assistantMessageId: null,
      sourceUserEventId: ref.eventId,
      conversationId: sessionId,
      traceId: randomUUID(),
      personaId,
      subjectUserId: personId,
      finalizedAt: receipt.envelope.recordedAt,
      ingestionRequested: true,
      userMessage: text,
      sourceText: text,
      sourceJournalRef: ref,
      assistantMessage: ""
    };
    return { admission: await service.admit(input), replay: () => service.admit(input), ref };
  }
  async function deliver(
    admission: FinalizedIngestionAdmission,
    order = admission.events.map((_, i) => i)
  ) {
    return Promise.all(
      order.map((i) =>
        executeFinalizedIngestionEvent({
          repository,
          provider,
          event: admission.events[i]!,
          leaseOwner: randomUUID(),
          leaseSeconds: 30
        })
      )
    );
  }
  async function initial(text: string) {
    const source = await admit(text, [
      { content: text, evidenceText: text, relation: "new", targetIds: [] }
    ]);
    await deliver(source.admission);
    return (await repository.listEvents(source.admission.turn.finalizedTurnId))[0]!
      .backendMemoryId!;
  }
  it.each([false, true])(
    "commits replacement and retraction in either worker order, replay and rebuild (reverse=%s)",
    async (reverse) => {
      const a = await initial("Editor A " + randomUUID());
      const source = await admit("现在用露川-4A87，旧代号已无效。", [
        {
          content: "现在用露川-4A87",
          evidenceText: "现在用露川-4A87",
          relation: "supersedes",
          targetIds: [a]
        },
        {
          content: "旧代号已无效",
          evidenceText: "旧代号已无效",
          relation: "supersedes",
          targetIds: [a]
        }
      ]);
      const order = reverse ? [1, 0] : [0, 1];
      // Sequential order is deliberately controlled; the scope lock is also tested below.
      for (const i of order) await deliver(source.admission, [i]);
      const turn = await repository.getTurn(source.admission.turn.finalizedTurnId);
      expect(turn).toMatchObject({
        status: "complete",
        completeEventCount: 2,
        failedEventCount: 0
      });
      const events = await repository.listEvents(source.admission.turn.finalizedTurnId);
      expect((await provider.knowledge.detail(scope, a))?.state).toBe("superseded");
      for (const e of events) {
        expect((await provider.knowledge.detail(scope, e.backendMemoryId!))?.state).toBe("current");
        expect(await provider.writeEventIdempotent(e.eventPayload)).toMatchObject({
          status: "unchanged",
          eventId: e.backendMemoryId
        });
        expect(
          (
            await pool.query(
              "select status from memory_authority_index_jobs where scope=$1 and id=$2",
              [scope, e.backendMemoryId]
            )
          ).rows[0]?.status
        ).toBe("pending");
      }
      expect((await source.replay()).events.map((e) => e.eventId)).toEqual(
        events.map((e) => e.eventId)
      );
      expect(
        (
          await pool.query(
            "select count(*) from memory_authority_relations where scope=$1 and to_id=$2",
            [scope, a]
          )
        ).rows[0]?.count
      ).toBe("2");
      const counts = await provider.knowledge.overview(scope);
      const actual = (
        await pool.query(
          "select count(*) from memory_authority_current where scope=$1 and state in ('current','conflicted')",
          [scope]
        )
      ).rows[0]!.count;
      expect(counts.current).toBe(actual);
      expect((await verifyMemoryProjection(pool, scope)).mismatches).toEqual([]);
      await rebuildMemoryProjection(authority, scope);
      expect((await provider.knowledge.overview(scope)).current).toBe(actual);
      const access = await host.readAuthority(source.ref, scope);
      const result = await provider.retrieveRelevant({
        scope,
        text: "露川-4A87",
        access: access!,
        limit: 5
      });
      expect(result.events.map((e) => e.id)).not.toContain(a);
      expect(
        (await provider.retrievalEvidence.detail(scope, result.retrievalId!))?.candidates
          .filter((e) => e.selected)
          .map((e) => e.id)
      ).toContain(
        events.find((e) => e.eventPayload.content === "现在用露川-4A87")!.backendMemoryId
      );
    }
  );
  it("serializes concurrent siblings and a duplicate claim without duplicate records", async () => {
    const a = await initial("Concurrent A " + randomUUID());
    const source = await admit("并发新值，旧值撤回", [
      { content: "并发新值", evidenceText: "并发新值", relation: "supersedes", targetIds: [a] },
      { content: "旧值撤回", evidenceText: "旧值撤回", relation: "supersedes", targetIds: [a] }
    ]);
    await deliver(source.admission, [0, 1, 0]);
    expect(await repository.getTurn(source.admission.turn.finalizedTurnId)).toMatchObject({
      status: "complete",
      completeEventCount: 2
    });
    expect(
      (
        await pool.query(
          "select count(*) from memory_authority_records where scope=$1 and id=any($2::text[])",
          [
            scope,
            (await repository.listEvents(source.admission.turn.finalizedTurnId)).map(
              (e) => e.backendMemoryId
            )
          ]
        )
      ).rows[0]!.count
    ).toBe("2");
  });
  it("requires the same durable turn, not just a copied Journal reference", async () => {
    const a = await initial("Cohort A " + randomUUID());
    const source = await admit("新值B，A已失效", [
      { content: "新值B", evidenceText: "新值B", relation: "supersedes", targetIds: [a] },
      { content: "A已失效", evidenceText: "A已失效", relation: "supersedes", targetIds: [a] }
    ]);
    await deliver(source.admission, [0]);
    const copied = { ...source.admission.events[1]!.eventPayload, idempotencyKey: randomUUID() };
    await provider.prepareEvidence!("FINALIZED_INGESTION", copied);
    expect(await provider.writeEventIdempotent(copied)).toMatchObject({
      status: "rejected",
      errorCode: "MEMORY_TARGET_STALE_OR_INACCESSIBLE"
    });
    await deliver(source.admission, [1]);
    expect((await repository.getTurn(source.admission.turn.finalizedTurnId))?.status).toBe(
      "complete"
    );
  });
  it("recovers a lost COMMIT acknowledgement without a second authority record", async () => {
    const a = await initial("ACK A " + randomUUID());
    const source = await admit("新值已定，A无效", [
      { content: "新值已定", evidenceText: "新值已定", relation: "supersedes", targetIds: [a] },
      { content: "A无效", evidenceText: "A无效", relation: "supersedes", targetIds: [a] }
    ]);
    await deliver(source.admission, [0]);
    let disconnect = true;
    const connection: AuthorityPool = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          async query(sql, values) {
            const result = await client.query(sql, values);
            if (sql === "commit" && disconnect) {
              disconnect = false;
              throw Error("injected lost COMMIT acknowledgement after PostgreSQL committed");
            }
            return result;
          }
        };
      }
    };
    const uncertainAuthority = new PostgresMemoryAuthority(connection, authority.indexModel);
    uncertainAuthority.authorizeSource = authority.authorizeSource;
    const uncertain = new PostgresMemoryProvider(uncertainAuthority);
    const delivered = await executeFinalizedIngestionEvent({
      repository,
      provider: uncertain,
      event: source.admission.events[1]!,
      leaseOwner: randomUUID(),
      leaseSeconds: 30
    });
    expect(delivered.outcome).toMatchObject({ status: "rejected", failureClass: "ambiguous" });
    expect(delivered.event?.status).toBe("reconcile_required");
    const event = delivered.event!;
    const owner = randomUUID();
    const claimed = await repository.claimReconcileEvent({
      ...event,
      expectedVersion: event.version,
      leaseOwner: owner,
      leaseSeconds: 30
    });
    const result = await provider.reconcileEvent({
      scope,
      idempotencyKey: event.backendIdempotencyKey,
      payloadDigest: event.eventPayload.payloadDigest!
    });
    expect(result.status).toBe("applied");
    await repository.recordReconcileOutcome({
      ...event,
      leaseOwner: owner,
      expectedVersion: claimed!.version,
      result
    });
    expect((await repository.getTurn(event.finalizedTurnId))?.status).toBe("complete");
    expect(await provider.writeEventIdempotent(event.eventPayload)).toMatchObject({
      status: "unchanged"
    });
    expect((await verifyMemoryProjection(pool, scope)).mismatches).toEqual([]);
  });
  it("reclaims a worker lease before dispatch and fences the expired owner", async () => {
    const a = await initial("Lease A " + randomUUID());
    const source = await admit("新值，旧值失效", [
      { content: "新值", evidenceText: "新值", relation: "supersedes", targetIds: [a] },
      { content: "旧值失效", evidenceText: "旧值失效", relation: "supersedes", targetIds: [a] }
    ]);
    const event = source.admission.events[0]!;
    const claimed = await repository.claimEvent({
      ...event,
      expectedVersion: event.version,
      leaseOwner: "expired-owner",
      leaseSeconds: 1
    });
    const reclaimed = await repository.reclaimExpiredEvent({
      ...event,
      expectedVersion: claimed!.version,
      now: new Date(Date.now() + 2000).toISOString()
    });
    expect(reclaimed?.status).toBe("pending");
    expect(
      await repository.markEventDispatchStarted({
        ...event,
        expectedVersion: claimed!.version,
        leaseOwner: "expired-owner"
      })
    ).toBeNull();
    await deliver({ ...source.admission, events: [reclaimed!, source.admission.events[1]!] });
    expect((await repository.getTurn(event.finalizedTurnId))?.status).toBe("complete");
  });
  it("keeps independent corrections/new facts despite another invalid quote", async () => {
    const a = await initial("Editor old " + randomUUID()),
      b = await initial("Tea old " + randomUUID());
    const source = await admit("编辑器新值，茶叶新值，项目新决定", [
      { content: "编辑器新值", evidenceText: "编辑器新值", relation: "supersedes", targetIds: [a] },
      { content: "茶叶新值", evidenceText: "茶叶新值", relation: "supersedes", targetIds: [b] },
      { content: "项目新决定", evidenceText: "项目新决定", relation: "new", targetIds: [] },
      { content: "虚构引文", evidenceText: "not in source", relation: "new", targetIds: [] }
    ]);
    expect(source.admission.events).toHaveLength(3);
    await deliver(source.admission);
    const turn = await repository.getTurn(source.admission.turn.finalizedTurnId);
    expect(turn).toMatchObject({ status: "partial", completeEventCount: 3 });
    expect((await provider.knowledge.detail(scope, a))?.state).toBe("superseded");
    expect((await provider.knowledge.detail(scope, b))?.state).toBe("superseded");
    expect((await verifyMemoryProjection(pool, scope)).mismatches).toEqual([]);
  });
  it("does not bypass a later independent correction or accept an older late worker", async () => {
    const a = await initial("Chronology A " + randomUUID());
    const b = await admit("值B，A撤回", [
      { content: "值B", evidenceText: "值B", relation: "supersedes", targetIds: [a] },
      { content: "A撤回", evidenceText: "A撤回", relation: "supersedes", targetIds: [a] }
    ]);
    await deliver(b.admission, [0]);
    const bId = (await repository.listEvents(b.admission.turn.finalizedTurnId))[0]!
      .backendMemoryId!;
    const c = await admit("值C", [
      { content: "值C", evidenceText: "值C", relation: "supersedes", targetIds: [bId] }
    ]);
    await deliver(c.admission);
    // B's remaining sibling must not sneak back after C has retracted B.
    const late = await deliver(b.admission, [1]);
    expect(late[0]?.outcome).toMatchObject({
      status: "rejected",
      errorCode: "MEMORY_TARGET_STALE_OR_INACCESSIBLE"
    });
    const cId = (await repository.listEvents(c.admission.turn.finalizedTurnId))[0]!
      .backendMemoryId!;
    expect((await provider.knowledge.detail(scope, cId))?.state).toBe("current");
    // A fresh clarification is a new trusted source; it does not rewrite the old receipt.
    const clarify = await admit("值D，C已无效", [
      { content: "值D", evidenceText: "值D", relation: "supersedes", targetIds: [cId] }
    ]);
    await deliver(clarify.admission);
    expect((await repository.getTurn(clarify.admission.turn.finalizedTurnId))?.status).toBe(
      "complete"
    );
    expect((await repository.getTurn(b.admission.turn.finalizedTurnId))?.status).toBe("partial");
  });
});
