import { assembleCanonicalContext } from "./canonical-context.js";
export {
  assembleCanonicalContext,
  projectCanonicalSharedContext,
  projectCanonicalCognitionMessages,
  CANONICAL_SHARED_SECTION_ORDER,
  CANONICAL_CONTEXT_STABILITY_VERSION,
  CANONICAL_STABLE_SHARED_SECTION_ORDER,
  CANONICAL_VOLATILE_SHARED_SECTION_ORDER,
  CANONICAL_VOLATILE_EXECUTION_COMPONENTS
} from "./canonical-context.js";
export type {
  CanonicalContext,
  CanonicalContextStability,
  CanonicalStableComponent,
  CanonicalStablePrefix,
  CanonicalVolatileContext,
  CanonicalSharedKind,
  CanonicalSharedSection
} from "./canonical-context.js";

export type PromptSectionName =
  | "SystemIdentity"
  | "CharacterStyle"
  | "RelationshipContext"
  | "CurrentTime"
  | "CurrentAffect"
  | "DirectContext"
  | "RecentEpisodicMemory"
  | "RelevantMemory"
  | "CurrentSituation"
  | "Tools"
  | "ProactiveInstruction"
  | "UserMessage";

export type PromptSection = {
  name: PromptSectionName;
  content: string;
  priority: number;
  stable: boolean;
};

export type RetrievedMemoryForPrompt = {
  content: string;
  summary?: string | null;
  displayText?: string;
  importance?: number;
  scope?: string;
  scopeId?: string | null;
  type?: string;
  subtype?: string | null;
  memoryLayer?: string;
  status?: string;
  validFrom?: Date | string;
  eventTime?: Date | string | null;
  validUntil?: Date | string | null;
  expiresAt?: Date | string | null;
  createdAt?: Date | string;
  lastAccessedAt?: Date | string;
  tags?: string[];
  associated?: boolean;
  ageBand?: string;
  relevanceReason?: string;
};

export type ToolContext = {
  name: string;
  description?: string;
  available?: boolean;
};

type PromptBuildSharedInput = {
  systemIdentity: string;
  /** @deprecated Persona/style is P8-owned. Retained only as an input compatibility field. */
  characterStyle?: string;
  relationshipContext?: string;
  retrievedMemories?: Array<string | RetrievedMemoryForPrompt>;
  memoryEnabled?: boolean;
  currentTime?: {
    isoTimestamp?: string;
    timezone?: string;
    localDate?: string;
    localDateTime?: string;
    elapsedSinceLastInteraction?: string;
    lastInteractionAgeBand?: string;
    temporalNotes?: string;
  };
  currentAffect?: string;
  directContext?: string;
  directContextEnabled?: boolean;
  recentEpisodicMemory?: string;
  recentEpisodicMemoryEnabled?: boolean;
  currentSituation?: string;
  tools?: ToolContext[];
  maxCharacters?: number;
};

export type PromptBuildInput =
  | (PromptBuildSharedInput & {
      turnOrigin?: "user-turn";
      userMessage: string;
      proactiveInstruction?: never;
    })
  | (PromptBuildSharedInput & {
      turnOrigin: "assistant-initiated";
      proactiveInstruction: string;
      userMessage?: never;
    });

export type ProviderNeutralChatMessage = {
  role: "system" | "user";
  content: string;
};

export type PromptBuildOutput = {
  sections: PromptSection[];
  messages: ProviderNeutralChatMessage[];
  prompt: string;
  characterCount: number;
  estimatedTokens: number;
  truncated: boolean;
};

export type PromptInput = {
  companionName: string;
  userMessage: string;
  memories: string[];
};

export type BuiltPrompt = {
  system: string;
  user: string;
};

const defaultMaxCharacters = 12000;

