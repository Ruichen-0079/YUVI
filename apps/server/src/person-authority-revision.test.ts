import { describe, expect, it } from "vitest";
import {
  commitProductSettings,
  defaultProductSettings,
  personAuthorityRevision
} from "./services/product-store.js";
describe("Person knowledge and binding generations", () => {
  it("preserves old Host grants across the first profile edit and rotates only identity binding", () => {
    const old = defaultProductSettings();
    old.people = [{ id: "p", displayName: "Person", personaId: "persona-a", notes: "old notes" }];
    old.personRevisionById = { p: "legacy-known-revision" };
    const edited = structuredClone(old);
    edited.people[0]!.notes = "updated knowledge";
    const saved = commitProductSettings(edited, old);
    expect(saved.personRevisionById!["p"]).not.toBe(old.personRevisionById["p"]);
    expect(personAuthorityRevision(saved, "p")).toBe("legacy-known-revision");
    const renamed = structuredClone(saved);
    renamed.people[0]!.displayName = "New display name";
    const next = commitProductSettings(renamed, saved);
    expect(personAuthorityRevision(next, "p")).toBe("legacy-known-revision");
    const rebound = structuredClone(next);
    rebound.people[0]!.personaId = "persona-b";
    expect(personAuthorityRevision(commitProductSettings(rebound, next), "p")).not.toBe(
      "legacy-known-revision"
    );
    const removed = commitProductSettings({ ...next, people: [] }, next);
    expect(personAuthorityRevision(removed, "p")).toBeNull();
    expect(personAuthorityRevision(commitProductSettings(next, removed), "p")).not.toBe(
      "legacy-known-revision"
    );
  });
});
