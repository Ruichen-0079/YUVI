import { describe, expect, it } from "vitest";
import { assembleCanonicalContext, type CanonicalSharedSection } from "./canonical-context.js";
import {
  projectCanonicalCognitionMessages,
  PromptBuilder,
  type PromptBuildInput
} from "./index.js";

const promptBuilder = new PromptBuilder();

function semanticSections(
  overrides: Partial<Record<string, Partial<CanonicalSharedSection>>> = {}
) {
  const base: CanonicalSharedSection[] = [
    {
      kind: "IDENTITY",
      state: "KNOWN",
      summary: "P8 identity",
      provenanceReferences: ["p8:b", "p8:a"]
    },
    {
      kind: "PERSONA",
      state: "KNOWN",
      summary: "P8 persona",
      provenanceReferences: ["p8:persona"]
    },
    {
      kind: "RELATIONSHIP_CONTEXT",
      state: "KNOWN",
      summary: "Retrieved relationship interpretation"
    },
    { kind: "RECENT_CONVERSATION", state: "KNOWN", summary: "Earlier conversation" },
    { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "Retrieved memory evidence" },
    { kind: "TEMPORAL_CONTEXT", state: "KNOWN", summary: "Current timestamp" },
    { kind: "CURRENT_SITUATION", state: "KNOWN", summary: "Current situation" }
  ];
  return base.map((section) => ({ ...section, ...overrides[section.kind] }));
}

function promptInput(overrides: Partial<PromptBuildInput> = {}): PromptBuildInput {
  return {
    systemIdentity: "You are YUVI.",
    relationshipContext: "Use retrieved context only when relevant.",
    directContext: "Earlier user and assistant messages.",
    retrievedMemories: ["A retrieved claim."],
    currentTime: {
      isoTimestamp: "2026-09-23T01:00:00.000Z",
      timezone: "UTC",
      localDate: "2026-09-23"
    },
    currentAffect: "No high-confidence immediate affect detected.",
    currentSituation: "The user is asking for verification.",
    userMessage: "Verify this image.",
    ...overrides
  } as PromptBuildInput;
}

function assemble(
  overrides: {
    sections?: readonly CanonicalSharedSection[];
    prompt?: PromptBuildInput;
    currentInput?: string;
    multimodalEvidence?: string | null;
    capabilityDescriptions?: string | null;
    capabilityDescriptionsVersion?: string | null;
    interactionProtocol?: string | null;
    interactionProtocolVersion?: string | null;
    currentSpeakerEvidence?: string | null;
  } = {}
) {
  const prompt = promptBuilder.buildPrompt(overrides.prompt ?? promptInput());
  const capabilityDescriptions =
    overrides.capabilityDescriptions === undefined
      ? "Capability inventory v1"
      : overrides.capabilityDescriptions;
  const interactionProtocol =
    overrides.interactionProtocol === undefined
      ? "Cognition protocol v1"
      : overrides.interactionProtocol;
  return assembleCanonicalContext({
    semanticSections: overrides.sections ?? semanticSections(),
    promptSections: prompt.sections,
    currentInput: overrides.currentInput ?? promptInput(overrides.prompt).userMessage,
    multimodalEvidence: overrides.multimodalEvidence ?? "Image observation",
    capabilityDescriptions,
    capabilityDescriptionsVersion:
      overrides.capabilityDescriptionsVersion ??
      (capabilityDescriptions === null ? null : "cognition-6g.v1"),
    interactionProtocol,
    interactionProtocolVersion:
      overrides.interactionProtocolVersion ??
      (interactionProtocol === null ? null : "cognition-interaction-round.v1"),
    currentSpeakerEvidence: overrides.currentSpeakerEvidence ?? null
  });
}

