import type {
  P8CharacterSpeakerView,
  P8CorrectionApplicationResult,
  P8CorrectionAudit,
  P8EpistemicState,
  P8EvidenceInterpretation,
  P8ProjectedInvariant,
  P8ReconstructionOutcome
} from "../../p8/src/index.js";
import {
  CHARACTER_ABI_2A_VERSION,
  createCharacterAbiContext,
  type CharacterAbiContext,
  type CharacterAbiEpistemicState,
  type CharacterAbiSemanticSection
} from "./index.js";

export const P8_CHARACTER_ABI_PROJECTION_VERSION = "character-abi-2b-p8.v1" as const;

/**
 * Pure one-way P8 -> Character ABI projection.
 *
 * This adapter consumes only P8-owned semantic output and emits only the ABI
 * sections P8 owns: IDENTITY, PERSONA, and RELATIONSHIP_CONTEXT. It never
 * promotes P8's embedded Memory/recent-conversation evidence channels into
 * Character ABI sections owned by Memory or conversation-context producers.
 */
export function projectP8ReconstructionToCharacterAbi(
  outcome: P8ReconstructionOutcome,
  speaker?: P8CharacterSpeakerView
): CharacterAbiContext {
  if (outcome.status !== "RECONSTRUCTED") {
    const state: CharacterAbiEpistemicState =
      outcome.status === "UNAVAILABLE" ? "UNAVAILABLE" : "ERROR";
    const authored = outcome.authoredProjection;
    const declarations = authored
      ? [
          projectInvariantSection(
            "IDENTITY",
            "identity",
            authored.identity.status,
            authored.identity.invariants,
            authored
          ),
          projectInvariantSection(
            "PERSONA",
            "persona",
            authored.persona.status,
            authored.persona.invariants,
            authored
          )
        ].map((section) => ({
          ...section,
          state: "PARTIAL" as const,
          summary: [
            section.summary,
            `Authored declarations retained. Dynamic correction reconstruction is ${outcome.status}; current corrected meaning is unknown. No unverified correction was applied.`
          ]
            .filter(Boolean)
            .join("\n")
        }))
      : [
          { kind: "IDENTITY" as const, state },
          { kind: "PERSONA" as const, state }
        ];
    return createCharacterAbiContext({
      abiVersion: CHARACTER_ABI_2A_VERSION,
      sections: [...declarations, { kind: "RELATIONSHIP_CONTEXT", state }]
    });
  }

  const projection = outcome.projection;
  const sections: CharacterAbiSemanticSection[] = [
    projectInvariantSection(
      "IDENTITY",
      "identity",
      projection.identity.status,
      projection.identity.invariants,
      projection
    ),
    projectInvariantSection(
      "PERSONA",
      "persona",
      projection.persona.status,
      projection.persona.invariants,
      projection
    )
  ];
  if (speaker) {
    const identity = sections[0]!;
    sections[0] = {
      ...identity,
      state:
        identity.state === "ERROR" ||
        identity.state === "UNAVAILABLE" ||
        identity.state === "CONFLICTING"
          ? identity.state
          : speaker.speaker === "conflicting"
            ? "CONFLICTING"
            : speaker.speaker === "resolved" && identity.state === "KNOWN"
              ? "KNOWN"
              : "PARTIAL",
      summary: [identity.summary, `Current speaker: ${JSON.stringify(speaker)}`]
        .filter(Boolean)
        .join("\n")
    };
  }
  const relationship = projectRelationshipSection(projection);
  if (relationship !== undefined) {
    sections.push(relationship);
  }

  return createCharacterAbiContext({
    abiVersion: CHARACTER_ABI_2A_VERSION,
    sections
  });
}

