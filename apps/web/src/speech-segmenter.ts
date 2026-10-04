import {
  isSpeakableSpeechText,
  prepareSpeechSegment,
  sanitizeSpeechText,
  speechTextFromMarkdown
} from "./speech-text.js";

export type SpeechFlushReason = "completed" | "cancelled" | "failed";

/**
 * Realtime queue feedback consulted on every delta. `undefined` (no provider,
 * or a transient read failure) falls back to the latency-safe strong-boundary
 * behavior, which is also the correct policy while the pipeline is healthy.
 */
export type SpeechPipelineSnapshot = {
  playing: boolean;
  synthesizing: boolean;
  playbackEnded: number;
};

export type SpeechReleaseReason =
  | "FIRST_STRONG"
  | "FIRST_MERGED"
  | "STRONG_BOUNDARY"
  | "STARVING_SOFT_BOUNDARY"
  | "EMERGENCY_BOUND"
  | "FINAL_FLUSH";

export type SpeechSegmenterOptions = {
  minChars?: number;
  maxChars?: number;
  /** Reads the current playback/synthesis state for the active turn. */
  pipeline?: () => SpeechPipelineSnapshot | undefined;
  /** Optional release observer for tests and passive live instrumentation. */
  onRelease?: (segment: string, reason: SpeechReleaseReason) => void;
};

type BoundaryKind = "strong" | "starving-soft" | "emergency";

/**
 * Incremental speech segmenter — the single speech segmentation authority.
 *
 * Conservation is of prepared speakable content, not byte-exact concatenation
 * of raw committed Markdown. Deltas accumulate as contiguous source, then
 * sanitize/prepare may normalize segment-boundary whitespace. Speakable
 * letters, digits and punctuation must not be missing or duplicated.
 *
 * - Does not finalize sanitize on every SSE delta alone; pending accumulates.
 * - Consumed body is sliced away so it is never re-emitted.
 * - completed flushes the remaining tail once.
 * - Each emitted segment is re-run through prepareSpeechSegment and is a
 *   single trimmed speakable line.
 *
 * Release urgency is queue-aware: the first meaningful strong boundary is
 * released immediately, strong boundaries always win, and an already-arrived
 * soft boundary may only be spoken when playback has demonstrably run dry
 * (starving) so a starving synthesizer gets work without degrading prosody
 * while audio is still playing.
 */
export class SpeechSegmenter {
  private pending = "";
  private markdown = "";
  private consumed = 0;
  private finished = false;
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly pipeline: (() => SpeechPipelineSnapshot | undefined) | null;
  private readonly onRelease: ((segment: string, reason: SpeechReleaseReason) => void) | null;
  private released = 0;
  readonly sealedSegments: Array<{ text: string; preparedStart: number; preparedEnd: number }> = [];

  constructor(options: SpeechSegmenterOptions = {}) {
    this.minChars = options.minChars ?? 8;
    this.maxChars = options.maxChars ?? 180;
    this.pipeline = options.pipeline ?? null;
    this.onRelease = options.onRelease ?? null;
  }

  push(markdownDelta: string): string[] {
    this.sealedSegments.length = 0;
    if (this.finished) return [];
    // Deltas are contiguous substrings, not words. Normalize the accumulated
    // Markdown so whitespace, split formatting, punctuation and UTF-16 pairs
    // have the same meaning regardless of the provider's frame boundaries.
    this.markdown += markdownDelta;
    this.project(false);
    return this.drain(false);
  }

  flush(reason: SpeechFlushReason): string[] {
    this.sealedSegments.length = 0;
    if (this.finished) return [];
    this.finished = true;
    this.project(true);
    if (reason === "cancelled") {
      this.pending = "";
      return [];
    }
    if (reason === "failed" && !/[。！？!?…\.]\s*$/.test(this.pending)) {
      this.pending = "";
      return [];
    }
    return this.drain(true);
  }

  private project(final: boolean): void {
    const markdown = final ? this.markdown : stableMarkdownPrefix(this.markdown);
    const normalized = sanitizeSpeechText(speechTextFromMarkdown(markdown));
    this.pending = normalized.slice(this.consumed);
  }

  reset(): void {
    this.pending = "";
    this.markdown = "";
    this.consumed = 0;
    this.finished = false;
    this.released = 0;
  }

  private readPipeline(): SpeechPipelineSnapshot | undefined {
    if (!this.pipeline) return undefined;
    try {
      return this.pipeline();
    } catch {
      return undefined;
    }
  }

  /**
   * Starving means speech was already released, everything released has
   * finished playing, nothing is audible and no future audio is being
   * synthesized. Only then may an already-arrived soft boundary be spoken.
   */
  private isStarving(): boolean {
    if (this.released === 0) return false;
    const snapshot = this.readPipeline();
    if (!snapshot) return false;
    if (snapshot.playing || snapshot.synthesizing) return false;
    return snapshot.playbackEnded >= this.released;
  }

