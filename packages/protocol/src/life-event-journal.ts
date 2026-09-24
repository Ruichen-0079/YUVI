import { z, type ZodIssue } from "zod";

/** A8.1 defines schemas and validation only. A8.2 owns durable append fields. */
export const JOURNAL_COMMAND_VERSION = "life-event-command.v1" as const;
export const JOURNAL_ENVELOPE_VERSION = "life-event-envelope.v1" as const;
export const JOURNAL_SELECTOR_VERSION = "source-selector.v1" as const;

const opaque = z.string().min(1).max(512);
const isoTime = z.string().datetime({ offset: true });

export const JournalEventKindSchema = z.enum([
  "RECEIPT",
  "INTENT",
  "ATTEMPT",
  "OUTCOME",
  "DECISION",
  "DERIVATION",
  "AMENDMENT"
]);
export type JournalEventKind = z.infer<typeof JournalEventKindSchema>;

/** This identity is intentionally tagged and cannot be confused with a Memory UUID. */
export const JournalEventRefSchema = z
  .object({
    kind: z.literal("JOURNAL_EVENT"),
    namespace: opaque,
    eventId: z.string().regex(/^jev1_[A-Za-z0-9_-]{16,}$/)
  })
  .strict();
export type JournalEventRef = z.infer<typeof JournalEventRefSchema>;

export const PayloadRefSchema = z
  .object({ namespace: opaque, payloadId: opaque, version: opaque })
  .strict();
export type PayloadRef = z.infer<typeof PayloadRefSchema>;

const CorrelationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CONVERSATION"), sessionId: opaque }).strict(),
  z.object({ kind: z.literal("MESSAGE"), sessionId: opaque, messageId: opaque }).strict(),
  z.object({ kind: z.literal("RUNTIME_EVENT"), runtimeEventId: opaque }).strict(),
  z.object({ kind: z.literal("EXECUTION"), executionId: opaque }).strict(),
  z
    .object({
      kind: z.literal("REASONING_ROUND"),
      executionId: opaque,
      roundOrdinal: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      kind: z.literal("CAPABILITY_OBSERVATION"),
      executionId: opaque,
      ordinal: z.number().int().nonnegative(),
      capabilityRef: opaque,
      observationRef: opaque
    })
    .strict(),
  z.object({ kind: z.literal("PROSPECTIVE_INTENT"), reference: opaque }).strict(),
  z.object({ kind: z.literal("PROSPECTIVE_ATTEMPT"), reference: opaque }).strict(),
  z
    .object({
      kind: z.literal("VOICE_OBSERVATION"),
      observationId: opaque,
      captureEpoch: opaque,
      segmentId: opaque.optional()
    })
    .strict()
]);
export type JournalCorrelation = z.infer<typeof CorrelationSchema>;

const SelectorBase = {
  version: z.literal(JOURNAL_SELECTOR_VERSION),
  payload: PayloadRefSchema
};

export const SourceSelectorSchema = z.discriminatedUnion("modality", [
  z
    .object({
      ...SelectorBase,
      modality: z.literal("TEXT"),
      range: z
        .object({
          unit: z.literal("UNICODE_CODE_POINT"),
          start: z.number().int().nonnegative(),
          end: z.number().int().positive()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...SelectorBase,
      modality: z.literal("AUDIO"),
      rangeMs: z
        .object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive() })
        .strict(),
      channel: z.number().int().nonnegative().optional()
    })
    .strict(),
  z
    .object({
      ...SelectorBase,
      modality: z.literal("IMAGE"),
      coordinateSpace: z.literal("PIXEL"),
      region: z
        .object({
          x: z.number().finite().nonnegative(),
          y: z.number().finite().nonnegative(),
          width: z.number().finite().positive(),
          height: z.number().finite().positive()
        })
        .strict(),
      frameId: opaque.optional()
    })
    .strict(),
  z.object({ ...SelectorBase, modality: z.literal("JSON"), pointer: z.string() }).strict(),
  z
    .object({
      ...SelectorBase,
      modality: z.literal("TOOL_RESULT"),
      resultRef: opaque,
      fragment: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("JSON_POINTER"), pointer: z.string() }).strict(),
        z
          .object({
            kind: z.literal("TEXT_RANGE"),
            unit: z.literal("UNICODE_CODE_POINT"),
            start: z.number().int().nonnegative(),
            end: z.number().int().positive()
          })
          .strict()
      ])
    })
    .strict()
]);
export type SourceSelector = z.infer<typeof SourceSelectorSchema>;

const OccurrenceTimeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("UNKNOWN") }).strict(),
  z
    .object({
      state: z.literal("INSTANT"),
      at: isoTime,
      clockSource: opaque,
      uncertaintyMs: z.number().finite().nonnegative()
    })
    .strict(),
  z
    .object({
      state: z.literal("INTERVAL"),
      start: isoTime,
      end: isoTime,
      clockSource: opaque,
      uncertaintyMs: z.number().finite().nonnegative()
    })
    .strict()
]);
export type JournalOccurrenceTime = z.infer<typeof OccurrenceTimeSchema>;

const ProducerSchema = z.object({ name: opaque, version: opaque }).strict();
const SurfaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PRIVATE_CHANNEL"), reference: opaque }).strict(),
  z.object({ kind: z.literal("GROUP_CHANNEL"), reference: opaque }).strict(),
  z.object({ kind: z.literal("DEVICE"), reference: opaque.optional() }).strict(),
  z.object({ kind: z.literal("LOCAL"), reference: opaque.optional() }).strict(),
  z.object({ kind: z.literal("UNKNOWN"), reference: opaque.optional() }).strict()
]);

const ReceiptDataSchema = z
  .object({
    receiptClass: z.enum(["ATTRIBUTED_ASSERTION", "DIRECT_OBSERVATION", "CONTROL"]),
    evidenceSelectors: z.array(SourceSelectorSchema).default([])
  })
  .strict();
