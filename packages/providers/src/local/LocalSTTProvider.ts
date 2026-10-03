import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderCallOptions, ProviderHealth } from "../types/common.js";
import { ProviderError, ProviderErrorCode } from "../types/errors.js";
import { createTransportAbort } from "../transport-abort.js";
import type {
  STTInput,
  STTOutput,
  STTSegment,
  STTProvider,
  VoiceActivityInput,
  VoiceActivityOutput,
  VoiceProfileMatch,
  VoiceProfileProvider,
  VoiceProfileNativeCommand,
  VoiceProfileNativeCommandResult
} from "../types/stt.js";

export type LocalSTTProviderOptions = {
  baseUrl: string;
  /** Packaged, read-only metadata path supplied by Supervisor; never reads vectors. */
  speakerMetadataPath?: string;
  model: string;
  timeoutMs?: number | undefined;
};

/** HTTP adapter for an external local CPU STT sidecar. It owns no process. */
export class LocalSTTProvider implements STTProvider {
  readonly name = "local";

  private async readAuthorityState(): Promise<{
    complete: boolean;
    revision: string | null;
    profiles: Array<{ voiceProfileId: string; label: string }>;
    cleanupPending?: boolean;
  }> {
    if (this.options.speakerMetadataPath) {
      if (!isAbsolute(this.options.speakerMetadataPath)) throw new Error("Speaker metadata path must be absolute.");
      try {
        let body = JSON.parse(await readFile(this.options.speakerMetadataPath, "utf8")) as {
          speakers?: Array<{ speakerId: string; label: string }>;
          revision?: unknown;
          complete?: unknown;
          cleanupPending?: unknown;
          version?: unknown;
          generation?: unknown;
          metadataFile?: unknown;
          metadataSha256?: unknown;
        };
        if (body.version === 1) {
          if (typeof body.generation !== "string" || !/^generation-[a-f0-9]{32}$/.test(body.generation) ||
              body.metadataFile !== "speakers.json" || typeof body.metadataSha256 !== "string")
            throw new Error("Invalid speaker generation manifest.");
          const metadataPath = join(dirname(this.options.speakerMetadataPath), body.generation, body.metadataFile);
          const metadataText = await readFile(metadataPath, "utf8");
          if (createHash("sha256").update(metadataText).digest("hex") !== body.metadataSha256)
            throw new Error("Speaker generation metadata digest mismatch.");
          body = { ...JSON.parse(metadataText) as typeof body, revision: body.revision, complete: true };
        }
        if (!Array.isArray(body.speakers) || body.speakers.some(p => typeof p.speakerId !== "string" || typeof p.label !== "string"))
          throw new Error("Invalid speaker metadata.");
        return {
          complete: body.complete !== false,
          revision: typeof body.revision === "string" ? body.revision : null,
          profiles: body.speakers.map(p => ({ voiceProfileId: p.speakerId, label: p.label }))
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { complete: true, revision: null, profiles: [] };
        throw error;
      }
    }
    const body = (await this.profileRequest("/speakers")) as {
      speakers: Array<{ speakerId: string; label: string }>;
      revision?: string | null;
          complete?: boolean;
      cleanupPending?: boolean;
    };
    if (!Array.isArray(body.speakers) || body.speakers.some(p => typeof p.speakerId !== "string" || typeof p.label !== "string"))
      throw new Error("Invalid speaker metadata.");
    return {
      complete: body.complete === true,
      revision: typeof body.revision === "string" ? body.revision : null,
      ...(typeof body.cleanupPending === "boolean" ? { cleanupPending: body.cleanupPending } : {}),
      profiles: body.speakers.map(record => ({ voiceProfileId: record.speakerId, label: record.label }))
    };
  }

  readonly voiceProfiles: VoiceProfileProvider = {
    list: async () => (await this.readAuthorityState()).profiles,
    readAuthorityState: () => this.readAuthorityState(),
    enroll: async (input) => {
      const body = (await this.profileRequest("/speakers", "POST", {
        voiceProfileId: input.voiceProfileId,
        label: input.label,
        audioBase64: resolveAudioBase64(input),
        mimeType: input.mimeType ?? "audio/wav"
      })) as { voiceProfileId: string; label: string };
      return { voiceProfileId: body.voiceProfileId, label: body.label };
    },
    identify: async (input) => {
      const body = (await this.profileRequest("/identify", "POST", {
        audioBase64: resolveAudioBase64(input),
        mimeType: input.mimeType ?? "audio/wav"
      })) as { voiceProfileMatch?: SidecarVoiceProfileMatch };
      return readVoiceProfileMatch(body.voiceProfileMatch) ?? { status: "NO_MATCH" };
    },
    delete: async (id) => {
      await this.profileRequest(`/speakers/${encodeURIComponent(id)}`, "DELETE");
    },
    fenceNativeCommand: async (command) => {
      const result = await this.profileRequest("/speakers/commands/fence", "POST", { command }) as { status?: unknown };
      if (result.status !== "READY" && result.status !== "APPLIED" && result.status !== "UNKNOWN" && result.status !== "CONFLICT")
        throw new Error("Acoustic owner returned an invalid fence result.");
      return result.status;
    },
    applyNativeCommand: async (command) => this.profileRequest("/speakers/commands", "POST", {
      command: stripAudio(command),
      ...(command.audioBase64 === undefined ? {} : { audioBase64: command.audioBase64 }),
      mimeType: "audio/wav"
    }) as Promise<VoiceProfileNativeCommandResult>,
    reconcileNativeCommand: async (command) => this.profileRequest("/speakers/commands/reconcile", "POST", { command }) as Promise<VoiceProfileNativeCommandResult>
  };

  private async profileRequest(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await fetch(`${trimSlash(this.options.baseUrl)}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000)
    });
    if (!response.ok) throw new Error(`Acoustic profile request failed (HTTP ${response.status}).`);
    return response.json();
  }

  constructor(private readonly options: LocalSTTProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = performance.now();
    const transport = createTransportAbort({ timeoutMs: this.options.timeoutMs ?? 4_000 });
    try {
      const response = await fetch(`${trimSlash(this.options.baseUrl)}/health`, {
        signal: transport.signal
      });
      if (!response.ok) throw new Error(`local STT health returned ${response.status}`);
      const body = (await response.json()) as { ok?: boolean; service?: string };
      if (body.ok !== true || body.service !== "yuvi-local-stt") {
        throw new Error("Local STT endpoint did not identify a ready yuvi-local-stt service.");
      }
      return {
        provider: this.name,
        name: this.name,
        capability: "stt",
        status: "healthy",
        configured: true,
        available: true,
        mock: false,
        baseUrl: this.options.baseUrl,
        model: this.options.model,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        message: "Local CPU STT sidecar is ready."
      };
    } catch (error) {
      return {
        provider: this.name,
        name: this.name,
        capability: "stt",
        status: "unavailable",
        configured: true,
        available: false,
        mock: false,
        baseUrl: this.options.baseUrl,
        model: this.options.model,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : "Local STT health check failed."
      };
    } finally {
      transport.cleanup();
    }
  }

  async transcribeAudio(input: STTInput, options?: ProviderCallOptions): Promise<STTOutput> {
    const transport = createTransportAbort({
      signal: options?.signal,
      timeoutMs: this.options.timeoutMs ?? 120_000
    });
    try {
      const audioBase64 = resolveAudioBase64(input);
      const response = await fetch(`${trimSlash(this.options.baseUrl)}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          mimeType: input.mimeType ?? "audio/wav",
          language: input.language,
          identify: input.metadata?.["identify"] !== false,
          diarize: input.metadata?.["diarize"] !== false
        }),
        signal: transport.signal
      });
      if (!response.ok) {
        throw new ProviderError({
          provider: this.name,
          capability: "stt",
          code: ProviderErrorCode.NetworkError,
          message: `Local STT transcription failed with HTTP ${response.status}.`,
          retryable: response.status >= 500
        });
      }
      const body = (await response.json()) as SidecarTranscribeBody;
      const acoustic = normalizeAcousticEvidence(body);
      return {
        observationId: randomUUID(),
        text: body.text ?? "",
        language: body.language ?? input.language,
        latencyMs: body.latencyMs,
        model: this.options.model,
        finalProvider: this.name,
        ...(acoustic.segments === undefined ? {} : { segments: acoustic.segments }),
        ...(acoustic.voiceProfileMatch === undefined
          ? {}
          : { voiceProfileMatch: acoustic.voiceProfileMatch }),
        // Provenance and diagnostics only. Acoustic evidence is typed
        // VoiceProfileMatch; person identity is not decided here. Raw
        // embeddings, scores, and sidecar labels never enter this bag.
        providerMetadata: {
          device: "cpu"
        }
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        provider: this.name,
        capability: "stt",
        code: ProviderErrorCode.NetworkError,
        message: "Local STT transcription request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }

  async detectVoiceActivity(
    input: VoiceActivityInput,
    options?: ProviderCallOptions
  ): Promise<VoiceActivityOutput> {
    const transport = createTransportAbort({
      signal: options?.signal ?? input.signal,
      timeoutMs: this.options.timeoutMs ?? 8_000
    });
    try {
      const response = await fetch(`${trimSlash(this.options.baseUrl)}/vad`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          captureEpoch: input.captureEpoch,
          pcmBase64: input.pcmBase64,
          sampleRate: input.sampleRate ?? 16_000
        }),
        signal: transport.signal
      });
      if (response.status === 503) {
        throw new ProviderError({
          provider: this.name,
          capability: "stt",
          code: ProviderErrorCode.ProviderUnavailable,
          message: "Local STT sidecar has no Silero VAD model.",
          retryable: false
        });
      }
      if (!response.ok) {
        throw new ProviderError({
          provider: this.name,
          capability: "stt",
          code: ProviderErrorCode.NetworkError,
          message: `Local STT VAD failed with HTTP ${response.status}.`,
          retryable: response.status >= 500
        });
      }
      const body = (await response.json()) as { active?: boolean; captureEpoch?: string };
      if (typeof body.active !== "boolean") {
        throw new ProviderError({
          provider: this.name,
          capability: "stt",
          code: ProviderErrorCode.MalformedResponse,
          message: "Local STT VAD response did not include an active boolean.",
          retryable: false
        });
      }
      return {
        active: body.active,
        captureEpoch: body.captureEpoch ?? input.captureEpoch
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        provider: this.name,
        capability: "stt",
        code: ProviderErrorCode.NetworkError,
        message: "Local STT VAD request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }
}

