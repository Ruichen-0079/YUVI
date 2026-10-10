import { describe, expect, it } from "vitest";
import { PromptBuilder } from "./index.js";

describe("PromptBuilder", () => {
  it("does not exceed configured character budget", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      characterStyle: "Warm and concise.",
      relationshipContext: "Helpful collaborator.",
      retrievedMemories: Array.from({ length: 20 }, (_, index) => ({
        content: `Important memory ${index}: ${"details ".repeat(80)}`,
        importance: index / 20,
        lastAccessedAt: new Date(Date.now() - index * 1000)
      })),
      currentSituation: "Testing prompt budget.",
      tools: [{ name: "memory.search", description: "Retrieve memories" }],
      userMessage: "Hello",
      maxCharacters: 1600
    });

    expect(output.prompt.length).toBeLessThanOrEqual(1600);
    expect(output.prompt).toContain("<RelevantMemory>");
  });

  it("does not emit legacy CharacterStyle into provider-facing prompts", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are YUVI.",
      characterStyle:
        "Warm, concise, conversational, and practical. Prefer short replies of about 1-3 sentences.",
      relationshipContext: "Use only supplied relationship evidence.",
      userMessage: "Hello"
    });

    expect(output.sections.map((section) => section.name)).not.toContain("CharacterStyle");
    expect(output.prompt).not.toContain("Warm, concise, conversational, and practical");
    expect(output.messages[0]?.content).not.toContain(
      "Warm, concise, conversational, and practical"
    );
  });

  it("includes current time context for temporal reasoning", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      retrievedMemories: [],
      currentTime: {
        isoTimestamp: "2026-05-22T10:00:00.000Z",
        timezone: "Asia/Shanghai",
        localDate: "2026-05-22"
      },
      userMessage: "What is current?"
    });

    expect(output.prompt).toContain("<CurrentTime>");
    expect(output.prompt).toContain("2026-05-22T10:00:00.000Z");
    expect(output.sections.some((section) => section.name === "CurrentTime")).toBe(true);
  });

  it("builds assistant-initiated prompts without a synthetic user message", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      turnOrigin: "assistant-initiated",
      proactiveInstruction: "Generate one natural assistant-initiated message.",
      directContext: "- Previous assistant-initiated message: Assistant: Earlier context.",
      retrievedMemories: [],
      currentSituation: "The assistant is initiating a message.",
      tools: []
    });

    expect(output.messages).toHaveLength(1);
    expect(output.messages[0]?.role).toBe("system");
    expect(output.sections.map((section) => section.name)).toContain("ProactiveInstruction");
    expect(output.sections.map((section) => section.name)).not.toContain("UserMessage");
    expect(output.prompt).toContain("Generate one natural assistant-initiated message.");
    expect(output.prompt).not.toContain("<UserMessage>");
  });

  it("keeps proactive prompts stable-first and removes non-semantic sections", () => {
    const build = (isoTimestamp: string) =>
      new PromptBuilder().buildPrompt({
        systemIdentity: "You are Companion.",
        characterStyle: "Warm and concise.",
        relationshipContext: "Use remembered context only when relevant.",
        currentTime: {
          isoTimestamp,
          timezone: "Asia/Shanghai",
          localDate: "2026-08-26"
        },
        currentAffect: "User appears focused.",
        directContext: "- Previous turn: The reading order is still unresolved.",
        retrievedMemories: ["The user is planning a reading project."],
        currentSituation: "The assistant is initiating a proactive message.",
        tools: [{ name: "memory.search", available: false }],
        turnOrigin: "assistant-initiated",
        proactiveInstruction: "Choose NO_OP or REQUEST_TEXT."
      });

    const first = build("2026-08-26T10:00:00.000Z");
    const second = build("2026-08-26T10:00:01.000Z");

    expect(first.sections.map((section) => section.name)).toEqual([
      "SystemIdentity",
      "ProactiveInstruction",
      "RelationshipContext",
      "DirectContext",
      "RelevantMemory"
    ]);
    expect(
      first.sections.filter((section) => section.stable).map((section) => section.name)
    ).toEqual(["SystemIdentity", "ProactiveInstruction", "RelationshipContext"]);
    expect(first.sections.slice(0, 3).map((section) => section.content)).toEqual(
      second.sections.slice(0, 3).map((section) => section.content)
    );
    expect(first.prompt).toContain("The reading order is still unresolved.");
    expect(first.prompt).toContain("The user is planning a reading project.");
    expect(first.prompt).not.toContain("<CharacterStyle>");
    expect(first.prompt).not.toContain("<CurrentTime>");
    expect(first.prompt).not.toContain("<CurrentAffect>");
    expect(first.prompt).not.toContain("<RecentEpisodicMemory>");
    expect(first.prompt).not.toContain("<CurrentSituation>");
    expect(first.prompt).not.toContain("<Tools>");
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]?.role).toBe("system");
  });

  it("preserves normal user-turn section order and message serialization", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      relationshipContext: "Use remembered context only when relevant.",
      currentTime: { isoTimestamp: "2026-08-26T10:00:00.000Z" },
      currentSituation: "The user is interacting with the companion runtime.",
      tools: [],
      userMessage: "Continue the topic."
    });

    expect(output.sections.map((section) => section.name)).toEqual([
      "SystemIdentity",
      "RelationshipContext",
      "CurrentTime",
      "DirectContext",
      "RecentEpisodicMemory",
      "RelevantMemory",
      "CurrentSituation",
      "Tools",
      "UserMessage"
    ]);
    expect(output.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(output.messages[1]?.content).toContain("Continue the topic.");
    expect(output.prompt).not.toContain("<CharacterStyle>");
    expect(output.prompt).not.toContain("<ProactiveInstruction>");
  });

  it("keeps DirectContext separate from RelevantMemory", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      directContext: "- Previous turn: User confirmed Candidate Review v1 is complete.",
      retrievedMemories: [
        {
          content: "用户偏好 Chat/Reasoning 使用 DeepSeek。",
          scope: "project",
          scopeId: "yuvi-runtime",
          memoryLayer: "core",
          status: "active"
        }
      ],
      userMessage: "Continue."
    });

    const directContext = output.sections.find((section) => section.name === "DirectContext");
    const relevantMemory = output.sections.find((section) => section.name === "RelevantMemory");

    expect(directContext?.content).toContain("Candidate Review v1");
    expect(directContext?.content).not.toContain("DeepSeek");
    expect(relevantMemory?.content).toContain("DeepSeek");
    expect(relevantMemory?.content).not.toContain("Candidate Review v1");
    expect(output.prompt.indexOf("<CurrentTime>")).toBeLessThan(
      output.prompt.indexOf("<DirectContext>")
    );
    expect(output.prompt.indexOf("<DirectContext>")).toBeLessThan(
      output.prompt.indexOf("<RecentEpisodicMemory>")
    );
    expect(output.prompt.indexOf("<RecentEpisodicMemory>")).toBeLessThan(
      output.prompt.indexOf("<RelevantMemory>")
    );
  });

  it("renders memory text that already has list markers as single bullets", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      retrievedMemories: [
        "- 用户正在开发 YUVI Runtime。",
        "* 用户偏好 DeepSeek。",
        "- - 用户使用 WSL2。",
        "1. 用户需要 Dashboard。",
        "> 用户正在调试记忆。"
      ],
      userMessage: "YUVI Runtime 是什么项目？"
    });

    const relevantMemory = output.sections.find((section) => section.name === "RelevantMemory");
    expect(relevantMemory?.content).toContain("- 用户正在开发 YUVI Runtime。");
    expect(relevantMemory?.content).toContain("- 用户偏好 DeepSeek。");
    expect(relevantMemory?.content).toContain("- 用户使用 WSL2。");
    expect(relevantMemory?.content).toContain("- 用户需要 Dashboard。");
    expect(relevantMemory?.content).toContain("- 用户正在调试记忆。");
    expect(relevantMemory?.content).not.toContain("- - 用户");
    expect(output.prompt).not.toContain("- - 用户");
  });

  it("renders concise scope, layer, status, and temporal hints for retrieved memories", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      retrievedMemories: [
        {
          content: "用户偏好 Chat/Reasoning 使用 DeepSeek。",
          scope: "project",
          scopeId: "yuvi-runtime",
          memoryLayer: "core",
          status: "active",
          validUntil: "2026-12-31T00:00:00.000Z",
          importance: 0.9
        }
      ],
      userMessage: "YUVI provider preference?"
    });

    const relevantMemory = output.sections.find((section) => section.name === "RelevantMemory");
    expect(relevantMemory?.content).toContain(
      "- [project:yuvi-runtime][core][active][validUntil:2026-12-31] 用户偏好 Chat/Reasoning 使用 DeepSeek。"
    );
  });

  it("renders absolute event hints for time-bound episodic memories", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      retrievedMemories: [
        {
          content: "用户吃了芒果蛋糕。",
          type: "episodic",
          subtype: "event",
          memoryLayer: "recall",
          status: "active",
          eventTime: "2026-05-23T08:00:00.000Z",
          importance: 0.5
        }
      ],
      userMessage: "我之前吃了什么？"
    });

    const relevantMemory = output.sections.find((section) => section.name === "RelevantMemory");
    expect(relevantMemory?.content).toContain(
      "- [2026-05-23 morning][episodic][recall][active] 用户吃了芒果蛋糕。"
    );
    expect(relevantMemory?.content).not.toContain("今早");
  });

  it("keeps L0 DirectContext, L1 recent episodes, and L2 relevant memory distinct", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      currentTime: {
        isoTimestamp: "2026-08-31T10:00:00.000Z",
        timezone: "Asia/Shanghai",
        localDate: "2026-08-31",
        elapsedSinceLastInteraction: "16 hours",
        lastInteractionAgeBand: "yesterday"
      },
      directContext: "- Previous turn: User: 刚才那个端口还是 6121 吗",
      recentEpisodicMemory:
        "- [L1][2026-08-30 15:00] User said: 下午把训练脚本改到 6121 端口。 Task state: 训练 6121.",
      retrievedMemories: [
        {
          content: "用户偏好本地 Character 模型。",
          associated: true,
          ageBand: "this-week",
          importance: 0.8
        }
      ],
      userMessage: "昨天那个训练怎么样了？"
    });

    expect(output.prompt).toContain("<RecentEpisodicMemory>");
    expect(output.prompt).toContain("训练脚本改到 6121");
    expect(output.prompt).toContain("Elapsed since last interaction: 16 hours [yesterday]");
    expect(output.prompt).toContain("[associated][this-week]");
    expect(output.sections.map((section) => section.name)).toContain("RecentEpisodicMemory");
  });
});