const IntentDataSchema = z.object({ actionRef: opaque, effectContractRef: opaque }).strict();
const AttemptDataSchema = z
  .object({
    intent: JournalEventRefSchema,
    dispatchBoundary: z.literal("MAY_BEGIN")
  })
  .strict();
const OutcomePredicateSchema = z.enum([
  "LOCAL_RESULT_PRODUCED",
  "SERVICE_ACCEPTED",
  "REMOTE_PERSISTED",
  "DEVICE_PRESENTED",
  "HUMAN_ACKNOWLEDGED",
  "DELIVERY_REJECTED",
  "NO_EFFECT_ESTABLISHED"
]);
const OutcomeDataSchema = z
  .object({
    attempt: JournalEventRefSchema,
    certainty: z.enum(["CONFIRMED_SUCCESS", "CONFIRMED_FAILURE", "UNKNOWN"]),
    establishes: OutcomePredicateSchema.optional(),
    evidenceSelectors: z.array(SourceSelectorSchema).default([])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.certainty === "UNKNOWN" && value.establishes !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["establishes"],
        message: "UNKNOWN cannot assert an established outcome"
      });
    }
    if (
      value.certainty !== "UNKNOWN" &&
      (!value.establishes || value.evidenceSelectors.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceSelectors"],
        message: "confirmed outcomes require an exact predicate and evidence"
      });
    }
    const failurePredicate =
      value.establishes === "DELIVERY_REJECTED" || value.establishes === "NO_EFFECT_ESTABLISHED";
    if (value.certainty === "CONFIRMED_SUCCESS" && failurePredicate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["establishes"],
        message: "A confirmed-success outcome cannot claim a failure predicate"
      });
    }
    if (value.certainty === "CONFIRMED_FAILURE" && value.establishes && !failurePredicate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["establishes"],
        message: "A confirmed-failure outcome requires a failure predicate"
      });
    }
  });
const DecisionDataSchema = z
  .object({
    choice: z.enum(["ADMIT", "REJECT", "SELECT", "DEFER"]),
    inputRefs: z.array(JournalEventRefSchema),
    alternatives: z.array(opaque),
    evidenceSelectors: z.array(SourceSelectorSchema).default([])
  })
  .strict();
const ClaimActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PERSON"), personId: opaque }).strict(),
  z.object({ kind: z.literal("PRINCIPAL"), namespace: opaque, actorId: opaque }).strict(),
  z
    .object({
      kind: z.literal("AMBIGUOUS_PRINCIPAL"),
      candidates: z.array(z.object({ namespace: opaque, actorId: opaque }).strict()).min(2)
    })
    .strict(),
  z.object({ kind: z.literal("YUVI_SELF") }).strict(),
  z.object({ kind: z.literal("UNRESOLVED"), reason: opaque }).strict()
]);
const DerivationDataSchema = z
  .object({
    derivedRef: opaque,
    derivationKind: z.enum(["CLAIM", "ANNOTATION", "PROJECTION", "INDEX_INPUT"]),
    claim: z
      .object({
        assertor: ClaimActorSchema,
        subject: ClaimActorSchema,
        provenance: z.enum([
          "SELF_REPORT",
          "EXTERNAL_CLAIM",
          "DIRECT_OBSERVATION",
          "ASSISTANT_INFERENCE",
          "UNKNOWN_AMBIENT",
          "UNKNOWN"
        ]),
        propositionRef: opaque
      })
      .strict()
      .optional(),
    sourceSelectors: z.array(SourceSelectorSchema).min(1),
    sourceEvents: z.array(JournalEventRefSchema).default([]),
    legacyMemorySources: z
      .array(
        z
          .object({
            kind: z.literal("LEGACY_MEMORY_EVENT"),
            provider: opaque,
            eventId: opaque,
            sourceTraceId: opaque.optional()
          })
          .strict()
      )
      .default([]),
    derivationVersion: opaque
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.derivationKind === "CLAIM" && value.claim === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claim"],
        message: "CLAIM derivations require an explicit assertor, subject and provenance"
      });
    }
    if (value.derivationKind !== "CLAIM" && value.claim !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claim"],
        message: "Only CLAIM derivations carry claim attribution"
      });
    }
  });
const AmendmentDataSchema = z
  .object({
    target: JournalEventRefSchema,
    relation: z.enum([
      "CORRECTION",
      "SUPERSESSION",
      "RETRACTION",
      "BINDING_CORRECTION",
      "REDACTION"
    ]),
    reasonRef: opaque,
    replacementRef: opaque.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      ["CORRECTION", "SUPERSESSION", "BINDING_CORRECTION"].includes(value.relation) &&
      value.replacementRef === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replacementRef"],
        message: `${value.relation} requires a replacement reference`
      });
    }
  });

const CommandBase = {
  version: z.literal(JOURNAL_COMMAND_VERSION),
  occurrenceTime: OccurrenceTimeSchema,
  causalParents: z.array(JournalEventRefSchema).default([])
};

/** Producer proposal only. Authority-assigned envelope fields are intentionally absent. */
export const JournalEventCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...CommandBase, kind: z.literal("RECEIPT"), data: ReceiptDataSchema }).strict(),
  z.object({ ...CommandBase, kind: z.literal("INTENT"), data: IntentDataSchema }).strict(),
  z.object({ ...CommandBase, kind: z.literal("ATTEMPT"), data: AttemptDataSchema }).strict(),
  z.object({ ...CommandBase, kind: z.literal("OUTCOME"), data: OutcomeDataSchema }).strict(),
  z.object({ ...CommandBase, kind: z.literal("DECISION"), data: DecisionDataSchema }).strict(),
  z.object({ ...CommandBase, kind: z.literal("DERIVATION"), data: DerivationDataSchema }).strict(),
  z.object({ ...CommandBase, kind: z.literal("AMENDMENT"), data: AmendmentDataSchema }).strict()
]);
export type JournalEventCommand = z.infer<typeof JournalEventCommandSchema>;

const PrincipalRefSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("RESOLVED"),
      kind: z.literal("PRINCIPAL"),
      namespace: opaque,
      actorId: opaque
    })
    .strict(),
  z.object({ state: z.literal("UNRESOLVED"), reason: opaque }).strict(),
  z
    .object({
      state: z.literal("AMBIGUOUS"),
      candidates: z.array(z.object({ namespace: opaque, actorId: opaque }).strict()).min(2)
    })
    .strict()
]);
const PersonBindingSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("RESOLVED"),
      kind: z.literal("PERSON_BINDING"),
      personId: opaque,
      bindingVersion: opaque
    })
    .strict(),
  z.object({ state: z.literal("UNRESOLVED"), reason: opaque }).strict(),
  z.object({ state: z.literal("CONFLICTING"), candidates: z.array(opaque).min(2) }).strict()
]);
const SubjectRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("PERSON"),
      personId: opaque,
      resolution: z.enum(["RESOLVED", "UNRESOLVED"])
    })
    .strict(),
  z
    .object({
      kind: z.literal("PRINCIPAL"),
      namespace: opaque,
      actorId: opaque,
      resolution: z.enum(["RESOLVED", "UNRESOLVED"])
    })
    .strict(),
  z.object({ kind: z.literal("YUVI_SELF") }).strict(),
  z.object({ kind: z.literal("UNRESOLVED"), reference: opaque.optional() }).strict()
]);
const MembershipSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("KNOWN"), snapshotRef: opaque, version: opaque }).strict(),
  z.object({ state: z.literal("UNKNOWN"), reason: opaque }).strict(),
  z
    .object({ state: z.literal("INCOMPLETE"), snapshotRef: opaque.optional(), reason: opaque })
    .strict()
]);
const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PRIVATE"), channelRef: opaque }).strict(),
  z.object({ kind: z.literal("GROUP"), channelRef: opaque, membership: MembershipSchema }).strict(),
  z.object({ kind: z.literal("UNKNOWN"), reason: opaque }).strict()
]);
const DisclosurePolicySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("KNOWN"), reference: opaque, version: opaque }).strict(),
  z.object({ state: z.literal("UNRESOLVED"), reason: opaque }).strict()
]);
const IntentAuthorizationSchema = z
  .object({
    kind: z.literal("AUTHORIZED_INTENT"),
    decision: JournalEventRefSchema,
    actionRef: opaque,
    effectContractRef: opaque,
    policyVersion: opaque
  })
  .strict();

const SourceReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("CONVERSATION_MESSAGE"), sessionId: opaque, messageId: opaque })
    .strict(),
  z.object({ kind: z.literal("RUNTIME_EVENT"), runtimeEventId: opaque }).strict(),
  z.object({ kind: z.literal("RUNTIME_EXECUTION"), executionId: opaque }).strict(),
  z
    .object({
      kind: z.literal("VOICE_OBSERVATION"),
      observationId: opaque,
      captureEpoch: opaque,
      segmentId: opaque.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("LEGACY_MEMORY_EVENT"),
      provider: opaque,
      eventId: opaque,
      sourceTraceId: opaque.optional()
    })
    .strict(),
  z.object({ kind: z.literal("UNRESOLVED_SOURCE"), reason: opaque }).strict()
]);
export type JournalSourceReference = z.infer<typeof SourceReferenceSchema>;

const PayloadDescriptorSchema = z.discriminatedUnion("modality", [
  z
    .object({
      ref: PayloadRefSchema,
      modality: z.literal("TEXT"),
      retention: z.enum(["RETAINED", "REDACTED", "NOT_RETAINED", "UNAVAILABLE"]),
      origin: z.enum(["USER_INPUT", "EXTERNAL_RESULT", "ASSISTANT_GENERATED", "MEMORY_LEGACY"]),
      selectable: z.boolean(),
      sourceEvent: JournalEventRefSchema.optional(),
      characterCount: z.number().int().nonnegative().optional()
    })
    .strict(),
  z
    .object({
      ref: PayloadRefSchema,
      modality: z.literal("AUDIO"),
      retention: z.enum(["RETAINED", "REDACTED", "NOT_RETAINED", "UNAVAILABLE"]),
      origin: z.enum(["USER_INPUT", "EXTERNAL_RESULT", "ASSISTANT_GENERATED", "MEMORY_LEGACY"]),
      selectable: z.boolean(),
      sourceEvent: JournalEventRefSchema.optional(),
      durationMs: z.number().finite().nonnegative().optional(),
      channelCount: z.number().int().nonnegative().optional()
    })
    .strict(),
  z
    .object({
      ref: PayloadRefSchema,
      modality: z.literal("IMAGE"),
      retention: z.enum(["RETAINED", "REDACTED", "NOT_RETAINED", "UNAVAILABLE"]),
      origin: z.enum(["USER_INPUT", "EXTERNAL_RESULT", "ASSISTANT_GENERATED", "MEMORY_LEGACY"]),
      selectable: z.boolean(),
      sourceEvent: JournalEventRefSchema.optional(),
      width: z.number().int().nonnegative().optional(),
      height: z.number().int().nonnegative().optional(),
      frameIds: z.array(opaque).optional()
    })
    .strict(),
  z
    .object({
      ref: PayloadRefSchema,
      modality: z.literal("JSON"),
      retention: z.enum(["RETAINED", "REDACTED", "NOT_RETAINED", "UNAVAILABLE"]),
      origin: z.enum(["USER_INPUT", "EXTERNAL_RESULT", "ASSISTANT_GENERATED", "MEMORY_LEGACY"]),
      selectable: z.boolean(),
      sourceEvent: JournalEventRefSchema.optional(),
      pointers: z.array(z.string()).optional()
    })
    .strict(),
  z
    .object({
      ref: PayloadRefSchema,
      modality: z.literal("TOOL_RESULT"),
      retention: z.enum(["RETAINED", "REDACTED", "NOT_RETAINED", "UNAVAILABLE"]),
      origin: z.enum(["USER_INPUT", "EXTERNAL_RESULT", "ASSISTANT_GENERATED", "MEMORY_LEGACY"]),
      selectable: z.boolean(),
      sourceEvent: JournalEventRefSchema.optional(),
      resultRef: opaque,
      fields: z.array(opaque).optional(),
      characterCount: z.number().int().nonnegative().optional()
    })
    .strict()
]);
export type JournalPayloadDescriptor = z.infer<typeof PayloadDescriptorSchema>;