  private drain(force: boolean): string[] {
    const cuts: Array<{
      segment: string;
      reason: SpeechReleaseReason;
      preparedStart: number;
      preparedEnd: number;
    }> = [];
    while (
      this.pending.length > 0 &&
      (this.pending.length >= this.minChars || force || hasNaturalBoundary(this.pending))
    ) {
      const starving = cuts.length === 0 && this.isStarving();
      const boundary = findBoundary(this.pending, this.minChars, this.maxChars, force, starving);
      if (boundary.index < 0) break;
      let kind: BoundaryKind | "final" | "first" | "first-merged" = boundary.kind;
      let end = boundary.index;
      if (!isSpeakableSpeechText(this.pending.slice(end))) {
        if (!force) break;
        end = this.pending.length;
      }
      if (force && end >= this.pending.length) {
        kind = "final";
      } else if (kind === "strong" && this.released + cuts.length === 0) {
        const merged = mergeTinyCjkFirstSegment(this.pending, end, this.minChars, this.maxChars);
        end = merged.end;
        kind = merged.merged ? "first-merged" : "first";
      }
      const segment = this.pending.slice(0, end).trim();
      if (isSpeakableSpeechText(segment)) {
        cuts.push({
          segment,
          reason: releaseReason(kind),
          preparedStart: this.consumed,
          preparedEnd: this.consumed + end
        });
      }
      this.consumed += end;
      this.pending = this.pending.slice(end);
    }
    const emitted: string[] = [];
    for (const cut of cuts) {
      const prepared = prepareSpeechSegment(cut.segment);
      if (!isSpeakableSpeechText(prepared)) continue;
      this.sealedSegments.push({
        text: prepared,
        preparedStart: cut.preparedStart,
        preparedEnd: cut.preparedEnd
      });
      this.released += 1;
      this.onRelease?.(prepared, cut.reason);
      emitted.push(prepared);
    }
    return emitted;
  }
}

function releaseReason(
  kind: BoundaryKind | "first" | "first-merged" | "final"
): SpeechReleaseReason {
  switch (kind) {
    case "first":
      return "FIRST_STRONG";
    case "first-merged":
      return "FIRST_MERGED";
    case "strong":
      return "STRONG_BOUNDARY";
    case "starving-soft":
      return "STARVING_SOFT_BOUNDARY";
    case "emergency":
      return "EMERGENCY_BOUND";
    case "final":
      return "FINAL_FLUSH";
  }
}

/**
 * The first segment is latency-biased: one natural, meaningful stable unit
 * goes out immediately. Only an absurdly tiny CJK conversational fragment
 * (嗯。 / 对。 / 是的。) may absorb the next sentence, and only when that next
 * strong boundary is already available in the buffer — never by waiting.
 */
function mergeTinyCjkFirstSegment(
  pending: string,
  end: number,
  minChars: number,
  maxChars: number
): { end: number; merged: boolean } {
  let merged = false;
  let current = end;
  while (isTinyCjkFragment(pending.slice(0, current))) {
    const rest = pending.slice(current);
    if (!rest) break;
    const next = findBoundary(rest, minChars, maxChars, false, false);
    if (next.index < 0) break;
    const candidate = current + next.index;
    if (candidate > maxChars) break;
    current = candidate;
    merged = true;
  }
  return { end: current, merged };
}

/** 嗯 / 对 / 是的 — one absurdly tiny CJK interjection sentence. */
function isTinyCjkFragment(value: string): boolean {
  const core = (value.match(/[\p{L}\p{N}]/gu) ?? []).join("");
  return /^[\u4e00-\u9fff\u3040-\u30ff]{1,2}$/.test(core);
}

/**
 * English sentence end: `.` / `!` / `?` / `…`, CJK terminals, newlines, then —
 * only when explicitly allowed (starving) or near the emergency length cap —
 * soft punctuation, then a safe hard cut.
 */
