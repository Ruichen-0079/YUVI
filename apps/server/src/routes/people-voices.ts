import { productVoiceProfiles } from "../services/packaged-voice.js";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { ServerConfig } from "../config.js";
import { hasLocalDashboardAccess, requireLocalDashboardAccess } from "./security.js";
import { readProductSettings } from "../services/product-store.js";
import {
  retainEnrollmentSamples,
  retainVoiceSample,
  updateVoiceReview,
  productVoiceReviews,
  readVoiceCommandSamples,
  type VoiceReview
} from "../services/voice-review.js";
import { executeAcousticProfileCommand } from "../services/acoustic-profile-command.js";
import { governVoiceBinding } from "../services/voice-binding-command.js";
import {
  createAcousticReplacementWorkflowPlan
} from "../product-person-command-effects.js";
import { toVoiceControlAdmissionFailure } from "../voice-control-receipt-admission.js";

const boundedId = z.string().trim().min(1).max(160);
const voiceSampleParams = z.object({ id: boundedId }).strict();
const VoiceSampleReviewRequest = z.union([
  z.object({ leaveUnknown: z.literal(true) }).strict(),
  z.object({ personId: boundedId, commandHandle: z.string().trim().min(1).max(256) }).strict()
]);
const ProductVoiceEnrollmentRequest = z
  .object({
    personId: boundedId,
    commandHandle: z.string().trim().min(1).max(256),
    recordings: z.array(z.string().max(1_100_000)).min(3).max(5),
    replaceVoiceId: boundedId.optional()
  })
  .strict();

function readReviewAfterAdmission(id: string): VoiceReview | undefined {
  try {
    return productVoiceReviews().find((row) => row.id === id);
  } catch {
    return undefined;
  }
}

function sameReviewSnapshot(before: VoiceReview, after: VoiceReview): boolean {
  return (
    before.id === after.id &&
    before.createdAt === after.createdAt &&
    before.voiceProfileId === after.voiceProfileId &&
    before.leftUnknown === after.leftUnknown &&
    before.sample === after.sample
  );
}

