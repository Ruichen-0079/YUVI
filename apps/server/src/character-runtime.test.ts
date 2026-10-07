import { PromptBuilder, assembleCanonicalContext } from "@companion/prompt-builder";
import type { ChatInput, ChatOutput } from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import { createServerCharacterPort } from "./character-runtime.js";

const prompt = new PromptBuilder().buildPrompt({
  systemIdentity: "YUVI",
  characterStyle: "Warm and precise.",
  userMessage: "How should I verify this?"
});

function output(content: string, finishReason: ChatOutput["finishReason"] = "stop"): ChatOutput {
  return {
    message: { role: "assistant", content },
    finishReason,
    model: "private-chat-model",
    debug: { rawResponse: { reasoning_content: "must never cross the boundary" } }
  };
}

function roundTrip(status: "SUCCESS" | "UNAVAILABLE" = "SUCCESS") {
  return {
    version: "character-harness-5h.v1",
    request: {
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "verification"
    },
    result:
      status === "SUCCESS"
        ? {
            version: "character-cognition-result.v1",
            status,
            answer: "The normalized answer.",
            uncertainty: ["The source may have changed."],
            caveats: ["Verify the current source before acting."]
          }
        : {
            version: "character-cognition-result.v1",
            status
          }
  };
}

function characterHarness(overrides: { responses: ChatOutput[] }) {
  const generateChat = vi.fn(async (_input: ChatInput): Promise<ChatOutput> => {
    const next = overrides.responses.shift();
    if (!next) {
      throw new Error("unexpected Character call");
    }
    return next;
  });
  return { generateChat };
}

