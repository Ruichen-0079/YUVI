import { describe, expect, it, vi } from "vitest";
import { HostEffectIntentAdmission, InMemoryEffectIntentStore } from "@companion/effects";
import { effectAuthority, effectRequest, fixtureJournal } from "../../effects/src/test-fixture.js";
import { InMemoryEventBus } from "@companion/event-bus";
import { InMemoryMemoryRepository, MemoryService } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import { createProviderRegistryFromEnv } from "@companion/providers";
import { RuntimeOrchestrator } from "./runtime-orchestrator.js";

function setup(port?: HostEffectIntentAdmission) {
  const eventBus = new InMemoryEventBus({ development: false });
  const publish = vi.spyOn(eventBus, "publish");
  const memory = new MemoryService(new InMemoryMemoryRepository());
  const memoryWrite = vi.spyOn(memory, "rememberInteraction");
  const providers = createProviderRegistryFromEnv({ PROVIDER_ALLOW_MOCKS: "true" });
  const providerNames = [
    "getChatProvider",
    "getReasoningProvider",
    "getTTSProvider",
    "getVisionProvider",
    "getSTTProvider",
    "getEmbeddingProvider",
    "getProactiveDecisionProvider",
    "getAssistantContinuationProvider"
  ] as const;
  const providerCalls = providerNames.map((name) => vi.spyOn(providers, name));
  const present = vi
    .fn<
      NonNullable<
        ConstructorParameters<typeof RuntimeOrchestrator>[0]["embodiedPresentation"]
      >["present"]
    >()
    .mockImplementation(() => {
      throw new Error("Admission must never present");
    });
  const capability = vi
    .fn<NonNullable<ConstructorParameters<typeof RuntimeOrchestrator>[0]["characterCognition"]>>()
    .mockRejectedValue(new Error("Admission must never invoke Cognition/capabilities"));
  const runtime = new RuntimeOrchestrator({
    eventBus,
    memory,
    providers,
    promptBuilder: new PromptBuilder(),
    effectIntents: port,
    characterCognition: capability,
    embodiedPresentation: { propose: () => null, present }
  });
  return { runtime, publish, memoryWrite, providerCalls, present, capability };
}
describe("A9.1 staged Runtime admission", () => {
  it.each(["yuvi.embodied-presentation.v1", "yuvi.read-text.v1"] as const)(
    "%s never resolves providers, invokes capabilities, publishes, presents, or writes Memory across admission/replay/replacement/cancel/expiry",
    async (contractRef) => {
      let now = new Date("2026-10-03T00:00:00Z");
      const store = new InMemoryEffectIntentStore(() => now);
      const port = new HostEffectIntentAdmission(store, fixtureJournal, () => now);
      const first = setup(port);
      const request = {
        ...effectRequest(),
        contractRef,
        payload:
          contractRef === "yuvi.read-text.v1"
            ? { path: "/not-read/a91.txt" }
            : effectRequest().payload
      };
      const authorization = effectAuthority().snapshot;
      authorization.permissions = ["RUNTIME_EMBODIED_PRESENTATION", "RUNTIME_AUTHORIZED_PATH_READ"];
      const admitted = await first.runtime.admitPendingEffectIntent(request, authorization, 0);
      expect(await first.runtime.admitPendingEffectIntent(request, authorization, 0)).toEqual(
        admitted
      );
      await first.runtime.sealAndDrainMemoryWrites();
      const replacement = setup(new HostEffectIntentAdmission(store, fixtureJournal, () => now));
      expect(await replacement.runtime.admitPendingEffectIntent(request, authorization, 0)).toEqual(
        admitted
      );
      await port.cancel(admitted.intentId);
      expect(
        (await replacement.runtime.admitPendingEffectIntent(request, authorization, 0)).state
      ).toBe("CANCELED");
      const short = { ...request, logicalKey: "expiry", expiresAt: "2026-10-03T00:00:01.000Z" };
      await replacement.runtime.admitPendingEffectIntent(short, authorization, 0);
      now = new Date("2026-10-03T00:00:02Z");
      await port.expire();
      expect(
        (await replacement.runtime.admitPendingEffectIntent(short, authorization, 0)).state
      ).toBe("EXPIRED");
      for (const sentinels of [first, replacement]) {
        expect(sentinels.publish).not.toHaveBeenCalled();
        expect(sentinels.memoryWrite).not.toHaveBeenCalled();
        expect(sentinels.present).not.toHaveBeenCalled();
        expect(sentinels.capability).not.toHaveBeenCalled();
        for (const call of sentinels.providerCalls) expect(call).not.toHaveBeenCalled();
      }
      await replacement.runtime.sealAndDrainMemoryWrites();
    }
  );
  it("denies a stale Runtime activity revision without pending work", async () => {
    const port = new HostEffectIntentAdmission(new InMemoryEffectIntentStore(), fixtureJournal);
    const { runtime } = setup(port);
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "new-epoch", active: true });
    expect(
      (await runtime.admitPendingEffectIntent(effectRequest(), effectAuthority().snapshot, 0))
        .reasonCode
    ).toBe("STALE_AUTHORITY");
    expect(await port.listPending()).toEqual([]);
    await runtime.sealAndDrainMemoryWrites();
  });
  it.each(["activity", "seal"])(
    "rechecks %s changes after asynchronous causal lookup and drains admission before replacement",
    async (change) => {
      let release!: () => void;
      let entered!: () => void;
      const lookupStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const lookupGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const port = new HostEffectIntentAdmission(new InMemoryEffectIntentStore(), {
        async get() {
          entered();
          await lookupGate;
          return fixtureJournal.get();
        }
      });
      const { runtime } = setup(port);
      const pending = runtime.admitPendingEffectIntent(
        effectRequest(),
        effectAuthority().snapshot,
        0
      );
      await lookupStarted;
      let drained = false;
      const seal =
        change === "seal"
          ? runtime.sealAndDrainMemoryWrites().then(() => {
              drained = true;
            })
          : null;
      if (change === "activity")
        runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "new-epoch", active: true });
      await Promise.resolve();
      expect(drained).toBe(false);
      release();
      expect((await pending).reasonCode).toBe("STALE_AUTHORITY");
      expect(await port.listPending()).toEqual([]);
      if (seal) {
        await seal;
        expect(drained).toBe(true);
      } else await runtime.sealAndDrainMemoryWrites();
      await expect(
        runtime.admitPendingEffectIntent(effectRequest(), effectAuthority().snapshot, 0)
      ).rejects.toThrow(/disposed/);
    }
  );
  it("is unavailable when the host did not configure durable admission", async () => {
    const { runtime } = setup();
    await expect(
      runtime.admitPendingEffectIntent(effectRequest(), effectAuthority().snapshot, 0)
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await runtime.sealAndDrainMemoryWrites();
  });
});
