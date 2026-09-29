import type {
  MemoryCandidate,
  MemoryExtractionInput,
  MemoryExtractor,
  MemoryExtractorStatus,
  MemoryLayer,
  MemoryScope,
  MemorySubtype,
  MemoryType
} from "./types.js";
import { detectExplicitRememberRequest, stripExplicitRememberPrefix } from "./intent.js";
import { hasRelativeTemporalExpression, isOrdinaryDailyEvent } from "./temporal.js";

export type MemoryExtractionReasoner = {
  readonly name?: string;
  generateReasoning(input: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    effort?: "low" | "medium" | "high" | undefined;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    maxOutputTokens?: number | undefined;
  }): Promise<{
    reasoning: string;
    answer?: string | undefined;
    finishReason?: string | undefined;
    model?: string | undefined;
    tokenUsage?: unknown;
  }>;
};

export type LlmMemoryExtractorOptions = {
  enabled?: boolean;
  providerConfigured?: boolean;
  providerName?: string;
  logger?: {
    warn?(message: string, context?: Record<string, unknown>): void;
  };
  includeRawPreview?: boolean;
};

const unsupportedGroundingReason =
  "unsupported-grounding: LLM evidence admission is unavailable until committed grounding is supported; using rule-based extraction.";

/**
 * Compatibility adapter for deployments that still select MEMORY_EXTRACTOR=llm.
 * Until generated propositions can be tied to committed Journal selectors, it
 * deliberately never invokes the reasoner and delegates only to the conservative
 * rule-based extractor.
 */
export class LlmMemoryExtractor implements MemoryExtractor {
  private readonly provider: string;
  private lastStatus: MemoryExtractorStatus;

  constructor(
    reasoner: MemoryExtractionReasoner,
    private readonly fallback: MemoryExtractor = new RuleBasedMemoryExtractor(),
    private readonly options: LlmMemoryExtractorOptions = {}
  ) {
    this.provider = options.providerName ?? reasoner.name ?? "reasoning";
    this.lastStatus = this.createStatus();
  }

  getStatus(): MemoryExtractorStatus {
    return this.lastStatus;
  }

  async extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
    const candidates = await this.fallback.extractCandidates(input);
    this.lastStatus = {
      ...this.createStatus(),
      candidateCount: candidates.length
    };
    return candidates;
  }

  private createStatus(): MemoryExtractorStatus {
    const enabled = Boolean(this.options.enabled && this.options.providerConfigured);
    const skippedReason = !this.options.enabled
      ? "LLM memory extraction is disabled until explicitly enabled."
      : !this.options.providerConfigured
        ? "Reasoning provider is not configured; falling back to rule-based extraction."
        : unsupportedGroundingReason;
    return {
      mode: "llm",
      active: "fallback-rule-based",
      enabled,
      provider: this.provider,
      fallbackUsed: true,
      skippedReason
    };
  }
}

export class RuleBasedMemoryExtractor implements MemoryExtractor {
  getStatus(): MemoryExtractorStatus {
    return {
      mode: "rule-based",
      active: "rule-based",
      enabled: true
    };
  }

  async extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
    const text = normalizeInput(input.userMessage);
    if (!text || isTrivialConversation(text) || isOrdinaryQuestion(text)) {
      return [];
    }
    if (
      isFailedOrUncertainAssistantAnswer(input.assistantMessage) &&
      !mentionsExplicitRemember(text)
    ) {
      return [];
    }

    const candidates: MemoryCandidate[] = [];
    const explicitContent = stripExplicitRememberPrefix(text);
    const sourceTraceId = input.sourceTraceId ?? null;
    const observedAt = input.timestamp ?? new Date().toISOString();

    if (mentionsExplicitRemember(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: inferType(explicitContent, "semantic"),
          subtype: inferSubtype(explicitContent),
          importance: isOrdinaryDailyEvent(explicitContent) ? 0.55 : 0.95,
          reason: "explicit-remember",
          observedAt,
          explicitRememberRequested: true,
          originRole: "user"
        })
      );
    }

    if (!mentionsExplicitRemember(text) && isOrdinaryDailyEvent(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "episodic",
          subtype: "event",
          importance: 0.45,
          reason: "ordinary-one-off-daily-event",
          observedAt
        })
      );
    }

    if (mentionsProviderChoice(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: "provider-choice",
          importance: 0.88,
          reason: "provider-choice",
          observedAt
        })
      );
    }

    if (mentionsIdentityStatement(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: "identity",
          importance: 0.9,
          reason: "explicit-user-identity",
          observedAt
        })
      );
    }

    if (mentionsCommunicationPreference(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: "preference",
          importance: 0.82,
          reason: "communication-preference",
          observedAt
        })
      );
    }

    if (mentionsDurableEmotionalPattern(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "emotional",
          subtype: "emotional-pattern",
          importance: 0.72,
          reason: "durable-emotional-pattern",
          observedAt
        })
      );
    }

    if (mentionsStablePreference(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: mentionsProviderChoice(text) ? "provider-choice" : "preference",
          importance: mentionsProviderChoice(text) ? 0.88 : 0.78,
          reason: "stable-preference",
          observedAt
        })
      );
    }

    if (mentionsPathOrRepository(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: inferPathSubtype(explicitContent),
          importance: 0.86,
          reason: "path-or-repository",
          observedAt
        })
      );
    }

    if (mentionsCommandOrStartup(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "procedural",
          subtype: mentionsConfigDecision(text) ? "config" : "command",
          importance: 0.82,
          reason: "command-or-startup-instruction",
          observedAt
        })
      );
    }

    if (mentionsTroubleshootingConclusion(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "procedural",
          subtype: "troubleshooting",
          importance: 0.8,
          reason: "troubleshooting-conclusion",
          observedAt
        })
      );
    }

    if (mentionsProjectMilestone(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "episodic",
          subtype: "milestone",
          importance: 0.76,
          reason: "project-milestone",
          observedAt
        })
      );
    }

    return dedupeCandidates(candidates);
  }
}

