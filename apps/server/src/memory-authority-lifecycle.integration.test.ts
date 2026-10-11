import { freezeFinalizedMemoryEvent } from "../../../packages/memory/src/finalized-memory-lineage.js";
import {
  canonicalLineageJson,
  lineageDigest
} from "../../../packages/memory/src/lineage-encoding.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool } from "@companion/database";
import { PostgresJournalRepository } from "@companion/journal";
import {
  PostgresMemoryAuthority,
  PostgresMemoryProvider,
  MemoryDecisionReassessment,
  MemoryIntegrityAudit,
  SemanticMemoryPolicy,
  JournalMemoryGroundingResolver,
  buildMemoryScope,
  readSqlMigrations,
  applySqlMigrations,
  PostgresContextUseRepository,
  contextManifestId,
  rebuildMemoryProjection
} from "@companion/memory";
import type { MemoryWriteEventInput } from "@companion/memory";
import { ConversationHostIdentity } from "./conversation-host-identity.js";
import {
  HostConversationalReceiptAdmission,
  toConversationalJournalRef
} from "./conversational-receipt-admission.js";

const url = process.env["YUVI_MEMORY_R5_TEST_DATABASE_URL"];
describe.skipIf(!url)(
  "Authority source audit, stale decision and retrieval evidence lifecycle",
  () => {
    const pool = createPostgresPool(url!);
    const namespace = "r5p2-lifecycle-" + randomUUID(),
      personaId = "character-instance:" + randomUUID(),
      personId = "p2-" + randomUUID();
    const scope = buildMemoryScope(personId, personaId);
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
      (id) => (id === personId ? "1" : null)
    );
    const ingress = new HostConversationalReceiptAdmission(journal, undefined, host);
    const authority = new PostgresMemoryAuthority(pool),
      provider = new PostgresMemoryProvider(authority);
    const audit = new MemoryIntegrityAudit(authority, journal);
    let token: string;
    beforeAll(async () => {
      await applySqlMigrations(pool, await readSqlMigrations());
      token = (await host.issue(personId)).token;
    });
    afterAll(() => pool.end());
    async function proposed(
      content: string,
      relation?: { supersedes?: string[]; supports?: string[]; conflicts?: string[] }
    ) {
      const sessionId = randomUUID();
      const identity = await host.authorize(
        { headers: { authorization: "Bearer " + token } },
        { sessionId }
      );
      const receipt = await ingress.admit({
        surface: "HTTP_MESSAGE",
        sessionId,
        runtimeEventId: randomUUID(),
        content,
        hostIdentity: identity!
      });
      const ref = toConversationalJournalRef(receipt.envelope);
      const source = await new JournalMemoryGroundingResolver(journal).resolve({
        sourceJournalRef: ref,
        sourceText: content
      });
      const semantic = freezeFinalizedMemoryEvent(
        source,
        { scope, kind: relation?.supersedes ? "correction" : "fact", content, ...relation },
        "test.semantic.v1"
      );
      const input = {
        ...semantic,
        idempotencyKey: randomUUID(),
        payloadDigest: lineageDigest(canonicalLineageJson(semantic))
      };
      await provider.prepareEvidence!("FINALIZED_INGESTION", input);
      await new Promise((r) => setTimeout(r, 3));
      return { input, ref, source };
    }
    it("reassesses a later correction against current B, preserves A→B→C, replay and original digest", async () => {
      const a = await proposed("Editor A"),
        savedA = await provider.writeEventIdempotent(a.input);
      const tea = await proposed("Tea T");
      const savedTea = await provider.writeEventIdempotent(tea.input);
      const b = await proposed("Editor B", { supersedes: [savedA.eventId!] }),
        c = await proposed("Editor C", { supersedes: [savedA.eventId!] });
      const savedB = await provider.writeEventIdempotent(b.input);
      const policy = new SemanticMemoryPolicy(
        {
          name: "deterministic-contract",
          async generateReasoning(input) {
            const prior = JSON.parse(input.messages[1]!.content).prior;
            const target = prior.find((e: any) => e.content === "Editor B");
            return {
              reasoning: "",
              answer: JSON.stringify({
                propositions: [
                  {
                    content: "Editor C",
                    evidenceText: "Editor C",
                    relation: "supersedes",
                    targetIds: [target.id]
                  }
                ]
              })
            };
          }
        },
        async () =>
          (await provider.knowledge.page({ scope, limit: 20 })).records.map((r) => r.event),
        { providerConfigured: true },
        pool
      );
      provider.reassessment = new MemoryDecisionReassessment(authority, policy, journal);
      const savedC = await provider.writeEventIdempotent(c.input);
      expect(savedC.status).toBe("written");
      expect((await provider.knowledge.detail(scope, savedA.eventId!))?.state).toBe("superseded");
      expect((await provider.knowledge.detail(scope, savedB.eventId!))?.state).toBe("superseded");
      expect((await provider.knowledge.detail(scope, savedC.eventId!))?.state).toBe("current");
      expect((await provider.knowledge.detail(scope, savedTea.eventId!))?.state).toBe("current");
      expect((await provider.writeEventIdempotent(c.input)).eventId).toBe(savedC.eventId);
      expect(
        await provider.reconcileEvent({
          scope,
          idempotencyKey: c.input.idempotencyKey,
          payloadDigest: c.input.payloadDigest
        })
      ).toMatchObject({ status: "applied", eventId: savedC.eventId });
      expect(
        await provider.reconcileEvent({
          scope,
          idempotencyKey: c.input.idempotencyKey,
          payloadDigest: "0".repeat(64)
        })
      ).toMatchObject({ status: "payload_conflict" });
      const job = (
        await pool.query(
          "select status,generation from memory_decision_reassessments where scope=$1 and logical_key=$2",
          [scope, c.input.idempotencyKey]
        )
      ).rows[0];
      expect(job).toEqual({ status: "complete", generation: 1 });
    }, 20000);
    it("persists source/payload/admission/relation/projection audit checkpoint, invalidates certificate on new version and detects corruption", async () => {
      const id = randomUUID();
      await audit.start(scope, id);
      let status = await audit.advance(scope, id, 2);
      expect(status?.status).toBe("RUNNING");
      while (status?.status === "RUNNING")
        status = await new MemoryIntegrityAudit(authority, journal).advance(scope, id, 2);
      expect(status?.status).toBe("VERIFIED");
      expect((await provider.knowledge.overview(scope)).integrity).toBe("VERIFIED");
      const more = await proposed("New project fact");
      await provider.writeEventIdempotent(more.input);
      expect((await provider.knowledge.overview(scope)).integrity).toBe("NOT_VERIFIED");
      const broken = (await provider.knowledge.page({ scope })).records[0]!;
      await pool.query(
        "update memory_authority_current set state='unattributed' where scope=$1 and id=$2",
        [scope, broken.id]
      );
      const next = randomUUID();
      await audit.start(scope, next);
      const bad = await audit.advance(scope, next, 100);
      expect(bad?.status).toBe("FAILED");
      expect(bad?.problems.some((p) => p.code === "PROJECTION_MISMATCH")).toBe(true);
      await rebuildMemoryProjection(authority, scope);
      const repaired = randomUUID();
      await audit.start(scope, repaired);
      expect((await audit.advance(scope, repaired, 100))?.status).toBe("VERIFIED");
    });
    it("records bounded legal retrieval candidates and distinguishes foreign reader and obsolete state", async () => {
      const source = await proposed("Query source");
      const access = await host.readAuthority(source.ref, scope);
      const found = await provider.retrieveRelevant({
        text: "Editor",
        scope,
        access: access!,
        traceId: randomUUID(),
        sourceJournalRef: source.ref,
        limit: 5
      });
      expect(found.status).toBe("ok");
      expect(found.retrievalId).toMatch(/^mre_/u);
      const evidence = await provider.retrievalEvidence.detail(scope, found.retrievalId!);
      expect(evidence?.candidates.filter((c) => c.selected).map((c) => c.content)).toEqual([
        "Editor C"
      ]);
      expect(evidence?.contexts).toEqual([]); // retrieval alone is never reported as model exposure
      const digest = lineageDigest(canonicalLineageJson("memory-block"));
      const manifest = {
        version: "context-use-manifest.v1" as const,
        namespace,
        executionId: randomUUID(),
        assemblyOrdinal: "1",
        scope,
        assemblyVersion: "test.v1",
        selectionVersion: "test.v1",
        enumeration: "TOP_K" as const,
        sources: [
          {
            owner: "MEMORY" as const,
            reference: "retrieval:" + found.retrievalId,
            revision: found.watermark!,
            digest,
            availability: "AVAILABLE" as const,
            revisionKind: "OBSERVED_SNAPSHOT" as const,
            selection: "SELECTED" as const,
            reason: "test",
            roots: []
          },
          {
            owner: "JOURNAL" as const,
            reference: JSON.stringify(source.ref),
            revision: source.ref.eventId,
            digest: null,
            availability: "AVAILABLE" as const,
            revisionKind: "NATIVE" as const,
            selection: "SELECTED" as const,
            reason: "actual cause",
            roots: []
          }
        ],
        blocks: [
          {
            key: "MEMORY_EVIDENCE",
            digest,
            characters: 8,
            sourceReferences: found.events.map((e) => e.id),
            stability: "VOLATILE" as const
          }
        ],
        stable: { version: "v1", digest },
        volatile: { version: "v1", digest }
      };
      const exposure = {
        version: "context-exposure.v1" as const,
        boundary: "PREPARED_FOR_USE" as const,
        manifestId: contextManifestId(manifest),
        consumerOperationSlot: "generateReply:" + randomUUID(),
        exposureOrdinal: "1",
        projectionVersion: "test.v1",
        inputDigest: digest,
        fields: [],
        blocks: [
          {
            key: "MEMORY_EVIDENCE",
            state: "EXPOSED" as const,
            digest,
            characters: 8,
            field: "input.messages.0.content",
            offset: 0,
            sourceReferences: found.events.map((e) => e.id)
          }
        ]
      };
      expect(manifest.executionId).not.toBe(
        (await provider.retrievalEvidence.page({ scope })).items[0]?.traceId
      );
      await new PostgresContextUseRepository(pool).admit(manifest, exposure);
      const used = await provider.retrievalEvidence.detail(scope, found.retrievalId!);
      expect(used?.contexts).toHaveLength(1);
      expect(used?.contexts[0]?.exposure.blocks[0]?.state).toBe("EXPOSED");
      expect(used?.contexts[0]?.consumers).toEqual([]); // PREPARED is not fabricated APPLIED
      const foreign = { ...manifest, namespace: "foreign", executionId: randomUUID() };
      await new PostgresContextUseRepository(pool).admit(foreign, {
        ...exposure,
        manifestId: contextManifestId(foreign),
        consumerOperationSlot: randomUUID()
      });
      expect(
        (await provider.retrievalEvidence.detail(scope, found.retrievalId!))?.contexts
      ).toHaveLength(1);
      // Imported/debug JSON cannot expose arbitrary private metadata through the product DTO.
      await pool.query(
        `update memory_retrieval_runs set candidates=jsonb_set(candidates,'{0,rawPrivateJournal}',to_jsonb('must not disclose'::text)) where scope=$1 and retrieval_id=$2`,
        [scope, found.retrievalId]
      );
      expect(
        JSON.stringify(await provider.retrievalEvidence.detail(scope, found.retrievalId!))
      ).not.toContain("must not disclose");
      const denied = await provider.retrieveRelevant({
        text: "Editor",
        scope,
        access: { principal: { namespace, actorId: "foreign" }, personId },
        traceId: randomUUID()
      });
      expect(denied.events).toEqual([]);
      expect(
        (await provider.retrievalEvidence.detail(scope, denied.retrievalId!))?.candidates
      ).toEqual([]);
    });
  }
);
