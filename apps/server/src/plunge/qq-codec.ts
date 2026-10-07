import { createHash } from "node:crypto";

export function qqId(value: unknown): string | undefined {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return;
  if (typeof value !== "number" && typeof value !== "string") return;
  const raw = String(value);
  if (!/^[0-9]{1,20}$/.test(raw) || BigInt(raw) === 0n) return;
  return BigInt(raw).toString();
}
export function messageHandle(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return;
  if (typeof value === "number" && !Number.isSafeInteger(value)) return;
  const s = String(value);
  if (!/^-?[0-9]{1,11}$/.test(s)) return;
  const n = BigInt(s);
  return n >= -2147483648n && n <= 2147483647n ? n.toString() : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export type QQTarget = Readonly<{
  kind: "PRIVATE" | "GROUP";
  peer: string;
  temporaryGroup?: string;
}>;
export type QQPacket = Readonly<{
  namespace: string;
  account: string;
  sender: string;
  target: QQTarget;
  channel: string;
  direction: "INBOUND" | "SELF";
  displayName?: string;
  content: string;
  mentions: readonly string[];
  replyTo?: string;
  messageId?: string;
  sequence?: string;
  timestamp?: string;
  imageFile?: string;
  imageUrl?: string;
  transportFacts: string;
  duplicateKey?: string;
}>;

/** OneBot signed handles are correlation hints. Sender/group UINs have a separate namespace. */
export function decodeQQPacket(
  raw: unknown,
  account: string,
  namespace: string
): QQPacket | undefined {
  const e = object(raw);
  if (
    !e ||
    !["message", "message_sent"].includes(String(e["post_type"])) ||
    qqId(e["self_id"]) !== account
  )
    return;
  const info = object(e["sender"]);
  const actor = qqId(e["user_id"]),
    reported = qqId(info?.["user_id"]);
  if (actor && reported && actor !== reported) return;
  const wireSender = actor ?? reported;
  if (!wireSender || !Array.isArray(e["message"]) || e["message"].length > 64) return;
  const direction =
    e["post_type"] === "message_sent" || wireSender === account ? "SELF" : "INBOUND";
  const sender = direction === "SELF" ? account : wireSender;
  const kind =
    e["message_type"] === "group"
      ? "GROUP"
      : e["message_type"] === "private"
        ? "PRIVATE"
        : undefined;
  if (!kind || e["anonymous"]) return;
  const peer =
    kind === "GROUP"
      ? qqId(e["group_id"])
      : direction === "SELF"
        ? (qqId(e["target_id"]) ?? (wireSender !== account ? wireSender : undefined))
        : sender;
  if (!peer) return;
  const temporaryGroup =
    kind === "PRIVATE" && e["sub_type"] === "group" ? qqId(info?.["group_id"]) : undefined;
  // A missing temp provenance cannot be silently routed as ordinary private.
  if (kind === "PRIVATE" && e["sub_type"] === "group" && !temporaryGroup) return;
  const target: QQTarget = { kind, peer, ...(temporaryGroup ? { temporaryGroup } : {}) };
  // Private synthetic self events may name the receiver in user_id. They are never turns.
  const segments = e["message"]
    .map(object)
    .filter((v): v is Record<string, unknown> => v !== undefined);
  let seenImages = 0;
  const content = segments
    .map((segment) => {
      const kind = segment["type"];
      if (kind === "text") {
        const text = object(segment["data"])?.["text"];
        return typeof text === "string" ? text : "";
      }
      if (kind === "image")
        return ++seenImages === 1
          ? "[Image attachment]"
          : "[Additional image attachment; contents unavailable]";
      if (kind === "at" || kind === "reply") return "";
      // Transport recognition is not perception. Unsupported media stays visible
      // in the conversation, with its contents explicitly unknown.
      return typeof kind === "string" && /^[a-z_]{1,32}$/.test(kind)
        ? `[Attachment: ${kind}; contents unavailable]`
        : "[Unsupported message segment; contents unavailable]";
    })
    .join("")
    .trim();
  if (content.length > 4096) return;
  const images = segments.filter((s) => s["type"] === "image");
  const firstImage = object(images[0]?.["data"]);
  const imageFile =
    typeof firstImage?.["file"] === "string" && firstImage["file"].length <= 2048
      ? firstImage["file"]
      : undefined;
  const imageUrl =
    typeof firstImage?.["url"] === "string" && firstImage["url"].length <= 2048
      ? firstImage["url"]
      : undefined;
  if (!content && images.length === 0) return;
  const mentions = [
    ...new Set(
      segments
        .filter((s) => s["type"] === "at")
        .map((s) => qqId(object(s["data"])?.["qq"]))
        .filter((v): v is string => v !== undefined)
    )
  ].slice(0, 16);
  const replyTo = messageHandle(
    object(segments.find((s) => s["type"] === "reply")?.["data"])?.["id"]
  );
  const messageId = messageHandle(e["message_id"]);
  const sequence = qqId(e["message_seq"]);
  const timestamp =
    typeof e["time"] === "number" &&
    Number.isSafeInteger(e["time"]) &&
    e["time"] > 0 &&
    e["time"] < 8640000000000
      ? new Date(e["time"] * 1000).toISOString()
      : undefined;
  const display = info?.["card"] || info?.["nickname"];
  const displayName = typeof display === "string" ? display.slice(0, 256) : undefined;
  const channel = `${namespace}:${kind.toLowerCase()}:${peer}${temporaryGroup ? ":temp:" + temporaryGroup : ""}`;
  const facts = {
    account,
    sender,
    target,
    direction,
    messageId,
    sequence,
    timestamp,
    mentions,
    replyTo,
    imageCount: images.length,
    unknownSegments: segments
      .filter((s) => !["text", "at", "reply", "image"].includes(String(s["type"])))
      .map((s) => s["type"])
  };
  const duplicateKey =
    messageId && sequence && timestamp
      ? createHash("sha256")
          .update(JSON.stringify({ channel, ...facts, segments: e["message"] }))
          .digest("hex")
      : undefined;
  return Object.freeze({
    namespace,
    account,
    sender,
    target,
    channel,
    direction,
    content: content || "[Image attachment]",
    mentions,
    transportFacts: JSON.stringify(facts),
    ...(displayName ? { displayName } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(messageId ? { messageId } : {}),
    ...(sequence ? { sequence } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(imageFile ? { imageFile } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(duplicateKey ? { duplicateKey } : {})
  });
}

export function encodeQQSend(
  target: QQTarget,
  text: string,
  replyTo?: string
): { action: string; params: Record<string, unknown> } {
  return {
    action: target.kind === "GROUP" ? "send_group_msg" : "send_private_msg",
    params: {
      [target.kind === "GROUP" ? "group_id" : "user_id"]: target.peer,
      ...(target.kind === "PRIVATE" && target.temporaryGroup
        ? { group_id: target.temporaryGroup }
        : {}),
      message: [
        ...(replyTo && messageHandle(replyTo) ? [{ type: "reply", data: { id: replyTo } }] : []),
        { type: "text", data: { text } }
      ]
    }
  };
}