/** Supplied by the trusted host/admission owner, never by model or plugin metadata. */
export const JournalAuthoritySnapshotSchema = z
  .object({
    journalNamespace: opaque,
    principal: PrincipalRefSchema,
    subjects: z.array(SubjectRefSchema),
    binding: PersonBindingSchema,
    surface: SurfaceSchema,
    correlations: z.array(CorrelationSchema),
    audience: AudienceSchema,
    disclosurePolicy: DisclosurePolicySchema,
    policyVersion: opaque,
    producer: ProducerSchema,
    modelVersion: opaque.optional(),
    codebookVersion: opaque.optional(),
    intentAuthorization: IntentAuthorizationSchema.optional(),
    sourceReferences: z.array(SourceReferenceSchema),
    payloads: z.array(PayloadDescriptorSchema)
  })
  .strict();
export type JournalAuthoritySnapshot = z.infer<typeof JournalAuthoritySnapshotSchema>;

/** Authority-owned commit fields plus the validated proposal; A8.1 never assigns these. */
export const JournalCommittedEnvelopeSchema = z
  .object({
    version: z.literal(JOURNAL_ENVELOPE_VERSION),
    eventId: z.string().regex(/^jev1_[A-Za-z0-9_-]{16,}$/),
    journalNamespace: opaque,
    commitSeq: z.number().int().positive(),
    recordedAt: isoTime,
    command: JournalEventCommandSchema,
    authority: JournalAuthoritySnapshotSchema
  })
  .strict();
export type JournalCommittedEnvelope = z.infer<typeof JournalCommittedEnvelopeSchema>;

export type JournalValidationCode =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "AUTHORITY_FIELD_PROHIBITED"
  | "INVALID_COMMAND"
  | "INVALID_AUTHORITY_CONTEXT"
  | "INVALID_ENVELOPE"
  | "INVALID_SELECTOR"
  | "UNKNOWN_PAYLOAD_REFERENCE"
  | "PAYLOAD_MODALITY_MISMATCH"
  | "PAYLOAD_UNAVAILABLE"
  | "SELECTOR_OUT_OF_BOUNDS"
  | "DUPLICATE_PARENT"
  | "SELF_PARENT"
  | "CAUSAL_CYCLE"
  | "CROSS_NAMESPACE_REFERENCE"
  | "SCOPE_MISMATCH"
  | "UNAUTHORIZED_INTENT"
  | "UNKNOWN_PARENT"
  | "ILLEGAL_PARENT_KIND"
  | "INCONSISTENT_SOURCE_LINEAGE"
  | "SELF_GENERATED_DISPOSITION_NOT_AUTHORITATIVE"
  | "DUPLICATE_EVENT_ID"
  | "NON_MONOTONIC_COMMIT_SEQUENCE";

export class JournalContractError extends Error {
  readonly code: JournalValidationCode;
  readonly path: readonly (string | number)[];
  readonly issues: readonly ZodIssue[];

  constructor(
    code: JournalValidationCode,
    message: string,
    path: readonly (string | number)[] = [],
    issues: readonly ZodIssue[] = []
  ) {
    super(message);
    this.name = "JournalContractError";
    this.code = code;
    this.path = path;
    this.issues = issues;
  }
}

export type JournalHistoryEntry = {
  ref: JournalEventRef;
  kind: JournalEventKind;
  parentRefs: readonly JournalEventRef[];
  commitSeq?: number;
};
export type JournalValidationContext = {
  /** Optional read-only committed-history fixture/resolver. It does not persist or append. */
  knownEvents?: readonly JournalHistoryEntry[];
  /** Set only when the resolver returned the complete relevant namespace graph. */
  historyComplete?: boolean;
  /** Highest already-committed sequence, supplied by an append/store authority. */
  latestCommitSeq?: number;
};

export type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