describe("production Character runtime adapter", () => {
  it("serializes the shared canonical P8 and Memory projection with current input", async () => {
    const canonicalContext = assembleCanonicalContext({
      semanticSections: [
        { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "A retrieved claim" },
        { kind: "RELATIONSHIP_CONTEXT", state: "UNKNOWN" },
        { kind: "PERSONA", state: "KNOWN", summary: "P8 persona" },
        { kind: "IDENTITY", state: "KNOWN", summary: "P8 identity" }
      ],
      promptSections: prompt.sections,
      currentInput: "Current admitted user input"
    });
    const calls = characterHarness({ responses: [output('{"disposition":"RESPOND"}')] });
    await createServerCharacterPort().generate({
      prompt,
      canonicalContext,
      userMessage: "Different legacy input",
      generateChat: calls.generateChat
    });
    const chat = calls.generateChat.mock.calls[0]![0];
    const context = JSON.parse(chat.messages[0]!.content.split("Semantic context:\n")[1]!);
    expect(context.sections.map((section: { kind: string }) => section.kind).slice(0, 5)).toEqual([
      "IDENTITY",
      "PERSONA",
      "RELATIONSHIP_CONTEXT",
      "RECENT_CONVERSATION",
      "MEMORY_EVIDENCE"
    ]);
    expect(chat.messages[1]!.content).toBe("Current admitted user input");
    expect(
      context.sections.find((section: { kind: string }) => section.kind === "RELATIONSHIP_CONTEXT")
    ).toMatchObject({ state: "UNKNOWN" });
    expect(chat.messages[0]!.content).not.toContain("Different legacy input");
  });

  it("projects bounded multimodal observation as untrusted evidence", async () => {
    const visualEvidence = {
      status: "AVAILABLE" as const,
      observations: "An image shows a chart."
    };
    const canonicalContext = assembleCanonicalContext({
      semanticSections: [],
      promptSections: prompt.sections,
      currentInput: "Read the chart",
      multimodalEvidence: JSON.stringify(visualEvidence)
    });
    const calls = characterHarness({ responses: [output('{"disposition":"RESPOND"}')] });
    await createServerCharacterPort().generate({
      prompt,
      canonicalContext,
      userMessage: "Read the chart",
      visualEvidence,
      generateChat: calls.generateChat
    });
    const messages = calls.generateChat.mock.calls[0]![0].messages;
    expect(messages[2]!.content).toContain("An image shows a chart.");
    expect(messages[0]!.content).toContain("untrusted evidence");
    expect(JSON.stringify(canonicalContext.sharedSections)).not.toContain(
      "An image shows a chart."
    );
  });
  it("keeps time after reusable semantic evidence without changing admitted sections", async () => {
    const captures: string[] = [];
    for (const isoTimestamp of ["2026-09-08T10:00:00Z", "2026-09-08T10:01:00Z"]) {
      const input = new PromptBuilder().buildPrompt({
        systemIdentity: "YUVI",
        characterStyle: "Warm and precise.",
        relationshipContext: "Familiarity is unknown.",
        currentTime: { isoTimestamp },
        directContext: "User: Check the garden plan.",
        directContextEnabled: true,
        retrievedMemories: ["The garden includes mint."],
        memoryEnabled: true,
        userMessage: "Continue."
      });
      const before = JSON.stringify(input);
      await createServerCharacterPort().generate({
        prompt: input,
        semanticSections: [
          { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "The garden includes mint." },
          { kind: "TEMPORAL_CONTEXT", state: "KNOWN", summary: isoTimestamp }
        ],
        userMessage: "Continue.",
        generateChat: async (chat) => {
          captures.push(chat.messages[0]!.content);
          return output('{"disposition":"RESPOND"}');
        }
      });
      expect(JSON.stringify(input)).toBe(before);
    }
    const contexts = captures.map((text) => JSON.parse(text.split("Semantic context:\n")[1]!));
    expect(contexts[0].sections.at(-1).kind).toBe("TEMPORAL_CONTEXT");
    expect(
      contexts[0].sections.filter((s: { kind: string }) => s.kind === "TEMPORAL_CONTEXT")
    ).toHaveLength(1);
    expect(contexts[0].sections.slice(0, -1)).toEqual(contexts[1].sections.slice(0, -1));
    expect(captures[0]!.split('"kind":"TEMPORAL_CONTEXT"')[0]).toBe(
      captures[1]!.split('"kind":"TEMPORAL_CONTEXT"')[0]
    );
    expect(captures[0]).toContain("The garden includes mint.");
    expect(captures[1]).toContain("2026-09-08T10:01:00Z");
  });

  it("returns a body request with orthogonal control for an accepted RESPOND gate", async () => {
    const calls = characterHarness({
      responses: [output('{"disposition":"RESPOND"}')]
    });

    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Is this directed to YUVI?",
      generateChat: calls.generateChat
    });

    expect(result.decision).toEqual({
      addressing: "DIRECTED_TO_YUVI",
      reply: { disposition: "RESPOND", body: expect.any(Object) },
      proactive: { action: "KEEP" }
    });
    expect(result.providerMetadata.model).toBe("private-chat-model");
    expect(result.cognitionHandoff).toBeUndefined();
    expect(calls.generateChat).toHaveBeenCalledTimes(1);
    const system = calls.generateChat.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(system).toContain("Output-language preference: AUTO");
    expect(system).toContain("follow the current interaction context naturally");
  });

  it.each([
    ["EN", "English"],
    ["ZH", "Chinese"],
    ["JA", "Japanese"]
  ] as const)(
    "admits explicit %s as the final %s Character expression language",
    async (language, name) => {
      const calls = characterHarness({
        responses: [output('{"disposition":"RESPOND"}')]
      });

      await createServerCharacterPort().generate({
        prompt,
        userMessage: "Use the selected language.",
        outputLanguage: language,
        generateChat: calls.generateChat
      });

      const system = calls.generateChat.mock.calls[0]?.[0].messages[0]?.content ?? "";
      expect(system).toContain(`Output-language preference: ${language}`);
      expect(system).toContain(`final Character expression must be in ${name}`);
      expect(system).toContain(`"outputLanguage":"${language}"`);
    }
  );

  it.each(["SILENCE", "TERMINATE"] as const)(
    "represents %s as a first-class decision instead of empty text",
    async (disposition) => {
      const calls = characterHarness({
        responses: [output(`{"disposition":"${disposition}"}`)]
      });

      const result = await createServerCharacterPort().generate({
        prompt,
        userMessage: "Directed input.",
        generateChat: calls.generateChat
      });

      expect(result.decision).toEqual({
        addressing: "DIRECTED_TO_YUVI",
        reply: { disposition },
        proactive: { action: "KEEP" }
      });
    }
  );

  it("hands the Cognition escalation to Runtime without executing it", async () => {
    const calls = characterHarness({
      responses: [output('{"disposition":"NEED_COGNITION","focus":"verification"}')]
    });

    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Verify this claim carefully.",
      generateChat: calls.generateChat
    });

    expect(result.decision.reply).toEqual({
      disposition: "NEED_COGNITION",
      focus: "verification"
    });
    expect(result.cognitionHandoff).toBeDefined();
    expect(result.cognitionHandoff?.request).toMatchObject({
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "verification"
    });
    expect(result.cognitionHandoff?.problem).toContain("verification");
    expect(result.cognitionHandoff?.problem).toContain("Verify this claim carefully.");
    // One Chat call only: the adapter never executes Cognition itself.
    expect(calls.generateChat).toHaveBeenCalledTimes(1);
  });

  it("re-enters Character with the completed Cognition round-trip and keeps it opaque", async () => {
    const calls = characterHarness({
      responses: [output('{"disposition":"RESPOND"}')]
    });

    const result = await createServerCharacterPort().generateAfterCognition({
      prompt,
      userMessage: "Verify this claim carefully.",
      outputLanguage: "EN",
      cognitionRoundTrip: roundTrip(),
      generateChat: calls.generateChat
    });

    expect(result.decision).toEqual({
      addressing: "DIRECTED_TO_YUVI",
      reply: { disposition: "RESPOND", body: expect.any(Object) },
      proactive: { action: "KEEP" }
    });
    const system = calls.generateChat.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(system).toContain("The normalized answer.");
    expect(system).toContain("COGNITION_RESULT");
    expect(system).toContain("Output-language preference: EN");
    expect(system).toContain('"outputLanguage":"EN"');
    expect(system).not.toContain("reasoning_content");
  });

  it("returns a repeated NEED_COGNITION faithfully and lets Runtime fail the turn", async () => {
    const calls = characterHarness({
      responses: [output('{"disposition":"NEED_COGNITION"}')]
    });

    const result = await createServerCharacterPort().generateAfterCognition({
      prompt,
      userMessage: "Do not recurse.",
      cognitionRoundTrip: roundTrip(),
      generateChat: calls.generateChat
    });

    expect(result.decision.reply).toEqual({ disposition: "NEED_COGNITION" });
    expect(calls.generateChat).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the Cognition result exceeds the Character context budget", async () => {
    const oversizedRoundTrip = {
      ...roundTrip(),
      result: {
        version: "character-cognition-result.v1",
        status: "SUCCESS",
        // Valid at the 5H Cognition boundary (16k cap) yet larger than the
        // 5K post-Cognition Character context budget (12k semantic chars).
        answer: "x".repeat(13_000)
      }
    };
    const calls = characterHarness({ responses: [] });

    await expect(
      createServerCharacterPort().generateAfterCognition({
        prompt,
        userMessage: "Over budget.",
        cognitionRoundTrip: oversizedRoundTrip,
        generateChat: calls.generateChat
      })
    ).rejects.toThrow("exceeded the Character context budget");
    expect(calls.generateChat).not.toHaveBeenCalled();
  });

  it("keeps cancellation bounded before Character execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = characterHarness({
      responses: [output('{"disposition":"RESPOND"}')]
    });

    await expect(
      createServerCharacterPort().generate({
        prompt,
        userMessage: "Cancelled.",
        signal: controller.signal,
        generateChat: calls.generateChat
      })
    ).rejects.toThrow("cancelled");
    expect(calls.generateChat).not.toHaveBeenCalled();
  });

  it("keeps cancellation bounded before Character re-entry execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = characterHarness({
      responses: [output('{"disposition":"RESPOND"}')]
    });

    await expect(
      createServerCharacterPort().generateAfterCognition({
        prompt,
        userMessage: "Cancelled.",
        cognitionRoundTrip: roundTrip(),
        signal: controller.signal,
        generateChat: calls.generateChat
      })
    ).rejects.toThrow("cancelled");
    expect(calls.generateChat).not.toHaveBeenCalled();
  });
});