export class PromptBuilder {
  buildPrompt(input: PromptBuildInput): PromptBuildOutput {
    const maxCharacters = input.maxCharacters ?? defaultMaxCharacters;
    const sections = this.createSections(input);
    // P8/Character owns production persona semantics. CharacterStyle remains
    // accepted only so older callers do not become an accidental second
    // authority while they are being retired.
    const providerFacingSections = sections.filter((section) => section.name !== "CharacterStyle");
    const budgetedSections = [
      ...assembleCanonicalContext({
        promptSections: this.enforceBudget(providerFacingSections, maxCharacters),
        currentInput: input.turnOrigin === "assistant-initiated" ? null : input.userMessage
      }).promptSections
    ];
    const prompt = budgetedSections.map(formatSection).join("\n\n");
    const systemPrompt = budgetedSections
      .filter((section) => section.name !== "UserMessage")
      .map(formatSection)
      .join("\n\n");

    return {
      sections: budgetedSections,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        ...(input.turnOrigin === "assistant-initiated"
          ? []
          : [
              {
                role: "user" as const,
                content: formatSection({
                  name: "UserMessage",
                  content: input.userMessage,
                  priority: 100,
                  stable: false
                })
              }
            ])
      ],
      prompt,
      characterCount: prompt.length,
      estimatedTokens: estimateTokens(prompt),
      truncated: sectionsToText(providerFacingSections).length > prompt.length
    };
  }

  build(input: PromptInput): BuiltPrompt {
    const output = this.buildPrompt({
      systemIdentity: `You are ${input.companionName}, a local-first AI companion runtime agent.`,
      relationshipContext: "Use remembered context only when it is relevant and helpful.",
      retrievedMemories: input.memories,
      currentSituation: "The user is actively interacting with the companion runtime.",
      tools: [],
      userMessage: input.userMessage
    });

    return {
      system: output.prompt,
      user: input.userMessage
    };
  }

  private createSections(input: PromptBuildInput): PromptSection[] {
    const sharedSections: PromptSection[] = [
      {
        name: "SystemIdentity",
        content: input.systemIdentity,
        priority: 100,
        stable: true
      },
      {
        name: "CharacterStyle",
        content: input.characterStyle ?? "",
        priority: 90,
        stable: true
      },
      {
        name: "RelationshipContext",
        content: input.relationshipContext ?? "No specific relationship context is available.",
        priority: 80,
        stable: false
      },
      {
        name: "CurrentTime",
        content: formatCurrentTime(input.currentTime),
        priority: 85,
        stable: true
      },
      {
        name: "CurrentAffect",
        content: formatCurrentAffect(input.currentAffect),
        priority: 84,
        stable: false
      },
      {
        name: "DirectContext",
        content: formatDirectContext(input.directContext, input.directContextEnabled ?? true),
        priority: 68,
        stable: false
      },
      {
        name: "RecentEpisodicMemory",
        content: formatRecentEpisodicMemory(
          input.recentEpisodicMemory,
          input.recentEpisodicMemoryEnabled ?? true
        ),
        priority: 72,
        stable: false
      },
      {
        name: "RelevantMemory",
        content: this.compressMemoryNarrative(
          input.retrievedMemories ?? [],
          input.memoryEnabled ?? true
        ),
        priority: 70,
        stable: false
      },
      {
        name: "CurrentSituation",
        content: input.currentSituation ?? "No additional situation context is available.",
        priority: 60,
        stable: false
      }
    ];

    if (input.turnOrigin === "assistant-initiated") {
      return [
        sharedSections[0]!,
        sharedSections[1]!,
        {
          name: "ProactiveInstruction",
          content: input.proactiveInstruction,
          priority: 100,
          stable: true
        },
        {
          ...sharedSections[2]!,
          stable: true
        },
        sharedSections[5]!,
        sharedSections[7]!
      ];
    }

    return [
      ...sharedSections,
      {
        name: "Tools",
        content: formatTools(input.tools ?? []),
        priority: 50,
        stable: false
      },
      {
        name: "UserMessage",
        content: input.userMessage,
        priority: 100,
        stable: false
      }
    ];
  }

  private compressMemoryNarrative(
    memories: Array<string | RetrievedMemoryForPrompt>,
    memoryEnabled: boolean
  ): string {
    if (!memoryEnabled) {
      return "Memory was disabled for this turn.";
    }

    if (memories.length === 0) {
      return "No relevant memory retrieved.";
    }

    const ranked = dedupePromptMemories(
      memories.map(normalizeMemory).sort(compareMemoryForPrompt)
    ).slice(0, 5);

    return ranked.map((memory) => `- ${formatMemoryForPrompt(memory)}`).join("\n");
  }

  private enforceBudget(sections: PromptSection[], maxCharacters: number): PromptSection[] {
    const result = sections.map((section) => ({ ...section }));

    while (sectionsToText(result).length > maxCharacters) {
      const candidate = [...result]
        .filter(
          (section) =>
            !section.stable && section.name !== "UserMessage" && section.content.length > 120
        )
        .sort((left, right) => left.priority - right.priority)[0];

      if (!candidate) {
        break;
      }

      candidate.content = truncateText(
        candidate.content,
        Math.max(120, Math.floor(candidate.content.length * 0.75))
      );
    }

    return result;
  }
}

