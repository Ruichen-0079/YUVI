import {
  createP8Projection,
  DEFAULT_CHARACTER_INSTANCE_ID,
  DEFAULT_PERSONA_PROFILE_ID,
  productionAuthoredInvariants,
  type P8AuthoredInvariant,
  type P8IdentityAddress
} from "@companion/p8";
import { characterMemoryPersonaId } from "@companion/memory";

/** Authored data, not a Runtime, a model process, or a store of experiences. */
export type CharacterDefinition = Readonly<{
  id: string;
  revision: string;
  name: string;
  authoredInvariants: readonly P8AuthoredInvariant[];
  systemIdentity: string;
}>;

/** A stable experience owner. Several surfaces may bind to this same instance. */
export type CharacterBinding = Readonly<{
  instanceId: string;
  definition: CharacterDefinition;
}>;

export const PRIMARY_CHARACTER: CharacterBinding = normalizeCharacterBinding({
  instanceId: DEFAULT_CHARACTER_INSTANCE_ID,
  definition: Object.freeze({
    id: DEFAULT_PERSONA_PROFILE_ID,
    revision: "1",
    name: "Yuvi",
    authoredInvariants: productionAuthoredInvariants(),
    systemIdentity: "You are YUVI, a local-first AI companion runtime agent."
  })
});

export function defineCharacter(input: {
  id: string;
  revision: string;
  name: string;
  persona: string;
}): CharacterDefinition {
  if (!input.persona.trim() || input.persona.length > 32_000)
    throw new Error("Character persona must contain between 1 and 32000 characters.");
  const reference = "character-definition:" + input.id;
  const provenance = { source: "authored" as const, reference, revision: input.revision };
  const authoredInvariants: P8AuthoredInvariant[] = [
    { key: "character.name", target: "identity", statement: input.name, provenance },
    ...(input.persona.match(/[\s\S]{1,480}/g) ?? []).map((statement, index) => ({
      key: "persona.authored." + String(index).padStart(4, "0"),
      target: "persona" as const,
      statement,
      provenance
    }))
  ];
  return normalizeCharacterBinding({
    instanceId: "definition-validation",
    definition: {
      id: input.id,
      revision: input.revision,
      name: input.name,
      authoredInvariants,
      systemIdentity:
        "You are " +
        input.name +
        ", a persistent AI companion. Use the supplied authored identity, persona and this Character's own experience."
    }
  }).definition;
}

/** Defensive immutable snapshot; changing caller-owned objects cannot switch a Runtime. */
export function normalizeCharacterBinding(binding: CharacterBinding): CharacterBinding {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(binding.instanceId))
    throw new Error("Character instanceId must be a stable bounded identifier.");
  const definition = binding.definition;
  if (
    !definition.name.trim() ||
    definition.name.length > 80 ||
    !definition.revision.trim() ||
    definition.revision.length > 80 ||
    !definition.systemIdentity.trim() ||
    definition.systemIdentity.length > 2048
  )
    throw new Error("Invalid Character definition.");
  const projection = createP8Projection({
    address: { characterInstanceId: binding.instanceId, personaProfileId: definition.id },
    authoredInvariants: definition.authoredInvariants
  });
  const names = projection.identity.invariants.filter((item) => item.key === "character.name");
  if (
    names.length !== 1 ||
    names[0]?.statement !== definition.name ||
    projection.persona.status !== "KNOWN"
  )
    throw new Error("Character definition must supply its own consistent identity and persona.");
  return Object.freeze({
    instanceId: binding.instanceId,
    definition: Object.freeze({
      id: definition.id,
      revision: definition.revision,
      name: definition.name,
      authoredInvariants: Object.freeze([
        ...projection.identity.invariants,
        ...projection.persona.invariants
      ]),
      systemIdentity: definition.systemIdentity
    })
  });
}

export function characterP8Address(
  binding: CharacterBinding,
  subjectScopeId?: string,
  legacyPersonaId?: string
): P8IdentityAddress {
  return Object.freeze({
    characterInstanceId: binding.instanceId,
    personaProfileId: legacyPersonaId ?? binding.definition.id,
    ...(subjectScopeId === undefined ? {} : { subjectScopeId })
  });
}

export function characterPersonaId(binding: CharacterBinding): string {
  return characterMemoryPersonaId(binding.instanceId);
}

// Coordination ownership guard, not a second Character state store. Expensive
// serving endpoints and world-identity readers are intentionally not claimed.
const resourceOwners = new WeakMap<object, string>();
export function claimCharacterResources(instanceId: string, resources: readonly unknown[]): void {
  const objects = resources.filter(
    (value): value is object => typeof value === "object" && value !== null
  );
  for (const resource of objects) {
    const owner = resourceOwners.get(resource);
    if (owner !== undefined && owner !== instanceId)
      throw new Error("Character compositions cannot share mutable coordination resources.");
  }
  for (const resource of objects) resourceOwners.set(resource, instanceId);
}