describe("semantic current-screen grounding", () => {
  it("consumes pre-resolved user-image evidence without requesting a second visual cycle", async () => {
    const calls = characterHarness({
      responses: [output('{"disposition":"RESPOND"}')]
    });
    const requestVisualEvidence = vi.fn(async () => ({
      status: "AVAILABLE" as const,
      observations: "must not run"
    }));

    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "What does this screenshot show?",
      visualEvidence: {
        status: "AVAILABLE",
        observations: "Permission denied in the settings dialog."
      },
      generateChat: calls.generateChat,
      requestVisualEvidence
    });

    expect(requestVisualEvidence).not.toHaveBeenCalled();
    expect(calls.generateChat).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls.generateChat.mock.calls[0])).toContain(
      "Permission denied in the settings dialog."
    );
    expect(JSON.stringify(calls.generateChat.mock.calls[0])).toContain("untrusted evidence");
    expect(result.decision.reply).toMatchObject({
      disposition: "RESPOND",
      body: expect.any(Object)
    });
  });

  it("lets Character select an exact observed image source and exposes its evidence in the next rendered model request", async () => {
    const calls = characterHarness({
      responses: [
        output('{"visualNeed":"Read the diagram uploaded by B","sourceReference":"image:b"}'),
        output('{"disposition":"RESPOND"}')
      ]
    });
    const sourceJournalRef = {
      kind: "JOURNAL_EVENT" as const,
      namespace: "test",
      eventId: "jev1_0000000000000001"
    };
    const requestVisualEvidence = vi.fn(async () => ({
      status: "AVAILABLE" as const,
      observations: "The selected image contains VISION_B_42.",
      sourceJournalRef
    }));
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "What is B's diagram?",
      visualSources: [{ reference: "image:b", sourceJournalRef }],
      requestVisualEvidence,
      generateChat: calls.generateChat
    });
    expect(requestVisualEvidence).toHaveBeenCalledWith({
      need: "Read the diagram uploaded by B",
      sourceReference: "image:b"
    });
    expect(JSON.stringify(calls.generateChat.mock.calls[0]?.[0])).toContain(
      "Available image sources"
    );
    expect(JSON.stringify(calls.generateChat.mock.calls[1]?.[0])).toContain("VISION_B_42");
    expect(JSON.stringify(calls.generateChat.mock.calls[1]?.[0])).toContain(
      sourceJournalRef.eventId
    );
    expect(result.decision.reply.disposition).toBe("RESPOND");
    expect(JSON.stringify(result.decision.reply)).toContain("VISION_B_42");
    expect(JSON.stringify(result.decision.reply)).toContain("image:b");
    expect(JSON.stringify(result.decision.reply)).toContain(sourceJournalRef.eventId);
  });
  it("reserves late-added visual evidence in the rendered request budget while preserving current scene and authored identity", async () => {
    const canonicalContext = assembleCanonicalContext({
      semanticSections: [
        { kind: "IDENTITY", state: "KNOWN", summary: "BOUND_IDENTITY" },
        { kind: "PERSONA", state: "KNOWN", summary: "AUTHORED_PERSONA" },
        { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "old memory ".repeat(340) },
        { kind: "CURRENT_SITUATION", state: "KNOWN", summary: "CURRENT_GROUP_ACTOR_REPLY" }
      ],
      currentInput: "Read the image"
    });
    const calls = characterHarness({
      responses: [
        output('{"visualNeed":"Read it","sourceReference":"image:a"}'),
        output('{"disposition":"RESPOND"}')
      ]
    });
    const result = await createServerCharacterPort().generate({
      prompt,
      canonicalContext,
      userMessage: "Read the image",
      visualSources: [
        {
          reference: "image:a",
          sourceJournalRef: {
            kind: "JOURNAL_EVENT",
            namespace: "test",
            eventId: "jev1_0000000000000001"
          }
        }
      ],
      requestVisualEvidence: async () => ({
        status: "AVAILABLE",
        observations: "VISUAL_REQUIRED_42 " + 'visible "text"\\n'.repeat(240)
      }),
      generateChat: calls.generateChat
    });
    expect(calls.generateChat).toHaveBeenCalledTimes(2);
    for (const request of calls.generateChat.mock.calls.map((call) => call[0])) {
      expect(
        request.messages.reduce((sum, message) => sum + message.content.length + 64, 0)
      ).toBeLessThanOrEqual(10240);
      expect(JSON.stringify(request)).toContain("CURRENT_GROUP_ACTOR_REPLY");
      expect(JSON.stringify(request)).toContain("BOUND_IDENTITY");
      expect(JSON.stringify(request)).toContain("AUTHORED_PERSONA");
    }
    expect(JSON.stringify(result.decision.reply)).toContain("VISUAL_REQUIRED_42");
    expect(JSON.stringify(result.decision.reply)).toContain("CURRENT_GROUP_ACTOR_REPLY");
  });

  it("fits complete perception with a populated private scene and existing history, without dropping either", async () => {
    const scene =
      "CURRENT_PRIVATE_SPEAKER_REPLY_AND_IMAGE_SOURCE\n" +
      'Observed event: speaker said "earlier words".\n'.repeat(60);
    const observations = 'VISIBLE_POSTER "visible text"\n'.repeat(145).slice(0, 4000);
    const visualEvidence = { status: "AVAILABLE" as const, observations };
    const canonicalContext = assembleCanonicalContext({
      semanticSections: [
        { kind: "IDENTITY", state: "KNOWN", summary: "Alice" },
        { kind: "PERSONA", state: "KNOWN", summary: "AUTHORED_PERSONA" },
        {
          kind: "RECENT_CONVERSATION",
          state: "KNOWN",
          summary: "Earlier assistant wrongly said it could not see images.\n".repeat(24)
        },
        { kind: "MEMORY_EVIDENCE", state: "KNOWN", summary: "Old recalled episode.\n".repeat(40) },
        { kind: "CURRENT_SITUATION", state: "KNOWN", summary: scene },
        { kind: "TEMPORAL_CONTEXT", state: "KNOWN", summary: "Earlier timestamp.\n".repeat(27) }
      ],
      currentInput: "图片里有什么",
      multimodalEvidence: JSON.stringify(visualEvidence)
    });
    const calls = characterHarness({ responses: [output('{"disposition":"RESPOND"}')] });
    const result = await createServerCharacterPort()
      .generate({
        prompt,
        canonicalContext,
        userMessage: "图片里有什么",
        visualEvidence,
        generateChat: calls.generateChat
      })
      .catch((error: Error) => {
        throw new Error(error.message);
      });
    expect(calls.generateChat).toHaveBeenCalledOnce();
    const gate = calls.generateChat.mock.calls[0]![0];
    expect(gate.messages.reduce((n, m) => n + m.content.length + 64, 0)).toBeLessThanOrEqual(10240);
    expect(gate.messages.some((m) => m.content.includes(observations))).toBe(true);
    expect(gate.messages[0]!.content).toContain(JSON.stringify(scene).slice(1, -1));
    expect(gate.messages[0]!.content).toContain("AUTHORED_PERSONA");
    expect(JSON.stringify(result.decision.reply)).toContain("VISIBLE_POSTER");
  });

  it("reserves complete cognition, current addressing and perception before admitting populated history", async () => {
    const scene =
      "Current speaker B; reply to A; mention Alice; attachment source image:b.\n" +
      "Current scene. ".repeat(125);
    const answer = "DIRECT_TOOL_OBSERVATION_42 " + "supported result. ".repeat(125);
    const observations = "CURRENT_ATTACHMENT_CONTENT_42 " + "Visible contents. ".repeat(110);
    const canonicalContext = assembleCanonicalContext({
      semanticSections: [
        { kind: "IDENTITY", state: "KNOWN", summary: "Alice" },
        { kind: "PERSONA", state: "KNOWN", summary: "AUTHORED_PERSONA" },
        {
          kind: "RECENT_CONVERSATION",
          state: "KNOWN",
          summary: "Assistant wrongly said it could not see images.\n".repeat(70)
        },
        {
          kind: "MEMORY_EVIDENCE",
          state: "KNOWN",
          summary: "Older recalled episode.\n".repeat(110)
        },
        { kind: "TEMPORAL_CONTEXT", state: "KNOWN", summary: "Older timestamp.\n".repeat(70) },
        { kind: "CURRENT_SITUATION", state: "KNOWN", summary: scene }
      ],
      currentInput: "What does the current attachment show?"
    });
    const cognitionRoundTrip = { ...roundTrip(), result: { ...roundTrip().result, answer } };
    const calls = characterHarness({ responses: [output('{"disposition":"RESPOND"}')] });
    const result = await createServerCharacterPort().generateAfterCognition({
      prompt,
      canonicalContext,
      userMessage: "Legacy input must not displace canonical input.",
      cognitionRoundTrip,
      visualEvidence: { status: "AVAILABLE", observations },
      generateChat: calls.generateChat
    });
    expect(calls.generateChat).toHaveBeenCalledOnce();
    expect(result.decision.reply.disposition).toBe("RESPOND");
    if (result.decision.reply.disposition !== "RESPOND" || !("body" in result.decision.reply))
      throw Error("Expected response body");
    for (const request of [calls.generateChat.mock.calls[0]![0], result.decision.reply.body]) {
      expect(request.messages.reduce((n, m) => n + m.content.length + 64, 0)).toBeLessThanOrEqual(
        10240
      );
      expect(request.messages[1]!.content).toBe(canonicalContext.currentInput);
      expect(request.messages.some((m) => m.content.includes(observations))).toBe(true);
      const context = JSON.parse(
        request.messages[0]!.content.split("Semantic context:\n")[1]!.split("\n")[0]!
      );
      expect(
        context.sections.find((s: { kind: string }) => s.kind === "CURRENT_SITUATION").summary
      ).toBe(
        scene +
          "\nImmediate affect: " +
          prompt.sections
            .filter((s) => s.name === "CurrentAffect")
            .map((s) => s.content)
            .join("\n")
      );
      expect(
        context.sections.find((s: { kind: string }) => s.kind === "COGNITION_RESULT").result
      ).toEqual(cognitionRoundTrip.result);
      expect(request.messages[0]!.content).toContain("AUTHORED_PERSONA");
      expect(request.messages[0]!.content).toContain("Past assistant text is fallible");
    }
  });

  it.each(["KNOWN", "CONFLICTING", "UNAVAILABLE"] as const)(
    "omits %s optional history and its unused provenance when the compressor floor cannot fit",
    async (state) => {
      const scene = "CURRENT_SPEAKER_REPLY_MENTION " + "scene ".repeat(475);
      const observations = "CURRENT_PERCEPTION " + "visual ".repeat(495);
      const canonicalContext = assembleCanonicalContext({
        semanticSections: [
          { kind: "IDENTITY", state: "KNOWN", summary: "Alice" },
          { kind: "PERSONA", state: "KNOWN", summary: "Authored persona" },
          {
            kind: "MEMORY_EVIDENCE",
            state,
            ...(state === "UNAVAILABLE" ? {} : { summary: "Older history." }),
            provenanceReferences: Array.from({ length: 32 }, (_, i) => String(i) + "x".repeat(195))
          },
          { kind: "CURRENT_SITUATION", state: "KNOWN", summary: scene }
        ],
        currentInput: "Read this image"
      });
      const calls = characterHarness({ responses: [output('{"disposition":"RESPOND"}')] });
      const result = await createServerCharacterPort().generate({
        prompt,
        canonicalContext,
        userMessage: "Read this image",
        visualEvidence: { status: "AVAILABLE", observations },
        generateChat: calls.generateChat
      });
      const gate = calls.generateChat.mock.calls[0]![0];
      const context = JSON.parse(
        gate.messages[0]!.content.split("Semantic context:\n")[1]!.split("\n")[0]!
      );
      expect(context.sections.find((s: { kind: string }) => s.kind === "MEMORY_EVIDENCE")).toEqual({
        kind: "MEMORY_EVIDENCE",
        state: state === "KNOWN" ? "PARTIAL" : state,
        ...(state === "UNAVAILABLE"
          ? {}
          : { summary: "[PARTIAL] Earlier context omitted by input budget." })
      });
      expect(
        context.sections.find((s: { kind: string }) => s.kind === "CURRENT_SITUATION").summary
      ).toBe(
        scene +
          "\nImmediate affect: " +
          prompt.sections
            .filter((s) => s.name === "CurrentAffect")
            .map((s) => s.content)
            .join("\n")
      );
      expect(gate.messages.some((m) => m.content.includes(observations))).toBe(true);
      expect(gate.messages.reduce((n, m) => n + m.content.length + 64, 0)).toBeLessThanOrEqual(
        10240
      );
      expect(JSON.stringify(result.decision.reply)).toContain("CURRENT_PERCEPTION");
    }
  );

  it("keeps a complete observation beyond 4000 characters in the final response request", async () => {
    const observations = "Visible text and uncertainty.\n".repeat(170) + "FINAL_VISIBLE_DETAIL";
    const calls = characterHarness({ responses: [output('{"disposition":"RESPOND"}')] });
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Read every visible detail",
      visualEvidence: { status: "AVAILABLE", observations },
      generateChat: calls.generateChat
    });
    expect(observations.length).toBeGreaterThan(4000);
    if (result.decision.reply.disposition !== "RESPOND" || !("body" in result.decision.reply))
      throw Error("Expected response body");
    for (const request of [calls.generateChat.mock.calls[0]![0], result.decision.reply.body]) {
      expect(request.messages.some((m) => m.content.includes(observations))).toBe(true);
      expect(request.messages.reduce((n, m) => n + m.content.length + 64, 0)).toBeLessThanOrEqual(
        10240
      );
    }
  });

  it("rejects only after required perception itself exceeds the budget, without truncating or calling Chat", async () => {
    const observations = "x".repeat(11000) + "REQUIRED_FINAL_DETAIL";
    const visualEvidence = Object.freeze({ status: "AVAILABLE" as const, observations });
    const calls = characterHarness({ responses: [] });
    await expect(
      createServerCharacterPort().generate({
        prompt,
        userMessage: "Read this",
        visualEvidence,
        generateChat: calls.generateChat
      })
    ).rejects.toThrow(/required=\d+, limit=10240/);
    expect(calls.generateChat).not.toHaveBeenCalled();
    expect(visualEvidence.observations).toBe(observations);
  });

  it("repairs a mixed perception/reasoning proposal before executing exactly one visual cycle", async () => {
    const calls = characterHarness({
      responses: [
        output(
          '{"disposition":"NEED_COGNITION","focus":"look","visualNeed":"Read it","sourceReference":"image:a"}'
        ),
        output('{"visualNeed":"Read it","sourceReference":"image:a"}'),
        output('{"disposition":"RESPOND"}')
      ]
    });
    const requestVisualEvidence = vi.fn(async () => ({
      status: "AVAILABLE" as const,
      observations: "PERCEPTION_42"
    }));
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Read the image",
      requestVisualEvidence,
      visualSources: [],
      generateChat: calls.generateChat
    });
    expect(requestVisualEvidence).toHaveBeenCalledOnce();
    expect(result.cognitionHandoff).toBeUndefined();
    expect(result.decision.reply.disposition).toBe("RESPOND");
    expect(calls.generateChat).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(calls.generateChat.mock.calls[1])).toContain("mutually exclusive");
  });

  it("carries newly acquired visual evidence in the Character-owned Cognition handoff", async () => {
    const calls = characterHarness({
      responses: [
        output('{"visualNeed":"Read the diagram","sourceReference":"image:a"}'),
        output('{"disposition":"NEED_COGNITION","focus":"Verify its calculation"}')
      ]
    });
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Verify the diagram",
      visualSources: [
        {
          reference: "image:a",
          sourceJournalRef: {
            kind: "JOURNAL_EVENT",
            namespace: "test",
            eventId: "jev1_0000000000000001"
          }
        }
      ],
      requestVisualEvidence: async () => ({
        status: "AVAILABLE",
        observations: "EVIDENCE_CALCULATION_42"
      }),
      generateChat: calls.generateChat
    });
    expect(result.cognitionHandoff?.problem).toContain("EVIDENCE_CALCULATION_42");
  });

  it("rejects a model-authored second visualNeed when attachment evidence is already present", async () => {
    const calls = characterHarness({
      responses: [output('{"visualNeed":"capture another image"}')]
    });
    const requestVisualEvidence = vi.fn(async () => ({
      status: "AVAILABLE" as const,
      observations: "must not run"
    }));

    await expect(
      createServerCharacterPort().generate({
        prompt,
        userMessage: "Inspect this",
        visualEvidence: {
          status: "UNAVAILABLE",
          observations: "Attached image analysis failed. Image contents are unknown."
        },
        generateChat: calls.generateChat,
        requestVisualEvidence
      })
    ).rejects.toThrow("Invalid or repeated visual grounding request");
    expect(requestVisualEvidence).not.toHaveBeenCalled();
  });

  it("requests evidence by need and resumes the same original user turn", async () => {
    const calls = characterHarness({
      responses: [
        output('{"visualNeed":"Read the visible error and relevant UI state"}'),
        output('{"disposition":"RESPOND"}')
      ]
    });
    const requestVisualEvidence = vi.fn(async () => ({
      status: "AVAILABLE" as const,
      observations: "Permission denied"
    }));
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "What is the error on my screen?",
      generateChat: calls.generateChat,
      requestVisualEvidence
    });
    expect(requestVisualEvidence).toHaveBeenCalledTimes(1);
    expect(requestVisualEvidence).toHaveBeenCalledWith({
      need: "Read the visible error and relevant UI state"
    });
    expect(result.decision.reply).toMatchObject({
      disposition: "RESPOND",
      body: expect.any(Object)
    });
    expect(calls.generateChat).toHaveBeenCalledTimes(2);
    const resumed = calls.generateChat.mock.calls[1]![0];
    expect(resumed.messages[1]?.content).toBe("What is the error on my screen?");
    expect(JSON.stringify(resumed)).toContain("Permission denied");
    expect(JSON.stringify(resumed)).toContain("untrusted evidence");
  });
  it("passes bounded evidence to the existing Cognition handoff", async () => {
    const calls = characterHarness({
      responses: [
        output('{"visualNeed":"Read the formula"}'),
        output('{"disposition":"NEED_COGNITION","focus":"Solve the visible formula"}')
      ]
    });
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Solve this",
      generateChat: calls.generateChat,
      requestVisualEvidence: async () => ({
        status: "AVAILABLE",
        observations: "x^2 = 4; the label is unreadable"
      })
    });
    expect(result.cognitionHandoff?.problem).toContain("x^2 = 4");
    expect(result.cognitionHandoff?.problem).toContain("unreadable");
  });
  it("does not ground ordinary chat and rejects recursive visual requests", async () => {
    const requestVisualEvidence = vi.fn(async () => ({
      status: "UNAVAILABLE" as const,
      observations: "Screen contents are unknown"
    }));
    const ordinary = characterHarness({
      responses: [output('{"disposition":"RESPOND"}')]
    });
    await createServerCharacterPort().generate({
      prompt,
      userMessage: "Hi",
      generateChat: ordinary.generateChat,
      requestVisualEvidence
    });
    expect(requestVisualEvidence).not.toHaveBeenCalled();
    const repeated = characterHarness({
      responses: [output('{"visualNeed":"Read screen"}'), output('{"visualNeed":"Again"}')]
    });
    await expect(
      createServerCharacterPort().generate({
        prompt,
        userMessage: "Look",
        generateChat: repeated.generateChat,
        requestVisualEvidence
      })
    ).rejects.toThrow("repeated");
    expect(requestVisualEvidence).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(repeated.generateChat.mock.calls[1])).toContain(
      "Screen contents are unknown"
    );
  });
});