function formatCurrentAffect(currentAffect: string | undefined): string {
  return currentAffect?.trim() || "No high-confidence immediate affect detected.";
}

function formatCurrentTime(currentTime?: PromptBuildInput["currentTime"]): string {
  const now = new Date();
  const isoTimestamp = currentTime?.isoTimestamp ?? now.toISOString();
  const timezone = currentTime?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDate =
    currentTime?.localDate ?? now.toLocaleDateString("en-CA", { timeZone: timezone });
  const lines = [
    `ISO timestamp: ${isoTimestamp}`,
    `Timezone: ${timezone}`,
    `Local date: ${localDate}`
  ];
  if (currentTime?.localDateTime) {
    lines.push(`Local date-time: ${currentTime.localDateTime}`);
  }
  if (currentTime?.elapsedSinceLastInteraction) {
    const band = currentTime.lastInteractionAgeBand
      ? ` [${currentTime.lastInteractionAgeBand}]`
      : "";
    lines.push(`Elapsed since last interaction: ${currentTime.elapsedSinceLastInteraction}${band}`);
  }
  if (currentTime?.temporalNotes) {
    lines.push(currentTime.temporalNotes);
  }
  return lines.join("\n");
}

function formatRecentEpisodicMemory(content: string | undefined, enabled: boolean): string {
  if (!enabled) {
    return "Recent episodic memory was disabled for this turn.";
  }
  const trimmed = content?.trim();
  return trimmed ? trimmed : "No recent episodic memory available.";
}

function formatDirectContext(context: string | undefined, enabled: boolean): string {
  if (!enabled) {
    return "Direct context was disabled for this turn.";
  }
  const trimmed = context?.trim();
  return trimmed ? trimmed : "No recent direct context available.";
}

function formatSection(section: PromptSection): string {
  return `<${section.name}>\n${section.content.trim()}\n</${section.name}>`;
}

function sectionsToText(sections: PromptSection[]): string {
  return sections.map(formatSection).join("\n\n");
}

function normalizeMemory(
  memory: string | RetrievedMemoryForPrompt
): Required<Pick<RetrievedMemoryForPrompt, "content">> & RetrievedMemoryForPrompt {
  if (typeof memory === "string") {
    return {
      content: memory,
      summary: null,
      importance: 0.5
    };
  }

  return memory;
}

function compareMemoryForPrompt(
  left: RetrievedMemoryForPrompt,
  right: RetrievedMemoryForPrompt
): number {
  const importanceDelta = (right.importance ?? 0.5) - (left.importance ?? 0.5);
  if (importanceDelta !== 0) {
    return importanceDelta;
  }

  return (
    toTime(right.lastAccessedAt ?? right.createdAt) - toTime(left.lastAccessedAt ?? left.createdAt)
  );
}

