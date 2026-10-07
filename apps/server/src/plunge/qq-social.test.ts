import { describe, expect, it, vi } from "vitest";
import type { SurfaceInput, SurfaceResult } from "../character-surface-host.js";
import { QQSocialAdapter } from "./qq-social.js";
import { decodeQQPacket } from "./qq-codec.js";
import { wire } from "./qq-fixture.js";
const connection = {
  generation: "g1",
  signal: new AbortController().signal,
  isCurrent: () => true,
  write: async () => {}
};
const packet = (extra: Record<string, unknown> = {}) => decodeQQPacket(wire(extra), "42", "ns")!;
function fixture() {
  let now = Date.now(),
    outcome: SurfaceResult["outcome"] = "SILENCE";
  const inputs: SurfaceInput[] = [];
  const receive = vi.fn(async (input: SurfaceInput) => {
    inputs.push(input);
    return {
      sourceJournalRef: {
        kind: "JOURNAL_EVENT" as const,
        namespace: "test",
        eventId: "jev1_" + String(inputs.length).padStart(16, "0")
      },
      speaker: { principalId: "principal:" + input.actorId },
      outcome: input.admission ? outcome : ("OBSERVED" as const)
    };
  });
  const social = new QQSocialAdapter({ receive }, () => now);
  return {
    social,
    inputs,
    receive,
    advance: (ms: number) => {
      now += ms;
    },
    set: (value: SurfaceResult["outcome"]) => {
      outcome = value;
    }
  };
}
describe("bounded QQ social admission", () => {
  it("ambient group receipts never become user turns; @Alice may still be SILENCE", async () => {
    const f = fixture();
    await f.social.receive(packet(), connection);
    expect(f.inputs[0]!.admission).toBeUndefined();
    const r = await f.social.receive(
      packet({
        message_id: 2,
        message: [
          { type: "at", data: { qq: 42 } },
          { type: "text", data: { text: "listen" } }
        ]
      }),
      connection
    );
    expect(f.inputs[1]).toMatchObject({
      admission: "MENTION",
      observations: [{ text: "hello", speaker: { principalId: "principal:7" } }]
    });
    expect(r.outcome).toBe("SILENCE");
  });
  it("admits private and recently observed replies to Alice, but unresolved/conflicting quotes stay ambient", async () => {
    const f = fixture();
    const first = packet();
    await f.social.receive(first, connection);
    f.social.published(first, "123", "Alice output");
    await f.social.receive(
      packet({
        message_id: 8,
        message: [
          { type: "reply", data: { id: 123 } },
          { type: "text", data: { text: "follow up" } }
        ]
      }),
      connection
    );
    expect(f.inputs.at(-1)).toMatchObject({
      admission: "REPLY",
      reply: { state: "OBSERVED", author: { principalId: "ns:42" }, text: "Alice output" }
    });
    await f.social.receive(
      packet({
        message_id: 9,
        message: [
          { type: "reply", data: { id: 111 } },
          { type: "text", data: { text: "other" } }
        ]
      }),
      connection
    );
    expect(f.inputs.at(-1)?.admission).toBeUndefined();
    expect(f.inputs.at(-1)?.reply?.state).toBe("UNRESOLVED");
    await f.social.receive(packet({ message_type: "private", sub_type: "friend" }), connection);
    expect(f.inputs.at(-1)?.admission).toBe("PRIVATE");
    f.social.published(first, "123", "conflicting output");
    await f.social.receive(
      packet({
        message_id: 10,
        message: [
          { type: "reply", data: { id: 123 } },
          { type: "text", data: { text: "which quote" } }
        ]
      }),
      connection
    );
    expect(f.inputs.at(-1)?.reply?.state).toBe("CONFLICTING");
    expect(f.inputs.at(-1)?.admission).toBeUndefined();
  });
  it("bounds direct continuation to the same speaker after ACK, without an intervening speaker or reconnect", async () => {
    const f = fixture();
    f.set("RESPOND");
    await f.social.receive(
      packet({
        message: [
          { type: "at", data: { qq: 42 } },
          { type: "text", data: { text: "hi" } }
        ]
      }),
      connection
    );
    await f.social.receive(packet({ message_id: 2 }), connection);
    expect(f.inputs.at(-1)?.admission).toBe("CONTINUATION");
    await f.social.receive(
      packet({ message_id: 3, user_id: 8, sender: { user_id: 8 } }),
      connection
    );
    await f.social.receive(packet({ message_id: 4 }), connection);
    expect(f.inputs.at(-1)?.admission).toBeUndefined();
    f.social.resetGeneration();
    await f.social.receive(packet({ message_id: 5 }), connection);
    expect(f.inputs.at(-1)?.observations).toHaveLength(0);
  });
  it("self echo and exact complete duplicates are observations, while same-ID conflicts remain distinct", async () => {
    const f = fixture();
    const p = packet({ message_type: "private" });
    await f.social.receive(p, connection);
    await f.social.receive(p, connection);
    expect(f.inputs.at(-1)?.admission).toBeUndefined();
    await f.social.receive(
      packet({ message_type: "private", message: [{ type: "text", data: { text: "different" } }] }),
      connection
    );
    expect(f.inputs.at(-1)?.admission).toBe("PRIVATE");
    await f.social.receive(
      packet({ post_type: "message_sent", user_id: 42, sender: { user_id: 42 } }),
      connection
    );
    expect(f.inputs.at(-1)?.admission).toBeUndefined();
  });
  it("keeps at most twelve recent observations and expires channel state", async () => {
    const f = fixture();
    for (let i = 0; i < 20; i++)
      await f.social.receive(packet({ message_id: i + 1, message_seq: i + 1 }), connection);
    expect(f.inputs.at(-1)?.observations).toHaveLength(12);
    f.advance(121_000);
    await f.social.receive(packet({ message_id: 99 }), connection);
    expect(f.inputs.at(-1)?.observations).toHaveLength(0);
  });
});
