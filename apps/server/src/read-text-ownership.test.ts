import { describe, expect, it, vi } from "vitest";
import {
  effectIntentId,
  type EffectCausalReader,
  type EffectDispatchStore,
  type EffectIntentAdmissionPort,
  type EffectIntent
} from "@companion/effects";
import { fixtureIdentity } from "../../../packages/effects/src/test-fixture.js";
import { HostReadTextEffects, type ReadTextEffectInput } from "./read-text-effect.js";
const input: ReadTextEffectInput = {
  path: "/authorized/path.txt",
  logicalKey: "same-logical-work",
  scope: "session:owner",
  executionId: "first",
  cause: { kind: "JOURNAL_EVENT", namespace: "probe-journal", eventId: "jev1_aaaaaaaaaaaaaaaa" },
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  isCurrent: () => true
};
function host() {
  const admission = {
    admit: vi.fn(
      async (request: { contractRef: "yuvi.read-text.v1"; logicalKey: string }) =>
        ({
          intentId: effectIntentId(request.contractRef, request.logicalKey),
          decision: "ADMITTED",
          workState: "PENDING"
        }) as EffectIntent
    )
  } as unknown as EffectIntentAdmissionPort;
  const journal = {
    get: async () => ({ command: { kind: "RECEIPT" }, authority: fixtureIdentity })
  } as unknown as EffectCausalReader;
  const host = new HostReadTextEffects(admission, {} as EffectDispatchStore, journal);
  vi.spyOn(host.dispatcher!, "run").mockResolvedValue({
    recorded: true,
    transientResult: { isError: false, content: [{ type: "text", text: "authorized result" }] }
  } as never);
  return { host, admission };
}
describe("volatile read grants have one owner across capture awaits", () => {
  it("rejects a concurrent same-key claimant before it can overwrite the installed grant", async () => {
    const { host: adapter, admission } = host();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let captures = 0;
    adapter.captureContext = async () => {
      captures++;
      await gate;
      return { manifestId: "manifest", exposureId: "exposure" };
    };
    const first = adapter.execute(input);
    await vi.waitFor(() => expect(captures).toBe(1));
    let secondStatus = "pending";
    const second = adapter.execute({ ...input, executionId: "second" }).then(
      () => {
        secondStatus = "succeeded";
      },
      () => {
        secondStatus = "rejected";
      }
    );
    try {
      await vi.waitFor(() => expect(secondStatus).toBe("rejected"));
      expect(captures).toBe(1);
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
    expect(admission.admit).toHaveBeenCalledTimes(1);
  });
  it("releases its own failed capture and permits a later legitimate owner", async () => {
    const { host: adapter } = host();
    adapter.captureContext = async () => {
      throw Error("capture unavailable");
    };
    await expect(adapter.execute(input)).rejects.toThrow("capture unavailable");
    adapter.captureContext = undefined;
    expect((await adapter.execute({ ...input, executionId: "retry" })).isError).toBe(false);
  });
});
