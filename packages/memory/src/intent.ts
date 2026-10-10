const explicitRememberPatterns: RegExp[] = [
  /(?:^|[，,。！!？?\s])请记住[，,：:\s]/u,
  /(?:^|[，,。！!？?\s])请记住$/u,
  /(?:^|[，,。！!？?\s])记住[，,：:\s]/u,
  /(?:^|[，,。！!？?\s])记住$/u,
  /帮我记住/u,
  /帮我记一下/u,
  /(?:^|[，,。！!？?\s])记一下/u,
  /不要忘记/u,
  /以后记得/u,
  /\bplease\s+remember\b/iu,
  /\bremember\s+that\b/iu,
  /\bremember\b[,:]?\s+(?:that\s+)?/iu,
  /\bdon'?t\s+forget\b/iu,
  /\bmake\s+a\s+note\b/iu
];

const explicitRememberFalsePositivePatterns: RegExp[] = [
  /想不起来.*记住/u,
  /《记住》/u,
  /电影.*《?记住》?/u,
  /这个词.*记住/u,
  /记住.*怎么写/u
];

export function detectExplicitRememberRequest(userMessage: string): boolean {
  const text = normalizeIntentInput(userMessage);
  if (!text) {
    return false;
  }
  if (explicitRememberFalsePositivePatterns.some((pattern) => pattern.test(text))) {
    return false;
  }
  return explicitRememberPatterns.some((pattern) => pattern.test(text));
}

export function stripExplicitRememberPrefix(text: string): string {
  return text
    .replace(
      /^(?:请记住|记住|帮我记住|帮我记一下|记一下|不要忘记|以后记得|please\s+remember|remember\s+that|remember|don't\s+forget|make\s+a\s+note)\s*[:：,，-]?\s*/iu,
      ""
    )
    .trim();
}

/**
 * Natural-language text is not authority for destructive Memory operations.
 * Kept as a compatibility export; use explicit, scoped management commands.
 */
export function detectExplicitForgetRequest(_userMessage: string): boolean {
  return false;
}

export function stripExplicitForgetPrefix(text: string): string {
  return text
    .replace(
      /^(?:请忘记|忘记|忘掉|帮我忘记|不要再记住|please\s+forget|forget\s+that|forget|don't\s+remember|delete\s+(?:that\s+)?memory)\s*[:：,，-]?\s*/iu,
      ""
    )
    .trim();
}

const correctionPatterns: RegExp[] = [
  /(?:^|[，,。！!？?\s])不对[，,：:]/u,
  /(?:^|[，,。！!？?\s])不对$/u,
  /我说错了/u,
  /更正一下/u,
  /纠正一下/u,
  /准确地说/u,
  /我后来想起来了/u,
  /刚才说错了/u,
  /应该是/u,
  /其实不是/u,
  /不是(?:这样|那个|对的)/u,
  /\bactually\b/iu,
  /\bi\s+was\s+wrong\b/iu,
  /\bcorrection\b/iu,
  /\blet\s+me\s+correct\b/iu,
  /\bthat'?s\s+not\s+right\b/iu,
  /\bto\s+be\s+precise\b/iu
];

const correctionFalsePositivePatterns: RegExp[] = [
  /其实很简单/u,
  /不是所有人/u,
  /不是每个/u,
  /不是唯一/u
];

export type UserMemoryIntent = "remember" | "correct" | "state" | "recall" | "other";

export function detectCorrectionRequest(userMessage: string): boolean {
  const text = normalizeIntentInput(userMessage);
  if (!text || text.length < 4) {
    return false;
  }
  if (correctionFalsePositivePatterns.some((pattern) => pattern.test(text))) {
    return false;
  }
  if (correctionPatterns.some((pattern) => pattern.test(text))) {
    return hasCorrectableFact(text);
  }
  if (/^其实/u.test(text) && hasCorrectableFact(text)) {
    return true;
  }
  return false;
}

export function extractCorrectionEvidence(userMessage: string): string | undefined {
  const text = normalizeIntentInput(userMessage);
  if (!text) {
    return undefined;
  }
  return text.length >= 4 ? text : undefined;
}

export function inferUserMemoryIntent(userMessage: string): UserMemoryIntent {
  if (detectExplicitRememberRequest(userMessage)) {
    return "remember";
  }
  if (detectCorrectionRequest(userMessage)) {
    return "correct";
  }
  if (/(你还记得|记得吗|刚才说了什么|what did i say|do you remember)/iu.test(userMessage)) {
    return "recall";
  }
  if (userMessage.trim().length > 0) {
    return "state";
  }
  return "other";
}

function hasCorrectableFact(text: string): boolean {
  return (
    text.length >= 8 &&
    /(吃|喝|饭|早饭|早餐|面包|蛋糕|去了|做了|买了|看了|meal|breakfast|bread|ate|drank|went|did)/iu.test(
      text
    )
  );
}

function normalizeIntentInput(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