function candidate(input: {
  text: string;
  sourceTraceId: string | null;
  type: MemoryType;
  subtype: MemorySubtype | null;
  importance: number;
  reason: string;
  observedAt?: string;
  explicitRememberRequested?: boolean;
  originRole?: "user" | "assistant" | "mixed";
}): MemoryCandidate {
  const content = normalizeInput(input.text);
  return {
    type: input.type,
    subtype: input.subtype,
    scope: inferScope(content),
    scopeId: inferScopeId(content),
    memoryLayer: inferMemoryLayer(input.type, input.subtype),
    content,
    summary: content.length > 180 ? `${content.slice(0, 177).trim()}...` : content,
    importance: input.importance,
    tags: createTags(content, input.subtype),
    reason: input.reason,
    confidence: 1,
    ...(input.explicitRememberRequested ? { explicitRememberRequested: true } : {}),
    ...(input.originRole ? { originRole: input.originRole } : {}),
    metadata: {
      generatedBy: "rule-based-memory-extractor",
      ...(input.reason === "explicit-remember" || input.explicitRememberRequested
        ? { explicitRemember: true, explicitRememberRequested: true }
        : {}),
      ...(input.originRole ? { originRole: input.originRole } : { originRole: "user" })
    },
    sourceTraceId: input.sourceTraceId,
    observedAt: input.observedAt ?? new Date().toISOString()
  };
}