export async function registerPeopleVoiceRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
) {
  app.get("/product/voices", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const profiles = productVoiceProfiles(context);
    try {
      const records = profiles ? await profiles.list() : [];
      const rows = productVoiceReviews();
      const voices = await Promise.all(
        records.map(async (p) => ({
          id: p.voiceProfileId,
          label: p.label,
          personId: await context.runtime.getVoiceProfilePerson(p.voiceProfileId),
          sampleId: rows.find((r) => r.voiceProfileId === p.voiceProfileId)?.id
        }))
      );
      return {
        available: Boolean(profiles),
        voices,
        unknown: rows
          .filter((r) => !voices.some((v) => v.id === r.voiceProfileId && v.personId))
          .map(({ sample, voiceProfileId, ...r }) => r)
      };
    } catch {
      return reply.code(503).send({ error: "Voice profiles or trusted bindings unavailable." });
    }
  });
  app.get("/product/voice-samples/:id", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const params = voiceSampleParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid sample ID." });
    const row = productVoiceReviews().find((r) => r.id === params.data.id);
    if (!row) return reply.code(404).send({ error: "Sample deleted or expired." });
    return reply
      .header("Cache-Control", "no-store")
      .type("audio/wav")
      .send(Buffer.from(row.sample, "base64"));
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
    if (!params.success || !parsed.success)
      return reply.code(400).send({ error: "Invalid review." });
    let row: VoiceReview | undefined;
    try {
      row = productVoiceReviews().find((r) => r.id === params.data.id);
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
        return reply
          .code(503)
          .send({ error: "Receipt recorded; voice review could not be saved." });
      }
    }
    const personId = (parsed.data as { personId?: string }).personId;
    const commandHandle = (parsed.data as { commandHandle?: string }).commandHandle;
    if (!personId || !commandHandle) return reply.code(400).send({ error: "Invalid review." });

    let settings;
    try {
      settings = readProductSettings();
    } catch {
      return reply.code(503).send({ error: "Saved People are unavailable." });
    }
    const person = settings?.people.find((p) => p.id === personId);
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
    if (!enrollFromSample && !profileRows.some((p) => p.voiceProfileId === row.voiceProfileId))
      return reply.code(409).send({ error: "The sample voice profile no longer exists." });
    const voiceProfileId =
      row.voiceProfileId ??
      `voice_${createHash("sha256").update(commandHandle).digest("hex").slice(0, 32)}`;

    const current = readReviewAfterAdmission(row.id);
    if (!current || !sameReviewSnapshot(row, current))
      return reply.code(409).send({ error: "Voice review changed before it could be applied." });

    if (enrollFromSample) {
      try {
        const samples = retainEnrollmentSamples(
          [current.sample],
          `${commandHandle}:acoustic-samples`
        );
        const enrolled = await executeAcousticProfileCommand(
          context,
          {
            commandHandle: `${commandHandle}:acoustic-enroll`,
            operation: "ENROLL",
            voiceProfileId,
            label: person.displayName,
            ...samples
          },
          () => hasLocalDashboardAccess(config, req)
        );
        if (enrolled.status !== "APPLIED")
          return reply
            .code(enrolled.status === "UNAVAILABLE" || enrolled.status === "UNKNOWN" ? 503 : 409)
            .send({ error: enrolled.reason ?? enrolled.status });
      } catch {
        return reply.code(503).send({ error: "Voice profile enrollment outcome is unavailable." });
      }
      try {
        if (!updateVoiceReview(row.id, { voiceProfileId }))
          return reply
            .code(409)
            .send({ error: "Voice profile enrolled; the review sample was deleted." });
      } catch {
        return reply
          .code(503)
          .send({ error: "Voice profile enrolled; sample association failed." });
      }
    } else {
      try {
        if (!(await profiles.list()).some((p) => p.voiceProfileId === voiceProfileId))
          return reply
            .code(409)
            .send({ error: "Receipt recorded; the voice profile no longer exists." });
      } catch {
        return reply.code(503).send({ error: "Receipt recorded; voice profiles are unavailable." });
      }
      const latest = readReviewAfterAdmission(row.id);
      if (!latest || !sameReviewSnapshot(row, latest))
        return reply.code(409).send({ error: "Voice review changed before it could be applied." });
    }

    const bound = await governVoiceBinding(
      context,
      {
        commandHandle: `${commandHandle}:binding`,
        voiceProfileId,
        personId: person.id,
        personaId: person.personaId
      },
      () => hasLocalDashboardAccess(config, req)
    );
    if (bound.status === "APPLIED" || bound.status === "ALREADY_BOUND")
      return {
        ok: true,
        ...(bound.status === "APPLIED" ? { controlReceiptRef: bound.receiptRef } : {})
      };
    return reply
      .code(bound.status === "UNAVAILABLE" ? 503 : 409)
      .send({ error: bound.reason ?? bound.status });
  });
  app.post("/product/voices/enroll", { bodyLimit: 4_000_000 }, async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const parsed = ProductVoiceEnrollmentRequest.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "Select a Person and record three short utterances." });
    let settings;
    try {
      settings = readProductSettings();
    } catch {
      return reply.code(503).send({ error: "Saved People are unavailable." });
    }
    const person = settings?.people.find((p) => p.id === parsed.data.personId);
    if (!person)
      return reply
        .code(400)
        .send({ error: "Select a saved Person and record three short utterances." });
    if (!context.runtime.canManageVoiceProfileBindings())
      return reply.code(503).send({ error: "Voice binding storage is unavailable." });

    let profiles;
    try {
      profiles = productVoiceProfiles(context);
      if (!profiles?.readAuthorityState)
        return reply.code(409).send({ error: "Configure local speaker recognition." });
      const snapshot = await profiles.readAuthorityState();
      if (!snapshot.complete)
        return reply.code(503).send({ error: "Voice profiles are unavailable." });
    } catch {
      return reply.code(503).send({ error: "Voice profiles are unavailable." });
    }
    const newVoiceProfileId = `voice_${createHash("sha256").update(parsed.data.commandHandle).digest("hex").slice(0, 32)}`;
    let retained: ReturnType<typeof retainEnrollmentSamples>;
    try {
      retained = retainEnrollmentSamples(
        parsed.data.recordings,
        `${parsed.data.commandHandle}:acoustic-samples`
      );
    } catch {
      return reply
        .code(422)
        .send({ error: "Enrollment samples are invalid or changed for this command." });
    }
    const replacementWorkflow = parsed.data.replaceVoiceId
      ? createAcousticReplacementWorkflowPlan({
          workflowId: parsed.data.commandHandle,
          newVoiceProfileId,
          previousVoiceProfileId: parsed.data.replaceVoiceId,
          personId: person.id,
          personaId: person.personaId,
          label: person.displayName,
          ...retained
        })
      : undefined;
    const acoustic = await executeAcousticProfileCommand(
      context,
      {
        commandHandle: `${parsed.data.commandHandle}:acoustic-enroll`,
        operation: "ENROLL",
        voiceProfileId: newVoiceProfileId,
        label: person.displayName,
        ...retained
      },
      () => hasLocalDashboardAccess(config, req),
      replacementWorkflow
        ? { plan: replacementWorkflow, stepKey: "enroll_new" }
        : undefined
    );
    if (acoustic.status !== "APPLIED")
      return reply
        .code(acoustic.status === "UNAVAILABLE" || acoustic.status === "UNKNOWN" ? 503 : 409)
        .send({ error: acoustic.reason ?? acoustic.status });
    try {
      const sample = readVoiceCommandSamples(
        [retained.sampleReferences[0]!],
        [retained.sampleDigests[0]!]
      )[0]!;
      retainVoiceSample(sample, newVoiceProfileId);
    } catch {
      return reply
        .code(503)
        .send({ error: "Voice profile enrolled; private review sample could not be retained." });
    }
    const bound = await governVoiceBinding(
      context,
      {
        commandHandle: `${parsed.data.commandHandle}:binding`,
        voiceProfileId: newVoiceProfileId,
        personId: person.id,
        personaId: person.personaId,
        ...(parsed.data.replaceVoiceId
          ? { previousVoiceProfileId: parsed.data.replaceVoiceId }
          : {})
      },
      () => hasLocalDashboardAccess(config, req),
      replacementWorkflow
        ? { plan: replacementWorkflow, stepKey: "switch_binding" }
        : undefined
    );
    if (bound.status !== "APPLIED" && bound.status !== "ALREADY_BOUND")
      return reply
        .code(bound.status === "UNAVAILABLE" ? 503 : 409)
        .send({ error: bound.reason ?? bound.status });

    if (parsed.data.replaceVoiceId) {
      const retired = await executeAcousticProfileCommand(
        context,
        {
          commandHandle: `${parsed.data.commandHandle}:acoustic-retire-old`,
          operation: "DELETE",
          voiceProfileId: parsed.data.replaceVoiceId
        },
        () => hasLocalDashboardAccess(config, req),
        replacementWorkflow
          ? { plan: replacementWorkflow, stepKey: "retire_old" }
          : undefined
      );
      if (retired.status !== "APPLIED") {
        return reply
          .code(409)
          .send({ error: "New voice saved; old voice profile cleanup failed." });
      }
      for (const sample of productVoiceReviews().filter(
        (r) => r.voiceProfileId === parsed.data.replaceVoiceId
      ))
        updateVoiceReview(sample.id, null);
    }
    return { ok: true };
  });
  app.delete("/product/voices/:id/binding", async (req, reply) => {
    if (!requireLocalDashboardAccess(config, req, reply)) return;
    const params = z.object({ id: z.string().min(1).max(160) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid voice profile ID." });
    const query = z.object({ commandHandle: boundedId }).safeParse(req.query);
    if (!query.success)
      return reply.code(400).send({ error: "A stable commandHandle query parameter is required." });
    const replay = await context.productPersonCommands.resolveExisting(
      {
        family: "VOICE_BINDING",
        commandHandle: query.data.commandHandle,
        operation: "REMOVE",
        voiceProfileId: params.data.id,
        personaId: context.activeRuntimeEnv["MEMORY_PERSONA_ID"]?.trim() || "unresolved-persona",
        expectedBindingRevision: null
      },
      () => hasLocalDashboardAccess(config, req)
    );
    if (replay?.status === "APPLIED")
      return { status: "REMOVED", controlReceiptRef: replay.receiptRef, intentId: replay.intentId };
    if (replay)
      return reply
        .code(
          replay.status === "DENIED"
            ? 403
            : replay.status === "UNAVAILABLE" || replay.status === "UNKNOWN"
              ? 503
              : 409
        )
        .send({ error: replay.reason ?? replay.status });
    if (!context.runtime.canManageVoiceProfileBindings())
      return reply.code(503).send({ error: "Voice binding storage is unavailable." });
    const binding = await context.runtime.getVoiceProfileBindingState(params.data.id);
    if (binding.status !== "AVAILABLE")
      return reply.code(503).send({ error: "Voice binding storage is unavailable." });
    if (binding.state.status === "UNBOUND") return { status: "ALREADY_UNBOUND" };
    if (binding.state.status === "CONFLICT")
      return reply.code(409).send({ error: "binding_conflict" });
    const result = await context.productPersonCommands.execute(
      {
        family: "VOICE_BINDING",
        commandHandle: query.data.commandHandle,
        operation: "REMOVE",
        voiceProfileId: params.data.id,
        personaId: binding.state.personaId,
        expectedBindingRevision: binding.state.revision
      },
      () => hasLocalDashboardAccess(config, req)
    );
    if (result.status === "APPLIED")
      return { status: "REMOVED", controlReceiptRef: result.receiptRef, intentId: result.intentId };
    return reply
      .code(result.status === "UNAVAILABLE" || result.status === "UNKNOWN" ? 503 : 409)
      .send({ error: result.reason ?? result.status });
  });
}
