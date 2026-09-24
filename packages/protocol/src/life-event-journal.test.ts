import { describe, expect, it } from "vitest";
import {
  JOURNAL_COMMAND_VERSION,
  JOURNAL_ENVELOPE_VERSION,
  JOURNAL_SELECTOR_VERSION,
  JournalContractError,
  JournalEventCommandSchema,
  JournalAuthoritySnapshotSchema,
  type JournalHistoryEntry,
  type JournalEventRef,
  validateJournalCommand,
  validateJournalEnvelope
} from "./life-event-journal.js";

const namespace = "journal:local";
const receiptRef = ref("jev1_aaaaaaaaaaaaaaaa");
const intentRef = ref("jev1_bbbbbbbbbbbbbbbb");
const attemptRef = ref("jev1_cccccccccccccccc");
const decisionRef = ref("jev1_gggggggggggggggg");

function ref(eventId: string, useNamespace = namespace): JournalEventRef {
  return { kind: "JOURNAL_EVENT", namespace: useNamespace, eventId };
}

const history: JournalHistoryEntry[] = [
  { ref: receiptRef, kind: "RECEIPT", parentRefs: [], commitSeq: 1 },
  { ref: intentRef, kind: "INTENT", parentRefs: [], commitSeq: 2 },
  { ref: attemptRef, kind: "ATTEMPT", parentRefs: [intentRef], commitSeq: 3 },
  { ref: decisionRef, kind: "DECISION", parentRefs: [receiptRef], commitSeq: 4 }
];

function payload(modality: string, payloadId: string, fields: Record<string, unknown> = {}) {
  return {
    ref: { namespace, payloadId, version: "v1" },
    modality,
    retention: "RETAINED",
    origin: "USER_INPUT",
    selectable: true,
    sourceEvent: receiptRef,
    ...fields
  };
}

function authority(overrides: Record<string, unknown> = {}) {
  return {
    journalNamespace: namespace,
    principal: { state: "UNRESOLVED", reason: "transport identity not available" },
    subjects: [
      { kind: "PERSON", personId: "person-alice", resolution: "RESOLVED" },
      { kind: "YUVI_SELF" }
    ],
    binding: { state: "UNRESOLVED", reason: "no authenticated person binding" },
    surface: { kind: "PRIVATE_CHANNEL", reference: "dm:alice" },
    correlations: [
      { kind: "CONVERSATION", sessionId: "session-1" },
      { kind: "MESSAGE", sessionId: "session-1", messageId: "message-1" },
      { kind: "RUNTIME_EVENT", runtimeEventId: "runtime-event-1" },
      { kind: "EXECUTION", executionId: "a2-execution-9" },
      { kind: "REASONING_ROUND", executionId: "a2-execution-9", roundOrdinal: 1 },
      {
        kind: "CAPABILITY_OBSERVATION",
        executionId: "a2-execution-9",
        ordinal: 0,
        capabilityRef: "read_text_file",
        observationRef: "observation-1"
      },
      {
        kind: "VOICE_OBSERVATION",
        observationId: "voice-observation-1",
        captureEpoch: "capture-epoch-1",
        segmentId: "segment-1"
      },
      { kind: "PROSPECTIVE_INTENT", reference: "proposal-only" },
      { kind: "PROSPECTIVE_ATTEMPT", reference: "dispatch-observation-only" }
    ],
    audience: { kind: "PRIVATE", channelRef: "dm:alice" },
    disclosurePolicy: { state: "UNRESOLVED", reason: "policy reference unavailable" },
    policyVersion: "policy.v1",
    producer: { name: "fixture", version: "1" },
    sourceReferences: [
      { kind: "CONVERSATION_MESSAGE", sessionId: "session-1", messageId: "message-1" }
    ],
    payloads: [
      payload("TEXT", "text-1", { characterCount: 20 }),
      payload("AUDIO", "audio-1", { durationMs: 2500, channelCount: 2 }),
      payload("IMAGE", "image-1", { width: 640, height: 480, frameIds: ["frame-1"] }),
      payload("JSON", "json-1", { pointers: ["/items/0/name"] }),
      payload("TOOL_RESULT", "tool-1", {
        resultRef: "observation-1",
        fields: ["/ok", "/count"],
        characterCount: 18
      }),
      payload("TEXT", "assistant-text", { characterCount: 60, origin: "ASSISTANT_GENERATED" }),
      payload("TEXT", "redacted-text", { characterCount: 20, retention: "REDACTED" }),
      payload("TEXT", "not-retained-text", {
        characterCount: 20,
        retention: "NOT_RETAINED",
        selectable: false
      }),
      payload("TEXT", "unavailable-text", { retention: "UNAVAILABLE", selectable: false })
    ],
    ...overrides
  };
}

