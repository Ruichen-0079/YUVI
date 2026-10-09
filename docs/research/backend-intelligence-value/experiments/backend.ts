import assert from "node:assert/strict";
import { RuntimeOrchestrator } from "@companion/core";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  MemoryService,
  InMemoryMemoryRepository,
  InMemoryConversationRepository
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider
} from "@companion/providers";
import { createServerCharacterPort } from "#repo/apps/server/src/character-runtime.ts";
import {
  createP8EvidenceAdapterProjection,
  createDefaultP8IdentityAddress,
  DEFAULT_AUTHORED_INVARIANTS
} from "@companion/p8";
import {
  DreamConsolidationEngine,
  InMemoryDreamJobStore
} from "#repo/packages/memory/src/dream-consolidation.ts";
import { InMemoryRecentEpisodeStore } from "#repo/packages/memory/src/recent-episode-store.ts";
import { assembleDreamFixtureEpisodes } from "#repo/packages/memory/src/dream-test-fixture.ts";
import { receipt } from "#repo/packages/memory/src/journal-evidence.test-fixture.ts";
import { detectCurrentAffect } from "#repo/packages/memory/src/affect.ts";
import { executeProductionCognition } from "#repo/apps/server/src/cognition-production.ts";
import { SERVER_MCP_READ_TEXT_CAPABILITY_REF } from "#repo/apps/server/src/mcp-capability-binding.ts";

// Providers are input recorders, not a quality evaluation or simulated Alice.
const output = (text: string) => ({
  message: { role: "assistant", content: text },
  finishReason: "stop",
  model: "offline-recorder"
});
function harness(extra: any = {}) {
  const calls: any[] = [],
    decisions: any[] = [],
    wakes: Array<() => void> = [];
  let now = Date.now();
  const chat = {
    name: "offline-recorder",
    streamingMode: "native",
    async generateReply(input: any) {
      calls.push({ kind: "gate", input });
      return output('{"disposition":"RESPOND"}');
    },
    async *streamReply(input: any) {
      calls.push({ kind: "body", input });
      yield { type: "text-delta", text: "Acknowledged." };
      yield { type: "completed", output: output("Acknowledged.") };
    }
  };
  const conversation = new InMemoryConversationRepository();
  const runtime = new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory: new MemoryService(new InMemoryMemoryRepository()),
    conversation,
    promptBuilder: new PromptBuilder(),
    character: createServerCharacterPort(),
    p8CorrectionStore: {
      async loadCorrections() {
        return { status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] };
      },
      async loadCorrectionByReference() {
        return { status: "UNAVAILABLE" };
      },
      async appendCorrection() {
        throw new Error("Probe does not author corrections");
      }
    } as any,
    providers: {
      getChatProvider: () => chat,
      getReasoningProvider: () => createMockReasoningProvider(),
      getVisionProvider: () => createMockVisionProvider(),
      getSTTProvider: () => createMockSTTProvider(),
      getEmbeddingProvider: () => undefined,
      getTTSProvider: () => undefined,
      hasProactiveRoute: () => true,
      getProactiveDecisionProvider: () => ({
        name: "offline-score",
        async decide(input: any) {
          decisions.push(input);
          return { score: 0, model: "offline-recorder" };
        }
      })
    } as any,
    now: () => now,
    setProactiveWake(cb: () => void) {
      wakes.push(cb);
      return wakes.length;
    },
    clearProactiveWake() {},
    ...extra
  });
  return {
    runtime,
    calls,
    decisions,
    wakes,
    conversation,
    advance(ms: number) {
      now += ms;
    }
  };
}
const row = (id: string, sessionId: string, role: "user" | "assistant", content: string) => ({
  id,
  sessionId,
  traceId: "probe",
  parentMessageId: null,
  role,
  content,
  status: "completed" as const,
  createdAt: "2026-10-08T10:00:00.000Z",
  completedAt: "2026-10-08T10:00:01.000Z",
  metadata: {}
});

