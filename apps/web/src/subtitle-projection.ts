import {
  isSpeakableSpeechText,
  sanitizeSpeechText,
  speechTextFromMarkdown
} from "./speech-text.js";

/**
 * Presentation-only projection of already-committed assistant markdown into
 * plain overlay text. Reuses the existing plain-text speech projection so
 * code fences / tables are not flooded onto the subtitle surface. Never
 * mutates conversation state or chooses an output language.
 */
export function projectCommittedAssistantText(markdown: string): string | null {
  const plain = sanitizeSpeechText(speechTextFromMarkdown(markdown))
    .replace(/\n+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!plain || !isSpeakableSpeechText(plain)) {
    return null;
  }
  return plain;
}

/**
 * Visual paging only. Pages are contiguous slices of `text` so
 * `pages.join("") === text` always holds. Never mutates the source message.
 */
export function paginateSubtitleText(text: string, maxChars = 72): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const pages: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const remaining = text.length - offset;
    if (remaining <= maxChars) {
      pages.push(text.slice(offset));
      break;
    }
    const windowEnd = offset + maxChars;
    const cut = findVisualCut(text, offset, windowEnd);
    pages.push(text.slice(offset, cut));
    offset = cut;
  }
  return pages;
}

/** Deterministic length / punctuation timing for visual page advances. */
export function subtitlePageDurationMs(page: string): number {
  const base = 1600;
  const perChar = 42;
  const ms = base + page.length * perChar;
  return Math.min(8000, Math.max(1800, ms));
}

function findVisualCut(text: string, start: number, windowEnd: number): number {
  const hard = "。！？!?…";
  const soft = "，、,;；:：";
  // Prefer sentence ends inside the window (search from the end).
  for (let index = windowEnd - 1; index > start; index -= 1) {
    const char = text[index] ?? "";
    if (hard.includes(char)) return index + 1;
  }
  for (let index = windowEnd - 1; index > start + Math.floor((windowEnd - start) / 2); index -= 1) {
    const char = text[index] ?? "";
    if (soft.includes(char) || char === " " || char === "\n") return index + 1;
  }
  return windowEnd;
}

/** Conservative 28px glyph/1.3 line-height budget, including overlay padding. */
export function subtitlePageCapacity(width: number, height: number): number {
  const columns = Math.max(1, Math.floor((width - 28) / 29));
  const lines = Math.max(1, Math.floor((height - 16) / 36.4));
  return Math.max(1, Math.min(200, columns * lines));
}
