/** Origin intervals are UTF-16 offsets in the retained, concatenated source. */
export type SpeechProjection = { text: string; origins: Array<{ start: number; end: number }> };
export function sourceProjection(text: string): SpeechProjection {
  return {
    text,
    origins: Array.from({ length: text.length }, (_, start) => ({ start, end: start + 1 }))
  };
}
export function sliceProjection(
  p: SpeechProjection,
  start: number,
  end = p.text.length
): SpeechProjection {
  return { text: p.text.slice(start, end), origins: p.origins.slice(start, end) };
}
export function replaceProjection(
  p: SpeechProjection,
  re: RegExp,
  replacement: string | { group: number }
): SpeechProjection {
  const text: string[] = [],
    origins: SpeechProjection["origins"] = [];
  let cursor = 0;
  for (const match of p.text.matchAll(
    new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
  )) {
    const index = match.index!;
    text.push(p.text.slice(cursor, index));
    origins.push(...p.origins.slice(cursor, index));
    if (typeof replacement !== "string") {
      const group = match[replacement.group] ?? "",
        start = index + match[0].indexOf(group);
      text.push(group);
      origins.push(...p.origins.slice(start, start + group.length));
    } else {
      text.push(replacement);
      const span = {
        start: p.origins[index]?.start ?? 0,
        end: p.origins[index + match[0].length - 1]?.end ?? 0
      };
      for (let i = 0; i < replacement.length; i++) origins.push(span);
    }
    cursor = index + match[0].length;
  }
  text.push(p.text.slice(cursor));
  origins.push(...p.origins.slice(cursor));
  return { text: text.join(""), origins };
}
export function trimProjection(p: SpeechProjection): SpeechProjection {
  const start = p.text.length - p.text.trimStart().length;
  return sliceProjection(p, start, start + p.text.trim().length);
}
export function markdownSpeechProjection(markdown: string): SpeechProjection {
  const normalized = replaceProjection(sourceProjection(markdown), /\r\n?/g, "\n"),
    output: SpeechProjection[] = [];
  let inFence = false,
    cursor = 0;
  for (const line of normalized.text.split("\n")) {
    let p = sliceProjection(normalized, cursor, cursor + line.length);
    cursor += line.length + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) continue;
    p = replaceProjection(p, /!\[([^\]]*)\]\([^)]*\)/g, { group: 1 });
    p = replaceProjection(p, /\[([^\]]+)\]\([^)]*\)/g, { group: 1 });
    for (const re of [
      /^\s{0,3}#{1,6}\s+/g,
      /^\s*>\s?/g,
      /^\s*(?:[-+*]|\d+[.)])\s+/g,
      /<[^>]+>/g,
      /(```?|\*\*|__|~~)/g
    ])
      p = replaceProjection(p, re, "");
    p = replaceProjection(p, /\|/g, " ");
    p = replaceProjection(p, /[ \t]+/g, " ");
    output.push(trimProjection(p));
  }
  let p: SpeechProjection = { text: "", origins: [] };
  for (const line of output) {
    if (p.text || p.origins.length || line !== output[0]) {
      const start = p.origins.at(-1)?.end ?? line.origins[0]?.start ?? 0;
      p.text += "\n";
      p.origins.push({ start, end: start + 1 });
    }
    p.text += line.text;
    p.origins.push(...line.origins);
  }
  p = replaceProjection(p, /\n{3,}/g, "\n\n");
  return replaceProjection(p, /[ \t]+/g, " ");
}