const affectText = "我不担心这个问题。请给出完整推导。";
const affect = detectCurrentAffect({ text: affectText });
assert.equal(affect?.affectLabel, "anxious");
const a = harness();
await a.runtime.handleUserMessage(
  {
    sessionId: "affect",
    subjectUserId: "person-a",
    personaId: "alice",
    content: affectText
  } as any,
  { readMemory: false, writeMemory: false }
);
const affectRequests = JSON.stringify(a.calls);
assert.ok(affectRequests.includes("User appears anxious"));
assert.ok(affectRequests.includes(affectText));
const affectProbe = {
  original: affectText,
  heuristic: affect,
  productionCharacterCalls: a.calls.length,
  originalPreserved: true,
  incorrectHintReachedProvider: true,
  requests: a.calls
};

const p8Input: any = {
  address: createDefaultP8IdentityAddress(),
  authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
  expectedScopeReference: { reference: "scope-person-a" },
  longTerm: {
    status: "ok",
    source: "probe-input",
    limited: false,
    events: [
      {
        id: "evidence-a",
        kind: "fact",
        content: "We have collaborated on Project Cedar for six months.",
        scope: "scope-person-a",
        source: "probe-input",
        recordedAt: "2026-10-08T10:00:00.000Z",
        metadata: {}
      }
    ]
  }
};
const bare = createP8EvidenceAdapterProjection({
  ...p8Input,
  interpretationCandidates: [{ domain: "RELATIONSHIP_CONTEXT" }]
});
const interpreted = createP8EvidenceAdapterProjection({
  ...p8Input,
  interpretationCandidates: [
    {
      domain: "RELATIONSHIP_CONTEXT",
      meaning: "We share a six-month collaboration history.",
      evidenceLinks: [{ evidenceReference: "evidence-a", relation: "SUPPORTS", support: "DIRECT" }]
    }
  ]
});
assert.equal(bare.interpretations[0]?.status, "UNKNOWN");
assert.equal(bare.interpretations[0]?.meaning, undefined);
assert.ok(interpreted.interpretations[0]?.meaning);
const p8Probe = {
  evidenceCount: bare.longTermEvidence.evidenceCount,
  productionShapeCandidate: bare.interpretations[0],
  explicitSemanticInput: interpreted.interpretations[0],
  counterfactualMeaningWasSuppliedByProbeNotGenerated: true
};

const dNow = new Date("2026-10-08T12:00:00.000Z");
const episodes = assembleDreamFixtureEpisodes({
  messages: [
    row("dream-u", "dream", "user", "我今天在整理书架。"),
    row("dream-a", "dream", "assistant", "好。")
  ].map((x, i) => ({ ...x, sequence: i + 1 })),
  now: dNow,
  sessionId: "dream",
  personaId: "alice",
  subjectUserId: "person-a",
  memoryScope: "scope-person-a"
});
const jobs = new InMemoryDreamJobStore(),
  store = new InMemoryRecentEpisodeStore();
await store.upsert(episodes[0]!);
const dream = new DreamConsolidationEngine(jobs, store);
const clockOnly = await dream.consider({ episode: episodes[0]!, existing: episodes, now: dNow });
const explicitElapsed = await dream.consider({
  episode: episodes[0]!,
  existing: episodes,
  now: dNow,
  idleMs: 31 * 60 * 1000
});
assert.equal(clockOnly.triggered, false);
assert.equal(explicitElapsed.triggerKind, "idle");
const stillPending = await jobs.listDue(new Date(dNow.getTime() + 24 * 3600000), 4);
assert.equal(stillPending.length, 1);
assert.equal(stillPending[0]?.status, "pending");
const dreamProbe = {
  fixture:
    "Committed-source fixture supplies inputs; real assembler/engine/store are invoked, no Postgres worker or model",
  productionCallerShape: clockOnly,
  withExplicitIdle: {
    triggered: explicitElapsed.triggered,
    triggerKind: explicitElapsed.triggerKind
  },
  afterOneDayWithoutExecutor: { due: stillPending.length, status: stillPending[0]?.status }
};

