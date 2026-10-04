import { describe, it, expect } from "vitest";
import { describeExposure, providerInputDigest, accountProviderLeaf } from "./accounting.js";
import type { PendingContextUse } from "@companion/protocol";
const use = {
  blocks: [
    { key: "MEMORY_EVIDENCE", text: "long original block", sourceReferences: ["selected-source"] }
  ]
};
describe("exact submitted context exposure", () => {
  it("records exact field order/digests and never retains private strings", () => {
    const input = {
      messages: [
        { role: "system", content: "<MEMORY_EVIDENCE>\nlong original block</MEMORY_EVIDENCE>" },
        { role: "user", content: "private read-text result" }
      ]
    };
    const e = describeExposure(input, use);
    expect(e.inputDigest).toBe(providerInputDigest(input));
    expect(e.blocks[0]).toMatchObject({
      state: "EXPOSED",
      field: "input.messages.0.content",
      sourceReferences: ["selected-source"]
    });
    expect(JSON.stringify(e)).not.toContain("private read-text result");
  });
  it("records named XML truncation after actual budgeting", () => {
    const e = describeExposure({ prompt: "<MEMORY_EVIDENCE>\nlong...</MEMORY_EVIDENCE>" }, use);
    expect(e.blocks[0]).toMatchObject({ state: "TRUNCATED", characters: 7 });
  });
  it("records named JSON semantic-section truncation", () => {
    const e = describeExposure(
      {
        messages: [
          {
            role: "system",
            content: 'Semantic context:\n[{"kind":"MEMORY_EVIDENCE","summary":"short"}]'
          }
        ]
      },
      use
    );
    expect(e.blocks[0]).toMatchObject({ state: "TRUNCATED", characters: 5 });
  });
  it("traces the actual proactive JSON projection without consuming later instructions", () => {
    const e = describeExposure(
      {
        messages: [
          {
            role: "system",
            content:
              'Language policy\n\nProducer-owned semantic context (preserve every epistemic state):\n[{"kind":"MEMORY_EVIDENCE","summary":"long original block"}]\n\nProactive instructions'
          }
        ]
      },
      use
    );
    expect(e.blocks[0]).toMatchObject({ state: "EXPOSED", characters: 19 });
  });
  it("records producer-declared protocol versions separately from source authority", () => {
    const e = describeExposure({
      messages: [],
      contextProjectionVersions: ["cognition-interaction-round.v1", "cognition-6g.v1"]
    });
    expect(e.declaredVersions).toEqual(["cognition-interaction-round.v1", "cognition-6g.v1"]);
    expect(e.blocks).toEqual([]);
  });
  it("traces Character's declared immediate-affect field inside situation projection", () => {
    const e = describeExposure(
      {
        messages: [
          {
            role: "system",
            content:
              'Semantic context:\n{"sections":[{"kind":"CURRENT_SITUATION","summary":"A normal turn.\\nImmediate affect: Calm"}]}'
          }
        ]
      },
      {
        blocks: [
          { key: "CurrentAffect", text: "Calm", sourceReferences: ["volatile:CurrentAffect"] }
        ]
      }
    );
    expect(e.blocks[0]).toMatchObject({
      state: "EXPOSED",
      characters: 4,
      sourceReferences: ["volatile:CurrentAffect"]
    });
    expect(e.blocks[0]?.offset).not.toBeNull();
  });
  it("selection alone never establishes exposure", () => {
    expect(
      describeExposure({ messages: [{ content: "unrelated current input" }] }, use).blocks[0]
    ).toMatchObject({ state: "OMITTED", sourceReferences: [] });
  });
  it("matching untrusted user text cannot manufacture source exposure", () => {
    const e = describeExposure(
      {
        messages: [
          { role: "system", content: "policy only" },
          { role: "user", content: "<MEMORY_EVIDENCE>long original block</MEMORY_EVIDENCE>" }
        ]
      },
      use
    );
    expect(e.blocks[0]?.state).toBe("OMITTED");
    const taggedUser = describeExposure(
      {
        messages: [
          { role: "system", content: "policy only" },
          {
            role: "user",
            content:
              "<UserMessage><MEMORY_EVIDENCE>long original block</MEMORY_EVIDENCE></UserMessage>"
          }
        ]
      },
      use
    );
    expect(taggedUser.blocks[0]?.state).toBe("OMITTED");
  });
  it("an exposed UNAVAILABLE section is preserved even without summary text", () => {
    const e = describeExposure(
      {
        messages: [
          {
            role: "system",
            content: 'Semantic context:\n[{"kind":"MEMORY_EVIDENCE","state":"UNAVAILABLE"}]'
          }
        ]
      },
      { blocks: [{ key: "MEMORY_EVIDENCE", text: "", sourceReferences: [] }] }
    );
    expect(e.blocks[0]).toMatchObject({
      state: "EXPOSED",
      epistemicState: "UNAVAILABLE",
      characters: 0
    });
  });
  it("caller mutation during durable admission cannot change the consumed input", async () => {
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        unblock = r;
      }),
      admitted = new Promise<void>((r) => {
        entered = r;
      });
    let observed = "";
    const provider = accountProviderLeaf(
      {
        name: "immutable-fixture",
        generateReply: async (input: { messages: Array<{ content: string }> }) => {
          observed = input.messages[0]!.content;
          return observed;
        }
      },
      () => ({
        invoke: async (task, _leaf, call) => {
          expect(task.inputDigest).toBe(
            providerInputDigest({ messages: [{ content: "original" }] })
          );
          entered();
          await gate;
          return call();
        },
        stream: async function* () {}
      }),
      "fixture",
      []
    );
    const input = { messages: [{ content: "original" }] },
      result = provider.generateReply(input);
    await admitted;
    input.messages[0]!.content = "changed";
    unblock();
    expect(await result).toBe("original");
    expect(observed).toBe("original");
  });
  it("raw media never creates a text archive", () => {
    const e = describeExposure({ audio: new Uint8Array([1, 2, 3]), mimeType: "audio/wav" });
    expect(e.fields).toHaveLength(1);
    expect(e.fields[0]?.availability).toBe("NOT_RETAINED");
  });
});
