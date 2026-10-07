import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  characterPersonaId,
  defineCharacter,
  normalizeCharacterBinding,
  type CharacterBinding
} from "@companion/core";
import type { NativeControllerBindingOwner } from "@companion/memory";
import { readProductSettings } from "./services/product-store.js";

export type ProductPersonProjection = Readonly<{
  person: Readonly<{ id: string; displayName: string }>;
  revision: string | null;
}>;

/** A world-identity read view. It carries neither Memory nor Character relationship. */
export type ProductPersonSource = Readonly<{
  readPerson(id: string): ProductPersonProjection | null;
}>;

export function fileProductPersonSource(envDirectory: string): ProductPersonSource {
  if (!isAbsolute(envDirectory)) throw new Error("People source requires an absolute directory.");
  const env = Object.freeze({ YUVI_RUNTIME_ENV_DIR: envDirectory });
  return Object.freeze({
    readPerson(id: string) {
      const settings = readProductSettings(env);
      const person = settings?.people.find((entry) => entry.id === id);
      return person
        ? Object.freeze({
            person: Object.freeze({ id: person.id, displayName: person.displayName }),
            revision: settings?.personRevisionById?.[id] ?? null
          })
        : null;
    }
  });
}

export type CharacterComposition = Readonly<{
  binding: CharacterBinding;
  env: Readonly<Record<string, string | undefined>>;
  people?: ProductPersonSource | undefined;
  /** Host-granted identity read authority, independent of this Character's Memory. */
  voiceBindingOwner?: NativeControllerBindingOwner | undefined;
  voiceBindingPersonaId?: string | undefined;
}>;

/** Reuse createAppContext; snapshot all bootstrap configuration before constructing it. */
export function characterComposition(input: {
  binding: CharacterBinding;
  envDirectory: string;
  dataDirectory?: string;
  env?: Record<string, string | undefined>;
  subjectUserId?: string;
  people?: ProductPersonSource;
  voiceBindingOwner?: NativeControllerBindingOwner;
  voiceBindingPersonaId?: string;
}): CharacterComposition {
  const binding = normalizeCharacterBinding(input.binding);
  if (
    !isAbsolute(input.envDirectory) ||
    (input.dataDirectory !== undefined && !isAbsolute(input.dataDirectory))
  )
    throw new Error("Character storage roots must be absolute.");
  if (input.voiceBindingOwner && !input.voiceBindingPersonaId)
    throw new Error("Shared voice identity requires an explicit binding realm.");
  const env = {
    ...(input.env ?? process.env),
    YUVI_RUNTIME_ENV_DIR: input.envDirectory,
    YUVI_RUNTIME_DATA_DIR: input.dataDirectory ?? join(input.envDirectory, "data"),
    YUVI_JOURNAL_NAMESPACE: "yuvi:character:" + binding.instanceId,
    MEMORY_PERSONA_ID: characterPersonaId(binding),
    MEMORY_SUBJECT_USER_ID: input.subjectUserId
  };
  return Object.freeze({
    binding,
    env: Object.freeze(env),
    ...(input.people ? { people: input.people } : {}),
    ...(input.voiceBindingOwner
      ? {
          voiceBindingOwner: input.voiceBindingOwner,
          voiceBindingPersonaId: input.voiceBindingPersonaId
        }
      : {})
  });
}

export function preserveCharacterEnvironment(
  composition: CharacterComposition,
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const result = { ...env };
  for (const key of [
    "YUVI_RUNTIME_ENV_DIR",
    "YUVI_RUNTIME_DATA_DIR",
    "YUVI_JOURNAL_NAMESPACE",
    "MEMORY_PERSONA_ID"
  ])
    result[key] = composition.env[key];
  return result;
}

/**
 * A bootstrap file chooses a composition, never a global "current Character".
 * Credentials remain in the existing environment/provider configuration.
 */
export function readCharacterComposition(
  file: string | undefined,
  env: Record<string, string | undefined>
): CharacterComposition | undefined {
  if (!file) return undefined;
  const input = JSON.parse(readFileSync(file, "utf8")) as {
    version: number;
    instanceId: string;
    definition: { id: string; revision: string; name: string; persona: string };
    envDirectory: string;
    dataDirectory?: string;
    peopleDirectory?: string;
    subjectUserId?: string;
  };
  if (input.version !== 1) throw new Error("Unsupported Character configuration version.");
  return characterComposition({
    binding: { instanceId: input.instanceId, definition: defineCharacter(input.definition) },
    envDirectory: input.envDirectory,
    ...(input.dataDirectory ? { dataDirectory: input.dataDirectory } : {}),
    ...(input.subjectUserId ? { subjectUserId: input.subjectUserId } : {}),
    ...(input.peopleDirectory ? { people: fileProductPersonSource(input.peopleDirectory) } : {}),
    env
  });
}
