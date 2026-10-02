import { sameLegacyMemoryPartition } from "./scope.js";
import type { Memory, MemoryCandidate, MemoryScope } from "./types.js";

export type MemoryRelationshipSuggestion = {
  supersedes: string[];
  autoSupersedes: string[];
  contradicts: string[];
  relationshipConfidence: number;
  relationshipReason?: string | undefined;
  relationshipMemoryPreviews: Array<{
    id: string;
    relation: "supersedes" | "contradicts";
    confidence: number;
    reason: string;
    contentPreview: string;
  }>;
};

type RelationshipCategory = {
  kind:
    | "provider-choice"
    | "config"
    | "project-path"
    | "port"
    | "model-choice"
    | "memory-mode"
    | "workflow"
    | "troubleshooting"
    | "preference"
    | "health-safety"
    | "unknown";
  key: string;
  value?: string | undefined;
  polarity?: "positive" | "negative" | undefined;
  dangerous: boolean;
};

const providerNames = ["deepseek", "openai", "xai", "dashscope", "mock"] as const;
const capabilities = ["chat", "reasoning", "embedding", "tts", "stt", "vision"] as const;
const memoryModes = ["postgres", "in-memory", "memory", "pgvector", "mock"] as const;

export function detectMemoryRelationships(
  candidate: MemoryCandidate,
  existingMemories: Memory[]
): MemoryRelationshipSuggestion {
  const candidateCategory = categorizeMemoryLike(candidate);
  const supersedes = new Set<string>(candidate.possibleSupersedes ?? []);
  const autoSupersedes = new Set<string>();
  const contradicts = new Set<string>(candidate.possibleContradictions ?? []);
  const previews: MemoryRelationshipSuggestion["relationshipMemoryPreviews"] = [];

  for (const existing of existingMemories) {
    if (!isCompatibleScope(candidate, existing)) continue;
    if (existing.status === "forgotten" || existing.status === "superseded") continue;

    const existingCategory = categorizeMemoryLike(existing);
    const relationship = classifyRelationship(candidateCategory, existingCategory);
    if (!relationship) continue;

    if (relationship.relation === "supersedes") {
      supersedes.add(existing.id);
      if (relationship.auto) {
        autoSupersedes.add(existing.id);
      }
    } else {
      contradicts.add(existing.id);
    }

    previews.push({
      id: existing.id,
      relation: relationship.relation,
      confidence: relationship.confidence,
      reason: relationship.reason,
      contentPreview: safePreview(existing.content)
    });
  }

  const strongest = previews.reduce((max, preview) => Math.max(max, preview.confidence), 0);
  const reason = previews
    .slice(0, 3)
    .map((preview) => `${preview.relation}:${preview.reason}`)
    .join("; ");

  return {
    supersedes: [...supersedes],
    autoSupersedes: [...autoSupersedes],
    contradicts: [...contradicts],
    relationshipConfidence: strongest,
    ...(reason ? { relationshipReason: reason } : {}),
    relationshipMemoryPreviews: previews
  };
}

export function relationshipSearchText(candidate: MemoryCandidate): string {
  const category = categorizeMemoryLike(candidate);
  return [category.kind, category.key, category.value, candidate.content, ...(candidate.tags ?? [])]
    .filter(Boolean)
    .join(" ");
}