const authorityFieldNames = new Set([
  "eventId",
  "eventIdentity",
  "journalNamespace",
  "namespace",
  "commitSeq",
  "recordedAt",
  "producer",
  "producerMetadata",
  "modelVersion",
  "codebookVersion",
  "surface",
  "correlations",
  "principal",
  "principalRef",
  "principalIdentity",
  "principalNamespace",
  "sourceId",
  "sourceReferences",
  "sourceRefs",
  "sourceObservationId",
  "payloadRefs",
  "payloads",
  "binding",
  "bindingVersion",
  "intentAuthorization",
  "audience",
  "audienceSnapshot",
  "audienceSnapshotRef",
  "disclosurePolicy",
  "policyVersion"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function raiseParseError(
  code: JournalValidationCode,
  message: string,
  issues: readonly ZodIssue[]
): never {
  const issue = issues[0];
  throw new JournalContractError(code, message, issue?.path ?? [], issues);
}

function checkSelectors(command: JournalEventCommand, authority: JournalAuthoritySnapshot): void {
  const selectors: SourceSelector[] = [];
  switch (command.kind) {
    case "RECEIPT":
    case "OUTCOME":
    case "DECISION":
      selectors.push(...command.data.evidenceSelectors);
      break;
    case "DERIVATION":
      selectors.push(...command.data.sourceSelectors);
      break;
    default:
      break;
  }
  for (const selector of selectors) validateSelector(selector, authority.payloads);
  if (command.kind === "DERIVATION" && command.data.claim?.subject.kind === "YUVI_SELF") {
    const claimsAuthority = command.data.claim.provenance !== "ASSISTANT_INFERENCE";
    if (
      claimsAuthority &&
      selectors.some((selector) =>
        authority.payloads.some(
          (payload) =>
            samePayload(payload.ref, selector.payload) && payload.origin === "ASSISTANT_GENERATED"
        )
      )
    ) {
      throw new JournalContractError(
        "SELF_GENERATED_DISPOSITION_NOT_AUTHORITATIVE",
        "Assistant-generated text can evidence what YUVI said, not YUVI's disposition"
      );
    }
  }
}

function validateAuthoritySemantics(
  command: JournalEventCommand,
  authority: JournalAuthoritySnapshot
): void {
  validateScope(authority);
  const sourceSet = new Set(authority.sourceReferences.map((source) => JSON.stringify(source)));
  if (sourceSet.size !== authority.sourceReferences.length)
    throw new JournalContractError(
      "INVALID_AUTHORITY_CONTEXT",
      "Authority source references must be unique"
    );
  const payloadSet = new Set(authority.payloads.map((payload) => JSON.stringify(payload.ref)));
  if (payloadSet.size !== authority.payloads.length)
    throw new JournalContractError(
      "INVALID_AUTHORITY_CONTEXT",
      "Authority payload references must be unique"
    );
  if (
    command.kind === "RECEIPT" &&
    !authority.sourceReferences.some((source) => source.kind !== "LEGACY_MEMORY_EVENT")
  ) {
    throw new JournalContractError(
      "INVALID_AUTHORITY_CONTEXT",
      "A receipt requires at least one host-attributed source reference"
    );
  }
}

function samePayload(a: PayloadRef, b: PayloadRef): boolean {
  return a.namespace === b.namespace && a.payloadId === b.payloadId && a.version === b.version;
}

function validJsonPointer(pointer: string): boolean {
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  return pointer
    .slice(1)
    .split("/")
    .every((part) => !/~(?:[^01]|$)/.test(part));
}

function validateSelector(
  selector: SourceSelector,
  payloads: readonly JournalPayloadDescriptor[]
): void {
  const payload = payloads.find((candidate) => samePayload(candidate.ref, selector.payload));
  if (!payload)
    throw new JournalContractError(
      "UNKNOWN_PAYLOAD_REFERENCE",
      "Selector payload is not in the trusted source catalog"
    );
  if (payload.modality !== selector.modality) {
    throw new JournalContractError(
      "PAYLOAD_MODALITY_MISMATCH",
      `Expected ${payload.modality}, got ${selector.modality}`
    );
  }
  if (
    !payload.selectable ||
    payload.retention === "NOT_RETAINED" ||
    payload.retention === "UNAVAILABLE"
  ) {
    throw new JournalContractError(
      "PAYLOAD_UNAVAILABLE",
      "Selector requires content that is not available for grounding"
    );
  }
  switch (selector.modality) {
    case "TEXT":
      if (selector.range.end <= selector.range.start)
        throw new JournalContractError(
          "INVALID_SELECTOR",
          "Text range must be non-empty and ordered"
        );
      if (
        "characterCount" in payload &&
        payload.characterCount !== undefined &&
        selector.range.end > payload.characterCount
      ) {
        throw new JournalContractError(
          "SELECTOR_OUT_OF_BOUNDS",
          "Text selector exceeds authoritative payload length"
        );
      }
      break;
    case "AUDIO":
      if (selector.rangeMs.end <= selector.rangeMs.start)
        throw new JournalContractError(
          "INVALID_SELECTOR",
          "Audio range must be non-empty and ordered"
        );
      if (
        "durationMs" in payload &&
        payload.durationMs !== undefined &&
        selector.rangeMs.end > payload.durationMs
      ) {
        throw new JournalContractError(
          "SELECTOR_OUT_OF_BOUNDS",
          "Audio selector exceeds authoritative duration"
        );
      }
      if (
        selector.channel !== undefined &&
        "channelCount" in payload &&
        payload.channelCount !== undefined &&
        selector.channel >= payload.channelCount
      ) {
        throw new JournalContractError(
          "SELECTOR_OUT_OF_BOUNDS",
          "Audio channel is outside authoritative channel count"
        );
      }
      break;
    case "IMAGE":
      if (
        "width" in payload &&
        payload.width !== undefined &&
        selector.region.x + selector.region.width > payload.width
      ) {
        throw new JournalContractError(
          "SELECTOR_OUT_OF_BOUNDS",
          "Image selector exceeds authoritative width"
        );
      }
      if (
        "height" in payload &&
        payload.height !== undefined &&
        selector.region.y + selector.region.height > payload.height
      ) {
        throw new JournalContractError(
          "SELECTOR_OUT_OF_BOUNDS",
          "Image selector exceeds authoritative height"
        );
      }
      if (
        selector.frameId &&
        "frameIds" in payload &&
        payload.frameIds &&
        !payload.frameIds.includes(selector.frameId)
      ) {
        throw new JournalContractError(
          "SELECTOR_OUT_OF_BOUNDS",
          "Frame identity is not in the authoritative payload"
        );
      }
      break;
    case "JSON":
      if (!validJsonPointer(selector.pointer))
        throw new JournalContractError("INVALID_SELECTOR", "Malformed JSON Pointer");
      if (
        "pointers" in payload &&
        payload.pointers &&
        !payload.pointers.includes(selector.pointer)
      ) {
        throw new JournalContractError(
          "SELECTOR_OUT_OF_BOUNDS",
          "JSON Pointer is not present in the authoritative structured payload"
        );
      }
      break;
    case "TOOL_RESULT":
      if (!("resultRef" in payload) || selector.resultRef !== payload.resultRef)
        throw new JournalContractError(
          "UNKNOWN_PAYLOAD_REFERENCE",
          "Tool result identity does not match source catalog"
        );
      if (
        selector.fragment.kind === "JSON_POINTER" &&
        !validJsonPointer(selector.fragment.pointer)
      ) {
        throw new JournalContractError("INVALID_SELECTOR", "Malformed JSON Pointer");
      }
      if (selector.fragment.kind === "TEXT_RANGE") {
        if (selector.fragment.end <= selector.fragment.start)
          throw new JournalContractError(
            "INVALID_SELECTOR",
            "Tool result range must be non-empty and ordered"
          );
        if (
          "characterCount" in payload &&
          payload.characterCount !== undefined &&
          selector.fragment.end > payload.characterCount
        ) {
          throw new JournalContractError(
            "SELECTOR_OUT_OF_BOUNDS",
            "Tool result selector exceeds authoritative result length"
          );
        }
      }
      if (
        selector.fragment.kind === "JSON_POINTER" &&
        "fields" in payload &&
        payload.fields &&
        selector.fragment.pointer !== "" &&
        !payload.fields.includes(selector.fragment.pointer)
      ) {
        throw new JournalContractError(
          "SELECTOR_OUT_OF_BOUNDS",
          "Tool result field is not in the authoritative result"
        );
      }
      break;
  }
}

function validateReferences(
  command: JournalEventCommand,
  authority: JournalAuthoritySnapshot,
  context: JournalValidationContext,
  eventId?: string
): void {
  const parentKeys = command.causalParents.map(
    (parent) => `${parent.namespace}\u0000${parent.eventId}`
  );
  if (new Set(parentKeys).size !== parentKeys.length)
    throw new JournalContractError("DUPLICATE_PARENT", "Causal parents must be unique");
  for (const parent of command.causalParents) {
    if (parent.eventId === eventId && parent.namespace === authority.journalNamespace)
      throw new JournalContractError("SELF_PARENT", "An event cannot be its own causal parent");
    if (parent.namespace !== authority.journalNamespace)
      throw new JournalContractError(
        "CROSS_NAMESPACE_REFERENCE",
        "Causal parent is outside the journal namespace"
      );
  }
  if (command.causalParents.length > 0 && context.knownEvents === undefined) {
    throw new JournalContractError(
      "UNKNOWN_PARENT",
      "Causal parents require a read-only committed-history resolver"
    );
  }

  const requireParent = (target: JournalEventRef, expected: readonly JournalEventKind[]) => {
    if (
      !command.causalParents.some(
        (candidate) =>
          candidate.eventId === target.eventId && candidate.namespace === target.namespace
      )
    ) {
      throw new JournalContractError(
        "ILLEGAL_PARENT_KIND",
        "Kind-specific target must also be a direct causal parent"
      );
    }
    const known = context.knownEvents?.find(
      (entry) => entry.ref.eventId === target.eventId && entry.ref.namespace === target.namespace
    );
    if (context.knownEvents && !known)
      throw new JournalContractError(
        "UNKNOWN_PARENT",
        "Referenced event is not in the supplied committed history"
      );
    if (known && !expected.includes(known.kind))
      throw new JournalContractError(
        "ILLEGAL_PARENT_KIND",
        `Expected parent kind ${expected.join(" or ")}, got ${known.kind}`
      );
  };

  for (const parent of command.causalParents) {
    const known = context.knownEvents?.find(
      (entry) => entry.ref.eventId === parent.eventId && entry.ref.namespace === parent.namespace
    );
    if (context.knownEvents && !known)
      throw new JournalContractError(
        "UNKNOWN_PARENT",
        "Causal parent is not in the supplied committed history"
      );
    if (known) {
      const allowedParents: Record<JournalEventKind, readonly JournalEventKind[]> = {
        RECEIPT: JournalEventKindSchema.options,
        INTENT: ["DECISION", "RECEIPT", "DERIVATION"],
        ATTEMPT: ["INTENT", "DECISION", "RECEIPT", "DERIVATION"],
        OUTCOME: ["ATTEMPT"],
        DECISION: ["RECEIPT", "DERIVATION", "OUTCOME", "INTENT"],
        DERIVATION: ["RECEIPT", "INTENT", "ATTEMPT", "OUTCOME", "DECISION", "DERIVATION"],
        AMENDMENT: JournalEventKindSchema.options
      };
      if (!allowedParents[command.kind].includes(known.kind)) {
        throw new JournalContractError(
          "ILLEGAL_PARENT_KIND",
          `${command.kind} cannot use ${known.kind} as a direct parent`
        );
      }
    }
  }
  if (command.kind !== "INTENT" && authority.intentAuthorization !== undefined) {
    throw new JournalContractError(
      "INVALID_AUTHORITY_CONTEXT",
      "Intent authorization may only accompany an INTENT command"
    );
  }
  switch (command.kind) {
    case "INTENT": {
      const authorization = authority.intentAuthorization;
      if (
        !authorization ||
        authorization.actionRef !== command.data.actionRef ||
        authorization.effectContractRef !== command.data.effectContractRef ||
        authorization.policyVersion !== authority.policyVersion
      ) {
        throw new JournalContractError(
          "UNAUTHORIZED_INTENT",
          "Intent action and effect contract must match the host-authorized decision snapshot"
        );
      }
      if (authorization.decision.namespace !== authority.journalNamespace) {
        throw new JournalContractError(
          "CROSS_NAMESPACE_REFERENCE",
          "Intent authorization decision is outside the journal namespace"
        );
      }
      requireParent(authorization.decision, ["DECISION"]);
      break;
    }
    case "ATTEMPT":
      requireParent(command.data.intent, ["INTENT"]);
      break;
    case "OUTCOME":
      requireParent(command.data.attempt, ["ATTEMPT"]);
      break;
    case "AMENDMENT": {
      const target = command.data.target;
      if (target.namespace !== authority.journalNamespace)
        throw new JournalContractError(
          "CROSS_NAMESPACE_REFERENCE",
          "Amendment target is outside the journal namespace"
        );
      if (
        !command.causalParents.some(
          (candidate) =>
            candidate.eventId === target.eventId && candidate.namespace === target.namespace
        )
      ) {
        throw new JournalContractError(
          "ILLEGAL_PARENT_KIND",
          "Amendment target must be a direct causal parent"
        );
      }
      if (
        context.knownEvents &&
        !context.knownEvents.some(
          (entry) =>
            entry.ref.eventId === target.eventId && entry.ref.namespace === target.namespace
        )
      ) {
        throw new JournalContractError(
          "UNKNOWN_PARENT",
          "Amendment target is not in supplied committed history"
        );
      }
      break;
    }
    case "DECISION":
      for (const input of command.data.inputRefs) {
        if (input.namespace !== authority.journalNamespace) {
          throw new JournalContractError(
            "CROSS_NAMESPACE_REFERENCE",
            "Decision input is outside the journal namespace"
          );
        }
        requireParent(input, ["RECEIPT", "INTENT", "ATTEMPT", "OUTCOME", "DECISION", "DERIVATION"]);
      }
      break;
    case "DERIVATION":
      if (command.data.sourceEvents.length === 0) {
        throw new JournalContractError(
          "INCONSISTENT_SOURCE_LINEAGE",
          "A derivation requires at least one committed source event"
        );
      }
      for (const source of command.data.sourceEvents) {
        if (source.namespace !== authority.journalNamespace)
          throw new JournalContractError(
            "CROSS_NAMESPACE_REFERENCE",
            "Derived source is outside the journal namespace"
          );
        if (
          !command.causalParents.some(
            (candidate) =>
              candidate.eventId === source.eventId && candidate.namespace === source.namespace
          )
        ) {
          throw new JournalContractError(
            "ILLEGAL_PARENT_KIND",
            "Derived source event must also be a direct causal parent"
          );
        }
        if (
          context.knownEvents &&
          !context.knownEvents.some(
            (entry) =>
              entry.ref.eventId === source.eventId && entry.ref.namespace === source.namespace
          )
        ) {
          throw new JournalContractError(
            "UNKNOWN_PARENT",
            "Derived source is not in supplied committed history"
          );
        }
      }
      for (const selector of command.data.sourceSelectors) {
        const payload = authority.payloads.find((candidate) =>
          samePayload(candidate.ref, selector.payload)
        );
        const sourceEvent = payload && "sourceEvent" in payload ? payload.sourceEvent : undefined;
        if (
          !sourceEvent ||
          !command.data.sourceEvents.some(
            (source) =>
              source.namespace === sourceEvent.namespace && source.eventId === sourceEvent.eventId
          )
        ) {
          throw new JournalContractError(
            "INCONSISTENT_SOURCE_LINEAGE",
            "Each derivation selector must identify its committed source event"
          );
        }
      }
      break;
    default:
      break;
  }

  if (context.historyComplete && context.knownEvents && eventId) {
    const committedKeys = new Set(
      context.knownEvents.map((entry) => `${entry.ref.namespace}\u0000${entry.ref.eventId}`)
    );
    committedKeys.add(`${authority.journalNamespace}\u0000${eventId}`);
    for (const entry of context.knownEvents) {
      if (entry.ref.namespace !== authority.journalNamespace) continue;
      for (const parent of entry.parentRefs) {
        if (parent.namespace !== authority.journalNamespace)
          throw new JournalContractError(
            "CROSS_NAMESPACE_REFERENCE",
            "Complete local history has a cross-namespace causal edge"
          );
        if (!committedKeys.has(`${parent.namespace}\u0000${parent.eventId}`))
          throw new JournalContractError("UNKNOWN_PARENT", "Complete history has a missing parent");
      }
    }
    const parents = new Map(
      context.knownEvents.map((entry) => [
        `${entry.ref.namespace}\u0000${entry.ref.eventId}`,
        entry.parentRefs
      ])
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): boolean => {
      if (visiting.has(key)) return false;
      if (visited.has(key)) return true;
      visiting.add(key);
      for (const parent of parents.get(key) ?? []) {
        if (!visit(`${parent.namespace}\u0000${parent.eventId}`)) return false;
      }
      visiting.delete(key);
      visited.add(key);
      return true;
    };
    const selfKey = `${authority.journalNamespace}\u0000${eventId}`;
    parents.set(selfKey, command.causalParents);
    if (!visit(selfKey))
      throw new JournalContractError(
        "CAUSAL_CYCLE",
        "Complete supplied history contains a causal cycle"
      );
  }
}

export type ValidatedJournalProposal = DeepReadonly<{
  command: JournalEventCommand;
  authority: JournalAuthoritySnapshot;
}>;

/** Validate a producer command against a host-supplied, read-only authority snapshot. */
export function validateJournalCommand(
  input: unknown,
  authorityInput: unknown,
  context: JournalValidationContext = {}
): ValidatedJournalProposal {
  if (isRecord(input)) {
    if (input["version"] !== JOURNAL_COMMAND_VERSION) {
      throw new JournalContractError(
        "UNSUPPORTED_SCHEMA_VERSION",
        "Unsupported journal command version",
        ["version"]
      );
    }
    for (const key of authorityFieldNames) {
      if (Object.hasOwn(input, key))
        throw new JournalContractError(
          "AUTHORITY_FIELD_PROHIBITED",
          `Producer command cannot set ${key}`,
          [key]
        );
    }
    assertSupportedSelectorVersions(input);
    validateRawSelectors(input);
  }
  const parsedCommand = JournalEventCommandSchema.safeParse(input);
  if (!parsedCommand.success)
    raiseParseError("INVALID_COMMAND", "Invalid journal event command", parsedCommand.error.issues);
  const parsedAuthority = JournalAuthoritySnapshotSchema.safeParse(authorityInput);
  if (!parsedAuthority.success)
    raiseParseError(
      "INVALID_AUTHORITY_CONTEXT",
      "Invalid host journal authority snapshot",
      parsedAuthority.error.issues
    );
  const command = parsedCommand.data;
  const authority = parsedAuthority.data;
  validateOccurrenceTime(command.occurrenceTime);
  validateAuthoritySemantics(command, authority);
  for (const selector of selectorsOf(command)) {
    const payload = authority.payloads.find((candidate) =>
      samePayload(candidate.ref, selector.payload)
    );
    if (!payload)
      throw new JournalContractError(
        "UNKNOWN_PAYLOAD_REFERENCE",
        "Selector payload is not authority-approved"
      );
  }
  checkSelectors(command, authority);
  validateReferences(command, authority, context);
  return deepFreeze({ command, authority });
}

function selectorsOf(command: JournalEventCommand): SourceSelector[] {
  switch (command.kind) {
    case "RECEIPT":
    case "OUTCOME":
    case "DECISION":
      return command.data.evidenceSelectors;
    case "DERIVATION":
      return command.data.sourceSelectors;
    default:
      return [];
  }
}

/** Validate a committed representation read from a future store; this function does not append. */
export function validateJournalEnvelope(
  input: unknown,
  context: JournalValidationContext = {}
): DeepReadonly<JournalCommittedEnvelope> {
  if (isRecord(input) && input["version"] !== JOURNAL_ENVELOPE_VERSION) {
    throw new JournalContractError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "Unsupported journal envelope version",
      ["version"]
    );
  }
  if (isRecord(input) && isRecord(input["command"])) {
    const commandInput = input["command"];
    if (commandInput["version"] !== JOURNAL_COMMAND_VERSION) {
      throw new JournalContractError(
        "UNSUPPORTED_SCHEMA_VERSION",
        "Unsupported nested journal command version",
        ["command", "version"]
      );
    }
    assertSupportedSelectorVersions(commandInput);
  }
  const parsed = JournalCommittedEnvelopeSchema.safeParse(input);
  if (!parsed.success)
    raiseParseError("INVALID_ENVELOPE", "Invalid committed journal envelope", parsed.error.issues);
  const envelope = parsed.data;
  validateOccurrenceTime(envelope.command.occurrenceTime);
  if (envelope.journalNamespace !== envelope.authority.journalNamespace) {
    throw new JournalContractError(
      "CROSS_NAMESPACE_REFERENCE",
      "Envelope and authority namespace differ"
    );
  }
  validateAuthoritySemantics(envelope.command, envelope.authority);
  validateReferences(envelope.command, envelope.authority, context, envelope.eventId);
  checkSelectors(envelope.command, envelope.authority);
  if (context.knownEvents) {
    const duplicate = context.knownEvents.some(
      (entry) =>
        entry.ref.namespace === envelope.journalNamespace && entry.ref.eventId === envelope.eventId
    );
    if (duplicate)
      throw new JournalContractError(
        "DUPLICATE_EVENT_ID",
        "Event identity already exists in supplied history"
      );
    for (const parent of envelope.command.causalParents) {
      const prior = context.knownEvents.find(
        (entry) => entry.ref.namespace === parent.namespace && entry.ref.eventId === parent.eventId
      );
      if (prior?.commitSeq !== undefined && prior.commitSeq >= envelope.commitSeq) {
        throw new JournalContractError(
          "NON_MONOTONIC_COMMIT_SEQUENCE",
          "A causal parent must precede its committed child"
        );
      }
    }
  }
  if (context.latestCommitSeq !== undefined && envelope.commitSeq <= context.latestCommitSeq) {
    throw new JournalContractError(
      "NON_MONOTONIC_COMMIT_SEQUENCE",
      "Commit sequence is not greater than the supplied latest committed sequence"
    );
  }
  return deepFreeze(envelope);
}

function assertSupportedSelectorVersions(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSupportedSelectorVersions(item);
    return;
  }
  if (!isRecord(value)) return;
  if ("modality" in value && "version" in value && value["version"] !== JOURNAL_SELECTOR_VERSION) {
    throw new JournalContractError(
      "UNSUPPORTED_SCHEMA_VERSION",
      "Unsupported source selector version",
      ["version"]
    );
  }
  for (const child of Object.values(value)) assertSupportedSelectorVersions(child);
}

