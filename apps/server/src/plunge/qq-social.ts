import type { RuntimeSocialContext } from "@companion/protocol";
import type {
  CharacterSurfacePort,
  SurfaceConnection,
  SurfaceResult
} from "../character-surface-host.js";
import type { QQPacket } from "./qq-codec.js";
import {
  renderQQAttentionContext,
  type QQAttentionDecision,
  type QQAttentionPort,
  type QQAttentionTrace
} from "./qq-attention.js";

type Observed = {
  sender: string;
  text: string;
  speaker: RuntimeSocialContext["speaker"];
  at: number;
};
type Channel = {
  observations: RuntimeSocialContext["observations"];
  handles: Map<string, Observed | null>;
  continuation?: { sender: string; until: number } | undefined;
  lastSender?: string | undefined;
  touched: number;
};
/** Bounded transport context, never a second Memory/Relationship or cognition loop. */
export class QQSocialAdapter {
  private readonly channels = new Map<string, Channel>();
  private readonly duplicates = new Map<string, number>();
  constructor(
    private readonly port: CharacterSurfacePort,
    private readonly now: () => number = Date.now,
    private readonly options: {
      attention?: QQAttentionPort;
      trace?: (event: QQAttentionTrace) => void;
    } = {}
  ) {}
  async receive(packet: QQPacket, connection: SurfaceConnection): Promise<SurfaceResult> {
    const now = this.now();
    for (const [key, c] of this.channels) if (c.touched < now - 120_000) this.channels.delete(key);
    for (const [key, t] of this.duplicates) if (t < now - 60_000) this.duplicates.delete(key);
    let c = this.channels.get(packet.channel);
    if (!c) {
      if (this.channels.size >= 64) this.channels.delete(this.channels.keys().next().value!);
      c = { observations: [], handles: new Map(), touched: now };
      this.channels.set(packet.channel, c);
    }
    c.touched = now;
    const linked = packet.replyTo ? c.handles.get(packet.replyTo) : undefined;
    const duplicate = packet.duplicateKey ? this.duplicates.has(packet.duplicateKey) : false;
    let admission: RuntimeSocialContext["admission"] | undefined =
      packet.direction === "SELF" || duplicate
        ? undefined
        : packet.target.kind === "PRIVATE"
          ? "PRIVATE"
          : packet.mentions.includes(packet.account)
            ? "MENTION"
            : linked?.sender === packet.account
              ? "REPLY"
              : c.continuation?.sender === packet.sender &&
                  c.continuation.until > now &&
                  c.lastSender === packet.sender
                ? "CONTINUATION"
                : undefined;
    const reply = packet.replyTo
      ? {
          reference: packet.replyTo,
          state:
            linked === null
              ? ("CONFLICTING" as const)
              : linked
                ? ("OBSERVED" as const)
                : ("UNRESOLVED" as const),
          ...(linked ? { author: linked.speaker, text: linked.text } : {})
        }
      : undefined;
    if (this.options.attention) {
      const trace = {
        generation: connection.generation,
        channel: packet.channel,
        ...(packet.messageId ? { messageId: packet.messageId } : {})
      };
      if ((admission && admission !== "CONTINUATION") || packet.direction === "SELF" || duplicate) {
        this.options.trace?.({
          ...trace,
          kind: "ATTENTION_BYPASS",
          reason: admission ?? (duplicate ? "DUPLICATE" : "SELF"),
          ...(admission ? { admission } : {})
        });
      } else {
        const context = renderQQAttentionContext(
          packet,
          reply,
          c.observations.slice(-12),
          admission === "CONTINUATION"
        );
        const started = performance.now();
        let decision: QQAttentionDecision;
        try {
          decision = await this.options.attention.evaluate(context, connection.signal);
        } catch {
          decision = {
            decision: "UNCERTAIN" as const,
            fallback: true,
            elapsedMs: Math.round(performance.now() - started)
          };
        }
        if (!connection.isCurrent() || connection.signal.aborted)
          throw Error("QQ attention completed in a stale generation.");
        admission = decision.fallback || decision.decision !== "IGNORE" ? "ATTENTION" : undefined;
        this.options.trace?.({
          ...trace,
          kind: "ATTENTION_EVALUATED",
          contextChars: context.length,
          attentionDecision: decision.decision,
          fallback: decision.fallback,
          elapsedMs: decision.elapsedMs,
          ...(decision.completionTokens !== undefined
            ? { completionTokens: decision.completionTokens }
            : {}),
          ...(decision.policyVersion ? { policyVersion: decision.policyVersion } : {}),
          ...(admission ? { admission } : {})
        });
      }
    }
    const result = await this.port.receive(
      {
        channelRef: packet.channel,
        conversationKind: packet.target.temporaryGroup ? "TEMPORARY_PRIVATE" : packet.target.kind,
        ...(packet.target.temporaryGroup
          ? { originChannelRef: `${packet.namespace}:group:${packet.target.temporaryGroup}` }
          : {}),
        actorId: packet.sender,
        content: packet.content,
        transportFacts: packet.transportFacts,
        hasImage: !!(packet.imageFile || packet.imageUrl),
        mentions: packet.mentions,
        observations: c.observations.slice(-12),
        ...(packet.displayName ? { displayName: packet.displayName } : {}),
        ...(admission ? { admission } : {}),
        ...(reply ? { reply } : {})
      },
      connection
    );
    if (result.outcome === "STALE" || !connection.isCurrent()) return result;
    if (packet.duplicateKey) {
      this.duplicates.set(packet.duplicateKey, now);
      if (this.duplicates.size > 256) this.duplicates.delete(this.duplicates.keys().next().value!);
    }
    c.observations.push({
      speaker: result.speaker,
      text: packet.content,
      observedAt: new Date(now).toISOString(),
      sourceJournalRef: result.sourceJournalRef,
      ...(result.media ? { media: result.media } : {}),
      direction: packet.direction === "SELF" ? "SELF" : "OTHER",
      interactionKind:
        packet.direction === "SELF" ? "SELF_EXPRESSION" : admission ? "ADMITTED_TURN" : "AMBIENT",
      mentions: packet.mentions.map((actor) => `${packet.namespace}:${actor}`),
      ...(reply ? { reply } : {})
    });
    if (result.publication) c.observations.push(result.publication);
    c.observations = c.observations.slice(-12);
    this.record(c, packet.messageId, {
      sender: packet.sender,
      speaker: result.speaker,
      text: packet.content,
      at: now
    });
    if (packet.direction !== "SELF" && !duplicate) {
      c.lastSender = packet.sender;
      if (result.outcome === "RESPOND")
        c.continuation = { sender: packet.sender, until: now + 60_000 };
      else c.continuation = undefined;
    }
    return result;
  }
  /** Only a successful observed send ACK authorizes a reply-Alice link. */
  published(packet: QQPacket, messageId: string, text: string) {
    const c = this.channels.get(packet.channel);
    if (c)
      this.record(c, messageId, {
        sender: packet.account,
        speaker: { principalId: `${packet.namespace}:${packet.account}` },
        text,
        at: this.now()
      });
  }
  private record(c: Channel, id: string | undefined, value: Observed) {
    if (!id) return;
    const previous = c.handles.get(id);
    if (
      previous === null ||
      (previous && (previous.sender !== value.sender || previous.text !== value.text))
    )
      c.handles.set(id, null);
    else c.handles.set(id, value);
    if (c.handles.size > 128) c.handles.delete(c.handles.keys().next().value!);
  }
  resetGeneration() {
    // Reconnection grants no replay/continuation/link guarantee.
    this.channels.clear();
    this.duplicates.clear();
  }
}
