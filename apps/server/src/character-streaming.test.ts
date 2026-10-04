import { describe, expect, it, vi } from "vitest";
import { RuntimeOrchestrator, type RuntimeCharacterCognitionExecutor } from "@companion/core";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  InMemoryConversationRepository,
  InMemoryMemoryRepository,
  MemoryService
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createProviderRegistryFromEnv,
  type ChatInput,
  type ChatOutput,
  type ChatStreamEvent,
  type ProviderCallOptions
} from "@companion/providers";
import { createServerCharacterPort } from "./character-runtime.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const output = (content: string): ChatOutput => ({
  message: { role: "assistant", content },
  finishReason: "stop"
});
function setup(
  stream: (input: ChatInput, options?: ProviderCallOptions) => AsyncIterable<ChatStreamEvent>,
  gates = ['{"disposition":"RESPOND"}'],
  cognition?: RuntimeCharacterCognitionExecutor
) {
  const providers = createProviderRegistryFromEnv({
    PROVIDER_ALLOW_MOCKS: "true",
    CHAT_PROVIDER_CHAIN: "mock"
  });
  const streamReply = vi.fn(stream);
  const generateReply = vi.fn(async () => output(gates.shift()!));
  vi.spyOn(providers, "getChatProvider").mockReturnValue({
    name: "controlled-provider",
    streamingMode: "native",
    generateReply,
    streamReply,
    healthCheck: async () => ({ provider: "controlled-provider", status: "healthy", checkedAt: "" })
  });
  const conversation = new InMemoryConversationRepository();
  const runtime = new RuntimeOrchestrator({
    providers,
    character: createServerCharacterPort(),
    characterCognition: cognition,
    memory: new MemoryService(new InMemoryMemoryRepository()),
    conversation,
    eventBus: new InMemoryEventBus({ development: false }),
    promptBuilder: new PromptBuilder()
  });
  const turn = (signal?: AbortSignal) =>
    runtime
      .streamUserMessage(
        { sessionId: "stream", content: "今天怎么样？" },
        { readMemory: false, writeMemory: false, voiceOutput: false, signal }
      )
      [Symbol.asyncIterator]();
  return { runtime, turn, streamReply, generateReply, conversation };
}

it("forwards each real Character provider delta before allowing provider completion", async () => {
  const second = latch(),
    third = latch(),
    finish = latch();
  let providerCompleted = false;
  const { turn, streamReply, generateReply } = setup(async function* () {
    yield { type: "text-delta", text: "今天" };
    await second.promise;
    yield { type: "text-delta", text: "天气" };
    await third.promise;
    yield { type: "text-delta", text: "不错。" };
    await finish.promise;
    providerCompleted = true;
    yield { type: "completed", output: output("今天天气不错。") };
  });
  const iterator = turn();
  try {
    expect((await iterator.next()).value).toMatchObject({ type: "text-delta", text: "今天" });
    expect(providerCompleted).toBe(false);
    second.release();
    expect((await iterator.next()).value).toMatchObject({ type: "text-delta", text: "天气" });
    expect(providerCompleted).toBe(false);
    third.release();
    expect((await iterator.next()).value).toMatchObject({ type: "text-delta", text: "不错。" });
    expect(providerCompleted).toBe(false);
    finish.release();
    expect((await iterator.next()).value).toMatchObject({
      type: "completed",
      content: "今天天气不错。"
    });
    expect(providerCompleted).toBe(true);
    expect((await iterator.next()).done).toBe(true);
    expect(generateReply).toHaveBeenCalledTimes(1);
    expect(streamReply).toHaveBeenCalledTimes(1);
  } finally {
    second.release();
    third.release();
    finish.release();
    await iterator.return?.();
  }
});

it("does not split a single provider delta", async () => {
  const { turn } = setup(async function* () {
    yield { type: "text-delta", text: "今天天气不错。" };
    yield { type: "completed", output: output("今天天气不错。") };
  });
  const iterator = turn();
  expect((await iterator.next()).value).toMatchObject({
    type: "text-delta",
    text: "今天天气不错。"
  });
  expect((await iterator.next()).value).toMatchObject({ type: "completed" });
  expect((await iterator.next()).done).toBe(true);
});

it.each(["SILENCE", "TERMINATE"])(
  "preserves %s without invoking the response provider",
  async (disposition) => {
    const { turn, streamReply, conversation } = setup(
      async function* () {
        throw new Error("must not stream");
      },
      [JSON.stringify({ disposition })]
    );
    const iterator = turn();
    expect((await iterator.next()).value).toMatchObject({ type: "completed", content: "" });
    expect((await iterator.next()).done).toBe(true);
    expect(streamReply).not.toHaveBeenCalled();
    expect(
      (await conversation.listRecentMessages("stream", { limit: 10 })).filter(
        (row) => row.role === "assistant"
      )
    ).toEqual([]);
  }
);

