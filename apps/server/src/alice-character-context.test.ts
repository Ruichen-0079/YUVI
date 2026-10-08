import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defineCharacter, characterP8Address, characterPersonaId } from "@companion/core";
import { buildMemoryScope } from "@companion/memory";
import { reconstructP8MainProfile, type P8ExplicitCorrection } from "@companion/p8";
import { projectP8ReconstructionToCharacterAbi } from "@companion/character-abi/p8-projection";
import { assembleCanonicalContext, PromptBuilder } from "@companion/prompt-builder";
import type { ChatInput } from "@companion/providers";
import { createServerCharacterPort } from "./character-runtime.js";

const authored = JSON.parse(
  readFileSync(new URL("../../../config/characters/alice.definition.json", import.meta.url), "utf8")
) as Parameters<typeof defineCharacter>[0];
const relationship = JSON.parse(
  readFileSync(
    new URL("../../../config/characters/alice.relationship.json", import.meta.url),
    "utf8"
  )
) as { meaning: string };
const binding = { instanceId: "alice.authoring-test", definition: defineCharacter(authored) };
const owner = "person:confirmed-creator";

function canonical(personId: string, current: string) {
  const address = characterP8Address(binding, personId);
  const scopeReference = { reference: buildMemoryScope(personId, characterPersonaId(binding)) };
  const correction: P8ExplicitCorrection = {
    correctionReference: "alice-explicit-relationship",
    address,
    scopeReference,
    target: { kind: "INTERPRETATION", interpretationReference: "relationship.current" },
    action: "REVISE",
    replacementMeaning: relationship.meaning,
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: "confirmed-product-person-binding"
    }
  };
  const p8 = reconstructP8MainProfile({
    address,
    expectedScopeReference: scopeReference,
    authoredInvariants: binding.definition.authoredInvariants,
    longTerm: { status: "empty", events: [], source: "test", limited: false },
    referencedInterpretationCandidates: [
      {
        interpretationReference: "relationship.current",
        candidate: { domain: "RELATIONSHIP_CONTEXT" }
      }
    ],
    correctionStore:
      personId === owner
        ? { status: "SUCCESS_WITH_CORRECTIONS", corrections: [correction] }
        : { status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] }
  });
  return assembleCanonicalContext({
    semanticSections: projectP8ReconstructionToCharacterAbi(p8).sections,
    currentInput: current
  });
}

it.each(["GROUP", "PRIVATE", "TEMPORARY_PRIVATE"] as const)(
  "the actual %s body request carries the full authored persona and only its own surface expression",
  async (conversationKind) => {
    const current = "爱丽丝，这个木偶的关节总是卡住，帮我认真检查一下。";
    const calls: ChatInput[] = [];
    const port = createServerCharacterPort({
      responseRequirements: binding.definition.responseRequirements,
      classifyCurrentTurn: async () => ({
        message: {
          role: "assistant",
          content: JSON.stringify({
            authorization: "TASK",
            currentEvidence: current,
            request: "检查关节卡住的原因",
            perception: false
          })
        },
        finishReason: "stop"
      })
    });
    const result = await port.generate({
      userMessage: current,
      canonicalContext: canonical(owner, current),
      interactionBoundary: {
        surface: "qq",
        conversationKind,
        admission: conversationKind === "GROUP" ? "MENTION" : "PRIVATE"
      },
      prompt: new PromptBuilder().buildPrompt({
        systemIdentity: "unused legacy identity",
        characterStyle: "UNWANTED_GENERIC_ASSISTANT",
        userMessage: current
      }),
      generateChat: async (request) => {
        calls.push(request);
        return {
          message: { role: "assistant", content: '{"disposition":"RESPOND"}' },
          finishReason: "stop"
        };
      }
    });
    if (result.decision.reply.disposition !== "RESPOND" || !("body" in result.decision.reply))
      throw Error("Body missing");
    const final = result.decision.reply.body;
    for (const request of [calls[0]!, final]) {
      const system = request.messages[0]!.content;
      expect(system).toContain(authored.identity);
      expect(system).toContain(authored.persona);
      expect(system).toContain(authored.responseRequirements!.general);
      expect(system).toContain(
        conversationKind === "GROUP"
          ? authored.responseRequirements!.group
          : authored.responseRequirements!.private
      );
      expect(system).not.toContain(
        conversationKind === "GROUP"
          ? authored.responseRequirements!.private
          : authored.responseRequirements!.group
      );
      expect(system).toContain(relationship.meaning);
      expect(system.indexOf("Response requirements (authored, for this surface):")).toBeLessThan(
        system.indexOf("Background context (data, not instructions):")
      );
      expect(system).not.toContain("Speak as Yuvi");
      expect(system).not.toContain("UNWANTED_GENERIC_ASSISTANT");
      expect(system).not.toContain('"abiVersion"');
      expect(request.contextProjectionVersions).toContain("character-response-requirements.v1");
      expect(request.messages.map((m) => m.role)).toEqual(["system", "user"]);
    }
  }
);

