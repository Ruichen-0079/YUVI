import { describe, expect, it } from "vitest";
import { decodeQQPacket, encodeQQSend, messageHandle, qqId } from "./qq-codec.js";
import { wire } from "./qq-fixture.js";
describe("QQ codec contract", () => {
  it("separates canonical UIN, signed local handle and display metadata", () => {
    expect(qqId("0007")).toBe("7");
    expect(qqId(-7)).toBeUndefined();
    expect(qqId(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(messageHandle(-12)).toBe("-12");
    expect(messageHandle(2147483648)).toBeUndefined();
    const p = decodeQQPacket(wire(), "42", "qq:test:42")!;
    expect(p).toMatchObject({
      sender: "7",
      messageId: "-12",
      target: { kind: "GROUP", peer: "99" },
      displayName: "observed card",
      channel: "qq:test:42:group:99"
    });
    expect(p.transportFacts).not.toContain("observed card");
    expect(decodeQQPacket(wire({ sender: { user_id: 8 } }), "42", "ns")).toBeUndefined();
    expect(decodeQQPacket(wire({ self_id: 43 }), "42", "ns")).toBeUndefined();
  });
  it("keeps temporary-private provenance and sends to the user with source-group routing", () => {
    const p = decodeQQPacket(
      wire({
        message_type: "private",
        sub_type: "group",
        sender: { user_id: 7, group_id: 99 },
        group_id: 100
      }),
      "42",
      "ns"
    )!;
    expect(p.channel).toBe("ns:private:7:temp:99");
    expect(encodeQQSend(p.target, "answer")).toMatchObject({
      action: "send_private_msg",
      params: { user_id: "7", group_id: "99" }
    });
    expect(
      decodeQQPacket(wire({ message_type: "private", sub_type: "group" }), "42", "ns")
    ).toBeUndefined();
  });
  it("normalizes synthetic self echo to Alice while preserving the private destination", () => {
    const p = decodeQQPacket(
      wire({
        post_type: "message_sent",
        user_id: 42,
        sender: { user_id: 42 },
        target_id: 7,
        message_type: "private"
      }),
      "42",
      "ns"
    )!;
    expect(p).toMatchObject({
      direction: "SELF",
      sender: "42",
      target: { kind: "PRIVATE", peer: "7" }
    });
  });
  it("carries mentions, quotes and image-only attachments without manufacturing text turns", () => {
    const p = decodeQQPacket(
      wire({
        message: [
          { type: "at", data: { qq: "42" } },
          { type: "reply", data: { id: -12 } },
          { type: "image", data: { file: "image-key" } }
        ]
      }),
      "42",
      "ns"
    )!;
    expect(p).toMatchObject({
      mentions: ["42"],
      replyTo: "-12",
      imageFile: "image-key",
      content: "[Image attachment]"
    });
    expect(encodeQQSend(p.target, "reply", p.messageId).params["message"]).toEqual([
      { type: "reply", data: { id: "-12" } },
      { type: "text", data: { text: "reply" } }
    ]);
  });
  it("does not equate collision-prone IDs with durable duplicate identity", () => {
    const a = decodeQQPacket(wire(), "42", "ns")!,
      b = decodeQQPacket(
        wire({ message: [{ type: "text", data: { text: "different" } }] }),
        "42",
        "ns"
      )!;
    expect(a.messageId).toBe(b.messageId);
    expect(a.duplicateKey).not.toBe(b.duplicateKey);
    expect(
      decodeQQPacket(wire({ message_seq: undefined }), "42", "ns")!.duplicateKey
    ).toBeUndefined();
  });
});