function compressMemoryText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const withoutTranscriptMarkers = compact
    .replace(/User intent:\s*/gi, "")
    .replace(/^User said:\s*/i, "User expressed: ")
    .replace(/^Assistant replied:\s*/i, "Assistant response summary: ");

  const withoutAssistantSummary = withoutTranscriptMarkers.replace(
    /Assistant response summary:\s*.*$/gis,
    ""
  );

  return truncateText(stripLeadingListMarkers(withoutAssistantSummary.trim()), 220);
}

function stripLeadingListMarkers(text: string): string {
  let result = text.trim();
  let previous = "";

  while (result && result !== previous) {
    previous = result;
    result = result
      .replace(/^>\s*/, "")
      .replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/u, "")
      .trimStart();
  }

  return result;
}

function displayTextForMemory(memory: RetrievedMemoryForPrompt): string {
  return memory.displayText ?? memory.summary ?? memory.content;
}

function formatMemoryForPrompt(memory: RetrievedMemoryForPrompt): string {
  const hints = [
    memory.associated ? "associated" : null,
    memory.ageBand ?? null,
    formatEventTimeHint(memory),
    memory.type ?? null,
    memory.scope ? (memory.scopeId ? `${memory.scope}:${memory.scopeId}` : memory.scope) : null,
    memory.memoryLayer ?? null,
    memory.status ?? null
  ].filter(Boolean);
  const temporalHint = formatTemporalHint(memory);
  const prefix = [...hints, temporalHint]
    .filter(Boolean)
    .map((hint) => `[${hint}]`)
    .join("");
  return `${prefix ? `${prefix} ` : ""}${compressMemoryText(displayTextForMemory(memory))}`;
}

function formatTemporalHint(memory: RetrievedMemoryForPrompt): string | null {
  if (memory.validUntil) {
    return `validUntil:${formatDateOnly(memory.validUntil)}`;
  }
  if (memory.expiresAt) {
    return `expires:${formatDateOnly(memory.expiresAt)}`;
  }
  return null;
}

function formatEventTimeHint(memory: RetrievedMemoryForPrompt): string | null {
  if (!memory.eventTime && !memory.validFrom) {
    return null;
  }
  const source = memory.eventTime ?? memory.validFrom;
  if (!source) return null;
  const date = source instanceof Date ? source : new Date(source);
  if (Number.isNaN(date.getTime())) return null;
  const hour = date.getUTCHours();
  const daypart =
    hour < 11 ? "morning" : hour < 15 ? "midday" : hour < 19 ? "afternoon" : "evening";
  return `${date.toISOString().slice(0, 10)} ${daypart}`;
}

function formatDateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function dedupePromptMemories(memories: RetrievedMemoryForPrompt[]): RetrievedMemoryForPrompt[] {
  const result: RetrievedMemoryForPrompt[] = [];
  for (const memory of memories) {
    const text = normalizeForPromptDedupe(displayTextForMemory(memory));
    const duplicate = result.some((kept) => {
      const keptText = normalizeForPromptDedupe(displayTextForMemory(kept));
      return (
        text === keptText ||
        (text.length >= 24 && keptText.includes(text)) ||
        (keptText.length >= 24 && text.includes(keptText))
      );
    });
    if (!duplicate) {
      result.push(memory);
    }
  }
  return result;
}

function normalizeForPromptDedupe(text: string): string {
  return text.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function formatTools(tools: ToolContext[]): string {
  if (tools.length === 0) {
    return "No tools are currently available.";
  }

  return tools
    .map((tool) => {
      const status = tool.available === false ? "unavailable" : "available";
      return `- ${tool.name} (${status})${tool.description ? `: ${tool.description}` : ""}`;
    })
    .join("\n");
}

function truncateText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toTime(value: Date | string | undefined): number {
  if (!value) {
    return 0;
  }

  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
