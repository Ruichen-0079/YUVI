import type { MemoryRetrievalOutcome } from "@companion/memory";
import type { P8AuthoredInvariant, P8IdentityAddress } from "./index.js";
import { P8_PROJECTION_VERSION } from "./versions.js";
import { P8_1B_CONTRACT_VERSION, type P8EvidenceScopeReference } from "./evidence.js";
import {
  P8_1C_VERSION,
  createP8EvidenceAdapterProjection,
  type P8InterpretationCandidateInput,
  type P8RecentConversationInput,
  type P8ReadOnlyEvidenceProjection
} from "./adapter.js";
import {
  P8_1D_VERSION,
  applyP8Corrections,
  type P8AuthoredInvariantRevisionPolicy,
  type P8CorrectionApplicationResult,
  type P8CorrectionTargetableInterpretation
} from "./correction.js";
import {
  P8_1E_VERSION,
  type P8CorrectionStoreAccessStatus,
  type P8CorrectionStoreLoadResult
} from "./persistence.js";

export type P8ReferencedInterpretationCandidate = Readonly<{
  /** Stable semantic identity supplied by the declaration, never generated here. */
  interpretationReference: string;
  candidate: P8InterpretationCandidateInput;
}>;

export type P8ReconstructionVersionManifest = Readonly<{
  p8ProjectionVersion: typeof P8_PROJECTION_VERSION;
  p8InterpretationVersion: typeof P8_1B_CONTRACT_VERSION;
  p8AdapterVersion: typeof P8_1C_VERSION;
  p8CorrectionVersion: typeof P8_1D_VERSION;
  p8ReconstructionVersion: typeof P8_1E_VERSION;
}>;

export const P8_RECONSTRUCTION_VERSIONS: P8ReconstructionVersionManifest = Object.freeze({
  p8ProjectionVersion: P8_PROJECTION_VERSION,
  p8InterpretationVersion: P8_1B_CONTRACT_VERSION,
  p8AdapterVersion: P8_1C_VERSION,
  p8CorrectionVersion: P8_1D_VERSION,
  p8ReconstructionVersion: P8_1E_VERSION
});

export type P8ReconstructionInput = Readonly<{
  address: P8IdentityAddress;
  authoredInvariants: readonly P8AuthoredInvariant[];
  expectedScopeReference: P8EvidenceScopeReference;
  longTerm: MemoryRetrievalOutcome;
  recentConversation?: P8RecentConversationInput;
  referencedInterpretationCandidates?: readonly P8ReferencedInterpretationCandidate[];
  authoredInvariantRevisionPolicies?: readonly P8AuthoredInvariantRevisionPolicy[];
  correctionStore: P8CorrectionStoreLoadResult;
}>;

export type P8ReconstructionOutcome = Readonly<
  | {
      status: "RECONSTRUCTED";
      versions: P8ReconstructionVersionManifest;
      projection: P8CorrectionApplicationResult;
    }
  | {
      status: "UNAVAILABLE" | "ERROR";
      versions: P8ReconstructionVersionManifest;
      correctionStoreStatus: Extract<P8CorrectionStoreAccessStatus, "UNAVAILABLE" | "ERROR">;
      /** Authored declarations only; never a successful dynamic reconstruction. */
      authoredProjection?: P8CorrectionApplicationResult;
    }
>;

/**
 * Rebuilds the current P8 meaning from supplied authoritative inputs. A
 * Correction outages retain authored declarations separately from the unavailable
 * dynamic reconstruction. No failed correction is accepted or applied.
 */
