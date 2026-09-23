import { describe, expect, it } from "vitest";
import {
  assembleCanonicalContext,
  projectCanonicalCognitionMessages,
  projectCanonicalSharedContext
} from "./canonical-context.js";
import { PromptBuilder } from "./index.js";

const prompt = new PromptBuilder().buildPrompt({
  systemIdentity: "YUVI product policy",
  relationshipContext: "Use retrieved evidence only when relevant.",
  directContext: "User: earlier task",
  retrievedMemories: ["A retrieved claim, not a person fact."],
  currentTime: {
    isoTimestamp: "2026-09-23T00:00:00.000Z",
    timezone: "UTC",
    localDate: "2026-09-23"
  },
  currentSituation: "The user is asking for verification.",
  userMessage: "Verify this image."
});

const producers = [
  { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "A retrieved claim, not a person fact." },
  { kind: "PERSONA", state: "KNOWN", summary: "P8 persona projection" },
  { kind: "RECENT_CONVERSATION", state: "KNOWN", summary: "User: earlier task" },
  { kind: "RELATIONSHIP_CONTEXT", state: "UNKNOWN" },
  { kind: "IDENTITY", state: "KNOWN", summary: "P8 identity projection" },
  { kind: "TEMPORAL_CONTEXT", state: "KNOWN", summary: "2026-09-23" }
] as const;

describe("canonical semantic assembly", () => {
  it("orders equivalent producer inputs deterministically and snapshots them", () => {
    const first = assembleCanonicalContext({
      semanticSections: producers,
      promptSections: prompt.sections,
      currentInput: "Verify this image."
    });
    const second = assembleCanonicalContext({
      semanticSections: [...producers].reverse(),
      promptSections: prompt.sections,
      currentInput: "Verify this image."
    });
    expect(first).toEqual(second);
    expect(first.sharedSections.map((section) => section.kind)).toEqual([
      "IDENTITY",
      "PERSONA",
      "RELATIONSHIP_CONTEXT",
      "RECENT_CONVERSATION",
      "MEMORY_EVIDENCE",
      "TEMPORAL_CONTEXT",
      "CURRENT_SITUATION"
    ]);
    expect(Object.isFrozen(first.sharedSections)).toBe(true);
    expect(Object.isFrozen(first.promptSections)).toBe(true);
    expect(first.currentInput).toBe("Verify this image.");
  });

  it("keeps Memory evidence outside P8, identity, policy and capability authority", () => {
    const context = assembleCanonicalContext({
      semanticSections: producers,
      promptSections: prompt.sections,
      currentInput: "Verify this image.",
      capabilityDescriptions: "Opaque read capability",
      interactionProtocol: "COMPLETE or REQUEST_CAPABILITY"
    });
    const section = (kind: string) => context.sharedSections.find((entry) => entry.kind === kind);
    expect(section("IDENTITY")?.summary).toBe("P8 identity projection");
    expect(section("PERSONA")?.summary).toBe("P8 persona projection");
    expect(section("RELATIONSHIP_CONTEXT")?.state).toBe("UNKNOWN");
    expect(section("MEMORY_EVIDENCE")?.summary).toContain("retrieved claim");
    expect(context.policy).not.toContain(section("MEMORY_EVIDENCE")?.summary);
    expect(context.capabilityDescriptions).toBe("Opaque read capability");
    expect(projectCanonicalSharedContext(context)).toContain('"kind":"MEMORY_EVIDENCE"');
    expect(projectCanonicalSharedContext(context)).toContain('"state":"UNKNOWN"');
  });

  it("projects Cognition order with current task, capabilities, protocol and visual evidence", () => {
    const context = assembleCanonicalContext({
      semanticSections: producers,
      promptSections: prompt.sections,
      currentInput: "Character-authorized verification problem",
      multimodalEvidence: '{"status":"AVAILABLE","observations":"Image shows a chart."}',
      capabilityDescriptions: "Opaque read capability",
      interactionProtocol: "COMPLETE or REQUEST_CAPABILITY"
    });
    const messages = projectCanonicalCognitionMessages(context);
    expect(messages.map((message) => message.role)).toEqual(Array(6).fill("user"));
    expect(messages[0]!.content).toContain("P8 identity projection");
    expect(messages[1]!.content).toContain("YUVI product policy");
    expect(messages[2]!.content).toBe("Character-authorized verification problem");
    expect(messages[3]!.content).toContain("Image shows a chart.");
    expect(messages[4]!.content).toBe("Opaque read capability");
    expect(messages[5]!.content).toBe("COMPLETE or REQUEST_CAPABILITY");
  });

  it("rejects a duplicate producer slot instead of letting later evidence rewrite it", () => {
    expect(() =>
      assembleCanonicalContext({
        semanticSections: [
          ...producers,
          { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "rewritten" }
        ]
      })
    ).toThrow("duplicate section");
  });

  it("retains the existing direct Chat projection and separate proactive mode", () => {
    expect(prompt.messages[0]?.content).toContain("<DirectContext>");
    expect(prompt.messages[0]?.content).toContain("<RelevantMemory>");
    expect(prompt.messages[1]?.content).toContain("<UserMessage>");
    const proactive = new PromptBuilder().buildPrompt({
      systemIdentity: "YUVI",
      turnOrigin: "assistant-initiated",
      proactiveInstruction: "Decide whether to speak.",
      directContext: "User: earlier task"
    });
    expect(proactive.messages).toHaveLength(1);
    expect(proactive.sections.map((section) => section.name)).toEqual([
      "SystemIdentity",
      "ProactiveInstruction",
      "RelationshipContext",
      "DirectContext",
      "RelevantMemory"
    ]);
  });
});
