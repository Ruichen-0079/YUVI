import {
  markdownSpeechProjection,
  sourceProjection,
  replaceProjection,
  sliceProjection,
  trimProjection,
  type SpeechProjection
} from "./speech-projection.js";
/** Convert the rendered Markdown message into conservative speech text. */
export function speechTextFromMarkdown(markdown: string): string {
  return markdownSpeechProjection(markdown).text;
}

/**
 * Emoji and decorative symbols are not speakable and break local GPT-SoVITS
 * (Alice wrapper returns HTTP 503 for wave dash / emoji). Strip or normalize
 * them before synthesis while keeping Japanese/Chinese text and speech
 * punctuation that the backend accepts.
 */
const NON_SPEECH_SYMBOLS =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * Characters that pass letter/punct checks but make Alice/GPT-SoVITS return 503.
 * Confirmed at the 9881 wrapper: wave dash alone is enough to fail synthesis.
 */
const TTS_UNSAFE_ORNAMENTS = /[〜～♪♫★☆♥♡※†‡•]/g;

/** Normalize curly quotes that some TTS frontends reject while keeping meaning. */
const CURLY_QUOTES: Array<[RegExp, string]> = [
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"]
];

export function sanitizeSpeechText(text: string): string {
  return sanitizeProjection(sourceProjection(text)).text;
}

/** Final per-segment cleanup immediately before enqueue / synthesis. */
export function prepareSpeechSegment(text: string): string {
  return prepareProjection(sourceProjection(text)).text;
}

/** True when the segment still has speakable letters or digits after cleanup. */
export function isSpeakableSpeechText(value: string): boolean {
  return /\p{L}|\p{N}/u.test(value);
}

function sanitizeProjection(input: SpeechProjection): SpeechProjection {
  let p = replaceProjection(input, /\r\n?/g, "\n");
  p = replaceProjection(p, NON_SPEECH_SYMBOLS, "");
  p = replaceProjection(p, TTS_UNSAFE_ORNAMENTS, " ");
  for (const [pattern, replacement] of CURLY_QUOTES) p = replaceProjection(p, pattern, replacement);
  p = replaceProjection(p, /[ \t]+/g, " ");
  p = replaceProjection(p, /[ \t]*\n[ \t]*/g, "\n");
  p = replaceProjection(p, /\n{3,}/g, "\n\n");
  p = replaceProjection(p, / {2,}/g, " ");
  return replaceProjection(p, /^[ \t]+|[ \t]+$/g, "");
}
function prepareProjection(input: SpeechProjection): SpeechProjection {
  let p = sanitizeProjection(input);
  p = replaceProjection(p, /\n+/g, " ");
  p = replaceProjection(p, /[ \t]+/g, " ");
  return trimProjection(replaceProjection(p, /^[\s•]+|[\s•]+$/g, ""));
}
/** Same preparation authority, with source origins; never makes segmentation decisions. */
export function sealedSpeechProjection(
  markdown: string,
  start: number,
  end: number
): SpeechProjection {
  return prepareProjection(sliceProjection(speechProjection(markdown), start, end));
}

export function speechProjection(markdown: string): SpeechProjection {
  return sanitizeProjection(markdownSpeechProjection(markdown));
}