const TASK_CONTINUATION_PROBE = "fulfill that request in this response";
const TASK_CONTINUATION_QUALIFIER = "when the work can be completed now";
const META_PROMISE_PATTERN =
  /i'll (start|begin|choose)|give me a moment|what topic|which (style|topic)/i;

function sentenceCount(text: string): number {
  return text.split(/[.!?]+/).filter((part) => part.trim().length > 0).length;
}

/**
 * Scripted instruction-following stand-in for the model: it fulfills only
 * when the contract carries both the task-continuation invariant and the
 * unresolved request itself. Otherwise it emits the exact meta-promise
 * failure mode the invariant exists to prevent, so these tests genuinely
 * distinguish fulfillment from announcement.
 */
function continuationModel(options: { requestMarker: string; fulfillment?: string }) {
  const systems: string[] = [];
  return {
    systems,
    generateChat: async (): Promise<ChatOutput> => output('{"disposition":"RESPOND"}'),
    streamReply: async function* (chat: ChatInput) {
      const system = chat.messages[0]?.content ?? "";
      systems.push(system);
      const follows =
        system.includes(TASK_CONTINUATION_PROBE) && system.includes(options.requestMarker);
      const text = follows ? (options.fulfillment ?? "") : "I'll start writing now.";
      yield { type: "text-delta" as const, text };
      yield { type: "completed" as const, output: output(text) };
    }
  };
}