function stripAudio(command: VoiceProfileNativeCommand & { audioBase64?: string }): VoiceProfileNativeCommand {
  const { audioBase64: _audioBase64, ...metadata } = command;
  return metadata;
}

type SidecarVoiceProfileMatch = {
  status?: string;
  voiceProfileId?: string | null;
};

type SidecarIdentity = {
  identity?: string;
  speakerId?: string | null;
  label?: string | null;
  score?: number | null;
};

type SidecarSegment = {
  text?: string;
  startMs?: number;
  endMs?: number;
  speaker?: string;
  voiceProfileMatch?: SidecarVoiceProfileMatch | null;
};

type SidecarTranscribeBody = {
  text?: string;
  language?: string;
  latencyMs?: number;
  identity?: SidecarIdentity | null;
  voiceProfileMatch?: SidecarVoiceProfileMatch | null;
  segments?: SidecarSegment[] | null;
};

/**
 * Normalizes sidecar diarization + acoustic template evidence.
 *
 * Legacy sidecar `speakerId` is mapped to `voiceProfileId` here. Cluster
 * labels stay capture-local. Mixed captures never inherit a whole-audio
 * template match. Scores, labels, embeddings, and person fields are dropped.
 */
function normalizeAcousticEvidence(body: SidecarTranscribeBody): {
  segments?: STTSegment[];
  voiceProfileMatch?: VoiceProfileMatch;
} {
  const sourceSegments = body.segments ?? [];
  const segments = sourceSegments.length > 0 ? sourceSegments.map(normalizeSegment) : undefined;
  const clusters = uniqueClusterIds(segments);
  const mixed = clusters.length > 1;
  const observationMatch =
    readVoiceProfileMatch(body.voiceProfileMatch) ?? readLegacyIdentity(body.identity);

  if (segments === undefined) {
    return observationMatch === undefined ? {} : { voiceProfileMatch: observationMatch };
  }

  if (mixed) {
    // Defense in depth: if the sidecar still returned one whole-audio match
    // and no cluster-scoped matches, drop it rather than labeling everyone.
    const hasClusterScopedMatch = segments.some(
      (segment) => segment.voiceProfileMatch !== undefined
    );
    return {
      segments: hasClusterScopedMatch
        ? segments.map((segment) =>
            segment.voiceProfileMatch === undefined
              ? { ...segment, voiceProfileMatch: { status: "NO_MATCH" as const } }
              : segment
          )
        : segments.map((segment) => ({
            ...segment,
            voiceProfileMatch: { status: "NO_MATCH" as const }
          }))
    };
  }

  if (observationMatch !== undefined && segments.length > 0) {
    return {
      voiceProfileMatch: observationMatch,
      segments: segments.map((segment) =>
        segment.voiceProfileMatch === undefined
          ? { ...segment, voiceProfileMatch: observationMatch }
          : segment
      )
    };
  }

  return {
    segments,
    ...(observationMatch === undefined ? {} : { voiceProfileMatch: observationMatch })
  };
}

