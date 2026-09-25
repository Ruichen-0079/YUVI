import { productVoiceProfiles } from "../services/packaged-voice.js";
import { retainVoiceSample, voiceReviews, updateVoiceReview } from "../services/voice-review.js";
import { isAbsolute } from "node:path";
import {
  correctionFromP8CorrectionRecord,
  parseP8CorrectionRecord,
  type P8ExplicitCorrection
} from "@companion/p8";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { localServicesStatus } from "../services/local-services.js";
import { toRuntimeControlAdmissionFailure } from "../runtime-control-receipt-admission.js";
import { toVoiceControlAdmissionFailure } from "../voice-control-receipt-admission.js";
import { readProductSettings } from "../services/product-store.js";
import { requireLocalDashboardAccess } from "./security.js";

const audio = z.object({
  audioBase64: z.string().min(1).max(24_000_000),
  mimeType: z.literal("audio/wav")
});

export async function registerLocalServiceRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
) {
  app.post("/p8/corrections", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    let correction: P8ExplicitCorrection;
    try {
      correction = correctionFromP8CorrectionRecord(parseP8CorrectionRecord(request.body));
    } catch {
      return reply.code(400).send({ error: "invalid_p8_correction" });
    }

    const preflight = await context.runtime.preflightP8Correction(correction);
    if (preflight === "CONFLICT") return reply.code(409).send({ status: "CONFLICT" });
    if (preflight === "UNAVAILABLE" || preflight === "ERROR")
      return reply.code(503).send({ error: "p8_correction_unavailable" });
    if (preflight === "INVALID") return reply.code(400).send({ error: "invalid_p8_correction" });

    const receiptInput =
      correction.target.kind === "INTERPRETATION"
        ? {
            operation: "P8_CORRECTION" as const,
            action: correction.action,
            targetKind: "INTERPRETATION" as const
          }
        : {
            operation: "P8_CORRECTION" as const,
            action: correction.action,
            targetKind: "AUTHORED_INVARIANT" as const,
            invariantTarget: correction.target.invariantTarget
          };
    try {
      await context.runtimeControlReceiptAdmission.admit(receiptInput);
    } catch (error) {
      const failure = toRuntimeControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }

    try {
      const result = await context.runtime.appendP8Correction(correction);
      return reply
        .code(result.status === "STORED" || result.status === "ALREADY_STORED" ? 200 : 409)
        .send(result);
    } catch {
      // The CONTROL receipt has committed. Keep the P8 rejection bounded and
      // never attempt to remove the admission fact.
      return reply.code(400).send({ error: "invalid_p8_correction" });
    }
  });
  app.post("/voice-profiles/:id/person", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = z
      .object({ personId: z.string().trim().min(1).max(160) })
      .strict()
      .safeParse(request.body);
    const params = z.object({ id: z.string().min(1).max(160) }).safeParse(request.params);
    if (!parsed.success || !params.success)
      return reply.code(400).send({ error: "invalid_person_binding" });
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      if (!(await profiles.list()).some((profile) => profile.voiceProfileId === params.data.id))
        return reply.code(404).send({ error: "voice_profile_not_found" });
      let settings;
      try {
        settings = readProductSettings();
      } catch {
        return reply.code(503).send({ error: "person_binding_unavailable" });
      }
      if (!settings) return reply.code(409).send({ error: "person_not_found" });
      if (!settings.people.some((person) => person.id === parsed.data.personId))
        return reply.code(404).send({ error: "person_not_found" });
      if (!context.runtime.canManageVoiceProfileBindings())
        return reply.code(503).send({ error: "person_binding_unavailable" });
      try {
        await context.voiceControlReceiptAdmission.admit({
          operation: "VOICE_PROFILE_BIND_PERSON",
          voiceProfileId: params.data.id,
          personId: parsed.data.personId
        });
      } catch (error) {
        const failure = toVoiceControlAdmissionFailure(error);
        return reply.code(failure.statusCode).send({ error: failure.code });
      }
      const result = await context.runtime.bindVoiceProfileToPerson(
        params.data.id,
        parsed.data.personId
      );
      return reply.code("status" in result && result.status === "STORED" ? 200 : 409).send(result);
    } catch {
      return reply.code(503).send({ error: "person_binding_unavailable" });
    }
  });
  app.post("/capabilities/read-text/authorize", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = z
      .object({
        sessionId: z
          .string()
          .min(1)
          .refine((value) => value.trim().length > 0),
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => value === value.trim())
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success || !isAbsolute(parsed.data.path))
      return reply.code(400).send({ error: "invalid_read_text_authorization" });

    try {
      await context.runtimeControlReceiptAdmission.admit({ operation: "READ_TEXT_AUTHORIZE" });
    } catch (error) {
      const failure = toRuntimeControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }
    try {
      context.runtime.authorizeReadText(parsed.data.sessionId, parsed.data.path);
    } catch {
      // Route preflight and Runtime share the accepted input constraints. If
      // Runtime still rejects, the committed receipt remains admission only.
      return reply.code(400).send({ error: "invalid_read_text_authorization" });
    }
    return { status: "AUTHORIZED" };
  });
  app.get("/local-services/status", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    return localServicesStatus(context);
  });
  app.get("/voice-profiles", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      return { profiles: await profiles.list() };
    } catch {
      return reply.code(503).send({ error: "voice_profiles_unavailable" });
    }
  });
  app.post("/voice-profiles", { bodyLimit: 24_001_024 }, async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = audio
      .extend({ label: z.string().trim().min(1).max(100) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_recording" });
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      await profiles.list();
    } catch {
      return reply.code(503).send({ error: "voice_profiles_unavailable" });
    }
    const voiceProfileId = randomUUID();
    try {
      await context.voiceControlReceiptAdmission.admit({
        operation: "VOICE_PROFILE_ENROLL",
        voiceProfileId
      });
    } catch (error) {
      const failure = toVoiceControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }
    try {
      const profile = await profiles.enroll({ ...parsed.data, voiceProfileId });
      try { retainVoiceSample(parsed.data.audioBase64, profile.voiceProfileId); } catch { /* Old clients may supply unsupported sample formats. */ }
      return profile;
    } catch {
      return reply
        .code(422)
        .send({ error: "enrollment_failed", message: "Use a clear recording of one speaker." });
    }
  });
  app.post("/voice-profiles/identify", { bodyLimit: 24_001_024 }, async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = audio.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_recording" });
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      return await profiles.identify(parsed.data);
    } catch {
      return reply.code(422).send({ error: "identification_failed" });
    }
  });
  app.delete<{ Params: { id: string } }>("/voice-profiles/:id", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const params = z.object({ id: z.string().min(1).max(160) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_voice_profile_id" });
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      const available = await profiles.list();
      if (!available.some((profile) => profile.voiceProfileId === params.data.id))
        return reply.code(404).send({ error: "voice_profile_not_found" });
    } catch {
      return reply.code(503).send({ error: "voice_profiles_unavailable" });
    }
    if (!context.runtime.canManageVoiceProfileBindings())
      return reply.code(503).send({ error: "profile_delete_failed" });
    try {
      await context.voiceControlReceiptAdmission.admit({
        operation: "VOICE_PROFILE_DELETE",
        voiceProfileId: params.data.id
      });
    } catch (error) {
      const failure = toVoiceControlAdmissionFailure(error);
      return reply.code(failure.statusCode).send({ error: failure.code });
    }
    try {
      const removed = await context.runtime.removeVoiceProfileBinding(params.data.id);
      if (removed.status !== "STORED") return reply.code(409).send({ error: "Remove the trusted binding before deleting this voice profile." });
      await profiles.delete(params.data.id);
      for (const sample of voiceReviews().filter(r => r.voiceProfileId === params.data.id)) updateVoiceReview(sample.id, null);
      return { ok: true };
    } catch {
      return reply.code(503).send({ error: "profile_delete_failed" });
    }
  });
}