function selector(modality: string, payloadId: string, fields: Record<string, unknown> = {}) {
  const normalizedFields = { ...fields };
  if (modality === "TEXT" && "range" in normalizedFields) {
    const range = normalizedFields["range"] as Record<string, unknown>;
    normalizedFields["range"] = { unit: "UNICODE_CODE_POINT", ...range };
  }
  if (modality === "IMAGE") normalizedFields["coordinateSpace"] = "PIXEL";
  if (modality === "TOOL_RESULT" && "fragment" in normalizedFields) {
    const fragment = normalizedFields["fragment"] as Record<string, unknown>;
    if (fragment["kind"] === "TEXT_RANGE") {
      normalizedFields["fragment"] = { unit: "UNICODE_CODE_POINT", ...fragment };
    }
  }
  return {
    version: JOURNAL_SELECTOR_VERSION,
    modality,
    payload: { namespace, payloadId, version: "v1" },
    ...normalizedFields
  };
}

function command(
  kind: string,
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    version: JOURNAL_COMMAND_VERSION,
    kind,
    occurrenceTime: { state: "UNKNOWN" },
    causalParents: [],
    data,
    ...overrides
  };
}

function validate(input: unknown, auth: unknown = authority(), known = history) {
  return validateJournalCommand(input, auth, { knownEvents: known });
}

function intentAuthority(actionRef: string, effectContractRef: string) {
  return authority({
    intentAuthorization: {
      kind: "AUTHORIZED_INTENT",
      decision: decisionRef,
      actionRef,
      effectContractRef,
      policyVersion: "policy.v1"
    }
  });
}

function expectCode(run: () => unknown, code: JournalContractError["code"]) {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(JournalContractError);
    expect((error as JournalContractError).code).toBe(code);
  }
}

