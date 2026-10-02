/**
 * Stable memory scope encoding for user × character isolation.
 *
 * Format: yuvi:v1:user:{encodedUserId}:character:{encodedCharacterId}
 *
 * encodeURIComponent keeps Unicode / special characters stable and reversible.
 * Empty IDs are rejected so callers cannot accidentally collapse scopes.
 */

export type MemoryScopeParts = {
  userId: string;
  characterId: string;
};

export class MemoryScopeError extends Error {
  readonly code = "SCOPE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MemoryScopeError";
  }
}

const SCOPE_PREFIX = "yuvi:v1";

export function buildMemoryScope(userId: string, characterId: string): string {
  const user = normalizeScopePart(userId, "userId");
  const character = normalizeScopePart(characterId, "characterId");
  return `${SCOPE_PREFIX}:user:${encodeURIComponent(user)}:character:${encodeURIComponent(character)}`;
}

export function parseMemoryScope(scope: string): MemoryScopeParts {
  if (typeof scope !== "string" || !scope.startsWith(`${SCOPE_PREFIX}:`)) {
    throw new MemoryScopeError("Memory scope has an invalid prefix.");
  }
  const body = scope.slice(`${SCOPE_PREFIX}:`.length);
  // user:<enc>:character:<enc> — split carefully on fixed markers.
  const userMarker = "user:";
  const characterMarker = ":character:";
  if (!body.startsWith(userMarker)) {
    throw new MemoryScopeError("Memory scope is missing the user segment.");
  }
  const afterUser = body.slice(userMarker.length);
  const splitAt = afterUser.indexOf(characterMarker);
  if (splitAt < 0) {
    throw new MemoryScopeError("Memory scope is missing the character segment.");
  }
  const encodedUser = afterUser.slice(0, splitAt);
  const encodedCharacter = afterUser.slice(splitAt + characterMarker.length);
  if (!encodedUser || !encodedCharacter) {
    throw new MemoryScopeError("Memory scope segments must be non-empty.");
  }
  try {
    return {
      userId: decodeURIComponent(encodedUser),
      characterId: decodeURIComponent(encodedCharacter)
    };
  } catch {
    throw new MemoryScopeError("Memory scope contains invalid percent-encoding.");
  }
}

export function hashMemoryScope(scope: string): string {
  // Lightweight non-crypto hash for logs (not security-sensitive).
  let hash = 2166136261;
  for (let i = 0; i < scope.length; i += 1) {
    hash ^= scope.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `s${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeScopePart(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new MemoryScopeError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new MemoryScopeError(`${field} must not be empty.`);
  }
  return trimmed;
}

/** Native host storage partition identity; compatibility defaults match Profile. */
export function sameLegacyMemoryPartition(left: { subjectUserId?: string | null | undefined; personaId?: string | null | undefined }, right: { subjectUserId?: string | null | undefined; personaId?: string | null | undefined }): boolean {
  return (left.subjectUserId ?? "default-user") === (right.subjectUserId ?? "default-user") &&
    (left.personaId ?? "default-persona") === (right.personaId ?? "default-persona");
}
