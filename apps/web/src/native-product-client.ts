import { isTauriRuntime } from "./tauri-window.js";
import { invoke, Channel } from "@tauri-apps/api/core";
export type NativeActivationState = {
  owned: boolean;
  people: { id: string; displayName: string }[];
  person: { id: string; displayName: string } | null;
  pending?: boolean;
  revocationPending?: boolean;
  serviceUnavailable?: boolean;
  memoryConfigured?: boolean;
};
export const nativeActivation = (action = "status", args: Record<string, unknown> = {}) =>
  invoke<NativeActivationState>("native_product_activation", { action, ...args });
let generation = 0;
export function nativeIdentityChanged() {
  generation++;
}

/** Only the native allowlisted product operations pass this bridge. No caller headers or URL are forwarded. */
export async function nativeProductFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const current = generation;
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
  if (init.body !== undefined && typeof init.body !== "string")
    throw Error("Native product requests require JSON");
  if (path === "/v1/messages/stream") {
    const id = crypto.randomUUID();
    let resolve!: (response: Response) => void;
    let reject!: (error: unknown) => void;
    const opened = new Promise<Response>((r, e) => {
      resolve = r;
      reject = e;
    });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let ended = false;
    const cancel = () => {
      if (ended) return;
      ended = true;
      void invoke("native_product_cancel", { id }).catch(() => {});
      controller.error(new DOMException("Native stream aborted", "AbortError"));
      reject(new DOMException("Native stream aborted", "AbortError"));
      init.signal?.removeEventListener("abort", cancel);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel
    });
    const channel = new Channel<{
      type: string;
      status?: number;
      contentType?: string;
      bytes?: number[];
    }>();
    channel.onmessage = (event) => {
      if (current !== generation || init.signal?.aborted) {
        cancel();
        return;
      }
      if (ended) return;
      if (event.type === "open")
        resolve(
          new Response(stream, {
            status: event.status ?? 503,
            headers: { "content-type": event.contentType ?? "" }
          })
        );
      else if (event.type === "chunk") controller.enqueue(new Uint8Array(event.bytes ?? []));
      else {
        ended = true;
        init.signal?.removeEventListener("abort", cancel);
        if (event.type === "close") controller.close();
        else {
          controller.error(Error("Native stream interrupted"));
          reject(Error("Native stream interrupted"));
        }
      }
    };
    init.signal?.addEventListener("abort", cancel, { once: true });
    void invoke("native_product_stream", { id, body, channel }).catch((error) => {
      cancel();
      reject(error);
    });
    return opened;
  }
  const result = await invoke<{ status: number; contentType: string; body: string }>(
    "native_product_request",
    { path, method, ...(body === undefined ? {} : { body }) }
  );
  if (current !== generation || init.signal?.aborted)
    throw new DOMException("Identity changed", "AbortError");
  return new Response(result.body, {
    status: result.status,
    headers: { "content-type": result.contentType }
  });
}
export function productTransport(path: string, init?: RequestInit): Promise<Response> {
  if (!isTauriRuntime()) throw Error("Native transport requires Tauri");
  return nativeProductFetch(path, init);
}

/** Fixed conversational socket; caller cannot choose a URL, credential or operator protocol. */
export async function openNativeChatSocket(
  onEvent: (event: { type: string; text?: string }) => void
) {
  const id = crypto.randomUUID();
  const channel = new Channel<{ type: string; text?: string }>();
  channel.onmessage = onEvent;
  await invoke("native_product_socket", { id, channel });
  return {
    send: (packet: unknown) => invoke<void>("native_product_socket_send", { id, packet }),
    close: () => invoke<void>("native_product_cancel", { id })
  };
}