it("waits for the existing cognition executor and streams only after Character re-entry RESPOND", async () => {
  const entered = latch(),
    release = latch();
  const cognition = vi.fn(async () => {
    entered.release();
    await release.promise;
    return {
      version: "character-harness-5h.v1",
      request: { version: "character-harness-5g.v1", kind: "NEED_COGNITION", focus: "verify" },
      result: {
        version: "character-cognition-result.v1",
        status: "SUCCESS",
        answer: "Verified evidence.",
        caveats: ["Bounded result."]
      }
    };
  });
  const { turn, streamReply, generateReply } = setup(
    async function* (input) {
      const system = input.messages[0]!.content;
      expect(system).toContain("COGNITION_RESULT");
      expect(system).toContain("Verified evidence.");
      expect(system).toContain("Bounded result.");
      expect(system).toContain("fulfill that request in this response");
      yield { type: "text-delta", text: "Verified." };
      yield { type: "completed", output: output("Verified.") };
    },
    ['{"disposition":"NEED_COGNITION","focus":"verify"}', '{"disposition":"RESPOND"}'],
    cognition
  );
  const iterator = turn();
  const first = iterator.next();
  await entered.promise;
  expect(streamReply).not.toHaveBeenCalled();
  release.release();
  expect((await first).value).toMatchObject({ type: "text-delta", text: "Verified." });
  expect((await iterator.next()).value).toMatchObject({ type: "completed" });
  await iterator.next();
  expect(cognition).toHaveBeenCalledTimes(1);
  expect(generateReply).toHaveBeenCalledTimes(2);
});

it("aborts a waiting provider, drops a late delta, and closes the cancelled lifecycle", async () => {
  const waiting = latch(),
    aborted = latch();
  let closed = false;
  const controller = new AbortController();
  const { turn, runtime, conversation } = setup(async function* (_input, options) {
    try {
      yield { type: "text-delta", text: "今天" };
      options!.signal!.addEventListener("abort", aborted.release, { once: true });
      waiting.release();
      await aborted.promise;
      // A provider racing cancellation must not leak this delta to Runtime/SSE.
      yield { type: "text-delta", text: "too late" };
    } finally {
      closed = true;
    }
  });
  const iterator = turn(controller.signal);
  expect((await iterator.next()).value).toMatchObject({ type: "text-delta", text: "今天" });
  const pending = iterator.next();
  const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  await waiting.promise;
  controller.abort();
  await aborted.promise;
  await rejected;
  expect(closed).toBe(true);
  expect((await iterator.next()).done).toBe(true);
  expect(
    (await conversation.listRecentMessages("stream", { limit: 10 })).filter(
      (row) => row.role === "assistant"
    )
  ).toMatchObject([{ content: "今天", status: "cancelled" }]);
  await runtime.sealAndDrainMemoryWrites();
});

it("aborts the provider when the stream consumer closes early", async () => {
  let signal: AbortSignal | undefined;
  let closed = false;
  const { turn } = setup(async function* (_input, options) {
    signal = options?.signal;
    try {
      yield { type: "text-delta", text: "first" };
    } finally {
      closed = true;
    }
  });
  const iterator = turn();
  await iterator.next();
  await iterator.return?.();
  expect(signal?.aborted).toBe(true);
  expect(closed).toBe(true);
});

it.each(["You choose.", "ok", "start"])(
  "fulfills a pending article on %s through the actual streamed body request",
  async (continuation) => {
    const article =
      "Harbor life begins before dawn. Boats cross the bay. Vendors open their stalls. Families gather by the pier. Evening lights shine on the water.";
    const { runtime, streamReply } = setup(
      async function* (input) {
        const system = input.messages[0]!.content;
        const fulfilled =
          system.includes("fulfill that request in this response") &&
          system.includes("Write an article about harbor life");
        const text = fulfilled ? article : "I'll start writing now.";
        yield { type: "text-delta", text };
        yield { type: "completed", output: output(text) };
      },
      ['{"disposition":"SILENCE"}', '{"disposition":"RESPOND"}']
    );
    for await (const event of runtime.streamUserMessage(
      { sessionId: "article", content: "Write an article about harbor life." },
      { readMemory: false, writeMemory: false }
    ))
      void event;
    const events = [];
    for await (const event of runtime.streamUserMessage(
      { sessionId: "article", content: continuation },
      { readMemory: false, writeMemory: false }
    ))
      events.push(event);
    expect(streamReply).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({ type: "text-delta", text: article });
    expect(events.at(-1)).toMatchObject({ type: "completed", content: article });
  }
);

it.each([
  [{ type: "text-delta", text: "ok" }],
  [
    { type: "text-delta", text: "ok" },
    { type: "completed", output: output("different") }
  ],
  [
    { type: "text-delta", text: "ok" },
    { type: "completed", output: output("ok") },
    { type: "text-delta", text: "late" }
  ]
] satisfies ChatStreamEvent[][])(
  "fails malformed provider streams while retaining only the durable prefix: %j",
  async (...events) => {
    const { turn, conversation } = setup(async function* () {
      yield* events;
    });
    const iterator = turn();
    expect((await iterator.next()).value).toMatchObject({ type: "text-delta", text: "ok" });
    await expect(iterator.next()).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    expect(
      (await conversation.listRecentMessages("stream", { limit: 10 })).filter(
        (row) => row.role === "assistant"
      )
    ).toMatchObject([{ content: "ok", status: "failed" }]);
  }
);

it.each([
  '{"disposition":"RESPOND","text":"completed text must not be accepted as a gate"}',
  '{"disposition":"RESPOND","presentation":{"intent":"soft-smile","device":"forbidden"}}'
])("rejects a full reply or invalid presentation in the semantic gate", async (gate) => {
  const { turn, streamReply } = setup(
    async function* () {
      throw new Error("must not stream");
    },
    [gate]
  );
  await expect(turn().next()).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  expect(streamReply).not.toHaveBeenCalled();
});
