import { createHash, randomUUID } from "node:crypto";
import type { PostgresPool } from "@companion/database";
import {
  effectDigest,
  effectIntentId,
  protocolEvidence,
  type EffectAttemptV1,
  type EffectProgressFact
} from "@companion/effects";
import {
  SpeechSegmentSealSchema,
  MediaDeviceReportSchema,
  speechProjection,
  sealedSpeechProjection,
  prepareSpeechSegment,
  sanitizeSpeechText,
  speechTextFromMarkdown,
  type SpeechSegmentSeal,
  type MediaPermission,
  type MediaDeviceReport,
  type JournalEventRef
} from "@companion/protocol";
import {
  withProviderWorkContext,
  type ProviderRegistry,
  type TTSInput,
  type TTSOutput
} from "@companion/providers";
import { HostOutwardEffects } from "./outward-effects.js";

type Generation = { sessionId: string; requestId: string; controller: AbortController };
type Segment = { segmentId: string; replyId: string; cause: JournalEventRef; generation: string };
type RegisteredPermission = {
  permission: MediaPermission;
  work: Awaited<ReturnType<HostOutwardEffects["work"]>>;
  attempt: EffectAttemptV1;
};
/** Speech/audio are immutable domain descriptors. Canonical A9 alone owns invocation state. */
export class HostMediaEffects {
  private readonly generations = new Map<string, Generation>();
  private readonly retiredRequests = new Set<string>();
  private readonly permissions = new Map<string, RegisteredPermission>();
  private accepting = true;
  constructor(
    private readonly pool: PostgresPool | undefined,
    private readonly outward: HostOutwardEffects,
    private readonly providers: () => ProviderRegistry,
    private readonly playbackObservation?: (
      intentId: string,
      requestId: string,
      observation: string
    ) => void
  ) {}
  generation(sessionId: string, requestId: string): string {
    if (!this.accepting || !this.pool) throw Error("Durable media generation unavailable.");
    const requestKey = JSON.stringify([sessionId, requestId]);
    if (this.retiredRequests.has(requestKey)) throw Error("Media request generation was revoked.");
    for (const [id, g] of this.generations)
      if (g.sessionId === sessionId && g.requestId === requestId) return id;
    for (const [id, g] of this.generations) if (g.sessionId === sessionId) this.revoke(id);
    if (this.generations.size >= 128) throw Error("Media generation capacity exceeded.");
    const id = randomUUID();
    this.generations.set(id, { sessionId, requestId, controller: new AbortController() });
    return id;
  }
  revoke(id: string) {
    const g = this.generations.get(id);
    if (g) {
      if (this.retiredRequests.size >= 512)
        this.retiredRequests.delete(this.retiredRequests.values().next().value!);
      this.retiredRequests.add(JSON.stringify([g.sessionId, g.requestId]));
    }
    this.generations.get(id)?.controller.abort();
    this.generations.delete(id);
    for (const [token, p] of this.permissions)
      if (p.permission.generation === id) {
        this.playbackObservation?.(
          p.permission.intentId,
          String((p.work.request.payload as { target: { recipient: string } }).target.recipient),
          "REVOKED"
        );
        this.permissions.delete(token);
      }
  }
  invalidateAll() {
    for (const id of [...this.generations.keys()]) this.revoke(id);
  }
  seal() {
    this.accepting = false;
    this.invalidateAll();
  }
  presentationTarget(replyId: string) {
    const reply = this.outward.replyRequest(replyId);
    if (!reply?.requestId) return undefined;
    for (const [generation, g] of this.generations)
      if (g.requestId === reply.requestId && g.sessionId === reply.sessionId)
        return {
          generation,
          requestId: g.requestId,
          current: () =>
            this.accepting &&
            this.generations.has(generation) &&
            !g.controller.signal.aborted &&
            this.outward.isReplyCurrent(replyId)
        };
    return undefined;
  }
  interruptSession(sessionId: string) {
    const g = [...this.generations.entries()].find(([, entry]) => entry.sessionId === sessionId);
    if (!g) return undefined;
    this.revoke(g[0]);
    return g[1].requestId;
  }
  private current(id: string): Generation {
    const g = this.generations.get(id);
    if (!this.accepting || !g || g.controller.signal.aborted)
      throw Error("Stale media generation.");
    return g;
  }
  async sealSegment(input: {
    seal: SpeechSegmentSeal;
    text: string;
    generation: string;
  }): Promise<Segment> {
    const seal = SpeechSegmentSealSchema.parse(input.seal),
      g = this.current(input.generation);
    if (!this.pool || !this.outward.isReplyLive(seal.replyId, g.requestId))
      throw Error("Reply speech rights are unavailable or stale.");
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [seal.replyId]);
      const components = await client.query(
        `select c.*,m.session_id,m.source_journal_ref from conversation_reply_components c
    join conversation_messages m on m.id=c.message_id where c.reply_id=$1 and c.sequence<=$2::bigint order by c.sequence`,
        [seal.replyId, seal.throughSequence]
      );
      if (
        !components.rows.length ||
        String(components.rows.at(-1)!["sequence"]) !== seal.throughSequence ||
        components.rows.some((r) => r["session_id"] !== g.sessionId)
      )
        throw Error("Speech source prefix is unavailable.");
      const source = components.rows.map((r) => r["text_content"]).join("");
      if (source.length > 128000 || components.rows.length > 2048)
        throw Error("Speech source descriptor bound exceeded.");
      const projected = sanitizeSpeechText(speechTextFromMarkdown(source));
      if (
        seal.preparedEnd > projected.length ||
        prepareSpeechSegment(projected.slice(seal.preparedStart, seal.preparedEnd)) !== input.text
      )
        throw Error("Speech segment does not match committed text under its frozen transform.");
      const plan = await client.query(
        "select plan,request_id from reply_speech_plans where reply_id=$1",
        [seal.replyId]
      );
      if (
        plan.rows[0]?.["plan"] !== "CLIENT_SEGMENTED" ||
        plan.rows[0]?.["request_id"] !== g.requestId
      )
        throw Error("Reply does not authorize this client speech plan.");
      const prior = await client.query(
        "select sequence,descriptor from speech_segment_descriptors where reply_id=$1 and sequence<$2::bigint order by sequence desc limit 1",
        [seal.replyId, seal.sequence]
      );
      const mapped = sealedSpeechProjection(source, seal.preparedStart, seal.preparedEnd);
      if (mapped.text !== input.text) throw Error("Speech preparation origin conflict.");
      const ranges: Array<{ start: number; end: number }> = [];
      for (const origin of mapped.origins) {
        const last = ranges.at(-1);
        if (last && origin.start <= last.end) last.end = Math.max(last.end, origin.end);
        else ranges.push({ ...origin });
      }
      const sourceSpans: Array<{
        componentId: string;
        sequence: string;
        start: number;
        end: number;
      }> = [];
      let offset = 0;
      for (const row of components.rows) {
        const text = String(row["text_content"]),
          next = offset + text.length;
        for (const range of ranges)
          if (range.end > offset && range.start < next)
            sourceSpans.push({
              componentId: String(row["component_id"]),
              sequence: String(row["sequence"]),
              start: [...text.slice(0, Math.max(0, range.start - offset))].length,
              end: [...text.slice(0, Math.min(text.length, range.end - offset))].length
            });
        offset = next;
      }
      const sourceStart =
        (prior.rows[0]?.["descriptor"] as { sourceEnd?: number } | undefined)?.sourceEnd ?? 0;
      const sourceEnd = speechProjection(source).origins[seal.preparedEnd]?.start ?? source.length;
      if (ranges[0] && ranges[0].start < sourceStart) throw Error("Speech source span overlap.");
      const descriptor = {
        ...seal,
        sourceStart,
        sourceEnd,
        sourceBoundaryUnit: "UTF16_CODE_UNIT",
        preparedUnit: "UTF16_CODE_UNIT",
        sourceUnit: "UNICODE_CODE_POINT",
        segmenterVersion: "speech-segmenter.v1",
        sourceSpans,
        omittedSourceUnit: "UNICODE_CODE_POINT",
        omittedSourceRanges: sourceGaps([
          { start: sourceStart, end: sourceStart },
          ...ranges,
          { start: sourceEnd, end: sourceEnd }
        ]).map((g) => ({
          start: [...source.slice(0, g.start)].length,
          end: [...source.slice(0, g.end)].length
        })),
        omissionPolicy: "speech-preparation.v1 markdown/nonspoken transform"
      };
      const digest = effectDigest(descriptor),
        segmentId = `ss1_${effectDigest([seal.replyId, seal.sequence])}`,
        spokenDigest = hash(input.text);
      const existing = await client.query(
        "select * from speech_segment_descriptors where segment_id=$1",
        [segmentId]
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0]["descriptor_digest"] !== digest ||
          existing.rows[0]["spoken_digest"] !== spokenDigest
        )
          throw Error("Sealed speech identity conflict.");
        await client.query("commit");
        return {
          segmentId,
          replyId: seal.replyId,
          cause: existing.rows[0]["cause"],
          generation: input.generation
        };
      }
      const expected = prior.rows[0] ? BigInt(String(prior.rows[0]["sequence"])) + 1n : 1n;
      if (BigInt(seal.sequence) !== expected)
        throw Error("Speech sequence is not the next sealed segment.");
      const previousEnd = prior.rows[0]
        ? (prior.rows[0]["descriptor"] as SpeechSegmentSeal).preparedEnd
        : 0;
      if (seal.preparedStart !== previousEnd) throw Error("Speech source gap or overlap.");
      const cause = this.outward.replyCause(seal.replyId);
      if (!cause) throw Error("Speech cause unavailable.");
      await client.query(
        `insert into speech_segment_descriptors(segment_id,reply_id,sequence,descriptor,descriptor_digest,spoken_digest,cause)
    values($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)`,
        [
          segmentId,
          seal.replyId,
          seal.sequence,
          JSON.stringify(descriptor),
          digest,
          spokenDigest,
          JSON.stringify(cause)
        ]
      );
      this.current(input.generation);
      await client.query("commit");
      return { segmentId, replyId: seal.replyId, cause, generation: input.generation };
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async sealWhole(
    text: string,
    sessionId: string,
    cause?: JournalEventRef,
    existingReplyId?: string
  ): Promise<Segment> {
    if (!this.pool || !this.accepting) throw Error("Durable whole speech seal unavailable.");
    const replyId = existingReplyId ?? `whole-speech:${randomUUID()}`,
      segmentId = `ss1_${effectDigest([replyId, "1"])}`;
    const ref = cause ?? (await this.outward.operationCause("standalone-tts", sessionId));
    const descriptor = {
      version: "speech-whole-seal.v1",
      plan: "SERVER_WHOLE",
      inputAvailability: "NOT_RETAINED",
      digest: hash(text)
    };
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (existingReplyId) {
        const plan = (
          await client.query("select plan from reply_speech_plans where reply_id=$1", [replyId])
        ).rows[0];
        const body = (
          await client.query(
            "select string_agg(text_content,'' order by sequence) as body from conversation_reply_components where reply_id=$1",
            [replyId]
          )
        ).rows[0];
        if (
          plan?.["plan"] !== "SERVER_WHOLE" ||
          body?.["body"] !== text ||
          !this.outward.isReplyCurrent(replyId)
        )
          throw Error("Reply does not authorize this whole speech plan.");
      } else
        await client.query(
          "insert into reply_speech_plans(reply_id,plan) values($1,'SERVER_WHOLE')",
          [replyId]
        );
      await client.query(
        `insert into speech_segment_descriptors(segment_id,reply_id,sequence,descriptor,descriptor_digest,spoken_digest,cause) values($1,$2,1,$3::jsonb,$4,$5,$6::jsonb)`,
        [
          segmentId,
          replyId,
          JSON.stringify(descriptor),
          effectDigest(descriptor),
          hash(text),
          JSON.stringify(ref)
        ]
      );
      await client.query("commit");
      return { segmentId, replyId, cause: ref, generation: "standalone-no-playback" };
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async synthesize(segment: Segment, input: TTSInput, signal: AbortSignal): Promise<TTSOutput> {
    const g =
      segment.generation === "standalone-no-playback"
        ? undefined
        : this.current(segment.generation);
    const descriptor = (
      await this.pool!.query(
        "select spoken_digest from speech_segment_descriptors where segment_id=$1",
        [segment.segmentId]
      )
    ).rows[0];
    if (descriptor?.["spoken_digest"] !== hash(input.text))
      throw Error("TTS input conflicts with its sealed segment.");
    const output = await withProviderWorkContext(
      {
        scope: `session:${g?.sessionId ?? "standalone-tts"}`,
        cause: segment.cause,
        operationKey: `tts:${segment.segmentId}:${effectDigest({ voice: input.voice ?? null, format: input.format ?? null, speed: input.speed ?? null, metadata: input.metadata ?? null })}`,
        replyId: segment.replyId,
        isCurrent: () => this.accepting && !signal.aborted && (!g || !g.controller.signal.aborted)
      },
      () =>
        this.providers()
          .getTTSProvider()
          .synthesizeSpeech(input, {
            signal: g ? AbortSignal.any([signal, g.controller.signal]) : signal
          })
    );
    if (!this.pool) throw Error("Audio result accounting unavailable.");
    const bytes = output.audioBase64
      ? Buffer.from(output.audioBase64, "base64")
      : Buffer.from(output.audio);
    await this.pool.query(
      `insert into speech_audio_results(segment_id,provider_attempt_id,audio_digest,mime_type,byte_count,availability_reference)
   values($1,$2,$3,$4,$5,$6)`,
      [
        segment.segmentId,
        (output as TTSOutput & { sourceAttemptId?: string }).sourceAttemptId ?? null,
        hash(bytes),
        output.mimeType,
        bytes.length,
        `volatile-audio:${randomUUID()}`
      ]
    );
    return output;
  }
  async permission(input: {
    segmentId: string;
    generation: string;
    kind: "PLAYBACK" | "SUBTITLE";
  }): Promise<MediaPermission> {
    const g = this.current(input.generation);
    if (!this.pool) throw Error("Media accounting unavailable.");
    const row = (
      await this.pool.query(
        "select s.*,a.audio_digest from speech_segment_descriptors s left join speech_audio_results a using(segment_id) where segment_id=$1",
        [input.segmentId]
      )
    ).rows[0];
    if (
      !row ||
      !this.outward.isReplyLive(row["reply_id"], g.requestId) ||
      (input.kind === "PLAYBACK" && !row["audio_digest"])
    )
      throw Error("Active sealed media unavailable.");
    const contractRef = input.kind === "PLAYBACK" ? "yuvi.playback.v1" : "yuvi.publication.v1";
    const work = await this.outward.work({
      contractRef,
      logicalKey: `${contractRef}:${input.segmentId}:${input.generation}:${input.kind}`,
      operation: input.kind,
      digest: effectDigest({ segmentId: input.segmentId, kind: input.kind }),
      configurationRef: "media-permission.v1",
      scope: `session:${g.sessionId}`,
      cause: row["cause"],
      replyId: row["reply_id"],
      target: { surface: input.kind, recipient: g.requestId, generation: input.generation },
      isCurrent: () => this.accepting && !g.controller.signal.aborted
    });
    if (
      (
        await this.outward.dispatcher?.diagnostic(
          effectIntentId(contractRef, work.request.logicalKey)
        )
      )?.currentAttempt
    )
      throw Error("A media permission cannot be resent or replayed.");
    let registered: RegisteredPermission | undefined;
    await this.outward.execute(work, async (a) => {
      const permission: MediaPermission = {
        version: "media-permission.v1",
        intentId: a.intentId,
        attemptId: a.attemptId,
        fence: a.fence,
        expiresAt: work.request.expiresAt,
        generation: input.generation,
        capability: randomUUID(),
        segmentId: input.segmentId,
        kind: input.kind
      };
      await this.outward.fact(a, {
        factKey: "media-permission",
        kind: "PERMISSION_ISSUED",
        reference: permission.capability,
        digest: effectDigest(permission),
        generation: input.generation
      });
      registered = { permission, work, attempt: a };
      return { evidence: protocolEvidence("CALL_UNCERTAIN", true) };
    });
    if (!registered) throw Error("Media permission was not durably accounted.");
    this.permissions.set(registered.permission.capability, registered);
    return registered.permission;
  }
  async report(raw: MediaDeviceReport): Promise<void> {
    const { permission, observation } = MediaDeviceReportSchema.parse(raw),
      g = this.current(permission.generation);
    if (Date.parse(permission.expiresAt) <= Date.now())
      throw Error("Stale expired media permission.");
    const registered = this.permissions.get(permission.capability);
    if (
      !registered ||
      effectDigest(registered.permission) !== effectDigest(permission) ||
      !this.outward.isReplyLive(
        (registered.work.request.payload as { relatedReply: string }).relatedReply,
        g.requestId
      )
    )
      throw Error("Stale or conflicting media report.");
    if (permission.kind === "SUBTITLE" && observation !== "SUBTITLE_ACCEPTED")
      throw Error("Wrong subtitle observation.");
    if (permission.kind === "PLAYBACK" && observation === "SUBTITLE_ACCEPTED")
      throw Error("Wrong playback observation.");
    const kind: EffectProgressFact["kind"] =
      observation === "SUBTITLE_ACCEPTED"
        ? "SUBTITLE_ACCEPTED"
        : observation === "ATTACHED"
          ? "DEVICE_ATTACHED"
          : observation === "PLAYING"
            ? "DEVICE_PLAYING"
            : observation === "COMPLETED"
              ? "DEVICE_COMPLETED"
              : observation === "INTERRUPTED"
                ? "DEVICE_INTERRUPTED"
                : "DEVICE_ERROR";
    const fact: EffectProgressFact = {
      factKey: `media:${observation}`,
      kind,
      reference: permission.segmentId,
      digest: effectDigest({ permission, observation }),
      generation: permission.generation
    };
    const current = await this.outward.dispatcher?.diagnostic(permission.intentId);
    if (!current?.currentAttempt) throw Error("Media attempt unavailable.");
    const status = await this.outward.store?.progress?.(current.currentAttempt, fact, {
      reference: permission.capability,
      generation: permission.generation
    });
    if (status !== "RECORDED" && status !== "REPLAY") throw Error("Media report was fenced.");
    if (permission.kind === "PLAYBACK")
      this.playbackObservation?.(permission.intentId, g.requestId, observation);
    if (observation === "PLAYING" && current.certainty !== "APPLIED")
      await this.outward.execute(registered.work, async () => ({
        evidence: {
          certainty: "APPLIED",
          layer: "DEVICE_REPORTED_PLAYING",
          reason: "RETURNED",
          remoteEffectId: null
        }
      }));
  }
}
function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceGaps(ranges: Array<{ start: number; end: number }>) {
  const gaps: Array<{ start: number; end: number }> = [];
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i]!.start > ranges[i - 1]!.end)
      gaps.push({ start: ranges[i - 1]!.end, end: ranges[i]!.start });
  return gaps;
}