describe("canonical context stability boundary", () => {
  it("classifies stable and volatile semantic sources explicitly in canonical order", () => {
    const context = assemble();
    expect(context.stability.stablePrefix.version).toBe("canonical-context-stability.v1");
    expect(context.stability.stablePrefix.components.map((component) => component.kind)).toEqual([
      "IDENTITY",
      "PERSONA",
      "POLICY",
      "CAPABILITY_DESCRIPTIONS",
      "INTERACTION_PROTOCOL"
    ]);
    expect(context.stability.volatileContext.sharedSections.map((section) => section.kind)).toEqual(
      [
        "RELATIONSHIP_CONTEXT",
        "RECENT_CONVERSATION",
        "MEMORY_EVIDENCE",
        "TEMPORAL_CONTEXT",
        "CURRENT_SITUATION"
      ]
    );
    expect(context.stability.volatileContext.promptSections.map((section) => section.name)).toEqual(
      [
        "CurrentTime",
        "CurrentAffect",
        "DirectContext",
        "RecentEpisodicMemory",
        "RelevantMemory",
        "CurrentSituation",
        "Tools",
        "UserMessage"
      ]
    );
    expect(context.promptSections.find((section) => section.name === "CurrentTime")?.stable).toBe(
      true
    );
    expect(
      context.stability.volatileContext.promptSections.find(
        (section) => section.name === "CurrentTime"
      )?.stable
    ).toBe(false);
    expect(context.stability.stablePrefix.identity).not.toContain("Retrieved memory evidence");
    expect(context.stability.stablePrefix.identity).not.toContain("Earlier conversation");
    expect(context.stability.volatileContext.currentInput).toBe("Verify this image.");
    expect(context.stability.volatileContext.multimodalEvidence).toBe("Image observation");
    expect(context.stability.volatileContext.executionLocalComponents).toEqual([
      "CAPABILITY_REQUEST_OBSERVATION"
    ]);
  });

  it("builds the same exact versioned identity for equivalent stable semantics", () => {
    const sections = semanticSections();
    const first = assemble({ sections });
    const reversed = assemble({
      sections: sections
        .slice()
        .reverse()
        .map((section) =>
          section.kind === "IDENTITY"
            ? { ...section, provenanceReferences: ["p8:a", "p8:b"] }
            : section
        )
    });
    expect(reversed.stability.stablePrefix.identity).toBe(first.stability.stablePrefix.identity);
    expect(reversed.stability.stablePrefix.components).toEqual(
      first.stability.stablePrefix.components
    );
  });

  it("keeps turn-dependent context and current speaker evidence out of prefix identity", () => {
    const first = assemble();
    const changed = assemble({
      sections: semanticSections({
        RELATIONSHIP_CONTEXT: { summary: "Different retrieved relationship interpretation" },
        RECENT_CONVERSATION: { summary: "Different recent conversation" },
        MEMORY_EVIDENCE: { summary: "Different retrieved memory evidence" },
        TEMPORAL_CONTEXT: { summary: "Later timestamp" },
        CURRENT_SITUATION: { summary: "New situation" }
      }),
      prompt: promptInput({
        directContext: "Different direct context.",
        retrievedMemories: ["Different retrieved claim."],
        currentTime: {
          isoTimestamp: "2026-09-23T02:00:00.000Z",
          timezone: "UTC",
          localDate: "2026-09-23"
        },
        currentAffect: "A current affect observation.",
        currentSituation: "A different current situation.",
        userMessage: "A different current input."
      }),
      currentInput: "A different authorized task problem.",
      multimodalEvidence: "A different visual observation.",
      currentSpeakerEvidence: '{"speaker":"resolved","personId":"another-person"}'
    });
    expect(changed.stability.stablePrefix.identity).toBe(first.stability.stablePrefix.identity);
    expect(changed.stability.volatileContext.currentInput).toBe(
      "A different authorized task problem."
    );
    expect(changed.stability.volatileContext.sharedSections.at(-1)?.summary).toContain(
      "Current speaker:"
    );
  });

  it.each([
    ["current user input", () => assemble({ currentInput: "Only current input changed." })],
    [
      "retrieved Memory",
      () =>
        assemble({
          sections: semanticSections({ MEMORY_EVIDENCE: { summary: "Only Memory changed." } })
        })
    ],
    [
      "recent conversation",
      () =>
        assemble({
          sections: semanticSections({ RECENT_CONVERSATION: { summary: "Only history changed." } })
        })
    ],
    [
      "Direct Context",
      () => assemble({ prompt: promptInput({ directContext: "Only Direct Context changed." }) })
    ],
    [
      "recent episodic Memory",
      () =>
        assemble({
          prompt: promptInput({ recentEpisodicMemory: "Only episodic evidence changed." })
        })
    ],
    [
      "Relevant Memory",
      () =>
        assemble({ prompt: promptInput({ retrievedMemories: ["Only retrieved Memory changed."] }) })
    ],
    ["multimodal evidence", () => assemble({ multimodalEvidence: "Only the image changed." })],
    [
      "current time",
      () =>
        assemble({
          prompt: promptInput({
            currentTime: {
              isoTimestamp: "2026-09-23T03:00:00.000Z",
              timezone: "UTC",
              localDate: "2026-09-23"
            }
          })
        })
    ],
    [
      "current affect",
      () => assemble({ prompt: promptInput({ currentAffect: "Only affect changed." }) })
    ],
    [
      "current situation",
      () =>
        assemble({
          sections: semanticSections({ CURRENT_SITUATION: { summary: "Only situation changed." } })
        })
    ],
    [
      "current speaker perception",
      () => assemble({ currentSpeakerEvidence: '{"speaker":"resolved","personId":"another"}' })
    ]
  ])("does not change prefix identity when only %s changes", (_name, change) => {
    expect(change().stability.stablePrefix.identity).toBe(
      assemble().stability.stablePrefix.identity
    );
  });

  it.each([
    [
      "identity",
      () =>
        assemble({ sections: semanticSections({ IDENTITY: { summary: "Changed P8 identity" } }) })
    ],
    [
      "persona",
      () => assemble({ sections: semanticSections({ PERSONA: { summary: "Changed P8 persona" } }) })
    ],
    [
      "policy",
      () => assemble({ prompt: promptInput({ systemIdentity: "A revised YUVI instruction." }) })
    ],
    [
      "capability descriptions",
      () => assemble({ capabilityDescriptions: "Capability inventory v2" })
    ],
    [
      "capability schema version",
      () => assemble({ capabilityDescriptionsVersion: "cognition-6g.v2" })
    ],
    ["interaction protocol", () => assemble({ interactionProtocol: "Cognition protocol v2" })],
    [
      "interaction protocol version",
      () => assemble({ interactionProtocolVersion: "cognition-interaction-round.v2" })
    ]
  ])("changes prefix identity when stable %s semantics change", (_label, change) => {
    expect(change().stability.stablePrefix.identity).not.toBe(
      assemble().stability.stablePrefix.identity
    );
  });

  it("gives Character and Cognition the same shared stability classification", () => {
    const character = assemble({ capabilityDescriptions: null, interactionProtocol: null });
    const cognition = assemble({ currentInput: "Character-authorized Cognition problem." });
    const sharedKinds = ["IDENTITY", "PERSONA", "POLICY"];
    expect(
      character.stability.stablePrefix.components.filter((component) =>
        sharedKinds.includes(component.kind)
      )
    ).toEqual(
      cognition.stability.stablePrefix.components.filter((component) =>
        sharedKinds.includes(component.kind)
      )
    );
    expect(
      cognition.stability.stablePrefix.components.map((component) => component.kind)
    ).toContain("CAPABILITY_DESCRIPTIONS");
    expect(cognition.stability.volatileContext.currentInput).toBe(
      "Character-authorized Cognition problem."
    );
  });

  it("keeps current speaker evidence volatile and preserves the A4 Cognition projection order", () => {
    const context = assemble({
      currentSpeakerEvidence: '{"speaker":"resolved","personId":"person-a"}'
    });
    const messages = projectCanonicalCognitionMessages(context);
    expect(messages[0]!.content).toContain('"kind":"IDENTITY"');
    expect(messages[0]!.content).toContain('"kind":"CURRENT_SITUATION"');
    const sharedSections = JSON.parse(messages[0]!.content.split("\n")[1]!) as Array<{
      kind: string;
      summary?: string;
    }>;
    expect(sharedSections.find((section) => section.kind === "IDENTITY")?.summary).not.toContain(
      "Current speaker:"
    );
    expect(
      sharedSections.find((section) => section.kind === "CURRENT_SITUATION")?.summary
    ).toContain('Current speaker: {"speaker":"resolved","personId":"person-a"}');
    expect(messages.map((message) => message.content)).toEqual([
      expect.stringContaining('"kind":"IDENTITY"'),
      expect.stringContaining("Product policy"),
      "Verify this image.",
      expect.stringContaining("Image observation"),
      "Capability inventory v1",
      "Cognition protocol v1"
    ]);
    expect(JSON.stringify(messages)).not.toContain("canonical-context-stability.v1");
    expect(JSON.stringify(messages)).not.toContain("stablePrefix");
    expect(context.stability.stablePrefix.identity).not.toContain("person-a");
  });

  it("rejects a volatile speaker overlay smuggled into the stable identity section", () => {
    expect(() =>
      assemble({
        sections: semanticSections({
          IDENTITY: { summary: "P8 identity\nCurrent speaker: unknown" }
        })
      })
    ).toThrow("Current speaker perception must remain in volatile situation context");
  });
});
