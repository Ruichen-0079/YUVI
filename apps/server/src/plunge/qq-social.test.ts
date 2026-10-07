import { describe, expect, it, vi } from "vitest";
import type { SurfaceInput, SurfaceResult } from "../character-surface-host.js";
import { QQSocialAdapter } from "./qq-social.js";
import { decodeQQPacket } from "./qq-codec.js";
import { wire } from "./qq-fixture.js";
import type { QQAttentionPort, QQAttentionTrace } from "./qq-attention.js";
const connection = {
  generation: "g1",
  signal: new AbortController().signal,
  isCurrent: () => true,
  write: async () => {}
};
const packet = (extra: Record<string, unknown> = {}) => decodeQQPacket(wire(extra), "42", "ns")!;
function fixture(attention?: QQAttentionPort) {
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
  const traces: QQAttentionTrace[] = [];
  const social = new QQSocialAdapter({ receive }, () => now, {
    ...(attention ? { attention } : {}),
    trace: (event) => traces.push(event)
  });
  return {
    social,
    inputs,
    receive,
    traces,
    advance: (ms: number) => {
      now += ms;
    },
    set: (value: SurfaceResult["outcome"]) => {
      outcome = value;
    }
  };
}
describe("bounded QQ social admission", () => {
  it("the local prefilter can admit ambient input but never dictates a response", async () => {
    const evaluate = vi.fn(async () => ({
      decision: "ATTEND" as const,
      fallback: false,
      elapsedMs: 60,
      completionTokens: 2
    }));
    const f = fixture({ evaluate });
    const result = await f.social.receive(packet(), connection);
    expect(f.inputs[0]).toMatchObject({ admission: "ATTENTION", content: "hello", mentions: [] });
    expect(result.outcome).toBe("SILENCE");
    expect(f.traces[0]).toMatchObject({
      attentionDecision: "ATTEND",
      admission: "ATTENTION",
      elapsedMs: 60
    });
  });
  it("IGNORE stays a journalled ambient observation and preserves image metadata", async () => {
    const f = fixture({
      evaluate: async () => ({ decision: "IGNORE", fallback: false, elapsedMs: 55 })
    });
    const result = await f.social.receive(
      packet({ message: [{ type: "image", data: { file: "image.png" } }] }),
      connection
    );
    expect(result.outcome).toBe("OBSERVED");
    expect(f.inputs[0]).toMatchObject({ hasImage: true, content: "[Image attachment]" });
    expect(f.inputs[0]?.admission).toBeUndefined();
    expect(f.receive).toHaveBeenCalledOnce();
  });
  it("private, mention and confirmed reply bypass a rejecting local model; continuation is only a candidate", async () => {
    const evaluate = vi.fn(async (_context: string, _signal: AbortSignal) => ({
      decision: "IGNORE" as const,
      fallback: false,
      elapsedMs: 1
    }));
    const f = fixture({ evaluate });
    await f.social.receive(packet({ message_type: "private" }), connection);
    f.set("RESPOND");
    const first = packet({
      message_id: 2,
      message: [
        { type: "at", data: { qq: 42 } },
        { type: "text", data: { text: "hello" } }
      ]
    });
    await f.social.receive(first, connection);
    f.social.published(first, "123", "Alice output");
    await f.social.receive(
      packet({
        message_id: 3,
        message: [
          { type: "reply", data: { id: 123 } },
          { type: "text", data: { text: "follow up" } }
        ]
      }),
      connection
    );
    await f.social.receive(packet({ message_id: 4 }), connection);
    expect(f.inputs.map((i) => i.admission)).toEqual(["PRIVATE", "MENTION", "REPLY", undefined]);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(JSON.parse(evaluate.mock.calls[0]![0]!).current.continuationCandidate).toBe(true);
  });
  it("self and duplicate packets cannot be promoted by a permissive local model", async () => {
    const evaluate = vi.fn(async () => ({
      decision: "ATTEND" as const,
      fallback: false,
      elapsedMs: 1
    }));
    const f = fixture({ evaluate });
    const p = packet();
    await f.social.receive(p, connection);
    await f.social.receive(p, connection);
    await f.social.receive(
      packet({ post_type: "message_sent", user_id: 42, sender: { user_id: 42 }, message_id: 2 }),
      connection
    );
    expect(f.inputs.map((i) => i.admission)).toEqual(["ATTENTION", undefined, undefined]);
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it.each(["uncertain", "offline"])(
    "%s falls through to Character rather than discarding current input",
    async (mode) => {
      const f = fixture({
        evaluate: async () => {
          if (mode === "offline") throw Error("offline");
          return { decision: "UNCERTAIN", fallback: false, elapsedMs: 1 };
        }
      });
      await f.social.receive(packet(), connection);
      expect(f.inputs[0]?.admission).toBe("ATTENTION");
    }
  );
  it("a pending local decision cannot admit or repopulate a replaced generation", async () => {
    let resolve!: (value: { decision: "ATTEND"; fallback: false; elapsedMs: number }) => void;
    const f = fixture({
      evaluate: () =>
        new Promise((r) => {
          resolve = r;
        })
    });
    let current = true;
    const pending = f.social.receive(packet(), { ...connection, isCurrent: () => current });
    current = false;
    f.social.resetGeneration();
    resolve({ decision: "ATTEND", fallback: false, elapsedMs: 1 });
    await expect(pending).rejects.toThrow("stale generation");
    expect(f.receive).not.toHaveBeenCalled();
  });
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
