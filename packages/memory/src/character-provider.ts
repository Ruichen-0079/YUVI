import {
  assertCharacterMemoryPersona,
  assertCharacterMemoryScope,
  type MemoryCharacterOwner
} from "./character-scope.js";
import type { MemoryProvider, MemoryRetrievalInput, MemoryEvent } from "./provider.js";
import type { ProfileMemorySourceReader } from "./profile-types.js";

const unboundPrimary = Object.freeze({ instanceId: "primary-legacy", personaId: null });

/** Access view over an existing provider, not a second Memory implementation. */
export function characterMemoryProvider(
  provider: MemoryProvider,
  getOwner: () => MemoryCharacterOwner | undefined
): MemoryProvider {
  const check = (input: { scope?: string | null; personaId?: string | null }) => {
    const owner = getOwner() ?? unboundPrimary;
    assertCharacterMemoryPersona(owner, input.personaId);
    if (input.scope) assertCharacterMemoryScope(owner, input.scope);
    else if (owner.personaId !== null)
      throw new Error("A Character Memory provider requires an explicit scope.");
  };
  const checkEvent = (event: MemoryEvent | null | undefined, scope?: string | null) => {
    if (!event) return;
    if (!event.scope || (scope && event.scope !== scope))
      throw new Error("Memory provider returned an event outside the requested scope.");
    assertCharacterMemoryScope(getOwner() ?? unboundPrimary, event.scope);
  };
  return {
    async retrieveRelevant(input: MemoryRetrievalInput) {
      check(input);
      const result = await provider.retrieveRelevant(input);
      for (const event of result.events) checkEvent(event, input.scope);
      return result;
    },
    async getEvent(input) {
      check(input);
      const result = await provider.getEvent(input);
      checkEvent(result, input.scope);
      return result;
    },
    async writeEvent(input) {
      check(input);
      const result = await provider.writeEvent(input);
      checkEvent(result.event, input.scope);
      return result;
    },
    ...(provider.prepareEvidence
      ? ({
          async prepareEvidence(producer, input) {
            check(input);
            return provider.prepareEvidence!(producer, input);
          }
        } satisfies Pick<MemoryProvider, "prepareEvidence">)
      : {}),
    ...(provider.writeEventIdempotent
      ? ({
          async writeEventIdempotent(input) {
            check(input);
            const result = await provider.writeEventIdempotent!(input);
            checkEvent(result.event, input.scope);
            return result;
          }
        } satisfies Pick<MemoryProvider, "writeEventIdempotent">)
      : {}),
    ...(provider.reconcileEvent
      ? ({
          async reconcileEvent(input) {
            check(input);
            return provider.reconcileEvent!(input);
          }
        } satisfies Pick<MemoryProvider, "reconcileEvent">)
      : {})
  };
}

export function characterProfileSourceReader(
  source: ProfileMemorySourceReader,
  getOwner: () => MemoryCharacterOwner | undefined
): ProfileMemorySourceReader {
  return {
    listEligibleSources(input) {
      assertCharacterMemoryScope(getOwner() ?? unboundPrimary, input.subject.scope);
      return source.listEligibleSources(input);
    }
  };
}