function projectInvariantSection(
  kind: "IDENTITY" | "PERSONA",
  target: "identity" | "persona",
  baseState: P8EpistemicState,
  invariants: readonly P8ProjectedInvariant[],
  projection: P8CorrectionApplicationResult
): CharacterAbiSemanticSection {
  const activeAudits = projection.correctionAudits.filter(
    (audit) =>
      audit.supersededByCorrectionReference === undefined &&
      audit.target.kind === "AUTHORED_INVARIANT" &&
      audit.target.invariantTarget === target
  );
  const state: CharacterAbiEpistemicState = activeAudits.some(
    (audit) => audit.currentStatus === "CONFLICTING"
  )
    ? "CONFLICTING"
    : mapP8State(baseState);
  const summary = joinMeaning(
    invariants.map((invariant) => `${invariant.key}: ${invariant.statement}`)
  );
  const provenanceReferences = uniqueSorted([
    ...invariants.map((invariant) => authoredProvenanceReference(invariant)),
    ...activeAudits.map(correctionProvenanceReference)
  ]);

  return Object.freeze({
    kind,
    state,
    ...(summary === undefined ? {} : { summary }),
    ...(provenanceReferences.length === 0 ? {} : { provenanceReferences })
  });
}

function projectRelationshipSection(
  projection: P8CorrectionApplicationResult
): CharacterAbiSemanticSection | undefined {
  const interpretations = projection.interpretations.filter(
    (interpretation) => interpretation.domain === "RELATIONSHIP_CONTEXT"
  );
  if (interpretations.length === 0) {
    return undefined;
  }

  const relationshipReferences = new Set(
    (projection.targetableInterpretations ?? [])
      .filter((binding) => binding.interpretation.domain === "RELATIONSHIP_CONTEXT")
      .map((binding) => binding.interpretationReference)
  );
  const activeAudits = projection.correctionAudits.filter(
    (audit) =>
      audit.supersededByCorrectionReference === undefined &&
      audit.target.kind === "INTERPRETATION" &&
      relationshipReferences.has(audit.target.interpretationReference)
  );
  const summary = joinMeaning(
    interpretations.flatMap((interpretation) =>
      interpretation.meaning === undefined ? [] : [interpretation.meaning]
    )
  );
  const provenanceReferences = uniqueSorted([
    ...interpretations.flatMap((interpretation) =>
      interpretation.provenance.map((provenance) => `p8:evidence:${provenance.reference}`)
    ),
    ...activeAudits.map(correctionProvenanceReference)
  ]);

  return Object.freeze({
    kind: "RELATIONSHIP_CONTEXT" as const,
    state: aggregateRelationshipState(interpretations),
    ...(summary === undefined ? {} : { summary }),
    ...(provenanceReferences.length === 0 ? {} : { provenanceReferences })
  });
}

function aggregateRelationshipState(
  interpretations: readonly P8EvidenceInterpretation[]
): CharacterAbiEpistemicState {
  const states = interpretations.map((interpretation) => interpretation.status);
  if (states.some((state) => state === "CONFLICTING")) {
    return "CONFLICTING";
  }
  if (states.every((state) => state === "KNOWN")) {
    return "KNOWN";
  }
  if (interpretations.some((interpretation) => interpretation.meaning !== undefined)) {
    return "PARTIAL";
  }
  const first = states[0];
  if (first !== undefined && states.every((state) => state === first)) {
    return mapP8State(first);
  }
  return "PARTIAL";
}

function authoredProvenanceReference(invariant: P8ProjectedInvariant): string {
  const revision = invariant.provenance.revision;
  return `p8:authored:${invariant.provenance.reference}${
    revision === undefined ? "" : `@${revision}`
  }`;
}

function correctionProvenanceReference(audit: P8CorrectionAudit): string {
  return `p8:correction:${audit.correctionReference}`;
}

function joinMeaning(values: readonly string[]): string | undefined {
  const unique = uniqueSorted(values);
  return unique.length === 0 ? undefined : unique.join("\n");
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapP8State(state: P8EpistemicState): CharacterAbiEpistemicState {
  switch (state) {
    case "KNOWN":
    case "UNKNOWN":
    case "CONFLICTING":
    case "PARTIAL":
    case "EMPTY":
    case "UNAVAILABLE":
    case "ERROR":
      return state;
  }
}
