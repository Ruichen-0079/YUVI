import type { Person } from "./product-store.js";

/**
 * Compatibility projection for older Product clients. This value describes
 * Product-owned profile state and is deliberately ineligible as Memory or
 * world evidence.
 */
export type ProductProfileEvidenceProjection = Readonly<{
  classification: "NON_EVIDENCE";
  projectionVersion: "product-person-profile.v1";
  owner: "PRODUCT_PERSON_STORE";
  personId: string;
  personRevision: string | null;
  lineageStatus: "VERSIONED" | "LEGACY_UNLINEAGED";
}>;

export function projectProductProfileEvidence(
  person: Pick<Person, "id">,
  personRevision: string | null = null
): ProductProfileEvidenceProjection {
  return Object.freeze({
    classification: "NON_EVIDENCE",
    projectionVersion: "product-person-profile.v1",
    owner: "PRODUCT_PERSON_STORE",
    personId: person.id,
    personRevision,
    lineageStatus: personRevision ? "VERSIONED" : "LEGACY_UNLINEAGED"
  });
}