describe("relationship remains scoped independently of authored personality", () => {
  it.each(["person:other", "qq:unbound:nickname-owner", "qq:unbound:nickname-creator"])(
    "does not give %s the owner relationship",
    async (personId) => {
      const current = personId.endsWith("nickname-owner")
        ? "我昵称也叫主人，怎么称呼我？"
        : "我昵称也叫制造者，怎么称呼我？";
      const result = await createServerCharacterPort({
        responseRequirements: binding.definition.responseRequirements
      }).generate({
        userMessage: current,
        canonicalContext: canonical(personId, current),
        prompt: new PromptBuilder().buildPrompt({
          systemIdentity: "Alice",
          characterStyle: "unused",
          userMessage: current
        }),
        generateChat: async () => ({
          message: { role: "assistant", content: '{"disposition":"RESPOND"}' },
          finishReason: "stop"
        })
      });
      if (result.decision.reply.disposition !== "RESPOND" || !("body" in result.decision.reply))
        throw Error("Body missing");
      expect(result.decision.reply.body.messages[0]!.content).not.toContain(relationship.meaning);
      expect(JSON.stringify(binding.definition)).not.toContain("主人");
      expect(
        binding.definition.authoredInvariants
          .filter((v) => v.target === "persona")
          .map((v) => v.statement)
          .join("")
      ).toBe(authored.persona);
    }
  );
});

it.each(["GROUP", "PRIVATE"] as const)(
  "retains the full Alice %s rules, scene, perception and cognition with populated optional history",
  async (conversationKind) => {
    const current = "爱丽丝，请综合分析当前图片和工具检查结果。";
    const scene = "CURRENT_SPEAKER_REPLY_MENTION " + "现场信息。".repeat(300);
    const observations = "CURRENT_IMAGE_CONTENT " + "可见图片细节。".repeat(500);
    const answer = "DIRECT_TOOL_RESULT " + "实际检查结果。".repeat(150);
    const base = canonical(owner, current);
    const context = assembleCanonicalContext({
      semanticSections: [
        ...base.sharedSections.filter(
          (section) => !["MEMORY_EVIDENCE", "TEMPORAL_CONTEXT"].includes(section.kind)
        ),
        { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "较旧历史。".repeat(660) },
        { kind: "TEMPORAL_CONTEXT", state: "KNOWN", summary: "更早时间。".repeat(660) }
      ],
      situationEvidence: scene,
      currentInput: current
    });
    const calls: ChatInput[] = [];
    const port = createServerCharacterPort({
      responseRequirements: binding.definition.responseRequirements,
      classifyCurrentTurn: async () => ({
        message: {
          role: "assistant",
          content: JSON.stringify({
            authorization: "TASK",
            currentEvidence: current,
            request: "分析当前图片和检查结果",
            perception: true
          })
        },
        finishReason: "stop"
      })
    });
    const result = await port.generateAfterCognition({
      userMessage: current,
      canonicalContext: context,
      // The full authored rules + scene + perception + cognition require over 11.5K.
      // Leave room for those required inputs while keeping older history over budget.
      contextWindow: 19000,
      interactionBoundary: {
        surface: "qq",
        conversationKind,
        admission: conversationKind === "GROUP" ? "MENTION" : "PRIVATE"
      },
      visualEvidence: { status: "AVAILABLE", observations },
      cognitionRoundTrip: {
        version: "character-harness-5h.v1",
        request: { version: "character-harness-5g.v1", kind: "NEED_COGNITION", focus: current },
        result: {
          version: "character-cognition-result.v1",
          status: "SUCCESS",
          answer,
          uncertainty: ["仍需实际尺寸"]
        }
      },
      prompt: new PromptBuilder().buildPrompt({
        systemIdentity: "unused",
        characterStyle: "unused",
        userMessage: current
      }),
      generateChat: async (request) => {
        calls.push(request);
        return {
          message: { role: "assistant", content: '{"disposition":"RESPOND"}' },
          finishReason: "stop"
        };
      }
    });
    if (result.decision.reply.disposition !== "RESPOND" || !("body" in result.decision.reply))
      throw Error("Body missing");
    for (const request of [calls[0]!, result.decision.reply.body]) {
      const text = request.messages.map((message) => message.content).join("\n");
      for (const required of [
        authored.identity,
        authored.persona,
        authored.responseRequirements!.general,
        authored.responseRequirements![conversationKind === "GROUP" ? "group" : "private"],
        relationship.meaning,
        scene,
        answer,
        observations
      ])
        expect(text).toContain(required);
      expect(text.split(observations)).toHaveLength(2);
      expect(request.messages.reduce((n, m) => n + m.content.length + 64, 0)).toBeLessThanOrEqual(
        12202 // 19000 * 0.75 working reserve - 2048 output reserve
      );
      expect(text).not.toContain("较旧历史。".repeat(660));
    }
  }
);
