import { randomBytes, randomUUID } from "node:crypto";
import type { PostgresPool as Pool, PostgresPoolClient as PoolClient } from "@companion/database";
import { z } from "zod";
import {
  canonicalEffectJson,
  decodeEffectIntent,
  effectDigest,
  effectIntentId,
  EffectIntentError,
  EffectIdentitySnapshotSchema,
  EFFECT_DELIVERY_CONTRACTS,
  type EffectAttemptV1,
  type EffectAuthority,
  type EffectDispatchStore,
  type EffectDispatcher,
  type EffectIntent,
  type EffectIntentRequest,
  type EffectEvidence,
  type NativeOwnerCommitV1,
  type HostEffectIntentAdmission
} from "@companion/effects";
import {
  JOURNAL_COMMAND_VERSION,
  JOURNAL_SELECTOR_VERSION,
  type JournalCommittedEnvelope,
  type JournalEventRef,
  type JournalPayloadDescriptor
} from "@companion/protocol";
import type {
  JournalAuthorityDraft,
  JournalHostAppendInput,
  JournalRepository
} from "@companion/journal";
import {
  applyProductPersonCommand,
  fenceProductPersonCommand,
  readProductSettings,
  reconcileProductPersonCommand,
  type ProductPersonCommandPayload,
  type ProductPersonCommandReceipt,
  withProductSettingsOwner
} from "./services/product-store.js";

const nativeControlContract = "yuvi.native-control.v1" as const;
const personCommandRequestSchema = z
  .object({
    commandHandle: z.string().trim().min(1).max(256),
    operation: z.enum(["CREATE", "UPDATE"]),
    personId: z.string().min(1).max(512).optional(),
    displayName: z.string().trim().min(1).max(100),
    personaId: z.string().trim().min(1).max(100),
    notes: z.string().max(4000),
    requestedPrimary: z.boolean(),
    expectedPersonRevision: z.string().nullable(),
    expectedPrimaryRevision: z.string().nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === "CREATE" && value.personId !== undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Create target is allocated by the native owner."
      });
    if (value.operation === "UPDATE" && value.personId === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Update requires an exact Person target."
      });
  });
const voiceBindingCommandRequestSchema = z
  .object({
    family: z.literal("VOICE_BINDING"),
    commandHandle: z.string().trim().min(1).max(256),
    operation: z.enum(["ASSIGN", "REPLACE", "REMOVE"]),
    voiceProfileId: z.string().trim().min(1).max(160),
    personaId: z.string().trim().min(1).max(100),
    personId: z.string().trim().min(1).max(512).optional(),
    expectedBindingRevision: z.string().nullable(),
    previousVoiceProfileId: z.string().trim().min(1).max(160).optional(),
    previousPersonaId: z.string().trim().min(1).max(100).optional(),
    expectedPreviousBindingRevision: z.string().nullable().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === "REMOVE" && value.personId !== undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Remove cannot target a new Person."
      });
    if (value.operation !== "REMOVE" && value.personId === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Assignment requires an exact Person target."
      });
    if (
      (value.previousVoiceProfileId === undefined) !==
      (value.expectedPreviousBindingRevision === undefined)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cross-profile replacement requires its exact prior revision."
      });
    if (value.previousPersonaId !== undefined && value.previousVoiceProfileId === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A prior persona requires an exact prior binding target."
      });
    if (value.previousVoiceProfileId === value.voiceProfileId &&
        (value.previousPersonaId ?? value.personaId) === value.personaId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A replacement source must be a distinct binding scope."
      });
    if (value.previousVoiceProfileId !== undefined && value.operation !== "REPLACE")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A previous profile is valid only for replacement."
      });
  });
const p8CommandRequestSchema = z
  .object({
    family: z.literal("P8_CORRECTION"),
    commandHandle: z.string().trim().min(1).max(160),
    operation: z.enum(["REVISE", "RETRACT"]),
    correctionReference: z.string().trim().min(1).max(160),
    expectedRevision: z.string().nullable(),
    correction: z.record(z.unknown())
  })
  .strict()
  .superRefine((value, context) => {
    if (value.commandHandle !== value.correctionReference)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "P8 correctionReference is the stable command handle."
      });
  });
const acousticProfileCommandRequestSchema = z
  .object({
    family: z.literal("ACOUSTIC_PROFILE"),
    commandHandle: z.string().trim().min(1).max(256),
    operation: z.enum(["ENROLL", "DELETE"]),
    voiceProfileId: z.string().trim().min(1).max(160),
    expectedAcousticRevision: z.string().nullable(),
    label: z.string().trim().min(1).max(100).optional(),
    sampleReferences: z.array(z.string().trim().min(1).max(160)).min(1).max(5).optional(),
    sampleDigests: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(5)
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.operation === "ENROLL" &&
      (!value.label ||
        !value.sampleReferences ||
        !value.sampleDigests ||
        value.sampleReferences.length !== value.sampleDigests.length)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enrollment requires matching private sample references and digests."
      });
    if (
      value.operation === "DELETE" &&
      (value.label !== undefined ||
        value.sampleReferences !== undefined ||
        value.sampleDigests !== undefined)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Deletion cannot contain enrollment material."
      });
  });
const commandRequestSchema = z.union([
  personCommandRequestSchema,
  voiceBindingCommandRequestSchema,
  p8CommandRequestSchema,
  acousticProfileCommandRequestSchema
]);
export type ProductPersonCommandInput = z.infer<typeof commandRequestSchema>;
type CommandInput = ProductPersonCommandInput;
type PersonCommandInput = z.infer<typeof personCommandRequestSchema>;
export type VoiceBindingCommandInput = z.infer<typeof voiceBindingCommandRequestSchema>;
export type P8CorrectionCommandInput = z.infer<typeof p8CommandRequestSchema>;
export type AcousticProfileCommandInput = z.infer<typeof acousticProfileCommandRequestSchema>;
type NativeCommandFamily =
  | "PRODUCT_PERSON"
  | "VOICE_BINDING"
  | "P8_CORRECTION"
  | "ACOUSTIC_PROFILE";
export type NativeControlWorkflowPlanV1 = Readonly<{
  version: "native-control-workflow.v1";
  workflowId: string;
  kind: "ACOUSTIC_PROFILE_REPLACEMENT";
  steps: readonly Readonly<{
    stepKey: string;
    ordinal: number;
    commandHandle: string;
    family: NativeCommandFamily;
    operation: string;
    targetReference: string;
    relatedTargetReference?: string;
    semanticDigest: string;
  }>[];
}>;
export type NativeControlWorkflowChild = Readonly<{
  plan: NativeControlWorkflowPlanV1;
  stepKey: string;
}>;
const nativeControlWorkflowPlanSchema = z
  .object({
    version: z.literal("native-control-workflow.v1"),
    workflowId: z.string().trim().min(1).max(256),
    kind: z.literal("ACOUSTIC_PROFILE_REPLACEMENT"),
    steps: z.array(z.object({
      stepKey: z.string().trim().min(1).max(80),
      ordinal: z.number().int().min(0).max(2),
      commandHandle: z.string().trim().min(1).max(256),
      family: z.enum(["PRODUCT_PERSON", "VOICE_BINDING", "P8_CORRECTION", "ACOUSTIC_PROFILE"]),
      operation: z.string().trim().min(1).max(32),
      targetReference: z.string().trim().min(1).max(512),
      relatedTargetReference: z.string().trim().min(1).max(512).optional(),
      semanticDigest: z.string().regex(/^[a-f0-9]{64}$/)
    }).strict()).length(3)
  })
  .strict()
  .superRefine((plan, context) => {
    const expected = [
      { stepKey: "enroll_new", family: "ACOUSTIC_PROFILE", operation: "ENROLL", suffix: ":acoustic-enroll" },
      { stepKey: "switch_binding", family: "VOICE_BINDING", operation: "REPLACE", suffix: ":binding" },
      { stepKey: "retire_old", family: "ACOUSTIC_PROFILE", operation: "DELETE", suffix: ":acoustic-retire-old" }
    ] as const;
    plan.steps.forEach((step, index) => {
      const rule = expected[index]!;
      if (step.ordinal !== index || step.stepKey !== rule.stepKey || step.family !== rule.family ||
          step.operation !== rule.operation || step.commandHandle !== `${plan.workflowId}${rule.suffix}`)
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index], message: "Invalid frozen workflow step." });
    });
    if (plan.steps[0]?.targetReference !== plan.steps[1]?.targetReference ||
        plan.steps[1]?.relatedTargetReference !== plan.steps[2]?.targetReference)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Replacement targets do not form one binding switch." });
    if (new Set(plan.steps.map((step) => step.stepKey)).size !== 3 ||
        new Set(plan.steps.map((step) => step.commandHandle)).size !== 3)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Workflow child identities must be unique." });
  });
