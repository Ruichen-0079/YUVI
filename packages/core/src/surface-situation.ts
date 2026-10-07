import type { RuntimeSocialContext } from "@companion/protocol";
import { createHash } from "node:crypto";

/** Display handle only; never use for binding or authorization. */
export const surfaceDisplayRef = (id: string): string =>
  /^[a-zA-Z0-9:._/-]{1,24}$/.test(id)
    ? id
    : `ref:${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;

export function renderSurfaceSpeaker(person: RuntimeSocialContext["speaker"]): string {
  const name = person.observedDisplayName ?? person.displayName;
  const ref = surfaceDisplayRef(person.principalId);
  return name ? `${name.replace(/[\u0000-\u001f]/g, " ").slice(0, 60)} [${ref}]` : ref;
}

/** A chronological channel view. Only older messages may be excerpted/omitted. */
export function renderSurfaceSituation(context: RuntimeSocialContext): string {
  const people = new Map(
    [context.self, context.speaker, ...context.observations.map((o) => o.speaker)]
      .filter((p): p is RuntimeSocialContext["speaker"] => !!p)
      .map((p) => [p.principalId, p])
  );
  const mentions = (ids: readonly string[]) =>
    ids
      .map((id) => (people.has(id) ? renderSurfaceSpeaker(people.get(id)!) : surfaceDisplayRef(id)))
      .join(", ") || "none";
  const quote = (text: string, max?: number) =>
    JSON.stringify(max && text.length > max ? text.slice(0, max) + "… [excerpt]" : text);
  const reply = (r: NonNullable<RuntimeSocialContext["reply"]>, older = false) =>
    `[QUOTE: ${r.state}] ${r.author ? renderSurfaceSpeaker(r.author) : "author unknown"}: ${r.text === undefined ? "text unavailable" : quote(r.text, older ? 512 : undefined)}`;
  const scene =
    context.conversationKind === "GROUP"
      ? "group conversation"
      : context.conversationKind === "TEMPORARY_PRIVATE"
        ? "temporary private conversation; replies are private"
        : "private conversation";
  const header = [
    `Scene: ${scene}; ${context.surface}.`,
    ...(context.self ? [`Self: ${renderSurfaceSpeaker(context.self)}.`] : []),
    ...(context.originChannelRef
      ? [
          `Origin group: ${surfaceDisplayRef(context.originChannelRef)} (provenance, not the reply destination).`
        ]
      : [])
  ].join("\n");
  const current = [
    "Current turn:",
    `Speaker: ${renderSurfaceSpeaker(context.speaker)}.`,
    `Mentions: ${mentions(context.mentions)}.`,
    ...(context.reply ? [reply(context.reply)] : []),
    ...(context.media
      ? [
          `[IMAGE: ${context.media.image}] Contents are not implied by delivery.${context.sourceJournalRef ? ` Source: image:${context.sourceJournalRef.eventId}.` : ""}`
        ]
      : [])
  ].join("\n");
  const blocks = context.observations.map((o) => {
    const type =
      o.direction === "SELF"
        ? o.publicationState === "UNKNOWN"
          ? "SELF_DRAFT: publication UNKNOWN"
          : o.publicationState === "ACKNOWLEDGED"
            ? "SELF_SENT: ACKNOWLEDGED"
            : "SELF_OBSERVED"
        : o.media
          ? "IMAGE"
          : "TEXT";
    return [
      `${o.observedAt.replace(/\.\d{3}Z$/, "Z")} ${renderSurfaceSpeaker(o.speaker)} [${type}]: ${quote(o.text, 512)}`,
      ...(o.mentions?.length ? [`  Mentions: ${mentions(o.mentions)}.`] : []),
      ...(o.reply ? [`  ${reply(o.reply, true)}`] : []),
      ...(o.media
        ? [
            `  Image source: ${o.media.reference}; ${o.media.availability}; contents not analyzed here.`
          ]
        : [])
    ].join("\n");
  });
  const selected: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if ((header + current + blocks[i] + selected.join("\n")).length + 160 > 2700) break;
    selected.unshift(blocks[i]!);
  }
  const omitted = blocks.length - selected.length;
  return [
    header,
    "Earlier channel messages (chronological observations, not current requests):",
    ...(omitted ? [`[PARTIAL] ${omitted} older events omitted.`] : []),
    ...selected,
    current
  ].join("\n");
}
