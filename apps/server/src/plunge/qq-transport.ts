import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ServerPluginSource } from "../plugin-lifecycle.js";
import type { CharacterSurfacePort } from "../character-surface-host.js";
import { decodeQQPacket, encodeQQSend, messageHandle, qqId, type QQPacket } from "./qq-codec.js";
import { readQQImage } from "./qq-image.js";
import { QQSocialAdapter } from "./qq-social.js";

export type QQTransportConfiguration = Readonly<{
  endpoint: string;
  accessToken: string;
  expectedAccount: string;
  namespace: string;
  privatePeers: readonly string[];
  groups: readonly string[];
  mediaRoots: readonly string[];
}>;
type Pending = { socket: WebSocket; resolve(value: Record<string, unknown>): void; reject(): void };
export type QQTrace = Readonly<{
  kind: string;
  generation: string;
  channel?: string;
  outcome?: string;
}>;

/** Plunge knows QQ. No prompt, Memory, P8 or model service is reachable here. */
export class QQTransport {
  private socket: WebSocket | undefined;
  private generation = "";
  private controller = new AbortController();
  private stopped = true;
  private ready = false;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly social: QQSocialAdapter;
  private queued = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly config: QQTransportConfiguration,
    port: CharacterSurfacePort,
    private readonly trace: (event: QQTrace) => void = () => {}
  ) {
    const endpoint = new URL(config.endpoint);
    if (
      !["ws:", "wss:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw Error("Invalid OneBot endpoint.");
    if (!config.accessToken || qqId(config.expectedAccount) !== config.expectedAccount)
      throw Error("OneBot requires authenticated expected-account configuration.");
    this.social = new QQSocialAdapter(port);
  }
  source(): ServerPluginSource {
    return {
      manifest: {
        manifestVersion: 1,
        id: "org.yuvi.plunge.qq",
        version: "2.0.0",
        compatibility: { apiVersion: 1 },
        surfaces: { input: ["qq"], presentation: ["qq"] }
      },
      load: () => ({
        start: async (context) => {
          this.stopped = false;
          try {
            await this.connect(context.signal);
          } catch (error) {
            this.stop();
            throw error;
          }
        },
        stop: () => this.stop(),
        dispose: () => this.stop()
      })
    };
  }
  snapshot() {
    return {
      ready: this.ready,
      generation: this.generation,
      pending: this.pending.size,
      queued: this.queued
    };
  }
  private stop() {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.reconnect);
    this.controller.abort();
    this.rejectPending();
    this.socket?.terminate();
  }
  private rejectPending() {
    for (const p of [...this.pending.values()]) p.reject();
  }
  private async connect(startSignal?: AbortSignal) {
    if (this.stopped) return;
    this.controller.abort();
    this.rejectPending();
    this.social.resetGeneration();
    this.controller = new AbortController();
    this.generation = randomUUID();
    const generation = this.generation,
      controller = this.controller;
    const socket = new WebSocket(this.config.endpoint, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      maxPayload: 128 * 1024,
      handshakeTimeout: 1500
    });
    this.socket = socket;
    this.ready = false;
    const current = () =>
      !this.stopped &&
      this.socket === socket &&
      this.generation === generation &&
      !controller.signal.aborted;
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.ready = false;
      controller.abort();
      this.rejectPending();
      this.social.resetGeneration();
      this.trace({ kind: "DISCONNECTED", generation });
      if (!this.stopped)
        this.reconnect = setTimeout(() => {
          void this.connect().catch(() => {});
        }, 500);
    });
    socket.on("message", (bytes) => {
      if (!current()) return;
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(bytes.toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        event = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      const pending =
        typeof event["echo"] === "string" ? this.pending.get(event["echo"]) : undefined;
      if (pending?.socket === socket) {
        if (
          event["status"] === "ok" &&
          event["retcode"] === 0 &&
          event["data"] &&
          typeof event["data"] === "object" &&
          !Array.isArray(event["data"])
        )
          pending.resolve(event["data"] as Record<string, unknown>);
        else pending.reject();
        return;
      }
      if (!this.ready) return;
      const packet = decodeQQPacket(event, this.config.expectedAccount, this.config.namespace);
      if (!packet || !this.allowed(packet)) return;
      if (this.queued >= 16) {
        this.trace({ kind: "INGRESS_FULL", generation, channel: packet.channel });
        return;
      }
      this.queued++;
      this.chain = this.chain
        .then(async () => {
          if (!current()) return;
          const result = await this.social.receive(packet, {
            generation,
            signal: controller.signal,
            isCurrent: current,
            write: async (text, signal) => {
              if (!current() || !this.ready) throw Error("QQ generation is stale.");
              const send = encodeQQSend(packet.target, text, packet.messageId);
              const data = await this.action(socket, send.action, send.params, signal, 15_000);
              const id = messageHandle(data["message_id"]);
              if (!id || !current()) throw Error("QQ send acknowledgement is unavailable.");
              this.social.published(packet, id, text);
              this.trace({ kind: "NATIVE_ACK", generation, channel: packet.channel });
            },
            readImage: async (signal) => {
              try {
                let reference = packet.imageUrl;
                if (!reference && packet.imageFile) {
                  const data = await this.action(
                    socket,
                    "get_image",
                    { file: packet.imageFile },
                    signal,
                    3000
                  );
                  reference =
                    typeof data["file"] === "string"
                      ? data["file"]
                      : typeof data["url"] === "string"
                        ? data["url"]
                        : undefined;
                }
                return reference
                  ? await readQQImage(reference, this.config.mediaRoots, signal)
                  : undefined;
              } catch {
                this.trace({ kind: "IMAGE_UNAVAILABLE", generation, channel: packet.channel });
                return undefined;
              }
            }
          });
          this.trace({
            kind: "RECEIPT",
            generation,
            channel: packet.channel,
            outcome: result.outcome
          });
        })
        .catch(() => {
          this.trace({ kind: "TURN_FAILED", generation, channel: packet.channel });
        })
        .finally(() => {
          this.queued--;
        });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          socket.terminate();
          reject(Error("QQ connection canceled."));
        };
        const cleanup = () => startSignal?.removeEventListener("abort", abort);
        if (startSignal?.aborted) {
          abort();
          return;
        }
        startSignal?.addEventListener("abort", abort, { once: true });
        socket.once("open", () => {
          cleanup();
          resolve();
        });
        socket.once("error", () => {
          cleanup();
          reject(Error("OneBot handshake failed."));
        });
        socket.once("close", () => {
          cleanup();
          reject(Error("OneBot closed before readiness."));
        });
      });
      const signal = AbortSignal.any([controller.signal, ...(startSignal ? [startSignal] : [])]);
      const version = await this.action(socket, "get_version_info", {}, signal, 700);
      if (
        version["app_name"] !== "SnowLuma" ||
        !["1.14.19", "1.14.19-node"].includes(String(version["app_version"])) ||
        version["protocol_version"] !== "v11"
      )
        throw Error("SnowLuma contract requires revalidation.");
      const login = await this.action(socket, "get_login_info", {}, signal, 700);
      const status = await this.action(socket, "get_status", {}, signal, 700);
      if (
        !current() ||
        qqId(login["user_id"]) !== this.config.expectedAccount ||
        status["online"] !== true ||
        status["good"] !== true
      )
        throw Error("Expected QQ account is not ready.");
      this.ready = true;
      this.trace({ kind: "READY", generation });
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }
  private allowed(p: QQPacket) {
    return p.target.kind === "GROUP"
      ? this.config.groups.includes(p.target.peer)
      : this.config.privatePeers.includes(p.target.peer);
  }
  private action(
    socket: WebSocket,
    action: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    if (
      socket !== this.socket ||
      socket.readyState !== WebSocket.OPEN ||
      signal.aborted ||
      this.pending.size >= 32
    )
      return Promise.reject(Error("OneBot action unavailable."));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (value?: Record<string, unknown>) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(echo);
        value ? resolve(value) : reject(Error("OneBot action outcome is uncertain."));
      };
      const abort = () => finish();
      const timer = setTimeout(abort, timeoutMs);
      this.pending.set(echo, { socket, resolve: (value) => finish(value), reject: abort });
      signal.addEventListener("abort", abort, { once: true });
      try {
        socket.send(JSON.stringify({ action, params, echo }), (error) => {
          if (error) finish();
        });
      } catch {
        finish();
      }
    });
  }
}