function normalizeInput(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inferType(text: string, fallback: MemoryType): MemoryType {
  if (mentionsCommandOrStartup(text)) {
    return "procedural";
  }
  if (mentionsProjectMilestone(text)) {
    return "episodic";
  }
  if (hasRelativeTemporalExpression(text) && isOrdinaryDailyEvent(text)) {
    return "episodic";
  }
  return fallback;
}

function inferSubtype(text: string): MemorySubtype | null {
  if (mentionsProviderChoice(text)) {
    return "provider-choice";
  }
  if (mentionsPathOrRepository(text)) {
    return inferPathSubtype(text);
  }
  if (mentionsCommandOrStartup(text)) {
    return mentionsConfigDecision(text) ? "config" : "command";
  }
  if (mentionsTroubleshootingConclusion(text)) {
    return "troubleshooting";
  }
  if (mentionsProjectMilestone(text)) {
    return "milestone";
  }
  if (hasRelativeTemporalExpression(text) && isOrdinaryDailyEvent(text)) {
    return "event";
  }
  if (/项目|project|yuvi|runtime/iu.test(text)) {
    return "project-fact";
  }
  if (mentionsIdentityStatement(text)) {
    return "identity";
  }
  if (mentionsDurableEmotionalPattern(text)) {
    return "emotional-pattern";
  }
  if (mentionsStablePreference(text)) {
    return "preference";
  }
  return "fact";
}

function inferPathSubtype(text: string): MemorySubtype {
  return /repo|repository|仓库|github/iu.test(text) ? "repo" : "path";
}

function createTags(text: string, subtype: MemorySubtype | null): string[] {
  const tags = new Set<string>();
  if (subtype) {
    tags.add(subtype);
  }
  if (/yuvi/iu.test(text)) tags.add("yuvi");
  if (/runtime/iu.test(text)) tags.add("runtime");
  if (/deepseek/iu.test(text)) tags.add("deepseek");
  if (/xai|x\.ai/iu.test(text)) tags.add("xai");
  if (/dashscope|阿里云|通义/iu.test(text)) tags.add("dashscope");
  if (/postgres|pgvector/iu.test(text)) tags.add("postgres");
  if (/config|配置|env|\.env/iu.test(text)) tags.add("config");
  if (/troubleshoot|排错|原因|root cause/iu.test(text)) tags.add("troubleshooting");
  return [...tags];
}

function inferScope(text: string): MemoryScope {
  if (/yuvi|runtime|repo|repository|项目|仓库|workspace|工作区/iu.test(text)) {
    return "project";
  }
  if (/session|本次会话|temporary|临时/iu.test(text)) {
    return "session";
  }
  return "user";
}

function inferScopeId(text: string, scope: MemoryScope = inferScope(text)): string | null {
  if (scope === "project") {
    return "yuvi-runtime";
  }
  return null;
}

function inferMemoryLayer(
  type: MemoryType,
  subtype: MemorySubtype | null | undefined
): MemoryLayer {
  if (type === "working") {
    return "working";
  }
  if (
    type === "semantic" ||
    subtype === "preference" ||
    subtype === "project" ||
    subtype === "provider-choice"
  ) {
    return "core";
  }
  if (type === "episodic" || subtype === "milestone" || subtype === "troubleshooting") {
    return "recall";
  }
  return "recall";
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const byContent = new Map<string, MemoryCandidate>();
  for (const item of candidates) {
    const key = item.content.toLowerCase();
    const existing = byContent.get(key);
    if (!existing || item.importance > existing.importance) {
      byContent.set(key, item);
    }
  }
  return [...byContent.values()];
}

function isTrivialConversation(text: string): boolean {
  return /^(hi|hello|hey|你好|您好|哈喽|嗨)[!.。！\s]*$/iu.test(text);
}

function isOrdinaryQuestion(text: string): boolean {
  if (mentionsDurableSignal(text)) {
    return false;
  }
  return /[?？]\s*$/u.test(text) && text.length < 160;
}

function mentionsDurableSignal(text: string): boolean {
  return (
    mentionsExplicitRemember(text) ||
    mentionsProviderChoice(text) ||
    mentionsStablePreference(text) ||
    mentionsIdentityStatement(text) ||
    mentionsCommunicationPreference(text) ||
    mentionsDurableEmotionalPattern(text) ||
    mentionsPathOrRepository(text) ||
    mentionsCommandOrStartup(text) ||
    mentionsConfigDecision(text) ||
    mentionsTroubleshootingConclusion(text) ||
    mentionsProjectMilestone(text)
  );
}

function mentionsExplicitRemember(text: string): boolean {
  return detectExplicitRememberRequest(text);
}

function mentionsStablePreference(text: string): boolean {
  return /\bfrom now on\b|\bprefer\b|\bpreference\b|以后|默认使用|默认|偏好|以后都|喜欢|不喜欢|不吃/u.test(
    text
  );
}

function mentionsIdentityStatement(text: string): boolean {
  return /(?:我叫|我的名字是|叫我|可以叫我|my name is|call me|i am called)\s*[\p{Letter}\p{Number}_-]{1,40}/iu.test(
    text
  );
}

function mentionsCommunicationPreference(text: string): boolean {
  return /(请直接|一步步|分步骤|少废话|详细解释|用中文|用英文|prefer.*(?:concise|steps|direct)|communication preference)/iu.test(
    text
  );
}

function mentionsDurableEmotionalPattern(text: string): boolean {
  return /(我.*(?:长期|总是|经常).*(?:焦虑|紧张|烦|崩溃)|容易.*(?:焦虑|紧张|崩溃)|prefer.*when.*(?:anxious|frustrated))/iu.test(
    text
  );
}

function mentionsProviderChoice(text: string): boolean {
  return /(deepseek|xai|x\.ai|dashscope|通义|阿里云|provider|供应商|模型).*(chat|reasoning|tts|stt|vision|默认|使用|prefer|选择)|(?:chat|reasoning|tts|stt|vision).*(deepseek|xai|x\.ai|dashscope|通义|阿里云)/iu.test(
    text
  );
}

function mentionsPathOrRepository(text: string): boolean {
  return /(项目路径|repo path|repository|repo|仓库|路径|目录|workspace|工作区|\/home\/|c:\\|\\\\wsl|github)/iu.test(
    text
  );
}

function mentionsCommandOrStartup(text: string): boolean {
  return /(\bcommand\b|命令|\bpnpm\b|docker compose|\bdocker\b|脚本|\bstartup\b|启动|start-dev|dev\.sh|health\.sh|stop\.sh|curl\s+http|npm\s+run)/iu.test(
    text
  );
}

function mentionsConfigDecision(text: string): boolean {
  return /(\bport\b|端口|配置|config|\.env|env var|environment variable|database_url|memory_repository|server_port|server_host|默认端口|默认使用)/iu.test(
    text
  );
}

function mentionsTroubleshootingConclusion(text: string): boolean {
  return /(root cause|原因是|结论是|排错结论|解决办法|fix is|修复方式|failed because|失败原因)/iu.test(
    text
  );
}

function mentionsProjectMilestone(text: string): boolean {
  return /(项目里程碑|milestone|完成|已完成|implemented|finished|done|通过验证|validation passed|all validation passed|上线)/iu.test(
    text
  );
}

function isFailedOrUncertainAssistantAnswer(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return /(i don'?t know|cannot determine|can't determine|not enough context|lack context|lacks context|unable to answer|无法确定|不知道|缺少上下文|没有足够上下文|不能判断|无法判断)/iu.test(
    text
  );
}