function classifyRelationship(
  candidate: RelationshipCategory,
  existing: RelationshipCategory
): {
  relation: "supersedes" | "contradicts";
  confidence: number;
  reason: string;
  auto: boolean;
} | null {
  if (candidate.kind === "unknown" || existing.kind === "unknown") return null;
  if (candidate.kind !== existing.kind) return null;
  if (candidate.key !== existing.key) return null;

  const valueChanged =
    Boolean(candidate.value) && Boolean(existing.value) && candidate.value !== existing.value;
  const polarityChanged =
    Boolean(candidate.polarity) &&
    Boolean(existing.polarity) &&
    candidate.polarity !== existing.polarity;

  if (candidate.dangerous || existing.dangerous) {
    if (valueChanged || polarityChanged) {
      return {
        relation: "contradicts",
        confidence: 0.76,
        reason: `${candidate.kind} conflict is safety-sensitive and requires review`,
        auto: false
      };
    }
    return null;
  }

  if (
    valueChanged &&
    (candidate.kind === "provider-choice" ||
      candidate.kind === "config" ||
      candidate.kind === "project-path" ||
      candidate.kind === "port" ||
      candidate.kind === "model-choice" ||
      candidate.kind === "memory-mode")
  ) {
    return {
      relation: "supersedes",
      confidence: 0.92,
      reason: `${candidate.kind} ${candidate.key} changed from ${existing.value} to ${candidate.value}`,
      auto: true
    };
  }

  if (valueChanged && (candidate.kind === "workflow" || candidate.kind === "troubleshooting")) {
    return {
      relation: "supersedes",
      confidence: 0.72,
      reason: `${candidate.kind} may replace a previous conclusion`,
      auto: false
    };
  }

  if (polarityChanged || valueChanged) {
    return {
      relation: "contradicts",
      confidence: 0.7,
      reason: `${candidate.kind} appears to conflict with an existing memory`,
      auto: false
    };
  }

  return null;
}

function categorizeMemoryLike(input: Memory | MemoryCandidate): RelationshipCategory {
  const text =
    `${input.content} ${input.summary ?? ""} ${(input.tags ?? []).join(" ")}`.toLowerCase();
  const subtype = input.subtype ?? null;
  const dangerous = isDangerousMemory(text, subtype);

  const provider = findFirst(text, providerNames);
  if (subtype === "provider-choice" || /provider|供应商|模型供应商/u.test(text)) {
    return {
      kind: "provider-choice",
      key: findFirst(text, capabilities) ?? "provider",
      value: provider,
      dangerous: false
    };
  }

  const envKey = text.match(
    /\b[a-z][a-z0-9_]*(?:api_key|token|model|provider|repository|database_url|port)\b/u
  )?.[0];
  if (subtype === "config" || envKey || /配置|config|env\b/u.test(text)) {
    return {
      kind: "config",
      key: envKey ?? configKeyFromText(text),
      value: configValueFromText(text),
      dangerous: false
    };
  }

  const pathValue = text.match(
    /[a-z]:\\[^\s，。]+|\/(?:home|users|workspace|tmp)\/[^\s，。]+|\\\\wsl[^\s，。]+/iu
  )?.[0];
  if (subtype === "path" || pathValue || /路径|目录|workspace|repo path/u.test(text)) {
    return {
      kind: "project-path",
      key: "project-path",
      value: pathValue?.replace(/\\/g, "/"),
      dangerous: false
    };
  }

  const port = text.match(/\b(?:port|端口)\D{0,8}(\d{3,5})\b/u)?.[1];
  if (port || /localhost:\d{3,5}|127\.0\.0\.1:\d{3,5}/u.test(text)) {
    return {
      kind: "port",
      key: text.includes("server") || text.includes("服务") ? "server-port" : "port",
      value: port ?? text.match(/:(\d{3,5})/u)?.[1],
      dangerous: false
    };
  }

  const model = text.match(
    /\b(?:deepseek-[a-z0-9-]+|text-embedding-[a-z0-9-]+|gpt-[a-z0-9.-]+)\b/u
  )?.[0];
  if (model || /model|模型/u.test(text)) {
    return {
      kind: "model-choice",
      key: findFirst(text, capabilities) ?? "model",
      value: model,
      dangerous: false
    };
  }

  const memoryMode = findFirst(text, memoryModes);
  if (memoryMode || /memory repository|memory mode|记忆模式|存储模式/u.test(text)) {
    return {
      kind: "memory-mode",
      key: "memory-mode",
      value: memoryMode,
      dangerous: false
    };
  }

  if (dangerous) {
    return {
      kind: "health-safety",
      key: healthSafetyKey(text),
      value: textValueFingerprint(text),
      polarity: polarity(text),
      dangerous: true
    };
  }

  if (subtype === "workflow" || /workflow|流程|procedure|步骤/u.test(text)) {
    return {
      kind: "workflow",
      key: "workflow",
      value: textValueFingerprint(text),
      dangerous: false
    };
  }

  if (subtype === "troubleshooting" || /troubleshoot|fix|root cause|修复|原因/u.test(text)) {
    return {
      kind: "troubleshooting",
      key: "troubleshooting",
      value: textValueFingerprint(text),
      dangerous: false
    };
  }

  if (subtype === "preference" || /prefer|preference|喜欢|不喜欢|偏好/u.test(text)) {
    return {
      kind: "preference",
      key: preferenceKey(text),
      value: textValueFingerprint(text),
      polarity: polarity(text),
      dangerous: false
    };
  }

  return { kind: "unknown", key: "unknown", dangerous: false };
}