describe("A8.1 life-event journal contract", () => {
  it("accepts exactly the seven versioned event kinds as distinct command shapes", () => {
    const examples = [
      command("RECEIPT", {
        receiptClass: "ATTRIBUTED_ASSERTION",
        evidenceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 8 } })]
      }),
      command(
        "INTENT",
        { actionRef: "local-transform", effectContractRef: "effect.v1" },
        { causalParents: [decisionRef] }
      ),
      command(
        "ATTEMPT",
        { intent: intentRef, dispatchBoundary: "MAY_BEGIN" },
        { causalParents: [intentRef] }
      ),
      command(
        "OUTCOME",
        {
          attempt: attemptRef,
          certainty: "CONFIRMED_SUCCESS",
          establishes: "LOCAL_RESULT_PRODUCED",
          evidenceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 5 } })]
        },
        { causalParents: [attemptRef] }
      ),
      command(
        "DECISION",
        {
          choice: "ADMIT",
          inputRefs: [receiptRef],
          alternatives: ["REJECT"]
        },
        { causalParents: [receiptRef] }
      ),
      command(
        "DERIVATION",
        {
          derivedRef: "claim-1",
          derivationKind: "CLAIM",
          claim: {
            assertor: { kind: "PRINCIPAL", namespace: "chat", actorId: "account-bob" },
            subject: { kind: "PERSON", personId: "person-alice" },
            provenance: "EXTERNAL_CLAIM",
            propositionRef: "repayment"
          },
          sourceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 8 } })],
          sourceEvents: [receiptRef],
          derivationVersion: "extractor.v1"
        },
        { causalParents: [receiptRef] }
      ),
      command(
        "AMENDMENT",
        {
          target: receiptRef,
          relation: "CORRECTION",
          reasonRef: "controller-correction",
          replacementRef: "corrected-claim"
        },
        { causalParents: [receiptRef] }
      )
    ];
    expect(
      examples.map(
        (example) =>
          validate(
            example,
            example.kind === "INTENT"
              ? intentAuthority("local-transform", "effect.v1")
              : authority()
          ).command.kind
      )
    ).toEqual(["RECEIPT", "INTENT", "ATTEMPT", "OUTCOME", "DECISION", "DERIVATION", "AMENDMENT"]);
    expect(
      JournalEventCommandSchema.safeParse({ ...examples[0], kind: "TRUST_UPDATE" }).success
    ).toBe(false);
    expect(
      JournalEventCommandSchema.safeParse({
        ...examples[1],
        data: { actionRef: "a", effectContractRef: "e", logicalIntentRef: "model-minted-id" }
      }).success
    ).toBe(false);
    expect(
      JournalEventCommandSchema.safeParse({
        ...examples[5],
        data: {
          derivedRef: "claim-without-attribution",
          derivationKind: "CLAIM",
          sourceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 1 } })],
          sourceEvents: [],
          derivationVersion: "v1"
        }
      }).success
    ).toBe(false);
    expect(
      JournalEventCommandSchema.safeParse({
        ...examples[6],
        data: { target: receiptRef, relation: "SUPERSESSION", reasonRef: "why" }
      }).success
    ).toBe(false);
  });

  it("rejects unsupported versions and producer attempts to override authority fields", () => {
    expectCode(
      () =>
        validate({
          ...command("INTENT", { actionRef: "a", effectContractRef: "e" }),
          version: "life-event-command.v2"
        }),
      "UNSUPPORTED_SCHEMA_VERSION"
    );
    expectCode(
      () =>
        validate({
          ...command("INTENT", { actionRef: "a", effectContractRef: "e" }),
          commitSeq: 42
        }),
      "AUTHORITY_FIELD_PROHIBITED"
    );
    expectCode(
      () =>
        validate({
          ...command("INTENT", { actionRef: "a", effectContractRef: "e" }),
          principal: { state: "RESOLVED" }
        }),
      "AUTHORITY_FIELD_PROHIBITED"
    );
    expectCode(
      () =>
        validate({
          ...command("INTENT", { actionRef: "a", effectContractRef: "e" }),
          sourceId: "model-invented"
        }),
      "AUTHORITY_FIELD_PROHIBITED"
    );
    expectCode(
      () =>
        validate({
          ...command("INTENT", { actionRef: "a", effectContractRef: "e" }),
          producer: { name: "model-claimed-host", version: "99" }
        }),
      "AUTHORITY_FIELD_PROHIBITED"
    );
    expectCode(
      () =>
        validate({
          ...command("INTENT", { actionRef: "a", effectContractRef: "e" }),
          surface: { kind: "PRIVATE_CHANNEL", reference: "forged-channel" }
        }),
      "AUTHORITY_FIELD_PROHIBITED"
    );
    expectCode(
      () =>
        validate({
          ...command("INTENT", { actionRef: "a", effectContractRef: "e" }),
          correlations: [{ kind: "MESSAGE", sessionId: "forged", messageId: "forged" }]
        }),
      "AUTHORITY_FIELD_PROHIBITED"
    );
    const unsupported = command("DERIVATION", {
      derivedRef: "d",
      derivationKind: "CLAIM",
      sourceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 1 } })],
      sourceEvents: [],
      derivationVersion: "v1"
    });
    (unsupported.data as { sourceSelectors: unknown[] }).sourceSelectors[0] = selector(
      "TEXT",
      "text-1",
      { range: { start: 0, end: 1 } }
    );
    (unsupported.data as { sourceSelectors: Array<Record<string, unknown>> }).sourceSelectors[0]![
      "version"
    ] = "source-selector.v9";
    expectCode(() => validate(unsupported), "UNSUPPORTED_SCHEMA_VERSION");
    expect(JournalAuthoritySnapshotSchema.safeParse({ ...authority(), commitSeq: 1 }).success).toBe(
      false
    );
  });

  it("requires host policy to authorize an intent and bind it to a prior decision", () => {
    const proposal = command(
      "INTENT",
      { actionRef: "local-transform", effectContractRef: "effect.v1" },
      { causalParents: [decisionRef] }
    );
    expectCode(() => validate(proposal), "UNAUTHORIZED_INTENT");
    expectCode(
      () => validate(proposal, intentAuthority("different-action", "effect.v1")),
      "UNAUTHORIZED_INTENT"
    );
    expectCode(
      () =>
        validate(proposal, {
          ...intentAuthority("local-transform", "effect.v1"),
          intentAuthorization: {
            kind: "AUTHORIZED_INTENT",
            decision: decisionRef,
            actionRef: "local-transform",
            effectContractRef: "effect.v1",
            policyVersion: "stale-policy.v0"
          }
        }),
      "UNAUTHORIZED_INTENT"
    );
    expectCode(
      () =>
        validate(
          command("INTENT", { actionRef: "local-transform", effectContractRef: "effect.v1" }),
          intentAuthority("local-transform", "effect.v1")
        ),
      "ILLEGAL_PARENT_KIND"
    );
  });

  it("keeps authority-assigned identity, namespace, commit order and recorded time out of commands", () => {
    const input = command(
      "INTENT",
      { actionRef: "local", effectContractRef: "v1" },
      { causalParents: [decisionRef] }
    );
    const authorized = intentAuthority("local", "v1");
    const parsed = validate(input, authorized);
    expect(parsed).not.toHaveProperty("eventId");
    expect(parsed).not.toHaveProperty("commitSeq");
    expect(parsed).not.toHaveProperty("recordedAt");
    expect(parsed.authority.journalNamespace).toBe(namespace);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.command)).toBe(true);
    expect(Object.isFrozen(parsed.command.data)).toBe(true);
    expect(Object.isFrozen(parsed.authority.correlations)).toBe(true);

    const envelope = {
      version: JOURNAL_ENVELOPE_VERSION,
      eventId: "jev1_dddddddddddddddd",
      journalNamespace: namespace,
      commitSeq: 5,
      recordedAt: "2029-01-01T00:00:00.000Z",
      command: {
        ...input,
        occurrenceTime: {
          state: "INSTANT",
          at: "2031-01-01T00:00:00.000Z",
          clockSource: "source-clock",
          uncertaintyMs: 60000
        }
      },
      authority: authorized
    };
    expect(validateJournalEnvelope(envelope, { knownEvents: history, latestCommitSeq: 4 })).toEqual(
      envelope
    );
    expectCode(
      () => validateJournalEnvelope({ ...envelope, version: "life-event-envelope.v2" }),
      "UNSUPPORTED_SCHEMA_VERSION"
    );
    expectCode(
      () => validateJournalEnvelope({ ...envelope, journalNamespace: "journal:other" }),
      "CROSS_NAMESPACE_REFERENCE"
    );
  });

  it("validates TEXT, AUDIO, IMAGE/FRAME, JSON and exact tool-result selectors", () => {
    const selectors = [
      selector("TEXT", "text-1", { range: { start: 2, end: 10 } }),
      selector("AUDIO", "audio-1", { rangeMs: { start: 120.5, end: 1400 }, channel: 1 }),
      selector("IMAGE", "image-1", {
        region: { x: 10, y: 10, width: 100, height: 100 },
        frameId: "frame-1"
      }),
      selector("JSON", "json-1", { pointer: "/items/0/name" }),
      selector("TOOL_RESULT", "tool-1", {
        resultRef: "observation-1",
        fragment: { kind: "JSON_POINTER", pointer: "/ok" }
      })
    ];
    for (const sourceSelector of selectors) {
      const input = command(
        "DERIVATION",
        {
          derivedRef: "d",
          derivationKind: "ANNOTATION",
          sourceSelectors: [sourceSelector],
          sourceEvents: [receiptRef],
          derivationVersion: "v1"
        },
        { causalParents: [receiptRef] }
      );
      expect(validate(input).command.kind).toBe("DERIVATION");
    }
    expect(
      validate(
        command(
          "DERIVATION",
          {
            derivedRef: "d",
            derivationKind: "INDEX_INPUT",
            sourceSelectors: [
              selector("TOOL_RESULT", "tool-1", {
                resultRef: "observation-1",
                fragment: { kind: "TEXT_RANGE", start: 0, end: 4 }
              })
            ],
            sourceEvents: [receiptRef],
            derivationVersion: "v1"
          },
          { causalParents: [receiptRef] }
        )
      ).command.kind
    ).toBe("DERIVATION");
  });

  it("rejects malformed, inverted, non-finite, fabricated and out-of-bounds selectors", () => {
    const invalidSelectors = [
      selector("TEXT", "text-1", { range: { start: 9, end: 2 } }),
      selector("TEXT", "text-1", { range: { start: -1, end: 2 } }),
      selector("TEXT", "text-1", { range: { start: 0, end: 21 } }),
      selector("AUDIO", "audio-1", { rangeMs: { start: 4, end: 3 } }),
      selector("AUDIO", "audio-1", { rangeMs: { start: 0, end: 3000 }, channel: 2 }),
      selector("IMAGE", "image-1", { region: { x: 630, y: 10, width: 20, height: 20 } }),
      selector("IMAGE", "image-1", {
        region: { x: 0, y: 0, width: 10, height: 10 },
        frameId: "frame-2"
      }),
      selector("JSON", "json-1", { pointer: "/bad~2escape" }),
      selector("JSON", "json-1", { pointer: "/not-present" }),
      selector("TOOL_RESULT", "tool-1", {
        resultRef: "invented-result",
        fragment: { kind: "JSON_POINTER", pointer: "/ok" }
      }),
      selector("TEXT", "fabricated", { range: { start: 0, end: 1 } }),
      selector("TEXT", "audio-1", { range: { start: 0, end: 1 } })
    ];
    for (const sourceSelector of invalidSelectors) {
      const input = command("DERIVATION", {
        derivedRef: "d",
        derivationKind: "ANNOTATION",
        sourceSelectors: [sourceSelector],
        sourceEvents: [],
        derivationVersion: "v1"
      });
      expect(() => validate(input)).toThrow(JournalContractError);
    }
    const nonFinite = command("DERIVATION", {
      derivedRef: "d",
      derivationKind: "ANNOTATION",
      sourceSelectors: [
        selector("AUDIO", "audio-1", { rangeMs: { start: 0, end: Number.POSITIVE_INFINITY } })
      ],
      sourceEvents: [],
      derivationVersion: "v1"
    });
    expectCode(() => validate(nonFinite), "INVALID_SELECTOR");
  });

  it("requires explicit payload availability and permits a selectable redacted representation", () => {
    const make = (payloadId: string) =>
      command(
        "DERIVATION",
        {
          derivedRef: "d",
          derivationKind: "ANNOTATION",
          sourceSelectors: [selector("TEXT", payloadId, { range: { start: 0, end: 2 } })],
          sourceEvents: [receiptRef],
          derivationVersion: "v1"
        },
        { causalParents: [receiptRef] }
      );
    expect(validate(make("redacted-text")).command.kind).toBe("DERIVATION");
    expectCode(() => validate(make("not-retained-text")), "PAYLOAD_UNAVAILABLE");
    expectCode(() => validate(make("unavailable-text")), "PAYLOAD_UNAVAILABLE");
    expectCode(() => validate(make("missing")), "UNKNOWN_PAYLOAD_REFERENCE");
    expect(authority()).toMatchObject({
      payloads: expect.arrayContaining([
        expect.objectContaining({ retention: "NOT_RETAINED" }),
        expect.objectContaining({ retention: "UNAVAILABLE" })
      ])
    });
  });

  it("preserves source clock uncertainty, skew, equal times, and unknown occurrence time", () => {
    const first = command(
      "RECEIPT",
      { receiptClass: "ATTRIBUTED_ASSERTION" },
      {
        occurrenceTime: {
          state: "INSTANT",
          at: "2035-01-01T00:00:00.000Z",
          clockSource: "untrusted-source-clock",
          uncertaintyMs: 3600000
        }
      }
    );
    const second = command(
      "RECEIPT",
      { receiptClass: "CONTROL" },
      {
        occurrenceTime: {
          state: "INSTANT",
          at: "2035-01-01T00:00:00.000Z",
          clockSource: "another-clock",
          uncertaintyMs: 0
        }
      }
    );
    const interval = command(
      "RECEIPT",
      { receiptClass: "CONTROL" },
      {
        occurrenceTime: {
          state: "INTERVAL",
          start: "2034-12-31T23:59:00.000Z",
          end: "2035-01-01T00:01:00.000Z",
          clockSource: "source",
          uncertaintyMs: 60000
        }
      }
    );
    expect(validate(first).command).toMatchObject({ occurrenceTime: { state: "INSTANT" } });
    expect(validate(second).command).toMatchObject({ occurrenceTime: { state: "INSTANT" } });
    expect(validate(interval).command).toMatchObject({ occurrenceTime: { state: "INTERVAL" } });
    expect(validate(command("RECEIPT", { receiptClass: "CONTROL" })).command).toMatchObject({
      occurrenceTime: { state: "UNKNOWN" }
    });
    expectCode(
      () =>
        validate(
          command(
            "RECEIPT",
            { receiptClass: "CONTROL" },
            {
              occurrenceTime: {
                state: "INTERVAL",
                start: "2035-01-01T00:01:00.000Z",
                end: "2035-01-01T00:00:00.000Z",
                clockSource: "clock",
                uncertaintyMs: 0
              }
            }
          )
        ),
      "INVALID_COMMAND"
    );
    expectCode(
      () =>
        validate(
          command(
            "OUTCOME",
            {
              attempt: attemptRef,
              certainty: "CONFIRMED_SUCCESS",
              establishes: "NO_EFFECT_ESTABLISHED",
              evidenceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 2 } })]
            },
            { causalParents: [attemptRef] }
          )
        ),
      "INVALID_COMMAND"
    );
  });

  it("keeps principal, Person binding, subjects, private/group scope, and membership certainty separate", () => {
    const ambiguousPrincipal = authority({
      principal: {
        state: "AMBIGUOUS",
        candidates: [
          { namespace: "chat", actorId: "account-a" },
          { namespace: "chat", actorId: "account-b" }
        ]
      },
      binding: {
        state: "RESOLVED",
        kind: "PERSON_BINDING",
        personId: "person-alice",
        bindingVersion: "binding.v7"
      }
    });
    expect(
      validate(command("RECEIPT", { receiptClass: "ATTRIBUTED_ASSERTION" }), ambiguousPrincipal)
        .authority
    ).toMatchObject({
      principal: { state: "AMBIGUOUS" },
      binding: { state: "RESOLVED", personId: "person-alice" }
    });

    const groupUnknown = authority({
      surface: { kind: "GROUP_CHANNEL", reference: "group:friends" },
      audience: {
        kind: "GROUP",
        channelRef: "group:friends",
        membership: { state: "UNKNOWN", reason: "snapshot missing" }
      }
    });
    const groupInput = command("RECEIPT", { receiptClass: "ATTRIBUTED_ASSERTION" });
    expect(validate(groupInput, groupUnknown).authority.audience).toMatchObject({
      kind: "GROUP",
      membership: { state: "UNKNOWN" }
    });
    const groupIncomplete = authority({
      surface: { kind: "GROUP_CHANNEL", reference: "group:friends" },
      audience: {
        kind: "GROUP",
        channelRef: "group:friends",
        membership: { state: "INCOMPLETE", snapshotRef: "members:v1", reason: "partial list" }
      }
    });
    expect(validate(groupInput, groupIncomplete).authority.audience).toMatchObject({
      membership: { state: "INCOMPLETE" }
    });
    const groupKnown = authority({
      surface: { kind: "GROUP_CHANNEL", reference: "group:friends" },
      audience: {
        kind: "GROUP",
        channelRef: "group:friends",
        membership: { state: "KNOWN", snapshotRef: "members:v2", version: "v2" }
      }
    });
    expect(validate(groupInput, groupKnown).authority.audience).toMatchObject({
      membership: { state: "KNOWN", snapshotRef: "members:v2" }
    });
    expectCode(
      () =>
        validate(command("RECEIPT", { receiptClass: "ATTRIBUTED_ASSERTION" }), {
          ...groupUnknown,
          surface: { kind: "GROUP_CHANNEL", reference: "group:elsewhere" }
        }),
      "SCOPE_MISMATCH"
    );
    expectCode(
      () =>
        validate(
          command("RECEIPT", { receiptClass: "ATTRIBUTED_ASSERTION" }),
          authority({
            audience: {
              kind: "GROUP",
              channelRef: "group:friends",
              membership: { state: "UNKNOWN", reason: "unknown" }
            }
          })
        ),
      "SCOPE_MISMATCH"
    );
    expect(authority()).toMatchObject({
      principal: { state: "UNRESOLVED" },
      subjects: [{ kind: "PERSON", personId: "person-alice" }, { kind: "YUVI_SELF" }]
    });
    const unresolvedSource = authority({
      sourceReferences: [
        { kind: "UNRESOLVED_SOURCE", reason: "transport did not provide a stable source id" }
      ]
    });
    expect(
      validate(command("RECEIPT", { receiptClass: "CONTROL" }), unresolvedSource).authority
        .sourceReferences
    ).toEqual([
      { kind: "UNRESOLVED_SOURCE", reason: "transport did not provide a stable source id" }
    ]);
  });

  it("validates causal parents, kind transitions, amendments and derivation lineage", () => {
    expectCode(
      () =>
        validate(
          command(
            "DECISION",
            { choice: "SELECT", inputRefs: [], alternatives: [] },
            { causalParents: [receiptRef, receiptRef] }
          )
        ),
      "DUPLICATE_PARENT"
    );
    expectCode(
      () =>
        validate(
          command(
            "ATTEMPT",
            { intent: receiptRef, dispatchBoundary: "MAY_BEGIN" },
            { causalParents: [receiptRef] }
          )
        ),
      "ILLEGAL_PARENT_KIND"
    );
    expectCode(
      () =>
        validate(
          command("DECISION", { choice: "ADMIT", inputRefs: [receiptRef], alternatives: [] }),
          authority()
        ),
      "ILLEGAL_PARENT_KIND"
    );
    expectCode(
      () =>
        validate(
          command(
            "DECISION",
            { choice: "ADMIT", inputRefs: [], alternatives: [] },
            { causalParents: [receiptRef] }
          ),
          authority(),
          []
        ),
      "UNKNOWN_PARENT"
    );
    expectCode(
      () =>
        validate(
          command("AMENDMENT", { target: receiptRef, relation: "RETRACTION", reasonRef: "why" })
        ),
      "ILLEGAL_PARENT_KIND"
    );
    expectCode(
      () =>
        validate(
          command("DERIVATION", {
            derivedRef: "d",
            derivationKind: "ANNOTATION",
            sourceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 1 } })],
            sourceEvents: [receiptRef],
            derivationVersion: "v1"
          })
        ),
      "ILLEGAL_PARENT_KIND"
    );
    const unlinkedPayloadCatalog = authority({
      payloads: authority().payloads.map((item) =>
        item.ref.payloadId === "text-1" ? { ...item, sourceEvent: intentRef } : item
      )
    });
    expectCode(
      () =>
        validate(
          command(
            "DERIVATION",
            {
              derivedRef: "d",
              derivationKind: "ANNOTATION",
              sourceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 1 } })],
              sourceEvents: [receiptRef],
              derivationVersion: "v1"
            },
            { causalParents: [receiptRef] }
          ),
          unlinkedPayloadCatalog
        ),
      "INCONSISTENT_SOURCE_LINEAGE"
    );
    expectCode(
      () =>
        validate(
          command("DERIVATION", {
            derivedRef: "d",
            derivationKind: "ANNOTATION",
            sourceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 1 } })],
            sourceEvents: [],
            derivationVersion: "v1"
          })
        ),
      "INCONSISTENT_SOURCE_LINEAGE"
    );
    const selfParentCommand = command(
      "DECISION",
      { choice: "DEFER", inputRefs: [], alternatives: [] },
      { causalParents: [ref("jev1_dddddddddddddddd")] }
    );
    expectCode(
      () =>
        validateJournalEnvelope({
          version: JOURNAL_ENVELOPE_VERSION,
          eventId: "jev1_dddddddddddddddd",
          journalNamespace: namespace,
          commitSeq: 4,
          recordedAt: "2029-01-01T00:00:00Z",
          command: selfParentCommand,
          authority: authority()
        }),
      "SELF_PARENT"
    );

    const newEventId = "jev1_eeeeeeeeeeeeeeee";
    const cyclicHistory: JournalHistoryEntry[] = [
      { ref: receiptRef, kind: "RECEIPT", parentRefs: [ref(newEventId)], commitSeq: 1 }
    ];
    expectCode(
      () =>
        validateJournalEnvelope(
          {
            version: JOURNAL_ENVELOPE_VERSION,
            eventId: newEventId,
            journalNamespace: namespace,
            commitSeq: 2,
            recordedAt: "2029-01-01T00:00:00Z",
            command: command(
              "DECISION",
              { choice: "DEFER", inputRefs: [], alternatives: [] },
              { causalParents: [receiptRef] }
            ),
            authority: authority()
          },
          { knownEvents: cyclicHistory, historyComplete: true }
        ),
      "CAUSAL_CYCLE"
    );
  });

  it("keeps ATTEMPT separate from OUTCOME and does not promote UNKNOWN", () => {
    const attempt = command(
      "ATTEMPT",
      { intent: intentRef, dispatchBoundary: "MAY_BEGIN" },
      { causalParents: [intentRef] }
    );
    expect(validate(attempt).command.kind).toBe("ATTEMPT");
    expect(
      JournalEventCommandSchema.safeParse({
        ...attempt,
        data: {
          intent: intentRef,
          certainty: "CONFIRMED_SUCCESS",
          establishes: "LOCAL_RESULT_PRODUCED"
        }
      }).success
    ).toBe(false);
    expectCode(
      () =>
        validate(
          command(
            "OUTCOME",
            {
              attempt: attemptRef,
              certainty: "UNKNOWN",
              establishes: "success",
              evidenceSelectors: []
            },
            { causalParents: [attemptRef] }
          )
        ),
      "INVALID_COMMAND"
    );
    expectCode(
      () =>
        validate(
          command(
            "OUTCOME",
            {
              attempt: attemptRef,
              certainty: "CONFIRMED_SUCCESS",
              establishes: "delivered",
              evidenceSelectors: []
            },
            { causalParents: [attemptRef] }
          )
        ),
      "INVALID_COMMAND"
    );
    expectCode(
      () =>
        validate(
          command(
            "OUTCOME",
            { attempt: attemptRef, status: "SUCCESS", evidenceSelectors: [] },
            { causalParents: [attemptRef] }
          )
        ),
      "INVALID_COMMAND"
    );
    expect(
      validate(
        command(
          "OUTCOME",
          { attempt: attemptRef, certainty: "UNKNOWN", evidenceSelectors: [] },
          { causalParents: [attemptRef] }
        )
      ).command.kind
    ).toBe("OUTCOME");
    expect(
      validate(
        command(
          "OUTCOME",
          {
            attempt: attemptRef,
            certainty: "CONFIRMED_FAILURE",
            establishes: "DELIVERY_REJECTED",
            evidenceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 2 } })]
          },
          { causalParents: [attemptRef] }
        )
      ).command.kind
    ).toBe("OUTCOME");
  });

  it("does not accept generated assistant prose as authoritative evidence of YUVI self-disposition", () => {
    const generatedClaim = command(
      "DERIVATION",
      {
        derivedRef: "self-claim",
        derivationKind: "CLAIM",
        claim: {
          assertor: { kind: "YUVI_SELF" },
          subject: { kind: "YUVI_SELF" },
          provenance: "SELF_REPORT",
          propositionRef: "I-am-jealous"
        },
        sourceSelectors: [selector("TEXT", "assistant-text", { range: { start: 0, end: 12 } })],
        sourceEvents: [receiptRef],
        derivationVersion: "extractor.v1"
      },
      { causalParents: [receiptRef] }
    );
    expectCode(() => validate(generatedClaim), "SELF_GENERATED_DISPOSITION_NOT_AUTHORITATIVE");
    const relabeledGenerated = {
      ...generatedClaim,
      data: {
        ...(generatedClaim.data as object),
        claim: {
          assertor: { kind: "YUVI_SELF" },
          subject: { kind: "YUVI_SELF" },
          provenance: "EXTERNAL_CLAIM",
          propositionRef: "I-am-jealous"
        }
      }
    };
    expectCode(() => validate(relabeledGenerated), "SELF_GENERATED_DISPOSITION_NOT_AUTHORITATIVE");
    const labeledInference = {
      ...generatedClaim,
      data: {
        ...(generatedClaim.data as object),
        claim: {
          assertor: { kind: "YUVI_SELF" },
          subject: { kind: "YUVI_SELF" },
          provenance: "ASSISTANT_INFERENCE",
          propositionRef: "I-am-jealous"
        }
      }
    };
    expect(validate(labeledInference).command.kind).toBe("DERIVATION");
  });

  it("preserves UNKNOWN_AMBIENT claim provenance without upgrading it", () => {
    const unknownAmbient = command(
      "DERIVATION",
      {
        derivedRef: "ambient-claim",
        derivationKind: "CLAIM",
        claim: {
          assertor: { kind: "UNRESOLVED", reason: "no attributable speaker" },
          subject: { kind: "UNRESOLVED", reason: "no attributable subject" },
          provenance: "UNKNOWN_AMBIENT",
          propositionRef: "ambient-observation"
        },
        sourceSelectors: [selector("TEXT", "text-1", { range: { start: 0, end: 8 } })],
        sourceEvents: [receiptRef],
        derivationVersion: "extractor.v1"
      },
      { causalParents: [receiptRef] }
    );
    expect(validate(unknownAmbient).command).toMatchObject({
      data: { claim: { provenance: "UNKNOWN_AMBIENT" } }
    });
  });

  it("keeps legacy Memory IDs explicitly typed and never treats their UUID shape as a journal event ID", () => {
    const memoryUuid = "550e8400-e29b-41d4-a716-446655440000";
    const legacyRef = {
      kind: "LEGACY_MEMORY_EVENT",
      provider: "legacy-postgres",
      eventId: memoryUuid,
      sourceTraceId: "trace-old"
    };
    const onlyLegacyMemory = authority({ sourceReferences: [legacyRef] });
    expect(
      validate(
        command(
          "INTENT",
          { actionRef: "legacy-index", effectContractRef: "local.v1" },
          { causalParents: [decisionRef] }
        ),
        { ...intentAuthority("legacy-index", "local.v1"), sourceReferences: [legacyRef] }
      ).authority.sourceReferences
    ).toEqual([legacyRef]);
    expectCode(
      () =>
        validate(command("RECEIPT", { receiptClass: "ATTRIBUTED_ASSERTION" }), onlyLegacyMemory),
      "INVALID_AUTHORITY_CONTEXT"
    );
    expectCode(
      () =>
        validate(
          command(
            "ATTEMPT",
            {
              intent: { kind: "JOURNAL_EVENT", namespace, eventId: memoryUuid },
              dispatchBoundary: "MAY_BEGIN"
            },
            { causalParents: [intentRef] }
          )
        ),
      "INVALID_COMMAND"
    );
    expectCode(
      () =>
        validate(
          command(
            "ATTEMPT",
            {
              intent: {
                kind: "LEGACY_MEMORY_EVENT",
                provider: "legacy-postgres",
                eventId: memoryUuid
              },
              dispatchBoundary: "MAY_BEGIN"
            },
            { causalParents: [intentRef] }
          )
        ),
      "INVALID_COMMAND"
    );
  });

  it("checks committed identity uniqueness and commit order only against supplied read-only history", () => {
    const envelope = {
      version: JOURNAL_ENVELOPE_VERSION,
      eventId: "jev1_ffffffffffffffff",
      journalNamespace: namespace,
      commitSeq: 5,
      recordedAt: "2029-01-01T00:00:00.000Z",
      command: command(
        "INTENT",
        { actionRef: "local", effectContractRef: "v1" },
        { causalParents: [decisionRef] }
      ),
      authority: intentAuthority("local", "v1")
    };
    expect(validateJournalEnvelope(envelope, { knownEvents: history })).toEqual(envelope);
    expectCode(
      () =>
        validateJournalEnvelope(
          { ...envelope, eventId: intentRef.eventId },
          { knownEvents: history }
        ),
      "DUPLICATE_EVENT_ID"
    );
    expectCode(
      () => validateJournalEnvelope({ ...envelope, commitSeq: 3 }, { knownEvents: history }),
      "NON_MONOTONIC_COMMIT_SEQUENCE"
    );
  });

  it("reapplies source and payload-catalog admission checks to committed envelopes", () => {
    const base = {
      version: JOURNAL_ENVELOPE_VERSION,
      eventId: "jev1_hhhhhhhhhhhhhhhh",
      journalNamespace: namespace,
      commitSeq: 5,
      recordedAt: "2029-01-01T00:00:00.000Z",
      command: command("RECEIPT", { receiptClass: "ATTRIBUTED_ASSERTION" }),
      authority: authority()
    };
    const legacyOnlyAuthority = authority({
      sourceReferences: [
        { kind: "LEGACY_MEMORY_EVENT", provider: "legacy-postgres", eventId: "memory-row-1" }
      ]
    });
    expectCode(
      () => validateJournalEnvelope({ ...base, authority: legacyOnlyAuthority }),
      "INVALID_AUTHORITY_CONTEXT"
    );

    const duplicatedPayloadAuthority = authority({
      payloads: [
        payload("TEXT", "same", { characterCount: 12 }),
        payload("TEXT", "same", { characterCount: 12 })
      ]
    });
    expectCode(
      () => validateJournalEnvelope({ ...base, authority: duplicatedPayloadAuthority }),
      "INVALID_AUTHORITY_CONTEXT"
    );
  });
});
