/** Real host/store pipeline in a disposable child. Parent kills only after an IPC barrier. */
import { appendFile } from "node:fs/promises";
import pg from "pg";
import { FaultPlan, faultPool, faultPort } from "./fault-surface.mjs";
import { PostgresJournalRepository } from "../../packages/journal/dist/index.js";
import {
  PostgresContextUseRepository,
  PostgresConversationRepository
} from "../../packages/memory/dist/index.js";
import {
  HostEffectIntentAdmission,
  PostgresEffectIntentStore,
  PostgresEffectDispatchStore,
  EffectDispatcher,
  effectDigest
} from "../../packages/effects/dist/index.js";
import {
  HostConversationalReceiptAdmission,
  toConversationalJournalRef
} from "../../apps/server/dist/conversational-receipt-admission.js";
import { HostOutwardEffects } from "../../apps/server/dist/outward-effects.js";
import { HostPresentationEffects } from "../../apps/server/dist/presentation-effects.js";
import { composeServerCharacterSoftSmileEmbodiedEffect } from "../../apps/server/dist/character-embodied-soft-smile-composition.js";
import { withProviderWorkContext } from "../../packages/providers/dist/index.js";
import { createEvent } from "../../packages/protocol/dist/index.js";

const {
  YUVI_CONFORMANCE_POINT: point,
  YUVI_CONFORMANCE_MODE: mode,
  YUVI_CONFORMANCE_EXECUTION: execution,
  YUVI_CONFORMANCE_SCHEMA: schema,
  YUVI_CONFORMANCE_MARKER: marker
} = process.env;
if (!/^[a-z0-9_]+$/.test(schema ?? "")) throw Error("Unsafe isolated schema");
const pool = new pg.Pool({
  connectionString: process.env.YUVI_EFFECT_TEST_DATABASE_URL,
  options: `-c search_path=${schema},public`
});
const faults = new FaultPlan();
faults.arm(point, "IPC");
const transactionPool = (label) => {
  let written = false;
  return faultPool(pool, faults, (sql) => {
    if (sql.startsWith("insert into")) written = true;
    if (sql === "commit" && written) {
      written = false;
      return `${label}.commit`;
    }
    if (sql === "rollback") written = false;
    return null;
  });
};
const journal = new PostgresJournalRepository(transactionPool("receipt"), {
  namespace: execution,
  authorityBuilder() {
    throw Error("Host authority required");
  }
});
const receipt = await faultPort(
  new HostConversationalReceiptAdmission(journal),
  { admit: "receipt" },
  faults
).admit({
  surface: "HTTP_MESSAGE",
  sessionId: execution,
  runtimeEventId: execution,
  content: "retained causal input"
});
const cause = toConversationalJournalRef(receipt.envelope);
const admission = new HostEffectIntentAdmission(
  new PostgresEffectIntentStore(transactionPool("intent")),
  journal
);
const realStore = new PostgresEffectDispatchStore(pool);
const store = faultPort(
  realStore,
  { claim: "attempt", start: "dispatch-start", record: "observation" },
  faults
);
function host(controlled) {
  const selectedStore = controlled ? store : realStore;
  const dispatcher = new EffectDispatcher(selectedStore, [], 30000, 4, true);
  const owner = new HostOutwardEffects(
    controlled ? faultPort(admission, { admit: "intent" }, faults) : admission,
    selectedStore,
    dispatcher,
    journal,
    execution
  );
  owner.setContextUseRepository(
    faultPort(
      new PostgresContextUseRepository(transactionPool("manifest")),
      { admit: "manifest" },
      faults
    )
  );
  return { owner, dispatcher };
}
const provider = host(mode === "provider");
const task = {
  operationId: execution,
  operation: "generateReply",
  inputDigest: effectDigest("bounded input"),
  configurationRef: "controlled-provider.v1",
  routingPlan: [{ provider: "controlled", model: "fixture" }],
  assemblyOrdinal: "1",
  context: { executionId: execution, scope: `session:${execution}`, cause, isCurrent: () => true },
  exposure: {
    projectionVersion: "fixture-input.v1",
    inputDigest: effectDigest("bounded input"),
    fields: [],
    blocks: []
  }
};
async function external() {
  await faults.around("external-effect", async () => {
    await appendFile(marker, "invoked\n");
  });
}
await provider.owner.invoke(
  task,
  { provider: "controlled", model: "fixture", method: "generateReply" },
  async () => {
    if (mode === "provider") await external();
    return { content: "projected reply" };
  }
);

if (mode !== "provider") {
  const selected = host(true),
    owner = selected.owner;
  const target = { surface: "SSE", targetId: execution, targetGeneration: "active-generation" };
  owner.registerTarget(
    target,
    () => mode === "publication",
    () => true
  );
  const conversation = new PostgresConversationRepository(pool);
  conversation.setPublicationAdmission(owner.admitReplyPublications);
  const message = await conversation.appendMessage({
    id: execution,
    sessionId: execution,
    traceId: execution,
    parentMessageId: null,
    role: "assistant",
    content: "",
    status: "streaming",
    createdAt: new Date().toISOString(),
    completedAt: null,
    metadata: {}
  });
  const component = await withProviderWorkContext(
    {
      cause,
      scope: `session:${execution}`,
      executionId: execution,
      speechPlan: "CLIENT_SEGMENTED",
      speechRequestId: execution
    },
    () =>
      faults.around("publication-admission", () =>
        conversation.appendReplyComponent({
          replyId: execution,
          messageId: message.id,
          sequence: "1",
          text: "projected reply",
          projectionVersion: "runtime-text.v1"
        })
      )
  );
  if (mode === "publication") {
    await owner.publish({
      target,
      frameId: component.componentId,
      replyId: execution,
      componentId: component.componentId,
      payload: { text: "projected reply" },
      write: external
    });
  } else if (mode === "presentation") {
    const presentation = new HostPresentationEffects(pool, owner, { publish: external }, () => ({
      generation: "active-generation",
      requestId: execution,
      current: () => true
    }));
    const decision = composeServerCharacterSoftSmileEmbodiedEffect(
      {
        version: "character-harness-5d.v1",
        status: "ACCEPTED",
        proposal: {
          disposition: "RESPOND",
          text: "projected reply",
          presentation: { intent: "soft-smile" }
        }
      },
      { kind: "turn", reference: execution },
      {
        allocateProposalInstance: () => ({ reference: `proposal:${execution}`, createdAtMs: 1 }),
        allocateEffectId: () => `effect:${execution}`,
        policyAllowsEmbodiedEffect: () => true
      }
    );
    await presentation.dispatch(
      decision,
      createEvent(
        "agent.reply",
        { content: "projected reply" },
        { id: execution, traceId: execution }
      )
    );
  } else throw Error("Unsupported path");
}
await faults.hit("finished");
throw Error(`Fault point was not reached: ${point}`);
