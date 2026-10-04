import type { SpeechSegmentSeal } from "@companion/protocol";
/**
 * Bounded current-turn buffer for companion speak messages that arrive before
 * the speech session is ready (start-generation race, remount gaps).
 *
 * Only the active requestId is retained. Segments from previous turns are
 * dropped so a late companion mount cannot replay stale speech.
 */

export type BufferedSpeakSegment = {
  seal?: SpeechSegmentSeal;
  requestId: string;
  sequence: number;
  text: string;
  language: string;
};

export type CompanionSpeechBuffer = {
  /** Remember which turn is currently expected to speak. */
  setActiveTurn(requestId: string): void;
  /** Clear turn state and any buffered segments. */
  clear(): void;
  /**
   * Buffer a segment for the active turn. Returns false when the segment is
   * rejected (wrong turn, empty, over capacity, or duplicate sequence).
   */
  push(segment: BufferedSpeakSegment): boolean;
  /** Drain buffered segments for a requestId in ascending sequence order. */
  drain(requestId: string): BufferedSpeakSegment[];
  /** Number of segments currently buffered. */
  size(): number;
  getActiveTurn(): string | null;
};

export const COMPANION_SPEECH_BUFFER_CAPACITY = 32;

export function createCompanionSpeechBuffer(
  capacity = COMPANION_SPEECH_BUFFER_CAPACITY
): CompanionSpeechBuffer {
  let activeRequestId: string | null = null;
  const segments: BufferedSpeakSegment[] = [];
  const seen = new Set<string>();

  return {
    setActiveTurn(requestId) {
      if (activeRequestId === requestId) return;
      activeRequestId = requestId;
      segments.length = 0;
      seen.clear();
    },
    clear() {
      activeRequestId = null;
      segments.length = 0;
      seen.clear();
    },
    push(segment) {
      if (!segment.text.trim()) return false;
      if (activeRequestId !== null && segment.requestId !== activeRequestId) {
        // A new turn replaces the buffer; do not keep foreign segments.
        return false;
      }
      if (activeRequestId === null) {
        activeRequestId = segment.requestId;
      }
      const key = `${segment.requestId}:${segment.sequence}`;
      if (seen.has(key)) return false;
      if (segments.length >= capacity) return false;
      seen.add(key);
      segments.push(segment);
      return true;
    },
    drain(requestId) {
      if (segments.length === 0) return [];
      const matching = segments
        .filter((segment) => segment.requestId === requestId)
        .sort((left, right) => left.sequence - right.sequence);
      // Keep only non-matching (should be empty after setActiveTurn).
      const remaining = segments.filter((segment) => segment.requestId !== requestId);
      segments.length = 0;
      segments.push(...remaining);
      for (const segment of matching) {
        seen.delete(`${segment.requestId}:${segment.sequence}`);
      }
      return matching;
    },
    size() {
      return segments.length;
    },
    getActiveTurn() {
      return activeRequestId;
    }
  };
}
