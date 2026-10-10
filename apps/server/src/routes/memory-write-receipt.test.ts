import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context.js";
import { currentReplyMemoryWriteStatus } from "./message.js";

type ReceiptContext = Pick<AppContext, "conversationRepository" | "finalizedIngestion">;
const input = { sessionId: "synthetic", traceId: "trace-a", replyId: "reply-a" };
const source = {
  id: "assistant-a",
  role: "assistant",
  traceId: "trace-a",
  parentMessageId: "reply-a",
  status: "completed",
  ingestionRequested: true,
  finalizedTurnId: "turn-a"
};
function context(message: object | null, turn: object | null): ReceiptContext {
  return {
    conversationRepository: { listRecentMessages: vi.fn(async () => (message ? [message] : [])) },
    finalizedIngestion: { getTurn: vi.fn(async () => turn) }
  } as unknown as ReceiptContext;
}
describe("current reply Memory receipt", () => {
  it.each(["pending", "partial", "reconcile_required", "terminal_failed", "complete"])(
    "publishes actual ledger status %s without treating chat completion as write completion",
    async (status) => {
      const c = context(source, { assistantMessageId: source.id, traceId: input.traceId, status });
      expect(await currentReplyMemoryWriteStatus(c, input)).toBe(status);
    }
  );
  it("reports pending while deferred materialization has no ledger row", async () => {
    expect(await currentReplyMemoryWriteStatus(context(source, null), input)).toBe("pending");
  });
  it("keeps a neighboring trace from supplying a completed receipt", async () => {
    const c = context({ ...source, traceId: "foreign" }, { status: "complete" });
    expect(await currentReplyMemoryWriteStatus(c, input)).toBe("unknown");
    expect(c.finalizedIngestion.getTurn).not.toHaveBeenCalled();
  });
  it("does not accept another assistant's receipt", async () => {
    expect(
      await currentReplyMemoryWriteStatus(
        context(source, {
          assistantMessageId: "other",
          traceId: input.traceId,
          status: "complete"
        }),
        input
      )
    ).toBe("pending");
  });
  it("does not turn a receipt read failure into a failed chat or success receipt", async () => {
    const c = context(source, null);
    vi.mocked(c.finalizedIngestion.getTurn).mockRejectedValue(new Error("offline"));
    expect(await currentReplyMemoryWriteStatus(c, input)).toBe("unknown");
  });
  it("distinguishes disabled ingestion from successful writing", async () => {
    expect(
      await currentReplyMemoryWriteStatus(
        context({ ...source, ingestionRequested: false }, null),
        input
      )
    ).toBe("skipped");
  });
});
