import { describe, expect, it } from "vitest";
import { RuntimeSocialContextSchema } from "@companion/protocol";
import { renderSurfaceSituation } from "./surface-situation.js";
describe("generic model-facing surface situation", () => {
  it("attention admission does not claim a mention or dictate a response", () => {
    const context = RuntimeSocialContextSchema.parse({
      surface: "qq",
      channelRef: "group",
      conversationKind: "GROUP",
      speaker: { principalId: "other" },
      admission: "ATTENTION",
      mentions: [],
      observations: []
    });
    const rendered = renderSurfaceSituation(context);
    expect(rendered).toContain("Current admission: ATTENTION");
    expect(rendered).toContain("does not establish direct addressing");
    expect(rendered).toContain("silence is allowed");
    expect(rendered).toContain("Current mentions: []");
  });
  it("keeps uncertain own drafts distinct from acknowledged speech and compacts repeated transport namespaces", () => {
    const actor = "transport:deployment:" + "x".repeat(160);
    const rendered = renderSurfaceSituation(
      RuntimeSocialContextSchema.parse({
        surface: "matrix",
        channelRef: actor + ":channel",
        conversationKind: "GROUP",
        speaker: { principalId: actor + ":other" },
        self: { principalId: actor + ":self", displayName: "Alice" },
        admission: "MENTION",
        mentions: [actor + ":self"],
        observations: [
          {
            speaker: { principalId: actor + ":self", displayName: "Alice" },
            direction: "SELF",
            interactionKind: "SELF_EXPRESSION",
            publicationState: "UNKNOWN",
            text: "unconfirmed answer",
            sourceJournalRef: {
              kind: "JOURNAL_EVENT",
              namespace: "test",
              eventId: "jev1_0000000000000001"
            },
            observedAt: "2026-10-07T00:00:00.000Z"
          }
        ]
      })
    );
    expect(rendered).toContain("publication UNKNOWN, do not assume others heard");
    expect(rendered).not.toContain('said "unconfirmed answer"');
    expect(rendered).not.toContain("x".repeat(160));
    const selfRef = JSON.parse(rendered.split("Your identity: ")[1]!.split(". SELF")[0]!).principal;
    expect(rendered).toContain('Current mentions: ["' + selfRef + '"]');
  });
  it("budgets whole observation events, retaining the newest image and marking omitted older events", () => {
    const context = RuntimeSocialContextSchema.parse({
      surface: "matrix",
      channelRef: "room",
      conversationKind: "GROUP",
      speaker: { principalId: "b" },
      self: { principalId: "self", displayName: "Alice" },
      admission: "MENTION",
      mentions: ["self"],
      observations: Array.from({ length: 12 }, (_, i) => ({
        speaker: { principalId: "actor:" + i, displayName: "speaker " + i },
        text: "long earlier message ".repeat(190),
        observedAt: "2026-10-07T00:00:00.000Z",
        sourceJournalRef: {
          kind: "JOURNAL_EVENT",
          namespace: "test",
          eventId: "jev1_" + String(i).padStart(16, "0")
        },
        ...(i === 11
          ? { media: { kind: "IMAGE", reference: "image:latest", availability: "RETRIEVABLE" } }
          : {})
      }))
    });
    const rendered = renderSurfaceSituation(context);
    expect(rendered.length).toBeLessThan(2800);
    expect(rendered).toContain("[PARTIAL]");
    expect(rendered).toContain("image:latest");
    expect(rendered).toContain("speaker 11");
    expect(rendered).not.toContain("speaker 0");
  });
  it("preserves speakers, self expressions, mentions, quotes, media availability and temporary-private provenance in one coherent scene", () => {
    const self = { principalId: "matrix:self", displayName: "Alice" },
      other = { principalId: "matrix:b", observedDisplayName: "B" };
    const text = renderSurfaceSituation(
      RuntimeSocialContextSchema.parse({
        surface: "matrix",
        channelRef: "matrix:private:b",
        conversationKind: "TEMPORARY_PRIVATE",
        originChannelRef: "matrix:room",
        self,
        speaker: other,
        admission: "PRIVATE",
        mentions: [self.principalId],
        reply: {
          reference: "message:1",
          state: "OBSERVED",
          author: self,
          text: "my earlier answer"
        },
        observations: [
          {
            speaker: self,
            direction: "SELF",
            text: "my earlier answer",
            observedAt: "2026-10-07T00:00:00.000Z",
            sourceJournalRef: {
              kind: "JOURNAL_EVENT",
              namespace: "test",
              eventId: "jev1_0000000000000001"
            }
          },
          {
            speaker: other,
            direction: "OTHER",
            text: "a diagram",
            mentions: [self.principalId],
            reply: {
              reference: "message:1",
              state: "OBSERVED",
              author: self,
              text: "my earlier answer"
            },
            media: { kind: "IMAGE", reference: "image:b", availability: "RETRIEVABLE" },
            observedAt: "2026-10-07T00:00:01.000Z",
            sourceJournalRef: {
              kind: "JOURNAL_EVENT",
              namespace: "test",
              eventId: "jev1_0000000000000002"
            }
          }
        ]
      })
    );
    for (const expected of [
      "temporary private",
      "replies are private",
      "not the reply destination",
      "SELF",
      "ambient context",
      "matrix:b",
      "Mentions in this event",
      "Referenced speaker",
      "image:b",
      "RETRIEVABLE",
      "not a text description"
    ])
      expect(text).toContain(expected);
    expect(text.indexOf("0000000000000001")).toBeLessThan(text.indexOf("0000000000000002"));
  });
});