const v = harness();
const transcript = "我支持方案甲。 我反对方案甲。";
const observation: any = {
  text: transcript,
  confidence: 0.8,
  observationId: "voice-observation-a",
  captureEpoch: "epoch-a",
  model: "fixture-stt",
  segments: [
    {
      segmentId: "seg-A",
      text: "我支持方案甲。",
      speakerClusterId: "cluster-A",
      startMs: 0,
      endMs: 900,
      confidence: 0.97
    },
    {
      segmentId: "seg-B",
      text: "我反对方案甲。",
      speakerClusterId: "cluster-B",
      startMs: 1100,
      endMs: 2000,
      confidence: 0.31
    }
  ]
};
const reservation = v.runtime.reserveFinalizedSpeechObservation(observation, {
  sessionId: "voice",
  captureEpoch: "epoch-a"
});
const committed: any = receipt({ text: transcript });
committed.authority.correlations.push({
  kind: "VOICE_OBSERVATION",
  observationId: reservation.observation.observationId,
  captureEpoch: reservation.captureEpoch
});
assert.equal(v.runtime.finalizeSpeechReservation(reservation.token, committed).status, "ready");
const event = v.runtime.commitSpeechTurn(
  reservation.observation.observationId!,
  "voice",
  transcript
);
assert.equal(event.payload.segments?.length, 2);
assert.ok(!("confidence" in event.payload.segments![0]!));
await v.runtime.handleUserMessage(event, { readMemory: false, writeMemory: false });
const voiceRequests = JSON.stringify(v.calls);
assert.ok(voiceRequests.includes(transcript));
assert.ok(!voiceRequests.includes("cluster-A"));
assert.ok(!voiceRequests.includes("cluster-B"));
const voiceProbe = {
  inputSegments: observation.segments,
  committedSegments: event.payload.segments,
  productionCharacterCalls: v.calls.length,
  transcriptReachedProvider: true,
  segmentLabelsReachedProvider: false,
  segmentConfidenceRetainedInCommittedTranscript: false,
  requests: v.calls
};

const h = harness({ proactiveConsentProjectionRequired: true });
await h.conversation.appendMessage(
  row("default-u", "default", "user", "DEFAULT_CONTEXT_MARKER 我们谈论花园。")
);
await h.conversation.appendMessage(
  row("work-u", "work", "user", "WORK_CONTEXT_MARKER 我们分析编译器。")
);
h.runtime.applyProactiveConsentProjection({ state: "READY", revision: 1, enabled: true });
h.runtime.startProactiveScheduler({
  sessionId: "default",
  readMemory: false,
  personaId: "alice",
  subjectUserId: "person-a"
});
await h.runtime.handleUserMessage(
  {
    sessionId: "work",
    content: "继续讨论 WORK_CURRENT_MARKER 编译器。",
    personaId: "alice",
    subjectUserId: "person-a"
  } as any,
  { readMemory: false, writeMemory: false }
);
const ordinaryRequests = JSON.stringify(h.calls);
assert.ok(ordinaryRequests.includes("WORK_CONTEXT_MARKER"));
h.advance(24 * 3600000);
// Await the real scheduled executor directly to avoid an unawaitable timer race; same generation/gates as its registered wake.
await (h.runtime as any).runScheduledProactiveAttempt((h.runtime as any).schedulerGeneration);
assert.equal(h.decisions.length, 1);
const proactivePrompt = JSON.stringify(h.decisions[0]);
assert.ok(proactivePrompt.includes("DEFAULT_CONTEXT_MARKER"));
assert.ok(!proactivePrompt.includes("WORK_CONTEXT_MARKER"));
const proactiveProbe = {
  productionBootSession: "default",
  activeUserSession: "work",
  decisionCalls: h.decisions.length,
  decisionUsesDefaultHistory: true,
  decisionUsesActiveWorkHistory: false,
  ordinaryTurnUsesFaithfulWorkHistory: true,
  decisionRequest: h.decisions[0]
};

