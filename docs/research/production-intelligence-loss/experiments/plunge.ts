import assert from "node:assert/strict";
import { renderCharacterModelContext } from "#repo/apps/server/src/character-model-context.ts";
import { renderSurfaceSituation } from "@companion/core";
import { decodeQQPacket } from "#repo/apps/server/src/plunge/qq-codec.ts";
import { QQSocialAdapter } from "#repo/apps/server/src/plunge/qq-social.ts";
import { createServerCharacterPort } from "#repo/apps/server/src/character-runtime.ts";
import { PromptBuilder } from "@companion/prompt-builder";
const marker = "HISTORY_ONLY_verified_result_7c924";
const context = {
  sections: [
    { kind: "RECENT_CONVERSATION", state: "KNOWN", summary: `assistant: ${marker}` },
    { kind: "CURRENT_SITUATION", state: "KNOWN", summary: "Private conversation" }
  ]
} as any;
const ordinary = renderCharacterModelContext(context, false),
  surface = renderCharacterModelContext(context, true);
assert.ok(ordinary.background.includes(marker));
assert.ok(!JSON.stringify(surface).includes(marker));
const speaker = { principalId: "123", displayName: "User" };
const scene = {
  surface: "qq",
  conversationKind: "PRIVATE",
  speaker,
  mentions: [],
  observations: [
    {
      speaker,
      observedAt: "2026-10-09T00:00:00.000Z",
      direction: "INBOUND",
      text: "x".repeat(600) + marker
    }
  ]
} as any;
assert.ok(!renderSurfaceSituation(scene).includes(marker));
const packet = (message: any[]) => ({
  post_type: "message",
  self_id: "999",
  user_id: "123",
  message_type: "private",
  sender: { user_id: "123" },
  message_id: 1,
  message
});
const images = decodeQQPacket(
  packet([
    { type: "text", data: { text: "Compare these two images" } },
    { type: "image", data: { file: "first.png" } },
    { type: "image", data: { file: "second.png" } }
  ]),
  "999",
  "audit"
);
const long = decodeQQPacket(
  packet([{ type: "text", data: { text: "x".repeat(4097) } }]),
  "999",
  "audit"
);
assert.equal(images?.imageFile, "first.png");
assert.ok(images?.content.includes("contents unavailable"));
assert.equal(long, undefined);
let now = 0;
const received: any[] = [];
const social = new QQSocialAdapter(
  {
    async receive(i: any) {
      received.push(i);
      return {
        outcome: "SILENCE",
        speaker,
        sourceJournalRef: {
          kind: "JOURNAL_EVENT",
          namespace: "audit",
          eventId: "jev1_0000000000000001"
        }
      };
    }
  } as any,
  () => now
);
const connection = {
  generation: "audit",
  signal: new AbortController().signal,
  isCurrent: () => true,
  write: async () => {}
};
const privatePacket = decodeQQPacket(
  packet([{ type: "text", data: { text: marker } }]),
  "999",
  "audit"
)!;
await social.receive(privatePacket, connection);
now = 1000;
await social.receive(
  { ...privatePacket, duplicateKey: undefined, messageId: "2", content: "repeat the result" },
  connection
);
assert.equal(received[1].observations.length, 1);
now = 122001;
await social.receive(
  { ...privatePacket, duplicateKey: undefined, messageId: "3", content: "repeat the result" },
  connection
);
assert.equal(received[2].observations.length, 0);
const calls: any[] = [];
const prompt = new PromptBuilder().buildPrompt({
  systemIdentity: "Alice",
  userMessage: "Please calculate 6 times 7."
});
const result = await createServerCharacterPort().generate({
  prompt,
  userMessage: "Please calculate 6 times 7.",
  interactionBoundary: { surface: "qq", conversationKind: "PRIVATE" },
  async generateChat(input: any) {
    calls.push(input);
    return {
      message: { role: "assistant", content: "invalid classifier JSON" },
      finishReason: "stop",
      model: "offline-fixture"
    };
  }
} as any);
assert.equal(calls.length, 2);
assert.equal(result.decision.reply.disposition, "SILENCE");
console.log(
  "AUDIT_RESULT=" +
    JSON.stringify({
      history: {
        marker,
        ordinaryRetains: true,
        surfaceRetains: false,
        olderSceneExcerptRetains: false,
        olderExcerptCharacters: 512,
        observationsWithin1Second: received[1].observations.length,
        observationsAfter121Seconds: received[2].observations.length
      },
      qqMedia: {
        firstImage: images?.imageFile,
        content: images?.content,
        long4097Accepted: !!long
      },
      authorizationFailure: {
        calls: calls.length,
        disposition: result.decision.reply.disposition,
        throws: false
      },
      inputComparators: {
        note: "Projection-only comparison; not complete model requests or quality evaluation",
        A: `Alice\nuser: previous question\nassistant: ${marker}\nuser: repeat the result`,
        B: surface,
        C: ordinary
      }
    })
);
