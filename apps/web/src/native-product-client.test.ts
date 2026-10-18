import { describe, expect, it, vi, beforeEach } from "vitest";
const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage: (event: unknown) => void }>
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: bridge.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
    constructor() {
      bridge.channels.push(this);
    }
  }
}));
import { nativeIdentityChanged, nativeProductFetch } from "./native-product-client.js";
beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.channels.length = 0;
  nativeIdentityChanged();
});
describe("native product transport private response ownership", () => {
  it("discards a prior Person's late HTTP response after an identity generation changes", async () => {
    let complete!: (value: unknown) => void;
    bridge.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const response = nativeProductFetch("/memory/v1/current?scope=prior");
    nativeIdentityChanged();
    complete({ status: 200, contentType: "application/json", body: '{"private":"old Person"}' });
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
  });
  it("never forwards JavaScript Authorization or caller cookies through the native bridge", async () => {
    bridge.invoke.mockResolvedValue({ status: 200, contentType: "application/json", body: "{}" });
    await nativeProductFetch("/host/v1/product/status", {
      headers: { authorization: "untrusted", cookie: "untrusted" }
    });
    expect(bridge.invoke).toHaveBeenCalledWith("native_product_request", {
      path: "/host/v1/product/status",
      method: "GET"
    });
  });
  it("cancels and discards streamed bytes from an old identity rather than reconnecting it", async () => {
    bridge.invoke.mockResolvedValue(undefined);
    const response = nativeProductFetch("/v1/messages/stream", {
      method: "POST",
      body: JSON.stringify({ text: "synthetic" })
    });
    bridge.channels[0]!.onmessage({ type: "open", status: 200, contentType: "text/event-stream" });
    const reader = (await response).body!.getReader();
    const pending = reader.read();
    nativeIdentityChanged();
    bridge.channels[0]!.onmessage({ type: "chunk", bytes: [112, 114, 105, 118, 97, 116, 101] });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(bridge.invoke).toHaveBeenCalledWith(
      "native_product_cancel",
      expect.objectContaining({ id: expect.any(String) })
    );
  });
});
