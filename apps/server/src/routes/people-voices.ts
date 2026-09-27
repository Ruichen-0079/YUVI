import { productVoiceProfiles } from "../services/packaged-voice.js";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { requireLocalDashboardAccess } from "./security.js";
import { readProductSettings } from "../services/product-store.js";
import { boundedWav, retainVoiceSample, updateVoiceReview, voiceReviews, type VoiceReview } from "../services/voice-review.js";
import { toVoiceControlAdmissionFailure } from "../voice-control-receipt-admission.js";

const boundedId = z.string().trim().min(1).max(160);
const voiceSampleParams = z.object({ id: boundedId }).strict();
const VoiceSampleReviewRequest = z.union([
  z.object({ leaveUnknown: z.literal(true) }).strict(),
  z.object({ personId: boundedId }).strict()
]);
const ProductVoiceEnrollmentRequest = z.object({
  personId: boundedId,
  recordings: z.array(z.string().max(1_100_000)).min(3).max(5),
  replaceVoiceId: boundedId.optional()
}).strict();

function readReviewAfterAdmission(id: string): VoiceReview | undefined {
  try {
    return voiceReviews().find(row => row.id === id);
  } catch {
    return undefined;
  }
}

function sameReviewSnapshot(before: VoiceReview, after: VoiceReview): boolean {
  return before.id === after.id &&
    before.createdAt === after.createdAt &&
    before.voiceProfileId === after.voiceProfileId &&
    before.leftUnknown === after.leftUnknown &&
    before.sample === after.sample;
}

