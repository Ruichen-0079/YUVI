import { productVoiceProfiles } from "../services/packaged-voice.js";
import {
  retainEnrollmentSamples,
  retainVoiceSample,
  voiceReviews,
  updateVoiceReview
} from "../services/voice-review.js";
import { executeAcousticProfileCommand } from "../services/acoustic-profile-command.js";
import { governVoiceBinding } from "../services/voice-binding-command.js";
import { isAbsolute } from "node:path";
import {
  correctionFromP8CorrectionRecord,
  parseP8CorrectionRecord,
  type P8ExplicitCorrection
} from "@companion/p8";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { localServicesStatus } from "../services/local-services.js";
import { toRuntimeControlAdmissionFailure } from "../runtime-control-receipt-admission.js";
import { readProductSettings } from "../services/product-store.js";
import { hasLocalDashboardAccess, requireLocalDashboardAccess } from "./security.js";

const audio = z.object({
  audioBase64: z.string().min(1).max(24_000_000),
  mimeType: z.literal("audio/wav")
});

export async function registerLocalServiceRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
) {
  await registerP8CorrectionRoutes(app, context, config);
  app.post("/voice-profiles/:id/person", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    const parsed = z
      .object({
        personId: z.string().trim().min(1).max(160),
        commandHandle: z.string().trim().min(1).max(256)
      })
      .strict()
      .safeParse(request.body);
    const params = z.object({ id: z.string().min(1).max(160) }).safeParse(request.params);
    if (!parsed.success || !params.success)
      return reply.code(400).send({ error: "invalid_person_binding" });
    let settings;
    try {
      settings = readProductSettings();
    } catch {
      return reply.code(503).send({ error: "person_binding_unavailable" });
    }
    const person = settings?.people.find((row) => row.id === parsed.data.personId);
    if (!person) return reply.code(404).send({ error: "person_not_found" });
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    try {
      if (!context.runtime.canManageVoiceProfileBindings())
        return reply.code(503).send({ error: "person_binding_unavailable" });
      if (!(await profiles.list()).some((profile) => profile.voiceProfileId === params.data.id))
        return reply.code(404).send({ error: "voice_profile_not_found" });
      const result = await governVoiceBinding(
        context,
        {
          commandHandle: parsed.data.commandHandle,
          voiceProfileId: params.data.id,
          personId: parsed.data.personId,
          personaId: person.personaId
        },
        () => hasLocalDashboardAccess(config, request)
      );
      if (result.status === "ALREADY_BOUND")
        return { status: "ALREADY_BOUND", personId: parsed.data.personId };
      if (result.status === "APPLIED")
        return {
          status: "STORED",
          personId: parsed.data.personId,
          controlReceiptRef: result.receiptRef,
          intentId: result.intentId
        };
      if (result.status === "PROVEN_NOT_APPLIED" || result.status === "CONFLICT")
        return reply.code(409).send({ error: result.reason ?? result.status });
      return reply
        .code(result.status === "DENIED" ? 403 : 503)
        .send({ error: result.reason ?? result.status });
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
      .extend({
        label: z.string().trim().min(1).max(100),
        commandHandle: z.string().trim().min(1).max(256)
      })
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
    const voiceProfileId = `voice_${createHash("sha256").update(parsed.data.commandHandle).digest("hex").slice(0, 32)}`;
    try {
      const samples = retainEnrollmentSamples(
        [parsed.data.audioBase64],
        `${parsed.data.commandHandle}:samples`
      );
      const result = await executeAcousticProfileCommand(
        context,
        {
          commandHandle: `${parsed.data.commandHandle}:acoustic-enroll`,
          operation: "ENROLL",
          voiceProfileId,
          label: parsed.data.label,
          ...samples
        },
        () => hasLocalDashboardAccess(config, request)
      );
      if (result.status !== "APPLIED")
        return reply
          .code(result.status === "UNAVAILABLE" || result.status === "UNKNOWN" ? 503 : 409)
          .send({ error: result.reason ?? result.status });
      retainVoiceSample(parsed.data.audioBase64, voiceProfileId);
      return { voiceProfileId, label: parsed.data.label };
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
    const query = z
      .object({ commandHandle: z.string().trim().min(1).max(256) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "command_handle_required" });
    const profiles = productVoiceProfiles(context);
    if (!profiles) return reply.code(409).send({ error: "voice_profiles_unavailable" });
    if (!context.runtime.canManageVoiceProfileBindings())
      return reply.code(503).send({ error: "profile_delete_failed" });
    const bindings = await context.runtime.getVoiceProfileBindingAuthorityState();
    if (bindings.status !== "AVAILABLE")
      return reply.code(503).send({ error: "profile_delete_failed" });
    const profileBindings = bindings.bindings.filter(
      (binding) => binding.voiceProfileId === params.data.id
    );
    if (profileBindings.some((binding) => binding.status === "ACTIVE"))
      return reply
        .code(409)
        .send({ error: "Remove the trusted binding before deleting this voice profile." });
    if (profileBindings.some((binding) => binding.status === "CONFLICT"))
      return reply.code(409).send({ error: "binding_conflict" });
    const result = await executeAcousticProfileCommand(
      context,
      {
        commandHandle: `${query.data.commandHandle}:acoustic-delete`,
        operation: "DELETE",
        voiceProfileId: params.data.id
      },
      () => hasLocalDashboardAccess(config, request)
    );
    if (result.status !== "APPLIED")
      return reply
        .code(result.status === "UNAVAILABLE" || result.status === "UNKNOWN" ? 503 : 409)
        .send({ error: result.reason ?? result.status });
    for (const sample of voiceReviews().filter((r) => r.voiceProfileId === params.data.id))
      updateVoiceReview(sample.id, null);
    return { ok: true };
  });
}

export async function registerP8CorrectionRoutes(
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

    // Keep the existing P8 validator in front of A9 admission. The native owner
    // repeats this inspection immediately before its write, so a concurrent
    // correction is still resolved by the authoritative store.
    const preflight = await context.runtime.preflightP8Correction(correction);
    if (preflight === "INVALID") return reply.code(400).send({ error: "invalid_p8_correction" });
    if (preflight === "CONFLICT") return reply.code(409).send({ error: "p8_correction_conflict" });
    if (preflight !== "READY") return reply.code(503).send({ error: "p8_correction_unavailable" });

    const owner = await context.runtime.getP8CorrectionOwnerRevision(correction);
    if (owner.status !== "AVAILABLE")
      return reply.code(503).send({ error: "p8_correction_unavailable" });
    const result = await context.productPersonCommands.execute(
      {
        family: "P8_CORRECTION",
        commandHandle: correction.correctionReference,
        operation: correction.action,
        correctionReference: correction.correctionReference,
        expectedRevision: owner.revision,
        correction: structuredClone(correction) as unknown as Record<string, unknown>
      },
      () => hasLocalDashboardAccess(config, request)
    );
    if (result.status === "APPLIED")
      return {
        status: "STORED",
        correctionReference: correction.correctionReference,
        controlReceiptRef: result.receiptRef,
        intentId: result.intentId
      };
    if (result.status === "PROVEN_NOT_APPLIED" || result.status === "CONFLICT")
      return reply.code(409).send({ status: result.status, error: result.reason ?? result.status });
    if (result.status === "DENIED")
      return reply.code(403).send({ error: result.reason ?? "CONTROL_DENIED" });
    return reply
      .code(503)
      .send({ status: "UNKNOWN", error: result.reason ?? "P8_CORRECTION_OUTCOME_UNKNOWN" });
  });
}