const nativeControlWorkflowChildSchema = z.object({
  plan: nativeControlWorkflowPlanSchema,
  stepKey: z.string().trim().min(1).max(80)
}).strict();

/** Build the fixed, predeclared three-child replacement workflow without a parent A9 command. */
export function createAcousticReplacementWorkflowPlan(input: {
  workflowId: string;
  newVoiceProfileId: string;
  previousVoiceProfileId: string;
  personId: string;
  personaId: string;
  label: string;
  sampleReferences: readonly string[];
  sampleDigests: readonly string[];
}): NativeControlWorkflowPlanV1 {
  const commands: Array<{ stepKey: string; command: CommandInput }> = [
    {
      stepKey: "enroll_new",
      command: {
        family: "ACOUSTIC_PROFILE",
        commandHandle: `${input.workflowId}:acoustic-enroll`,
        operation: "ENROLL",
        voiceProfileId: input.newVoiceProfileId,
        expectedAcousticRevision: null,
        label: input.label,
        sampleReferences: [...input.sampleReferences],
        sampleDigests: [...input.sampleDigests]
      }
    },
    {
      stepKey: "switch_binding",
      command: {
        family: "VOICE_BINDING",
        commandHandle: `${input.workflowId}:binding`,
        operation: "REPLACE",
        voiceProfileId: input.newVoiceProfileId,
        personaId: input.personaId,
        personId: input.personId,
        expectedBindingRevision: null,
        previousVoiceProfileId: input.previousVoiceProfileId,
        expectedPreviousBindingRevision: null
      }
    },
    {
      stepKey: "retire_old",
      command: {
        family: "ACOUSTIC_PROFILE",
        commandHandle: `${input.workflowId}:acoustic-retire-old`,
        operation: "DELETE",
        voiceProfileId: input.previousVoiceProfileId,
        expectedAcousticRevision: null
      }
    }
  ];
  if (!input.workflowId || input.workflowId.length > 256 || input.newVoiceProfileId === input.previousVoiceProfileId)
    throw new Error("Invalid acoustic replacement workflow identity.");
  const steps = commands.map(({ stepKey, command }, ordinal) => {
    const parsed = commandRequestSchema.parse(command);
    const family = familyOf(parsed);
    const targetReference = nativeTargetReference(parsed);
    return Object.freeze({
      stepKey,
      ordinal,
      commandHandle: parsed.commandHandle,
      family,
      operation: parsed.operation,
      targetReference,
      ...("family" in parsed && parsed.family === "VOICE_BINDING" && parsed.previousVoiceProfileId
        ? { relatedTargetReference: parsed.previousVoiceProfileId }
        : {}),
      semanticDigest: effectDigest(semanticBody(parsed))
    });
  });
  return Object.freeze({
    version: "native-control-workflow.v1",
    workflowId: input.workflowId,
    kind: "ACOUSTIC_PROFILE_REPLACEMENT",
    steps: Object.freeze(steps)
  });
}
type ProductPersonProtectedCommand = Readonly<{
  version: "product-person-command-payload.v1";
  family: "PRODUCT_PERSON";
  commandHandle: string;
  operation: "CREATE" | "UPDATE";
  personId: string;
  displayName: string;
  personaId: string;
  notes: string;
  requestedPrimary: boolean;
  expectedPersonRevision: string | null;
  expectedPrimaryRevision: string | null;
  semanticDigest: string;
}>;
const productPersonProtectedCommandSchema = z
  .object({
    version: z.literal("product-person-command-payload.v1"),
    family: z.literal("PRODUCT_PERSON"),
    commandHandle: z.string().min(1).max(256),
    operation: z.enum(["CREATE", "UPDATE"]),
    personId: z.string().min(1).max(512),
    displayName: z.string().trim().min(1).max(100),
    personaId: z.string().trim().min(1).max(100),
    notes: z.string().max(4000),
    requestedPrimary: z.boolean(),
    expectedPersonRevision: z.string().nullable(),
    expectedPrimaryRevision: z.string().nullable(),
    semanticDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type VoiceBindingProtectedCommand = Readonly<{
  version: "voice-binding-command-payload.v1";
  family: "VOICE_BINDING";
  commandHandle: string;
  operation: "ASSIGN" | "REPLACE" | "REMOVE";
  voiceProfileId: string;
  personaId: string;
  personId?: string;
  expectedBindingRevision: string | null;
  previousVoiceProfileId?: string;
  previousPersonaId?: string;
  expectedPreviousBindingRevision?: string | null;
  semanticDigest: string;
}>;
const voiceBindingProtectedCommandSchema = z
  .object({
    version: z.literal("voice-binding-command-payload.v1"),
    family: z.literal("VOICE_BINDING"),
    commandHandle: z.string().min(1).max(256),
    operation: z.enum(["ASSIGN", "REPLACE", "REMOVE"]),
    voiceProfileId: z.string().min(1).max(160),
    personaId: z.string().min(1).max(100),
    personId: z.string().min(1).max(512).optional(),
    expectedBindingRevision: z.string().nullable(),
    previousVoiceProfileId: z.string().min(1).max(160).optional(),
    previousPersonaId: z.string().min(1).max(100).optional(),
    expectedPreviousBindingRevision: z.string().nullable().optional(),
    semanticDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type P8CorrectionProtectedCommand = Readonly<{
  version: "p8-correction-command-payload.v1";
  family: "P8_CORRECTION";
  commandHandle: string;
  operation: "REVISE" | "RETRACT";
  correctionReference: string;
  expectedRevision: string | null;
  correction: Record<string, unknown>;
  semanticDigest: string;
}>;
const p8CorrectionProtectedCommandSchema = z
  .object({
    version: z.literal("p8-correction-command-payload.v1"),
    family: z.literal("P8_CORRECTION"),
    commandHandle: z.string().min(1).max(160),
    operation: z.enum(["REVISE", "RETRACT"]),
    correctionReference: z.string().min(1).max(160),
    expectedRevision: z.string().nullable(),
    correction: z.record(z.unknown()),
    semanticDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type AcousticProfileProtectedCommand = Readonly<{
  version: "acoustic-profile-command-payload.v1";
  family: "ACOUSTIC_PROFILE";
  commandHandle: string;
  operation: "ENROLL" | "DELETE";
  voiceProfileId: string;
  expectedAcousticRevision: string | null;
  label?: string;
  sampleReferences?: readonly string[];
  sampleDigests?: readonly string[];
  semanticDigest: string;
}>;
const acousticProfileCommandSchema = z
  .object({
    version: z.literal("acoustic-profile-command-payload.v1"),
    family: z.literal("ACOUSTIC_PROFILE"),
    commandHandle: z.string().min(1).max(256),
    operation: z.enum(["ENROLL", "DELETE"]),
    voiceProfileId: z.string().min(1).max(160),
    expectedAcousticRevision: z.string().nullable(),
    label: z.string().trim().min(1).max(100).optional(),
    sampleReferences: z.array(z.string().min(1).max(160)).min(1).max(5).optional(),
    sampleDigests: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(5)
      .optional(),
    semanticDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
type ProtectedCommand =
  | ProductPersonProtectedCommand
  | VoiceBindingProtectedCommand
  | P8CorrectionProtectedCommand
  | AcousticProfileProtectedCommand;
export type NativeControlOwnerCommand =
  | VoiceBindingProtectedCommand
  | P8CorrectionProtectedCommand
  | AcousticProfileProtectedCommand;
const protectedCommandSchema = z.discriminatedUnion("family", [
  productPersonProtectedCommandSchema,
  voiceBindingProtectedCommandSchema,
  p8CorrectionProtectedCommandSchema,
  acousticProfileCommandSchema
]);
type PayloadRow = {
  payload_ref: string;
  intent_id: string | null;
  installation_namespace: string;
  command_handle: string;
  target_reference: string;
  payload_digest: string;
  semantic_digest: string;
  payload_state: "AVAILABLE" | "REDACTED";
  payload: unknown | null;
};
export type ProductPersonCommandResult = Readonly<{
  status: "APPLIED" | "PROVEN_NOT_APPLIED" | "UNKNOWN" | "CONFLICT" | "DENIED" | "UNAVAILABLE";
  personId?: string;
  targetReference?: string;
  receiptRef?: JournalEventRef;
  intentId?: string;
  personRevision?: string;
  primaryPersonRevision?: string | null;
  reason?: string;
}>;
export interface ProductPersonCommandPort {
  execute(input: CommandInput, current: () => boolean, workflowChild?: NativeControlWorkflowChild): Promise<ProductPersonCommandResult>;
  resolveExisting(
    input: CommandInput,
    current: () => boolean,
    workflowChild?: NativeControlWorkflowChild
  ): Promise<ProductPersonCommandResult | null>;
}
export interface NativeControlOwnerHandler {
  invoke(
    command: NativeControlOwnerCommand,
    intent: EffectIntent,
    attempt: EffectAttemptV1,
    signal: AbortSignal
  ): Promise<EffectEvidence>;
  reconcile(
    command: NativeControlOwnerCommand,
    intent: EffectIntent,
    attempt: EffectAttemptV1,
    signal: AbortSignal
  ): Promise<EffectEvidence>;
}

/** One A9 worker adapter for fixed Product Person commands; Journal, intent, payload and pending work commit together. */
export class HostProductPersonCommandEffects implements ProductPersonCommandPort {
  private accepting = true;
  private readonly dispatchCurrentness = new Map<string, () => boolean>();
  private readonly ownerHandlers = new Map<
    "VOICE_BINDING" | "P8_CORRECTION" | "ACOUSTIC_PROFILE",
    NativeControlOwnerHandler
  >();

  constructor(
    private readonly pool: Pool | null,
    private readonly journal: JournalRepository | null,
    private readonly admission: HostEffectIntentAdmission,
    private readonly dispatchStore: EffectDispatchStore | null,
    private readonly dispatcher: EffectDispatcher | null,
    private readonly installationNamespace: string
  ) {
    if (dispatcher) {
      dispatcher.registerAdapter({
        contractRef: nativeControlContract,
        adapter: EFFECT_DELIVERY_CONTRACTS[nativeControlContract].adapter,
        isCurrent: (intent) => this.isCurrent(intent),
        invoke: (intent, attempt, signal) => this.invoke(intent, attempt, signal),
        reconcile: (intent, attempt, signal) => this.reconcile(intent, attempt, signal)
      });
    }
  }

  registerOwnerHandler(
    family: "VOICE_BINDING" | "P8_CORRECTION" | "ACOUSTIC_PROFILE",
    handler: NativeControlOwnerHandler
  ) {
    if (!this.accepting || this.ownerHandlers.has(family))
      throw new Error("Native owner handler is already registered or unavailable.");
    this.ownerHandlers.set(family, handler);
  }

  async execute(
    rawInput: CommandInput,
    current: () => boolean,
    rawWorkflowChild?: NativeControlWorkflowChild
  ): Promise<ProductPersonCommandResult> {
    const parsed = commandRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { status: "CONFLICT", reason: "INVALID_COMMAND" };
    if (
      !this.accepting ||
      !this.pool ||
      !this.journal ||
      !this.dispatchStore ||
      !this.dispatcher ||
      !this.journal.appendWithHostAuthorityInTransaction
    )
      return { status: "UNAVAILABLE", reason: "DURABLE_NATIVE_CONTROL_UNAVAILABLE" };
    const input = parsed.data;
    const family = familyOf(input);
    const semanticDigest = effectDigest(semanticBody(input));
    const workflowChild = parseWorkflowChild(rawWorkflowChild, input, semanticDigest);
    if (workflowChild === false) return { status: "CONFLICT", reason: "INVALID_WORKFLOW_CHILD" };
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      return { status: "UNAVAILABLE", reason: "POSTGRES_UNAVAILABLE" };
    }
    let began = false;
    try {
      await client.query("begin");
      began = true;
      const ownerKey = `yuvi.native-control.v1|${this.installationNamespace}|${family}|${input.commandHandle}`;
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerKey]);
      await this.requireWorkflowCoordinator(client, input.commandHandle, workflowChild);
      const existingPayloadResult = await client.query(
        `select * from effect_command_payloads where contract_ref=$1 and installation_namespace=$2 and command_handle=$3 for update`,
        [nativeControlContract, this.installationNamespace, input.commandHandle]
      );
      let intent: EffectIntent;
      let receiptRef: JournalEventRef;
      let targetReference: string;
      let payloadRef: string;
      if (existingPayloadResult.rows[0]) {
        const row = existingPayloadResult.rows[0] as PayloadRow;
        if (row.semantic_digest !== semanticDigest) {
          await client.query("rollback");
          began = false;
          return { status: "CONFLICT", reason: "COMMAND_HANDLE_REUSED" };
        }
        targetReference = row.target_reference;
        payloadRef = row.payload_ref;
        if (!row.intent_id)
          throw new EffectIntentError(
            "INTEGRITY_FAILURE",
            "Native payload has no exact A9 intent link."
          );
        const existingIntentResult = await client.query(
          `select * from effect_intents where contract_ref=$1 and intent_id=$2 for update`,
          [nativeControlContract, row.intent_id]
        );
        if (!existingIntentResult.rows[0])
          throw new EffectIntentError("INTEGRITY_FAILURE", "Native payload has no A9 intent.");
        intent = decodeEffectIntent(existingIntentResult.rows[0]);
        const descriptor = intent.request.payload as
          | {
              version?: unknown;
              family?: unknown;
              commandHandle?: unknown;
              payloadRef?: unknown;
              payloadDigest?: unknown;
              semanticDigest?: unknown;
              targetReference?: unknown;
            }
          | undefined;
        if (
          intent.decision === "ADMITTED" &&
          (descriptor?.family !== family ||
            descriptor?.payloadRef !== row.payload_ref ||
            descriptor.payloadDigest !== row.payload_digest ||
            descriptor.semanticDigest !== semanticDigest ||
            descriptor.targetReference !== row.target_reference ||
            descriptor.commandHandle !== input.commandHandle)
        )
          throw new EffectIntentError(
            "INTEGRITY_FAILURE",
            "Native payload and A9 intent disagree."
          );
        const reference = intent.request.causalRefs[0];
        if (!reference)
          throw new EffectIntentError("INTEGRITY_FAILURE", "Native intent has no CONTROL receipt.");
        receiptRef = reference;
      } else {
        targetReference =
          family === "PRODUCT_PERSON"
            ? input.operation === "CREATE"
              ? randomUUID()
              : (input as PersonCommandInput).personId!
            : family === "VOICE_BINDING"
              ? (input as VoiceBindingCommandInput).voiceProfileId
              : family === "P8_CORRECTION"
                ? (input as P8CorrectionCommandInput).correctionReference
                : (input as AcousticProfileCommandInput).voiceProfileId;
        const protectedCommand = protectedCommandFor(input, targetReference, semanticDigest);
        const protectedDigest = effectDigest(protectedCommand);
        payloadRef = `cmd_${randomBytes(24).toString("base64url")}`;
        await client.query(
          `insert into effect_command_payloads
           (payload_ref,contract_ref,installation_namespace,command_handle,target_reference,payload_digest,semantic_digest,payload_state,payload)
           values($1,$2,$3,$4,$5,$6,$7,'AVAILABLE',$8::jsonb)`,
          [
            payloadRef,
            nativeControlContract,
            this.installationNamespace,
            input.commandHandle,
            targetReference,
            protectedDigest,
            semanticDigest,
            canonicalEffectJson(protectedCommand)
          ]
        );
        const summary = commandSummary(input, targetReference, protectedDigest);
        const receipt = this.receiptAppend(summary, family);
        const staged = await this.journal.appendWithHostAuthorityInTransaction(
          client,
          receipt.input,
          receipt.authority
        );
        const envelope = staged.envelope as JournalCommittedEnvelope;
        receiptRef = {
          kind: "JOURNAL_EVENT",
          namespace: envelope.journalNamespace,
          eventId: envelope.eventId
        };
        const identity = EffectIdentitySnapshotSchema.parse({
          principal: envelope.authority.principal,
          subjects: envelope.authority.subjects,
          binding: envelope.authority.binding,
          audience: envelope.authority.audience,
          disclosurePolicy: envelope.authority.disclosurePolicy
        });
        const scope = commandScope(input, targetReference);
        const request: EffectIntentRequest = {
          contractRef: nativeControlContract,
          logicalKey: this.logicalKey(family, scope, targetReference, input.commandHandle),
          scope,
          audience: identity.audience,
          payload: {
            version: "native-control-command.v1",
            family,
            commandHandle: input.commandHandle,
            payloadRef,
            payloadDigest: protectedDigest,
            semanticDigest,
            targetReference
          },
          causalRefs: [receiptRef],
          executionId: null,
          expiresAt: new Date(Date.now() + 120_000).toISOString()
        };
        const authority: EffectAuthority = {
          snapshot: {
            policyVersion: `native-control:${family.toLowerCase()}.v1`,
            authorityVersion: `command:${input.commandHandle}`,
            scope,
            identity,
            permissions: ["NATIVE_CONTROL_COMMAND"],
            allowed: true
          },
          isCurrent: () => this.accepting && current()
        };
        intent = await this.admission.admitWithExactReceiptInTransaction(
          request,
          authority,
          envelope,
          client
        );
        await client.query(
          `update effect_command_payloads set intent_id=$1 where payload_ref=$2 and intent_id is null`,
          [intent.intentId, payloadRef]
        );
      }
      await this.recordWorkflowChild(
        client,
        workflowChild,
        input,
        semanticDigest,
        targetReference,
        payloadRef,
        intent
      );
      if (intent.decision === "ADMITTED" && intent.workState === "WITHHELD") {
        await client.query("commit");
        began = false;
        return {
          status: "UNKNOWN",
          targetReference,
          ...(family === "PRODUCT_PERSON" ? { personId: targetReference } : {}),
          receiptRef,
          intentId: intent.intentId,
          reason: "COMMAND_WITHHELD"
        };
      }
      if (
        intent.decision === "ADMITTED" &&
        intent.workState !== "PENDING" &&
        intent.workState !== "CLAIMED"
      )
        throw new EffectIntentError(
          "INTEGRITY_FAILURE",
          "Native command admission is not dispatchable."
        );
      if (intent.decision === "ADMITTED") this.dispatchCurrentness.set(intent.intentId, current);
      await client.query("commit");
      began = false;
      if (intent.decision !== "ADMITTED") {
        return {
          status: "DENIED",
          targetReference,
          ...(family === "PRODUCT_PERSON" ? { personId: targetReference } : {}),
          receiptRef,
          intentId: intent.intentId,
          ...(intent.reasonCode ? { reason: intent.reasonCode } : {})
        };
      }
      return await this.observeAndProject(intent, targetReference, receiptRef, payloadRef);
    } catch (error) {
      if (began) await client.query("rollback").catch(() => undefined);
      return {
        status:
          error instanceof EffectIntentError && error.code === "CONFLICT"
            ? "CONFLICT"
            : "UNAVAILABLE",
        reason: error instanceof EffectIntentError ? error.code : "NATIVE_CONTROL_ADMISSION_FAILED"
      };
    } finally {
      client.release();
    }
  }

  /** Resolve a stable command handle before callers inspect mutable native state for a retry. */
  async resolveExisting(
    rawInput: CommandInput,
    current: () => boolean,
    rawWorkflowChild?: NativeControlWorkflowChild
  ): Promise<ProductPersonCommandResult | null> {
    const parsed = commandRequestSchema.safeParse(rawInput);
    if (!parsed.success) return { status: "CONFLICT", reason: "INVALID_COMMAND" };
    if (!this.accepting || !this.pool || !this.dispatchStore || !this.dispatcher)
      return { status: "UNAVAILABLE", reason: "DURABLE_NATIVE_CONTROL_UNAVAILABLE" };
    const input = parsed.data;
    const family = familyOf(input);
    const semanticDigest = effectDigest(semanticBody(input));
    const workflowChild = parseWorkflowChild(rawWorkflowChild, input, semanticDigest);
    if (workflowChild === false) return { status: "CONFLICT", reason: "INVALID_WORKFLOW_CHILD" };
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      return { status: "UNAVAILABLE", reason: "POSTGRES_UNAVAILABLE" };
    }
    let began = false;
    try {
      await client.query("begin");
      began = true;
      const ownerKey = `yuvi.native-control.v1|${this.installationNamespace}|${family}|${input.commandHandle}`;
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerKey]);
      await this.requireWorkflowCoordinator(client, input.commandHandle, workflowChild);
      const payloadResult = await client.query(
        `select * from effect_command_payloads where contract_ref=$1 and installation_namespace=$2 and command_handle=$3 for update`,
        [nativeControlContract, this.installationNamespace, input.commandHandle]
      );
      const row = payloadResult.rows[0] as PayloadRow | undefined;
      if (!row) {
        await client.query("commit");
        began = false;
        return null;
      }
      if (row.semantic_digest !== semanticDigest) {
        await client.query("commit");
        began = false;
        return { status: "CONFLICT", reason: "COMMAND_HANDLE_REUSED" };
      }
      if (!row.intent_id)
        throw new EffectIntentError(
          "INTEGRITY_FAILURE",
          "Native payload has no exact A9 intent link."
        );
      const intentResult = await client.query(
        `select * from effect_intents where contract_ref=$1 and intent_id=$2 for update`,
        [nativeControlContract, row.intent_id]
      );
      if (!intentResult.rows[0])
        throw new EffectIntentError("INTEGRITY_FAILURE", "Native payload has no A9 intent.");
      const intent = decodeEffectIntent(intentResult.rows[0]);
      const descriptor = intent.request.payload as
        | {
            family?: unknown;
            commandHandle?: unknown;
            payloadRef?: unknown;
            payloadDigest?: unknown;
            semanticDigest?: unknown;
            targetReference?: unknown;
          }
        | undefined;
      if (
        intent.decision === "ADMITTED" &&
        (descriptor?.family !== family ||
          descriptor.payloadRef !== row.payload_ref ||
          descriptor.payloadDigest !== row.payload_digest ||
          descriptor.semanticDigest !== semanticDigest ||
          descriptor.targetReference !== row.target_reference ||
          descriptor.commandHandle !== input.commandHandle)
      )
        throw new EffectIntentError("INTEGRITY_FAILURE", "Native payload and A9 intent disagree.");
      const receiptRef = intent.request.causalRefs[0];
      if (!receiptRef)
        throw new EffectIntentError("INTEGRITY_FAILURE", "Native intent has no CONTROL receipt.");
      if (workflowChild)
        await this.recordWorkflowChild(
          client,
          workflowChild,
          input,
          semanticDigest,
          row.target_reference,
          row.payload_ref,
          intent
        );
      if (intent.decision === "ADMITTED") this.dispatchCurrentness.set(intent.intentId, current);
      await client.query("commit");
      began = false;
      if (intent.decision !== "ADMITTED")
        return {
          status: "DENIED",
          targetReference: row.target_reference,
          ...(family === "PRODUCT_PERSON" ? { personId: row.target_reference } : {}),
          receiptRef,
          intentId: intent.intentId,
          ...(intent.reasonCode ? { reason: intent.reasonCode } : {})
        };
      return await this.observeAndProject(
        intent,
        row.target_reference,
        receiptRef,
        row.payload_ref
      );
    } catch (error) {
      if (began) await client.query("rollback").catch(() => undefined);
      return {
        status:
          error instanceof EffectIntentError && error.code === "CONFLICT"
            ? "CONFLICT"
            : "UNAVAILABLE",
        reason: error instanceof EffectIntentError ? error.code : "NATIVE_CONTROL_REPLAY_FAILED"
      };
    } finally {
      client.release();
    }
  }

  private async requireWorkflowCoordinator(
    client: PoolClient,
    commandHandle: string,
    workflowChild: NativeControlWorkflowChild | null
  ) {
    if (workflowChild) return;
    const planned = await client.query(
      `select workflow_id from native_control_workflows
       where installation_namespace=$1 and exists (
         select 1 from jsonb_array_elements(plan->'steps') step
         where step->>'commandHandle'=$2
       ) limit 1`,
      [this.installationNamespace, commandHandle]
    );
    const linked = await client.query(
      `select 1 from native_control_workflow_children where installation_namespace=$1 and command_handle=$2 limit 1`,
      [this.installationNamespace, commandHandle]
    );
    if (planned.rows.length || linked.rows.length)
      throw new EffectIntentError("CONFLICT", "Workflow child requires its immutable coordinator plan.");
  }

  private async recordWorkflowChild(
    client: PoolClient,
    workflowChild: NativeControlWorkflowChild | null,
    input: CommandInput,
    semanticDigest: string,
    targetReference: string,
    payloadRef: string,
    intent: EffectIntent
  ) {
    if (!workflowChild) return;
    const { plan, stepKey } = workflowChild;
    const step = plan.steps.find((candidate) => candidate.stepKey === stepKey);
    if (!step || step.commandHandle !== input.commandHandle || step.family !== familyOf(input) ||
        step.operation !== input.operation || step.targetReference !== targetReference ||
        step.semanticDigest !== semanticDigest ||
        ("family" in input && input.family === "VOICE_BINDING" && step.relatedTargetReference !== input.previousVoiceProfileId))
      throw new EffectIntentError("CONFLICT", "Workflow child does not match its immutable plan.");

    const planDigest = effectDigest(plan);
    const existingPlan = await client.query(
      `select plan_digest,plan from native_control_workflows
       where installation_namespace=$1 and workflow_id=$2 for update`,
      [this.installationNamespace, plan.workflowId]
    );
    if (!existingPlan.rows[0]) {
      if (step.ordinal !== 0)
        throw new EffectIntentError("CONFLICT", "Workflow cannot start after its first child.");
      await client.query(
        `insert into native_control_workflows(installation_namespace,workflow_id,workflow_kind,plan_digest,plan)
         values($1,$2,$3,$4,$5::jsonb)`,
        [this.installationNamespace, plan.workflowId, plan.kind, planDigest, canonicalEffectJson(plan)]
      );
    } else if (
      existingPlan.rows[0]["plan_digest"] !== planDigest ||
      effectDigest(existingPlan.rows[0]["plan"]) !== planDigest
    ) {
      throw new EffectIntentError("CONFLICT", "Workflow plan changed after admission.");
    }

    for (const predecessor of plan.steps.slice(0, step.ordinal)) {
      const result = await client.query(
        `select c.intent_id,o.evidence
         from native_control_workflow_children c
         left join lateral (
           select attempt_id from effect_attempts where intent_id=c.intent_id order by ordinal desc limit 1
         ) a on true
         left join lateral (
           select evidence from effect_observations where attempt_id=a.attempt_id order by observation_id desc limit 1
         ) o on true
         where c.installation_namespace=$1 and c.workflow_id=$2 and c.step_key=$3 for update of c`,
        [this.installationNamespace, plan.workflowId, predecessor.stepKey]
      );
      const evidence = result.rows[0]?.["evidence"] as
        | { certainty?: string; layer?: string }
        | null
        | undefined;
      if (!result.rows[0] || !evidence || evidence.certainty !== "APPLIED" ||
          typeof evidence.layer !== "string" || !evidence.layer.startsWith("NATIVE_OWNER_"))
        throw new EffectIntentError("CONFLICT", "Workflow predecessor lacks native-owner APPLIED evidence.");
    }

    const priorChild = await client.query(
      `select step_key,ordinal,command_handle,intent_id,payload_ref from native_control_workflow_children
       where installation_namespace=$1 and workflow_id=$2 and step_key=$3 for update`,
      [this.installationNamespace, plan.workflowId, stepKey]
    );
    const prior = priorChild.rows[0] as
      | { step_key: string; ordinal: number; command_handle: string; intent_id: string; payload_ref: string }
      | undefined;
    if (prior) {
      if (prior.ordinal !== step.ordinal || prior.command_handle !== input.commandHandle ||
          prior.intent_id !== intent.intentId || prior.payload_ref !== payloadRef)
        throw new EffectIntentError("CONFLICT", "Workflow child reference changed after admission.");
      return;
    }
    await client.query(
      `insert into native_control_workflow_children
       (installation_namespace,workflow_id,step_key,ordinal,command_handle,intent_id,payload_ref)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [this.installationNamespace, plan.workflowId, stepKey, step.ordinal, input.commandHandle, intent.intentId, payloadRef]
    );
  }

  private async observeAndProject(
    intent: EffectIntent,
    targetReference: string,
    receiptRef: JournalEventRef,
    payloadRef: string
  ) {
    const descriptor = intent.request.payload as {
      family: NativeCommandFamily;
      commandHandle: string;
      payloadDigest: string;
    };
    const target = {
      targetReference,
      ...(descriptor.family === "PRODUCT_PERSON" ? { personId: targetReference } : {})
    };
    if (!this.dispatcher || !this.pool)
      return { status: "UNAVAILABLE" as const, ...target, receiptRef, intentId: intent.intentId };
    try {
      await this.dispatcher.run(intent.intentId);
    } catch {
      // The durable attempt and native owner receipt decide recovery; transport exceptions do not.
    }
    let diagnostic;
    try {
      diagnostic = await this.dispatcher.diagnostic(intent.intentId);
    } catch {
      return { status: "UNKNOWN" as const, ...target, receiptRef, intentId: intent.intentId };
    }
    const evidence = diagnostic?.evidence;
    if (!evidence)
      return { status: "UNKNOWN" as const, ...target, receiptRef, intentId: intent.intentId };
    this.dispatchCurrentness.delete(intent.intentId);
    if (evidence.certainty === "APPLIED" && evidence.layer.startsWith("NATIVE_OWNER_")) {
      if (descriptor.family === "PRODUCT_PERSON") {
        const current = readProductSettings();
        const receipt = current?.productCommandReceipts?.find(
          (item) => item.commandHandle === descriptor.commandHandle
        );
        if (
          !receipt ||
          receipt.intentId !== intent.intentId ||
          receipt.payloadDigest !== descriptor.payloadDigest
        )
          return { status: "UNKNOWN" as const, ...target, receiptRef, intentId: intent.intentId };
        await this.retirePayload(payloadRef, descriptor.payloadDigest);
        return {
          status: "APPLIED" as const,
          ...target,
          receiptRef,
          intentId: intent.intentId,
          personRevision: receipt.resultingPersonRevision,
          primaryPersonRevision: receipt.resultingPrimaryRevision
        };
      }
      await this.retirePayload(payloadRef, descriptor.payloadDigest);
      return { status: "APPLIED" as const, ...target, receiptRef, intentId: intent.intentId };
    }
    if (evidence.certainty === "DEFINITIVE_REJECTION") {
      await this.retirePayload(payloadRef, descriptor.payloadDigest);
      return {
        status: "CONFLICT" as const,
        ...target,
        receiptRef,
        intentId: intent.intentId,
        reason: "OWNER_REJECTED"
      };
    }
    if (evidence.certainty === "PROVEN_NOT_APPLIED") {
      return {
        status: "PROVEN_NOT_APPLIED" as const,
        ...target,
        receiptRef,
        intentId: intent.intentId,
        reason: evidence.reason
      };
    }
    return {
      status: "UNKNOWN" as const,
      ...target,
      receiptRef,
      intentId: intent.intentId,
      reason: evidence.reason
    };
  }

  private isCurrent(intent: EffectIntent) {
    const descriptor = intent.request.payload as
      | { family?: string; commandHandle?: string; semanticDigest?: string }
      | undefined;
    let authorized = false;
    try {
      authorized = this.dispatchCurrentness.get(intent.intentId)?.() === true;
    } catch {}
    return (
      this.accepting &&
      authorized &&
      intent.decision === "ADMITTED" &&
      (descriptor?.family === "PRODUCT_PERSON" ||
        descriptor?.family === "VOICE_BINDING" ||
        descriptor?.family === "P8_CORRECTION" ||
        descriptor?.family === "ACOUSTIC_PROFILE") &&
      typeof descriptor.commandHandle === "string" &&
      descriptor.commandHandle.length > 0 &&
      typeof descriptor.semanticDigest === "string" &&
      /^[a-f0-9]{64}$/.test(descriptor.semanticDigest)
    );
  }

  private async invoke(intent: EffectIntent, attempt: EffectAttemptV1, signal: AbortSignal) {
    signal.throwIfAborted();
    const loaded = await this.readProtectedPayload(intent);
    if (!loaded?.payload) throw new Error("Protected native command payload is unavailable.");
    if (loaded.payload.family !== "PRODUCT_PERSON") {
      const handler = this.ownerHandlers.get(loaded.payload.family);
      if (!handler) throw new Error("Native command owner is unavailable.");
      return { evidence: await handler.invoke(loaded.payload, intent, attempt, signal) };
    }
    const payload = payloadForOwner(loaded.payload, intent, attempt);
    const fenced = await fenceProductPersonCommand({
      commandHandle: payload.commandHandle,
      intentId: attempt.intentId,
      attemptId: attempt.attemptId,
      fence: attempt.fence,
      payloadDigest: payload.payloadDigest
    });
    if (fenced !== "READY") throw new Error("Native Product command fence is unavailable.");
    signal.throwIfAborted();
    const applied = await applyProductPersonCommand(payload);
    if (applied.status === "APPLIED")
      return {
        evidence: nativeEvidence("APPLIED", "NATIVE_OWNER_COMMIT", "OWNER_COMMITTED", productOwnerCommit(applied.receipt)),
        transientResult: { personId: applied.receipt.personId }
      };
    if (applied.status === "ALREADY_APPLIED")
      return {
        evidence: nativeEvidence(
          "APPLIED",
          "NATIVE_OWNER_RECONCILIATION",
          "OWNER_RECONCILED_APPLIED",
          productOwnerCommit(applied.receipt)
        ),
        transientResult: { personId: applied.receipt.personId }
      };
    if (applied.status === "PROVEN_NOT_APPLIED")
      return {
        evidence: nativeEvidence(
          "DEFINITIVE_REJECTION",
          "NATIVE_OWNER_RECONCILIATION",
          "OWNER_REJECTED"
        )
      };
    if (applied.status === "CONFLICT")
      return { evidence: nativeEvidence("DEFINITIVE_REJECTION", "NATIVE_OWNER_RECONCILIATION", "OWNER_REJECTED") };
    throw new Error("Native Product command result is ambiguous.");
  }

  private async reconcile(
    intent: EffectIntent,
    attempt: EffectAttemptV1,
    signal: AbortSignal
  ): Promise<EffectEvidence> {
    signal.throwIfAborted();
    const loaded = await this.readProtectedPayload(intent);
    if (!loaded) throw new Error("Protected native command descriptor is unavailable.");
    if (!loaded.payload) {
      const descriptor = intent.request.payload as {
        family: NativeCommandFamily;
        commandHandle: string;
      };
      if (descriptor.family !== "PRODUCT_PERSON")
        throw new Error(
          "Redacted native command cannot be reconciled without its exact owner instruction."
        );
      const settings = await withProductSettingsOwner(() => readProductSettings());
      const receipt = settings?.productCommandReceipts?.find(
        (item) => item.commandHandle === descriptor.commandHandle
      );
      if (
        receipt &&
        receipt.intentId === intent.intentId &&
        receipt.payloadDigest === loaded.row.payload_digest
      )
        return nativeEvidence("APPLIED", "NATIVE_OWNER_RECONCILIATION", "OWNER_RECONCILED_APPLIED", productOwnerCommit(receipt));
      throw new Error("Redacted native command has no exact owner receipt.");
    }
    if (loaded.payload.family !== "PRODUCT_PERSON") {
      const handler = this.ownerHandlers.get(loaded.payload.family);
      if (!handler) throw new Error("Native command owner is unavailable.");
      return handler.reconcile(loaded.payload, intent, attempt, signal);
    }
    const payload = payloadForOwner(loaded.payload, intent, attempt);
    const result = await reconcileProductPersonCommand({
      payload,
      attemptId: attempt.attemptId,
      fence: attempt.fence
    });
    if (result.status === "ALREADY_APPLIED")
      return nativeEvidence("APPLIED", "NATIVE_OWNER_RECONCILIATION", "OWNER_RECONCILED_APPLIED", productOwnerCommit(result.receipt));
    if (
      result.status === "PROVEN_NOT_APPLIED" &&
      result.reason === "NO_COMMAND_RECEIPT_AFTER_FENCE"
    )
      return nativeEvidence(
        "PROVEN_NOT_APPLIED",
        "NATIVE_OWNER_RECONCILIATION",
        "OWNER_RECONCILED_NOT_APPLIED"
      );
    throw new Error("Native owner could not reconcile this attempt.");
  }

  private async readProtectedPayload(
    intent: EffectIntent
  ): Promise<{ row: PayloadRow; payload: ProtectedCommand | null } | null> {
    if (!this.pool) return null;
    const descriptor = intent.request.payload as {
      family?: NativeCommandFamily;
      payloadRef?: string;
      payloadDigest?: string;
      commandHandle?: string;
      targetReference?: string;
    };
    const result = await this.pool.query(
      `select * from effect_command_payloads where payload_ref=$1 and contract_ref=$2 and installation_namespace=$3`,
      [descriptor.payloadRef, nativeControlContract, this.installationNamespace]
    );
    const row = result.rows[0] as PayloadRow | undefined;
    if (
      !row ||
      row.payload_digest !== descriptor.payloadDigest ||
      row.command_handle !== descriptor.commandHandle ||
      row.target_reference !== descriptor.targetReference
    )
      return null;
    if (row.payload_state === "REDACTED") return { row, payload: null };
    const parsed = protectedCommandSchema.safeParse(row.payload);
    let payload: ProtectedCommand | undefined;
    if (parsed.success) {
      if (parsed.data.family === "VOICE_BINDING") {
        const { personId, previousVoiceProfileId, previousPersonaId, expectedPreviousBindingRevision, ...rest } =
          parsed.data;
        payload = {
          ...rest,
          ...(typeof personId === "string" ? { personId } : {}),
          ...(typeof previousVoiceProfileId === "string" ? { previousVoiceProfileId } : {}),
          ...(typeof previousPersonaId === "string" ? { previousPersonaId } : {}),
          ...(typeof expectedPreviousBindingRevision === "string" ||
          expectedPreviousBindingRevision === null
            ? { expectedPreviousBindingRevision }
            : {})
        };
      } else if (parsed.data.family === "ACOUSTIC_PROFILE") {
        const { label, sampleReferences, sampleDigests, ...rest } = parsed.data;
        payload = {
          ...rest,
          ...(typeof label === "string" ? { label } : {}),
          ...(sampleReferences ? { sampleReferences } : {}),
          ...(sampleDigests ? { sampleDigests } : {})
        };
      } else payload = parsed.data;
    }
    const payloadTarget = payload
      ? payload.family === "PRODUCT_PERSON"
        ? payload.personId
        : payload.family === "VOICE_BINDING"
          ? payload.voiceProfileId
          : payload.family === "P8_CORRECTION"
            ? payload.correctionReference
            : payload.voiceProfileId
      : undefined;
    if (
      !payload ||
      effectDigest(payload) !== row.payload_digest ||
      payload.semanticDigest !== row.semantic_digest ||
      payload.family !== descriptor.family ||
      payloadTarget !== row.target_reference ||
      payload.commandHandle !== row.command_handle
    )
      throw new EffectIntentError(
        "INTEGRITY_FAILURE",
        "Protected native command payload failed its digest."
      );
    return { row, payload };
  }

  private async retirePayload(payloadRef: string, payloadDigest: string) {
    await this.pool?.query(
      `update effect_command_payloads set payload_state='REDACTED',payload=null where payload_ref=$1 and payload_digest=$2 and payload_state='AVAILABLE'`,
      [payloadRef, payloadDigest]
    );
  }

  private logicalKey(
    family: NativeCommandFamily,
    scope: string,
    targetReference: string,
    commandHandle: string
  ) {
    return `native-control.v1|${this.installationNamespace}|${family}|${scope}|${targetReference}|${commandHandle}`;
  }

  private receiptAppend(
    summary: string,
    family: NativeCommandFamily
  ): { input: JournalHostAppendInput; authority: JournalAuthorityDraft } {
    const textRef = {
      namespace: "yuvi:product-control",
      payloadId: `text_${randomBytes(24).toString("base64url")}`,
      version: "v1"
    };
    const characterCount = [...summary].length;
    const payloads: JournalPayloadDescriptor[] = [
      {
        ref: textRef,
        modality: "TEXT",
        retention: "RETAINED",
        origin: "USER_INPUT",
        selectable: characterCount > 0,
        characterCount
      }
    ];
    const input: JournalHostAppendInput = {
      command: {
        version: JOURNAL_COMMAND_VERSION,
        kind: "RECEIPT",
        occurrenceTime: { state: "UNKNOWN" },
        causalParents: [],
        data: {
          receiptClass: "CONTROL",
          evidenceSelectors: characterCount
            ? [
                {
                  version: JOURNAL_SELECTOR_VERSION,
                  modality: "TEXT",
                  payload: textRef,
                  range: { unit: "UNICODE_CODE_POINT", start: 0, end: characterCount }
                }
              ]
            : []
        }
      },
      retainedText: [{ ref: textRef, text: summary }]
    };
    const authority: JournalAuthorityDraft = {
      principal: {
        state: "UNRESOLVED",
        reason: "local dashboard access does not authenticate a human principal"
      },
      subjects: [],
      binding: {
        state: "UNRESOLVED",
        reason: "local dashboard access does not establish a Person binding"
      },
      surface: {
        kind: "LOCAL",
        reference:
          family === "PRODUCT_PERSON"
            ? "yuvi:http:/product/people"
            : family === "VOICE_BINDING"
              ? "yuvi:http:/voice-profile-bindings"
              : family === "ACOUSTIC_PROFILE"
                ? "yuvi:voice-profile-acoustic-control"
                : "yuvi:http:/p8/corrections"
      },
      correlations: [],
      audience: { kind: "UNKNOWN", reason: "local control has no audience or membership snapshot" },
      disclosurePolicy: {
        state: "UNRESOLVED",
        reason: "no local-control disclosure-policy snapshot is available"
      },
      policyVersion: "yuvi-product-control-receipt.v1",
      producer: { name: "yuvi-product-control-ingress", version: "0.1.3-a10.2" },
      sourceReferences: [
        {
          kind: "UNRESOLVED_SOURCE",
          reason: "the local command handle is an idempotency key, not a source assertion"
        }
      ],
      payloads
    };
    return { input, authority };
  }

  shutdown() {
    this.accepting = false;
    this.dispatchCurrentness.clear();
  }
}

function semanticCommand(input: PersonCommandInput) {
  return {
    operation: input.operation,
    ...(input.operation === "UPDATE" ? { personId: input.personId } : {}),
    displayName: input.displayName,
    notes: input.notes,
    requestedPrimary: input.requestedPrimary,
    expectedPersonRevision: input.expectedPersonRevision,
    expectedPrimaryRevision: input.expectedPrimaryRevision
  };
}
function familyOf(input: CommandInput): NativeCommandFamily {
  return "family" in input ? input.family : "PRODUCT_PERSON";
}
function nativeTargetReference(input: CommandInput): string {
  if (!("family" in input)) return input.operation === "UPDATE" ? input.personId! : "";
  if (input.family === "P8_CORRECTION") return input.correctionReference;
  return input.voiceProfileId;
}
function parseWorkflowChild(
  raw: NativeControlWorkflowChild | undefined,
  input: CommandInput,
  semanticDigest: string
): NativeControlWorkflowChild | null | false {
  if (raw === undefined) return null;
  const parsed = nativeControlWorkflowChildSchema.safeParse(raw);
  if (!parsed.success) return false;
  const step = parsed.data.plan.steps.find((candidate) => candidate.stepKey === parsed.data.stepKey);
  if (!step || step.commandHandle !== input.commandHandle || step.family !== familyOf(input) ||
      step.operation !== input.operation || step.targetReference !== nativeTargetReference(input) ||
      step.semanticDigest !== semanticDigest ||
      ("family" in input && input.family === "VOICE_BINDING" && step.relatedTargetReference !== input.previousVoiceProfileId) ||
      (!('family' in input) || input.family !== "VOICE_BINDING") && step.relatedTargetReference !== undefined)
    return false;
  return parsed.data as NativeControlWorkflowChild;
}
function semanticBody(input: CommandInput) {
  if (!("family" in input)) return semanticCommand(input);
  if (input.family === "VOICE_BINDING")
    return {
      family: input.family,
      voiceProfileId: input.voiceProfileId,
      personaId: input.personaId,
      ...(input.operation === "REMOVE"
        ? { desiredBinding: null }
        : { desiredBinding: { personId: input.personId } }),
      ...(input.previousVoiceProfileId && input.previousVoiceProfileId !== input.voiceProfileId
        ? { previousVoiceProfileId: input.previousVoiceProfileId }
        : {})
    };
  if (input.family === "P8_CORRECTION")
    return {
      family: input.family,
      operation: input.operation,
      correctionReference: input.correctionReference,
      correction: input.correction
    };
  return {
    family: input.family,
    operation: input.operation,
    voiceProfileId: input.voiceProfileId,
    label: input.label ?? null,
    sampleReferences: input.sampleReferences ?? [],
    sampleDigests: input.sampleDigests ?? []
  };
}
function protectedCommandFor(
  input: CommandInput,
  targetReference: string,
  semanticDigest: string
): ProtectedCommand {
  if (!("family" in input))
    return Object.freeze({
      version: "product-person-command-payload.v1",
      family: "PRODUCT_PERSON",
      commandHandle: input.commandHandle,
      operation: input.operation,
      personId: targetReference,
      displayName: input.displayName,
      personaId: input.personaId,
      notes: input.notes,
      requestedPrimary: input.requestedPrimary,
      expectedPersonRevision: input.expectedPersonRevision,
      expectedPrimaryRevision: input.expectedPrimaryRevision,
      semanticDigest
    });
  if (input.family === "VOICE_BINDING")
    return Object.freeze({
      version: "voice-binding-command-payload.v1",
      family: input.family,
      commandHandle: input.commandHandle,
      operation: input.operation,
      voiceProfileId: input.voiceProfileId,
      personaId: input.personaId,
      ...(typeof input.personId === "string" ? { personId: input.personId } : {}),
      expectedBindingRevision: input.expectedBindingRevision,
      ...(input.previousVoiceProfileId
        ? { previousVoiceProfileId: input.previousVoiceProfileId }
        : {}),
      ...(input.previousPersonaId ? { previousPersonaId: input.previousPersonaId } : {}),
      ...(input.expectedPreviousBindingRevision !== undefined
        ? { expectedPreviousBindingRevision: input.expectedPreviousBindingRevision }
        : {}),
      semanticDigest
    });
  if (input.family === "P8_CORRECTION")
    return Object.freeze({
      version: "p8-correction-command-payload.v1",
      family: input.family,
      commandHandle: input.commandHandle,
      operation: input.operation,
      correctionReference: input.correctionReference,
      expectedRevision: input.expectedRevision,
      correction: input.correction,
      semanticDigest
    });
  return Object.freeze({
    version: "acoustic-profile-command-payload.v1",
    family: input.family,
    commandHandle: input.commandHandle,
    operation: input.operation,
    voiceProfileId: targetReference,
    expectedAcousticRevision: input.expectedAcousticRevision,
    ...(input.label ? { label: input.label } : {}),
    ...(input.sampleReferences ? { sampleReferences: input.sampleReferences } : {}),
    ...(input.sampleDigests ? { sampleDigests: input.sampleDigests } : {}),
    semanticDigest
  });
}
function commandScope(input: CommandInput, targetReference: string) {
  if (!("family" in input)) return `product-person:${targetReference}`;
  if (input.family === "VOICE_BINDING")
    return `voice-binding:${input.previousPersonaId ?? input.personaId}:${input.previousVoiceProfileId ?? input.voiceProfileId}:${input.personaId}:${input.voiceProfileId}`;
  if (input.family === "ACOUSTIC_PROFILE") return `acoustic-profile:${targetReference}`;
  const address = input.correction["address"] as Record<string, unknown> | undefined;
  const scope = input.correction["scopeReference"] as Record<string, unknown> | undefined;
  return `p8:${JSON.stringify({
    characterInstanceId: address?.["characterInstanceId"] ?? null,
    personaProfileId: address?.["personaProfileId"] ?? null,
    subjectScopeId: address?.["subjectScopeId"] ?? null,
    scopeReference: scope?.["reference"] ?? null,
    correctionReference: targetReference
  })}`;
}
function commandSummary(input: CommandInput, targetReference: string, payloadDigest: string) {
  if (!("family" in input))
    return JSON.stringify({
      operation: input.operation === "CREATE" ? "product.person.create" : "product.person.update",
      commandHandle: input.commandHandle,
      personId: targetReference,
      requestedPrimary: input.requestedPrimary,
      expectedPersonRevision: input.expectedPersonRevision,
      expectedPrimaryRevision: input.expectedPrimaryRevision,
      payloadDigest
    });
  if (input.family === "VOICE_BINDING")
    return JSON.stringify({
      operation: `voice.binding.${input.operation.toLowerCase()}`,
      commandHandle: input.commandHandle,
      voiceProfileId: input.voiceProfileId,
      personaId: input.personaId,
      ...(input.personId ? { personId: input.personId } : {}),
      expectedBindingRevision: input.expectedBindingRevision,
      ...(input.previousVoiceProfileId ? { previousVoiceProfileId: input.previousVoiceProfileId } : {}),
      ...(input.previousPersonaId ? { previousPersonaId: input.previousPersonaId } : {}),
      ...(input.expectedPreviousBindingRevision !== undefined
        ? { expectedPreviousBindingRevision: input.expectedPreviousBindingRevision }
        : {}),
      payloadDigest
    });
  if (input.family === "ACOUSTIC_PROFILE")
    return JSON.stringify({
      operation: `acoustic.profile.${input.operation.toLowerCase()}`,
      commandHandle: input.commandHandle,
      voiceProfileId: input.voiceProfileId,
      expectedAcousticRevision: input.expectedAcousticRevision,
      sampleCount: input.sampleReferences?.length ?? 0,
      payloadDigest
    });
  return JSON.stringify({
    operation: `p8.correction.${input.operation.toLowerCase()}`,
    commandHandleDigest: effectDigest(input.commandHandle),
    targetKind:
      input.correction["target"] && typeof input.correction["target"] === "object"
        ? ((input.correction["target"] as Record<string, unknown>)["kind"] ?? null)
        : null,
    payloadDigest
  });
}
function payloadForOwner(
  payload: ProtectedCommand,
  intent: EffectIntent,
  attempt: EffectAttemptV1
): ProductPersonCommandPayload {
  if (payload.family !== "PRODUCT_PERSON")
    throw new EffectIntentError("INVALID_REQUEST", "Payload is not a Product Person command.");
  const reference = intent.request.causalRefs[0];
  if (!reference)
    throw new EffectIntentError("INTEGRITY_FAILURE", "Native intent lacks a CONTROL receipt.");
  return {
    commandHandle: payload.commandHandle,
    operation: payload.operation,
    personId: payload.personId,
    displayName: payload.displayName,
    personaId: payload.personaId,
    notes: payload.notes,
    requestedPrimary: payload.requestedPrimary,
    expectedPersonRevision: payload.expectedPersonRevision,
    expectedPrimaryRevision: payload.expectedPrimaryRevision,
    payloadDigest: (intent.request.payload as { payloadDigest: string }).payloadDigest,
    intentId: intent.intentId,
    attemptId: attempt.attemptId,
    fence: attempt.fence,
    causalRefs: [reference]
  };
}
function nativeEvidence(
  certainty: EffectEvidence["certainty"],
  layer: EffectEvidence["layer"],
  reason: EffectEvidence["reason"],
  nativeOwnerCommit?: NativeOwnerCommitV1
): EffectEvidence {
  return {
    certainty,
    layer,
    reason,
    remoteEffectId: null,
    ...(nativeOwnerCommit ? { nativeOwnerCommit } : {})
  };
}

function productOwnerCommit(receipt: ProductPersonCommandReceipt): NativeOwnerCommitV1 {
  const revisions = [{ ownerReference: `person:${receipt.personId}`, revision: receipt.resultingPersonRevision }];
  if (receipt.resultingPrimaryRevision && receipt.resultingPrimaryRevision !== receipt.priorPrimaryRevision)
    revisions.push({ ownerReference: "primary-person-selection", revision: receipt.resultingPrimaryRevision });
  return {
    version: "native-owner-commit.v1",
    ownerFamily: "PRODUCT_PERSON",
    targetReference: receipt.personId,
    revisions,
    eventIds: []
  };
}