function normalizeSegment(segment: SidecarSegment): STTSegment {
  const match = readVoiceProfileMatch(segment.voiceProfileMatch);
  return {
    segmentId: randomUUID(),
    ...(typeof segment.text === "string" ? { text: segment.text } : {}),
    startMs: segment.startMs,
    endMs: segment.endMs,
    ...(segment.speaker !== undefined ? { speakerClusterId: String(segment.speaker) } : {}),
    ...(match === undefined ? {} : { voiceProfileMatch: match })
  };
}

function uniqueClusterIds(segments: STTSegment[] | undefined): string[] {
  if (segments === undefined) return [];
  const ids: string[] = [];
  for (const segment of segments) {
    const clusterId = segment.speakerClusterId;
    if (clusterId === undefined || ids.includes(clusterId)) continue;
    ids.push(clusterId);
  }
  return ids;
}

function readVoiceProfileMatch(
  value: SidecarVoiceProfileMatch | null | undefined
): VoiceProfileMatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (value.status === "MATCHED") {
    const voiceProfileId =
      typeof value.voiceProfileId === "string" && value.voiceProfileId.trim()
        ? value.voiceProfileId.trim()
        : undefined;
    if (!voiceProfileId) return { status: "NO_MATCH" };
    return { status: "MATCHED", voiceProfileId };
  }
  if (value.status === "NO_MATCH") return { status: "NO_MATCH" };
  return undefined;
}

function readLegacyIdentity(
  value: SidecarIdentity | null | undefined
): VoiceProfileMatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  // Legacy speakerId is the acoustic template id, never a person id.
  if (value.identity === "KNOWN" && typeof value.speakerId === "string" && value.speakerId.trim()) {
    return { status: "MATCHED", voiceProfileId: value.speakerId.trim() };
  }
  if (value.identity === "UNKNOWN" || value.identity === "KNOWN") {
    return { status: "NO_MATCH" };
  }
  return undefined;
}

function resolveAudioBase64(input: STTInput): string {
  if (input.audioBase64?.trim()) return input.audioBase64.trim();
  const bytes = input.audio ?? input.audioBuffer;
  if (bytes && bytes.byteLength > 0) return Buffer.from(bytes).toString("base64");
  throw new ProviderError({
    provider: "local",
    capability: "stt",
    code: ProviderErrorCode.UnsupportedInput,
    message: "Local STT requires audio bytes or audioBase64.",
    retryable: false
  });
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
