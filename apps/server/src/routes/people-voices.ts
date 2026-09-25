import { productVoiceProfiles } from "../services/packaged-voice.js";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { requireLocalDashboardAccess } from "./security.js";
import { readProductSettings } from "../services/product-store.js";
import { boundedWav, retainVoiceSample, updateVoiceReview, voiceReviews } from "../services/voice-review.js";
import { toVoiceControlAdmissionFailure } from "../voice-control-receipt-admission.js";

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
    const row = voiceReviews().find(r => r.id === (req.params as { id: string }).id);
    if (!row) return reply.code(404).send({ error: "Sample deleted or expired." });
    return reply.header("Cache-Control", "no-store").type("audio/wav").send(Buffer.from(row.sample, "base64"));
  });
  app.delete("/product/voice-samples/:id", async (req, reply) => { if (!requireLocalDashboardAccess(config, req, reply)) return; updateVoiceReview((req.params as { id: string }).id, null); return { ok: true }; });
  app.post("/product/voice-samples/:id/review", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const parsed = z.object({ personId: z.string().optional(), leaveUnknown: z.boolean().optional() }).strict().safeParse(req.body);
    const row = voiceReviews().find(r => r.id === (req.params as { id: string }).id);
    if (!row || !parsed.success) return reply.code(400).send({ error: "Invalid review." });
    if (parsed.data.leaveUnknown) { updateVoiceReview(row.id, { leftUnknown: true }); return { ok: true }; }
    const person = readProductSettings()?.people.find(p => p.id === parsed.data.personId);
    const profiles = productVoiceProfiles(context);
    if (!person || !profiles) return reply.code(409).send({ error: "Select a saved Person and configure local speaker recognition." });
    try {
      let id = row.voiceProfileId;
      if (!id) {
        const enrolled = await profiles.enroll({ voiceProfileId: randomUUID(), label: person.displayName, audioBase64: row.sample, mimeType: "audio/wav" });
        id = enrolled.voiceProfileId; updateVoiceReview(row.id, { voiceProfileId: id });
      }
      const bound = await context.runtime.bindVoiceProfileToPerson(id, person.id);
      if (!("status" in bound) || bound.status !== "STORED") return reply.code(409).send({ error: "Voice enrolled; binding was not stored. Check Memory and retry." });
      return { ok: true };
    } catch { return reply.code(503).send({ error: "Voice review could not be applied." }); }
  });
  app.post("/product/voices/enroll", { bodyLimit: 4_000_000 }, async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const parsed = z.object({ personId: z.string(), recordings: z.array(z.string().max(1_100_000)).min(3).max(5), replaceVoiceId: z.string().optional() }).strict().safeParse(req.body);
    const person = parsed.success ? readProductSettings()?.people.find(p => p.id === parsed.data.personId) : undefined;
    const profiles = productVoiceProfiles(context);
    if (!parsed.success || !person || !profiles) return reply.code(400).send({ error: "Select a Person and record three short utterances." });
    try {
      const clips = parsed.data.recordings.map(boundedWav);
      if (clips.some(c => !c.subarray(20, 36).equals(clips[0]!.subarray(20, 36)))) throw new Error();
      const data = Buffer.concat(clips.map(c => c.subarray(44)));
      const combined = Buffer.concat([clips[0]!.subarray(0, 44), data]); combined.writeUInt32LE(combined.length - 8, 4); combined.writeUInt32LE(data.length, 40);
      const enrolled = await profiles.enroll({ voiceProfileId: randomUUID(), label: person.displayName, audioBase64: combined.toString("base64"), mimeType: "audio/wav" });
      retainVoiceSample(clips[0]!.toString("base64"), enrolled.voiceProfileId);
      const bound = await context.runtime.bindVoiceProfileToPerson(enrolled.voiceProfileId, person.id);
      if (!("status" in bound) || bound.status !== "STORED") return reply.code(409).send({ error: "Voice enrolled but binding failed. Review it in Unknown Voices." });
      if (parsed.data.replaceVoiceId) {
        if (await context.runtime.getVoiceProfilePerson(parsed.data.replaceVoiceId) !== person.id) return reply.code(409).send({ error: "New voice saved; original binding changed, so it was retained." });
        const removed = await context.runtime.removeVoiceProfileBinding(parsed.data.replaceVoiceId);
        if (removed.status !== "STORED") return reply.code(409).send({ error: "New voice saved; old binding removal failed." });
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
    } catch { return reply.code(422).send({ error: "Enrollment failed. Use clear mono speech recordings." }); }
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
