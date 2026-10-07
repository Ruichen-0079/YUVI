import { describe, expect, it, vi } from "vitest";
import { createLocalQQAttentionPort, renderQQAttentionContext } from "./qq-attention.js";
import { decodeQQPacket } from "./qq-codec.js";
import { wire } from "./qq-fixture.js";

const signal = new AbortController().signal;
describe("bounded local QQ attention service port", () => {
  it("preserves complete current input and drops only optional older observations", () => {
    const text = "当前图片问题".repeat(600);
    const packet = decodeQQPacket(
      wire({ message: [{ type: "text", data: { text } }] }),
      "42",
      "ns"
    )!;
    const context = renderQQAttentionContext(
      packet,
      undefined,
      Array.from({ length: 12 }, (_, i) => ({
        speaker: { principalId: "other" },
        text: "old".repeat(1000),
        observedAt: "2026-10-07T00:00:00.000Z",
        sourceJournalRef: {
          kind: "JOURNAL_EVENT",
          namespace: "test",
          eventId: "jev1_" + String(i).padStart(16, "0")
        }
      }))
    );
    const parsed = JSON.parse(context);
    expect(parsed.current.text).toBe(text);
    expect(parsed.current.directMention).toBe(false);
    expect(parsed.earlier).toHaveLength(0);
    expect(context.length).toBeLessThan(6000);
    expect(parsed.current.hasImage).toBe(false);
    expect(parsed.current.imageContents).toBeUndefined();
  });
  it("accepts a complete bounded decision and sends no configurable generation parameters", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ decision: "IGNORE", handoff: false, fallback: false, completionTokens: 2 })
    );
    const port = createLocalQQAttentionPort("http://127.0.0.1:8130/attention", "test", fetcher);
    expect(await port.evaluate("current QQ context", signal)).toMatchObject({
      decision: "IGNORE",
      fallback: false,
      completionTokens: 2
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      context: "current QQ context"
    });
  });
  it.each([
    { decision: "IGNORE", handoff: false, fallback: false, completionTokens: 100 },
    { decision: "IGNORE", handoff: true, fallback: false, completionTokens: 2 },
    { decision: "IGNORE", handoff: false, fallback: true },
    { decision: "IGNORE", handoff: false },
    { decision: "NOT_A_DECISION", handoff: false, fallback: false, completionTokens: 2 }
  ])("malformed or failed results cannot suppress an event: %j", async (body) => {
    const port = createLocalQQAttentionPort("http://127.0.0.1:8130/attention", "test", async () =>
      Response.json(body)
    );
    expect(await port.evaluate("QQ event", signal)).toMatchObject({
      decision: "UNCERTAIN",
      fallback: true
    });
  });
  it("oversized current context and connection errors hand off", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw Error("offline");
    });
    const port = createLocalQQAttentionPort("http://127.0.0.1:8130/attention", "test", fetcher);
    expect(await port.evaluate("图".repeat(6001), signal)).toMatchObject({
      decision: "UNCERTAIN",
      fallback: true
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await port.evaluate("QQ event", signal)).toMatchObject({
      decision: "UNCERTAIN",
      fallback: true
    });
  });
  it("rejects raw model endpoints and remote gateways", () => {
    for (const endpoint of [
      "http://127.0.0.1:8129/v1/chat/completions",
      "http://example.com/attention",
      "http://127.0.0.1:8130/attention?key=test"
    ])
      expect(() => createLocalQQAttentionPort(endpoint, "test")).toThrow("bounded gateway");
  });
});