const HARBOR_ARTICLE = [
  "The harbor festival begins at dawn, when fishing boats return with lanterns still burning at their sterns.",
  "Salt spray hangs over the pier as vendors roll up striped awnings and arrange the morning catch on crushed ice.",
  "Children press against the railings to watch crabs scramble in shallow tanks, shrieking whenever a claw snaps.",
  "By midday the brass band claims the bandstand, and tubas compete cheerfully with gulls for the town's attention.",
  "The lighthouse opens its narrow stair to visitors once a year, and the queue winds past the chandlery before nine.",
  "Old sailors tell believable lies about storms in the beer tent, while newcomers pretend they can tell which parts are true.",
  "Rope-makers demonstrate knots their grandfathers taught them, fingers moving faster than the eye wants to follow.",
  "At dusk the committee lights the bonfire on the shingle, and the whole beach smells of woodsmoke and fried dough.",
  "Fireworks rise over the breakwater at ten, paid for by the cannery, applauded by everyone including the cannery cat.",
  "Couples walk the sea wall with paper cups of cocoa, arguing gently about which burst was the finest of the night.",
  "When the tide turns after midnight, volunteers rake the sand clean, finding lost scarves, one shoe, and three kites.",
  "The festival ends as it began, with boats slipping out past the lighthouse, lanterns lit, heading for dark water."
].join(" ");

