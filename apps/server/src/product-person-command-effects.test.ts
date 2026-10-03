import { describe, expect, it } from "vitest";
import { createAcousticReplacementWorkflowPlan } from "./product-person-command-effects.js";

function replacementPlan(personaId = "persona-one") {
  return createAcousticReplacementWorkflowPlan({
    workflowId: "replacement-command",
    newVoiceProfileId: "voice-new",
    previousVoiceProfileId: "voice-old",
    personId: "person-one",
    personaId,
    label: "Rui",
    sampleReferences: ["private-sample-ref"],
    sampleDigests: ["a".repeat(64)]
  });
}

describe("native control replacement workflow plan", () => {
  it("declares three immutable owner children in the frozen order without storing audio", () => {
    const plan = replacementPlan();
    expect(plan).toMatchObject({
      version: "native-control-workflow.v1",
      workflowId: "replacement-command",
      kind: "ACOUSTIC_PROFILE_REPLACEMENT",
      steps: [
        { stepKey: "enroll_new", ordinal: 0, family: "ACOUSTIC_PROFILE", operation: "ENROLL", targetReference: "voice-new" },
        {
          stepKey: "switch_binding",
          ordinal: 1,
          family: "VOICE_BINDING",
          operation: "REPLACE",
          targetReference: "voice-new",
          relatedTargetReference: "voice-old"
        },
        { stepKey: "retire_old", ordinal: 2, family: "ACOUSTIC_PROFILE", operation: "DELETE", targetReference: "voice-old" }
      ]
    });
    expect(JSON.stringify(plan)).not.toContain("PRIVATE_AUDIO");
    expect(JSON.stringify(plan)).not.toContain("Rui");
    expect(JSON.stringify(plan)).not.toContain("private-sample-ref");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.steps)).toBe(true);
    expect(plan.steps.every(Object.isFrozen)).toBe(true);
  });

  it("binds the planned switch to its semantic Person scope", () => {
    const first = replacementPlan();
    const otherPersona = replacementPlan("persona-two");
    expect(first.steps[1]?.semanticDigest).not.toBe(otherPersona.steps[1]?.semanticDigest);
    expect(first.steps[0]?.semanticDigest).toBe(otherPersona.steps[0]?.semanticDigest);
  });

  it("rejects a replacement that would reuse one acoustic profile as both resources", () => {
    expect(() => createAcousticReplacementWorkflowPlan({
      workflowId: "replacement-command",
      newVoiceProfileId: "voice-same",
      previousVoiceProfileId: "voice-same",
      personId: "person-one",
      personaId: "persona-one",
      label: "Rui",
      sampleReferences: ["private-sample-ref"],
      sampleDigests: ["a".repeat(64)]
    })).toThrow("Invalid acoustic replacement workflow identity.");
  });
});