export function reconstructP8Projection(input: P8ReconstructionInput): P8ReconstructionOutcome {
  if (input.correctionStore.status === "UNAVAILABLE") {
    return unavailableReconstruction("UNAVAILABLE", input);
  }
  if (input.correctionStore.status === "ERROR") {
    return unavailableReconstruction("ERROR", input);
  }
  if (
    input.correctionStore.status !== "SUCCESS_WITH_CORRECTIONS" &&
    input.correctionStore.status !== "SUCCESS_WITH_NO_CORRECTIONS"
  ) {
    return unavailableReconstruction("ERROR", input);
  }
  if (
    !Array.isArray(input.correctionStore.corrections) ||
    (input.correctionStore.status === "SUCCESS_WITH_CORRECTIONS" &&
      input.correctionStore.corrections.length === 0) ||
    (input.correctionStore.status === "SUCCESS_WITH_NO_CORRECTIONS" &&
      input.correctionStore.corrections.length > 0)
  ) {
    return unavailableReconstruction("ERROR", input);
  }

  const referencedCandidates = normalizeReferencedCandidates(
    input.referencedInterpretationCandidates
  );
  const baseProjection = createP8EvidenceAdapterProjection({
    address: input.address,
    authoredInvariants: input.authoredInvariants,
    expectedScopeReference: input.expectedScopeReference,
    longTerm: input.longTerm,
    ...(input.recentConversation === undefined
      ? {}
      : { recentConversation: input.recentConversation }),
    ...(referencedCandidates === undefined
      ? {}
      : { interpretationCandidates: referencedCandidates.map((item) => item.candidate) })
  });
  const targetableInterpretations =
    referencedCandidates === undefined
      ? undefined
      : createTargetBindings(referencedCandidates, baseProjection);
  const projection = applyP8Corrections({
    baseProjection,
    ...(targetableInterpretations === undefined ? {} : { targetableInterpretations }),
    ...(input.authoredInvariantRevisionPolicies === undefined
      ? {}
      : { authoredInvariantRevisionPolicies: input.authoredInvariantRevisionPolicies }),
    scopeReference: input.expectedScopeReference,
    corrections: input.correctionStore.corrections
  });

  return Object.freeze({
    status: "RECONSTRUCTED" as const,
    versions: P8_RECONSTRUCTION_VERSIONS,
    projection
  });
}

function unavailableReconstruction(
  correctionStoreStatus: Extract<P8CorrectionStoreAccessStatus, "UNAVAILABLE" | "ERROR">,
  input: P8ReconstructionInput
): P8ReconstructionOutcome {
  const baseProjection = createP8EvidenceAdapterProjection({
    address: input.address,
    authoredInvariants: input.authoredInvariants,
    expectedScopeReference: input.expectedScopeReference,
    longTerm: { status: "unavailable", events: [], source: "p8-authored-only", limited: false }
  });
  const authoredProjection = applyP8Corrections({
    baseProjection,
    scopeReference: input.expectedScopeReference,
    corrections: []
  });
  return Object.freeze({
    status: correctionStoreStatus,
    versions: P8_RECONSTRUCTION_VERSIONS,
    correctionStoreStatus,
    authoredProjection
  });
}

function normalizeReferencedCandidates(
  candidates: readonly P8ReferencedInterpretationCandidate[] | undefined
): readonly P8ReferencedInterpretationCandidate[] | undefined {
  if (candidates === undefined) {
    return undefined;
  }

  const references = new Set<string>();
  const normalized = candidates.map((item) => {
    validateBoundedText(item.interpretationReference, "referenced interpretationReference", 160);
    if (references.has(item.interpretationReference)) {
      throw new Error(
        `P8 referenced interpretationReference must be unique: ${item.interpretationReference}.`
      );
    }
    references.add(item.interpretationReference);
    return Object.freeze({
      interpretationReference: item.interpretationReference,
      candidate: item.candidate
    });
  });
  return Object.freeze(normalized);
}

function createTargetBindings(
  candidates: readonly P8ReferencedInterpretationCandidate[],
  baseProjection: P8ReadOnlyEvidenceProjection
): readonly P8CorrectionTargetableInterpretation[] {
  if (baseProjection.interpretations.length !== candidates.length) {
    throw new Error("P8 referenced candidates did not reconstruct one-to-one interpretations.");
  }
  return Object.freeze(
    candidates.map((candidate, index) => {
      const interpretation = baseProjection.interpretations[index];
      if (interpretation === undefined) {
        throw new Error(
          `P8 referenced interpretation did not reconstruct: ${candidate.interpretationReference}.`
        );
      }
      return Object.freeze({
        interpretationReference: candidate.interpretationReference,
        interpretation
      });
    })
  );
}

function validateBoundedText(value: string, field: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`P8 ${field} must be a non-empty string of at most ${maximum} characters.`);
  }
}