function findBoundary(
  value: string,
  minChars: number,
  maxChars: number,
  force = false,
  allowSoftCut = false
): { index: number; kind: BoundaryKind | "final" } {
  const limit = Math.min(value.length, maxChars);

  // Prefer true sentence / paragraph ends anywhere in the visible window so
  // short openers such as "Hello." are not held behind minChars.
  for (let index = 0; index < limit; index += 1) {
    const char = value[index] ?? "";
    // A leading punctuation fragment belongs to the next speakable body;
    // consuming it on its own would drop a provider delta after a release.
    if (!isSpeakableSpeechText(value.slice(0, index + 1))) continue;
    if ("。！？!?…".includes(char)) return strongBoundary(value, index + 1, force);
    if (char === "\n" && index > 0) return strongBoundary(value, index + 1, force);
    if (char === "." && isEnglishSentenceEnd(value, index)) {
      return strongBoundary(value, index + 1, force);
    }
  }

  if (value.length >= maxChars) {
    // Emergency bound: recent soft punctuation , ; : — - then hard cut.
    for (let index = limit - 1; index >= Math.max(0, minChars - 1); index -= 1) {
      if (isSoftBoundaryChar(value, index)) return { index: index + 1, kind: "emergency" };
    }
    // Space fallback already covered; hard cut last (surrogate-pair safe).
    return { index: safeHardCutIndex(value, limit), kind: "emergency" };
  }
  if (allowSoftCut) {
    // Playback has run dry: the most recent good soft boundary becomes an
    // acceptable cut so a starving synthesizer gets work immediately.
    for (let index = limit - 1; index >= Math.max(0, minChars - 1); index -= 1) {
      if (isSoftBoundaryChar(value, index)) return { index: index + 1, kind: "starving-soft" };
    }
  }
  if (force) return { index: safeHardCutIndex(value, limit), kind: "final" };
  return { index: -1, kind: "strong" };
}

/** True when `value[index]` is a soft boundary that is safe to cut after. */
function isSoftBoundaryChar(value: string, index: number): boolean {
  const char = value[index] ?? "";
  if (!"、，,;:；—–- \n".includes(char)) return false;
  // Never cut a numeric group like "1,000" in half.
  const prev = value[index - 1] ?? "";
  const next = value[index + 1] ?? "";
  if (/\d/.test(prev) && /\d/.test(next)) return false;
  return true;
}

/** Back off one code unit so a hard cut never splits a surrogate pair. */
function safeHardCutIndex(value: string, limit: number): number {
  if (limit > 0 && limit < value.length) {
    const prev = value.charCodeAt(limit - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) return limit - 1;
  }
  return limit;
}

/** True when `.` ends a sentence rather than an abbreviation or decimal. */
function isEnglishSentenceEnd(value: string, index: number): boolean {
  const next = value[index + 1] ?? "";
  if (!(next === "" || /\s/.test(next))) return false;

  // Decimal / version: "2.5" or "v2.0"
  const prev = value[index - 1] ?? "";
  const nextNonSpace = value.slice(index + 1).match(/\S/)?.[0] ?? "";
  if (/\d/.test(prev) && /\d/.test(nextNonSpace)) return false;

  // Common abbreviations: Dr. Mr. Mrs. Ms. Prof. Sr. Jr. etc.
  const before = value.slice(0, index);
  if (/(?:^|[\s("'])(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|vs|etc|e\.g|i\.e)$/i.test(before)) {
    return false;
  }
  return true;
}

/** A terminal punctuation run belongs to its sentence, even across deltas. */
function strongBoundary(
  value: string,
  index: number,
  force: boolean
): { index: number; kind: "strong" } {
  let end = index;
  while (end < value.length && /[\p{P}\p{Z}\s]/u.test(value[end] ?? "")) end += 1;
  // One textual lookahead (or final flush), never a timer. Otherwise a late
  // punctuation-only delta cannot be added to an already-submitted request.
  if (!force && !isSpeakableSpeechText(value.slice(end))) return { index: -1, kind: "strong" };
  // Leave whitespace pending; final segment preparation trims it, and it may
  // still be extended by the next provider frame.
  return { index: value.slice(0, end).trimEnd().length, kind: "strong" };
}

/** Hold incomplete inline Markdown whose completion could rewrite speech. */
function stableMarkdownPrefix(markdown: string): string {
  let end = markdown.length;
  if (/[\uD800-\uDBFF]$/.test(markdown)) end -= 1;
  const brackets: number[] = [];
  for (let index = 0; index < end; index += 1) {
    if (markdown[index] === "[" && markdown[index - 1] !== "\\") brackets.push(index);
    if (markdown[index] === "]" && brackets.length) {
      const open = brackets.pop()!;
      if (index + 1 === end) return markdown.slice(0, open);
      if (markdown[index + 1] === "(") {
        const close = markdown.indexOf(")", index + 2);
        if (close < 0) return markdown.slice(0, open);
        index = close;
      }
    }
  }
  if (brackets.length) end = Math.min(end, brackets[0]!);
  const tag = markdown.lastIndexOf("<", end - 1);
  if (tag >= 0 && markdown.indexOf(">", tag) < 0) end = Math.min(end, tag);
  return markdown.slice(0, end);
}

function hasNaturalBoundary(value: string): boolean {
  if (/[。！？!?…\n]/.test(value)) return true;
  // English period that is a real sentence end (not Dr. / 2.5).
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "." && isEnglishSentenceEnd(value, index)) return true;
  }
  return false;
}
