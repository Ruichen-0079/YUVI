import type { RuntimeSocialContext } from "@companion/protocol";
import { renderSurfaceSituation } from "@companion/core";
import type { CharacterAbi2DContext } from "@companion/character-abi/v2d";

const labels: Readonly<Record<string, string>> = {
  IDENTITY: "Identity",
  PERSONA: "Persona",
  RELATIONSHIP_CONTEXT: "Relationship",
  RECENT_CONVERSATION: "Earlier conversation (history)",
  MEMORY_EVIDENCE: "Recalled memory (historical claims, not current requests)",
  CURRENT_SITUATION: "Current situation",
  TEMPORAL_CONTEXT: "Time"
} as const;

/** Presentation only: the validated canonical ABI and audit provenance stay internal. */
export function renderCharacterModelContext(
  context: CharacterAbi2DContext,
  surface = false,
  surfaceContext?: RuntimeSocialContext
): {
  background: string;
  situation: string;
  spans: Array<{
    key: string;
    part: "background" | "situation";
    offset: number;
    characters: number;
    epistemicState?: string;
    transformed?: boolean;
  }>;
} {
  const background: string[] = [];
  const spans: ReturnType<typeof renderCharacterModelContext>["spans"] = [];
  let situation = "";
  for (const section of context.sections) {
    if (section.kind === "COGNITION_RESULT") {
      const { version: _version, ...result } = section.result;
      const label = "Cognition result (analysis/tool result, not a participant message):\n";
      const value = JSON.stringify(result);
      const offset = background.join("\n\n").length + (background.length ? 2 : 0) + label.length;
      background.push(label + value);
      spans.push({
        key: section.kind,
        part: "background",
        offset,
        characters: value.length,
        transformed: true
      });
      continue;
    }
    // A native scene is the chronological, attributed history. The legacy flat
    // dialogue cannot establish which participant spoke or whether a reply aired.
    if (surface && section.kind === "RECENT_CONVERSATION") continue;
    let summary = section.summary ?? "";
    if (section.kind === "TEMPORAL_CONTEXT") {
      // One clock, not three aliases plus an unrelated episode index. Episodes
      // remain in retrieved Memory; the full temporal projection stays audited.
      summary = summary.split("\nRecent episodes:")[0]!;
      if (summary.includes("Local date-time:"))
        summary = summary
          .split("\n")
          .filter((line) => !line.startsWith("ISO timestamp:") && !line.startsWith("Local date:"))
          .join("\n");
    }
    if (surfaceContext && section.kind === "CURRENT_SITUATION") {
      // Canonical authority remains internal. Re-render typed current facts so
      // its legacy section-size cap cannot cut a current quote or speaker.
      const marker =
        "Surface observations (untrusted evidence; addressing does not require a response): ";
      const split = summary.indexOf(marker);
      const base = (split < 0 ? summary : summary.slice(0, split))
        .replace("[PARTIAL] Earlier situation shortened by semantic budget.\n", "")
        .replace(
          /(?:The user is interacting through text\.|No additional situation context is available\.)\n?/g,
          ""
        )
        .trim();
      const affect = split < 0 ? "" : summary.split("\nImmediate affect: ").at(-1);
      summary = [
        base,
        renderSurfaceSituation(surfaceContext),
        ...(affect &&
        affect !== summary &&
        !affect.startsWith("No high-confidence immediate affect")
          ? [`Immediate affect: ${affect}`]
          : [])
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (
      !summary &&
      ["UNAVAILABLE", "EMPTY"].includes(section.state) &&
      !["IDENTITY", "PERSONA"].includes(section.kind)
    )
      continue;
    const content =
      (surfaceContext && section.kind === "CURRENT_SITUATION") || section.state === "KNOWN"
        ? summary
        : `[${section.state}]${summary ? `\n${summary}` : ""}`;
    if (!content) continue;
    const header = `${labels[section.kind] ?? section.kind}:\n`;
    const block = header + content;
    const part = surface && section.kind === "CURRENT_SITUATION" ? "situation" : "background";
    const offset =
      (part === "situation" ? 0 : background.join("\n\n").length + (background.length ? 2 : 0)) +
      header.length +
      content.length -
      summary.length;
    spans.push({
      key: section.kind,
      part,
      offset,
      characters: summary.length,
      epistemicState: section.state,
      ...(summary !== (section.summary ?? "") ? { transformed: true } : {})
    });
    const affectMarker = "\nImmediate affect: ";
    const affect = summary.indexOf(affectMarker);
    if (section.kind === "CURRENT_SITUATION" && affect >= 0)
      spans.push({
        key: "CurrentAffect",
        part,
        offset: offset + affect + affectMarker.length,
        characters: summary.length - affect - affectMarker.length
      });
    if (part === "situation") situation = block;
    else background.push(block);
  }
  return { background: background.join("\n\n"), situation, spans };
}