const HARBOR_ANNOUNCEMENT =
  "The harbor festival opens Saturday at dawn with the lantern flotilla. " +
  "The brass band plays the bandstand at noon, and fireworks close the night at ten. " +
  "All harbor residents are welcome; bring a lantern if you have one.";

describe("Character task-continuation invariant", () => {
  it("fulfills a delegated choice instead of announcing it (Case A)", async () => {
    const model = continuationModel({
      requestMarker: "500-word article",
      fulfillment: HARBOR_ARTICLE
    });
    const result = await createServerCharacterPort().generate({
      prompt,
      semanticSections: [
        {
          kind: "RECENT_CONVERSATION",
          state: "KNOWN",
          summary:
            "User asked for a roughly 500-word article. Assistant asked which topic and style. User replied: You choose."
        }
      ],
      userMessage: "You choose.",
      generateChat: model.generateChat
    });

    const reply = result.decision.reply;
    expect(reply.disposition).toBe("RESPOND");
    if (reply.disposition !== "RESPOND" || !("body" in reply))
      throw new Error("Missing streamed body");
    let text = "";
    for await (const event of model.streamReply(reply.body))
      if (event.type === "text-delta") text += event.text;
    expect(model.systems[0]).toContain(TASK_CONTINUATION_PROBE);
    expect(text.length).toBeGreaterThan(1000);
    expect(sentenceCount(text)).toBeGreaterThanOrEqual(10);
    expect(text).toContain("harbor");
    expect(text).not.toMatch(META_PROMISE_PATTERN);
  });

  it("performs an authorized pending deliverable on ok/start (Case B)", async () => {
    const model = continuationModel({
      requestMarker: "harbor festival announcement",
      fulfillment: HARBOR_ANNOUNCEMENT
    });
    const result = await createServerCharacterPort().generate({
      prompt,
      semanticSections: [
        {
          kind: "RECENT_CONVERSATION",
          state: "KNOWN",
          summary:
            "Assistant drafted a harbor festival announcement and asked for approval to post it. User has not approved yet."
        }
      ],
      userMessage: "start",
      generateChat: model.generateChat
    });

    const reply = result.decision.reply;
    expect(reply.disposition).toBe("RESPOND");
    if (reply.disposition !== "RESPOND" || !("body" in reply))
      throw new Error("Missing streamed body");
    let text = "";
    for await (const event of model.streamReply(reply.body))
      if (event.type === "text-delta") text += event.text;
    expect(model.systems[0]).toContain(TASK_CONTINUATION_PROBE);
    expect(text).toContain("harbor festival");
    expect(sentenceCount(text)).toBeGreaterThanOrEqual(3);
    expect(text).not.toMatch(META_PROMISE_PATTERN);
  });

  it("still permits a necessary clarification when information is genuinely missing (Case C)", async () => {
    const systems: string[] = [];
    const result = await createServerCharacterPort().generate({
      prompt,
      semanticSections: [
        {
          kind: "RECENT_CONVERSATION",
          state: "KNOWN",
          summary:
            "User mentioned a letter. No recipient, address, or delivery method was ever stated."
        }
      ],
      userMessage: "Send it to her.",
      generateChat: async (chat: ChatInput) => {
        systems.push(chat.messages[0]?.content ?? "");
        return output('{"disposition":"RESPOND"}');
      }
    });
    // The invariant must not force arbitrary guessing: its qualifier stays
    // in the contract so a model may ask instead of inventing an address.
    expect(systems[0]).toContain(TASK_CONTINUATION_QUALIFIER);
    expect(result.decision.reply).toMatchObject({
      disposition: "RESPOND",
      body: expect.any(Object)
    });
    const reply = result.decision.reply;
    if (reply.disposition !== "RESPOND" || !("body" in reply)) throw new Error("Missing body");
    expect(reply.body.messages[0]?.content).toContain(TASK_CONTINUATION_QUALIFIER);
    expect(reply.body.messages[1]?.content).toBe("Send it to her.");
  });

  it("exposes a meta-promise when recent conversation drops the unresolved request", async () => {
    const model = continuationModel({
      requestMarker: "500-word article",
      fulfillment: HARBOR_ARTICLE
    });
    const result = await createServerCharacterPort().generate({
      prompt,
      semanticSections: [{ kind: "TEMPORAL_CONTEXT", state: "UNAVAILABLE" }],
      userMessage: "You choose.",
      generateChat: model.generateChat
    });
    // Without the original request in context, even an invariant-following
    // model cannot fulfill: the failure surfaces as the recognizable
    // meta-promise instead of a silently accepted empty answer.
    const reply = result.decision.reply;
    if (reply.disposition !== "RESPOND" || !("body" in reply)) throw new Error("Missing body");
    const events = [];
    for await (const event of model.streamReply(reply.body)) events.push(event);
    expect(events[0]).toEqual({ type: "text-delta", text: "I'll start writing now." });
  });
});