export async function registerPeopleVoiceRoutes(app: FastifyInstance, context: AppContext, config: ServerConfig) {
  app.get("/product/voices", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const profiles = productVoiceProfiles(context);
    try {
      const records = profiles ? await profiles.list() : [];
      const rows = voiceReviews();
      const voices = await Promise.all(records.map(async p => ({ id: p.voiceProfileId, label: p.label, personId: await context.runtime.getVoiceProfilePerson(p.voiceProfileId), sampleId: rows.find(r => r.voiceProfileId === p.voiceProfileId)?.id })));
      return { available: Boolean(profiles), voices, unknown: rows.filter(r => !voices.some(v => v.id === r.voiceProfileId && v.personId)).map(({ sample, voiceProfileId, ...r }) => r) };
    } catch { return reply.code(503).send({ error: "Voice profiles or trusted bindings unavailable." }); }
  });
  app.get("/product/voice-samples/:id", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const params = voiceSampleParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid sample ID." });
    const row = voiceReviews().find(r => r.id === params.data.id);
    if (!row) return reply.code(404).send({ error: "Sample deleted or expired." });
    return reply.header("Cache-Control", "no-store").type("audio/wav").send(Buffer.from(row.sample, "base64"));
  });
  app.delete("/product/voice-samples/:id", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const params = voiceSampleParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid sample ID." });
    try {
      updateVoiceReview(params.data.id, null);
      return { ok: true };
    } catch {
      return reply.code(503).send({ error: "Voice sample could not be deleted." });
    }
  });
  app.post("/product/voice-samples/:id/review", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const params = voiceSampleParams.safeParse(req.params);
    const parsed = VoiceSampleReviewRequest.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "Invalid review." });
    let row: VoiceReview | undefined;
    try {
      row = voiceReviews().find(r => r.id === params.data.id);
    } catch {
      return reply.code(503).send({ error: "Voice review samples are unavailable." });
    }
    if (!row) return reply.code(404).send({ error: "Sample deleted or expired." });

    if ("leaveUnknown" in parsed.data) {
      try {
        await context.voiceControlReceiptAdmission.admit({
          operation: "VOICE_SAMPLE_REVIEW_UNKNOWN",
          sampleId: row.id
        });
      } catch (error) {
        const failure = toVoiceControlAdmissionFailure(error);
        return reply.code(failure.statusCode).send({ error: failure.code });
      }
      const current = readReviewAfterAdmission(row.id);
      if (!current || !sameReviewSnapshot(row, current))
        return reply.code(409).send({ error: "Voice review changed before it could be applied." });
      try {
        updateVoiceReview(row.id, { leftUnknown: true });
        return { ok: true };
      } catch {
        return reply.code(503).send({ error: "Receipt recorded; voice review could not be saved." });
      }
    }
    const personId = (parsed.data as { personId?: string }).personId;
    if (!personId) return reply.code(400).send({ error: "Invalid review." });

    let settings;
    try {
      settings = readProductSettings();
    } catch {
      return reply.code(503).send({ error: "Saved People are unavailable." });
    }
    const person = settings?.people.find(p => p.id === personId);
    if (!person) return reply.code(409).send({ error: "Select a saved Person." });
    if (!context.runtime.canManageVoiceProfileBindings())
      return reply.code(503).send({ error: "Voice binding storage is unavailable." });

    let profiles;
    let profileRows;
    try {
      profiles = productVoiceProfiles(context);
      if (!profiles) return reply.code(409).send({ error: "Configure local speaker recognition." });
      profileRows = await profiles.list();
    } catch {
      return reply.code(503).send({ error: "Voice profiles are unavailable." });
    }
    const enrollFromSample = row.voiceProfileId === undefined;
    if (!enrollFromSample && !profileRows.some(p => p.voiceProfileId === row.voiceProfileId))
      return reply.code(409).send({ error: "The sample voice profile no longer exists." });
    const voiceProfileId = row.voiceProfileId ?? randomUUID();
    if (enrollFromSample && profileRows.some(p => p.voiceProfileId === voiceProfileId))
      return reply.code(409).send({ error: "A new voice profile could not be allocated." });

    try {
      await context.voiceControlReceiptAdmission.admit({
        operation: "VOICE_SAMPLE_REVIEW_PERSON",
        sampleId: row.id,
        personId: person.id,
        voiceProfileId,
        enrollFromSample
      });
    } catch (error) {
      const failure = toVoiceControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }

    const current = readReviewAfterAdmission(row.id);
    if (!current || !sameReviewSnapshot(row, current))
      return reply.code(409).send({ error: "Voice review changed before it could be applied." });

    if (enrollFromSample) {
      let enrolled;
      try {
        enrolled = await profiles.enroll({
          voiceProfileId,
          label: person.displayName,
          audioBase64: current.sample,
          mimeType: "audio/wav"
        });
      } catch {
        return reply.code(503).send({ error: "Receipt recorded; voice profile enrollment failed." });
      }
      if (enrolled.voiceProfileId !== voiceProfileId)
        return reply.code(409).send({ error: "Receipt recorded; provider returned an unexpected profile." });
      try {
        if (!updateVoiceReview(row.id, { voiceProfileId }))
          return reply.code(409).send({ error: "Voice profile enrolled; the review sample was deleted." });
      } catch {
        return reply.code(503).send({ error: "Voice profile enrolled; sample association failed." });
      }
    } else {
      try {
        if (!(await profiles.list()).some(p => p.voiceProfileId === voiceProfileId))
          return reply.code(409).send({ error: "Receipt recorded; the voice profile no longer exists." });
      } catch {
        return reply.code(503).send({ error: "Receipt recorded; voice profiles are unavailable." });
      }
      const latest = readReviewAfterAdmission(row.id);
      if (!latest || !sameReviewSnapshot(row, latest))
        return reply.code(409).send({ error: "Voice review changed before it could be applied." });
    }

    try {
      const bound = await context.runtime.bindVoiceProfileToPerson(voiceProfileId, person.id);
      if (!("status" in bound) || bound.status !== "STORED")
        return reply.code(409).send({ error: "Voice profile is ready; binding was not stored. Check Memory and retry." });
      return { ok: true };
    } catch {
      return reply.code(503).send({ error: "Receipt recorded; voice binding could not be completed." });
    }
  });
  app.post("/product/voices/enroll", { bodyLimit: 4_000_000 }, async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const parsed = ProductVoiceEnrollmentRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Select a Person and record three short utterances." });
    let settings;
    try {
      settings = readProductSettings();
    } catch {
      return reply.code(503).send({ error: "Saved People are unavailable." });
    }
    const person = settings?.people.find(p => p.id === parsed.data.personId);
    if (!person) return reply.code(400).send({ error: "Select a saved Person and record three short utterances." });
    if (!context.runtime.canManageVoiceProfileBindings())
      return reply.code(503).send({ error: "Voice binding storage is unavailable." });

    let profiles;
    let profileRows;
    try {
      profiles = productVoiceProfiles(context);
      if (!profiles) return reply.code(409).send({ error: "Configure local speaker recognition." });
      profileRows = await profiles.list();
    } catch {
      return reply.code(503).send({ error: "Voice profiles are unavailable." });
    }

    let clips: Buffer[];
    let combined: Buffer;
    try {
      clips = parsed.data.recordings.map(boundedWav);
      if (clips.some(c => !c.subarray(20, 36).equals(clips[0]!.subarray(20, 36)))) throw new Error();
      const data = Buffer.concat(clips.map(c => c.subarray(44)));
      combined = Buffer.concat([clips[0]!.subarray(0, 44), data]);
      combined.writeUInt32LE(combined.length - 8, 4);
      combined.writeUInt32LE(data.length, 40);
    } catch { return reply.code(422).send({ error: "Enrollment failed. Use clear mono speech recordings." }); }

    const newVoiceProfileId = randomUUID();
    if (profileRows.some(p => p.voiceProfileId === newVoiceProfileId))
      return reply.code(503).send({ error: "A new voice profile could not be allocated." });
    if (parsed.data.replaceVoiceId) {
      if (!profileRows.some(p => p.voiceProfileId === parsed.data.replaceVoiceId))
        return reply.code(409).send({ error: "The original voice profile no longer exists." });
      try {
        if (await context.runtime.getVoiceProfilePerson(parsed.data.replaceVoiceId) !== person.id)
          return reply.code(409).send({ error: "The original voice profile is not bound to this Person." });
      } catch {
        return reply.code(503).send({ error: "The original voice binding is unavailable." });
      }
    }

    try {
      await context.voiceControlReceiptAdmission.admit({
        operation: "PRODUCT_VOICE_ENROLL",
        newVoiceProfileId,
        personId: person.id,
        ...(parsed.data.replaceVoiceId ? { replaceVoiceProfileId: parsed.data.replaceVoiceId } : {})
      });
    } catch (error) {
      const failure = toVoiceControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }

    let enrolled;
    try {
      enrolled = await profiles.enroll({
        voiceProfileId: newVoiceProfileId,
        label: person.displayName,
        audioBase64: combined.toString("base64"),
        mimeType: "audio/wav"
      });
    } catch {
      return reply.code(503).send({ error: "Receipt recorded; voice profile enrollment failed." });
    }
    if (enrolled.voiceProfileId !== newVoiceProfileId)
      return reply.code(409).send({ error: "Receipt recorded; provider returned an unexpected profile." });
    try {
      retainVoiceSample(clips[0]!.toString("base64"), newVoiceProfileId);
    } catch {
      return reply.code(503).send({ error: "Voice profile enrolled; private review sample could not be retained." });
    }
    try {
      const bound = await context.runtime.bindVoiceProfileToPerson(newVoiceProfileId, person.id);
      if (!("status" in bound) || bound.status !== "STORED")
        return reply.code(409).send({ error: "Voice enrolled; binding failed. Review it in Unknown Voices." });
    } catch {
      return reply.code(503).send({ error: "Voice enrolled; binding could not be completed." });
    }

    if (parsed.data.replaceVoiceId) {
      try {
        if (await context.runtime.getVoiceProfilePerson(parsed.data.replaceVoiceId) !== person.id)
          return reply.code(409).send({ error: "New voice saved; original binding changed, so it was retained." });
      } catch {
        return reply.code(503).send({ error: "New voice saved; original binding could not be revalidated." });
      }
      try {
        const removed = await context.runtime.removeVoiceProfileBinding(parsed.data.replaceVoiceId);
        if (removed.status !== "STORED") return reply.code(409).send({ error: "New voice saved; old binding removal failed." });
      } catch {
        return reply.code(409).send({ error: "New voice saved; old binding removal failed." });
      }
      try {
        await profiles.delete(parsed.data.replaceVoiceId);
        for (const sample of voiceReviews().filter(r => r.voiceProfileId === parsed.data.replaceVoiceId)) {
          updateVoiceReview(sample.id, null);
        }
      } catch {
        return reply.code(409).send({ error: "New voice saved; old voice profile cleanup failed." });
      }
    }
    return { ok: true };
  });
  app.delete("/product/voices/:id/binding", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const params = z.object({ id: z.string().min(1).max(160) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid voice profile ID." });
    if (!context.runtime.canManageVoiceProfileBindings())
      return reply.code(503).send({ error: "Voice binding storage is unavailable." });
    try {
      await context.voiceControlReceiptAdmission.admit({
        operation: "VOICE_PROFILE_BINDING_REMOVE",
        voiceProfileId: params.data.id
      });
    } catch (error) {
      const failure = toVoiceControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }
    try {
      const result = await context.runtime.removeVoiceProfileBinding(params.data.id);
      return reply.code(result.status === "STORED" ? 200 : 409).send(result);
    } catch {
      return reply.code(409).send({ error: "Voice binding could not be removed." });
    }
  });
}
