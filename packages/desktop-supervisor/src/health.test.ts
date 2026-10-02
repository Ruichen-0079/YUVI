import { afterEach, expect, it, vi } from "vitest";
import { mem0HealthOk, probeHttpHealth } from "./health.js";

afterEach(() => vi.unstubAllGlobals());
it.each(["healthy", "degraded", "unhealthy"])(
  "reads Mem0 capability status before envelope success: %s",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        data: { status, capabilities: { profileSnapshotMode: "bounded_snapshot" } }
      })))
    );
    const result = await probeHttpHealth("http://localhost/health", { validateBody: mem0HealthOk });
    expect(result.ok).toBe(status !== "unhealthy");
    expect(result.degraded).toBe(status === "degraded");
  }
);

it("rejects a healthy Mem0 instance without bounded snapshot support", () => {
  expect(mem0HealthOk({ ok: true, data: { status: "healthy", capabilities: { crud: true } } })).toBe(false);
});

it("distinguishes local TTS warmup from ready without accepting arbitrary JSON", async () => {
  const { ttsWrapperHealthOk } = await import("./health.js");
  expect(ttsWrapperHealthOk({})).toBe(false);
  expect(ttsWrapperHealthOk({ model_loaded: false })).toBe(false);
  expect(ttsWrapperHealthOk({ model_loaded: true })).toBe(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ service: "yuvi-dots-tts", state: "warming", model_loaded: false }),
          { status: 503 }
        )
    )
  );
  expect(
    await probeHttpHealth("http://localhost/health", { validateBody: ttsWrapperHealthOk })
  ).toMatchObject({ ok: false, warming: true });
});

it("recognizes a dots load failure as unavailable service, not a foreign port", async () => {
  const { ttsWrapperHealthOk } = await import("./health.js");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ service: "yuvi-dots-tts", state: "error", model_loaded: false }),
          { status: 503 }
        )
    )
  );
  expect(
    await probeHttpHealth("http://localhost/health", { validateBody: ttsWrapperHealthOk })
  ).toMatchObject({ ok: false, protocolOk: true, warming: false });
});

it("treats hibernated dots TTS as healthy ready-on-demand, not a foreign port", async () => {
  const { ttsWrapperHealthOk } = await import("./health.js");
  expect(
    ttsWrapperHealthOk({
      service: "yuvi-dots-tts",
      state: "hibernated",
      model_loaded: false,
      ready_on_demand: true,
      gpu_resident: false
    })
  ).toBe(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            service: "yuvi-dots-tts",
            state: "hibernated",
            model_loaded: false,
            ready_on_demand: true
          }),
          { status: 200 }
        )
    )
  );
  expect(
    await probeHttpHealth("http://localhost/health", { validateBody: ttsWrapperHealthOk })
  ).toMatchObject({ ok: true, protocolOk: true, warming: false });
});
