import type { RuntimeSocialContext } from "@companion/protocol";
import type { QQPacket } from "./qq-codec.js";

export type QQAttentionDecision = Readonly<{
  decision: "ATTEND" | "IGNORE" | "UNCERTAIN";
  fallback: boolean;
  elapsedMs: number;
  completionTokens?: number;
  policyVersion?: string;
}>;
export interface QQAttentionPort {
  evaluate(context: string, signal: AbortSignal): Promise<QQAttentionDecision>;
}
export type QQAttentionTrace = Readonly<{
  kind: "ATTENTION_EVALUATED" | "ATTENTION_BYPASS";
  generation: string;
  channel: string;
  messageId?: string;
  reason?: string;
  admission?: RuntimeSocialContext["admission"];
  attentionDecision?: QQAttentionDecision["decision"];
  fallback?: boolean;
  elapsedMs?: number;
  completionTokens?: number;
  contextChars?: number;
  policyVersion?: string;
}>;

/** Preserve the whole current event; only older observations compete for this optional budget. */
export function renderQQAttentionContext(
  packet: QQPacket,
  reply: RuntimeSocialContext["reply"],
  observations: RuntimeSocialContext["observations"],
  continuationCandidate = false
): string {
  const current = {
    channelRef: packet.channel,
    messageHandle: packet.messageId,
    observedAt: packet.timestamp,
    conversationKind: packet.target.temporaryGroup ? "TEMPORARY_PRIVATE" : packet.target.kind,
    self: { principalId: `${packet.namespace}:${packet.account}`, name: "Alice" },
    speaker: {
      principalId: `${packet.namespace}:${packet.sender}`,
      observedName: packet.displayName
    },
    direction: packet.direction,
    text: packet.content,
    directMention: packet.mentions.includes(packet.account),
    continuationCandidate,
    mentions: packet.mentions.map((actor) => `${packet.namespace}:${actor}`),
    reply: reply ?? null,
    hasImage: !!(packet.imageFile || packet.imageUrl),
    ...(packet.imageFile || packet.imageUrl
      ? {
          imageContents:
            "Not perceived by this text-only attention prefilter. Do not infer contents."
        }
      : {})
  };
  const earlier: RuntimeSocialContext["observations"] = [];
  const render = () => JSON.stringify({ current, earlier });
  for (const observation of [...observations].reverse()) {
    earlier.unshift(observation);
    if (render().length > 6000) {
      earlier.shift();
      break;
    }
  }
  return render();
}

/** The bounded local gateway is a service port, not a Character or capability authority. */
export function createLocalQQAttentionPort(
  endpoint: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): QQAttentionPort {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/attention" ||
    !apiKey
  )
    throw Error("QQ attention requires the authenticated loopback bounded gateway.");
  return {
    async evaluate(context, signal) {
      const started = performance.now();
      const fallback = (): QQAttentionDecision => ({
        decision: "UNCERTAIN",
        fallback: true,
        elapsedMs: Math.round(performance.now() - started)
      });
      if (context.length > 6000) return fallback();
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ context }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(1700)])
        });
        if (!response.ok) return fallback();
        const body = (await response.json()) as Record<string, unknown>;
        const decision = body["decision"];
        const tokens = body["completionTokens"];
        if (body["fallback"] === true) return fallback();
        if (
          !["ATTEND", "IGNORE", "UNCERTAIN"].includes(String(decision)) ||
          body["fallback"] !== false ||
          body["handoff"] !== (decision !== "IGNORE") ||
          typeof tokens !== "number" ||
          !Number.isInteger(tokens) ||
          tokens < 1 ||
          tokens > 4
        )
          return fallback();
        return {
          decision: decision as QQAttentionDecision["decision"],
          fallback: false,
          completionTokens: tokens,
          ...(typeof body["policyVersion"] === "string"
            ? { policyVersion: body["policyVersion"].slice(0, 64) }
            : {}),
          elapsedMs: Math.round(performance.now() - started)
        };
      } catch {
        return fallback();
      }
    }
  };
}