function validateOccurrenceTime(value: JournalOccurrenceTime): void {
  if (value.state === "INTERVAL" && Date.parse(value.end) < Date.parse(value.start)) {
    throw new JournalContractError(
      "INVALID_COMMAND",
      "Occurrence interval end precedes its start",
      ["occurrenceTime", "end"]
    );
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as DeepReadonly<T>;
}

function validateScope(authority: JournalAuthoritySnapshot): void {
  if (authority.surface.kind === "PRIVATE_CHANNEL" && authority.audience.kind !== "PRIVATE") {
    throw new JournalContractError(
      "SCOPE_MISMATCH",
      "Private surface requires a private audience snapshot"
    );
  }
  if (authority.surface.kind === "GROUP_CHANNEL" && authority.audience.kind !== "GROUP") {
    throw new JournalContractError(
      "SCOPE_MISMATCH",
      "Group surface requires a group audience snapshot"
    );
  }
  if (authority.surface.kind === "DEVICE" && authority.audience.kind !== "UNKNOWN") {
    throw new JournalContractError(
      "SCOPE_MISMATCH",
      "Device surface audience must remain explicitly unknown until defined"
    );
  }
  if (
    (authority.surface.kind === "PRIVATE_CHANNEL" || authority.surface.kind === "GROUP_CHANNEL") &&
    authority.surface.reference
  ) {
    if (
      authority.audience.kind === "UNKNOWN" ||
      authority.audience.channelRef !== authority.surface.reference
    ) {
      throw new JournalContractError(
        "SCOPE_MISMATCH",
        "Surface and authority audience channel references differ"
      );
    }
  }
}

function validateRawSelectors(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) validateRawSelectors(item);
    return;
  }
  if (!isRecord(value)) return;
  if ("modality" in value && "version" in value) {
    const parsed = SourceSelectorSchema.safeParse(value);
    if (!parsed.success)
      raiseParseError("INVALID_SELECTOR", "Invalid source selector", parsed.error.issues);
  }
  for (const child of Object.values(value)) validateRawSelectors(child);
}
