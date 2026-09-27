import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getRuntimeEnvDir } from "../env.js";
import { writePrivateJson } from "./product-store.js";
import type { STTOutput } from "@companion/providers";
export type VoiceReview = { id: string; voiceProfileId?: string; createdAt: string; sample: string; leftUnknown?: boolean };
const path = () => {
  const target = join(resolve(process.env["YUVI_RUNTIME_DATA_DIR"] || getRuntimeEnvDir()), "voice-review.json");
  const legacy = join(getRuntimeEnvDir(), "voice-review.json");
  if (legacy !== target && existsSync(legacy)) {
    const old = JSON.parse(readFileSync(legacy, "utf8")) as VoiceReview[];
    const current = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) as VoiceReview[] : [];
    if (!Array.isArray(old) || !Array.isArray(current)) throw new Error("Invalid voice review migration source.");
    const merged = new Map(old.map(row => [row.id, row]));
    for (const row of current) merged.set(row.id, row);
    // Commit DATA before removing CONFIG; retry after interruption is idempotent.
    writePrivateJson(target, [...merged.values()]);
    unlinkSync(legacy);
  }
  return target;
};
export function voiceReviews(): VoiceReview[] {
  try { return JSON.parse(readFileSync(path(), "utf8")) as VoiceReview[]; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("Voice review samples unavailable."); }
}
/** Only PCM WAV excerpts, eight seconds each, thirty entries total. No recording loop or network I/O. */
export function boundedWav(base64: string): Buffer {
  if (base64.length > 24_000_000) throw new Error("Recording too large.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Use PCM WAV audio.");
  let fmt: Buffer | undefined, data: Buffer | undefined;
  for (let pos = 12; pos + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(pos + 4); if (pos + 8 + size > bytes.length) throw new Error("Invalid WAV.");
    const type = bytes.toString("ascii", pos, pos + 4);
    if (type === "fmt ") fmt = bytes.subarray(pos + 8, pos + 8 + size);
    if (type === "data") data = bytes.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size % 2);
  }
  if (!fmt || fmt.length < 16 || !data || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt16LE(14) !== 16 || fmt.readUInt32LE(4) < 8000 || fmt.readUInt32LE(4) > 48000 || fmt.readUInt16LE(12) !== 2 || fmt.readUInt32LE(8) !== fmt.readUInt32LE(4) * 2) throw new Error("Use mono PCM16 WAV (8–48 kHz).");
  data = data.subarray(0, Math.min(data.length - data.length % 2, fmt.readUInt32LE(8) * 8));
  if (data.length < fmt.readUInt32LE(8) / 4) throw new Error("Recording too short.");
  const out = Buffer.alloc(44 + data.length); out.write("RIFF"); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16); fmt.copy(out, 20, 0, 16); out.write("data", 36); out.writeUInt32LE(data.length, 40); data.copy(out, 44); return out;
}
export function retainVoiceSample(base64: string, voiceProfileId?: string): VoiceReview {
  const sample = boundedWav(base64).toString("base64");
  const rows = voiceReviews();
  const existing = voiceProfileId ? rows.find(r => r.voiceProfileId === voiceProfileId) : undefined;
  if (existing) return existing;
  const row = { id: randomUUID(), ...(voiceProfileId ? { voiceProfileId } : {}), createdAt: new Date().toISOString(), sample };
  writePrivateJson(path(), [...rows, row].slice(-30)); return row;
}
export function updateVoiceReview(id: string, update: Partial<Pick<VoiceReview, "voiceProfileId" | "leftUnknown">> | null): boolean {
  const rows = voiceReviews();
  const existed = rows.some(row => row.id === id);
  writePrivateJson(path(), rows.flatMap(r => r.id !== id ? [r] : update ? [{ ...r, ...update }] : []));
  return existed;
}
export function retainSpeechReview(audio: string | undefined, output: STTOutput) {
  if (!audio || new Set(output.segments?.map(s => s.speakerClusterId)).size > 1) return;
  const match = output.voiceProfileMatch ?? (output.segments?.length === 1 ? output.segments[0]?.voiceProfileMatch : undefined);
  if (!match) return; // Only the local acoustic contract can propose review material.
  if (match.status === "NO_MATCH" && voiceReviews().some(r => !r.voiceProfileId && Date.now() - Date.parse(r.createdAt) < 300_000)) return;
  try { retainVoiceSample(audio, match.status === "MATCHED" ? match.voiceProfileId : undefined); } catch { /* Invalid/non-PCM material is never retained. */ }
}
