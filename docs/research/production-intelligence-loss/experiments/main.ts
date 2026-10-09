import assert from "node:assert/strict";
import { executeProductionCognition } from "#repo/apps/server/src/cognition-production.ts";
import { createServerCharacterPort } from "#repo/apps/server/src/character-runtime.ts";
import { RuntimeOrchestrator } from "@companion/core";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  MemoryService,
  InMemoryMemoryRepository,
  InMemoryConversationRepository
} from "@companion/memory";
import {
  detectExplicitRememberRequest,
  detectExplicitForgetRequest
} from "#repo/packages/memory/src/intent.ts";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createMockReasoningProvider,
  createMockVisionProvider,
  createMockSTTProvider
} from "@companion/providers";
const output = (text: string, finishReason = "stop") => ({
  message: { role: "assistant", content: text },
  finishReason,
  model: "offline-fixture"
});
const reasoningInputs: any[] = [];
const reasoning = {
  name: "offline-reasoning",
  async generateReasoning(input: any) {
    reasoningInputs.push(input);
    return {
      answer: reasoningInputs.length < 3 ? "CONTINUE" : "COMPLETE\nThe answer is 42.",
      reasoning: "",
      model: "offline-fixture"
    };
  }
};
const cognition = await executeProductionCognition({
  providers: { getReasoningProvider: () => reasoning } as any,
  request: { version: "character-harness-5g.v1", kind: "NEED_COGNITION", focus: "solve" },
  problem: "Find 6 times 7",
  execution: { executionId: "audit", isCurrent: () => true },
  limits: { maxReasoningRounds: 4, maxCapabilityCalls: 2, timeBudgetMs: 60000 }
});
assert.equal(reasoningInputs.length, 3);
assert.deepEqual(reasoningInputs[0], reasoningInputs[1]);
assert.deepEqual(reasoningInputs[1], reasoningInputs[2]);

async function runTurn({
  text = "Give a useful answer",
  finish = "stop",
  disposition = "RESPOND",
  mem0 = false,
  backendFails = false,
  attachment = false
}: {
  text?: string;
  finish?: string;
  disposition?: string;
  mem0?: boolean;
  backendFails?: boolean;
  attachment?: boolean;
}) {
  const deleted: string[] = [];
  const calls: any[] = [];
  const writes: any[] = [];
  const backend = {
    kind: "mem0",
    async search(q: any) {
      if (backendFails) throw new Error("fixture backend unavailable");
      return [
        {
          id: "existing-fact",
          scope: q.scope,
          content: "My project codename is Blue Heron.",
          score: 0.99,
          metadata: {}
        }
      ];
    },
    async list() {
      return { items: [], total: 0 };
    },
    async delete({ memoryId }: any) {
      deleted.push(memoryId);
    },
    async add(x: any) {
      writes.push(x);
      return [];
    }
  };
  const memory = new MemoryService(
    new InMemoryMemoryRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    mem0 ? { kind: "mem0", mem0: backend as any } : undefined
  );
  const body = "A useful partial answer with a verified calculation: 6 × 7 = 42.";
  const chat = {
    name: "offline-chat",
    streamingMode: "native",
    async generateReply(i: any) {
      calls.push({ kind: "gate", input: i });
      return output(JSON.stringify({ disposition }));
    },
    async *streamReply(i: any) {
      calls.push({ kind: "body", input: i });
      yield { type: "text-delta", text: body };
      yield { type: "completed", output: output(body, finish) };
    }
  };
  const providers = {
    getChatProvider: () => chat,
    getReasoningProvider: () => createMockReasoningProvider(),
    getVisionProvider: () => createMockVisionProvider(),
    getSTTProvider: () => createMockSTTProvider(),
    getEmbeddingProvider: () => undefined,
    getTTSProvider: () => undefined
  };
  const conversation = new InMemoryConversationRepository();
  const runtime = new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory,
    conversation,
    promptBuilder: new PromptBuilder(),
    providers: providers as any,
    character: createServerCharacterPort()
  });
  let reply: any, error: any;
  try {
    reply = await runtime.handleUserMessage(
      {
        sessionId: "audit",
        subjectUserId: "user",
        personaId: "alice",
        content: text,
        ...(attachment
          ? { attachment: { kind: "image", mimeType: "image/png", base64: "aGVsbG8=" } }
          : {})
      } as any,
      { readMemory: false, writeMemory: mem0 }
    );
  } catch (e) {
    error = { name: (e as Error).name, message: (e as Error).message };
  }
  const rows = await conversation.listRecentMessages("audit", { limit: 20 });
  return {
    replyContent: reply?.payload?.content ?? null,
    error: error ?? null,
    deleted,
    writes: writes.length,
    calls: calls.map((c) => ({ kind: c.kind, maxTokens: c.input.maxTokens })),
    gateText: calls
      .filter((c) => c.kind === "gate")
      .map((c) => JSON.stringify(c.input))
      .join("\n"),
    rows
  };
}
const sentence = "Don't forget that my project codename is Blue Heron.";
assert.equal(detectExplicitRememberRequest(sentence), true);
assert.equal(detectExplicitForgetRequest(sentence), true);
const forgotten = await runTurn({ text: sentence, mem0: true, disposition: "SILENCE" });
assert.deepEqual(forgotten.deleted, ["existing-fact"]);
const backendFailure = await runTurn({
  text: "Forget my project codename Blue Heron",
  mem0: true,
  backendFails: true,
  disposition: "SILENCE"
});
const stopped = await runTurn({ finish: "stop" });
const length = await runTurn({ finish: "length" });
assert.ok(stopped.replyContent);
assert.ok(length.error);
assert.equal(length.replyContent, null);
const forgetService = new MemoryService(
  new InMemoryMemoryRepository(),
  undefined,
  undefined,
  undefined,
  undefined,
  {
    kind: "mem0",
    mem0: {
      kind: "mem0",
      async search() {
        throw Error("offline");
      }
    } as any
  }
);
const masked = await forgetService.forgetExplicitMemory({
  userMessage: "Forget Blue Heron",
  subjectUserId: "user",
  personaId: "alice"
});
assert.equal(masked.notFound, true);
assert.equal(masked.deleted, 0);
console.log(
  "AUDIT_RESULT=" +
    JSON.stringify({
      cognition: {
        calls: reasoningInputs.length,
        identicalInputs: true,
        capabilityInventoryEmpty: !JSON.stringify(reasoningInputs[0]).includes("read_text_file"),
        outcome: cognition
      },
      negatedForget: {
        sentence,
        remember: true,
        forget: true,
        deletedBeforeGate: forgotten.deleted,
        gateCalls: forgotten.calls.length
      },
      forgetFailure: {
        serviceResult: masked,
        runtimePromptClaimsNotFound: /no matching memory|no matching long.term memory/i.test(
          backendFailure.gateText
        )
      },
      outputFinish: {
        stop: {
          reply: stopped.replyContent,
          error: stopped.error,
          calls: stopped.calls,
          history: stopped.rows.map((r) => ({ role: r.role, status: r.status }))
        },
        length: {
          reply: length.replyContent,
          error: length.error,
          calls: length.calls,
          history: length.rows.map((r) => ({ role: r.role, status: r.status }))
        }
      }
    })
);