function isCompatibleScope(candidate: MemoryCandidate, memory: Memory): boolean {
  const candidateScope = candidate.scope ?? inferScopeFromCandidate(candidate);
  const candidateScopeId =
    candidate.scopeId ?? (candidateScope === "project" ? "yuvi-runtime" : null);
  if (!sameLegacyMemoryPartition(candidate, memory) || candidateScope !== memory.scope) return false;
  if (candidateScope === "user") return true;
  return candidateScopeId === memory.scopeId;
}

function inferScopeFromCandidate(candidate: MemoryCandidate): MemoryScope {
  const haystack =
    `${candidate.content} ${candidate.summary ?? ""} ${candidate.tags.join(" ")}`.toLowerCase();
  return /yuvi|runtime|project|项目|repo|repository/u.test(haystack) ? "project" : "user";
}

function findFirst<T extends readonly string[]>(text: string, values: T): T[number] | undefined {
  return values.find((value) => text.includes(value));
}

function configKeyFromText(text: string): string {
  if (/database_url|database url|数据库/u.test(text)) return "database_url";
  if (/embedding/u.test(text)) return "embedding";
  if (/memory_repository|memory repository/u.test(text)) return "memory_repository";
  return "config";
}

function configValueFromText(text: string): string | undefined {
  return (
    text.match(/=\s*([^\s，。]+)/u)?.[1] ??
    text.match(/(?:使用|use|to|为|is)\s*([a-z0-9_.:/\\-]+)/u)?.[1]
  )?.toLowerCase();
}

function isDangerousMemory(text: string, subtype: string | null): boolean {
  return (
    subtype === "relationship" ||
    /health|medical|medicine|allergy|allergic|过敏|健康|药|医疗|关系|喜欢的人|legal|financial|财务|法律/u.test(
      text
    )
  );
}

function healthSafetyKey(text: string): string {
  if (/mango|芒果/u.test(text)) return "mango";
  if (/peanut|花生/u.test(text)) return "peanut";
  if (/medicine|药/u.test(text)) return "medicine";
  return "health-safety";
}

function preferenceKey(text: string): string {
  if (/mango|芒果/u.test(text)) return "mango";
  if (/cake|蛋糕/u.test(text)) return "cake";
  if (/provider|供应商/u.test(text)) return "provider";
  return "preference";
}

function polarity(text: string): "positive" | "negative" | undefined {
  if (/不喜欢|讨厌|avoid|dislike|not prefer|不要/u.test(text)) return "negative";
  if (/喜欢|prefer|偏好|like/u.test(text)) return "positive";
  return undefined;
}

function textValueFingerprint(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[，。,.]/gu, "")
    .slice(0, 120);
}

function safePreview(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(
      /([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)[A-Z0-9_]*)=([^\s]+)/giu,
      "$1=[REDACTED]"
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