const memoryFact = "BACKEND_MEMORY_MARKER The project codename is Cedar Finch.";
const memoryReads: any[] = [];
const mem0: any = {
  kind: "mem0",
  async search(q: any) {
    memoryReads.push(q);
    return [{ id: "fact-a", scope: q.scope, content: memoryFact, score: 0.99, metadata: {} }];
  },
  async list() {
    return { items: [], total: 0 };
  }
};
const m = harness({
  memory: new MemoryService(
    new InMemoryMemoryRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    { kind: "mem0", mem0 }
  )
});
await m.runtime.handleUserMessage(
  {
    sessionId: "memory",
    subjectUserId: "person-a",
    personaId: "alice",
    content: "What is our project codename?"
  } as any,
  { readMemory: true, writeMemory: false }
);
assert.ok(memoryReads.length > 0);
assert.ok(JSON.stringify(m.calls).includes(memoryFact));
const memoryProbe = {
  backend: "Injected Mem0 search response, not a live sidecar",
  queries: memoryReads,
  memoryFactReachedProductionCharacter: true,
  calls: m.calls
};

const reasoningCalls: any[] = [],
  effectCalls: any[] = [];
const observed = "CAPABILITY_OBSERVATION_MARKER Build checksum is 92f4.";
const reasoning = {
  name: "offline-reasoning-recorder",
  async generateReasoning(input: any) {
    reasoningCalls.push(input);
    return {
      answer:
        reasoningCalls.length === 1
          ? "REQUEST_CAPABILITY\n" +
            JSON.stringify({
              capabilityRef: SERVER_MCP_READ_TEXT_CAPABILITY_REF,
              request: "Read admitted evidence."
            })
          : "COMPLETE\nThe observed checksum is 92f4.",
      reasoning: "",
      finishReason: "stop",
      model: "offline-recorder"
    };
  }
};
const cognition = await executeProductionCognition({
  providers: { getReasoningProvider: () => reasoning } as any,
  request: { version: "character-harness-5g.v1", kind: "NEED_COGNITION", focus: "verify" },
  problem: "Verify build checksum.",
  runtimeAuthorizedPath: "/authorized/probe.txt",
  effectContext: {
    scope: "probe",
    cause: { kind: "JOURNAL_EVENT", namespace: "probe-journal", eventId: "jev1_aaaaaaaaaaaaaaaa" }
  },
  readTextEffects: {
    async execute(input: any) {
      effectCalls.push(input);
      return { isError: false, content: [{ type: "text", text: observed }] };
    }
  } as any,
  execution: { executionId: "backend-value-probe", isCurrent: () => true },
  limits: { maxReasoningRounds: 3, maxCapabilityCalls: 1, timeBudgetMs: 60000 }
});
assert.equal(reasoningCalls.length, 2);
assert.equal(effectCalls.length, 1);
assert.ok(!JSON.stringify(reasoningCalls[0]).includes(observed));
assert.ok(JSON.stringify(reasoningCalls[1]).includes(observed));
const toolProbe = {
  hostEffectAdapter:
    "Injected authorized response; no actual filesystem read or durable effect-store assertion",
  reasoningCalls: reasoningCalls.length,
  capabilityCalls: effectCalls.length,
  observationAbsentBeforeRead: true,
  observationConsumedByNextReasoning: true,
  inputs: reasoningCalls,
  result: cognition
};

for (const harness of [a, v, h, m]) {
  harness.runtime.stopProactiveScheduler();
  await harness.runtime.sealAndDrainMemoryWrites();
}
console.log(
  "AUDIT_RESULT=" +
    JSON.stringify({
      affect: affectProbe,
      relationship: p8Probe,
      dream: dreamProbe,
      voice: voiceProbe,
      proactive: proactiveProbe,
      memory: memoryProbe,
      capability: toolProbe,
      scope: {
        noActualModelQualityEvaluation: true,
        noQQSourcesImported: true,
        positiveControl:
          "Ordinary non-default session history is recovered and consumed by production Character."
      }
    })
);
