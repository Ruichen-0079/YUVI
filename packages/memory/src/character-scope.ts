import { parseMemoryScope } from "./scope.js";

const prefix = "character-instance:";

/** Reserved instance dimension; old primary persona aliases keep their exact encoding. */
export function characterMemoryPersonaId(instanceId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(instanceId))
    throw new Error("Invalid Memory Character instance identifier.");
  return prefix + instanceId;
}

export type MemoryCharacterOwner = Readonly<{
  instanceId: string;
  /** null preserves primary legacy scopes, while denying all reserved instance scopes. */
  personaId: string | null;
}>;

export function assertCharacterMemoryPersona(
  owner: MemoryCharacterOwner,
  personaId: string | null | undefined
): void {
  if (owner.personaId !== null) {
    if (personaId != null && personaId !== owner.personaId)
      throw new Error("Memory scope belongs to another Character.");
  } else if (personaId?.startsWith(prefix)) {
    throw new Error("Primary legacy Memory cannot access another Character instance scope.");
  }
}

export function assertCharacterMemoryScope(owner: MemoryCharacterOwner, scope: string): void {
  assertCharacterMemoryPersona(owner, parseMemoryScope(scope).characterId);
}
